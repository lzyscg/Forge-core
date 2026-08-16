# Task 21 Report — Seal only through the system-owned Gate and assembler

**Status:** IMPLEMENTED and locally qualified; independent adversarial review remains the orchestrator's next gate.

## Delivered behavior

- Added a pure System Seal Gate with ten independent, stable unmet reasons. The Gate derives the whole-tree decision from exact active Map/finalized manifest/review/validator/assembler authority; reviewer or generator text cannot publish a v2 artifact.
- Added `SystemSealServiceV2` with evidence-preserving input-blocking, output-blocking, infrastructure-retry, and clear branches. Clear output prepares the exact `SealValidationBundle`, `SealRecordV2`, artifact, `SystemArtifactDelivery`, submitter grant, and all authority refs before a single facade publication.
- Added the deterministic allowlisted assembler registry and real `builtin.zhihu_chapter_markdown.v1` implementation. The handler executes canonical cloned inputs inside an isolated VM with code generation and ambient network/clock/random/process/module/timer access disabled, enforces exact authority, route/name/media/byte budgets, and verifies a second execution is byte-identical.
- Bound the production assembler to the frozen identity: ABI `forge-assembler/v2`, module `src/server/runtime/authoritative-review/builtin-assemblers/zhihu-chapter-v1`, export `assembleZhihuChapterV1`, implementation digest `3bd953501644e53f952c83acdfb30c3c4fd3b4a7e0b1e044449871fcc4646157`, and budget `5000 / 67108864 / 8388608`.
- Rotated the still-provisional profile to version 3 and digest `19dd1ec9c0bd9309fdc1a6265761b3bc5d8b7becb5127873f2b80d133dc81cd1`; updated only the v2 semantic-hash fixtures that bind this real identity. Capability semantics remain disabled/provisional.
- Extended ArtifactStore with the exact v1/v2 authority union. V1 retains required `sourceNodeId`; v2 forbids it and requires system WorkItem, SealRecord, artifact, custody, template, and delivery authority. Combined history allocates over the maximum committed v1/v2 version.
- V2 staging is keyed only by stable `sealWorkItemId + artifactRef`, carries no version/delivery, and accepts only the `system_seal` caller. The delivery blob and PublicationPin exist before the lock; the fresh-tail lock allocates the version only into `artifact_published_v2`.
- Added atomic `system_seal_publish`: scaffold seal, artifact publication, delivery, submitter WorkItem, system command completion, and Seal WorkItem completion are one six-event envelope. Its pin includes every artifact/validator/receipt/warning/bundle/record/delivery/authority/grant ref. The pinned payload carries the actual artifact file SHA; the event never substitutes the artifact object's digest.
- Response loss and two-process races converge on one delivery ref and one version with no reservation gap. Reconstructed ArtifactStore instances claim staged custody from the committed event and immediately support list/read; mismatched disk bytes, hashes, delivery, or provenance fail corrupt.
- Public workspace/API projection now preserves the exact `ArtifactVersionV1 | ArtifactVersionV2` discrimination. The one-line client branch selects v2 artifacts without inventing or scrolling to a legacy `sourceNodeId`; legacy behavior is unchanged.

## TDD evidence

Observed REDs before the corresponding implementation included:

- missing v2 system staging/promotion authority;
- generic submitter publication rejected because its mandatory grant was absent;
- exact `SealValidationBundle` parser rejecting extra fields;
- API schema rejecting the v2 public artifact union;
- stage/append infrastructure initially returning terminal rejection instead of retryable evidence custody;
- publication event file hash differing from the staged file SHA when `artifactRef.digest` was incorrectly reused.
- the new two-instance test initially gave the second live process a different boot identity, which correctly enabled reboot takeover and intermittently superseded the first hold; the fixture now models two live processes on the same boot and passed 10/10 repeated races.
- additional allowlisted attack handlers initially remained unknown because the registry exposed no additive, digest-checked installation seam; the final registry always installs the production builtin first, rejects duplicate replacement, and admits only handlers whose implementation digest matches their declared identity.
- an execution-level template hash could initially diverge from the frozen Gate identity while the Gate itself remained internally consistent; the final service rejects that mismatch before validators, assembly, staging, or publication.

GREEN qualification:

- Seal/assembler/ArtifactStore/facade/registry/action-committer/shared-v2 focused set: **8 files / 216 passed**.
- Profile/archive/template/API/projector set, including the new workspace authority regression: **6 files / 161 passed**.
- Same-boot two-instance Seal publication race stress: **10/10 passed**.
- The two tests that timed out only under an earlier default-timeout concurrent full run passed independently: namespace isolation **1 passed in 2.64 s**; F1/F2 successor correction **1 passed in 16.87 s** with a 60-second ceiling.
- `npm run check`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.
- Production authoritative-review sources have no `EventStore` import.

## Scope and compatibility

- V1 events, metadata parsing, list/read/cross-check, annotation, and publish semantics remain intact; the public optional v1 discriminator is not emitted into legacy workspace bytes.
- Frozen object/publication schema versions remain `1` where specified.
- V2 mutation remains facade-only. ArtifactStore is the storage adapter and runtime Seal code does not import EventStore.
- The two `task-runner.ts` guards only fail closed if a v2 system delivery is incorrectly routed through the legacy v1 handoff path; Task 22 owns the generic submitter execution path.
- No Task 22+ implementation was started.

## Review attack surface

- Recompute the builtin implementation/profile digests and attack canonical-source normalization/transitive identity.
- Attempt VM escapes and nondeterministic output; verify exact route/name/media/bytes and authority mismatch failures.
- Mutate each Gate input independently, especially same-semantic/different-ref Map and manifest identities.
- Crash before staging, after validation, during append, and after append before response; reconstruct stores and verify one version/delivery plus complete closure.
- Race two facade instances and try v1/agent/arbitrary-system publication into the v2 custody path.
- Tamper artifact file bytes/hash, meta provenance, SealRecord, custody, or delivery and confirm list/read fails corrupt rather than degrading to v1.
