// @vitest-environment node
/**
 * Zhihu single-chapter acceptance template (plan Phase D Task 1 Step 1).
 *
 * Loads the committed, self-contained `templates/zhihu-single-chapter`
 * template through the generic Phase B template contract and pins the shape the
 * real acceptance loop depends on: exactly two Agents (`writer`, `reviewer`), an
 * artifact edge writer→reviewer, a message return edge reviewer→writer, and a
 * single final submitter `reviewer`.
 *
 * The committed fixture must validate with **no Provider call**: its Agents carry
 * non-live `configured/<model>` placeholder identifiers in a single provider
 * namespace, so `loadTemplateDirectory` succeeds purely on structure. The real
 * acceptance runner (Task 2) copies this directory and replaces only those model
 * scalars before reload.
 *
 * Business vocabulary lives only inside the template directory and this test;
 * the platform template modules under test carry none (iron rule 1).
 */
import { cpSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CorePaths } from '../storage/core-paths';
import { EventStore } from '../storage/event-store';
import { TaskStore } from '../storage/task-store';
import { SkillService } from '../runtime/skill-service';
import { disposeAllTestRoots, makeTempCorePaths } from '../test-support';
import { loadTemplateDirectory } from './template-loader';
import { TemplateCatalog } from './template-catalog';

const TEMPLATE_ID = 'zhihu-single-chapter';

/** The committed template source, resolved relative to this test file. */
function zhihuTemplateRoot(): string {
  return fileURLToPath(
    new URL('../../../templates/zhihu-single-chapter', import.meta.url),
  );
}

afterEach(() => {
  disposeAllTestRoots();
});

describe('zhihu single-chapter acceptance template', () => {
  it('loads a self-contained two-Agent return-loop template', async () => {
    const template = await loadTemplateDirectory(zhihuTemplateRoot());
    expect(template.agents.map((agent) => agent.id)).toEqual(['writer', 'reviewer']);
    expect(template.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'writer', to: 'reviewer', kind: 'artifact' }),
        expect.objectContaining({ from: 'reviewer', to: 'writer', kind: 'message' }),
      ]),
    );
    expect(template.finalOutput.submitters).toEqual(['reviewer']);
  });

  it('declares the Zhihu chapter identity, inputs and final Markdown output', async () => {
    const template = await loadTemplateDirectory(zhihuTemplateRoot());
    expect(template.id).toBe(TEMPLATE_ID);
    expect(template.name).toBe('知乎单章生产');
    expect(template.description.trim().length).toBeGreaterThan(0);
    expect(template.inputFields.map((field) => field.id)).toEqual([
      'requirements',
      'source_material',
    ]);
    for (const field of template.inputFields) {
      expect(['text', 'textarea']).toContain(field.kind);
      expect(field.required).toBe(true);
      expect(field.label.trim().length).toBeGreaterThan(0);
      expect(field.description.trim().length).toBeGreaterThan(0);
    }
    expect(template.finalOutput.name).toBe('chapter_markdown');
    expect(template.finalOutput.format).toBe('markdown');
  });

  it('uses non-live single-provider model placeholders so no Provider call is needed', async () => {
    const template = await loadTemplateDirectory(zhihuTemplateRoot());
    const writer = template.agents.find((agent) => agent.id === 'writer');
    const reviewer = template.agents.find((agent) => agent.id === 'reviewer');
    expect(writer?.model).toBe('configured/writer-model');
    expect(reviewer?.model).toBe('configured/reviewer-model');
    // Single provider namespace and structurally valid <provider>/<model>.
    const namespaces = template.agents.map((agent) => agent.model.split('/')[0]);
    expect(new Set(namespaces).size).toBe(1);
    for (const agent of template.agents) {
      expect(agent.model).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/);
    }
    // Validation completed without any Provider call: a deterministic content hash.
    expect(template.versionHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('authorizes both Skills and lets SkillService load their content', async () => {
    const { paths, templateRoot } = makeTempCorePaths();
    cpSync(zhihuTemplateRoot(), join(templateRoot, TEMPLATE_ID), { recursive: true });
    const catalog = new TemplateCatalog(paths);
    await catalog.initialize();
    const detail = catalog.get(TEMPLATE_ID);
    expect(detail?.status).toBe('valid');

    const tasks = new TaskStore(paths, catalog);
    const events = new EventStore(paths);
    const skills = new SkillService({ paths, tasks, events });
    const created = await tasks.create({
      templateId: TEMPLATE_ID,
      name: '知乎单章验收任务',
      input: {
        requirements: '用第一人称写一章完整的故事。',
        source_material: '一段足以支撑一章冲突的素材。',
      },
    });

    const writerSkill = await skills.loadAuthorized(created.id, 'writer', 'chapter-drafting');
    expect(writerSkill.content.trim().length).toBeGreaterThan(0);
    const reviewerSkill = await skills.loadAuthorized(created.id, 'reviewer', 'chapter-review');
    expect(reviewerSkill.content.trim().length).toBeGreaterThan(0);

    // SkillService refuses a Skill the frozen manifest did not authorize.
    await expect(
      skills.loadAuthorized(created.id, 'writer', 'chapter-review'),
    ).rejects.toMatchObject({ code: 'SKILL_NOT_AUTHORIZED' });
  });

  it('agent prompts and skills only reference actions routable on the declared edges', async () => {
    // A real Provider model follows these texts literally: any action named in
    // an Agent prompt or Skill must be routable on the frozen edges, or the
    // committer rejects the whole Turn (ROUTE_NOT_ALLOWED) — exactly what the
    // first real acceptance attempt hit when the writer prompt instructed a
    // send_message to the reviewer although only the artifact edge exists.
    const template = await loadTemplateDirectory(zhihuTemplateRoot());
    const root = zhihuTemplateRoot();
    for (const agent of template.agents) {
      let instructionText = agent.systemPrompt;
      for (const skill of agent.skills) {
        instructionText += `\n${await readFile(join(root, skill.contentPath), 'utf8')}`;
      }
      const hasMessageRoute = template.routes.some(
        (route) => route.from === agent.id && route.kind === 'message',
      );
      const hasArtifactRoute = template.routes.some(
        (route) => route.from === agent.id && route.kind === 'artifact',
      );
      if (!hasMessageRoute) {
        expect(instructionText, `${agent.id} may not be told to send_message`).not.toContain(
          'send_message',
        );
      }
      if (!hasArtifactRoute) {
        expect(
          instructionText,
          `${agent.id} may not be told to publish_artifact`,
        ).not.toContain('publish_artifact');
      }
      if (template.finalOutput.submitters.includes(agent.id)) {
        expect(instructionText, `${agent.id} must know how to submit the final output`).toContain(
          'submit_final_artifact',
        );
      }
    }
  });

  it('carries loadable skill files and a deterministic example input', async () => {
    const root = zhihuTemplateRoot();
    const drafting = await readFile(join(root, 'skills/chapter-drafting/SKILL.md'), 'utf8');
    const review = await readFile(join(root, 'skills/chapter-review/SKILL.md'), 'utf8');
    expect(drafting.trim().length).toBeGreaterThan(0);
    expect(review.trim().length).toBeGreaterThan(0);

    const example = JSON.parse(await readFile(join(root, 'input.example.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(example).sort()).toEqual(['requirements', 'source_material']);
    expect(typeof example.requirements).toBe('string');
    expect(typeof example.source_material).toBe('string');
    expect((example.requirements as string).trim().length).toBeGreaterThan(0);
    expect((example.source_material as string).trim().length).toBeGreaterThan(0);
  });

  it('declares version 1 turn contracts for both agents (plan 2026-08-04 Task 2)', async () => {
    const template = await loadTemplateDirectory(zhihuTemplateRoot());
    const writer = template.agents.find((agent) => agent.id === 'writer');
    const reviewer = template.agents.find((agent) => agent.id === 'reviewer');
    // Writer: seal a Markdown chapter from its workspace file, publish to reviewer.
    expect(writer?.turnContract).toEqual({
      version: 1,
      production: {
        completionAction: 'finish_production',
        output: { formats: ['markdown'], sources: ['workspace_file'] },
      },
      dispatch: {
        cardinality: 'single',
        allowedActions: ['publish_artifact'],
        targets: { publish_artifact: ['reviewer'] },
        productionPackageRef: 'current',
      },
    });
    // Reviewer: seal an inline review and message it back, or seal the received
    // chapter artifact and submit it as the final output — one intent per turn.
    expect(reviewer?.turnContract).toEqual({
      version: 1,
      production: {
        completionAction: 'finish_production',
        output: { formats: ['markdown', 'text'], sources: ['inline', 'current_input_artifact'] },
      },
      dispatch: {
        cardinality: 'single',
        allowedActions: ['send_message', 'submit_final_artifact'],
        targets: { send_message: ['writer'] },
        productionPackageRef: 'current',
      },
    });
  });

  it('system prompts teach the two-step finish_production → dispatch contract', async () => {
    const template = await loadTemplateDirectory(zhihuTemplateRoot());
    for (const agent of template.agents) {
      expect(
        agent.systemPrompt,
        `${agent.id} must be told to seal production with finish_production`,
      ).toContain('finish_production');
      expect(
        agent.systemPrompt,
        `${agent.id} must reference the sealed package with productionPackageRef`,
      ).toContain('productionPackageRef');
    }
    const reviewer = template.agents.find((agent) => agent.id === 'reviewer');
    expect(reviewer?.systemPrompt).toContain('current_input_artifact');
  });
});
