import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { startApp, type App } from '../src/app.ts';
import { findSymbolizer } from '../src/symbolize.ts';
import { APP_ID, APP_LIB, BUILD_ID, SO_PATH, envelope, frame, nullDerefTombstone } from './helpers.ts';

const KEY = 'test-key';

type Reply = { status: number; body: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(app: App, method: string, path: string, body?: unknown, o: { key?: string | null; gzip?: boolean; raw?: Buffer } = {}): Promise<Reply> {
  const headers: Record<string, string> = {};
  let data: Buffer | undefined;
  if (o.raw) {
    data = o.raw;
    headers['content-type'] = 'application/octet-stream';
  } else if (body !== undefined) {
    data = Buffer.from(JSON.stringify(body));
    headers['content-type'] = 'application/json';
  }
  if (data && o.gzip) {
    data = gzipSync(data);
    headers['content-encoding'] = 'gzip';
  }
  if (o.key !== null) headers.authorization = `Bearer ${o.key ?? KEY}`;
  const res = await fetch(app.url + path, { method, headers, body: data ? new Uint8Array(data) : undefined });
  const text = await res.text();
  return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
}

const upload = (app: App, reports: unknown[]) => call(app, 'POST', '/v1/reports', { sdk: '1.0.0', reports }, { gzip: true });

const emptyCartCrash = (sessionId: string, frames: ReturnType<typeof frame>[]) =>
  envelope('jvm_crash', { thread: { name: 'main', main: true }, exception: { type: 'java.lang.IllegalStateException', message: 'Cannot submit an empty cart', frames }, threads: [] }, { sessionId });

const signalHandlerCrash = (sessionId: string) =>
  envelope(
    'native_crash',
    {
      source: 'signal-handler',
      signal: 11,
      signalName: 'SIGSEGV',
      code: 1,
      faultAddress: '0x4',
      frames: [
        { pc: '0x7f3a00000a5b', relPc: '0xa5b', buildId: BUILD_ID, symbol: 'blackbox_sample_apply_discount', symbolOffset: 11, module: APP_LIB },
        { pc: '0x7f3a002c5e7b', relPc: '0x2c5e7b', buildId: 'b1c4a9', symbol: 'art_quick_generic_jni_trampoline', symbolOffset: 43, module: '/apex/com.android.art/lib64/libart.so' },
      ],
      breadcrumbs: ['1780000000000 ui: scenario native_crash'],
    },
    { sessionId },
  );

const tombstoneExit = (sessionId: string) =>
  envelope('app_exit', { reason: 'CRASH_NATIVE', traceFormat: 'tombstone-proto-base64', trace: Buffer.from(nullDerefTombstone()).toString('base64'), status: 11 }, { sessionId });

describe('service', () => {
  let app: App;
  before(async () => {
    app = await startApp({ port: 0, dataDir: null, apiKeys: [KEY], symbolizer: findSymbolizer() });
  });
  after(async () => {
    await app.close();
  });

  test('rejects uploads without a valid API key and malformed batches', async () => {
    assert.equal((await call(app, 'POST', '/v1/reports', { reports: [] }, { key: null })).status, 401);
    assert.equal((await call(app, 'POST', '/v1/reports', { reports: [] }, { key: 'wrong' })).status, 401);
    const bad = await call(app, 'POST', '/v1/reports', { items: [] });
    assert.deepEqual([bad.status, bad.body.error.code], [400, 'invalid_batch']);
    const gzipLie = await fetch(`${app.url}/v1/reports`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: '{"reports":[]}',
    });
    assert.equal(gzipLie.status, 400);
  });

  test('ingests gzip batches idempotently and rejects invalid reports individually', async () => {
    const session = envelope('session', { coldStartCandidate: true, sdkInitMicros: 640 }, { sessionId: 's1' });
    const crash = emptyCartCrash('s1', [frame(`${APP_ID}.CheckoutService`, 'submit', 'Scenarios.kt', 53), frame(`${APP_ID}.Scenarios`, 'run', 'Scenarios.kt', 35)]);
    const invalid = { ...envelope('jvm_crash', {}), id: 'not a valid id!' };
    const first = await upload(app, [session, crash, invalid]);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.accepted, [session.id, crash.id]);
    assert.deepEqual(first.body.rejected, [{ id: 'not a valid id!', error: 'invalid id' }]);
    const again = await upload(app, [session, crash]);
    assert.deepEqual([again.body.accepted.length, again.body.duplicates], [2, 2]);

    const issues = (await call(app, 'GET', '/v1/issues?kind=crash')).body.items;
    assert.equal(issues.length, 1);
    assert.deepEqual([issues[0].category, issues[0].events, issues[0].sessions], ['Failed precondition', 1, 1]);
  });

  test('retraces an R8-obfuscated crash into the same issue as the readable one', async () => {
    const mapping = readFileSync(new URL('./fixtures/mapping-excerpt.txt', import.meta.url));
    const uploaded = await call(app, 'POST', '/v1/mappings?version=1.0&build=1', undefined, { raw: mapping });
    assert.equal(uploaded.status, 201);
    assert.ok(uploaded.body.classes >= 5);
    assert.equal((await call(app, 'POST', '/v1/mappings?build=1', undefined, { raw: mapping })).status, 400);

    await upload(app, [envelope('session', {}, { sessionId: 's2' }), emptyCartCrash('s2', [frame('m6', 'a', 'SourceFile', 37)])]);
    const [issue] = (await call(app, 'GET', '/v1/issues?kind=crash')).body.items;
    assert.deepEqual([issue.events, issue.sessions, issue.location], [2, 2, 'CheckoutService.submit (Scenarios.kt:53)']);
    const detail = (await call(app, 'GET', `/v1/issues/${issue.id}`)).body;
    assert.equal(detail.analysis.retraced, true);
    assert.deepEqual(detail.analysis.frames.map((f: { text: string }) => f.text), [
      `${APP_ID}.CheckoutService.submit(Scenarios.kt:53)`,
      `${APP_ID}.Scenarios.run(Scenarios.kt:35)`,
    ]);
  });

  test('counts a native crash seen by both the signal handler and the tombstone once', async () => {
    const symbols = await call(app, 'POST', '/v1/symbols?name=libcrashy.so', undefined, { raw: readFileSync(SO_PATH) });
    assert.deepEqual([symbols.status, symbols.body.buildId], [201, BUILD_ID]);
    assert.equal((await call(app, 'POST', '/v1/symbols?name=x.so', undefined, { raw: Buffer.from('not an ELF file') })).status, 400);

    // Signal handler first (the usual upload order), then the opposite order in another session.
    await upload(app, [envelope('session', {}, { sessionId: 's3' }), signalHandlerCrash('s3'), tombstoneExit('s3')]);
    await upload(app, [envelope('session', {}, { sessionId: 's4' }), tombstoneExit('s4')]);
    await upload(app, [signalHandlerCrash('s4')]);

    const issues = (await call(app, 'GET', '/v1/issues?kind=native_crash')).body.items;
    assert.equal(issues.length, 1);
    assert.deepEqual([issues[0].category, issues[0].events, issues[0].sessions], ['Null pointer dereference', 2, 2]);
    const detail = (await call(app, 'GET', `/v1/issues/${issues[0].id}`)).body;
    assert.equal(detail.sample.type, 'app_exit');
    assert.deepEqual(detail.sample.breadcrumbs, [{ t: 1_780_000_000_000, c: 'ui', m: 'scenario native_crash' }]);
    const sessionReports = (await call(app, 'GET', '/v1/sessions/s3/reports')).body.items;
    assert.ok(sessionReports.filter((r: { issue_id: string }) => r.issue_id === issues[0].id).length === 2);
  });

  test('keeps the longest version of a hang that was still ongoing', async () => {
    const writing = [frame(`${APP_ID}.ReceiptArchive`, 'saveAllOnMainThread', 'Scenarios.kt', 84)];
    const syncing = [frame('java.io.FileDescriptor', 'sync', null, -2), frame(`${APP_ID}.ReceiptArchive`, 'saveAllOnMainThread', 'Scenarios.kt', 84)];
    const hang = (blockedMs: number, ongoing: boolean) =>
      envelope('app_hang', { blockedMs, ongoing, mainThreadState: 'RUNNABLE', mainThreadSamples: [syncing, writing, syncing], threads: [] }, { id: 'hang-1', sessionId: 's5' });
    await upload(app, [envelope('session', {}, { sessionId: 's5' }), hang(2500, true)]);
    await upload(app, [hang(9000, false)]);
    const stale = await upload(app, [hang(4000, true)]);
    assert.equal(stale.body.duplicates, 1);
    const [issue] = (await call(app, 'GET', '/v1/issues?kind=hang')).body.items;
    assert.deepEqual([issue.events, issue.title], [1, 'Main thread blocked 9.0 s: Disk I/O on main thread']);
    assert.equal((await call(app, 'GET', '/v1/reports/hang-1')).body.report.payload.blockedMs, 9000);
  });

  test('reports fleet health', async () => {
    const o = (await call(app, 'GET', '/v1/overview')).body;
    assert.equal(o.sessions, 5);
    assert.ok(Math.abs(o.crashFreeSessions - 0.2) < 1e-9); // s1-s4 crashed; s5 only hung
    assert.equal(o.hangRate, 0.2);
    assert.equal(o.issuesByKind.native_crash.events, 2);
    const metrics = (await call(app, 'GET', '/metrics')).body as string;
    assert.match(metrics, /reports_ingested_total\{outcome="duplicate"\} [1-9]/);
    assert.match(metrics, /http_request_duration_seconds_bucket\{route="\/v1\/reports",le="0\.1"\}/);
    assert.equal((await call(app, 'GET', '/v1/issues/does-not-exist')).status, 404);
  });
});

describe('hotspots', () => {
  let app: App;
  before(async () => {
    app = await startApp({ port: 0, dataDir: null, symbolizer: null });
  });
  after(async () => {
    await app.close();
  });

  test('flags a crash concentrated on one manufacturer but not a fleet-wide one', async () => {
    const makers = [
      { manufacturer: 'samsung', models: ['SM-S918B', 'SM-A546E'], sessions: 120 },
      { manufacturer: 'Xiaomi', models: ['23021RAAEG', '2201117TG'], sessions: 80 },
      { manufacturer: 'Google', models: ['Pixel 8', 'Pixel 7a'], sessions: 100 },
    ];
    const reports: unknown[] = [];
    let n = 0;
    for (const m of makers) {
      for (let i = 0; i < m.sessions; i++) {
        const device = { manufacturer: m.manufacturer, model: m.models[i % 2]!, sdkInt: 31 + (i % 4) };
        const sessionId = `${m.manufacturer}-${i}`;
        reports.push(envelope('session', {}, { sessionId, device }));
        if (m.manufacturer === 'Xiaomi' && i < 36) {
          reports.push(
            envelope('native_crash', { signal: 11, signalName: 'SIGSEGV', code: 1, faultAddress: '0x18', frames: [{ relPc: '0x4c2f0', buildId: 'cafe01', symbol: 'MiuiBoost_attach', module: '/vendor/lib64/libmigui.so' }] }, { sessionId, device }),
          );
        }
        if (n++ % 10 === 0) {
          reports.push(envelope('jvm_crash', { thread: { name: 'main', main: true }, exception: { type: 'java.lang.NullPointerException', message: 'cart is null', frames: [frame(`${APP_ID}.CartView`, 'bind', 'CartView.kt', 31)] }, threads: [] }, { sessionId, device }));
        }
      }
    }
    const res = await call(app, 'POST', '/v1/reports', { reports });
    assert.equal(res.body.rejected.length, 0);

    const { sessions, flagged } = (await call(app, 'GET', '/v1/hotspots')).body;
    assert.equal(sessions, 300);
    assert.equal(flagged.length, 1);
    assert.equal(flagged[0].issue.category, 'OEM library crash');
    assert.deepEqual([flagged[0].segments[0].dimension, flagged[0].segments[0].value], ['manufacturer', 'Xiaomi']);
    assert.ok(Math.abs(flagged[0].segments[0].lift - 300 / 80) < 1e-9);
  });
});
