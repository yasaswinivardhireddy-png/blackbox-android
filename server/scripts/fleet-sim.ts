// Fleet simulation: does hotspot detection find device- and OS-specific defects, and stay quiet
// about fleet-wide ones? Sessions are synthetic (the device mix and defect rates below are
// assumptions, not real telemetry); every report still goes through the real ingestion, analysis
// and grouping code.
//
//   node scripts/fleet-sim.ts [--sizes 5000,20000,50000] [--seeds 10] [--out fleet.json]

import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Service } from '../src/service.ts';
import type { Envelope } from '../src/types.ts';

const { values } = parseArgs({ options: { sizes: { type: 'string', default: '5000,20000,50000' }, seeds: { type: 'string', default: '10' }, out: { type: 'string' } } });
const SIZES = values.sizes.split(',').map(Number);
const SEEDS = Number(values.seeds);
const APP = 'io.github.yasaswini.blackbox.sample';

const MAKERS: { manufacturer: string; share: number; models: string[] }[] = [
  { manufacturer: 'samsung', share: 0.35, models: ['SM-S918B', 'SM-A546E', 'SM-A145F'] },
  { manufacturer: 'Xiaomi', share: 0.2, models: ['23021RAAEG', '2201117TG', '22111317G'] },
  { manufacturer: 'Google', share: 0.1, models: ['Pixel 8', 'Pixel 7a', 'Pixel 6'] },
  { manufacturer: 'OPPO', share: 0.1, models: ['CPH2481', 'CPH2531'] },
  { manufacturer: 'vivo', share: 0.1, models: ['V2207', 'V2246'] },
  { manufacturer: 'motorola', share: 0.08, models: ['moto g54 5G', 'moto g84 5G'] },
  { manufacturer: 'OnePlus', share: 0.07, models: ['CPH2449', 'LE2113'] },
];
const API_LEVELS: [number, number][] = [[29, 0.05], [30, 0.1], [31, 0.15], [32, 0.05], [33, 0.3], [34, 0.35]];

type Device = { manufacturer: string; model: string; sdkInt: number };
type Seeded = {
  name: string;
  rate: number;
  applies: (d: Device) => boolean;
  expect: { dimension: string; value: string } | null;
  report: () => { type: string; payload: Record<string, unknown> };
};

const f = (c: string, m: string, file: string, l: number) => ({ c, m, f: file, l });
const LOOPER = [f('android.os.Handler', 'dispatchMessage', 'Handler.java', 99), f('android.os.Looper', 'loop', 'Looper.java', 294), f('android.app.ActivityThread', 'main', 'ActivityThread.java', 8177)];
const anrTrace = (mainState: string, frames: string[], extra = '') =>
  `----- pid 4321 at 2026-07-01 10:00:00 -----\nCmd line: ${APP}\n\n"main" prio=5 tid=1 ${mainState}\n  | group="main" sCount=1\n${frames.map((x) => `  ${x}`).join('\n')}\n  at android.os.Looper.loop(Looper.java:294)\n\n${extra}----- end 4321 -----\n`;

const SEEDED: Seeded[] = [
  {
    name: 'Fleet-wide null dereference',
    rate: 0.006,
    applies: () => true,
    expect: null,
    report: () => ({
      type: 'jvm_crash',
      payload: {
        thread: { name: 'main', main: true },
        exception: { type: 'java.lang.NullPointerException', message: "Attempt to invoke interface method 'int java.util.List.size()' on a null object reference", frames: [f(`${APP}.cart.CartAdapter`, 'getItemCount', 'CartAdapter.kt', 41), ...LOOPER] },
        threads: [],
      },
    }),
  },
  {
    name: 'Fleet-wide lock-contention ANR',
    rate: 0.004,
    applies: () => true,
    expect: null,
    report: () => ({
      type: 'app_exit',
      payload: {
        reason: 'ANR',
        traceFormat: 'anr-text',
        status: 0,
        trace: anrTrace(
          'Blocked',
          [`at ${APP}.feed.FeedRepository.snapshot(FeedRepository.kt:88)`, '- waiting to lock <0x0a1b2c3d> (a java.lang.Object) held by thread 19', `at ${APP}.feed.FeedFragment.onResume(FeedFragment.kt:52)`],
          `"feed-sync" prio=5 tid=19 Runnable\n  at ${APP}.feed.FeedRepository.sync(FeedRepository.kt:140)\n  - locked <0x0a1b2c3d> (a java.lang.Object)\n\n`,
        ),
      },
    }),
  },
  {
    name: 'OEM UI library crash on Xiaomi',
    rate: 0.03,
    applies: (d) => d.manufacturer === 'Xiaomi',
    expect: { dimension: 'manufacturer', value: 'Xiaomi' },
    report: () => ({
      type: 'native_crash',
      payload: {
        signal: 11,
        signalName: 'SIGSEGV',
        code: 1,
        faultAddress: '0x18',
        frames: [
          { relPc: '0x4c2f0', buildId: 'a1b2c3', symbol: 'MiuiBoost_attachView', module: '/system_ext/lib64/libmigui.so' },
          { relPc: '0x2c5e7c', buildId: 'b1c4a9', symbol: 'art_quick_generic_jni_trampoline', module: '/apex/com.android.art/lib64/libart.so' },
        ],
        breadcrumbs: [],
      },
    }),
  },
  {
    name: 'Android 14 unexported-receiver crash',
    rate: 0.02,
    applies: (d) => d.sdkInt === 34,
    expect: { dimension: 'android', value: '34' },
    report: () => ({
      type: 'jvm_crash',
      payload: {
        thread: { name: 'main', main: true },
        exception: {
          type: 'java.lang.SecurityException',
          message: `${APP}: One of RECEIVER_EXPORTED or RECEIVER_NOT_EXPORTED should be specified when a receiver isn't being registered exclusively for system broadcasts`,
          frames: [f('android.app.ContextImpl', 'registerReceiverInternal', 'ContextImpl.java', 1870), f(`${APP}.promo.PromoReceiver`, 'register', 'PromoReceiver.kt', 23), ...LOOPER],
        },
        threads: [],
      },
    }),
  },
  {
    name: 'Binder ANR on Samsung Android 13',
    rate: 0.025,
    applies: (d) => d.manufacturer === 'samsung' && d.sdkInt === 33,
    expect: { dimension: 'manufacturer+android', value: 'samsung / API 33' },
    report: () => ({
      type: 'app_exit',
      payload: {
        reason: 'ANR',
        traceFormat: 'anr-text',
        status: 0,
        trace: anrTrace('Native', [
          'at android.os.BinderProxy.transactNative(Native method)',
          'at android.os.BinderProxy.transact(BinderProxy.java:584)',
          'at android.content.IClipboard$Stub$Proxy.getPrimaryClip(IClipboard.java:371)',
          `at ${APP}.checkout.CouponField.pasteFromClipboard(CouponField.kt:64)`,
        ]),
      },
    }),
  },
  {
    name: 'GPU driver crash on Pixel 6',
    rate: 0.04,
    applies: (d) => d.model === 'Pixel 6',
    expect: { dimension: 'model', value: 'Pixel 6' },
    report: () => ({
      type: 'native_crash',
      payload: {
        signal: 7,
        signalName: 'SIGBUS',
        code: 2,
        faultAddress: '0x7a4c001000',
        frames: [
          { relPc: '0x9e1c4', buildId: 'c0ffee', symbol: null, module: '/vendor/lib64/egl/libGLES_mali.so' },
          { relPc: '0x3b2a0', buildId: 'd00d11', symbol: 'android::uirenderer::renderthread::CanvasContext::draw', module: '/system/lib64/libhwui.so' },
        ],
        breadcrumbs: [],
      },
    }),
  },
];

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, items: [T, number][]): T {
  let r = rand();
  for (const [item, weight] of items) if ((r -= weight) < 0) return item;
  return items[items.length - 1]![0];
}

async function runSeed(seed: number, sessions: number) {
  const rand = mulberry32(seed);
  const service = new Service(null, null);
  let n = 0;
  const make = (type: string, sessionId: string, device: Device, payload: Record<string, unknown>): Envelope => ({
    schema: 1,
    id: `s${seed}-${n++}`,
    type,
    sessionId,
    timestamp: 1_780_000_000_000 + n * 1000,
    app: { id: APP, version: '4.2.0', build: 420 },
    device,
    payload,
  });
  const defectOfReport = new Map<string, string>();
  let batch: Envelope[] = [];
  const flush = async () => {
    if (batch.length) await service.ingest({ reports: batch });
    batch = [];
  };
  for (let s = 0; s < sessions; s++) {
    const maker = pick(rand, MAKERS.map((m): [typeof m, number] => [m, m.share]));
    const device: Device = { manufacturer: maker.manufacturer, model: maker.models[Math.floor(rand() * maker.models.length)]!, sdkInt: pick(rand, API_LEVELS) };
    const sessionId = `s${seed}-session-${s}`;
    batch.push(make('session', sessionId, device, { coldStartCandidate: true }));
    for (const seeded of SEEDED) {
      if (seeded.applies(device) && rand() < seeded.rate) {
        const { type, payload } = seeded.report();
        const report = make(type, sessionId, device, payload);
        defectOfReport.set(report.id, seeded.name);
        batch.push(report);
      }
    }
    if (batch.length >= 450) await flush();
  }
  await flush();

  // Map each server-side issue back to the seeded defect that produced it.
  const defectOfIssue = new Map<string, string>();
  for (const [reportId, name] of defectOfReport) {
    const row = service.store.get<{ issue_id: string | null }>('SELECT issue_id FROM reports WHERE id = ?', reportId);
    if (row?.issue_id) defectOfIssue.set(row.issue_id, name);
  }
  const flagged = service.hotspots().flagged.map((h) => ({ name: defectOfIssue.get(h.issue.id) ?? h.issue.title, top: h.segments[0]! }));
  const issues = service.issues();
  service.close();

  return SEEDED.map((seeded) => {
    const hit = flagged.find((x) => x.name === seeded.name);
    const issue = issues.find((i) => defectOfIssue.get(String(i.id)) === seeded.name);
    const correct = seeded.expect ? hit?.top.dimension === seeded.expect.dimension && hit?.top.value === seeded.expect.value : hit === undefined;
    return { name: seeded.name, sessions: Number(issue?.sessions ?? 0), category: String(issue?.category ?? ''), flagged: hit !== undefined, correct };
  });
}

const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const ratio = (a: number, b: number) => (b === 0 ? null : a / b);

async function sweep(sessions: number) {
  const started = performance.now();
  const runs: Awaited<ReturnType<typeof runSeed>>[] = [];
  for (let seed = 1; seed <= SEEDS; seed++) runs.push(await runSeed(seed, sessions));
  // A defect counts as found only when its top segment is the seeded one; flagging a fleet-wide
  // defect, or blaming the wrong segment, is a false positive.
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const rows of runs) {
    rows.forEach((row, i) => {
      const expected = SEEDED[i]!.expect;
      if (expected && row.correct) tp++;
      else if (row.flagged) fp++;
      else if (expected) fn++;
    });
  }
  return {
    sessionsPerRun: sessions,
    seconds: Number(((performance.now() - started) / 1000).toFixed(1)),
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn),
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    perDefect: SEEDED.map((s, i) => ({
      name: s.name,
      expected: s.expect ? `${s.expect.dimension} = ${s.expect.value}` : 'not flagged (fleet-wide)',
      correctRuns: runs.filter((rows) => rows[i]!.correct).length,
      medianSessions: median(runs.map((rows) => rows[i]!.sessions)),
      rootCause: runs[0]![i]!.category,
    })),
  };
}

const results: Awaited<ReturnType<typeof sweep>>[] = [];
for (const size of SIZES) results.push(await sweep(size));

const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const k = (n: number) => `${n / 1000}k`;
console.log(`Fleet simulation: ${SEEDS} seeded runs per fleet size; synthetic sessions, real ingestion and analysis.\n`);
console.log('| Sessions per run | Precision | Recall | False positives | Time |');
console.log('|---|---|---|---|---|');
for (const r of results) console.log(`| ${k(r.sessionsPerRun)} | ${pct(r.precision)} | ${pct(r.recall)} | ${r.falsePositives} | ${r.seconds} s |`);
console.log(`\n| Seeded defect | Expected | Root cause assigned | ${results.map((r) => `${k(r.sessionsPerRun)}: correct (median sessions)`).join(' | ')} |`);
console.log(`|---|---|---|${results.map(() => '---|').join('')}`);
SEEDED.forEach((s, i) => {
  const p = results[0]!.perDefect[i]!;
  console.log(`| ${s.name} | ${p.expected} | ${p.rootCause} | ${results.map((r) => `${r.perDefect[i]!.correctRuns}/${SEEDS} (${r.perDefect[i]!.medianSessions})`).join(' | ')} |`);
});
if (values.out) writeFileSync(values.out, `${JSON.stringify({ seeds: SEEDS, results }, null, 2)}\n`);
// False alarms must never happen; misses are expected only while a defect has too few sessions.
const largest = results[results.length - 1]!;
if (results.some((r) => r.falsePositives > 0) || (largest.recall ?? 1) < 0.95) process.exitCode = 1;
