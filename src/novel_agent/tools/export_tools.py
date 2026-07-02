from novel_agent.providers.base import ToolDescriptor

ExportTool = ToolDescriptor(name="ExportTool", purpose="Export chapters to markdown.", side_effects=["write_file"])
