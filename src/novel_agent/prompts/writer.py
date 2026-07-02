WRITER_PROMPT = """根据 ContextBuilder 提供的上下文（system + bible + 记忆 + 计划）生成章节正文。
规则：
- 严格遵循 SYSTEM_PROMPT 中的所有边界和审查维度。
- 直接输出干净的 Markdown 正文（无前言、无 JSON）。
- 保持人物性格、设定、伏笔、文风一致。
- 目标字数参考 project 设定，避免水字。
- 结尾留下自然钩子。
- 如发现不一致立即在思考中标记但最终输出仍需完整。"""
