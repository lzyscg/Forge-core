/**
 * TDD: Authoritative v2 structured review drawer (spec §15 / design §20).
 *
 * Version dispatch (production-page.tsx):
 * - v1 stays on StructuredSlotDrawer (existing test coverage stays untouched).
 * - v2 renders StructuredReviewDrawer with six tabs (Overview/Slot tree/
 *   Relationship/Review/Findings/Seal).
 *
 * Read-only invariant: the v2 UI never calls a mutation gateway method.
 *
 * Tree: lazy-load children, fixed snapshot traversal, windowed visible rows,
 * "newer events" prompt when a newer snapshot is detected.
 *
 * Relationship: disabled mode OR zero relations displays "本 Map 未使用关系网"
 * and is not an error.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AuthoritativeCandidateDetailV2,
  AuthoritativeFindingSummaryV2,
  AuthoritativeLocateResultV2,
  AuthoritativeMapDetailV2,
  AuthoritativeRelationReviewDetailV2,
  AuthoritativeReviewRoundSummaryV2,
  AuthoritativeReviewSummaryV2,
  AuthoritativeSealReadinessDetailV2,
  AuthoritativeSlotReviewDetailV2,
  AuthoritativeTreePageV2,
  CollectionPageV2,
  SnapshotCursorV2,
} from '../../../shared/authoritative-review-v2';
import type { TaskWorkspace } from '../../../shared/contracts';
import { recordingGateway, renderProductionPage, stubGateway, workspaceWithReturnLoop } from '../../test-support';

afterEach(() => {
  vi.restoreAllMocks();
});

const SNAPSHOT_CURSOR: SnapshotCursorV2 = {
  version: 2,
  keyId: 'key-1',
  token: 'token-1',
};

function makeRef(kind: 'map_snapshot' | 'map_review_bundle' | 'seal_record' | 'artifact' | 'artifact_custody' | 'content_version' | 'content_value', tag: string): import('../../../shared/authoritative-review-v2').BlobRefV2 {
  return {
    kind,
    digest: 'a'.repeat(64),
    byteLength: 256,
    mediaType: 'application/json',
    schemaVersion: 1,
    digestLabel: tag,
  } as unknown as import('../../../shared/authoritative-review-v2').BlobRefV2;
}

function v2Workspace(): TaskWorkspace {
  const base = workspaceWithReturnLoop();
  return {
    ...base,
    task: {
      ...base.task,
      id: 'task-v2',
      status: 'running',
      structuredProtocol: 'v2',
    },
    authoritativeReview: {
      version: 2,
      executionEligibility: { state: 'eligible', frozenProfileDigest: 'a'.repeat(64), currentProfileDigest: 'a'.repeat(64) },
      pendingQuestion: null,
    },
  };
}

const MAP_DETAIL: AuthoritativeMapDetailV2 = {
  mapId: 'map-1',
  mapRevision: 1,
  mapSemanticDigest: 'b'.repeat(64),
  supersedesMapId: null,
  mapSnapshotRef: makeRef('map_snapshot', 'map-snap'),
  mapReviewBundleRef: makeRef('map_review_bundle', 'map-bundle'),
  candidateRef: null,
  rootSlotId: 'root',
  nodeCount: 24,
  relationCount: 3,
  relation: { mode: 'optional', relationCount: 3 },
};

const CANDIDATE_DETAIL: AuthoritativeCandidateDetailV2 = {
  candidateId: 'cand-1',
  candidateRef: makeRef('map_snapshot', 'cand'),
  baseMapId: null,
  buildId: 'build-1',
  nodeCount: 24,
  relationCount: 3,
};

const TREE_ROOT: AuthoritativeTreePageV2 = {
  parentId: null,
  hasMoreChildren: false,
  items: [
    { slotId: 'intro', slotType: 'paragraph', documentOrder: 0, siblingOrder: 0, contentBearing: true, childCount: 1, review: { mapPreReview: 'pass', content: 'pass' } },
    { slotId: 'body', slotType: 'paragraph', documentOrder: 1, siblingOrder: 1, contentBearing: true, childCount: 0, review: { mapPreReview: 'pass', content: 'reject' } },
  ],
  nextCursor: null,
};

const TREE_INTRO_CHILDREN: AuthoritativeTreePageV2 = {
  parentId: 'intro',
  hasMoreChildren: false,
  items: [
    { slotId: 'quote', slotType: 'paragraph', documentOrder: 0, siblingOrder: 0, contentBearing: true, childCount: 0, review: { mapPreReview: 'pass', content: 'pass' } },
  ],
  nextCursor: null,
};

const LOCATE_RESULT: AuthoritativeLocateResultV2 = {
  target: { slotId: 'slot-1500', slotType: 'paragraph', documentOrder: 0, siblingOrder: 0, contentBearing: true, childCount: 0, review: { mapPreReview: 'pass', content: 'pass' } },
  ancestors: [
    { slotId: 'root', seekCursor: SNAPSHOT_CURSOR },
    { slotId: 'middle', seekCursor: SNAPSHOT_CURSOR },
    { slotId: 'slot-1500', seekCursor: SNAPSHOT_CURSOR },
  ],
};

const MAP_ROUNDS: CollectionPageV2<AuthoritativeReviewRoundSummaryV2> = {
  items: [
    { reviewRoundId: 'round-map-1', kind: 'map', state: 'settled' },
  ],
  nextCursor: null,
};

const CONTENT_ROUNDS: CollectionPageV2<AuthoritativeReviewRoundSummaryV2> = {
  items: [
    { reviewRoundId: 'round-content-1', kind: 'content', state: 'reviewing_batches' },
    { reviewRoundId: 'round-content-0', kind: 'content', state: 'completed' },
  ],
  nextCursor: null,
};

const REVIEW_SUMMARY: AuthoritativeReviewSummaryV2 = {
  version: 2,
  mapCycleOrdinal: 1,
  contentCycleOrdinal: 1,
  pendingCount: 4,
  passCount: 18,
  rejectCount: 2,
  staleCount: 1,
  openBlockingFindingCount: 2,
  relation: { mode: 'optional', relationCount: 3 },
};

const SLOT_REVIEW: AuthoritativeSlotReviewDetailV2 = {
  slotId: 'body',
  slotType: 'paragraph',
  parentSlotId: 'root',
  documentOrder: 1,
  siblingOrder: 1,
  contentBearing: true,
  review: { mapPreReview: 'pass', content: 'reject' },
  openBlockingFindingIds: ['f-body-1'],
  contentDetail: {
    state: 'set',
    slotRevision: 2,
    taskContentRevision: 3,
    manifestPhase: 'finalized',
    versionRef: makeRef('content_version', 'body-version'),
    contentValueRef: makeRef('content_value', 'body-value'),
    contentDigest: 'b'.repeat(64),
    mediaType: 'text/markdown',
    text: '# Body 正文\n\n这里是当前槽位的真实内容。',
    textLength: 25,
    truncated: false,
  },
};

const RELATION_REVIEW: AuthoritativeRelationReviewDetailV2 = {
  relationId: 'rel-1',
  typeId: 'references',
  fromSlotId: 'intro',
  toSlotId: 'body',
  review: 'violated',
  openBlockingFindingIds: ['f-rel-1'],
};

const FINDINGS: CollectionPageV2<AuthoritativeFindingSummaryV2> = {
  items: [
    {
      findingId: 'f-body-1',
      reviewContext: { kind: 'content', roundId: 'round-content-1' },
      primaryLocation: { kind: 'slot', id: 'body' },
      defectClass: 'content',
      severity: 'blocking',
      source: 'reviewer',
      status: 'open',
    },
  ],
  nextCursor: null,
};

const SEAL_READINESS: AuthoritativeSealReadinessDetailV2 = {
  readiness: 'not_ready',
  unmetConditionCount: 2,
  sealed: false,
  sealRecordRef: null,
  conditions: [
    { code: 'BLOCKING_FINDINGS_CLEAR', detail: '存在 blocking Finding', satisfied: false },
    { code: 'REVIEW_BUNDLE_PRESENT', detail: 'ReviewBundle 已存在', satisfied: true },
    { code: 'MANIFEST_FINALIZED', detail: '内容 manifest 已 finalized', satisfied: false },
  ],
};

const SEAL_READINESS_SEALED: AuthoritativeSealReadinessDetailV2 = {
  readiness: 'ready',
  unmetConditionCount: 0,
  sealed: true,
  sealRecordRef: makeRef('seal_record', 'seal'),
  conditions: [
    { code: 'BLOCKING_FINDINGS_CLEAR', detail: '无 blocking Finding', satisfied: true },
    { code: 'REVIEW_BUNDLE_PRESENT', detail: 'ReviewBundle 已存在', satisfied: true },
    { code: 'MANIFEST_FINALIZED', detail: '内容 manifest 已 finalized', satisfied: true },
  ],
};

function buildGateway(overrides: Partial<Parameters<typeof stubGateway>[0]> = {}) {
  return stubGateway({
    getWorkspace: async () => v2Workspace(),
    getAuthoritativeMap: async () => MAP_DETAIL,
    getAuthoritativeCandidate: async () => CANDIDATE_DETAIL,
    listAuthoritativeTree: async () => TREE_ROOT,
    locateAuthoritativeSlot: async () => LOCATE_RESULT,
    listAuthoritativeMapRounds: async () => MAP_ROUNDS,
    getAuthoritativeReviewSummary: async () => REVIEW_SUMMARY,
    listAuthoritativeRounds: async () => CONTENT_ROUNDS,
    getAuthoritativeSlotReview: async () => SLOT_REVIEW,
    getAuthoritativeRelationReview: async () => RELATION_REVIEW,
    listAuthoritativeFindings: async () => FINDINGS,
    getAuthoritativeSealReadiness: async () => SEAL_READINESS,
    listAuthoritativeIssues: async () => [],
    ...overrides,
  });
}

describe('ProductionPage version dispatch (Task 24)', () => {
  it('shows the Structure button for v2 tasks and opens the v2 drawer', async () => {
    renderProductionPage(v2Workspace(), buildGateway());
    const toggle = await screen.findByRole('button', { name: '结构' });
    await userEvent.click(toggle);
    const drawer = await screen.findByRole('complementary', { name: '结构' });
    expect(within(drawer).getByRole('tablist', { name: '结构抽屉视图' })).toBeVisible();
    expect(within(drawer).getByRole('tab', { name: '总览' })).toBeVisible();
    expect(within(drawer).getByRole('tab', { name: '槽位树' })).toBeVisible();
    expect(within(drawer).getByRole('tab', { name: '关系网' })).toBeVisible();
    expect(within(drawer).getByRole('tab', { name: '审核' })).toBeVisible();
    expect(within(drawer).getByRole('tab', { name: 'Findings' })).toBeVisible();
    expect(within(drawer).getByRole('tab', { name: 'Seal' })).toBeVisible();
  });

  it('overview tab shows current Map, candidate, rounds, coverage and readiness', async () => {
    renderProductionPage(v2Workspace(), buildGateway());
    await userEvent.click(await screen.findByRole('button', { name: '结构' }));
    const drawer = await screen.findByRole('complementary', { name: '结构' });
    const overviewPanel = within(drawer).getByRole('tabpanel', { hidden: false });
    expect(within(overviewPanel).getByText('map-1')).toBeVisible();
    expect(within(overviewPanel).getByText('cand-1')).toBeVisible();
    expect(within(overviewPanel).getByText((text) => text.includes('round-map-1'))).toBeVisible();
    expect(within(overviewPanel).getByText((text) => text.includes('round-content-1'))).toBeVisible();
    expect(within(overviewPanel).getByText(/pass 18/)).toBeVisible();
    expect(within(overviewPanel).getByText(/未满足条件数: 2/)).toBeVisible();
  });

  it('slot tree tab lazy-loads children, windows visible rows and offers locate', async () => {
    const listTree = vi.fn(async (_taskId: string, parentId: string | null) =>
      parentId === 'intro' ? TREE_INTRO_CHILDREN : TREE_ROOT,
    );
    renderProductionPage(v2Workspace(), buildGateway({ listAuthoritativeTree: listTree }));
    await userEvent.click(await screen.findByRole('button', { name: '结构' }));
    const drawer = await screen.findByRole('complementary', { name: '结构' });
    await userEvent.click(within(drawer).getByRole('tab', { name: '槽位树' }));
    await waitFor(() => expect(listTree).toHaveBeenCalled());

    // Top-level rows render (intro + body).
    expect(within(drawer).getByRole('treeitem', { name: /intro/ })).toBeVisible();
    expect(within(drawer).getByRole('treeitem', { name: /body/ })).toBeVisible();
    // Children of intro not yet loaded (lazy).
    expect(within(drawer).queryByRole('treeitem', { name: /quote/ })).toBeNull();

    // Expand intro → its child loads.
    await userEvent.click(within(drawer).getByRole('button', { name: /展开 intro/ }));
    await waitFor(() =>
      expect(within(drawer).getByRole('treeitem', { name: /quote/ })).toBeVisible(),
    );

    // Locate input offered for large trees.
    const locateInput = within(drawer).getByRole('textbox', { name: /定位 slotId/i });
    await userEvent.clear(locateInput);
    await userEvent.type(locateInput, 'slot-1500');
    await userEvent.click(within(drawer).getByRole('button', { name: '定位' }));
    expect(within(drawer).getByRole('status', { name: /已定位 slot-1500/ })).toBeVisible();
  });

  it('shows the selected slot content and review facts below the tree', async () => {
    renderProductionPage(v2Workspace(), buildGateway());
    await userEvent.click(await screen.findByRole('button', { name: '结构' }));
    const drawer = await screen.findByRole('complementary', { name: '结构' });
    await userEvent.click(within(drawer).getByRole('tab', { name: '槽位树' }));

    await userEvent.click(await within(drawer).findByRole('treeitem', { name: /body/ }));
    expect(await within(drawer).findByText(/当前槽位的真实内容。/)).toBeVisible();
    expect(within(drawer).getByText('内容版本')).toBeVisible();
    expect(within(drawer).getByText('content review: reject')).toBeVisible();
    expect(within(drawer).getByText('blocking Finding：1')).toBeVisible();
  });

  it('relationship tab shows "本 Map 未使用关系网" when disabled or zero relations', async () => {
    const mapNoRelations: AuthoritativeMapDetailV2 = {
      ...MAP_DETAIL,
      relation: { mode: 'disabled', relationCount: 0 },
      relationCount: 0,
    };
    const gateway = buildGateway({ getAuthoritativeMap: async () => mapNoRelations });
    renderProductionPage(v2Workspace(), gateway);
    await userEvent.click(await screen.findByRole('button', { name: '结构' }));
    const drawer = await screen.findByRole('complementary', { name: '结构' });
    await userEvent.click(within(drawer).getByRole('tab', { name: '关系网' }));
    expect(within(drawer).getByText('本 Map 未使用关系网')).toBeVisible();
  });

  it('relationship tab lists actual relations with enforcement and review states when present', async () => {
    const gateway = buildGateway({ getAuthoritativeRelationReview: async () => RELATION_REVIEW });
    // Force relationCount=1 so exactly one row is rendered.
    const singleMap: AuthoritativeMapDetailV2 = { ...MAP_DETAIL, relationCount: 1, relation: { mode: 'optional', relationCount: 1 } };
    gateway.getAuthoritativeMap = async () => singleMap;
    renderProductionPage(v2Workspace(), gateway);
    await userEvent.click(await screen.findByRole('button', { name: '结构' }));
    const drawer = await screen.findByRole('complementary', { name: '结构' });
    await userEvent.click(within(drawer).getByRole('tab', { name: '关系网' }));
    const relationsPanel = await within(drawer).findByRole('tabpanel', { hidden: false });
    expect(within(relationsPanel).getAllByText('references').length).toBeGreaterThan(0);
    expect(within(relationsPanel).getByText(/intro → body/)).toBeVisible();
    expect(within(relationsPanel).getAllByText(/violated/).length).toBeGreaterThan(0);
  });

  it('review tab lists map and content rounds plus layered observation', async () => {
    renderProductionPage(v2Workspace(), buildGateway());
    await userEvent.click(await screen.findByRole('button', { name: '结构' }));
    const drawer = await screen.findByRole('complementary', { name: '结构' });
    await userEvent.click(within(drawer).getByRole('tab', { name: '审核' }));
    const roundsPanel = await within(drawer).findByRole('tabpanel', { hidden: false });
    expect(within(roundsPanel).getAllByText(/整体观察/).length).toBeGreaterThan(0);
    expect(within(roundsPanel).getByText((text) => text.includes('round-map-1'))).toBeVisible();
    expect(within(roundsPanel).getByText((text) => text.includes('round-content-1'))).toBeVisible();
  });

  it('findings tab shows defect class, owner context, lifecycle and locate action', async () => {
    const locateBody = { ...LOCATE_RESULT, target: { ...LOCATE_RESULT.target, slotId: 'body' } };
    const locateAuthoritativeSlot = vi.fn(async () => locateBody);
    const gateway = buildGateway({ locateAuthoritativeSlot });
    renderProductionPage(v2Workspace(), gateway);
    await userEvent.click(await screen.findByRole('button', { name: '结构' }));
    const drawer = await screen.findByRole('complementary', { name: '结构' });
    await userEvent.click(within(drawer).getByRole('tab', { name: 'Findings' }));
    const findingsPanel = await within(drawer).findByRole('tabpanel', { hidden: false });
    expect(within(findingsPanel).getByText('f-body-1')).toBeVisible();
    expect(within(findingsPanel).getByText(/defect: content/)).toBeVisible();
    expect(within(findingsPanel).getByText(/来源: reviewer/)).toBeVisible();
    expect(within(findingsPanel).getByText(/status: open/)).toBeVisible();
    const locateBtn = within(findingsPanel).getByRole('button', { name: /定位 finding 主体 body/ });
    await userEvent.click(locateBtn);
    // Locate switches to tree tab and announces status.
    const treeStatus = await within(drawer).findByRole('status', { name: /已定位 body/ });
    expect(treeStatus).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(locateAuthoritativeSlot).toHaveBeenCalledTimes(1);
  });

  it('seal readiness tab lists per-condition gate and shows sealed custody when sealed', async () => {
    renderProductionPage(
      v2Workspace(),
      buildGateway({ getAuthoritativeSealReadiness: async () => SEAL_READINESS_SEALED }),
    );
    await userEvent.click(await screen.findByRole('button', { name: '结构' }));
    const drawer = await screen.findByRole('complementary', { name: '结构' });
    await userEvent.click(within(drawer).getByRole('tab', { name: 'Seal' }));
    const sealPanel = await within(drawer).findByRole('tabpanel', { hidden: false });
    expect(within(sealPanel).getByText('BLOCKING_FINDINGS_CLEAR')).toBeVisible();
    expect(within(sealPanel).getByText(/已封存/)).toBeVisible();
    expect(within(sealPanel).getByText(/seal_record/)).toBeVisible();
  });

  it('is strictly read-only — no mutation gateway methods are called from any tab', async () => {
    const baseGateway = buildGateway();
    // Wrap with the recording proxy so every method call is captured.
    const recording = recordingGateway();
    Object.assign(recording, baseGateway);
    const mutationNames = [
      'submitMapPatch',
      'finishMapBuild',
      'writeSlotContent',
      'submitContentDraft',
      'submitMapNodeReview',
      'submitMapRelationReview',
      'submitSlotReview',
      'submitRelationReview',
      'submitMapWholeFinding',
      'submitWholeTreeFinding',
      'submitFindingVerification',
      'completeReviewAssignment',
      'startTask',
      'stopTask',
      'resumeTask',
      'retryTask',
      'answerHuman',
      'submitHumanDecision',
      'cloneTask',
      'deleteTask',
      'reopenFailed',
    ];
    for (const name of mutationNames) {
      (recording as unknown as Record<string, unknown>)[name] = vi.fn(async () => {
        throw new Error(`mutation ${name} must not be called by v2 drawer`);
      });
    }
    renderProductionPage(v2Workspace(), recording as unknown as ReturnType<typeof stubGateway>);
    await userEvent.click(await screen.findByRole('button', { name: '结构' }));
    const drawer = await screen.findByRole('complementary', { name: '结构' });
    // Click through every tab so every view's render path runs.
    for (const name of ['总览', '槽位树', '关系网', '审核', 'Findings', 'Seal']) {
      await userEvent.click(within(drawer).getByRole('tab', { name }));
    }
    for (const name of mutationNames) {
      expect(recording.calls[name] ?? []).toHaveLength(0);
    }
  });

  it('v1 task stays on StructuredSlotDrawer with the existing read-only drawer', async () => {
    const base = workspaceWithReturnLoop();
    const v1: TaskWorkspace = {
      ...base,
      task: { ...base.task, id: 'task-v1' },
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
        issueSummary: { errors: 0, warnings: 0 },
      },
    };
    renderProductionPage(v1);
    const toggle = await screen.findByRole('button', { name: '结构' });
    await userEvent.click(toggle);
    const drawer = await screen.findByRole('complementary', { name: '结构' });
    // The v1 drawer renders the v1 outline list, NOT the v2 tablist.
    expect(within(drawer).queryByRole('tablist', { name: '结构抽屉视图' })).toBeNull();
  });
});
