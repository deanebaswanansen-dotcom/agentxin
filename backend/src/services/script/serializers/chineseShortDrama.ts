import type {
  ScriptBlock,
  ScriptCharacter,
  ScriptEpisode,
  ScriptScene,
} from '../domain.js';

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

export function chineseNumber(value: number): string {
  if (!Number.isInteger(value) || value < 1 || value > 999) return String(value);
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (value < 10) return digits[value] ?? String(value);
  if (value < 20) return `十${value === 10 ? '' : digits[value % 10]}`;
  if (value < 100) {
    const remainder = value % 10;
    return `${digits[Math.floor(value / 10)]}十${remainder === 0 ? '' : digits[remainder]}`;
  }
  const remainder = value % 100;
  const head = `${digits[Math.floor(value / 100)]}百`;
  if (remainder === 0) return head;
  return `${head}${remainder < 10 ? '零' : ''}${chineseNumber(remainder)}`;
}

function renderBlock(block: ScriptBlock): string {
  const text = block.text.trim();
  if (block.type === 'caption') {
    if (/^(?:闪回|闪回结束|闪出)$/u.test(text)) return `【${text}】`;
    return `【字幕：${text}】`;
  }
  if (block.type === 'action') return `△${text}`;
  const mode = block.mode === 'os' || block.mode === 'vo' ? block.mode.toUpperCase() : '';
  const delivery = block.delivery?.trim();
  return `${block.speaker.trim()}${mode || (delivery ? `（${delivery}）` : '')}：${text}`;
}

function renderScene(
  episodeNumber: number,
  scene: ScriptScene,
  charactersById: ReadonlyMap<string, ScriptCharacter>,
  introducedCharacterIds: Set<string>,
): string {
  const heading = `${episodeNumber}-${scene.ordinal} ${TIME_LABELS[scene.timeOfDay]} ${SPACE_LABELS[scene.interiorExterior]} ${scene.location.trim()}`;
  const names = scene.characterIds.map((id) => {
    const character = charactersById.get(id);
    if (!character) return id;
    if (introducedCharacterIds.has(id)) return character.name;
    introducedCharacterIds.add(id);
    const identity = character.identity?.trim() ?? '';
    return identity ? `${character.name}（${identity}）` : character.name;
  });
  const lines = [heading];
  if (names.length > 0) lines.push(`人物：${names.join(' ')}`);
  lines.push(...scene.blocks.map(renderBlock));
  return lines.join('\n');
}

export function serializeChineseShortDrama(
  episodes: readonly ScriptEpisode[],
  characters: readonly ScriptCharacter[],
): string {
  const charactersById = new Map(characters.map((character) => [character.id, character]));
  const introducedCharacterIds = new Set<string>();
  return [...episodes]
    .sort((left, right) => left.episodeNumber - right.episodeNumber)
    .map((episode) => {
      const scenes = [...episode.scenes]
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((scene) => renderScene(
          episode.episodeNumber,
          scene,
          charactersById,
          introducedCharacterIds,
        ));
      return [`第${episode.episodeNumber}集：`, ...scenes].join('\n\n');
    })
    .join('\n\n');
}
