// Checks what the server concluded after the emulator run in scripts/e2e.sh: every sample
// scenario must arrive as an issue of the right kind, with the right root cause and location.
//
//   node scripts/e2e-verify.ts --url http://127.0.0.1:8080 [--out e2e-out] [--timeout 60]

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { url: { type: 'string', default: 'http://127.0.0.1:8080' }, out: { type: 'string' }, timeout: { type: 'string', default: '60' } } });

type Issue = { id: string; kind: string; title: string; location: string; category: string; events: number; sessions: number };
type Check = { scenario: string; kind: string; category: RegExp; match: RegExp; flag?: 'retraced' | 'symbolicated' };

const CHECKS: Check[] = [
  { scenario: 'jvm_crash', kind: 'crash', category: /^Failed precondition$/, match: /CheckoutService\.submit \(Scenarios\.kt:53\)/, flag: 'retraced' },
  { scenario: 'race', kind: 'crash', category: /^Race condition$/, match: /OrderFeed/, flag: 'retraced' },
  { scenario: 'oom', kind: 'crash', category: /^Out of memory$/, match: /ImageCache\.fillForever/, flag: 'retraced' },
  { scenario: 'native_crash', kind: 'native_crash', category: /^Null pointer dereference$/, match: /blackbox_sample_apply_discount \(crashy\.cpp:23\)/, flag: 'symbolicated' },
  { scenario: 'native_abort', kind: 'native_crash', category: /^Buffer overflow \(FORTIFY\)$/, match: /blackbox_sample_format_label \(crashy\.cpp:34\)/, flag: 'symbolicated' },
  { scenario: 'anr_lock: system ANR', kind: 'anr', category: /^(Lock contention|Deadlock)$/, match: /InventoryRepository/, flag: 'retraced' },
  { scenario: 'anr_lock: in-app watchdog', kind: 'hang', category: /^Lock contention$/, match: /InventoryRepository/ },
  { scenario: 'anr_io: system ANR', kind: 'anr', category: /^Disk I\/O on main thread$/, match: /ReceiptArchive/, flag: 'retraced' },
  { scenario: 'anr_io: in-app watchdog', kind: 'hang', category: /^Disk I\/O on main thread$/, match: /ReceiptArchive/ },
  { scenario: 'jank', kind: 'jank', category: /^Frozen frames$/, match: /JankActivity/ },
  { scenario: 'leak', kind: 'leak', category: /^Memory leak$/, match: /LeakActivity/ },
  { scenario: 'non_fatal', kind: 'non_fatal', category: /^Handled exception$/, match: /PaymentDeclinedException/, flag: 'retraced' },
];

const get = async <T>(path: string): Promise<T> => {
  const res = await fetch(`${values.url}${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
};

async function evaluate() {
  const { items } = await get<{ items: Issue[] }>('/v1/issues');
  const rows = [];
  for (const check of CHECKS) {
    const candidates = items.filter((i) => i.kind === check.kind && check.match.test(`${i.title} ${i.location}`));
    const issue = candidates.find((i) => check.category.test(i.category)) ?? candidates[0];
    let flagOk = true;
    if (issue && check.flag) flagOk = Boolean(((await get<{ analysis: Record<string, unknown> }>(`/v1/issues/${issue.id}`)).analysis)[check.flag]);
    const pass = Boolean(issue && check.category.test(issue.category) && flagOk);
    rows.push({ scenario: check.scenario, pass, kind: check.kind, category: issue?.category ?? '(no issue)', location: issue?.location ?? '', events: issue?.events ?? 0, note: issue && !flagOk ? `not ${check.flag}` : '' });
  }
  return { rows, issues: items };
}

const deadline = Date.now() + Number(values.timeout) * 1000;
let result = await evaluate();
while (result.rows.some((r) => !r.pass) && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000));
  result = await evaluate();
}

const overview = await get<Record<string, unknown>>('/v1/overview');
const passed = result.rows.filter((r) => r.pass).length;
const native = result.issues.filter((i) => i.kind === 'native_crash');
const lines = [
  `### Emulator end-to-end: ${passed}/${result.rows.length} scenarios diagnosed correctly`,
  '',
  '| Scenario | Result | Root cause | Location | Events |',
  '|---|---|---|---|---|',
  ...result.rows.map((r) => `| ${r.scenario} | ${r.pass ? 'PASS' : `FAIL ${r.note}`} | ${r.category} | \`${r.location.replace(/\|/g, '\\|')}\` | ${r.events} |`),
  '',
  `Native crash issues: ${native.length} (each crash is reported by the signal handler and by the Android tombstone, and must be counted once).`,
  '',
  '```json',
  JSON.stringify(overview, null, 2),
  '```',
];
const markdown = lines.join('\n');
console.log(markdown);
if (values.out) {
  mkdirSync(values.out, { recursive: true });
  writeFileSync(join(values.out, 'e2e-summary.md'), `${markdown}\n`);
  writeFileSync(join(values.out, 'e2e-summary.json'), `${JSON.stringify({ passed, total: result.rows.length, rows: result.rows, overview, issues: result.issues }, null, 2)}\n`);
}
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
if (passed !== result.rows.length || native.length !== 2) process.exitCode = 1;
