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

export function serializeScriptMarkdown(
  episodes: readonly ScriptEpisode[],
  characters: readonly ScriptCharacter[],
  options: { title?: string } = {},
): string {
  const names = new Map(characters.map((character) => [character.id, character.name]));
  const hasSeriesTitle = Boolean(options.title?.trim());
  const body = [...episodes]
    .sort((left, right) => left.episodeNumber - right.episodeNumber)
    .map((episode) => {
      const scenes = [...episode.scenes]
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((scene) => {
          const cast = scene.characterIds.map((id) => names.get(id) ?? id).join(' ');
          const lines = [
            `${hasSeriesTitle ? '###' : '##'} ${episode.episodeNumber}-${scene.ordinal} ${scene.location.trim()} ${TIME_LABELS[scene.timeOfDay]}/${SPACE_LABELS[scene.interiorExterior]}`,
          ];
          if (cast) lines.push(`人物：${cast}`);
          for (const block of scene.blocks) {
            const text = block.text.trim();
            if (block.type === 'caption') lines.push(`> 字幕：${text}`);
            else if (block.type === 'action') lines.push(`△${text}`);
            else {
              const parenthetical = block.delivery?.trim() || block.mode;
              lines.push(`**${block.speaker.trim()}${parenthetical ? `（${parenthetical}）` : ''}：**${text}`);
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
