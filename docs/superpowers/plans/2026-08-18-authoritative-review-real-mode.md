# Authoritative Review Real-Mode Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with verification checkpoints.

**Goal:** Make the enabled authoritative-review v2 production path actually execute Agent assignments, expose the correct closure-bound v2 tools to Pi, persist domain result references, and fail deterministically instead of leaving leases hanging.

**Architecture:** The production composition remains the only v2 installation root. Its scheduling tick will execute every newly leased work item through `V2AttemptCoordinator`; a task-aware tool-runtime registry will create one `V2ToolFactory` per frozen task context, and the same factory instance will serve Pi's `v2Tools` seam and the runner's result-ref collector. Domain services and private journals remain server-owned; model input never supplies authority identities.

**Tech Stack:** TypeScript, Vitest, `@earendil-works/pi-coding-agent` 0.82, content-addressed v2 storage, `CoreService`, `V2AttemptCoordinator`, `V2ToolFactory`, and the existing real-provider acceptance scripts.

## Global Constraints

- Preserve v1/basic and v3 structured-slot behavior byte-for-byte.
- Structured v2 sessions receive only their closed session-kind tool list; generic submitter turns retain only the delivery-bound generic surface.
- Authority, grant, lease, attempt, private-journal, result-ref, and terminal state remain server-owned.
- Agent completion is legal only with the non-empty domain result refs required by the current WorkItem kind.
- No credentials, hidden reasoning, or unbounded prompt/history content may enter durable logs or traces.
- Any source change invalidates captured qualification evidence; re-run check/build/qualification/promotion before claiming production readiness.
- Existing untracked `.workbuddy/memory/*` files in the main checkout are user data and must not be changed or removed.

---

### Task 1: Establish the current production execution regression

**Files:**
- Create: `src/server/runtime/authoritative-review/production-composition.integration.test.ts`
- Modify: `src/server/runtime/authoritative-review/production-composition.ts:676-693` only after the failing test is observed

**Interfaces:**
- Consumes: `installAuthoritativeReviewRuntime`, `V2AttemptCoordinator`, `V2AssignmentRunner`, `FakeAgentRuntime`, and the existing v2 coordinator test environment.
- Produces: a regression test proving that a freshly leased `agent_assignment` is handed to `executeLeased`, while system-command leases continue to execute.

- [ ] **Step 1: Write the failing test**

  Build the smallest real composition harness that returns one leased `agent_assignment`, supplies a `V2AssignmentRunner` backed by a recording `AgentRuntime`, and returns the corresponding projected WorkItem from `readProjection`. Assert that `runTick()` returns one execution outcome and that the recording runtime received the v2 turn. Add a second assertion that the existing system-command path remains executable.

- [ ] **Step 2: Run the focused test and verify it fails for the intended reason**

  Run:

  ```bash
  npx vitest run src/server/runtime/authoritative-review/production-composition.integration.test.ts -t "executes a freshly leased agent assignment"
  ```

  Expected failure: the outcome list is empty and the recording runtime has zero calls because `runTick()` currently filters out `agent_assignment`.

- [ ] **Step 3: Implement the minimal production-driver change**

  Make `runTick()` call `attempts.executeLeased(leased.taskId)` for every entry in `pass.leased`. Keep the existing scheduler eligibility gate and let `V2AttemptCoordinator` dispatch command versus Agent execution from the projected lease carrier.

- [ ] **Step 4: Run the focused test and verify it passes**

  Run the same command. Expected result: the Agent execution regression and system-command assertion pass.

- [ ] **Step 5: Commit the independently testable driver change**

  ```bash
  git add src/server/runtime/authoritative-review/production-composition.ts src/server/runtime/authoritative-review/production-composition.integration.test.ts
  git commit -m "fix: execute leased authoritative agent assignments"
  ```

### Task 2: Install one task-aware v2 tool runtime

**Files:**
- Create: `src/server/runtime/authoritative-review/production-tool-runtime.ts`
- Modify: `src/server/runtime/agent-runtime.ts:31-64` only if an opaque task-context handoff is needed
- Modify: `src/server/runtime/pi-agent-runtime.ts:205-232` only if the adapter needs a new structural seam
- Modify: `src/server/runtime/authoritative-review/assignment-runner.ts:87-132`
- Modify: `src/server/core-service.ts:40-120,493-506,631-671`
- Test: `src/server/runtime/authoritative-review/production-tool-runtime.test.ts`
- Test: `src/server/runtime/authoritative-review/assignment-runner.test.ts`

**Interfaces:**
- Consumes: `V2ToolFactory.createContext`, `V2ToolFactory.toolsFor`, `V2ToolFactory.collectResultRefs`, `createPiV2ToolRuntime`, `AuthoritativeReviewPrivateStore`, `GrantService`, `V2AttemptContext`, and the persisted v2 projection/resolver.
- Produces: a production adapter with `createContext(input)` for Pi and `collectResultRefs(ctx)` for the runner, backed by the same task-scoped factory and private store.

- [ ] **Step 1: Write failing seam tests**

  Add tests that construct a task-scoped production adapter with a fake factory and assert:

  ```ts
  const piContext = await adapter.createContext(agentTurnInput);
  expect(piContext?.toolDefinitions.map((tool) => tool.name)).toEqual([
    'read_map_build_frontier',
    'append_map_candidate_chunk',
    'finish_map_build',
  ]);
  expect(await adapter.collectResultRefs(attemptContext)).toEqual([resultRef]);
  ```

  Add a test that the runner does not resolve one unused tool list and then hand a different list to Pi; the factory is the single source of tool definitions. Add an identity test where `GrantInstance.agentId` is the lease owner while `input.agent.id` is the frozen role agent, and assert that the authoritative context uses the persisted lease identity.

- [ ] **Step 2: Run the focused tests and verify they fail**

  ```bash
  npx vitest run src/server/runtime/authoritative-review/production-tool-runtime.test.ts src/server/runtime/authoritative-review/assignment-runner.test.ts -t "production|single source|lease owner"
  ```

  Expected failure: the adapter does not exist and the runner currently evaluates an unused `toolsFor(ctx)` result.

- [ ] **Step 3: Implement the minimal task-aware adapter**

  Create a registry that resolves a frozen task context from `(taskId, workItemId, attemptId)` and constructs `V2ToolFactory` with:

  - the task's frozen authoritative profile;
  - `GrantService` using the canonical projection and blob resolver;
  - `AuthoritativeReviewPrivateStore(paths, taskId)`;
  - the real domain handlers and review publication seams;
  - a context resolver that derives lease owner, epoch, dispatch ref, authority base, and role agent from persisted state.

  Pass `createPiV2ToolRuntime(registry)` into the production `PiAgentRuntime`. Make the runner use the same registry only for post-turn `collectResultRefs`; remove the unused tool-definition lookup or move any fail-fast resolution inside the runner's classified error boundary.

- [ ] **Step 4: Run the focused seam tests and verify they pass**

  Run the same focused command and then:

  ```bash
  npm run check
  ```

- [ ] **Step 5: Commit the tool-runtime seam**

  ```bash
  git add src/server/runtime/authoritative-review/production-tool-runtime.ts src/server/runtime/authoritative-review/production-tool-runtime.test.ts src/server/runtime/authoritative-review/assignment-runner.ts src/server/runtime/authoritative-review/assignment-runner.test.ts src/server/runtime/agent-runtime.ts src/server/runtime/pi-agent-runtime.ts src/server/core-service.ts
  git commit -m "feat: wire authoritative v2 tools into production Pi runtime"
  ```

### Task 3: Wire real domain services and result carriers

**Files:**
- Modify: `src/server/runtime/authoritative-review/production-composition.ts:205-304,650-694`
- Modify: `src/server/core-service.ts:631-677`
- Modify: `src/server/runtime/authoritative-review/production-tool-runtime.ts`
- Test: `src/server/runtime/authoritative-review/production-composition.integration.test.ts`

**Interfaces:**
- Consumes: `MapBuildService`, `ContentPlanService`, `RepairService`, `MigrationServiceV2`, `MapReviewService`, `ContentReviewService`, `createContentPlanToolHandlers`, `createRepairToolHandlers`, and the existing service dependency contracts.
- Produces: a production composition where structure, generation, repair, migration, review settlement, and seal command paths are all real or fail closed before leasing; no enabled v2 task parks because an optional service was silently omitted.

- [ ] **Step 1: Write failing production-chain assertions**

  Extend the composition integration test to assert that the initial structure assignment receives its exact closed tools and that a committed tool result is returned as a non-empty `resultRefs` carrier to `completeWorkItem`. Add assertions that an uninstalled service cannot produce an enabled production composition.

- [ ] **Step 2: Run the focused test and verify the missing-service failure**

  ```bash
  npx vitest run src/server/runtime/authoritative-review/production-composition.integration.test.ts -t "closed tools|result refs|uninstalled service"
  ```

- [ ] **Step 3: Wire the real services in the composition root**

  Construct each service from its existing dependency interface, reusing the composition's canonical resolver, facade, frozen profile/template, validator registry, review policy, and coordinator. Bind map-build writes to `MapBuildService.appendChunk`/`finishMapBuild`, content writes to `createContentPlanToolHandlers`, repair writes/reads to `createRepairToolHandlers`, and review completion to the appropriate map/content review service target and freeze seam. Pass every constructed service into the existing optional service slots of `installAuthoritativeReviewRuntime`.

- [ ] **Step 4: Run focused integration and domain tests**

  ```bash
  npx vitest run src/server/runtime/authoritative-review/production-composition.integration.test.ts src/server/runtime/authoritative-review/tool-factory.test.ts src/server/runtime/authoritative-review/map-build-service.test.ts src/server/runtime/authoritative-review/content-plan-service.test.ts src/server/runtime/authoritative-review/repair-service.test.ts
  npm run check
  ```

- [ ] **Step 5: Commit the real domain composition**

  ```bash
  git add src/server/runtime/authoritative-review/production-composition.ts src/server/core-service.ts src/server/runtime/authoritative-review/production-tool-runtime.ts src/server/runtime/authoritative-review/production-composition.integration.test.ts
  git commit -m "feat: compose authoritative v2 domain services"
  ```

### Task 4: Make real-mode failures bounded and observable

**Files:**
- Modify: `src/server/runtime/pi-agent-runtime.ts:782-1080`
- Modify: `src/server/runtime/authoritative-review/attempt-coordinator.ts:372-430`
- Test: `src/server/runtime/pi-agent-runtime.test.ts`
- Test: `src/server/runtime/authoritative-review/attempt-coordinator.test.ts`
- Modify: `docs/INVESTIGATION-AUTHORITATIVE-REVIEW-REAL-MODE.md`

**Interfaces:**
- Consumes: `AbortSignal`, `RuntimeFailure`, Pi session listeners, and the existing attempt timeout/retry envelope.
- Produces: sanitized lifecycle logs and a deterministic retryable `ATTEMPT_TIMEOUT`/provider failure instead of an indefinitely pending Agent lease.

- [ ] **Step 1: Write failing timeout/listener tests**

  Add a runtime test with a session promise that never settles and an aborted signal; add an attempt-coordinator test proving the attempt records the configured timeout failure and removes the lease wakeup. Add a listener test proving diagnostic logging does not turn a provider event rejection into an unhandled hung promise.

- [ ] **Step 2: Run tests and verify the failure**

  ```bash
  npx vitest run src/server/runtime/pi-agent-runtime.test.ts src/server/runtime/authoritative-review/attempt-coordinator.test.ts -t "timeout|listener|never settles"
  ```

- [ ] **Step 3: Implement bounded diagnostics**

  Add only sanitized fields to logs: task/workitem/attempt, model provider/model, tool count/names, session creation, prompt dispatch, first tool event, agent end, abort, and terminal outcome. Ensure listener errors are surfaced in development diagnostics while preserving trace best-effort semantics. Ensure provider/session aborts settle through the existing retry classification and do not write a completion without confirmed result refs.

- [ ] **Step 4: Run focused tests and check**

  ```bash
  npx vitest run src/server/runtime/pi-agent-runtime.test.ts src/server/runtime/authoritative-review/attempt-coordinator.test.ts
  npm run check
  ```

- [ ] **Step 5: Commit the bounded real-mode behavior**

  ```bash
  git add src/server/runtime/pi-agent-runtime.ts src/server/runtime/authoritative-review/attempt-coordinator.ts src/server/runtime/pi-agent-runtime.test.ts src/server/runtime/authoritative-review/attempt-coordinator.test.ts docs/INVESTIGATION-AUTHORITATIVE-REVIEW-REAL-MODE.md
  git commit -m "fix: bound and instrument authoritative real-mode attempts"
  ```

### Task 5: Fresh qualification and real acceptance

**Files:**
- Modify: `docs/CLOSURE-AUTHORITATIVE-REVIEW-V2.md`
- Create/update only through existing scripts: `docs/evidence/*`

- [ ] **Step 1: Run the project verification gates**

  ```bash
  npm run check
  npm run build
  npm run verify:authoritative-review -- --acceptance-only --capability production
  npm test -- --reporter=dot --maxWorkers=1
  ```

- [ ] **Step 2: Run a real HTTP/Pi task with the configured provider**

  Start the actual `npm run dev` service with the configured DeepSeek credential supplied only through the environment, create the `zhihu-salt-chapter-draft` task over HTTP, start it, and verify both persisted events and the rendered browser state. The run must reach a terminal/completed state without a stale lease; inspect only sanitized logs.

- [ ] **Step 3: Run the real-mode acceptance command and regenerate evidence**

  ```bash
  npm run acceptance:authoritative-review-real
  ```

  Do not hand-edit capability manifests. If the source/profile/evidence digests changed, use the repository's benchmark → qualify → promote path before re-enabling production capability.

- [ ] **Step 4: Request independent code review and address all important findings**

  Review the final diff against the initial `49c4f8e` baseline, specifically checking v1 compatibility, authority identity binding, tool closure, result-ref custody, and timeout behavior. Fix Critical/Important findings before declaring completion.

- [ ] **Step 5: Commit documentation and final verification**

  ```bash
  git add docs/CLOSURE-AUTHORITATIVE-REVIEW-V2.md docs/evidence
  git commit -m "docs: close authoritative real-mode acceptance"
  ```

