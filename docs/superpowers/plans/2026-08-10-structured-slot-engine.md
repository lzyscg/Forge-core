# Structured Slot Engine v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变 basic v2 行为与九动作注册表的前提下，实现可由模板选择、可恢复、可审计的结构槽生产模式。

**Architecture:** 新增无存储依赖的 `src/server/structured-slots` 纯领域层；现有 Loader 负责冻结 contract，storage 负责 batch/blob/private state，runtime 负责 Attempt/Grant/Slot Tool/Gate，唯一 ActionCommitter 负责权威提交。structured v3 与 basic v2 在 Runner 分流，Seal 后重新汇入现有 artifact v2 流程。

**Tech Stack:** TypeScript 5.5、Node.js 20、Vitest 2、TypeBox、YAML 2、isolated-vm 6、React 18、现有 append-only 文件存储。

## Global Constraints

- 权威规格是 `docs/2026-08-10-structured-slot-engine-spec.md`；上游系统设计第 25、26 节优先级更高。
- `FORGE_ACTION_NAMES` 必须继续恰好九项；Slot Tool 使用独立、turn-bound registry。
- `productionMode` 缺失必须保持 basic 语义与历史 hash；structured 只以 contract v1 + TurnContract v3 上线。
- 单 case 串行；不得实现 Slot Scheduler、动态实例领取、自动 rebase 或跨 Attempt 草稿续写。
- Slot Schema 使用 `forge-canonical-json/v1`、`forge-safe-regex/v1` 和冻结白名单；未知字段一律 fail closed。
- LayoutGrammar 只允许六种 AST kind，必须静态证明可终止、无歧义并单遍匹配。
- 模型参数面不得出现 task/case/scaffold/draft/grant/agent/revision/path/requestId 等工程身份。
- structure/fill/seal 的权威状态、Agent result、terminal 与 dispatch 必须使用一个 `appendBatch` 全有或全无。
- task 内大对象先 stage/verify/promote，TaskEvent batch 是唯一可见性点。
- Attempt meter 只豁免同 key、同参数的缓存重放；失败/冲突调用、compaction 与 provider session 续接不能绕过计量。
- 总 wall deadline 必须主动 abort provider/sandbox；超限后同 Attempt 不得继续 Slot Tool、dispatch 或 human。
- structured annotation 必须 `required: false`；SealRecord 只证明 create files；task 完成仍只认 `final_submission_accepted`。
- UI 和 REST 首版只读；不得添加人工改槽、拖拽、人工 Merge 或文件反向同步。
- 不添加 production 文学模板；只添加平台中性的 fixture 与离线 acceptance。
- 每个任务先红后绿；每次提交前运行该任务列出的测试与 `npm run check`。

---

## File Structure

| 文件/目录 | 单一职责 |
|---|---|
| `src/shared/structured-slots.ts` | 公开 JSON、issue、verdict、SealRecord、workspace/API 类型 |
| `src/server/structured-slots/canonical-json.ts` | `forge-canonical-json/v1` 编码与 hash |
| `src/server/structured-slots/issues.ts` | code registry、issue 构造、排序、授权过滤 |
| `src/server/structured-slots/slot-schema.ts` | Slot Schema v1 meta-compile 与值校验 |
| `src/server/structured-slots/layout-grammar.ts` | Grammar 编译、终止/歧义证明、实例匹配 |
| `src/server/structured-slots/platform-profile.ts` | versioned hard ceiling 与 budget evaluator |
| `src/server/template/structured-slot-contract.ts` | contract exact 解析、资源 manifest、交叉引用 |
| `src/server/template/structured-pipeline-validator.ts` | v3 capability、dispatch 与 typestate 固定点 |
| `src/server/storage/structured-slot-blob-store.ts` | task-local immutable blob/generation/content roots |
| `src/server/storage/structured-slot-private-store.ts` | Proposal/Draft/Attempt journal 与 checkpoint |
| `src/server/storage/structured-slot-state.ts` | 从 TaskEvent + blob 投影 active scaffold 状态 |
| `src/server/runtime/structured-slot/validation-engine.ts` | Structure/Merge/Seal Gate 与聚合预算 |
| `src/server/runtime/structured-slot/evaluator-runner.ts` | validator/Assembler 纯函数沙箱 ABI |
| `src/server/runtime/structured-slot/grant-service.ts` | selector、可见投影与判别 Grant |
| `src/server/runtime/structured-slot/attempt-coordinator.ts` | epoch、meter、deadline、terminal CAS |
| `src/server/runtime/structured-slot/proposal-service.ts` | Proposal 工具与 structure candidate |
| `src/server/runtime/structured-slot/draft-service.ts` | Draft overlay、Merge Gate 与 merge candidate |
| `src/server/runtime/structured-slot/session-service.ts` | session 状态、receipt、Forge dispatch guard |
| `src/server/runtime/structured-slot/tool-factory.ts` | 按 kind 暴露 Slot Tool definition |
| `src/server/runtime/structured-slot/structured-committer.ts` | structure/fill/rework/Seal 的 batch 计划 |
| `src/server/api/structured-slot-routes.ts` | 只读 contract/tree/slot/issues/seal REST |
| `src/client/components/structured-slot-drawer.tsx` | 只读槽树与详情 UI |

依赖顺序：

```text
1 contracts/canonical/issues
  ├─> 2 Slot Schema ─┐
  └─> 3 Grammar ─────┼─> 4 contract loader ─> 5 v3 typestate
6 Event batch ─> 7 structured storage ─┐
2+3+7 ─> 8 evaluator/Gate ─> 9 profile benchmark
4+5+7 ─> 10 Grant/projection ─> 11 Attempt coordinator
8+10+11 ─> 12 Structure ─> 13 Fill ─> 14 Pi session integration
6+7+12+13+14 ─> 15 structured commit
8+15 ─> 16 Seal custody
11+15+16 ─> 17 scheduler/recovery/human
7+10+17 ─> 18 API/UI
全部 ─> 19 acceptance/backward-compatibility
```

---

### Task 1: Public Contracts, Canonical JSON, and Issue Registry

**Files:**

- Create: `src/shared/structured-slots.ts`
- Create: `src/server/structured-slots/canonical-json.ts`
- Create: `src/server/structured-slots/canonical-json.test.ts`
- Create: `src/server/structured-slots/issues.ts`
- Create: `src/server/structured-slots/issues.test.ts`
- Modify: `src/shared/contracts.ts`

**Interfaces:**

- Produces: `JsonValue`, `JsonObject`, `StructuredIssueV1`, `StructuredVerdictV1`, `IssueLocation`, `StructuredBlobRefV1`, `SealRecord`, `StructuredSlotsSummaryV1`.
- Produces: `canonicalJson(value: unknown): string`, `canonicalJsonBytes(value: unknown): Buffer`, `canonicalJsonSha256(value: unknown): string`.
- Produces: `makeStructuredIssue(code, phase, location, details)` and `projectStructuredVerdict(verdict, visibility)`.

- [ ] **Step 1: Write failing canonical JSON vectors**

```ts
it('sorts object keys by JCS UTF-16 order and normalizes negative zero', () => {
  expect(canonicalJson({ z: -0, a: 'é' })).toBe('{"a":"é","z":0}');
});

it('rejects lone surrogates and non-finite numbers', () => {
  expect(() => canonicalJson('\ud800')).toThrow('CANONICAL_JSON_INVALID');
  expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow('CANONICAL_JSON_INVALID');
});
```

- [ ] **Step 2: Run the new tests and confirm red**

Run: `npx vitest run src/server/structured-slots/canonical-json.test.ts src/server/structured-slots/issues.test.ts`

Expected: FAIL because both modules are missing.

- [ ] **Step 3: Add exact shared discriminated unions**

```ts
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export interface StructuredVerdictV1 {
  version: 1;
  status: 'passed' | 'failed' | 'incomplete';
  issues: StructuredIssueV1[];
  truncated: boolean;
  summary: { errors: number; warnings: number };
}
```

Copy the eight phases, ten sources, six location variants and SealRecord fields verbatim from the spec; use exact object types with no index signature except `JsonObject`.

- [ ] **Step 4: Implement deterministic canonical encoding and hashing**

Use recursive plain-object validation, JCS key comparison, JSON shortest-number serialization, `-0 -> 0`, UTF-8 output, cycle detection and lone-surrogate rejection. Export only the three functions listed above.

- [ ] **Step 5: Implement the closed issue registry**

```ts
export const STRUCTURED_ISSUE_REGISTRY = {
  CONTENT_SCHEMA_INVALID: {
    source: 'slot_schema',
    phases: ['draft', 'merge', 'seal_input'],
    severity: 'error',
    locations: ['proposal', 'slot'],
  },
  VALIDATOR_ADVISORY: {
    source: 'validator',
    phases: ['merge', 'seal_input'],
    severity: 'warning',
    locations: ['slot', 'operation'],
  },
} as const;
```

Populate every code from spec §10/F03; constructors must reject unregistered code/phase/location combinations. Filter hidden related locations first; suppress or remap a hidden primary to an operation-safe code before stable sort and truncation.

- [ ] **Step 6: Run domain tests and typecheck**

Run: `npx vitest run src/server/structured-slots/canonical-json.test.ts src/server/structured-slots/issues.test.ts && npm run check`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/shared/contracts.ts src/shared/structured-slots.ts src/server/structured-slots
git commit -m "feat: add structured slot domain contracts"
```

---

### Task 2: Slot Schema v1 Compiler and Validator

**Files:**

- Create: `src/server/structured-slots/slot-schema.ts`
- Create: `src/server/structured-slots/slot-schema.test.ts`

**Interfaces:**

- Consumes: Task 1 canonical JSON and issue constructors.
- Produces: `compileSlotSchemaV1(raw, limits): CompiledSlotSchemaV1`.
- Produces: `validateSlotValue(compiled, value, location, phase): StructuredIssueV1[]`.

- [ ] **Step 1: Add failing meta-schema tests**

```ts
it.each(['multipleOf', 'oneOf', '$ref', 'default'])('rejects %s', (keyword) => {
  expect(() => compileSlotSchemaV1({ type: 'number', [keyword]: 1 }, limits))
    .toThrow('SPEC_SCHEMA_INVALID');
});

it('requires explicit object additionalProperties', () => {
  expect(() => compileSlotSchemaV1({ type: 'object', properties: {} }, limits))
    .toThrow('SPEC_SCHEMA_INVALID');
});
```

- [ ] **Step 2: Add failing runtime-value tests**

Cover Unicode code-point length, finite/safe integer, object property closure, array uniqueItems by canonical hash, enum type sensitivity, substring pattern semantics and no input mutation.

- [ ] **Step 3: Run the focused test and confirm red**

Run: `npx vitest run src/server/structured-slots/slot-schema.test.ts`

Expected: FAIL because `compileSlotSchemaV1` is missing.

- [ ] **Step 4: Implement exact keyword dispatch**

```ts
const KEYWORDS_BY_TYPE = {
  string: new Set(['type', 'description', 'enum', 'const', 'minLength', 'maxLength', 'pattern']),
  number: new Set(['type', 'description', 'enum', 'const', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']),
  integer: new Set(['type', 'description', 'enum', 'const', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']),
  object: new Set(['type', 'description', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'minProperties', 'maxProperties']),
  array: new Set(['type', 'description', 'enum', 'const', 'items', 'minItems', 'maxItems', 'uniqueItems']),
  boolean: new Set(['type', 'description', 'enum', 'const']),
  null: new Set(['type', 'description', 'enum', 'const']),
} as const;
```

Compile safe regex at load time; count schema depth/nodes/enum/pattern against injected limits. Return an immutable compiled tree.

- [ ] **Step 5: Implement pure value validation**

Traverse without modifying the value. Sort issues by schema pointer, instance pointer, keyword and code. Enforce UTF-8 payload limits separately from keyword code-point lengths.

- [ ] **Step 6: Run test, check, and commit**

Run: `npx vitest run src/server/structured-slots/slot-schema.test.ts && npm run check`

```bash
git add src/server/structured-slots/slot-schema.ts src/server/structured-slots/slot-schema.test.ts
git commit -m "feat: implement slot schema v1"
```

---

### Task 3: Deterministic LayoutGrammar Compiler

**Files:**

- Create: `src/server/structured-slots/layout-grammar.ts`
- Create: `src/server/structured-slots/layout-grammar.test.ts`

**Interfaces:**

- Consumes: Task 1 issue types.
- Produces: `compileLayoutGrammarV1(grammar, typeIds, limits): CompiledLayoutGrammarV1`.
- Produces: `matchProduction(compiled, parentTypeId, childTypeIds, locations): StructuredIssueV1[]`.

- [ ] **Step 1: Write red tests for all six AST kinds and references**

Use a document grammar containing sequence/slot/optional/repeat/choice plus an explicit empty leaf. Assert exact normalized AST and max-consumption count.

- [ ] **Step 2: Write red termination and ambiguity tests**

```ts
it('rejects a mandatory recursion without a finite exit', () => {
  expect(() => compileLayoutGrammarV1(nonTerminating, typeIds, limits))
    .toThrow('LAYOUT_GRAMMAR_NON_TERMINATING');
});

it('rejects optional FIRST/FOLLOW overlap', () => {
  expect(() => compileLayoutGrammarV1(optionalThenSameType, typeIds, limits))
    .toThrow('LAYOUT_GRAMMAR_OPTIONAL_FOLLOW_CONFLICT');
});
```

Also cover nullable repeat, choice FIRST overlap, repeat FOLLOW overlap, unreachable production and recursive grammar with a finite exit.

- [ ] **Step 3: Run and confirm red**

Run: `npx vitest run src/server/structured-slots/layout-grammar.test.ts`

- [ ] **Step 4: Implement fixed-point analyses**

Compute `nullable`, `minConsumption`, `maxConsumption`, `first`, `follow` and `generatable` to convergence over a finite type set. Reject `empty` unless it is the whole production and reject repeat item when nullable.

- [ ] **Step 5: Implement the non-backtracking matcher**

At choice/optional/repeat boundaries select only from the next type or EOF; never inspect a farther child or prefer declaration order. Emit one bounded `STRUCTURE_PRODUCTION_MISMATCH` at the first failure location.

- [ ] **Step 6: Run test, check, and commit**

Run: `npx vitest run src/server/structured-slots/layout-grammar.test.ts && npm run check`

```bash
git add src/server/structured-slots/layout-grammar.ts src/server/structured-slots/layout-grammar.test.ts
git commit -m "feat: compile deterministic layout grammar"
```

---

### Task 4: Structured Contract Loader and Snapshot Hashing

**Files:**

- Create: `src/server/template/structured-slot-contract.ts`
- Create: `src/server/template/structured-slot-contract.test.ts`
- Create: `src/server/template/__fixtures__/structured-valid/slots/contract.yaml`
- Create: `src/server/template/__fixtures__/structured-valid/slots/validators/validate.js`
- Create: `src/server/template/__fixtures__/structured-valid/slots/assembler/render.js`
- Modify: `src/server/template/template-schema.ts`
- Modify: `src/server/template/template-validator.ts`
- Modify: `src/server/template/template-loader.ts`
- Modify: `src/server/template/template-cache.ts`
- Modify: `src/server/template/template-loader.test.ts`

**Interfaces:**

- Consumes: Tasks 1–3.
- Produces: `FrozenStructuredSlotContractV1` and `loadStructuredSlotContract(templateRoot, profile)`.
- Extends: `FrozenTemplate.productionMode` and `FrozenTemplate.structuredSlots` with historical defaults.

- [ ] **Step 1: Add a platform-neutral valid contract fixture subtree**

Use `document`, `title`, and `body` slot types; one static access profile; one validator; one Assembler route. Keep all fixture content generic and declare all 28 limits.

- [ ] **Step 2: Write red exact-schema and containment tests**

Cover missing/extra top-level fields, duplicate IDs, unreferenced resource, symlink, `../`, backslash, wrong directory, wrong ABI, missing budget, required annotation and multiple create producers.

- [ ] **Step 3: Write red hash compatibility tests**

Assert existing basic fixture hashes remain byte-for-byte unchanged when `productionMode` is absent. Assert changing contract semantics, validator bytes or Assembler bytes changes the structured hash; changing mtime or absolute root does not.

- [ ] **Step 4: Run focused loader tests and confirm red**

Run: `npx vitest run src/server/template/structured-slot-contract.test.ts src/server/template/template-loader.test.ts`

- [ ] **Step 5: Implement contract normalization**

Parse exact SlotType, AccessProfile, validator, Assembler and limits shapes. Call Tasks 2–3 compilers. Build a sorted resource manifest `{logicalPath, sha256, byteLength}` and include ABI/profile identity in the frozen object.

- [ ] **Step 6: Integrate mode-aware load/cache behavior**

Keep canonical source omission for old basic templates. Reject basic + `slots/`, structured without contract and unknown productionMode. Historical cache/snapshot manifests without new fields normalize to basic/null only after their original hash is verified.

- [ ] **Step 7: Run loader/cache regression and commit**

Run: `npx vitest run src/server/template/structured-slot-contract.test.ts src/server/template/template-loader.test.ts src/server/template/template-catalog.test.ts && npm run check`

```bash
git add src/server/template src/server/template/__fixtures__/structured-valid
git commit -m "feat: load structured slot contracts"
```

---

### Task 5: TurnContract v3 and Pipeline Typestate

**Files:**

- Create: `src/server/template/structured-pipeline-validator.ts`
- Create: `src/server/template/structured-pipeline-validator.test.ts`
- Modify: `src/server/template/template-schema.ts`
- Modify: `src/server/template/template-validator.ts`
- Modify: `src/server/template/template-loader.ts`
- Create: `src/server/template/__fixtures__/structured-valid/template.yaml`
- Create: `src/server/template/__fixtures__/structured-valid/pipeline.yaml`
- Create: `src/server/template/__fixtures__/structured-valid/agents/structure.yaml`
- Create: `src/server/template/__fixtures__/structured-valid/agents/fill.yaml`
- Create: `src/server/template/__fixtures__/structured-valid/agents/seal.yaml`
- Create: `src/server/template/__fixtures__/structured-valid/agents/submitter.yaml`

**Interfaces:**

- Produces: `BasicTurnContractV1 | BasicTurnContractV2 | StructuredTurnContractV3` union.
- Produces: `validateStructuredPipeline(frozen): Map<agentId, ReadonlySet<ScaffoldPhase>>`.

- [ ] **Step 1: Write red capability matrix tests**

Assert structure without read/write/submit, fill without read-spec/read-content/write/submit, or seal without request-seal fails. Assert capabilities outside the kind allowlist and above Agent `slotCapabilities` fail.

- [ ] **Step 2: Write red dispatch matrix tests**

Assert structure/fill cannot publish, seal must have send plus publish/final, rework send targets only v3 fill/structure, v2 post-Seal cannot production or send back to v3.

- [ ] **Step 3: Write red typestate graph tests**

Cover fill/seal as first node, a route that bypasses structure, an invalid join, v2 before Seal, Seal rework staying active_unsealed and sealed backedge.

- [ ] **Step 4: Implement the v3 discriminated union parser**

Normalize only declared keys; structure requires `accessProfile: null`, fill/seal require a known profile. Preserve v1/v2 historical members unchanged.

- [ ] **Step 5: Implement three-state fixed-point propagation**

Start the sole initial agent with `no_scaffold`; propagate success and rework edges separately. Reject an edge when any incoming phase is outside the target precondition. Store the compiled phase contract in the snapshot.

- [ ] **Step 6: Run all template tests and commit**

Run: `npx vitest run src/server/template && npm run check`

```bash
git add src/server/template
git commit -m "feat: validate structured turn contracts"
```

---

### Task 6: Atomic TaskEvent Batches and Structured Event Union

**Files:**

- Modify: `src/server/storage/core-paths.ts`
- Modify: `src/server/storage/core-paths.test.ts`
- Modify: `src/server/storage/task-events.ts`
- Modify: `src/server/storage/task-events.test.ts`
- Modify: `src/server/storage/event-store.ts`
- Modify: `src/server/storage/event-store.test.ts`

**Interfaces:**

- Produces: structured events from spec §7.4.
- Produces: `EventStore.appendBatch(taskId, commitId, events, { expectedLastSequence })`.
- Preserves: `EventStore.append()` and legacy event filename behavior for basic v2.

- [ ] **Step 1: Add exact structured event validation tests**

Create one valid value for every new union member. For each member, remove one required field and add one unknown field; both must reject before disk write.

- [ ] **Step 2: Add mixed legacy/batch read tests**

Commit two legacy events, one three-event batch and one legacy event. Assert flattened logical sequences are `[1,2,3,4,5,6]` and projector consumers see no envelope.

- [ ] **Step 3: Add CAS, replay, conflict, and crash tests**

```ts
await expect(store.appendBatch(taskId, 'commit-a', events, { expectedLastSequence: 0 }))
  .resolves.toHaveLength(events.length);
await expect(store.appendBatch(taskId, 'commit-a', events, { expectedLastSequence: 0 }))
  .resolves.toEqual(firstResult);
await expect(store.appendBatch(taskId, 'commit-a', changed, { expectedLastSequence: 0 }))
  .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
```

Inject failure before atomic rename and assert no member is readable; after rename assert every member is readable.

- [ ] **Step 4: Implement batch filename/envelope parsing**

Use `<first>-<last>-<commitId>.batch.json`. Validate safe commitId, exact envelope fields, SHA-256 of canonical events and `eventCount === last-first+1`.

- [ ] **Step 5: Implement appendBatch under the existing task queue**

Inside the mutex, scan and validate first; replay existing commit before checking current tail; otherwise enforce expectedLastSequence, allocate contiguous logical sequences and write one file with `writeNewAtomic`.

- [ ] **Step 6: Run storage regression and commit**

Run: `npx vitest run src/server/storage/core-paths.test.ts src/server/storage/task-events.test.ts src/server/storage/event-store.test.ts && npm run check`

```bash
git add src/server/storage/core-paths.ts src/server/storage/core-paths.test.ts src/server/storage/task-events.ts src/server/storage/task-events.test.ts src/server/storage/event-store.ts src/server/storage/event-store.test.ts
git commit -m "feat: add atomic task event batches"
```

---

### Task 7: Structured Blob, Generation, Draft, and Attempt Storage

**Files:**

- Modify: `src/server/storage/core-paths.ts`
- Modify: `src/server/storage/task-store.ts`
- Create: `src/server/storage/structured-slot-blob-store.ts`
- Create: `src/server/storage/structured-slot-blob-store.test.ts`
- Create: `src/server/storage/structured-slot-private-store.ts`
- Create: `src/server/storage/structured-slot-private-store.test.ts`
- Create: `src/server/storage/structured-slot-state.ts`
- Create: `src/server/storage/structured-slot-state.test.ts`

**Interfaces:**

- Produces: `putGeneration`, `readSlot`, `putContentRevision`, `readEffectiveContent`, `putJsonBlob`.
- Produces: `open/replace/lock/terminal` methods for Proposal and Draft, plus persistent Attempt meter snapshots.
- Produces: `projectStructuredSlotState(events): StructuredSlotState`.

- [ ] **Step 1: Write red content-address and corruption tests**

Assert equal canonical bytes reuse one digest; changed bytes get a new digest; a file whose bytes do not match its path hash returns `TASK_CORRUPTED`.

- [ ] **Step 2: Write red indexed generation tests**

Create 10,000 slot records, read one tail slot, and instrument the record reader to assert it reads one byte range rather than parsing every NDJSON line. Verify parent/order/type/document-order indexes.

- [ ] **Step 3: Write red journal/checkpoint lifecycle tests**

Assert Proposal/Draft open is idempotent by turnId, post-lock writes reject, terminal objects are read-only, checkpoint + tail journal rebuild the same state and task delete removes all structured directories.

- [ ] **Step 4: Implement immutable blob and generation storage**

Write temp bytes, fsync/verify digest, rename to task-local final path. Generation manifest references `slots.ndjson` and an index containing byte offsets; cache only the index, never the full slot file.

- [ ] **Step 5: Implement content-root and private stores**

Store content values as separate canonical blobs and rewrite only the `slotId -> presence/digest` root per revision. Journal every private operation with tool signature/result; checkpoint after 128 operations or 1 MiB of journal bytes, whichever occurs first.

- [ ] **Step 6: Implement event-derived structured state**

Fold active generation, revision, Draft lifecycle and Seal status only from validated TaskEvents and referenced blobs. A checkpoint never overrides event history.

- [ ] **Step 7: Run storage tests and commit**

Run: `npx vitest run src/server/storage/structured-slot-blob-store.test.ts src/server/storage/structured-slot-private-store.test.ts src/server/storage/structured-slot-state.test.ts && npm run check`

```bash
git add src/server/storage
git commit -m "feat: persist structured slot state"
```

---

### Task 8: Validator and Assembler Sandbox Engine

**Files:**

- Create: `src/server/runtime/structured-slot/evaluator-runner.ts`
- Create: `src/server/runtime/structured-slot/evaluator-runner.test.ts`
- Create: `src/server/runtime/structured-slot/validation-engine.ts`
- Create: `src/server/runtime/structured-slot/validation-engine.test.ts`
- Modify: `src/server/runtime/gate-runner.ts`
- Modify: `src/server/runtime/gate-runner.test.ts`

**Interfaces:**

- Produces: `runValidator(registration, canonicalInput, signal): EvaluatorResult`.
- Produces: `runAssembler(registration, canonicalInput, signal): AssemblerFileResult[]`.
- Produces: `runStructureGate`, `runMergeGate`, `runSealGate` with per-Gate usage.

- [ ] **Step 1: Add ABI conformance and escape tests**

Test valid pass/reject, syntax error, throw, infinite loop, memory/output overrun, invalid return, `require`, FS/network/process/Date/random access and nondeterministic double-run mismatch.

- [ ] **Step 2: Add enforcement and aggregate tests**

Assert blocking false -> error/failed, advisory false -> warning/passed, either runtime failure -> incomplete. Assert preflight overflow executes zero validators; runtime output/issues/wall overflow stops remaining validators.

- [ ] **Step 3: Run focused tests and confirm red**

Run: `npx vitest run src/server/runtime/structured-slot/evaluator-runner.test.ts src/server/runtime/structured-slot/validation-engine.test.ts`

- [ ] **Step 4: Implement a shared isolated-vm primitive**

Refactor only sandbox creation/call mechanics from the existing GateRunner; keep its public behavior and tests unchanged. For structured ABI, freeze globals, remove nondeterministic APIs, stream/measure serialized result bytes before full normalization, and dispose a timed-out isolate.

- [ ] **Step 5: Implement deterministic target expansion and Gate accounting**

Resolve `(validatorId, logicalTarget)` in stable order, preflight declared CPU/invocation totals, execute serially, adapt narrow issues through Task 1 registry and return `{verdict, usage}`. Seal always evaluates all applicable registrations.

- [ ] **Step 6: Implement Assembler result validation**

Require unique declared route IDs, UTF-8 strings, exact required create coverage, no extra route and artifact byte limits. Return no platform path or media fields from the sandbox.

- [ ] **Step 7: Run sandbox regression and commit**

Run: `npx vitest run src/server/runtime/gate-runner.test.ts src/server/runtime/structured-slot && npm run check`

```bash
git add src/server/runtime/gate-runner.ts src/server/runtime/gate-runner.test.ts src/server/runtime/structured-slot
git commit -m "feat: run structured slot evaluators"
```

---

### Task 9: Benchmark and Freeze Platform Profile v1

**Files:**

- Create: `src/server/structured-slots/platform-profile.ts`
- Create: `src/server/structured-slots/platform-profile.test.ts`
- Create: `scripts/benchmark-structured-slots.ts`
- Create: `docs/evidence/structured-slot-platform-profile-v1.json`
- Modify: `package.json`

**Interfaces:**

- Produces: `STRUCTURED_SLOT_PLATFORM_PROFILE_V1` and `assertTemplateLimitsWithinProfile`.
- Produces script: `npm run benchmark:structured-slots`.

- [ ] **Step 1: Encode the design candidate profile as benchmark input**

```ts
export const STRUCTURED_SLOT_PROFILE_CANDIDATE = {
  schema: { maxSchemaDepth: 16, maxSchemaNodes: 4096, maxEnumItems: 256, maxPatternLength: 512 },
  structure: { maxSlots: 10_000, maxTreeDepth: 32, maxChildrenPerSlot: 1_000 },
  payload: { maxSpecBytesPerSlot: 65_536, maxContentBytesPerSlot: 1_048_576, maxScaffoldPayloadBytes: 67_108_864 },
  draft: { maxChangedSlots: 2_000, maxDraftBytes: 16_777_216 },
  attempt: { maxSlotToolCallsPerAttempt: 512, maxValidationRunsPerAttempt: 16, maxValidatorInvocationsPerAttempt: 40_000, maxAggregateValidatorCpuMsPerAttempt: 240_000, maxAggregateValidatorWallClockMsPerAttempt: 480_000, maxValidatorOutputBytesPerAttempt: 16_777_216, maxAttemptWallClockMs: 600_000 },
  validation: { maxValidators: 64, maxValidatorInvocationsPerGate: 10_000, maxAggregateValidatorCpuMsPerGate: 60_000, maxAggregateValidatorWallClockMsPerGate: 120_000, maxValidatorOutputBytesPerGate: 4_194_304, maxIssuesPerRun: 500 },
  output: { maxArtifactFiles: 64, maxArtifactBytesPerFile: 16_777_216, maxTotalArtifactBytes: 67_108_864 },
} as const;
```

- [ ] **Step 2: Add cross-field rejection tests**

Attempt values must be >= per-Gate counterparts; validation runs <= tool calls; Attempt wall >= Attempt validator wall; changed slots <= max slots; per-file <= total output.

- [ ] **Step 3: Implement benchmark cases**

Measure worst Schema/Grammar compile, 10k tree match and indexed single-slot read, 64 MiB content root, 2k-change Draft, 10k validator fanout, 500 issue projection, 64 MiB Seal/Assembler and batch recovery. Emit machine-readable p50/p95/max/RSS/disk bytes.

- [ ] **Step 4: Run the benchmark and select the checked-in profile**

Run: `npm run benchmark:structured-slots -- --write docs/evidence/structured-slot-platform-profile-v1.json`

Acceptance: indexed slot p95 <= 25 ms; 10k tree match <= 2 s; content-root and Draft operations <= 2 s; 500 issue projection <= 250 ms; 64 MiB Seal <= 30 s excluding deliberately budgeted validators; peak RSS <= 512 MiB; no case exceeds its declared wall/output bound. If a 100% candidate axis fails, rerun at 75%, 50%, then 25% and freeze the greatest passing value for that axis; never raise a design candidate.

- [ ] **Step 5: Gate production structured loading on the frozen profile**

`STRUCTURED_SLOT_PLATFORM_PROFILE_V1` must be the values recorded in evidence, carry identity `forge-structured-runtime/v1`, and be the only default used by production Loader. Unit tests may inject smaller profiles.

- [ ] **Step 6: Run profile tests and commit evidence**

Run: `npx vitest run src/server/structured-slots/platform-profile.test.ts && npm run check`

```bash
git add package.json scripts/benchmark-structured-slots.ts src/server/structured-slots/platform-profile.ts src/server/structured-slots/platform-profile.test.ts docs/evidence/structured-slot-platform-profile-v1.json
git commit -m "perf: freeze structured slot profile v1"
```

---

### Task 10: Selector Resolution, Authorized Projection, and Grants

**Files:**

- Create: `src/server/runtime/structured-slot/grant-service.ts`
- Create: `src/server/runtime/structured-slot/grant-service.test.ts`
- Create: `src/server/runtime/structured-slot/projection-service.ts`
- Create: `src/server/runtime/structured-slot/projection-service.test.ts`

**Interfaces:**

- Consumes: Frozen contract and Task 7 state/store.
- Produces: `resolveStructureGrant`, `resolveFillGrant`, `resolveSealGrant`.
- Produces: `listSlots(grant, cursor, limit)` and `readSlot(grant, slotId, overlay)`.

- [ ] **Step 1: Write selector and document-order tests**

Cover all/root/types, rule union, bounded ancestors/descendants/direct siblings, depth-first pre-order and precedingFilled over multiple writable targets.

- [ ] **Step 2: Write non-disclosure tests**

Assert missing and hidden slot return identical `SLOT_NOT_VISIBLE`; a mixed visible/hidden batch returns zero rows; ancestor shell has no spec/content/child count; pagination reveals no hidden totals.

- [ ] **Step 3: Write Grant lifecycle tests**

Assert wrong task/turn/agent/kind/snapshot/generation/revision/draft rejects. Assert structure Grant has no scaffold fields and seal Grant has empty writable IDs.

- [ ] **Step 4: Implement stable selector resolution**

Resolve static targets from generation indexes, add read context, then add precedingFilled only when read-content capability exists. Sort and de-duplicate by document order.

- [ ] **Step 5: Implement signed internal Grant objects and cursors**

Use platform-generated IDs stored server-side; tool context holds the object, model only sees projections. Cursor payload includes generationId, revision, projection hash, last document-order key and ordering version; sign with a task-local random secret not written to snapshot/events.

- [ ] **Step 6: Run tests and commit**

Run: `npx vitest run src/server/runtime/structured-slot/grant-service.test.ts src/server/runtime/structured-slot/projection-service.test.ts && npm run check`

```bash
git add src/server/runtime/structured-slot/grant-service.ts src/server/runtime/structured-slot/grant-service.test.ts src/server/runtime/structured-slot/projection-service.ts src/server/runtime/structured-slot/projection-service.test.ts
git commit -m "feat: resolve structured slot grants"
```

---

### Task 11: Attempt Coordinator, Resource Meter, and Deadline

**Files:**

- Create: `src/server/runtime/structured-slot/attempt-coordinator.ts`
- Create: `src/server/runtime/structured-slot/attempt-coordinator.test.ts`
- Create: `src/server/runtime/structured-slot/attempt-meter.ts`
- Create: `src/server/runtime/structured-slot/attempt-meter.test.ts`
- Modify: `src/server/runtime/agent-runtime.ts`

**Interfaces:**

- Produces: `startAttempt`, `terminalize`, `recoverDanglingAttempts`, `activeAttemptForInput`.
- Produces: `AttemptMeter.chargeTool`, `reserveValidation`, `recordValidationUsage`, `signal`.
- Extends: `AgentTurnInput.slotSession` with an internal session handle and deadline signal; basic uses null.

- [ ] **Step 1: Add epoch/CAS race tests**

Start two concurrent attempts for one input; only one epoch 1 batch wins. Terminalize completion and stop concurrently; exactly one terminal exists and loser returns the committed terminal.

- [ ] **Step 2: Add meter signature tests**

Charge exact replay once, same toolCallId with changed args twice, invalid/unauthorized calls once each and a different toolCallId once. Assert the next call beyond the exact max closes the Attempt.

- [ ] **Step 3: Add active deadline tests with a fake monotonic clock**

Advance through provider wait without any tool call; deadline must abort the signal and append `RESOURCE_LIMIT_EXCEEDED + failed/runtime_failure`. Simulate compaction/session continuation and assert meter values remain.

- [ ] **Step 4: Implement deterministic epoch allocation**

Read the logical event tail, derive `maxEpoch(inputNodeId)+1`, derive a safe turnId from inputNodeId+epoch and append the started event with expectedLastSequence. Retry only the CAS read/append loop.

- [ ] **Step 5: Implement persistent meter and composite abort**

Persist signature/result records and cumulative usage in Task 7 Attempt store. Use one AbortController for deadline/resource closure and combine it with scheduler stop signal. A terminal state makes every charge return the same terminal failure.

- [ ] **Step 6: Implement terminal batches and dangling recovery**

Validate the six legal status/reason pairs, abandon private state through callbacks, append terminal with caller-supplied companion events and expected tail. Recovery closes every started-without-terminal as crash_recovery before task resume.

- [ ] **Step 7: Run tests and commit**

Run: `npx vitest run src/server/runtime/structured-slot/attempt-meter.test.ts src/server/runtime/structured-slot/attempt-coordinator.test.ts && npm run check`

```bash
git add src/server/runtime/agent-runtime.ts src/server/runtime/structured-slot/attempt-coordinator.ts src/server/runtime/structured-slot/attempt-coordinator.test.ts src/server/runtime/structured-slot/attempt-meter.ts src/server/runtime/structured-slot/attempt-meter.test.ts
git commit -m "feat: coordinate structured attempts"
```

---

### Task 12: StructureProposal Session and Tools

**Files:**

- Create: `src/server/runtime/structured-slot/proposal-service.ts`
- Create: `src/server/runtime/structured-slot/proposal-service.test.ts`
- Create: `src/server/runtime/structured-slot/session-service.ts`
- Create: `src/server/runtime/structured-slot/session-service.test.ts`

**Interfaces:**

- Produces structure operations: `getContract`, `putProposal`, `getProposal`, `validateProposal`, `submitProposal`.
- Produces `StructureCommitCandidate` bound to turn/proposal/snapshot and a safe receipt.

- [ ] **Step 1: Write Proposal storage-boundary tests**

Assert content/slotId/ACL/revision/path fields reject; non-object spec, duplicate clientKey, depth/nodes/bytes reject; a schema/grammar-invalid but storage-safe proposal stays open.

- [ ] **Step 2: Write Gate and candidate tests**

Assert validate is advisory; submit runs full schema/grammar, allocates deterministic slot IDs and freezes `clientKey -> slotId`; failed Gate leaves Proposal open; candidate locks further write/submit.

- [ ] **Step 3: Write first-session Grant test**

Start with no scaffold; create Proposal before signing structure Grant; complete a candidate without any fake scaffoldId/revision.

- [ ] **Step 4: Implement whole-tree normalization and deterministic slot IDs**

Normalize children in submitted order and derive slotId from `scaffoldId + generationId + instancePath`, not clientKey. Store the mapping only in the candidate; no generation event is written here.

- [ ] **Step 5: Implement candidate/receipt state machine**

Store the full internal candidate in private state. Return only `{kind, status, changeCount, issueSummary}` to the model; no blob, Grant, revision or internal ID.

- [ ] **Step 6: Run tests and commit**

Run: `npx vitest run src/server/runtime/structured-slot/proposal-service.test.ts src/server/runtime/structured-slot/session-service.test.ts && npm run check`

```bash
git add src/server/runtime/structured-slot/proposal-service.ts src/server/runtime/structured-slot/proposal-service.test.ts src/server/runtime/structured-slot/session-service.ts src/server/runtime/structured-slot/session-service.test.ts
git commit -m "feat: add structure proposal sessions"
```

---

### Task 13: FillDraft Overlay and Merge Candidate

**Files:**

- Create: `src/server/runtime/structured-slot/draft-service.ts`
- Create: `src/server/runtime/structured-slot/draft-service.test.ts`
- Modify: `src/server/runtime/structured-slot/session-service.ts`
- Modify: `src/server/runtime/structured-slot/session-service.test.ts`

**Interfaces:**

- Produces fill operations: `listSlots`, `readSlot`, `replaceContent`, `unsetContent`, `validateDraft`, `submitDraft`, `getDraftStatus`.
- Produces `MergeCommitCandidate` with normalized changes, base/result revision and changeCount.

- [ ] **Step 1: Write overlay and authorization tests**

Assert reads see base + own overlay; batch replace is all-or-nothing; unset differs from null; out-of-scope/hidden IDs reveal no existence; type/spec/tree mutations reject.

- [ ] **Step 2: Write lifecycle and idempotency tests**

Assert get-or-create by active turn, signature replay, signature conflict, candidate lock, stale base, abandoned after terminal and no cross-Attempt clone.

- [ ] **Step 3: Write Merge Gate tests**

Cover content schema, changed-slot validator, affected subtree/scaffold validator, zero authority change on failure, nonempty expected revision +1 and no-op expected revision unchanged.

- [ ] **Step 4: Implement canonical overlay operations**

Charge meter before parameter authorization, validate full batch, write one journal record containing canonical args hash/result, and update checkpoint atomically. Resolve read content through Task 7 root plus overlay.

- [ ] **Step 5: Implement Merge candidate and no-op semantics**

For nonempty changes, stage the new content-root blob without promoting authority. For zero changes, candidate `content=null`, `resultRevision=baseRevision`, `changeCount=0`; still execute scaffold-level merge validators.

- [ ] **Step 6: Run tests and commit**

Run: `npx vitest run src/server/runtime/structured-slot/draft-service.test.ts src/server/runtime/structured-slot/session-service.test.ts && npm run check`

```bash
git add src/server/runtime/structured-slot/draft-service.ts src/server/runtime/structured-slot/draft-service.test.ts src/server/runtime/structured-slot/session-service.ts src/server/runtime/structured-slot/session-service.test.ts
git commit -m "feat: add fill draft sessions"
```

---

### Task 14: Slot Tool Factory and Pi Runtime Integration

**Files:**

- Create: `src/server/runtime/structured-slot/tool-factory.ts`
- Create: `src/server/runtime/structured-slot/tool-factory.test.ts`
- Modify: `src/server/runtime/pi-agent-runtime.ts`
- Modify: `src/server/runtime/pi-agent-runtime.test.ts`
- Modify: `src/server/runtime/pi-tool-factory.ts`
- Modify: `src/server/runtime/action-buffer.ts`
- Modify: `src/server/runtime/action-buffer.test.ts`

**Interfaces:**

- Consumes: `AgentTurnInput.slotSession` and Task 12/13 session service.
- Produces TypeBox tool definitions per session kind.
- Produces `assertStructuredForgeAction(sessionState, action)` before ActionBuffer proposal.

- [ ] **Step 1: Write exact tool registry tests**

Assert structure exposes five Proposal tools, fill exposes seven Draft tools, seal exposes request_seal plus declared read capabilities, and basic exposes none. Snapshot each parameter schema and ensure no engineering key appears.

- [ ] **Step 2: Write progressive disclosure tests**

Initial fill prompt contains target/outline directory but no preceding content. list_slots paginates; read_slot returns one complete authorized content; content above response limit rejects without truncation.

- [ ] **Step 3: Write dispatch guard tests**

Before candidate: structure/fill send rejects; after candidate only send succeeds. Seal passed permits only publish/final; reliable failed permits only rework send target; incomplete permits neither. human remains available until Attempt closes.

- [ ] **Step 4: Implement tool definitions with runner toolCallId**

Each execute callback passes `{toolCallId, toolName, params}` to session service; the service charges meter and performs idempotency. Tool result serializes only the authorized projection or safe receipt.

- [ ] **Step 5: Integrate session-aware action proposal**

Add an optional `beforePropose` hook to `createForgeToolDefinitions`/ActionBuffer wiring. Keep basic behavior byte-for-byte; structured hook validates receipt state and target before buffering dispatch.

- [ ] **Step 6: Integrate deadline signal and corrective prompt**

Pi runtime uses the composite Attempt signal. Corrective prompt names the required Slot completion before dispatch; context compaction does not recreate the session handle or meter.

- [ ] **Step 7: Run runtime tests and commit**

Run: `npx vitest run src/server/runtime/structured-slot/tool-factory.test.ts src/server/runtime/pi-agent-runtime.test.ts src/server/runtime/action-buffer.test.ts && npm run check`

```bash
git add src/server/runtime/structured-slot/tool-factory.ts src/server/runtime/structured-slot/tool-factory.test.ts src/server/runtime/pi-agent-runtime.ts src/server/runtime/pi-agent-runtime.test.ts src/server/runtime/pi-tool-factory.ts src/server/runtime/action-buffer.ts src/server/runtime/action-buffer.test.ts
git commit -m "feat: expose structured slot tools"
```

---

### Task 15: Atomic Structured Commit for Structure, Fill, Rework, and Human

**Files:**

- Create: `src/server/runtime/structured-slot/structured-committer.ts`
- Create: `src/server/runtime/structured-slot/structured-committer.test.ts`
- Modify: `src/server/runtime/action-committer.ts`
- Modify: `src/server/runtime/action-committer.test.ts`
- Modify: `src/server/runtime/task-runner.ts`
- Modify: `src/server/runtime/task-runner.test.ts`

**Interfaces:**

- Produces: `prepareStructuredCommit(context, action): PreparedStructuredCommit`.
- Keeps: `ActionCommitter.validateAndCommit` as the only public authority boundary.

- [ ] **Step 1: Write basic-path non-regression tests first**

Snapshot existing basic commit event order/results and assert the new productionMode branch does not invoke structured stores for v2.

- [ ] **Step 2: Write structure batch tests**

Assert promoted generation/content roots, proposal terminal, generation event, Agent result, Attempt terminal and message Route/input appear together. Inject failure before batch and assert none appear; replay returns original mapping/revision.

- [ ] **Step 3: Write fill and no-op batch tests**

Assert nonempty merge increments revision once; no-op emits Draft merged + dispatch but no content blob/revision bump; stale candidate writes one failure terminal and no content authority.

- [ ] **Step 4: Write Seal rework and human tests**

Reliable failed receipt can only send to frozen v3 target and keeps revision/phase. Human abandons Proposal/Draft/candidate/staging and atomically writes Agent result + waiting_human terminal + request.

- [ ] **Step 5: Implement deterministic batch planning**

Build every event and sequence in memory from one tail snapshot. Derive commitId from turn + completion kind. Promote immutable objects, then call `appendBatch(expectedLastSequence)`. On CAS conflict, read terminal and either replay or reject stale.

- [ ] **Step 6: Remove structured partial-commit failure writes**

Do not call the existing per-event `recordCommitFailure` on v3. Terminal companion events are part of one coordinator batch; only basic retains historical partial replay.

- [ ] **Step 7: Run committer/runner tests and commit**

Run: `npx vitest run src/server/runtime/structured-slot/structured-committer.test.ts src/server/runtime/action-committer.test.ts src/server/runtime/task-runner.test.ts && npm run check`

```bash
git add src/server/runtime/structured-slot/structured-committer.ts src/server/runtime/structured-slot/structured-committer.test.ts src/server/runtime/action-committer.ts src/server/runtime/action-committer.test.ts src/server/runtime/task-runner.ts src/server/runtime/task-runner.test.ts
git commit -m "feat: commit structured slot candidates atomically"
```

---

### Task 16: Seal Gate, Assembler, and Artifact Custody

**Files:**

- Modify: `src/server/runtime/structured-slot/session-service.ts`
- Create: `src/server/runtime/structured-slot/seal-service.test.ts`
- Modify: `src/server/runtime/structured-slot/structured-committer.ts`
- Modify: `src/server/runtime/structured-slot/structured-committer.test.ts`
- Modify: `src/server/storage/artifact-store.ts`
- Modify: `src/server/storage/artifact-store.test.ts`

**Interfaces:**

- Produces: `ArtifactStore.prepareStructuredVersion`, `promotePreparedVersion`, `recoverStructuredCustody`.
- Produces: `requestSeal` tri-state result and turn-bound content/rework receipt.

- [ ] **Step 1: Write Seal input and tri-state tests**

Cover required unset, all content schema, grammar, blocking/advisory validators, unavailable validator, Assembler error, output schema mismatch, passed/failed/incomplete and retry under remaining Attempt budget.

- [ ] **Step 2: Write custody crash-window tests**

Inject crash before promote, after promote/before batch and after batch. Before batch no artifact/Seal appears; orphan is reused or removed by digest. After batch all files and SealRecord are readable. Hash mismatch returns `ARTIFACT_INTEGRITY_FAILED`.

- [ ] **Step 3: Write publish and direct-final tests**

Publish creates artifact_published + sealed + Route/input; direct final by declared submitter creates artifact_published + sealed + final_submission_accepted. Plain Seal/publish does not complete task.

- [ ] **Step 4: Implement requestSeal content identity**

Hash task/scaffold/revision/snapshot/Assembler digest/canonical input. Run full Seal Gate and Assembler; validate exact create routes; write custody staging and immutable SealRecord candidate. Do not write events.

- [ ] **Step 5: Implement event-backed prepared artifact versions**

Allocate the next event-backed version, stage all files/meta/manifest, verify hashes, then promote to an unreferenced final directory. `list/read` ignores unreferenced directories; a future prepare may replace a different orphan only after proving no event references it.

- [ ] **Step 6: Add Seal success to the structured batch planner**

Include artifact_published, structured_scaffold_sealed, Agent result, terminal and the chosen publish Route or final event in one appendBatch. SealRecord references the exact prepared artifact ID/version.

- [ ] **Step 7: Run tests and commit**

Run: `npx vitest run src/server/runtime/structured-slot/seal-service.test.ts src/server/runtime/structured-slot/structured-committer.test.ts src/server/storage/artifact-store.test.ts && npm run check`

```bash
git add src/server/runtime/structured-slot src/server/storage/artifact-store.ts src/server/storage/artifact-store.test.ts
git commit -m "feat: seal structured slot artifacts"
```

---

### Task 17: Scheduler Lifecycle, Recovery, and Atomic Human Answer

**Files:**

- Modify: `src/server/runtime/task-runner.ts`
- Modify: `src/server/runtime/task-runner.test.ts`
- Modify: `src/server/runtime/task-scheduler.ts`
- Modify: `src/server/runtime/task-scheduler.test.ts`
- Modify: `src/server/core-service.ts`
- Modify: `src/server/core-service-live.test.ts`

**Interfaces:**

- Consumes: Task 11 coordinator and Task 15/16 committer.
- Preserves: basic retry/progress-guard behavior.

- [ ] **Step 1: Write full Attempt lifecycle tests**

Cover success, runtime failure, automatic retry, manual retry, stop during provider, stop racing commit, process recovery and resume. Assert epoch monotonicity, one terminal and no Proposal/Draft/candidate reuse.

- [ ] **Step 2: Write atomic structured answer tests**

Inject failure before and after answer batch. Before: request remains pending. After: both human_answered and fresh input exist. Same answer replays; different answer conflicts; answer fresh input starts epoch 1.

- [ ] **Step 3: Write resource-limit scheduler tests**

When Attempt timer or meter closes the turn, assert provider abort, no further tool/dispatch/human, failed/runtime_failure terminal and scheduler retry only under existing bounded retry policy.

- [ ] **Step 4: Integrate structured runNext path**

Detect productionMode, start Attempt before private object/Grant creation, build session handle, run with composite signal and delegate terminal authority to structured committer/coordinator. Basic branch remains the current code.

- [ ] **Step 5: Integrate stop and startup recovery**

Stop uses one batch for private abandonment + abandoned/task_stop + task_stopped. Startup recovery scans dangling starts and commits abandoned/crash_recovery + task_interrupted before tasks become resumable.

- [ ] **Step 6: Implement answer batch lookup before status rejection**

Derive IDs and commitId from pending request ID. Check existing commit and canonical answer first; otherwise append answer + fresh input together with expected tail. Do not call the two existing single-event helpers for structured agent_request.

- [ ] **Step 7: Run scheduler/service regression and commit**

Run: `npx vitest run src/server/runtime/task-runner.test.ts src/server/runtime/task-scheduler.test.ts src/server/core-service-live.test.ts && npm run check`

```bash
git add src/server/runtime/task-runner.ts src/server/runtime/task-runner.test.ts src/server/runtime/task-scheduler.ts src/server/runtime/task-scheduler.test.ts src/server/core-service.ts src/server/core-service-live.test.ts
git commit -m "feat: run and recover structured slot attempts"
```

---

### Task 18: Read-Only Projection, REST, Gateway, and UI

**Files:**

- Modify: `src/shared/contracts.ts`
- Modify: `src/shared/api-schemas.ts`
- Modify: `src/shared/api-schemas.test.ts`
- Modify: `src/server/storage/task-projector.ts`
- Modify: `src/server/storage/task-projector.test.ts`
- Create: `src/server/api/structured-slot-routes.ts`
- Create: `src/server/api/structured-slot-routes.test.ts`
- Modify: `src/server/api/router.ts`
- Modify: `src/server/core-service.ts`
- Modify: `src/client/gateway/forge-core-gateway.ts`
- Modify: `src/client/gateway/http-gateway.ts`
- Modify: `src/client/gateway/http-gateway.test.ts`
- Create: `src/client/components/structured-slot-drawer.tsx`
- Create: `src/client/components/structured-slot-drawer.test.tsx`
- Modify: `src/client/pages/production-page.tsx`
- Modify: `src/client/styles/app.css`

**Interfaces:**

- Produces the five read-only endpoints from spec §14.
- Extends `TaskWorkspace.structuredSlots?: StructuredSlotsSummaryV1`.
- Extends gateway with `getStructuredContract`, `listStructuredSlots`, `getStructuredSlot`, `listStructuredIssues`, `getStructuredSeal`.

- [ ] **Step 1: Write exact response schema tests**

Assert unknown fields reject; basic workspace omits structuredSlots; structured summary never includes content/tree/Draft/Grant; cursor-invalid maps to stable 409 public error.

- [ ] **Step 2: Write API authorization/pagination tests**

Cover contract projection without implementation paths, paged outline, one slot detail, visible issues, SealRecord, stale cursor and missing/hidden slot indistinguishability.

- [ ] **Step 3: Write drawer UI tests**

Assert basic tasks show no Structure button; structured tasks open a read-only tree, load one slot on selection, render spec/content/status/issues and link sealed artifact. Assert no textbox, drag handle, save or merge control exists.

- [ ] **Step 4: Implement projector and CoreService reads**

Fold only authoritative structured events into summary. Route detailed reads through the same projection service used by Agent grants, using the task-owner visibility profile rather than direct file reads.

- [ ] **Step 5: Implement exact REST and gateway decoding**

Register `structuredSlotRoutes()` in the central router. Decode every response with TypeBox before returning to React; map `SLOT_NOT_VISIBLE`, cursor invalid and runtime unavailable to stable public envelopes.

- [ ] **Step 6: Implement the read-only drawer**

Reuse existing task watch for summary refresh and fetch pages/details on demand. Keep the canvas and artifact drawer unchanged; add a third overlay toggle labelled “结构”.

- [ ] **Step 7: Run API/UI tests and commit**

Run: `npx vitest run src/shared/api-schemas.test.ts src/server/storage/task-projector.test.ts src/server/api/structured-slot-routes.test.ts src/client/gateway/http-gateway.test.ts src/client/components/structured-slot-drawer.test.tsx && npm run check`

```bash
git add src/shared src/server/storage/task-projector.ts src/server/storage/task-projector.test.ts src/server/api src/server/core-service.ts src/client
git commit -m "feat: expose structured slots read only"
```

---

### Task 19: Acceptance, Security Regression, and Documentation

**Files:**

- Create: `src/server/template/structured-slot-template.acceptance.test.ts`
- Create: `scripts/verify-structured-slots.ts`
- Modify: `package.json`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/PROJECT-MAP.md`
- Modify: `docs/IMPLEMENTATION-LOG.md`

**Interfaces:**

- Produces: offline `npm run verify:structured-slots` evidence command.
- Consumes all preceding tasks.

- [ ] **Step 1: Build a deterministic end-to-end fixture script**

Use the platform-neutral structured fixture and scripted Agent runtime to execute: initial structure -> fill -> no-op fill -> Seal reliable failure -> rework fill -> Seal publish -> v2 final submit. Assert final content derives from sealed scaffold and task completes only at final submission.

- [ ] **Step 2: Add crash and replay acceptance cases**

Inject process boundaries before/after structure batch, merge batch, rework batch, Seal promote/batch and answer batch. Restart stores/coordinator and assert exactly one authority result for each commitId.

- [ ] **Step 3: Add security/source scans**

Run a test that asserts ForgeAction registry is the original nine names; Slot Tool schemas have no engineering keys; evaluator modules have no business fixture words; public issues contain no absolute workspace path, secret key names or raw provider thinking.

- [ ] **Step 4: Run the complete regression suite**

Run:

```bash
npm run check
npm test -- --reporter=dot
npm run build
npm run e2e
npm run verify:backend
npm run verify:runtime
npm run verify:structured-slots
```

Expected: every command exits 0; existing basic fixtures retain their pre-change version hashes and outputs.

- [ ] **Step 5: Update architecture and implementation records**

Document the new pure domain layer, mode split, EventStore batch files, structured task directory, Attempt state machine, Seal custody and read-only UI. Record the frozen platform profile evidence path and explicitly state that no production story template was added.

- [ ] **Step 6: Run final diff audits**

Run:

```bash
git diff --check
rg -n "T[B]D|T[O]DO|FIX[M]E" src docs scripts
rg -n "taskId|scaffoldId|draftId|grantId|revision|requestId" src/server/runtime/structured-slot/tool-factory.ts
```

Expected: `git diff --check` empty; placeholder scan empty in new structured files; engineering-key scan finds only the test that asserts rejection and internal closures, never TypeBox model parameters.

- [ ] **Step 7: Commit the verified engine**

```bash
git add package.json src scripts docs/ARCHITECTURE.md docs/PROJECT-MAP.md docs/IMPLEMENTATION-LOG.md
git commit -m "feat: complete structured slot engine v1"
```

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-10-structured-slot-engine.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review spec compliance and code quality between tasks.
2. **Inline Execution** — execute tasks in this session with `executing-plans`, in dependency order with checkpoints.

Do not begin either option until the user explicitly asks to implement.
