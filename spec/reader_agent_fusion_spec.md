# SPEC: Source-Parity Reader + Agent Fusion

## Objective

`agentxin` 提供两个顶层模式：Agent 工作台和书架模式。书架模式必须达到 `novel-comic-reader` 的主要阅读功能和视觉结构，再额外支持选中文段交给 Agent 重写、提取世界观、大纲和人物资料。

## Source Of Truth

- Source app: `C:\Users\my147\Desktop\novel-comic-reader`
- Reference files: `index.html`, `src/main.js`, `src/styles.css`, `src/utils/book-parser.js`, `src/utils/epub-parser.js`, `src/utils/comic-parser.js`, `src/utils/app-storage.js`

## Required Reader Features

1. Import and parsing
   - Single file: TXT, MD, Markdown, EPUB, HTML, HTM, JSON, PDF, CBZ, image files.
   - Folder: image folders as comic pages, Markdown folders as ordered text collection.
   - Directory scan should preserve relative paths for search and categorization.

2. Bookshelf
   - Home layout with import/drop zone, continue reading, local stats, shelf grid, recent list.
   - Persist full book payloads in IndexedDB, with localStorage only for lightweight session, recent, bookmark and settings state.
   - Categories: all, current project, text novels, comic/PDF, scanned folders, linked Agent projects, recent.
   - Each item shows title, format, chapter/page count, last-opened time, source path or directory.

3. Reader
   - Text: TOC, bookmarks, current chapter, chapter slider, search and highlight, previous/next chapter, keyboard navigation.
   - Comic: continuous vertical pages, comic width setting.
   - PDF: original browser PDF view.
   - Settings: theme, font size, line height, reader width, comic width, reset.
   - Immersive mode hides chrome and focuses the content.

4. Agent integration
   - Text selections can be rewritten by existing `freeChat.stream`.
   - Applying a rewrite updates imported shelf books or backend project chapters.
   - Extraction writes to existing world settings, outlines and characters APIs.
   - Non-text media keeps reading controls and disables text-only Agent actions.

## Visual Requirements

- Use the source app's paper reading feel: warm background, ink-green accent, readable text column, cover grid, rounded panels and restrained shadows.
- Reader content card width and paragraph rhythm should follow the source app: centered text card, `2em` paragraph indent, high line height.
- The first screen in bookshelf mode must look like a reader application home, not an admin table or drawer.
- Mobile layout stacks without horizontal overflow at 390px width.

## Verification Commands

- Frontend: `npm run typecheck`, `npm test`, `npm run build`
- Backend: `npm run typecheck`, `npm test`, `npm run build`
- Browser: run backend on `3000`, frontend on `5173`, verify bookshelf mode at `http://127.0.0.1:5173/`

## Browser Acceptance

- Open top-level `书架` mode and verify no `[role="dialog"]` or drawer overlay is used.
- Import TXT/MD and open as text reader.
- Import image folder and verify comic continuous pages.
- Open current Agent project as readable book.
- Add bookmark, search text, move chapter slider, change font size/line height, toggle immersive mode.
- Select text, generate rewrite, apply rewrite, verify the content changes.
- Extract world/outline/character and verify API calls succeed.
- Console errors: 0. Console warnings: 0. Horizontal overflow: 0 at desktop and mobile widths.
