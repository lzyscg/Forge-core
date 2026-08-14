# Authoritative Per-Slot Review Lifecycle v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Review status:** Approved after independent adversarial review (Cycle 3 Round 4). Implementation may proceed only from this frozen Spec/Plan pair.

**Goal:** Add a production-qualified v2 structured-slot lifecycle in which Agents submit only scoped Map/content/review facts, while the system alone owns Map activation, aggregate review state, repair routing, Seal, artifact custody, and final delivery readiness.

**Architecture:** Preserve the current structured-slot v1 runtime byte-for-byte and branch by the task's frozen `structuredSlots.version`. Build v2 as a parallel pure-domain + BlobRefV2/event-projection + persistent WorkItem runtime. Reuse the existing canonical JSON, EventStore atomic batch, Pi turn runner, evaluator isolation, and ArtifactStore primitives through narrow adapters. Keep `authoritative_review_v1` disabled until a complete 10,000-slot qualification, failure matrix, and fresh real browser Case produce matching evidence.

**Tech Stack:** TypeScript 5.5, Node.js 20+, React 18, TypeBox, YAML 2, Vitest 2, Playwright 1.55, existing file-backed append-only storage, `isolated-vm`, Pi 0.82, existing `re2-wasm@1.0.2` and canonical JSON implementation.

## Global Constraints

- Normative documents are, in order: `docs/superpowers/specs/2026-08-13-authoritative-per-slot-review-lifecycle-design.md`, then `docs/superpowers/specs/2026-08-14-authoritative-per-slot-review-lifecycle-spec.md`, then this plan.
- Work in an isolated git worktree and branch. Do not edit or delete unrelated user changes.
- TDD is mandatory: add the focused failing test, run it and capture the expected failure, implement the smallest legal behavior, rerun focused tests, then run `npm run check` before committing.
- Every task ends in a focused commit. Do not collapse protocol, runtime, UI, qualification, and generated evidence into one commit.
- Never widen or reinterpret Contract v1, StructuredTurnContractV3, BlobRefV1, current structured attempt events, v1 SealRecord, v1 cursor, or v1 Route reachability.
- Select v1/v2 only from the task's frozen snapshot. Current source/catalog state and event names are not protocol selectors.
- V2 Agent output never owns aggregate pass, Map activation, Finding closure, Grant issuance, Seal, artifact publication, or next-phase routing.
- V2 has no Agent Seal session and no `request_seal` tool. `system:structured_seal` is not an Agent.
- Relationship mode is `disabled | optional`; a Map and any slot may legally have zero relations.
- All v2 cross-object lineage/custody uses BlobRefV2. Plain digests are display aliases only.
- Every visible domain transition, attempt terminal, WorkItem transition, and deterministic successor is one `EventStore.appendBatch` CAS envelope.
- Large ledgers live in canonical blobs. Events contain refs and bounded summaries, never one event per verdict.
- Keep `maxActiveLeasesPerTask = 1` until a later protocol revision.
- Task stop is a suspension overlay and never overwrites human-question or retry-budget dispositions.
- V2 progress is semantic/digest based; never reuse v1's finite turn counter to truncate a legal 10,000-slot plan.
- Production v2 compilation/run is fail-closed while `authoritative_review_v1` is disabled. Tests inject an explicit provisional enabled environment.
- Stage the final v2 Zhihu source before qualification, but do not publish it into the production catalog cache while capability is disabled. Promotion must not be followed by a source edit that invalidates the source digest.
- A final claim requires full tests, build, v1 regression, v2 10k qualification, fault injection, source/evidence match, real Pi + HTTP execution, browser/file/API/event reconciliation, restart recovery, and a fresh v2 task.

---

## Dependency Map

```text
1 v1 fences
  -> 2 shared v2 types
  -> 3 pure domain/object registry
  -> 4 Contract v2 compiler
  -> 5 pipeline + capability/profile

2+3 -> 7 v2 event union
3+6+7 -> 8 publication pins/GC -> 9 projector/checkpoint/keyring
7+9 -> 10 WorkItem domain
5+8+10 -> 11 coordinator/lifecycle + TaskStore/index profile publication
11 -> 12 attempt/runner/grant -> 13 bound tools
5+3+6 -> 14 validator registry/engine + provisional profile rotation

11+12+13+14 -> 15 MapBuild -> 16 Map review/activation
16 -> 17 content generation -> 18 content review/Findings
18 -> 19 repair -> 20 migration
18+20+14 -> 21 System Seal + assembler profile rotation -> 22 system delivery/Submitter

9+16+18+21 -> 23 API/cursors -> 24 v2 UI
all domain/runtime -> 25 Zhihu v2 source + final production-handler profile rotation + hermetic acceptance
all -> 26 recovery/fault matrix -> 27 10k qualification
27 -> 28 capability promotion -> 29 fresh real browser acceptance
```

---

### Task 1: Freeze the v1 compatibility baseline

**Files:**

- Modify: `src/server/template/template-loader.test.ts`
- Modify: `src/server/template/structured-slot-template.acceptance.test.ts`
- Modify: `src/server/template/zhihu-salt-chapter-draft-template.test.ts`
- Create: `src/server/template/__fixtures__/zhihu-salt-chapter-v1/` (frozen copy of the current v1 package)
- Modify: `src/server/storage/task-events.test.ts`
- Modify: `src/server/storage/structured-slot-state.test.ts`
- Modify: `src/server/runtime/task-scheduler.test.ts`
- Create: `src/server/template/__snapshots__/structured-v1-compatibility.json`

**Produces:** A machine-checked fence for the current frozen v1 semantic digest/hash, event member keys, Route order, session kinds, Seal path, and historical replay result.

- [ ] **Step 1: Record the current v1 fixture bytes without changing product code**

Copy the current Zhihu v1 package into a dedicated historical fixture before the production source is migrated. Add an exact JSON fixture containing the loaded `structured-valid` semantic digest, the archived Zhihu v1 version hash, v1 route list, Contract v1 top-level keys, StructuredTurnContractV3 session union, and a projected completed v1 acceptance summary. Generate it once from `main@f89d721`, then review the checked-in bytes. Later tasks change the production Zhihu source but must keep this archived fixture and its hash unchanged.

- [ ] **Step 2: Add failing-on-drift tests**

```ts
it('keeps historical v1 template and event semantics byte stable', async () => {
  const frozen = await loadTemplateDirectory(v1Fixture, { runtimeEnvironment: v1Env });
  expect(projectV1Compatibility(frozen)).toEqual(readV1CompatibilitySnapshot());
  expect(validateTaskEvent(v1SealEvent)).toEqual(v1SealEvent);
});
```

Also assert that v1 stopped-task start, `request_seal`, v1 Route reachability, and the existing v1 cursor behavior remain accepted.

- [ ] **Step 3: Run the fence and existing structured acceptance**

Run:

```bash
npx vitest run src/server/template/template-loader.test.ts src/server/template/zhihu-salt-chapter-draft-template.test.ts src/server/template/structured-slot-template.acceptance.test.ts src/server/storage/task-events.test.ts src/server/storage/structured-slot-state.test.ts src/server/runtime/task-scheduler.test.ts
npm run check
```

Expected: PASS on the untouched v1 implementation.

- [ ] **Step 4: Commit**

```bash
git add src/server/template src/server/storage src/server/runtime/task-scheduler.test.ts
git commit -m "test: freeze structured slot v1 compatibility"
```

---

### Task 2: Add shared v2 discriminated contracts

**Files:**

- Create: `src/shared/authoritative-review-v2.ts`
- Create: `src/shared/authoritative-review-v2.test.ts`
- Modify: `src/shared/contracts.ts`
- Modify: `src/shared/api-schemas.ts`
- Modify: `src/shared/api-schemas.test.ts`
- Modify: `src/shared/errors.ts`
- Modify: `src/server/storage/task-store.ts`
- Modify: `src/server/storage/task-store.test.ts`
- Modify: `src/server/storage/task-projector.ts`
- Modify: `src/server/storage/task-projector.test.ts`
- Modify: `src/server/core-service.ts`
- Modify: `src/server/core-service-live.test.ts`
- Modify: `src/server/core-service-phase-e.test.ts`
- Modify: `src/client/mock/mock-store.ts`
- Modify: `src/client/mock/mock-gateway.ts`
- Modify: `src/client/mock/mock-store.test.ts`
- Modify: `src/client/mock/mock-gateway.test.ts`
- Modify: `src/client/components/task-controls.tsx`
- Modify: `src/client/components/task-controls.test.tsx`
- Modify: `src/client/gateway/forge-core-gateway.ts`
- Modify: `src/client/gateway/http-gateway.ts`
- Modify: `src/client/gateway/http-gateway.test.ts`
- Modify: `src/client/mock/mock-fixtures.ts`
- Modify: `src/client/mock/mock-projector.ts`
- Modify: `src/client/mock/mock-projector.test.ts`
- Modify: `src/client/pages/task-list-page.tsx`
- Modify: `src/client/pages/task-list-page.test.tsx`
- Modify: `src/server/api/api.integration.test.ts`
- Modify: `src/server/api/task-routes.ts`
- Modify: `src/server/runtime/task-scheduler.ts`
- Modify: every additional file returned by `rg -l "TaskSummary" src --glob '*.{ts,tsx}'` before the task starts; record the inventory in the Task 2 commit message

**Produces:** `BlobRefV2`, public Map/review/Finding/Seal DTOs, `PendingQuestionV2`, `ArtifactProvenanceV2`, `TaskStatus='failed'`, required protocol-discriminated task summaries from every producer, v2 workspace summary, and exact TypeBox mirrors.

- [ ] **Step 1: Add schema tests that reject cross-branch fields**

```ts
it('requires exact system artifact provenance refs', () => {
  expect(check(artifactProvenanceV2Schema, {
    producerKind: 'system',
    producerWorkItemId: 'work-1',
    sealRecordRef,
    artifactRef,
    custodyRef,
  })).toBe(true);
  expect(check(artifactProvenanceV2Schema, {
    producerKind: 'system', sourceNodeId: 'forbidden', sealRecordDigest: digest,
  })).toBe(false);
});
```

Add exact tests for BlobRefV2, `failed`, required `TaskSummary.structuredProtocol`, v1/v2 workspace summary discrimination, pending question, answer/delete/reopen v2 bodies, `FailedTaskRecoverySummaryV2`, collection page/cursor, relation-disabled summary, and unknown-field rejection. `questionVersion` must accept only the Spec's case-sensitive, unpadded 43-character `[A-Za-z0-9_-]{43}` token produced by Node `digest('base64url')`; reject numbers, counters, lowercase-normalized values, malformed lengths/alphabet, extra padding, and an otherwise well-formed token recomputed from a different WorkItem/AuthorityBase/opened commit. Delete requires UUID operation + bounded reason and forbids caller-supplied actor. Reopen requires exact expected tail/operation/reason/recipe/track and rejects cross-recipe fields.

- [ ] **Step 2: Confirm red**

Run: `npx vitest run src/shared/authoritative-review-v2.test.ts src/shared/api-schemas.test.ts`

Expected: FAIL because the v2 module and schemas do not exist.

- [ ] **Step 3: Implement exact closed unions**

Define `AuthoritativeBlobKindV2` explicitly; do not use `string`. It includes `profile_snapshot` and `publication_operation_payload` from the first v2 commit. Export the exact profile snapshot bootstrap shape and public DTOs, including the separately derived `AuthoritativeReviewExecutionEligibilityV1`; internal plan/fact object bodies stay in the pure domain module from Task 3.

```ts
export interface BlobRefV2 {
  kind: AuthoritativeBlobKindV2;
  digest: string;
  byteLength: number;
  mediaType: 'application/json' | 'text/markdown' | 'text/plain';
  schemaVersion: number;
}
```

- [ ] **Step 4: Implement exact TypeBox schemas and compatibility overloads**

Keep the old answer-body schema exported for v1. Add `answerBodyV2Schema` and let the server choose it after loading the frozen task.

Add the stable public v2 error codes to `src/shared/errors.ts` and their exact HTTP/UI mappings in this task: `AUTHORITY_BASE_STALE`, `HUMAN_QUESTION_STALE`, `CURSOR_STALE`, `USE_RESUME`, `AUTHORITATIVE_REVIEW_UNAVAILABLE`, `ARTIFACT_VALIDATION_FAILED`, `REVIEW_REPAIR_LIMIT_EXCEEDED`, `RUNNING_WITHOUT_WORK`, and the storage-corruption/invalid-transition codes named by the Spec. Unknown internal causes must map to a bounded public error without paths or raw validator/provider text.

In the same change, update every explicitly inventoried `TaskSummary` producer, consumer literal, mock, fixture, stub, schema and gateway contract. Production derives `none | v1 | v2` only from the frozen snapshot through a shared helper; historical/corrupt fallback uses the immutable protocol identity available in the task record/index and fails closed rather than guessing. Run the `rg` inventory again and require zero object literals/builders missing the field before `npm run check`.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npx vitest run src/shared/authoritative-review-v2.test.ts src/shared/api-schemas.test.ts src/server/storage/task-store.test.ts src/server/storage/task-projector.test.ts src/server/core-service-live.test.ts src/server/core-service-phase-e.test.ts src/server/api/api.integration.test.ts src/server/runtime/task-scheduler.test.ts src/client/components/task-controls.test.tsx src/client/pages/task-list-page.test.tsx src/client/mock src/client/gateway
npm run check
git add src/shared src/server/storage/task-store* src/server/storage/task-projector* src/server/core-service* src/server/api/api.integration.test.ts src/server/api/task-routes.ts src/server/runtime/task-scheduler.ts src/client/components/task-controls* src/client/pages/task-list-page* src/client/mock src/client/gateway
git diff --cached --name-only > /tmp/authoritative-task-summary-staged.txt
comm -23 <(rg -l "TaskSummary" src --glob '*.{ts,tsx}' | sort) <(sort /tmp/authoritative-task-summary-staged.txt)
git commit -m "feat: add authoritative review v2 shared contracts"
npm run check
git status --short
```

Expected: `comm` prints nothing; the post-commit `npm run check` runs from the committed tree, and `git status --short` contains no TaskSummary migration file. If the inventory grows while implementing, add that file to this task explicitly rather than leaving an unstaged compatibility fix.

---

### Task 3: Implement pure v2 authority domains and object registry

**Files:**

- Create: `src/server/authoritative-review/authority-types.ts`
- Create: `src/server/authoritative-review/object-registry.ts`
- Create: `src/server/authoritative-review/map-domain.ts`
- Create: `src/server/authoritative-review/content-domain.ts`
- Create: `src/server/authoritative-review/review-domain.ts`
- Create: `src/server/authoritative-review/finding-domain.ts`
- Create: `src/server/authoritative-review/work-item-domain.ts`
- Create: `src/server/authoritative-review/seal-gate.ts`
- Create: corresponding `*.test.ts` files

**Produces:** Storage-free exact object validation, digest calculation, child-ref extraction, Map/content identities, review coverage/adoption, Finding routing, WorkItem transitions, and Seal eligibility.

- [ ] **Step 1: Write failing object-graph and identity tests**

Cover:

- equal Map semantics with different MapSnapshot bytes/ref digests;
- equal content roots with different manifest refs;
- complete `unset | rewrite_required | set` manifest coverage;
- optional-unset system coverage and required-unset rejection;
- whole-observation fact adoption rejection;
- zero-relations natural coverage;
- mixed Finding routes Map first;
- Seal Gate rejects a ReviewBundle that binds a different same-root manifest.

```ts
expect(resolveMapSemanticDigest(mapSnapshotA)).toBe(resolveMapSemanticDigest(mapSnapshotB));
expect(refA.digest).not.toBe(refB.digest);
expect(() => assertManifestAgainstMap(manifestA, refB)).toThrow('AUTHORITY_BASE_STALE');
```

- [ ] **Step 2: Confirm red**

Run: `npx vitest run src/server/authoritative-review`

Expected: FAIL because the modules are absent.

- [ ] **Step 3: Add all canonical object interfaces from the approved design**

Use discriminated unions and exact object validators for MapCandidate/Snapshot, MapReview cores/bundle, slot versions/manifests, review facts/adoption/round cores/bundle, Findings/verifications, grants, plan specs, migration objects, validator objects, AuthorityBaseSet, WorkItem, Seal bundle/record/delivery.

- [ ] **Step 4: Register every Blob kind**

```ts
interface BlobSchemaRegistration<T> {
  kind: AuthoritativeBlobKindV2;
  schemaVersion: number;
  mediaType: BlobRefV2['mediaType'];
  parse(value: unknown): T;
  childRefs(value: T): readonly BlobRefV2[];
  maxBytes(profile: AuthoritativeReviewProfile): number;
}
```

Include `profile_snapshot`, `publication_operation_payload`, `failure_recovery_payload`, and `round_budget_override` as exact registered kinds. `publication_operation_payload` is a strict discriminated union for domain publish, state-only lease/retry/lifecycle/question/recovery/delete, and artifact version allocation, with exact child refs and no executable callback or raw Agent text. `profile_snapshot` uses the bootstrap schema/media/version/max-bytes rule and validates `profileDigest` over canonical bytes without that field before any profile-owned kind limits are consulted; its BlobRef digest is separately computed over the complete canonical object and must never be equated with `profileDigest`. The recovery payload stores event-ledger identities (IDs/epoch/terminal event+commit) plus only real object refs; it does not invent WorkItem/Attempt blob kinds. The override stores repair lineage, initial/current plan refs, predecessor override ref, and transfer ordinal. Child-ref extraction and max-size rules must cover all four.

Reject unregistered kinds, schema versions, unknown fields, mismatched display digests, self refs, and illegal phase/provenance combinations.

- [ ] **Step 5: Implement pure calculations**

Implement Map normalization/semantic digest/diff/subgraph/impact, content leaf/root/manifest validation, review adoption and coverage settlement, Finding route/status, AuthorityBase field matrices, WorkItem legal transition, and structured Seal Gate reasons.

- [ ] **Step 6: Add property tests for deterministic sort/digest and illegal cycles**

Use seeded shuffled inputs to prove canonical results, and construct each pre-validation/final-object DAG to prove no object must reference its own aggregate.

- [ ] **Step 7: Verify and commit**

Run:

```bash
npx vitest run src/server/authoritative-review
npm run check
git add src/server/authoritative-review
git commit -m "feat: add authoritative review pure domains"
```

---

### Task 4: Compile Contract v2 without changing Contract v1

**Files:**

- Create: `src/server/template/structured-slot-contract-v2.ts`
- Create: `src/server/template/structured-slot-contract-v2.test.ts`
- Create: `src/server/template/__fixtures__/authoritative-valid/slots/contract.yaml`
- Create: invalid v2 fixture variants under `src/server/template/__fixtures__/`

**Produces:** A pure, strict Contract v2 compiler/parser and canonical contract/resource digest that can be tested without loading a Pipeline/FrozenTemplate. First successful v2 FrozenTemplate load/hash is intentionally deferred to Task 5.

- [ ] **Step 1: Add failing version-dispatch and exact-shape tests**

Test valid disabled/optional relationship modes, zero relations, declared relation cross-references, review limits, ValidatorRegistrationV2 phase matrix, assembler registration shape, unknown/cross-version fields, and resource containment by calling the standalone compiler directly. Do not place a v2 `pipeline.yaml` in this task's valid fixture and do not call `loadTemplateDirectory` yet.

- [ ] **Step 2: Confirm red**

Run: `npx vitest run src/server/template/structured-slot-contract-v2.test.ts`

- [ ] **Step 3: Implement the standalone compiler**

Reuse v1 Slot Schema/Layout Grammar compilers only where their frozen input/output semantics are identical. Do not import v1 validator registration or v1 access-profile parser as a shortcut when fields differ.

- [ ] **Step 4: Export canonical contract/resource identity for Task 5**

Export the strict raw-version peek, compiler result, canonical bytes and resource/implementation identity closure. Do not modify TemplateLoader, FrozenTemplate, artifact producer parsing, pipeline typestate or template version hash in this task.

- [ ] **Step 5: Re-run the v1 compatibility snapshot and v2 tests**

Run:

```bash
npx vitest run src/server/template/structured-slot-contract-v2.test.ts src/server/template/structured-slot-contract.test.ts
npm run check
```

- [ ] **Step 6: Commit**

```bash
git add src/server/template/structured-slot-contract-v2.ts src/server/template/structured-slot-contract-v2.test.ts src/server/template/__fixtures__
git commit -m "feat: compile structured slot contract v2"
```

---

### Task 5: Validate v2 roles, turn contracts, profile, and capability

**Files:**

- Create: `src/server/template/authoritative-review-pipeline-validator.ts`
- Create: `src/server/template/authoritative-review-pipeline-validator.test.ts`
- Create: `src/server/structured-slots/authoritative-review-profile.ts`
- Create: `src/server/structured-slots/authoritative-review-profile.test.ts`
- Create: `src/server/structured-slots/authoritative-review-profile-v1.json`
- Create: `src/server/structured-slots/authoritative-review-capability.ts`
- Create: `src/server/structured-slots/authoritative-review-capability.test.ts`
- Create: `src/server/structured-slots/authoritative-review-capability-v1.json`
- Create: `src/server/structured-slots/authoritative-review-profile-archive.ts`
- Create: `src/server/structured-slots/authoritative-review-profile-archive.test.ts`
- Create: `src/server/structured-slots/test-support/authoritative-review-test-handlers.ts`
- Create: `src/server/structured-slots/test-support/authoritative-review-test-registry.ts`
- Create: `src/server/template/__fixtures__/authoritative-valid/pipeline.yaml`
- Create: v2 valid Agent/turn-contract fixture files under `src/server/template/__fixtures__/authoritative-valid/`
- Modify: `src/server/main.ts`
- Modify: `src/server/http-server.test.ts`
- Modify: `src/server/core-service.ts`
- Modify: `src/server/template/template-schema.ts`
- Modify: `src/server/template/template-validator.ts`
- Modify: `src/server/template/structured-pipeline-validator.ts`
- Modify: `src/server/template/template-loader.ts`
- Modify: `src/server/template/template-loader.test.ts`

**Produces:** The first valid full v2 FrozenTemplate load/hash: TurnContract v4, independent role binding, exact system producer, strict v2 pipeline validator, immutable profile snapshot/archive binding, dual capability gate, and an explicitly test-only profile/handler environment. It does not pretend that production validator or assembler identities already exist.

- [ ] **Step 1: Add failing role and route tests**

Reject reviewer/write-role identity overlap, absent/multiple role bindings, v2 seal Agent, `request_seal`, Agent completion routes, system identity as Agent/Route target, wrong artifact producer, and Submitter not bound to SystemArtifactDelivery.

Add compatibility tests for the artifact producer parser: basic/v1 scalar `producer: seal` must normalize/hash exactly as today; v2 requires `{ system: structured_seal }` (or the exact equivalent chosen in the valid fixture) and freezes it as `ArtifactProducerRef {kind:'system', systemId:'structured_seal'}`. Never relax the current safe Agent-ID regex to admit `system:structured_seal`, because that would also make it a legal Agent/Route target.

- [ ] **Step 2: Add failing profile/capability tests**

Prove production rejects provisional/missing/mismatched evidence, v2 template limits can use 10,000 while v1 stays 2,500, templates can only tighten, both capabilities are required, and source cache activation stays on the prior valid cache while v2 is disabled.

Add profile snapshot tests: canonical complete bytes/digest/qualification state, same identity/different bytes distinct, FrozenTemplate hash/ref computation, archive lookup after current profile changes, disabled capability historical read/genesis, missing archive corrupt, and separately derived blocked execution eligibility when current capability no longer authorizes the frozen digest. TaskStore/index publication is deliberately deferred to Task 11.

- [ ] **Step 3: Confirm red**

Run:

```bash
npx vitest run src/server/template/authoritative-review-pipeline-validator.test.ts src/server/structured-slots/authoritative-review-profile.test.ts src/server/structured-slots/authoritative-review-capability.test.ts
```

- [ ] **Step 4: Implement exact v4/capability sets**

Keep TurnContract v3 guards unchanged. Add `isAuthoritativeStructuredTurnContractV4`. Add `createAuthoritativeReviewTestEnvironment()` only in test-support; there is no environment-variable production bypass.

Thread one immutable `AuthoritativeReviewRuntimeEnvironmentV1` from production manifest load in `main.ts` through CoreService, TemplateCatalog/cache, TaskStore snapshot reopen, scheduler, runner, and every v2 service. CoreService construction must fail closed when the enabled manifest/evidence/key material is corrupt; a disabled environment remains available for historical read-only projection. Do not let individual modules re-read defaults or accept a second independently constructed environment. The valid fixture resolves only the checked-in test-support handler registry and a `qualificationState: test_only` profile; production manifest loading rejects either identity.

In this same task, implement pipeline/artifact producer parsing and first v2 loader branch atomically: version-peek Contract, parse `structuredReviewLifecycle`, explicit `{system: structured_seal}` producer, v4 turn contracts, v2 pipeline validator, profile archive resolution, and final semantic template hash over contract/resources/handler identities plus exact profile identity+digest+snapshot ref. V1 parser/validator/hash receives no new defaults. The Task 4 compiler fixture becomes a full valid loader fixture only here; no temporary validation bypass is permitted.

- [ ] **Step 5: Add a disabled production manifest**

```json
{
  "version": 1,
  "status": "disabled",
  "profileIdentity": null,
  "profileDigest": null,
  "evidenceDigest": null,
  "requiredAbis": ["forge-validator/v2", "forge-assembler/v2"]
}
```

- [ ] **Step 6: Verify v1 and v2 template paths and commit**

Run:

```bash
npx vitest run src/server/template src/server/structured-slots/authoritative-review-profile.test.ts src/server/structured-slots/authoritative-review-profile-archive.test.ts src/server/structured-slots/authoritative-review-capability.test.ts
npm run check
git add src/server/template src/server/structured-slots src/server/main.ts src/server/core-service.ts src/server/http-server.test.ts
git commit -m "feat: gate authoritative review templates"
```

---

### Task 6: Add canonical BlobRefV2 storage

**Files:**

- Create: `src/server/storage/authoritative-review-blob-store.ts`
- Create: `src/server/storage/authoritative-review-blob-store.test.ts`
- Modify: `src/server/storage/core-paths.ts`
- Modify: `src/server/storage/core-paths.test.ts`

**Produces:** Per-task canonical v2 object store, including immutable task-bound profile snapshot blobs, with schema/kind/ref validation and recursive resolution.

- [ ] **Step 1: Write failing storage identity tests**

Test canonical put/read, same ref idempotency, same digest/different bytes corruption, wrong kind/media/schema/size rejection, child-ref validation, missing child fail-closed, task/path containment, frozen profile snapshot archive/ref identity, and objects with equal semantic/root digests but different BlobRef digests.

- [ ] **Step 2: Confirm red**

Run: `npx vitest run src/server/storage/authoritative-review-blob-store.test.ts src/server/storage/core-paths.test.ts`

- [ ] **Step 3: Add v2 paths**

Use explicit helpers rooted under `structured-slots/v2/`; no caller supplies a filesystem path.

- [ ] **Step 4: Implement canonical put/read**

```ts
putJson<T>(taskId: string, kind: K, value: T): Promise<BlobRefV2>;
readJson<T>(taskId: string, ref: BlobRefV2, expectedKind: K): Promise<T>;
resolveClosure(taskId: string, roots: readonly BlobRefV2[]): Promise<ResolvedClosure>;
```

Use existing canonical JSON bytes, same-filesystem atomic rename, byte comparison on collision, and registry child refs.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npx vitest run src/server/storage/authoritative-review-blob-store.test.ts src/server/storage/core-paths.test.ts
npm run check
git add src/server/storage
git commit -m "feat: add authoritative review blob storage"
```

---

### Task 7: Add the exact v2 event union

**Files:**

- Create: `src/server/storage/authoritative-review-events.ts`
- Create: `src/server/storage/authoritative-review-events.test.ts`
- Modify: `src/server/storage/task-events.ts`
- Modify: `src/server/storage/task-events.test.ts`
- Modify: `src/server/storage/event-store.test.ts`

**Produces:** Every approved v2 domain/WorkItem/attempt/SystemCommand/question/Seal event as a strict canonical TaskEvent member.

- [ ] **Step 1: Build a table-driven test vector for every v2 event name**

For each member, test one legal payload and mutations for missing required identity/ref, unknown field, wrong protocol version, cross-attempt branch fields, bare custody digest, invalid filename-safe ID, and illegal null/non-null fields. Include reopenable/non-reopenable `structured_task_failed_v2`, `structured_task_reopened_v2.overrideRef`, `structured_round_budget_override_transferred_v2`, and Map/content round-created `consumedOverrideRef` matrices. Event-ledger attempt/command identity uses IDs + lease epoch + terminal event/commit, never fake BlobRefs.

- [ ] **Step 2: Confirm red**

Run: `npx vitest run src/server/storage/authoritative-review-events.test.ts src/server/storage/task-events.test.ts`

- [ ] **Step 3: Implement the isolated union/validator**

Use shared exact primitives for WorkItem/authority/refs, but keep per-event `MEMBER_KEYS` closed. V2 event timestamps/IDs are generated by system adapters, not domain handlers or Agents. Formal roots include failureRecoveryPayloadRef, created/transferred override refs, and consumedOverrideRef.

- [ ] **Step 4: Dispatch from `validateTaskEvent` without changing legacy members**

The legacy normalizer never rewrites a v2 event. V2 validation runs before append and during replay exactly like legacy validation.

- [ ] **Step 5: Verify atomic batches and v1 snapshot**

Run:

```bash
npx vitest run src/server/storage/authoritative-review-events.test.ts src/server/storage/task-events.test.ts src/server/storage/event-store.test.ts src/server/template/structured-slot-template.acceptance.test.ts
npm run check
```

- [ ] **Step 6: Commit**

```bash
git add src/server/storage
git commit -m "feat: add authoritative review event protocol"
```

---

### Task 8: Protect put-before-append with publication pins and recursive GC

**Files:**

- Create: `src/server/storage/authoritative-publication-store.ts`
- Create: `src/server/storage/authoritative-publication-store.test.ts`
- Create: `src/server/storage/authoritative-publication-intent-registry.ts`
- Create: `src/server/storage/authoritative-publication-intent-registry.test.ts`
- Create: `src/server/storage/authoritative-append-facade.ts`
- Create: `src/server/storage/authoritative-append-facade.test.ts`
- Create: `src/server/storage/authoritative-review-gc.ts`
- Create: `src/server/storage/authoritative-review-gc.test.ts`
- Modify: `src/server/storage/atomic-file.ts`
- Modify: `src/server/storage/atomic-file.test.ts`
- Modify: `src/server/storage/core-paths.ts`
- Modify: `src/server/storage/event-store.ts`
- Modify: `src/server/storage/event-store.test.ts`

**Produces:** Durable pins plus typed publication intents, the sole cross-process-fenced v2 append facade, generation barrier, idempotent publish helper, pin recovery, recursive mark/sweep, and validated event-root enumeration. Task 7 already supplies the exact event union, so facade and GC compile against closed schemas.

- [ ] **Step 1: Add crash/race tests**

Cover crash before put, after put/before append, after append/before pin cleanup, response loss, concurrent GC mark, new object after mark start, dead owner epoch takeover, abandoned pin quarantine, and formal ref surviving multiple GC generations. For put-before-append crashes, test byte-identical replay from a registered typed `PublicationIntentV2`, plus unknown handler/version, missing payload ref, changed reconstruction, stale authority, and no-intent cases that abandon without guessing.

Create two independent `EventStore` + `AuthoritativePublicationStore` + facade instances over the same data root. Race equal-tail same/different operations and assert either idempotent replay or non-overlapping ordered batches; never overlapping sequence files. Test live-lock non-steal, proven-dead owner/start-token epoch takeover, stale cached append manifests, ref removal between prepare and lock, and direct v2 `EventStore.appendBatch` rejection without a live fence proof.

- [ ] **Step 2: Confirm red**

Run: `npx vitest run src/server/storage/authoritative-publication-store.test.ts src/server/storage/authoritative-publication-intent-registry.test.ts src/server/storage/authoritative-review-gc.test.ts`

- [ ] **Step 3: Implement pin lifecycle, typed intent registry, and barrier**

`AuthoritativeAppendFacadeV2.publishWithPin` accepts a stable operation/commit ID, expected tail, prepared refs, and a registered `PublicationIntentV2 {handlerKind, handlerVersion, canonicalOperationPayloadRef, expectedResultIdentity}`. The runtime may use an in-memory builder initially, but startup replay resolves only the stored allowlisted handler/version and payload ref and requires byte-identical reconstruction. The closed registry maps every handler kind/version to one allowed payload kind, parser, exact event/result schema, child-ref extractor, and deterministic builder; it includes state-only lease/retry/stop/resume/answer/recovery/delete families and the artifact-version allocation family. Unknown or mismatched handler/payload/event/result fails closed.

Under one installation/data-root cross-process store lock the facade reloads the on-disk tail/manifest, revalidates pin/refs/operation, allocates sequences and artifact versions, invokes `appendBatch`, fsyncs batch files and parent directory, verifies the new tail, advances the fence generation, and only then releases and cleans up. `commitStateOnly` uses the same typed intent path with no prepared result refs; its operation payload ref remains pinned. Every v2 mutation receives this facade rather than raw EventStore.

Add a dependency-boundary test that rejects `EventStore` imports or construction under `src/server/runtime/authoritative-review` and rejects every `AuthoritativeReviewEventV2` appended without the facade-issued current fence. Keep v1 direct append behavior unchanged.

Extend the committed-write primitive with an explicit durable variant that fsyncs the renamed file's parent directory, and use it for pins, v2 blobs, batch events referenced by pins, generation/lock metadata, and pin terminal markers. Keep the legacy `writeNewAtomic` byte/behavior path intact for v1 unless a focused cross-platform regression proves the stronger helper is compatible.

- [ ] **Step 4: Implement schema-driven recursive GC**

Roots come only from exact Task 7 v2 event fields. Child refs come only from the Task 3 registry. Bare digests are ignored. Checkpoints are not roots.

- [ ] **Step 5: Add startup pin recovery and corruption tests**

Committed operations clean their pins after ref verification. Legal uncommitted operations replay only from a registered intent/payload with unchanged reconstructed bytes and current authority; every other expired pin becomes abandoned, survives one additional generation, and lets WorkItem/lifecycle recovery create a new operation.

- [ ] **Step 6: Verify and commit**

Run:

```bash
npx vitest run src/server/storage/atomic-file.test.ts src/server/storage/event-store.test.ts src/server/storage/authoritative-append-facade.test.ts src/server/storage/authoritative-publication-store.test.ts src/server/storage/authoritative-publication-intent-registry.test.ts src/server/storage/authoritative-review-gc.test.ts
npm run check
git add src/server/storage
git commit -m "feat: protect authoritative blob publication"
```

---

### Task 9: Project v2 state, checkpoints, and stable snapshot cursors

**Files:**

- Create: `src/server/storage/authoritative-review-state.ts`
- Create: `src/server/storage/authoritative-review-state.test.ts`
- Create: `src/server/storage/authoritative-review-checkpoint-store.ts`
- Create: `src/server/storage/authoritative-review-checkpoint-store.test.ts`
- Create: `src/server/storage/review-cursor-keyring.ts`
- Create: `src/server/storage/review-cursor-keyring.test.ts`
- Modify: `src/server/storage/event-store.ts`
- Modify: `src/server/storage/task-projector.ts`
- Modify: `src/server/storage/task-projector.test.ts`
- Modify: `src/server/core-service.ts`

**Produces:** Pure genesis projection, incremental tail replay, persistent append manifest/checkpoints, and restart-stable cursor authentication.

- [ ] **Step 1: Add failing random-transition and corruption tests**

Generate legal and illegal event sequences for single lease, WorkItem epochs, plan successor lineage, current Map/manifest/round, unique question/budget disposition, attempt kind, AuthorityBase staleness, system delivery chain, and formal ref closure. Add override state derivation: reopen-created available, same-lineage transfer supersedes prior ref, round-created consumption once, wrong lineage/plan/track, competing transfer/finalizer, second consumption, or two available refs corrupt. Resolve recovery payload terminal IDs/epoch/event+commit against history and reject fake/mismatched identities. Illegal history must return `corrupt`, never a partial projection.

- [ ] **Step 2: Add failing checkpoint equivalence tests**

For seeded histories, assert genesis replay equals checkpoint + tail digest/state. Corrupt/missing checkpoint falls back to full scan; corrupt authoritative event does not.

- [ ] **Step 3: Add failing key persistence/rotation tests**

Create a cursor, reconstruct CoreService, read the next page, rotate keys, verify the old cursor during retention, retire the key, and receive `CURSOR_STALE(signing_key_retired)`. Missing key file must fail closed.

- [ ] **Step 4: Confirm red**

Run:

```bash
npx vitest run src/server/storage/authoritative-review-state.test.ts src/server/storage/authoritative-review-checkpoint-store.test.ts src/server/storage/review-cursor-keyring.test.ts
```

- [ ] **Step 5: Implement projector and incremental store**

Expose validated `readAfter(taskId, throughSequence)` and append-manifest rebuild in EventStore. Bind checkpoints to `throughSequence + priorCheckpointDigest + projectionSchemaVersion` and verify all referenced refs.

- [ ] **Step 6: Branch TaskProjector/CoreService by frozen protocol**

V1 keeps `projectStructuredSlotState` and in-memory cursor signer. V2 uses the new state/checkpoint/keyring. Do not infer v2 summary from v1 generation fields.

- [ ] **Step 7: Verify and commit**

Run:

```bash
npx vitest run src/server/storage src/server/core-service-live.test.ts src/server/core-service-phase-e.test.ts
npm run check
git add src/server/storage src/server/core-service.ts
git commit -m "feat: project authoritative review state"
```

---

### Task 10: Implement WorkItem, AuthorityBase, retry, and suspension domains

**Files:**

- Create: `src/server/runtime/authoritative-review/authority-base.ts`
- Create: `src/server/runtime/authoritative-review/authority-base.test.ts`
- Create: `src/server/runtime/authoritative-review/work-item-coordinator.ts`
- Create: `src/server/runtime/authoritative-review/work-item-coordinator.test.ts`
- Modify: `src/server/runtime/test-support.ts`

**Produces:** Deterministic WorkItem creation/order/lease/reclaim/retry/park/supersede/completion and exact AuthorityBase matrices using atomic event batches.

- [ ] **Step 1: Add failing transition and stale-base tests**

Cover all legal transitions, invalid `parkDisposition`, mandatory exact profileSnapshotRef on every AuthorityBase/WorkItem/plan/dispatch/grant, same-identity/different-profile stale completion, same-root/different-manifest stale completion, two-lease CAS race, expired reclaim/late result, deterministic ordering, active-successor uniqueness, and WorkItem kind field matrices.

- [ ] **Step 2: Add retry and suspension combination properties**

Test ready/retryable/expired-budget/human WorkItems across stop, service restart, resume, timer expiry, manual retry, and double operations. Resume must not clear human or budget dispositions.

- [ ] **Step 3: Confirm red**

Run: `npx vitest run src/server/runtime/authoritative-review/work-item-coordinator.test.ts`

- [ ] **Step 4: Implement operation-keyed atomic methods**

```ts
createWorkItem(input): Promise<WorkItemRef>;
leaseNext(taskId, workerId, operationId): Promise<LeasedWork | null>;
reclaimExpired(taskId, workItemId, operationId): Promise<void>;
recordRetryableFailure(...): Promise<void>;
requeueDue(...): Promise<void>;
manualRetry(...): Promise<void>;
applySuspension(...): Promise<void>;
clearSuspension(...): Promise<void>;
```

Every method reprojects current state, validates expected tail/authority, prepares refs with a pin, and commits one batch.

- [ ] **Step 5: Add response-loss/idempotency tests**

Same operation and payload returns the original result; changed payload conflicts. No method creates a second logical successor after response loss.

- [ ] **Step 6: Verify and commit**

Run:

```bash
npx vitest run src/server/runtime/authoritative-review/work-item-coordinator.test.ts src/server/storage/authoritative-review-state.test.ts
npm run check
git add src/server/runtime/authoritative-review src/server/runtime/test-support.ts
git commit -m "feat: add authoritative work item coordinator"
```

---

### Task 11: Route v2 task lifecycle through the WorkItem scheduler

**Files:**

- Create: `src/server/runtime/authoritative-review/task-lifecycle.ts`
- Create: `src/server/runtime/authoritative-review/task-lifecycle.test.ts`
- Create: `src/server/runtime/authoritative-review/wakeup-index.ts`
- Create: `src/server/runtime/authoritative-review/wakeup-index.test.ts`
- Create: `src/server/runtime/authoritative-review/startup-recovery.ts`
- Create: `src/server/runtime/authoritative-review/startup-recovery.test.ts`
- Create: `src/server/storage/authoritative-task-deletion.ts`
- Create: `src/server/storage/authoritative-task-deletion.test.ts`
- Create: `src/server/storage/authoritative-task-index.ts`
- Create: `src/server/storage/authoritative-task-index.test.ts`
- Modify: `src/server/storage/task-store.ts`
- Modify: `src/server/storage/task-store.test.ts`
- Modify: `src/server/runtime/task-scheduler.ts`
- Modify: `src/server/runtime/task-scheduler.test.ts`
- Modify: `src/shared/contracts.ts`
- Modify: `src/shared/api-schemas.ts`
- Modify: `src/server/core-service.ts`
- Modify: `src/server/api/task-routes.ts`
- Modify: `src/server/api/api.integration.test.ts`
- Modify: `src/client/components/task-controls.tsx`
- Modify: `src/client/components/task-controls.test.tsx`
- Modify: `src/client/pages/task-list-page.tsx`
- Modify: `src/client/pages/task-list-page.test.tsx`

**Produces:** V2 start/resume/stop/retry/reopen/answer/delete version dispatch, persistent ready/due-work wakeups, deterministic non-graceful startup recovery, cross-process deletion tombstones/quarantine, and `failed` UI/API behavior.

- [ ] **Step 1: Add failing start/resume/recovery tests**

Assert v2 start commits `task_started + MapBuildSpec + first structure WorkItem + AuthorityBase + GrantSpec` with no seeded legacy `agent_input`; start on stopped/interrupted returns `USE_RESUME`; resume never seeds a new build; a ready WorkItem runs even when there is no Route/pending input.

Add A -> same-identity/different-digest B -> disabled -> exact A restart tests. B/disabled must expose `executionEligibility=blocked` without changing the event-derived TaskStatus, WorkItem disposition, retry timer, or wakeup identity; scheduler claim/reclaim and execution-producing mutations return `AUTHORITATIVE_REVIEW_UNAVAILABLE`. Exact A makes an underlying running task claimable through startup reconciliation without a resume/reopen event, while stopped/waiting-human/retry-budget-exhausted states remain governed by their existing commands. Permanent unsupported frozen schema alone projects terminal `incompatible`.

Table-test the complete Spec 10.4 startup matrix: in-flight reclaim/abandon, ready registration/claim, retry-before-due timer rebuild, retry-after-due requeue, stopped/interrupted dormant wakeups, pending question rebuild, terminal cleanup, and `running + no non-terminal WorkItem -> RUNNING_WITHOUT_WORK`. Repeating a scan with `H(taskId, observedTailCommitId, 'auto_continue_v1')` must replay the same compensation; a changed tail must reproject before a new action. Kill/recreate Coordinator instances and prove no in-memory queue or timer is required.

- [ ] **Step 2: Add failing retry/question/reopen endpoint tests**

Test stale two-tab answer, operation replay/conflict, stop while waiting, budget stop/resume, terminal failed command rejection, legal `reopen_failed`, and v1 old answer/start behavior unchanged. The case-sensitive opaque question token cannot be derived from the event tail, survives unrelated appends/stop/restart/resume, binds question + WorkItem + logical assignment + attempt/epoch + AuthorityBase + opened commit, rejects lowercase normalization/prior/recomputed-different tokens, and makes repeated same-operation/same-answer delivery idempotent.

Add two-instance deletion tests for running/ready, leased attempt, retry-before/after-due, active PublicationPin, Seal staging, startup recovery, and concurrent append. The fenced operation must create an installation-level prepared tombstone, block every subsequent facade/read/claim with `TASK_DELETED`, remove durable wakeups, make pins non-replayable, atomically rename the task root to epoch-keyed quarantine with parent fsync, and purge asynchronously. Crash/restart at prepared/detached/purged resumes idempotently; a reappearing directory is quarantined and never revives. Same operation replays; different delete payload conflicts. Preserve legacy v1 delete tests unchanged.

Freeze and test `DeleteTaskBodyV2/ResultV2` end to end. Task summaries expose protocol derived from frozen snapshot/index. `task-list-page.tsx` owns the real confirmation state: it creates one UUID when the v2 dialog opens, requires/bounds a reason, and keeps the dialog plus same canonical body after a retryable/response-loss error; success or cancel clears it, and editing the reason intentionally creates a new operation. Gateway sends a DELETE JSON body only for a summary-discriminated v2 task. The first release injects the fixed local `task_owner` principal and ignores/rejects client actor fields. Same operation/body returns the detached/purged result after response loss; changed reason conflicts. The installation task index selects v2 even when its task record/root is corrupt; corrupt v1 keeps legacy delete. Missing/extra body fields and wrong-protocol body fail before a tombstone is written. Preserve current v1 no-reason/no-body behavior and its page tests.

Implement the installation migration barrier before any v2 create: under the fence capture every pre-marker task directory and durably register it `legacy_preexisting` even if unreadable, then fsync the completed marker. Crash resumes the same captured set and v2 creation stays disabled; any later unindexed directory is quarantined/fail-closed. Then implement creation/index atomicity inside `TaskStore.create`, the only ID/root publisher: require marker -> prepared index fsync -> complete temp task root/snapshot fsync -> root rename + parent fsync -> active index. Add crashes after every phase, startup repair/cancel, two-instance create/delete, tombstoned/legacy ID no-reuse, preexisting corrupt-v1 legacy delete, valid no-index post-marker v1/v2 quarantine, and corrupt/mismatched root tests. CoreService must not try to add the index after `tasks.create()` returns.

TaskStore creation now owns the real profile blob choreography and therefore depends on Tasks 5/6/8: compute the exact ref from the frozen profile, write/fsync `profile_snapshot` inside the temporary task root, persist the prepared index with that ref, rename/fsync the complete root, and advance active under the installation fence. Prepared/active index refs and their frozen-template aliases are formal GC roots; deletion keeps the root through detached quarantine until the purged tombstone is durable. Test create-before-start followed by multiple GC generations, crash at each prepared/root/index phase, and create/GC/delete races. Task 5 contains no mock TaskStore binding claim.

Test the complete failure-code/recipe table from Spec 10.3.1. Each eligible failed event must carry `failureRecoveryPayloadRef` to the exact branch; `rebuild_missing_work` requires predecessor/expected-successor/base/grant input and forbids nonexistent failed WorkItem/attempt identities, while other branches require IDs + epoch + terminal event/commit and actual object refs only. Assert one legal and every illegal recipe/track/base/permission combination for Seal/SystemCommand, Map/content round-limit, and reconstructible `RUNNING_WITHOUT_WORK`; strict event/object/child-ref/projector tests cover each branch and reject fake WorkItem/Attempt BlobRefs. Corrupt/incompatible/delete/non-reconstructible failures offer clone only. Response loss replays one replacement; stale tail or changed reason conflicts; no reopen mutates the failed WorkItem, resets counters, reuses staging, widens a Grant, or creates two successors.

For round-limit recovery, reopen creates one registered override blob with repairLineageId, initial/current RepairPlan refs, null predecessor override and transfer ordinal 0; its event roots `overrideRef` but does not increment a cycle. Scope expansion/correction atomically creates the successor override and `structured_round_budget_override_transferred_v2`, superseding the old ref only within the same lineage. Drive Map/content paths through zero/one/multiple transfers -> finalizer -> round-created `consumedOverrideRef` + exactly one ordinal increment -> settlement. Genesis/checkpoint replay and GC retain the closure. Replay returns the same transfer/round; wrong/stale plan, wrong lineage/track, competing finalizers, or second consumption reject. A later over-limit round without a new authorized override fails again.

- [ ] **Step 3: Confirm red**

Run:

```bash
npx vitest run src/server/runtime/authoritative-review/task-lifecycle.test.ts src/server/runtime/task-scheduler.test.ts src/server/api/api.integration.test.ts src/client/components/task-controls.test.tsx
```

- [ ] **Step 4: Implement one frozen-version branch at each entry**

Keep v1 methods untouched behind the v1 branch. V2 scheduler loop checks deletion tombstone, event-derived task status/dispositions, then the separately derived execution eligibility, and only then leases one WorkItem. A blocked deployment keeps its wakeup entry but does not busy-loop; environment/startup reconciliation reactivates it when the exact profile becomes eligible. Startup and every committed successor/timer/resume upsert the same durable wakeup index; a full startup scan repairs that disposable index from event projection plus the current non-authoritative eligibility gate. Every recovery/lifecycle write goes through `AuthoritativeAppendFacadeV2`. CoreService's v2 delete branch delegates to `AuthoritativeTaskDeletionV2` using the installation task index; it never calls legacy recursive deletion on an active/corrupt v2 root. `reopenFailed` applies only the frozen policy table, derives replacement base/scope/Grant server-side, and upserts its wakeup in the same batch.

- [ ] **Step 5: Project `failed` and recovery actions**

Add structured failure summary to list/detail; render source, stable code, and only policy-allowed reopen/clone actions. Ordinary retry/resume controls remain disabled for failed.

- [ ] **Step 6: Verify and commit**

Run:

```bash
npx vitest run src/server/runtime/authoritative-review/startup-recovery.test.ts src/server/runtime/authoritative-review/wakeup-index.test.ts src/server/storage/authoritative-task-index.test.ts src/server/storage/authoritative-task-deletion.test.ts src/server/storage/task-store.test.ts src/server/runtime/task-scheduler.test.ts src/server/api src/client/components/task-controls.test.tsx src/client/pages/task-list-page.test.tsx
npm run check
git add src/server/runtime src/server/storage src/server/api src/server/core-service.ts src/client/components/task-controls* src/client/pages/task-list-page*
git commit -m "feat: schedule v2 tasks from persistent work items"
```

---

### Task 12: Execute structured, generic, and SystemCommand attempts

**Files:**

- Create: `src/server/runtime/authoritative-review/attempt-coordinator.ts`
- Create: `src/server/runtime/authoritative-review/attempt-coordinator.test.ts`
- Create: `src/server/runtime/authoritative-review/assignment-runner.ts`
- Create: `src/server/runtime/authoritative-review/assignment-runner.test.ts`
- Modify: `src/server/runtime/task-runner.ts`
- Modify: `src/server/runtime/task-runner.test.ts`
- Modify: `src/server/runtime/pi-agent-runtime.ts`
- Modify: `src/server/runtime/pi-agent-runtime.test.ts`
- Modify: `src/server/runtime/action-committer.ts`
- Modify: `src/server/runtime/action-committer.test.ts`

**Produces:** WorkItem-driven v2 Pi turns, isolated namespaces, versioned attempt events, SystemCommand dispatch, and terminal atomicity.

- [ ] **Step 1: Add failing attempt-envelope tests**

Prove lease atomically includes dispatch/input and exactly one of structured Agent, generic Agent, or SystemCommand start; illegal cross-kind fields fail; terminal result/domain facts/WorkItem completion are all-or-none.

- [ ] **Step 2: Add namespace/history-isolation tests**

Run two WorkItems for the same Agent ID and prove the second prompt receives only current assignment, bounded committed checkpoint, and approved Map/content reads—not raw prior conversation/human messages. Reviewer never receives orchestrator/generator history.

- [ ] **Step 3: Add late result, timeout, and response-loss tests**

An old epoch cannot write trace/domain/terminal state. Provider abort prevents further tools. Replaying a successful completion returns the original commit.

- [ ] **Step 4: Confirm red**

Run:

```bash
npx vitest run src/server/runtime/authoritative-review/attempt-coordinator.test.ts src/server/runtime/authoritative-review/assignment-runner.test.ts src/server/runtime/task-runner.test.ts src/server/runtime/pi-agent-runtime.test.ts
```

- [ ] **Step 5: Add a v2 runner entry without altering `runStructuredNext`**

The runner consumes a leased AssignmentDispatch, injects the v2 tool provider, persists only public trace, and submits its completion to the v2 committer. Generic Submitter reuses basic-turn execution with delivery-bound authority.

- [ ] **Step 6: Register the six SystemCommand handlers**

Start with typed handler interfaces and explicit `NOT_IMPLEMENTED` retryable test doubles; later domain tasks supply handlers. System handlers cannot access Agent prompt/tools or open human questions.

- [ ] **Step 7: Verify and commit**

Run:

```bash
npx vitest run src/server/runtime/authoritative-review src/server/runtime/task-runner.test.ts src/server/runtime/pi-agent-runtime.test.ts src/server/runtime/action-committer.test.ts
npm run check
git add src/server/runtime
git commit -m "feat: execute authoritative work assignments"
```

---

### Task 13: Issue Grants and expose bound session tools

**Files:**

- Create: `src/server/runtime/authoritative-review/grant-service.ts`
- Create: `src/server/runtime/authoritative-review/grant-service.test.ts`
- Create: `src/server/runtime/authoritative-review/tool-factory.ts`
- Create: `src/server/runtime/authoritative-review/tool-factory.test.ts`
- Create: `src/server/storage/authoritative-review-private-store.ts`
- Create: `src/server/storage/authoritative-review-private-store.test.ts`
- Modify: `src/server/runtime/pi-agent-runtime.ts`

**Produces:** WriteGrantSpec/GrantInstance, attempt-bound draft/staging journals, closed session tool lists, and full-tree bounded reads.

- [ ] **Step 1: Add failing Grant identity/scope tests**

Test spec/WorkItem/AuthorityBase equality, instance binding after attempt ID, reclaim re-sign with unchanged scope, stale baseline/epoch, same-root/different-manifest, out-of-scope write, oversized payload, and scope-expansion cannot mutate current Grant.

- [ ] **Step 2: Add exact per-session tool-list tests**

Assert each session gets only the capabilities in the spec. Both `review_map_batch` and `review_map_whole`, plus both content reviewer session kinds, receive `submit_finding_verification` when and only when their frozen assignment contains verification targets; its exact body is only findingId/stage/resolved-or-still-present/evidence/clientOperationId, while closure binds task/round/assignment/attempt/base. Add one reachable and one forbidden verification case per session kind. Reviewer has no Map/content write, Seal, Grant, free-standing `submit_finding`, or Finding-close tools. Batch verdict tools accept ordinary anchored `findingDrafts` and constrained `crossScopeFindingDrafts`; whole sessions alone get their whole-finding tool. Test assigned source/nonexistent primary/wrong baseline/duplicate/oversize/response-loss, unreviewed-primary deterministic assignment routing, already-reviewed-primary whole-observation routing, and settlement blocked until mandatory target decision. Every mutating tool exact schema requires `clientOperationId` (or the one frozen trusted-runner stable tool-call identity) and forbids task/path/grant/lease/attempt/authority fields; add response-loss replay and same-ID/different-body conflict for every write family. Reject `mapPassed/treePassed/sealApproved`.

- [ ] **Step 3: Add private-journal recovery tests**

Same attempt/same call idempotently resumes; a reclaimed/new attempt cannot commit old draft or review journal; repair staging is plan/revision/ordinal scoped and never publicly visible by directory scan.

- [ ] **Step 4: Confirm red**

Run:

```bash
npx vitest run src/server/runtime/authoritative-review/grant-service.test.ts src/server/runtime/authoritative-review/tool-factory.test.ts src/server/storage/authoritative-review-private-store.test.ts
```

- [ ] **Step 5: Implement closure-bound tools and paging budgets**

Each tool resolves its lease/dispatch/grant from the provider closure, reprojects authority before mutation, and delegates to the relevant domain service. Read tools page committed objects only.

Verification calls write only the current attempt's private review journal. `complete_review_assignment` verifies one record for each `verificationFindingStage` plus all ordinary targets, then freezes ReviewFacts and FindingVerificationRecords together in one AssignmentLedgerBlob/event. Stale/non-addressed/system-validator/wrong-stage/wrong-baseline/duplicate verification rejects without partial publication.

- [ ] **Step 6: Verify and commit**

Run:

```bash
npx vitest run src/server/runtime/authoritative-review src/server/storage/authoritative-review-private-store.test.ts src/server/runtime/pi-agent-runtime.test.ts
npm run check
git add src/server/runtime/authoritative-review src/server/storage src/server/runtime/pi-agent-runtime.ts
git commit -m "feat: bind authoritative review tools and grants"
```

---

### Task 14: Execute Validator v2 and freeze aggregate custody

**Files:**

- Create: `src/server/runtime/authoritative-review/validator-registry.ts`
- Create: `src/server/runtime/authoritative-review/validator-registry.test.ts`
- Create: `src/server/runtime/authoritative-review/validator-engine.ts`
- Create: `src/server/runtime/authoritative-review/validator-engine.test.ts`
- Create: `src/server/runtime/authoritative-review/builtin-validators.ts`
- Modify: `src/server/runtime/structured-slot/evaluator-runner.ts`
- Modify: `src/server/runtime/structured-slot/evaluator-runner.test.ts`
- Modify: `src/server/structured-slots/authoritative-review-profile-v1.json`
- Modify: `src/server/structured-slots/authoritative-review-profile.test.ts`
- Modify: `src/server/structured-slots/authoritative-review-profile-archive.test.ts`
- Modify: `src/server/template/template-loader.test.ts`
- Modify: affected v2 semantic-hash fixtures

**Produces:** Allowlisted deterministic handlers, input envelopes, receipts/failures, aggregates, warning roots/custody, frozen trigger routing, and a new immutable provisional profile revision that replaces fixture validator identities with the installed production validator identities.

- [ ] **Step 1: Add registry and phase-matrix tests**

Reject unknown/multiple handler identity, digest mismatch, non-builtin implementation, invalid trigger/phase, advisory seal-output, budget expansion, and v1 CJS registration passed to v2.

- [ ] **Step 2: Add result/target-matrix and determinism tests**

Cover legal valid/domain-invalid, empty/unknown/malformed output, handler enforcement spoof, target outside selected snapshot, seal input without repair targets, seal output with content targets, two runs with different digest, and sandbox network/clock/random/task-I/O denial.

- [ ] **Step 3: Add aggregate/custody DAG tests**

Prove missing/duplicate execution becomes infrastructure failure, outcome priority, advisory clear behavior, canonical ordering, phase separation, recursive `aggregate.inputRef -> envelope -> core`, no final object self-ref, and failed branches survive GC.

- [ ] **Step 4: Confirm red**

Run: `npx vitest run src/server/runtime/authoritative-review/validator-*.test.ts`

- [ ] **Step 5: Implement v2 evaluator adapter and engine**

Reuse isolate creation/budget enforcement, but pass only resolved canonical envelope data and v2 ABI. Do not expose snapshot path or reuse v1 `{pass,issues}` interpretation.

- [ ] **Step 6: Add minimal platform-generic builtins**

Implement structural schema/coverage/artifact-path validators required by fixtures. Template-specific Zhihu validation comes later as installed source modules with frozen registry digests, not template code.

- [ ] **Step 7: Rotate the immutable profile and verify/commit**

Generate a new `qualificationState: provisional` profile/archive entry from the installed validator registry, update the loader/semantic-hash fixtures, and prove the prior test-only profile cannot load a Contract that names a new production handler. Never edit archived profile bytes in place; the disabled production capability still prevents use.

Run:

```bash
npx vitest run src/server/runtime/authoritative-review/validator-registry.test.ts src/server/runtime/authoritative-review/validator-engine.test.ts src/server/runtime/structured-slot/evaluator-runner.test.ts
npm run check
git add src/server/runtime src/server/structured-slots/authoritative-review-profile-v1.json src/server/structured-slots/authoritative-review-profile*.test.ts src/server/template/template-loader.test.ts src/server/template/__fixtures__
git commit -m "feat: add deterministic validator v2 engine"
```

---

### Task 15: Build chunked Maps and finalize system-owned candidates

**Files:**

- Create: `src/server/runtime/authoritative-review/map-build-service.ts`
- Create: `src/server/runtime/authoritative-review/map-build-service.test.ts`
- Create: `src/server/runtime/authoritative-review/map-build-service.property.test.ts`
- Modify: `src/server/runtime/authoritative-review/tool-factory.ts`
- Modify: `src/server/runtime/authoritative-review/assignment-runner.ts`
- Modify: `src/server/runtime/authoritative-review/work-item-coordinator.ts`

**Produces:** Recoverable MapBuild specs/chunks/manifests/key ledgers, finish proposal, system finalizer, rejected-build successor, and system-provenance MapCandidateSnapshot.

- [ ] **Step 1: Add failing chunk/frontier/key tests**

Cover contiguous ordinals, parent frontier, root count, stable build-local keys, same-chunk reference order, duplicate/missing/tombstoned keys, disabled/optional relations, zero relations, byte/slot/depth/children limits, wrong Grant, old attempt, and response-loss replay.

- [ ] **Step 2: Add failing finalizer-only-publication tests**

An Agent finish call must create only a finish proposal/System WorkItem. An Agent attempt cannot write `structured_map_candidate_committed`. Two System finalizers race and only one candidate/round successor commits.

- [ ] **Step 3: Add rejected/successor tests**

Blocking candidate validation retains aggregate/input/receipt, marks old build rejected, creates one successor revision with imported immutable chunks and explicit replacement ordinals, and never auto-retries the same finalizer. Infrastructure failure retries without a successor.

- [ ] **Step 4: Confirm red**

Run: `npx vitest run src/server/runtime/authoritative-review/map-build-service*.test.ts`

- [ ] **Step 5: Implement build operations and SystemCommand handler**

Persist each chunk and active manifest through publication pins; finalizer traverses only the event-bound manifest/key ledger. Candidate provenance is `system_finalize` with a contribution manifest of Agent chunk attempts.

- [ ] **Step 6: Add 10,000-node interrupted-build property test**

Create at least 40 chunks, crash/restart at seeded boundaries, resume from first incomplete ordinal, finalize, and compare candidate digest with uninterrupted construction.

- [ ] **Step 7: Verify and commit**

Run:

```bash
npx vitest run src/server/runtime/authoritative-review/map-build-service*.test.ts src/server/runtime/authoritative-review/tool-factory.test.ts
npm run check
git add src/server/runtime/authoritative-review
git commit -m "feat: build authoritative map candidates"
```

---

### Task 16: Review and atomically activate candidate Maps

**Files:**

- Create: `src/server/runtime/authoritative-review/review-coordinator.ts`
- Create: `src/server/runtime/authoritative-review/map-review-service.ts`
- Create: `src/server/runtime/authoritative-review/map-review-service.test.ts`
- Create: `src/server/runtime/authoritative-review/observation-planner.ts`
- Create: `src/server/runtime/authoritative-review/observation-planner.test.ts`
- Modify: `src/server/runtime/authoritative-review/tool-factory.ts`
- Modify: `src/server/runtime/authoritative-review/work-item-coordinator.ts`

**Produces:** MapReviewRound/assignments/ledgers, layered whole-Map observations, Map settlement DAG, MapReviewBundle, active MapSnapshot, baseline-unset manifest, and GenerationPlan successor.

- [ ] **Step 1: Add failing deterministic planner tests**

For shuffled nodes/relations, freeze identical batches by document order/locality, respect target/object limits, include every Map node and every actual candidate relation exactly once—including advisory relations even when `reviewAdvisoryRelations=false`—and plan bounded layered observations to one root. Zero relation graph adds no relation assignment. Add a paired content-review test proving that the same false policy excludes advisory relations only from content relation-satisfaction assignments while retaining all blocking ones.

- [ ] **Step 2: Add reviewer-ledger tests**

Draft verdicts are invisible until assignment completion. Completion requires every target, evidence/context digest, no conflict, and current attempt/base. Reviewer cannot submit aggregate pass, activate, create Grant, or close Finding.

- [ ] **Step 3: Add settlement DAG and Gate tests**

Prove `CoverageCore -> settlement aggregate -> SettlementCore -> ProposedMapCore -> activation aggregate -> MapReviewBundle/MapSnapshot` is acyclic. Missing fact/observation, reject, blocking Finding, or validator failure cannot activate or create GenerationPlan.

- [ ] **Step 4: Add candidate replacement tests**

First Map clear activates and creates a complete baseline-unset manifest. A rejected replacement leaves old Map/content current. Equal semantic Map but new snapshot ref still invalidates exact authority.

- [ ] **Step 5: Confirm red**

Run:

```bash
npx vitest run src/server/runtime/authoritative-review/map-review-service.test.ts src/server/runtime/authoritative-review/observation-planner.test.ts
```

- [ ] **Step 6: Implement review tools, settlement handler, and atomic first activation**

Use one AssignmentLedgerBlob per assignment and one root observation closure. The `system_review_settlement(stage=initial)` handler is the only activator and creates deterministic successor WorkItems in its completion envelope.

- [ ] **Step 7: Verify no content generation before activation**

Add an integration assertion over event sequences that no generation WorkItem/attempt/event precedes `structured_map_activated` with a clear MapReviewBundle.

- [ ] **Step 8: Verify and commit**

Run:

```bash
npx vitest run src/server/runtime/authoritative-review/map-review-service.test.ts src/server/runtime/authoritative-review/observation-planner.test.ts src/server/runtime/task-scheduler.test.ts
npm run check
git add src/server/runtime/authoritative-review
git commit -m "feat: review and activate authoritative maps"
```

---

### Task 17: Generate content through manifests and two validator phases

**Files:**

- Create: `src/server/runtime/authoritative-review/content-plan-service.ts`
- Create: `src/server/runtime/authoritative-review/content-plan-service.test.ts`
- Create: `src/server/runtime/authoritative-review/content-plan-service.property.test.ts`
- Modify: `src/server/runtime/authoritative-review/tool-factory.ts`
- Modify: `src/server/runtime/authoritative-review/work-item-coordinator.ts`

**Produces:** Deterministic GenerationPlan, scoped generation batches, SlotContentVersionV2/ContentRevisionManifestV2, batch validation, plan finalization, and correction successor.

- [ ] **Step 1: Add failing plan and single-writer tests**

Test deterministic complete slot partition, one runnable batch, full Map/context reads, batch-only writes, manifest CAS, stale Map/manifest Grant, overscope rejection, and no review before finalization.

- [ ] **Step 2: Add manifest identity/presence tests**

Cover baseline unset, partial provisional set, finalized complete content, optional unset, required unset, rewrite-required, schema validation, sorted total coverage, Map semantic/ref checks, and same root/different provenance refs.

- [ ] **Step 3: Add validator phase isolation tests**

Partial batches run only `content_commit/batch_commit`; the finalizer alone runs `plan_finalize` against the complete provisional manifest. A global validator must not reject the first legal partial batch.

- [ ] **Step 4: Add blocking successor tests**

Finalizer domain invalid creates a receipt and one successor GenerationPlan with imported untouched versions and deterministic correction batches. Advisory clear does not. Infrastructure failure retries the SystemCommand.

- [ ] **Step 5: Confirm red**

Run: `npx vitest run src/server/runtime/authoritative-review/content-plan-service*.test.ts`

- [ ] **Step 6: Implement content batch/finalizer services**

Each clear batch publishes a provisional manifest that stores the batch core/aggregate/warning provenance per replaced set version. The finalizer publishes a new finalized manifest with finalizer custody refs.

- [ ] **Step 7: Add interrupted 10,000-slot plan property test**

Restart after seeded batches and prove resumed result/plan closure equals uninterrupted execution without rerunning completed ordinals.

- [ ] **Step 8: Verify and commit**

Run:

```bash
npx vitest run src/server/runtime/authoritative-review/content-plan-service*.test.ts src/server/runtime/authoritative-review/validator-engine.test.ts
npm run check
git add src/server/runtime/authoritative-review
git commit -m "feat: generate authoritative content manifests"
```

---

### Task 18: Review content per slot/relation and settle Findings

**Files:**

- Create: `src/server/runtime/authoritative-review/content-review-service.ts`
- Create: `src/server/runtime/authoritative-review/content-review-service.test.ts`
- Create: `src/server/runtime/authoritative-review/finding-service.ts`
- Create: `src/server/runtime/authoritative-review/finding-service.test.ts`
- Create: `src/server/runtime/authoritative-review/review-adoption-service.ts`
- Create: `src/server/runtime/authoritative-review/review-adoption-service.test.ts`
- Modify: `src/server/runtime/authoritative-review/review-coordinator.ts`
- Modify: `src/server/runtime/authoritative-review/tool-factory.ts`

**Produces:** Presence-aware ReviewRound, slot/relation facts, adoption roots, layered whole-tree observation, Finding lifecycle/verification, ReviewBundle, and deterministic repair route.

- [ ] **Step 1: Add coverage tests**

Required/optional set slots each require one current pass/reject fact; optional unset gets one system `absent_not_applicable`; required unset/rewrite-required routes to repair before planning. Content coverage always includes every actual blocking relation and includes actual advisory relations only when `reviewAdvisoryRelations=true`; zero relations passes relation coverage. Cross-test that Map pre-review always covered those advisory relations regardless of this switch.

- [ ] **Step 2: Add fact/adoption tests**

Only committed assignment facts count. Historical batch facts require exact stable target/subject/context/policy match and an AdoptionRecord in the current root. Whole-observation facts or adoption-ineligible facts reject. Current and adopted target sets cannot overlap.

- [ ] **Step 3: Add whole-tree observation tests**

Use bounded layered assignments and one root closure. An observation can add Finding/reject/violated facts or a no-new-finding receipt, but cannot submit whole-tree pass/fail. Any content/Map change requires a new root observation.

- [ ] **Step 4: Add Finding route/status/verification tests**

Test reviewer/system-validator source identities, evidence/target validation, `content | map | mixed`, mixed Map-first route, addressed not closed, reviewer or validator verification requirements, and Agent close rejection. Drive ordinary reviewer Findings through verdict-anchored creation -> repair planned/dispatched -> addressed -> next assignment verification target -> `submit_finding_verification(resolved|still_present)` draft -> atomic assignment ledger -> settlement verified/closed or reopened. Also drive a cross-scope draft from an assigned source to an unreviewed primary target and an already-reviewed primary target; assert deterministic assignment/whole-observation routing, immutable blocking obligation, exact-baseline target verdict resolution, and no settlement/Seal while unrouteable or undecided. Required verification missing/duplicate/stale makes the assignment incomplete; system-validator Findings reject the reviewer tool and close only by validator rerun.

- [ ] **Step 5: Add settlement and ReviewBundle DAG tests**

`ContentReviewCoverageCore -> settlement aggregate -> SettlementCore -> ReviewBundle` must be acyclic and exact-ref bound. Clear creates a System Seal WorkItem. Any blocking fact/Finding creates repair, never Seal.

Add hard-cycle-budget tests at `maxRounds-1`, `maxRounds`, and `maxRounds+1` for initial and repaired content rounds. Assignment retries, whole-observation layers, validator infrastructure retry, stop/resume, and response-loss replay do not increment the content cycle. Attempting the over-limit successor atomically terminal-fails finalizer/settlement and task with `REVIEW_REPAIR_LIMIT_EXCEEDED` and publishes no round/RepairPlan/ReviewBundle/Seal. Ordinary retry/resume reject it. The only exception is an exact available Content `RoundBudgetOverrideV2`, atomically consumed when the new complete round receives one ordinal increment; wrong/preconsumed override rejects.

- [ ] **Step 6: Confirm red**

Run:

```bash
npx vitest run src/server/runtime/authoritative-review/content-review-service.test.ts src/server/runtime/authoritative-review/finding-service.test.ts src/server/runtime/authoritative-review/review-adoption-service.test.ts
```

- [ ] **Step 7: Implement services and immutable ledgers**

Store assignments/adoptions as bounded canonical chunks/roots. Planning and settlement use exact Map/manifest/policy refs and current event tail.

- [ ] **Step 8: Verify and commit**

Run:

```bash
npx vitest run src/server/runtime/authoritative-review/content-review-service.test.ts src/server/runtime/authoritative-review/finding-service.test.ts src/server/runtime/authoritative-review/review-adoption-service.test.ts
npm run check
git add src/server/runtime/authoritative-review
git commit -m "feat: settle per-slot content reviews"
```

---

### Task 19: Repair Map/content through versioned private staging

**Files:**

- Create: `src/server/runtime/authoritative-review/repair-service.ts`
- Create: `src/server/runtime/authoritative-review/repair-service.test.ts`
- Create: `src/server/runtime/authoritative-review/repair-service.property.test.ts`
- Modify: `src/server/runtime/authoritative-review/grant-service.ts`
- Modify: `src/server/runtime/authoritative-review/tool-factory.ts`
- Modify: `src/server/runtime/authoritative-review/work-item-coordinator.ts`

**Produces:** Deterministic Map/Content RepairPlan specs/revisions, serial batches, plan-aware reads/writes, scope expansion, finalizer-only publication, and verification loop.

- [ ] **Step 1: Add initial/successor identity tests**

Initial plan must have no fake predecessor and uses the settlement creation key. Successor requires one predecessor and a stable operation key. Competing scope-expansion/validation successors yield one winner; the loser must re-evaluate on the winner.

- [ ] **Step 2: Add Map staging/key-lineage tests**

Each batch CASes expected staging root, may refer to prior plan keys, carries key ledger/lineage, respects operation/node/relation scope, and cannot publish a candidate. Official IDs are allocated only by finalizer.

- [ ] **Step 3: Add content staging/continuity tests**

Grant writes only targeted slots but reads full committed tree, adjacent slots, and actual relation context. Verify unchanged out-of-scope version refs, same-root/different-manifest stale, and batched repairs do not trigger early review.

- [ ] **Step 4: Add scope expansion tests**

Approval atomically supersedes old WorkItem/Grant and creates a successor plan/spec/WorkItem/new Grant within hard limits. Rejection terminal-completes the request without widening authority.

- [ ] **Step 5: Add finalizer route tests**

Clear publishes one candidate or finalized content manifest and plans complete re-review; blocking validation creates one correction successor; infrastructure failure retries. Last Agent batch only creates the finalizer.

Enforce the system-projected `mapCycleOrdinal`/`contentCycleOrdinal` at the same atomic boundary that would publish a repaired candidate/finalized manifest and create its complete review round. Add perpetual Map reject, perpetual content reject, mixed Map-first then content re-review, exact-boundary success, and over-limit response-loss tests. Map/content budgets are independent, cannot be traded or reset by stop/resume/manual retry, and infrastructure retries of the same round consume none. Over-limit writes exactly one `structured_task_failed_v2(REVIEW_REPAIR_LIMIT_EXCEEDED)` and no successor unless the same atomic round-creation envelope consumes the exact track/predecessor/operator-bound available `RoundBudgetOverrideV2`. Reopen itself does not increment; consumption increments once. Replay, second consumption, wrong track/predecessor, and a subsequent unoverridden round are tested.

- [ ] **Step 6: Confirm red**

Run: `npx vitest run src/server/runtime/authoritative-review/repair-service*.test.ts`

- [ ] **Step 7: Implement and verify**

Run:

```bash
npx vitest run src/server/runtime/authoritative-review/repair-service*.test.ts src/server/runtime/authoritative-review/grant-service.test.ts src/server/runtime/authoritative-review/tool-factory.test.ts
npm run check
git add src/server/runtime/authoritative-review
git commit -m "feat: add scoped authoritative repair plans"
```

---

### Task 20: Migrate content across approved Map replacements

**Files:**

- Create: `src/server/runtime/authoritative-review/migration-service.ts`
- Create: `src/server/runtime/authoritative-review/migration-service.test.ts`
- Create: `src/server/runtime/authoritative-review/migration-service.property.test.ts`
- Modify: `src/server/runtime/authoritative-review/map-review-service.ts`
- Modify: `src/server/runtime/authoritative-review/work-item-coordinator.ts`

**Produces:** Intent, persistent validation plan/batches, equivalence proof/fresh validation, settlement, provisional manifest, finalizer, activation decision, and four-way atomic route.

- [ ] **Step 1: Add action-coverage tests**

For every source/target slot pair, exactly one action is constructible: `inherit_or_validate`, `carry_unset`, `rewrite_required`, or `new_or_schema_reset`. Optional compatible unset must not fall through.

- [ ] **Step 2: Add local-validator custody tests**

Reusing an old batch aggregate requires exact frozen registration set, selector expansion, content bytes, local Map subgraph, and relation context equivalence. Any difference runs a fresh target-Map batch validator or yields rewrite-required.

- [ ] **Step 3: Add recoverable batch/settlement tests**

Persist ordered result roots, resume the first missing ordinal after crash, validate complete closure before settlement, and retain every proof/aggregate/receipt/Finding through event roots and GC.

- [ ] **Step 4: Add preactivation finalizer and route tests**

Use only `mapContext=migration_preactivation`. Combine batch/finalizer classifications in MigrationActivationDecision and test:

```text
clear -> Map + finalized manifest + review
content -> Map + provisional manifest + ContentRepairPlan
map/mixed -> no activation + old baseline + candidate MapRepairPlan
infrastructure -> no activation envelope + retry/fail
```

- [ ] **Step 5: Confirm red**

Run: `npx vitest run src/server/runtime/authoritative-review/migration-service*.test.ts`

- [ ] **Step 6: Implement `system_review_settlement(stage=initial|post_migration)`**

Initial creates the migration validation plan and first batch when needed. Last batch creates one post-migration WorkItem. Post-migration alone freezes settlement/finalizer/decision and activates or routes repair.

- [ ] **Step 7: Add 10,000-slot restart/equality property test**

Most slots should take equivalence/carry paths; seed a minority of fresh validation/rewrite/new cases. Compare uninterrupted and restarted final refs/routes.

- [ ] **Step 8: Verify and commit**

Run:

```bash
npx vitest run src/server/runtime/authoritative-review/migration-service*.test.ts src/server/runtime/authoritative-review/map-review-service.test.ts
npm run check
git add src/server/runtime/authoritative-review
git commit -m "feat: migrate content across map revisions"
```

---

### Task 21: Seal only through the system-owned Gate and assembler

**Files:**

- Create: `src/server/runtime/authoritative-review/system-seal-service.ts`
- Create: `src/server/runtime/authoritative-review/system-seal-service.test.ts`
- Create: `src/server/runtime/authoritative-review/assembler-registry.ts`
- Create: `src/server/runtime/authoritative-review/assembler-registry.test.ts`
- Create: `src/server/runtime/authoritative-review/builtin-assemblers/zhihu-chapter-v1.ts`
- Create: `src/server/runtime/authoritative-review/builtin-assemblers/zhihu-chapter-v1.test.ts`
- Modify: `src/server/storage/artifact-store.ts`
- Modify: `src/server/storage/artifact-store.test.ts`
- Modify: `src/shared/contracts.ts`
- Modify: `src/shared/api-schemas.ts`
- Modify: `src/server/runtime/authoritative-review/work-item-coordinator.ts`
- Modify: `src/server/runtime/action-committer.ts`
- Modify: `src/server/structured-slots/authoritative-review-profile-v1.json`
- Modify: `src/server/structured-slots/authoritative-review-profile.test.ts`
- Modify: `src/server/structured-slots/authoritative-review-profile-archive.test.ts`
- Modify: `src/server/template/template-loader.test.ts`
- Modify: affected v2 semantic-hash fixtures

**Produces:** Exact Seal Gate, production Zhihu assembler handler + registry identity, seal input/output validator custody, assembler staging, SealValidationBundle, SealRecordV2, one system artifact publish, evidence-preserving failures, and a rotated immutable provisional profile/hash that binds the real assembler rather than the Task 5 test handler.

The production assembler identity is frozen now:

```ts
{
  abi: 'forge-assembler/v2',
  handlerKey: 'builtin.zhihu_chapter_markdown.v1',
  moduleId: 'src/server/runtime/authoritative-review/builtin-assemblers/zhihu-chapter-v1',
  exportName: 'assembleZhihuChapterV1',
  implementationDigest: sha256(canonicalNormalizedSourceAndTransitiveRegistryIdentity),
  budget: { timeoutMs: 5000, maxInputBytes: 67_108_864, maxOutputBytes: 8_388_608 },
  routes: [{ id: 'chapter-markdown', artifactFile: 'chapter.md', mediaType: 'text/markdown' }]
}
```

The digest generator is a checked-in deterministic helper in `assembler-registry.ts`: LF-normalized UTF-8 source bytes plus a sorted canonical list of transitive builtin implementation module IDs/digests, never compiled timestamps or absolute paths. Contract/profile/evidence all bind the resulting digest.

Installing this handler atomically generates a new provisional profile/archive entry and updates loader/capability/hash fixtures. The previous profile must fail to load a Contract naming `builtin.zhihu_chapter_markdown.v1`; no task or template silently substitutes the new registry identity.

- [ ] **Step 1: Add one test per Seal Gate condition**

Create a fully eligible fixture, mutate each of the ten conditions independently, and assert a stable unmet reason with no assembler call. Include same semantic Map/different ref and same content root/different manifest ref.

- [ ] **Step 2: Add system-producer access tests**

Only `system_seal` handler can call v2 artifact prepare/promote. Agent attempts, v1 Seal adapter, and arbitrary system handlers cannot publish a v2 system artifact. V1 Agent artifact publication remains unchanged.

Add exact v2 assembler registry tests: the real `builtin.zhihu_chapter_markdown.v1` registration/digest/output bytes, unknown/multiple handler, digest/module/export/budget/route mismatch, v1 CJS ABI presented as v2, network/clock/random/task-global I/O, invalid/duplicate/path-escaping output names, media/byte limits, nondeterministic output, and input authority mismatch all fail closed. Tests must not replace this handler with a test double.

Assert `SystemArtifactDelivery` has no `artifactVersion` field. Its BlobRef and full PublicationPin exist before lock acquisition; the lock allocates the version only into `artifact_published_v2`, whose exact `deliveryRef` is then the projection/list/read source for that version. Two-instance races and response-loss replay return one delivery ref and one combined-history version without a reservation gap or post-pin blob mutation.

Add a table-driven ArtifactStore authority adapter suite. The shared/public type is exactly `ArtifactVersionV1 | ArtifactVersionV2`: v1 retains required `sourceNodeId`; v2 forbids that field and requires system WorkItem, SealRecord, artifact, custody, template, and delivery refs. Parse old metadata/events unchanged. Allocate versions over the combined ordered `artifact_published | artifact_published_v2` stream, and prove v1 then v2 then v1 produces versions 1/2/3 without collision.

- [ ] **Step 3: Add seal validator branch tests**

- seal-input blocking: no assembler/artifact; retain aggregate/receipt; create system-validator Finding and repair WorkItem;
- seal-output blocking: no publication; retain aggregate/receipt; task terminal `ARTIFACT_VALIDATION_FAILED`;
- infrastructure: retry/fail with aggregate ref;
- clear: two aggregates, warning custody, bundle, record, artifact, delivery successor all in one publish envelope.

- [ ] **Step 4: Add crash/response-loss/single-publication tests**

Crash at staging, after output validation, during append, and after append before response. Stable `sealWorkItemId + artifactRef.digest` must yield one artifact version and delivery.

After each clear publication, assert existing workspace/list/read APIs return the v2 artifact immediately and after reconstructing EventStore/ArtifactStore/CoreService. Exercise staged-directory claim after response loss. Cross-check event file hashes against disk plus the artifact/custody/Seal refs; missing or mismatched event/disk/provenance fails corrupt. Keep annotation v1-only and rerun existing v1 list/read/cross-check cases.

- [ ] **Step 5: Confirm red**

Run:

```bash
npx vitest run src/server/runtime/authoritative-review/system-seal-service.test.ts src/server/storage/artifact-store.test.ts
```

- [ ] **Step 6: Implement the v2 assembler registry, SealRecordV2, and atomic publish handler**

The handler resolves exact authority refs, runs pure Gate, resolves one allowlisted `forge-assembler/v2` module by handler key/implementation digest/module/export, supplies only canonical finalized Map/manifest/template inputs through the isolated evaluator, validates named outputs, uses artifact staging, and commits publication/version allocation through `AuthoritativeAppendFacadeV2` under its fresh-tail cross-process fence. ArtifactStore resolves the exact v1/v2 authority union for list/read/recovery and disk cross-check. V1 assembler execution remains behind the v1 branch.

- [ ] **Step 7: Verify and commit**

Run:

```bash
npx vitest run src/server/runtime/authoritative-review/assembler-registry.test.ts src/server/runtime/authoritative-review/builtin-assemblers/zhihu-chapter-v1.test.ts src/server/runtime/authoritative-review/system-seal-service.test.ts src/server/storage/artifact-store.test.ts src/server/runtime/action-committer.test.ts src/shared/authoritative-review-v2.test.ts
npm run check
git add src/server/runtime src/server/storage/artifact-store* src/server/structured-slots/authoritative-review-profile-v1.json src/server/structured-slots/authoritative-review-profile*.test.ts src/server/template/template-loader.test.ts src/server/template/__fixtures__
git commit -m "feat: seal authoritative reviews through system gate"
```

---

### Task 22: Deliver system artifacts to the generic Submitter

**Files:**

- Create: `src/server/runtime/authoritative-review/system-artifact-delivery.ts`
- Create: `src/server/runtime/authoritative-review/system-artifact-delivery.test.ts`
- Modify: `src/server/runtime/authoritative-review/assignment-runner.ts`
- Modify: `src/server/runtime/task-runner.ts`
- Modify: `src/server/runtime/action-committer.ts`
- Modify: `src/server/storage/artifact-store.ts`
- Modify: `src/shared/contracts.ts`
- Modify: `src/shared/api-schemas.ts`
- Modify: `src/client/components/artifact-drawer.tsx`
- Modify: `src/client/components/artifact-drawer.test.tsx`

**Produces:** SystemArtifactDelivery, generic attempt binding, v2 final reachability, atomic final submission, and system provenance UI.

- [ ] **Step 1: Add delivery/ref validation tests**

Require exact SealRecord/artifact/custody/template/submitter WorkItem refs and target identity. Reject a delivery built from bare digests, stale Seal, wrong submitter, different artifact version, or missing completed System Seal WorkItem.

- [ ] **Step 2: Add generic attempt and reachability tests**

Lease binds delivery ID in GenericAgentAttempt. Submit succeeds only for current delivery and atomically writes final commit + attempt completed + WorkItem completed. Retry/terminal/reclaim carry full delivery/base identity. Human authorization cannot bypass reachability.

- [ ] **Step 3: Confirm red**

Run:

```bash
npx vitest run src/server/runtime/authoritative-review/system-artifact-delivery.test.ts src/client/components/artifact-drawer.test.tsx
```

- [ ] **Step 4: Implement v2 reachability branch and UI provenance**

Agent provenance retains source-node navigation. System provenance shows System Seal WorkItem, SealRecord, template snapshot, artifact/custody refs, and delivery with no fake node link. `ArtifactStore.list/read/crossCheck` consumes the same discriminated authority adapter used by publication; no UI-specific projection may infer a `sourceNodeId` for v2.

- [ ] **Step 5: Verify v1 reachability regression and commit**

Run:

```bash
npx vitest run src/server/runtime/authoritative-review/system-artifact-delivery.test.ts src/server/runtime/action-committer.test.ts src/client/components/artifact-drawer.test.tsx
npm run check
git add src/server/runtime src/server/storage src/shared src/client/components/artifact-drawer*
git commit -m "feat: deliver system sealed artifacts"
```

---

### Task 23: Add snapshot-stable v2 review APIs

**Files:**

- Create: `src/server/api/authoritative-review-routes.ts`
- Create: `src/server/api/authoritative-review-routes.test.ts`
- Create: `src/server/runtime/authoritative-review/projection-service.ts`
- Create: `src/server/runtime/authoritative-review/projection-service.test.ts`
- Create: `src/server/runtime/authoritative-review/projection-service.bench.test.ts`
- Modify: `src/server/api/router.ts`
- Modify: `src/server/core-service.ts`
- Modify: `src/shared/contracts.ts`
- Modify: `src/shared/api-schemas.ts`
- Modify: `src/client/gateway/forge-core-gateway.ts`
- Modify: `src/client/gateway/http-gateway.ts`
- Modify: `src/client/gateway/forge-core-gateway.contract.ts`
- Modify: `src/client/gateway/gateway-contracts.test.ts`
- Modify: `src/client/gateway/http-gateway.test.ts`

**Produces:** All v2 Map/tree/review/Finding/Seal endpoints, fixed snapshots, locate, persistent cursor handling, issues compatibility projection, and versioned answer/delete/reopen mutations with gateway parity.

- [ ] **Step 1: Add route/schema tests for every endpoint**

Test task/protocol/local-owner authorization, exact success/error payload, default/max limit, stable order, query/filter binding, cursor tamper, stale reason, missing key failure, non-recursive tree, relation-disabled/zero state, and no private Grant/receipt leakage. Add exact `DELETE /api/tasks/:taskId` version dispatch/body/result and `POST /api/tasks/:taskId/reopen-failed` schema/principal/policy/result cases; actor/operator always comes from the dependency-injected fixed `task_owner` principal in the first release, never a client field/header. Gateway contract and HTTP tests prove TaskSummary-driven protocol choice, UUID/body reuse after simulated response loss, changed-payload conflict, corrupt-v2 index dispatch, and unchanged v1 no-body delete.

- [ ] **Step 2: Add concurrent-append pagination tests**

Fetch page 1, append review events, restart service, fetch all remaining pages, and prove exactly-once traversal through original `throughSequence`. A fresh page 1 sees the new events.

- [ ] **Step 3: Add locate-beyond-1,000 test**

Create 10,000 siblings/descendants, locate a target after ordinal 9,000, follow each seek cursor, and retrieve it without walking earlier pages or silent truncation.

- [ ] **Step 4: Add API performance/N+1 test**

Instrument blob/index reads for summary/page/slot detail. Enforce bounded read count and RSS independent of full-tree size for a single page.

- [ ] **Step 5: Confirm red**

Run:

```bash
npx vitest run src/server/api/authoritative-review-routes.test.ts src/server/runtime/authoritative-review/projection-service*.test.ts
```

- [ ] **Step 6: Implement projection indexes and routes**

Use fixed projection snapshots/checkpoint indexes and registered cursor keyring. V2 issues route derives current Findings/validator issues; it never maps a Seal boolean to per-slot pass.

- [ ] **Step 7: Implement v2 answer dispatch**

Server loads the task first, then validates old or v2 body. V2 passes question identity/operation to TaskLifecycle; stale answer returns stable 409 code.

- [ ] **Step 8: Implement v2 delete and reopen dispatch**

Add exact shared schemas, `ForgeCoreGateway.deleteTask(taskId, request?)`, `reopenFailedTask(taskId, request)`, HTTP encoders/decoders, routes, CoreService methods, and public errors. Delete selects protocol from the immutable installation task index so a corrupt/detached v2 root never falls into legacy recursive deletion. Reopen uses projected legal recipes and server-derived AuthorityBase/Grant; the UI stores one operation/body per confirmation and only displays recipe choices returned by `FailedTaskRecoverySummaryV2`.

- [ ] **Step 9: Verify and commit**

Run:

```bash
npx vitest run src/server/api src/server/runtime/authoritative-review/projection-service*.test.ts src/client/gateway
npm run check
git add src/server/api src/server/core-service.ts src/server/runtime/authoritative-review/projection-service* src/shared src/client/gateway
git commit -m "feat: expose authoritative review projections"
```

---

### Task 24: Build the v2 read-only review workspace

**Files:**

- Create: `src/client/components/structured-review-drawer.tsx`
- Create: `src/client/components/structured-review-drawer.test.tsx`
- Create: `src/client/components/structured-review/review-overview.tsx`
- Create: `src/client/components/structured-review/virtual-review-tree.tsx`
- Create: `src/client/components/structured-review/relationship-view.tsx`
- Create: `src/client/components/structured-review/review-rounds-view.tsx`
- Create: `src/client/components/structured-review/findings-view.tsx`
- Create: `src/client/components/structured-review/seal-readiness-view.tsx`
- Create: focused tests for the six views
- Modify: `src/client/pages/production-page.tsx`
- Modify: `src/client/pages/production-page.test.tsx`
- Modify: `src/client/styles/app.css`
- Modify: `src/client/components/structured-slot-drawer.test.tsx`

**Produces:** Version-dispatched drawer, six read-only views, lazy virtual tree, relation-disabled state, fact/system distinction, Finding navigation, and Seal custody display.

- [ ] **Step 1: Add version-dispatch and state tests**

V1 workspace still renders the old drawer. V2 renders the new drawer. Test loading/error/empty/retry, candidate vs active Map, Agent fact vs system-effective state, generation readiness, failed state, and system artifact provenance.

- [ ] **Step 2: Add virtual tree/snapshot tests**

Expand/collapse/lazy-load a 10,000-node mocked projection; assert only visible rows render, child pages use one snapshot cursor, locate opens ancestors beyond 1,000, and newer events show a refresh banner without mutating the current traversal.

- [ ] **Step 3: Add relationship and Finding tests**

Disabled/zero displays “本 Map 未使用关系网”. Actual edges show type/direction/enforcement/Map review/content satisfaction. Finding click locates the target and shows owner, Grant, lifecycle, evidence, and stale reason.

- [ ] **Step 4: Add read-only authority tests**

Assert no buttons or gateway calls exist for editing verdict, closing Finding, changing Grant, activating Map, or forcing Seal.

- [ ] **Step 5: Confirm red**

Run:

```bash
npx vitest run src/client/components/structured-review* src/client/pages/production-page.test.tsx
```

- [ ] **Step 6: Implement accessible views and styling**

Use semantic tabs/list/tree roles, keyboard navigation, visible focus, status text beyond color, and responsive split panes. Keep v1 CSS/selectors stable.

- [ ] **Step 7: Verify and commit**

Run:

```bash
npx vitest run src/client/components src/client/pages/production-page.test.tsx
npm run check
npm run build
git add src/client
git commit -m "feat: add authoritative review workspace"
```

---

### Task 25: Migrate the Zhihu source revision and add hermetic v2 acceptance

**Files:**

- Modify: `templates/zhihu-salt-chapter-draft/pipeline.yaml`
- Modify: `templates/zhihu-salt-chapter-draft/slots/contract.yaml`
- Modify: `templates/zhihu-salt-chapter-draft/agents/structure.yaml`
- Modify: `templates/zhihu-salt-chapter-draft/agents/fill.yaml`
- Create: `templates/zhihu-salt-chapter-draft/agents/review.yaml`
- Delete: `templates/zhihu-salt-chapter-draft/agents/seal.yaml`
- Modify: `templates/zhihu-salt-chapter-draft/prompts/structure-system.md`
- Modify: `templates/zhihu-salt-chapter-draft/prompts/fill-system.md`
- Create: `templates/zhihu-salt-chapter-draft/prompts/review-system.md`
- Delete: `templates/zhihu-salt-chapter-draft/prompts/seal-system.md`
- Modify: `templates/zhihu-salt-chapter-draft/prompts/submitter-system.md`
- Delete: `templates/zhihu-salt-chapter-draft/slots/assembler/render.cjs` from the v2 source package (preserved only in archived v1 fixture)
- Use without modification: `src/server/runtime/authoritative-review/builtin-assemblers/zhihu-chapter-v1.ts`
- Add: installed Zhihu builtin validator module and registry identity
- Modify: `src/server/structured-slots/authoritative-review-profile-v1.json`
- Modify: profile/archive/capability tests and v2 loader/hash fixtures
- Modify: `src/server/template/zhihu-salt-chapter-draft-template.test.ts`
- Create: `src/server/template/zhihu-salt-chapter-draft-v2.runtime.acceptance.test.ts`
- Keep: `src/server/template/__fixtures__/zhihu-salt-chapter-v1/` v1 regression fixture

**Produces:** Stable template ID with new v2 snapshot, independent reviewer, optional narrative relations, System Seal producer, and deterministic end-to-end fixture acceptance.

- [ ] **Step 1: Add failing source-package tests**

Assert Contract v2, hash differs from archived v1, maxSlots 10,000 within v2 test profile, batch target 24/soft 64, optional relation policy, reviewer identity/capabilities including Finding verification, no Seal Agent/Route/request tool, system artifact producer, all local skill sections retained, and assembler registration exactly equals production `builtin.zhihu_chapter_markdown.v1` module/export/digest/budget/route. Fail if v2 references `render.cjs` or a test registry entry.

- [ ] **Step 2: Add a scripted full-lifecycle acceptance before changing the package**

The script must cover Map chunks, Map node/actual-relation pre-review, activation, content batches, a rejected slot with content repair, unchanged adjacent slots, re-review/whole observation, system Seal, SystemArtifactDelivery, Submitter final commit, and exact `chapter.md` bytes.

- [ ] **Step 3: Confirm red**

Run:

```bash
npx vitest run src/server/template/zhihu-salt-chapter-draft-template.test.ts src/server/template/zhihu-salt-chapter-draft-v2.runtime.acceptance.test.ts
```

- [ ] **Step 4: Rewrite the template source for v2**

Use meaningful optional narrative relation types (for example sequence/information dependency/state inheritance) without minimum edges. Reviewer prompt must request target-level facts/evidence only and explicitly state that system settlement owns aggregate state.

- [ ] **Step 5: Install deterministic Zhihu validators**

Port the current structural/completeness rules to allowlisted v2 handlers with trigger/phase-specific inputs. Do not load the old template CJS validator under the v2 ABI.

Reference the already-installed Task 21 production assembler identity exactly; do not copy, wrap, replace, or reinterpret `render.cjs`. The archived v1 package is the sole owner of the old CJS assembler. Installing the Zhihu production validators creates the last pre-qualification provisional profile/archive revision and updates the template semantic hash, capability/profile tests, and fixtures in this same task. Task 25's Contract must bind that revision; the preceding profile must reject the new handlers. Hermetic lifecycle acceptance resolves the production registry entries and asserts exact `chapter.md` bytes/digest.

- [ ] **Step 6: Run both archived v1 and new v2 acceptances**

Run:

```bash
npx vitest run src/server/template/zhihu-salt-chapter-draft-template.test.ts src/server/template/zhihu-salt-chapter-draft-v2.runtime.acceptance.test.ts src/server/template/structured-slot-template.acceptance.test.ts
npm run check
npm run build
```

- [ ] **Step 7: Commit**

```bash
git add -A templates/zhihu-salt-chapter-draft src/server/template src/server/runtime/authoritative-review src/server/structured-slots/authoritative-review-profile-v1.json src/server/structured-slots/authoritative-review-profile*.test.ts
git commit -m "feat: migrate zhihu chapter template to authoritative review"
```

---

### Task 26: Close recovery, corruption, and fault-injection matrices

**Files:**

- Create: `src/server/runtime/authoritative-review/recovery.acceptance.test.ts`
- Create: `src/server/runtime/authoritative-review/fault-injection.test.ts`
- Create: `src/server/storage/authoritative-review-genesis-replay.test.ts`
- Modify: `scripts/real-recovery-acceptance.ts`
- Modify: recovery test helpers

**Produces:** Exhaustive persisted-state recovery proof for all atomic boundaries and stable operation replay.

- [ ] **Step 1: Build a table of every atomic envelope from Spec section 9.2**

For every envelope inject crash before blob put, after put/pin, before append, after append, after response loss, and during cleanup. Assert the recovered projection is exactly the pre-commit or post-commit legal state—never half-visible.

- [ ] **Step 2: Exercise lifecycle recovery matrix**

Cover ready-before-lease, leased expiry, retry timer before/after due, budget parked, question open, stop/resume overlays, map/content/review partial ledgers, migration batches, Seal staging, generic Submitter, reopen-failed, and old-epoch late calls.

- [ ] **Step 3: Exercise corruption matrix**

Delete/mutate each formal blob kind, corrupt an event/checkpoint/keyring/append manifest, mismatch ref size/schema/media, and add illegal event transitions. Formal authority corruption must fail closed; disposable checkpoint/manifest corruption must rebuild from genesis.

- [ ] **Step 4: Prove genesis/checkpoint equality after every scenario**

Run an independent no-checkpoint projector and compare state/digest to recovered production projection.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npx vitest run src/server/runtime/authoritative-review/recovery.acceptance.test.ts src/server/runtime/authoritative-review/fault-injection.test.ts src/server/storage/authoritative-review-genesis-replay.test.ts
npm run check
git add src/server scripts/real-recovery-acceptance.ts
git commit -m "test: harden authoritative review recovery"
```

---

### Task 27: Create a clean checkpoint and qualify the complete 10,000-slot lifecycle

**Files:**

- Create: `scripts/benchmark-authoritative-review.ts`
- Create: `scripts/benchmark-authoritative-review.test.ts`
- Create: `scripts/authoritative-review-integrated-benchmark-adapter.ts`
- Create: `scripts/authoritative-review-evidence-schema.ts`
- Create: `scripts/authoritative-review-evidence-schema.test.ts`
- Create: `scripts/verify-authoritative-review.ts`
- Create: `scripts/verify-authoritative-review.test.ts`
- Create: `scripts/authoritative-review-qualification-outputs.ts`
- Create: `scripts/authoritative-review-real-acceptance.ts`
- Create: `scripts/authoritative-review-real-acceptance.test.ts`
- Create: `e2e/authoritative-review-real-provider.spec.ts`
- Create: `docs/evidence/authoritative-review-reference-runner-v1.json`
- Generate: `docs/evidence/authoritative-review-platform-profile-v1.json`
- Generate: `docs/evidence/authoritative-review-release-v1.json`
- Finalize before checkpoint: `src/server/structured-slots/authoritative-review-profile-v1.json` plus archive/loader/hash fixtures
- Modify: `package.json`

**Produces:** Reproducible final v2 profile, source-locked evidence chain, and promotion-only capability tool.

The final profile is generated from the complete installed registry produced by Tasks 14, 21, and 25. It is the only revision marked `qualificationState: final`; generation fails if any Contract handler is absent, any extra test-only handler remains, or the profile/loader semantic hash still names an earlier provisional registry. Finalization happens before the clean qualification checkpoint: generate the final profile, archive entry, and affected v2 template/hash fixtures; run their tests; commit them with the implementation checkpoint. The Step 5 benchmark may update only measured evidence fields that were explicitly excluded from template/runtime profile authority, or otherwise must create a downstream evidence object rather than mutate the frozen final profile bytes. The qualification window never changes the task-bound final profile or template semantic hash.

- [ ] **Step 1: Add evidence-schema and dirty-tree tests**

Freeze runner identity, source digest algorithm, package-lock digest, exact gate IDs, generated-output allowlist, profile cross-field relations, and the acyclic chain `source + final profile -> platform benchmark evidence -> release evidence -> capability`. The final profile never contains a downstream evidence digest.

- [ ] **Step 2: Add integrated benchmark cases**

Measure fresh-process scales through:

- 10,000 Map nodes/chunks/key ledger/candidate;
- optional relations including zero and high fan-out bounded cases;
- default-24 Map review and layered observation;
- 10,000 content generation/manifest/finalizer;
- review assignment/adoption ledgers and Findings;
- Map migration with equivalence/fresh/rewrite/carry-unset mix;
- checkpoint/genesis replay and restart;
- stable cursor traversal/locate after 9,000;
- publication-pin/recursive-GC closure;
- event-count headroom below 999,999;
- peak RSS, disk, page latency, append latency, recovery time.

- [ ] **Step 3: Add qualification orchestration tests**

Only the exact reference runner on a clean source tree plus generated outputs can write a final profile/evidence. A primitive smoke, mock adapter, skipped real gate, or hand-edited capability cannot qualify.

Also finish and unit-test the real acceptance harness and Playwright spec now, before the clean checkpoint. The harness must support `--verify-existing`, isolated ports/data roots, production-capability/provider preflight, critical event-order assertions, browser/API/file reconciliation, restart verification, and source/capability digest capture. Do not run the provider-dependent Case yet, but ensure all deterministic parsing/preflight tests pass.

- [ ] **Step 4: Run disabled-production full gates and create the clean checkpoint commit**

Run:

```bash
npm run check
npm test
npm run build
npm run e2e
npm run verify:structured-slots -- --acceptance-only --capability production
npx tsx scripts/verify-authoritative-review.ts --acceptance-only --capability injected
```

Before these gates, deterministically finalize the complete production-handler profile, archive entry, and v2 loader/template hash fixtures; run the stale-provisional and exact-handler tests. Then run all commands. Expected: all commands PASS; base structured production remains green; v2 production manifest remains disabled and v2 acceptance runs only through explicit injection. Commit every implementation, final task-bound profile/archive, template/hash fixture, test, script, and documentation change while the capability remains disabled:

```bash
git add package.json package-lock.json scripts src templates e2e docs/ARCHITECTURE.md docs/PROJECT-MAP.md docs/IMPLEMENTATION-LOG.md
git commit -m "test: qualify disabled authoritative review runtime"
git status --short
```

Expected: clean tree. The resulting HEAD is the immutable qualification checkpoint; no source/template/test edits are allowed in the generated-evidence window.

- [ ] **Step 5: Run the integrated reference benchmark from the exact checkpoint**

Run:

```bash
npx tsx scripts/benchmark-authoritative-review.ts --mode integrated-qualify --profile src/server/structured-slots/authoritative-review-profile-v1.json --evidence docs/evidence/authoritative-review-platform-profile-v1.json
```

Expected: the benchmark does not mutate the frozen final profile or any source/template/hash fixture. It writes only platform-profile evidence, records the checkpoint HEAD/source/lock/runner identities, verifies the already-frozen final profile has `maxSlots >= 10000` and assignment floor 256/1,024, and records bounded metrics. The platform evidence may reference the final profile digest; the profile never embeds its later evidence digest, avoiding a cycle. Neither node hashes the later release evidence/capability manifest.

- [ ] **Step 6: Run disabled-production qualification and generate release evidence**

Run: `npx tsx scripts/verify-authoritative-review.ts --qualify`

Expected: PASS, exact hermetic gates rerun, production v2 capability still disabled, and release evidence generated. Release evidence binds the Step 4 checkpoint HEAD and source-tree/package-lock digests and does not contain the future capability-manifest digest.

- [ ] **Step 7: Verify the generated-output-only dirty set without committing it**

Run:

```bash
git diff --check
git status --short
npx tsx scripts/verify-authoritative-review.ts --validate-only
```

Expected: only platform/release evidence are dirty/untracked; the final profile is unchanged and already part of the checkpoint. Do not commit evidence yet: promotion must validate it against the unchanged checkpoint HEAD and then add the capability manifest as the downstream node.

---

### Task 28: Promote `authoritative_review_v1` from generated evidence

**Files:**

- Verify unchanged: `src/server/structured-slots/authoritative-review-profile-v1.json`
- Generate: `docs/evidence/authoritative-review-platform-profile-v1.json`
- Generate: `docs/evidence/authoritative-review-release-v1.json`
- Generate/update: `src/server/structured-slots/authoritative-review-capability-v1.json`
- Modify tests only if promotion exposes a proven schema bug; otherwise no source changes

**Produces:** Enabled capability whose profile/evidence/source digests match the qualification commit.

- [ ] **Step 1: Verify clean checkpoint and exact generated-output allowance**

Run:

```bash
git status --short
git rev-parse HEAD
npx tsx scripts/verify-authoritative-review.ts --validate-only
```

Expected: no source/template/profile changes after the qualified checkpoint; before promotion exactly the two evidence files are dirty/untracked, and promotion may add only the capability manifest.

- [ ] **Step 2: Promote through the only legal command**

Run:

```bash
npx tsx scripts/verify-authoritative-review.ts --promote-capability docs/evidence/authoritative-review-release-v1.json
```

Expected: enabled manifest with exact profile/evidence digests; any dirty source or digest mismatch fails.

- [ ] **Step 3: Run production-capability acceptance and full gates**

Run:

```bash
npx tsx scripts/verify-authoritative-review.ts --acceptance-only --capability production
npm run check
npm test
npm run build
npm run e2e
npm run verify:structured-slots -- --acceptance-only --capability production
```

- [ ] **Step 4: Commit promotion**

```bash
git diff --check
git status --short
git add src/server/structured-slots/authoritative-review-profile-v1.json src/server/structured-slots/authoritative-review-capability-v1.json docs/evidence/authoritative-review-platform-profile-v1.json docs/evidence/authoritative-review-release-v1.json
git diff --cached --name-only
git commit -m "feat: enable authoritative review runtime v1"
```

Expected: staged-name audit lists exactly those four generated files. No implementation/template/test or mutable real-Case evidence enters the enable commit.

---

### Task 29: Prove a fresh real Pi + HTTP + browser v2 task

**Files:**

- Use without modification: `scripts/authoritative-review-real-acceptance.ts`
- Use without modification: `e2e/authoritative-review-real-provider.spec.ts`
- Generate: `docs/evidence/authoritative-review-real-case-v1.json`
- Generate: task journal, blobs, SealRecord, artifact, screenshots under the isolated acceptance data root

**Produces:** Browser-visible production-real Case plus persisted event/blob/artifact evidence from the final checkout.

- [ ] **Step 1: Start isolated real services**

Use a fresh temporary data root and non-conflicting API/UI ports. Load the production enabled capabilities and real provider mapping. Confirm health endpoints, template version/hash, and that UI is not serving mock data.

First assert both harness files are tracked, clean, and included in the source digest certified by the enabled capability. Task 29 may create only generated evidence/artifacts; no source or template file may change after promotion.

- [ ] **Step 2: Create a new Zhihu v2 task through HTTP**

Drive a prompt/script that yields at least one Map candidate, Map pre-review, optional/zero relation state, generation, one scoped content rejection/repair, re-review, System Seal, and Submitter final commit. If real model variability does not naturally reject a slot, use a deterministic template input/validator scenario whose expected lifecycle includes a repair; do not mutate the journal by hand.

- [ ] **Step 3: Verify event ordering while the task runs**

Assert from persisted events that MapReviewBundle/activation precede every generation attempt; repair only changes granted slots; whole-tree observation reruns; ReviewBundle precedes Seal; only System Seal publishes the artifact.

- [ ] **Step 4: Verify browser/API/file reconciliation**

Using Playwright, inspect Overview, tree, relationships, review facts, Findings, and Seal. Follow a repaired slot and system artifact provenance. Compare displayed refs/counts to API and resolved blobs. Compare `chapter.md` bytes and digests to SealRecord/ArtifactStore.

- [ ] **Step 5: Restart both services and re-open the task**

Verify cursor/pagination continuity where applicable, identical projected authority, final artifact, event tail, and no duplicated WorkItems/attempts/artifact versions.

- [ ] **Step 6: Write evidence bound to checkout and capability**

Evidence must include commit, source-tree digest, package-lock digest, template snapshot hash, task ID, ports/provider mode, event-tail/critical sequence identities, Map/manifest/review/Seal/artifact refs, file hashes, restart result, browser screenshots, and capability/profile/release digests.

- [ ] **Step 7: Run final verification and commit only generated real-Case evidence**

Run:

```bash
npm run check
npm test
npm run build
npm run e2e
npx tsx scripts/verify-authoritative-review.ts --acceptance-only --capability production
npx tsx scripts/authoritative-review-real-acceptance.ts --verify-existing docs/evidence/authoritative-review-real-case-v1.json
git diff --check
```

Then commit only validated generated evidence; the harness and E2E source were already included in the final qualification checkpoint:

```bash
git add docs/evidence/authoritative-review-real-case-v1.json
git diff --cached --name-only
git commit -m "test: prove authoritative review real case"
```

Expected: the staged-name audit contains only the generated real-Case evidence file. If a harness/source fix is necessary, stop, make and test the source fix, then repeat Tasks 27-29; never keep an enabled capability whose source digest predates the fix.

---

## Final Implementation Self-Review

Before declaring the plan complete, the implementing worker must answer each item with a file/test/evidence reference:

- [ ] Every approved design invariant has at least one implementation owner and one test.
- [ ] No v1 type/hash/event/Route/Seal behavior changed; archived v1 fixture and acceptance pass.
- [ ] Every cross-object v2 field is BlobRefV2 or a verified display alias.
- [ ] Every success, blocking, retry, terminal, crash, and response-loss branch retains validator input/evidence custody.
- [ ] Map/content/migration object graphs are constructible and acyclic.
- [ ] Every Agent write is Grant/attempt/base scoped; reviewer has no aggregate or write authority.
- [ ] Every deterministic successor is atomic with predecessor completion and idempotent by operation key.
- [ ] No path can generate content before Map approval/activation or publish before System Seal.
- [ ] Stop/resume cannot clear human/retry state; stale answers/epochs/bases fail atomically.
- [ ] V2 API pagination survives append/restart/key rotation and reaches beyond 1,000/10,000 without silent truncation.
- [ ] 10k qualification includes the complete lifecycle, not just primitives.
- [ ] Capability promotion was generated from the final source digest and no later source edits invalidated it.
- [ ] A fresh real browser Case, API, event journal, Blob refs, SealRecord, and artifact bytes reconcile after restart.
- [ ] `git status --short` contains no unexplained files and `git diff --check` is clean.
