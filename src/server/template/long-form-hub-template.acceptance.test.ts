// @vitest-environment node
/**
 * Long-form hub acceptance template (plan 2026-08-06).
 *
 * Loads the committed `templates/long-form-hub` template through the generic
 * template contract and pins the shape the hybrid hub topology depends on:
 * three Agents (controller/writer/reviewer), the controller owning a
 * multi-target `send_message` candidate set plus the sole `submit_final_artifact`,
 * the reviewer choosing between a direct return to writer and a report to the
 * controller, and a template-declared progress budget.
 *
 * The committed fixture must validate with no Provider call: Agents carry
 * non-live `configured/<model>` placeholders in a single provider namespace.
 *
 * Business vocabulary lives only inside the template directory and this test;
 * the platform template modules under test carry none (iron rule 1).
 */
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
        expect.objectContaining({ from: 'reviewer', to: 'controller', kind: 'message' }),
      ]),
    );
    expect(template.finalOutput.submitters).toEqual(['controller']);
    // The template declares a progress budget within the platform ceiling.
    expect(template.budget).toEqual({ maxTurnsSinceHumanAnswer: 16 });
  });

  it('gives the controller multi-target dispatch and the sole final submission', async () => {
    const template = await loadTemplateDirectory(hubTemplateRoot());
    const controller = template.agents.find((agent) => agent.id === 'controller');
    expect(controller?.turnContract).toEqual({
      version: 1,
      production: {
        completionAction: 'finish_production',
        output: { formats: ['markdown', 'text'], sources: ['inline', 'current_input_artifact'] },
      },
      dispatch: {
        cardinality: 'single',
        allowedActions: ['send_message', 'submit_final_artifact'],
        targets: { send_message: ['writer', 'reviewer'] },
        productionPackageRef: 'current',
      },
    });
  });

  it('gives the reviewer a direct-return candidate and a forward-to-controller candidate', async () => {
    const template = await loadTemplateDirectory(hubTemplateRoot());
    const reviewer = template.agents.find((agent) => agent.id === 'reviewer');
    expect(reviewer?.turnContract).toEqual({
      version: 1,
      production: {
        completionAction: 'finish_production',
        output: { formats: ['markdown', 'text'], sources: ['inline', 'current_input_artifact'] },
      },
      dispatch: {
        cardinality: 'single',
        allowedActions: ['send_message'],
        targets: { send_message: ['writer', 'controller'] },
        productionPackageRef: 'current',
      },
    });
  });

  it('lets the writer publish chapter artifacts without a dispatch target choice', async () => {
    const template = await loadTemplateDirectory(hubTemplateRoot());
    const writer = template.agents.find((agent) => agent.id === 'writer');
    expect(writer?.turnContract).toEqual({
      version: 1,
      production: {
        completionAction: 'finish_production',
        output: { formats: ['markdown'], sources: ['inline', 'workspace_file'] },
      },
      dispatch: {
        cardinality: 'single',
        allowedActions: ['publish_artifact'],
        targets: {},
        productionPackageRef: 'current',
      },
    });
  });
});
