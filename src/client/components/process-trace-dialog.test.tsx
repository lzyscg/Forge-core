import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type {
  SkillContent,
  TurnTrace,
  TurnTracePhase,
  WorkspaceNode,
} from '../../shared/contracts';
import { CORE_ERROR_CODES, CoreError } from '../gateway/core-errors';
import { GatewayProvider } from '../gateway/gateway-context';
import type { DevelopmentGateway } from '../gateway/development-gateway';
import type { ForgeCoreGateway } from '../gateway/forge-core-gateway';
import { stubGateway } from '../test-support';
import { ProcessTraceDialog } from './process-trace-dialog';

const TASK_ID = 'task-trace';

const resultNode: WorkspaceNode = {
  id: 'node-result-1',
  sequence: 2,
  agentId: 'writer',
  kind: 'result',
  title: '第一章初稿',
  body: '正文内容。',
  status: 'confirmed',
  attemptCount: 1,
  artifactVersion: 1,
  turnId: 'turn-1',
};

const skillNode: WorkspaceNode = {
  id: 'node-skill-1',
  sequence: 3,
  agentId: 'writer',
  kind: 'skill',
  title: 'skill-chapter-writing',
  body: '8f3a2b1c4d5e',
  status: 'confirmed',
  attemptCount: 1,
  artifactVersion: null,
  turnId: 'turn-1',
};

const trace: TurnTrace = {
  turnId: 'turn-1',
  entries: [
    { kind: 'thinking', text: '先确定视角，再落细节。' },
    {
      kind: 'tool_call',
      toolName: 'write_workspace',
      params: { path: 'draft/v1.md', content: '初稿' },
    },
    { kind: 'tool_result', toolName: 'write_workspace', text: 'draft/v1.md (6 bytes)' },
    { kind: 'text', text: '第一段正文。' },
  ],
};

const skill: SkillContent = {
  skillId: 'skill-chapter-writing',
  content: '# 章节写作 Skill\n\n开篇三百字内落下一个具体的悬念物件。',
  versionHash: '8f3a2b1c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f70819283a4b5c6d7e8',
};

function phaseTrace(phase: TurnTracePhase, entries = trace.entries): TurnTrace {
  return { turnId: trace.turnId, phase, entries };
}

const dispatchedToReviewer: TurnTracePhase = {
  state: 'dispatched',
  dispatchAction: 'publish_artifact',
  target: '章节审核',
  message: null,
};

const dispatchedFinal: TurnTracePhase = {
  state: 'dispatched',
  dispatchAction: 'submit_final_artifact',
  target: null,
  message: null,
};

const waitingHuman: TurnTracePhase = {
  state: 'waiting_human',
  dispatchAction: 'request_human_input',
  target: null,
  message: null,
};

const phaseFailed: TurnTracePhase = {
  state: 'failed',
  dispatchAction: null,
  target: null,
  message: '本回合未完成制作和发送，系统将按重试策略处理。',
};

function renderDialog(
  node: WorkspaceNode,
  gateway: ForgeCoreGateway & DevelopmentGateway,
  onClose: () => void = () => {},
) {
  return render(
    <GatewayProvider core={gateway} development={gateway}>
      <ProcessTraceDialog taskId={TASK_ID} node={node} onClose={onClose} />
    </GatewayProvider>,
  );
}

describe('ProcessTraceDialog', () => {
  it('renders thinking, tool call, tool result and text entries in order', async () => {
    const getTurnTrace = vi.fn().mockResolvedValue(trace);
    renderDialog(resultNode, stubGateway({ getTurnTrace }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleName('第一章初稿');
    // Exactly one fetch, keyed by the node's turn id.
    expect(getTurnTrace).toHaveBeenCalledTimes(1);
    expect(getTurnTrace).toHaveBeenCalledWith(TASK_ID, 'turn-1');

    const sectionTitles = [...dialog.querySelectorAll('.fc-trace__section')].map(
      (section) => section.querySelector('.fc-trace__section-title')?.textContent ?? null,
    );
    expect(sectionTitles).toEqual([
      '思维',
      '工具调用：write_workspace',
      '工具返回：write_workspace',
      '正文',
    ]);

    const pres = dialog.querySelectorAll('pre');
    expect(pres).toHaveLength(2);
    expect(pres[0].textContent).toContain('"path": "draft/v1.md"');
    expect(pres[1].textContent).toContain('draft/v1.md (6 bytes)');
    expect(dialog.textContent).toContain('先确定视角，再落细节。');
    expect(dialog.textContent).toContain('第一段正文。');
    // The thinking section carries its dedicated style hook.
    expect(dialog.querySelector('.fc-trace__section--thinking')).not.toBeNull();
  });

  it('shows the skill version prefix and full content for skill nodes', async () => {
    const getSkillContent = vi.fn().mockResolvedValue(skill);
    const getTurnTrace = vi.fn();
    renderDialog(skillNode, stubGateway({ getSkillContent, getTurnTrace }));

    const dialog = await screen.findByRole('dialog');
    expect(getSkillContent).toHaveBeenCalledTimes(1);
    expect(getSkillContent).toHaveBeenCalledWith(TASK_ID, 'skill-chapter-writing');
    expect(getTurnTrace).not.toHaveBeenCalled();

    // Meta shows the 12-char version prefix only, never the full hash.
    expect(dialog.textContent).toContain('8f3a2b1c4d5e');
    expect(dialog.textContent).not.toContain(skill.versionHash);
    const pre = dialog.querySelector('.fc-trace__skill-content');
    expect(pre?.textContent).toBe(skill.content);
  });

  it('shows the placeholder copy when the trace load rejects', async () => {
    const getTurnTrace = vi.fn().mockRejectedValue(
      new CoreError(
        CORE_ERROR_CODES.TRACE_NOT_FOUND,
        '未找到回合 turn-1 的执行过程记录。',
        'MockGateway.getTurnTrace',
        '返回画布选择其他节点后重试。',
      ),
    );
    renderDialog(resultNode, stubGateway({ getTurnTrace }));

    expect(
      await screen.findByText(/暂无执行过程记录：该任务运行于过程记录功能上线之前，或该回合未产生过程信息。/),
    ).toBeVisible();
    // Iron rule 6: the raw rejection details never reach the dialog.
    expect(screen.queryByText('未找到回合 turn-1 的执行过程记录。')).toBeNull();
    expect(screen.queryByText(/MockGateway/)).toBeNull();
  });

  it('shows the skill placeholder when the skill load rejects', async () => {
    const getSkillContent = vi.fn().mockRejectedValue(
      new CoreError(
        CORE_ERROR_CODES.SKILL_NOT_FOUND,
        '未找到技能 skill-chapter-writing。',
        'MockGateway.getSkillContent',
        '返回画布查看模板声明的技能。',
      ),
    );
    renderDialog(skillNode, stubGateway({ getSkillContent }));

    expect(await screen.findByText('无法加载技能内容。')).toBeVisible();
    expect(screen.queryByText('未找到技能 skill-chapter-writing。')).toBeNull();
  });

  it('shows the placeholder without requesting when the node has no turn id', async () => {
    const getTurnTrace = vi.fn();
    renderDialog({ ...resultNode, turnId: null }, stubGateway({ getTurnTrace }));

    expect(
      await screen.findByText(/暂无执行过程记录：该任务运行于过程记录功能上线之前，或该回合未产生过程信息。/),
    ).toBeVisible();
    expect(getTurnTrace).not.toHaveBeenCalled();
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    const getTurnTrace = vi.fn().mockResolvedValue(trace);
    renderDialog(resultNode, stubGateway({ getTurnTrace }), onClose);

    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('returns focus to the invoking element when closed', async () => {
    const getTurnTrace = vi.fn().mockResolvedValue(trace);
    const gateway = stubGateway({ getTurnTrace });

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" id="trace-trigger" onClick={() => setOpen(true)}>
            打开浮窗
          </button>
          {open ? (
            <GatewayProvider core={gateway} development={gateway}>
              <ProcessTraceDialog
                taskId={TASK_ID}
                node={resultNode}
                onClose={() => setOpen(false)}
              />
            </GatewayProvider>
          ) : null}
        </div>
      );
    }

    render(<Harness />);
    const trigger = document.getElementById('trace-trigger') as HTMLButtonElement;
    trigger.focus();
    await userEvent.click(trigger);

    expect(screen.getByRole('dialog')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '关闭浮窗' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('renders one phase row above the entries for a dispatched trace', async () => {
    const getTurnTrace = vi.fn().mockResolvedValue(phaseTrace(dispatchedToReviewer));
    renderDialog(resultNode, stubGateway({ getTurnTrace }));

    const dialog = await screen.findByRole('dialog');
    const phaseRows = dialog.querySelectorAll('.fc-trace__phase');
    expect(phaseRows).toHaveLength(1);
    expect(phaseRows[0].textContent).toBe('阶段：已发送给「章节审核」');

    // Exactly one row, directly above the trace entry sections.
    expect(phaseRows[0].nextElementSibling).toBe(dialog.querySelector('.fc-trace__sections'));
    // Entries stay unchanged beneath the phase row.
    expect(dialog.querySelectorAll('.fc-trace__section')).toHaveLength(trace.entries.length);
    expect(dialog.textContent).toContain('先确定视角，再落细节。');
  });

  it('shows the submit intent for a dispatched final submission without target', async () => {
    const getTurnTrace = vi.fn().mockResolvedValue(phaseTrace(dispatchedFinal));
    renderDialog(resultNode, stubGateway({ getTurnTrace }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.querySelector('.fc-trace__phase')?.textContent).toBe('阶段：已提交最终结果');
  });

  it('shows the published artifact identity for a publish phase without target (review F5)', async () => {
    // The committer enriches the publish phase with the sealed package title
    // and the system-assigned version; the dialog renders it instead of the
    // bare "dispatched" label.
    const publishPhase: TurnTracePhase = {
      state: 'dispatched',
      dispatchAction: 'publish_artifact',
      target: null,
      message: '已发布产物「第一章初稿」v1',
    };
    const getTurnTrace = vi.fn().mockResolvedValue(phaseTrace(publishPhase));
    renderDialog(resultNode, stubGateway({ getTurnTrace }));

    const dialog = await screen.findByRole('dialog');
    const phaseRow = dialog.querySelector('.fc-trace__phase');
    expect(phaseRow?.textContent).toBe('阶段：已发布产物「第一章初稿」v1');
    expect(phaseRow?.classList.contains('fc-trace__phase--dispatched')).toBe(true);
  });

  it('shows the waiting-human phase row', async () => {
    const getTurnTrace = vi.fn().mockResolvedValue(phaseTrace(waitingHuman));
    renderDialog(resultNode, stubGateway({ getTurnTrace }));

    const dialog = await screen.findByRole('dialog');
    const phaseRow = dialog.querySelector('.fc-trace__phase');
    expect(phaseRow?.textContent).toBe('阶段：等待人工，人工问题已提交');
    expect(phaseRow?.classList.contains('fc-trace__phase--waiting_human')).toBe(true);
  });

  it('shows the failed phase row with the public message only', async () => {
    const getTurnTrace = vi.fn().mockResolvedValue(phaseTrace(phaseFailed));
    renderDialog(resultNode, stubGateway({ getTurnTrace }));

    const dialog = await screen.findByRole('dialog');
    const phaseRow = dialog.querySelector('.fc-trace__phase');
    expect(phaseRow?.textContent).toBe(
      `阶段：阶段未完成，${phaseFailed.message ?? ''}`,
    );
    expect(phaseRow?.classList.contains('fc-trace__phase--failed')).toBe(true);
  });

  it('renders the phase row for a phase-only trace without entries', async () => {
    const getTurnTrace = vi.fn().mockResolvedValue(phaseTrace(phaseFailed, []));
    renderDialog(resultNode, stubGateway({ getTurnTrace }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.querySelector('.fc-trace__phase')?.textContent).toContain('阶段未完成');
    expect(dialog.querySelector('.fc-trace__placeholder')).toBeNull();
    expect(dialog.querySelectorAll('.fc-trace__section')).toHaveLength(0);
  });

  it('keeps existing behavior for old traces without a phase field', async () => {
    const legacyTrace: TurnTrace = { turnId: trace.turnId, entries: trace.entries };
    const getTurnTrace = vi.fn().mockResolvedValue(legacyTrace);
    renderDialog(resultNode, stubGateway({ getTurnTrace }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.querySelector('.fc-trace__phase')).toBeNull();
    expect(dialog.querySelectorAll('.fc-trace__section')).toHaveLength(trace.entries.length);
    expect(dialog.textContent).toContain('第一段正文。');
  });

  it('still shows the placeholder for old empty traces without a phase', async () => {
    const getTurnTrace = vi
      .fn()
      .mockResolvedValue({ turnId: trace.turnId, entries: [] } satisfies TurnTrace);
    renderDialog(resultNode, stubGateway({ getTurnTrace }));

    expect(
      await screen.findByText(/暂无执行过程记录：该任务运行于过程记录功能上线之前，或该回合未产生过程信息。/),
    ).toBeVisible();
    expect(document.querySelector('.fc-trace__phase')).toBeNull();
  });
});
