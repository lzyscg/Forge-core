# Task 20 Report — Migrate content across approved Map replacements

**Status:** IMPLEMENTED and locally qualified. This report is part of the commit `feat: migrate content across map revisions`; an independent Task 20 adversarial review remains the orchestrator's next gate.

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
- The property test covers **10,000 slots / 157 batches**, interrupts after ordinal 73, resumes from the first missing ordinal, and proves restarted/uninterrupted settlement and execution digests are byte-equal.
- Full Map review integration: **1 file / 16 passed** under one Vitest worker.
- Task 19 repair regression: **1 file / 35 passed** under one Vitest worker.
- Parser/event/projector/content-domain regression: **5 files / 765 passed**.
- `npm run check`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.

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
