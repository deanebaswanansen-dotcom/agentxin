/** Canonical short-drama domain contract. Structured JSON is the source of truth. */

export type ScriptId = string;
export type ScriptPlanStatus = 'draft' | 'approved' | 'locked';
export type ScriptOutlineStatus = 'card' | 'expanded' | 'approved';
export type ScriptEpisodeStatus =
  | 'planned'
  | 'generating'
  | 'reviewing'
  | 'completed'
  | 'failed';
export type ScriptTimeOfDay = 'day' | 'night' | 'dawn' | 'dusk';
export type ScriptInteriorExterior = 'interior' | 'exterior';

export interface ScriptPlan {
  id: ScriptId;
  projectId: ScriptId;
  status: ScriptPlanStatus;
  revision: number;
  title: string;
  theme: string;
  market: 'domestic' | 'overseas';
  channel: 'female' | 'male' | 'general';
  genres: string[];
  audience: string;
  coreConflict: string;
  logline: string;
  highlights: string[];
  totalEpisodes: number;
  episodeDurationSeconds: { min: number; max: number };
  targetCharsPerEpisode: number;
  maxPrimaryCharacters: number;
  maxScenesPerEpisode: number;
  dialogueDensityPercent: number;
  language: 'zh-CN';
  format: 'cn_short_drama';
  coreRequirements: string;
  forbiddenElements: string[];
  endingDirection: string;
  coverPrompt?: string;
  createdAt: string;
  updatedAt: string;
}

export type ScriptPlanInput = Omit<
  ScriptPlan,
  'id' | 'projectId' | 'revision' | 'createdAt' | 'updatedAt'
> & { id?: ScriptId };

export interface ScriptCharacterRelationship {
  characterId: ScriptId;
  label: string;
  notes?: string;
}

export interface ScriptCharacter {
  id: ScriptId;
  projectId: ScriptId;
  name: string;
  aliases: string[];
  role: 'lead' | 'supporting' | 'antagonist' | 'minor';
  age?: number;
  occupation?: string;
  identity: string;
  biography: string;
  motivation: string;
  goal: string;
  weakness: string;
  arc: string;
  appearance: string;
  hairstyle: string;
  physique: string;
  defaultOutfit: string;
  personality: string[];
  skills: string[];
  speechStyle: string;
  catchphrases: string[];
  relationships: ScriptCharacterRelationship[];
  revision: number;
  updatedAt: string;
}

export type ScriptCharacterInput = Omit<
  ScriptCharacter,
  'id' | 'projectId' | 'revision' | 'updatedAt'
> & { id?: ScriptId };

export interface ScriptWorldBible {
  projectId: ScriptId;
  era: string;
  primaryLocations: string[];
  worldState: string;
  rules: string[];
  transport: string[];
  communication: string[];
  organizations: string[];
  recurringProps: string[];
  forbiddenAnachronisms: string[];
  revision: number;
  updatedAt: string;
}

export type ScriptWorldBibleInput = Omit<
  ScriptWorldBible,
  'projectId' | 'revision' | 'updatedAt'
>;

export interface ScriptEpisodeCard {
  episodeNumber: number;
  title: string;
  logline: string;
  mainEvent: string;
  endingHook: string;
}

export interface ScriptSeriesOutline {
  projectId: ScriptId;
  synopsis: string;
  openingState: string;
  midpointTurn: string;
  climax: string;
  endingState: string;
  mainArc: string[];
  subplotArcs: string[];
  episodeCards: ScriptEpisodeCard[];
  revision: number;
}

export type ScriptSeriesOutlineInput = Omit<
  ScriptSeriesOutline,
  'projectId' | 'revision'
>;

export interface ScriptPlannedScene {
  ordinal: number;
  location: string;
  timeOfDay: ScriptTimeOfDay;
  interiorExterior: ScriptInteriorExterior;
  purpose: string;
}

export interface ScriptEpisodeOutline {
  id: ScriptId;
  projectId: ScriptId;
  episodeNumber: number;
  title: string;
  goal: string;
  conflict: string;
  beats: string[];
  characterIds: ScriptId[];
  plannedScenes: ScriptPlannedScene[];
  reveal?: string;
  reversal?: string;
  endingHook: string;
  requiredFacts: string[];
  forbiddenFacts: string[];
  status: ScriptOutlineStatus;
  revision: number;
}

export type ScriptEpisodeOutlineInput = Omit<
  ScriptEpisodeOutline,
  'id' | 'projectId' | 'revision'
> & { id?: ScriptId };

export type ScriptBlock =
  | { id: ScriptId; type: 'caption'; text: string }
  | { id: ScriptId; type: 'action'; text: string }
  | {
      id: ScriptId;
      type: 'dialogue';
      characterId?: ScriptId;
      speaker: string;
      delivery?: string;
      mode?: 'normal' | 'os' | 'vo';
      text: string;
    };

export interface ScriptScene {
  id: ScriptId;
  ordinal: number;
  location: string;
  timeOfDay: ScriptTimeOfDay;
  interiorExterior: ScriptInteriorExterior;
  characterIds: ScriptId[];
  blocks: ScriptBlock[];
}

export interface ScriptEpisode {
  id: ScriptId;
  projectId: ScriptId;
  episodeNumber: number;
  title: string;
  outlineId: ScriptId;
  status: ScriptEpisodeStatus;
  targetChars: number;
  scenes: ScriptScene[];
  summary: string;
  newFacts: string[];
  openedThreads: string[];
  closedThreads: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type ScriptEpisodeInput = Omit<
  ScriptEpisode,
  'id' | 'projectId' | 'revision' | 'createdAt' | 'updatedAt'
> & { id?: ScriptId };

export interface ScriptContinuityState {
  currentState: string[];
  openThreads: string[];
  wardrobeLedger: Array<{
    episodeNumber: number;
    characterId: ScriptId;
    outfit: string;
  }>;
}

export interface ScriptProjectState {
  schemaVersion: 1;
  projectId: ScriptId;
  plan?: ScriptPlan;
  characters: ScriptCharacter[];
  worldBible?: ScriptWorldBible;
  seriesOutline?: ScriptSeriesOutline;
  episodeOutlines: ScriptEpisodeOutline[];
  episodes: ScriptEpisode[];
  continuity: ScriptContinuityState;
  updatedAt: string;
}

export interface ScriptEpisodeSummary {
  id: ScriptId;
  episodeNumber: number;
  title: string;
  status: ScriptEpisodeStatus;
  targetChars: number;
  visibleChars: number;
  sceneCount: number;
  revision: number;
  updatedAt: string;
}

export type ScriptExportFormat = 'txt' | 'md';

