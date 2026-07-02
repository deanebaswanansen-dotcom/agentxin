import type { SVGProps } from 'react';

export type IconName =
  | 'archive'
  | 'bookOpen'
  | 'brain'
  | 'check'
  | 'chevronRight'
  | 'edit'
  | 'fileText'
  | 'folder'
  | 'folderOpen'
  | 'formatBold'
  | 'formatHeading'
  | 'formatItalic'
  | 'formatList'
  | 'formatQuote'
  | 'gamepad'
  | 'map'
  | 'messageCircle'
  | 'messages'
  | 'panelLeft'
  | 'panelRight'
  | 'penLine'
  | 'puzzle'
  | 'redo'
  | 'refresh'
  | 'search'
  | 'settings'
  | 'sparkles'
  | 'tag'
  | 'trash'
  | 'undo'
  | 'x';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children' | 'viewBox'> {
  name: IconName;
  size?: number | string;
}

const iconPaths: Record<IconName, JSX.Element> = {
  archive: (
    <>
      <path d="M3 5h18v4H3z" />
      <path d="M5 9v10h14V9" />
      <path d="M9 13h6" />
    </>
  ),
  bookOpen: (
    <>
      <path d="M4 5.5A3.5 3.5 0 0 1 7.5 2H20v17H7.5A3.5 3.5 0 0 0 4 22z" />
      <path d="M4 5.5A3.5 3.5 0 0 1 7.5 2H20" />
      <path d="M4 22V5.5" />
      <path d="M12 2v17" />
    </>
  ),
  brain: (
    <>
      <path d="M8 6.5A3 3 0 0 1 13 4a3.3 3.3 0 0 1 5 2.8 3 3 0 0 1 1 5.7 3.2 3.2 0 0 1-3.2 4.5H14v2a2 2 0 0 1-4 0v-2H8.2A3.2 3.2 0 0 1 5 12.5a3 3 0 0 1 3-6z" />
      <path d="M12 4v15" />
      <path d="M8 9h3" />
      <path d="M13 9h3" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  chevronRight: <path d="m9 18 6-6-6-6" />,
  edit: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z" />
    </>
  ),
  fileText: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M8 13h8" />
      <path d="M8 17h6" />
    </>
  ),
  folder: (
    <>
      <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2h6.5A2.5 2.5 0 0 1 21 8.5V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M3 10h18" />
    </>
  ),
  folderOpen: (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h5a2 2 0 0 1 2 2v1" />
      <path d="M3.5 10h17l-2 9H5.5z" />
    </>
  ),
  formatBold: (
    <>
      <path d="M7 4h6a4 4 0 0 1 0 8H7z" />
      <path d="M7 12h7a4 4 0 0 1 0 8H7z" />
      <path d="M7 4v16" />
    </>
  ),
  formatHeading: (
    <>
      <path d="M5 4v16" />
      <path d="M19 4v16" />
      <path d="M5 12h14" />
    </>
  ),
  formatItalic: (
    <>
      <path d="M10 4h8" />
      <path d="M6 20h8" />
      <path d="m14 4-4 16" />
    </>
  ),
  formatList: (
    <>
      <path d="M8 6h13" />
      <path d="M8 12h13" />
      <path d="M8 18h13" />
      <path d="M3 6h.01" />
      <path d="M3 12h.01" />
      <path d="M3 18h.01" />
    </>
  ),
  formatQuote: (
    <>
      <path d="M8 8H5a3 3 0 0 0-3 3v5h6z" />
      <path d="M20 8h-3a3 3 0 0 0-3 3v5h6z" />
    </>
  ),
  gamepad: (
    <>
      <path d="M6 11h12a4 4 0 0 1 3.7 5.5l-.5 1.2a2.3 2.3 0 0 1-3.8.7L15 16H9l-2.4 2.4a2.3 2.3 0 0 1-3.8-.7l-.5-1.2A4 4 0 0 1 6 11z" />
      <path d="M7 14h4" />
      <path d="M9 12v4" />
      <path d="M16.5 14h.01" />
      <path d="M18.5 16h.01" />
    </>
  ),
  map: (
    <>
      <path d="m9 18-6 3V6l6-3 6 3 6-3v15l-6 3z" />
      <path d="M9 3v15" />
      <path d="M15 6v15" />
    </>
  ),
  messageCircle: (
    <>
      <path d="M21 11.5a8.5 8.5 0 0 1-12.6 7.4L3 20l1.1-5.1A8.5 8.5 0 1 1 21 11.5z" />
      <path d="M8 10h8" />
      <path d="M8 14h5" />
    </>
  ),
  messages: (
    <>
      <path d="M21 12a7 7 0 0 1-7 7H8l-5 3 1.5-5A7 7 0 1 1 21 12z" />
      <path d="M8 10h8" />
      <path d="M8 14h5" />
    </>
  ),
  panelLeft: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </>
  ),
  panelRight: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </>
  ),
  penLine: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z" />
    </>
  ),
  puzzle: (
    <>
      <path d="M8 3h4v4a2 2 0 1 0 4 0V3h3v6h-4a2 2 0 1 0 0 4h4v8h-6v-4a2 2 0 1 0-4 0v4H3v-6h4a2 2 0 1 0 0-4H3V7h5z" />
    </>
  ),
  redo: (
    <>
      <path d="m17 2 4 4-4 4" />
      <path d="M3 12a6 6 0 0 1 6-6h12" />
    </>
  ),
  refresh: (
    <>
      <path d="M21 12a9 9 0 0 1-15.4 6.4" />
      <path d="M3 12A9 9 0 0 1 18.4 5.6" />
      <path d="M18 2v4h4" />
      <path d="M6 22v-4H2" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  settings: (
    <>
      <path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5z" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.3a2 2 0 1 1-4 0V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1A2 2 0 1 1 4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H2.7a2 2 0 1 1 0-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1A2 2 0 1 1 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6v-.3a2 2 0 1 1 4 0V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 1 1 19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.3a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.6 1z" />
    </>
  ),
  sparkles: (
    <>
      <path d="m12 3 1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7z" />
      <path d="m5 14 .9 2.1L8 17l-2.1.9L5 20l-.9-2.1L2 17l2.1-.9z" />
      <path d="m19 14 .7 1.6 1.6.7-1.6.7L19 19l-.7-1.6-1.6-.7 1.6-.7z" />
    </>
  ),
  tag: (
    <>
      <path d="M20.5 13.5 13.5 20a2 2 0 0 1-2.8 0L3 12.3V3h9.3l8.2 7.7a2 2 0 0 1 0 2.8z" />
      <path d="M7.5 7.5h.01" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6l-1 15H6L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </>
  ),
  undo: (
    <>
      <path d="M7 7 3 11l4 4" />
      <path d="M21 17a6 6 0 0 0-6-6H3" />
    </>
  ),
  x: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
};

export function Icon({ name, size = '1em', className, ...props }: IconProps): JSX.Element {
  const classes = className ? `nwa-icon ${className}` : 'nwa-icon';
  return (
    <svg
      className={classes}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {iconPaths[name]}
    </svg>
  );
}

export default Icon;
