/**
 * Agent 任务定义（单一数据源）。
 *
 * 从原 AgentCommandCenter 提炼，供 useAgentEngine 和 SlashMenu 共用。
 * 新增 / 修改任务时只改这里。
 */
import type { AgentRunMode, AgentTask } from '../../types/index.js';
import type { IconName } from '../Icon.js';

export interface AgentTaskDef {
  key: AgentTask;
  /** 斜杠命令名（不含 /）。 */
  slash: string;
  icon: IconName;
  title: string;
  desc: string;
  mode: AgentRunMode;
  /** 是否锁定模式（不允许可切换）。 */
  lockedMode?: boolean;
  placeholder: string;
  /** 是否需要先选中项目。 */
  needsProject?: boolean;
  /** 是否需要先选中章节。 */
  needsChapter?: boolean;
}

export const AGENT_TASKS: AgentTaskDef[] = [
  {
    key: 'novel',
    slash: '新书',
    icon: 'sparkles',
    title: '一键创建新书',
    desc: '输入题材或爽点，自动建项目、补设定、写首章。',
    mode: 'draft',
    placeholder: '例：赛博修仙学院，主角靠写代码御剑...',
  },
  {
    key: 'full_novel',
    slash: '整本',
    icon: 'bookOpen',
    title: '一键生成整本',
    desc: '建项目→设定→逐章自动写作，每章带长期记忆与反思自我进化（默认 3 章）。',
    mode: 'draft',
    lockedMode: true,
    placeholder: '例：废土机械师重建文明，节奏明快、多反转...',
  },
  {
    key: 'auto_next',
    slash: '下一章',
    icon: 'refresh',
    title: '一键写下一章',
    desc: '后端编排：建章 → 蓝图 → 分场景写作 → 合并正文（需先选项目）。',
    mode: 'draft',
    lockedMode: true,
    needsProject: true,
    placeholder: '可选：指定本章剧情走向；留空则自动顺接上一章。',
  },
  {
    key: 'title',
    slash: '按标题',
    icon: 'tag',
    title: '按标题生成',
    desc: '给一个书名或章节名，自动扩展题材、卖点和开篇方向。',
    mode: 'draft',
    placeholder: '例：我在废土开灵田',
  },
  {
    key: 'outline',
    slash: '大纲',
    icon: 'map',
    title: '大纲和设定',
    desc: '只生成世界观、人物护栏与卷一大纲，不写正文。',
    mode: 'reference',
    lockedMode: true,
    placeholder: '例：都市异能，主角能看见城市地下灵脉，节奏要快。',
  },
  {
    key: 'polish',
    slash: '润写',
    icon: 'penLine',
    title: '润写小说',
    desc: '参考模式出建议；成文模式直接润写（有选中章节时会写回）。',
    mode: 'reference',
    placeholder: '粘贴片段或说明：更热血 / 更悬疑 / 去掉废话。',
  },
  {
    key: 'diagnostic',
    slash: '诊断',
    icon: 'search',
    title: '综合测试',
    desc: '检查项目缺口、连贯性与下一步（需先选项目）。',
    mode: 'reference',
    lockedMode: true,
    needsProject: true,
    placeholder: '例：能否继续写第三章？列出缺口和建议。',
  },
  {
    key: 'material_research',
    slash: '素材',
    icon: 'fileText',
    title: '素材研究',
    desc: '搜索公开资料，提炼桥段结构、俗套风险和原创改写方向。',
    mode: 'reference',
    lockedMode: true,
    placeholder: '例：我想写一个退婚反杀桥段，但不要太老套。',
  },
  {
    key: 'trope_breakdown',
    slash: '拆梗',
    icon: 'puzzle',
    title: '拆梗',
    desc: '把一个桥段拆成冲突、动机、爽点、误会、反转和原创变体。',
    mode: 'reference',
    lockedMode: true,
    placeholder: '例：女主假退婚保护男主，男主误以为被羞辱。',
  },
  {
    key: 'cliche_guard',
    slash: '避俗',
    icon: 'search',
    title: '避俗检查',
    desc: '检查构思的老套风险、动机漏洞和假爽点，并给替代方案。',
    mode: 'reference',
    lockedMode: true,
    placeholder: '例：废柴主角获得传承后在宗门大比打脸众人。',
  },
  {
    key: 'chapter_diagnosis',
    slash: '章节诊断',
    icon: 'fileText',
    title: '章节诊断',
    desc: '读取当前章节，检查冲突、节奏、爽点兑现和人物动机。',
    mode: 'reference',
    lockedMode: true,
    needsProject: true,
    needsChapter: true,
    placeholder: '可留空：直接诊断当前章节；也可指定关注点。',
  },
  {
    key: 'workspace_review',
    slash: '审阅',
    icon: 'brain',
    title: '主动审阅',
    desc: '不等细指令，自动阅读当前项目并给出缺口、风险和下一步建议。',
    mode: 'reference',
    lockedMode: true,
    needsProject: true,
    placeholder: '可留空：Agent 会主动审阅当前项目。',
  },
];

export const TASK_PLANS: Record<AgentTask, string[]> = {
  novel: ['创建或复用项目', '世界观子 Agent', '人物子 Agent', '大纲子 Agent', '正文子 Agent 写首章'],
  full_novel: [
    '建项目 + 设定包',
    '写入初始故事记忆',
    '逐章生成（回灌记忆）',
    '每章反思自我进化',
    '累积连贯整本草稿',
  ],
  title: ['按标题建项', '扩展题材与卖点', '分步写入设定', '生成开篇正文'],
  outline: ['创建或复用项目', '世界观 / 人物 / 大纲分步生成', '保存到项目资料'],
  polish: ['解析润写需求', '载入章节（如有）', '润写子 Agent 输出', '保存建议或写回章节'],
  diagnostic: ['汇总章节与设定', '诊断子 Agent 分析', '保存诊断报告'],
  material_research: ['生成公开检索关键词', '检索 Wikisource / HN / RSS', '清洗资料片段', '提炼套路与原创建议', '保存 Markdown 报告'],
  trope_breakdown: ['识别桥段承诺', '拆冲突与人物动机', '拆爽点 / 误会 / 反转', '给原创变体', '保存拆梗报告'],
  cliche_guard: ['检查老套风险', '定位动机漏洞', '替换假爽点', '生成原创替代方案', '保存避俗报告'],
  chapter_diagnosis: ['读取当前章节', '汇总项目上下文', '诊断冲突 / 节奏 / 爽点', '给修改建议', '保存章节诊断报告'],
  workspace_review: ['读取全局项目快照', '主动评估缺口与风险', '写入下一步建议报告'],
  auto_next: ['推断章节序号', '回灌长期记忆', '生成蓝图', '分场景写作', '合并整章正文', '反思更新记忆'],
  plan_blueprint: ['解析章节需求', '读取 bible + outline + 记忆', '生成结构化蓝图 JSON (scenes + 字数+节奏)', '保存到 blueprints/'],
  write_scene: ['载入蓝图指定 scene', '按 must_include / purpose / 目标字数写正文', '保存 scenes/chapter_XX/scene_YY.md', '可选衔接检查'],
  write_chapter_from_blueprint: ['plan 或载入蓝图', '逐 scene write', 'merge 成整章', 'word_count + pacing report', '可选 expand/rewrite 循环'],
};

/** 根据 slash 名查找任务定义。 */
export function findTaskBySlash(slash: string): AgentTaskDef | undefined {
  return AGENT_TASKS.find((t) => t.slash === slash);
}
