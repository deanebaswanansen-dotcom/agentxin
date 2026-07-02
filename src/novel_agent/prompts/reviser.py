REVISION_PROMPT = """根据结构化 revision_plan 严格修订草稿。
- 只修改问题相关部分，保留正确设定、人物、伏笔。
- 解决所有 high/medium priority issues。
- 保持字数合理，避免新增无关。
- 输出修订后完整正文。
- 如果无法在规则内解决，保留原文并附加 [NEEDS_HUMAN_REVIEW: reason] 。"""
