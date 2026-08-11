# SDD ledger — plan: docs/superpowers/plans/2026-08-10-structured-slot-engine.md

## Bootstrapping

- Start time (local): 2026-08-10 ~21:06
- Worktree: /Users/lzy/Desktop/ForgeCore/.worktrees/codex-structured-slot-engine-v1
- Branch: codex/structured-slot-engine-v1
- Baseline commit (fork point): 16c9e5b (approval baseline == starting HEAD of main)
- Main HEAD at start: 16c9e5b (clean tree)
- node_modules: symlinked from main checkout (shared package-lock.json)
- Baseline tests: 72 files / 1231 tests passed; `npm run check` clean

## Overnight Harness roles

- Controller/Harness: main session (this one)
- Implementer subagents: fresh per task
- Task reviewer subagents: fresh, independent per task
- Final whole-branch reviewer: strongest model at end

## Global Constraints (verbatim pointer)

Plan file `docs/superpowers/plans/2026-08-10-structured-slot-engine.md` § Global Constraints;
authoritative spec `docs/2026-08-10-structured-slot-engine-spec.md`;
upstream design `docs/STRUCTURED-SLOT-ENGINE-DESIGN.md` §25-26 takes precedence.

## Task ledger

(per task: BASE, HEAD, implementer agent, files, tests, review verdict, fix rounds, commits)

## Bootstrapping (cont.)

- All frozen docs read by harness: DESIGN (full incl §25-26), SPEC (full), IMPLEMENTATION-REVIEW (full), plan (full), ARCHITECTURE, PROJECT-MAP.
- Pre-flight conflict scan of plan: no fatal internal contradictions. Notes:
  - re2-wasm@1.0.2 is the plan-locked dependency for Task 2.
  - Task 9 reference-runner descriptor is machine-specific; this host (macOS, Apple Silicon) is recorded as the designated runner; Task 19 benchmark runs on the same host → descriptor match is legitimate.
  - Task 19 promotion is expected to depend on real benchmark evidence; if it cannot be produced on this host, capability stays disabled (per harness rules).
- Baseline verified in worktree: npm run check clean; 72 files / 1231 tests pass.

## Task ledger


## Harness codebase reconnaissance (2026-08-10)

Key existing-code facts the harness verified (implementers should verify deeper per task):
- contracts.ts: TaskWorkspace lacks structuredSlots; TurnPhase types exist. contracts.ts is frozen-ish.
- task-events.ts: TaskEvent union with exact-key validation (validateTaskEvent, normalizeLegacyEvent); MEMBER_KEYS registry; new structured events must be added here (Task 6).
- event-store.ts: append() per-task mutex, scanCommitted validates + contiguous 1..N sequences; canonicalJson local helper (sorts keys, NOT JCS -0 normalization). Task 6 adds appendBatch/readBatchByCommitId + batch file `<first>-<last>-<commitId>.batch.json`.
- core-paths.ts: EVENT_FILE_NAME regex; taskEventFile validates fileName; needs batch filename support (Task 6/7) + structured-slots paths.
- action-committer.ts: validateAndCommit -> validateActionSet (pure) + commitValidated; per-event append via appendPlanned; recordCommitFailure (basic partial replay). Task 15 adds structured branch + completion signature preflight; v3 must NOT call recordCommitFailure / per-event append.
- gate-runner.ts: isolated-vm CommonJS wrapper, GateIssue{stage,evidence,scope}, cache per (taskId,agentId,sha256). Task 8 refactors sandbox mechanics into shared primitive; keep public behavior + tests unchanged.
- template-schema.ts: FrozenTemplate lacks productionMode/structuredSlots; TurnContract v1|2. isTurnContractSupported() gates v2-only. Task 5 adds union + productionMode/structuredSlots + runtime env.
- template-loader.ts: computeVersionHash excludes template id/sourcePath; canonicalize sorts keys + newline-normalizes strings. Task 5 must keep old basic hashes byte-identical (omit default fields).
- template-validator.ts: validateTurnContract handles version 1|2 only; validateAgentFile requires turnContract. Task 5 adds v3 slotSession parsing.
- template-cache.ts: cacheTemplate(paths, frozen) copies + reopens; manifest.json stores FrozenTemplate + cachedAt; readManifest normalizes scalar targets. Task 5 must thread runtime env into cache reopen.
- template-catalog.ts: TemplateCatalog(paths) no env; refreshFromSource -> loadTemplateDirectory + cacheTemplate; serveFromCache fallback. Task 5 adds structured runtime env (capability+profile) + TEMPLATE_RUNTIME_UNAVAILABLE diagnostic.
- task-store.ts: TaskStore(paths, catalog); readFrozenTemplate/publishTaskDirectory call loadTemplateDirectory directly (must use catalog env). Task 5 modifies; maps runtime-unavailable to TEMPLATE_RUNTIME_UNAVAILABLE not TEMPLATE_NOT_FOUND.
- task-runner.ts: runNext builds input, checks agent.turnContract===null -> TURN_CONTRACT_REQUIRED; turnId=`${inputNodeId}-t${attemptCount}` (basic). buildTurnChecklist/commit context. Task 5 adds v2/v3 narrowing; Task 11 adds slotSession; Task 17 adds structured runNext path.
- agent-runtime.ts: AgentTurnInput has NO slotSession yet. Task 11 makes it required `SessionHandle | null`.
- forge-actions.ts: FORGE_ACTION_NAMES 9 items (load_skill/finish_production/annotate_artifact/read_artifact_version/publish_artifact/forward_input_version/submit_final_artifact/send_message/request_human_input); FORBIDDEN_ACTION_KEYS. Slot Tool must be a separate turn-bound registry, never here.
- task-scheduler.ts: single-slot; prepare() gates isTurnContractSupported; answer path appends human_answered + agent_input separately (basic). Task 17 adds structured answer batch + crash recovery + runtime env recheck.
- core-service.ts: CoreService(paths, options) constructs TemplateCatalog(paths) + TaskStore + EventStore + ArtifactStore + GateRunner + committer + runner + scheduler. Task 5 adds env threading; Task 17/18 more.
- SDD workspace: .superpowers/sdd/2026-08-10-structured-slot-engine (ledger progress.md, briefs task-1..19-brief.md)
- Subagent model note: environment maps requested models (sonnet/opus) to available provider models; strongest model for final review per availability.

## Task ledger

## Task 1: Public Contracts, Canonical JSON, Issue Registry

- BASE: 16c9e5b ; HEAD: f17a66c
- Implementer agent: a78249fdb19240385 (sonnet-tier); status DONE
- Commit: f17a66c "feat: add structured slot domain contracts" (6 files, +1426)
- Files: src/shared/structured-slots.ts, canonical-json.ts(+test), issues.ts(+test), contracts.ts (+7: TaskWorkspace.structuredSlots?)
- Tests: 43 new domain tests pass (canonical 17, issues 26); full suite 74 files/1274 green; npm run check clean
- Implementer concerns: (1) 37 non-pinned code source/phase/location = implementer's F03-domain assignment; (2) sort key (phase,code) not pinned by F06; (3) detailsSchema deferred to later task; (4) node_modules symlink untracked
- Harness fix: replaced node_modules symlink with real install (symlink was NOT gitignored; real dir now ignored) — protects Task 19 clean-tree gate
- Review: reviewer afa50c151dea31e50 dispatched (BASE 16c9e5b..f17a66c, package review-16c9e5b..f17a66c.diff)

- Review verdict: Spec ✅, quality Approved (reviewer afa50c151dea31e50). 0 Critical, 0 Important.
- Harness re-verify: focused tests 43/43 pass; npm run check clean.
- Task 1: minor (deferred): detailsSchema omitted from registry (F02 key shape) — handoff to Task 18/final review; details not yet code-shaped bounded (F04) — accepted for Task 1 scope.
- Task 1: minor (deferred): summary recomputed pre-cap (F06 "visible" ambiguity) — defensible, flagged for final review.
- Task 1: minor (deferred): TextSpan start/end extra fields + JsonPointer not RFC 6901-validated — defer to pointer-consuming gate task.
- Task 1: minor (deferred): projectStructuredVerdict trusts issue severity/source — safe while makeStructuredIssue is sole producer; harden in later task.
- Task 1: complete (commits 16c9e5b..f17a66c, review clean, 4 deferred minors)


## Task 2: Slot Schema v1 Compiler + Safe Regex

- BASE: f17a66c (HEAD at dispatch)
- Implementer agent: a7b37312a52c9327d (sonnet-tier)
- Dispatch notes: added StructuredSlotLimitsV1 to shared (spec §5 frozen contract); safe-regex backed only by re2-wasm@1.0.2 exact; TDD red-green; brief task-2-brief.md.


## Task 2 (cont.)

- HEAD: 4a7977d ; commit "feat: implement slot schema v1" (7 files +1441)
- Implementer concerns: payload byte ceilings out of scope (limits.schema has none; belongs to limits.payload later); phase→code mapping interpretation; safe-regex also rejects named groups (stricter, fail-closed); @internal _enumHashes/_constHash on compiled tree
- Harness re-verify: focused 72/72 pass; npm run check clean; re2-wasm exact 1.0.2 in package.json + package-lock.json
- Review: reviewer ad95dc5488b74af6e dispatched (f17a66c..4a7977d, review-f17a66c..4a7977d.diff)


- Task 2 review: Spec ✅, quality Approved (reviewer ad95dc5488b74af6e). 0 Critical, 0 Important.
- Task 2: minor (deferred): _enumHashes Set not truly frozen (Object.freeze no-op on Set.add) — documented @internal, cosmetic; final review to triage.
- Task 2: minor (deferred): "requires Unicode mode" test doesn't prove library-level rejection of missing u flag (property real, verified by reviewer in re2-wasm source) — test could be strengthened.
- Task 2: minor (deferred): named groups rejected though RE2 supports them — stricter than literal brief, fail-closed, defensible; harness confirms strictness intended.
- Task 2: complete (commits f17a66c..4a7977d, review clean, 3 deferred minors)

## Task 3: Deterministic LayoutGrammar Compiler

- BASE: 4a7977d
- Implementer: TBD (sonnet-tier)
- Dispatch notes: brief task-3-brief.md; consumes Task 1 issue types only.


## Task 3 (cont.)

- Implementer agent: ae51f7c5279300696 (sonnet-tier)
- Dispatch notes: fixed-point analyses nullable/min/maxConsumption/first/follow/generatable; non-backtracking single-pass matcher; registry codes from F03 grammar_ref/term/ambig (may additively extend issues.ts if a grammar code is missing).


- Task 3 note: implementer ae51f7c5279300696 stopped prematurely (2 tool calls, no work, no report). Resumed via SendMessage with explicit "begin now" nudge. No changes on disk.


## Task 3 (cont.)

- HEAD: e3e95ec ; commit "feat: compile deterministic layout grammar" (2 files +1484)
- Harness re-verify: focused 34/34 pass; npm run check clean; worktree clean
- Implementer concerns: Set immutability type-level (ReadonlySet); repeat-item FOLLOW over-approximated (fail-closed); end-of-children failures place issue at trailing locations entry (documented)
- Review: reviewer ada1aaf1cfcc34ffa dispatched (4a7977d..e3e95ec, review-4a7977d..e3e95ec.diff)


- Task 3 review: Spec ✅, quality Approved (reviewer ada1aaf1cfcc34ffa). 0 Critical, 0 Important. ⚠️ FOLLOW-granularity resolved (production-local is correct per design §8.6.2 "当前 production 上下文"); pass counts re-verified by harness (34/34, check clean).
- Task 3: minor (deferred): leftover-children failure reports whole-production summary instead of EOF marker (bounded, test-pinned).
- Task 3: minor (deferred): UNKNOWN_PARENT_TYPE/MATCH_LOCATIONS_EMPTY throw raw Errors outside registry (programmer-error guards).
- Task 3: minor (deferred): maxConsumption bound reuses LAYOUT_GRAMMAR_NODE_INVALID; note for Task 4 contract compiler (RESOURCE_LIMIT_EXCEEDED-style code exists).
- Task 3: minor (deferred): Set immutability type-level only (consistent with slot-schema convention).
- Task 3: minor (deferred): coverage — no nullable-choice-branch repeat test, no choice/optional production-root matcher test, guard throws untested.
- Task 3: complete (commits 4a7977d..e3e95ec, review clean, 5 deferred minors)

## Task 4: Structured Contract Compiler and Resource Manifest

- BASE: e3e95ec
- Implementer: TBD (sonnet-tier)
- Dispatch notes: brief task-4-brief.md; fixture limits <= 25% of design §25.13 candidate; profile arg = platform hard ceiling (StructuredSlotLimitsV1 for now; Task 9 reconciles full profile).


## Task 4 (cont.)

- Implementer agent: ab5ee3321a7526e17 (sonnet-tier)
- Dispatch notes: profile arg = StructuredSlotLimitsV1 hard ceiling for now (Task 9 reconciles); fixture limits <= 25% of design §25.13 candidate; semantic digest independent of mtime/root; sorted resource manifest; fixture business words confined to __fixtures__ subtree.


## Task 4 (cont.)

- HEAD: 7987c70 ; commit "feat: compile structured slot contracts" (5 files +1494: compiler 783, test 556, fixture contract.yaml 121, validators/validate.js 18, assembler/render.js 16)
- Harness re-verify: focused 36/36 pass; npm run check clean; worktree clean
- Implementer concerns: digest array-order sensitive (not required invariant); ids non-empty strings (not SAFE_ID); budgets positive-int only (no per-impl ceiling field yet); assembler routes may be empty; malformed profile arg → SLOTS_CONTRACT_INVALID for now
- Review: reviewer a062ed6d7b8498599 dispatched (e3e95ec..7987c70, review-e3e95ec..7987c70.diff)


- Task 4 review: Spec ✅, quality Approved (reviewer a062ed6d7b8498599). 0 Critical, 0 Important. ⚠️ missing-field tests for layoutGrammar/version (code covers all 7; harness accepts).
- Task 4: minor (deferred): semantic digest array-order sensitive (A03 only mandates mtime/root invariance + change-sensitivity — satisfied; order-normalization would be future polish).
- Task 4: minor (deferred): ids are nonEmptyString not SAFE_ID — cheap to harden later.
- Task 4: minor (deferred): assembler routes may be [] — Task 5 artifactSchema integration is the natural place to require create coverage.
- Task 4: minor (deferred): validator/assembler budgets no per-impl ceiling yet (no profile field).
- Task 4: minor (deferred): malformed profile arg → SLOTS_CONTRACT_INVALID (plan-mandated until Task 9).
- Task 4: minor (deferred): coverage — layoutGrammar/version deletion + YAML duplicate-key path untested.
- Task 4: minor (deferred): small TOCTOU window in readResourceBytes (identical to existing readContainedFile).
- Task 4: complete (commits e3e95ec..7987c70, review clean, 7 deferred minors)

## Task 5: TurnContract v3, Loader Integration, Typestate, Readiness Gate (BIGGEST INTEGRATION)

- BASE: 7987c70
- Implementer: TBD (opus-tier — highest-risk integration: v3 union + Loader/Cache/Catalog/TaskStore/CoreService/runner/committer wiring + capability gate + typestate + fixtures)
- Dispatch notes: brief task-5-brief.md; keep old basic hashes byte-identical; capability+profile env threaded everywhere; production manifest disabled.


## Task 5 (cont.)

- Implementer agent: a77288b2618fc76b3 (opus-tier)
- Dispatch notes: v3 union no fake optional fields; old basic hash byte-identical golden; capability+profile env threaded Loader→cache→TaskStore→CoreService (TaskStore from ITS Catalog, never second default); production manifest disabled; typestate 3-state fixed point; fixture completed; Step 8 command + npm run check as proof.


- Task 5 note: implementer a77288b2618fc76b3 stopped prematurely (2 tool calls, no work). Resumed via SendMessage with begin-now nudge.


## Task 5 (cont.)

- HEAD: 1f6a1b3 ; commit "feat: load gated structured turn contracts" (28 files +2421/-75)
- Harness re-verify: Step 8 proof 12 files/296 tests pass; npm run check clean; full suite 80 files/1463 green; pinned golden hashes 5dee5a79… pass (basic hash preserved)
- Out-of-scope acceptance-test edits (long-form-hub/zhihu): verified = v3-union consumer narrowing via isBasicTurnContract, minimal necessary ripples (P2-1), no basic behavior change
- Implementer concerns (flagged for reviewer): (1) cache manifest stores degraded structuredSlots (Sets→arrays, funcs dropped) — claimed safe because consumers recompile; (2) basic+slots rejection on contract.yaml presence not bare dir (matches §15); (3) structured snapshot reads require enabled env in both loader modes (vs O05 "historical snapshot readable" — judgment call)
- Review: reviewer a8946f419e0523dae (opus-tier) dispatched (7987c70..1f6a1b3, review-7987c70..1f6a1b3.diff 173KB)


- Task 5 review: Spec ✅, quality Approved (reviewer a8946f419e0523dae, opus-tier). 0 Critical.
- Task 5: IMPORTANT (carried forward to Task 17, NOT a Task 5 defect — reviewer traced all consumers safe today): catalog.getFrozen().structuredSlots for a structured template is the MANIFEST-DEGRADED contract (Sets→arrays, schema test fns dropped). Every current consumer recompiles from YAML; NO code reads it as authority. MUST pin in Task 17 dispatch: structured runtime modules must reopen via loadTemplateDirectory/readFrozenTemplate (recompile), never trust getFrozen().structuredSlots internals.
- Task 5: minor (deferred): task-store.readFrozenTemplate maps runtime-unavailable → TASK_CORRUPTED for structured snapshots while disabled (acceptable — no production structured snapshots exist; consider distinguishing runtime-unavailable from corruption in future).
- Task 5: minor (deferred): post-Seal v2 agent declaring slotCapabilities not rejected (design §11.4 "不得声明任何 Slot capability") — inert today; add empty-ceiling check for v2.
- Task 5: minor (deferred): Task 4 contract errors masked to generic TEMPLATE_INVALID (map to TemplateError with location slots/contract.yaml).
- Task 5: minor (deferred): runNext v3 guard STRUCTURED_TURN_NOT_RUNNABLE lacks direct test.
- Task 5: minor (deferred): structured-pipeline-validator.test duplicates CANDIDATE_PROFILE_LIMITS_V1 instead of importing.
- Task 5: minor (deferred): productionMode:null treated as basic (spec says missing=basic; null harmless strictness nit).
- Task 5: complete (commits 7987c70..1f6a1b3, review clean, 1 important carried-to-Task-17 + 6 deferred minors)

## Task 6: Atomic TaskEvent Batches and Structured Event Union

- BASE: 1f6a1b3
- Implementer: TBD (sonnet-tier)
- Dispatch notes: brief task-6-brief.md; appendBatch/readBatchByCommitId; batch file <first>-<last>-<commitId>.batch.json; preserves append() + legacy; structured event union from spec §7.4.


## Task 6 (cont.)

- Implementer agent: af7f024ba029119f4 (sonnet-tier)
- Dispatch notes: six structured event members to task-events union (spec §7.4); appendBatch + readBatchByCommitId (spec §7.3); batch file <first>-<last>-<commitId>.batch.json; preserves legacy append(); mixed-read flattening; IDEMPOTENCY_CONFLICT; crash-window tests.


## Task 6 (cont.)

- HEAD: b0b3f34 ; commit "feat: add atomic task event batches" (7 storage files +1237/-10)
- Harness re-verify: focused 90/90 pass; npm run check clean; full suite 80 files/1508 green
- Implementer concern: new error codes (IDEMPOTENCY_CONFLICT/EXPECTED_SEQUENCE_MISMATCH) not yet in api/router STATUS_BY_CODE — out of scope (no HTTP route calls appendBatch yet); a future API task should map them to 409
- Review: reviewer aa0c9edb635234538 (sonnet-tier) dispatched (1f6a1b3..b0b3f34, review-1f6a1b3..b0b3f34.diff)


- Task 6 review: Spec ✅, quality Approved (reviewer aa0c9edb635234538). 0 Critical, 0 Important.
- Task 6: minor (deferred): missing content key on fill_draft_terminal / missing supersedesGenerationId accepted as null (more permissive than exact; consistent with nullableString; flag to final review).
- Task 6: minor (deferred): duplicate commitIds across batch files overwrite in batches Map (only reachable via tampering; suggest TASK_CORRUPTED on second file — robustness, flag to final review).
- Task 6: minor (deferred): batch↔legacy separation one-directional for adversarial legacy eventIds (inherent to naming scheme; documented).
- Task 6: minor (deferred): CommittedEvent.size for batch members = envelope length (docstring cosmetic).
- Task 6: complete (commits 1f6a1b3..b0b3f34, review clean, 4 deferred minors)

## Task 7: Structured Blob, Generation, Draft, Attempt Storage

- BASE: b0b3f34
- Implementer: TBD (sonnet-tier)
- Dispatch notes: brief task-7-brief.md; blob-store (content-address, indexed generation 10k), private-store (journal/checkpoint, idempotent by turnId, no private terminal before authority), state projection (TaskEvents authoritative).


## Task 7 (cont.)

- Implementer agent: ac1bf56e475a7927b (sonnet-tier)
- Dispatch notes: blob-store content-address + indexed generation (10k, single byte-range read proof); private-store journal/checkpoint (128 ops / 1 MiB), idempotent by turnId, post-lock reject, NO private terminal as authority (event-derived reconciliation); state projection from events only.


## Task 7 (cont.)

- HEAD: 2ba7398 ; commit "feat: persist structured slot state" (11 files +2462/-5)
- Harness re-verify: focused 28/28 pass; npm run check clean; full suite 83 files/1539 green
- Implementer concerns: private-store mutations assume per-task mutex (same as EventStore); whole-file NDJSON integrity verified at blob-read time not per slot read (would defeat single-range guarantee)
- Review: reviewer aab6c227fe320389a (sonnet-tier) dispatched (b0b3f34..2ba7398, review-b0b3f34..2ba7398.diff 108KB)


- Task 7 review: Spec ✅, quality Approved WITH 1 Important finding + 8 minors (reviewer aab6c227fe320389a).
- Task 7: IMPORTANT (enter fix loop): structured-slot-blob-store.ts computeMaxDepth recurses depthOf(parent)+1 unbounded — self-cycle or dangling parent → raw RangeError stack overflow, not stable StorageError. Fix: bound depth to slotCount or iterative walk with visited set; throw INVALID_INPUT on cycle/dangling; add covering test.
- Task 7: minor (deferred): duplicate slotIds last-win in index (self-consistency check still passes; gate should reject).
- Task 7: minor (deferred): proposal abandonment any-match over whole bound turn (epoch-agnostic; plan-mandated one-attempt-per-turn; flag integration).
- Task 7: minor (deferred): torn-line skip only covers final journal line (trailing-newline garbage case).
- Task 7: minor (deferred): byte-threshold measured pre-append (whichever-first approximation).
- Task 7: minor (deferred): readSlot can't detect in-place byte flip staying canonical same-slotId (documented integrity gap at hot path).
- Task 7: minor (deferred): readDraft returns live overlay Map (harmless; each read rebuilds).
- Task 7: minor (deferred): projection doesn't validate supersedesGenerationId vs active (later commit flow).
- Fix round 1/5: resume implementer ac1bf56e475a7927b with the computeMaxDepth finding.


- Task 7 fix round 1: implementer ac1bf56e475a7927b fixed (commit 9ef053a "fix: fail closed on cyclic generation parent graphs" — iterative parent walk + visited path, INVALID_INPUT on self-cycle/dangling, validation moved before disk write; 3 new covering tests incl valid 5000-deep chain). Harness re-verify: 11/11 + check clean. Noted: pre-existing flaky api.integration.test.ts timing test (passed on isolated + final re-run, unrelated).
- Scoped re-review: reviewer add75774697d4158a dispatched (2ba7398..9ef053a).


- Task 7 fix round 1/5: ADDRESSED (re-reviewer add75774697d4158a) — iterative walk, no RangeError path, INVALID_INPUT on cycle/dangling, validation before disk write; no new breakage. Caveat (deferred minor): self-cycle/dangling tests masked by root-presence check (fixtures lack root slot); observable contract asserted, but branches lack effective regression test — could strengthen with root+cycle/root+dangling fixtures.
- Task 7: complete (commits b0b3f34..9ef053a, review clean after 1 fix round; 8 deferred minors + 1 fix-caveat minor)

## Task 8: Validator and Assembler Sandbox Engine

- BASE: 9ef053a
- Implementer: TBD (sonnet-tier)
- Dispatch notes: brief task-8-brief.md; refactor GateRunner sandbox mechanics into shared primitive (keep public behavior + tests unchanged); evaluator-runner ABI; validation-engine Gate accounting + aggregate budgets; Seal always all-applicable.


## Task 8 (cont.)

- Implementer agent: a80b3b20214699f25 (sonnet-tier)
- Dispatch notes: evaluator-runner ABI (frozen globals, no nondeterminism, stream-measure bytes before normalization, dispose timed-out isolate); validation-engine Gate accounting (stable target order, preflight overflow → zero validators + incomplete, stream-measure CPU/wall/output/issues, blocking/advisory enforcement, Seal all-applicable, {verdict, usage}); gate-runner refactor keeps public behavior + tests unchanged.


## Task 8 (cont.)

- HEAD: e8e7086 ; commit "feat: run structured slot evaluators" (6 files +2249/-77: isolated-sandbox.ts shared primitive + evaluator-runner + validation-engine + tests; gate-runner refactored)
- Harness re-verify: focused 72/72 pass; npm run check clean; full suite 1588 green (one pre-existing api.integration timing flake re-run OK)
- Implementer concerns: runAssembler not yet wired into runSealGate (later Seal/custody task); cpuTime ns → /1e6 (Task 9 benchmark uses same unit); abort at iteration boundaries; preflight covers count+invocations+declared CPU, wall/output runtime-monitored
- Review: reviewer afd17a28131305bdc (sonnet-tier) dispatched (9ef053a..e8e7086, review-9ef053a..e8e7086.diff 102KB)


- Task 8 review: Spec ❌ — 1 Important + 4 minors (reviewer afd17a28131305bdc). Task quality: Needs fixes.
- Task 8: IMPORTANT (fix loop): validation-engine.ts blocking validator `{pass:false, issues:[]}` → code=VALIDATOR_REJECTED but no issue pushed, buildVerdict sees zero errors → status passed (FAIL-OPEN). Fix: when pass===false ALWAYS push one VALIDATOR_REJECTED/VALIDATOR_ADVISORY issue (empty details when no issues); add covering test.
- Task 8: minor (deferred): CPU meter excludes module compile/top-level time (sample before compile to bill Task 11 meter).
- Task 8: minor (deferred): subtree projection BFS not document order — design E02 does not mandate ordering for envelope tree projection; fixtures 2-level so untested; flag final review.
- Task 8: minor (steering to Task 16): ASSEMBLER_* codes allow only phase 'assemble' in registry — the seal/custody task wiring runAssembler MUST use phase 'assemble' or extend registry, else makeStructuredIssue throws.
- Task 8: minor (deferred): GateRunner call-time syntax error now GATE_RUNTIME_ERROR (unobservable, arguably more correct).
- Fix round 1/5: resume implementer a80b3b20214699f25 with the fail-open finding.


- Task 8 fix round 1: implementer a80b3b20214699f25 fixed (commit 8c67c4f "fix: never fail open on a silent validator rejection" — pass:false ALWAYS emits VALIDATOR_REJECTED/VALIDATOR_ADVISORY with empty-details fallback; +2 covering tests). Harness re-verify: validation-engine+evaluator-runner 48/48, check clean.
- Scoped re-review: reviewer aecc3ea80570f467c dispatched (e8e7086..8c67c4f).


- Task 8 fix round 1/5: ADDRESSED (re-reviewer aecc3ea80570f467c) — pass:false ALWAYS emits VALIDATOR_REJECTED/ADVISORY, result.pass authoritative, both covering tests present, no new breakage.
- Task 8: complete (commits 9ef053a..8c67c4f, review clean after 1 fix round; 4 deferred minors; steering note for Task 16: ASSEMBLER_* codes allow only phase 'assemble')

## Task 9: Benchmark Harness and Provisional Platform Profile v1

- BASE: 8c67c4f
- Implementer: TBD (sonnet-tier)
- Dispatch notes: brief task-9-brief.md; provisional profile JSON (status provisional, null evidenceDigest); reference-runner descriptor on THIS host; primitive benchmark cases; IntegratedBenchmarkCasesV1 injected interface (no static imports of Task 10/16); smoke mode only; capability manifest stays disabled.


## Task 9 (cont.)

- Implementer agent: a7dd3a82707cf87a1 (sonnet-tier)
- Host identity (designated reference runner): Node v22.22.3, V8 12.4.254.21-node.56, darwin arm64, Apple M4, 10 cores, 16384 MiB
- Dispatch notes: provisional profile exact JSON; IntegratedBenchmarkCasesV1 injected (no static Task 10/16 imports); primitive cases real; smoke mode only; capability validator rejects provisional; manifest disabled.


## Task 9 (cont.)

- HEAD: ca0e182 ; commit "perf: add structured slot benchmark harness" (8 files +1596/-88, exact brief list; manifest NOT touched)
- Harness re-verify: focused 40/40 pass; npm run check clean; full suite 86 files/1621 green; primitive-smoke runs exit 0 (machine-readable JSON)
- Smoke observations (Task 19 calibration inputs): 64 MiB content-root ~5.8s p50 / ~2.6GB peak RSS (above Task 19 2s acceptance — Task 19 concern); validator-fanout-10k ~10.7s (within 30s Seal bound); tree-match-10k ~0.84ms
- Review: reviewer a4f15c13d7fed7f61 (sonnet-tier) dispatched (8c67c4f..ca0e182, review-8c67c4f..ca0e182.diff 80KB)


- Task 9 review: Spec ✅, quality Approved (reviewer a4f15c13d7fed7f61). 0 Critical, 0 Important.
- Task 9: minor (deferred): smoke summary hardcodes runnerId/version/digest instead of reading checked-in descriptor (stale-identity risk if runner updated).
- Task 9: minor (deferred): `void adapter; void evidenceFacts;` dead weight.
- Task 9: minor (STEERING to Task 19): `--adapter` relative path resolves against script module URL not cwd — Task 19 must pass an absolute path or package specifier.
- Task 9: minor (deferred): assertTemplateLimitsWithinProfile doesn't self-document profile-validation assumption.
- Task 9: minor (deferred): 847-line script large but coherently organized (no split this task).
- Task 9: complete (commits 8c67c4f..ca0e182, review clean, 5 deferred minors)

## Task 10: Selector Resolution, Authorized Projection, Grants

- BASE: ca0e182
- Implementer: TBD (sonnet-tier)
- Dispatch notes: brief task-10-brief.md; grant-service (3 resolve fns + lifecycle), projection-service (listSlots/readSlot + ProjectionSubjectV1 agent|task_owner), selector resolution + precedingFilled, non-disclosure invariants, signed cursors.


## Task 10 (cont.)

- Implementer agent: ae7fdc8ae55fba0c1 (sonnet-tier)
- Dispatch notes: grant-service (structure/fill/seal resolves + lifecycle rejects), projection-service (listSlots/readSlot, ProjectionSubjectV1 agent|task_owner, D04/D05 non-disclosure, precedingFilled gated on read_slot_content capability), signed cursors (task-local secret not persisted).


## Task 10 (cont.)

- HEAD: 53ca989 ; commit "feat: resolve structured slot grants" (5 files +2166: grant-service 489, projection-service 573, tests, shared types 94)
- Harness re-verify: focused 40/40 pass; npm run check clean; full suite 88 files/1661 green
- Implementer concerns: shared/structured-slots.ts added to commit (brief's add list omitted it but task requires the types — legitimate); projection uses injected StructuredSlotDataSource seam (Task 12 session service must adapt the store); cursor secret in-memory per task (restart invalidates held cursors → fail closed); owner issue/SealRecord projection deferred to Task 18
- Review: reviewer a3e7f9c2b94bf9c4b (sonnet-tier) dispatched (ca0e182..53ca989, review-ca0e182..53ca989.diff 94KB)


- Task 10 review: Spec ✅, quality Approved (reviewer a3e7f9c2b94bf9c4b). 0 Critical, 0 Important.
- Task 10: minor (deferred): precedingFilled scan O(W·N) quadratic (bounded by scaffold limits; a running set-count would be O(N)).
- Task 10: minor (deferred): listSlots throws SLOT_MISSING_FROM_GENERATION (unstable code; slotId already visible; store integrity failure).
- Task 10: minor (deferred): createTaskLocalCursorSigner per-call not per-task — Task 12 MUST hold ONE signer per task or pagination breaks across requests.
- Task 10: minor (deferred): shell outline entries carry ancestor's own contentPresence (within D04; maximally-bare shell would drop it).
- Task 10: ⚠️ resolved: StructuredSlotDataSource seam — Task 12 must add thin public accessors on the Task 7 blob store (or adapt via projectStructuredSlotState + readEffectiveContent).
- Task 10: ⚠️ resolved: owner issue/SealRecord listing deferred to Task 18 (plan-confirmed boundary).
- Task 10: complete (commits ca0e182..53ca989, review clean, 4 deferred minors + 2 seams for Tasks 12/18)

## Task 11: Attempt Coordinator, Resource Meter, Deadline

- BASE: 53ca989
- Implementer: TBD (opus-tier — concurrency/CAS/epoch/meter/deadline persistence)
- Dispatch notes: brief task-11-brief.md; AgentTurnInput.slotSession required SessionHandle|null NOW; basic paths explicit null; six terminal status/reason pairs; crash recovery.


## Task 11 (cont.)

- Implementer agent: ac45199381e04c0ff (opus-tier)
- Dispatch notes: attempt-coordinator (CAS epoch allocation, turnId from inputNodeId+epoch, fill started+draft_opened one batch, six terminal pairs, terminalize, recoverDanglingAttempts); attempt-meter (persistent precharge/record/reserve/usage, exact-replay-only-free, composite abort signal, monotonic deadline never reset); AgentTurnInput.slotSession required SessionHandle|null with basic paths explicit null (agent-runtime, task-runner, test-support, pi-runtime-probe).


## Task 11 (cont.)

- HEAD: f3c4a33 ; commit "feat: coordinate structured attempts" (10 files +2237)
- Harness re-verify: focused 72/72 pass; npm run check clean; full suite 90 files/1686 green
- Implementer concerns: readEvents added seam beyond brief's literal param list (needed for CAS re-read loop); race-replay terminalize returns committed terminal via readBatchByCommitId; recoverDanglingAttempts leaves task_interrupted to Task 17 via companions seam
- Review: reviewer ae4d255794148cc03 (opus-tier) dispatched (53ca989..f3c4a33, review-53ca989..f3c4a33.diff 93KB)


- Task 11 review: Spec ✅, quality Approved (reviewer ae4d255794148cc03, opus-tier). 0 Critical, 0 Important.
- Task 11: minor (deferred): fractional validator aggregates (cpuMs 12.5) persist but snapshot parse requires int → METER_SNAPSHOT_INVALID bricks continuation (fails closed but spurious; align read/write).
- Task 11: minor (carry to Task 14): recordToolResult push-if-missing is a latent meter-bypass — Task 14 MUST always precharge before recording.
- Task 11: minor (carry to Task 14/15): charges gate on closed+deadline but not composite signal.aborted (post-stop charging) — Task 14/15 must check meter.signal.aborted before charging.
- Task 11: minor (deferred): METER_INVALID_INPUT raw string not in METER_ERROR_CODES.
- Task 11: minor (carry to Task 17): terminalize race loser returns only single terminal entry, not winner full batch — Task 17 callers must readBatchByCommitId(${turnId}-terminal) to learn outcome.
- Task 11: minor (carry to Task 17): replay-while-active returns active attempt identities even if requested sessionKind differs (draftContext silently discarded) — surface sessionKind in StartAttemptResult.
- Task 11: minor (carry to Task 15): deadline anchor = meter construction monotonic time, not literal attempt_started event timestamp — Task 15 must create meter immediately after start batch commits.
- Task 11: minor (deferred): clock/companions seams untested (gain coverage at Task 17 wiring).
- Task 11: complete (commits 53ca989..f3c4a33, review clean, 7 deferred minors + 4 wiring notes for Tasks 14/15/17)

## Task 12: StructureProposal Session and Tools

- BASE: f3c4a33
- Implementer: TBD (sonnet-tier)
- Dispatch notes: brief task-12-brief.md; proposal-service (5 structure ops, whole-tree replacement, deterministic slotIds from scaffoldId+generationId+instancePath NOT clientKey, candidate lock, safe receipt); session-service (structure session state + dispatch guard); adapt Task 7 store to StructuredSlotDataSource seam (Task 10 note); hold ONE cursor signer per task (Task 10 note).


## Task 12 (cont.)

- Implementer agent: a54f47be2da8be3c0 (sonnet-tier)
- Dispatch notes: proposal-service (5 structure ops, storage-safe put, advisory validate, submit = full Gate + deterministic slotIds from scaffoldId+generationId+instancePath NOT clientKey, candidate lock, safe receipt {kind,status,changeCount,issueSummary}); session-service (structure session state + assertStructuredForgeAction guard foundation + lifecycle by event reconciliation); adapt Task 7 store to StructuredSlotDataSource seam (Task 10 note).


## Task 12 (cont.)

- HEAD: 7e9cfbd ; commit "feat: add structure proposal sessions" (6 files +2086/-2; blob-store +9 seam accessors, private-store +49 candidate journal op/checkpoint)
- Harness re-verify: focused 29/29 pass; npm run check clean; full suite 92 files/1715 green
- Implementer concern (carry to Task 15): slotId derivation needs a scaffoldId at submit time that a first session lacks — submit takes internal SubmitStructureContext {scaffoldId, generationId}; candidate stores generationId but NOT scaffoldId; Task 15 committer must reproduce the same identity via exported deriveSlotId
- Review: reviewer a58cc89a3ca2b31d2 (sonnet-tier) dispatched (f3c4a33..7e9cfbd, review-f3c4a33..7e9cfbd.diff 100KB)


- Task 12 review: Spec ✅, quality Approved (reviewer a58cc89a3ca2b31d2). 0 Critical, 0 Important.
- Task 12: minor (deferred, flag final review): assertStorageSafeTree/runStructureGate walk recursion can RangeError on adversarial deep tree (legit trees bounded by maxTreeDepth 8; short-circuit inside walk is the fix — same pattern as Task 7's fixed finding).
- Task 12: minor (carry to Task 14): grant.capabilities never consulted in proposal ops — capability gating should live in the Task 14 tool adapter.
- Task 12: minor (carry to Task 15): scaffoldId in SubmitStructureContext at submit must equal the scaffold the generation commits to, or blob-store slotIds won't line up (cross-task contract note).
- Task 12: minor (deferred): storeProposalCandidate validates only isPlainObject (defensive only).
- Task 12: complete (commits f3c4a33..7e9cfbd, review clean, 4 deferred minors + 2 carry notes for Tasks 14/15)

## Task 13: FillDraft Overlay and Merge Candidate

- BASE: 7e9cfbd
- Implementer: TBD (sonnet-tier)
- Dispatch notes: brief task-13-brief.md; draft-service (7 fill ops, overlay semantics, Merge Gate, no-op candidate, lifecycle via event reconciliation); session-service extended with fill ops; meter charge before authorization; never write merged/stale/abandoned as private authority.


## Task 13 (cont.)

- Implementer agent: afb855c8c80026294 (sonnet-tier)
- Dispatch notes: draft-service (listSlots/readSlot via Task 10 projection with overlay, replace/unset batch all-or-nothing, meter BEFORE authorization, Merge Gate via Task 8 engine, no-op candidate semantics, lifecycle via event reconciliation); session-service extended with fill session + fill dispatch guard.


## Task 13 (cont.)

- HEAD: 65e05df ; commit "feat: add fill draft sessions" (5 files +2003/-29; private-store +55 MergeCommitCandidate/storedDraftCandidate/DraftView.candidate)
- Harness re-verify: focused 35/35 pass; npm run check clean; full suite 93 files/1742 green
- Implementer concerns (carry): (1) Task 14 — raw tool_execution_start precharge seam + draft-service's own precharge could double-charge schema-valid calls; Task 14 must inject a consume-only adapter or precharge only non-executed calls; (2) maxValidationRunsPerAttempt/validator aggregates reserved for Task 15/17 committer/coordinator; (3) list_slots outline shows base presence (projection listSlots takes no overlay — acceptable)
- Review: reviewer a9e2862249c16030f (sonnet-tier) dispatched (7e9cfbd..65e05df, review-7e9cfbd..65e05df.diff 107KB)


- Task 13 review: Spec ❌ — 1 Important + 3 minors + 3 security ⚠️ (reviewer a9e2862249c16030f). Task quality: Needs fixes.
- Task 13: IMPORTANT (fix loop): buildEffectiveSlots feeds Merge Gate stale base content for baseRevision>0 — gate base for unchanged slots comes from generation-manifest slot records (revision-0 era), not the content root at the draft's base revision; after any prior merge, a later fill (baseRevision>=1) validates against wrong invariants. Fix: build gate input from readEffectiveContent(active.content) merged over generation structure (mirror stageContentRoot's base handling); also removes latent stageContentRoot null-content edge. All current tests use baseRevision 0 → add a baseRevision>=1 test.
- Task 13: minor (deferred): assertFillGrant weaker than draft-service assertGrant (add scaffoldId + baseRevision checks).
- Task 13: minor (deferred): dead DRAFT_ALREADY_SUBMITTED branch (candidate always stored before lock).
- Task 13: minor (carry to Task 14): narrow submit crash-window double-charge (precharge before candidate replay) — plan-mandated precharge-before-auth seam.
- Task 13: security ⚠️ (carry to Task 14/15/17): (1) fill grant issuance gate — no create_grant minting, token/injection-only, fill tool admin; (2) writable-scope derivation excludes hidden (pre-existing Task 10 resolveWriteScope — Task 10 review confirmed D04/D05; confirm integration); (3) fill engine single-writer while fill active (Task 14/15 integration).
- Fix round 1/5: resume implementer afb855c8c80026294 with the stale-base finding.


- Task 13 fix round 1: implementer afb855c8c80026294 fixed (commit c17a1be "fix: gate drafts against committed content at the active revision" — buildEffectiveSlots now resolves base from readEffectiveContent(active.content) merged over generation structure; fails closed on missing content root; stageContentRoot null-content edge fixed; covering test at baseRevision 1 with subtree validator seeing merged-title). Harness re-verify: draft-service+session-service 36/36, check clean.
- Scoped re-review: reviewer a53b523629a7d70ef dispatched (65e05df..c17a1be).


- Task 13 fix round 1/5: ADDRESSED (re-reviewer a53b523629a7d70ef) — gate base now from readEffectiveContent(active.content) merged over generation structure; null-content edge fails closed; covering test at baseRevision 1 (subtree validator sees merged-title, candidate baseRev 1/resultRev 2); no new breakage.
- Task 13: complete (commits 7e9cfbd..c17a1be, review clean after 1 fix round; 2 deferred minors + carry notes for Tasks 14/15/17)

## Task 14: Slot Tool Factory and Pi Runtime Integration

- BASE: c17a1be
- Implementer: TBD (opus-tier — Pi 0.82 SDK raw pre-validation seam, highest remaining risk)
- Dispatch notes: brief task-14-brief.md; forge-pi-slot-preflight/v1 raw-Agent subscription seam (required, three hand-written impls); TypeBox tool defs per kind, sequential, no engineering keys; progressive disclosure; dispatch guard; consume-only precharge (avoid double-charge with Task 13 draft-service); check meter.signal.aborted before charging.


## Task 14 (cont.)

- Implementer agent: a01b8d844cde3e526 (opus-tier)
- Dispatch notes: forge-pi-slot-preflight/v1 raw-Agent seam (required, 3 impls: production factory, ScriptedPiSession, probe wrapper); TypeBox tool defs per kind sequential no-engineering-keys; consume-only precharge (no double-charge with draft-service); meter.signal.aborted check; recordToolResult only precharged keys; capability gating in tool adapter; no grant minting; progressive disclosure; beforePropose hook; corrective prompt + compaction no-reset.


## Task 14 (cont.)

- HEAD: f2f893d ; commit "feat: expose structured slot tools" (13 files +2611/-36; tool-factory 855, pi-agent-runtime +213, draft-service +61 consume seam, attempt-meter +20, action-buffer +20, test-support +86, probe +3; + @earendil-works/pi-agent-core@0.82.0 exact devDep)
- Harness re-verify: Step 8 121/121 pass; npm run check clean; full suite 94/1779 green; pi-agent-core pin exact 0.82.0 consistent with lock family
- Implementer concern (carry to Task 17): Task 17 must wire production structuredSlot provider, submitStructureContext, seal SealToolOperations
- Review: reviewer a9f761031c1bd5d50 (opus-tier) dispatched (c17a1be..f2f893d, review-c17a1be..f2f893d.diff 163KB)


- Task 14 review: Spec ❌ — 2 Important + 6 minors (reviewer a9f761031c1bd5d50). Task quality: Needs fixes. No double-charge/meter-bypass in production wiring.
- Task 14: IMPORTANT (fix loop) #1: TypeBox coercion breaks consume key match → spurious NOT_PRECHARGED — raw precharge keys on raw model args (hash(123)), execute consume keys on validated/coerced params (hash("123")); Pi coerces 123→"123" for String schema; a schema-valid-after-coercion call is spurious-rejected. Fix: key consume on raw args (preflight records raw hash; adapter resolves precharge by toolCallId or coercion-tolerant comparison) + add a coerced-call characterization test.
- Task 14: IMPORTANT (fix loop) #2: request_seal exact replay re-runs the Seal Gate instead of replaying the recorded result (consumes validator budget, could differ). Fix: consumeReplay check after consume + replay test.
- Task 14: minor (deferred): duplicate PiSessionEventLike interface declaration (should have added isError? to original).
- Task 14: minor (deferred): lock-digest ABI assertion tautology (asserts slice length === 12, always passes; doesn't pin lock content).
- Task 14: minor (deferred): schema snapshot coverage partial (put_structure_proposal/unset_draft_content not exactly asserted).
- Task 14: minor (deferred): action-buffer beforePropose backstop never wired by runtime (dispatch guard enforced at forge-tool layer only; workspace/skill-section/validate_artifact tools bypass in structured turn — likely acceptable per §11.3, report wording overstated).
- Task 14: minor (deferred): fill-path business failures not recorded (structure path records; low likelihood Pi retries use new toolCallIds).
- Task 14: minor (deferred): no stable multi-page list_slots iteration test; structure precharge rejections return empty reason.
- Fix round 1/5: resume implementer a01b8d844cde3e526 with both findings.


- Task 14 fix round 1: implementer a01b8d844cde3e526 fixed (commit d3fdd88 "fix: consume precharge by toolCallId and replay request_seal" — consume resolves by toolCallId (exact-hash-first then most-recent pending), pre-charged hash threaded through every execute path; request_seal checks consumeReplay, returns recorded result on exact replay, fresh call re-runs gate; coerced fill-path test + real-loop Pi coercion characterization + seal replay gate-count tests). Harness re-verify: tool-factory+pi-agent-runtime 97/97, check clean.
- Scoped re-review: reviewer a105af0bfa719339c (opus-tier) dispatched (f2f893d..d3fdd88).


- Task 14 fix round 1/5: Finding 2 ADDRESSED; Finding 1 PARTIAL (re-reviewer a105af0bfa719339c) — single-call coercion fixed, but: (a) coerced call's EXACT REPLAY still spurious NOT_PRECHARGED (raw seam re-precharges raw key → replayed:true no pending entry; execute computes validated hash; exact match fails; pending fallback empty → fail closed); (b) wrong-consume hazard: toolCallId-only "most recent pending" fallback can consume an ORPHANED pending precharge (from earlier schema-invalid/truncated call, same toolCallId) instead of replaying the recorded result → journal corruption + wrong cached result later. Fix: replay-first branch for a recorded raw-hash entry (resolve replay by raw hash) and/or a pending-record lookup refusing keys never this call's charge; add a coerced exact-replay test (same coerced call twice → second replays recorded result, usage stays 1).
- Fix round 2/5: resume implementer a01b8d844cde3e526 with the residual.


- Task 14 fix round 2: implementer a01b8d844cde3e526 fixed (commit 79a3c90 "fix: resolve consume by the raw seam's current precharge" — AttemptMeter records current key in in-memory lastPrecharged (open meter only); consumeSlotToolPrecharge resolves by it when toolCallId matches → coerced exact replay returns recorded result, orphaned pending never consulted; exact-key fallback retained; missing precharge fails closed. Tests: fill coerced replay, orphan-hazard, real-loop coerced replay read_slot {slotId:123} twice usage 1). Harness re-verify: tool-factory+pi-agent-runtime 100/100, check clean.
- Scoped re-review round 2: reviewer a773a721688e2caef (opus-tier) dispatched (d3fdd88..79a3c90).


- Task 14 fix round 2/5: ADDRESSED (re-reviewer a773a721688e2caef, opus-tier) — prechargeRawTool records in-memory lastPrechargedKey (open meter only); consumeSlotToolPrecharge resolves by it when toolCallId matches; orphan fallback removed; coerced replay free on fill + real Pi loop; orphan-hazard test present; no new breakage. Out-of-scope notes (non-blocking): lastPrecharged never cleared (safe within sequential Pi loop); in-memory reset on fresh meter (raw seam always precharges first).
- Task 14: complete (commits c17a1be..79a3c90, review clean after 2 fix rounds; 6 deferred minors; wiring notes for Task 15/17: production structuredSlot provider, submitStructureContext, seal SealToolOperations)

## Task 15: Atomic Structured Commit (Structure, Fill, Rework, Human)

- BASE: 79a3c90
- Implementer: TBD (opus-tier — completion signature preflight + atomic batch authority)
- Dispatch notes: brief task-15-brief.md; prepareStructuredCommit + completion-signature commitId + readBatchByCommitId preflight; keep ActionCommitter.validateAndCommit sole authority; no recordCommitFailure on v3; no private terminal before appendBatch; carry: deriveSlotId scaffoldId reproduction (Task 12), meter right after start batch (Task 11), submitStructureContext wiring (Task 14).


## Task 15 (cont.)

- Implementer agent: aa3ccd38f1be16dbc (opus-tier)
- Dispatch notes: structured-committer prepareStructuredCommit + completion-signature commitId + readBatchByCommitId preflight before event construction; ActionCommitter.validateAndCommit sole authority, productionMode branch (basic byte-for-byte, no recordCommitFailure on v3, no private terminal before batch); task-runner structured commit wiring; carries: deriveSlotId scaffoldId reproduction, meter right after start batch, submitStructureContext/SealToolOperations wiring.


## Task 15 (cont.)

- HEAD: a2ace9b ; commit "feat: commit structured slot candidates atomically" (8 files +2579/-11; structured-committer 1232, tests, action-committer +78, task-runner +7, blob-store +72 idempotent putGeneration + readContentRevisionRef, private-store +9 proposal waiting_human)
- Harness re-verify: Step 8 119/119 pass; npm run check clean; full suite 1804 green
- Implementer concern (carry to Task 17): StructuredCommitError standalone — Task 17's structured runner will handle it (basic runner fails closed before it)
- Review: reviewer ab345ac6c8d57b7d0 (opus-tier) dispatched (79a3c90..a2ace9b, review-79a3c90..a2ace9b.diff 123KB)


- Task 15 review: Spec ✅, quality Approved (reviewer ab345ac6c8d57b7d0, opus-tier). 0 Critical, 0 Important.
- Task 15: minor (deferred, flag final review): idempotent putGeneration differing-digest path falls through to old manifest (latent fail-open, only reachable via caller bug; throw corrupt when digest differs).
- Task 15: minor (deferred): publicText not in completion signature (matches spec; Task 17 runner must treat committed events as authoritative).
- Task 15: minor (deferred): Step 5 replay test advances clock but no literal ID/random swap (ids deterministic); seal-rework/human tests leave synthetic fill draft unterminated (harness artifacts).
- Task 15: ⚠️ resolved: seal_rework/human/structure response-loss replay depends on Task 17 reconstructing the same sealDispatch/frozen candidate from turn state; committed generation slotIds vs candidate slotIdByClientKey equality enforced by submitStructureContext identity.
- Task 15: complete (commits 79a3c90..a2ace9b, review clean, 3 deferred minors + 2 wiring deps for Task 17)

## Task 16: Seal Gate, Assembler, Artifact Custody

- BASE: a2ace9b
- Implementer: TBD (opus-tier — seal tri-state + custody crash-window + event-backed artifact versions)
- Dispatch notes: brief task-16-brief.md; ArtifactStore.prepareStructuredVersion/promotePreparedVersion/recoverStructuredCustody; requestSeal tri-state + receipts; seal success batch in structured-committer; carry from Task 8: ASSEMBLER_* codes allow only phase 'assemble' (use it or extend registry).


## Task 16 (cont.)

- Implementer agent: a5e78b851769a5e07 (opus-tier)
- Dispatch notes: requestSeal tri-state (content identity, full Seal Gate + Assembler, passed→sealed candidate / reliable-failed→rework receipt / incomplete→no receipt); ArtifactStore prepare/promote/recover structured custody (event-backed, unreferenced-until-batch); seal success batch in structured-committer; ASSEMBLER_* phase 'assemble' note.


## Task 16 (cont.)

- HEAD: 374512e ; commit "feat: seal structured slot artifacts" (8 files +2596/-31; seal-service 648, artifact-store +555, structured-committer +312, tool-factory +49, atomic-file +6 ARTIFACT_INTEGRITY_FAILED)
- Harness re-verify: Step 7 51/51 pass; npm run check clean; full suite 96/1823 green
- Implementer concerns: atomic-file.ts committed beyond brief's add list (required for the new error code — legitimate); seal service runtime wiring (abort signal/rework target/dispatches) per-attempt via options consumed by Task 17 assembly; tool-factory request_seal seam unchanged
- Review: reviewer a1aebcde5b7157597 (opus-tier) dispatched (a2ace9b..374512e, review-a2ace9b..374512e.diff 139KB)


- Task 16 review: Spec ✅, quality Approved WITH 1 Important + 7 minors (reviewer a1aebcde5b7157597). 
- Task 16: IMPORTANT (fix loop): declaredDispatches never enforced at committer authority boundary (structured-committer.ts) — buildSealSuccessBatch gates seal_final only on finalSubmitters; determineCandidateKind gates publish/final only on sessionKind+passed; frozen declaredDispatches never consulted; assertSealDispatchAction (tool-factory) has zero production callers. A passed candidate whose turn declared only publish_artifact + action submit_final_artifact would be committed (task completed) if agent is template final submitter. Fix: committer checks context.sealDispatch.declaredDispatches.includes(action) in determineCandidateKind/buildSealSuccessBatch.
- Task 16: minor (deferred): byte-limit violations classify incomplete not failed (fail closed; semantic).
- Task 16: minor (deferred): manifest.json/seal-record.json not reserved for normal publishes → a file literally named that trips TASK_CORRUPTED (add to RESERVED_FILE_NAMES).
- Task 16: minor (deferred): content identity includes generationId/assemblerId beyond J06 (conservative; same-rev-different-gen different key reconciled by recovery).
- Task 16: minor (deferred): recovery checks artifactVersionRef.artifactId not .version.
- Task 16: minor (deferred): already-sealed idempotency returns passed receipt with no candidate (dispatch none; fail-closed but misleading).
- Task 16: minor (deferred): assertBatchMatchesSignature seal kinds don't verify terminal status / absence of final_submission_accepted in seal_publish.
- Task 16: minor (deferred): re-prepare generates fresh artifactId even for identical content (digest-reuse dormant).
- Fix round 1/5: resume implementer a5e78b851769a5e07 with the declaredDispatches finding.


- Task 16 fix round 1: implementer a5e78b851769a5e07 fixed (commit 6497835 "fix: enforce seal declaredDispatches at the commit boundary" — determineCandidateKind rejects publish/final not in frozen sealDispatch.declaredDispatches (DISPATCH_NOT_ALLOWED); buildSealSuccessBatch enforces defensively before disk mutation; covering test: undeclared submit_final rejected no-writes/no-completion even for template final submitter, declared publish commits). Harness re-verify: structured-committer+seal-service 29/29, check clean.
- Scoped re-review: reviewer ad06449452ae190da dispatched (374512e..6497835).


- Task 16 fix round 1/5: ADDRESSED (re-reviewer ad06449452ae190da) — declaredDispatches enforced in determineCandidateKind (DISPATCH_NOT_ALLOWED) + buildSealSuccessBatch defensively before disk mutation; covering test proves undeclared submit_final rejected no-writes for template final submitter; both gates coexist with finalSubmitters; no new breakage.
- Task 16: complete (commits a2ace9b..6497835, review clean after 1 fix round; 7 deferred minors; seal runtime wiring to Task 17)

## Task 17: Scheduler Lifecycle, Recovery, Atomic Human Answer

- BASE: 6497835
- Implementer: TBD (opus-tier — structured runNext full integration + readiness lifecycle + atomic answer + stop/recovery)
- Dispatch notes: brief task-17-brief.md; carry MANY wiring notes (see ledger Task 5/10/11/13/14/15/16): manifest-degraded contract → reopen via readFrozenTemplate; terminalize race loser → readBatchByCommitId; StartAttemptResult sessionKind; fill grant issuance gate + single-writer; production structuredSlot provider + submitStructureContext + SealToolOperations; StructuredCommitError handled; seal runtime wiring; one cursor signer per task; runtime env recheck threaded through CoreService/Scheduler; no env-var fallback; manifest stays disabled (Task 19 owns enable).


## Task 17 (cont.)

- Implementer agent: af660110b39859b82 (opus-tier)
- Dispatch notes: structured runNext (start Attempt before private object/Grant; fill coordinator-atomic started+draft_opened then materialize+Grant); runtime-readiness lifecycle (disabled vs injected enabled env threaded CoreService/Catalog/TaskStore/Scheduler, no env-var fallback); stop/recovery one-batch; atomic structured answer (request-ID-derived commitId, pre-read, human_answered+fresh input one batch, epoch 1); basic byte-for-byte; all carried wiring notes (manifest-degraded → readFrozenTemplate; terminalize race loser → readBatchByCommitId; StartAttemptResult sessionKind; fill grant issuance gate; single-writer; structuredSlot provider + submitStructureContext + SealToolOperations; StructuredCommitError; committed events authoritative; one cursor signer per task).


- Task 17 note: first implementer attempt (af660110b39859b82) interrupted by process exit before any work (tree clean at 6497835, no report). Re-dispatched fresh implementer aff89d8afee7da01c (opus-tier) with the same full brief + wiring notes.


- Task 17 note: re-dispatched implementer aff89d8afee7da01c stopped mid-implementation (partial uncommitted changes in core-service.ts/task-runner.ts/runtime-capability.ts; no commit, no report). Resumed via SendMessage with complete-the-task nudge; partial work preserved.


## Task 17 (cont.)

- HEAD: 39a8be3 ; commit "feat: run and recover structured slot attempts" (8 files +2288/-27; task-runner +1027, task-scheduler +458, core-service +42, runtime-capability +19)
- Harness re-verify: Step 8 115/115 pass; npm run check clean; full suite 96/1840 green
- Implementer concerns (flagged for reviewer): (1) TaskStore.readFrozenTemplate still maps TEMPLATE_RUNTIME_UNAVAILABLE → TASK_CORRUPTED; scheduler compensates by probing snapshot pipeline.yaml (task-store.ts outside brief list); (2) structured committer hardcodes retryable:false on agent_attempt_failed while RunNextResult.retryable drives auto-retry (display inconsistency?); (3) crash-after-start-batch Draft recreation covered by Task 11 coordinator tests not re-tested end-to-end
- Review: reviewer a1bf563052d3891a6 (opus-tier) dispatched (6497835..39a8be3, review-6497835..39a8be3.diff 128KB)


- Task 17 review: Spec ❌ — 1 Critical + 2 Important + 6 minors (reviewer a1bf563052d3891a6). Task quality: Needs fixes.
- Task 17: CRITICAL (fix loop): Seal Turns always fail SCAFFOLD_NOT_ACTIVE — runStructuredNext resolves active scaffold only for fill; buildStructuredBundle unconditional guard throws when null, reached by seal branch → every seal Turn starts then throws (leaks dangling attempt). Fix: resolve active scaffold for fill OR seal; add a seal end-to-end test.
- Task 17: IMPORTANT (fix loop): replayStructuredAnswer not anchored to pending request — scans all structured human_requested newest-first, continues past batch-less requests; after a second structured human cycle, answering B with different text → IDEMPOTENCY_CONFLICT, or A's text → silently replays A leaves B pending → waiting_human deadlock. Fix: stop at the first batch-less request newest-first (the one the answer addresses) and return 'none'; only a request with a committed batch replays/conflicts; add answer→re-request→second-answer test.
- Task 17: IMPORTANT (fix loop): projection layer still masks runtime-unavailable as corruption — TaskStore.readFrozenTemplate maps TEMPLATE_RUNTIME_UNAVAILABLE → TASK_CORRUPTED; scheduler compensation sound but durable gap remains (direct getWorkspace/listing/export + recoverInterruptedTasks silently skips). Fix: let TEMPLATE_RUNTIME_UNAVAILABLE propagate in task-store.ts (in scope as a necessary integration).
- Task 17: minor (deferred): retryable:false on committed agent_attempt_failed is display inconsistency not functional (scheduler auto-retry uses RunNextResult.retryable).
- Task 17: minor (deferred): crash-after-start-batch Draft recreation not re-tested end-to-end (Task 11 coordinator property).
- Task 17: minor (deferred): closeActiveStructuredAttempt multi-dangling edge (stale expectedTail → EVENT_ID_CONFLICT; normally one dangling).
- Task 17: minor (deferred): lifecycle event id inconsistency (deterministic vs randomUUID).
- Task 17: minor (deferred): task-runner +895 lines; assembleStructuredTurnInput duplicates basic assembly (byte-for-byte justification).
- Task 17: minor (deferred): seam cast not statically enforced (safe, synchronous fill, fail-closed).
- Fix round 1/5: resume implementer aff89d8afee7da01c with all three findings.


- Task 17 fix round 1: implementer aff89d8afee7da01c fixed (commit e84d6e9 "fix: seal scaffold resolution, answer anchoring, and runtime-unavailable propagation" — seal resolves scaffold for fill|seal; replayStructuredAnswer stops at first batch-less request newest-first; task-store propagates TEMPLATE_RUNTIME_UNAVAILABLE; +3 covering tests incl seal e2e + answer→re-request→second-answer). Harness re-verify: 139/139, check clean.
- Remaining concerns (deferred): retryable:false display inconsistency on committed agent_attempt_failed (scheduler auto-retry unaffected); task-listing still summarizes disabled structured as corrupt (listTasks isolates per-task projection failures by design; direct read/getWorkspace/export now surface TEMPLATE_RUNTIME_UNAVAILABLE).
- Scoped re-review: reviewer adb4e07f177a902b6 (opus-tier) dispatched (39a8be3..e84d6e9).


- Task 17 fix round 1/5: ADDRESSED (re-reviewer adb4e07f177a902b6, opus-tier) — seal scaffold resolved for fill|seal (SCAFFOLD_NOT_ACTIVE moved BEFORE startAttempt → no dangling leak); answer anchored to first batch-less request newest-first (no deadlock); TEMPLATE_RUNTIME_UNAVAILABLE propagates from task-store; matching regression tests; no new breakage. Out-of-scope: stale comment + pre-existing scheduler defensive probe.
- Task 17: complete (commits 6497835..e84d6e9, review clean after 1 fix round; 6 deferred minors; remaining: retryable:false display inconsistency + task-listing corrupt summary both deferred)

## Task 18: Read-Only Projection, REST, Gateway, UI

- BASE: e84d6e9
- Implementer: TBD (sonnet-tier)
- Dispatch notes: brief task-18-brief.md; five read-only REST endpoints (task_owner subject); TaskWorkspace.structuredSlots summary; five Gateway methods (HTTP + Mock + complete stub + shared contract suite); structured-slot-drawer read-only UI ("结构" toggle); exact TypeBox schemas; cursor-invalid 409; SLOT_NOT_VISIBLE stable envelope.


## Task 18 (cont.)

- Implementer agent: aae1b9096ae3fbe4a (sonnet-tier)
- Dispatch notes: five read-only REST endpoints (task_owner subject, exact TypeBox, cursor 409, SLOT_NOT_VISIBLE envelope, reject profile/principal query params); TaskWorkspace.structuredSlots summary (basic omits); five Gateway methods on ALL complete impls (HTTP/Mock/stub) + shared contract suite; read-only 结构 drawer (no write controls); register routes in central router.


## Task 18 (cont.)

- HEAD: 68c1da6 ; commit "feat: expose structured slots read only" (21 files +2977/-9; core-service +417 five endpoints, api-schemas +325, drawer 248, routes 155, task-projector +91)
- Harness re-verify: Step 7 proof 140/140 pass; npm run check clean; full suite 98 files/1885 green
- Implementer concerns (flagged for reviewer): (1) filledSlotCount event-derived cumulative-change approximation (exact presence in content blob); (2) owner-visible issues fold only stale-draft terminals (validation verdicts not persisted); (3) seal read via blob store (no projection-service seal method); (4) mock never simulates structured tasks (basic-only rejection)
- Review: reviewer a490a276318b4eaac (opus-tier) dispatched (e84d6e9..68c1da6, review-e84d6e9..68c1da6.diff 147KB)


- Task 18 review: Spec ✅ (5 endpoints/task_owner/leak-safety/gateway/UI verified) BUT 2 Important + 5 minors (reviewer a490a276318b4eaac). Task quality: Needs fixes.
- Task 18: IMPORTANT (fix loop) #1: filledSlotCount not the count of filled slots — task-projector sums changeCount of all merged drafts across ALL events (not scoped to active generation) + caps at visibleSlotCount → wrong in common cases (fresh generation with set content reports 0; double-count on two merges; superseded generations not reset while contentRevision IS reset). Design §18.3 allows "事件加可验证 blob" projection — compute filledSlotCount from the ACTIVE generation's content root referenced by events (exact set-count scoped to active generation). At minimum document the field semantics; better to make it accurate.
- Task 18: IMPORTANT (fix loop) #2: seal response not schema-validated server-side — core-service getStructuredSeal does JSON.parse(readBlob(sha256)) as SealRecord with no Value.Check + no kind==='seal_record' check. Fix: fail closed with SEAL_NOT_FOUND/INTERNAL_ERROR.
- Task 18: minor (deferred): deriveOwnerIssues iterates all events (superseded generations' stale drafts surface — defensible, add comment).
- Task 18: minor (deferred): drawer tree flat list (parentSlotId unused for hierarchy; aria-expanded no behavior).
- Task 18: minor (deferred): sealed-artifact link cosmetic (plain anchor, no overlay open).
- Task 18: minor (deferred): structuredReadFailure fallback maps unknown codes to CURSOR_INVALID (unreachable for fixed owner subject).
- Task 18: minor (deferred): server responses not Value.Check-ed before sendJson (client catches; seal is the one case — see Important #2).
- Fix round 1/5: resume implementer aae1b9096ae3fbe4a with both findings.


- Task 18 fix round 1: implementer aae1b9096ae3fbe4a fixed (commit e73e0f7 "fix: count filled slots from the active content root and validate seal records" — filledSlotCount = exact set-count of ACTIVE generation's content root referenced by events (design §18.3 event+blob), 0 when none, superseded merges no leak, route test asserts 2; getStructuredSeal checks kind==='seal_record' + Value.Check, fails closed SEAL_NOT_FOUND). Harness re-verify: routes+projector 40/40, check clean.
- Scoped re-review: reviewer af27ef56f04b83c07 dispatched (68c1da6..e73e0f7).


- Task 18 fix round 1/5: ADDRESSED (re-reviewer af27ef56f04b83c07) — filledSlotCount = exact set-count of active generation content root (event+blob derived, superseded-scoped, 0-when-none, route seed asserts 2); getStructuredSeal checks kind + Value.Check, fails closed 404; no new breakage.
- Task 18: complete (commits e84d6e9..e73e0f7, review clean after 1 fix round; 5 deferred minors)

## Full verification gate (before Task 19)

Running npm run check + npm test + npm run build + npm run e2e to confirm a green baseline before the qualification task.


## Full verification gate (result)

- npm run check: clean
- npm test -- --reporter=dot: 98 files / 1889 pass
- npm run build: passes (vite + tsc server)
- npm run e2e: 44 pass / 10 skipped (real-provider tests need a real API key; expected)
- Baseline green before Task 19.

## Task 19: Integrated Profile Qualification, Acceptance, Production Enable (SPECIAL GATE)

- BASE: e73e0f7
- Implementer: TBD (opus-tier)
- Dispatch notes: brief task-19-brief.md; Steps 1-5 offline work MUST complete (deterministic e2e fixture with injected matching enabled env, crash/replay, security scans, docs, disabled checkpoint commit); Step 6 integrated reference benchmark with REAL Task 10/16 adapters; NO fudging — if bounds fail at all 4 scales (100/75/50/25), no final profile, capability stays DISABLED, record exact measurements; Steps 7-10 only if a final profile can be frozen. Primitive smoke already showed 64 MiB content-root ~5.8s / ~2.6GB RSS vs 2s/512MiB acceptance — likely PARTIAL outcome with capability disabled.


## Task 19 (cont.)

- Implementer agent: adedfbf23df97ef3b (opus-tier)
- Dispatch notes: Steps 1-5 offline MUST complete (e2e fixture + acceptance script, crash/replay, security scans, docs, disabled checkpoint commit); Step 6 integrated benchmark honest (real adapters, 4 scales, no fudge — expected to fail the 512 MiB RSS bound → NO final profile → capability DISABLED → PARTIAL); Steps 7-10 only if final profile frozen.


## Task 19 (cont.)

- HEAD: 8c48b93 ; commit "test: qualify disabled structured slot runtime" (Step 5 checkpoint; manifest disabled + profile provisional)
- Harness re-verify: npm run check clean; npm test 99 files/1898 pass/1 skipped (production-default gate); npm run build pass; npm run e2e 44 pass/10 skip; verify:structured-slots --acceptance-only --capability injected exit 0; git diff --check OK; no placeholders; engineering-key scan only comments + internal types
- Step 6 integrated benchmark: HONEST FAILURE — no 100/75/50/25% scale satisfies all bounds; peak RSS ≈2.71 GB even at 25% (>512 MiB); content-root >2s at 100/75/50%. NO final profile frozen, NO release evidence, capability manifest stays DISABLED.
- Four real integration bugs found+fixed by the e2e acceptance (in 8c48b93): (1) tool-factory submit_structure_proposal post-lock journal write; (2) structured-committer buildSlotInstances sibling re-parenting (tree shape); (3) session-service data source never merging committed content revision; (4) fixture validator/assembler wrong CommonJS ABI shape.
- Failure evidence recorded in task-19-report.md (untracked file removed by harness to keep tree clean; measurements preserved in report).
- Task 19: PARTIAL (Steps 1-5 complete, Step 6 honest failure, Steps 7-10 not run, capability DISABLED) — production structured runtime capability final status: DISABLED.

## Final whole-branch review

- MERGE_BASE: 16c9e5b ; HEAD: 8c48b93
- Reviewer: strongest model (opus-tier), fresh agent
- Inputs: whole-branch review package + ledger deferred-minor/parked lines for triage.


## Final whole-branch review (cont.)

- Reviewer: a57c46fee2b8d8319 (opus-tier, strongest model) dispatched with whole-branch package (27 commits, 1.9MB) + full deferred-minor triage list.
- Waiting for verdict; then one fix dispatch + one scoped re-review if findings; then overnight-final-report.md.


## Final whole-branch review (verdict)

- Verdict: APPROVED_WITH_RECOMMENDATIONS (reviewer a57c46fee2b8d8319, opus-tier). 0 Critical, 0 Important. All 18 tasks complete + Task 19 PARTIAL (capability DISABLED, correct).
- FIX_BEFORE_HANDOFF: proposal-service tree-walk recursion RangeError (same class as fixed Task 7 finding).
- Minor findings: git diff --check vs merge base not clean (2 EOF blank lines — harness's earlier check only covered working tree, reviewer correct); structured runner bypasses ActionCommitter.validateAndCommit (two authority entry points — functionally equivalent, plan-conformance drift); meter snapshot fractional read/write misalignment (dormant); putGeneration differing-digest fail-open.
- Recommended cleanups: RESERVED_FILE_NAMES add manifest.json/seal-record.json; throw corrupt on differing-digest putGeneration; document meter + retryable:false contracts.
- needs-documentation: T1 F02 detailsSchema; T5 post-Seal v2 slotCapabilities; T16 RESERVED_FILE_NAMES (folded into fix wave).
- Fix wave: ONE unified fix agent a177903ce5a05e056 (opus-tier) dispatched with the full actionable list.


## Final fix wave

- Fix agent a177903ce5a05e056 applied all 5 items (commit 14596e9 "fix: apply final whole-branch review fixes to structured slot engine", 10 files +182/-17): proposal depth short-circuit (FIX_BEFORE_HANDOFF), trailing blank lines removed, RESERVED_FILE_NAMES + manifest.json/seal-record.json, putGeneration differing-digest → TASK_CORRUPTED, meter parser aligned to fractional aggregates + retryable comment.
- Harness re-verify: targeted 68/68; npm run check clean; git diff --check main...HEAD exit 0; tree clean; manifest untouched (disabled).
- Scoped re-review: reviewer a732dadb44e3dc3e7 (opus-tier) dispatched (8c48b93..14596e9).


## Final fix wave re-review (result)

- Scoped re-review (reviewer a732dadb44e3dc3e7, opus-tier): All 5 fix items ADDRESSED, no new Critical/Important breakage. Out-of-scope (non-blocking): post-walk maxDepth/nodes checks now dead code; gate short-circuit defense-in-depth duplicate issue for wide over-limit trees; orphaned content blob on differing-digest concurrent loser (pre-existing write ordering).
- Final full verification (harness): npm run check clean; npm test 99 files/1903 pass/1 skip; npm run build pass; npm run e2e 44 pass/10 skip; verify:structured-slots --acceptance-only --capability injected exit 0; git diff --check main...HEAD exit 0; tree clean; 28 commits (16c9e5b..14596e9).
- Final report written: .superpowers/sdd/2026-08-10-structured-slot-engine/overnight-final-report.md

## OVERALL RESULT

- Overall status: PARTIAL (Tasks 1-18 complete; Task 19 PARTIAL — production capability stays DISABLED due to honest Step 6 benchmark failure on this host's 512 MiB peak-RSS bound).
- Final HEAD: 14596e9 (28 commits from 16c9e5b). Tree clean. Branch + worktree + ledger + reports preserved for user.
- Production structured runtime capability: DISABLED.


## REOPENING — Codex independent acceptance findings (2026-08-11)

Codex 独立验收结论：Tasks 1-18 健康，但 Task 19 的 benchmark/evidence/promotion 存在阻断性缺陷，不得视为完整完成。

### Findings + owners + verification plan

- **P1-1 Benchmark RSS 隔离错误** (owner: Patch A implementer) — benchmark-structured-slots.ts 约 909/923/933 行用全局 state.peakRssBytes 判定各档 → 75/50/25% 全显示 2,714,386,432；measureCase 只在 unit 后采样 rss，捕获不到操作期间峰值。Fix: 每档在 fresh child process 隔离测量，child 用 process.resourceUsage().maxRSS（darwin bytes / linux KB→bytes 归一）+ 逐 unit 采样，每档只用自己的峰值判定；加回归测试证明前档高峰不污染后档。
- **P1-2 Integrated benchmark 双重缩放** (owner: Patch A implementer) — benchmark 主脚本 scaledLimits() 已缩放 limits，同时又传 scale；adapter buildBenchTask 约 86-90 行再乘 scale → 25% 档实际负载 6.25%。Fix: 单一缩放边界（adapter 收已缩放 limits，不再乘 scale）；case 描述/实际 bytes/slots/evidence frozenLimits 一致；加测试锁定 100/75/50/25% 真实负载。
- **P1-3 失败 qualification 仍可 promotion** (owner: Patch B implementer) — verify-structured-slots.ts 约 217-243 行无论 gate 全绿都写 release evidence；约 264-336 行 promotion 不校验 release exact schema/mode/完整 gate 集/exitCode===0。Fix: qualify 仅全绿后原子写 release evidence；失败产物不可被误认；promotion 独立 exact-validate 全部冻结契约，任一异常 fail closed；加负测（失败 gate/缺 gate/重复 gate/非零 gate/错误 mode/任意 JSON+匹配 digest 全被拒）。
- **P2 evidence 完整性** (owner: Patch A implementer) — benchmark 约 985-997 行 hardcode warmupCount/sampleCount/每 case samples/warmup=1/1/1/0，与真实 CaseDefinition 不符；state.diskBytes 未纳入真实磁盘量。Fix: 从真实运行结果生成 machine-readable metadata、raw sample digest、per-case warmup/sample、per-scale peak/disk，exact schema 校验。Task 19 report 声称 evidence 文件存在但实际被 harness 移除——修正报告/持久证据策略，失败证据必须真实存在且不丢失。

### 验证计划

1. Patch A（benchmark+adapter+evidence）实现 → 独立审查 A（对抗找 false pass/false fail）。
2. Patch B（verify 脚本 qualify/promote）实现 → 独立审查 B。
3. 独立对抗审查整个 Task 19 benchmark/evidence/promotion 区域。
4. Harness 亲自运行：focused regression、npm run check、npm test -- --reporter=dot、npm run build、npm run e2e、injected acceptance、locked Pi characterization。
5. 从干净 checkpoint 重跑 integrated qualification；若纠正后仍不满足冻结界限 → 诚实 provisional+disabled，保存准确失败证据，总体 PARTIAL；若全部门禁真实通过 → 按冻结 Plan 走 qualify/promote/production re-verify/enable commit。
6. 保持 basic v2 / 九动作 / closed Slot Tools / Seal custody / 原子性幂等资源门禁不回退。
7. 独立 whole-branch review；提交代码/测试/ledger/report；不 push/merge。


## Patch A (P1-1 + P1-2 + P2) — in progress

- Implementer agent: a057f52af8fd77626 (opus-tier)
- Scope: benchmark-structured-slots.ts (child-process per-scale isolation + evidence from real results), structured-integrated-benchmark-adapter.ts (remove double scaling), scripts/structured-evidence-schema.ts (exact profile-evidence validator), scripts/benchmark-structured-slots.test.ts (isolation + load-locking + evidence tests).
- Constraints: capability manifest stays disabled; frozen bounds unchanged; honest-failure path still writes failure evidence to docs/evidence/structured-slot-platform-profile-v1.json.


- Patch A note: implementer a057f52af8fd77626 interrupted mid-work (partial P1-2 fix in adapter, uncommitted). Resumed via SendMessage with continue-and-complete nudge.


## Patch A (cont.)

- HEAD: 6b2c60b "fix: isolate per-scale benchmark RSS and single-scale integrated load" (4 files +1173/-170)
- Harness re-verify: scripts/benchmark-structured-slots.test.ts 17/17 pass; npm run check clean; full npm test 100 files/1920 pass/1 skip; primitive-smoke exit 0; smoke integrated-qualify showed distinct per-scale peaks 2.67/2.79/2.61/2.12 GB (isolation proven) + exact-validated failure evidence written (untracked, allowlisted)
- Implementer concern: darwin Node 22 maxRSS empirically KB (not bytes) — implemented self-calibrating osMaxRssBytes (raw < currentRss → *1024), provably correct on both platforms
- Adversarial review: reviewer a52a48cc9a8e77f00 (opus-tier) dispatched (14596e9..6b2c60b, 79KB) focused on false pass/false fail


## Patch A review (adversarial)

- Reviewer a52a48cc9a8e77f00 (opus-tier): APPROVED — P1-1/P1-2/P2 genuinely fixed, no reachable false pass/fail. Empirical proof: distinct per-scale peaks 2.67/2.79/2.61/2.12 GB; load-locking tests fail against old double-scaling.
- IMPORTANT (fix loop): evaluateScaleReport silently passes a missing required case (`byId.get(id)?.p95Ms ?? 0`) — latent false-PASS if a future refactor drops content-root-64mib or seal-assembler-custody. Fix: assert byId.has(id) for all six required ids → violation; add regression test (report missing one required case must FAIL).
- Minor (fix): mid-loop child failure (exit 7) skips writing failure evidence → write a distinct failure evidence on error so evidence is never lost; seal/content-root descriptions hardcode "64 MiB" at lower scales → use actual MiB; candidatePercentage not constrained to {100,75,50,25} → enumerate; spawnSync default maxBuffer 1MiB → raise explicitly.
- Fix round: resume implementer a057f52af8fd77626.


- Patch A fix round: resumed implementer a057f52af8fd77626 with the Important missing-case guard + 4 minors (mid-loop failure evidence, actual-MiB descriptions, candidatePercentage enumeration, spawnSync maxBuffer).


- Patch A fix round: implementer a057f52af8fd77626 applied (commits 04422e5 + bf1f5c1 — missing-case guard + child_failed evidence + actual-MiB descriptions + candidatePercentage enumeration + spawnSync maxBuffer). Harness re-verify: 21/21, check clean, full 1924 pass; smoke integrated-qualify wrote no_scale_passed evidence (exit 6); bogus-adapter smoke wrote child_failed evidence (exit 7).
- Scoped re-review: reviewer a66b0e615285ed017 dispatched (6b2c60b..bf1f5c1).


## Patch A fix round re-review

- Reviewer a66b0e615285ed017: All 5 items ADDRESSED, no new Critical/Important breakage. Missing-case guard verified against real child report shape (no false positives); child_failed evidence validates; candidatePercentage enumerated; maxBuffer raised.

## Patch A COMPLETE

- Commits 6b2c60b + 04422e5 + bf1f5c1. P1-1/P1-2/P2 fixed, reviewed (APPROVED + fix round closed).
- Untracked failure evidence at docs/evidence/structured-slot-platform-profile-v1.json is the expected smoke artifact (allowlisted, not committed).

## Patch B (P1-3) — verify-structured-slots qualify/promote — in progress

- Implementer: TBD (opus-tier)
- Scope: runQualify writes release evidence ONLY after all gates pass (atomic); failure products never mistaken for release evidence; runPromoteCapability independently exact-validates release/profile evidence (schemaVersion/mode/complete gate set/no dup/no missing/exitCode 0/digests/requiredAbis), any anomaly fail closed; negative tests (failed gate/missing/duplicate/non-zero/wrong mode/arbitrary JSON+matched digest all rejected); make script testable (guard main() on direct execution, export functions).


## Patch B (cont.)

- Implementer agent: a669a47618bf430a3 (opus-tier)
- Dispatch notes: qualify writes release evidence ONLY after all gates pass (atomic, .failed marker on failure); promote exact-validates release evidence schema (schemaVersion/gate/mode/gates set/exitCode 0/digests/requiredAbis) + profile-evidence mode==='integrated-qualify' before any digest cross-check; direct-execution guard + exported functions for testability; negative tests (failed/missing/duplicate/non-zero gate, wrong mode, arbitrary JSON+matched digest, no_scale_passed/child_failed evidence all rejected).


## Patch B (cont.)

- HEAD: 4d94a96 "fix: gate release evidence on all qualify gates and exact-validate promotion" (3 files +878/-68: verify script +275, evidence-schema +119, test +552)
- Harness re-verify: verify-structured-slots.test.ts 25/25; npm run check clean; full 101 files/1949 pass/1 skip; verify:structured-slots --acceptance-only --capability injected exit 0; git diff --check clean
- Implementer concerns: checkpointCommit 40-or-64-hex (SHA-1 repo); happy-path promote test injects porcelain ()=>[] (test-only, allowlist logic unchanged in production); untracked failure evidence left untouched
- Adversarial review: reviewer a9b07148d6bb9f84d (opus-tier) dispatched (bf1f5c1..4d94a96, 53KB)


- Patch A flaky-test finding (harness full-verification): scripts/benchmark-structured-slots.test.ts "a no-alloc child after a 512 MiB allocator stays far below it" — `Buffer.alloc(512MiB, 1)` did not reliably commit physical pages on this host (child peak ≈498 MiB < the 512 MiB assertion). Test-reliability bug, not an isolation-mechanism bug. Fix: alloc-probe must force-touch pages (write pattern loop / larger alloc e.g. 1 GiB) and the assertions must prove the RELATIVE isolation gap (small child < 256 MiB AND small << big) rather than an absolute big>512MiB that overcommit can defeat.
- Fix round: resume Patch A implementer a057f52af8fd77626.


## Full verification gate (after Patches A+B + flaky fix)

- npm run check clean; npm test 101 files/1949 pass/1 skip; npm run build ✓; npm run e2e 44 pass/10 skip; verify:structured-slots --acceptance-only --capability injected exit 0; git diff --check clean.
- Flaky-test fix: commit 9ef95b4 (alloc-probe force-touches 1 GiB pages, margin-based assertions).
- Patch B review: APPROVED (no Critical/Important; 5 minors all non-blocking).

## Holistic Task 19 chain adversarial review — in progress

- Reviewer a2a14a39774fc93d7 (opus-tier) auditing benchmark evidence → qualify → promote → enable + digest chain for false pass/false fail.


## Integrated qualification re-run (corrected benchmark) — RESULT

- From HEAD 9ef95b4 (clean checkpoint, only allowlisted untracked failure evidence).
- Per-scale child peaks: 100% 2,735,226,880 / 75% 2,838,052,864 / 50% 2,857,517,056 / 25% 2,269,495,296 bytes — DISTINCT (isolation proven in the real run).
- All scales FAIL: peak RSS >512MiB at every scale; content-root-64mib >2s at 100/75/50%; authorized-projection-500-issues >250ms at all scales (incl 25%); seal-assembler-custody fails only at 100%.
- outcome=no_scale_passed, exit 6; failure evidence written (now exists) at docs/evidence/structured-slot-platform-profile-v1.json (untracked, allowlisted).
- Profile provisional + evidenceDigest null; manifest disabled. qualify exit 1 (refuses), promote exit 2 (refuses).
- Capability FINAL status: DISABLED. Task 19 = PARTIAL (honest).

## Final whole-branch review (reopened) — in progress

- Reviewer a538957a8636b10ac (opus-tier) with whole-branch package (33 commits, 2MB) verifying reopen closure + no regression + honest PARTIAL + chain audit + deferred-minor triage.


## Final whole-branch review (reopened) — VERDICT

- Reviewer a538957a8636b10ac (opus-tier): **APPROVED**. Reopen closed (P1-1/P1-2/P1-3/P2 all genuinely fixed), no regression to Tasks 1-18 (REOPEN commits touch only scripts/, 0 src/ changes; suite +2 files/+46 tests exactly matching the two new test files), honest PARTIAL with capability DISABLED, chain CLEAN (digest DAG no upstream-hashes-downstream), no new load-bearing deferred items. Minor #1: stale task-19 report §2 (now marked superseded by §9).
- Final recommendation: Hand off as-is. Do not enable capability on this host. Recovery path documented.

## OVERALL RESULT (REOPEN CLOSED)

- Overall status: PARTIAL (Tasks 1-18 complete + unaffected; Task 19 PARTIAL — production capability stays DISABLED; corrected benchmark honestly fails all four scales on this host: distinct per-scale peaks 2.74/2.84/2.86/2.27 GB, all >512MiB; 25% also fails 500-issue projection >250ms).
- Final HEAD: 9ef95b4 (33 commits from 16c9e5b). Tree clean except allowlisted untracked failure evidence.
- Production structured runtime capability: DISABLED (manifest disabled, profile provisional, qualify/promote correctly refuse).
- Accurate failure evidence preserved at docs/evidence/structured-slot-platform-profile-v1.json (real, exact-validated).


## Task 19 qualification performance remediation (2026-08-11, new round)

### 权威顺序（已由 harness 重新核对）

1. DESIGN §25-26；2. Spec；3. Plan；4. ledger；5. 当前实现与测试。
HEAD 复核：5cfbfe0（当前 HEAD 与已知一致），工作树仅未跟踪失败证据（允许清单内，benchmark 可重写，不手工删除）。

### 独立诊断确认的根因

1. primitive smoke：schema/grammar/tree 后 RSS ~98MB；64MiB content-root canonicalization 后 RSS ~3.06GB；10k validator fanout 未再推高 → 内存根因是大字符串 canonical JSON 路径，非 isolated-vm fanout。
2. canonical-json.ts serializeString 逐字符 `out +=` → 大字符串巨量中间表示（O(n²)）。
3. blob-store 多处先 canonicalJsonBytes(value) 再 canonicalJsonSha256(value) → 同一载荷完整规范化两次。
4. 同一机器 64MiB 用原生单次 JSON 编码 + Buffer + SHA-256 仅 ~173ms / RSS ~380MB → 512MiB 门槛可达。
5. 500 issue 纯 projectStructuredVerdict p95 ~0.22ms；integrated case 25% 档 ~316ms；同 adapter 连续执行 245/60/57ms → 冷启动、generation index 重复读取、槽读取、内容全量 hydration 混入 projection。

### 绝对禁止（本轮）

- 不得提高/删除 512MiB、2s、250ms、30s 冻结门槛。
- 不得删除真实 case、减少固定 10k tree/fanout 负载、伪造 evidence。
- 不得手工把 capability 改为 enabled；不得加环境变量/后门/绕过 Loader。
- 不得削弱 sandbox 隔离、安全校验、原子性、幂等、权限投影。
- 不得 reset/clean/push/merge/改 main；不得覆盖无关改动。
- 不得仅凭测试绿色宣称 production-ready。

### 任务拆分（每 Task：独立实现 Agent → 独立 Spec Reviewer → 独立 Code Quality Reviewer → 修复回环 → 双审通过 → proof → 提交 → ledger）

- Task A：锁定失败回归（大载荷 canonical JSON 子进程性能/RSS 回归 + 锁定现有 digest/JCS 语义 + projection 冷/热/纯测量分离）。
- Task B：修复 canonical JSON（O(n) 字符串序列化，保留 JCS 遍历/键序/数字/非法校验，不得整体替换 JSON.stringify）+ 一次规范化同时得 bytes+sha256 + blob-store 各路径只编码一次；旧 digest/vector 完全一致。
- Task C：修复投影/Seal N+1 I/O（GenerationIndex 按 generationId 缓存；presence/digest 映射与 content hydration 分离；listSlots 只读元数据；readSlot 只加载目标；Seal 批量/流式 generation 读取；有上限并发）。
- Task D：校准 benchmark 真实边界（500 issue ≤250ms 精确测授权 verdict projection；冷/热 outline 作独立诊断；合理 warmup+多样本；总 child peak RSS 仍为 512MiB 权威门禁；逐 case RSS/耗时诊断；scales=100/75/50/25 冻结最大真实通过档；保持 required case + failure evidence fail-closed；澄清回写 Design/Spec/Plan/报告但不改冻结数值）。
- Task E：主 Agent 亲自执行完整 proof + integrated-qualify；任一模通过 → qualify → promote-capability → production acceptance → 全量 proof → 校验 digest/回归/fail-closed/diff-check → final whole-branch reviewer（APPROVED 或带精确文件的 REVISE）；无档通过 → 诚实 disabled + 精确失败证据 + 下一步建议。


## Task A — lock failure regressions (test-only, RED first)

- Implementer: TBD (opus-tier)
- Scope: (1) subprocess canonical-json perf/RSS regression (large payload, old O(n²)/rope-blowup must FAIL); (2) lock existing JCS digest vectors (string/number/key-sort/-0/lone-surrogate) — must stay green; (3) projection cold/hot/pure 500-issue separation measurement.
- Owner: harness; must run RED against current code BEFORE any production change.


## Task A (cont.)

- Implementer agent: a7f54525444f6b914 (opus-tier)
- Dispatch notes: subprocess canonical-json perf/RSS regression (large payload RED against current rope-blowup), lock JCS semantic vectors (must stay green), projection cold/hot/pure 500-issue separation (must pass current code with cold>hot margin).


## Task A (cont.)

- HEAD: 01aeafe "test: lock canonical-json perf/rss and projection separation regressions" (4 files +492, test-only)
- Harness re-verify: RED subprocess regression FAILS current code (32MiB child peak ~1.25-1.36GiB > 1GiB guard); canonical-json semantic 25/25 PASS; projection separation 2/2 PASS (pure 0.41ms<30ms; cold 106ms > hot 55ms)
- Dual review dispatched: Spec reviewer a4380791d844bb02d + Quality reviewer ac86c17126221b69d (parallel, read-only)


## Task A dual review (quality)

- Quality reviewer ac86c17126221b69d: **QUALITY-OK** — RED genuine (1.26GiB>1GiB, 3 runs), probe wall excludes bootstrap, self-calibrating maxRSS, 8 semantic vectors trap the JSON.stringify fast-path hazards, projection separation real (cold ~2x hot, pure ~66x under bound), no temp residue.
- Task A minors (deferred, non-blocking): (1) RED margin ~1.25x — consider 512MiB guard for 2.6x margin; (2) no explicit it-timeout (add 30_000); (3) p95 at n=10 is max (cosmetic); (4) fixture verdict summary errors:250/warnings:250 factually wrong per registry (recomputed; cosmetic); (5) sha256(self) tautology (harmless, beside independent createHash cross-check).


## Task A dual review (spec)

- Spec reviewer a4380791d844bb02d: **SPEC-OK** — RED genuine + bound-appropriate (1GiB diagnostic ≠ 512MiB acceptance); 8 JCS vectors trap JSON.stringify fast-path hazards; projection separation isolates pure verdict (0.41ms) from cold/hot N+1; commit strictly test-only, no bound weakened, no case removed, no capability touched.
- Task A complete (commit 01aeafe, dual-approved, 9 deferred minors).

## Task B — canonical JSON O(n) + single-pass encoding — in progress

- Implementer: TBD (opus-tier)
- Scope: canonical-json.ts serializeString O(n) (linear surrogate validation + fast path for no-escape strings + chunked escape path, no per-char concat); add canonicalJsonBytesAndSha256(value) one-pass; keep canonicalJson/Bytes/Sha256 backward-compatible; blob-store putJsonBlob/putContentValue/putContentRevision + putGeneration index encode ONCE; content-root-64mib benchmark case uses one-pass (no double serialize); all old digest vectors identical; measure child peak after fix (32MiB well under 1GiB; 64MiB ideally <~500MiB).


## Task B (cont.)

- Implementer agent: a9771d0e636bfb48b (opus-tier)
- Dispatch notes: serializeString O(n) (linear surrogate validation + no-escape fast path `"${s}"` + chunked escape path, no per-char concat); add canonicalJsonBytesAndSha256 one-pass; blob-store putJsonBlob/putContentValue/putContentRevision + putGeneration index encode once; content-root-64mib benchmark one-pass; old digest vectors identical; 32MiB child must drop below 1GiB; measure 64MiB child peak (<~512MiB target).


## Task B (cont.)

- HEAD: 9048a0d "perf: linear-time canonical JSON strings and single-pass bytes+sha256" (7 files +279/-69)
- Harness re-verify: Task A RED now GREEN (2/2); canonical-json 29/29; blob-store 13/13; npm run check clean
- Key numbers: 32MiB child 204MiB/142ms (was 1.26GiB/1.73s); 64MiB fresh-child 383MiB/193ms; integrated-scale child retaining setup string peaks ~495MiB (<512MiB, thin ~18-41MiB margin — Task E concern)
- Dual review dispatched: Spec a34d94f4039d9b4db + Quality ae68ed7a670f8e8ea (parallel)


## Task B dual review (quality)

- Quality reviewer ae68ed7a670f8e8ea: **QUALITY-OK** — O(n) serializer byte-identical (50k-trial differential fuzz zero drift), one-pass interface correct, blob store encode-once with stable pinned digests, security/atomicity preserved, benchmark one-pass test non-tautological, 32MiB child ~192MiB / 64MiB fresh ~383MiB.
- Task B minors (deferred): canonicalJsonBytes computes discarded sha256 for bytes-only callers (small values); blob-store digest pins exercise only no-escape path (covered by unit vectors + fuzz); C0 test semi-self-referential; escape-path comment overstates O(1) peak; benchmark case-level guard redundant.
- Carry to Task D/E: ~495MiB 100%-scale integrated-child headroom (thin ~18-41MiB) — qualification concern.


## Task B dual review (spec)

- Spec reviewer a34d94f4039d9b4db: **SPEC-OK** — JCS semantics preserved (90,660-string fuzz + Python golden digest cross-check, zero drift), one-pass correct, blob encode-once with stable pins, frozen bounds + manifest untouched, memory plausible (fast path single concat). 2 cosmetic minors.
- Task B complete (commit 9048a0d, dual-approved).

## Task C — projection/Seal N+1 I/O fix — in progress

- Implementer: TBD (opus-tier)
- Scope: immutable GenerationIndex cache per generationId; content-revision presence/digest separated from content-blob hydration (readContentPresence root-only + lazy per-slot hydration); listSlots reads metadata + presence only (no full hydration); readSlot loads target content only; Seal/full-scaffold batch generation read (one file open, no 10k index re-parse) + bounded concurrency for many content blobs; keep single-slot read / content-addressing / integrity / hidden-slot / cursor/grant fail-closed; tests proving list 64 slots reads no content blobs + Seal does no 10k index parses.


## Task C (cont.)

- Implementer agent: ace89cc983399a776 (opus-tier)
- Dispatch notes: immutable GenerationIndex cache; readContentPresence (root-only) + lazy per-slot hydration + bounded-concurrency readEffectiveContent; data source caches state + presence, getSlot no content hydration; Seal batch readGenerationSlots (one NDJSON open) + one index parse; mapLimit bounded concurrency; N+1 instrumented tests (list no content blobs / readSlot one blob / Seal O(1) index+open / state projection bounded / concurrency capped); keep all semantics.


## Task C (cont.)

- HEAD: 2109143 "perf: cache generation indexes and separate content presence from hydration" (8 files +1015/-117)
- Harness re-verify: focused 40/40; N+1 tests 7/7; npm run check clean
- N+1 before→after (100-slot gen): listSlots 100 blob reads+64 index parses → 0 blob reads+1 index parse; readSlot 100 blobs → 1; Seal 101 index parses+100 opens+100 blobs → 1 index+1 open; state re-projection per slot → 1 per op; Task A separation bench cold 31.3ms > hot 14.6ms
- Dual review dispatched: Spec a0ac2c050137c55d3 + Quality a2681e0209dd6867a (parallel)


## Task C dual review (quality)

- Quality reviewer a2681e0209dd6867a: **QUALITY-ISSUES** — cache/readGenerationSlots/mapLimit/instrumentation/set-null all PASS; 1 Important: data-source getSlot/getActiveGeneration can serve a stale pre-merge revision from a long-lived source instead of GRANT_STALE (report's claim inaccurate); unreachable in production (per-operation sources) but the exact stale-cache read. Recommended: refresh cached state on event-tail advance OR re-validate active revision on content-level reads.
- Task C minors: mapLimit NaN/error-drain; readGenerationSlots doesn't re-verify caller-supplied index.generationId; seal loadSlots `?? slot.content ?? null` treats set-null as missing (correct only because NDJSON records carry no content); getContentPresence returns cached object by reference.
- Fix round: resume implementer ace89cc983399a776 with the Important + cheap minors.


- Task C fix round: resumed implementer ace89cc983399a776 (Important stale-revision + seal null-resolution + index identity + presence defensive copy + report correction).
- Task C Spec review (a0ac2c050137c55d3) still pending.


## Task C fix round (cont.)

- HEAD: 60f8694 "fix: recompute data source operation state and harden seal/n1 edges" (5 files +156/-58)
- Harness re-verify: focused 40/40; npm run check clean; implementer two full runs 106/1976 pass/1 skip
- Scoped re-review: reviewer aeb42d22d6b26fef8 dispatched (2109143..60f8694)
- Task C Spec review (a0ac2c050137c55d3) still pending


## Task C fix round re-review (quality)

- Reviewer aeb42d22d6b26fef8: All 5 items ADDRESSED, no new Critical/Important breakage. Operation-boundary recompute stays per-operation (no per-slot event-read regression); seal null-resolution correct; index identity check + defensive copy + report correction done. 2 stale-comment nits (non-blocking).
- Task C Spec review (a0ac2c050137c55d3) still pending.


## Task C dual review (spec) — verdict recovered from transcript

- Spec reviewer a0ac2c050137c55d3: **SPEC-OK** (completed 2026-08-11T17:32:43Z, notification lost; final output recovered). Integrity/single-range/presence-separation/projection-semantics all PASS. Its only Important (data-source caching stale-revision, not reachable in production) is the SAME finding the quality review raised — ADDRESSED by fix round 60f8694 and closed by the scoped re-review (aeb42d22d6b26fef8: all addressed, no new breakage).
- **Task C COMPLETE** (commits 2109143 + 60f8694, dual-approved, fix round closed).

## Task D — benchmark calibration — in progress

- Implementer: TBD (opus-tier)
- Scope: authorized-projection-500-issues case precisely measures the PURE authorized verdict projection (projectStructuredVerdict) with warmup + multiple samples (the 250ms bound target); cold owner outline + hot owner outline as SEPARATE diagnostic cases (kept, not dropped); per-case RSS/time diagnostics in evidence; total child peak RSS remains the authoritative 512MiB gate (no per-case subprocess evasion); keep scales 100/75/50/25 + required cases + fail-closed failure evidence; if evidence schema extended → exact-versioned + positive/negative tests; sync benchmark clarifications to Design/Spec/Plan/report without changing frozen values.


## Task D (cont.)

- Implementer agent: a09af40fad0d4491c (opus-tier)
- Dispatch notes: adapter split (runAuthorizedProjection500Issues = PURE projectStructuredVerdict; add runOwnerOutlineCold/Hot diagnostics); benchmark case uses pure with warmup>=3/samples>=10 + outline diagnostic cases (not bound-gated) + per-case postCasePeakRssBytes in evidence; REQUIRED_BOUND_CASE_IDS unchanged (6); evidence schema extended (additive under schemaVersion 1 + validator updated + pos/neg tests); docs note (250ms bound = pure projection; cold/hot diagnostics); no frozen-value change; total child peak RSS remains the gate.


- Task D note: implementer a09af40fad0d4491c stopped mid-work (6 files modified + 2 new test files, no commit/report). Resumed via SendMessage with continue-and-complete nudge.


## Task D (cont.)

- HEAD: a779ce0 "perf: measure the pure authorized projection and add outline diagnostics" (9 files +835/-77)
- Harness re-verify: focused 41/41; npm run check clean; git diff --check clean; full 108 files/1994 pass/1 skip
- New per-scale child peaks after Tasks B+C: 100%=965MiB, 75%=995MiB, 50%=673MiB, 25%=467MiB (pre-B/C 2.74/2.84/2.86/2.27GB). 25% PASSES every bound (467<512MiB, all timings); pure projection p95 0.44-0.75ms (was ~316ms); outline cold 133-492ms / hot 123-483ms; seal max ≤1.3s; content-root max ≤205ms. Implementer deliberately did NOT run integrated-qualify (Task E authority).
- Implementer concerns: 25% passes but thin ~22-45MiB margin under 512MiB — re-verify on clean tree; evidence file left as pre-existing untracked failure evidence.
- Dual review dispatched: Spec a4baacf0d9b02fea6 + Quality a8ae5d5ceb0f05eeb (parallel)


## Task D dual review (spec)

- Spec reviewer a4baacf0d9b02fea6: **SPEC-OK** — bounds/REQUIRED ids unchanged; 250ms gates PURE projection (warmup3/samples10); outline diagnostics bound-free but emission-required; scales 100/75/50/25 + total child RSS authoritative (no per-case isolation); evidence additive under schemaVersion 1 with pos/neg tests + unchanged digest chain; docs additive no frozen-value change; implementer honestly refrained from integrated-qualify (profile still provisional; evidence on disk is old format).
- Task D minors (deferred): stale pre-Task-D failure evidence will be overwritten by Task E (hygiene); 25% margin ~45MiB thin (re-verify on clean tree); cosmetic §16.3 comment refs.


## Pre-existing flaky test found at the Task E gate

- `src/server/api/api.integration.test.ts` "Phase C Task 5: startup interruption recovery > restores active tasks as interrupted before serving any request" (basic-v2 path; NOT touched by Tasks A-D) intermittently fails under full-suite parallel load: after a detached POST /resume (202), the immediate GET /workspace races the background loop and can observe `retryable_failure` (a transient resume-turn failure parks it for manual retry), which the test's allowed set ['running','interrupted'] misses. Passes in isolation (2/2); full-suite ~50% flaky. Pre-existing timing/load flake (noted earlier in Task 7's fix round).
- Owner: harness. Fix must make the test deterministic WITHOUT weakening its intent (recovery+resume leaves the task in a valid NON-TERMINAL resumable state) and WITHOUT changing scheduler/runner semantics.


- Flaky-test fix dispatched: implementer ad865ed0575d457f7 (opus-tier) — make the api.integration recovery test deterministic (await/poll the detached resume to a settled legitimate non-terminal state; complete the allowed set running|interrupted|retryable_failure; NOT terminal/corrupt; no scheduler/runner/production change; no skip/.only).


## Post-promotion phase-pinned test conversion (Task 19 Step 1/9 surfaced)

- With the checked-in manifest now ENABLED + profile FINAL (promotion succeeded), 4 tests that pinned the CHECKED-IN phase fail under `npm test`:
  1. src/server/api/structured-slot-routes.test.ts "surfaces a stable TEMPLATE_RUNTIME_UNAVAILABLE for a disabled runtime" — constructs CoreService with the production default (now enabled) → must inject createDisabledRuntimeEnvironment() explicitly.
  2. src/server/storage/task-store.test.ts ×2 — "maps a gated structured template to TEMPLATE_RUNTIME_UNAVAILABLE" + "propagates TEMPLATE_RUNTIME_UNAVAILABLE when reopening a structured snapshot under a disabled runtime" — reopen steps rely on the checked-in disabled default → must inject createDisabledRuntimeEnvironment() explicitly.
  3. scripts/verify-structured-slots.test.ts promote happy-path — the isolated temp-workspace promote test now fails; must be made phase-independent.
- This is the plan's Task 19 Step 1/Step 9 requirement: unit tests must be explicit disabled/enabled fixture tests, identical source passes before AND after promotion. Owner: harness. Fix by explicit environment injection, not by weakening.
- IMPORTANT: qualification already succeeded and the manifest is ENABLED — this test conversion is a post-promotion cleanup to keep `npm test` green under the enabled default; the release evidence's sourceTreeDigest must match HEAD, so commit the test fix and re-verify.


- Phase-pinned test conversion dispatched: implementer a61922af1c0b2504d (opus-tier) — inject explicit disabled/enabled fixtures in structured-slot-routes + task-store (2) + verify-structured-slots promote happy-path; keep manifest enabled + profile final; no assertion weakening; full-suite 3× deterministic green + check + diff-check.

