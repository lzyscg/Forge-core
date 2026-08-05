/**
 * Template API routes (plan Phase B Task 5): list, detail and explicit
 * reload. All three delegate to the CoreService template catalog; the route
 * layer never touches template files itself (spec §15.4).
 */
import { ApiError, sendJson, type ApiRoute } from './router';

export function templateRoutes(): ApiRoute[] {
  return [
    {
      method: 'GET',
      segments: ['api', 'templates'],
      handle({ service, res }) {
        sendJson(res, 200, service.templates.list());
      },
    },
    {
      method: 'GET',
      segments: ['api', 'templates', ':templateId'],
      handle({ service, params, res }) {
        const detail = service.templates.get(params.templateId);
        if (detail === undefined) {
          throw new ApiError(
            'TEMPLATE_NOT_FOUND',
            `未找到模板 ${params.templateId}。`,
            null,
            '返回模板列表重新加载。',
          );
        }
        sendJson(res, 200, detail);
      },
    },
    {
      method: 'POST',
      segments: ['api', 'templates', ':templateId', 'reload'],
      async handle({ service, params, res }) {
        const reloaded = await service.templates.reload(params.templateId);
        sendJson(res, 200, reloaded);
      },
    },
  ];
}
