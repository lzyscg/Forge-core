import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  SealRecord,
  StructuredIssuePageV1,
  StructuredSlotOutlinePageV1,
  StructuredSlotPublicContractV1,
  StructuredSlotReadResponseV1,
  TaskWorkspace,
} from '../../shared/contracts';
import { renderProductionPage, stubGateway, workspaceWithReturnLoop } from '../test-support';

afterEach(() => {
  vi.restoreAllMocks();
});

const CONTRACT: StructuredSlotPublicContractV1 = {
  version: 1,
  slotTypes: [
    { id: 'document', name: 'Document', description: 'root', specSchema: { type: 'object' }, content: { presence: 'forbidden' } },
    { id: 'title', name: 'Title', description: 'leaf', specSchema: { type: 'object' }, content: { presence: 'required', schema: { type: 'string' } } },
    { id: 'body', name: 'Body', description: 'leaf', specSchema: { type: 'object' }, content: { presence: 'required', schema: { type: 'string' } } },
  ],
  layoutGrammar: { rootType: 'document', productions: {} },
  limits: {
    schema: { maxSchemaDepth: 4, maxSchemaNodes: 1024, maxEnumItems: 64, maxPatternLength: 128 },
    structure: { maxSlots: 2500, maxTreeDepth: 8, maxChildrenPerSlot: 250 },
    payload: { maxSpecBytesPerSlot: 16384, maxContentBytesPerSlot: 262144, maxScaffoldPayloadBytes: 16777216 },
    draft: { maxChangedSlots: 500, maxDraftBytes: 4194304 },
    attempt: {
      maxSlotToolCallsPerAttempt: 128,
      maxValidationRunsPerAttempt: 4,
      maxValidatorInvocationsPerAttempt: 10000,
      maxAggregateValidatorCpuMsPerAttempt: 60000,
      maxAggregateValidatorWallClockMsPerAttempt: 120000,
      maxValidatorOutputBytesPerAttempt: 4194304,
      maxAttemptWallClockMs: 150000,
    },
    validation: {
      maxValidators: 16,
      maxValidatorInvocationsPerGate: 2500,
      maxAggregateValidatorCpuMsPerGate: 15000,
      maxAggregateValidatorWallClockMsPerGate: 30000,
      maxValidatorOutputBytesPerGate: 1048576,
      maxIssuesPerRun: 125,
    },
    output: { maxArtifactFiles: 16, maxArtifactBytesPerFile: 4194304, maxTotalArtifactBytes: 16777216 },
  },
  abiProfileIdentity: {
    validatorAbi: 'forge-validator/v1',
    assemblerAbi: 'forge-assembler/v1',
    profileIdentity: 'forge-structured-runtime/v1',
  },
  semanticDigest: 'c'.repeat(64),
};

const OUTLINE: StructuredSlotOutlinePageV1 = {
  entries: [
    { slotId: 'root', typeId: 'document', contentPresence: 'unset', parentSlotId: null, shell: false, level: 'content', spec: { type: 'object' } },
    { slotId: 'title', typeId: 'title', contentPresence: 'set', parentSlotId: 'root', shell: false, level: 'content', spec: { type: 'object' } },
  ],
  nextCursor: null,
};

const SLOT_READ: StructuredSlotReadResponseV1 = {
  slot: {
    slotId: 'title',
    typeId: 'title',
    contentPresence: 'set',
    level: 'content',
    spec: { type: 'object' },
    content: 'The Title',
    ancestors: [{ slotId: 'root', typeId: 'document', contentPresence: 'unset' }],
  },
};

const ISSUES: StructuredIssuePageV1 = {
  issues: [
    {
      version: 1,
      code: 'DRAFT_STALE',
      severity: 'error',
      phase: 'merge',
      source: 'lifecycle',
      message: 'DRAFT_STALE (merge)',
      primaryLocation: { kind: 'operation' },
      relatedLocations: [],
      details: {},
    },
  ],
  nextCursor: null,
};

const SEAL: SealRecord = {
  sealId: 'seal-1',
  caseId: 'task-structured',
  scaffoldId: 'scaffold-1',
  scaffoldRevision: 1,
  scaffoldTreeHash: 'a'.repeat(64),
  templateId: 'structured-valid',
  templateVersion: 'v1',
  snapshotHash: 'b'.repeat(64),
  assemblerId: 'render',
  assemblerVersion: 'v1',
  artifactVersionRef: { artifactId: 'artifact-1', version: 3 },
  outputs: [{ routeId: 'document-md', path: 'document.md', mediaType: 'text/markdown; charset=utf-8', byteLength: 120, sha256: 'c'.repeat(64) }],
  sealedAt: '2026-08-05T00:00:00.000Z',
};

function structuredWorkspace(): TaskWorkspace {
  const base = workspaceWithReturnLoop();
  return {
    ...base,
    task: { ...base.task, id: 'task-structured' },
    structuredSlots: {
      version: 1,
      mode: 'structured_slots',
      scaffoldId: 'scaffold-1',
      generationId: 'gen-1',
      contentRevision: 0,
      structureStatus: 'active',
      sealStatus: 'sealed',
      visibleSlotCount: 2,
      filledSlotCount: 1,
      issueSummary: { errors: 1, warnings: 0 },
    },
  };
}

describe('StructuredSlotDrawer (read-only 结构 drawer)', () => {
  it('shows no Structure button for a basic task', async () => {
    renderProductionPage(workspaceWithReturnLoop());
    await screen.findByTestId('workspace-canvas');
    expect(screen.queryByRole('button', { name: '结构' })).toBeNull();
  });

  it('opens a read-only tree for a structured task and loads one slot on selection', async () => {
    const workspace = structuredWorkspace();
    const getStructuredSlot = vi.fn(async () => SLOT_READ);
    const gateway = stubGateway({
      getWorkspace: async () => workspace,
      getStructuredContract: async () => CONTRACT,
      listStructuredSlots: async () => OUTLINE,
      getStructuredSlot,
      listStructuredIssues: async () => ISSUES,
      getStructuredSeal: async () => SEAL,
    });
    renderProductionPage(workspace, gateway);

    const toggle = await screen.findByRole('button', { name: '结构' });
    await userEvent.click(toggle);

    const drawer = await screen.findByRole('complementary', { name: '结构' });
    expect(drawer).toBeVisible();

    // Tree outline entries render.
    expect(within(drawer).getByText('document')).toBeVisible();
    const titleEntry = within(drawer).getByText('title');
    expect(titleEntry).toBeVisible();

    // Selecting one entry loads exactly that slot.
    await userEvent.click(titleEntry);
    await waitFor(() => expect(getStructuredSlot).toHaveBeenCalledTimes(1));
    expect(getStructuredSlot).toHaveBeenCalledWith('task-structured', 'title');

    // The slot detail renders spec, content and status.
    expect(await within(drawer).findByText('The Title')).toBeVisible();
    expect(within(drawer).getAllByText(/type": "object/).length).toBeGreaterThan(0);
    expect(within(drawer).getByText(/content: set/)).toBeVisible();

    // Issues render.
    expect(within(drawer).getByText('DRAFT_STALE')).toBeVisible();

    // The sealed artifact is linked by version.
    expect(within(drawer).getByRole('link', { name: /V3/ })).toHaveAttribute(
      'href',
      '#artifact-artifact-1',
    );
  });

  it('has no textbox, drag handle, save or merge control', async () => {
    const workspace = structuredWorkspace();
    const gateway = stubGateway({
      getWorkspace: async () => workspace,
      getStructuredContract: async () => CONTRACT,
      listStructuredSlots: async () => OUTLINE,
      getStructuredSlot: async () => SLOT_READ,
      listStructuredIssues: async () => ISSUES,
      getStructuredSeal: async () => SEAL,
    });
    renderProductionPage(workspace, gateway);
    await userEvent.click(await screen.findByRole('button', { name: '结构' }));
    const drawer = await screen.findByRole('complementary', { name: '结构' });

    expect(within(drawer).queryByRole('textbox')).toBeNull();
    expect(within(drawer).queryByLabelText(/拖拽|drag/i)).toBeNull();
    expect(within(drawer).queryByRole('button', { name: /保存|save/i })).toBeNull();
    expect(within(drawer).queryByRole('button', { name: /合并|merge/i })).toBeNull();
  });
});
