// @vitest-environment node
/**
 * outline-designer acceptance template (plan 2026-08-07 Phase 4).
 *
 * Loads the committed `templates/outline-designer` through the generic
 * template contract and pins the v2-adapted topology: two Agents
 * (outline-designer / submitter), the outline-designer's seven-round skill
 * with an 8-file `sections` collection, its declared gate (validator +
 * artifactType + [self_check, commit]), and the submitter as the sole final
 * submitter. Business vocabulary lives only inside the template directory and
 * this test; platform modules carry none (iron rule 1).
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadTemplateDirectory } from './template-loader';

function outlineTemplateRoot(): string {
  return fileURLToPath(new URL('../../../templates/outline-designer', import.meta.url));
}

describe('outline-designer acceptance template (plan 2026-08-07 Phase 4)', () => {
  it('loads a self-contained two-Agent topology with the artifact edge', async () => {
    const template = await loadTemplateDirectory(outlineTemplateRoot());
    expect(template.agents.map((agent) => agent.id)).toEqual(['outline-designer', 'submitter']);
    expect(template.routes).toEqual([
      expect.objectContaining({
        from: 'outline-designer',
        to: 'submitter',
        kind: 'artifact',
        label: '交付执行大纲',
      }),
    ]);
    expect(template.finalOutput).toEqual({
      name: 'imitation_blueprint',
      format: 'markdown',
      submitters: ['submitter'],
    });
    expect(template.artifactSchema.files.map((file) => file.name)).toEqual(['content.md']);
    expect(template.budget).toBeNull();
  });

  it('collects the eight round references into the outline-designer skill sections', async () => {
    const template = await loadTemplateDirectory(outlineTemplateRoot());
    const outlineDesigner = template.agents.find((agent) => agent.id === 'outline-designer');
    expect(outlineDesigner?.skills).toHaveLength(1);
    const skill = outlineDesigner?.skills[0];
    expect(skill?.sectionsPath).toBe('skills/outline-designer/references');
    expect(skill?.sections).toEqual([
      'skills/outline-designer/references/01-source-boundaries.md',
      'skills/outline-designer/references/02-facts-and-conflicts.md',
      'skills/outline-designer/references/03-story-change-map.md',
      'skills/outline-designer/references/04-character-pressure-map.md',
      'skills/outline-designer/references/05-narrative-fingerprint.md',
      'skills/outline-designer/references/06-blueprint-assembly.md',
      'skills/outline-designer/references/07-outline-audit.md',
      'skills/outline-designer/references/08-outline-repair.md',
    ]);
  });

  it('declares the artifact gate on the outline-designer agent only', async () => {
    const template = await loadTemplateDirectory(outlineTemplateRoot());
    const outlineDesigner = template.agents.find((agent) => agent.id === 'outline-designer');
    expect(outlineDesigner?.gate).toEqual({
      validator: 'gates/validate-blueprint.js',
      artifactType: 'imitation_blueprint',
      mode: ['self_check', 'commit'],
    });
    const submitter = template.agents.find((agent) => agent.id === 'submitter');
    expect(submitter?.gate).toBeNull();
  });

  it('carries v2 contracts runnable under the v2-only platform', async () => {
    const template = await loadTemplateDirectory(outlineTemplateRoot());
    const outlineDesigner = template.agents.find((agent) => agent.id === 'outline-designer');
    expect(outlineDesigner?.turnContract).toEqual({
      version: 2,
      production: {
        completionAction: 'finish_production',
        output: { formats: ['markdown'], sources: ['workspace_file'] },
        files: ['content.md'],
      },
      dispatch: {
        cardinality: 'single',
        allowedActions: ['publish_artifact'],
        targets: { publish_artifact: ['submitter'] },
      },
    });
    const submitter = template.agents.find((agent) => agent.id === 'submitter');
    expect(submitter?.turnContract).toEqual({
      version: 2,
      dispatch: {
        cardinality: 'single',
        allowedActions: ['submit_final_artifact'],
        targets: {},
      },
    });
    // v2-only runnable gate.
    expect(template.agents.every((agent) => agent.turnContract?.version === 2)).toBe(true);
  });

  it('derives a stable version hash across loads', async () => {
    const first = await loadTemplateDirectory(outlineTemplateRoot());
    const second = await loadTemplateDirectory(outlineTemplateRoot());
    expect(first.versionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.versionHash).toBe(first.versionHash);
  });

  it('keeps every section path referenced by the prompts resolvable to a frozen section (review H1)', async () => {
    // The system prompt and SKILL main entry name sections with the short
    // template-relative form `references/0N-…`; readSection resolves them via
    // a trailing-suffix match against the frozen full paths. This pins that
    // every referenced short path is a suffix of a collected section, so a
    // future rename cannot silently break the seven-round reads.
    const { readFileSync } = await import('node:fs');
    const root = outlineTemplateRoot();
    const promptText = readFileSync(`${root}/prompts/outline-designer-system.md`, 'utf8');
    const skillText = readFileSync(`${root}/skills/outline-designer/SKILL.md`, 'utf8');
    const referenced = new Set<string>();
    // Only real round references (`references/0\d-…`), never the `0N-…`
    // placeholder that appears in the SKILL round table.
    for (const match of `${promptText}\n${skillText}`.matchAll(/references\/0\d-[\w.-]+\.md/g)) {
      referenced.add(match[0]);
    }
    expect(referenced.size).toBe(8);
    const template = await loadTemplateDirectory(outlineTemplateRoot());
    const sections = template.agents
      .find((agent) => agent.id === 'outline-designer')
      ?.skills[0].sections ?? [];
    for (const short of referenced) {
      expect(sections.some((full) => full === short || full.endsWith(`/${short}`)), short).toBe(true);
    }
  });
});
