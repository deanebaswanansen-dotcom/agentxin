import { useId } from 'react';
import './components.css';

export type EmptyIllustrationVariant =
  | 'chat'
  | 'project'
  | 'editor'
  | 'blueprint'
  | 'reader'
  | 'collection';

export interface EmptyIllustrationProps {
  variant: EmptyIllustrationVariant;
  className?: string;
}

const ACCENT: Record<EmptyIllustrationVariant, string> = {
  chat: '#0f766e',
  project: '#8b3f1d',
  editor: '#7c3aed',
  blueprint: '#2563eb',
  reader: '#b45309',
  collection: '#047857',
};

function VariantGlyph({ variant, accent }: { variant: EmptyIllustrationVariant; accent: string }): JSX.Element {
  if (variant === 'chat') {
    return (
      <>
        <path d="M82 73h72c13 0 23 10 23 23v32c0 13-10 23-23 23h-40l-30 22 8-22H82c-13 0-23-10-23-23V96c0-13 10-23 23-23z" fill="#fffaf0" stroke={accent} strokeWidth="5" />
        <path d="M91 103h54M91 124h38" stroke={accent} strokeWidth="7" strokeLinecap="round" opacity="0.62" />
      </>
    );
  }
  if (variant === 'project') {
    return (
      <>
        <path d="M56 88c0-12 10-22 22-22h36l14 14h50c12 0 22 10 22 22v62c0 10-8 18-18 18H74c-10 0-18-8-18-18z" fill="#fffaf0" stroke={accent} strokeWidth="5" />
        <path d="M56 108h144" stroke={accent} strokeWidth="5" opacity="0.45" />
        <path d="M86 137h78M86 157h48" stroke={accent} strokeWidth="7" strokeLinecap="round" opacity="0.56" />
      </>
    );
  }
  if (variant === 'editor') {
    return (
      <>
        <path d="M80 55h82l36 36v102H80z" fill="#fffaf0" stroke={accent} strokeWidth="5" strokeLinejoin="round" />
        <path d="M162 55v38h36" fill="none" stroke={accent} strokeWidth="5" strokeLinejoin="round" opacity="0.72" />
        <path d="M103 120h70M103 142h56M103 164h75" stroke={accent} strokeWidth="7" strokeLinecap="round" opacity="0.56" />
      </>
    );
  }
  if (variant === 'blueprint') {
    return (
      <>
        <path d="M64 59h140v132H64z" fill="#fffaf0" stroke={accent} strokeWidth="5" />
        <path d="M88 88h92v76H88z" fill="none" stroke={accent} strokeWidth="4" opacity="0.55" />
        <path d="M88 114h92M118 88v76" stroke={accent} strokeWidth="4" opacity="0.42" />
        <path d="M150 126l31-27M95 153l38-31 25 16" stroke={accent} strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" opacity="0.7" />
      </>
    );
  }
  if (variant === 'reader') {
    return (
      <>
        <path d="M54 76c24-14 50-14 78 0v103c-28-14-54-14-78 0z" fill="#fffaf0" stroke={accent} strokeWidth="5" strokeLinejoin="round" />
        <path d="M132 76c28-14 54-14 78 0v103c-24-14-50-14-78 0z" fill="#fffaf0" stroke={accent} strokeWidth="5" strokeLinejoin="round" />
        <path d="M81 106h29M81 130h34M154 106h29M154 130h26" stroke={accent} strokeWidth="6" strokeLinecap="round" opacity="0.5" />
      </>
    );
  }
  return (
    <>
      <path d="M67 79h126v91H67z" fill="#fffaf0" stroke={accent} strokeWidth="5" />
      <path d="M87 61h86v38H87z" fill="#fff4df" stroke={accent} strokeWidth="5" />
      <path d="M94 121h72M94 144h44" stroke={accent} strokeWidth="7" strokeLinecap="round" opacity="0.55" />
      <circle cx="184" cy="87" r="18" fill={accent} opacity="0.18" />
      <path d="m184 77 4 8 9 2-7 6 2 9-8-4-8 4 2-9-7-6 9-2z" fill={accent} opacity="0.78" />
    </>
  );
}

export function EmptyIllustration({ variant, className }: EmptyIllustrationProps): JSX.Element {
  const accent = ACCENT[variant];
  const gradientId = useId().replace(/:/g, '');
  const classes = className ? `nwa-empty-illustration ${className}` : 'nwa-empty-illustration';

  return (
    <svg
      className={classes}
      viewBox="0 0 260 220"
      aria-hidden="true"
      focusable="false"
      data-empty-illustration={variant}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff7e8" stopOpacity="0.95" />
          <stop offset="1" stopColor={accent} stopOpacity="0.12" />
        </linearGradient>
      </defs>
      <ellipse cx="130" cy="192" rx="82" ry="14" fill="#000" opacity="0.08" />
      <circle cx="130" cy="109" r="88" fill={`url(#${gradientId})`} />
      <path d="M47 174c25-15 42-40 51-74 11-42 40-61 75-51 33 10 52 38 58 84" fill="none" stroke={accent} strokeWidth="3" opacity="0.14" strokeLinecap="round" />
      <VariantGlyph variant={variant} accent={accent} />
      <circle cx="63" cy="58" r="8" fill={accent} opacity="0.18" />
      <circle cx="208" cy="62" r="6" fill={accent} opacity="0.22" />
      <circle cx="218" cy="156" r="9" fill={accent} opacity="0.13" />
    </svg>
  );
}

export default EmptyIllustration;
