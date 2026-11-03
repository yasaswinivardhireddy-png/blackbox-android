import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { test } from 'node:test';
import { analyze, type AnalyzeContext } from '../src/analyze.ts';
import { findSymbolizer, readBuildId, symbolize } from '../src/symbolize.ts';
import { parseTombstone } from '../src/tombstone.ts';
import { APP_ID, BUILD_ID, SO_PATH, envelope, fortifyTombstone, nullDerefTombstone } from './helpers.ts';

const symbolizer = findSymbolizer();
const skipNoSymbolizer = symbolizer ? false : 'llvm-symbolizer not found (set LLVM_SYMBOLIZER, ANDROID_NDK_HOME or ANDROID_HOME)';

const ctx = (withSymbols: boolean): AnalyzeContext => ({
  mapping: () => null,
  symbolFile: (id) => (withSymbols && id === BUILD_ID ? SO_PATH : null),
  symbolizer: withSymbols ? symbolizer : null,
});

test('reads the GNU build ID that debuggerd and the SDK report', () => {
  assert.equal(readBuildId(readFileSync(SO_PATH)), BUILD_ID);
  assert.equal(readBuildId(Buffer.alloc(128, 1)), null);
});

test('symbolizes addresses and keeps inline chains', { skip: skipNoSymbolizer }, async () => {
  const [crash, call, unknown] = await symbolize(symbolizer!, SO_PATH, [0xa5bn, 0xac9n, 0x123456n]);
  assert.deepEqual(crash!.map((s) => [s.functionName, basename(s.file), s.line]), [['blackbox_sample_apply_discount', 'crashy.cpp', 23]]);
  assert.deepEqual(call!.map((s) => s.functionName), ['strcpy(char*, char const* pass_object_size1)', 'blackbox_sample_format_label']);
  assert.equal(call![1]!.line, 34);
  assert.deepEqual(unknown, []);
});

test('decodes an Android tombstone', () => {
  const t = parseTombstone(nullDerefTombstone());
  assert.equal(t.arch, 'x86_64');
  assert.deepEqual([t.signal.name, t.signal.codeName, t.signal.faultAddress], ['SIGSEGV', 'SEGV_MAPERR', 4n]);
  assert.deepEqual(t.causes, ['null pointer dereference']);
  assert.equal(t.crashingThread?.name, 'main');
  assert.equal(t.crashingThread?.frames[0]?.buildId, BUILD_ID);
  assert.equal(t.crashingThread?.frames[0]?.relPc, 0xa5bn);
});

const tombstoneReport = (trace: Uint8Array) =>
  envelope('app_exit', { reason: 'CRASH_NATIVE', traceFormat: 'tombstone-proto-base64', trace: Buffer.from(trace).toString('base64'), status: 11 });

test('classifies a null pointer dereference from a tombstone', async () => {
  const a = (await analyze(tombstoneReport(nullDerefTombstone()), ctx(false)))!;
  assert.equal(a.kind, 'native_crash');
  assert.equal(a.category, 'Null pointer dereference');
  assert.equal(a.location, 'blackbox_sample_apply_discount');
  assert.equal(a.symbolicated, false);
});

test('symbolizes tombstone frames with the uploaded library', { skip: skipNoSymbolizer }, async () => {
  const a = (await analyze(tombstoneReport(nullDerefTombstone()), ctx(true)))!;
  assert.equal(a.location, 'blackbox_sample_apply_discount (crashy.cpp:23)');
  assert.equal(a.symbolicated, true);
  assert.ok(a.frames[0]!.inApp);
});

test('attributes a FORTIFY abort to the app function, not the inlined libc header', { skip: skipNoSymbolizer }, async () => {
  const a = (await analyze(tombstoneReport(fortifyTombstone()), ctx(true)))!;
  assert.equal(a.category, 'Buffer overflow (FORTIFY)');
  assert.equal(a.location, 'blackbox_sample_format_label (crashy.cpp:34)');
  assert.ok(a.frames.some((f) => f.text.startsWith('(inlined)') && !f.inApp));
});

test('recognizes FORTIFY from the stack when there is no abort message', async () => {
  const report = envelope('native_crash', {
    source: 'signal-handler',
    signal: 6,
    signalName: 'SIGABRT',
    code: -6,
    faultAddress: '0x0',
    frames: [
      { relPc: '0x5c2b0', buildId: 'aa11', symbol: 'abort', module: '/apex/com.android.runtime/lib64/bionic/libc.so' },
      { relPc: '0x6f0a1', buildId: 'aa11', symbol: '__strcpy_chk', module: '/apex/com.android.runtime/lib64/bionic/libc.so' },
      { relPc: '0xac9', buildId: BUILD_ID, symbol: 'blackbox_sample_format_label', module: `/data/app/~~a==/${APP_ID}-b==/base.apk!/lib/x86_64/libcrashy.so` },
    ],
    breadcrumbs: [],
  });
  const a = (await analyze(report, ctx(false)))!;
  assert.equal(a.category, 'Buffer overflow (FORTIFY)');
  assert.equal(a.location, 'blackbox_sample_format_label');
  assert.match(a.explanation, /__strcpy_chk/);
});
