# 知乎盐选单章正文结构槽模板 Implementation Plan

> For agentic workers: implement task-by-task with a fresh review after each task.

**Goal:** Add one production-ready structured_slots template, zhihu-salt-chapter-draft, that models a chapter as ordered title/opening/scenes/closure/end slots and assembles a sealed tree into chapter.md.

**Architecture:** Keep the platform runtime unchanged. Add a self-contained repository template package with v3 structure/fill/seal agents and a v2 submitter; compile a bounded slot contract; attach a package-local projection of the real Zhihu chapter Skill; use deterministic CommonJS validator and assembler resources; verify with fixture-backed loader and real scheduler acceptance tests.

**Tech Stack:** TypeScript/Vitest, YAML template contracts, forge-validator/v1, forge-assembler/v1, Markdown Skill files.

## Global Constraints

- Preserve the structured runtime v3 contract and structure → fill → seal → submitter route.
- Keep basic templates and all existing ForgeActions unchanged.
- Keep business vocabulary inside the template package.
- Validator and assembler are deterministic, sandbox-compatible, and fail closed.
- Final output is chapter.md derived only from sealed scaffold data.
- Do not modify production capability manifests or generated qualification evidence.

### Task 1: Add the template package and Skill projection

Files to create:

- templates/zhihu-salt-chapter-draft/template.yaml
- templates/zhihu-salt-chapter-draft/pipeline.yaml
- templates/zhihu-salt-chapter-draft/input.example.json
- templates/zhihu-salt-chapter-draft/agents/{structure,fill,seal,submitter}.yaml
- templates/zhihu-salt-chapter-draft/prompts/{structure,fill,seal,submitter}-system.md
- templates/zhihu-salt-chapter-draft/skills/chapter-drafting/SKILL.md
- templates/zhihu-salt-chapter-draft/skills/chapter-drafting/sections/01-focus-contract.md through 08-targeted-repair.md

Use productionMode structured_slots and agents structure, fill, seal, submitter. Routes are structure→fill message, fill→seal message, seal→fill message for rework, and seal→submitter artifact. The artifact schema declares chapter.md produced by seal. Structure declares read_structure_contract, write_structure_proposal, submit_structure_proposal. Fill declares read_slot_spec, read_slot_content, write_draft_content, submit_draft. Seal declares request_seal and failureDispatch seal_gate_failed→send_message. Submitter is a v2 submit_final_artifact node.

Copy the existing zhihu-salt-chapter-drafter contract into the package-local Skill and eight section files. Do not reference the external skills directory at runtime.

Verification:

    npm run check
    git diff --check

Commit:

    git add templates/zhihu-salt-chapter-draft
    git commit -m "feat: add Zhihu chapter draft structured template"

### Task 2: Add the slot contract, validator, assembler, and focused tests

Files to create:

- templates/zhihu-salt-chapter-draft/slots/contract.yaml
- templates/zhihu-salt-chapter-draft/slots/validators/validate.js
- templates/zhihu-salt-chapter-draft/slots/assembler/render.js
- src/server/template/zhihu-salt-chapter-draft-template.test.ts

The root slot is chapter with ordered children title, opening, one-to-sixteen scene_block slots, emotional_closure, and chapter_end. All leaf content is required non-empty string content with bounded lengths; chapter has forbidden content. Define an editor access profile and one blocking merge-and-seal validator. Define one assembler route chapter-md→chapter.md.

The focused test copies the package into a temporary template root, loads it with createTestRuntimeEnvironment(), and asserts productionMode, root type, assembler route, and phases:

    structure: no_scaffold
    fill: active_unsealed
    seal: active_unsealed
    submitter: sealed

The validator returns the narrow pass/issues envelope and rejects malformed root, missing required content, empty content, invalid child types, wrong order, and scene count outside 1–16. The assembler returns exactly one chapter-md file and constructs Markdown in tree order from sealed scaffold content only.

Verification:

    npm test -- --run src/server/template/zhihu-salt-chapter-draft-template.test.ts
    npm run check

Commit:

    git add templates/zhihu-salt-chapter-draft/slots src/server/template/zhihu-salt-chapter-draft-template.test.ts
    git commit -m "feat: define Zhihu chapter slot contract"

### Task 3: Add the real scheduler acceptance flow

Modify src/server/template/zhihu-salt-chapter-draft-template.test.ts.

Use the existing structured-slot-template.acceptance.test.ts harness pattern with a scripted AgentRuntime. Propose chapter → title + opening + scene_block + emotional_closure + chapter_end. First fill leaves chapter_end empty and must receive a blocking Seal failure. Second fill completes the tree and must pass.

Assert one scaffold generation, two merged fill draft terminals, one Seal failure receipt followed by one sealed event, one final_submission_accepted event, and final chapter.md containing title and scene text while not containing raw input keys. Assert no generated qualification files change.

Verification:

    npm test -- --run src/server/template/zhihu-salt-chapter-draft-template.test.ts src/server/template/structured-slot-template.acceptance.test.ts
    npm test -- --reporter=dot
    npm run build
    npm run check

Update the design document with the verified package path and test result, then commit:

    git add docs/2026-08-12-zhihu-salt-chapter-draft-template-design.md src/server/template/zhihu-salt-chapter-draft-template.test.ts
    git commit -m "test: verify Zhihu chapter structured template"

### Task 4: Independent final review

Review only the intended template, test, design, and plan files. Run git status --short --branch, git diff --check, the focused test, npm run check, and the full test suite. Confirm no runtime source, manifest, qualification evidence, or basic template changed. Report ready for template catalog testing only when loader and real scheduler acceptance pass; otherwise record the exact failing command and keep the production capability claim unchanged.
