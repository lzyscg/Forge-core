import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { PublicCoreError } from '../../shared/errors';
import { CORE_ERROR_CODES } from '../gateway/core-errors';
import { useForgeCoreGateway } from '../gateway/gateway-context';
import { toPublicCoreError, useGatewayQuery } from '../hooks/use-gateway-query';
import { PublicErrorNotice } from './public-error-notice';

const NAME_FIELD_ID = 'fc-new-task-name';

function fieldControlId(fieldId: string): string {
  return `fc-new-task-field-${fieldId}`;
}

function fieldHintId(fieldId: string): string {
  return `${fieldControlId(fieldId)}-hint`;
}

/**
 * Task creation form. Renders exactly the inputs the template declares — never
 * editors for model, prompt, Skill, Agent or routes (spec §4.2, §9.2) — and
 * submits through Gateway.createTask only. On failure entered values are
 * retained and the error summary receives focus.
 */
export function NewTaskPage() {
  const gateway = useForgeCoreGateway();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const templateId = searchParams.get('template');

  const query = useGatewayQuery(
    () =>
      templateId !== null
        ? gateway.getTemplate(templateId)
        : Promise.reject({
            code: CORE_ERROR_CODES.INVALID_INPUT,
            message: '缺少模板参数，无法新建任务。',
            location: '/tasks/new',
            action: '从模板列表选择一个模板后再新建任务。',
          } satisfies PublicCoreError),
    [gateway, templateId],
  );

  const [name, setName] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [missingLabels, setMissingLabels] = useState<string[]>([]);
  const [submitError, setSubmitError] = useState<PublicCoreError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (missingLabels.length > 0) {
      summaryRef.current?.focus();
    }
  }, [missingLabels]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const detail = query.data;
    if (detail === null || templateId === null || submitting) return;

    const missing: string[] = [];
    if (name.trim().length === 0) missing.push('任务名称');
    for (const field of detail.inputFields) {
      if (field.required && (values[field.id] ?? '').trim().length === 0) {
        missing.push(field.label);
      }
    }
    if (missing.length > 0) {
      setSubmitError(null);
      setMissingLabels(missing);
      return;
    }

    setMissingLabels([]);
    setSubmitting(true);
    try {
      const input: Record<string, string> = {};
      for (const field of detail.inputFields) {
        input[field.id] = (values[field.id] ?? '').trim();
      }
      const task = await gateway.createTask({
        templateId,
        name: name.trim(),
        input,
      });
      navigate(`/tasks/${task.id}`);
    } catch (error) {
      setSubmitError(toPublicCoreError(error));
      setSubmitting(false);
    }
  };

  return (
    <section className="fc-new-task-page">
      <h1 className="fc-page-title">新建任务</h1>

      {query.data === null ? (
        query.status === 'error' && query.error !== null ? (
          <>
            <PublicErrorNotice title="无法新建任务。" error={query.error} />
            <p className="fc-page-recovery">
              <Link className="fc-inline-link" to="/templates">
                浏览模板
              </Link>
            </p>
          </>
        ) : (
          <p className="fc-loading-note">模板信息加载中…</p>
        )
      ) : (
        <form className="fc-new-task-form" onSubmit={(event) => void handleSubmit(event)} noValidate>
          <div className="fc-field">
            <div className="fc-field__label-row">
              <label className="fc-field__label" htmlFor={NAME_FIELD_ID}>
                任务名称
              </label>
              <span className="fc-field__required">必填</span>
            </div>
            <input
              id={NAME_FIELD_ID}
              name="task-name"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          {query.data.inputFields.map((field) => (
            <div className="fc-field" key={field.id}>
              <div className="fc-field__label-row">
                <label className="fc-field__label" htmlFor={fieldControlId(field.id)}>
                  {field.label}
                </label>
                {field.required ? <span className="fc-field__required">必填</span> : null}
              </div>
              <p className="fc-field__hint" id={fieldHintId(field.id)}>
                {field.description}
              </p>
              {field.kind === 'textarea' ? (
                <textarea
                  id={fieldControlId(field.id)}
                  name={field.id}
                  rows={5}
                  aria-describedby={fieldHintId(field.id)}
                  value={values[field.id] ?? ''}
                  onChange={(event) =>
                    setValues((previous) => ({ ...previous, [field.id]: event.target.value }))
                  }
                />
              ) : (
                <input
                  id={fieldControlId(field.id)}
                  name={field.id}
                  type="text"
                  aria-describedby={fieldHintId(field.id)}
                  value={values[field.id] ?? ''}
                  onChange={(event) =>
                    setValues((previous) => ({ ...previous, [field.id]: event.target.value }))
                  }
                />
              )}
            </div>
          ))}

          {missingLabels.length > 0 ? (
            <div className="fc-error-notice" role="alert" tabIndex={-1} ref={summaryRef}>
              <p className="fc-error-notice__title">以下必填字段尚未填写：</p>
              <ul className="fc-error-notice__list">
                {missingLabels.map((label) => (
                  <li key={label}>{label}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {submitError !== null ? (
            <PublicErrorNotice title="创建任务失败。" error={submitError} focusOnMount />
          ) : null}

          <p className="fc-new-task-form__note">
            Agent、模型、Skill 与管道均由模板决定，创建后冻结，不能在此修改。
          </p>

          <button type="submit" className="fc-button" disabled={submitting}>
            {submitting ? '创建中…' : '创建任务'}
          </button>
        </form>
      )}
    </section>
  );
}
