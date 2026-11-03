import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

export class HttpError extends Error {
  status: number;
  code: string;
  details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type Request = {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: unknown;
  raw: Buffer;
  requestId: string;
};

export type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };
export type Handler = (req: Request) => Reply | Promise<Reply>;
type Route = { method: string; pattern: string; regex: RegExp; keys: string[]; handler: Handler; maxBytes: number };

export class Router {
  routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler, maxBytes = 1024 * 1024): this {
    const keys: string[] = [];
    const source = pattern
      .split('/')
      .map((s) => (s.startsWith(':') ? (keys.push(s.slice(1)), '([^/]+)') : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('/');
    this.routes.push({ method, pattern, regex: new RegExp(`^${source}$`), keys, handler, maxBytes });
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: Handler, maxBytes?: number): this {
    return this.add('POST', pattern, handler, maxBytes);
  }

  match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.regex.exec(path);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
      return { route, params };
    }
    return null;
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'payload_too_large', `Request body exceeds ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function decode(req: IncomingMessage, raw: Buffer, limit: number): { raw: Buffer; body: unknown } {
  let bytes = raw;
  if ((req.headers['content-encoding'] ?? '').includes('gzip') && raw.length > 0) {
    try {
      bytes = gunzipSync(raw, { maxOutputLength: limit * 8 });
    } catch {
      throw new HttpError(400, 'invalid_gzip', 'Body is not valid gzip or decompresses too large');
    }
  }
  const type = req.headers['content-type'] ?? '';
  if (bytes.length > 0 && type.includes('application/json')) {
    try {
      return { raw: bytes, body: JSON.parse(bytes.toString('utf8')) };
    } catch {
      throw new HttpError(400, 'invalid_json', 'Body is not valid JSON');
    }
  }
  return { raw: bytes, body: undefined };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export type ServerOptions = {
  port: number;
  host?: string;
  router: Router;
  publicDir?: string;
  apiKeys?: Set<string>;
  onRequest?: (route: string, status: number, seconds: number) => void;
  metricsText?: () => string;
  log?: (msg: string, fields: Record<string, unknown>) => void;
};

export type RunningServer = { url: string; port: number; close(): Promise<void> };

export async function startHttp(opts: ServerOptions): Promise<RunningServer> {
  const publicRoot = opts.publicDir ? resolve(opts.publicDir) : null;

  const serveStatic = async (path: string, res: ServerResponse): Promise<boolean> => {
    if (!publicRoot) return false;
    const file = resolve(publicRoot, `.${path === '/' ? '/index.html' : path}`);
    if (file !== publicRoot && !file.startsWith(publicRoot + sep)) return false;
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return false;
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(await readFile(file));
    return true;
  };

  const server = createServer(async (req, res) => {
    const started = performance.now();
    const requestId = randomUUID();
    let route = 'unmatched';
    let status = 500;
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      if (method === 'GET' && url.pathname === '/healthz') {
        route = '/healthz';
        status = 200;
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
        return;
      }
      if (method === 'GET' && url.pathname === '/metrics' && opts.metricsText) {
        route = '/metrics';
        status = 200;
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(opts.metricsText());
        return;
      }
      const match = opts.router.match(method, url.pathname);
      if (!match) {
        if (method === 'GET' && !url.pathname.startsWith('/v1/') && (await serveStatic(url.pathname, res))) {
          route = 'static';
          status = 200;
          return;
        }
        throw new HttpError(404, 'not_found', `No route for ${method} ${url.pathname}`);
      }
      route = match.route.pattern;
      if (opts.apiKeys && method !== 'GET') {
        const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        if (!opts.apiKeys.has(token)) throw new HttpError(401, 'unauthorized', 'Missing or unknown API key');
      }
      const { raw, body } = decode(req, method === 'GET' ? Buffer.alloc(0) : await readBody(req, match.route.maxBytes), match.route.maxBytes);
      const reply = await match.route.handler({
        method,
        path: url.pathname,
        params: match.params,
        query: url.searchParams,
        headers: req.headers,
        body,
        raw,
        requestId,
      });
      status = reply.status ?? 200;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-request-id': requestId, ...reply.headers });
      res.end(reply.body === undefined ? undefined : JSON.stringify(reply.body));
    } catch (error) {
      const e = error instanceof HttpError ? error : new HttpError(500, 'internal_error', 'Internal server error');
      status = e.status;
      if (!(error instanceof HttpError)) opts.log?.('unhandled_error', { requestId, route, error: (error as Error)?.stack ?? String(error) });
      if (!res.headersSent) {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-request-id': requestId });
        res.end(JSON.stringify({ error: { code: e.code, message: e.message, details: e.details, requestId } }));
      }
    } finally {
      opts.onRequest?.(route, status, (performance.now() - started) / 1000);
    }
  });
  server.keepAliveTimeout = 5_000;
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => ok());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((ok) => {
        server.close(() => ok());
        server.closeAllConnections();
      }),
  };
}
