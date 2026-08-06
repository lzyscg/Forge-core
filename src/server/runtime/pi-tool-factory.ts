/**
 * The six Forge custom tools as buffer-only Pi ToolDefinitions (plan Phase
 * C Task 2 Step 5; reshaped for the production/dispatch turn contract by
 * plan 2026-08-04 Task 4, spec §5.1/§5.2).
 *
 * Each tool's TypeBox parameters mirror the frozen Task 1 action fields
 * exactly; `execute` semantically validates the proposal through
 * `validateForgeAction`, proposes it to the current Turn's ActionBuffer and
 * returns a short public acknowledgement. The phase-aware buffer rejects
 * illegal phase transitions immediately with stable codes (dispatch before
 * `finish_production`, production work after sealing, a second dispatch),
 * so the model can self-correct within the same Turn; the ActionCommitter
 * revalidates the final set as the non-bypassable boundary. Tool callbacks
 * hold only the buffer — no CoreService, EventStore, ArtifactStore or
 * scheduler handle is ever injected (global constraint). Invalid or late
 * proposals are rejected back to the model with stable codes instead of
 * throwing; only a completely successful Turn commits anything.
 */
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type, type Static, type TSchema } from 'typebox';
import { ActionBufferError, type ActionBuffer } from './action-buffer';
import {
  ACTION_VALIDATION_CODES,
  FORGE_ACTION_LIMITS,
  ForgeActionValidationError,
  PUBLISH_WORKSPACE_FILE_MAX_LENGTH,
  PRODUCTION_PACKAGE_REF,
  validateForgeAction,
  type ForgeActionName,
} from './forge-actions';

/** Short text fields: question / title (Task 1 limits). */
const shortText = () => Type.String({ minLength: 1, maxLength: FORGE_ACTION_LIMITS.shortText });

/** Identifier fields: skillId / targetAgentId / artifactType. */
const idField = () => Type.String({ minLength: 1, maxLength: FORGE_ACTION_LIMITS.id });

/** Sealed package content (Task 1 limit). */
const contentField = () => Type.String({ minLength: 1, maxLength: FORGE_ACTION_LIMITS.content });

/** Sealed-package publication metadata; null for message-only packages. */
const optionalMetadata = (field: () => TSchema) => Type.Optional(Type.Union([field(), Type.Null()]));

const formatField = () =>
  Type.Optional(Type.Union([Type.Literal('markdown'), Type.Literal('text')]));

/** Dispatch actions reference the sealed package with exactly `current`. */
const PRODUCTION_PACKAGE_REF_PARAMETERS = Type.Object({
  productionPackageRef: Type.Literal(PRODUCTION_PACKAGE_REF),
});

const LOAD_SKILL_PARAMETERS = Type.Object({
  skillId: idField(),
});

/**
 * `finish_production` seals the turn's one production package (spec §4.3):
 * inline content, a private workspace file, or the platform-resolved
 * reference to the received input artifact. Format/metadata belong to the
 * production phase; dispatch tools never carry them.
 */
const FINISH_PRODUCTION_PARAMETERS = Type.Object({
  source: Type.Union([
    Type.Literal('inline'),
    Type.Literal('workspace_file'),
    Type.Literal('current_input_artifact'),
  ]),
  content: optionalMetadata(contentField),
  workspaceFile: optionalMetadata(() =>
    Type.String({ minLength: 1, maxLength: PUBLISH_WORKSPACE_FILE_MAX_LENGTH }),
  ),
  format: formatField(),
  artifactType: optionalMetadata(idField),
  title: optionalMetadata(shortText),
});

const SEND_MESSAGE_PARAMETERS = Type.Object({
  targetAgentId: idField(),
  productionPackageRef: Type.Literal(PRODUCTION_PACKAGE_REF),
});

const PUBLISH_ARTIFACT_PARAMETERS = PRODUCTION_PACKAGE_REF_PARAMETERS;

const SUBMIT_FINAL_ARTIFACT_PARAMETERS = PRODUCTION_PACKAGE_REF_PARAMETERS;

const REQUEST_HUMAN_INPUT_PARAMETERS = Type.Object({
  question: shortText(),
});

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
      'Seal this turn\'s production package exactly once. Choose source "inline" with content, "workspace_file" with a relative file you wrote to your private workspace, or "current_input_artifact" to seal the artifact received with the current input (the platform resolves it; never supply versions). Provide format plus artifactType and title when the package may be published as an artifact; they may be null for message-only packages. After sealing, only exactly one dispatch action may follow.',
    promptSnippet:
      'finish_production(source: inline | workspace_file | current_input_artifact, …) — seal the production package; call exactly once',
    parameters: FINISH_PRODUCTION_PARAMETERS,
  },
  {
    name: 'send_message',
    description:
      'Deliver the sealed production package as a public message to one of the agents declared in the template. Requires finish_production first; pass productionPackageRef "current" and targetAgentId — the target must be the agent\'s declared id (e.g. "writer"), never its display name; choose exactly one target from the candidates the task describes. The message body comes from the sealed package. Exactly one dispatch action per turn.',
    promptSnippet:
      'send_message(targetAgentId, productionPackageRef: "current") — route the sealed package to one declared agent by its id',
    parameters: SEND_MESSAGE_PARAMETERS,
  },
  {
    name: 'publish_artifact',
    description:
      'Publish the sealed production package as one artifact version and route it along the template artifact edges. Requires finish_production first (it supplies content, format, artifactType and title); pass productionPackageRef "current" only. The platform assigns identity and version at commit time; do not include ids, versions, timestamps or paths. Exactly one dispatch action per turn.',
    promptSnippet:
      'publish_artifact(productionPackageRef: "current") — publish the sealed package as an artifact version',
    parameters: PUBLISH_ARTIFACT_PARAMETERS,
  },
  {
    name: 'submit_final_artifact',
    description:
      'Submit the sealed production package as the task\x27s final output. Use this when you are approving content as complete and want to finalize the task - this is the ONLY way to complete the task. Do NOT use send_message to say "approved" or "passed" - call this tool instead. Requires finish_production first with source "current_input_artifact" (to seal the received artifact you are approving); pass productionPackageRef "current" only. The system validates finality independently; natural language cannot complete the task. Exactly one dispatch action per turn.',
    promptSnippet:
      'submit_final_artifact(productionPackageRef: "current") — request system final validation of the sealed package',
    parameters: SUBMIT_FINAL_ARTIFACT_PARAMETERS,
  },
  {
    name: 'request_human_input',
    description:
      'Pause the task and ask the human one question. Either call it as the very first action of the turn (direct interrupt, no sealed package needed) or after finish_production as the single dispatch action; nothing may follow it.',
    promptSnippet:
      'request_human_input(question) — pause and ask the human one question (sole first action, or the one dispatch after sealing)',
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
 * Reads the full content of one authorized skill for the current Turn's
 * task/agent. When provided, `load_skill` returns the full skill text in its
 * tool result so the model can act on it in the SAME Turn (the persistence
 * injection next Turn stays in place). An unauthorized read (null) rejects the
 * proposal without buffering. When absent (a runtime that does not wire a
 * reader), `load_skill` keeps the legacy short acknowledgement for backward
 * compatibility with existing harnesses.
 */
export interface ForgeToolFactoryOptions {
  readSkillContent?: (skillId: string) => Promise<{ content: string; versionHash: string } | null>;
}

function accepted(acknowledgement: string): ForgeToolResult {
  return { content: [{ type: 'text', text: acknowledgement }], details: { accepted: true } };
}

function rejected(code: string, name: ForgeActionName): ForgeToolResult {
  // Short public acknowledgement only — no task/version/engineering fields.
  return {
    content: [{ type: 'text', text: `${name} rejected: ${code}` }],
    details: { accepted: false, code },
  };
}

/**
 * Creates the closed six-tool set bound to one Turn's ActionBuffer. A fresh
 * set is created for every Turn; tool callbacks never outlive their buffer.
 *
 * `load_skill` is the one tool whose result carries live content: when a
 * `readSkillContent` reader is wired, it reads the authorized skill and
 * returns the full text so the model can use it this Turn (an unauthorized
 * read rejects without proposing). Without a reader the tool keeps the legacy
 * short acknowledgement. The other tools always propose-then-acknowledge;
 * buffer phase violations come back as correctable rejections (spec §5.3).
 */
export function createForgeToolDefinitions(
  buffer: ActionBuffer,
  options: ForgeToolFactoryOptions = {},
): ToolDefinition[] {
  const { readSkillContent } = options;
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
