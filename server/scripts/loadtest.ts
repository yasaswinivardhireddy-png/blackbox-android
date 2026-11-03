// Ingestion load test: the server runs in its own process with a file-backed SQLite database, and
// concurrent clients post gzip batches shaped like the SDK's (25 reports each, unique ids).
//
//   node scripts/loadtest.ts [--seconds 10] [--connections 16] [--out loadtest.json]

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';

const { values } = parseArgs({ options: { seconds: { type: 'string', default: '10' }, connections: { type: 'string', default: '16' }, out: { type: 'string' } } });
const SECONDS = Number(values.seconds);
const CONNECTIONS = Number(values.connections);
const BATCH = 25;
const APP = 'io.github.yasaswini.blackbox.sample';
const KEY = 'loadtest-key';

const dataDir = mkdtempSync(join(tmpdir(), 'blackbox-load-'));
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.ts'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, PORT: '0', DATA_DIR: dataDir, API_KEYS: KEY },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const url = await new Promise<string>((resolve, reject) => {
  let out = '';
  server.stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString();
    const m = /on (http:\/\/[\d.]+:\d+)/.exec(out);
    if (m) resolve(m[1]!);
  });
  server.once('exit', (code) => reject(new Error(`server exited with ${code}`)));
});

const f = (c: string, m: string, file: string, l: number) => ({ c, m, f: file, l });
const device = (i: number) => [
  { manufacturer: 'samsung', model: 'SM-A546E', sdkInt: 34 },
  { manufacturer: 'Xiaomi', model: '23021RAAEG', sdkInt: 33 },
  { manufacturer: 'Google', model: 'Pixel 8', sdkInt: 34 },
][i % 3]!;

// The mix an app sends: mostly session, startup and frame reports, some errors and hangs.
function report(n: number) {
  const base = { schema: 1, id: `load-${n}`, sessionId: `load-session-${Math.floor(n / 5)}`, timestamp: 1_780_000_000_000 + n, sdk: '1.0.0', app: { id: APP, version: '4.2.0', build: 420 }, device: device(n) };
  const crumbs = [{ t: 1_780_000_000_000, c: 'ui', m: 'Opened CartActivity' }, { t: 1_780_000_000_500, c: 'network', m: 'GET /v2/cart 200' }];
  switch (n % 10) {
    case 0:
    case 1:
      return { ...base, type: 'session', payload: { coldStartCandidate: true, sdkInitMicros: 600 + (n % 300) } };
    case 2:
      return { ...base, type: 'startup', payload: { startType: 'cold', durationMs: 420 + (n % 400), activity: `${APP}.MainActivity`, sdkInitMicros: 600 + (n % 300) } };
    case 3:
    case 4:
    case 5:
      return { ...base, type: 'jank', payload: { screen: `${APP}.FeedActivity`, frames: 900, slowFrames: 40 + (n % 30), frozenFrames: n % 2, worstFrameMs: 120, refreshRateHz: 60 } };
    case 6:
    case 7:
      return {
        ...base,
        type: 'non_fatal',
        breadcrumbs: crumbs,
        payload: { thread: { name: 'main', main: true }, exception: { type: 'java.io.IOException', message: 'timeout', frames: [f(`${APP}.net.CartApi`, 'fetch', 'CartApi.kt', 30 + (n % 7)), f(`${APP}.cart.CartViewModel`, 'refresh', 'CartViewModel.kt', 58)] } },
      };
    case 8:
      return {
        ...base,
        type: 'jvm_crash',
        breadcrumbs: crumbs,
        payload: {
          thread: { name: 'main', main: true },
          exception: { type: 'java.lang.IllegalStateException', message: 'Cannot submit an empty cart', frames: [f(`${APP}.CheckoutService`, 'submit', 'Scenarios.kt', 53), f(`${APP}.Scenarios`, 'run', 'Scenarios.kt', 35), f('android.os.Looper', 'loop', 'Looper.java', 294)] },
          threads: [{ name: 'OkHttp Dispatcher', state: 'WAITING', frames: [f('java.lang.Object', 'wait', 'Object.java', -2)] }],
        },
      };
    default:
      return {
        ...base,
        type: 'app_hang',
        payload: { blockedMs: 2600, thresholdMs: 2000, ongoing: false, mainThreadState: 'RUNNABLE', mainThreadSamples: [[f('java.io.FileDescriptor', 'sync', '', -2), f(`${APP}.ReceiptArchive`, 'save', 'ReceiptArchive.kt', 84)]], threads: [] },
      };
  }
}

// Bodies are built before the clock starts, so the measurement is the server, not the generator.
const MAX_BATCHES = 20_000;
let next = 0;
const bodies: Buffer[] = [];
const prepare = (count: number) => {
  for (let i = 0; i < count; i++) {
    const reports = Array.from({ length: BATCH }, () => report(next++));
    bodies.push(gzipSync(JSON.stringify({ sdk: '1.0.0', reports })));
  }
};
prepare(2000);

const latencies: number[] = [];
let accepted = 0;
let duplicates = 0;
let errors = 0;
let cursor = 0;
const deadline = performance.now() + SECONDS * 1000;
const started = performance.now();

async function client() {
  while (performance.now() < deadline) {
    if (cursor >= bodies.length) {
      if (bodies.length >= MAX_BATCHES) break;
      prepare(500);
    }
    const body = bodies[cursor++]!;
    const t0 = performance.now();
    try {
      const res = await fetch(`${url}/v1/reports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', authorization: `Bearer ${KEY}` },
        body: new Uint8Array(body),
      });
      const json = (await res.json()) as { accepted?: string[]; duplicates?: number };
      if (!res.ok) errors++;
      accepted += (json.accepted?.length ?? 0) - (json.duplicates ?? 0);
      duplicates += json.duplicates ?? 0;
    } catch {
      errors++;
    }
    latencies.push(performance.now() - t0);
  }
}

await Promise.all(Array.from({ length: CONNECTIONS }, client));
const elapsed = (performance.now() - started) / 1000;
server.kill();
await new Promise((r) => server.once('exit', r));
rmSync(dataDir, { recursive: true, force: true });

latencies.sort((a, b) => a - b);
const q = (p: number) => Number(latencies[Math.min(latencies.length - 1, Math.ceil(p * latencies.length) - 1)]!.toFixed(1));
const summary = {
  seconds: Number(elapsed.toFixed(1)),
  connections: CONNECTIONS,
  batchSize: BATCH,
  requests: latencies.length,
  requestsPerSecond: Math.round(latencies.length / elapsed),
  reportsPerSecond: Math.round(accepted / elapsed),
  reportsStored: accepted,
  duplicates,
  errors,
  latencyMs: { p50: q(0.5), p95: q(0.95), p99: q(0.99) },
  storage: 'SQLite (WAL) on local disk, separate server process',
  node: process.version,
};
console.log(`Ingested ${accepted.toLocaleString('en-US')} reports in ${summary.seconds} s over ${CONNECTIONS} connections`);
console.log(`${summary.reportsPerSecond.toLocaleString('en-US')} reports/s (${summary.requestsPerSecond} batches/s); latency p50 ${summary.latencyMs.p50} ms, p95 ${summary.latencyMs.p95} ms, p99 ${summary.latencyMs.p99} ms; errors ${errors}, duplicates ${duplicates}`);
if (values.out) writeFileSync(values.out, `${JSON.stringify(summary, null, 2)}\n`);
if (errors > 0 || duplicates > 0) process.exitCode = 1;
