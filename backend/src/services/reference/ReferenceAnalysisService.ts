/**
 * 参考小说分析与创作迁移服务（MVP）。
 *
 * 流程：导入 → 章节识别/本地统计 → 分层模型分析 → 原作内容拆解
 *      → 可选：用户选维度迁移写作方法到原创项目（不注入原文）
 *      → 相似度检查（原文/专有名词）
 */
import { randomUUID } from 'node:crypto';

import type { ModelProxy } from '../../proxy/ModelProxy.js';
import type { DataStore } from '../../store/DataStore.js';
import type {
  AgentArtifact,
  ChatMessage,
  Id,
  ModelConfig,
  ReferenceAnalysisDepth,
  ReferenceAnalyzeResult,
  ReferenceCharacterProfile,
  ReferenceCreativeProfile,
  ReferenceAnalyzeRequest,
  ReferenceImportRequest,
  ReferenceImportResult,
  ReferenceNovelDetail,
  ReferenceNovelSummary,
  ReferenceTransferDimension,
  ReferenceTransferRequest,
  ReferenceTransferResult,
  ReferenceTransferableMethod,
  SimilarityCheckRequest,
  SimilarityCheckResult,
} from '../../types/index.js';
import { REFERENCE_TRANSFER_DIMENSIONS } from '../../types/index.js';
import type { ModelConfigService } from '../modelConfig/ModelConfigService.js';
import type { MemoryService } from '../memory/MemoryService.js';
import { ServiceError } from '../ServiceError.js';
import { stripReasoningArtifacts } from '../text/reasoningSanitizer.js';
import { detectChapters } from './chapterDetect.js';
import {
  aggregatePacingProfile,
  aggregateStyleProfile,
  computeChapterMetrics,
} from './styleMetrics.js';
import { checkSimilarityAgainstReference } from './similarityCheck.js';
import type {
  ProjectReferenceConfig,
  ReferenceStorePort,
  StoredReferenceNovel,
} from './ReferenceStore.js';

/** 整本导入：约 150 万字量级上限（浏览器粘贴/上传）。 */
const MAX_IMPORT_CHARS = 1_500_000;
/** 最多入库章节数（支持几十到上百章）。 */
const MAX_CHAPTERS_STORED = 120;
/** 用户一次最多勾选分析的章节数。 */
const MAX_CHAPTERS_SELECT = 80;
/** 送入模型综合的章节上限（本地统计仍覆盖所选全部）。 */
const DEPTH_MODEL_SAMPLE: Record<ReferenceAnalysisDepth, number> = {
  quick: 12,
  standard: 60,
  deep: 80,
};

/** 拆解项目章节只保留占位，禁止把参考原文拷进 DataStore 供写作/Agent 吞掉。 */
const ANALYSIS_CHAPTER_PLACEHOLDER = '原文已保存在参考库';

const DIMENSION_LABELS: Record<ReferenceTransferDimension, string> = {
  pacing: '剧情节奏',
  chapter_structure: '章节结构',
  characterization: '人物塑造方式',
  suspense: '悬念设计',
  dialogue_density: '对话密度',
  description_density: '描写密度',
  emotion_curve: '情绪曲线',
  payoff_frequency: '爽点频率',
  worldbuilding_delivery: '世界观展示方法',
  style: '文风参数',
};

export class ReferenceAnalysisService {
  constructor(
    private readonly refStore: ReferenceStorePort,
    private readonly dataStore: DataStore,
    private readonly modelConfigService: ModelConfigService,
    private readonly modelProxy: ModelProxy,
    private readonly memory: MemoryService,
  ) {}

  list(): ReferenceNovelSummary[] {
    return this.refStore.listNovels().map(toSummary);
  }

  get(id: Id): ReferenceNovelDetail {
    const novel = this.requireNovel(id);
    return toDetail(novel);
  }

  async importText(request: ReferenceImportRequest): Promise<ReferenceImportResult> {
    const text = typeof request.text === 'string' ? request.text : '';
    if (text.trim().length < 80) {
      throw ServiceError.validation('参考小说正文过短，请粘贴更多内容（至少约 80 字）。');
    }
    if (text.length > MAX_IMPORT_CHARS) {
      throw ServiceError.validation(`正文过长，请控制在 ${MAX_IMPORT_CHARS} 字符以内或分段导入。`);
    }
    const depth = normalizeDepth(request.depth);
    const detected = detectChapters(text).slice(0, MAX_CHAPTERS_STORED);
    if (detected.length === 0) {
      throw ServiceError.validation('未能识别到可用正文。');
    }

    const chapters = detected.map((ch) => {
      const metrics = computeChapterMetrics(ch.content);
      return {
        id: randomUUID(),
        number: ch.number,
        title: ch.title,
        content: ch.content,
        wordCount: metrics.wordCount,
        metrics,
      };
    });
    const wordCount = chapters.reduce((s, c) => s + c.wordCount, 0);
    const now = new Date().toISOString();
    const novel: StoredReferenceNovel = {
      id: randomUUID(),
      title: normalizeReferenceTitle(
        request.title?.trim() || inferTitle(text, chapters[0]?.title),
      ).slice(0, 64),
      author: request.author?.trim() || undefined,
      depth,
      status: 'imported',
      isCompleteWork: request.isCompleteWork,
      chapters,
      createdAt: now,
      updatedAt: now,
    };
    await this.refStore.saveNovel(novel);
    return {
      reference: toSummary(novel),
      chaptersDetected: chapters.length,
      wordCount,
      message: `已导入《${novel.title}》：识别 ${chapters.length} 章，约 ${wordCount.toLocaleString()} 字。请勾选要分析的章节（可全书 / 部分，最多 ${MAX_CHAPTERS_SELECT} 章）。`,
      chapters: chapters.map((c) => ({
        id: c.id,
        number: c.number,
        title: c.title,
        wordCount: c.wordCount,
        contentPreview: c.content.replace(/\s+/g, ' ').slice(0, 120),
      })),
    };
  }

  async analyze(
    id: Id,
    signal: AbortSignal,
    request: ReferenceAnalyzeRequest = {},
  ): Promise<ReferenceAnalyzeResult> {
    const novel = this.requireNovel(id);
    const selected = resolveSelectedChapters(novel, request);
    if (selected.length === 0) {
      throw ServiceError.validation('请至少选择 1 章进行分析。');
    }
    if (selected.length > MAX_CHAPTERS_SELECT) {
      throw ServiceError.validation(`单次最多分析 ${MAX_CHAPTERS_SELECT} 章，请缩小选择范围。`);
    }

    const previousStatus = novel.status;
    const previousErrorMessage = novel.errorMessage;
    if (request.depth) {
      novel.depth = normalizeDepth(request.depth);
    }
    novel.status = 'analyzing';
    novel.errorMessage = undefined;
    await this.refStore.saveNovel(novel);

    try {
      const metrics = selected.map((c) => c.metrics);
      const style = aggregateStyleProfile(metrics);
      const pacing = aggregatePacingProfile(metrics);

      const modelCap = Math.min(
        DEPTH_MODEL_SAMPLE[novel.depth],
        Math.max(1, request.maxModelChapters ?? DEPTH_MODEL_SAMPLE[novel.depth]),
        selected.length,
      );
      const sample = evenlyPick(selected, modelCap);

      // 本地启发式：对「所选全部」写摘要线索；模型只用 sample
      for (const ch of selected) {
        const local = localChapterHints(ch.content, ch.title);
        const target = novel.chapters.find((c) => c.id === ch.id);
        if (target) {
          target.summary = local.summary;
          target.functions = local.functions;
          target.openHook = local.openHook;
          target.endHook = local.endHook;
          target.characters = local.characters;
        }
      }

      let profile = buildLocalProfile(novel, style, pacing, selected.length);
      let modelEnhanced = false;

      const config = await this.modelConfigService.getInternalConfig();
      if (config) {
        const synthesized = await this.synthesizeWithModel(config, novel, profile, sample, signal);
        modelEnhanced = hasMeaningfulModelExtraction(profile, synthesized);
        const chapterCharacterOutfits = await this.synthesizeChapterOutfitsWithModel(
          config,
          novel,
          synthesized,
          selected,
          signal,
        );
        const finalChapterCharacterOutfits =
          chapterCharacterOutfits.length > 0
            ? chapterCharacterOutfits
            : synthesized.chapterCharacterOutfits ?? [];
        profile = {
          ...synthesized,
          chapterCharacterOutfits: finalChapterCharacterOutfits,
          markdownReport: replaceChapterOutfitReportSection(
            synthesized.markdownReport,
            finalChapterCharacterOutfits,
          ),
        };
      }

      novel.profile = profile;
      novel.status = 'ready';
      const analysisProject = await this.persistAnalysisProject(novel, profile);
      await this.refStore.saveNovel(novel);

      return {
        reference: toSummary(novel),
        profile,
        analysisProjectId: analysisProject.projectId,
        analysisProjectName: analysisProject.projectName,
        artifacts: analysisProject.artifacts,
        chaptersAnalyzed: sample.length,
        chaptersSelected: selected.length,
        message: modelEnhanced
          ? `已完成《${novel.title}》内容拆解：统计 ${selected.length} 章，模型综合 ${sample.length} 章。左侧项目「${analysisProject.projectName}」已按原顺序写入 ${novel.chapters.length} 章；点击“资料”可查看人物、冲突、爽点、世界观、剧情大纲与分章人物服装。`
          : `已生成《${novel.title}》本地基础拆解（统计 ${selected.length} 章）。左侧项目「${analysisProject.projectName}」已按原顺序写入 ${novel.chapters.length} 章；点击“资料”可查看当前提取结果，配置真实模型后可获得更完整的人物、冲突、爽点、世界观、大纲与分章人物服装。`,
      };
    } catch (error) {
      if (isAbortError(error, signal)) {
        novel.status = previousStatus;
        novel.errorMessage = previousErrorMessage;
        await this.refStore.saveNovel(novel);
        throw error;
      }
      novel.status = 'failed';
      novel.errorMessage = error instanceof Error ? error.message : String(error);
      await this.refStore.saveNovel(novel);
      throw error;
    }
  }

  private async persistAnalysisProject(
    novel: StoredReferenceNovel,
    profile: ReferenceCreativeProfile,
  ): Promise<{ projectId: Id; projectName: string; artifacts: AgentArtifact[] }> {
    const projectName = uniqueAnalysisProjectName(novel.title, novel.id);
    let project = novel.analysisProjectId
      ? await this.dataStore.getProject(novel.analysisProjectId)
      : undefined;

    if (!project) {
      project = await this.dataStore.createProject(projectName);
    }
    if (!project) {
      throw new Error(`无法创建或读取拆解项目：${projectName}`);
    }

    novel.analysisProjectId = project.id;
    const artifacts: AgentArtifact[] = [
      { kind: 'project', id: project.id, title: project.name },
    ];

    const existingChapters = await this.dataStore.listChapters(project.id);
    const existingChapterById = new Map(existingChapters.map((chapter) => [chapter.id, chapter]));
    const previousChapterMap = novel.analysisChapterMap ?? {};
    const nextChapterMap: Record<Id, Id> = {};
    const generatedChapterIds: Id[] = [];
    const usedChapterIds = new Set<Id>();

    for (const referenceChapter of [...novel.chapters].sort(
      (left, right) => left.number - right.number,
    )) {
      let savedChapter = existingChapterById.get(previousChapterMap[referenceChapter.id] ?? '');
      if (savedChapter && usedChapterIds.has(savedChapter.id)) {
        savedChapter = undefined;
      }
      if (!savedChapter) {
        savedChapter = existingChapters.find(
          (chapter) =>
            !usedChapterIds.has(chapter.id) && chapter.title === referenceChapter.title,
        );
      }
      if (!savedChapter) {
        savedChapter = await this.dataStore.createChapter(project.id, referenceChapter.title);
      } else if (savedChapter.title !== referenceChapter.title) {
        savedChapter = await this.dataStore.renameChapter(
          savedChapter.id,
          referenceChapter.title,
        );
      }

      if (savedChapter.content !== ANALYSIS_CHAPTER_PLACEHOLDER) {
        savedChapter = await this.dataStore.updateChapterContent(
          savedChapter.id,
          ANALYSIS_CHAPTER_PLACEHOLDER,
        );
      }

      nextChapterMap[referenceChapter.id] = savedChapter.id;
      generatedChapterIds.push(savedChapter.id);
      usedChapterIds.add(savedChapter.id);
      artifacts.push({ kind: 'chapter', id: savedChapter.id, title: savedChapter.title });
    }

    const generatedChapterSet = new Set(generatedChapterIds);
    for (const oldProjectChapterId of Object.values(previousChapterMap)) {
      if (!generatedChapterSet.has(oldProjectChapterId)) {
        await this.dataStore.deleteChapter(oldProjectChapterId);
      }
    }
    const referenceRawContents = new Set(
      novel.chapters.map((chapter) => chapter.content).filter((content) => content.trim().length > 0),
    );
    const duplicateChapterIds = new Set(
      existingChapters
        .filter(
          (chapter) =>
            !generatedChapterSet.has(chapter.id) &&
            chapter.content.trim().length > 0 &&
            referenceRawContents.has(chapter.content),
        )
        .map((chapter) => chapter.id),
    );
    for (const duplicateChapterId of duplicateChapterIds) {
      await this.dataStore.deleteChapter(duplicateChapterId);
    }
    const manualChapterIds = existingChapters
      .filter(
        (chapter) =>
          !Object.values(previousChapterMap).includes(chapter.id) &&
          !generatedChapterSet.has(chapter.id) &&
          !duplicateChapterIds.has(chapter.id),
      )
      .map((chapter) => chapter.id);
    await this.dataStore.reorderChapters(project.id, [
      ...generatedChapterIds,
      ...manualChapterIds,
    ]);
    novel.analysisChapterMap = nextChapterMap;

    const existingCharacters = await this.dataStore.listCharacters(project.id);
    const desiredCharacterNames = new Set(
      (profile.characters ?? []).map((character) => character.name),
    );
    for (const existing of existingCharacters) {
      const isGeneratedAnalysisMaterial =
        existing.description.startsWith(`# ${existing.name}\n`) &&
        existing.description.includes('## 人物弧光') &&
        existing.description.includes('## 关键行动');
      if (isGeneratedAnalysisMaterial && !desiredCharacterNames.has(existing.name)) {
        await this.dataStore.deleteCharacter(existing.id);
      }
    }
    for (const character of profile.characters ?? []) {
      const description = renderCharacterMaterial(character, profile);
      const existing = existingCharacters.find((item) => item.name === character.name);
      const saved = existing
        ? await this.dataStore.updateCharacter(existing.id, {
            name: character.name,
            description,
          })
        : await this.dataStore.createCharacter(project.id, character.name, description);
      artifacts.push({ kind: 'character', id: saved.id, title: saved.name });
    }

    const worldTitle = '世界观拆解';
    const worldContent = renderWorldbuildingMaterial(profile);
    const existingWorlds = await this.dataStore.listWorldSettings(project.id);
    const existingWorld = existingWorlds.find((item) => item.title === worldTitle);
    const savedWorld = existingWorld
      ? await this.dataStore.updateWorldSetting(existingWorld.id, {
          title: worldTitle,
          content: worldContent,
        })
      : await this.dataStore.createWorldSetting(project.id, worldTitle, worldContent);
    artifacts.push({ kind: 'world', id: savedWorld.id, title: savedWorld.title });

    const outlineMaterials = buildOutlineMaterials(profile);
    const existingOutlines = await this.dataStore.listOutlines(project.id);
    for (const material of outlineMaterials) {
      const existing = existingOutlines.find((item) => item.title === material.title);
      const saved = existing
        ? await this.dataStore.updateOutline(existing.id, {
            title: material.title,
            content: material.content,
          })
        : await this.dataStore.createOutline(project.id, material.title, material.content);
      artifacts.push({ kind: 'outline', id: saved.id, title: saved.title });
    }

    return { projectId: project.id, projectName: project.name, artifacts };
  }

  async transferToProject(
    projectId: Id,
    request: ReferenceTransferRequest,
    signal: AbortSignal,
  ): Promise<ReferenceTransferResult> {
    const project = await this.dataStore.getProject(projectId);
    if (!project) throw ServiceError.notFound(`项目不存在：${projectId}`);

    const novel = this.requireNovel(request.referenceId);
    if (!novel.profile || novel.status !== 'ready') {
      throw ServiceError.validation('请先完成参考小说分析并生成创作档案。');
    }

    const dimensions = normalizeDimensions(request.dimensions);
    if (dimensions.length === 0) {
      throw ServiceError.validation('请至少选择一个可迁移维度。');
    }

    const planMarkdown = await this.buildTransferPlan(
      novel,
      dimensions,
      request.originalBrief,
      signal,
    );

    const artifacts: AgentArtifact[] = [{ kind: 'project', id: projectId, title: project.name }];

    const outline = await this.dataStore.createOutline(
      projectId,
      `参考创作档案（迁移）：${novel.title}`,
      planMarkdown,
    );
    artifacts.push({ kind: 'outline', id: outline.id, title: outline.title });

    const methodBlock = filterMethods(novel.profile.transferableMethods, dimensions)
      .map(
        (m) =>
          `### ${DIMENSION_LABELS[m.dimension]} · ${m.title}\n- 方法：${m.method}\n- 应用：${m.howToApply}`,
      )
      .join('\n\n');

    const world = await this.dataStore.createWorldSetting(
      projectId,
      `参考写作方法（迁移）：${novel.title}`,
      [
        '# 参考写作方法（仅抽象方法，禁止照搬原文/专名/剧情）',
        '',
        `来源参考：《${novel.title}》`,
        `已选维度：${dimensions.map((d) => DIMENSION_LABELS[d]).join('、')}`,
        '',
        methodBlock || '（无匹配方法条目，请见大纲中的迁移方案）',
        '',
        '## 严禁',
        ...(novel.profile.doNotCopy.length > 0
          ? novel.profile.doNotCopy.map((x) => `- ${x}`)
          : ['- 原作人名/地名/组织/能力/独特句子/完整剧情']),
      ].join('\n'),
    );
    artifacts.push({ kind: 'world', id: world.id, title: world.title });

    const facts = filterMethods(novel.profile.transferableMethods, dimensions)
      .slice(0, 12)
      .map((m) => ({
        kind: 'plot' as const,
        text: `参考方法[${DIMENSION_LABELS[m.dimension]}]：${m.method} → ${m.howToApply}`.slice(0, 280),
      }));
    if (facts.length > 0) await this.memory.recordFacts(projectId, facts);
    await this.memory.recordLearning(
      projectId,
      `已启用参考作《${novel.title}》的迁移维度：${dimensions.map((d) => DIMENSION_LABELS[d]).join('、')}。写作时只学方法，禁止复制原文与专名。`,
    );

    const cfg: ProjectReferenceConfig = {
      projectId,
      referenceId: novel.id,
      dimensions,
      planMarkdown,
      appliedAt: new Date().toISOString(),
    };
    await this.refStore.saveProjectConfig(cfg);

    return {
      projectId,
      referenceId: novel.id,
      dimensions,
      planMarkdown,
      artifacts,
      summary: `已将《${novel.title}》的 ${dimensions.length} 个维度迁移到项目「${project.name}」（只写入方法参数，未写入参考原文）。`,
    };
  }

  async checkSimilarity(
    projectId: Id | undefined,
    request: SimilarityCheckRequest,
  ): Promise<SimilarityCheckResult> {
    const novel = this.requireNovel(request.referenceId);
    let text = request.text?.trim() ?? '';
    if (request.chapterId) {
      const chapter = await this.dataStore.getChapter(request.chapterId);
      if (!chapter || (projectId !== undefined && chapter.projectId !== projectId)) {
        throw ServiceError.notFound(`章节不存在：${request.chapterId}`);
      }
      if (!text) text = chapter.content;
    }
    if (!text) throw ServiceError.validation('请提供待检文本或 chapterId。');

    const refTexts = novel.chapters
      .filter((c) => c.content.trim().length > 0)
      .slice(0, 80)
      .map((c) => c.content.slice(0, 8000));

    return checkSimilarityAgainstReference({
      referenceId: novel.id,
      referenceTitle: novel.title,
      referenceTexts: refTexts,
      candidateText: text,
      projectId,
    });
  }

  async purgeRawText(id: Id): Promise<ReferenceNovelSummary> {
    const novel = this.requireNovel(id);
    novel.chapters = novel.chapters.map((c) => ({ ...c, content: '' }));
    novel.rawPurged = true;
    await this.blankAnalysisProjectChapters(novel);
    await this.refStore.saveNovel(novel);
    return toSummary(novel);
  }

  async remove(id: Id): Promise<void> {
    const novel = this.refStore.getNovel(id);
    if (!novel) throw ServiceError.notFound(`参考小说不存在：${id}`);
    await this.blankAnalysisProjectChapters(novel);
    const ok = await this.refStore.deleteNovel(id);
    if (!ok) throw ServiceError.notFound(`参考小说不存在：${id}`);
  }

  /** 清空拆解项目中对应章节正文，避免参考原文残留在可写作 DataStore。 */
  private async blankAnalysisProjectChapters(novel: StoredReferenceNovel): Promise<void> {
    const projectId = novel.analysisProjectId;
    if (!projectId) return;
    const project = await this.dataStore.getProject(projectId);
    if (!project) return;

    const mappedIds = Object.values(novel.analysisChapterMap ?? {});
    const chapterIds =
      mappedIds.length > 0
        ? mappedIds
        : (await this.dataStore.listChapters(projectId)).map((chapter) => chapter.id);

    for (const chapterId of chapterIds) {
      const chapter = await this.dataStore.getChapter(chapterId);
      if (!chapter || chapter.projectId !== projectId) continue;
      if (chapter.content.length === 0) continue;
      await this.dataStore.updateChapterContent(chapterId, '');
    }
  }

  /**
   * 写作时注入：仅返回已迁移的抽象方法，绝不带参考原文。
   */
  buildActiveTransferPrompt(projectId: Id): string {
    const cfg = this.refStore.getProjectConfig(projectId);
    if (!cfg) return '';
    const novel = this.refStore.getNovel(cfg.referenceId);
    if (!novel?.profile) {
      return cfg.planMarkdown.slice(0, 3000);
    }
    const methods = filterMethods(novel.profile.transferableMethods, cfg.dimensions);
    const lines = [
      '# 已启用的参考写作方法（只学方法，禁止抄袭原文/专名/剧情）',
      `参考档案：《${novel.title}》`,
      `维度：${cfg.dimensions.map((d) => DIMENSION_LABELS[d]).join('、')}`,
      '',
    ];
    for (const m of methods.slice(0, 14)) {
      lines.push(`- [${DIMENSION_LABELS[m.dimension]}] ${m.method}｜应用：${m.howToApply}`);
    }
    lines.push('', '禁止：原作人名、地名、组织、能力名、独特句子、完整剧情链。');
    if (novel.profile.style) {
      lines.push(
        `文风参考参数：句长≈${novel.profile.style.avgSentenceLength}，对话比≈${novel.profile.style.dialogueRatio}，节奏=${novel.profile.style.rhythmLabel}（参数级，非原文）。`,
      );
    }
    if (novel.profile.pacing) {
      lines.push(
        `节奏参考：约每 ${novel.profile.pacing.estimatedSmallConflictEveryN} 章小冲突，每 ${novel.profile.pacing.estimatedMajorPayoffEveryN} 章阶段爽点。`,
      );
    }
    return lines.join('\n');
  }

  private requireNovel(id: Id): StoredReferenceNovel {
    const novel = this.refStore.getNovel(id);
    if (!novel) throw ServiceError.notFound(`参考小说不存在：${id}`);
    return novel;
  }

  private async synthesizeWithModel(
    config: ModelConfig,
    novel: StoredReferenceNovel,
    local: ReferenceCreativeProfile,
    sample: StoredReferenceNovel['chapters'],
    signal: AbortSignal,
  ): Promise<ReferenceCreativeProfile> {
    const totalContentBudget = 72_000;
    const perChapterBudget = Math.max(
      1_200,
      Math.min(6_000, Math.floor(totalContentBudget / Math.max(1, sample.length))),
    );
    const sampleBlock = sample
      .map((ch) => {
        const content = ch.content.trim().slice(0, perChapterBudget);
        return [
          `### 第${ch.number}章｜${ch.title}`,
          `字数=${ch.wordCount} 对话比=${ch.metrics.dialogueRatio} 描写比=${ch.metrics.descriptionRatio}`,
          '正文：',
          content,
        ].join('\n');
      })
      .join('\n\n');

    const system = [
      '你是小说内容分析师。任务是忠实拆解给定原作，不是续写、改写、仿写，也不是创作一部新小说。',
      '必须保留并使用原作中的人物名、地名、组织名和具体剧情事实；不要把它们抽象成“某主角”“某势力”。',
      '只写正文能够支持的结论；无法确认时明确写“未确认”，禁止编造。可以概述情节，但不要连续引用大段原文。',
      '重点提取：人物与人物弧光、人物关系、核心/阶段/内外冲突、爽点及其铺垫与兑现、世界观规则与势力、完整剧情大纲、伏笔、反转、主题。',
      '“可迁移写作方法”只是末尾附录，不得挤占内容拆解。',
      '只输出一个 JSON 对象，不要 Markdown 代码块。字段结构：',
      '{"oneLineSummary":"","genreGuess":"","coreConflict":"","mainPlotAbstract":"使用原作专名概述完整主线","characters":[{"name":"","role":"主角|配角|反派|关键人物","identity":"","goal":"","motivation":"","traits":[""],"arc":"","keyActions":[""]}],"relationships":[{"from":"","to":"","relation":"","evolution":""}],"conflicts":[{"type":"core|external|internal|relationship|stage","parties":[""],"description":"","stakes":"","progression":""}],"payoffs":[{"title":"","setup":"","trigger":"","payoff":"","impact":"","chapter":"章节范围"}],"worldbuilding":{"premise":"","rules":[""],"factions":[""],"locations":[""],"systems":[""],"history":[""],"terminology":[""]},"plotOutline":[{"stage":"阶段/卷/章组","chapters":"第1-3章","summary":"","turningPoint":""}],"foreshadowing":[{"setup":"","payoff":"","status":"unresolved|partial|resolved|uncertain"}],"reversals":[{"setup":"","reversal":"","effect":"","chapter":""}],"themes":[""],"characterMethods":[""],"worldbuildingDelivery":[""],"transferableMethods":[{"dimension":"pacing|chapter_structure|characterization|suspense|dialogue_density|description_density|emotion_curve|payoff_frequency|worldbuilding_delivery|style","title":"","method":"","why":"","howToApply":""}],"strengths":[""],"risks":[""],"doNotCopy":[""]}',
      'characters 覆盖主要角色；plotOutline 必须覆盖所给章节的开端、发展、转折、高潮与结局；payoffs 必须写清“铺垫→触发→兑现”。',
    ].join('\n');

    const user = [
      `作品：《${novel.title}》 深度：${novel.depth} 章数：${novel.chapters.length}`,
      `本地风格：句长${local.style.avgSentenceLength} 对话比${local.style.dialogueRatio} 节奏${local.style.rhythmLabel}`,
      `本地节奏：均章${local.pacing.avgChapterWords} 小冲突每${local.pacing.estimatedSmallConflictEveryN}章 高潮每${local.pacing.estimatedMajorPayoffEveryN}章`,
      '',
      `# 待拆解正文（${sample.length} 章，单章最多 ${perChapterBudget} 字符）`,
      sampleBlock.slice(0, totalContentBudget + sample.length * 120),
    ].join('\n');

    const raw = await this.generateText(config, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], signal);

    const parsed = parseProfileJson(raw);
    return mergeProfiles(local, parsed, novel.title);
  }

  private async synthesizeChapterOutfitsWithModel(
    config: ModelConfig,
    novel: StoredReferenceNovel,
    profile: ReferenceCreativeProfile,
    chapters: StoredReferenceNovel['chapters'],
    signal: AbortSignal,
  ): Promise<NonNullable<ReferenceCreativeProfile['chapterCharacterOutfits']>> {
    const extracted: NonNullable<ReferenceCreativeProfile['chapterCharacterOutfits']> = [];
    const sortedChapters = [...chapters].sort((left, right) => left.number - right.number);
    const batchSize = 5;

    for (let start = 0; start < sortedChapters.length; start += batchSize) {
      const batch = sortedChapters.slice(start, start + batchSize);
      const chapterBlock = batch
        .map((chapter) => [
          `### ${chapter.title}`,
          chapter.content.trim().slice(0, 5_000),
        ].join('\n'))
        .join('\n\n');
      const system = [
        '你是小说服装连续性分析师。只分析给定章节中实际出场人物穿了什么。',
        '逐章列出实际出场的具名人物。正文明确写到穿着、换装或服装外观才标 explicit。',
        '只有同一连续场景能够确认沿用上一段服装时才标 inferred，并在 evidence 说明依据。',
        '没有服装信息必须写 outfit="正文未描写"、evidence=""、certainty="not_described"。',
        '“袖中取物”“查看衣领”“缝衣”“衣襟藏物”等不代表描述了人物所穿服装，不得标 explicit。',
        '严禁根据人物身份、时代、职业、性别或常识臆造服装。evidence 不超过30字，不连续引用原文。',
        'chapter 必须逐字复制输入中的章节标题。只输出一个 JSON 对象，不要代码块或解释。',
        '{"chapterCharacterOutfits":[{"chapter":"第一章 章名","characters":[{"name":"人物名","outfit":"具体服装或正文未描写","evidence":"30字内依据","certainty":"explicit|inferred|not_described"}]}]}',
        '服装分析协议版本：2。',
      ].join('\n');
      const user = [
        `作品：《${novel.title}》`,
        `已知主要人物：${(profile.characters ?? []).map((item) => item.name).join('、') || '由正文识别'}`,
        '',
        chapterBlock,
      ].join('\n');

      try {
        const raw = await this.generateText(
          config,
          [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          signal,
        );
        const parsed = parseProfileJson(raw).chapterCharacterOutfits ?? [];
        extracted.push(...parsed);
      } catch {
        // 单批失败不拖垮整本拆解；下方会用“正文未描写”的保守基线补齐。
      }
    }

    const local = extractLocalChapterCharacterOutfits(novel, profile.characters ?? []);
    return mergeChapterOutfitCoverage(sortedChapters, profile.characters ?? [], extracted, local);
  }

  private async buildTransferPlan(
    novel: StoredReferenceNovel,
    dimensions: ReferenceTransferDimension[],
    originalBrief: string | undefined,
    signal: AbortSignal,
  ): Promise<string> {
    const profile = novel.profile!;
    const methods = filterMethods(profile.transferableMethods, dimensions);
    const base = [
      `# 迁移方案：${novel.title} → 原创项目`,
      '',
      `选择维度：${dimensions.map((d) => DIMENSION_LABELS[d]).join('、')}`,
      originalBrief?.trim() ? `原创方向：${originalBrief.trim()}` : '',
      '',
      '## 原则',
      '- 只迁移抽象写作方法与参数，不迁移专名与剧情。',
      '- 禁止一键换皮复用原作事件链。',
      '',
      '## 可执行方法',
      ...methods.map(
        (m, i) =>
          `${i + 1}. **${DIMENSION_LABELS[m.dimension]} · ${m.title}**\n   - ${m.method}\n   - 落地：${m.howToApply}`,
      ),
      '',
      '## 文风/节奏参数（可参考数值，勿模仿原句）',
      `- 句长≈${profile.style.avgSentenceLength}，对话比≈${profile.style.dialogueRatio}，描写比≈${profile.style.descriptionRatio}，节奏=${profile.style.rhythmLabel}`,
      `- 小冲突间隔≈${profile.pacing.estimatedSmallConflictEveryN}章，阶段爽点≈${profile.pacing.estimatedMajorPayoffEveryN}章`,
      '',
      '## 严禁复制',
      ...profile.doNotCopy.map((x) => `- ${x}`),
    ]
      .filter(Boolean)
      .join('\n');

    const config = await this.modelConfigService.getInternalConfig();
    if (!config || methods.length === 0) return base;

    try {
      const raw = await this.generateText(
        config,
        [
          {
            role: 'system',
            content: [
              '你需要把参考作品的抽象写作规律迁移到原创项目。',
              '允许：节奏、信息密度、章节功能、高潮间隔、对话/描写比例、人物塑造方法、悬念策略。',
              '禁止：人名地名势力能力、原剧情、原台词、标志性表达、连续事件顺序。',
              '输出 Markdown 迁移方案，不要输出原文。',
            ].join('\n'),
          },
          {
            role: 'user',
            content: [
              base,
              '',
              '请在上述草案基础上润色为更可执行的迁移方案（保留严禁条款）。',
            ].join('\n'),
          },
        ],
        signal,
      );
      const text = stripReasoningArtifacts(raw).trim();
      return text.length > 200 ? text : base;
    } catch {
      return base;
    }
  }

  private async generateText(
    config: ModelConfig,
    messages: ChatMessage[],
    signal: AbortSignal,
  ): Promise<string> {
    let out = '';
    for await (const delta of this.modelProxy.streamCompletion(config, messages, signal, {
      jsonMode: messages.some((m) => m.content.includes('只输出一个 JSON')),
    })) {
      if (delta.kind === 'content' && delta.text) out += delta.text;
    }
    return stripReasoningArtifacts(out);
  }
}

function renderCharacterMaterial(
  character: ReferenceCharacterProfile,
  profile: ReferenceCreativeProfile,
): string {
  const relationships = (profile.relationships ?? []).filter(
    (item) => item.from === character.name || item.to === character.name,
  );
  const outfits = (profile.chapterCharacterOutfits ?? []).flatMap((chapter) =>
    chapter.characters
      .filter((item) => item.name === character.name)
      .map((item) => ({ chapter: chapter.chapter, ...item })),
  );
  return [
    `# ${character.name}`,
    '',
    `- **人物定位**：${character.role || '待确认'}`,
    `- **身份**：${character.identity || '待确认'}`,
    `- **目标**：${character.goal || '待确认'}`,
    `- **动机**：${character.motivation || '待确认'}`,
    `- **性格特征**：${character.traits?.join('、') || '待确认'}`,
    '',
    '## 人物弧光',
    character.arc || '待结合全文确认',
    '',
    '## 关键行动',
    ...markdownList(character.keyActions, '暂未提取到明确行动'),
    '',
    '## 人物关系',
    ...(relationships.length > 0
      ? relationships.map(
          (item) =>
            `- **${item.from} → ${item.to}**：${item.relation || '关系待确认'}${
              item.evolution ? `；变化：${item.evolution}` : ''
            }`,
        )
      : ['- 暂未提取到明确关系']),
    '',
    '## 分章服装',
    ...(outfits.length > 0
      ? outfits.map(
          (item) =>
            `- **${item.chapter}**：${item.outfit || '正文未描写'}（${outfitCertaintyLabel(item.certainty)}）${
              item.evidence ? `；依据：${item.evidence}` : ''
            }`,
        )
      : ['- 暂未提取到分章服装信息']),
  ].join('\n');
}

function renderWorldbuildingMaterial(profile: ReferenceCreativeProfile): string {
  const world = profile.worldbuilding;
  return [
    '# 世界观拆解',
    '',
    '## 故事前提',
    world?.premise || profile.oneLineSummary || '待结合全文确认',
    '',
    '## 世界规则',
    ...markdownList(world?.rules, '暂未提取'),
    '',
    '## 势力与组织',
    ...markdownList(world?.factions, '暂未提取'),
    '',
    '## 关键地点',
    ...markdownList(world?.locations, '暂未提取'),
    '',
    '## 能力 / 制度 / 运行系统',
    ...markdownList(world?.systems, '暂未提取'),
    '',
    '## 历史背景',
    ...markdownList(world?.history, '暂未提取'),
    '',
    '## 专有名词',
    ...markdownList(world?.terminology, '暂未提取'),
  ].join('\n');
}

function buildOutlineMaterials(
  profile: ReferenceCreativeProfile,
): Array<{ title: string; content: string }> {
  const plotOutline = [
    '# 故事总览与剧情大纲',
    '',
    `- **类型判断**：${profile.genreGuess || '待确认'}`,
    `- **一句话故事**：${profile.oneLineSummary || '待确认'}`,
    `- **核心冲突**：${profile.coreConflict || '待确认'}`,
    '',
    '## 主线概述',
    profile.mainPlotAbstract || '待结合全文确认',
    '',
    '## 分阶段大纲',
    ...((profile.plotOutline ?? []).length > 0
      ? profile.plotOutline!.map(
          (beat, index) =>
            `${index + 1}. **${beat.stage || `阶段 ${index + 1}`}**（${beat.chapters || '章节待确认'}）\n` +
            `   - 剧情：${beat.summary || '待确认'}\n` +
            `   - 转折：${beat.turningPoint || '待确认'}`,
        )
      : ['- 暂未提取到可靠的分阶段大纲']),
  ].join('\n');

  const conflictAndPayoff = [
    '# 冲突与爽点',
    '',
    '## 冲突结构',
    ...((profile.conflicts ?? []).length > 0
      ? profile.conflicts!.map(
          (item, index) =>
            `${index + 1}. **${conflictTypeLabel(item.type)}**：${item.description || '待确认'}\n` +
            `   - 对抗方：${item.parties?.join(' vs ') || '待确认'}\n` +
            `   - 代价：${item.stakes || '待确认'}\n` +
            `   - 推进：${item.progression || '待确认'}`,
        )
      : ['- 暂未提取到可靠冲突']),
    '',
    '## 爽点 / 情绪回报',
    ...((profile.payoffs ?? []).length > 0
      ? profile.payoffs!.map(
          (item, index) =>
            `${index + 1}. **${item.title || `爽点 ${index + 1}`}**（${item.chapter || '章节待确认'}）\n` +
            `   - 铺垫：${item.setup || '待确认'}\n` +
            `   - 触发：${item.trigger || '待确认'}\n` +
            `   - 兑现：${item.payoff || '待确认'}\n` +
            `   - 影响：${item.impact || '待确认'}`,
        )
      : ['- 暂未提取到可靠爽点']),
  ].join('\n');

  const cluesAndThemes = [
    '# 伏笔、反转与主题',
    '',
    '## 伏笔与回收',
    ...((profile.foreshadowing ?? []).length > 0
      ? profile.foreshadowing!.map(
          (item, index) =>
            `${index + 1}. **铺垫**：${item.setup || '待确认'}\n` +
            `   - 回收：${item.payoff || '尚未确认'}\n` +
            `   - 状态：${item.status}`,
        )
      : ['- 暂未提取']),
    '',
    '## 剧情反转',
    ...((profile.reversals ?? []).length > 0
      ? profile.reversals!.map(
          (item, index) =>
            `${index + 1}. **${item.chapter || '章节待确认'}**：${item.reversal || '待确认'}\n` +
            `   - 前置认知：${item.setup || '待确认'}\n` +
            `   - 作用：${item.effect || '待确认'}`,
        )
      : ['- 暂未提取']),
    '',
    '## 主题',
    ...markdownList(profile.themes, '暂未提取'),
  ].join('\n');

  const chapterOutfits = [
    '# 分章人物服装',
    '',
    '> 只记录正文能够支持的服装信息；“上下文推断”不等于原文明写，“正文未描写”不会自动补衣服。',
    '',
    ...((profile.chapterCharacterOutfits ?? []).length > 0
      ? profile.chapterCharacterOutfits!.flatMap((chapter) => [
          `## ${chapter.chapter}`,
          ...(chapter.characters.length > 0
            ? chapter.characters.map(
                (item) =>
                  `- **${item.name}**：${item.outfit || '正文未描写'}（${outfitCertaintyLabel(item.certainty)}）${
                    item.evidence ? `；依据：${item.evidence}` : ''
                  }`,
              )
            : ['- 本章未提取到具名人物']),
          '',
        ])
      : ['- 暂未提取到分章服装信息']),
  ].join('\n');

  return [
    { title: '01 · 故事总览与剧情大纲', content: plotOutline },
    { title: '02 · 冲突与爽点', content: conflictAndPayoff },
    { title: '03 · 伏笔、反转与主题', content: cluesAndThemes },
    {
      title: '04 · 完整拆解报告',
      content: profile.markdownReport?.trim() || [plotOutline, conflictAndPayoff, cluesAndThemes].join('\n\n'),
    },
    { title: '05 · 分章人物服装', content: chapterOutfits },
  ];
}

function markdownList(values: string[] | undefined, emptyText: string): string[] {
  const usable = (values ?? []).map((item) => item.trim()).filter(Boolean);
  return usable.length > 0 ? usable.map((item) => `- ${item}`) : [`- ${emptyText}`];
}

function conflictTypeLabel(type: string): string {
  return (
    {
      core: '核心冲突',
      external: '外部冲突',
      internal: '内心冲突',
      relationship: '关系冲突',
      stage: '阶段冲突',
    }[type] ?? '冲突'
  );
}

function outfitCertaintyLabel(
  certainty: 'explicit' | 'inferred' | 'not_described',
): string {
  return (
    {
      explicit: '正文明确描写',
      inferred: '上下文推断',
      not_described: '正文未描写',
    }[certainty] ?? '正文未描写'
  );
}

function replaceChapterOutfitReportSection(
  markdownReport: string,
  outfits: NonNullable<ReferenceCreativeProfile['chapterCharacterOutfits']>,
): string {
  const section = [
    '## 分章人物服装',
    ...(outfits.length > 0
      ? outfits.flatMap((chapter) => [
          `### ${chapter.chapter}`,
          ...(chapter.characters.length > 0
            ? chapter.characters.map(
                (item) =>
                  `- **${item.name}**：${item.outfit || '正文未描写'}（${outfitCertaintyLabel(item.certainty)}）${
                    item.evidence ? `；依据：${item.evidence}` : ''
                  }`,
              )
            : ['- 本章未提取到具名人物']),
        ])
      : ['- 未提取到分章服装信息。']),
  ].join('\n');
  const existingSection = /\n## 分章人物服装[\s\S]*?(?=\n## 文风与节奏统计)/u;
  if (existingSection.test(markdownReport)) {
    return markdownReport.replace(existingSection, `\n${section}\n`);
  }
  return `${markdownReport.trim()}\n\n${section}`;
}

function normalizeDepth(value: unknown): ReferenceAnalysisDepth {
  if (value === 'quick' || value === 'standard' || value === 'deep') return value;
  return 'standard';
}

function normalizeDimensions(values: unknown): ReferenceTransferDimension[] {
  if (!Array.isArray(values)) return [];
  const set = new Set<ReferenceTransferDimension>();
  for (const v of values) {
    if (typeof v === 'string' && (REFERENCE_TRANSFER_DIMENSIONS as readonly string[]).includes(v)) {
      set.add(v as ReferenceTransferDimension);
    }
  }
  return [...set];
}

function filterMethods(
  methods: ReferenceTransferableMethod[],
  dimensions: ReferenceTransferDimension[],
): ReferenceTransferableMethod[] {
  const set = new Set(dimensions);
  return methods.filter((m) => set.has(m.dimension));
}

function uniqueAnalysisProjectName(title: string, novelId: string): string {
  const suffix = ` · ${novelId.replace(/-/g, '').slice(0, 8)}`;
  const prefix = `小说拆解 · ${title}`.slice(0, Math.max(8, 96 - suffix.length));
  return `${prefix}${suffix}`;
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return error instanceof Error && error.name === 'AbortError';
}

function toSummary(novel: StoredReferenceNovel): ReferenceNovelSummary {
  return {
    id: novel.id,
    title: novel.title,
    author: novel.author,
    depth: novel.depth,
    status: novel.status,
    chapterCount: novel.chapters.length,
    wordCount: novel.chapters.reduce((s, c) => s + c.wordCount, 0),
    createdAt: novel.createdAt,
    updatedAt: novel.updatedAt,
    errorMessage: novel.errorMessage,
  };
}

function toDetail(novel: StoredReferenceNovel): ReferenceNovelDetail {
  return {
    ...toSummary(novel),
    profile: novel.profile,
    hasRawText: !novel.rawPurged && novel.chapters.some((c) => c.content.trim().length > 0),
    chapters: novel.chapters.map((c) => ({
      id: c.id,
      number: c.number,
      title: c.title,
      wordCount: c.wordCount,
      metrics: c.metrics,
      summary: c.summary,
      functions: c.functions,
      openHook: c.openHook,
      endHook: c.endHook,
      characters: c.characters,
      contentPreview: c.content.replace(/\s+/g, ' ').slice(0, 160),
    })),
  };
}

function inferTitle(text: string, fallback?: string): string {
  const first = text.split(/\n/).map((l) => l.trim()).find((l) => l.length >= 2 && l.length <= 40);
  if (first && !/^第.+[章节]/.test(first)) return normalizeReferenceTitle(first).slice(0, 32);
  return normalizeReferenceTitle(fallback || '未命名参考作').slice(0, 32);
}

function normalizeReferenceTitle(value: string): string {
  return value
    .replace(/^#{1,6}\s+/u, '')
    .replace(/^(?:书名|名称)\s*[:：]\s*/u, '')
    .trim();
}

function resolveSelectedChapters(
  novel: StoredReferenceNovel,
  request: ReferenceAnalyzeRequest,
): StoredReferenceNovel['chapters'] {
  const byId = new Map(novel.chapters.map((c) => [c.id, c]));
  const byNum = new Map(novel.chapters.map((c) => [c.number, c]));

  if (Array.isArray(request.chapterIds) && request.chapterIds.length > 0) {
    const out: StoredReferenceNovel['chapters'] = [];
    for (const id of request.chapterIds) {
      const ch = byId.get(id);
      if (ch) out.push(ch);
    }
    return out.sort((a, b) => a.number - b.number);
  }

  if (Array.isArray(request.chapterNumbers) && request.chapterNumbers.length > 0) {
    const out: StoredReferenceNovel['chapters'] = [];
    for (const n of request.chapterNumbers) {
      if (typeof n !== 'number' || !Number.isFinite(n)) continue;
      const ch = byNum.get(Math.round(n));
      if (ch) out.push(ch);
    }
    return out.sort((a, b) => a.number - b.number);
  }

  // 未指定：默认全书（受 MAX_CHAPTERS_SELECT 截断）
  return novel.chapters.slice(0, MAX_CHAPTERS_SELECT);
}

/** 从前中后均匀抽取最多 max 章（保持顺序）。 */
function evenlyPick<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  if (max <= 1) return [items[0]!];
  const indexes = new Set<number>();
  for (let i = 0; i < max; i += 1) {
    indexes.add(Math.min(items.length - 1, Math.floor((i * (items.length - 1)) / (max - 1))));
  }
  return [...indexes].sort((a, b) => a - b).map((i) => items[i]!);
}

function localChapterHints(content: string, title: string): {
  summary: string;
  functions: string[];
  openHook: string;
  endHook: string;
  characters: string[];
} {
  const compact = content.replace(/\s+/g, ' ').trim();
  const summary = `${title}：${compact.slice(0, 100)}`;
  const functions: string[] = [];
  if (/战斗|杀|打|战|逃|追|逼|阻|争|敌|威胁|危险|审问|对抗|冲突/.test(compact)) {
    functions.push('冲突推进');
  }
  if (/说|问|道|「|“/.test(compact)) functions.push('对话');
  if (/想起|曾经|记忆|伏笔|预言|秘密|谜|异常|不明/.test(compact)) functions.push('伏笔/悬念');
  if (/突然|却|竟然|原来|没想到|真相|身份/.test(compact)) functions.push('反转/揭示');
  if (/终于|反杀|击败|救下|成功|揭开|兑现|复仇|洗清|夺回|突破/.test(compact)) {
    functions.push('爽点/兑现');
  }
  if (functions.length === 0) functions.push('推进');
  const openHook = compact.slice(0, 40);
  const endHook = compact.slice(-40);
  const characters: string[] = [];
  const stopNames = /^(?:老人们|人们|众人|有人|没人|没有人|男人|女人|少年|少女|孩子|掌柜|官兵|弟子|师父|先生|姑娘|对方|自己|他们|她们|我们|你们|这人|那人)$/u;
  for (const m of compact.matchAll(/([\p{Script=Han}]{2,4})(?:说|道|问|答|笑|怒|看向|望着|走进|走出|抬头|摇头|点头|皱眉|转身|不信|没有|将|把)/gu)) {
    if (characters.length >= 8) break;
    const name = m[1]!;
    if (!stopNames.test(name) && !name.endsWith('们') && !characters.includes(name)) {
      characters.push(name);
    }
  }
  return { summary, functions, openHook, endHook, characters };
}

function buildLocalContentBreakdown(novel: StoredReferenceNovel): {
  characters: NonNullable<ReferenceCreativeProfile['characters']>;
  conflicts: NonNullable<ReferenceCreativeProfile['conflicts']>;
  payoffs: NonNullable<ReferenceCreativeProfile['payoffs']>;
  worldbuilding: NonNullable<ReferenceCreativeProfile['worldbuilding']>;
  plotOutline: NonNullable<ReferenceCreativeProfile['plotOutline']>;
  foreshadowing: NonNullable<ReferenceCreativeProfile['foreshadowing']>;
  reversals: NonNullable<ReferenceCreativeProfile['reversals']>;
  chapterCharacterOutfits: NonNullable<ReferenceCreativeProfile['chapterCharacterOutfits']>;
  themes: string[];
} {
  const fullText = novel.chapters.map((chapter) => chapter.content).join('\n');
  const characters = extractCharacterCandidates(fullText)
    .slice(0, 12)
    .map(({ name, count }, index) => ({
      name,
      role: index === 0 ? '主要人物（本地识别）' : '关键人物（本地识别）',
      identity: `正文中出现约 ${count} 次；具体身份需模型确认`,
      goal: '需模型结合全文确认',
      motivation: '需模型结合全文确认',
      traits: [],
      arc: '需模型结合全文确认',
      keyActions: novel.chapters
        .filter((chapter) => chapter.content.includes(name))
        .slice(0, 4)
        .map((chapter) => chapter.summary ?? chapter.title),
    }));
  const chapterCharacterOutfits = extractLocalChapterCharacterOutfits(novel, characters);

  const plotOutline = novel.chapters.map((chapter) => ({
    stage: chapter.title,
    chapters: `第${chapter.number}章`,
    summary: chapter.summary ?? `${chapter.title}（待模型概括）`,
    turningPoint: chapter.endHook ? `章末：${chapter.endHook}` : '待模型确认',
  }));

  const conflicts = novel.chapters
    .filter((chapter) => chapter.functions?.some((item) => item.includes('冲突')))
    .slice(0, 16)
    .map((chapter) => ({
      type: 'stage' as const,
      parties: chapter.characters ?? [],
      description: `候选冲突章节｜${chapter.summary ?? chapter.title}`,
      stakes: '需模型结合前后文确认',
      progression: `${chapter.title}推进该冲突。`,
    }));

  const payoffs = novel.chapters
    .filter((chapter) => chapter.functions?.includes('爽点/兑现'))
    .slice(0, 16)
    .map((chapter) => ({
      title: `${chapter.title}的候选兑现节点`,
      setup: '需模型结合前文确认',
      trigger: chapter.summary ?? chapter.title,
      payoff: chapter.endHook ?? chapter.summary ?? chapter.title,
      impact: '需模型结合后续确认',
      chapter: `第${chapter.number}章`,
    }));

  const foreshadowing = novel.chapters
    .filter((chapter) => chapter.functions?.includes('伏笔/悬念'))
    .slice(0, 16)
    .map((chapter) => ({
      setup: chapter.summary ?? chapter.title,
      payoff: '尚需模型跨章节核对',
      status: 'uncertain' as const,
    }));

  const reversals = novel.chapters
    .filter((chapter) => chapter.functions?.includes('反转/揭示'))
    .slice(0, 16)
    .map((chapter) => ({
      setup: chapter.openHook ?? chapter.title,
      reversal: chapter.summary ?? chapter.title,
      effect: chapter.endHook ?? '需模型结合后续确认',
      chapter: `第${chapter.number}章`,
    }));

  const terminology = extractFrequentTerms(fullText);
  const ruleSentences = fullText
    .split(/[。！？\n]/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 8 && sentence.length <= 80)
    .filter((sentence) => /规矩|必须|不能|不得|只有|一旦|如果|若|会被|称为|叫作|意味着/u.test(sentence))
    .slice(0, 12);
  const worldbuilding = {
    premise: ruleSentences[0] ?? '需模型结合全文概括世界观前提',
    rules: ruleSentences,
    factions: terminology.filter((term) => /署|司|院|宫|堂|门|宗|会|盟|局|府$/u.test(term)),
    locations: terminology.filter((term) => /城|江|河|海|山|楼|塔|港|街|宫|堂|库|客栈$/u.test(term)),
    systems: terminology.filter((term) => /术|法|灯|器|印|诀|阵|能力|制度$/u.test(term)),
    history: [],
    terminology,
  };

  return {
    characters,
    conflicts,
    payoffs,
    worldbuilding,
    plotOutline,
    foreshadowing,
    reversals,
    chapterCharacterOutfits,
    themes: [],
  };
}

function extractLocalChapterCharacterOutfits(
  novel: StoredReferenceNovel,
  characters: NonNullable<ReferenceCreativeProfile['characters']>,
): NonNullable<ReferenceCreativeProfile['chapterCharacterOutfits']> {
  const garmentPattern =
    /短褂|长褂|长袍|衣衫|袍|裙|裤|夹克|外套|大衣|风衣|卫衣|衬衫|T恤|校服|制服|西装|斗篷|披风|蓑衣|围巾|帽子?|鞋|靴|袜|领带|腰带|发带|头巾|手套/u;
  const wearingPattern =
    /穿着|身穿|穿了|穿上|换上|换下|披着|披了|披好|套着|套上|裹着|着一袭|一袭|一身/u;
  const descriptiveGarmentPattern =
    /(?:白|黑|红|灰|青|蓝|绿|紫|黄|深色|浅色|素色|破旧|崭新|宽大|紧身).{0,6}(?:短褂|长褂|长袍|衣衫|袍|裙|裤|夹克|外套|大衣|风衣|卫衣|衬衫|T恤|校服|制服|西装|斗篷|披风|蓑衣|围巾|帽子?|鞋|靴|袜|领带|腰带|发带|头巾|手套)/u;
  const nonDescriptionPattern =
    /袖中|袖里|衣领|衣襟|袖口|缝衣|洗衣|衣柜|衣架|衣物|衣服里|塞进|藏进|取出/u;

  return [...novel.chapters]
    .sort((left, right) => left.number - right.number)
    .map((chapter) => {
      const presentCharacters = characters.filter((character) =>
        chapter.content.includes(character.name),
      );
      const sentences = chapter.content
        .split(/(?<=[。！？；\n])/u)
        .map((sentence) => sentence.trim())
        .filter(Boolean);
      return {
        chapter: chapter.title,
        characters: presentCharacters.map((character) => {
          const evidence = sentences.find(
            (sentence) =>
              sentence.includes(character.name) &&
              garmentPattern.test(sentence) &&
              !nonDescriptionPattern.test(sentence) &&
              (wearingPattern.test(sentence) || descriptiveGarmentPattern.test(sentence)),
          );
          return {
            name: character.name,
            outfit: evidence ? evidence.slice(0, 100) : '正文未描写',
            evidence: evidence ? evidence.slice(0, 80) : '',
            certainty: evidence ? ('explicit' as const) : ('not_described' as const),
          };
        }),
      };
    })
    .filter((chapter) => chapter.characters.length > 0);
}

function mergeChapterOutfitCoverage(
  chapters: StoredReferenceNovel['chapters'],
  characters: NonNullable<ReferenceCreativeProfile['characters']>,
  remote: NonNullable<ReferenceCreativeProfile['chapterCharacterOutfits']>,
  local: NonNullable<ReferenceCreativeProfile['chapterCharacterOutfits']>,
): NonNullable<ReferenceCreativeProfile['chapterCharacterOutfits']> {
  const normalizeChapterTitle = (value: string) =>
    value.replace(/\s+/gu, '').replace(/[｜|].*$/u, '').trim();
  const findChapter = (
    source: NonNullable<ReferenceCreativeProfile['chapterCharacterOutfits']>,
    title: string,
  ) => {
    const normalizedTitle = normalizeChapterTitle(title);
    return source.find((item) => {
      const normalizedItem = normalizeChapterTitle(item.chapter);
      return (
        normalizedItem === normalizedTitle ||
        normalizedItem.includes(normalizedTitle) ||
        normalizedTitle.includes(normalizedItem)
      );
    });
  };

  return [...chapters]
    .sort((left, right) => left.number - right.number)
    .map((chapter) => {
      const remoteCharacters = findChapter(remote, chapter.title)?.characters ?? [];
      const localCharacters = findChapter(local, chapter.title)?.characters ?? [];
      const baseCharacters = remoteCharacters.length > 0 ? remoteCharacters : localCharacters;
      const merged = new Map<
        string,
        NonNullable<ReferenceCreativeProfile['chapterCharacterOutfits']>[number]['characters'][number]
      >();

      for (const item of baseCharacters) {
        if (!item.name.trim() || merged.has(item.name.trim())) continue;
        let certainty =
          item.certainty === 'explicit' ||
          item.certainty === 'inferred' ||
          item.certainty === 'not_described'
            ? item.certainty
            : 'not_described';
        if (
          certainty === 'inferred' &&
          !/同一场景|紧接上章|承接上章|随后|仍穿|仍是|未离开/u.test(item.evidence)
        ) {
          certainty = 'not_described';
        }
        merged.set(item.name.trim(), {
          name: item.name.trim(),
          outfit:
            certainty === 'not_described'
              ? '正文未描写'
              : item.outfit.trim() || '正文未描写',
          evidence: certainty === 'not_described' ? '' : item.evidence.trim().slice(0, 80),
          certainty:
            certainty !== 'not_described' && !item.outfit.trim()
              ? 'not_described'
              : certainty,
        });
      }

      for (const character of characters) {
        if (!chapter.content.includes(character.name) || merged.has(character.name)) continue;
        merged.set(character.name, {
          name: character.name,
          outfit: '正文未描写',
          evidence: '',
          certainty: 'not_described',
        });
      }

      return {
        chapter: chapter.title,
        characters: [...merged.values()],
      };
    });
}

function extractFrequentTerms(text: string): string[] {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(/[\p{Script=Han}]{2,8}(?:城|江|河|海|山|署|司|院|宫|堂|楼|塔|门|宗|族|会|盟|局|府|港|街|库|灯|术|法|器|印|诀|阵|客栈)/gu)) {
    const term = match[0]!;
    if (term.length > 10) continue;
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 24)
    .map(([term]) => term);
}

function extractCharacterCandidates(text: string): Array<{ name: string; count: number }> {
  const candidates = new Set<string>();
  const commonSurnames =
    '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟黄萧尹姚邵汪祁毛狄米贝戴宋庞熊纪舒屈项祝董梁杜阮蓝闵席季贾路危江童颜郭梅盛林刁钟徐高夏蔡田樊胡凌霍虞万柯卢莫房裘缪丁宣邓单杭洪包诸左石崔吉龚程嵇邢裴陆荣翁荀羊惠曲封储靳段巫焦牧谷车侯全班秋仲伊宁仇甘厉祖武符刘景詹束龙叶黎薄白怀蒲鄂咸赖卓蔺屠池乔闻翟谭申冉桑桂牛通燕浦尚温庄晏柴瞿阎艾容向古易慎戈廖冷辛简饶曾沙关查游权盖益桓';
  const titlePrefixes = /^(?:掌灯使|巡雾使|院首|掌柜|船夫|巡官|术士|女子|男子|老人|少年|少女|灯使)/u;
  const invalid =
    /^(?:低声|轻声|沉声|冷声|高声|大声|忽然|突然|什么|为什么|怎么|而是|两人|一个|两个|三个|一只|一条|有人|没人|众人|自己|对方|此人|那人|这人|死者|活人|走路|几乎|仍然|已经|只是|只能|仿佛|原来|里面|外面|时候|东西|底部|内侧|姓名|名字|最后|空白|不知|母亲|父亲|男孩|女孩|孩子|老人|男人|女人)$/u;
  for (const match of text.matchAll(/([\p{Script=Han}]{2,7})(?=说|道|问|答|笑|怒|看向|望着|走进|走出|抬头|摇头|点头|皱眉|转身|不信|没有|将|把)/gu)) {
    let name = match[1]!.replace(titlePrefixes, '');
    if (name.length > 4) name = name.slice(-4);
    name = name.replace(/^(?:灯使|院首|巡官|术士)/u, '');
    if (name.length < 2 || name.length > 4) continue;
    if (invalid.test(name) || name.endsWith('们')) continue;
    if (/^(?:什么|怎么|一个|两个|三个|里面|外面|底部|内侧|走路)/u.test(name)) continue;
    if (/^第[一二三四五六七八九十百千万\d]/u.test(name)) continue;
    if (/^[一二三四五六七八九十百千万零两\d]/u.test(name)) continue;
    if (/(?:城|港|江|河|海|山|署|司|院|宫|堂|楼|塔|门|宗|族|会|盟|局|府|街|库|钟|客栈)$/u.test(name)) continue;
    candidates.add(name);
  }
  return [...candidates]
    .map((name) => ({
      name,
      count: Math.max(0, text.split(name).length - 1),
    }))
    .filter(
      (item) =>
        item.count >= 2 &&
        (commonSurnames.includes(item.name[0]!) || /^[阿小]/u.test(item.name) || item.count >= 5),
    )
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, 'zh-CN'));
}

function buildLocalProfile(
  novel: StoredReferenceNovel,
  style: ReferenceCreativeProfile['style'],
  pacing: ReferenceCreativeProfile['pacing'],
  selectedCount?: number,
): ReferenceCreativeProfile {
  const scopeNote =
    selectedCount !== undefined && selectedCount < novel.chapters.length
      ? `（基于勾选的 ${selectedCount}/${novel.chapters.length} 章）`
      : `（基于入库 ${novel.chapters.length} 章）`;
  const content = buildLocalContentBreakdown(novel);
  const methods: ReferenceTransferableMethod[] = [
    {
      dimension: 'pacing',
      title: '章节长度节奏',
      method: `维持接近均章 ${pacing.avgChapterWords} 字，短长章交替（短章比≈${pacing.shortChapterRatio}）${scopeNote}。`,
      why: '章长分布影响连载阅读体验。',
      howToApply: '为原创项目设定目标章长区间，高潮章可加长，过渡章缩短。',
    },
    {
      dimension: 'payoff_frequency',
      title: '冲突/爽点间隔',
      method: `约每 ${pacing.estimatedSmallConflictEveryN} 章安排小冲突，每 ${pacing.estimatedMajorPayoffEveryN} 章安排阶段兑现。`,
      why: '规律刺激点维持追读。',
      howToApply: '在大纲上标注小冲突与阶段目标兑现节点，避免连续空转。',
    },
    {
      dimension: 'dialogue_density',
      title: '对话密度',
      method: `对话占比约 ${style.dialogueRatio}，用对白推进信息与关系。`,
      why: '对话密度决定节奏感与信息释放方式。',
      howToApply: '关键信息优先用角色冲突对白释放，而非长篇说明。',
    },
    {
      dimension: 'description_density',
      title: '描写密度',
      method: `描写占比约 ${style.descriptionRatio}，环境信息服务情节。`,
      why: '描写过多拖节奏，过少缺沉浸。',
      howToApply: '每场景 1–2 处有效感官细节即可，绑定人物目标。',
    },
    {
      dimension: 'style',
      title: '句长与节奏标签',
      method: `平均句长约 ${style.avgSentenceLength}，整体节奏「${style.rhythmLabel}」。`,
      why: '句长影响情绪与阅读速度。',
      howToApply: '紧张场面缩短句长，抒情场面可略拉长，但避免整章长句堆叠。',
    },
    {
      dimension: 'chapter_structure',
      title: '章末钩子',
      method: '多数章节以未决问题、危险、新信息或关系变化收束。',
      why: '断章驱动连载。',
      howToApply: '每章结尾留下下一章必须回应的具体钩子，避免假悬念。',
    },
    {
      dimension: 'characterization',
      title: '行动塑造',
      method: '人物性格主要通过选择与行动展示，而非长篇介绍。',
      why: '行动塑造更可迁移且不易抄设定。',
      howToApply: '给角色两难选择，用选择结果体现性格与成长。',
    },
    {
      dimension: 'suspense',
      title: '信息延迟释放',
      method: '关键信息分章投放，先给结果或异常再补原因。',
      why: '悬念来自信息差而非堆谜语。',
      howToApply: '列出读者已知/角色已知矩阵，控制揭晓时机。',
    },
    {
      dimension: 'worldbuilding_delivery',
      title: '设定嵌入叙事',
      method: '世界观通过冲突与行动展示，减少一次性设定倾倒。',
      why: '展示方式可迁移，专有设定不可迁移。',
      howToApply: '新规则必须在 1–3 章内产生剧情作用。',
    },
    {
      dimension: 'emotion_curve',
      title: '情绪起伏',
      method: '压制与释放交替，高潮后安排缓冲。',
      why: '情绪曲线决定爽感与疲劳。',
      howToApply: '大纲标注压抑章与释放章，避免连续同强度情绪。',
    },
  ];

  const report = [
    `# 小说内容拆解：${novel.title}`,
    '',
    '> 当前为本地基础提取；配置真实模型后会补全人物动机、关系演变、冲突因果、爽点铺垫与完整大纲。',
    '',
    '## 剧情大纲',
    ...content.plotOutline.map(
      (beat) => `- **${beat.chapters}｜${beat.stage}**：${beat.summary}｜转折：${beat.turningPoint}`,
    ),
    '',
    '## 人物',
    ...(content.characters.length > 0
      ? content.characters.map((character) => `- **${character.name}**：${character.identity}`)
      : ['- 本地未可靠识别人名；需配置真实模型完成角色拆解。']),
    '',
    '## 冲突',
    ...(content.conflicts.length > 0
      ? content.conflicts.map((conflict) => `- ${conflict.description}`)
      : ['- 本地未可靠识别冲突链；需配置真实模型完成因果分析。']),
    '',
    '## 爽点与兑现',
    ...(content.payoffs.length > 0
      ? content.payoffs.map((payoff) => `- **${payoff.chapter}｜${payoff.title}**：${payoff.payoff}`)
      : ['- 本地未可靠识别明确兑现节点；需配置真实模型跨章节核对。']),
    '',
    '## 世界观',
    `- 前提：${content.worldbuilding.premise}`,
    ...content.worldbuilding.rules.map((rule) => `- 规则：${rule}`),
    ...content.worldbuilding.terminology.map((term) => `- 专名：${term}`),
    '',
    '## 本地统计',
    ...style.notes.map((n) => `- ${n}`),
    ...pacing.notes.map((n) => `- ${n}`),
    '',
    '## 附录：可迁移写法（非内容拆解）',
    ...methods.map((m) => `- [${DIMENSION_LABELS[m.dimension]}] ${m.method}`),
  ].join('\n');

  return {
    oneLineSummary: `对《${novel.title}》的内容向基础拆解${scopeNote}。`,
    genreGuess: '待模型判定或用户补充',
    coreConflict: '本地只能定位潜在冲突章节；需配置真实模型确认核心冲突与冲突双方',
    mainPlotAbstract: content.plotOutline.map((beat) => beat.summary).join(' → ').slice(0, 1600),
    characters: content.characters,
    relationships: [],
    conflicts: content.conflicts,
    payoffs: content.payoffs,
    worldbuilding: content.worldbuilding,
    plotOutline: content.plotOutline,
    foreshadowing: content.foreshadowing,
    reversals: content.reversals,
    chapterCharacterOutfits: content.chapterCharacterOutfits,
    themes: content.themes,
    characterMethods: ['行动塑造', '对话塑造', '危机反应'],
    worldbuildingDelivery: ['冲突展示', '对话解释', '环境展示'],
    style,
    pacing,
    transferableMethods: methods,
    strengths: style.notes.slice(0, 3),
    risks: ['若照搬原作事件链将产生同质化与侵权风险'],
    doNotCopy: [
      '原作人物姓名与身份组合',
      '原作地名、组织、能力专名',
      '原作完整剧情与独特句子',
      '标志性比喻与连续表达',
    ],
    markdownReport: report,
  };
}

export function parseProfileJson(raw: string): Partial<ReferenceCreativeProfile> {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return {};
  const jsonText = raw.slice(start, end + 1);
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(jsonText) as Record<string, unknown>;
  } catch {
    try {
      obj = JSON.parse(repairMalformedJsonStrings(jsonText)) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  try {
    const methods: ReferenceTransferableMethod[] = [];
    if (Array.isArray(obj.transferableMethods)) {
      for (const item of obj.transferableMethods.slice(0, 20)) {
        if (!item || typeof item !== 'object') continue;
        const m = item as Record<string, unknown>;
        const dimension = m.dimension;
        if (typeof dimension !== 'string' || !(REFERENCE_TRANSFER_DIMENSIONS as readonly string[]).includes(dimension)) {
          continue;
        }
        const title = typeof m.title === 'string' ? m.title.trim() : '';
        const method = typeof m.method === 'string' ? m.method.trim() : '';
        if (!method) continue;
        methods.push({
          dimension: dimension as ReferenceTransferDimension,
          title: title || DIMENSION_LABELS[dimension as ReferenceTransferDimension],
          method,
          why: typeof m.why === 'string' ? m.why.trim() : '',
          howToApply: typeof m.howToApply === 'string' ? m.howToApply.trim() : method,
        });
      }
    }
    const strArr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim()) : [];
    const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
    const record = (v: unknown): Record<string, unknown> | undefined =>
      v !== null && typeof v === 'object' && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : undefined;

    const characters: NonNullable<ReferenceCreativeProfile['characters']> = [];
    for (const item of Array.isArray(obj.characters) ? obj.characters.slice(0, 20) : []) {
      const value = record(item);
      if (!value || !str(value.name)) continue;
      characters.push({
        name: str(value.name),
        role: str(value.role) || '关键人物',
        identity: str(value.identity),
        goal: str(value.goal),
        motivation: str(value.motivation),
        traits: strArr(value.traits),
        arc: str(value.arc),
        keyActions: strArr(value.keyActions),
      });
    }

    const relationships: NonNullable<ReferenceCreativeProfile['relationships']> = [];
    for (const item of Array.isArray(obj.relationships) ? obj.relationships.slice(0, 30) : []) {
      const value = record(item);
      if (!value || !str(value.from) || !str(value.to)) continue;
      relationships.push({
        from: str(value.from),
        to: str(value.to),
        relation: str(value.relation),
        evolution: str(value.evolution),
      });
    }

    const conflicts: NonNullable<ReferenceCreativeProfile['conflicts']> = [];
    const conflictTypes = new Set(['core', 'external', 'internal', 'relationship', 'stage']);
    for (const item of Array.isArray(obj.conflicts) ? obj.conflicts.slice(0, 24) : []) {
      const value = record(item);
      if (!value || !str(value.description)) continue;
      const type = conflictTypes.has(str(value.type)) ? str(value.type) : 'stage';
      conflicts.push({
        type: type as NonNullable<ReferenceCreativeProfile['conflicts']>[number]['type'],
        parties: strArr(value.parties),
        description: str(value.description),
        stakes: str(value.stakes),
        progression: str(value.progression),
      });
    }

    const payoffs: NonNullable<ReferenceCreativeProfile['payoffs']> = [];
    for (const item of Array.isArray(obj.payoffs) ? obj.payoffs.slice(0, 24) : []) {
      const value = record(item);
      if (!value || !str(value.payoff)) continue;
      payoffs.push({
        title: str(value.title) || '兑现节点',
        setup: str(value.setup),
        trigger: str(value.trigger),
        payoff: str(value.payoff),
        impact: str(value.impact),
        chapter: str(value.chapter),
      });
    }

    const plotOutline: NonNullable<ReferenceCreativeProfile['plotOutline']> = [];
    for (const item of Array.isArray(obj.plotOutline) ? obj.plotOutline.slice(0, 40) : []) {
      const value = record(item);
      if (!value || !str(value.summary)) continue;
      plotOutline.push({
        stage: str(value.stage) || '剧情阶段',
        chapters: str(value.chapters),
        summary: str(value.summary),
        turningPoint: str(value.turningPoint),
      });
    }

    const foreshadowing: NonNullable<ReferenceCreativeProfile['foreshadowing']> = [];
    const foreshadowStatuses = new Set(['unresolved', 'partial', 'resolved', 'uncertain']);
    for (const item of Array.isArray(obj.foreshadowing) ? obj.foreshadowing.slice(0, 30) : []) {
      const value = record(item);
      if (!value || !str(value.setup)) continue;
      const status = foreshadowStatuses.has(str(value.status)) ? str(value.status) : 'uncertain';
      foreshadowing.push({
        setup: str(value.setup),
        payoff: str(value.payoff),
        status: status as NonNullable<ReferenceCreativeProfile['foreshadowing']>[number]['status'],
      });
    }

    const reversals: NonNullable<ReferenceCreativeProfile['reversals']> = [];
    for (const item of Array.isArray(obj.reversals) ? obj.reversals.slice(0, 24) : []) {
      const value = record(item);
      if (!value || !str(value.reversal)) continue;
      reversals.push({
        setup: str(value.setup),
        reversal: str(value.reversal),
        effect: str(value.effect),
        chapter: str(value.chapter),
      });
    }

    const chapterCharacterOutfits: NonNullable<
      ReferenceCreativeProfile['chapterCharacterOutfits']
    > = [];
    const outfitCertainties = new Set(['explicit', 'inferred', 'not_described']);
    for (const item of Array.isArray(obj.chapterCharacterOutfits)
      ? obj.chapterCharacterOutfits.slice(0, 80)
      : []) {
      const value = record(item);
      if (!value || !str(value.chapter)) continue;
      const chapterCharacters: NonNullable<
        ReferenceCreativeProfile['chapterCharacterOutfits']
      >[number]['characters'] = [];
      for (const rawCharacter of Array.isArray(value.characters)
        ? value.characters.slice(0, 30)
        : []) {
        const character = record(rawCharacter);
        if (!character || !str(character.name)) continue;
        const rawCertainty = str(character.certainty);
        const certainty = outfitCertainties.has(rawCertainty)
          ? rawCertainty
          : str(character.outfit)
            ? 'inferred'
            : 'not_described';
        chapterCharacters.push({
          name: str(character.name),
          outfit:
            certainty === 'not_described'
              ? '正文未描写'
              : str(character.outfit) || '正文未描写',
          evidence: str(character.evidence).slice(0, 120),
          certainty: certainty as NonNullable<
            ReferenceCreativeProfile['chapterCharacterOutfits']
          >[number]['characters'][number]['certainty'],
        });
      }
      chapterCharacterOutfits.push({
        chapter: str(value.chapter),
        characters: chapterCharacters,
      });
    }

    const world = record(obj.worldbuilding);
    const worldbuilding = world
      ? {
          premise: str(world.premise),
          rules: strArr(world.rules),
          factions: strArr(world.factions),
          locations: strArr(world.locations),
          systems: strArr(world.systems),
          history: strArr(world.history),
          terminology: strArr(world.terminology),
        }
      : undefined;

    return {
      oneLineSummary: typeof obj.oneLineSummary === 'string' ? obj.oneLineSummary.trim() : undefined,
      genreGuess: typeof obj.genreGuess === 'string' ? obj.genreGuess.trim() : undefined,
      coreConflict: typeof obj.coreConflict === 'string' ? obj.coreConflict.trim() : undefined,
      mainPlotAbstract: typeof obj.mainPlotAbstract === 'string' ? obj.mainPlotAbstract.trim() : undefined,
      characters,
      relationships,
      conflicts,
      payoffs,
      worldbuilding,
      plotOutline,
      foreshadowing,
      reversals,
      chapterCharacterOutfits,
      themes: strArr(obj.themes),
      characterMethods: strArr(obj.characterMethods),
      worldbuildingDelivery: strArr(obj.worldbuildingDelivery),
      transferableMethods: methods,
      strengths: strArr(obj.strengths),
      risks: strArr(obj.risks),
      doNotCopy: strArr(obj.doNotCopy),
    };
  } catch {
    return {};
  }
}

/**
 * DeepSeek 偶尔会在较长 JSON 字符串的末尾漏掉引号，直接换行后输出 `},`。
 * 这里只修复 JSON 字符串内部的非法控制字符，以及这种可明确判断的漏引号；
 * 不补字段、不猜内容，修复失败仍由调用方安全降级。
 */
function repairMalformedJsonStrings(input: string): string {
  let output = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;

    if (!inString) {
      output += character;
      if (character === '"') inString = true;
      continue;
    }

    if (escaped) {
      output += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      output += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      output += character;
      inString = false;
      continue;
    }
    if (character === '\t') {
      output += '\\t';
      continue;
    }
    if (character === '\r' || character === '\n') {
      const nextIndex =
        character === '\r' && input[index + 1] === '\n' ? index + 2 : index + 1;
      const nextText = input.slice(nextIndex);
      if (/^\s*[}\]],?/.test(nextText)) {
        output += '"';
        inString = false;
        output += '\n';
      } else {
        output += '\\n';
      }
      if (character === '\r' && input[index + 1] === '\n') index += 1;
      continue;
    }

    output += character;
  }

  return output;
}

function mergeProfiles(
  local: ReferenceCreativeProfile,
  remote: Partial<ReferenceCreativeProfile>,
  title: string,
): ReferenceCreativeProfile {
  const methods =
    remote.transferableMethods && remote.transferableMethods.length > 0
      ? remote.transferableMethods
      : local.transferableMethods;
  const characters = remote.characters?.length ? remote.characters : local.characters ?? [];
  const relationships = remote.relationships?.length
    ? remote.relationships
    : local.relationships ?? [];
  const conflicts = remote.conflicts?.length ? remote.conflicts : local.conflicts ?? [];
  const payoffs = remote.payoffs?.length ? remote.payoffs : local.payoffs ?? [];
  const plotOutline = remote.plotOutline?.length ? remote.plotOutline : local.plotOutline ?? [];
  const foreshadowing = remote.foreshadowing?.length
    ? remote.foreshadowing
    : local.foreshadowing ?? [];
  const reversals = remote.reversals?.length ? remote.reversals : local.reversals ?? [];
  const themes = remote.themes?.length ? remote.themes : local.themes ?? [];
  const chapterCharacterOutfits = remote.chapterCharacterOutfits?.length
    ? remote.chapterCharacterOutfits
    : local.chapterCharacterOutfits ?? [];
  const worldbuilding = remote.worldbuilding ?? local.worldbuilding ?? {
    premise: '未提取到可靠世界观前提',
    rules: [],
    factions: [],
    locations: [],
    systems: [],
    history: [],
    terminology: [],
  };
  const markdownReport = [
    `# 小说内容拆解：${title}`,
    '',
    `> ${remote.oneLineSummary ?? local.oneLineSummary}`,
    '',
    `类型判断：${remote.genreGuess ?? local.genreGuess}`,
    `核心冲突：${remote.coreConflict ?? local.coreConflict}`,
    '',
    '## 主线剧情',
    remote.mainPlotAbstract ?? local.mainPlotAbstract,
    '',
    '## 人物',
    ...(characters.length > 0
      ? characters.map((character) => [
          `### ${character.name}｜${character.role}`,
          `- 身份：${character.identity || '未确认'}`,
          `- 目标：${character.goal || '未确认'}`,
          `- 动机：${character.motivation || '未确认'}`,
          `- 性格：${character.traits.join('、') || '未确认'}`,
          `- 人物弧光：${character.arc || '未确认'}`,
          `- 关键行动：${character.keyActions.join('；') || '未确认'}`,
        ].join('\n'))
      : ['- 未提取到可靠人物信息。']),
    '',
    '## 人物关系',
    ...(relationships.length > 0
      ? relationships.map(
          (relationship) =>
            `- **${relationship.from} ↔ ${relationship.to}**：${relationship.relation || '关系未确认'}；演变：${relationship.evolution || '未确认'}`,
        )
      : ['- 未提取到可靠人物关系。']),
    '',
    '## 冲突链',
    ...(conflicts.length > 0
      ? conflicts.map(
          (conflict) =>
            `- **${conflict.type}｜${conflict.parties.join(' vs ') || '相关人物未确认'}**：${conflict.description}｜代价：${conflict.stakes || '未确认'}｜推进：${conflict.progression || '未确认'}`,
        )
      : ['- 未提取到可靠冲突链。']),
    '',
    '## 爽点与兑现',
    ...(payoffs.length > 0
      ? payoffs.map(
          (payoff) =>
            `- **${payoff.chapter || '章节未确认'}｜${payoff.title}**：铺垫「${payoff.setup || '未确认'}」→ 触发「${payoff.trigger || '未确认'}」→ 兑现「${payoff.payoff}」→ 影响「${payoff.impact || '未确认'}」`,
        )
      : ['- 未提取到可靠爽点/兑现节点。']),
    '',
    '## 世界观',
    `- **核心前提**：${worldbuilding.premise || '未确认'}`,
    ...worldbuilding.rules.map((item) => `- **规则**：${item}`),
    ...worldbuilding.factions.map((item) => `- **势力/组织**：${item}`),
    ...worldbuilding.locations.map((item) => `- **地点**：${item}`),
    ...worldbuilding.systems.map((item) => `- **体系**：${item}`),
    ...worldbuilding.history.map((item) => `- **历史**：${item}`),
    ...worldbuilding.terminology.map((item) => `- **专有名词**：${item}`),
    '',
    '## 剧情大纲',
    ...(plotOutline.length > 0
      ? plotOutline.map(
          (beat) =>
            `- **${beat.chapters || '章节未确认'}｜${beat.stage}**：${beat.summary}｜关键转折：${beat.turningPoint || '未确认'}`,
        )
      : ['- 未提取到可靠剧情大纲。']),
    '',
    '## 伏笔',
    ...(foreshadowing.length > 0
      ? foreshadowing.map(
          (item) => `- **${item.status}**：${item.setup} → ${item.payoff || '尚未兑现/未确认'}`,
        )
      : ['- 未提取到可靠伏笔链。']),
    '',
    '## 反转',
    ...(reversals.length > 0
      ? reversals.map(
          (item) =>
            `- **${item.chapter || '章节未确认'}**：${item.setup || '铺垫未确认'} → ${item.reversal}｜影响：${item.effect || '未确认'}`,
        )
      : ['- 未提取到可靠反转。']),
    '',
    '## 主题',
    ...(themes.length > 0 ? themes.map((item) => `- ${item}`) : ['- 未确认。']),
    '',
    '## 分章人物服装',
    ...(chapterCharacterOutfits.length > 0
      ? chapterCharacterOutfits.flatMap((chapter) => [
          `### ${chapter.chapter}`,
          ...(chapter.characters.length > 0
            ? chapter.characters.map(
                (item) =>
                  `- **${item.name}**：${item.outfit || '正文未描写'}（${outfitCertaintyLabel(item.certainty)}）${
                    item.evidence ? `；依据：${item.evidence}` : ''
                  }`,
              )
            : ['- 本章未提取到具名人物']),
        ])
      : ['- 未提取到分章服装信息。']),
    '',
    '## 文风与节奏统计',
    `- 句长 ${local.style.avgSentenceLength}｜对话比 ${local.style.dialogueRatio}｜描写比 ${local.style.descriptionRatio}｜节奏 ${local.style.rhythmLabel}`,
    ...local.style.notes.map((n) => `- ${n}`),
    ...local.pacing.notes.map((n) => `- ${n}`),
    '',
    '## 附录：可迁移写作方法（可选）',
    ...methods.map((m) => `- **${DIMENSION_LABELS[m.dimension]}｜${m.title}**：${m.method} → ${m.howToApply}`),
    '',
    '## 优点',
    ...(remote.strengths?.length ? remote.strengths : local.strengths).map((x) => `- ${x}`),
    '',
    '## 风险',
    ...(remote.risks?.length ? remote.risks : local.risks).map((x) => `- ${x}`),
    '',
    '## 严禁迁移',
    ...(remote.doNotCopy?.length ? remote.doNotCopy : local.doNotCopy).map((x) => `- ${x}`),
  ].join('\n');

  return {
    oneLineSummary: remote.oneLineSummary ?? local.oneLineSummary,
    genreGuess: remote.genreGuess ?? local.genreGuess,
    coreConflict: remote.coreConflict ?? local.coreConflict,
    mainPlotAbstract: remote.mainPlotAbstract ?? local.mainPlotAbstract,
    characters,
    relationships,
    conflicts,
    payoffs,
    worldbuilding,
    plotOutline,
    foreshadowing,
    reversals,
    themes,
    chapterCharacterOutfits,
    characterMethods: remote.characterMethods?.length ? remote.characterMethods : local.characterMethods,
    worldbuildingDelivery: remote.worldbuildingDelivery?.length
      ? remote.worldbuildingDelivery
      : local.worldbuildingDelivery,
    style: local.style,
    pacing: local.pacing,
    transferableMethods: methods,
    strengths: remote.strengths?.length ? remote.strengths : local.strengths,
    risks: remote.risks?.length ? remote.risks : local.risks,
    doNotCopy: remote.doNotCopy?.length ? remote.doNotCopy : local.doNotCopy,
    markdownReport,
  };
}

function hasMeaningfulModelExtraction(
  local: ReferenceCreativeProfile,
  synthesized: ReferenceCreativeProfile,
): boolean {
  return (
    synthesized.oneLineSummary !== local.oneLineSummary ||
    synthesized.genreGuess !== local.genreGuess ||
    synthesized.coreConflict !== local.coreConflict ||
    JSON.stringify(synthesized.characters ?? []) !== JSON.stringify(local.characters ?? []) ||
    JSON.stringify(synthesized.conflicts ?? []) !== JSON.stringify(local.conflicts ?? []) ||
    JSON.stringify(synthesized.payoffs ?? []) !== JSON.stringify(local.payoffs ?? []) ||
    JSON.stringify(synthesized.plotOutline ?? []) !== JSON.stringify(local.plotOutline ?? [])
  );
}
