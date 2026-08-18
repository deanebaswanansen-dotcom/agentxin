import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const appCss = readFileSync(join(process.cwd(), 'src', 'App.css'), 'utf8');
const componentsCss = readFileSync(join(process.cwd(), 'src', 'components', 'components.css'), 'utf8');
const scriptWorkspaceCss = readFileSync(join(process.cwd(), 'src', 'components', 'script-workspace.css'), 'utf8');
const themeCss = readFileSync(join(process.cwd(), 'src', 'styles', 'theme.css'), 'utf8');

const cssFiles = [
  { name: 'App.css', source: appCss },
  { name: 'components.css', source: componentsCss },
  { name: 'theme.css', source: themeCss },
];

describe('CSS guardrails', () => {
  it('keeps letter spacing at zero for stable text rendering', () => {
    const violations = cssFiles.flatMap((file) => {
      return Array.from(file.source.matchAll(/letter-spacing\s*:\s*([^;]+);/g))
        .map((match) => match[1].trim())
        .filter((value) => value !== '0')
        .map((value) => `${file.name}: letter-spacing: ${value}`);
    });

    expect(violations).toEqual([]);
  });

  it('keeps the three configured theme background assets wired', () => {
    expect(appCss).toContain("url('/bg-tavern.svg')");
    expect(appCss).toContain("url('/bg-cyber.svg')");
    expect(appCss).toContain("url('/bg-study.svg')");
  });

  it('keeps z-index values behind semantic layer variables', () => {
    const expectedLayerVars = [
      '--z-workspace',
      '--z-header',
      '--z-popover',
      '--z-mobile-sidebar',
      '--z-mobile-chat',
      '--z-drawer',
      '--z-toast',
      '--z-modal',
    ];

    expectedLayerVars.forEach((layer) => {
      expect(themeCss).toContain(layer);
    });

    const violations = cssFiles.flatMap((file) => {
      return Array.from(file.source.matchAll(/z-index\s*:\s*([^;]+);/g))
        .map((match) => match[1].trim())
        .filter((value) => !value.startsWith('var(--z-'))
        .map((value) => `${file.name}: z-index: ${value}`);
    });

    expect(violations).toEqual([]);
  });

  it('does not globally flatten depth feedback', () => {
    const violations = cssFiles.flatMap((file) => {
      return Array.from(file.source.matchAll(/(box-shadow|backdrop-filter|transform)\s*:\s*none\s*;/g))
        .map((match) => `${file.name}: ${match[0]}`);
    });

    expect(violations).toEqual([]);
  });

  it('keeps screenplay fullscreen above the global header with semantic layers', () => {
    expect(appCss).toContain('.nwa-tavern-workspace:has(.script-episodes-panel.is-fullscreen)');
    expect(scriptWorkspaceCss).toMatch(
      /\.script-episodes-panel\.is-fullscreen\s*\{[^}]*z-index:\s*var\(--z-modal\)/s,
    );
  });
});
