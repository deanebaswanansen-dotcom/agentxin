/**
 * 斜杠命令菜单 —— 输入框首字符为 / 时弹出，列出所有 Agent 任务。
 *
 * 设计：
 *  - 输入 `/` 触发显示，列出 AGENT_TASKS（图标 + 标题 + 描述）
 *  - 支持输入过滤（/新 → 过滤出"新书"）
 *  - 键盘：↑↓ 选择，Enter 确认，Esc 关闭
 *  - 选中后调用 onSelectTask，由父组件（ChatWorkspace）接管：清空输入、设 placeholder、准备执行
 *  - Mock 演示模式作为菜单顶部独立项
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon.js';
import { AGENT_TASKS, type AgentTaskDef } from './chat/agentTasks.js';

export interface SlashMenuProps {
  /** 当前输入框文本（用于判断是否应该显示菜单）。 */
  query: string;
  /** 当前是否选中了项目（用于禁用 needsProject 任务）。 */
  hasProject: boolean;
  /** 当前是否选中了章节（用于禁用 needsChapter 任务）。 */
  hasChapter?: boolean;
  /** 选中任务时触发。 */
  onSelectTask: (task: AgentTaskDef) => void;
  /** 选择 Mock 演示模式。 */
  onSelectMock: () => void;
  /** Mock is a developer-only test provider and is hidden in production. */
  showMock?: boolean;
  /** 关闭菜单（Esc 或失焦）。 */
  onClose: () => void;
}

export function SlashMenu({
  query,
  hasProject,
  hasChapter = false,
  onSelectTask,
  onSelectMock,
  showMock = false,
  onClose,
}: SlashMenuProps): JSX.Element | null {
  // query 形如 "/新书" 或 "/新"；提取过滤词
  const filterText = query.startsWith('/') ? query.slice(1).trim().toLowerCase() : '';
  const mockMatches = showMock &&
    filterText.length === 0 ||
    'mock'.includes(filterText) ||
    '演示模式'.includes(filterText);

  const filteredTasks = useMemo(() => {
    if (filterText.length === 0) return AGENT_TASKS;
    const exact = AGENT_TASKS.find((task) => task.slash.toLowerCase() === filterText);
    if (exact) return [exact];
    return AGENT_TASKS.filter(
      (t) =>
        t.title.toLowerCase().includes(filterText) ||
        t.slash.toLowerCase().includes(filterText) ||
        t.desc.toLowerCase().includes(filterText),
    );
  }, [filterText]);

  // 菜单项列表：顶部 Mock + 任务列表
  type MenuItem =
    | { type: 'mock' }
    | { type: 'task'; def: AgentTaskDef; disabled: boolean };
  const items: MenuItem[] = useMemo(() => {
    const result: MenuItem[] = mockMatches ? [{ type: 'mock' }] : [];
    for (const def of filteredTasks) {
      const disabled =
        (def.needsProject === true && !hasProject) ||
        (def.needsChapter === true && !hasChapter);
      result.push({ type: 'task', def, disabled });
    }
    return result;
  }, [filteredTasks, hasProject, hasChapter, mockMatches]);

  const [activeIndex, setActiveIndex] = useState(0);

  // query 变化时重置选中
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const listRef = useRef<HTMLDivElement | null>(null);

  // 键盘导航由父组件的输入框 onKeyDown 调用本组件暴露的方法；
  // 这里通过全局监听 Escape 关闭
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => Math.min(items.length - 1, i + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const item = items[activeIndex];
        if (!item) return;
        if (item.type === 'mock') {
          onSelectMock();
        } else if (!item.disabled) {
          onSelectTask(item.def);
        }
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [items, activeIndex, onSelectTask, onSelectMock, onClose]);

  if (items.length === 1 && filterText.length > 0) {
    // 只剩 Mock 项且用户在过滤，说明没匹配任务，仍显示（让用户知道）
  }

  return (
    <div className="nwa-slash-menu" ref={listRef} role="listbox" aria-label="斜杠命令">
      {items.map((item, index) => {
        if (item.type === 'mock') {
          return (
            <button
              key="mock"
              type="button"
              role="option"
              aria-selected={activeIndex === index}
              className={`nwa-slash-item nwa-slash-item--mock${activeIndex === index ? ' nwa-slash-item--active' : ''}`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => onSelectMock()}
            >
              <span className="nwa-slash-item__icon"><Icon name="gamepad" /></span>
              <span className="nwa-slash-item__body">
                <span className="nwa-slash-item__title">演示模式（无需 Key）</span>
                <span className="nwa-slash-item__desc">切换到 Mock，本地模拟响应，立即体验</span>
              </span>
            </button>
          );
        }
        const { def, disabled } = item;
        return (
          <button
            key={def.key}
            type="button"
            role="option"
            aria-selected={activeIndex === index}
            disabled={disabled}
            className={`nwa-slash-item${activeIndex === index ? ' nwa-slash-item--active' : ''}${disabled ? ' nwa-slash-item--disabled' : ''}`}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => {
              if (!disabled) onSelectTask(def);
            }}
          >
            <span className="nwa-slash-item__icon"><Icon name={def.icon} /></span>
            <span className="nwa-slash-item__body">
              <span className="nwa-slash-item__title">
                /{def.slash} · {def.title}
              </span>
              <span className="nwa-slash-item__desc">
                {disabled
                  ? def.needsChapter === true && !hasChapter
                    ? '需要先选择章节'
                    : '需要先选择项目'
                  : def.desc}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default SlashMenu;
