/**
 * NovelPlanService — 开局「计划模式 / 头脑风暴」。
 *
 * 进入时先选深度：
 * - light     轻量 4～5 轮
 * - standard  中等 8～10 轮
 * - deep      极限详细约 20 轮
 *
 * 多轮结构化追问 → 必须补齐「总字数 / 每章字数 / 章节数」→ Agent 生成分章大纲
 * → 产出 brief + planSummary，再交给 novel / full_novel / long_novel 写正文。
 */
import type { ModelProxy } from '../../proxy/ModelProxy.js';
import type {
  ChatMessage,
  ModelConfig,
  NovelPlanAnswer,
  NovelPlanChapterOutline,
  NovelPlanDepth,
  NovelPlanHistoryTurn,
  NovelPlanQuestion,
  NovelPlanSummary,
  NovelPlanTargetTask,
  NovelPlanTurnRequest,
  NovelPlanTurnResponse,
} from '../../types/index.js';
import { ServiceError } from '../ServiceError.js';
import type { ModelConfigService } from '../modelConfig/ModelConfigService.js';
import { stripReasoningArtifacts } from '../text/reasoningSanitizer.js';

const MAX_QUESTIONS_PER_TURN = 3;
const MAX_OPTIONS_PER_QUESTION = 5;
export const MAX_OUTLINE_CHAPTERS = 30;
const DEFAULT_WORDS_PER_CHAPTER = 2000;
const DEFAULT_CHAPTER_COUNT = 10;

/** 各深度内容追问轮次（不含「选深度」那一轮）。 */
export const DEPTH_LIMITS: Record<NovelPlanDepth, { min: number; max: number; label: string }> = {
  light: { min: 4, max: 5, label: '轻量模式' },
  standard: { min: 8, max: 10, label: '中等模式' },
  deep: { min: 18, max: 20, label: '极限详细模式' },
};

const TARGET_LABELS: Record<NovelPlanTargetTask, string> = {
  novel: '一键创建新书（设定 + 首章）',
  full_novel: '一键生成整本',
  long_novel: '长篇小说模式（质量门控）',
  outline: '大纲与设定（不写正文）',
  title: '按标题扩展并开篇',
};

interface ScriptRound {
  id: string;
  message: string;
  questions: NovelPlanQuestion[];
  /** 是否为规模轮（总字数/每章/章数）。 */
  isScale?: boolean;
}

const Q = {
  genre: {
    id: 'genre_lane',
    question: '这本书更靠近哪条赛道？',
    options: [
      { id: 'xuanhuan', label: '玄幻 / 修仙', description: '升级打脸、势力争锋' },
      { id: 'dushi', label: '都市 / 异能', description: '现实壳 + 超凡' },
      { id: 'kehuan', label: '科幻 / 赛博', description: '科技设定驱动' },
      { id: 'yanqing', label: '言情 / 情感', description: '关系与情绪主线' },
      { id: 'xuanyi', label: '悬疑 / 惊悚', description: '谜题与压迫感' },
    ],
  } satisfies NovelPlanQuestion,
  hook: {
    id: 'core_hook',
    question: '开篇最强钩子是？',
    options: [
      { id: 'face_slap', label: '打脸爽点' },
      { id: 'mystery', label: '悬念谜团' },
      { id: 'relationship', label: '人物关系' },
      { id: 'world_wonder', label: '世界观奇观' },
      { id: 'crisis', label: '生死危机' },
    ],
  } satisfies NovelPlanQuestion,
  desire: {
    id: 'protag_desire',
    question: '主角最想得到什么？',
    options: [
      { id: 'power', label: '力量 / 地位' },
      { id: 'revenge', label: '复仇 / 正名' },
      { id: 'survive', label: '活下去' },
      { id: 'love', label: '爱情 / 羁绊' },
      { id: 'truth', label: '真相 / 自由' },
    ],
  } satisfies NovelPlanQuestion,
  flaw: {
    id: 'protag_flaw',
    question: '主角最大的缺点是？',
    options: [
      { id: 'trust', label: '轻信' },
      { id: 'pride', label: '好强 / 面子' },
      { id: 'coward', label: '怂但清醒' },
      { id: 'obsess', label: '执念过深' },
      { id: 'cold', label: '情感迟钝' },
    ],
  } satisfies NovelPlanQuestion,
  tone: {
    id: 'tone_pace',
    question: '整体基调与节奏？（可多选）',
    multiSelect: true,
    options: [
      { id: 'fast', label: '快节奏推进' },
      { id: 'humor', label: '轻松幽默' },
      { id: 'dark', label: '偏暗黑沉重' },
      { id: 'warm', label: '热血励志' },
      { id: 'slow_burn', label: '细腻慢热' },
    ],
  } satisfies NovelPlanQuestion,
  worldFeel: {
    id: 'world_feel',
    question: '世界更接近哪种感觉？',
    options: [
      { id: 'sect', label: '宗门 / 学院' },
      { id: 'city', label: '现代都市' },
      { id: 'empire', label: '王朝 / 帝国' },
      { id: 'wasteland', label: '废土 / 末世' },
      { id: 'mix', label: '多重世界 / 副本' },
    ],
  } satisfies NovelPlanQuestion,
  worldRule: {
    id: 'world_rule',
    question: '世界里最重要的特殊规则是？',
    options: [
      { id: 'power_rank', label: '清晰的力量等级' },
      { id: 'resource', label: '资源稀缺争夺' },
      { id: 'secret', label: '隐藏真相体系' },
      { id: 'system', label: '系统 / 面板' },
      { id: 'soft', label: '规则偏软，重人物' },
    ],
  } satisfies NovelPlanQuestion,
  villain: {
    id: 'villain_type',
    question: '主要阻力更像？',
    options: [
      { id: 'org', label: '宗门 / 公司 / 势力' },
      { id: 'rival', label: '天才对手' },
      { id: 'system_op', label: '体制与规则' },
      { id: 'monster', label: '灾厄 / 外敌' },
      { id: 'inner', label: '主角内心执念' },
    ],
  } satisfies NovelPlanQuestion,
  romance: {
    id: 'romance_need',
    question: '感情线怎么处理？',
    options: [
      { id: 'none', label: '几乎没有' },
      { id: 'side', label: '副线点缀' },
      { id: 'main', label: '主线之一' },
      { id: 'multi', label: '多线 / 群像情感' },
      { id: 'slow', label: '超慢热单线' },
    ],
  } satisfies NovelPlanQuestion,
  totalWords: {
    id: 'total_words',
    question: '全书目标总字数大约多少？',
    options: [
      { id: 'total_30k', label: '约 3 万字', description: '短篇 / 试读' },
      { id: 'total_100k', label: '约 10 万字', description: '中篇' },
      { id: 'total_300k', label: '约 30 万字', description: '常见网文量' },
      { id: 'total_1m', label: '约 100 万字', description: '长篇连载' },
    ],
  } satisfies NovelPlanQuestion,
  wpc: {
    id: 'words_per_chapter',
    question: '每一章目标字数？',
    options: [
      { id: 'wpc_1200', label: '约 1200 字' },
      { id: 'wpc_2000', label: '约 2000 字' },
      { id: 'wpc_3000', label: '约 3000 字' },
      { id: 'wpc_5000', label: '约 5000 字' },
    ],
  } satisfies NovelPlanQuestion,
  chapters: {
    id: 'chapter_count',
    question: '先规划写多少章？',
    options: [
      { id: 'ch_3', label: '3 章', description: '开书试写' },
      { id: 'ch_10', label: '10 章', description: '第一卷骨架' },
      { id: 'ch_30', label: '30 章', description: '中长篇前段' },
      { id: 'ch_50', label: '50 章', description: '长篇（明细大纲最多 30 章）' },
    ],
  } satisfies NovelPlanQuestion,
  taboo: {
    id: 'taboo_list',
    question: '哪些内容尽量不要出现？（可多选）',
    multiSelect: true,
    options: [
      { id: 'no_ntr', label: '绿帽 / 强拆' },
      { id: 'no_stupid', label: '反派降智' },
      { id: 'no_face', label: '无动机打脸流水线' },
      { id: 'no_dark', label: '过度虐主' },
      { id: 'ok_any', label: '没有特别禁忌' },
    ],
  } satisfies NovelPlanQuestion,
  pov: {
    id: 'narration_pov',
    question: '叙事视角偏好？',
    options: [
      { id: 'first', label: '第一人称' },
      { id: 'third_limit', label: '第三人称有限' },
      { id: 'third_multi', label: '多视角切换' },
      { id: 'god', label: '上帝视角偶尔全知' },
    ],
  } satisfies NovelPlanQuestion,
  ending: {
    id: 'ending_type',
    question: '结局更倾向？',
    options: [
      { id: 'he', label: '圆满 HE' },
      { id: 'bittersweet', label: '苦乐参半' },
      { id: 'open', label: '开放式' },
      { id: 'tragic', label: '偏悲剧' },
      { id: 'undecided', label: '先不锁，边写边定' },
    ],
  } satisfies NovelPlanQuestion,
  selling: {
    id: 'selling_point',
    question: '最想强调的卖点是？',
    options: [
      { id: 'upgrade', label: '升级爽感' },
      { id: 'plot', label: '剧情反转' },
      { id: 'char', label: '人物魅力' },
      { id: 'world', label: '世界观密度' },
      { id: 'emotion', label: '情绪共鸣' },
    ],
  } satisfies NovelPlanQuestion,
  cast: {
    id: 'cast_density',
    question: '配角戏份希望？',
    options: [
      { id: 'solo', label: '主角单核' },
      { id: 'duo', label: '双强 / CP 并重' },
      { id: 'team', label: '小队群像' },
      { id: 'mass', label: '大势力群像' },
    ],
  } satisfies NovelPlanQuestion,
  power: {
    id: 'power_strict',
    question: '力量体系要多严格？',
    options: [
      { id: 'hard', label: '硬核等级，不能跳阶乱杀' },
      { id: 'mid', label: '有等级但可破例' },
      { id: 'soft', label: '软设定，服务剧情' },
      { id: 'none', label: '几乎不涉及等级' },
    ],
  } satisfies NovelPlanQuestion,
  arc: {
    id: 'arc_shape',
    question: '前段结构更像？',
    options: [
      { id: 'fast_hook', label: '三章内大冲突' },
      { id: 'slow_build', label: '先立人设再爆点' },
      { id: 'mystery_peel', label: '层层剥洋葱' },
      { id: 'episodic', label: '单元事件串主线' },
    ],
  } satisfies NovelPlanQuestion,
  audience: {
    id: 'audience',
    question: '主要写给谁看？',
    options: [
      { id: 'male_web', label: '男频网文读者' },
      { id: 'female_web', label: '女频网文读者' },
      { id: 'general', label: '泛向 / 双向' },
      { id: 'lite', label: '轻松向全龄' },
    ],
  } satisfies NovelPlanQuestion,
  prose: {
    id: 'prose_style',
    question: '文风更接近？',
    options: [
      { id: 'plain', label: '白描直给' },
      { id: 'punchy', label: '短句有力' },
      { id: 'literary', label: '稍文学一点' },
      { id: 'dialogue', label: '对话驱动' },
    ],
  } satisfies NovelPlanQuestion,
  mystery: {
    id: 'mystery_density',
    question: '伏笔 / 反转密度？',
    options: [
      { id: 'low', label: '少伏笔，主线清晰' },
      { id: 'mid', label: '适中，每几章一抖' },
      { id: 'high', label: '高密度谜团' },
    ],
  } satisfies NovelPlanQuestion,
  autonomy: {
    id: 'agent_autonomy',
    question: '后续写作希望 Agent？',
    options: [
      { id: 'strict', label: '严格执行，少自作主张' },
      { id: 'collab', label: '协作：细节可补，大事问我' },
      { id: 'auto', label: '高度自主，尽量连写' },
    ],
  } satisfies NovelPlanQuestion,
  must: {
    id: 'must_include',
    question: '还有硬性要求吗？',
    options: [
      { id: 'none_more', label: '没有了，可以出方案' },
      { id: 'more_world', label: '世界观再细一点' },
      { id: 'more_char', label: '人物关系再细一点' },
      { id: 'more_plot', label: '主线节点再细一点' },
    ],
  } satisfies NovelPlanQuestion,
};

/**
 * 每轮固定 2～3 题（规模轮 3 题）。
 * light 用前 5 包；standard 用前 10 包；deep 用全部 20 包。
 */
const SCRIPT_BANK: ScriptRound[] = [
  {
    id: 'r01_genre_hook',
    message: '先对齐赛道和开篇钩子——这决定读者预期。',
    questions: [Q.genre, Q.hook, Q.tone],
  },
  {
    id: 'r02_protagonist',
    message: '主角定调：欲望和缺点越清晰，后面越不写飘。',
    questions: [Q.desire, Q.flaw, Q.selling],
  },
  {
    id: 'r03_world',
    message: '世界感与规则：长篇靠规则托底。',
    questions: [Q.worldFeel, Q.worldRule, Q.power],
  },
  {
    id: 'r04_conflict',
    message: '阻力、感情与禁忌。',
    questions: [Q.villain, Q.romance, Q.taboo],
  },
  {
    id: 'r05_scale',
    message: '写正文前必须定死规模：总字数、每章字数、章数——我会据此生成分章大纲。',
    isScale: true,
    questions: [Q.totalWords, Q.wpc, Q.chapters],
  },
  {
    id: 'r06_narration',
    message: '叙事与结局方向。',
    questions: [Q.pov, Q.ending, Q.arc],
  },
  {
    id: 'r07_cast_reader',
    message: '配角浓度与目标读者。',
    questions: [Q.cast, Q.audience, Q.prose],
  },
  {
    id: 'r08_info_auto',
    message: '伏笔密度与 Agent 自主度。',
    questions: [Q.mystery, Q.autonomy, Q.must],
  },
  // deep 追加轮：换角度细问，id 全新，避免与上面重复
  {
    id: 'r09_protag_detail',
    message: '再抠一点主角与卖点细节。',
    questions: [
      {
        id: 'protag_job',
        question: '主角初始身份更像？',
        options: [
          { id: 'underdog', label: '底层逆袭' },
          { id: 'heir', label: '世家/天才落难' },
          { id: 'outsider', label: '外来者/穿越' },
          { id: 'professional', label: '职业人设（医生/兵/码农等）' },
          { id: 'mystery_id', label: '身份成谜' },
        ],
      },
      {
        id: 'protag_method',
        question: '主角推进目标的主要手段？',
        options: [
          { id: 'brain', label: '算计 / 智斗' },
          { id: 'brawn', label: '硬刚 / 战力' },
          { id: 'social', label: '人际关系' },
          { id: 'system_carry', label: '金手指/系统' },
          { id: 'grind', label: '苟与积累' },
        ],
      },
      {
        id: 'emotion_core',
        question: '读者最该共情的情绪是？',
        options: [
          { id: 'anger', label: '憋屈后爆发' },
          { id: 'hope', label: '热血希望' },
          { id: 'fear', label: '压迫恐惧' },
          { id: 'warmth', label: '温暖治愈' },
          { id: 'curious', label: '求知解谜' },
        ],
      },
    ],
  },
  {
    id: 'r10_world_detail',
    message: '世界运行细节。',
    questions: [
      {
        id: 'conflict_fuel',
        question: '长期冲突的燃料是？',
        options: [
          { id: 'resource_war', label: '资源争夺' },
          { id: 'ideology', label: '理念对立' },
          { id: 'blood_feud', label: '血仇世仇' },
          { id: 'survival', label: '生存危机' },
          { id: 'throne', label: '权力更迭' },
        ],
      },
      {
        id: 'info_asymmetry',
        question: '信息差怎么用？',
        options: [
          { id: 'reader_knows', label: '读者先知，主角后知' },
          { id: 'together', label: '读者与主角同步' },
          { id: 'multi_hide', label: '多方互相不知' },
        ],
      },
      {
        id: 'tone_secondary',
        question: '次要气质（可多选）',
        multiSelect: true,
        options: [
          { id: 'wuxia_yiqi', label: '义气' },
          { id: 'scheming', label: '权谋' },
          { id: 'adventure', label: '冒险探索' },
          { id: 'daily', label: '日常松弛' },
          { id: 'war', label: '战争宏大' },
        ],
      },
    ],
  },
  {
    id: 'r11_plot_beats',
    message: '关键剧情节奏点。',
    questions: [
      {
        id: 'first_climax_when',
        question: '第一次小高潮希望出现在？',
        options: [
          { id: 'ch1', label: '第 1 章内' },
          { id: 'ch3', label: '前 3 章' },
          { id: 'ch10', label: '前 10 章' },
          { id: 'slow', label: '更靠后，先铺垫' },
        ],
      },
      {
        id: 'twist_style',
        question: '反转风格？',
        options: [
          { id: 'fair', label: '公平线索型' },
          { id: 'shock', label: '强冲击型' },
          { id: 'emotional', label: '情感反转' },
          { id: 'low_twist', label: '少反转，稳推主线' },
        ],
      },
      {
        id: 'side_quest',
        question: '支线/副本密度？',
        options: [
          { id: 'few', label: '很少，主线一把梭' },
          { id: 'balanced', label: '主线为主，偶有单元' },
          { id: 'many', label: '多单元串主线' },
        ],
      },
    ],
  },
  {
    id: 'r12_char_relations',
    message: '关系网与配角功能。',
    questions: [
      {
        id: 'mentor',
        question: '导师/引路人？',
        options: [
          { id: 'yes_strong', label: '有强力导师' },
          { id: 'yes_flawed', label: '有，但不靠谱/有黑幕' },
          { id: 'no', label: '基本靠自己' },
        ],
      },
      {
        id: 'ally',
        question: '核心盟友？',
        options: [
          { id: 'one_ride', label: '一生一骑' },
          { id: 'small_team', label: '小团队' },
          { id: 'shifting', label: '阵营常变' },
          { id: 'lonely', label: '独狼' },
        ],
      },
      {
        id: 'betrayal',
        question: '背叛戏码？',
        options: [
          { id: 'must', label: '必须有高光背叛' },
          { id: 'maybe', label: '可以有' },
          { id: 'no_betr', label: '尽量不要' },
        ],
      },
    ],
  },
  {
    id: 'r13_style_more',
    message: '文风与尺度。',
    questions: [
      {
        id: 'violence_level',
        question: '暴力/尺度？',
        options: [
          { id: 'clean', label: '清爽少血腥' },
          { id: 'normal', label: '常规网文' },
          { id: 'darker', label: '偏黑暗写实' },
        ],
      },
      {
        id: 'humor_level',
        question: '幽默含量？',
        options: [
          { id: 'h0', label: '几乎没有' },
          { id: 'h1', label: '点缀' },
          { id: 'h2', label: '经常耍贫' },
        ],
      },
      {
        id: 'desc_density',
        question: '描写密度？',
        options: [
          { id: 'lean', label: '极简推进' },
          { id: 'balanced_d', label: '均衡' },
          { id: 'lush', label: '场景细腻' },
        ],
      },
    ],
  },
  {
    id: 'r14_theme',
    message: '主题与价值。',
    questions: [
      {
        id: 'theme_core',
        question: '更想表达的主题是？',
        options: [
          { id: 'growth', label: '成长与选择' },
          { id: 'justice', label: '正义与代价' },
          { id: 'freedom', label: '自由与秩序' },
          { id: 'love_theme', label: '爱与理解' },
          { id: 'power_corrupt', label: '权力与腐化' },
        ],
      },
      {
        id: 'moral_gray',
        question: '道德灰区？',
        options: [
          { id: 'black_white', label: '黑白分明' },
          { id: 'gray', label: '大量灰色' },
          { id: 'antihero', label: '反英雄' },
        ],
      },
      {
        id: 'hope_level',
        question: '整体希望感？',
        options: [
          { id: 'bright', label: '偏光明' },
          { id: 'mixed', label: '明暗交织' },
          { id: 'bleak', label: '偏压抑' },
        ],
      },
    ],
  },
  {
    id: 'r15_serial',
    message: '连载观感与章末钩子。',
    questions: [
      {
        id: 'cliffhanger',
        question: '章末钩子强度？',
        options: [
          { id: 'soft_c', label: '温和收束' },
          { id: 'mid_c', label: '每章都要钩一下' },
          { id: 'hard_c', label: '强悬念断章' },
        ],
      },
      {
        id: 'recap',
        question: '回顾前文的方式？',
        options: [
          { id: 'minimal_r', label: '尽量不水回顾' },
          { id: 'light_r', label: '必要时轻提' },
          { id: 'ok_r', label: '可适当复盘' },
        ],
      },
      {
        id: 'title_style',
        question: '章节标题风格？',
        options: [
          { id: 'plain_t', label: '直白剧情' },
          { id: 'cool_t', label: '酷炫短句' },
          { id: 'literary_t', label: '文气一点' },
        ],
      },
    ],
  },
  {
    id: 'r16_final_pack',
    message: '收尾确认：还有没有硬门槛。',
    questions: [
      {
        id: 'must_have_scene',
        question: '必须写到的名场面类型？',
        options: [
          { id: 'duel', label: '巅峰对决' },
          { id: 'reveal', label: '身份/真相大揭露' },
          { id: 'reunion', label: '重逢/告别' },
          { id: 'heist', label: '布局/翻盘计' },
          { id: 'none_scene', label: '没有硬性名场面' },
        ],
      },
      {
        id: 'avoid_trope',
        question: '最想避开的俗套？',
        options: [
          { id: 'stupid_villain', label: '反派降智' },
          { id: 'forced_face', label: '强行打脸循环' },
          { id: 'love_brain', label: '恋爱脑毁人设' },
          { id: 'power_reset', label: '战力崩坏' },
          { id: 'ok_tropes', label: '俗套用好就行' },
        ],
      },
      {
        id: 'ready_confirm',
        question: '可以开始生成章纲了吗？',
        options: [
          { id: 'yes_ready', label: '可以，出完整方案' },
          { id: 'need_scale', label: '规模再确认一下' },
          { id: 'need_more', label: '还想再聊一轮' },
        ],
      },
    ],
  },
];

/** light：5 轮（每轮 2～3 题） */
const LIGHT_INDICES = [0, 1, 2, 4, 3];
/** standard：10 轮 */
const STANDARD_INDICES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
/** deep：16 轮脚本（约 18～20 目标轮次中内容轮用满脚本 + 必要时补规模） */
const DEEP_INDICES = SCRIPT_BANK.map((_, i) => i);

const SCALE_QUESTION_IDS = new Set(['total_words', 'words_per_chapter', 'chapter_count']);

function depthIndices(depth: NovelPlanDepth): number[] {
  if (depth === 'light') return LIGHT_INDICES;
  if (depth === 'standard') return STANDARD_INDICES;
  return DEEP_INDICES;
}

/** 从历史/答案中收集已经问过的 questionId，避免重复。 */
function collectAskedQuestionIds(
  history: NovelPlanHistoryTurn[],
  answers?: NovelPlanAnswer[],
): Set<string> {
  const asked = new Set<string>();
  if (answers) {
    for (const a of answers) {
      if (a.questionId && a.questionId !== 'plan_depth') asked.add(a.questionId);
    }
  }
  for (const h of history) {
    if (h.role !== 'user') continue;
    // formatAnswersForHistory / formatAnswers: "questionId: ..." or "问题 →"
    const idLines = h.content.matchAll(/(?:^|\n)-\s*([a-zA-Z0-9_]+)\s*:/g);
    for (const m of idLines) asked.add(m[1]);
    const plainIds = h.content.matchAll(/\b(genre_lane|core_hook|protag_desire|protag_flaw|tone_pace|world_feel|world_rule|villain_type|romance_need|total_words|words_per_chapter|chapter_count|taboo_list|narration_pov|ending_type|selling_point|cast_density|power_strict|arc_shape|audience|prose_style|mystery_density|agent_autonomy|must_include|protag_job|protag_method|emotion_core|conflict_fuel|info_asymmetry|tone_secondary|first_climax_when|twist_style|side_quest|mentor|ally|betrayal|violence_level|humor_level|desc_density|theme_core|moral_gray|hope_level|cliffhanger|recap|title_style|must_have_scene|avoid_trope|ready_confirm)\b/g);
    for (const m of plainIds) asked.add(m[1]);
  }
  return asked;
}

/** 取本轮 2～3 题：从当前包开始向后凑，跳过已问过的。 */
function pickRoundQuestions(
  depth: NovelPlanDepth,
  contentRound: number,
  asked: Set<string>,
  preferScale: boolean,
): { message: string; questions: NovelPlanQuestion[]; usedScale: boolean } {
  const indices = depthIndices(depth);
  const start = Math.min(Math.max(contentRound, 1), indices.length) - 1;

  if (preferScale) {
    const scaleQs = [Q.totalWords, Q.wpc, Q.chapters].filter((q) => !asked.has(q.id));
    if (scaleQs.length > 0) {
      return {
        message: '写正文前先把规模定死（跳过你已选过的项）。',
        questions: scaleQs.slice(0, MAX_QUESTIONS_PER_TURN),
        usedScale: true,
      };
    }
  }

  const picked: NovelPlanQuestion[] = [];
  let message = '继续对齐几个关键选择。';
  let usedScale = false;

  for (let offset = 0; offset < indices.length && picked.length < MAX_QUESTIONS_PER_TURN; offset++) {
    const pack = SCRIPT_BANK[indices[(start + offset) % indices.length]];
    if (!pack) continue;
    if (offset === 0) message = pack.message;
    if (pack.isScale) usedScale = true;
    for (const q of pack.questions) {
      if (asked.has(q.id)) continue;
      if (picked.some((p) => p.id === q.id)) continue;
      picked.push(q);
      if (picked.length >= MAX_QUESTIONS_PER_TURN) break;
    }
  }

  // 仍不足 2 题：从全库扫尾
  if (picked.length < 2) {
    for (const pack of SCRIPT_BANK) {
      for (const q of pack.questions) {
        if (asked.has(q.id) || picked.some((p) => p.id === q.id)) continue;
        picked.push(q);
        if (picked.length >= 2) break;
      }
      if (picked.length >= 2) break;
    }
  }

  return {
    message,
    questions: picked.slice(0, MAX_QUESTIONS_PER_TURN),
    usedScale,
  };
}

function depthSelectionRound(): NovelPlanTurnResponse {
  return {
    status: 'asking',
    round: 0,
    message:
      '进入计划模式前，先选追问深度。轮数越多，设定和章纲越细，后面写正文越稳——也可以随时「够了，出方案」。',
    questions: [
      {
        id: 'plan_depth',
        question: '选择计划深度',
        options: [
          {
            id: 'light',
            label: '轻量模式',
            description: '4～5 轮：赛道 / 钩子 / 主角 / 规模，快速开写',
          },
          {
            id: 'standard',
            label: '中等模式',
            description: '8～10 轮：世界、对手、禁忌、视角等更完整（推荐）',
          },
          {
            id: 'deep',
            label: '极限详细模式',
            description: '约 20 轮：立项级细抠，卖点/结构/自主度等全问到',
          },
        ],
      },
    ],
    depthRoundRange: undefined,
  };
}

function resolveDepthFromAnswers(answers?: NovelPlanAnswer[]): NovelPlanDepth | undefined {
  if (!answers) return undefined;
  for (const a of answers) {
    if (a.questionId !== 'plan_depth') continue;
    for (const id of a.selectedOptionIds) {
      if (id === 'light' || id === 'standard' || id === 'deep') return id;
    }
    const t = (a.customText ?? '').trim();
    if (/轻量|4|5/.test(t)) return 'light';
    if (/极限|详细|20/.test(t)) return 'deep';
    if (/中等|8|10/.test(t)) return 'standard';
  }
  return undefined;
}

function resolveDepthFromHistory(history: NovelPlanHistoryTurn[]): NovelPlanDepth | undefined {
  for (const h of history) {
    if (h.role !== 'user') continue;
    if (/plan_depth:\s*light|轻量模式/.test(h.content)) return 'light';
    if (/plan_depth:\s*deep|极限详细/.test(h.content)) return 'deep';
    if (/plan_depth:\s*standard|中等模式/.test(h.content)) return 'standard';
    const s = extractScaleFromText(h.content); // no-op for depth
    void s;
    if (/\bdepth[_:]?\s*light\b/i.test(h.content)) return 'light';
    if (/\bdepth[_:]?\s*deep\b/i.test(h.content)) return 'deep';
    if (/\bdepth[_:]?\s*standard\b/i.test(h.content)) return 'standard';
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatAnswers(answers: NovelPlanAnswer[] | undefined): string {
  if (!answers || answers.length === 0) return '';
  return answers
    .map((a) => {
      const picks = a.selectedOptionIds.length > 0 ? a.selectedOptionIds.join(', ') : '（未选选项）';
      const custom = a.customText?.trim() ? `；补充：${a.customText.trim()}` : '';
      return `- ${a.questionId}: ${picks}${custom}`;
    })
    .join('\n');
}

function extractJsonObject(raw: string): unknown {
  const text = stripReasoningArtifacts(raw).trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error('not json');
  }
}

function normalizeQuestion(raw: unknown, index: number): NovelPlanQuestion | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `q${index + 1}`;
  const question = typeof raw.question === 'string' ? raw.question.trim() : '';
  if (!question) return null;
  const optionsRaw = Array.isArray(raw.options) ? raw.options : [];
  const options = optionsRaw
    .map((opt, oi) => {
      if (!isRecord(opt)) return null;
      const label = typeof opt.label === 'string' ? opt.label.trim() : '';
      if (!label) return null;
      const oid = typeof opt.id === 'string' && opt.id.trim() ? opt.id.trim() : `opt_${oi + 1}`;
      const description =
        typeof opt.description === 'string' && opt.description.trim()
          ? opt.description.trim()
          : undefined;
      return { id: oid, label, description };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .slice(0, MAX_OPTIONS_PER_QUESTION);
  if (options.length < 2) return null;
  return { id, question, multiSelect: raw.multiSelect === true, options };
}

function parsePositiveInt(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.round(raw);
  if (typeof raw === 'string') {
    const m = raw.replace(/[,，\s]/g, '').match(/(\d{3,})/) ?? raw.replace(/[,，\s]/g, '').match(/(\d+)/);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return undefined;
}

/**
 * Extract scale numbers from free text.
 * Chapter count only from explicit scale phrases — not 「第N章」「前N章」 etc.
 */
export function extractScaleFromText(text: string): {
  totalWords?: number;
  wordsPerChapter?: number;
  chapterCount?: number;
} {
  const out: { totalWords?: number; wordsPerChapter?: number; chapterCount?: number } = {};
  const totalCn = text.match(/(?:总|全书|一共|约)?\s*(\d+(?:\.\d+)?)\s*万\s*字/);
  if (totalCn) out.totalWords = Math.round(Number(totalCn[1]) * 10000);
  const totalPlain = text.match(/(?:总字数|全书|一共)[^\d]{0,6}(\d{4,7})\s*字?/);
  if (totalPlain && !out.totalWords) out.totalWords = Number(totalPlain[1]);
  const perCn = text.match(/(?:每章|单章)[^\d]{0,6}(\d{3,5})\s*字?/);
  if (perCn) out.wordsPerChapter = Number(perCn[1]);

  // Explicit chapter-count phrases only (avoid 第N章 / 前N章 / bare N章 from goals).
  const chapterPatterns: RegExp[] = [
    // 总章数 30 / 计划章节数：30 / 章节数 30 / 章数约 10
    /(?:总章数|计划章节数|章节数|章数)[^\d第前]{0,8}(\d{1,3})/,
    // 计划写30章 / 先规划30章 / 先规划写30章 / 一共30章 / 共30章 / 约30章
    /(?:计划写|先规划写?|一共|共写?|约写?|约)\s*(\d{1,3})\s*章/,
    // 写30章 — not 写30章内 (chapter-goal wording)
    /(?<!前)写\s*(\d{1,3})\s*章(?!内)/,
    // 30章左右 / 30章大纲 / 30章计划
    /(\d{1,3})\s*章\s*(?:左右|大纲|计划)/,
  ];
  for (const re of chapterPatterns) {
    const m = text.match(re);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) {
        out.chapterCount = n;
        break;
      }
    }
  }
  return out;
}

function mergeScale(
  ...parts: Array<{ totalWords?: number; wordsPerChapter?: number; chapterCount?: number }>
): { totalWords?: number; wordsPerChapter?: number; chapterCount?: number } {
  const out: { totalWords?: number; wordsPerChapter?: number; chapterCount?: number } = {};
  for (const p of parts) {
    if (p.totalWords) out.totalWords = p.totalWords;
    if (p.wordsPerChapter) out.wordsPerChapter = p.wordsPerChapter;
    if (p.chapterCount) out.chapterCount = p.chapterCount;
  }
  if (out.totalWords && out.wordsPerChapter && !out.chapterCount) {
    out.chapterCount = Math.max(1, Math.round(out.totalWords / out.wordsPerChapter));
  }
  if (out.totalWords && out.chapterCount && !out.wordsPerChapter) {
    out.wordsPerChapter = Math.max(300, Math.round(out.totalWords / out.chapterCount));
  }
  if (out.wordsPerChapter && out.chapterCount && !out.totalWords) {
    out.totalWords = out.wordsPerChapter * out.chapterCount;
  }
  if (out.chapterCount) {
    out.chapterCount = Math.min(MAX_OUTLINE_CHAPTERS, Math.max(1, out.chapterCount));
  }
  return out;
}

export function collectScaleFromSession(
  history: NovelPlanHistoryTurn[],
  answers?: NovelPlanAnswer[],
  summary?: NovelPlanSummary,
): { totalWords?: number; wordsPerChapter?: number; chapterCount?: number } {
  const chunks: Array<{ totalWords?: number; wordsPerChapter?: number; chapterCount?: number }> = [];
  if (summary) {
    chunks.push({
      totalWords: summary.totalWords,
      wordsPerChapter: summary.wordsPerChapter,
      chapterCount: summary.chapterCount,
    });
  }
  for (const h of history) chunks.push(extractScaleFromText(h.content));
  if (answers) {
    for (const a of answers) {
      const blob = `${a.questionId} ${a.selectedOptionIds.join(' ')} ${a.customText ?? ''}`;
      chunks.push(extractScaleFromText(blob));
      for (const id of a.selectedOptionIds) {
        if (id === 'total_30k') chunks.push({ totalWords: 30000 });
        if (id === 'total_100k') chunks.push({ totalWords: 100000 });
        if (id === 'total_300k') chunks.push({ totalWords: 300000 });
        if (id === 'total_1m') chunks.push({ totalWords: 1000000 });
        if (id === 'wpc_1200') chunks.push({ wordsPerChapter: 1200 });
        if (id === 'wpc_2000') chunks.push({ wordsPerChapter: 2000 });
        if (id === 'wpc_3000') chunks.push({ wordsPerChapter: 3000 });
        if (id === 'wpc_5000') chunks.push({ wordsPerChapter: 5000 });
        if (id === 'ch_3') chunks.push({ chapterCount: 3 });
        if (id === 'ch_10') chunks.push({ chapterCount: 10 });
        if (id === 'ch_30') chunks.push({ chapterCount: 30 });
        // Outline generation is capped; map intentionally rather than silent clamp later.
        if (id === 'ch_50') chunks.push({ chapterCount: MAX_OUTLINE_CHAPTERS });
      }
    }
  }
  return mergeScale(...chunks);
}

function hasCompleteScale(scale: {
  totalWords?: number;
  wordsPerChapter?: number;
  chapterCount?: number;
}): scale is { totalWords: number; wordsPerChapter: number; chapterCount: number } {
  return Boolean(scale.totalWords && scale.wordsPerChapter && scale.chapterCount);
}

function normalizeChapterOutlines(
  raw: unknown,
  chapterCount: number,
  wordsPerChapter: number,
): NovelPlanChapterOutline[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: NovelPlanChapterOutline[] = [];
  for (let i = 0; i < list.length && out.length < chapterCount; i++) {
    const item = list[i];
    if (!isRecord(item)) continue;
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const goal = typeof item.goal === 'string' ? item.goal.trim() : '';
    if (!title && !goal) continue;
    const number =
      typeof item.number === 'number' && item.number > 0 ? Math.round(item.number) : out.length + 1;
    const estimatedWords =
      typeof item.estimatedWords === 'number' && item.estimatedWords > 0
        ? Math.round(item.estimatedWords)
        : wordsPerChapter;
    out.push({
      number,
      title: title || `第${number}章`,
      goal: goal || '推进主线冲突并留下章末钩子。',
      estimatedWords,
    });
  }
  while (out.length < chapterCount) {
    const n = out.length + 1;
    out.push({
      number: n,
      title: `第${n}章`,
      goal: n === 1 ? '建立主角、世界规则与初始冲突，章末抛钩子。' : '推进主线，制造新阻碍，章末留下悬念。',
      estimatedWords: wordsPerChapter,
    });
  }
  return out.slice(0, chapterCount).map((c, i) => ({ ...c, number: i + 1 }));
}

function normalizeSummary(raw: unknown): NovelPlanSummary | undefined {
  if (!isRecord(raw)) return undefined;
  const pick = (key: string): string | undefined => {
    const v = raw[key];
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
  const constraints = Array.isArray(raw.constraints)
    ? raw.constraints.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((s) => s.trim())
    : undefined;
  const scale = mergeScale({
    totalWords: parsePositiveInt(raw.totalWords),
    wordsPerChapter: parsePositiveInt(raw.wordsPerChapter),
    chapterCount: parsePositiveInt(raw.chapterCount),
  });
  const chapterOutlines =
    scale.chapterCount && scale.wordsPerChapter
      ? normalizeChapterOutlines(raw.chapterOutlines, scale.chapterCount, scale.wordsPerChapter)
      : undefined;
  const summary: NovelPlanSummary = {
    title: pick('title'),
    genre: pick('genre'),
    protagonist: pick('protagonist'),
    hook: pick('hook'),
    tone: pick('tone'),
    constraints: constraints && constraints.length > 0 ? constraints : undefined,
    totalWords: scale.totalWords,
    wordsPerChapter: scale.wordsPerChapter,
    chapterCount: scale.chapterCount,
    chapterOutlines,
  };
  if (
    !summary.title &&
    !summary.genre &&
    !summary.protagonist &&
    !summary.hook &&
    !summary.tone &&
    !summary.constraints &&
    !summary.totalWords &&
    !summary.chapterOutlines
  ) {
    return undefined;
  }
  return summary;
}

function buildChapterOutlineFallback(
  seed: string,
  chapterCount: number,
  wordsPerChapter: number,
): NovelPlanChapterOutline[] {
  const templates = [
    '建立主角身份、世界规则与初始欲望，章末抛出不可回避的冲突。',
    '主角被迫行动，遭遇第一个阻碍，展示性格与能力边界。',
    '引入关键配角/对手，冲突升级，获得关键信息或代价。',
    '小胜利后立刻付出代价，揭示更大阴谋或规则漏洞。',
    '关系或立场出现裂痕，主角做出艰难选择。',
    '中段反转：此前认知被颠覆，目标需要重估。',
    '资源/盟友重组，为下一阶段对抗做准备。',
    '高潮前压迫感拉满，失败风险清晰可见。',
    '阶段性决战或对决，兑现部分爽点，埋下新伏笔。',
    '收束本卷冲突，留下长线钩子与下一卷入口。',
  ];
  return Array.from({ length: chapterCount }, (_, i) => {
    const n = i + 1;
    return {
      number: n,
      title: `第${n}章`,
      goal: `${templates[i % templates.length]}（围绕：${seed.slice(0, 24)}）`,
      estimatedWords: wordsPerChapter,
    };
  });
}

function formatChapterOutlinesMd(outlines: NovelPlanChapterOutline[]): string {
  return outlines
    .map(
      (c) =>
        `### 第${c.number}章 ${c.title}\n- 目标字数：约 ${c.estimatedWords ?? '?'} 字\n- 本章大纲：${c.goal}`,
    )
    .join('\n\n');
}

function buildBrief(params: {
  seed: string;
  history: NovelPlanHistoryTurn[];
  answers?: NovelPlanAnswer[];
  scale: { totalWords: number; wordsPerChapter: number; chapterCount: number };
  outlines: NovelPlanChapterOutline[];
  summary?: NovelPlanSummary;
  depth: NovelPlanDepth;
}): string {
  const { seed, history, answers, scale, outlines, summary, depth } = params;
  const historyBlock = history
    .slice(-12)
    .map((h) => `${h.role === 'user' ? '用户' : '策划'}：${h.content}`)
    .join('\n');
  return [
    `【创作 brief】`,
    `计划深度：${DEPTH_LIMITS[depth].label}`,
    `原始灵感：${seed}`,
    summary?.title ? `书名向：${summary.title}` : '',
    summary?.genre ? `赛道：${summary.genre}` : '',
    summary?.protagonist ? `主角：${summary.protagonist}` : '',
    summary?.hook ? `核心钩子：${summary.hook}` : '',
    summary?.tone ? `基调：${summary.tone}` : '',
    `【规模（必须遵守）】`,
    `- 全书目标总字数：约 ${scale.totalWords.toLocaleString()} 字`,
    `- 每章目标字数：约 ${scale.wordsPerChapter.toLocaleString()} 字`,
    `- 计划章节数：${scale.chapterCount} 章`,
    historyBlock ? `【对话要点】\n${historyBlock}` : '',
    formatAnswers(answers) ? `【本轮选择】\n${formatAnswers(answers)}` : '',
    `【分章大纲（写作时按章推进）】`,
    formatChapterOutlinesMd(outlines),
    `【写作要求】按分章大纲与每章字数写作；开篇冲突清晰，避免脸谱反派与无动机打脸。`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function withDepthMeta(
  res: NovelPlanTurnResponse,
  depth?: NovelPlanDepth,
): NovelPlanTurnResponse {
  if (!depth) return res;
  const lim = DEPTH_LIMITS[depth];
  return { ...res, depth, depthRoundRange: [lim.min, lim.max] };
}

function scriptedAsking(
  seed: string,
  depth: NovelPlanDepth,
  contentRound: number,
  history: NovelPlanHistoryTurn[] = [],
  answers?: NovelPlanAnswer[],
  preferScale = false,
): NovelPlanTurnResponse {
  void seed;
  const lim = DEPTH_LIMITS[depth];
  const asked = collectAskedQuestionIds(history, answers);
  // 本轮 answers 里刚答过的也不要立刻再问
  if (answers) {
    for (const a of answers) {
      if (a.questionId !== 'plan_depth') asked.add(a.questionId);
    }
  }
  const needScale = preferScale || !hasCompleteScale(collectScaleFromSession(history, answers));
  // 仅当规模未齐且（明确要求 或 已过半）才优先规模
  const forceScale =
    needScale &&
    (preferScale ||
      (contentRound >= Math.max(2, Math.floor(DEPTH_LIMITS[depth].min / 2)) &&
        ![...asked].some((id) => SCALE_QUESTION_IDS.has(id))));

  const { message, questions } = pickRoundQuestions(depth, contentRound, asked, forceScale);
  const progress = `（${DEPTH_LIMITS[depth].label} · 内容第 ${contentRound}/${lim.max} 轮 · 本轮 ${questions.length} 题）`;

  if (questions.length === 0) {
    // 题库问完了 → 交给 ready 路径
    return withDepthMeta(
      {
        status: 'asking',
        round: contentRound,
        message: `${progress} 关键问题已齐，若规模也齐可点「够了，出方案」。`,
        questions: [Q.must],
      },
      depth,
    );
  }

  return withDepthMeta(
    {
      status: 'asking',
      round: contentRound,
      message: `${message} ${progress}`,
      questions,
    },
    depth,
  );
}

function fallbackReady(
  seed: string,
  history: NovelPlanHistoryTurn[],
  answers: NovelPlanAnswer[] | undefined,
  depth: NovelPlanDepth,
  scaleIn?: { totalWords?: number; wordsPerChapter?: number; chapterCount?: number },
): NovelPlanTurnResponse {
  const scale = mergeScale(
    collectScaleFromSession(history, answers),
    scaleIn ?? {},
    { wordsPerChapter: DEFAULT_WORDS_PER_CHAPTER, chapterCount: DEFAULT_CHAPTER_COUNT },
  );
  const wordsPerChapter = scale.wordsPerChapter ?? DEFAULT_WORDS_PER_CHAPTER;
  const chapterCount = Math.min(MAX_OUTLINE_CHAPTERS, scale.chapterCount ?? DEFAULT_CHAPTER_COUNT);
  const totalWords = scale.totalWords ?? wordsPerChapter * chapterCount;
  const complete = { totalWords, wordsPerChapter, chapterCount };
  const outlines = buildChapterOutlineFallback(seed, chapterCount, wordsPerChapter);
  const planSummary: NovelPlanSummary = {
    title: seed.slice(0, 24) || '未命名小说',
    hook: seed,
    constraints: ['避免无动机打脸', '人物欲望清晰', '按分章大纲推进'],
    totalWords,
    wordsPerChapter,
    chapterCount,
    chapterOutlines: outlines,
  };
  const lim = DEPTH_LIMITS[depth];
  return withDepthMeta(
    {
      status: 'ready',
      round: lim.max,
      message: `【${lim.label}】规模已定：约 ${totalWords.toLocaleString()} 字 / ${chapterCount} 章 × 每章约 ${wordsPerChapter} 字。分章大纲已生成，确认后可按章写作。`,
      brief: buildBrief({
        seed,
        history,
        answers,
        scale: complete,
        outlines,
        summary: planSummary,
        depth,
      }),
      planSummary,
    },
    depth,
  );
}

export class NovelPlanService {
  constructor(
    private readonly modelConfigService: ModelConfigService,
    private readonly modelProxy: ModelProxy,
  ) {}

  async turn(request: NovelPlanTurnRequest, signal: AbortSignal): Promise<NovelPlanTurnResponse> {
    const seed = request.seedPrompt?.trim() ?? '';
    if (!seed) throw ServiceError.validation('seedPrompt 不能为空。');

    const history = Array.isArray(request.history) ? request.history : [];
    const targetTask: NovelPlanTargetTask = request.targetTask ?? 'full_novel';
    const userForceReady = request.forceReady === true;

    // —— 解析深度：请求体 > 本轮答案 > 历史 ——
    let depth: NovelPlanDepth | undefined =
      request.depth ?? resolveDepthFromAnswers(request.answers) ?? resolveDepthFromHistory(history);

    // 尚未选深度：只返回深度选择题
    if (!depth) {
      // 若本轮答案里有深度，会在上面解析到；否则首屏选深度
      if (!resolveDepthFromAnswers(request.answers)) {
        return depthSelectionRound();
      }
      depth = resolveDepthFromAnswers(request.answers)!;
    }

    const lim = DEPTH_LIMITS[depth];
    // 内容轮：assistant 条数里若含「深度选择」那一轮，要减掉
    const assistantRounds = history.filter((h) => h.role === 'assistant').length;
    const depthAlreadyChosenInHistory = Boolean(resolveDepthFromHistory(history) || request.depth);
    // 刚在本轮 answers 里选完深度、历史里还没有内容轮
    const justChoseDepth = Boolean(resolveDepthFromAnswers(request.answers)) && !request.depth && !resolveDepthFromHistory(history);

    // contentRound = 即将进行的内容追问轮次（1-based）
    let contentRound: number;
    if (justChoseDepth) {
      contentRound = 1;
    } else if (depthAlreadyChosenInHistory) {
      // 历史 assistant 条数 ≈ 深度选择(0或1) + 已完成内容轮
      const depthMsgCount = history.some(
        (h) => h.role === 'assistant' && /计划深度|轻量模式|中等模式|极限详细/.test(h.content),
      )
        ? 1
        : request.depth
          ? 0
          : 0;
      // 更稳：用 assistant 数；若第一轮 assistant 是深度选择，内容已完成 = assistantRounds - 1
      const completedContent = Math.max(0, assistantRounds - (depthMsgCount || (request.depth ? 0 : 1)));
      contentRound = completedContent + 1;
    } else {
      contentRound = Math.max(1, assistantRounds + 1);
    }

    contentRound = Math.min(lim.max, Math.max(1, contentRound));
    const atCap = contentRound >= lim.max;
    const pastMin = contentRound > lim.min || (contentRound >= lim.min && userForceReady);

    const scaleSoFar = collectScaleFromSession(history, request.answers);
    const scaleComplete = hasCompleteScale(scaleSoFar);

    // 本轮刚选完深度：直接抛第 1 个内容题（不 ready）
    if (justChoseDepth && !userForceReady) {
      return scriptedAsking(seed, depth, 1, history, request.answers, false);
    }

    // 未到最小轮次且未强制：走脚本题（自动凑 2～3 题、去重）
    if (!userForceReady && contentRound < lim.min) {
      return scriptedAsking(seed, depth, contentRound, history, request.answers, false);
    }

    // 达到最小轮次：规模未齐仍要问规模（只补未问过的规模题）
    if (!scaleComplete && !userForceReady && !atCap) {
      return scriptedAsking(seed, depth, contentRound, history, request.answers, true);
    }

    // 未封顶且未强制：可继续多问一轮脚本，或收束
    if (!userForceReady && !atCap && contentRound < lim.max) {
      // 标准/极限在 min～max 之间：有模型则让模型决定是否再问；无模型则继续脚本
      const config = await this.modelConfigService.getInternalConfig();
      if (config === undefined) {
        if (pastMin && scaleComplete && contentRound >= lim.min) {
          return fallbackReady(seed, history, request.answers, depth, scaleSoFar);
        }
        return scriptedAsking(seed, depth, contentRound, history, request.answers, false);
      }
      try {
        const raw = await this.generateJson(
          config,
          seed,
          targetTask,
          history,
          request.answers,
          false,
          signal,
          depth,
          lim,
          contentRound,
          !scaleComplete,
        );
        const parsed = this.normalizeModelOutput(raw, seed, history, request.answers, contentRound, false, scaleSoFar);
        if (parsed.status === 'ready') {
          const s = collectScaleFromSession(history, request.answers, parsed.planSummary);
          if (!hasCompleteScale(s)) {
            return scriptedAsking(seed, depth, contentRound, history, request.answers, true);
          }
          if (contentRound < lim.min) {
            return scriptedAsking(seed, depth, contentRound, history, request.answers, false);
          }
          return await this.ensureReadyWithOutlines(
            config,
            seed,
            history,
            request.answers,
            contentRound,
            parsed,
            s,
            depth,
            signal,
          );
        }
        // 模型返回的题目去重 + 不足 2 题则用脚本补齐
        const asked = collectAskedQuestionIds(history, request.answers);
        const filtered = (parsed.questions ?? []).filter((q) => !asked.has(q.id));
        if (filtered.length < 2) {
          return scriptedAsking(seed, depth, contentRound, history, request.answers, !scaleComplete);
        }
        return withDepthMeta(
          {
            ...parsed,
            round: contentRound,
            questions: filtered.slice(0, MAX_QUESTIONS_PER_TURN),
          },
          depth,
        );
      } catch {
        return scriptedAsking(seed, depth, contentRound, history, request.answers, !scaleComplete);
      }
    }

    // 封顶或 forceReady → ready + 大纲
    const config = await this.modelConfigService.getInternalConfig();
    if (config === undefined) {
      return fallbackReady(seed, history, request.answers, depth, scaleSoFar);
    }
    try {
      const raw = await this.generateJson(
        config,
        seed,
        targetTask,
        history,
        request.answers,
        true,
        signal,
        depth,
        lim,
        contentRound,
        false,
      );
      const parsed = this.normalizeModelOutput(raw, seed, history, request.answers, contentRound, true, scaleSoFar);
      const s = collectScaleFromSession(history, request.answers, parsed.planSummary);
      const complete = hasCompleteScale(s)
        ? s
        : {
            totalWords:
              (s.wordsPerChapter ?? DEFAULT_WORDS_PER_CHAPTER) *
              (s.chapterCount ?? DEFAULT_CHAPTER_COUNT),
            wordsPerChapter: s.wordsPerChapter ?? DEFAULT_WORDS_PER_CHAPTER,
            chapterCount: Math.min(MAX_OUTLINE_CHAPTERS, s.chapterCount ?? DEFAULT_CHAPTER_COUNT),
          };
      return await this.ensureReadyWithOutlines(
        config,
        seed,
        history,
        request.answers,
        contentRound,
        parsed,
        complete as { totalWords: number; wordsPerChapter: number; chapterCount: number },
        depth,
        signal,
      );
    } catch {
      return fallbackReady(seed, history, request.answers, depth, scaleSoFar);
    }
  }

  private normalizeModelOutput(
    raw: string,
    seed: string,
    history: NovelPlanHistoryTurn[],
    answers: NovelPlanAnswer[] | undefined,
    round: number,
    forceReady: boolean,
    scaleHint: { totalWords?: number; wordsPerChapter?: number; chapterCount?: number },
  ): NovelPlanTurnResponse {
    let data: unknown;
    try {
      data = extractJsonObject(raw);
    } catch {
      return forceReady
        ? fallbackReady(seed, history, answers, 'standard', scaleHint)
        : { status: 'asking', round, message: '再对齐几个关键选择。', questions: SCRIPT_BANK[0].questions };
    }
    if (!isRecord(data)) {
      return forceReady
        ? fallbackReady(seed, history, answers, 'standard', scaleHint)
        : { status: 'asking', round, message: '再对齐几个关键选择。', questions: SCRIPT_BANK[0].questions };
    }
    const message =
      typeof data.message === 'string' && data.message.trim()
        ? data.message.trim()
        : forceReady
          ? '方案已收束。'
          : '继续追问。';
    const status: 'asking' | 'ready' = data.status === 'ready' || forceReady ? 'ready' : 'asking';
    if (status === 'ready') {
      return {
        status: 'ready',
        round,
        message,
        brief: typeof data.brief === 'string' ? data.brief.trim() : undefined,
        planSummary: normalizeSummary(data.planSummary),
      };
    }
    const questions = (Array.isArray(data.questions) ? data.questions : [])
      .map((q, i) => normalizeQuestion(q, i))
      .filter((q): q is NovelPlanQuestion => q !== null)
      .slice(0, MAX_QUESTIONS_PER_TURN);
    if (questions.length === 0) {
      return scriptedAsking(seed, 'standard', Math.max(1, round), history, answers, false);
    }
    // 至少保证 2 题（深度选择轮除外）
    if (questions.length === 1 && questions[0].id !== 'plan_depth') {
      const asked = collectAskedQuestionIds(history, answers);
      asked.add(questions[0].id);
      const fill = pickRoundQuestions('standard', Math.max(1, round), asked, false);
      const merged = [...questions, ...fill.questions].slice(0, MAX_QUESTIONS_PER_TURN);
      return { status: 'asking', round, message, questions: merged };
    }
    return { status: 'asking', round, message, questions };
  }

  private async ensureReadyWithOutlines(
    config: ModelConfig,
    seed: string,
    history: NovelPlanHistoryTurn[],
    answers: NovelPlanAnswer[] | undefined,
    round: number,
    parsed: NovelPlanTurnResponse,
    scale: { totalWords: number; wordsPerChapter: number; chapterCount: number },
    depth: NovelPlanDepth,
    signal: AbortSignal,
  ): Promise<NovelPlanTurnResponse> {
    const chapterCount = Math.min(MAX_OUTLINE_CHAPTERS, Math.max(1, scale.chapterCount));
    const wordsPerChapter = Math.max(300, scale.wordsPerChapter);
    const totalWords = scale.totalWords > 0 ? scale.totalWords : wordsPerChapter * chapterCount;
    const complete = { totalWords, wordsPerChapter, chapterCount };

    let outlines = parsed.planSummary?.chapterOutlines;
    if (!outlines || outlines.length < chapterCount) {
      outlines = await this.generateChapterOutlines(config, seed, history, complete, signal);
    } else {
      outlines = normalizeChapterOutlines(outlines, chapterCount, wordsPerChapter);
    }

    const planSummary: NovelPlanSummary = {
      ...(parsed.planSummary ?? {}),
      totalWords,
      wordsPerChapter,
      chapterCount,
      chapterOutlines: outlines,
      title: parsed.planSummary?.title ?? seed.slice(0, 24),
      hook: parsed.planSummary?.hook ?? seed,
    };

    const brief =
      parsed.brief && parsed.brief.includes('分章大纲')
        ? parsed.brief
        : buildBrief({ seed, history, answers, scale: complete, outlines, summary: planSummary, depth });

    return withDepthMeta(
      {
        status: 'ready',
        round,
        message:
          parsed.message ||
          `【${DEPTH_LIMITS[depth].label}】已生成 ${chapterCount} 章大纲（每章约 ${wordsPerChapter} 字）。`,
        brief,
        planSummary,
      },
      depth,
    );
  }

  private async generateChapterOutlines(
    config: ModelConfig,
    seed: string,
    history: NovelPlanHistoryTurn[],
    scale: { totalWords: number; wordsPerChapter: number; chapterCount: number },
    signal: AbortSignal,
  ): Promise<NovelPlanChapterOutline[]> {
    const historyText = history
      .slice(-14)
      .map((h) => `${h.role === 'user' ? '用户' : '策划'}：${h.content}`)
      .join('\n');
    try {
      const raw = await this.collectText(
        config,
        [
          {
            role: 'system',
            content: `你是分章大纲 Agent。只输出 JSON：{ "chapterOutlines": [ { "number":1,"title":"...","goal":"...","estimatedWords":${scale.wordsPerChapter} } ] }，必须 ${scale.chapterCount} 章。goal 写清冲突、行动、章末钩子。`,
          },
          {
            role: 'user',
            content: `灵感：${seed}\n规模：${scale.chapterCount}章×${scale.wordsPerChapter}字\n对话：\n${historyText}`,
          },
        ],
        signal,
        true,
      );
      const data = extractJsonObject(raw);
      if (isRecord(data)) {
        return normalizeChapterOutlines(data.chapterOutlines, scale.chapterCount, scale.wordsPerChapter);
      }
    } catch {
      /* fallback */
    }
    return buildChapterOutlineFallback(seed, scale.chapterCount, scale.wordsPerChapter);
  }

  private async generateJson(
    config: ModelConfig,
    seed: string,
    targetTask: NovelPlanTargetTask,
    history: NovelPlanHistoryTurn[],
    answers: NovelPlanAnswer[] | undefined,
    forceReady: boolean,
    signal: AbortSignal,
    _depth: NovelPlanDepth,
    lim: { min: number; max: number; label: string },
    contentRound: number,
    requireScale: boolean,
  ): Promise<string> {
    const historyText =
      history.length === 0
        ? '（尚无历史）'
        : history.map((h) => `${h.role === 'user' ? '用户' : '策划'}：${h.content}`).join('\n');
    const scale = collectScaleFromSession(history, answers);
    const system = `你是小说开局策划 Agent。只输出 JSON。status=asking|ready。
深度=${lim.label}，目标 ${lim.min}～${lim.max} 轮内容追问，当前约第 ${contentRound} 轮。
未收齐总字数/每章字数/章节数时禁止 ready。
ready 时必须含 planSummary.totalWords/wordsPerChapter/chapterCount 与 chapterOutlines。
asking 时 1～${MAX_QUESTIONS_PER_TURN} 题，每题 2～${MAX_OPTIONS_PER_QUESTION} 选项。`;

    return this.collectText(
      config,
      [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            `下游：${TARGET_LABELS[targetTask]}`,
            `灵感：${seed}`,
            `规模已知：总=${scale.totalWords ?? '?'} 每章=${scale.wordsPerChapter ?? '?'} 章数=${scale.chapterCount ?? '?'}`,
            forceReady
              ? '立即 ready 并给完整 brief + chapterOutlines。'
              : requireScale
                ? '必须问规模三题，禁止 ready。'
                : contentRound < lim.min
                  ? `未满 ${lim.min} 轮，继续 asking，不要 ready。`
                  : '可 ready 或再问一轮高价值问题。',
            '历史：',
            historyText,
            '本轮答案：',
            formatAnswers(answers) || '（无）',
          ].join('\n'),
        },
      ],
      signal,
      true,
    );
  }

  private async collectText(
    config: ModelConfig,
    messages: ChatMessage[],
    signal: AbortSignal,
    jsonMode: boolean,
  ): Promise<string> {
    const chunks: string[] = [];
    for await (const delta of this.modelProxy.streamCompletion(config, messages, signal, { jsonMode })) {
      if (delta.kind === 'content') chunks.push(delta.text);
    }
    return chunks.join('');
  }
}
