import type { MemorySourceRef } from './SourceMemory.js';

/** Explicit author records, stored beside the mode's authoritative manuscript. */
export type StoryControlKind = 'preference' | 'fact_correction' | 'thread';
export type StoryThreadStatus = 'planted' | 'echoed' | 'resolved' | 'dropped';

export interface StoryControl {
  id: string;
  revision: number;
  kind: StoryControlKind;
  text: string;
  enabled: boolean;
  importance: 'required' | 'advisory';
  fromUnit: number;
  throughUnit?: number;
  /** Required for a fact correction; never invent a source for an author note. */
  source?: MemorySourceRef;
  thread?: {
    /** Stable canonical thread entity ID, or the author record's own ID. */
    threadId: string;
    title: string;
    status: StoryThreadStatus;
    urgency: 'low' | 'medium' | 'high';
    deadlineUnit?: number;
    /** Only this explicit author choice makes payoff a required writing goal. */
    requiredAtUnit?: number;
  };
  createdAt: string;
  updatedAt: string;
}

export type StoryControlInput = Omit<StoryControl, 'id' | 'revision' | 'createdAt' | 'updatedAt'> & {
  id?: string;
  /** Explicit author adjudication before retracting a previously accepted source. */
  resolutionConfirmed?: boolean;
};

export interface StoryControlCollection {
  schemaVersion: 1;
  revision: number;
  items: StoryControl[];
}

export interface StoryControlStorePort {
  getStoryControls(projectId: string): Promise<StoryControlCollection>;
  upsertStoryControl(projectId: string, input: StoryControlInput, expectedRevision: number): Promise<StoryControlCollection>;
  deleteStoryControl(projectId: string, id: string, expectedRevision: number): Promise<StoryControlCollection>;
}
