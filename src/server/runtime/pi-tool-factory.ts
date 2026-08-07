/**
 * The nine Forge custom tools as buffer-only Pi ToolDefinitions (plan
 * 2026-08-07 Phase 2; v7 artifact version directory schema, spec §4/§5.1).
 *
 * Each tool's TypeBox parameters mirror the frozen action fields exactly;
 * `execute` semantically validates the proposal through `validateForgeAction`,
 * proposes it to the current Turn's ActionBuffer (for the propose actions) and
 * returns a short public acknowledgement. The phase-aware buffer rejects
 * illegal phase transitions immediately with stable codes, so the model can
 * self-correct within the same Turn; the ActionCommitter revalidates the final
 * set as the non-bypassable boundary. Tool callbacks hold only the buffer and
 * the read hooks — no CoreService, EventStore, ArtifactStore or scheduler
 * handle is ever injected (global constraint).
 *
 * `load_skill` and `read_artifact_version` are read tools: when their readers
 * are wired they return live content in the tool result so the model can act
 * on it this Turn; an unauthorized/unavailable read rejects without
 * proposing. The remaining tools propose-then-acknowledge.
 */
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type, type Static, type TSchema } from 'typebox';
import { ActionBufferError, type ActionBuffer } from './action-buffer';
import { parseAnnotateVerdict, ANNOTATE_FRONTMATTER_INVALID } from './annotate-verdict';
import {
  ACTION_VALIDATION_CODES,
  FORGE_ACTION_LIMITS,
  ForgeActionValidationError,
  PUBLISH_WORKSPACE_FILE_MAX_LENGTH,
  validateForgeAction,
  type ForgeActionName,
} from './forge-actions';

/** Short text fields: question / title / summary. */
const shortText = () => Type.String({ minLength: 1, maxLength: FORGE_ACTION_LIMITS.shortText });

/** Identifier fields: skillId / targetAgentId / artifactType / file name. */
const idField = () => Type.String({ minLength: 1, maxLength: FORGE_ACTION_LIMITS.id });

/** Sealed-package content (per file). */
const contentField = () => Type.String({ minLength: 1, maxLength: FORGE_ACTION_LIMITS.content });

const optionalMetadata = (field: () => TSchema) => Type.Optional(Type.Union([field(), Type.Null()]));

const formatField = () =>
  Type.Optional(Type.Union([Type.Literal('markdown'), Type.Literal('text')]));

const fileField = () => Type.String({ minLength: 1, maxLength: FORGE_ACTION_LIMITS.id });

const LOAD_SKILL_PARAMETERS = Type.Object({ skillId: idField() });

const FINISH_FILE = Type.Object({
  name: fileField(),
  content: optionalMetadata(contentField),
  workspaceFile: optionalMetadata(() =>
    Type.String({ minLength: 1, maxLength: PUBLISH_WORKSPACE_FILE_MAX_LENGTH }),
  ),
});

/**
 * `finish_production` seals the turn's multi-file production package (spec §4):
 * inline content or private workspace files. Format/metadata belong to the
 * production phase; dispatch tools never carry them.
 */
const FINISH_PRODUCTION_PARAMETERS = Type.Object({
  source: Type.Union([Type.Literal('inline'), Type.Literal('workspace_file')]),
  files: Type.Array(FINISH_FILE, { minItems: 1 }),
  format: formatField(),
  artifactType: optionalMetadata(idField),
  title: optionalMetadata(shortText),
});

const ANNOTATE_ARTIFACT_PARAMETERS = Type.Object({
  file: fileField(),
  content: contentField(),
});

const READ_ARTIFACT_VERSION_PARAMETERS = Type.Object({ file: fileField() });

const FORWARD_INPUT_VERSION_PARAMETERS = Type.Object({ targetAgentId: idField() });

const SEND_MESSAGE_PARAMETERS = Type.Object({
  targetAgentId: idField(),
  summary: shortText(),
});

const REQUEST_HUMAN_INPUT_PARAMETERS = Type.Object({ question: shortText() });

interface ForgeToolSpec {
  name: ForgeActionName;
  description: string;
  promptSnippet: string;
  parameters: TSchema;
}

/** Neutral platform descriptions — zero business vocabulary (iron rule 1). */
const TOOL_SPECS: ForgeToolSpec[] = [
  {
    name: 'load_skill',
    description:
      'Request the full content of an authorized skill by id. Only skills listed as authorized for this agent can be loaded, and only before the production package is sealed.',
    promptSnippet: 'load_skill(skillId) — load one authorized skill by id (production phase only)',
    parameters: LOAD_SKILL_PARAMETERS,
  },
  {
    name: 'finish_production',
    description:
      'Seal this turn\'s multi-file production package exactly once (production turns only). Pass source "inline" with one file per {name, content}, or "workspace_file" with one {name, workspaceFile} per file you wrote to your private workspace. Provide format plus artifactType and title. After sealing, only exactly one dispatch (publish_artifact) may follow.',
    promptSnippet:
      'finish_production(source, files: [{name, content} | {name, workspaceFile}], format, artifactType, title) — seal the package; call exactly once',
    parameters: FINISH_PRODUCTION_PARAMETERS,
  },
  {
    name: 'annotate_artifact',
    description:
      'Annotate one file (e.g. review.md) of the artifact version received with the current input. Operate turns only; the file content must carry a frontmatter `verdict: pass | reject`. At most one annotation per (version, file); annotate before your one dispatch.',
    promptSnippet: 'annotate_artifact(file, content) — annotate the input version (operate turns)',
    parameters: ANNOTATE_ARTIFACT_PARAMETERS,
  },
  {
    name: 'read_artifact_version',
    description:
      'Read one file of the artifact version received with the current input. Returns the file content for this Turn; never proposes or commits anything.',
    promptSnippet: 'read_artifact_version(file) — read one file of the input version',
    parameters: READ_ARTIFACT_VERSION_PARAMETERS,
  },
  {
    name: 'publish_artifact',
    description:
      'Publish the sealed production package as one artifact version and route it along the template artifact edges. Requires finish_production first. The platform assigns identity and version at commit time; do not include ids, versions, timestamps or paths. Exactly one dispatch action per turn (production turns).',
    promptSnippet: 'publish_artifact() — publish the sealed package as an artifact version',
    parameters: Type.Object({}),
  },
  {
    name: 'forward_input_version',
    description:
      'Forward the input artifact version to one declared artifact-edge target (operate turns). Zero-copy: no new version is created. Pass targetAgentId — the target must be the agent\'s declared id (e.g. "controller"). Exactly one dispatch action per turn.',
    promptSnippet: 'forward_input_version(targetAgentId) — forward the input version along one artifact edge',
    parameters: FORWARD_INPUT_VERSION_PARAMETERS,
  },
  {
    name: 'submit_final_artifact',
    description:
      'Submit the input artifact version as the task\'s final output (operate/coordinate turns). Use this when you are approving the received content as complete; this is the ONLY way to complete the task. The platform resolves the version from the input; do not supply ids/versions. The system validates finality independently; natural language cannot complete the task. Exactly one dispatch action per turn.',
    promptSnippet: 'submit_final_artifact() — submit the input version as final output',
    parameters: Type.Object({}),
  },
  {
    name: 'send_message',
    description:
      'Deliver a short coordination message to one declared target agent. Pass targetAgentId (the agent\'s declared id, e.g. "writer") and a short summary body. The input version (if any) propagates to the target. Exactly one dispatch action per turn.',
    promptSnippet: 'send_message(targetAgentId, summary) — route a short message to one declared agent by id',
    parameters: SEND_MESSAGE_PARAMETERS,
  },
  {
    name: 'request_human_input',
    description:
      'Pause the task and ask the human one question. Call it as the very first action of the turn (direct interrupt) or after finish_production/annotate_artifact as the single dispatch; nothing may follow it.',
    promptSnippet: 'request_human_input(question) — pause and ask the human one question',
    parameters: REQUEST_HUMAN_INPUT_PARAMETERS,
  },
];

interface ForgeToolDetails {
  accepted: boolean;
  code?: string;
}

interface ForgeToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: ForgeToolDetails;
}

/**
 * Read hooks for the two read-only tools. `readSkillContent` returns the full
 * skill text for an authorized id (null rejects); `readArtifactVersionFile`
 * returns one file of the input version (null when no input version).
 */
export interface ForgeToolFactoryOptions {
  readSkillContent?: (skillId: string) => Promise<{ content: string; versionHash: string } | null>;
  readArtifactVersionFile?: (file: string) => Promise<string | null>;
}

function accepted(acknowledgement: string): ForgeToolResult {
  return { content: [{ type: 'text', text: acknowledgement }], details: { accepted: true } };
}

function rejected(code: string, name: ForgeActionName): ForgeToolResult {
  return {
    content: [{ type: 'text', text: `${name} rejected: ${code}` }],
    details: { accepted: false, code },
  };
}

/**
 * Creates the closed nine-tool set bound to one Turn's ActionBuffer. A fresh
 * set is created for every Turn; tool callbacks never outlive their buffer.
 */
export function createForgeToolDefinitions(
  buffer: ActionBuffer,
  options: ForgeToolFactoryOptions = {},
): ToolDefinition[] {
  const { readSkillContent, readArtifactVersionFile } = options;
  return TOOL_SPECS.map((spec) => ({
    name: spec.name,
    label: spec.name,
    description: spec.description,
    promptSnippet: spec.promptSnippet,
    parameters: spec.parameters,
    executionMode: 'sequential' as const,
    execute: async (
      _toolCallId: string,
      params: Static<TSchema>,
    ): Promise<ForgeToolResult> => {
      try {
        const action = validateForgeAction({
          type: spec.name,
          ...(params as Record<string, unknown>),
        });
        if (action.type === 'load_skill' && readSkillContent !== undefined) {
          const loaded = await readSkillContent(action.skillId);
          if (loaded === null) {
            return rejected('SKILL_NOT_AUTHORIZED', spec.name);
          }
          buffer.propose(action);
          return accepted(
            `load_skill accepted (${action.skillId}@${loaded.versionHash.slice(0, 12)}):\n${loaded.content}`,
          );
        }
        if (action.type === 'read_artifact_version') {
          if (readArtifactVersionFile === undefined) {
            return accepted('read_artifact_version acknowledged (no reader wired)');
          }
          const content = await readArtifactVersionFile(action.file);
          if (content === null) {
            return rejected('FINAL_ARTIFACT_NOT_FOUND', spec.name);
          }
          return accepted(`read_artifact_version (${action.file}):\n${content}`);
        }
        if (action.type === 'annotate_artifact') {
          // Model-facing format contract (semantic audit P1, plan 2026-08-07):
          // reject malformed review frontmatter here so the model can correct
          // in the same Turn; the committer re-checks it non-bypassably.
          if (parseAnnotateVerdict(action.content) === null) {
            return rejected(ANNOTATE_FRONTMATTER_INVALID, spec.name);
          }
        }
        buffer.propose(action);
        return accepted(`${spec.name} proposal accepted`);
      } catch (error) {
        if (error instanceof ForgeActionValidationError) {
          return rejected(error.code, spec.name);
        }
        if (error instanceof ActionBufferError) {
          return rejected(error.code, spec.name);
        }
        return rejected(ACTION_VALIDATION_CODES.ACTION_NOT_OBJECT, spec.name);
      }
    },
  }));
}
