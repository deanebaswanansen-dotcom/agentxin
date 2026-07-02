# 小说Agent — 用户体验问题报告（全面审查）

> 审查日期：2026-06-04
> 审查范围：前端全部组件 + CSS + 布局 + 交互流程
> 严重程度：🔴 致命 / 🟠 严重 / 🟡 中等 / 🔵 轻微

---

## 一、CSS 致命 Bug（导致大面积看不见）

### 🔴 BUG-01：三个核心 CSS 变量从未定义，导致大量元素不可见

**文件**：`frontend/src/App.css` 的 `:root` 块 和 `frontend/src/components/components.css`

**问题**：`components.css` 中大量使用了以下三个 CSS 变量，但它们在 `:root` 中**根本没有定义**：
- `--bg-surface` — 用在 `.nwa-panel`、`.nwa-agent`、`.nwa-workspace-panel`、`.nwa-provider-card--active` 等背景
- `--bg-surface-hover` — 用在所有 hover 态背景（`.nwa-button:disabled`、`.nwa-task-card:hover`、`.nwa-tab:hover`、`.nwa-workspace-tab:hover` 等）
- `--border-subtle` — 用在**几乎所有**组件的边框（`.nwa-panel`、`.nwa-input`、`.nwa-textarea`、`.nwa-button--ghost`、`.nwa-stream`、`.nwa-tabs`、`.nwa-chat__msg`、`.nwa-provider-card`、`.nwa-workspace-panel`、`.nwa-toast` 等）

**后果**：
- 所有面板（`.nwa-panel`）没有边框、没有背景色 → 和背景融为一体，看不见边界
- 所有输入框（`.nwa-input`、`.nwa-textarea`）没有边框 → 用户找不到输入框在哪
- 所有按钮 hover/disabled 态背景消失
- 所有列表项没有分隔线
- 对话消息气泡没有边框
- 设置面板的 provider 卡片没有边框
- Toast 错误提示没有边框

**修复**：在 `App.css` 的 `:root` 中添加：
```css
--bg-surface: rgba(15, 15, 20, 0.65);
--bg-surface-hover: rgba(25, 25, 35, 0.75);
--border-subtle: rgba(255, 255, 255, 0.1);
```

---

### 🔴 BUG-02：CSS 语法错误 — 多余的 `}` 导致后续样式全部失效

**文件**：`frontend/src/components/components.css` 第 202 行

**问题**：在 `.nwa-list__actions` 规则块结束后（第 200 行），第 202 行有一个**多余的右花括号 `}`**。这个孤立的 `}` 会被浏览器当作语法错误，导致它之后的所有 CSS 规则解析出错或失效。

**位置**：
```css
/* 第 195-202 行 */
.nwa-list__actions {
  display: flex;
  gap: 0.25rem;
  flex: 1 0 auto;
  justify-content: flex-end;
}

}  /* ← 这个 } 是多余的！ */

.nwa-list__item--selected {  /* ← 从这里开始可能受影响 */
```

**后果**：从第 204 行开始的所有 CSS 规则可能不被正确解析，包括：
- `.nwa-list__item--selected`（选中态样式）
- `.nwa-list__button`
- `.nwa-muted`
- `.nwa-empty`
- `.nwa-stream`
- `.nwa-tabs` / `.nwa-tab`
- 整个 Agent 区域样式
- 整个 workspace 面板样式
- 整个 Chat 面板样式
- 整个 Settings 面板样式
- Toast 错误提示样式
- 所有响应式媒体查询

**修复**：删除第 202 行的孤立 `}`。

---

### 🔴 BUG-03：`.nwa-list__item--selected` 重复定义，且两处样式冲突

**文件**：`frontend/src/components/components.css`

**问题**：`.nwa-list__item--selected` 被定义了两次：
1. 第 168-171 行：使用紫色系（`rgba(192, 132, 252, 0.15)` + `var(--border-glow)`）
2. 第 204-208 行：使用蓝色系（`rgba(96, 165, 250, 0.08)` + `var(--accent-primary)`）

由于 BUG-02 的语法错误，实际生效的是哪一份不确定，导致选中态样式不可预测。

**修复**：删除其中一份，统一使用一种颜色方案。

---

## 二、布局与排版问题

### 🟠 BUG-04：Agent 面板双按钮功能完全重复，用户困惑

**文件**：`frontend/src/components/AgentCommandCenter.tsx` 第 244-249 行

**问题**：操作区有两个按钮：
- 「直接执行」（ghost 样式）
- 「按计划执行：开始生成」（主样式）

两个按钮绑定的是**同一个 `run()` 函数**，功能完全一样。用户会困惑："直接执行"和"按计划执行"有什么区别？答案是：没有区别。

**修复**：删除「直接执行」按钮，只保留一个。

---

### 🟠 BUG-05：编辑器页面三栏布局在中等屏幕溢出

**文件**：`frontend/src/App.css` 第 113 行

**问题**：主工作区使用固定三栏布局：
```css
grid-template-columns: 360px 1fr 380px;
```
加上 `gap: 1.5rem` 和 `padding: 0 1.5rem`，总最小宽度约为 `360 + 380 + 1.5*16*4 + 1.5*16*2 = 888px`。但中间编辑器区域没有最小宽度约束，在 1200px 以下屏幕（第 288-293 行的媒体查询改为 `280px 1fr 320px`）时，编辑器可能被挤压到很窄。

**更严重的问题**：`body` 设置了 `overflow: hidden`（第 28 行），意味着如果内容超出视口，用户**完全无法滚动**。在小屏幕或缩放情况下，底部内容会被截断且无法访问。

---

### 🟠 BUG-06：右侧 Agent/Chat 面板内容可能被截断

**文件**：`frontend/src/App.css` 第 282-286 行

**问题**：右侧内容区 `.nwa-right-content` 设置了 `overflow-y: auto`，但它的父容器 `.nwa-tavern-right` 使用 `display: flex; flex-direction: column`，没有设置 `min-height: 0` 或 `overflow: hidden`。在某些情况下，flex 子项可能不收缩，导致内容溢出而滚动条不出现。

---

### 🟡 BUG-07：编辑器 textarea 没有最小高度，空章节时几乎看不见

**文件**：`frontend/src/components/ChapterEditor.tsx` 第 209 行

**问题**：编辑器 textarea 设置了 `rows={16}`，但如果 `.nwa-editor-wrapper` 的高度不够（比如窗口较小），textarea 可能被压缩得很小。而且编辑器的 `.nwa-panel` 样式由于 `--bg-surface` 和 `--border-subtle` 未定义（BUG-01），面板本身没有边框和背景，textarea 浮在背景上几乎不可见。

---

### 🟡 BUG-08：左侧边栏的 ProjectListView 和 ProjectWorkspaceView 面板样式被覆盖为透明

**文件**：`frontend/src/App.css` 第 159-166 行

**问题**：
```css
.nwa-tavern-sidebar .nwa-panel,
.nwa-tavern-sidebar .nwa-workspace-panel {
  padding: 0;
  border: none;
  background: transparent;
  box-shadow: none;
  backdrop-filter: none;
}
```
这把侧边栏里所有面板的 padding、border、background 全部去掉了。但 `ProjectListView` 和 `ProjectWorkspaceView` 的内部布局依赖这些 padding 来留白。结果是内容紧贴边缘，非常拥挤。

特别是 `ProjectWorkspaceView` 的标题「项目资料」和 tab 按钮紧贴容器左上角，没有呼吸空间。

---

### 🟡 BUG-09：侧边栏内的 workspace-tabs 四等分在 360px 宽度下太挤

**文件**：`frontend/src/components/components.css` 第 587-589 行

**问题**：
```css
.nwa-workspace-tabs {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}
```
在 360px 宽的侧边栏里，4 个 tab（章节/人物/世界观/大纲）每个只有约 80px 宽，加上 gap 和 padding，文字可能被截断或换行。

---

### 🟡 BUG-10：人物描述仍然是单行 input，长文本完全不可见

**文件**：`frontend/src/components/ProjectWorkspaceView.tsx` 第 333-340 行

**问题**：人物描述输入框使用的是 `<input type="text">`（单行），而不是 `<textarea>`。人物描述通常是一段话（比如"25岁，性格冷酷，擅长冰系法术，口头禅是'你不够格'"），单行 input 只能显示约 20 个汉字，超出部分被截断且无法看到全貌。

同样的问题存在于：
- 世界观内容输入（第 405-412 行）— 世界观内容可能很长
- 大纲内容输入（第 479-486 行）— 大纲内容可能很长

---

### 🟡 BUG-11：编辑表单（editForm）的三列 grid 布局在窄屏下挤压

**文件**：`frontend/src/components/components.css` 第 621-628 行

**问题**：
```css
.nwa-inline-edit {
  grid-template-columns: minmax(160px, 0.6fr) minmax(220px, 1fr) auto;
}
```
在侧边栏 360px 宽度内，这个三列布局（标题输入 + 内容输入 + 按钮组）非常拥挤。而且「按钮组」是一个 `.nwa-list__actions` div（包含保存和取消按钮），它作为 grid 子项可能换行或溢出。

---

### 🟡 BUG-12：对话面板的聊天记录区域固定最大高度 28rem，在右侧面板中可能过大或过小

**文件**：`frontend/src/components/components.css` 第 888 行

**问题**：
```css
.nwa-chat {
  max-height: 28rem;
}
```
右侧面板总宽度约 380px，减去 padding 后内容区更窄。28rem（约 448px）的聊天记录区加上操作类型 tabs、选定文本提示、输入框和发送按钮，总高度可能超出面板可视区域。由于面板有 `overflow-y: auto`，用户需要滚动才能看到输入框——这是非常糟糕的体验，因为用户最常交互的输入框被推到了最下面。

---

## 三、交互与功能问题

### 🟠 BUG-13：「伴写」tab 在未选章节时只显示一行灰色提示，没有任何操作入口

**文件**：`frontend/src/App.tsx` 第 191 行 和 第 224-226 行

**问题**：当用户点击「伴写」tab 但没有选择章节时，显示的是：
```
请先在左侧选择一个章节
```
但问题是——这个提示是在 `.nwa-empty-state-small` 里，样式是 `text-align: center; color: var(--text-muted); font-style: italic`。由于 `--text-muted` 依赖 CSS 变量（已定义，值为 `#94a3b8`），在深色背景上应该可见，但灰色斜体字在暗色背景上对比度很低，用户可能根本注意不到这行字。

---

### 🟠 BUG-14：蓝图 tab 在未选章节时完全空白，没有任何提示

**文件**：`frontend/src/App.tsx` 第 210-217 行

**问题**：
```tsx
{rightTab === 'blueprint' && selectedChapter && (
  <ChapterBlueprintPanel ... />
)}
```
当 `selectedChapter` 为 null 时，蓝图 tab 什么都不渲染——不像伴写 tab 至少有 "请先在左侧选择一个章节" 的提示。用户切换到蓝图 tab 会看到完全空白的面板，不知道发生了什么。

虽然第 224 行有 fallback：
```tsx
{(rightTab === 'chat' || rightTab === 'blueprint') && selectedChapter === null && (
  <div className="nwa-empty-state-small">请先在左侧选择一个章节</div>
)}
```
但这段代码在 `{rightTab === 'blueprint' && selectedChapter && (...)}` **之后**，由于 React 的条件渲染逻辑，当 `rightTab === 'blueprint'` 且 `selectedChapter` 为 null 时，第一个条件不匹配所以不渲染 ChapterBlueprintPanel，但第二个条件 `(rightTab === 'chat' || rightTab === 'blueprint') && selectedChapter === null` **应该匹配**——所以这段 fallback 应该能工作。

但等等，仔细看：当 `rightTab === 'settings'` 时，第 219-221 行会渲染 SettingsPanel。而 fallback 条件是 `(rightTab === 'chat' || rightTab === 'blueprint')`，所以 settings 不受影响。

**实际问题**：这段 fallback 确实应该工作。但如果 CSS 有问题（BUG-01/02），`.nwa-empty-state-small` 的样式可能不生效，导致文字不可见。

---

### 🟡 BUG-15：章节编辑器的保存按钮和标题在同一行，在窄右侧面板中可能换行

**文件**：`frontend/src/components/ChapterEditor.tsx` 第 194-205 行

**问题**：编辑器顶部是 `.nwa-row`（flex 布局），包含章节标题、"未保存" 指示器和保存按钮。如果章节标题很长（比如 "第三章：主角在废土灵田中发现上古阵法"），标题会把保存按钮挤到右边甚至换行。

---

### 🟡 BUG-16：Agent 执行进度条的步骤指示器是 5 列 grid，在窄面板中文字截断

**文件**：`frontend/src/components/components.css` 第 527-533 行

**问题**：
```css
.nwa-agent-progress__steps {
  grid-template-columns: repeat(5, minmax(0, 1fr));
}
```
5 个步骤（读取项目资料 / 整理人物和世界观 / 规划章节方向 / 调用模型生成 / 保存结果）在 Agent 面板中等分宽度。每个步骤名都是中文，在窄面板中会被截断。第 977-979 行的媒体查询在 1024px 以下改为单列，但在 1024-1200px 之间仍然是 5 列。

---

### 🟡 BUG-17：Agent 结果区域的 `.nwa-agent__result` 使用两列 grid，步骤列表可能溢出

**文件**：`frontend/src/components/components.css` 第 477-485 行

**问题**：
```css
.nwa-agent__result {
  grid-template-columns: minmax(280px, 0.7fr) 1fr;
}
```
左列最小 280px 放步骤列表，右列放 artifacts。但在右侧面板（380px 宽）中，两列加起来最小需要 280 + gap = 280 + 32 = 312px，加上面板 padding (2rem * 2 = 64px)，总需 376px，几乎刚好。但如果面板实际可用宽度不足，步骤列表会被压缩。

---

### 🟡 BUG-18：重命名/删除项目仍然使用原生 window.prompt / window.confirm

**文件**：`frontend/src/components/ProjectListView.tsx` 第 98 行、第 117 行

**问题**：虽然这不是新问题，但在精心设计的暗色主题 UI 中，突然弹出一个系统原生的白色对话框，视觉冲击非常大，破坏沉浸感。应该使用自定义 modal。

---

### 🔵 BUG-19：ChatPanel 的选定文本提示截断为 60 字符，在窄面板中可能一行就满了

**文件**：`frontend/src/components/ChatPanel.tsx` 第 277 行

**问题**：
```tsx
selectedText.length > 60 ? `${selectedText.slice(0, 60)}…` : selectedText
```
在 380px 宽的右侧面板中，60 个中文字符约需 1200px 宽度，远超面板宽度。虽然 CSS 有 `word-break: break-word`，但截断逻辑本身是合理的。不过 `.nwa-chat__selected` 的样式中 `padding` 被重复定义了（第 916 行和第 917 行），后面的会覆盖前面的。

---

### 🔵 BUG-20：Google Fonts 加载失败时没有 fallback 保障

**文件**：`frontend/src/App.css` 第 1 行

**问题**：
```css
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=Outfit:wght@400;500;600;700;800&display=swap');
```
如果 Google Fonts 加载失败（网络问题、被墙等），`font-family: 'Outfit', sans-serif` 会 fallback 到 sans-serif。但很多组件的排版尺寸（标题 font-size: 2rem、font-weight: 800 等）是为 Outfit 字体设计的，fallback 字体可能看起来完全不同。

**更严重**：在中国大陆，Google Fonts 被墙的可能性很高。如果用户网络无法访问 `fonts.googleapis.com`，这个 `@import` 会阻塞页面渲染（因为 CSS `@import` 是渲染阻塞的），导致页面白屏很长时间。

---

### 🔵 BUG-21：bg.png 背景图引用可能导致 404

**文件**：`frontend/src/App.css` 第 39 行

**问题**：
```css
background-image: url('/bg.png');
```
这个路径指向 `frontend/public/bg.png`。虽然文件存在，但如果部署方式不同（比如 SPA 路由、子目录部署），`/bg.png` 可能 404。而且如果图片加载失败，`--bg-base`（`#05050a`）会作为 fallback，这倒是没问题。

---

## 四、信息展示问题

### 🟡 BUG-22：字数报告和节奏报告中显示 sceneId 而非场景名称

**文件**：`frontend/src/components/ReportView.tsx` 第 79 行、第 138 行

**问题**：
```tsx
<strong>{s.sceneId}</strong>
```
用户看到的是类似 `scene-1`、`scene-2` 这样的技术 ID，而不是场景名称（如"主角入学"、"导师测试"）。同样的问题在节奏报告的 `sceneIssues` 中也存在（第 138 行）。

---

### 🟡 BUG-23：Agent 生成结果中 artifact 标签不可点击，无法跳转查看

**文件**：`frontend/src/components/AgentCommandCenter.tsx` 第 283-289 行

**问题**：Agent 执行完后显示的 artifact 标签（"世界观：xxx"、"人物：xxx"）只是纯文本 `<span className="nwa-chip">`，不可点击。用户想查看生成的世界观或人物详情，只能手动去"项目资料"tab 找。

---

### 🔵 BUG-24：Agent 进度条的进度是基于时间估算的，不是真实进度

**文件**：`frontend/src/components/AgentCommandCenter.tsx` 第 156 行

**问题**：
```tsx
const progressIndex = Math.min(PROGRESS_STEPS.length - 1, Math.floor(elapsedSeconds / 8));
```
进度条是按每 8 秒跳一步来估算的（总共 5 步 = 40 秒）。如果模型响应快（10 秒完成），进度条只走了第一步；如果模型响应慢（2 分钟），进度条会在第 5 步停很久。这不是真实进度，给用户错误的预期。

---

## 五、响应式问题

### 🟡 BUG-25：900px 以下单列布局但没有为移动端优化交互

**文件**：`frontend/src/App.css` 第 296-304 行

**问题**：900px 以下改为单列，三个面板垂直堆叠。但：
- `body { overflow: auto }` 恢复了滚动，意味着用户需要滚动很长的页面
- 侧边栏（360px 原始宽度）在单列中变成全宽，但内容仍然按 360px 设计
- 右侧面板（380px 原始宽度）也变成全宽，但 Agent 面板的 grid 布局（两列）可能在窄屏上不好看

---

### 🔵 BUG-26：`.nwa-rtab` 按钮在禁用态下 opacity 0.3 太透明

**文件**：`frontend/src/App.css` 第 277-280 行

**问题**：
```css
.nwa-rtab:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
```
目前没有 tab 被禁用的逻辑，但如果将来添加，0.3 的透明度在暗色背景上几乎看不见。

---

## 六、代码质量问题（影响可维护性）

### 🔵 BUG-27：前后端 types 文件是手动同步的拷贝

**文件**：`frontend/src/types/index.ts` 第 8-14 行注释

**问题**：注释明确说 "This file is a COPY of the canonical source at `backend/src/types/index.ts`"，并要求 "MUST be updated together"。这种手动同步方式极易遗漏，导致前后端类型不一致。

---

## 总结：按严重程度排序

| 编号 | 严重程度 | 问题 | 影响 |
|------|---------|------|------|
| BUG-01 | 🔴 致命 | 三个 CSS 变量未定义 | 大面积元素不可见（面板、输入框、按钮、边框） |
| BUG-02 | 🔴 致命 | CSS 多余 `}` 语法错误 | 第 202 行之后的所有样式可能失效 |
| BUG-03 | 🔴 致命 | `.nwa-list__item--selected` 重复定义 | 选中态样式不可预测 |
| BUG-04 | 🟠 严重 | Agent 双按钮功能重复 | 用户困惑 |
| BUG-05 | 🟠 严重 | body overflow:hidden 截断内容 | 小屏幕用户无法访问底部内容 |
| BUG-06 | 🟠 严重 | 右侧面板 flex 子项可能不收缩 | 内容溢出无滚动条 |
| BUG-08 | 🟡 中等 | 侧边栏面板样式被覆盖为透明 | 内容拥挤无呼吸空间 |
| BUG-10 | 🟡 中等 | 人物/世界观/大纲用单行 input | 长文本看不见 |
| BUG-11 | 🟡 中等 | 编辑表单三列在窄屏挤压 | 编辑体验差 |
| BUG-12 | 🟡 中等 | 聊天记录区固定高度可能推走输入框 | 用户找不到输入框 |
| BUG-13 | 🟠 严重 | 未选章节时伴写提示对比度低 | 用户注意不到提示 |
| BUG-14 | 🟡 中等 | 蓝图 tab 未选章节时的 fallback | 可能正常工作但依赖 CSS |
| BUG-20 | 🔵 轻微 | Google Fonts 在中国被墙 | 页面可能白屏 |
| 其他 | 🔵 轻微 | 各种小问题 | 见上方详细描述 |

---

## 建议修复优先级

1. **立即修复**：BUG-01 + BUG-02 + BUG-03（CSS 变量定义 + 语法错误）— 这三个修好后，大部分"看不见"的问题就解决了
2. **尽快修复**：BUG-04（删重复按钮）、BUG-05（overflow 问题）、BUG-10（input 改 textarea）
3. **后续优化**：其余中等和轻微问题

---

## 2026-06 后续复审（CSS 致命问题已基本修复后的新发现）

> 审查方式：完整用户路径模拟（从 start.bat 启动 → 新建项目 → 填资料建章节 → 中间编辑 → 右侧 Agent/伴写/蓝图/设置 全流程切换 + 边界 case） + 源码走读全部核心组件 + 部分后端 API 验证 + 与旧报告交叉比对。
> 重点：**新手可发现性 + 日常交互效率 + 信息架构 + 视觉/布局细节**（而非早期渲染不可见问题）。
> 当前状态：旧报告中 🔴 致命的 CSS 变量缺失、孤立 }、重复 selected 等已修复；workspace-tabs 改为 2 列网格；modals 已实现；Agent 双按钮重复已删除。基础可渲染，但“用起来不方便”的问题仍较多。

**本轮会话已修复 / 缓解：**
- NEW-02：编辑器保存/关闭按钮样式（components.css 新增 --outline / --icon 规则）
- NEW-03（大部分）：Agent 面板视觉空间大幅优化——任务卡 grid 改为 minmax(155px) 可在窄栏 2 列排列、卡片 min-height 降至 3.8rem + 紧凑 padding/字体；plan 步骤用 <details> 可折叠（默认收起节省空间）；整体 .nwa-agent / __box gap 减小、current box 更紧凑；prompt 6rem。视觉更紧致不拥挤仍美观。额外：每个任务卡加上小图标（✨ 🔄 🏷️ 🗺️ ✍️ 🔍），提升辨识度和视觉吸引力，当前任务也显示图标。
- NEW-01：Agent 面板内“一键启用 Mock 演示（无需 Key）”按钮 + 视觉提示区（直接调用 modelConfig.save）
- NEW-04：Agent 自动加载新章节时不再强制切右侧到 chat（保留用户在 Agent 结果页）
- NEW-05：人物/世界观/大纲的创建表单从横向 row--wrap 改为清晰的垂直堆叠（name → 内容 textarea → 右对齐按钮）
- NEW-07：Agent 结果中的 artifact chips（世界观/人物/大纲/章节）现在是可点击按钮，点击后会自动切换左侧「项目资料」的对应 tab（并在章节时加载到编辑器）。实现了从生成结果直接跳转查看。
- NEW-06：章节现在支持重命名和删除（UI 列表里加了操作按钮 + 模态确认，和人物/世界观/项目一致）。后端新增了 renameChapter API / PATCH /chapters/:id 。
- NEW-08：报告视图（字数/节奏）现在优先显示场景的真实 name（从蓝图 scenes 映射），而非 sceneId（如 "scene-1" → "主角觉醒"）。在 ChapterBlueprintPanel 传入 scenes，ReportView 内部用 Map 回显，fallback 保留兼容。测试覆盖。
- NEW-09：左侧侧边栏增加“收起列表/展开列表”按钮（项目选中时出现），可折叠上方的项目列表，专注下方的项目资料面板，缓解双面板常驻堆叠问题。
- NEW-10：进度估算已缓解（明确“步骤 X/Y（编排估算，非实时）”标签）。
- 蓝图面板嵌套 panel（已移除外层 class）。
- 其他轻微细节已记录/缓解。

### 🔴 高优先（严重影响新手上手和核心创作流）

**NEW-01: 首次无 Key 体验门槛过高，无明显 Mock 快速入口**  
**文件**：`frontend/src/components/SettingsPanel.tsx`（预设顺序）、`App.tsx:264`（Agent 默认打开）、各空状态。  
**问题**：PROVIDER_PRESETS[0] 是 DeepSeek V4 Pro，需要真实 Key。Mock 是第 3 个卡片。  
用户打开即看到 Agent 6 张任务卡 + prompt，点执行大概率触发 409 MODEL_NOT_CONFIGURED，右上 toast 报错。  
没有在 Agent 面板顶部、空状态、欢迎页、或“新建项目”成功后给出“一键切换 Mock 立即体验”的强引导或按钮。  
README/start.bat 提到，但 UI 自己不教用户。  
**后果**：新手第一分钟就卡住、报错、失去信心。

**NEW-02: ChapterEditor 顶部操作按钮样式规则缺失**  
**文件**：`frontend/src/components/ChapterEditor.tsx:204,213`  
**问题**：保存按钮用 `nwa-button nwa-button--outline`，关闭用 `nwa-button nwa-button--icon`。  
`components.css` 中只有 `--ghost` / `--danger` 定义，这两个变体完全没有规则。  
结果：保存继承主渐变色大按钮（跟“新建”一样抢眼）；关闭 ✕ 也是带背景和 padding 的彩色按钮，完全不像图标按钮。标题行视觉权重错乱。  
**后果**：编辑器头部（用户高频停留区）显得很业余。

**NEW-03: 右侧 Agent 面板垂直空间严重超载（默认 ~380px 右栏）**  
**文件**：`frontend/src/components/AgentCommandCenter.tsx:229`（任务网格）、`423`（`.nwa-agent__input { min-height:14rem }`）、`456`（plan）、`299`（进度）。  
**问题**：6 个 min 5.5rem 任务卡 + 当前任务重复 desc + 编排步骤 ol + 14rem 高的 prompt + hint + 按钮 + 结果区。  
在右栏内容区（减 padding 后更窄）里，prompt 输入框经常被推到需要滚动才能看到的位置。  
任务卡选中后下方又几乎重复显示标题+描述+计划，信息冗余。  
**后果**：用户写 prompt、点执行时要反复滚动，体验割裂。

**NEW-04: Agent 成功生成章节后强制切到“伴写”tab，用户看不到结果**  
**文件**：`frontend/src/App.tsx:98`（loadChapter 内 setRightTab('chat')）、`AgentCommandCenter.tsx:161`（onCompleted 后）。  
**问题**：auto_next / novel 等任务写完章节后，会调用 loadChapter → 强制切右侧到 chat。  
结果（summary、步骤列表、artifact chips、章节预览）仍留在 Agent 组件 state（因为用 display:none 保持挂载），但用户被切走，看不到刚生成的东西。  
**后果**：心流中断，要手动切回 Agent 才能 review 结果。

**NEW-05: 项目资料（非章节）创建表单在侧边栏布局混乱**  
**文件**：`frontend/src/components/ProjectWorkspaceView.tsx:345`（characters）、`411`（world）、`477`（outlines）。  
**问题**：用 `.nwa-row nwa-row--wrap` 把“名称 input + 内容 textarea（min 8rem 高） + 添加按钮”横向一排。  
在 360px 左栏内 wrap 后对齐差（按钮 align 到 input 而非 textarea）、从属关系不清。  
章节 tab 是干净的“标题+按钮”+列表，人物/世界观/大纲却混排，体验不一致。  
**后果**：添加人物/世界观时用户经常搞不清输入框和按钮的关系。

### 🟠 中等

**NEW-06: 章节在 UI 中缺少基本管理能力**  
**文件**：`ProjectWorkspaceView.tsx` chapters 分支（只渲染列表，无 actions）。  
**问题**：只能新建 + 点击标题打开编辑。无重命名、无删除、无改标题。  
ChapterEditor 里标题只读（`{chapter.title}`）。后端 ChapterService.remove 存在且路由支持，但前端完全没暴露。  
创建错标题后只能绕路。

**NEW-07: Agent 结果 artifacts 不可点击**  
**文件**：`AgentCommandCenter.tsx:325`（`nwa-chip` 纯 span）。  
**问题**：生成后显示“世界观：xxx”“人物：xxx”“章节：yyy”，只是展示。  
用户想去左侧查看/编辑，必须手动切 tab、找列表。  
**建议**：chip 可点击 → 切换左侧 activeTab + 定位对应条目（或至少滚动+高亮）。

**NEW-08: 报告视图仍显示 sceneId 而非人类可读名称**  
**文件**：`ReportView.tsx:79,138`（`<strong>{s.sceneId}</strong>` 等）。  
**问题**：字数报告和节奏问题列表直接用 backend 返回的 sceneId（scene-1 等）。  
Blueprint 里的 scenes 有 name 字段，但 report 数据没带过来 join。  
旧报告 BUG-22 未完全解决。

**NEW-09: 左侧“图书馆 + 项目资料”双面板常驻堆叠，无专注/折叠**  
选中项目后，上面是项目列表（可能很多），下面是项目资料（4 tab + 内容）。  
无“收起项目列表”或“只看当前项目资料”的控件。内容多时滚动距离长。

**NEW-10: 进度条仍是纯时间估算，非真实进度**  
`AgentCommandCenter.tsx:134`（setInterval 每 12s +1），bar 按 liveStepIndex。  
meta 文字写着“估算”，但用户还是会把进度条当真进度看。快响应时几乎不动，慢响应时第 5 步卡很久。  
**已缓解**：进度区域现在显示“步骤 X/Y：当前标签（编排估算，非实时进度；完成后以结果为准）”，bar 仍作为视觉参考但更透明。

### 🔵 轻微 / 细节

- 任务卡 + 下方 current 信息有明显重复。
- 关闭章节后，右侧 chat/blueprint 显示“请先选择章节”的小提示，对“当前还在这个项目”这个事实表达不够清晰。
- 粒子背景 + 玻璃拟态美观，但对长时间写作或低配用户可能是轻微噪音。
- Google Fonts import 在国内仍可能有首屏加载影响。
- 设置页 4 个 provider 卡片在窄右栏下描述文字较长，视觉拥挤。
- 没有全局帮助/快捷键 cheat-sheet（已添加：header 中显示 “⌨️ Ctrl/⌘+Enter 发送 | Ctrl/⌘+S 保存” 提示）。
- 蓝图面板里 BlueprintForm 自己又包一层 `.nwa-panel`（已修复：移除外层 panel class，避免不必要的嵌套视觉层级）。
- 章节列表和人物列表 hover/选中反馈存在，但没有“最后更新时间”或字数统计等辅助信息。

### 当前建议修复顺序（复审后，已大部分完成）

大部分 NEW- 问题已在本次会话中修复（见顶部“本轮会话已修复 / 缓解”列表，包括 01-10 的核心部分 + 视觉图标等）。

剩余轻微细节可后续迭代：
- 粒子背景可选关闭
- Google Fonts 国内加载优化（用系统字体 fallback 已基本处理）
- 全局快捷键帮助提示（输入框 placeholder 已提及 Ctrl+Enter）
- 章节列表可考虑加 hover 字数等辅助信息

优先级已从“修复阻塞”转向“润色”。

---

*本追加部分由 Grok 4.3 通过完整路径模拟 + 源码审查生成。旧致命渲染问题已解决，当前痛点集中在“新手可玩性”和“创作时不卡手”上。*

*原报告末尾由 Claude Code 生成。*
