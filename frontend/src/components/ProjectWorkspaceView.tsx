import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { DragDropContext, Droppable, Draggable, type DropResult } from '@hello-pangea/dnd';
import apiClient from '../api/apiClient.js';
import type { Chapter, Character, Id, Outline, WorldSetting } from '../types/index.js';
import { EmptyIllustration } from './EmptyIllustration.js';
import { Icon } from './Icon.js';
import './components.css';

export type WorkspaceClient = Pick<typeof apiClient, 'chapters' | 'settings'>;

export interface ProjectWorkspaceViewProps {
  projectId: Id;
  /** Bump after Agent / external writes so lists reload without re-selecting project. */
  refreshToken?: number;
  selectedChapterId?: Id | null;
  onSelectChapter: (chapterId: Id) => void;
  onChapterDeleted?: (chapterId: Id) => void;
  onError?: (error: unknown) => void;
  client?: WorkspaceClient;

  /** Controlled tab from parent (used for "jump from Agent result artifacts"). If omitted, component manages internally. */
  workspaceTab?: WorkspaceTab;
  onWorkspaceTabChange?: (tab: WorkspaceTab) => void;
}

/** Tabs inside the project workspace (left sidebar). Exported for parent-controlled navigation (e.g. from Agent artifacts). */
export type WorkspaceTab = 'chapters' | 'characters' | 'world' | 'outlines';

type EditableKind = 'character' | 'world' | 'outline';

interface EditDraft {
  kind: EditableKind;
  id: Id;
  title: string;
  body: string;
}

interface DeleteDraft {
  kind: EditableKind;
  id: Id;
  title: string;
}

const TAB_LABELS: Record<WorkspaceTab, string> = {
  chapters: '章节',
  characters: '人物',
  world: '世界观',
  outlines: '大纲',
};

interface OutlineTreeItem {
  id: string;
  level: number;
  label: string;
}

interface CharacterAttributeRow {
  id: Id;
  name: string;
  values: Record<string, string>;
}

interface CharacterAttributeView {
  columns: string[];
  rows: CharacterAttributeRow[];
}

interface CharacterRelation {
  id: string;
  pair: string;
  label: string;
}

interface TimelineItem {
  id: string;
  marker: string;
  event: string;
  source: string;
}

function parseOutlineTree(outlines: Outline[]): OutlineTreeItem[] {
  const items: OutlineTreeItem[] = [];
  for (const outline of [...outlines].sort((a, b) => a.position - b.position)) {
    items.push({ id: `${outline.id}-title`, level: 1, label: outline.title });
    outline.content.split(/\r?\n/).forEach((rawLine, index) => {
      const line = rawLine.trim();
      if (line.length === 0) return;
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      const bullet = line.match(/^[-*]\s+(.+)$/);
      const volume = /^(第.+卷|卷[一二三四五六七八九十\d]+)/.test(line);
      const chapter = /^第.+章/.test(line);
      const level = heading
        ? Math.min(4, heading[1].length + 1)
        : volume
          ? 2
          : chapter
            ? 3
            : bullet
              ? 4
              : 3;
      items.push({ id: `${outline.id}-${index}`, level, label: heading?.[2] ?? bullet?.[1] ?? line });
    });
  }
  return items;
}

function parseCharacterAttributeView(characters: Character[]): CharacterAttributeView {
  const columns: string[] = [];
  const markdownAttributeKeys = new Set(['人物定位', '身份', '目标', '动机', '性格特征']);
  const rows = characters.map((character) => {
    const values: Record<string, string> = {};
    character.description.split(/\r?\n/).forEach((rawLine) => {
      const line = rawLine.trim();
      const markdownMatch = line.match(/^[-*]\s+\*\*([^*]{1,12})\*\*\s*[:：]\s*(.+)$/);
      const plainMatch = line.startsWith('- ') || line.startsWith('* ')
        ? null
        : line.match(/^([^:：#]{1,12})\s*[:：]\s*(.+)$/);
      const match = markdownMatch ?? plainMatch;
      if (!match) return;

      const key = match[1].trim();
      const value = match[2].trim();
      if (key.length === 0 || value.length === 0 || key === '关系') return;
      if (markdownMatch && !markdownAttributeKeys.has(key)) return;

      values[key] = value;
      if (!columns.includes(key)) columns.push(key);
    });

    return { id: character.id, name: character.name, values };
  });

  return { columns, rows };
}

function parseCharacterRelations(characters: Character[]): CharacterRelation[] {
  const relations: CharacterRelation[] = [];
  characters.forEach((character) => {
    character.description.split(/\r?\n/).forEach((rawLine, lineIndex) => {
      const line = rawLine.trim();
      if (!/^关系\s*[:：]/.test(line)) return;

      const body = line.replace(/^关系\s*[:：]\s*/, '');
      body.split(/[;；]/).forEach((segment, segmentIndex) => {
        const match = segment.trim().match(/^(.+?)\s*(?:->|→)\s*(.+?)(?:\s*[:：]\s*(.+))?$/);
        if (!match) return;

        const from = match[1].trim();
        const to = match[2].trim();
        if (from.length === 0 || to.length === 0) return;

        relations.push({
          id: `${character.id}-${lineIndex}-${segmentIndex}`,
          pair: `${from} -> ${to}`,
          label: match[3]?.trim() ?? '关系',
        });
      });
    });
  });
  return relations;
}

function parseTimelineLine(line: string): { marker: string; event: string } | null {
  const clean = line
    .trim()
    .replace(/^[-*]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .trim();
  if (clean.length === 0 || /^时间线\s*[:：]?\s*$/.test(clean)) return null;

  const match = clean.match(/^(第[^:：]{1,16}?[天日年月章节幕卷场]|T\d+|\d{4}年(?:\d{1,2}月(?:\d{1,2}日)?)?)\s*[:：]\s*(.+)$/);
  if (!match) return null;

  const marker = match[1].trim();
  const event = match[2].trim();
  if (marker.length === 0 || event.length === 0) return null;
  return { marker, event };
}

function parseTimelineItems(worldSettings: WorldSetting[], outlines: Outline[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  worldSettings.forEach((setting) => {
    setting.content.split(/\r?\n/).forEach((line, index) => {
      const item = parseTimelineLine(line);
      if (!item) return;
      items.push({ id: `world-${setting.id}-${index}`, source: setting.title, ...item });
    });
  });

  [...outlines].sort((a, b) => a.position - b.position).forEach((outline) => {
    outline.content.split(/\r?\n/).forEach((line, index) => {
      const item = parseTimelineLine(line);
      if (!item) return;
      items.push({ id: `outline-${outline.id}-${index}`, source: outline.title, ...item });
    });
  });
  return items;
}

/** 简单字数统计（中英文混合），用于章节列表增强（NEW 建议 + 章节辅助信息） */
function countWordsForList(content: string): number {
  const cjkCount = content.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const latinCount = content
    .replace(/[\u3400-\u9fff]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  return cjkCount + latinCount;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function WorkspaceEmpty({ children }: { children: string }): JSX.Element {
  return (
    <div className="nwa-empty-visual">
      <EmptyIllustration variant="collection" className="nwa-empty-illustration--sm" />
      <p className="nwa-empty">{children}</p>
    </div>
  );
}

export function ProjectWorkspaceView({
  projectId,
  refreshToken = 0,
  selectedChapterId,
  onSelectChapter,
  onChapterDeleted,
  onError,
  client = apiClient,
  workspaceTab: controlledWorkspaceTab,
  onWorkspaceTabChange,
}: ProjectWorkspaceViewProps): JSX.Element {
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [worldSettings, setWorldSettings] = useState<WorldSetting[]>([]);
  const [outlines, setOutlines] = useState<Outline[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [deleteDraft, setDeleteDraft] = useState<DeleteDraft | null>(null);

  // Internal state for uncontrolled mode (when parent does not control the tab)
  const [internalActiveTab, setInternalActiveTab] = useState<WorkspaceTab>('chapters');

  // Support controlled tab from parent (NEW-07: jump from Agent artifact chips)
  const activeTab = controlledWorkspaceTab ?? internalActiveTab;
  const setActiveTab = useCallback((tab: WorkspaceTab) => {
    if (onWorkspaceTabChange) {
      onWorkspaceTabChange(tab);
    } else {
      setInternalActiveTab(tab);
    }
  }, [onWorkspaceTabChange]);

  const [chapterTitle, setChapterTitle] = useState('');
  const [characterName, setCharacterName] = useState('');
  const [characterDesc, setCharacterDesc] = useState('');
  const [worldTitle, setWorldTitle] = useState('');
  const [worldContent, setWorldContent] = useState('');
  const [outlineTitle, setOutlineTitle] = useState('');
  const [outlineContent, setOutlineContent] = useState('');
  const outlineTree = parseOutlineTree(outlines);
  const characterAttributeView = parseCharacterAttributeView(characters);
  const characterRelations = parseCharacterRelations(characters);
  const timelineItems = parseTimelineItems(worldSettings, outlines);

  // Chapter management states (NEW-06)
  const [renameChapterTarget, setRenameChapterTarget] = useState<Chapter | null>(null);
  const [renameChapterInput, setRenameChapterInput] = useState('');
  const [deleteChapterTarget, setDeleteChapterTarget] = useState<Chapter | null>(null);

  const handleError = useCallback(
    (error: unknown) => {
      if (isAbort(error)) return;
      onError?.(error);
    },
    [onError],
  );

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const [ch, chars, worlds, outs] = await Promise.all([
          client.chapters.list(projectId, signal),
          client.settings.characters.list(projectId, signal),
          client.settings.worldSettings.list(projectId, signal),
          client.settings.outlines.list(projectId, signal),
        ]);
        setChapters(ch);
        setCharacters(chars);
        setWorldSettings(worlds);
        setOutlines(outs);
      } catch (error) {
        handleError(error);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [client, projectId, handleError],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh, refreshToken]);

  const runLocalMutation = useCallback(
    async <T,>(op: () => Promise<T>, apply: (value: T) => void, reset: () => void) => {
      if (busy) return;
      setBusy(true);
      try {
        const value = await op();
        apply(value);
        reset();
      } catch (error) {
        handleError(error);
      } finally {
        setBusy(false);
      }
    },
    [busy, handleError],
  );

  const handleCreateChapter = useCallback(() => {
    const title = chapterTitle.trim();
    if (title.length === 0) return;
    void runLocalMutation(
      () => client.chapters.create(projectId, title),
      ({ id }) => {
        setChapters((current) => [
          ...current,
          {
            id,
            projectId,
            title,
            content: '',
            position: current.length,
          },
        ]);
      },
      () => setChapterTitle(''),
    );
  }, [chapterTitle, client, projectId, runLocalMutation]);

  const handleDragEnd = useCallback(async (result: DropResult) => {
    if (!result.destination) return;
    const sourceIndex = result.source.index;
    const destinationIndex = result.destination.index;
    if (sourceIndex === destinationIndex) return;

    // Optimistic UI update
    const newChapters = Array.from(chapters);
    const [moved] = newChapters.splice(sourceIndex, 1);
    newChapters.splice(destinationIndex, 0, moved);
    setChapters(newChapters);

    setBusy(true);
    try {
      const orderedIds = newChapters.map(c => c.id);
      await client.chapters.reorder(projectId, orderedIds);
    } catch (error) {
      handleError(error);
      await refresh(); // Revert on failure
    } finally {
      setBusy(false);
    }
  }, [chapters, projectId, client, handleError, refresh]);

  const handleCreateCharacter = useCallback(() => {
    const name = characterName.trim();
    if (name.length === 0) return;
    void runLocalMutation(
      () => client.settings.characters.create(projectId, { name, description: characterDesc }),
      (created) => setCharacters((current) => [...current, created]),
      () => {
        setCharacterName('');
        setCharacterDesc('');
      },
    );
  }, [characterName, characterDesc, client, projectId, runLocalMutation]);

  const handleCreateWorld = useCallback(() => {
    const title = worldTitle.trim();
    if (title.length === 0) return;
    void runLocalMutation(
      () => client.settings.worldSettings.create(projectId, { title, content: worldContent }),
      (created) => setWorldSettings((current) => [...current, created]),
      () => {
        setWorldTitle('');
        setWorldContent('');
      },
    );
  }, [worldTitle, worldContent, client, projectId, runLocalMutation]);

  const handleCreateOutline = useCallback(() => {
    const title = outlineTitle.trim();
    if (title.length === 0) return;
    void runLocalMutation(
      () => client.settings.outlines.create(projectId, { title, content: outlineContent }),
      (created) => setOutlines((current) => [...current, created]),
      () => {
        setOutlineTitle('');
        setOutlineContent('');
      },
    );
  }, [outlineTitle, outlineContent, client, projectId, runLocalMutation]);

  // Chapter rename/delete (NEW-06)
  const startRenameChapter = useCallback((chapter: Chapter) => {
    setRenameChapterTarget(chapter);
    setRenameChapterInput(chapter.title);
  }, []);

  const doRenameChapter = useCallback(async () => {
    if (!renameChapterTarget) return;
    const title = renameChapterInput.trim();
    if (title.length === 0 || title === renameChapterTarget.title) {
      setRenameChapterTarget(null);
      return;
    }
    setBusy(true);
    try {
      const updated = await client.chapters.rename(renameChapterTarget.id, title);
      setChapters((current) => current.map((chapter) => (chapter.id === updated.id ? updated : chapter)));
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
      setRenameChapterTarget(null);
    }
  }, [renameChapterTarget, renameChapterInput, client, handleError]);

  const handleDeleteChapter = useCallback((chapter: Chapter) => {
    setDeleteChapterTarget(chapter);
  }, []);

  const doDeleteChapter = useCallback(async () => {
    if (!deleteChapterTarget) return;
    setBusy(true);
    try {
      await client.chapters.remove(deleteChapterTarget.id);
      setChapters((current) => current.filter((chapter) => chapter.id !== deleteChapterTarget.id));
      if (deleteChapterTarget.id === selectedChapterId) {
        onChapterDeleted?.(deleteChapterTarget.id);
      }
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
      setDeleteChapterTarget(null);
    }
  }, [deleteChapterTarget, selectedChapterId, client, handleError, onChapterDeleted]);

  const startEditCharacter = useCallback((item: Character) => {
    setEditDraft({ kind: 'character', id: item.id, title: item.name, body: item.description });
  }, []);

  const startEditWorld = useCallback((item: WorldSetting) => {
    setEditDraft({ kind: 'world', id: item.id, title: item.title, body: item.content });
  }, []);

  const startEditOutline = useCallback((item: Outline) => {
    setEditDraft({ kind: 'outline', id: item.id, title: item.title, body: item.content });
  }, []);

  const handleSaveEdit = useCallback(() => {
    if (editDraft === null || editDraft.title.trim().length === 0) return;
    const { id, kind, title, body } = editDraft;
    const op = (): Promise<Character | WorldSetting | Outline> => {
      if (kind === 'character') {
        return client.settings.characters.update(id, { name: title.trim(), description: body });
      }
      if (kind === 'world') {
        return client.settings.worldSettings.update(id, { title: title.trim(), content: body });
      }
      return client.settings.outlines.update(id, { title: title.trim(), content: body });
    };
    void runLocalMutation(
      op,
      (updated) => {
        if (kind === 'character') {
          setCharacters((current) => current.map((item) => (item.id === id ? updated as Character : item)));
        } else if (kind === 'world') {
          setWorldSettings((current) => current.map((item) => (item.id === id ? updated as WorldSetting : item)));
        } else {
          setOutlines((current) => current.map((item) => (item.id === id ? updated as Outline : item)));
        }
      },
      () => setEditDraft(null),
    );
  }, [client, editDraft, runLocalMutation]);

  const requestDelete = useCallback((kind: EditableKind, id: Id, title: string) => {
    setDeleteDraft({ kind, id, title });
  }, []);

  const doDeleteDraft = useCallback(
    () => {
      if (deleteDraft === null) return;
      const { kind, id } = deleteDraft;
      const op = () => {
        if (kind === 'character') return client.settings.characters.remove(id);
        if (kind === 'world') return client.settings.worldSettings.remove(id);
        return client.settings.outlines.remove(id);
      };
      void runLocalMutation(
        op,
        () => {
        if (kind === 'character') {
          setCharacters((current) => current.filter((item) => item.id !== id));
        } else if (kind === 'world') {
          setWorldSettings((current) => current.filter((item) => item.id !== id));
        } else {
          setOutlines((current) => current.filter((item) => item.id !== id));
        }
        },
        () => {
        setEditDraft((current) => (current?.id === id ? null : current));
        setDeleteDraft(null);
        },
      );
    },
    [client, deleteDraft, runLocalMutation],
  );

  const editModal = editDraft ? (
    <div className="nwa-modal-overlay">
      <div className="nwa-modal" role="dialog" aria-label="编辑资料" aria-modal="true">
        <div className="nwa-modal-header">
          <h2>编辑{editDraft.kind === 'character' ? '人物' : editDraft.kind === 'world' ? '世界观' : '大纲'}</h2>
          <button type="button" className="nwa-modal-close" onClick={() => setEditDraft(null)} aria-label="关闭编辑资料">
            <Icon name="x" />
          </button>
        </div>
        <div className="nwa-modal-body">
          <input
            className="nwa-input"
            aria-label="编辑标题"
            placeholder="名称/标题"
            value={editDraft.title}
            disabled={busy}
            onChange={(event) => setEditDraft({ ...editDraft, title: event.target.value })}
          />
          <textarea
            className="nwa-textarea nwa-grow"
            aria-label="编辑内容"
            placeholder="详细内容..."
            value={editDraft.body}
            disabled={busy}
            onChange={(event) => setEditDraft({ ...editDraft, body: event.target.value })}
            rows={10}
          />
        </div>
        <div className="nwa-modal-footer">
          <button
            type="button"
            className="nwa-button nwa-button--ghost"
            disabled={busy}
            onClick={() => setEditDraft(null)}
          >
            取消
          </button>
          <button
            type="button"
            className="nwa-button"
            disabled={busy || editDraft.title.trim().length === 0}
            onClick={handleSaveEdit}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  ) : null;

  const portalModal = editModal ? createPortal(editModal, document.body) : null;

  const deleteDraftModal = deleteDraft ? (
    <div className="nwa-modal-overlay">
      <div className="nwa-modal" role="dialog" aria-label="删除资料确认" aria-modal="true">
        <div className="nwa-modal-header">
          <h2>
            删除
            {deleteDraft.kind === 'character' ? '人物' : deleteDraft.kind === 'world' ? '世界观' : '大纲'}
          </h2>
          <button type="button" className="nwa-modal-close" onClick={() => setDeleteDraft(null)} aria-label="关闭删除资料确认">
            <Icon name="x" />
          </button>
        </div>
        <div className="nwa-modal-body">
          <p>确定要删除「{deleteDraft.title}」吗？此操作不可撤销。</p>
        </div>
        <div className="nwa-modal-footer">
          <button
            type="button"
            className="nwa-button nwa-button--ghost"
            disabled={busy}
            onClick={() => setDeleteDraft(null)}
          >
            取消
          </button>
          <button
            type="button"
            className="nwa-button nwa-button--danger"
            disabled={busy}
            onClick={doDeleteDraft}
          >
            确认删除
          </button>
        </div>
      </div>
    </div>
  ) : null;

  // Chapter rename modal (title only)
  const renameChapterModal = renameChapterTarget ? (
    <div className="nwa-modal-overlay">
      <div className="nwa-modal" role="dialog" aria-label="重命名章节" aria-modal="true">
        <div className="nwa-modal-header">
          <h2>重命名章节</h2>
          <button type="button" className="nwa-modal-close" onClick={() => setRenameChapterTarget(null)} aria-label="关闭重命名章节">
            <Icon name="x" />
          </button>
        </div>
        <div className="nwa-modal-body">
          <input
            className="nwa-input"
            value={renameChapterInput}
            onChange={(e) => setRenameChapterInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doRenameChapter();
            }}
            autoFocus
          />
        </div>
        <div className="nwa-modal-footer">
          <button
            type="button"
            className="nwa-button nwa-button--ghost"
            disabled={busy}
            onClick={() => setRenameChapterTarget(null)}
          >
            取消
          </button>
          <button
            type="button"
            className="nwa-button"
            disabled={busy || !renameChapterInput.trim()}
            onClick={() => void doRenameChapter()}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  ) : null;

  // Chapter delete confirm modal
  const deleteChapterModal = deleteChapterTarget ? (
    <div className="nwa-modal-overlay">
      <div className="nwa-modal" role="dialog" aria-label="删除章节确认" aria-modal="true">
        <div className="nwa-modal-header">
          <h2>删除章节</h2>
          <button type="button" className="nwa-modal-close" onClick={() => setDeleteChapterTarget(null)} aria-label="关闭删除章节确认">
            <Icon name="x" />
          </button>
        </div>
        <div className="nwa-modal-body">
          <p>
            确定要删除章节「{deleteChapterTarget.title}」吗？此操作不可撤销，相关蓝图、场景草稿和报告也将一并删除。
          </p>
        </div>
        <div className="nwa-modal-footer">
          <button
            type="button"
            className="nwa-button nwa-button--ghost"
            disabled={busy}
            onClick={() => setDeleteChapterTarget(null)}
          >
            取消
          </button>
          <button
            type="button"
            className="nwa-button nwa-button--danger"
            disabled={busy}
            onClick={() => void doDeleteChapter()}
          >
            确认删除
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <section className="nwa-workspace-panel" aria-label="项目工作台">
      <div className="nwa-workspace-panel__head">
        <div>
          <h2 className="nwa-panel__title">项目资料</h2>
          {loading && <p className="nwa-muted">加载中…</p>}
        </div>
        <div className="nwa-workspace-panel__stats" aria-label="项目统计">
          <span>{chapters.length} 章</span>
          <span>{characters.length} 人物</span>
          <span>{worldSettings.length} 设定</span>
          <span>{outlines.length} 大纲</span>
        </div>
      </div>

      <div className="nwa-workspace-tabs" role="tablist" aria-label="项目资料分类">
        {(['chapters', 'characters', 'world', 'outlines'] as const).map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={activeTab === item}
            className={`nwa-workspace-tab${activeTab === item ? ' nwa-workspace-tab--active' : ''}`}
            onClick={() => setActiveTab(item)}
          >
            {TAB_LABELS[item]}
          </button>
        ))}
      </div>

      {activeTab === 'chapters' ? (
        <div className="nwa-workspace-pane" aria-label="章节列表">
          <h2 className="nwa-panel__title">章节</h2>
          <div className="nwa-row">
            <input
              className="nwa-input nwa-grow"
              type="text"
              placeholder="新章节标题"
              aria-label="新章节标题"
              value={chapterTitle}
              disabled={busy}
              onChange={(e) => setChapterTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateChapter();
              }}
            />
            <button
              type="button"
              className="nwa-button"
              disabled={busy || chapterTitle.trim().length === 0}
              onClick={handleCreateChapter}
            >
              新建章节
            </button>
          </div>
          {chapters.length === 0 ? (
            <WorkspaceEmpty>还没有章节。</WorkspaceEmpty>
          ) : (
            <DragDropContext onDragEnd={handleDragEnd}>
              <Droppable droppableId="chapters-list">
                {(provided) => (
                  <ul className="nwa-list" {...provided.droppableProps} ref={provided.innerRef}>
                    {chapters.map((chapter, index) => {
                      const selected = chapter.id === selectedChapterId;
                      return (
                        <Draggable key={chapter.id} draggableId={chapter.id} index={index}>
                          {(provided, snapshot) => (
                            <li
                              ref={provided.innerRef}
                              {...provided.draggableProps}
                              {...provided.dragHandleProps}
                              className={`nwa-list__item${selected ? ' nwa-list__item--selected' : ''}${snapshot.isDragging ? ' nwa-list__item--dragging' : ''}`}
                              style={provided.draggableProps.style}
                              title="拖拽排序，或点击在中间编辑器中打开"
                            >
                              <span className="nwa-drag-handle" style={{ marginRight: '8px', opacity: 0.5 }}>⋮⋮</span>
                              <button
                                type="button"
                                className="nwa-list__button"
                                aria-pressed={selected}
                                onClick={() => onSelectChapter(chapter.id)}
                              >
                                {chapter.title}
                              </button>
                              <span className="nwa-muted" style={{ fontSize: '0.75rem', marginLeft: '0.5rem' }}>
                                {countWordsForList(chapter.content).toLocaleString()} 字
                              </span>
                              <span className="nwa-list__actions">
                                <button
                                  type="button"
                                  className="nwa-button nwa-button--ghost"
                                  disabled={busy}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    startRenameChapter(chapter);
                                  }}
                                  title="重命名章节"
                                >
                                  重命名
                                </button>
                                <button
                                  type="button"
                                  className="nwa-button nwa-button--danger"
                                  disabled={busy}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDeleteChapter(chapter);
                                  }}
                                  title="删除章节"
                                >
                                  删除
                                </button>
                              </span>
                            </li>
                          )}
                        </Draggable>
                      );
                    })}
                    {provided.placeholder}
                  </ul>
                )}
              </Droppable>
            </DragDropContext>
          )}
        </div>
      ) : null}

      {activeTab === 'characters' ? (
        <div className="nwa-workspace-pane" aria-label="人物设定">
          <h2 className="nwa-panel__title">人物</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <input
              className="nwa-input"
              type="text"
              placeholder="人物姓名"
              aria-label="人物姓名"
              value={characterName}
              disabled={busy}
              onChange={(e) => setCharacterName(e.target.value)}
            />
            <textarea
              className="nwa-textarea"
              placeholder="人物描述（可选）"
              aria-label="人物描述"
              value={characterDesc}
              disabled={busy}
              onChange={(e) => setCharacterDesc(e.target.value)}
              rows={3}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="nwa-button"
                disabled={busy || characterName.trim().length === 0}
                onClick={handleCreateCharacter}
              >
                添加人物
              </button>
            </div>
          </div>
          {characters.length === 0 ? (
            <WorkspaceEmpty>还没有人物设定。</WorkspaceEmpty>
          ) : (
            <>
              {characterAttributeView.columns.length > 0 || characterRelations.length > 0 ? (
                <div className="nwa-character-summary">
                  {characterAttributeView.columns.length > 0 ? (
                    <div className="nwa-character-table-wrap">
                      <table className="nwa-character-table" aria-label="角色属性表">
                        <thead>
                          <tr>
                            <th scope="col">人物</th>
                            {characterAttributeView.columns.map((column) => (
                              <th key={column} scope="col">{column}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {characterAttributeView.rows.map((row) => (
                            <tr key={row.id}>
                              <th scope="row">{row.name}</th>
                              {characterAttributeView.columns.map((column) => (
                                <td key={column}>{row.values[column] ?? '-'}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                  {characterRelations.length > 0 ? (
                    <div className="nwa-relationship-graph" aria-label="人物关系图谱">
                      {characterRelations.map((relation) => (
                        <div key={relation.id} className="nwa-relationship-graph__edge">
                          <span className="nwa-relationship-graph__pair">{relation.pair}</span>
                          <span className="nwa-relationship-graph__label">{relation.label}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <ul className="nwa-list">
                {characters.map((c) => (
                  <li key={c.id} className="nwa-list__item">
                    <span className="nwa-list__content">
                      <strong>{c.name}</strong>
                      {c.description ? <span className="nwa-muted">{c.description}</span> : null}
                    </span>
                    <span className="nwa-list__actions">
                      <button
                        type="button"
                        className="nwa-button nwa-button--ghost"
                        disabled={busy}
                        onClick={() => startEditCharacter(c)}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="nwa-button nwa-button--danger"
                        disabled={busy}
                        onClick={() => requestDelete('character', c.id, c.name)}
                      >
                        删除
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : null}

      {activeTab === 'world' ? (
        <div className="nwa-workspace-pane" aria-label="世界观设定">
          <h2 className="nwa-panel__title">世界观</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <input
              className="nwa-input"
              type="text"
              placeholder="世界观标题"
              aria-label="世界观标题"
              value={worldTitle}
              disabled={busy}
              onChange={(e) => setWorldTitle(e.target.value)}
            />
            <textarea
              className="nwa-textarea"
              placeholder="世界观内容"
              aria-label="世界观内容"
              value={worldContent}
              disabled={busy}
              onChange={(e) => setWorldContent(e.target.value)}
              rows={3}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="nwa-button"
                disabled={busy || worldTitle.trim().length === 0}
                onClick={handleCreateWorld}
              >
                添加世界观
              </button>
            </div>
          </div>
          {worldSettings.length === 0 ? (
            <WorkspaceEmpty>还没有世界观设定。</WorkspaceEmpty>
          ) : (
            <>
              {timelineItems.length > 0 ? (
                <div className="nwa-timeline" aria-label="故事时间线">
                  {timelineItems.map((item) => (
                    <div key={item.id} className="nwa-timeline__item">
                      <span className="nwa-timeline__marker">{item.marker}</span>
                      <span className="nwa-timeline__event">{item.event}</span>
                      <span className="nwa-timeline__source">{item.source}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              <ul className="nwa-list">
                {worldSettings.map((w) => (
                  <li key={w.id} className="nwa-list__item">
                    <span className="nwa-list__content">
                      <strong>{w.title}</strong>
                      {w.content ? <span className="nwa-muted">{w.content}</span> : null}
                    </span>
                    <span className="nwa-list__actions">
                      <button
                        type="button"
                        className="nwa-button nwa-button--ghost"
                        disabled={busy}
                        onClick={() => startEditWorld(w)}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="nwa-button nwa-button--danger"
                        disabled={busy}
                        onClick={() => requestDelete('world', w.id, w.title)}
                      >
                        删除
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : null}

      {activeTab === 'outlines' ? (
        <div className="nwa-workspace-pane" aria-label="大纲">
          <h2 className="nwa-panel__title">大纲</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <input
              className="nwa-input"
              type="text"
              placeholder="大纲标题"
              aria-label="大纲标题"
              value={outlineTitle}
              disabled={busy}
              onChange={(e) => setOutlineTitle(e.target.value)}
            />
            <textarea
              className="nwa-textarea"
              placeholder="大纲内容"
              aria-label="大纲内容"
              value={outlineContent}
              disabled={busy}
              onChange={(e) => setOutlineContent(e.target.value)}
              rows={3}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="nwa-button"
                disabled={busy || outlineTitle.trim().length === 0}
                onClick={handleCreateOutline}
              >
                添加大纲
              </button>
            </div>
          </div>
          {outlines.length === 0 ? (
            <WorkspaceEmpty>还没有大纲。</WorkspaceEmpty>
          ) : (
            <>
              <div className="nwa-outline-tree" aria-label="大纲层级树">
                {outlineTree.map((item) => (
                  <div
                    key={item.id}
                    className={`nwa-outline-tree__item nwa-outline-tree__item--l${item.level}`}
                  >
                    {item.label}
                  </div>
                ))}
              </div>
              <ul className="nwa-list">
                {outlines.map((o) => (
                  <li key={o.id} className="nwa-list__item">
                    <span className="nwa-list__content">
                      <strong>{o.title}</strong>
                      {o.content ? <span className="nwa-muted">{o.content}</span> : null}
                    </span>
                    <span className="nwa-list__actions">
                      <button
                        type="button"
                        className="nwa-button nwa-button--ghost"
                        disabled={busy}
                        onClick={() => startEditOutline(o)}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="nwa-button nwa-button--danger"
                        disabled={busy}
                        onClick={() => requestDelete('outline', o.id, o.title)}
                      >
                        删除
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : null}

      {renameChapterModal && createPortal(renameChapterModal, document.body)}
      {deleteChapterModal && createPortal(deleteChapterModal, document.body)}
      {deleteDraftModal && createPortal(deleteDraftModal, document.body)}
      {portalModal}
    </section>
  );
}

export default ProjectWorkspaceView;
