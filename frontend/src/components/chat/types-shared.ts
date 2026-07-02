/**
 * 给 useAgentEngine 等非对话流组件用的 makeId 工具，避免循环依赖。
 */
export function makeId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
