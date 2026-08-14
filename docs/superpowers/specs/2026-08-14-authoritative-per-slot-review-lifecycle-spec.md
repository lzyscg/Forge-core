# Authoritative Per-Slot Review Lifecycle v2 Technical Specification

> **Status:** Approved after independent adversarial review (Cycle 3 Round 4)
> **Date:** 2026-08-14
> **Normative design:** [`2026-08-13-authoritative-per-slot-review-lifecycle-design.md`](./2026-08-13-authoritative-per-slot-review-lifecycle-design.md)
> **Compatibility baseline:** Structured Slot Engine v1 at commit `f89d721`

## 1. Purpose and normative precedence

This specification turns the approved lifecycle design into an implementable repository contract. It freezes module boundaries, protocol discrimination, storage and event seams, API shapes, rollout gates, and acceptance evidence for ForgeCore.

The precedence order is:

1. The approved lifecycle design defines business invariants and canonical domain-object semantics.
2. This document defines how those invariants map onto the current repository.
3. The implementation plan defines sequencing and verification, but may not weaken either document.

If implementation discovers a contradiction, capability `authoritative_review_v1` remains disabled until the spec and design are revised and independently re-approved. Code is not allowed to resolve a contradiction by inventing a third behavior.

## 2. Outcome

ForgeCore shall support two structured-slot protocols in the same process:

- Contract v1 keeps the current `structure -> fill -> seal -> submitter` behavior, existing events, Route scheduler, `request_seal`, BlobRefV1, SealRecord v1, cursor behavior, frozen template hashes, and historical replay unchanged.
- Contract v2 adds system-owned WorkItems, Map pre-review, per-node/per-slot/per-relation facts, deterministic review settlement, scoped repair, content migration, and System Seal.

For v2, a reviewer Agent can decide only the verdict for each assigned Map node, actual relation, content slot, or relation-satisfaction target. It cannot decide whether a Map, review round, slot tree, or delivery passes. The system derives those aggregate states from committed facts and frozen policy.

No v2 content generation may start before the proposed Map has a current system-approved MapReviewBundle and has been atomically activated. No artifact may be published before the system Seal Gate proves that every required slot and actual blocking relation has a current passing fact, all Findings are closed, and all deterministic validators are clear.

## 3. Scope

### 3.1 Included

- Strict Contract v2 and structured Agent turn contract v4.
- Optional relationship graph with zero relations and zero-degree slots both legal.
- Separate authoritative Map and content-review lifecycles.
- Per-task persistent WorkItem ledger, lease, attempt, retry, stop/resume, human-question, and crash recovery.
- BlobRefV2, recursive custody, publication pins, and GC barriers.
- MapBuild chunking, GenerationPlan batching, review Assignment ledgers, layered whole-tree observations, and 10,000-slot qualification.
- Validator v2 registration, canonical inputs, receipts, aggregates, warning custody, and deterministic routing.
- Content and Map repair, scope expansion, same-root/different-manifest staleness, and Map-activation content migration.
- System Seal, system artifact provenance, SystemArtifactDelivery, and generic Submitter handoff.
- Versioned read APIs, persistent snapshot cursors, v2 answer mutation, and six read-only UI views.
- A new v2 revision of `zhihu-salt-chapter-draft` after production qualification.

### 3.2 Excluded

- Migrating or backfilling existing v1 tasks.
- Inferring per-slot pass from a historical v1 whole-scaffold Seal.
- Parallel leases inside one task; v2 initially fixes `maxActiveLeasesPerTask = 1`.
- Human UI controls that directly edit reviewer verdicts, close Findings, alter Grants, or force Seal.
- Agent-created relation types, validators, IDs, digests, grants, WorkItems, or aggregate decisions.
- Template-supplied arbitrary validator code in v2. The first release accepts only installed allowlisted handlers.
- Treating a checked-in template, green unit tests, or a static UI as production qualification.

## 4. Compatibility and protocol discrimination

### 4.1 Frozen template discriminator

`FrozenTemplate.productionMode` remains `basic | structured_slots`. Structured protocol selection is exclusively:

```ts
type FrozenStructuredSlotContract =
  | FrozenStructuredSlotContractV1
  | FrozenStructuredSlotContractV2;

function structuredProtocolOf(template: FrozenTemplate): 'none' | 'v1' | 'v2' {
  if (template.productionMode !== 'structured_slots' || template.structuredSlots === null) {
    return 'none';
  }
  return template.structuredSlots.version === 1 ? 'v1' : 'v2';
}
```

The runtime must read the task's frozen snapshot. It must never select the protocol from the current catalog entry, template ID, newest source files, event-name heuristics, or capability status.

### 4.2 Hash and replay rules

- The v1 compiler, normalized v1 contract bytes, v3 turn contract, event payloads, and template hash algorithm remain byte-for-byte compatible.
- Contract v2 has a separate compiler and semantic-digest branch. No new default fields are injected into v1 normalization.
- `task-events.ts` retains every current v1 member and validation rule. V2 adds new closed members; it never widens an existing payload.
- `StructuredBlobRefV1`, `SealRecord`, v1 projection, v1 Route reachability, and the v1 cursor signer remain unchanged and v1-only.
- A process can read and run v1 and v2 tasks concurrently when their respective capability gates pass.

### 4.3 Frozen profile snapshot

`profileIdentity` is only a compatibility family name; it is never sufficient authority. The enabled manifest resolves an immutable `AuthoritativeReviewProfileSnapshotV1` whose canonical JSON contains the complete validated profile: identity/version, every object/API/assignment/byte/count/time/lease/retry/recovery/cursor/GC/event/assembler/validator limit and policy, implementation ABI identities, and `profileDigest = sha256(canonicalBytesWithoutDigest)`. Those bytes are stored in the installed profile archive by digest and are independently readable after a later capability/profile change.

When a v2 task is created, TaskStore copies the exact profile snapshot bytes into its frozen template snapshot, publishes a `profile_snapshot` BlobRefV2, and records `{profileIdentity, profileDigest, profileSnapshotRef}` in the prepared/active installation task index before the task becomes listable. `FrozenTemplate.authoritativeReviewProfile` and the v2 semantic template hash bind all three fields. Every `AuthorityBaseSetV2`, plan spec, AssignmentDispatch, WriteGrantSpec, ValidatorInputEnvelope, cursor snapshot, WorkItem and Seal authority must carry the exact `profileSnapshotRef`; display aliases must equal the resolved snapshot. A current deployment profile is never substituted.

The current base structured capability plus `authoritative_review_v1` enabled manifest decides whether new v2 tasks may compile/start/lease. Historical read/projection/genesis replay, corruption diagnosis, delete, and blob/schema validation resolve the archived task-bound profile even when the current capability is disabled or points to profile B. Missing/mismatched archived profile bytes make that task corrupt. Profile archive retention is at least the maximum task/evidence retention and GC never treats the current manifest as the sole root.

Temporary deployment eligibility is not `TaskStatus` and never rewrites or reinterprets event history:

```ts
type AuthoritativeReviewExecutionEligibilityV1 =
  | {
      state: 'eligible';
      frozenProfileDigest: string;
      currentProfileDigest: string;
    }
  | {
      state: 'blocked';
      reason:
        | 'base_capability_disabled'
        | 'authoritative_capability_disabled'
        | 'profile_digest_mismatch'
        | 'required_abi_unavailable';
      frozenProfileDigest: string;
      currentProfileDigest: string | null;
    };
```

The v2 workspace/detail projection exposes this separately from the event-derived task status. Scheduler claim/reclaim and any mutation that would create execution events require `state='eligible'`; read, genesis replay, corruption diagnosis, and fenced delete do not. A blocked task retains its underlying event status, WorkItem disposition, timers, and durable wakeup identity. Restoring the exact profile A and required ABIs causes startup/wakeup reconciliation to make an underlying `running` task runnable again without a lifecycle event; stopped, waiting-human, retry-budget-exhausted, failed, or other underlying states remain unchanged and require their existing dedicated command. `TaskStatus='incompatible'` remains terminal only for a frozen schema/protocol that the binary permanently cannot interpret.

Profile snapshots are immutable revisions. Their canonical bytes include `qualificationState: 'test_only' | 'provisional' | 'final'` and the exact installed validator/assembler registry identities. Adding or replacing a handler creates a new profile snapshot/digest and matching template hash; archived bytes are never edited. Production capability accepts only `final`. Task 5 may use an explicitly injected `test_only` registry/profile. Tasks that install production handlers must rotate the provisional profile, archive, loader/hash fixtures, and stale-profile tests atomically; qualification derives the sole final profile from the complete registry.

Qualification must create with profile A, restart under same-identity/different-digest profile B and disabled capability, prove reads/genesis/digests still use A while execution eligibility is blocked, then re-enable exact A and prove startup reconciliation continues the unchanged underlying state with unchanged lease/retry/recovery/limit semantics.

### 4.4 Runtime branching

The following entry points must branch once on the frozen contract version and then call an isolated implementation:

- template load/cache reopen;
- task create/start/resume/retry/answer/reopen/delete;
- task projection and workspace summary;
- scheduler and runner;
- structured tool provider and committer;
- artifact final-commit reachability;
- structured read API and UI drawer.

V2 code must not call the v1 `request_seal`, Proposal/Draft finalizers, v1 Grant, v1 structured attempt events, or Route-driven next-agent logic.

## 5. Repository architecture

### 5.1 Shared contracts

| File | Responsibility |
|---|---|
| `src/shared/authoritative-review-v2.ts` | Single source for BlobRefV2, public v2 enums/DTOs, pending question, Map/review/Finding/Seal summaries. |
| `src/shared/contracts.ts` | Adds `failed`, v2 workspace summary, ArtifactProvenanceV2 union, and re-exports public v2 DTOs without changing v1 shapes. |
| `src/shared/api-schemas.ts` | Exact TypeBox mirrors for new DTOs and versioned answer/delete/reopen mutations. |

### 5.2 Template and capability

| File | Responsibility |
|---|---|
| `src/server/template/structured-slot-contract-v2.ts` | Strict Contract v2 parse, cross-reference validation, semantic digest, resource manifest. |
| `src/server/template/authoritative-review-pipeline-validator.ts` | Role bindings, v4 turn contracts, system producer, forbidden Agent Routes, independent reviewer. |
| `src/server/structured-slots/authoritative-review-profile.ts` | Exact v2 limits and template/profile comparison. |
| `src/server/structured-slots/authoritative-review-capability.ts` | Independent disabled/enabled capability and evidence validation. |
| `src/server/structured-slots/authoritative-review-profile-v1.json` | Generated final v2 profile after qualification; provisional during tests only. |
| `src/server/structured-slots/authoritative-review-capability-v1.json` | Checked in disabled until final promotion. |

### 5.3 Pure domain

Pure, storage-independent rules live under `src/server/authoritative-review/`:

| File | Responsibility |
|---|---|
| `authority-types.ts` | Canonical internal object types that are not public API DTOs. |
| `object-registry.ts` | Closed Blob kind/schema/media registry and child-ref extractors. |
| `map-domain.ts` | Map normalization, semantic digest, diff, subgraph, impact closure, coverage. |
| `content-domain.ts` | Slot versions, manifest validation/root, presence-aware coverage, migration objects. |
| `review-domain.ts` | Review facts/adoption, assignment/observation closure, settlement calculations. |
| `finding-domain.ts` | Finding classification/lifecycle, verification, deterministic route. |
| `work-item-domain.ts` | AuthorityBase matrix, WorkItem transitions, retry/suspension/question invariants. |
| `seal-gate.ts` | Pure ten-condition Gate returning structured unmet conditions, never a model verdict. |

These modules may depend on shared v2 types and the existing canonical JSON implementation, but never on filesystem, EventStore, Pi, HTTP, React, or wall clock.

### 5.4 Storage and projection

| File | Responsibility |
|---|---|
| `src/server/storage/authoritative-review-events.ts` | Closed v2 event union and exact validator. |
| `src/server/storage/authoritative-review-blob-store.ts` | Canonical BlobRefV2 put/read, schema registry, recursive ref validation. |
| `src/server/storage/authoritative-publication-store.ts` | Durable PublicationPin, generation barrier, recovery, recursive GC. |
| `src/server/storage/authoritative-append-facade.ts` | The sole v2 append path; cross-process store fencing, fresh-tail CAS, pin/ref verification, version allocation, and durable EventStore commit. |
| `src/server/storage/authoritative-review-state.ts` | Pure genesis replay for v2 authority and invariant checks. |
| `src/server/storage/authoritative-review-checkpoint-store.ts` | Append manifest, projection checkpoints, fixed-through-sequence snapshots. |
| `src/server/storage/authoritative-review-private-store.ts` | Attempt-bound Map/content/review draft journals and repair staging. |
| `src/server/storage/review-cursor-keyring.ts` | Installation-persistent cursor keys, rotation, verification retention. |
| `src/server/storage/authoritative-task-index.ts` | Installation-level immutable v2 task/protocol identity used even when the task root is corrupt or detached. |
| `src/server/storage/authoritative-task-deletion.ts` | Fenced v2 deletion tombstone, quarantine rename, purge recovery, and no-resurrection checks. |

### 5.5 Runtime

Runtime v2 lives under `src/server/runtime/authoritative-review/`:

| File | Responsibility |
|---|---|
| `authority-base.ts` | Kind-specific AuthorityBaseSet field matrix and stale checks. |
| `work-item-coordinator.ts` | WorkItem creation, deterministic ordering, lease/reclaim, retry, suspension, question delivery. |
| `attempt-coordinator.ts` | Structured Agent, generic Agent, and SystemCommand attempt envelopes. |
| `grant-service.ts` | WriteGrantSpec and lease-bound GrantInstance validation. |
| `tool-factory.ts` | Session-specific bound tools; no task/grant/path parameters and no Seal tool. |
| `validator-registry.ts` | Allowlisted handler identity and digest registry. |
| `validator-engine.ts` | Input envelope, isolated deterministic execution, receipt/aggregate/warning custody. |
| `map-build-service.ts` | MapBuild chunks, frontier/key ledger, finish proposal, candidate finalization. |
| `review-coordinator.ts` | Map/content round planning, assignments, facts/adoption, observation, settlement. |
| `content-plan-service.ts` | GenerationPlan, content versions/manifests, batch/finalizer commits. |
| `finding-service.ts` | Finding classification, lifecycle, verification, deterministic repair route. |
| `repair-service.ts` | Map/content RepairPlan revisions, staging CAS, Grants, scope expansion, finalizer. |
| `migration-service.ts` | Intent, recoverable validation batches, settlement, finalizer, activation decision. |
| `system-seal-service.ts` | Seal Gate, assembler, seal validators, artifact publication and delivery. |
| `projection-service.ts` | Owner read model, snapshot queries, legacy issues compatibility projection. |

`task-scheduler.ts`, `task-runner.ts`, `pi-agent-runtime.ts`, `action-committer.ts`, and `core-service.ts` gain only explicit version dispatch and dependency injection. V1 domain services remain unchanged.

## 6. Contract v2

### 6.1 Exact top-level shape

```yaml
version: 2
slotTypes: []
layoutGrammar: {}
accessProfiles: []
relationTypes: []
relationshipPolicy: { mode: disabled | optional }
reviewPolicy: {}
validators: []
assembler: {}
limits: {}
```

Unknown fields fail with `SLOTS_CONTRACT_INVALID`. Cross-version fields fail rather than being ignored.

`relationshipPolicy.mode=disabled` requires no relation types and zero candidate relations. `optional` requires at least one declared type but permits zero Map relations and zero relations on every individual slot. The platform has no minimum-relation rule.

### 6.2 Review policy

The compiler normalizes and freezes:

```ts
interface ReviewPolicyV2 {
  mapReview: 'required';
  contentSelector: 'content_bearing';
  mapBatchTargetSlots: number;      // default 24
  contentBatchTargetSlots: number;  // default 24
  assignmentSoftLimit: number;      // default 64, <= profile hard limit
  wholeMapObservation: 'required';
  wholeContentTreeObservation: 'required';
  reviewAdvisoryRelations: boolean;
  maxRounds: number;
}
```

The qualified v2 profile must support at least 256 primary targets, 1,024 total objects in one assignment, and 10,000 slots across a complete plan. These are profile ceilings, not schema constants. Templates may tighten them but cannot expand them beyond the active profile.

### 6.3 Pipeline roles and system producer

`pipeline.yaml` adds:

```yaml
structuredReviewLifecycle:
  protocol: authoritative_review_v1
  roleBindings:
    orchestrator: structure
    generator: fill
    reviewer: review
    submitter: submitter
  systemArtifactProducer: system:structured_seal
```

Contract v2 does not smuggle `system:structured_seal` through the current safe Agent-ID fields. The pipeline parser gains a versioned structured lifecycle block and the artifact schema gains a discriminated producer reference:

```ts
type ArtifactProducerRef =
  | { kind: 'agent'; agentId: string }
  | { kind: 'system'; systemId: 'structured_seal' };
```

V1/basic scalar `producer: seal` normalizes to the existing Agent branch and preserves its canonical hash. A v2 file uses an explicit system branch in YAML; the exact syntax is frozen by the v2 fixture/compiler and enters the template hash. Generic `routes.from/to` and Agent IDs continue using the existing safe-ID rules and never accept a colon-bearing system identity.

The loader enforces:

- exactly one binding for every role;
- reviewer ID differs from orchestrator, generator, and every Agent allowed to write Map or content;
- `system:structured_seal` is not an Agent and cannot be a Route endpoint;
- structured roles cannot Route completion to review, repair, Seal, artifact publication, or Submitter;
- the Submitter accepts only SystemArtifactDelivery;
- the artifact schema's create producer is exactly `system:structured_seal`;
- no v2 Agent exposes `request_seal`.

### 6.4 Structured turn contract v4

V1 Agents retain `StructuredTurnContractV3`. V2 structured Agents use:

```ts
export interface AuthoritativeStructuredTurnContractV4 {
  version: 4;
  authoritativeReview: {
    allowedSessionKinds: StructuredSessionKindV2[];
    accessProfiles: Partial<Record<StructuredSessionKindV2, string | null>>;
    capabilities: SlotCapabilityV2[];
  };
  dispatch: {
    allowedActions: Array<'request_human_input'>;
    targets: Record<string, never>;
  };
}
```

`StructuredSessionKindV2` and `SlotCapabilityV2` are the closed sets approved in design section 9. An Agent may support multiple session kinds because the orchestrator handles both structure chunks and Map repair, the generator handles generation and content repair, and the reviewer handles Map/content batch and whole observations. The WorkItem chooses one allowed session and receives only that session's capability intersection.

The Submitter remains a generic BasicTurnContractV2 Agent and never receives structured write tools.

### 6.5 Validator registrations

`ValidatorRegistrationV2` is distinct from v1 and contains:

```ts
interface ValidatorRegistrationV2 {
  validatorId: string;
  handlerKey: string;
  implementationDigest: string;
  implementationRef: {
    kind: 'builtin';
    moduleId: string;
    exportName: string;
  };
  trigger:
    | 'map_candidate_commit'
    | 'map_review_settlement'
    | 'map_activation'
    | 'content_commit'
    | 'review_settlement'
    | 'seal_input'
    | 'seal_output';
  executionPhase: 'batch_commit' | 'plan_finalize' | null;
  selector: ValidatorSelectorV2;
  enforcement: 'blocking' | 'advisory';
  deterministic: true;
  inputContractVersion: number;
  outputContractVersion: number;
  budgetProfileId: string;
}
```

Only `content_commit` may use a non-null execution phase. `seal_output` advisory registrations are rejected. Handler identity, module/export, implementation digest, trigger, phase, ABI, and budget must match exactly one installed registry entry.

## 7. Authority objects and BlobRefV2

### 7.1 Reference

```ts
export interface BlobRefV2 {
  kind: AuthoritativeBlobKindV2;
  digest: string;
  byteLength: number;
  mediaType: 'application/json' | 'text/markdown' | 'text/plain';
  schemaVersion: number;
}
```

`digest` is lowercase SHA-256 of the exact canonical bytes. Every cross-object authority or custody link is a BlobRefV2. A duplicate plain digest is display-only and must equal the corresponding ref digest. A bare digest never keeps an object alive and never satisfies a Gate.

The closed kind registry includes `profile_snapshot`, `publication_operation_payload`, Map build specs/chunks/manifests/key ledgers, Map candidates/validation cores/snapshots/bundles, content values/versions/manifests/commit and finalize cores, generation/repair/migration specs and results, review facts/ledgers/adoptions/round cores/bundles, Findings/verifications, authority bases/grants/dispatch payloads, validator envelopes/receipts/failures/aggregates/warning roots, Seal bundles/records/artifacts/deliveries, and checkpoints. `publication_operation_payload` is a closed discriminated union over operation families (domain publish, lease/retry/lifecycle/question/recovery/delete state-only mutation, artifact publish/version allocation); each branch has exact keys, authority/event-builder inputs, child refs, and profile size limit. `PublicationIntentV2` is an exact persisted record whose handler-kind/version matrix requires one payload branch and one result/event schema; it is not an open string-to-blob pair. `profile_snapshot` has an exact schema/parser, `application/json` media type, schema version, child-ref extractor, and profile-independent bootstrap maximum large enough to parse the profile that supplies all later per-kind limits. The object's `profileDigest` equals SHA-256 of canonical bytes with that field omitted; `profileSnapshotRef.digest` equals SHA-256 of the exact complete object bytes. They are distinct identities. The task-index/frozen-template `profileDigest` alias must equal the resolved object field, while their `profileSnapshotRef` must byte-equal the actual BlobRef, including byte length.

Each kind has exactly one schema version, media type, parser, child-ref extractor, and maximum byte policy in the registry. Unknown kinds or schema versions fail closed.

### 7.2 Map identities

- `MapCandidateSnapshot` is rejected or approved input and never the active Map.
- `MapSnapshotRef.digest` identifies the entire snapshot bytes, including review/provenance/revision.
- `mapSemanticDigest` identifies only normalized position structure, declared actual relations, template identity, and applicable semantic fields.
- These identities must never be equated. Content objects verify their `mapSemanticDigest` against the resolved MapSnapshot but bind authority and staleness to `mapRef`.

### 7.3 Content identities

Every Map content slot has one `SlotContentVersionV2` entry in a `ContentRevisionManifestV2`. Entry state is exactly one of:

- `unset` with `initial | new_slot | schema_reset | carry_unset` provenance;
- `rewrite_required` with source and blocking evidence;
- `set` with content blob and generated or migrated provenance.

The manifest completely covers the current Map, is sorted by slot ID, and has phase `baseline_unset | provisional | finalized`. Only `finalized` is Seal-eligible. `contentRootDigest` identifies normalized slot leaves; the manifest ref identifies authority and custody. Equal roots with different manifests are different revisions and stale old Grants and reviews.

### 7.4 Review facts

Agent review outputs become immutable facts only when `complete_review_assignment` atomically publishes a validated AssignmentLedgerBlob. A draft journal never participates in a Gate.

Every fact binds stable target identity, subject digest, local context digest, review policy digest, current round/assignment source, and origin:

```ts
type ReviewFactOriginV2 =
  | { kind: 'batch'; adoptionEligible: true }
  | { kind: 'whole_observation'; adoptionEligible: false };
```

Historical batch facts participate in a new round only through a system-created ReviewAdoptionRecord and current ReviewAdoptionRoot. Whole-observation facts are never adopted. Current assignment facts and adopted historical facts are disjoint coverage sources.

## 8. Durable publication and GC

All v2 objects use `structured-slots/v2/blobs/<kind>/<first2>/<digest>` under the task root. Visibility follows put-before-append:

1. Create and fsync a durable PublicationPin containing operation ID, expected tail/commit identity, complete BlobRefs, GC generation, server time, owner epoch, and a `PublicationIntentV2` with the canonical operation-payload ref, closed handler kind/version, expected result identity, and deterministic event-envelope builder inputs. Agent text and executable callbacks are never stored in the pin.
2. Canonically encode each object, write/fdatasync a same-filesystem temporary file, verify ref fields, atomically rename, and fsync its parent. Existing same-address bytes must compare exactly or the task becomes corrupt.
3. Under the cross-process generation/append barrier, re-read the task tail and every ref, then commit the referencing TaskEvent batch through existing `EventStore.appendBatch`.
4. After commit durability, mark/delete the pin. Response-loss replay uses the same operation/commit ID.

GC marks event-rooted refs, active pins (including their intent payload refs), and installation-owned task roots, recursively following the registered child-ref extractors. For every v2 `prepared | active` task-index entry, `profileSnapshotRef` and the matching ref in the frozen template are formal roots; a delete tombstone retains the root and its resolved prepared/final/quarantine location until the tombstone is durably `purged`. Creation recovery resolves a prepared entry before GC may sweep that task. GC excludes objects newer than the mark-start generation. Before deleting, it rechecks event roots, pins, task-index/tombstone roots, and generation under the same barrier. Startup may complete a crashed pin only by resolving its allowlisted handler/version and operation-payload ref, deterministically rebuilding byte-identical events/results, and rechecking the expected tail/authority/idempotency predicate. If the intent is absent/unknown, reconstruction differs, or legality no longer holds, the pin is abandoned after owner-lease expiry and survives one additional full generation; the owning WorkItem/lifecycle recovery creates a new legal operation rather than guessing the old event envelope.

A formally referenced missing, mismatched, or unparseable blob makes the v2 task `corrupt`. Checkpoints are accelerators, not roots.

### 8.1 Sole v2 append facade and cross-process exclusion

Every batch containing an `AuthoritativeReviewEventV2` must be submitted through `AuthoritativeAppendFacadeV2`; no domain service, lifecycle endpoint, recovery worker, timer, or SystemCommand receives a raw `EventStore`. The legacy `EventStore.appendBatch` path rejects a v2 member unless the call carries a currently valid facade-issued store-fence proof. A dependency-boundary test rejects direct `EventStore` imports from v2 runtime/domain modules.

The first release uses one installation/data-root scoped cross-process exclusive store lock for the short publication commit section. Its fencing record contains owner PID, process-start token, lease epoch, acquisition nonce, and durable generation. Stale takeover requires proving the recorded process/start token is dead and atomically advancing the epoch; wall-clock expiry alone cannot steal a live lock. Under that lock, the facade must, in order:

1. reload the append manifest and task event tail from disk rather than an instance cache;
2. verify the operation/commit id has not already committed, the expected tail/commit identity still matches, the PublicationPin is active, and every referenced BlobRef resolves exactly;
3. allocate sequence numbers and any artifact version from the fresh combined v1/v2 history;
4. call `appendBatch`, fsync every batch file and its parent directory, then re-read the committed tail/commit identity;
5. durably advance the generation/fence record before releasing the lock.

All v2 state-only mutations use the same facade with an empty prepared-ref set; this includes lease, retry timer, stop/resume, human answer, startup recovery, and task failure. Pin cleanup occurs after the locked durable commit. GC obtains the same store lock for mark-generation capture and final delete recheck, so it cannot interleave a stale mark/delete decision with a publication commit.

Two `EventStore`/PublicationStore instances aimed at the same data root must therefore converge to one winner or two non-overlapping ordered commits. Overlapping sequence files, different payloads under one commit ID, or a v2 append without a live fence are storage corruption/fail-closed errors, never last-writer-wins behavior.

## 9. Events, projection, and atomic boundaries

### 9.1 Event integration

`authoritative-review-events.ts` exports `AuthoritativeReviewEventV2` and `validateAuthoritativeReviewEventV2`. `task-events.ts` exports:

```ts
export type TaskEvent = LegacyTaskEvent | AuthoritativeReviewEventV2;
```

All v2 members carry `protocolVersion: 2`, stable `id`, `at`, and exact identity/ref fields. The event families and names are those frozen in design section 17.4. Existing names such as `structured_slot_attempt_started` stay v1-only; v2 uses the suffixed Agent-attempt family and distinct generic/SystemCommand families.

Events carry refs and small summaries, never 10,000 verdicts or full bodies. Assignment, adoption, migration-batch, and other large results live in immutable blobs.

### 9.2 Atomic envelopes

The following are single `appendBatch` commits after all referenced blobs have been pinned and verified:

- task start plus MapBuild spec, first WorkItem, AuthorityBase and WriteGrantSpec;
- WorkItem lease plus AssignmentDispatch, attempt/command start, confirmed display input, and GrantInstance when applicable;
- Agent completion plus immutable domain result, attempt terminal, WorkItem completion, progress checkpoint, and deterministic successor WorkItem;
- SystemCommand completion plus domain result, command terminal, WorkItem completion, and successor;
- retry failure/requeue/budget park/manual retry;
- stop/resume suspension overlay;
- human question open/delivery/replacement;
- review settlement plus repair plan, or ReviewBundle plus Seal WorkItem;
- Map activation plus migrated/current manifest and next plan;
- SealRecord, artifact publication, SystemArtifactDelivery, and Submitter WorkItem;
- final submission plus generic attempt and WorkItem completion.

No visible state may contain a leased WorkItem without its attempt/command, a completed WorkItem without its result, an activated Map without its chosen content manifest, or a published system artifact without delivery custody.

### 9.3 Pure projector

`projectAuthoritativeReviewState(events, resolver)` replays from genesis and validates:

- at most one active task lease;
- at most one pending v2 question and one budget-exhausted disposition;
- exact WorkItem transition and epoch ordering;
- immutable plan/spec lineage and single active successor;
- current Map/content/round/Finding/Seal ref closure;
- legal attempt type for WorkItem execution kind;
- no Agent-created aggregate, Grant, ID, time, or system result;
- no stale AuthorityBase completion;
- exact system-producer delivery chain.

Any invariant violation yields a structured corruption diagnostic; it is never skipped during replay.

### 9.4 Incremental replay

The event store gains validated tail-range access plus an append manifest containing tail sequence, event-ID index, commit-ID index, and envelope digests. V2 projection checkpoints bind `throughSequence`, prior checkpoint digest, and projection schema version. Startup reads the last valid checkpoint and replays the tail. Qualification must reproduce its digest by independent genesis replay.

## 10. WorkItem execution protocol

### 10.1 WorkItem

The WorkItem, AuthorityBaseSet, park disposition, and session-kind unions are exactly those frozen in design section 17.2. WorkItem kinds are:

```ts
type WorkItemKindV2 =
  | 'agent_assignment'
  | 'system_map_finalize'
  | 'system_generation_finalize'
  | 'system_repair_finalize'
  | 'system_migration_validation_batch'
  | 'system_review_settlement'
  | 'system_seal';
```

Agent assignments discriminate `structured_session` from `generic_turn`; only review assignments have `reviewAssignmentId`. System WorkItems have no Agent identity. AuthorityBaseSet has a closed required/null field matrix per WorkItem kind.

The implementation must copy the complete frozen schemas from the approved design rather than invent a smaller runtime shape:

- `AuthorityBaseSetV2` always contains the exact `profileSnapshotRef` plus template snapshot, current Map/candidate/Map-review bundle, content manifest, plan/staging/round/coverage/review bundle, Finding set, Seal/artifact/delivery refs, and verified display aliases. Each WorkItem kind has an exact required/null matrix for the phase-specific refs; profile/template refs are mandatory for every kind.
- `WriteGrantSpec` is the closed union `InitialStructureGrantSpec | InitialGenerationGrantSpec | RepairBatchGrantSpec`; a lease creates a separate `GrantInstance` bound to WorkItem, attempt, Agent, epoch, and the same AuthorityBase.
- `TaskSuspensionOverlay` is a task-level event-derived object distinct from WorkItem state.
- `StructuredHumanQuestion` and `HumanAnswerDelivery` bind original/replacement WorkItem, logical assignment, attempt, lease epoch, AuthorityBase, question version/digest, answer digest, and operation ID.
- Every successful WorkItem completion records a monotonic digest-bound progress checkpoint; planned-work overflow or checkpoint regression is a system failure.

### 10.2 Leasing

- Only `ready` and task-unsuspended WorkItems are claimable.
- Deterministic ordering is plan ordinal, observation level/order, system phase order, then WorkItem ID.
- Lease is a tail-CAS transition and sets the sole active lease.
- Agent lease materializes a unique conversation namespace `<executionKind>/<roleBinding>/<workItemId>/<attemptId>`.
- A structured write lease signs a GrantInstance from the immutable GrantSpec after attempt ID and epoch exist.
- Expired leases atomically abandon the old attempt/command and dispatch, increment epoch, clear active lease, and return the WorkItem to ready.
- Late completion from an older epoch or AuthorityBase is rejected without partial writes.

### 10.3 Retry, stop, and terminal failure

Retryable failure records ordinal, server-computed not-before, budget, full authority, and applicable validator aggregate. Requeue is a separate durable transition. Exhausted budget parks the WorkItem with `retry_budget_exhausted`; only the v2 manual-retry command clears it.

Task stop/interruption is a separate suspension overlay and never overwrites the WorkItem's underlying park disposition. Resume removes only that overlay. A question or budget-exhausted WorkItem remains parked after resume.

Permanent failure atomically terminal-fails the attempt/command and WorkItem and writes `structured_task_failed_v2`; shared `TaskStatus` gains `failed`. Ordinary start/resume/retry reject `failed`. Only an authorized, reasoned, idempotent `reopen_failed` command may create a replacement WorkItem using a frozen recovery recipe.

### 10.3.1 Exact failed-task recovery contract

The public mutation is:

```ts
type RecoveryRecipeKeyV2 =
  | 'retry_system_command'
  | 'restart_map_review_cycle'
  | 'restart_content_review_cycle'
  | 'rebuild_missing_work';

interface ReopenFailedRequestV2 {
  expectedLastSequence: number;
  operationId: string;       // UUID v4
  reason: string;            // trimmed, 1..1000 Unicode code points
  recipeKey: RecoveryRecipeKeyV2;
  track: 'map' | 'content' | null;
}

type FailureRecoveryPayloadV2 =
  | {
      kind: 'retry_system_command';
      failedWorkItemId: string;
      failedCommandId: string;
      failedLeaseEpoch: number;
      terminalEventId: string;
      terminalCommitId: string;
      authorityBaseRef: BlobRefV2;
      systemKind: Extract<WorkItemKindV2, `system_${string}`>;
      systemPayloadRef: BlobRefV2;
    }
  | {
      kind: 'restart_review_cycle';
      track: 'map' | 'content';
      failedWorkItemId: string;
      failedAttemptOrCommandId: string;
      failedLeaseEpoch: number;
      terminalEventId: string;
      terminalCommitId: string;
      authorityBaseRef: BlobRefV2;
      rejectedSubjectRef: BlobRefV2;
      findingSetRef: BlobRefV2;
      failedCycleOrdinal: number;
    }
  | {
      kind: 'rebuild_missing_work';
      predecessorResultRef: BlobRefV2;
      expectedSuccessorKind: WorkItemKindV2;
      expectedSuccessorPayloadRef: BlobRefV2;
      authorityBaseRef: BlobRefV2;
      grantSpecInputRef: BlobRefV2 | null;
    };

interface RoundBudgetOverrideV2 {
  overrideId: string;
  failedEventId: string;
  track: 'map' | 'content';
  repairLineageId: string;
  initialRepairPlanRef: BlobRefV2;
  currentAuthorizedRepairPlanRef: BlobRefV2;
  predecessorOverrideRef: BlobRefV2 | null;
  transferOrdinal: number;
  operationId: string;
  operatorId: string;
  reasonDigest: string;
  state: 'available';
}
```

The first local-owner release uses the server-fixed operation principal `{id:'task_owner', permissions:['task:reopen_failed','task:delete']}`; there is no current authentication subsystem to infer an identity from an arbitrary header. Future authentication may replace that dependency-injected principal but must preserve the same permission check. The body cannot name an operator. The exact endpoint is `POST /api/tasks/:taskId/reopen-failed`. CoreService loads the frozen v2 task and current failed projection, then applies this closed policy table:

| Failure class | Legal recipe/body | Exact successor |
|---|---|---|
| `ARTIFACT_VALIDATION_FAILED`, permanent assembler/Seal handler failure, other recoverable terminal SystemCommand failure with a stored recovery payload | `retry_system_command`, `track=null` | Clone the failed System WorkItem kind/payload into one new ready WorkItem with epoch 1, exact latest legal AuthorityBase, no Agent Grant, and a new SystemCommand attempt only after lease. It never reuses or publishes prior staging. |
| `REVIEW_REPAIR_LIMIT_EXCEEDED` with failed track recorded as Map | `restart_map_review_cycle`, `track='map'` | Create one available `RoundBudgetOverrideV2(track=map)`, one successor MapRepairPlan revision from the last rejected candidate/current Map Finding set, one structure repair WorkItem, and exact Map Repair WriteGrantSpec. Do not increment a cycle during reopen. |
| `REVIEW_REPAIR_LIMIT_EXCEEDED` with failed track recorded as content | `restart_content_review_cycle`, `track='content'` | Create one available `RoundBudgetOverrideV2(track=content)`, one successor ContentRepairPlan revision from the current finalized/provisional manifest and blocking Finding set, one content repair WorkItem, and exact Content Repair WriteGrantSpec. Do not increment a cycle during reopen. |
| `RUNNING_WITHOUT_WORK` where projector stores a unique reconstructible expected-successor recipe | `rebuild_missing_work`, exact stored track or null | Recreate only that expected successor kind/payload/AuthorityBase and applicable GrantSpec from the persisted failed-event recovery payload. |

Every `structured_task_failed_v2` eligible for reopen therefore carries `failureRecoveryPayloadRef: BlobRefV2`; an ineligible failure requires that field to be null. `FailureRecoveryPayloadV2` and `RoundBudgetOverrideV2` are registered canonical object kinds. WorkItem, AgentAttempt, and SystemCommandAttempt are event-ledger identities, not invented canonical blobs: retry/review branches require their exact IDs, lease epoch, and terminal event/commit identity, while only AuthorityBase, system payload, rejected subject, Finding set, and other actual canonical objects use BlobRefV2. The projector resolves the IDs against the terminal event in that commit and rejects a kind/epoch/base mismatch. `rebuild_missing_work` explicitly forbids failed WorkItem/attempt/command identity fields because that failure proves there is no non-terminal WorkItem; it instead requires predecessor result, expected-successor payload/kind, AuthorityBase, and optional GrantSpec input. The strict event validator, canonical recovery-payload object parser/child-ref registry, projector, GC roots, and recovery-policy matcher use the same branch matrix. If no row applies, payload is absent, refs are stale, or reconstruction is ambiguous, in-place reopen is forbidden and UI offers clone only. Provider/validator policy violations, storage corruption, incompatible snapshots, delete tombstones, and artifact bytes whose source authority is unavailable are never reopenable.

The fenced reopen batch verifies exact tail/failure/recipe/permission, writes one `structured_task_reopened_v2` with operator/reason/operation/recipe/recovery-payload refs and (for round limit) `overrideRef`, leaves the failed WorkItem immutable, creates exactly one ready replacement plus applicable system-owned WriteGrantSpec, creates the one available `RoundBudgetOverrideV2` only for a round-limit recipe, and upserts the durable wakeup. `RoundBudgetOverrideV2` is a registered canonical Blob kind with child refs; the reopen event is its GC/root and its existence event. Same operation/body replays; a changed body conflicts; stale tail returns `AUTHORITY_BASE_STALE` without partial writes. Neither a client nor Agent can widen the recipe, scope, Grant, base, cycle counter, or override.

The owner task summary exposes a bounded `FailedTaskRecoverySummaryV2` with failure code, failed sequence, legal recipe keys/tracks, `reopenAllowed`, and clone fallback—never private refs or evidence. `ForgeCoreGateway.reopenFailedTask`, HTTP gateway, exact TypeBox schema, task route, CoreService, and task controls use that summary. The UI generates one UUID per confirmation attempt, requires a reason, sends the displayed `expectedLastSequence`, retains the same operation/body across response-loss retries, and offers only server-returned legal recipes. V1 has no reopen endpoint behavior.

### 10.4 Startup recovery and durable wakeups

`WorkItemCoordinatorV2` owns an installation-persistent wakeup index; process-local queues and timers are only accelerators. On every startup it scans every v2 task snapshot through the projector and converges with:

| Projected state | Recovery action |
|---|---|
| `running` + leased/in-flight | With `recoveryOperationId = H(taskId, observedTailCommitId, recoveryPolicyVersion)`, atomically abandon the stale Agent/System attempt and dispatch, invalidate the draft journal, reclaim epoch+1 to ready, and enqueue the task. |
| `running` + ready + no lease | Insert/repair its durable runnable wakeup row, then claim only through normal tail-CAS leasing. |
| `running` + retryable failure before due | Recreate the durable due-time wakeup from event state; do not requeue early. |
| `running` + retryable failure at/after due | Use the stable recovery operation ID to atomically append the normal requeue event, then enqueue. |
| `running` + no non-terminal WorkItem | Atomically fail with `RUNNING_WITHOUT_WORK`; never remain falsely running. |
| stopped/interrupted overlay | Do not claim. Retain/rebuild underlying retry due-time and runnable index entries as dormant so resume cannot lose them. |
| waiting human | Rebuild pending question from opened/delivered events only; do not claim or synthesize an answer. |
| completed/failed/corrupt/incompatible | No claim; remove disposable wakeups. |

The scan, normal completion notification, retry timer, and resume path all upsert the same durable wakeup identity. Repeating recovery before or after response loss returns the same compensation commit; a changed observed-tail input creates a new legal recovery ID and must reproject before acting. The first release's frozen `recoveryPolicyVersion` is `auto_continue_v1`; it never guesses a crash to be an operator interruption. Any future interruption-on-crash semantic requires a new policy version and atomic suspension overlay.

### 10.5 Cross-process-safe task deletion

V2 deletion is a fenced lifecycle operation, not the current best-effort `scheduler.releaseTask()` plus recursive directory removal. It is allowed from any non-corrupt owner-visible task status but uses the sole installation store fence and a durable installation-level tombstone outside the task directory:

```ts
interface DeletedTaskTombstoneV2 {
  protocolVersion: 2;
  taskId: string;
  templateSnapshotHash: string;
  deleteOperationId: string;
  requestedBy: string;
  reason: string;
  observedTailCommitId: string;
  deleteEpoch: number;
  state: 'prepared' | 'detached' | 'purged';
}
```

Under the same cross-process store fence, delete reprojects the task, rejects a conflicting delete operation, advances a durable delete epoch/tombstone to `prepared`, and makes all facade appends, lease claims, timers, recovery, pin replay, and reads reject `TASK_DELETED` for that task ID. It then abandons any in-flight attempt/owner only as deletion cleanup (no later task event is appended), removes its durable wakeup entries, marks all pins non-replayable, atomically renames the task root to an installation trash/quarantine path keyed by task ID + delete epoch, fsyncs both parents, and advances the tombstone to `detached` before releasing the fence. Recursive purge of the detached quarantine happens afterward and advances to `purged`; a crash at any phase is resumed from the tombstone. The tombstone is retained according to installation policy and prevents task ID reuse or directory resurrection.

Any worker/facade that prepared work before delete must recheck the external tombstone/delete epoch while holding the fence and fail before append/rename. A missing active directory with a prepared/detached tombstone is deletion recovery, not task corruption. A directory that reappears for a tombstoned ID is quarantined as an orphan and never scheduled. V1 deletion remains on the legacy path. Qualification races two independent service/store instances across append, retry wakeup, active PublicationPin, System Seal staging, startup recovery, and delete, then restarts and proves the task cannot reappear, publish, or be claimed.

Before the first release is allowed to create any Contract v2 task, installation bootstrap must durably complete `authoritative-task-index-migration-v1`. Under the installation fence it snapshots every task-directory name that exists before the migration marker, writes one `legacy_preexisting` index identity for each name even when its task record/snapshot is unreadable, fsyncs the index, and only then writes/fsyncs the completed migration marker. Those names may use the legacy delete path because their pre-v2 existence is now proven independently of their contents; they can never be reused for v2. A crash before marker completion resumes the same captured-directory migration under the fence, and v2 task creation remains disabled. A directory first appearing after the marker without a prepared/active index is never classified legacy and is quarantined/fail-closed.

After that barrier, an installation-level immutable task index records `taskId + frozen protocol version + templateSnapshotHash` with `state: prepared | active`; legacy rows use `state: legacy_preexisting` and do not claim a protocol version. `TaskStore.create` remains the sole ID allocator and receives an `AuthoritativeTaskIndexV1` dependency. Under the same installation store fence it: (1) requires the completed migration marker and rejects a tombstoned/reused/legacy-preexisting ID; (2) durably writes/fsyncs the prepared index entry outside the task root; (3) creates/fsyncs the complete temporary task root and snapshot; (4) atomically renames the root into the listable tasks directory and fsyncs that parent; and (5) advances the index entry to active before releasing the fence. Listing/opening ignores prepared entries and directories without an active matching index for newly created v2 tasks.

Startup creation recovery runs before listing/scheduling: prepared + no final root removes/quarantines any temp root and cancels the entry; prepared + complete matching final root verifies snapshot then activates; active + missing root is corruption/deletion recovery depending on tombstone; active + mismatched root is quarantined. `legacy_preexisting` permits view/delete through existing legacy rules without claiming parse validity. Any post-marker task directory without a prepared/active index always fails closed and is never sent to legacy deletion—even if its bytes resemble a valid v1 or v2 task. Delete dispatch consults the migration marker/index before reading the possibly corrupt task root, so a preexisting corrupt task keeps legacy delete while an unindexed post-marker directory cannot bypass fenced/quarantine handling.

The public v2 delete mutation is exact:

```ts
interface DeleteTaskBodyV2 {
  operationId: string; // UUID v4
  reason: string;      // trimmed, 1..500 Unicode code points
}

interface DeleteTaskResultV2 {
  operationId: string;
  state: 'detached' | 'purged';
}
```

The server-fixed local owner principal supplies `requestedBy='task_owner'`; clients cannot forge it. Current task-list/detail projection adds required `structuredProtocol: 'none' | 'v1' | 'v2'`, derived from the frozen snapshot or immutable installation task index, so the client does not guess from status/template ID/events. `ForgeCoreGateway.deleteTask(taskId, request?)` requires `request` when the corresponding summary says v2 and sends exact JSON on `DELETE /api/tasks/:taskId`; v1 callers continue sending no body. The task-list delete dialog creates one UUID operation ID when it opens and retains that ID and canonical reason across retries/response loss until success, cancel, or choosing a new deletion. Same operation + same canonical body returns the tombstone result even after purge; same operation + different reason is an idempotency conflict. Missing/unknown fields or a v1 body on v2 return a stable exact mutation error without beginning deletion. Server-side CoreService still dispatches by the installation task index, not by trusting the body's branch or the public summary.

### 10.6 Human questions

Only an active Agent attempt may open one StructuredHumanQuestion under the frozen question policy. SystemCommands cannot ask humans.

V2 workspace returns:

```ts
interface PendingQuestionV2 {
  questionId: string;
  questionDigest: string;
  questionVersion: string;
  source: 'agent_request' | 'progress_guard';
  text: string;
}
```

The v2 answer request is:

```ts
type AnswerTaskBodyV2 = {
  questionId: string;
  questionVersion: string;
  operationId: string;
} & (
  | { answer: string }
  | { decision: 'continue' | 'accept'; text: string }
  | { decision: 'stop' }
);
```

The server atomically checks the current unconsumed identity. Stale tabs receive `HUMAN_QUESTION_STALE`. Same operation/same canonical answer replays; different payload conflicts. V1 tasks continue accepting the old body.

`questionVersion` is an opaque, unpadded base64url encoding of a 32-byte SHA-256 digest with exact syntax `[A-Za-z0-9_-]{43}`. It is generated in Node as `createHash('sha256').update(canonicalBytes).digest('base64url')`, where `canonicalBytes = canonical({protocolVersion:2, questionId, originalWorkItemId, logicalAssignmentId, attemptId, leaseEpoch, questionDigest, authorityBaseRef, openedCommitId})`. Case is significant; implementations must not lowercase or otherwise normalize the encoded token. It is neither a counter nor an event sequence and cannot be derived from the current tail. The opened event persists the already-computed token; projector/API verify the format and recompute it from the bound fields. Unrelated appends, stop, restart, and resume leave it unchanged. A consumed/replaced token is permanently stale; same `operationId` plus the same canonical answer replays the original delivery.

## 11. Bound tools and authority

Tools are created from the leased AssignmentDispatch. They do not accept task IDs, paths, grant IDs, lease IDs, attempt IDs, AuthorityBase refs/digests, or arbitrary Agent IDs. Server closure supplies those values. Every mutating tool input has a required `clientOperationId`; the only allowed equivalent is a stable Pi tool-call operation identity generated and durably bound by the trusted runner before invocation. Array position, wall clock, random retry ID, or regenerated call ID is not equivalent. Same identity plus same canonical body replays the prior result; same identity plus a different body conflicts.

### 11.1 Orchestrator sessions

- `read_structure_contract()`
- `read_map_build_frontier({ cursor?, limit? })`
- `append_map_candidate_chunk({ ordinal, expectedFrontierDigest, nodes, relations, clientOperationId })`
- `finish_map_build({ expectedChunkCount, expectedFrontierDigest, expectedRootCount, clientOperationId })`
- `read_map_repair_staging({ cursor?, limit? })`
- `submit_map_patch({ expectedStagingDigest, operations, clientOperationId })`
- `request_scope_expansion({ findingIds, requestedNodeIds, requestedRelationIds, reason, clientOperationId })`

Chunk and patch calls update only attempt/plan-private state. An Agent can propose finish but cannot publish a candidate or activate a Map.

### 11.2 Generator sessions

- `read_active_map({ parentId?, cursor?, limit? })`
- `read_slot_content({ slotIds })`
- `read_related_context({ slotId, maxHops })`
- `write_slot_content({ slotId, value, clientOperationId })`
- `submit_content_draft({ expectedManifestDigest, clientOperationId })`
- `request_scope_expansion({ findingIds, requestedSlotIds, reason, clientOperationId })`

Full committed Map/content is readable within byte budgets. Writes are limited by static profile, assignment, and current Grant intersection. A batch cannot publish a finalized manifest.

### 11.3 Reviewer sessions

- `read_map_candidate`, `read_active_map`, `read_slot_content`, `read_relation_context` with bounded pagination;
- `submit_map_node_review`, `submit_map_relation_review` with required `clientOperationId`;
- `submit_slot_review`, `submit_relation_review` with required `clientOperationId`;
- the four batch verdict tools may also carry bounded `crossScopeFindingDrafts[]`, each anchored to the current assigned verdict target as `sourceTarget`, naming one existing target in the same frozen candidate/Map/content baseline as `primaryTarget`, plus defect class, evidence and an operation-local key;
- `submit_finding_verification({ findingId, repairStage, verdict, evidence, clientOperationId })` only for verification targets frozen into the current assignment;
- `submit_map_whole_finding`, `submit_whole_tree_finding` with required `clientOperationId`;
- `complete_review_assignment({ clientOperationId })`.

Reviewer tools expose no Map/content write, Grant, Finding-close, aggregate-pass, Seal, publish, or dispatch capability. An output field such as `treePassed`, `mapPassed`, or `sealApproved` is unknown and rejected.

Node/relation/slot Findings for the verdict target are accepted only as its `findingDrafts`. A batch may report an assignment-external problem only as `crossScopeFindingDrafts` on that same assigned verdict call; there is no free-standing `submit_finding`. The server proves the source target is assigned, the primary target exists in the exact frozen baseline, the evidence/context is readable under the current assignment, the pair is not duplicated, and the profile object/byte limits hold. `complete_review_assignment` freezes these drafts in the same AssignmentLedgerBlob and atomically creates deterministic routing obligations: an unreviewed primary target receives the Finding context in its already planned assignment or a deterministic successor; an already reviewed target enters the whole-observation mandatory-decision set. Until one current-baseline target verdict explicitly confirms/rejects the issue, a blocking cross-scope Finding remains an unresolved obligation and settlement cannot pass. Wrong/missing target, stale baseline, duplicate, response-loss conflict, or unrouteable obligation rejects completion. Whole-observation Findings are accepted only by the two anchored whole-finding tools.

`submit_finding_verification` validates reviewer source, current addressed stage, current round/assignment verification target, exact candidate/Map/content/evidence baseline and one record per stage. It writes only the attempt-bound draft journal. `complete_review_assignment` requires complete ordinary, cross-scope-routing, and verification coverage, freezes ReviewFacts and FindingVerificationRecords into the same AssignmentLedgerBlob, and publishes that ledger atomically. Verification verdicts are only `resolved | still_present`; settlement—not the Agent—projects verified/closed/reopen status.

## 12. Validator v2

Every run first persists a canonical `ValidatorInputEnvelopeV2` that contains all input BlobRefs. The engine resolves only those refs and the selected target refs, with no network, ambient filesystem, clock, random source, or task-global lookup.

The seven triggers, two content phases, target matrices, invalid-routing rules, and pre-validation-core DAG are normative from design section 9. The engine returns only:

```ts
type ValidatorResultV2 =
  | { status: 'valid'; executionDigest: string }
  | {
      status: 'domain_invalid';
      issues: [ValidatorIssueV2, ...ValidatorIssueV2[]];
      executionDigest: string;
    };
```

Thrown errors, timeout, budget exhaustion, invalid output, nondeterminism, missing/duplicate registration execution, or target-matrix violation become durable infrastructure-failure blobs. Handlers cannot set enforcement or downgrade themselves.

The system constructs one `ValidatorAggregateV2` for each trigger/phase. Outcome priority is infrastructure failure, then blocking invalid, then clear. Finalizers and Gates consume only that aggregate. Advisory invalid receipts create warning custody and count as clear; they do not create repair plans. All failure events retain aggregate and receipt refs so the original input remains recursively reviewable after GC.

## 13. Domain pipelines

### 13.1 Initial Map build and pre-review

1. Start creates MapBuildSpec revision 1 and the first `structure_chunk` WorkItem/Grant.
2. Chunks commit in contiguous ordinal order against frontier/key-ledger CAS. Relations may reference previously committed keys or earlier keys in the same chunk.
3. `finish_map_build` is only a proposal. A `system_map_finalize` verifies the unique active chunk manifest, roots, parents, order, keys, limits, optional relation policy, and `map_candidate_commit` validators.
4. Clear creates a system-provenance MapCandidateSnapshot and a MapReviewRound. Blocking invalid creates a receipt and deterministic successor MapBuild revision. Infrastructure failure uses SystemCommand retry/failure.
5. Reviewer assignments cover every Map node and every actual relation in the candidate, including advisory relations, plus layered whole-Map observation. `reviewAdvisoryRelations` is not consulted during Map pre-review.
6. System settlement validates coverage and Findings. Blocking Map findings create a MapRepairPlan. Clear creates MapReviewSettlementCore, ProposedMapCore, runs `map_activation`, freezes MapReviewBundle/MapSnapshot, atomically activates it, and creates baseline-unset content plus GenerationPlan.

No Map candidate can be activated and no GenerationPlan can exist before successful pre-review settlement.

### 13.2 Content generation and review

1. GenerationPlan freezes deterministic ordered slot batches and starts from the active Map's baseline/current manifest.
2. One generation batch is writable at a time. It creates `ContentRevisionCommitCoreV2`, runs only `content_commit/batch_commit`, and on clear publishes a provisional manifest revision.
3. The last batch creates `system_generation_finalize`, which binds the complete provisional manifest in `ContentPlanFinalizeCoreV2` and runs only `content_commit/plan_finalize`.
4. Clear publishes a finalized manifest and plans Content Review. Blocking invalid creates a deterministic successor GenerationPlan; infrastructure failure retries.
5. Content round coverage is presence-aware: set required/optional slots require reviewer facts; optional unset uses a system `absent_not_applicable` fact; required unset and rewrite-required are routed to repair before review.
6. Every actual blocking relation requires a relation-satisfaction fact. Advisory relations are added only when `reviewPolicy.reviewAdvisoryRelations=true`. Zero relations satisfy either quantifier naturally. This content-review selector never changes the Map pre-review rule that covers every actual candidate relation.
7. Layered whole-tree observation can add Findings/reject facts but cannot return a whole-tree boolean.
8. Settlement validates coverage, adoption, Finding verification, observations, and validators. Blocking findings create deterministic repair plans; clear creates ReviewBundle and a System Seal WorkItem.

### 13.3 Findings and repair

Finding classes are `content | map | mixed`; source is `reviewer | system_validator`. System validation checks evidence and targets and owns status transitions. `mixed` always routes Map first.

- Pure content findings create a ContentRepairPlan. Its Grants write only targeted slots; all committed context is readable. Batches update private staging manifest and a System repair finalizer publishes one complete revision before re-review.
- Any Map or mixed finding creates a MapRepairPlan. Batches update a private staging Map and plan key ledger. Only the System repair finalizer publishes a new candidate, which must pass a complete MapReviewRound before activation.
- Scope expansion always creates a successor plan revision and replacement WorkItem/Grant; it never mutates the active Grant.
- Same predecessor and operation key replay the same successor; competing different successors conflict and must rebase on the winner.

### 13.3.1 Authoritative review/repair round budget

`reviewPolicy.maxRounds` is a hard per-track lifecycle budget, not a display hint. The system projects two monotonic counters from committed plan/round identity; retries, replacement WorkItems, assignment batches, whole-observation layers, validation reruns inside one plan, and response-loss replays never increment either counter:

- `mapCycleOrdinal`: incremented when the system atomically creates a new complete `MapReviewRound` for a candidate revision after initial Map build or Map repair. A mixed Finding remains on this Map track until Map activation; the later required content re-review is counted by the content track.
- `contentCycleOrdinal`: incremented when the system atomically creates a new complete `ContentReviewRound` for a finalized content manifest after initial generation, content repair, or activated migration.

Ordinals start at `1`. A normal new round may be created only when `nextOrdinal <= maxRounds`. When `nextOrdinal > maxRounds`, creation is legal only if the same atomic envelope consumes the one current available `RoundBudgetOverrideV2` whose failed event, track, reopen operation, repair lineage, and current authorized RepairPlan ref all match; the round-created event carries `consumedOverrideRef` as provenance. Round creation is the sole place that changes the ordinal, so an operator-overridden round increments exactly once. The projector derives `available` from `structured_task_reopened_v2.overrideRef` and `consumed` only from the unique Map/content round-created event's `consumedOverrideRef`; it rejects missing, duplicate, wrong-lineage, or second consumption. The consumed override is immutable and can never authorize another round, another track, or another lineage.

Scope expansion or deterministic validation correction may move the override only within the same `repairLineageId`: the single successor-plan creation envelope writes `structured_round_budget_override_transferred_v2 {overrideRef, fromRepairPlanRef, toRepairPlanRef, transferOperationId}` and freezes a successor override blob with the same override ID/failed event/track/reopen operation plus updated `currentAuthorizedRepairPlanRef`. The projector atomically supersedes the prior available ref. Competing transfer/finalizer operations tail-CAS; the loser reprojections and cannot use the stale plan-bound ref. Cross-lineage/track transfer, transfer after consumption, or two active refs is corrupt. The transfer event and later round-created event are formal GC roots.

Without an exact available override, the envelope instead terminal-fails the current finalizer/settlement WorkItem and its attempt/command and writes exactly one `structured_task_failed_v2(failureCode='REVIEW_REPAIR_LIMIT_EXCEEDED')`; it publishes no new round, RepairPlan, Map activation, ReviewBundle, or Seal WorkItem. Pure infrastructure retries of the same round do not consume a cycle. Map and content counters cannot be traded or reset by stop/resume/manual retry.

Ordinary start, retry, and resume reject this `failed` task. Only authorized `reopen_failed` may apply a frozen recovery recipe that explicitly names one track and creates one replacement plan/WorkItem plus the one available RoundBudgetOverride; it does not preassign or increment a successor ordinal. The later finalizer consumes that override while atomically creating the complete round and assigning its system successor ordinal. History and both counters are never reset. Qualification includes perpetual Map reject, perpetual content reject, mixed Map-first reject, boundary-equal success, reopen-to-round-to-settlement, override response-loss replay, wrong-track/predecessor rejection, and second-consumption rejection.

### 13.4 Map activation and content migration

For a replacement Map, activation is not allowed to re-label old content versions. The system creates:

```text
ContentMigrationSpec
  -> immutable ContentMigrationIntentCore
  -> persistent ContentMigrationValidationPlan batches
  -> ContentMigrationSettlementCore
  -> provisional migrated manifest
  -> content plan-finalize aggregate
  -> MigrationActivationDecision
  -> activation or deterministic repair route
```

Compatible set content is inherited only with a LocalValidatorEquivalenceProof or a fresh target-Map batch-commit aggregate. Optional unset uses `carry_unset`. New/schema-reset slots are unset. Blocking content/mixed targets become `rewrite_required` so the provisional manifest remains complete but cannot Seal.

The final activation decision combines batch and finalizer findings:

- clear: atomically activate target Map and finalized migrated manifest, then review affected content;
- pure content blocking: activate Map with provisional manifest and create ContentRepairPlan; no review/Seal;
- any Map/mixed blocking: do not activate; keep old Map/manifest and create candidate-bound MapRepairPlan;
- infrastructure failure: no activation envelope; retry/fail the SystemCommand.

### 13.5 System Seal and delivery

The System Seal Gate enforces all ten conditions in design section 16.2 using exact MapSnapshotRef, ContentRevisionManifestRef, MapReviewBundleRef, ReviewBundleRef, and validator custody—not semantic/content roots alone.

`system_seal` is the only assembler and artifact publisher. It runs `seal_input`, stages assembler output, runs `seal_output`, and only on two clear aggregates atomically publishes:

- SealValidationBundle;
- SealRecordV2;
- artifact with system ArtifactProvenanceV2;
- `artifact_published_v2`;
- SystemArtifactDelivery;
- generic Submitter WorkItem.

The assembler is versioned separately from the v1 CJS ABI. V2 Contract registers only an installed allowlisted `forge-assembler/v2` handler identity (`handlerKey + implementationDigest + module/export + budget + output routes`). It receives the exact finalized manifest/Map/template inputs resolved from the Seal authority, has no network/clock/random/task-global I/O, and returns bounded named artifact bytes. The old template `forge-assembler/v1` resource remains v1-only and cannot be reinterpreted as v2 merely by changing a YAML ABI string.

`seal_input` blocking invalid creates a system-validator Finding and repair route without an artifact. `seal_output` blocking invalid records evidence and terminal-fails with `ARTIFACT_VALIDATION_FAILED`; it never invents content Findings. Infrastructure failures retain aggregate refs and follow SystemCommand retry policy.

`SystemArtifactDelivery` excludes `artifactVersion`. It is immutable and fully constructible before the publication lock from artifact/Seal/custody/template/submitter authority. The lock-scoped `artifact_published_v2` event alone stores the newly allocated combined-history `artifactVersion` plus exact `deliveryRef`; projection/list/read derive the version from that event and reject a mismatched delivery ref. The Submitter receives only the delivery ref, uses the generic runner, and may submit only the exact current artifact. V2 final reachability validates the delivery/Seal/system WorkItem chain and does not call v1 Agent Route traversal.

### 13.5.1 ArtifactStore v1/v2 authority adapter

The existing artifact filesystem stays the byte store, but its event/provenance adapter becomes an exact discriminated union:

```ts
type PublishedArtifactAuthority =
  | { kind: 'agent_v1'; event: Extract<TaskEvent, {type:'artifact_published'}>; sourceNodeId: string }
  | { kind: 'system_seal_v2'; event: Extract<TaskEvent, {type:'artifact_published_v2'}>; provenance: ArtifactProvenanceV2 };

type ArtifactVersion = ArtifactVersionV1 | ArtifactVersionV2;
```

`ArtifactVersionV1` retains required `sourceNodeId`. `ArtifactVersionV2` instead requires the exact System Seal WorkItem, `SealRecordV2`, artifact BlobRef, custody BlobRef, template snapshot, and SystemArtifactDelivery provenance and forbids a fabricated source node. Artifact metadata on disk carries the same versioned provenance discriminator; legacy `meta.json` parses byte-for-byte as v1.

Artifact version allocation, list/read/recovery, staged-directory claim, and disk/event cross-check count the combined ordered publication stream and resolve either `artifact_published` or `artifact_published_v2`. V2 file names/hashes/media/byte lengths must match both the publication event and artifact/custody refs, and its event must close through the current SealRecord/System Seal WorkItem. Annotation remains v1-only unless a later v2 protocol explicitly adds it. The System Seal publish envelope uses the sole v2 append facade so version allocation and event append occur under the cross-process fresh-tail lock. A committed v2 publication must therefore be visible through current workspace/list/read APIs after response loss and restart; an event/disk/provenance mismatch is corruption.

## 14. Read API and mutations

### 14.1 V2 read routes

`src/server/api/authoritative-review-routes.ts` registers:

- `GET /api/tasks/:taskId/structured-slots/map`
- `GET /api/tasks/:taskId/structured-slots/map/candidate`
- `GET /api/tasks/:taskId/structured-slots/tree?parentId=&limit=&after=`
- `GET /api/tasks/:taskId/structured-slots/tree/locate/:slotId?snapshotCursor=`
- `GET /api/tasks/:taskId/structured-slots/review/map-rounds?limit=&after=`
- `GET /api/tasks/:taskId/structured-slots/review/summary`
- `GET /api/tasks/:taskId/structured-slots/review/rounds?limit=&after=`
- `GET /api/tasks/:taskId/structured-slots/review/slots/:slotId?snapshotCursor=`
- `GET /api/tasks/:taskId/structured-slots/review/relations/:relationId?snapshotCursor=`
- `GET /api/tasks/:taskId/structured-slots/review/findings?limit=&after=`
- `GET /api/tasks/:taskId/structured-slots/review/seal-readiness`

The existing v1 routes and response types remain available to v1 tasks. The existing issues route projects current v2 Findings and deterministic validator issues for compatibility.

### 14.2 Snapshot cursor

The first collection request fixes `throughSequence`, projection schema, authority baseline refs, filters digest, and deterministic sort. Response returns an authenticated opaque cursor with key ID. Later pages remain stable while new events append. Default limit is 50; v2 profile hard maximum is 500.

The key ring is installed under the data root, created durably at service bootstrap, fsynced, versioned, and retained across restarts. Rotation keeps verification keys for at least the snapshot-retention period. Missing/unreadable keys fail v2 review reads; they do not silently generate a replacement. `CURSOR_STALE` is allowed only for retention/key retirement, changed query identity, or corruption.

Tree responses are non-recursive parent pages, return child counts and `hasMoreChildren`, and sort by parent/sibling order/slot ID. Locate returns the ancestor path and page seek cursor at each level. There is no 1,000-entry walk cap or silent truncation.

### 14.3 Mutations

Existing task start/stop/resume/retry/answer endpoints dispatch by frozen version. V2 adds exact bodies for answer and `reopen_failed`; all mutations use operation IDs and tail CAS internally. No endpoint directly writes review facts, Findings, Grants, Map activation, aggregate pass, or Seal.

Stable public v2 error codes include `AUTHORITATIVE_REVIEW_UNAVAILABLE`, `USE_RESUME`, `AUTHORITY_BASE_STALE`, `HUMAN_QUESTION_STALE`, `CURSOR_STALE`, `ARTIFACT_VALIDATION_FAILED`, exact invalid-transition/idempotency conflicts, and task corruption. Public errors never contain absolute paths, validator internals, provider output, private evidence, or raw storage exceptions.

## 15. UI

`ProductionPage` selects `StructuredSlotDrawer` for v1 and new `StructuredReviewDrawer` for v2 using workspace summary version. V2 components are:

```text
src/client/components/structured-review/
  review-overview.tsx
  virtual-review-tree.tsx
  relationship-view.tsx
  review-rounds-view.tsx
  findings-view.tsx
  seal-readiness-view.tsx
```

The drawer provides Overview, Slot tree, Relationship graph/list, Review, Findings, and Seal views. It distinguishes Agent facts from system-effective state and system-derived Map/generation/Seal readiness. The tree lazy-loads children, keeps a fixed snapshot while expanded, uses windowed rendering for the visible flattened rows, and offers “refresh to latest” when newer events exist.

Disabled or zero-relation state displays “本 Map 未使用关系网” and is not an error. Slot detail shows current content version, local Map subgraph, adjacent/related slots, fact/adoption source, Findings, and staleness reason. System-produced artifacts show Seal/custody provenance without a fake node link.

## 16. Capacity, security, and progress

### 16.1 Qualified profile floor

The first enabled `forge-authoritative-review/v1` profile must prove:

- `maxSlots >= 10_000`;
- one assignment supports at least 256 primary targets and 1,024 total objects;
- total WorkItem/assignment ceilings can cover 10,000 slots at default batch target 24 plus layered observations, settlement, and qualified retry budget;
- Map chunk, generation, review ledger/adoption, checkpoint, cursor, migration, publication-pin, and recursive-GC limits are internally consistent;
- every byte/time/relation/finding/round/repair/validator/assembler bound is finite and templates can only tighten it.

The v1 profile's current 2,500-slot limit remains a v1 domain limit. For v2, the base structured capability proves shared primitive readiness; the authoritative-review profile owns v2 domain limits. V2 compiler and runtime must not call the v1 `maxSlots` assertion.

### 16.2 Progress guard

V2 progress is a monotonic digest-bound checkpoint over planned/completed coverage, observation level, Finding stages, plan ordinals, and settlement state. Legitimate hundreds of WorkItems do not count as no-progress. Retries with unchanged checkpoints do. The v1 32-turn/progress policy remains v1-only.

### 16.3 Security

- Reviewer identity and conversation namespace are isolated from all write-role histories.
- Prompts, Map values, relations, evidence, IDs, refs, and content are untrusted input.
- All Agent payloads have exact schemas and byte/object limits.
- V2 validators are allowlisted, isolated, deterministic, and non-networked.
- Grants are server-signed lease-bound capabilities; stale or scope-exceeding calls reject atomically.
- No Agent tool can create System identities, close Findings, aggregate a pass, Seal, publish, or dispatch the next phase.
- Public traces never store private reasoning; evidence is bounded public text/refs.

## 17. Capability and rollout

`authoritative_review_v1` is an additional production capability. It starts disabled. A v2 task is runnable only when:

1. the existing structured runtime capability is enabled and valid;
2. authoritative-review capability is enabled with a final v2 profile whose digest is referenced by matching downstream benchmark/release evidence and source digest;
3. the frozen v2 template snapshot resolves to those identities.

Development fixtures inject an enabled provisional environment explicitly. Production catalog publication of a v2 template is rejected while the capability is disabled.

Promotion order is fixed:

1. v1 regression fences;
2. v2 protocol/storage/runtime/domain/API/UI complete under test environment;
3. 10,000-slot benchmark and failure matrix;
4. generated final profile/evidence and source digest bundle;
5. independent full-suite verification;
6. capability promotion from disabled to enabled;
7. publish the already-qualified v2 `zhihu-salt-chapter-draft` source revision from that same source checkpoint;
8. create a fresh real Pi + HTTP task and collect browser, event, blob, Seal, artifact, and checkout evidence. This post-promotion evidence records the certified checkpoint commit and the actual execution commit, proves their normalized source-tree digest is identical, and proves any commit difference contains only generated qualification/acceptance outputs. It is downstream acceptance evidence and is not inserted back into the already-promoted capability digest chain.

Capability/evidence generation is scripted. Tests may never pass merely because a developer hand-edited an enabled JSON file.

## 18. Zhihu template v2 revision

The template ID remains `zhihu-salt-chapter-draft`; the version/snapshot hash must change. Historical task snapshots remain intact.

The source revision shall:

- bind `structure` as orchestrator, `fill` as generator, new independent `review` as reviewer, and `submitter` as generic Submitter;
- remove `seal` from v2 Agents, prompts, Routes, and artifact producer;
- make `chapter.md` producer `system:structured_seal`;
- use relationship policy `optional` and declare only meaningful narrative relation types; any slot and the full Map may still have zero edges;
- freeze Map and content review policy with default batch target 24 and soft limit 64;
- use v2 builtin deterministic validators and the system assembler ABI;
- set template limits within the qualified v2 profile, including `maxSlots=10_000` as the deployment envelope even if the template grammar normally yields far fewer slots;
- update structure/fill prompts to use bound chunk/batch/repair tools and add a reviewer prompt that forbids aggregate judgments;
- retain the existing artifact format and Submitter responsibility.

## 19. Verification matrix

### 19.1 Required automated proof

- V1 frozen template hash, replay, Route, Seal, API, and acceptance regressions unchanged.
- Contract v2 exact validation, role identity, optional/disabled/zero relations, forbidden Routes/system identity, v4 capabilities, and profile limits.
- BlobRefV2 byte identity, schema registry, recursive child refs, publication-pin crash boundaries, response loss, GC generation races, and missing-ref corruption.
- Every v2 event member exact validation plus random/invalid transition projection properties.
- WorkItem lease/reclaim/retry/budget/stop/resume/question/reopen and stale epoch/base races.
- MapBuild chunk/finalize, Map review coverage/whole observation/settlement, and no-generation-before-activation invariant.
- Content version/manifest batch/finalize, same-root/different-manifest staleness, required/optional/rewrite presence coverage.
- ReviewFact/adoption eligibility, whole-observation non-adoption, Finding lifecycle/verification, deterministic route.
- Map/content repair, scope expansion successor conflict, private staging, finalizer-only publication.
- Migration equivalence/revalidation/carry-unset/rewrite-required and all four activation outcomes.
- Validator trigger/phase isolation, target matrices, warning custody, failure evidence, determinism, and no self-reference cycles.
- System Seal Gate, input/output failures, single publish, SystemArtifactDelivery, generic Submitter, and v1 reachability regression.
- Snapshot pagination through process restart and key rotation, locate beyond slot 1,000, virtualized UI, and no silent truncation.
- Full 10,000-slot lifecycle, bounded RSS/latency, restart recovery, genesis/checkpoint digest equality, and event-count headroom below the existing 999,999 sequence ceiling.

### 19.2 Required real acceptance

A final result is accepted only from a newly created v2 task through the real HTTP service and real Pi provider on the implementation checkout. Evidence must show:

- candidate Map visible before activation;
- Map per-node/actual-relation facts and system Map approval before any content generation event;
- at least one scoped repair where only authorized slots change and nearby/whole-tree review reruns;
- optional or zero relation state treated as valid;
- every current slot state and Finding reconstructable from event/blob lineage;
- ReviewBundle and Seal readiness computed by the system;
- SealRecord refs match current Map, finalized manifest, review bundle, validation bundle, artifact bytes, template snapshot, and browser projection;
- Submitter receives the SystemArtifactDelivery and final artifact;
- persisted journal/event evidence survives a service restart;
- capability evidence's normalized source digest matches the execution checkout; its checkpoint commit may differ from the execution commit only by the frozen generated-output allowlist.

Unit tests, a fixture-only task, mock browser data, or an old task are insufficient substitutes.

## 20. Definition of done

The feature is complete only when all of the following are true:

- design, this spec, and implementation plan have independent `APPROVED` verdicts with no unresolved P0/P1/P2 correctness findings;
- all implementation tasks and required commits are present in an isolated development worktree and pass review;
- `npm run check`, full Vitest, build, E2E, structured v1 verification, v2 qualification, fault injection, and real acceptance are green;
- a genesis replay matches the production checkpoint and every published ref resolves after GC simulation;
- authoritative-review capability is enabled only by generated matching evidence;
- the Zhihu template source is on v2 while historical v1 tasks remain readable/runnable under v1 rules;
- a fresh browser-visible task and its persisted artifact/journal prove the lifecycle end to end, and the execution checkout has the same normalized source digest as the capability-certified checkpoint with only allowlisted generated-output commit differences.
