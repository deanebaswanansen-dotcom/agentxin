import type { ScriptCharacter, ScriptEpisode, ScriptScene } from '../domain.js';

const TIME_LABELS: Record<ScriptScene['timeOfDay'], string> = {
  day: 'DAY',
  night: 'NIGHT',
  dawn: 'DAWN',
  dusk: 'DUSK',
};

const SPACE_LABELS: Record<ScriptScene['interiorExterior'], string> = {
  interior: '.INT.',
  exterior: '.EXT.',
};

export function serializeFountain(
  episodes: readonly ScriptEpisode[],
  _characters: readonly ScriptCharacter[],
): string {
  return [...episodes]
    .sort((left, right) => left.episodeNumber - right.episodeNumber)
    .map((episode) => {
      const scenes = [...episode.scenes]
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((scene) => {
          const chunks = [
            `${SPACE_LABELS[scene.interiorExterior]} ${scene.location.trim()} - ${TIME_LABELS[scene.timeOfDay]}`,
          ];
          for (const block of scene.blocks) {
            const text = block.text.trim();
            if (block.type === 'caption') {
              chunks.push(`[[字幕：${text}]]`);
            } else if (block.type === 'action') {
              chunks.push(text);
            } else {
              const mode = block.mode === 'os' ? 'O.S.' : block.mode === 'vo' ? 'V.O.' : undefined;
              const delivery = block.delivery?.trim();
              const parentheticals = [delivery, mode].filter((value): value is string => Boolean(value));
              chunks.push(
                `${block.speaker.trim()}${parentheticals.length > 0 ? ` (${parentheticals.join(', ')})` : ''}\n${text}`,
              );
            }
          }
          return chunks.join('\n\n');
        });
      return [`# 第${episode.episodeNumber}集 ${episode.title.trim()}`, ...scenes].join('\n\n');
    })
    .join('\n\n===\n\n');
}
