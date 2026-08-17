import type { ScriptCharacter, ScriptEpisode, ScriptScene } from '../domain.js';
import { chineseNumber } from './chineseShortDrama.js';

const TIME_LABELS: Record<ScriptScene['timeOfDay'], string> = {
  day: '日',
  night: '夜',
  dawn: '晨',
  dusk: '黄昏',
};

const SPACE_LABELS: Record<ScriptScene['interiorExterior'], string> = {
  interior: '内',
  exterior: '外',
};

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function emphasizedAction(text: string, characterNames: readonly string[]): string {
  const tokens = [
    '【[^】]+】',
    ...characterNames.filter(Boolean).sort((left, right) => right.length - left.length).map(escapedRegExp),
  ];
  if (tokens.length === 1) return text.replace(/【[^】]+】/gu, (value) => `**${value}**`);
  return text.replace(new RegExp(`(${tokens.join('|')})`, 'gu'), (value) => `**${value}**`);
}

export function serializeScriptMarkdown(
  episodes: readonly ScriptEpisode[],
  characters: readonly ScriptCharacter[],
  options: { title?: string } = {},
): string {
  const charactersById = new Map(characters.map((character) => [character.id, character]));
  const characterNames = characters.map((character) => character.name);
  const introducedCharacterIds = new Set<string>();
  const hasSeriesTitle = Boolean(options.title?.trim());
  const body = [...episodes]
    .sort((left, right) => left.episodeNumber - right.episodeNumber)
    .map((episode) => {
      const scenes = [...episode.scenes]
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((scene) => {
          const cast = scene.characterIds.map((id) => {
            const character = charactersById.get(id);
            if (!character) return id;
            if (introducedCharacterIds.has(id)) return character.name;
            introducedCharacterIds.add(id);
            const identity = character.identity?.trim() ?? '';
            return identity ? `${character.name}（${identity}）` : character.name;
          }).join(' ');
          const lines = [
            `${hasSeriesTitle ? '###' : '##'} ${episode.episodeNumber}-${scene.ordinal} ${TIME_LABELS[scene.timeOfDay]} ${SPACE_LABELS[scene.interiorExterior]} ${scene.location.trim()}`,
          ];
          if (cast) lines.push(`人物：${cast}`);
          for (const block of scene.blocks) {
            const text = block.text.trim();
            if (block.type === 'caption') {
              lines.push(/^(?:闪回|闪回结束|闪出)$/u.test(text) ? `> 【${text}】` : `> 【字幕：${text}】`);
            }
            else if (block.type === 'action') lines.push(`△${emphasizedAction(text, characterNames)}`);
            else {
              const mode = block.mode === 'os' || block.mode === 'vo' ? block.mode.toUpperCase() : '';
              const delivery = block.delivery?.trim();
              lines.push(`**${block.speaker.trim()}${mode || (delivery ? `（${delivery}）` : '')}：**${text}`);
            }
          }
          return lines.join('\n\n');
        });
      const episodeHeading = hasSeriesTitle
        ? `## 第${chineseNumber(episode.episodeNumber)}集 · ${episode.title.trim()}`
        : `# 第${episode.episodeNumber}集 ${episode.title.trim()}`;
      return [episodeHeading, ...scenes].join('\n\n');
    })
    .join('\n\n---\n\n');
  return hasSeriesTitle ? `# ${options.title?.trim()}\n\n${body}` : body;
}
