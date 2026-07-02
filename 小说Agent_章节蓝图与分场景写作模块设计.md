# 小说 Agent：章节蓝图与分场景写作模块设计

> 目标：让小说 Agent 不再只是“直接写一章”，而是能够根据用户给出的章节大纲、目标字数、剧情要求和节奏要求，自动拆分章节结构、分配场景字数、按场景写作、检查字数与节奏，并支持局部扩写和重写。

---

## 1. 模块定位

这个模块可以叫：

- **Chapter Planner**
- **章节蓝图器**
- **章节施工器**
- **剧情节拍控制器**

它是小说 Agent 的核心发动机。

普通写作流程是：

```txt
用户给一句大纲
↓
AI 直接写正文
↓
剧情容易跑偏，字数不准，节奏失控
```

升级后的流程是：

```txt
用户给章节要求
↓
Agent 生成章节蓝图
↓
Agent 按场景拆分字数和剧情节拍
↓
Agent 逐个场景写正文
↓
Agent 合并章节
↓
Agent 检查字数、节奏、人设、伏笔、冲突
↓
Agent 局部扩写 / 重写
↓
保存最终章节
```

核心原则：

> **先规划，再写作；先分场景，再合并章节；先检查，再定稿。**

---

## 2. 为什么要加这个功能

小说 Agent 最容易出的问题不是不会写，而是：

1. 字数不准  
2. 节奏乱飞  
3. 剧情跳太快  
4. 人物关系推进过猛  
5. 前半铺垫太长，后半草草收尾  
6. 用户要求的剧情点漏掉  
7. 一口气写长文导致质量下降  
8. 想重写时只能整章重写，很难局部修改  

所以需要一个“章节蓝图”作为施工图。

它的作用类似：

```txt
代码开发里的技术设计文档
游戏制作里的关卡设计表
小说创作里的分场景大纲
```

---

## 3. 用户输入格式

建议让用户使用固定模板输入章节需求。

### 3.1 标准章节需求模板

```txt
章节编号：3
章节标题：意外的同好
目标字数：3000

本章目标：
男主发现校花也有隐藏的游戏爱好，并为后续社团线埋下钩子。

剧情必须包含：
- 男主发现校花的异常
- 两人产生误会
- 校花反过来试探男主
- 男主不敢直接承认自己的秘密
- 结尾校花邀请男主去旧社团楼

节奏要求：
- 开场轻松日常
- 中段尴尬搞笑
- 后段暧昧试探
- 结尾留下悬念

情绪变化：
轻松 → 好奇 → 尴尬 → 紧张 → 暧昧 → 悬念

禁止事项：
- 不要让两人直接坦白
- 不要推进感情太快
- 不要新增重大世界观
- 不要让男主突然变得很会撩
- 不要让校花人设崩坏

参考风格：
轻小说、校园恋爱喜剧、吐槽感、节奏轻快。
```

### 3.2 简化输入也要支持

用户也可以直接输入一句话：

```txt
第3章，3000字，男主发现校花也玩黄油，节奏搞笑转暧昧，结尾社团邀请。
```

Agent 需要自动补全为结构化章节需求。

---

## 4. 新增核心命令

建议给小说 Agent 增加以下命令。

| 命令 | 作用 | 优先级 |
|---|---|---:|
| `/plan_chapter` | 根据用户要求生成章节蓝图 | 最高 |
| `/write_scene` | 根据蓝图写单个场景 | 最高 |
| `/write_chapter` | 根据蓝图自动写完整章节 | 最高 |
| `/merge_chapter` | 合并多个场景为完整章节 | 高 |
| `/word_count_check` | 检查目标字数和实际字数差距 | 高 |
| `/pacing_check` | 检查节奏是否符合要求 | 高 |
| `/expand_scene` | 指定场景扩写指定字数 | 高 |
| `/rewrite_scene` | 指定场景重写 | 高 |
| `/chapter_report` | 输出章节质量报告 | 中 |
| `/finalize_chapter` | 定稿并保存最终版本 | 中 |

---

## 5. 推荐文件结构

在现有小说 Agent 项目里新增这些目录和文件。

```txt
novel-agent/
├─ story/
│  ├─ chapters/
│  │  ├─ chapter_001.md
│  │  └─ chapter_002.md
│  ├─ scenes/
│  │  └─ chapter_003/
│  │     ├─ scene_001.md
│  │     ├─ scene_002.md
│  │     └─ scene_003.md
│  ├─ blueprints/
│  │  └─ chapter_003_blueprint.json
│  ├─ outline.md
│  └─ synopsis.md
│
├─ bible/
│  ├─ world.md
│  ├─ characters.md
│  ├─ timeline.md
│  ├─ factions.md
│  └─ rules.md
│
├─ prompts/
│  ├─ chapter_planner.md
│  ├─ scene_writer.md
│  ├─ chapter_merger.md
│  ├─ pacing_checker.md
│  ├─ word_count_checker.md
│  ├─ scene_expander.md
│  └─ scene_rewriter.md
│
├─ reports/
│  ├─ chapter_003_word_count_report.md
│  ├─ chapter_003_pacing_report.md
│  └─ chapter_003_quality_report.md
│
├─ versions/
│  └─ chapter_003/
│     ├─ chapter_003_v1.md
│     ├─ chapter_003_v2.md
│     └─ chapter_003_final.md
│
├─ tools/
│  ├─ blueprint_tools.py
│  ├─ scene_tools.py
│  ├─ word_count_tools.py
│  ├─ pacing_tools.py
│  └─ file_tools.py
│
└─ main.py
```

---

## 6. 章节蓝图 JSON 结构

章节蓝图是整个模块的核心数据。

建议保存为：

```txt
story/blueprints/chapter_003_blueprint.json
```

示例：

```json
{
  "chapter_id": 3,
  "title": "意外的同好",
  "target_words": 3000,
  "main_goal": "男主发现校花也有隐藏的游戏爱好，并为后续社团线埋下钩子。",
  "tone": ["轻松", "搞笑", "暧昧", "悬疑"],
  "pacing": "前半轻松搞笑，中段误会升级，后段两人互相试探，结尾留下社团邀请钩子。",
  "required_plot_points": [
    "男主发现校花的异常",
    "两人产生误会",
    "校花反过来试探男主",
    "男主不敢直接承认自己的秘密",
    "结尾校花邀请男主去旧社团楼"
  ],
  "forbidden_points": [
    "不要让两人直接坦白",
    "不要推进感情太快",
    "不要新增重大世界观",
    "不要让男主突然变得很会撩"
  ],
  "emotional_curve": [
    "轻松",
    "好奇",
    "尴尬",
    "紧张",
    "暧昧",
    "悬念"
  ],
  "scenes": [
    {
      "scene_id": 1,
      "name": "放学后的日常",
      "target_words": 500,
      "location": "教室",
      "characters": ["男主", "同学"],
      "purpose": "展示男主表面普通、内心吐槽的状态，并引出校花传闻。",
      "emotion": "轻松",
      "pacing": "慢",
      "must_include": [
        "男主急着回家玩游戏",
        "同学提到校花的传闻",
        "男主对校花保持距离"
      ],
      "ending_state": "男主注意到校花似乎有异常举动。"
    },
    {
      "scene_id": 2,
      "name": "异常的校花",
      "target_words": 700,
      "location": "图书馆",
      "characters": ["男主", "校花"],
      "purpose": "男主意外发现校花在查看某个游戏相关页面。",
      "emotion": "好奇、紧张",
      "pacing": "中",
      "must_include": [
        "校花偷偷查看游戏相关内容",
        "男主误以为自己看错了",
        "校花察觉男主在看她"
      ],
      "ending_state": "两人都开始怀疑对方知道了什么。"
    },
    {
      "scene_id": 3,
      "name": "尴尬的试探",
      "target_words": 800,
      "location": "走廊",
      "characters": ["男主", "校花"],
      "purpose": "通过对话制造误会和试探，让两人的秘密关系开始建立。",
      "emotion": "尴尬、搞笑、紧张",
      "pacing": "快",
      "must_include": [
        "校花用模糊的话试探男主",
        "男主拼命装傻",
        "双方都说出容易被误解的话"
      ],
      "ending_state": "校花确认男主有秘密，但没有揭穿。"
    },
    {
      "scene_id": 4,
      "name": "旧社团楼的邀请",
      "target_words": 700,
      "location": "放学路上/社团楼附近",
      "characters": ["男主", "校花"],
      "purpose": "让校花主动抛出社团邀请，为下一章制造钩子。",
      "emotion": "暧昧、悬疑",
      "pacing": "中",
      "must_include": [
        "校花暗示自己知道男主的爱好",
        "男主开始动摇",
        "校花邀请男主明天去旧社团楼"
      ],
      "ending_state": "男主陷入纠结，读者期待下一章。"
    },
    {
      "scene_id": 5,
      "name": "结尾钩子",
      "target_words": 300,
      "location": "校门口",
      "characters": ["男主"],
      "purpose": "强化悬念，让读者想继续看。",
      "emotion": "悬念",
      "pacing": "快",
      "must_include": [
        "男主回想校花的话",
        "手机收到一条神秘消息",
        "章节以旧社团楼作为悬念结束"
      ],
      "ending_state": "下一章进入社团线。"
    }
  ],
  "ending_hook": "如果你真的想知道答案，明天放学后来旧社团楼。"
}
```

---

## 7. 核心流程设计

### 7.1 `/plan_chapter`

输入：

```txt
/plan_chapter 第3章，3000字，男主发现校花也玩黄油，节奏搞笑转暧昧，结尾社团邀请。
```

执行流程：

```txt
1. 读取 story/outline.md
2. 读取 bible/characters.md
3. 读取 bible/world.md
4. 读取 bible/timeline.md
5. 解析用户输入
6. 生成章节蓝图 JSON
7. 检查每个场景字数之和是否接近目标字数
8. 保存到 story/blueprints/chapter_003_blueprint.json
```

输出：

```txt
已生成章节蓝图：
story/blueprints/chapter_003_blueprint.json
```

---

### 7.2 `/write_scene`

输入：

```txt
/write_scene 3 2
```

含义：

```txt
写第3章第2个场景。
```

执行流程：

```txt
1. 读取 chapter_003_blueprint.json
2. 找到 scene_002
3. 读取相关角色设定
4. 读取上一场景内容
5. 读取必要的前文摘要
6. 根据 scene.target_words 写正文
7. 保存到 story/scenes/chapter_003/scene_002.md
```

输出：

```txt
已完成：
story/scenes/chapter_003/scene_002.md
```

---

### 7.3 `/write_chapter`

输入：

```txt
/write_chapter 3
```

执行流程：

```txt
1. 读取 chapter_003_blueprint.json
2. 依次写 scene_001 到 scene_005
3. 每写完一个场景，检查是否完成 must_include
4. 保存每个场景文件
5. 调用 /merge_chapter 3
6. 调用 /word_count_check 3
7. 调用 /pacing_check 3
8. 保存报告
```

输出：

```txt
已完成第3章初稿：
story/chapters/chapter_003.md

检查报告：
reports/chapter_003_word_count_report.md
reports/chapter_003_pacing_report.md
```

---

### 7.4 `/merge_chapter`

输入：

```txt
/merge_chapter 3
```

执行流程：

```txt
1. 读取 story/scenes/chapter_003/ 下所有 scene 文件
2. 按 scene_id 排序
3. 合并为完整章节
4. 检查衔接是否自然
5. 保存到 story/chapters/chapter_003.md
```

---

### 7.5 `/word_count_check`

输入：

```txt
/word_count_check 3
```

输出示例：

```txt
# 第3章字数检查报告

目标字数：3000
实际字数：2480
差距：-520

## 场景字数统计

| 场景 | 目标字数 | 实际字数 | 差距 |
|---|---:|---:|---:|
| scene_001 | 500 | 420 | -80 |
| scene_002 | 700 | 620 | -80 |
| scene_003 | 800 | 610 | -190 |
| scene_004 | 700 | 570 | -130 |
| scene_005 | 300 | 260 | -40 |

## 建议

建议扩写：
- scene_003：增加两人试探对话，扩写约250字
- scene_004：增加校花邀请前的心理拉扯，扩写约200字
- scene_001：增加男主内心吐槽，扩写约70字
```

---

### 7.6 `/expand_scene`

输入：

```txt
/expand_scene 3 3 +300
```

含义：

```txt
把第3章第3个场景扩写约300字。
```

要求：

```txt
只扩写指定场景。
不得改变已有剧情走向。
不得新增重大设定。
扩写内容应服务于当前场景目的。
```

---

### 7.7 `/pacing_check`

输入：

```txt
/pacing_check 3
```

输出示例：

```txt
# 第3章节奏检查报告

## 总体评价

本章整体节奏基本符合“轻松 → 尴尬 → 暧昧 → 悬念”的要求，但中段误会升级不够强，后段钩子有效。

## 问题列表

### 1. 开场铺垫略短

当前开场只完成了男主日常展示，但没有充分引出校花传闻。

建议：
- 增加同学对校花的讨论
- 让男主明确表达“她和我不是一个世界的人”

### 2. 中段误会冲突偏弱

男主和校花的对话不够尴尬，缺少一次“差点暴露”的瞬间。

建议：
- 加入一个双关词误会
- 让校花说一句看似普通但只有同好才懂的话

### 3. 结尾钩子有效

旧社团楼邀请具备悬念，可以保留。

## 修改优先级

1. 优先强化 scene_003
2. 其次补强 scene_001
3. 保留 scene_005 的结尾钩子
```

---

## 8. Prompt 设计

### 8.1 `prompts/chapter_planner.md`

```txt
你是小说章节结构编辑。

你的任务是根据用户输入的章节要求、小说总大纲、角色设定、世界观和时间线，生成一个可执行的章节蓝图。

你不能直接写正文。

你必须输出 JSON，字段包括：

- chapter_id
- title
- target_words
- main_goal
- tone
- pacing
- required_plot_points
- forbidden_points
- emotional_curve
- scenes
- ending_hook

每个 scene 必须包括：

- scene_id
- name
- target_words
- location
- characters
- purpose
- emotion
- pacing
- must_include
- ending_state

规则：

1. 所有场景 target_words 之和必须接近章节 target_words。
2. 场景数量建议为 3 到 7 个。
3. 每个场景必须有明确作用。
4. 不要让剧情推进过快。
5. 不要新增用户未要求的重大设定。
6. 必须遵守角色设定。
7. 必须为结尾设计钩子。
8. 输出必须是合法 JSON。
```

---

### 8.2 `prompts/scene_writer.md`

```txt
你是小说正文作者。

你的任务是根据章节蓝图中的单个 scene 写正文。

你必须遵守：

1. 只写当前场景。
2. 不要提前写后续场景内容。
3. 必须完成 scene.must_include 中的所有要求。
4. 必须服务于 scene.purpose。
5. 字数尽量接近 scene.target_words。
6. 不要擅自改变人物关系。
7. 不要新增重大世界观。
8. 不要让人物说出不符合人设的话。
9. 保持与上一场景的自然衔接。
10. 结尾必须到达 scene.ending_state。

输出只包含正文，不要解释。
```

---

### 8.3 `prompts/pacing_checker.md`

```txt
你是小说节奏编辑。

你的任务是检查章节正文是否符合章节蓝图中的节奏要求。

请检查：

1. 开场是否过长或过短
2. 中段冲突是否足够
3. 情绪变化是否自然
4. 场景之间是否衔接顺畅
5. 结尾钩子是否有效
6. 是否存在剧情跳跃
7. 是否存在人物关系推进过快
8. 是否完成 required_plot_points
9. 是否违反 forbidden_points

输出 Markdown 报告，包含：

- 总体评价
- 问题列表
- 对应场景
- 修改建议
- 修改优先级
```

---

### 8.4 `prompts/scene_expander.md`

```txt
你是小说局部扩写编辑。

你的任务是扩写指定场景。

必须遵守：

1. 只扩写当前场景。
2. 不改变原本剧情走向。
3. 不删除原有关键内容。
4. 不新增重大设定。
5. 扩写内容必须服务于当前场景目的。
6. 扩写方式可以包括：
   - 增加心理描写
   - 增加环境描写
   - 增加对话拉扯
   - 增加动作细节
   - 增加情绪过渡
7. 扩写后字数尽量达到目标。
8. 输出完整扩写后的场景正文。
```

---

### 8.5 `prompts/scene_rewriter.md`

```txt
你是小说局部重写编辑。

你的任务是根据修改要求重写指定场景。

必须遵守：

1. 只重写当前场景。
2. 保留章节蓝图要求。
3. 保留本场景必须完成的剧情功能。
4. 可以改变表达方式、对话和细节。
5. 不得破坏后续场景衔接。
6. 不得违反角色设定。
7. 不得新增重大设定。
8. 输出完整重写后的场景正文。
```

---

## 9. 字数控制策略

AI 很容易写不够字，所以不要只靠一句“写3000字”。

建议采用以下策略：

### 9.1 总字数拆分

例如目标 3000 字：

```txt
scene_001：500字
scene_002：700字
scene_003：800字
scene_004：700字
scene_005：300字
```

这样比直接要求“写3000字”稳定。

### 9.2 写完后统计

写完后进行：

```txt
目标字数 vs 实际字数
```

如果差距超过 15%，自动生成扩写建议。

### 9.3 局部扩写

不要整章扩写，而是指定场景扩写：

```txt
/expand_scene 3 3 +300
/expand_scene 3 4 +200
```

---

## 10. 节奏控制策略

建议把节奏拆成四个维度：

| 维度 | 说明 |
|---|---|
| 情绪曲线 | 轻松、紧张、暧昧、悬疑等 |
| 冲突强度 | 弱、中、强 |
| 信息释放 | 本场景透露多少新信息 |
| 关系推进 | 人物关系变化速度 |

每个场景都要写清楚：

```json
{
  "emotion": "尴尬、搞笑、紧张",
  "pacing": "快",
  "conflict_level": "medium",
  "information_reveal": "校花可能也是同好",
  "relationship_change": "双方从陌生变成互相怀疑"
}
```

这样 Agent 写作时更不容易跑偏。

---

## 11. 质量检查报告

建议每章写完后自动生成一个总报告。

文件：

```txt
reports/chapter_003_quality_report.md
```

内容：

```txt
# 第3章质量检查报告

## 1. 字数检查

目标字数：
实际字数：
差距：

## 2. 剧情点完成情况

| 剧情点 | 是否完成 | 说明 |
|---|---|---|
| 男主发现校花异常 | 是 | scene_002 完成 |
| 两人产生误会 | 是 | scene_003 完成 |
| 校花试探男主 | 部分完成 | 需要加强 |
| 结尾社团邀请 | 是 | scene_005 完成 |

## 3. 节奏检查

- 开场：
- 中段：
- 后段：
- 结尾：

## 4. 人设检查

- 男主：
- 校花：

## 5. 时间线检查

- 是否与前文冲突：
- 是否需要更新 timeline：

## 6. 修改建议

1. 优先修改 scene_003，加强误会冲突。
2. 扩写 scene_004，增加校花邀请前的暧昧试探。
3. 保留结尾钩子。
```

---

## 12. 推荐实现顺序

第一轮不要全部做完，按这个顺序实现。

### 阶段一：最小可用

必须完成：

```txt
/plan_chapter
/write_scene
/merge_chapter
/write_chapter
```

目标：

```txt
用户输入章节要求 → 自动生成蓝图 → 自动写完整章
```

---

### 阶段二：可控写作

增加：

```txt
/word_count_check
/expand_scene
/rewrite_scene
```

目标：

```txt
字数不够可以自动定位哪里需要扩写。
```

---

### 阶段三：质量检查

增加：

```txt
/pacing_check
/chapter_report
/finalize_chapter
```

目标：

```txt
写完后有质量报告，可以按报告修。
```

---

### 阶段四：高级增强

后续再加：

```txt
/search_inspiration
/originality_check
/foreshadowing_check
/emotional_curve_check
/dialogue_naturalness_check
```

---

## 13. 给 Opus / Codex 的实现提示词

如果让 Opus 4.8 或 Codex 帮你实现，可以直接给下面这段。

```txt
请在现有 Novel Agent 项目中增加“章节蓝图与分场景写作模块”。

目标：
用户给出一段章节大纲、目标字数、剧情要求和节奏要求后，Agent 不要直接写整章，而是先生成章节蓝图 JSON，再按场景写正文，最后合并章节并生成字数/节奏检查报告。

请实现以下命令：

1. /plan_chapter
   - 输入用户章节要求
   - 读取 story outline、characters、world、timeline
   - 输出 story/blueprints/chapter_xxx_blueprint.json

2. /write_scene
   - 输入 chapter_id 和 scene_id
   - 读取对应 blueprint
   - 根据 scene 的 target_words、purpose、must_include 写正文
   - 保存到 story/scenes/chapter_xxx/scene_xxx.md

3. /merge_chapter
   - 合并 story/scenes/chapter_xxx/ 下所有场景
   - 保存到 story/chapters/chapter_xxx.md

4. /write_chapter
   - 自动按 blueprint 顺序写所有 scene
   - 合并章节
   - 生成字数检查报告和节奏检查报告

5. /word_count_check
   - 统计每个 scene 和整章字数
   - 与 blueprint 中 target_words 对比
   - 输出 reports/chapter_xxx_word_count_report.md

6. /pacing_check
   - 根据 blueprint 的 pacing、emotional_curve、required_plot_points、forbidden_points 检查章节正文
   - 输出 reports/chapter_xxx_pacing_report.md

7. /expand_scene
   - 指定 chapter_id、scene_id 和扩写字数
   - 只扩写当前 scene，不改变剧情走向

8. /rewrite_scene
   - 指定 chapter_id、scene_id 和修改要求
   - 重写当前 scene

要求：
- 使用 Python 实现。
- 不引入 LangChain / LangGraph。
- 不做 Web UI。
- 保持项目结构清晰。
- 所有 prompt 放在 prompts/ 目录。
- 所有章节蓝图保存为 JSON。
- 所有场景正文保存为 Markdown。
- 所有报告保存为 Markdown。
- 必须兼容 mock 模式，如果没有 API key，也能用假数据跑通流程。
- 代码要简洁，可运行，不要过度抽象。

最终我希望流程是：

/plan_chapter → /write_chapter → /word_count_check → /pacing_check → /expand_scene 或 /rewrite_scene → /finalize_chapter
```

---

## 14. 最终推荐功能组合

如果只选最重要的几个，建议优先做：

```txt
1. 章节蓝图器：/plan_chapter
2. 场景写作器：/write_scene
3. 整章生成器：/write_chapter
4. 字数检查器：/word_count_check
5. 节奏检查器：/pacing_check
6. 局部扩写器：/expand_scene
7. 局部重写器：/rewrite_scene
```

这个组合做完，小说 Agent 就从“会生成文字”升级成：

> **能按大纲、字数、剧情点和节奏要求施工的小说写作 Agent。**

---

## 15. 一句话总结

这个模块的核心不是让 AI 写得更花，而是让 AI 写得更可控。

> **用户给大纲，Agent 拆蓝图；用户定字数，Agent 分场景；用户定节奏，Agent 按节拍写；写完后还能检查、扩写、重写和定稿。**

这就是小说 Agent 真正实用的第一道门槛。
