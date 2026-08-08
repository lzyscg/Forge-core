// @vitest-environment node
/**
 * Long-form hub acceptance template (plan 2026-08-07 Phase 3, v7).
 *
 * Loads the committed `templates/long-form-hub` template through the generic
 * template contract and pins the v7 hybrid hub topology: three Agents
 * (controller/writer/reviewer) with production/operate/coordinate turn
 * contracts, the reviewer->controller artifact edge (zero-copy forward), the
 * controller as the sole final submitter, and a template-declared progress
 * budget.
 *
 * The committed fixture must validate with no Provider call: Agents carry
 * concrete single-provider `deepseek/<model>` identifiers (model specs are
 * parsed structurally; the provider is never contacted at load time).
 *
 * Business vocabulary lives only inside the template directory and this test;
 * the platform template modules under test carry none (iron rule 1).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadTemplateDirectory } from './template-loader';

function hubTemplateRoot(): string {
  return fileURLToPath(new URL('../../../templates/long-form-hub', import.meta.url));
}

describe('long-form hub acceptance template', () => {
  it('loads a self-contained three-Agent hub topology', async () => {
    const template = await loadTemplateDirectory(hubTemplateRoot());
    expect(template.agents.map((agent) => agent.id)).toEqual(['controller', 'writer', 'reviewer']);
    expect(template.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'controller', to: 'writer', kind: 'message' }),
        expect.objectContaining({ from: 'controller', to: 'reviewer', kind: 'message' }),
        expect.objectContaining({ from: 'writer', to: 'reviewer', kind: 'artifact' }),
        expect.objectContaining({ from: 'reviewer', to: 'writer', kind: 'message' }),
        // v7: reviewer->controller is an artifact edge (zero-copy forward).
        expect.objectContaining({ from: 'reviewer', to: 'controller', kind: 'artifact' }),
      ]),
    );
    expect(template.finalOutput.submitters).toEqual(['controller']);
    expect(template.budget).toEqual({ maxTurnsSinceHumanAnswer: 16 });
    expect(template.artifactSchema.files.map((file) => file.name).sort()).toEqual([
      'content.md',
      'review.md',
      'revision.md',
    ]);
  });

  it('gives the controller a coordinate (dispatch-only) contract with sole final submission', async () => {
    const template = await loadTemplateDirectory(hubTemplateRoot());
    const controller = template.agents.find((agent) => agent.id === 'controller');
    expect(controller?.turnContract).toMatchObject({
      version: 2,
      dispatch: {
        allowedActions: ['send_message', 'submit_final_artifact'],
        targets: { send_message: ['writer', 'reviewer'] },
      },
    });
    expect(controller?.turnContract?.production).toBeUndefined();
    expect(controller?.turnContract?.annotate).toBeUndefined();
  });

  it('gives the reviewer an operate contract (annotate + forward/send)', async () => {
    const template = await loadTemplateDirectory(hubTemplateRoot());
    const reviewer = template.agents.find((agent) => agent.id === 'reviewer');
    expect(reviewer?.turnContract).toMatchObject({
      version: 2,
      annotate: { files: ['review.md'] },
      dispatch: {
        allowedActions: ['forward_input_version', 'send_message', 'request_human_input'],
        targets: {
          forward_input_version: ['controller'],
          send_message: ['writer'],
        },
      },
    });
    expect(reviewer?.turnContract?.production).toBeUndefined();
  });

  it('gives the writer a production contract with publish_artifact', async () => {
    const template = await loadTemplateDirectory(hubTemplateRoot());
    const writer = template.agents.find((agent) => agent.id === 'writer');
    expect(writer?.turnContract).toMatchObject({
      version: 2,
      production: {
        files: ['content.md', 'revision.md'],
        output: { sources: ['inline', 'workspace_file'], formats: ['markdown'] },
      },
      dispatch: {
        allowedActions: ['publish_artifact'],
        targets: { publish_artifact: ['reviewer'] },
      },
    });
    expect(writer?.turnContract?.annotate).toBeUndefined();
  });

  it('does not hardcode a narrative voice in the writer system prompt', () => {
    // Semantic audit P2 (plan 2026-08-07): the theme input declares the
    // narrative voice (first/third person); the generic writer prompt must not
    // hardcode one, or it conflicts with the business input.
    const promptPath = fileURLToPath(
      new URL('../../../templates/long-form-hub/prompts/writer-system.md', import.meta.url),
    );
    const prompt = readFileSync(promptPath, 'utf8');
    expect(prompt).not.toMatch(/第一人称/);
    expect(prompt).not.toMatch(/第三人称/);
  });
});
