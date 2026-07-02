/**
 * Property-based test for {@link FileDataStore} restart recovery.
 *
 * Covers design.md Correctness **Property 24: 重启后从存储恢复全部数据**
 * (task 2.5; Requirement 7.3): *For any* dataset of projects plus their
 * associated chapters / characters / world settings / outlines (and an optional
 * single-instance model config) written to a `FileDataStore`, re-constructing a
 * store over the SAME persistence file (a simulated service restart) must read
 * back exactly the same data that was observable before the restart.
 *
 * Method (design.md Testing Strategy — "FileDataStore 的原子写入与跨实例恢复以集成
 * 测试覆盖（属性 24）"): we drive the real store through its public mutators,
 * capture the full read-back state from the live instance, then build a fresh
 * `FileDataStore.create(samePath)` and assert its full read-back state
 * deep-equals the captured one.
 *
 * Uses fast-check with >= 100 runs. Generators cover special characters,
 * whitespace, Unicode, empty collections and longer strings. Every fast-check
 * run gets its OWN temp directory (created inside the predicate) which is
 * removed in a `finally` block, so runs never contaminate each other and no
 * leftover files remain. Cleanup uses `rm({ recursive, force })` which tolerates
 * Windows file-lock / missing-path quirks.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { FileDataStore } from './FileDataStore.js';
import type { Chapter, Character, ModelConfig, Outline, Project, WorldSetting } from '../types/index.js';

const NUM_RUNS = 100;

/**
 * Text generator covering the required edge classes: ASCII (incl. empty),
 * full Unicode code points, printable graphemes/emoji, hand-picked
 * whitespace / structural-marker strings, and longer strings.
 */
const textArb: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  fc.string({ unit: 'grapheme' }),
  fc.string({ unit: 'binary' }),
  fc.constantFrom(
    '',
    ' ',
    '\n',
    '\t',
    '   \n\t  ',
    '第一章',
    '林夜与星辰之海',
    '日本語のテキスト',
    '😀🎉👨‍👩‍👧‍👦',
    'line1\nline2\r\nline3',
    '"quoted" <tag> & ampersand \\backslash',
    '{"looks":"like json"}',
  ),
  fc.string({ minLength: 100, maxLength: 300 }),
);

interface ChapterSpec {
  title: string;
  content: string;
}
interface NamedSpec {
  name: string;
  description: string;
}
interface TitledSpec {
  title: string;
  content: string;
}
interface ProjectSpec {
  name: string;
  chapters: ChapterSpec[];
  characters: NamedSpec[];
  worldSettings: TitledSpec[];
  outlines: TitledSpec[];
}
interface DatasetSpec {
  projects: ProjectSpec[];
  modelConfig?: ModelConfig;
}

const chapterSpecArb: fc.Arbitrary<ChapterSpec> = fc.record({
  title: textArb,
  content: textArb,
});

const characterSpecArb: fc.Arbitrary<NamedSpec> = fc.record({
  name: textArb,
  description: textArb,
});

const titledSpecArb: fc.Arbitrary<TitledSpec> = fc.record({
  title: textArb,
  content: textArb,
});

const modelConfigArb: fc.Arbitrary<ModelConfig> = fc.record({
  baseUrl: textArb,
  apiKey: textArb,
  modelName: textArb,
});

const projectSpecArb: fc.Arbitrary<ProjectSpec> = fc.record({
  name: textArb,
  // maxLength includes 0, so empty collections are exercised.
  chapters: fc.array(chapterSpecArb, { maxLength: 4 }),
  characters: fc.array(characterSpecArb, { maxLength: 4 }),
  worldSettings: fc.array(titledSpecArb, { maxLength: 4 }),
  outlines: fc.array(titledSpecArb, { maxLength: 4 }),
});

const datasetArb: fc.Arbitrary<DatasetSpec> = fc.record({
  projects: fc.array(projectSpecArb, { maxLength: 3 }),
  // The model config is a single store-wide singleton; sometimes absent.
  modelConfig: fc.option(modelConfigArb, { nil: undefined }),
});

/** Full observable read-back of a store, used as the comparison value. */
interface CapturedState {
  projects: Pick<Project, 'id' | 'name'>[];
  byProject: Record<
    string,
    {
      chapters: Chapter[];
      characters: Character[];
      worldSettings: WorldSetting[];
      outlines: Outline[];
    }
  >;
  modelConfig: ModelConfig | undefined;
}

/**
 * Read everything observable through the public API: the project list plus,
 * per project, its chapters / characters / world settings / outlines, and the
 * single model config.
 */
async function captureState(store: FileDataStore): Promise<CapturedState> {
  const projects = await store.listProjects();
  const byProject: CapturedState['byProject'] = {};
  for (const project of projects) {
    byProject[project.id] = {
      chapters: await store.listChapters(project.id),
      characters: await store.listCharacters(project.id),
      worldSettings: await store.listWorldSettings(project.id),
      outlines: await store.listOutlines(project.id),
    };
  }
  const modelConfig = await store.getModelConfig();
  return { projects, byProject, modelConfig };
}

/** Write a generated dataset into the store via its public mutators. */
async function writeDataset(
  store: FileDataStore,
  dataset: DatasetSpec,
): Promise<void> {
  for (const projectSpec of dataset.projects) {
    const project = await store.createProject(projectSpec.name);

    for (const chapter of projectSpec.chapters) {
      const created = await store.createChapter(project.id, chapter.title);
      // Content is set through the dedicated content mutator (Requirement 2.3).
      await store.updateChapterContent(created.id, chapter.content);
    }
    for (const character of projectSpec.characters) {
      await store.createCharacter(
        project.id,
        character.name,
        character.description,
      );
    }
    for (const world of projectSpec.worldSettings) {
      await store.createWorldSetting(project.id, world.title, world.content);
    }
    for (const outline of projectSpec.outlines) {
      await store.createOutline(project.id, outline.title, outline.content);
    }
  }

  if (dataset.modelConfig !== undefined) {
    await store.saveModelConfig(dataset.modelConfig);
  }
}

describe('FileDataStore restart recovery property test', () => {
  it('Feature: novel-writing-agent, Property 24: 重启后从存储恢复全部数据', async () => {
    await fc.assert(
      fc.asyncProperty(datasetArb, async (dataset) => {
        // Unique temp dir per run so runs never contaminate each other.
        const dir = await mkdtemp(join(tmpdir(), 'fds-prop-'));
        const file = join(dir, 'store.json');
        try {
          // 1. Write the generated dataset into the original store instance.
          const original = await FileDataStore.create(file);
          await writeDataset(original, dataset);

          // 2. Capture everything observable before the simulated restart.
          const before = await captureState(original);

          // 3. Simulate a restart: a brand-new store over the SAME file.
          const restarted = await FileDataStore.create(file);
          const after = await captureState(restarted);

          // 4. The recovered data must be identical to the pre-restart data
          //    (projects + all associated entities + model config).
          expect(after).toEqual(before);
        } finally {
          // Tolerates Windows file locks / already-removed paths.
          await rm(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: NUM_RUNS },
    );
    // Each run performs real filesystem I/O (mkdtemp + multiple atomic writes +
    // recursive cleanup), so 100 runs comfortably exceed vitest's 5s default.
  }, 120_000);
});
