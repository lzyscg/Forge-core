# Task 20 Report — Migrate content across approved Map replacements

**Status:** IMPLEMENTED; adversarial re-review fix round 5 is closed locally and qualified. The orchestrator still owns the next independent re-review gate.

## Delivered behavior

- Added `migration-service.ts` with deterministic builders for the migration spec, intent, compatibility/equivalence proofs, validation plan/batches, settlement, provisional/finalized manifests, preactivation finalizer core, activation decision, and publication envelopes.
- Every target content-bearing slot receives exactly one frozen action: `inherit_or_validate`, `carry_unset`, `rewrite_required`, or `new_or_schema_reset`. Optional compatible unset content is carried explicitly; new/schema-reset slots are never mistaken for inherited content.
- Local validator reuse is all-or-nothing across the frozen registration set, selector expansion, content bytes, local Map subgraph, and local relation context. Any changed dimension enters the fresh target-Map validator path; rejected validation retains aggregate, receipt, FindingSet, and per-slot rewrite custody.
- Migration batches are persistently ordered, resume at the first missing ordinal, reject duplicate/out-of-range/incomplete closure, and publish their result roots plus successor/terminal events atomically. A completed ordinal is discovered from projected event custody and is never rerun.
- The only migration finalizer context is `mapContext.kind = migration_preactivation`. Batch and finalizer classifications combine under system control into four routes: clear, content repair, Map repair, or infrastructure retry.
- Clear activation requires the exact finalized migrated manifest plus a complete content-review round and its WorkItems. Content repair activates the Map only with the exact provisional manifest and one ContentRepairPlan. Map/mixed repair never activates and instead carries a candidate-bound MapRepairPlan. Infrastructure failure emits no activation envelope.
- `system_review_settlement` is split by a system-owned payload kind: ordinary Map review coverage is the initial stage; `migration_validation_plan_spec` is the post-migration stage. Only post-migration settlement can publish migration settlement custody and activate or route repair.
- Ordinary replacement candidates are selected through explicit candidate provenance. `system_repair_finalize` is the repair path; other replacements are migration. `mapCycleOrdinal > 1` is no longer used as an origin proxy.
- The existing map-review settlement publication handler atomically emits migration settlement completion before Map settlement/activation and retains provisional manifest/finalizer refs as event-root custody. Parser additions accept both the old schemaVersion-1 carrier key set and the additive Task 20 keys.

## TDD evidence

- Initial focused RED: importing `migration-service` failed because the module did not exist.
- Route-contract RED: clear migration without a content review round unexpectedly succeeded; after the system gate was added, the focused test passed.
- Focused migration suite: **2 files / 27 passed** (`migration-service.test.ts` 26, `migration-service.property.test.ts` 1).
- The fast property model covers **10,000 slots / 157 batches**, interrupts after ordinal 73, resumes from the first missing ordinal, and proves deterministic restarted/uninterrupted settlement and execution digests are byte-equal. It is an in-memory stress model, not the durable recovery proof recorded below.
- Full Map review integration: **1 file / 16 passed** under one Vitest worker.
- Task 19 repair regression: **1 file / 35 passed** under one Vitest worker.
- Parser/event/projector/content-domain regression: **5 files / 765 passed**.
- `npm run check`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.

## Adversarial review fix round 1

- **P1-1 — fresh post-migration authority:** settlement now reads the live projection both before preparation and immediately before publication. It fails closed unless the active source Map, active source manifest, current candidate, active migration plan, WorkItem payload/authority refs, review round, and completed frozen plan are exact. A preparation-window race test changes the active manifest and proves zero publication.
- **P1-2 — production composition:** `createProductionMigrationRuntime` installs the real `ValidatorEngine` for `content_commit/batch_commit` and `plan_finalize`, uses the installed registry, frozen profile/registration inputs and blob resolver, derives all five local-equivalence dimensions, constructs system-owned Finding/route envelopes, installs the migration command in `SystemCommandRegistry`, and delegates only carrier construction to review/repair coordinators. The integration test executes `V2AttemptCoordinator -> SystemCommandRegistry -> production migration runtime -> AuthoritativeAppendFacade -> projector`; it does not call a fake business-decision callback.
- **P1-3 — infrastructure retry/evidence custody:** an infrastructure batch no longer publishes a completed ordinal or successor, so the same ordinal runs again. Retryable system-command outcomes formally carry `validatorAggregateRef`; `V2AttemptCoordinator` roots it in the retryable-failure event. The finalizer path propagates the same aggregate root, making transitive validator evidence reachable for response-loss replay and GC.
- **P1-4 — sequential replacement lineage:** migration projection lineage is reset/closed on settlement and initialized per new plan. Concurrent/duplicate plans still reject, while a second replacement after settlement replays and checkpoints successfully.
- **P1-5 — authoritative result derivation:** settlement resolves every persisted batch result by exact ref, requires the exact plan ref, ordinal and slot set, validates aggregate/result consistency, rejects gaps/extras/swaps and persisted infrastructure outcomes, then derives batch/finalizer/combined routes from a canonical union FindingSet. Corruption tests and simultaneous content-batch plus Map-finalizer findings prove the system-derived mixed route.
- **P2 — preliminary 10k model (superseded below):** this round strengthened the in-memory `MigrationServiceV2` stress model, but adversarial re-review correctly found that it did not prove EventStore/projector/GC recovery. The real durable proof is the separate production integration in fix round 2 below.

### Fix-round qualification (2026-08-16)

- Task 20 migration/Map/repair/projector/attempt/facade focused regression: **9 files / 176 passed**. The real 10,000-slot persistent test completes inside this run.
- Capability/profile archive guard regression: **3 files / 48 passed**.
- `npm run check`: passed after the final test type narrowing.
- `npm run build`: passed.
- `git diff --check`: passed.
- Runtime boundary: authoritative-review runtime has no `EventStore` import; schemaVersion remains `1`; v1/capability/profile sources are unchanged.

## Adversarial re-review fix round 2

- **P1-1 — check/tail race:** post-migration publication now captures the append tail first, performs the final fresh projector/authority check second, and publishes against the captured tail. A deterministic test mutates authority from `tail()` and proves zero publication: changes before the check fail the authority comparison, while changes after the captured tail fail the append CAS.
- **P1-2 — exact settlement closure:** batch settlement resolves, kind-checks, and byte-hash-checks every result, equivalence proof, aggregate, input envelope, warning root, receipt, FindingSet, and Finding. It binds the batch trigger/phase, installed registration digest, plan/core/target Map/source version/slot/ordinal, aggregate warning root, blocking-receipt membership, and Finding lineage. Finalizer settlement applies the analogous checks for `content_commit/plan_finalize`, installed finalizer registrations, input-to-finalize-core binding, warning custody, and receipt/Finding lineage. Corruption tests cover wrong registration, swapped receipt, unrelated FindingSet, wrong warning, forged proof, and wrong finalizer input.
- **P1-3 — authoritative migration Findings and real repair routes:** migration validator Findings are opened as `structured_finding_opened` events in the same atomic post-migration settlement envelope and are cross-bound to the combined FindingSet and RepairPlan scope. The production repair adapter prepares the initial Map/Content RepairPlan from those exact Finding bytes without pre-publish projection reads. Real `AttemptCoordinator -> SystemCommandRegistry -> production migration runtime -> append facade/EventStore -> projector` tests cover clear, content repair, mixed Map repair, and finalizer infrastructure failure. The content case then leases the projected repair WorkItem, commits a real repair batch, runs the real repair finalizer, and confirms the same projected system Finding is addressed.
- **P2 — real durable 10k recovery:** the earlier restart-shaped property model is retained only as a fast deterministic stress model and is no longer cited as persistent proof. A separate production integration creates 10,000 target Map nodes and 600 validatable slots, publishes 75 real migration batches through the append facade/EventStore/projector, stops after ordinal 73, runs `AuthoritativeReviewGc`, discards and reconstructs the environment/runtime/coordinators from the durable paths, and resumes through `V2AttemptCoordinator`. It compares uninterrupted/restarted batch roots, 599 equivalence-proof refs plus one real fresh production-validator result, validator counts derived from persisted batch results, settlement/decision/manifest refs, route, and the complete event root.
- **Additional invariant fixes exposed by the real routes:** migration batch/finalizer Findings bind to the existing completed Map review round rather than a synthetic unprojected round; finalizer validator universe includes the target Map nodes/relations; migration replacement commits the new manifest before activation; the projector permits finalized-to-provisional only for a migration-plan replacement while a candidate exists; and both migrated slot provenance and finalizer manifests retain canonical warning-custody roots rather than raw validator warning roots.

### Re-review-1 fix qualification (2026-08-16)

- Migration unit + deterministic stress model: **2 files / 32 passed**.
- Real four-route AttemptCoordinator integration: **4 passed**; installed-registry batch integration: **1 passed**.
- Real 10,000-node durable GC/reopen proof: **1 passed** in **590.45 s** (75 batches; restart after ordinal 73; 599 equivalence proofs + 1 persisted fresh-validation result).
- Repair service/property: **2 files / 39 passed**; Map review: **1 file / 16 passed**.
- Append facade/projector/attempt/registry/capability regression: **6 files / 132 passed**; projector state regression: **1 file / 40 passed**.
- `npm run check`, `npm run build`, and `git diff --check`: passed.
- Runtime boundary remains facade-only with zero `EventStore` imports; object schema versions remain `1`; v1/capability/profile sources remain unchanged.

## Scope and compatibility

- v1 runtime/storage behavior was not modified.
- Blob and publication payload schema versions remain `1`; old map-review carrier bytes remain accepted.
- The authoritative-review capability/profile remains disabled and unchanged.
- Runtime mutation is facade-only. No authoritative-review runtime service imports EventStore.
- No Task 21+ Seal/profile/assembler work was started.

## Handoff notes

- `MigrationServiceV2` is dependency-injected into `MapReviewService`; the capability remains disabled, so production bootstrap/profile activation is intentionally deferred to the later activation task.
- The clear/content/Map route preparers and the target-Map validator/finalizer are explicit system-owned dependency seams. The service validates their authority-bearing carriers before publication rather than trusting a caller-supplied route.
- Independent review should attack GC closure for every migration ref, response-loss replay for initial/batch/post envelopes, mixed Finding routing, schemaVersion-1 parser compatibility, and the zero-validation direct-post path.

## Adversarial re-review fix round 3

- **P1-1 — sequential equivalence custody:** production migration now follows any equivalence-only `sourceVersionRef` chain to the originating clear `content_commit/batch_commit` aggregate. Every inherited link is hash-checked and recomputes the frozen registration, selector, content bytes, local Map subgraph, and relation-context dimensions. The originating input/core/raw-warning/custody closure must be exact. Missing or corrupt historic custody is conservatively treated as `fresh_validation_required`, never as a migration crash. Settlement repeats the complete custody proof before accepting an `equivalent` result.
- **P1-2 — system-owned required coverage:** the production finalizer derives the complete content-bearing and required slot sets from the exact target Map plus frozen slot types. The compatibility callback is comparison-only and any disagreement fails closed. The manifest must exactly cover all content-bearing target nodes with target-Map-bound versions, and `clear` additionally requires every system-derived required slot to be set.
- **P1-3 — complete Map Finding scope:** migration Findings retain the union of authoritative content-slot and Map-node stable IDs plus every relation target. Map repair preparation consumes slot-primary mixed targets, related Map nodes, related relations, and the closed `$map` whole-Map location. Whole-Map expansion is still bounded by the exact target Map and the repair profile limits.
- **Durable fixture correction:** the 10,000-node production proof now gives each of the 600 required source slots its own valid `ContentValue`, validator input, clear aggregate, warning root, and warning-custody root. The remaining 9,400 target nodes use a frozen optional slot type, so the system-derived required set is exactly the 600 populated slots; the callback can no longer clear required unset content by returning `[]`.

### Re-review-2 fix qualification (2026-08-16)

- Sequential real replacement after GC/reopen: first replacement produces `inherit_equivalent`; the second production migration follows its source custody, completes clear, and two executions produce the same terminal batch root.
- Real AttemptCoordinator Map routes: slot-primary mixed, `$map` primary, and multi-node/relation targets all project a candidate-bound ready `MapRepairPlan` with complete bounded scopes.
- Required-slot disagreement case: fails closed and publishes no replacement Map activation.
- Non-10k production integration: **10 passed, 1 skipped** (the skipped case is only the separately-run 10k proof).
- Real 10,000-node durable GC/reopen proof: **1 passed** in **752.38 s**, then re-run at the final source state and **1 passed** in **761.46 s**, with uninterrupted/restarted byte-identical roots and valid per-slot source provenance.
- Migration/repair/Map/attempt/validator focused regression: **7 files / 144 tests; 143 passed initially, then the one updated 10k fast property passed independently**. Repair service alone: **36 passed**; Map review: **16 passed**; AttemptCoordinator: **23 passed**; ValidatorEngine: **34 passed**.
- Capability/profile/append-facade guard regression: **4 files / 75 passed**.
- `npm run check`, `npm run build`, and `git diff --check`: passed.
- Runtime boundary remains facade-only with no production `EventStore` import; schemaVersion remains `1`; v1/capability/profile sources are unchanged.

## Adversarial re-review fix round 4

- **P1-1 — source provenance/Map custody:** validator reuse now starts from the exact content-addressed source manifest and migration source Map. It self-validates the manifest digest and requires one exact slot entry, task/Map/semantic identity, and the source version's Map binding. The originating clear execution must close its version, content bytes, commit core, producer plan, frozen batch membership, complete replacement set, complete validator selector, aggregate, warning root, and warning custody. Revalidated migration sources additionally close through the producing intent/settlement decision. The Map actually bound by that originating execution is resolved and its local node/relation dimensions must equal the migration source Map before target equivalence is considered. Any missing or corrupt link falls back to fresh target-Map validation; settlement repeats the same proof before accepting an equivalence result.
- **Durable source fixture:** the 600 populated source slots now represent one semantically exact generation batch: the plan batch, commit replacement closure, validator selected-target closure, versions, shared clear aggregate, and custody root all agree. The runtime caches only successful immutable content-addressed resolutions (never missing refs), eliminating repeated disk reads without weakening validation.
- **P1-2 — primary-location routing:** `map`, `map_node`, and `relation` primary locations now force the Map track, while simultaneous content slot targets yield `mixed`. A legal `$map` primary with empty explicit targets reaches Map repair and expands to the complete candidate-bound target Map node/relation scope.
- **Corruption/route regressions:** manifest-Map, version-Map, and originating-core-Map disagreement each prove zero equivalence reuse and one fresh validation. The real AttemptCoordinator `$map`/empty-target case projects one candidate-bound ready MapRepairPlan with the exact bounded full-Map scope.

### Re-review-3 fix qualification (2026-08-16)

- RED→GREEN: `$map` with empty repair targets originally threw `migration Content Finding has no resolvable slot target`; after primary-location classification it completes on the Map track.
- Source-custody corruption cases: **3 passed**; each produced `equivalenceRefs=0`, `revalidatedCount=1`, and a clear system route after fresh validation.
- Real durable 10,000-slot GC/reopen/restart proof: **1 passed** in **629.974 s** (uninterrupted and restart-at-73 roots/settlement/decision/manifest/event root byte-identical; 599 equivalence proofs + 1 fresh result).
- Focused migration/repair/Map/validator/attempt/projector/facade/capability/profile regression: **14 files / 281 passed, 1 skipped**. The skipped test is only the separately executed real 10k proof above.
- `npm run check`, `npm run build`, and `git diff --check`: passed.
- Runtime boundary remains facade-only with no production `EventStore` import; blob/event schemaVersion remains `1`; v1/capability/profile sources are unchanged.

## Adversarial re-review fix round 5

- **P1 — independently derived target selector expansion:** equivalence no longer copies the source validator envelope into the target custody dimension. Production reconstructs the canonical ordered expansion per installed validator selector from the exact target Map and frozen migration intent/plan. Every source-selected target must have an unchanged, target-authoritative `inherit_or_validate` counterpart with the same content bytes; a removed, rewritten, or schema-reset companion changes the expansion and forces the existing real target-Map validator path. Post-migration settlement independently performs the same reconstruction before accepting an equivalence proof. The installed registration list is a required service dependency rather than an optional production-only hint.
- **P1 regression:** a real source batch selects A+B while the exact target Map changes B's slot schema and the migration intent freezes B as `schema_reset`. A is now fresh-validated exactly once and no equivalence proof is emitted. The 10,000-node durable fixture obtains its 599 equivalences from the independently derived 600-target expansion, not copied source refs.
- **P2 — producer-plan identity by kind:** source custody branches on producer plan kind before identity validation. `repair_plan_spec` uses its canonical two-field identity (`specDigest` excludes both digest fields; `planRevisionId` binds repairPlanId/revision/specDigest), while generation/migration plans retain the canonical single self-digest rule.
- **P2 regressions:** a real content-repair-produced two-slot batch reuses the unchanged slot and fresh-validates the locally changed slot. Independently corrupting either `specDigest` or `planRevisionId` yields zero equivalence reuse and two real fresh validations.
- **Sequential custody:** the second-replacement GC/reopen fixture now preserves the complete original selector expansion in its target Map/intent; the unchanged slot remains equivalent and replay produces the same terminal batch root. Removing/resetting a companion is covered separately as a mandatory cache miss.

### Re-review-4 fix qualification (2026-08-16)

- Selector/repair/sequential production integrations: **5 passed**.
- Migration/repair/Map/validator/attempt focused regression: **7 files / 158 passed, 1 skipped**. The skipped case is only the separately executed real 10k proof.
- Real 10,000-node durable EventStore/projector/GC/reopen proof: **1 passed** in **634.610 s**; uninterrupted and restart-at-73 roots, settlement, decision, manifest, route, and complete event root are byte-identical with **599 independently justified equivalence proofs + 1 real fresh result**.
- Projector/append-facade/capability/profile guards: **5 files / 105 passed**.
- `npm run check`, `npm run build`, and `git diff --check`: passed.
- Runtime boundary remains facade-only with no production `EventStore` import; schemaVersion remains `1`; v1/capability/profile sources are unchanged.
