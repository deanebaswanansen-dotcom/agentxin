/**
 * Fastify route group for the model configuration endpoints (design: HTTP API
 * table — `PUT /api/model-config`, `GET /api/model-config`).
 *
 * Routes (task 11.4):
 *   - `PUT  /api/model-config` — save/update the singleton model config from
 *     `{ baseUrl, apiKey, modelName }`. On success returns HTTP 200 with the
 *     MASKED {@link ModelConfigView} (Requirements 4.1, 4.3). An empty /
 *     whitespace-only field is rejected by the service with `VALIDATION_ERROR`
 *     → HTTP 400 (Requirement 4.4).
 *   - `GET  /api/model-config` — return the MASKED {@link ModelConfigView}
 *     (`baseUrl`, `modelName`, `apiKeyMasked`) with HTTP 200 (Requirement 4.2).
 *
 * SECURITY (Requirements 4.2, 5.6): every response body is the masked view
 * produced by {@link ModelConfigService}. The raw `apiKey` is NEVER serialized
 * into any response — `save` returns the masked view and `getView` masks the
 * stored key, so this layer only ever forwards already-masked data.
 *
 * The {@link ModelConfigService} is injected (dependency injection) rather than
 * constructed here, so wiring (task 13.1) controls the concrete store-backed
 * instance and tests can supply their own. Errors are funneled through the
 * shared {@link toErrorResponse} helper so this group emits the unified
 * {@link ApiError} shape with the correct HTTP status.
 */
import type { FastifyInstance } from 'fastify';
import type { ModelConfigService } from '../services/modelConfig/ModelConfigService.js';
import type { ModelConfig } from '../types/index.js';
import { toErrorResponse } from './errorMapping.js';

/** Request body accepted by `PUT /api/model-config`. */
interface SaveModelConfigBody {
  baseUrl?: unknown;
  apiKey?: unknown;
  modelName?: unknown;
  temperature?: unknown;
  topP?: unknown;
}

/**
 * Coerce an unknown body field into a string. Missing/non-string values become
 * the empty string so they fail the service's non-empty validation
 * (`VALIDATION_ERROR` → 400) rather than throwing a generic type error.
 */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asOptionalNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'number' ? value : Number.NaN;
}

/**
 * Register the model-configuration routes on the given Fastify instance.
 *
 * @param app - the Fastify instance (or encapsulated plugin scope) to register on.
 * @param modelConfigService - injected domain service performing validation,
 *   persistence and API-key masking.
 */
export function registerModelConfigRoutes(
  app: FastifyInstance,
  modelConfigService: ModelConfigService,
): void {
  // PUT /api/model-config — save/update the model config (Requirements 4.1, 4.3, 4.4).
  app.put<{ Body: SaveModelConfigBody }>('/api/model-config', async (request, reply) => {
    try {
      const body = request.body ?? {};
      const config: ModelConfig = {
        baseUrl: asString(body.baseUrl),
        apiKey: asString(body.apiKey),
        modelName: asString(body.modelName),
        temperature: asOptionalNumber(body.temperature),
        topP: asOptionalNumber(body.topP),
      };
      // `save` validates non-empty fields and returns the MASKED view; the raw
      // apiKey is never present in the result (Requirements 4.2, 5.6).
      const view = await modelConfigService.save(config);
      return reply.code(200).send(view);
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      return reply.code(status).send(body);
    }
  });

  // GET /api/model-config — masked view of the stored config (Requirement 4.2).
  app.get('/api/model-config', async (_request, reply) => {
    try {
      const view = await modelConfigService.getView();
      return reply.code(200).send(view);
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      return reply.code(status).send(body);
    }
  });
}

export default registerModelConfigRoutes;
