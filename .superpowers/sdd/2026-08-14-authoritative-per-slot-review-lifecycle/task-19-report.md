# Task 19 report — Repair Map/content through versioned private staging

**Status:** COMPLETE (uncommitted — adversarial review pending; working tree holds all Task 19 changes). Work UNCOMMITTED by design: the orchestrator commits after adversarial review (per the dispatch constraints).

## What was built (with EXACT test counts)

1. **`src/server/runtime/authoritative-review/repair-service.ts`** (+ **20 tests** in `repair-service.test.ts` + **3 tests** in `repair-service.property.test.ts`) — the Map/Content repair lifecycle (spec §13.3/§13.3.1, design §13):
   - Pure builders: `buildRepairPlanSpec` (the frozen parser contract: specDigest covers canonical bytes minus (specDigest, planRevisionId); planRevisionId = hash(repairPlanId, revision, specDigest)), `buildRepairKeyLedger`, `buildRepairStagingRoot`, `buildRepairBatchScopes`, `deriveRepairTargets`, `mapPatchScopeErrors`, `foldRepairMapState`, `buildRepairContributionManifest`, `buildRepairCandidateCore/Snapshot`, `buildFailureRecoveryPayload`, `mapRoundBudgetCheck` (the §13.3.1 map-track budget twin), `repairLedgerRevisionIdOf` (the self-consistent ledger revision id — the ledger is prepared BEFORE the plan spec exists, the Task 11 reopen precedent).
   - `createInitialRepairPlan` (the settlement-blocking envelope: `[*_repair_plan_started, work_item_created(batch 1), repair_grant_issued, command/WorkItem terminals]` in ONE batch — the settlement command COMPLETES), `createSuccessorRepairPlan` (validation_correction/recovery successors), `createRepairPlanFromSettlement` (the Task 18 handoff seam both settlements call — routes by `repairRouteOf`, decides initial vs successor by lineage existence).
   - `commitRepairBatch` (serial batches: next-ordinal only, grant plan-ref + staging-root CAS + ledger CAS, operation/node/relation/plan-key scope for map, slot scope for content, same-root/different-manifest staleness — NEVER a candidate/finalized event).
   - `executeRepairFinalize` (the `repair_finalize` SystemCommand): map clear publishes the repair build chain (`map_build_started` + `map_build_finish_proposed` + `map_build_finalized` + `map_candidate_committed` — the Task 15 candidate rules demand the chain) + the COMPLETE MapReviewRound (mapCycleOrdinal+1, budget-checked) + review WorkItems + `finding_addressed` + terminals; content clear publishes the repaired FINALIZED manifest + the COMPLETE ContentReviewRound (contentCycleOrdinal+1 via the Task 18 seam, SAME envelope) + review WorkItems + finding_addressed + terminals; blocking publishes `[*_repair_plan_rejected, revision_started(validation_correction), correction-batch WorkItem/Grant, terminals]`; over-limit publishes EXACTLY ONE `structured_task_failed_v2(REVIEW_REPAIR_LIMIT_EXCEEDED)` + the restart_review_cycle failure-recovery payload and NOTHING else.
   - `requestScopeExpansion` / `approveScopeExpansion` / `rejectScopeExpansion` (the operator seam), `prepareContentReReviewRound` (the public content-cycle boundary used by the content repair finalizer AND the repaired-Map activation).
   - Six registered publication handlers (`repair_plan_creation`, `repair_batch_commit`, `repair_finalize`, `repair_scope_request`, `repair_scope_approval`, `repair_scope_rejection`) + `registerRepairPublicationHandlers` + `createRepairFinalizeSystemCommandHandler` (replaces the Task 12 stub via `SystemCommandRegistry.replace`) + `createRepairToolHandlers` (submit_map_patch / write_slot_content / submit_content_draft / request_scope_expansion + the plan-aware read seam).
2. **`grant-service.ts`** (+ builders): `buildRepairBatchGrantSpec` + `grantSpecPlanKeyLedgerRef`/`grantSpecExpectedStagingRootRef`/`grantSpecFindingIds` helpers.
3. **`work-item-coordinator.ts`** (+1): `validateRepairSuccessorCarrier` (the §17.2 carry rules PLUS the repair payload/plan binding).
4. **`content-review-service.ts`** (additive): optional `repairService` dep — the blocking settlement now creates the deterministic RepairPlan via `createRepairPlanFromSettlement` instead of a bare retryable_failure (the no-seam path keeps the Task 18 surface).
5. **`map-review-service.ts`** (additive): optional `repairService` dep — the blocking settlement creates the MapRepairPlan; the REPAIR-round clear path (round ordinal > 1) activates the map WITHOUT regenerating content (`manifestPhase` null → no `content_revision_committed`) and folds the complete content re-review round (`contentRound` + `reviewWorkItems` carriers) into the SAME activation envelope.
6. **`tool-factory.ts`** (additive): `collectResultRefs` gains the `map_repair`/`content_repair` branch (the committed staging root ref — the §9.2 completion gate is never bare).

## EXACT test counts

- Brief Step 6 set (`repair-service*.test.ts`): **23 passed** (20 + 3 property) — 27 after the fix round. The Step-6 red run preceded the implementation; the original "14 failed at the first run" claim is UNVERIFIABLE (the pre-implementation state no longer exists; corrected in the fix round — M5).
- Brief Step 7 set (repair* + grant-service + tool-factory): **84 passed**.
- Full suite: **158 files / 3654 passed / 1 skipped** (baseline 156/3631/1 at `4a05c0d`; +2 files / +23 tests; the +1 skipped preserved). After the fix round: **158 files / 3658 passed / 1 skipped**. `npm run check` clean. HEAD still `4a05c0d`.

## Enumerated decisions (all required by the brief)

1. **Initial-plan creation key**: `origin = { kind: 'initial', settlementId: <settlement workitem id>, settlementDigest: <coverage-core ref digest>, creationOperationKey: attemptContinuationOperationId(taskId, settlementWorkItemId, settlementCommandId, 'complete') }` — the settlement's deterministic continuation key; NO fake predecessor. The plan-started event lands in the CREATION envelope (not the first batch — the Task 17 first-batch pattern would corrupt a pre-batch scope request: `structured_repair_scope_requested` demands the repair lineage).
2. **Successor op key**: `successorOperationKey` = the creating operation id (the blocking finalize uses `repairFinalizeOperationId`; scope expansion uses `repairScopeApprovalOperationId`); the same key + inputs replay the same successor bytes; a different key yields a different successor. Successor revision = superseded revision + 1; per-revision batch ordinals restart at 1 (the projector's per-(plan, revision) bookkeeping); successor WorkItem ids include the planRevisionId (`repairBatchWorkItemId(taskId, planId, ordinal, planRevisionId)`) so a successor revision NEVER collides with the superseded revision's workitems.
3. **Scope-expansion winner rule**: the approval envelope tail-CASes (`expectedLastSequence` + `expectedTailCommitId` — the facade's own CAS is the authority); a stale tail fails closed `AUTHORITY_BASE_STALE` and the loser re-evaluates on the winner. The successor plan spec is a pure function of the superseded head + the request, so competing successors from the same head are deterministic.
4. **Cycle-boundary seam ownership**: `planContentReviewRound` (Task 18) is the content-cycle boundary — the content repair finalizer calls `prepareContentReReviewRound` (which runs `contentRoundBudgetCheck` + resolves the exact available override) and folds the round-planned event + review WorkItems into the REPAIR_FINALIZE envelope (the round is NEVER created in a separate batch). The MAP-cycle boundary is new in Task 19: `mapRoundBudgetCheck` + the round-planned event inside the repair finalize envelope (mapCycleOrdinal+1, `consumedOverrideRef` carried). The repaired-Map ACTIVATION (map settlement clear on a repair round) folds the content re-review round into the activation envelope (`contentRound` + `reviewWorkItems` on the mapReview carrier; `manifestPhase` null → no content_revision_committed — the manifest is unchanged by a Map repair).
5. **Reopen-override envelope location**: the `structured_task_reopened_v2` + available-`RoundBudgetOverrideV2` envelope is Task 11/12 machinery (`task-lifecycle.reopenFailed` + the `recovery` family handlers) — NOT rebuilt in Task 19. Task 19 owns the CONSUMPTION side (the budget-checked round creation with `consumedOverrideRef`) + the `structured_round_budget_override_transferred_v2` transfer (successor-creation envelopes move the override within the same lineage when the available override binds the superseded plan). The reopen tests publish the recovery envelope through the frozen `restart_map_review_cycle` handler.
6. **Adoption wiring**: `ReviewAdoptionService` remains dormant — Task 19's repair rounds plan assignments over the FULL changed coverage of the repaired artifact (a complete Map/Content round), so the adoptable set (coverage − assignment) stays structurally empty; the Task 18 F3 deferral stands (the strict-subset planning that engages adoption is a Task 21 composition concern).
7. **Event ordering** (per the frozen projector): the initial envelope is `[*_repair_plan_started, work_item_created, repair_grant_issued, terminal pair]`; each batch envelope is `[*_repair_batch_committed, structured_repair_committed, work_item_created(next batch|finalizer), repair_grant_issued]`; the blocking finalize envelope is `[finding_addressed…, *_repair_plan_rejected (names the SUPERSEDED revision — the carrier's supersedesPlanRevisionId), structured_repair_plan_revision_started (the successor), work_item_created, repair_grant_issued, terminal pair]`; the clear map envelope is `[finding_addressed…, map_build_started, map_build_finish_proposed, map_build_finalized, map_candidate_committed, map_review_round_planned, review WorkItems, terminal pair]`; the clear content envelope is `[finding_addressed…, content_revision_committed(finalized), review_round_planned, review WorkItems, terminal pair]`.
8. **Scope-expansion event route**: NO new SystemCommand kinds — the approval/rejection ride the `repair_scope_approval` / `repair_scope_rejection` domain-publish handlers (the operator seam calls `RepairService.approveScopeExpansion`/`rejectScopeExpansion`; Task 21 wires the console). The approved event `structured_repair_scope_expansion_approved_v2` SELF-REGISTERS the successor revision in the projector — a separate `structured_repair_plan_revision_started` in the same envelope would clash (`revision_clash`); documented.
9. **Superseded old WorkItem/Grant**: the approval envelope atomically supersedes the old WorkItem via `structured_work_item_superseded` (reason `new_authority_base` — the projector fully folds it; CORRECTED in the fix round: the original claim "the projection has no workitem-supersede event" was FALSE). Its grant binds the superseded plan revision and every write from it fails `PLAN_STALE` (the plan head is the write authority). Documented in the service.
10. **Map repair base after activation**: the settlement repair base prefers the CURRENT CANDIDATE (`map_candidate`) and falls back to the ACTIVATED map (`map_active`) — after the initial map settlement the candidate is consumed by the activation, so the base is `map_active` (verified by tests).
11. **Batch-1 grants**: the creation envelope ALWAYS creates the batch-1 WorkItem WITH its grant (`isLast: false`, `batchOrdinal: 0` — the successor of "batch 0" is batch 1); the FINALIZER workitem is created only by the LAST batch's commit envelope. The `repair_grant_issued` event rides only when the successor carries a grant (the finalizer successor is grantless).
12. **Over-limit envelope**: the terminal-fail is published DIRECTLY through the `work_item_terminal_failed` handler with the coordinator's terminal op id (`attemptContinuationOperationId(..., 'terminal')`), `failureRecoveryPayloadRef` = a `restart_review_cycle` `failure_recovery_payload` (the projector CORRUPTS a REVIEW_REPAIR_LIMIT_EXCEEDED failed event without it — `recovery_missing`); `terminalEventId` = `deterministicEventId(terminalOp, 'work_item_terminal_failed', 0)`; `failedCycleOrdinal` = the would-be ordinal; `rejectedSubjectRef` = the current candidate/map or manifest.

## Union/registry/fixture changes (forced — additive, schemaVersion stays 1)

- `authority-types.ts`: `RepairPublishCarriersV2` + `repair` on the domain_publish payload; new publishKinds (`repair_plan_creation`, `repair_batch_commit`, `repair_scope_request`, `repair_scope_approval`, `repair_scope_rejection`; `repair_finalize` existed); `MapReviewPublishCarriersV2` += `contentRound` + `reviewWorkItems`; `ValidatorTriggerV2` += `'repair_finalize'`; `ValidatorInputEnvelopeV2` += the `repair_finalize` branch; `ValidationReceiptV2.receiptKind` += `'repair_finalize'`.
- `object-schema-parsers-3.ts`: `parseRepairPublishCarriers` (+build/finish/transfer sub-parsers), `repair` in `parsePublicationOperationPayload`, the mapReview `contentRound`/`reviewWorkItems` fields, `parseValidatorInputEnvelope` repair branch, `TRIGGER_ENUM` += `repair_finalize`, `RECEIPT_KINDS` += `repair_finalize`.
- `structured-slot-contract-v2.ts` (the template contract): `ValidatorTriggerV2` += `'repair_finalize'` (the registrations the engine executes carry the trigger; the repair finalizer runs with a null execution phase — the phase-routing rule matches).
- `authoritative-publication-intent-registry.ts`: `publicationPayloadChildRefs` repair branch + the mapReview `contentRound`/`reviewWorkItems` children.
- `validator-engine.ts`: `buildValidatorEnvelopeV2` + `receiptKindOf` repair branches.
- Fixtures: `repair: null` added to the domain_publish payload literals in map-build-service, map-review-service, content-review-service + object-registry.test.ts, map-review-service.test.ts, authoritative-append-facade.test.ts, authoritative-review-blob-store.test.ts, authoritative-review-gc.test.ts, authoritative-publication-intent-registry.test.ts, review-adoption-service.test.ts. (CORRECTED in the fix round — M3: content-plan-service.test.ts is NOT in the staged diff; the file has no domain-publish payload literal needing it.)
- **No profile fixture change. schemaVersion stays 1 — capability disabled, zero production blobs.** No new blob kinds (all repair kinds pre-existed). No new SystemCommand kinds (the approval/rejection ride domain-publish handlers; `repair_finalize` replaces the Task 12 stub).

## Deferred items (explicit)

1. **Verification loop wiring**: the repair finalize emits `finding_addressed` per plan finding; the NEXT complete round carries the addressed-but-unverified stages (the content round's carrier + the map round blob — the fix round made this real: `verificationStagesOfPlan` folds the in-envelope addressing stage in), and the settlement gate closes verified findings via ledger records (fix round: the content gate demands the records cross-round; the map round's freeze demands them per carried stage). The system-validator rerun path for system findings remains Task 21.
2. **`reopen_failed` UI/endpoint**: Task 21 (the recovery envelope machinery itself is Task 11/12).
3. **Adoption engagement**: deferred (decision 6).
4. **Content repair batch validation**: the repair batch commits do NOT run a batch-level validator (the finalizer-only validation model — the repair `repair_finalize` validator is the sole gate); documented.
5. **The `map_build_finalized.manifestRef` for the repair build chain** = the repair contribution manifest ref (the repair build has no chunk manifest; the contribution manifest IS the complete staged-map manifest — the field's kind is unvalidated by the event validator and the projector uses only the build id). Documented in the carrier type.

## Adversarial-review scrutiny points

- The settlement-blocking behavior CHANGE in content-review-service/map-review-service (with the seam wired) — the Task 18 tests stay green because the seam is an optional dependency.
- The `repair_finalize` trigger/phase semantics (the engine's phase routing treats repair_finalize as phase-less).
- The scope-approval envelope's lack of an explicit old-WorkItem terminal event (decision 9) — the plan head is the authority.
- The `ValidatorTriggerV2`/template-contract union widening (additive, but touches the "frozen" contract).

---

## Fix round (adversarial review 2026-08-15) — I-1..I-4 + minors

**Status:** COMPLETE. All Task 19 changes + the fix-round delta remain UNCOMMITTED (staged Task 19 + unstaged fix-round delta; the orchestrator commits after re-review). Full suite: **158 files / 3658 passed / 1 skipped** (baseline `4a05c0d` 156/3631/1 → Task 19 158/3654/1 → fix round +4 tests = **3658**; the +1 skipped preserved). Brief step-6 set (`repair-service*.test.ts`): **27 passed** (23 + 4 new). `npm run check` clean. HEAD `4a05c0d`.

### I-1 (repaired-Map activation binds the NEW snapshot) — FIXED

`prepareContentReReviewRound(taskId, manifestRef, mapContext?)` now accepts the activation's NEW snapshot (`ContentReReviewMapContextV2 { mapRef, mapSemanticDigest }`); `prepareContentRound` binds it for the round carrier, the review WorkItems' authority bases, and the planned coverage core. `map-review-service.ts` passes `{ mapRef: snapshotRef, mapSemanticDigest: proposedCore.mapSemanticDigest }`. End-to-end test: map repair → round-2 review (with the map-stage verification) → settlement clear → activation projects cleanly; the cr-2 round's `mapRef` == the activation's `mapSnapshotRef`.

**Additional defects this test exposed and fixed:**
1. `readRoundBlob` (map-review-service) rebuilt the round blob with hard-coded `verificationFindingStages: []` while the finalize now carries the plan's stages → the settlement bound an UNPREPARED blob ref (`TASK_CORRUPTED`). It now derives the IDENTICAL set from the repair candidate's provenance (`repairPlanId` + `repairPlanRevision` → the plan → `repairService.verificationStagesOfPlan(plan, 'map')`).
2. The map finalize built the round blob with `assignmentIds: []` while the settlement rebuilds the full assignment-id list → divergent blob. The finalize now carries the same assignment ids.
3. `map_review_settlement` handler's `expectedEventTypes` lacked `structured_review_round_planned` (the Task 19 content-round addition was never exercised) → every repaired-Map activation failed the replay identity check. Added.
4. The map round blob's verification stages were ALWAYS empty (the `finding_addressed` events land in the SAME finalize envelope, so the pre-projection read saw no addressed stage). `verificationStagesOfPlan` now takes the envelope's `addressingTrack` and folds the track stage in — the map round now genuinely carries `['m-1:map']` (the report's deferred-1 claim about the map carrier is now TRUE and asserted in the I-1 test via the round-2 freeze).

### I-2 (override transfer could never project) — FIXED (frozen Task 11 projector amendment)

**Projector amendment (`authoritative-review-state.ts` `applyOverrideTransfer`, prominently commented):** the frozen first check compared `p.availableOverride.ref` (a `round_budget_override` blob ref) against `event.fromRepairPlanRef` (a `repair_plan_spec` ref) — kind+digest `sameRef` could NEVER hold, so every emitted transfer corrupted `override_unknown`. Amended: the first check demands an EXISTING available override (`available === null` → corrupt); the atomic chain binding is enforced by the FROZEN blob checks (unchanged): the event's override blob must descend from the available ref (`newBlob.predecessorOverrideRef === available.ref`), the available blob's `currentAuthorizedRepairPlanRef` must equal `event.fromRepairPlanRef` (the superseded plan), and the new blob's must equal `event.toRepairPlanRef` (the successor). The event union fields were verified (`{overrideRef, fromRepairPlanRef, toRepairPlanRef, transferOperationId}` — no change); the emitter (`prepareOverrideTransfer`) already carried the exact refs (available-override blob → new blob, superseded plan ref → successor plan ref) — unchanged.

**Additional defects exposed and fixed:** the `repair_finalize` handler's `expectedEventTypes` lacked `structured_round_budget_override_transferred_v2` (the blocking-finalize transfer was never exercised) — added.

**Test through the REAL projector + REAL service paths:** over-limit fail (rev 1 clear) → reopen (`restart_map_review_cycle`, available override bound to the SUPERSEDED plan — the frozen reopen emits no repair-plan event, so a fabricated successor can never become the lineage head; the recovery successor is created by the REAL `createSuccessorRepairPlan`) → transfer #1 (rev 1 → rev 2) → rev-2 batch → **blocking finalize → transfer #2** (rev 2 → rev 3, `transferOrdinal` 2, descends from the transferred ref) → rev-3 batch → clear finalize consumes the transferred override exactly once (round-planned `consumedOverrideRef` == the transferred ref; `availableOverride` null; `consumedOverrideRefs` contains it).

### I-3 (content-track verification loop) — FIXED

1. The content re-review round now CARRIES the plan's addressed-but-unverified stages: `prepareContentRound` takes `verificationStages`; the round-planned event's `verificationFindingCount` = the count, and the planned coverage core's `finding-stage root` carries `{findingId, repairStage: 'content', state: 'committed'}` entries (the durable carrier, mirroring the map round blob). Content finalize derives them from the plan (`verificationStagesOfPlan(plan, 'content')` — the in-envelope addressing folded in); the repaired-Map activation path derives the CONTENT-track stages cross-round (`contentVerificationStagesOf` — the map plan's own stages are map-track and never ride a content round).
2. `resolveContentRoundFromCore` now derives verification targets from addressed-but-unverified CONTENT findings ACROSS rounds (the repair finding was opened in the PRIOR round) — probe C's `['f-1:content']` expectation.
3. The content settlement gate now demands a current verification record per cross-round target (`projectContentTrackFindings` + `verificationStagesOf`); duplicate records for the same target in the round's ledgers → incomplete (never last-writer-wins). The "blocking finding remains non-closed" check stays ROUND-scoped (an addressed-but-unverified finding must block via the missing-RECORD demand, not a repair re-route).
4. The tool gate `validateVerificationSubmission` accepts an ADDRESSED finding from an earlier round of the same track (the exact-round binding still applies to non-addressed findings).

**Test:** content repair → re-review round (asserts `verificationFindingCount` 1, the finding-stage-root entry, `resolveContentRoundFromCore` → `['c-1:content']`, the tool gate accepts the cross-round submission) → the assignment freeze WITHOUT the record is rejected (`missing verification record`, ZERO publication — the round never completes) → with `submit_finding_verification` the freeze completes → round completes → settlement SEALS.

**Judgment call for the re-reviewer:** the GATE-level missing-record negative is not reachable through the tool path (the assignment freeze enforces the record BEFORE the round can complete) — the gate's record demand is defense-in-depth, proven by the positive path (the record satisfies it) and the freeze-level negative. Also: the projected `verifiedStages` is only updated by `structured_finding_verification_recorded`/validator events (the reviewer freeze stores records in the ledger only), so the gate's demand is ledger-record-based by design; the `finding_verified_closed` projection transition remains the Task 21 system-validator rerun path.

**Additional defect exposed and fixed:** the CONTENT-track finalizer's authority base carried `contentRevisionManifestRef`, which the FROZEN work-item-domain rule for `system_repair_finalize` forbids (allowed: `planSpecRef` + `stagingManifestRef` + `findingSetRef` + one of `mapRef|mapCandidateRef`) — the content finalize path had ZERO test coverage and could never publish. Dropped the manifest ref (the finalize execution reads only plan/staging refs).

### I-4 (scope-expansion approval supersede) — FIXED

The approval envelope now emits `structured_work_item_superseded` for the superseded plan revision's claimable WorkItem atomically (carrier `supersededWorkItem` — union + parser + factory additions; the handler's `expectedEventTypes` includes the event). The projector fully folds it (state.ts:1005-1029) — the report's decision-9 justification ("the projection has no workitem-supersede event") was FALSE and is corrected in the service docs. `supersededWorkItemOf` finds the claimable workitem via the DETERMINISTIC ids (batch ordinals 1..N + the finalizer) and emits only when the projector accepts it: ready/retryable_failed/parked, or a lease whose attempt cycle ended — a mid-session lease (started attempt) is SKIPPED (the projector corrupts `supersede_without_terminal`; the plan head remains the write authority — PLAN_STALE). Test: approval emits the supersede; the old workitem is superseded (not claimable); the old grant write fails PLAN_STALE; the successor's batch proceeds to completion.

**Additional defect exposed and fixed:** the approval's successor spec bound the SUPERSEDED key ledger while its grant/staging root bound the NEW one — the successor's batch-1 commit ALWAYS failed `AUTHORITY_BASE_STALE` ("successor proceeds to completion" was impossible). The successor now binds its OWN ledger (self-consistent `repairLedgerRevisionIdOf`, mirroring the blocking-finalize successor — the ledger is prepared BEFORE the spec to avoid the spec↔ledger reference circle).

### Minors + cosmetic

- **M1:** the over-limit `rejectedSubjectRef` `?? planRef` fallback (a `repair_plan_spec` ref would corrupt `recovery_ref_kind`) is removed — fail-closed `MAP_UNRESOLVED`/`MANIFEST_UNRESOLVED` (unreachable today: a map finalize always has its repair base's candidate or an activated map; a content finalize requires the current manifest — commented). `publishOverLimitFailure` now carries an explicit comment that it returns `{kind:'completed'}` while the TASK is FAILED (the kind is the COMMAND's disposition, decision 12).
- **M3 (report correction):** the report's fixture list is corrected — `content-plan-service.test.ts` did NOT gain `repair: null` (verified in the staged diff; the file has no domain-publish payload literal needing it). All other listed fixture files match.
- **M4 (Task 20 note):** `map-review-service.ts:1324` — `isRepairRound = plannedRound.mapCycleOrdinal > 1` misclassifies any future non-repair second map round (Task 20 migration preactivation) as a repair round. RECORDED FOR TASK 20 (unchanged).
- **M5 (report correction):** the "red run 14 failed first" claim is softened — the pre-implementation state no longer exists and the claim is unverifiable (plausible: 23 tests, 14 failed first).
- Cosmetic: dead locals removed (`void firstBatch; void state;` in `createInitialRepairPlan`; `void input.operatorId;` in the approval/rejection; `void state;` in the rejection).

### Fix-round judgment calls for the re-reviewer

1. The I-2 projector amendment is deliberately minimal (one satisfiable first check); the atomic chain binding rests on the FROZEN blob checks (predecessor/plan bindings). The review's literal prescription ("compare the available ref with the event's override ref") is unsatisfiable against the frozen blob checks (the event MUST carry the NEW ref — `transferOrdinal = old + 1` — which can never equal the available ref); the descent relationship IS the comparison, via the blob chain. Documented in the projector comment.
2. The I-2 test sequence deviates from the review's literal "reopen → blocking finalize → transfer" by ALSO transferring on the recovery-successor envelope (the available override binds the superseded rev 1; the REAL `createSuccessorRepairPlan` emits the first transfer). The blocking finalize transfer + the consumption are asserted exactly as prescribed. The fabricated reopen envelope itself cannot produce a finalizable plan (the frozen `restart_map_review_cycle` handler emits no repair-plan event — a pre-existing Task 11/12 ↔ Task 19 integration gap, out of scope here, recorded for Task 21).
3. The test-only seed handler (`test/seed_events`) is broken-by-construction for new event types (the payload's non-enumerable `seedEvents` is lost in the pin payload roundtrip; its `seedEvents`-based helpers were dead code — never called by any test). Not touched; the new tests use only real service paths.
4. The map round blob's verification stages are now REAL (addressingTrack fold); the map settlement gate does NOT demand verification records (round-scoped blocking findings only — pre-existing; the review flagged only the content track, and the map round's freeze-level record demand now exists via the carried stages).
5. The I-3 gate-level missing-record negative is unreachable through the tool path (freeze enforces earlier) — see I-3 above.

### Verification

- Brief step-6 set: `repair-service.test.ts` (24) + `repair-service.property.test.ts` (3) = **27 passed** (was 23; +4 fix-round tests).
- Full suite: **158 files / 3658 passed / 1 skipped** (baseline 156/3631/1; Task 19 staged 158/3654/1; fix round +4).
- `npm run check` clean. HEAD `4a05c0d`. Work UNCOMMITTED by design (the orchestrator commits after re-review).

---

## Fix round 2 (R2-1/R2-2, Codex takeover 2026-08-16)

**Status:** COMPLETE and committed as `feat: harden authoritative repair staging` (commit recorded by the orchestrator after this report update). This round was limited to the two remaining Important findings from the independent re-review; no Task 20 work was started.

### R2-1 — repaired-Map settlement round bytes are now prepared-byte exact

- `MapReviewService.readRoundBlob` first resolves the `reviewRoundRef` from an already-created review WorkItem's prepared authority base. This reuses the exact `map_review_round` bytes prepared by the repair finalizer, including verification stages, assignment ids, and state fields, instead of rebuilding from mutable projected verification state.
- Its crash-recovery fallback is deterministic and uses the same pre-verification derivation as finalization (`subtractVerified = false`), including the repair plan provenance and carried map verification stages. This prevents settlement from binding a digest that was never prepared.
- The R2-1 end-to-end test now verifies map repair → round-2 verification → settlement → repaired-map activation, compares the settlement base's round ref with the review WorkItem's prepared round ref, and runs the complete authoritative GC. The test passes with the verification stage already projected.

### R2-2 — mid-session scope approval atomically ends the stale cycle

- `supersededWorkItemOf` now returns an abandonment carrier when the old repair WorkItem is leased with a started structured attempt. The approval envelope emits, in one ordered publication, `structured_agent_attempt_abandoned_v2` → `structured_work_item_lease_reclaimed` → `structured_work_item_superseded`; the supersede uses the post-reclaim epoch, so the stale WorkItem can never be claimed again.
- The carrier/parser/type and approval handler expected-event union were extended only for this Task 19 envelope. Ready/retryable/parked old WorkItems continue to use the direct supersede path; command/unresolvable cycles fail closed rather than manufacturing a half-state.
- The R2-2 test approves while the old WorkItem is leased and its attempt is `started`, asserts the abandoned/reclaimed/superseded sequence and final projection, then completes the successor batch.

### Verification evidence for this takeover

- Focused repair + map review run: **2 files / 40 tests passed** (`repair-service.test.ts` 25, `map-review-service.test.ts` 15).
- Repair property run: **1 file / 3 tests passed** (`repair-service.property.test.ts`).
- Serial regression reruns under one Vitest worker: `content-review-service.test.ts` **15/15**, `map-build-service.property.test.ts` **1/1**, `benchmark-structured-slots.test.ts` **32/32**.
- `npm run check`: **passed**.
- `npm run build`: **passed**.
- A full parallel `npm test -- --reporter=dot` run reached **155 passed / 1 skipped** and reported 8 timeouts in content-review, the 10,000-node map property, and benchmark scaling. Each of those files passed when rerun serially with one worker (evidence above); the parallel failures were resource-contention timeouts, not assertion failures. No unrelated product diff was introduced.

The worktree was then staged and committed with the exact message `feat: harden authoritative repair staging`; the independent reviewer should inspect that commit against the previous Task 19 package and this report.

---

## Fix round 1 (independent Codex findings, 2026-08-16)

**Status:** COMPLETE. All 4 P1 and 2 P2 findings in `task-19-review-findings-codex.md` are addressed within Task 19. `schemaVersion` remains 1, the v2 capability remains disabled, production services still use the append facade, and no runtime service imports EventStore.

### 1. Authoritative Finding verification and fail-closed settlement

- Map/content production assignment freeze now materializes `finding_verification_record`, emits `structured_finding_verification_recorded`, and carries the exact later re-review context. The test-only verification injector was removed.
- Settlement emits `structured_finding_verified_closed` only after every defect-class-required stage is authoritatively verified. Content settlement/Seal and Map settlement fail closed on an open or addressed-but-unverified blocking Finding regardless of validator outcome.
- Cross-round verification projection accepts the later repair-stage review context while preserving reviewer/system source authority.

### 2. Mixed Finding route and cross-context content tracking

- Verification targets are track-filtered (`map` stages never ride content review and vice versa).
- A mixed blocking Finding now follows the strict route: MapRepairPlan → repaired Map review/verification → Map activation + ContentRepairPlan in the same atomic envelope. A content review round is created only after that ContentRepairPlan finalizes.
- Content-stage lookup and settlement no longer discard a pending mixed Finding merely because it opened in a Map review context.

### 3. Exact repair-finalizer closure

- The `repair_finalize` validator envelope now binds the exact plan revision, authoritative staging root, key ledger, staged artifact, and selected target refs.
- Validator core resolution provides the plan plus the resolved staging root/ledger and complete staged Map candidate core or provisional content manifest; content targets resolve every exact version ref.
- A production-style validator test blocks specifically because staged Map artifact bytes are visible. Content repair tests assert the corresponding manifest/root/ledger/target closure.

### 4. Repaired-Map content budget boundary

- Content round preparation still consumes only the exact available content override.
- If repaired-Map activation would exceed the content-cycle limit without that override, Map settlement now invokes the common terminal boundary and atomically publishes one `REVIEW_REPAIR_LIMIT_EXCEEDED` failure/recovery envelope. It never degrades to `MAP_REVIEW_SETTLEMENT_FAILED` or an ordinary retryable failure, and publishes no Map activation/content round.

### 5. Content warning custody and GC reachability

- Content repair finalization prepares `validation_warning_custody_root`, stores that custody ref in `finalizerWarningRootRefs`, and publishes both the raw `validation_warning_root` and custody ref. The finalized manifest therefore roots the complete warning chain for GC.

### 6. Scope rejection and immutable approval scope

- Scope rejection now atomically abandons/reclaims an active attempt, supersedes the old WorkItem/Grant, and creates one deterministic same-plan/same-scope replacement WorkItem/Grant. The rejection reason is projected onto the replacement and carried into its `assignment_dispatch`.
- Approval derives authority only from the immutable recorded request. Repeated API scope fields must be byte-equivalent after canonicalization, every requested target must exist, and the successor operation/key binds the requested scope digest.

### Tests and qualification

- Focused Task 19/Map/Content/property run: **4 files / 59 passed** after repairing two stale tests that requested a nonexistent node.
- Validator/schema/projector focused run: **3 files / 90 passed**.
- Full serial suite: **158 files / 3660 passed / 1 skipped** (`npx vitest run --maxWorkers=1 --minWorkers=1`).
- `npm run check`: passed.
- `npm run build`: passed.

The remaining warnings in the full run are pre-existing React Router/`act(...)` test warnings; there were no test failures or Task 20 changes.

---

## Fix round 2 (scoped re-review findings, 2026-08-16)

**Status:** COMPLETE. All 2 P1 and 2 P2 findings in `task-19-rereview-findings-codex.md` are addressed inside Task 19. No Task 20 behavior, v1 surface, capability fixture, or blob schema version changed; production publication remains facade-only with zero runtime EventStore imports.

### 1. Mixed Map-opened Finding reaches the content tool and authoritative close

- `resolveContentRoundFromCore` now derives reviewer verification targets from the round's frozen `finding_stage_root` and current content stage, rather than the Finding's opening-context kind. A mixed Finding opened in Map therefore exposes exactly `findingId:content` after its ContentRepairPlan finalizes.
- `validateVerificationSubmission` treats the frozen finding-stage target as stage authority; it no longer rejects a mixed content-stage verification merely because the immutable opening context is Map.
- The mixed end-to-end regression now continues through ContentRepairPlan batch commit/finalizer, production tool reconstruction, content assignment freeze, `structured_finding_verification_recorded`, settlement, `structured_finding_verified_closed`, and projected `verified_closed`.

### 2. `still_present` atomically routes the next repair cycle

- Projection of a real `still_present` verification resets only that repair stage from `addressStages` and returns the Finding to `open`, preserving other mixed stages while making the rejected stage repair-eligible.
- Content settlement carries Findings verified in the current content round even when they opened in a prior round, so the same settlement creates the deterministic correction revision instead of returning `CONTENT_REVIEW_BLOCKED` forever. Map uses its frozen carried stage equivalently.
- Production-flow regressions cover both Map and Content: real repair, real re-review freeze with `still_present`, stage reset, settlement completion, one additional repair revision, and a ready successor Grant.

### 3. Scope Finding ids are immutable, known, current, and track-correct

- Both request and approval validate every requested Finding against the immutable active plan: the Finding must exist, belong to the plan's server-computed Finding closure, remain blocking/unclosed, and require the active repair track.
- Unknown and wrong-track/out-of-lineage requests fail with `REPAIR_SCOPE_INVALID` before publication; the test asserts zero `structured_repair_scope_requested` events. Approval repeats the same validation after byte-equality against the recorded request, preventing a malformed ledger request from authorizing a corrupt successor.

### 4. Scope rejection replay preserves result identity and operator identity

- The persisted rejection event and carrier now bind `operatorId`; the operation id binds task/request/operator/reason bytes.
- Replays reconstruct the deterministic replacement WorkItem and return the exact original authority-base and Grant refs plus `replacementWorkItemId`. Same-byte replay is deeply equal to the first result; changed operator or reason fails `OPERATION_CONFLICT`.

### Verification

- Scoped behavior run: **3 files / 39 passed** (scope, Map/Content `still_present`, mixed full lifecycle, tool verification, rejection event schema).
- Full affected serial run: **5 files / 807 passed** (`repair-service`, `content-review-service`, `tool-factory`, event schema, projector).
- `npm run check`: passed.
- `npm run build`: passed.

### Post-review GC hardening

- The extended mixed lifecycle exposed two fabricated provenance refs in repaired `content_version` blobs. Content repair batches now run the registered `content_commit/batch_commit` validators over the frozen commit core and exact staged content values, persist the real envelope/aggregate/receipt/warning graph, and bind a prepared `validation_warning_custody_root` into every repaired version.
- The mixed regression now runs a complete authoritative GC after content finalization and settlement; the live repaired manifest graph is fully resolvable. The complete `repair-service.test.ts` run passes **28/28** (including the restored GC assertion), followed by a fresh successful `npm run check` and `npm run build` (732 modules).

---

## Fix round 3 (final scoped re-review, 2026-08-16)

**Status:** COMPLETE. Both P1 findings and the P2 finding in `task-19-rereview2-findings-codex.md` are closed inside Task 19. No Task 20 behavior, v1 surface, capability fixture, blob kind, SystemCommand kind, or schema version was added or changed; publication remains facade-only with zero runtime EventStore imports.

### 1. Multi-batch content staging is cumulative

- Every committed content batch now starts from the immediately preceding staging root's complete provisional manifest, not the repair base manifest. Its commit core binds that exact prior staged manifest and exact current version refs.
- The new cumulative provisional manifest overlays only the current batch. Earlier repaired versions remain byte-identical, later batches cannot restore base refs over them, and untouched slots retain their original version refs.
- The finalizer resolves the last committed cumulative manifest directly and verifies its content-root digest before resolving every version; it no longer refolds each batch over the base.

### 2. Pre-finalizer validator/provenance custody and restart recovery

- `RepairStagingRootV2` now carries `contentManifestRef` (null for Map roots). Because the committed batch event roots the staging root, recursive GC reaches the complete provisional manifest, content versions/values, commit cores, validator envelopes/aggregates/receipts/warnings, and warning custody before finalization.
- A legal GC between Batch 1 and Batch 2 no longer deletes the journaled content value or provenance closure. Finalizer recovery resolves the committed closure and never invokes the already-completed batch validator again.
- The real multi-batch regression commits two one-slot batches, runs authoritative GC between them, finalizes, checks both repaired texts/versions, proves an untargeted slot ref is unchanged, and asserts the batch-validator invocation count remains exactly two across recovery/finalization.

### 3. Frozen `ContentValidationCoreV2` batch wrapper

- Repair batch validation now prepares and persists `{ phase: 'batch_commit', contentRevisionCommitCoreRef }` and binds its ref as `ValidatorInputEnvelopeV2.contentValidationCoreRef`. The engine deep-resolves the wrapper to the exact commit core.
- The closed registry has no separate content-validation-core blob kind, so the wrapper is stored as the existing `content_revision_commit_core` family variant; its parser is exact, extracts the inner core child ref, retains schemaVersion 1, and rejects unknown fields.
- The direct-core compatibility branch now recognizes the frozen `authorizedReplacementEntriesWithoutValidation` field. Parser and engine regressions cover the wrapper child edge and direct-core normalization; a production repair validator blocks specifically from `batchOrdinal` and authorized replacement bytes.

### Verification

- RED evidence: the multi-batch test failed because `contentManifestRef` was absent; the core-byte validator test committed instead of blocking because it received the raw core.
- Focused repair run: **1 file / 29 passed**.
- Parser/validator/property run: **4 files / 62 passed** (`validator-engine`, object registry, authority properties, repair property).
- Full affected serial run: **7 files / 820 passed** (`repair-service`, repair property, content review, tool factory, event schema, projector, GC).
- Recovery lifecycle regression: **1 file / 13 passed**. Round-limit recovery now serializes `contentManifestRef` on its staging root, roots only a real projected manifest, and keeps the deliberately unresolved placeholder outside the lease/GC closure.
- Full serial suite: **158 files / 3665 passed / 1 skipped** (`npx vitest run --maxWorkers=1 --minWorkers=1`).
- `npm run check`: passed.
- `npm run build`: passed (732 modules).

The only full-suite diagnostics were the pre-existing React Router and `act(...)` warnings; there were no test failures.

---

## Fix round 4 (schemaVersion-1 staging compatibility, 2026-08-16)

**Status:** COMPLETE. The sole P1 in `task-19-rereview3-findings-codex.md` is closed inside Task 19. schemaVersion remains 1; no v1 surface, capability fixture, blob kind, SystemCommand kind, or Task 20 behavior changed. Publication remains facade-only with zero runtime EventStore imports.

### 1. Historical and cumulative roots share the schemaVersion-1 read contract

- `parseRepairStagingRoot` accepts exactly two closed forms: the historical root without `contentManifestRef`, and the cumulative root with it. Each form verifies `stagingDigest` against the exact fields that were persisted; unknown keys remain rejected.
- A historical root is normalized to `contentManifestRef: null` only after its historical digest passes. The normalized object is a read view: its current-form content address differs, and neither BlobStore reads nor GC rewrite the historical canonical bytes.
- `currentStagingState` takes an uncommitted plan's base root from the persisted batch-1 authority base instead of recomputing it with the current builder. Historical Map and Content grants therefore retain their exact CAS identity after an upgrade.

### 2. Legacy Map and Content recovery is authoritative

- A historical Map base/root resolves normally, can commit a current-form successor root whose `priorStagingRootRef` names the historical bytes, and can complete through the normal finalizer.
- A historical Content base with no committed batch safely falls back to the authoritative repair-base manifest once, then writes a current cumulative root with an event-rooted `contentManifestRef`.
- A historical Content head after any committed batch never falls back to the repair base. Before the next batch validator runs, the service atomically abandons/reclaims/supersedes the active old WorkItem and creates one `successorReason: recovery` plan revision from the unchanged authoritative base. A legacy finalizer head similarly completes its system command with one recovery successor. This preserves committed validator execution history without pretending the missing cumulative closure can be reconstructed.
- The `repair_plan_creation` rebuild handler carries the recovery WorkItem transition in the same deterministic envelope. The old committed staging event continues to root the historical bytes and remains GC-resolvable after the successor is created.

### Verification

- RED evidence: parser/BlobStore/GC tests failed on missing `contentManifestRef`; all three runtime compatibility paths initially failed because the recomputed base ref did not match the persisted historical Grant; the multi-batch path then incorrectly returned `committed`; the finalizer returned `STAGING_UNRESOLVED`.
- Focused compatibility run: **4 files / 8 passed** (historical/current parser forms, byte-preserving BlobStore resolution, event-rooted old/new GC walk, Map recovery, Content base migration, in-flight batch recovery, finalizer recovery).
- Complete repair-service serial run: **1 file / 33 passed**.
- Full affected serial run: **10 files / 899 passed** (`repair-service`, repair property, content review, tool factory, event schema, projector, GC, BlobStore, validator engine, object registry).
- Capability/dependency-boundary qualification: **2 files / 5 focused passed** (checked-in production capability stays disabled; runtime/domain trees remain free of EventStore imports/construction).
- `npm run check`: passed.
- `npm run build`: passed (732 modules).
- `git diff --check`: passed.
