# Authoritative Per-Slot Review Spec and Plan Adversarial Review Log

> **Documents under review:**
> - `docs/superpowers/specs/2026-08-14-authoritative-per-slot-review-lifecycle-spec.md`
> - `docs/superpowers/plans/2026-08-14-authoritative-per-slot-review-lifecycle.md`
>
> **Review method:** Independent read-only reviewer using the `codex-review` evidence-first framework. The author applies fixes; the same reviewer verifies closure and searches for new material failures. A reviewer may run at most five rounds before replacement. Implementation is forbidden until an independent `APPROVED` verdict.

## Cycle 1

### Round 1 — REVISE

The reviewer read the approved design, Technical Spec, Implementation Plan, and relevant current repository seams. Six P1 implementation blockers were reported and accepted.

1. **Opaque question identity was weakened to a number.**
   - Fix: `questionVersion` is now an exact 43-character base64url SHA-256 token binding question, original WorkItem/logical assignment, attempt/epoch, question digest, AuthorityBase, and opened commit. It is not a counter/tail. Spec and Task 2/11 now require format, recomputation, stale, stop/resume/restart, and idempotency tests.
2. **`maxRounds` had configuration but no authority transition.**
   - Fix: Spec freezes independent Map/content cycle ordinals, increment boundaries, non-consuming retries, atomic over-limit failure, and `reopen_failed` as the only recovery. Tasks 18/19 own boundary, perpetual-reject, mixed, response-loss, and no-successor tests.
3. **Map pre-review could omit advisory actual relations.**
   - Fix: Map review always covers every actual candidate relation. `reviewAdvisoryRelations` now affects only content relation-satisfaction review. Tasks 16/18 cross-test the different selectors.
4. **Non-graceful startup recovery had tests but no implementation owner.**
   - Fix: Spec adds the full startup recovery table and stable recovery operation identity. Task 11 now owns a persistent wakeup index and startup recovery service plus restart/idempotency tests; Task 26 remains the fault-matrix verifier.
5. **`artifact_published_v2` was not connected to ArtifactStore read authority.**
   - Fix: Spec freezes v1/v2 publication/provenance and ArtifactVersion unions, combined version allocation, list/read/recovery/cross-check behavior, and corruption rules. Tasks 21/22 own schema, store adapter, mixed-stream, restart, response-loss, disk/ref, UI, and v1 regression tests.
6. **Cross-process append exclusion was not an implementable contract.**
   - Fix: Spec adds `AuthoritativeAppendFacadeV2` as the only v2 append path and freezes fencing/fresh-tail/ref/version/durability order. Task 7 owns the facade, two-independent-instance races, stale takeover, bypass rejection, and dependency-boundary tests.

Round 2 was requested only after both documents passed `git diff --check` and targeted term scans showed no surviving weakened forms.

### Round 2 — REVISE

Round 1 findings 2–6 were verified closed. The question identity fix had one encoding contradiction, and one existing public lifecycle operation had not been incorporated.

1. **Question token said both lowercase and standard base64url.**
   - Fix: froze Node `digest('base64url')`, no padding, exact case-sensitive `[A-Za-z0-9_-]{43}` syntax, and explicit rejection of lowercase normalization.
2. **Legacy recursive task deletion could race v2 append/wakeup/pin work.**
   - Fix: Spec now includes delete in version dispatch and defines installation-level prepared/detached/purged tombstones, the same cross-process fence, wakeup/pin shutdown, atomic quarantine rename with parent fsync, crash recovery, retained no-reuse guard, and orphan quarantine. Task 11 owns the v2 delete service plus two-instance append/pin/retry/Seal/restart races; v1 deletion remains unchanged.

Round 3 was requested after targeted scans and `git diff --check`.

### Round 3 — REVISE

Round 2's token and storage-level deletion mechanics were verified closed. Two public mutation/authority chains remained incomplete.

1. **V2 delete had no request DTO capable of replaying the same operation after response loss.**
   - Fix: froze exact `DeleteTaskBodyV2/ResultV2`, auth-derived actor, gateway overload, DELETE JSON branch, UI confirmation-scoped UUID/reason reuse, wrong-protocol rejection, and same-operation/different-payload tests. Added an installation-level task protocol index so corrupt v2 roots cannot fall into legacy deletion.
2. **`reopen_failed` had neither a request DTO nor a closed recovery recipe.**
   - Fix: froze `ReopenFailedRequestV2`, endpoint/auth/gateway/UI semantics, public legal-recipe summary, and a failure-class-to-recipe table for SystemCommand/Seal, Map/content round limit, and reconstructible missing work. Each eligible failure stores a closed recovery payload; reopen derives exact successor/base/Grant server-side, preserves counters/failed history, and clone-only is mandatory when reconstruction is unsafe.

Round 4 was requested after both vertical slices had explicit implementation and test owners and the documents passed `git diff --check`.

### Round 4 — REVISE

Both Round 3 public mutation slices were field-complete. Five remaining implementation/state-machine contradictions were accepted.

1. **Round-limit reopen would immediately fail the same hard gate or double-increment.**
   - Fix: added a one-shot track/predecessor/operator-bound `RoundBudgetOverrideV2`. Reopen creates it without incrementing; the later atomic complete-round creation consumes it and increments exactly once. Wrong/replayed/second consumption rejects.
2. **`RUNNING_WITHOUT_WORK` could not satisfy a recovery payload that required a failed WorkItem.**
   - Fix: froze `FailureRecoveryPayloadV2` as three exact branches. Missing-work recovery requires predecessor/expected-successor/base/grant inputs and forbids nonexistent failed WorkItem/attempt refs; event/object/child-ref/projector contracts share the matrix.
3. **Making `TaskSummary.structuredProtocol` required before migrating its producers would break the task's own typecheck.**
   - Fix: Task 2 now owns every production/mock/fixture/gateway TaskSummary producer and their tests in the same commit, with an `rg` zero-missing-field audit before `npm run check`.
4. **Installation task index creation was not atomic with TaskStore publication.**
   - Fix: TaskStore remains sole ID/root publisher and now owns fenced prepared-index -> temp root fsync -> rename/parent fsync -> active-index choreography, startup recovery, legacy backfill, fail-closed no-index v2, and crash/two-instance tests.
5. **The actual delete dialog page had no implementation owner.**
   - Fix: Task 11 explicitly modifies/tests `task-list-page.tsx`; it owns reason/UUID creation, body persistence across response loss, new operation on reason edit, and v1 no-body compatibility.

Round 5 was requested after term scans and `git diff --check`.

### Round 5 — REVISE (reviewer retired at five-round limit)

Three prior fixes were verified; four persistence/commit issues remained. Per the user's rule, this reviewer receives no further rounds after these fixes.

1. **RoundBudgetOverride lacked actual plan-lineage fields and created/transfer/consumed events.**
   - Fix: registered the canonical override kind with repair lineage, initial/current plan refs, predecessor override and transfer ordinal. Reopen roots creation; successor-plan envelopes root exact same-lineage transfers; round-created events root consumption. Projector/GC/replay and Tasks 3/8/9/11 own the complete state machine.
2. **Recovery payload referenced nonexistent WorkItem/Attempt blobs.**
   - Fix: registered a recovery-payload object whose WorkItem/Attempt/SystemCommand identities are IDs + lease epoch + terminal event/commit; only real authority/payload/evidence objects are BlobRefs. Event validator/projector resolve those identities against history; missing-work branch forbids them.
3. **A pre-index corrupt legacy task could not be classified safely.**
   - Fix: added a mandatory pre-v2 installation migration marker/barrier that registers every preexisting directory as `legacy_preexisting` even if unreadable. Post-marker unindexed directories always quarantine/fail closed; v2 creation is disabled until the marker is durable.
4. **TaskSummary commit could still omit typed literals outside the staging set.**
   - Fix: enumerated the current `rg` inventory explicitly across components/pages/API/runtime/mocks/gateways, expanded tests/staging, added a staged-file coverage check, reran typecheck after the commit, and required no remaining TaskSummary migration files in status.

Cycle 2 starts with a fresh independent reviewer and the full current documents rather than relying on Cycle 1's closure claim.

## Cycle 2

### Round 1 — REVISE

The fresh reviewer independently reread the approved design, current Spec/Plan, review log, and repository entry points. Four P1s were accepted.

1. **Reviewer Findings had a required verification record but no reachable tool/capability.**
   - Fix: amended the approved design and Spec with exact `submit_finding_verification` capability/body/closure checks/private journal/atomic AssignmentLedger semantics. Removed free-standing `submit_finding`; verdicts own anchored drafts and whole sessions own whole Findings. Tasks 13/18 now test the complete addressed -> verification -> settlement closure.
2. **Profile identity was mutable deployment state, not frozen task authority.**
   - Fix: defined complete canonical profile snapshot bytes/digest/archive/ref; task index/FrozenTemplate/hash/AuthorityBase/plans/dispatch/grants/validators/cursors/Seal bind it. Current capability gates execution only; disabled/changed deployment profiles cannot change historical read/genesis semantics. Tasks 5/6/10 and qualification own A/B/disabled/restart tests.
3. **Task 4 could not load a v2 template before Task 5 added pipeline/system-producer support.**
   - Fix: Task 4 is now a pure Contract compiler only. Task 5 atomically owns first full v2 pipeline parsing, producer union, v4 validation, profile binding, loader and semantic hash success; no temporary bypass.
4. **Zhihu v2 assembler remained an illegal two-choice placeholder.**
   - Fix: Task 21 now installs one production builtin module with frozen handler/module/export/digest algorithm/budget/route. Task 25 deletes the source-package CJS (archived v1 only) and must resolve the real production entry with exact chapter bytes; test doubles cannot qualify.

Cycle 2 Round 2 was requested after design/spec/plan consistency scans and `git diff --check`.

### Round 2 — REVISE

Round 1's Task 4/5 compiler split and unique production assembler choice were verified closed. Four P1 execution gaps were accepted.

1. **Map batch verification was unreachable.**
   - Fix: added `submit_finding_verification` to `review_map_batch`; Task 13 now tests reachable/forbidden verification for every Map/content reviewer session, while Tasks 16/18 retain target coverage and settlement checks.
2. **A transient profile mismatch was incorrectly mapped to terminal `incompatible`.**
   - Fix: defined a separate non-event `AuthoritativeReviewExecutionEligibilityV1`. Deployment mismatch blocks execution only, retains event status/dispositions/wakeups, and exact-profile startup reconciliation resumes an underlying running task. Permanent unsupported frozen schema alone remains `incompatible`.
3. **The frozen profile blob had no closed kind or lifetime owner.**
   - Fix: registered `profile_snapshot` from Tasks 2/3, made prepared/active index and deletion-tombstone refs formal GC roots, and moved actual temp-root blob/index choreography to Task 11 with explicit Tasks 5/6/7 dependencies and create-before-start/GC/delete tests.
4. **The profile was frozen before real handler identities existed.**
   - Fix: Task 5 now owns only a test-only handler/profile revision. Tasks 14, 21, and 25 rotate immutable provisional profiles as validators/assembler/template validators are installed; Task 27 derives the only final profile from the complete production registry. Each rotation owns archive, loader/hash fixtures, stale-profile rejection, and capability tests.

Cycle 2 Round 3 was requested after all four vertical slices were made explicit in the design, Spec, task file ownership, and dependency graph.

## Cycle 3

The previous fresh reviewer did not return a bounded Round 3 verdict after repeated stop requests, so it was interrupted and replaced. Cycle 3 independently reread the full Spec and Plan rather than inheriting an approval claim.

### Round 1 — REVISE

Cycle 2 Round 2's four fixes were verified closed. Four additional P1 implementation contradictions were accepted.

1. **Publication/GC preceded the event union it must validate.**
   - Fix: reordered the dependency graph so Task 8 defines the exact v2 event union before Task 7 implements direct-append rejection, event-root enumeration, publication, and GC; Task 9 follows Task 7.
2. **Artifact version allocation made SystemArtifactDelivery content addressing cyclic.**
   - Fix: removed `artifactVersion` from the immutable delivery blob. The lock-scoped `artifact_published_v2` event owns the allocated version plus exact deliveryRef; projection/API derive and cross-check it. Task 21 adds two-instance/no-gap/replay tests.
3. **Tool authority fields and operation identities conflicted across documents.**
   - Fix: attempt/AuthorityBase are now server-closure-only and forbidden in Agent inputs. Every mutating tool requires `clientOperationId` or one frozen durable trusted-runner equivalent, with exact replay/conflict tests per write family.
4. **A crashed PublicationPin lacked enough intent to replay safely.**
   - Fix: added typed `PublicationIntentV2` with allowlisted handler/version, canonical operation-payload ref, and expected result identity. Startup replays only byte-identical, still-authorized reconstruction; unknown/stale/changed intent is abandoned and the owning WorkItem/lifecycle recovery creates a new operation.

Cycle 3 Round 2 was requested after the ordering, artifact, tool ABI, and publication-intent contracts were updated and `git diff --check` passed.

### Round 2 — REVISE

The artifact-version/delivery cycle was verified closed. Three implementation gaps remained and were accepted.

1. **The dependency graph and physical task order disagreed.**
   - Fix: physically swapped and renumbered the tasks: Task 7 now defines the exact event union; Task 8 owns publication/facade/GC. All downstream dependency references use the new numbering.
2. **Older design clauses still exposed Grant/authority capability fields to Agents.**
   - Fix: removed GrantInstance/spec/AuthorityBase/map/content refs and digests from Agent tool inputs throughout sections 12, 14, and 18. Dispatch/tool closure supplies and revalidates them; Agents send only business payload, expected semantic/root digests where applicable, and operation identity.
3. **PublicationIntent lacked a closed payload kind and registry owner.**
   - Fix: registered `publication_operation_payload` in Tasks 2/3 as an exact operation-family union. Task 8 now owns a typed handler registry mapping handler/version to payload branch, event/result schema, child refs, and deterministic builder, including state-only and artifact-version branches.

Cycle 3 Round 3 was requested after physical ordering and all three schema/ownership chains were aligned.

### Round 3 — REVISE

The three requested closures were verified. One P1 review-semantics gap remained.

1. **A batch reviewer could observe but not persist an assignment-external defect.**
   - Fix: batch verdict tools now accept bounded `crossScopeFindingDrafts` anchored to an assigned source target and an existing primary target in the same frozen baseline. Assignment completion atomically freezes the draft and a deterministic routing obligation; unreviewed targets enter their planned assignment/successor, already-reviewed targets enter whole observation, and blocking obligations prevent settlement until explicitly decided. There is still no free-standing Finding tool.

Cycle 3 Round 4 was requested after Spec, tool tests, Finding service tests, and design semantics all carried the same cross-scope route.

### Round 4 — APPROVED

The reviewer reverified cross-scope Finding reachability, atomic routing obligations, settlement blocking, physical Task 7 -> 8 ordering, closure-only Grant/authority, and the typed publication payload/intent registry. A final repository-seam and dependency scan found no remaining P0/P1 behavior or implementation blocker.

`VERDICT: APPROVED`. The paired Technical Spec and Implementation Plan are frozen for implementation.
