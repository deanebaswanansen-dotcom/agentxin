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

/** A persisted input revision used to reject work produced from stale canon. */
export interface ScriptInputRevisionRef {
  resource:
    | 'plan'
    | 'outline'
    | 'characters'
    | 'world'
    | 'episode'
    | 'continuity';
  id: ScriptId;
  revision: number;
}

/** An immutable checkpoint artifact that contributed to a generated candidate. */
export interface ScriptUpstreamArtifactRef {
  node: string;
  artifactRevision: number;
  artifactHash: string;
}

export interface ScriptContinuityCharacterUpdate {
  characterId: ScriptId;
  location?: string;
  emotionalState?: string;
  knownFactsAdded: string[];
  relationshipChanges: string[];
  outfit?: string;
}

export interface ScriptContinuityFact {
  /** Stable across later commits that refer to the same fact. */
  factId: ScriptId;
  text: string;
  evidenceBlockIds: ScriptId[];
}

export interface ScriptContinuityProp {
  /** Stable across transfers and state changes of the same prop. */
  propId: ScriptId;
  name: string;
  holderCharacterId?: ScriptId;
  state: string;
  evidenceBlockIds: ScriptId[];
}

export interface ScriptContinuityThread {
  /** Stable from opening through advancing and closing the same thread. */
  threadId: ScriptId;
  action: 'opened' | 'advanced' | 'closed';
  description: string;
  evidenceBlockIds: ScriptId[];
}

export interface ScriptContinuityTimelineEvent {
  /** Stable when another event cites this event as a cause. */
  eventId: ScriptId;
  timeLabel: string;
  summary: string;
  causeEventIds: ScriptId[];
  evidenceBlockIds: ScriptId[];
}

export interface ScriptEpisodeContinuityCommitInput {
  characterUpdates: ScriptContinuityCharacterUpdate[];
  factsAdded: ScriptContinuityFact[];
  props: ScriptContinuityProp[];
  threads: ScriptContinuityThread[];
  timelineEvents: ScriptContinuityTimelineEvent[];
  nextEpisodeMustInherit: string[];
}

/**
 * Versioned continuity delta bound to one exact, atomically committed Episode
 * revision. Historical entries remain inspectable but cannot be used as canon
 * after they become stale.
 */
export interface ScriptEpisodeContinuityCommit
  extends ScriptEpisodeContinuityCommitInput {
  id: ScriptId;
  schemaVersion: 1;
  projectId: ScriptId;
  episodeNumber: number;
  episodeRevision: number;
  /** Monotonic project-wide continuity commit revision. */
  revision: number;
  status: 'current' | 'stale';
  inputFingerprint: string;
  previousContinuityCommitId?: ScriptId;
  previousContinuityRevision?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ScriptCommitEpisodeWithContinuityInput {
  episode: ScriptEpisode;
  expectedEpisodeRevision: number;
  /** Review ledger revision observed before this atomic Episode commit. */
  expectedReviewRevision: number;
  /** Candidate review findings replaced in the same store mutation as the Episode. */
  reviewUpdate?: {
    sources: ScriptReviewSource[];
    items: ScriptReviewIssue[];
  };
  continuity: ScriptEpisodeContinuityCommitInput;
  inputRevisionRefs: ScriptInputRevisionRef[];
  upstreamArtifactRefs: ScriptUpstreamArtifactRef[];
  promptVersion: string;
  modelConfigFingerprint: string;
  inputFingerprint: string;
  candidateHash: string;
}

export interface ScriptCommitEpisodeWithContinuityResult {
  episode: ScriptEpisode;
  continuity: ScriptEpisodeContinuityCommit;
}

export type ScriptReviewSeverity = 'hard' | 'soft' | 'suggestion';
export type ScriptReviewStatus = 'open' | 'fixed' | 'ignored';
export type ScriptReviewSource = 'deterministic' | 'ai' | 'user';
export type ScriptReviewCategory =
  | 'format'
  | 'continuity'
  | 'logic'
  | 'dialogue'
  | 'character'
  | 'pacing'
  | 'spelling'
  | 'hook';

/** A localized proofreading finding. It is persisted independently from episode text. */
export interface ScriptReviewIssue {
  id: ScriptId;
  projectId: ScriptId;
  episodeNumber: number;
  sceneId?: ScriptId;
  blockId?: ScriptId;
  path?: string;
  code: string;
  severity: ScriptReviewSeverity;
  category: ScriptReviewCategory;
  message: string;
  suggestion?: string;
  status: ScriptReviewStatus;
  source: ScriptReviewSource;
  createdAt: string;
  updatedAt: string;
}

export type ScriptReviewIssueInput = Omit<
  ScriptReviewIssue,
  'id' | 'projectId' | 'createdAt' | 'updatedAt'
> & { id?: ScriptId };

export interface ScriptReviewIssueCollection {
  revision: number;
  items: ScriptReviewIssue[];
}

export interface ScriptReviewIssueUpdateResult {
  revision: number;
  item: ScriptReviewIssue;
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
  /** Detailed continuity source of truth; missing in legacy v1 files. */
  continuityCommits?: ScriptEpisodeContinuityCommit[];
  /** Legacy aggregate retained while readers migrate to continuityCommits. */
  continuity: ScriptContinuityState;
  /** Aggregate compare-and-save revision for the review issue collection. */
  reviewRevision: number;
  reviewIssues: ScriptReviewIssue[];
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

export type ScriptBatchStatus =
  | 'blocked'
  | 'ready'
  | 'generating'
  | 'proofreading'
  | 'completed'
  | 'failed';

export interface ScriptBatchSummary {
  startEpisode: number;
  endEpisode: number;
  status: ScriptBatchStatus;
  completedEpisodes: number;
  visibleChars: number;
  activeJobId?: string;
  unresolvedHardIssues: number;
  unresolvedSoftIssues: number;
}

/** Compact, single-request payload used by the production workspace shell. */
export interface ScriptWorkspaceSnapshot {
  schemaVersion: 1;
  projectId: ScriptId;
  plan?: ScriptPlan;
  outline?: ScriptSeriesOutline;
  characters: ScriptCharacter[];
  worldBible?: ScriptWorldBible;
  episodeSummaries: ScriptEpisodeSummary[];
  batchSummaries: ScriptBatchSummary[];
  reviewRevision: number;
  reviewIssues: ScriptReviewIssue[];
  updatedAt: string;
}

export type ScriptExportFormat = 'txt' | 'md' | 'fountain';

