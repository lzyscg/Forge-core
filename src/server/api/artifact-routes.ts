/**
 * Artifact API routes (plan Phase B Task 5).
 *
 * Reserved read route for one committed artifact version. It projects through
 * the CoreService workspace (store-validated entries, final flag derived
 * exclusively from the accepted-final event) so the artifact module stays
 * the single authority over version contents (spec §15.4).
 */
import { API_ERROR_CODES, ApiError, sendJson, type ApiRoute } from './router';

function parseArtifactVersion(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new ApiError(
      'INVALID_INPUT',
      '产物版本必须是正整数。',
      null,
      '使用产物版本号重试。',
    );
  }
  const version = Number(raw);
  if (version < 1 || version > 999) {
    throw new ApiError(
      'INVALID_INPUT',
      '产物版本必须是正整数。',
      null,
      '使用产物版本号重试。',
    );
  }
  return version;
}

export function artifactRoutes(): ApiRoute[] {
  return [
    {
      method: 'GET',
      segments: ['api', 'tasks', ':taskId', 'artifacts', ':version'],
      async handle({ service, params, res }) {
        const version = parseArtifactVersion(params.version);
        const workspace = await service.getWorkspace(params.taskId);
        const found = workspace.artifacts.find((artifact) => artifact.version === version);
        if (found === undefined) {
          throw new ApiError(
            API_ERROR_CODES.ARTIFACT_VERSION_NOT_FOUND,
            `未找到产物版本 ${version}。`,
            null,
            '返回生产页查看已发布的版本。',
          );
        }
        sendJson(res, 200, found);
      },
    },
  ];
}
