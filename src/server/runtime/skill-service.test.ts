// @vitest-environment node
/**
 * SkillService tests (plan Phase C Task 3 Steps 1/3).
 *
 * Skills are resolved only through the frozen task snapshot (spec §5.2):
 * authorization comes from the frozen manifest, the file must stay inside
 * `snapshot/` (realpath containment, symlink escape rejected), and the first
 * successful load appends exactly one `skill_loaded` event while repeated
 * loads of the same content hash return the content without duplicating it.
 * Missing or changed content fails the current node with a typed,
 * non-retryable error; `loadedSkillsFor` rebuilds loaded contents from the
 * committed event history.
 *
 * The plan Step 1 verbatim case names the agents of the storage-level
 * `valid` template fixture — business vocabulary is confined to fixture data
 * and this test file; the SkillService module itself carries none.
 */
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CorePaths } from '../storage/core-paths';
import { EventStore } from '../storage/event-store';
import { TaskStore } from '../storage/task-store';
import {
  catalogWithOneTemplate,
  catalogWithSectionsTemplate,
  disposeAllTestRoots,
  makeEventNode,
  makeTaskEvent,
  validTaskRequest,
} from '../test-support';
import { SkillService } from './skill-service';

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

let paths: CorePaths;
let events: EventStore;
let skills: SkillService;
let taskId: string;
let dataRoot: string;
let snapshotRoot: string;

beforeEach(async () => {
  const fixture = await catalogWithOneTemplate();
  paths = fixture.paths;
  dataRoot = paths.dataRoot;
  const tasks = new TaskStore(paths, fixture.catalog);
  events = new EventStore(paths);
  skills = new SkillService({ paths, tasks, events });
  const created = await tasks.create(validTaskRequest());
  taskId = created.id;
  snapshotRoot = paths.taskSnapshotRoot(taskId);
});

afterEach(() => {
  disposeAllTestRoots();
});

/** A committed result node so later `skill_loaded` events attribute to it. */
async function seedResultNode(agentId: string): Promise<void> {
  await events.append(
    taskId,
    makeTaskEvent({
      type: 'agent_result',
      node: makeEventNode({ agentId, kind: 'result', title: '结果' }),
    }),
  );
}

function skillLoadedEvents(eventList: Awaited<ReturnType<EventStore['read']>>): string[] {
  return eventList
    .filter((committed) => committed.event.type === 'skill_loaded')
    .map((committed) => committed.event.id);
}

describe('SkillService authorization (plan Task 3 Step 1 verbatim)', () => {
  it('loads only a Skill authorized to the current frozen Agent', async () => {
    await expect(skills.loadAuthorized(taskId, 'writer', 'review-only'))
      .rejects.toMatchObject({ code: 'SKILL_NOT_AUTHORIZED' });
  });

  it('rejects an unknown agent with the same authorization error', async () => {
    await expect(skills.loadAuthorized(taskId, 'ghost', 'style-guide'))
      .rejects.toMatchObject({ code: 'SKILL_NOT_AUTHORIZED' });
  });

  it('never appends an event for an unauthorized load', async () => {
    const before = await events.read(taskId);
    await expect(skills.loadAuthorized(taskId, 'writer', 'review-checklist'))
      .rejects.toMatchObject({ code: 'SKILL_NOT_AUTHORIZED' });
    expect(await events.read(taskId)).toEqual(before);
  });
});

describe('SkillService snapshot-contained loading', () => {
  it('reads the authorized Skill content from the frozen snapshot', async () => {
    const loaded = await skills.loadAuthorized(taskId, 'writer', 'style-guide');
    const onDisk = readFileSync(join(snapshotRoot, 'skills/style-guide/SKILL.md'), 'utf8');
    expect(loaded.id).toBe('style-guide');
    expect(loaded.content).toBe(onDisk);
    expect(loaded.versionHash).toBe(sha256(onDisk));
  });

  it('appends exactly one skill_loaded event on the first successful load', async () => {
    await seedResultNode('writer');
    await skills.loadAuthorized(taskId, 'writer', 'style-guide');
    expect(skillLoadedEvents(await events.read(taskId))).toHaveLength(1);
  });

  it('returns the content without a duplicate event on repeated loads of the same hash', async () => {
    await seedResultNode('writer');
    const first = await skills.loadAuthorized(taskId, 'writer', 'style-guide');
    const second = await skills.loadAuthorized(taskId, 'writer', 'style-guide');
    expect(second).toEqual(first);
    expect(skillLoadedEvents(await events.read(taskId))).toHaveLength(1);
  });

  it('rejects a symlink escaping the frozen snapshot without appending events', async () => {
    await seedResultNode('writer');
    await skills.loadAuthorized(taskId, 'writer', 'style-guide');
    const skillFile = join(snapshotRoot, 'skills/style-guide/SKILL.md');
    const outsideFile = join(dataRoot, 'outside-skill.md');
    writeFileSync(outsideFile, 'content outside the frozen snapshot');
    rmSync(skillFile);
    symlinkSync(outsideFile, skillFile);
    await expect(skills.loadAuthorized(taskId, 'writer', 'style-guide'))
      .rejects.toMatchObject({ code: 'SKILL_PATH_UNSAFE' });
    expect(skillLoadedEvents(await events.read(taskId))).toHaveLength(1);
  });

  it('fails the node when the Skill content changed since the first load', async () => {
    await seedResultNode('writer');
    await skills.loadAuthorized(taskId, 'writer', 'style-guide');
    writeFileSync(join(snapshotRoot, 'skills/style-guide/SKILL.md'), 'tampered content');
    await expect(skills.loadAuthorized(taskId, 'writer', 'style-guide'))
      .rejects.toMatchObject({ code: 'SKILL_CONTENT_CHANGED', retryable: false });
    expect(skillLoadedEvents(await events.read(taskId))).toHaveLength(1);
  });

  it('fails the node when the Skill file is missing from the snapshot', async () => {
    // A successful load caches the frozen manifest, so the missing file of a
    // different skill surfaces as a node failure instead of a template error.
    await skills.loadAuthorized(taskId, 'writer', 'style-guide');
    rmSync(join(snapshotRoot, 'skills/review-checklist/SKILL.md'));
    await expect(skills.loadAuthorized(taskId, 'reviewer', 'review-checklist'))
      .rejects.toMatchObject({ code: 'SKILL_MISSING', retryable: false });
  });
});

describe('SkillService loaded-history rebuild', () => {
  it('rebuilds loaded Skill contents for the loading agent only', async () => {
    await seedResultNode('writer');
    const loaded = await skills.loadAuthorized(taskId, 'writer', 'style-guide');
    await expect(skills.loadedSkillsFor(taskId, 'writer')).resolves.toEqual([loaded]);
    await expect(skills.loadedSkillsFor(taskId, 'reviewer')).resolves.toEqual([]);
  });

  it('lists nothing before any load and dedupes repeated loads', async () => {
    await expect(skills.loadedSkillsFor(taskId, 'writer')).resolves.toEqual([]);
    await seedResultNode('writer');
    await skills.loadAuthorized(taskId, 'writer', 'style-guide');
    await skills.loadAuthorized(taskId, 'writer', 'style-guide');
    await expect(skills.loadedSkillsFor(taskId, 'writer')).resolves.toHaveLength(1);
  });
});

describe('SkillService display read (plan Task E3 Step 1)', () => {
  it('returns the snapshot Skill content for display without appending events', async () => {
    const before = await events.read(taskId);
    const display = await skills.readSkillForDisplay(taskId, 'style-guide');
    const onDisk = readFileSync(join(snapshotRoot, 'skills/style-guide/SKILL.md'), 'utf8');
    expect(display).toEqual({
      skillId: 'style-guide',
      content: onDisk,
      versionHash: sha256(onDisk),
    });
    expect(await events.read(taskId)).toEqual(before);
  });

  it('returns null for a Skill no frozen agent declares', async () => {
    const before = await events.read(taskId);
    await expect(skills.readSkillForDisplay(taskId, 'ghost-skill')).resolves.toBeNull();
    expect(await events.read(taskId)).toEqual(before);
  });

  it('returns null when the snapshot Skill file is unreadable', async () => {
    // A successful read caches the frozen manifest, so the missing file then
    // surfaces as the display null instead of a snapshot corruption error.
    await skills.readSkillForDisplay(taskId, 'style-guide');
    rmSync(join(snapshotRoot, 'skills/style-guide/SKILL.md'));
    await expect(skills.readSkillForDisplay(taskId, 'style-guide')).resolves.toBeNull();
  });
});

describe('SkillService section reads (plan 2026-08-07 Phase 1)', () => {
  let sectionsPaths: CorePaths;
  let sectionsEvents: EventStore;
  let sectionsSkills: SkillService;
  let sectionsTaskId: string;
  let sectionsSnapshotRoot: string;
  let sectionsDataRoot: string;

  beforeEach(async () => {
    const fixture = await catalogWithSectionsTemplate();
    sectionsPaths = fixture.paths;
    sectionsDataRoot = fixture.paths.dataRoot;
    const tasks = new TaskStore(fixture.paths, fixture.catalog);
    sectionsEvents = new EventStore(fixture.paths);
    sectionsSkills = new SkillService({ paths: fixture.paths, tasks, events: sectionsEvents });
    const created = await tasks.create(validTaskRequest());
    sectionsTaskId = created.id;
    sectionsSnapshotRoot = fixture.paths.taskSnapshotRoot(sectionsTaskId);
  });

  it('reads one authorized section from the frozen snapshot without appending events', async () => {
    const before = await sectionsEvents.read(sectionsTaskId);
    const section = await sectionsSkills.readSection(
      sectionsTaskId,
      'writer',
      'style-guide',
      'skills/style-guide/references/01.md',
    );
    const onDisk = readFileSync(
      join(sectionsSnapshotRoot, 'skills/style-guide/references/01.md'),
      'utf8',
    );
    expect(section).toEqual({ content: onDisk, versionHash: sha256(onDisk) });
    // Read-only invariant: a section read never appends any event.
    expect(await sectionsEvents.read(sectionsTaskId)).toEqual(before);
  });

  it('rejects a section path outside the frozen readable set', async () => {
    await expect(
      sectionsSkills.readSection(
        sectionsTaskId,
        'writer',
        'style-guide',
        'skills/style-guide/references/zz.md',
      ),
    ).rejects.toMatchObject({ code: 'SKILL_SECTION_NOT_AUTHORIZED' });
    await expect(
      sectionsSkills.readSection(sectionsTaskId, 'writer', 'style-guide', '../outside.md'),
    ).rejects.toMatchObject({ code: 'SKILL_SECTION_NOT_AUTHORIZED' });
  });

  it('rejects an unknown skill with the authorization code', async () => {
    await expect(
      sectionsSkills.readSection(
        sectionsTaskId,
        'writer',
        'ghost-skill',
        'skills/style-guide/references/01.md',
      ),
    ).rejects.toMatchObject({ code: 'SKILL_NOT_AUTHORIZED' });
  });

  it('rejects a section symlink escaping the frozen snapshot as path-unsafe', async () => {
    // A first successful read caches the frozen manifest, so the later file
    // surgery surfaces as the section read failure, not a snapshot corruption.
    await sectionsSkills.readSection(
      sectionsTaskId,
      'writer',
      'style-guide',
      'skills/style-guide/references/01.md',
    );
    const sectionFile = join(sectionsSnapshotRoot, 'skills/style-guide/references/01.md');
    const outsideFile = join(sectionsDataRoot, 'outside-section.md');
    writeFileSync(outsideFile, 'content outside the frozen snapshot');
    rmSync(sectionFile);
    symlinkSync(outsideFile, sectionFile);
    await expect(
      sectionsSkills.readSection(
        sectionsTaskId,
        'writer',
        'style-guide',
        'skills/style-guide/references/01.md',
      ),
    ).rejects.toMatchObject({ code: 'SKILL_SECTION_PATH_UNSAFE' });
  });

  it('fails with the missing code when an authorized section file is absent', async () => {
    // A first successful read caches the frozen manifest, so the removed file
    // surfaces as the section missing failure, not a snapshot corruption.
    await sectionsSkills.readSection(
      sectionsTaskId,
      'writer',
      'style-guide',
      'skills/style-guide/references/01.md',
    );
    rmSync(join(sectionsSnapshotRoot, 'skills/style-guide/references/01.md'));
    await expect(
      sectionsSkills.readSection(
        sectionsTaskId,
        'writer',
        'style-guide',
        'skills/style-guide/references/01.md',
      ),
    ).rejects.toMatchObject({ code: 'SKILL_SECTION_MISSING' });
  });
});
