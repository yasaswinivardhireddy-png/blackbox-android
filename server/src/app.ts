import { fileURLToPath } from 'node:url';
import { Router, startHttp, type RunningServer } from './http.ts';
import { Registry } from './metrics.ts';
import { Service } from './service.ts';
import { findSymbolizer } from './symbolize.ts';

export type AppOptions = {
  port: number;
  host?: string;
  dataDir?: string | null;
  apiKeys?: string[];
  symbolizer?: string | null;
  log?: boolean;
};

export type App = RunningServer & { service: Service };

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

export async function startApp(options: AppOptions): Promise<App> {
  const symbolizer = options.symbolizer === undefined ? findSymbolizer() : options.symbolizer;
  const service = new Service(options.dataDir ?? null, symbolizer);
  const registry = new Registry();
  const requests = registry.counter('http_requests_total', 'Requests by route and status');
  const latency = registry.histogram('http_request_duration_seconds', 'Request latency');
  const ingested = registry.counter('reports_ingested_total', 'Reports accepted, by outcome');
  const log = options.log ? (msg: string, fields: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), msg, ...fields })}\n`) : undefined;

  const router = new Router()
    .post('/v1/reports', async (req) => {
      const result = await service.ingest(req.body);
      ingested.inc({ outcome: 'accepted' }, result.accepted.length - result.duplicates);
      ingested.inc({ outcome: 'duplicate' }, result.duplicates);
      ingested.inc({ outcome: 'rejected' }, result.rejected.length);
      return { body: result };
    }, 16 * 1024 * 1024)
    .post('/v1/symbols', (req) => ({ status: 201, body: service.uploadSymbols(req.raw, req.query.get('name') ?? 'library.so') }), 256 * 1024 * 1024)
    .post('/v1/mappings', (req) => ({
      status: 201,
      body: service.uploadMapping(req.raw.toString('utf8'), req.query.get('version') ?? '', Number(req.query.get('build') ?? 0)),
    }), 128 * 1024 * 1024)
    .get('/v1/overview', () => ({ body: service.overview() }))
    .get('/v1/issues', (req) => ({ body: { items: service.issues(req.query.get('kind') ?? undefined) } }))
    .get('/v1/issues/:id', (req) => ({ body: service.issue(req.params.id!) }))
    .get('/v1/hotspots', () => ({ body: service.hotspots() }))
    .get('/v1/jank', () => ({ body: { items: service.jank() } }))
    .get('/v1/reports/:id', (req) => ({ body: service.report(req.params.id!) }))
    .get('/v1/sessions/:id/reports', (req) => ({ body: { items: service.reportsOfSession(req.params.id!) } }));

  const server = await startHttp({
    port: options.port,
    host: options.host,
    router,
    publicDir: PUBLIC_DIR,
    apiKeys: options.apiKeys && options.apiKeys.length > 0 ? new Set(options.apiKeys) : undefined,
    metricsText: () => registry.render(),
    onRequest: (route, status, seconds) => {
      requests.inc({ route, status: String(status) });
      latency.observe({ route }, seconds);
    },
    log,
  });
  return {
    ...server,
    service,
    close: async () => {
      await server.close();
      service.close();
    },
  };
}
