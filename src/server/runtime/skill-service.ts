/**
 * Snapshot-contained Skill loading (plan Phase C Task 3 Step 3, spec §5.2).
 *
 * Agents only ever see summaries of their authorized Skills; full content is
 * read on demand through `loadAuthorized`, and only through the task's frozen
 * snapshot. The frozen manifest (revalidated against the version hash stored
 * in `task.json` by the task store) decides authorization; the file itself
 * must stay inside `snapshot/` — path containment is checked twice, on the
 * resolved path and again after `realpath`, so symlink escapes are rejected.
 *
 * The first successful load appends exactly one `skill_loaded` event;
 * repeated loads of the same content hash return the content without
 * duplicating the event. Missing files or content changed since the first
 * load fail the current node with a typed, non-retryable `RuntimeFailure` —
 * they never escape into other agents, tasks or templates (spec §8.3).
 * `loadedSkillsFor` rebuilds the loaded contents from committed events, so
 * the Task 4 runner can assemble `AgentTurnInput.loadedSkills` after a
 * restart without any second authoritative state.
 *
 * The event union carries only the skill id, so attribution folds over event
 * order: a `skill_loaded` event belongs to the agent of the most recent
 * node-carrying event, which the committer guarantees by appending the
 * agent result before the Turn's skill loads (plan Task 3 Step 5).
 *
 * No business vocabulary lives here (iron rule 1).
 */
import { createHash, randomUUID } from 'node:crypto';
import { realpath, stat, readFile } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import type { SkillContent } from '../../shared/contracts';
import type { CorePaths } from '../storage/core-paths';
import type { EventStore } from '../storage/event-store';
import type { TaskEvent } from '../storage/task-events';
import type { TaskStore } from '../storage/task-store';
import type { FrozenAgentConfig, FrozenTemplate } from '../template/template-schema';
import { RuntimeFailure } from './agent-runtime';

/** Stable skill error codes owned by this module. */
export const SKILL_ERROR_CODES = {
  /** The frozen manifest does not authorize this Skill for this Agent. */
  SKILL_NOT_AUTHORIZED: 'SKILL_NOT_AUTHORIZED',
  /** The authorized Skill file is absent or unreadable in the snapshot. */
  SKILL_MISSING: 'SKILL_MISSING',
  /** The Skill file resolves outside the frozen snapshot directory. */
  SKILL_PATH_UNSAFE: 'SKILL_PATH_UNSAFE',
  /** The Skill content changed after it was first loaded for this Agent. */
  SKILL_CONTENT_CHANGED: 'SKILL_CONTENT_CHANGED',
} as const;

/** One loaded Skill ready for injection into an Agent Turn. */
export interface LoadedSkill {
  id: string;
  content: string;
  versionHash: string;
}

export interface SkillServiceOptions {
  paths: CorePaths;
  tasks: TaskStore;
  events: EventStore;
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

type FrozenSkill = FrozenAgentConfig['skills'][number];

/**
 * Folds ordered events into per-agent Skill load lists. Node-carrying events
 * advance the current agent; `skill_loaded` attributes to it.
 */
function attributeSkillLoads(events: readonly TaskEvent[]): Map<string, string[]> {
  const loads = new Map<string, string[]>();
  let currentAgent: string | null = null;
  for (const event of events) {
    switch (event.type) {
      case 'agent_input':
      case 'agent_result':
      case 'human_requested':
      case 'human_answered':
        currentAgent = event.node.agentId;
        break;
      case 'skill_loaded': {
        if (currentAgent === null) {
          break; // A load before any node cannot be attributed; ignore it.
        }
        const forAgent = loads.get(currentAgent) ?? [];
        if (!forAgent.includes(event.skillId)) {
          forAgent.push(event.skillId);
        }
        loads.set(currentAgent, forAgent);
        break;
      }
      default:
        break;
    }
  }
  return loads;
}

export class SkillService {
  private readonly paths: CorePaths;

  private readonly tasks: TaskStore;

  private readonly events: EventStore;

  /** Frozen manifests are revalidated once per task per process. */
  private readonly frozenCache = new Map<string, FrozenTemplate>();

  /** Content hash recorded at first load, keyed by task:agent:skill. */
  private readonly loadedHashes = new Map<string, string>();

  constructor(options: SkillServiceOptions) {
    this.paths = options.paths;
    this.tasks = options.tasks;
    this.events = options.events;
  }

  /**
   * Loads one Skill authorized to the agent from the frozen snapshot. The
   * first successful load appends `skill_loaded`; repeated loads of the same
   * hash return the content without a duplicate event. Failures are typed,
   * non-retryable and confined to the current node.
   */
  async loadAuthorized(taskId: string, agentId: string, skillId: string): Promise<LoadedSkill> {
    const frozen = await this.frozenFor(taskId);
    const skill = this.authorizedSkill(frozen, agentId, skillId);
    const { content, versionHash } = await this.readSnapshotSkill(taskId, skill);

    const key = `${taskId}:${agentId}:${skillId}`;
    const recorded = this.loadedHashes.get(key);
    if (recorded !== undefined && recorded !== versionHash) {
      throw new RuntimeFailure(
        SKILL_ERROR_CODES.SKILL_CONTENT_CHANGED,
        '技能内容在加载后发生变化，当前节点无法继续。',
        false,
      );
    }

    const committed = await this.events.read(taskId);
    const alreadyLoaded = (attributeSkillLoads(committed.map((entry) => entry.event)).get(agentId) ?? [])
      .includes(skillId);
    if (!alreadyLoaded) {
      await this.events.append(taskId, {
        id: randomUUID(),
        at: new Date().toISOString(),
        type: 'skill_loaded',
        skillId,
      });
    }
    this.loadedHashes.set(key, versionHash);
    return { id: skillId, content, versionHash };
  }

  /**
   * Rebuilds the Skills an agent has already loaded, from committed events
   * and the frozen snapshot. Supplies `AgentTurnInput.loadedSkills` after a
   * restart; never appends events.
   */
  async loadedSkillsFor(taskId: string, agentId: string): Promise<LoadedSkill[]> {
    const frozen = await this.frozenFor(taskId);
    const committed = await this.events.read(taskId);
    const skillIds = attributeSkillLoads(committed.map((entry) => entry.event)).get(agentId) ?? [];
    const loaded: LoadedSkill[] = [];
    for (const skillId of skillIds) {
      const skill = this.authorizedSkill(frozen, agentId, skillId);
      const { content, versionHash } = await this.readSnapshotSkill(taskId, skill);
      const key = `${taskId}:${agentId}:${skillId}`;
      const recorded = this.loadedHashes.get(key);
      if (recorded !== undefined && recorded !== versionHash) {
        throw new RuntimeFailure(
          SKILL_ERROR_CODES.SKILL_CONTENT_CHANGED,
          '技能内容在加载后发生变化，当前节点无法继续。',
          false,
        );
      }
      this.loadedHashes.set(key, versionHash);
      loaded.push({ id: skillId, content, versionHash });
    }
    return loaded;
  }

  /**
   * Reads one declared Skill's snapshot content for display only (plan Phase
   * E Task 3): the first frozen agent declaring the skill supplies the file,
   * the snapshot containment read is reused, every `RuntimeFailure` maps to
   * null and no event is ever appended. Storage-level errors (task identity
   * unreadable) propagate so the service can pass them through.
   */
  async readSkillForDisplay(taskId: string, skillId: string): Promise<SkillContent | null> {
    const frozen = await this.frozenFor(taskId);
    let skill: FrozenSkill | undefined;
    for (const agent of frozen.agents) {
      skill = agent.skills.find((candidate) => candidate.id === skillId);
      if (skill !== undefined) {
        break;
      }
    }
    if (skill === undefined) {
      return null;
    }
    try {
      const { content, versionHash } = await this.readSnapshotSkill(taskId, skill);
      return { skillId, content, versionHash };
    } catch (error) {
      if (error instanceof RuntimeFailure) {
        return null;
      }
      throw error;
    }
  }

  /**
   * The frozen manifest of one task, revalidated against the version hash
   * stored in `task.json` on first access (spec §4.4) and cached for the
   * process lifetime: the snapshot never changes for a live task.
   */
  private async frozenFor(taskId: string): Promise<FrozenTemplate> {
    const cached = this.frozenCache.get(taskId);
    if (cached !== undefined) {
      return cached;
    }
    const frozen = await this.tasks.readFrozenTemplate(taskId);
    this.frozenCache.set(taskId, frozen);
    return frozen;
  }

  /** Resolves the manifest entry or fails the node as unauthorized. */
  private authorizedSkill(
    frozen: FrozenTemplate,
    agentId: string,
    skillId: string,
  ): FrozenSkill {
    const agent = frozen.agents.find((candidate) => candidate.id === agentId);
    const skill = agent?.skills.find((candidate) => candidate.id === skillId);
    if (agent === undefined || skill === undefined) {
      throw new RuntimeFailure(
        SKILL_ERROR_CODES.SKILL_NOT_AUTHORIZED,
        '该 Agent 未获得此技能的授权。',
        false,
      );
    }
    return skill;
  }

  /**
   * Reads one authorized Skill file confined to the frozen snapshot. The
   * containment check runs on the resolved path and again after `realpath`,
   * so symlinks escaping the snapshot are rejected (plan Task 3 Step 3).
   */
  private async readSnapshotSkill(
    taskId: string,
    skill: FrozenSkill,
  ): Promise<{ content: string; versionHash: string }> {
    const snapshotRoot = this.paths.taskSnapshotRoot(taskId);
    const contentPath = skill.contentPath;
    if (isAbsolute(contentPath) || contentPath.includes('\0')) {
      throw new RuntimeFailure(
        SKILL_ERROR_CODES.SKILL_PATH_UNSAFE,
        '技能文件必须位于任务快照之内。',
        false,
      );
    }
    const resolved = resolve(snapshotRoot, contentPath);
    if (resolved !== snapshotRoot && !resolved.startsWith(snapshotRoot + sep)) {
      throw new RuntimeFailure(
        SKILL_ERROR_CODES.SKILL_PATH_UNSAFE,
        '技能文件必须位于任务快照之内。',
        false,
      );
    }
    let real: string;
    let realRoot: string;
    try {
      real = await realpath(resolved);
      realRoot = await realpath(snapshotRoot);
    } catch {
      throw new RuntimeFailure(
        SKILL_ERROR_CODES.SKILL_MISSING,
        '技能文件缺失或不可读，当前节点无法继续。',
        false,
      );
    }
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      throw new RuntimeFailure(
        SKILL_ERROR_CODES.SKILL_PATH_UNSAFE,
        '技能文件必须位于任务快照之内。',
        false,
      );
    }
    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      fileStat = await stat(real);
    } catch {
      throw new RuntimeFailure(
        SKILL_ERROR_CODES.SKILL_MISSING,
        '技能文件缺失或不可读，当前节点无法继续。',
        false,
      );
    }
    if (!fileStat.isFile()) {
      throw new RuntimeFailure(
        SKILL_ERROR_CODES.SKILL_MISSING,
        '技能文件缺失或不可读，当前节点无法继续。',
        false,
      );
    }
    let content: string;
    try {
      content = await readFile(real, 'utf8');
    } catch {
      throw new RuntimeFailure(
        SKILL_ERROR_CODES.SKILL_MISSING,
        '技能文件缺失或不可读，当前节点无法继续。',
        false,
      );
    }
    return { content, versionHash: sha256(content) };
  }
}
