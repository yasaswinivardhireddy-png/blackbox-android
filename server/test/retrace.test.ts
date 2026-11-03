import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Mapping, type JavaFrame } from '../src/retrace.ts';

// An excerpt of the sample app's real R8 mapping (compiler 9.5, full mode): CheckoutService was
// inlined into Scenarios.run and removed, ReportStore was merged into InventoryRepository (k4),
// and lambdas were compiled into the synthetic class j4.
const mapping = Mapping.parse(readFileSync(new URL('./fixtures/mapping-excerpt.txt', import.meta.url), 'utf8'));
const show = (frames: JavaFrame[]) => frames.map((f) => `${f.className}.${f.method}(${f.file}:${f.line})`);
const at = (className: string, method: string, line: number): JavaFrame => ({ className, method, file: 'SourceFile', line });

test('expands an inlined call into its original frames, innermost first', () => {
  assert.deepEqual(show(mapping.frame(at('m6', 'a', 37))), [
    'io.github.yasaswini.blackbox.sample.CheckoutService.submit(Scenarios.kt:53)',
    'io.github.yasaswini.blackbox.sample.Scenarios.run(Scenarios.kt:35)',
  ]);
});

test('maps a minified line range onto the original line range', () => {
  // 29:30:void ReportStore.<init>(File,int,long):12:13, inlined into the default-arguments overload.
  assert.deepEqual(show(mapping.frame(at('k4', '<init>', 30))), [
    'io.github.yasaswini.blackbox.internal.ReportStore.<init>(ReportStore.kt:13)',
    'io.github.yasaswini.blackbox.internal.ReportStore.<init>(ReportStore.kt:12)',
  ]);
  assert.deepEqual(show(mapping.frame(at('m6', 'a', 5))), ['io.github.yasaswini.blackbox.sample.Scenarios.run(Scenarios.kt:33)']);
});

test('hides synthesized lambda bridges and resolves package-relative qualifiers', () => {
  assert.deepEqual(show(mapping.frame(at('j4', 'a', 23))), [
    'io.github.yasaswini.blackbox.sample.InventoryRepository.refreshThenCount$lambda$1(Scenarios.kt:63)',
  ]);
});

test('applies rewriteFrame rules only for the thrown exception at the top frame', () => {
  // Report.getJson() was inlined into ReportStore.write; an NPE there means `report` was null.
  assert.deepEqual(show(mapping.frame(at('k4', 'd', 9))), [
    'io.github.yasaswini.blackbox.internal.Report.getJson(Reports.kt:5)',
    'io.github.yasaswini.blackbox.internal.ReportStore.write(ReportStore.kt:23)',
  ]);
  assert.deepEqual(show(mapping.frame(at('k4', 'd', 9), 'java.lang.NullPointerException')), [
    'io.github.yasaswini.blackbox.internal.ReportStore.write(ReportStore.kt:23)',
  ]);
  assert.equal(mapping.frame(at('k4', 'd', 9), 'java.lang.IllegalStateException').length, 2);
  assert.deepEqual(show(mapping.frames([at('k4', 'd', 9), at('m6', 'a', 37)], 'java.lang.NullPointerException')), [
    'io.github.yasaswini.blackbox.internal.ReportStore.write(ReportStore.kt:23)',
    'io.github.yasaswini.blackbox.sample.CheckoutService.submit(Scenarios.kt:53)',
    'io.github.yasaswini.blackbox.sample.Scenarios.run(Scenarios.kt:35)',
  ]);
});

test('deobfuscates class names and leaves unknown frames untouched', () => {
  assert.equal(mapping.className('m6'), 'io.github.yasaswini.blackbox.sample.Scenarios');
  assert.equal(mapping.className('android.os.Handler'), 'android.os.Handler');
  const framework = at('android.os.Handler', 'handleCallback', 958);
  assert.deepEqual(mapping.frame(framework), [framework]);
  assert.ok(mapping.classCount >= 5);
});

test('falls back to the method name when the line is unknown', () => {
  const [frame] = mapping.frame({ className: 'm6', method: 'a', file: 'SourceFile', line: 0 });
  assert.equal(frame!.className, 'io.github.yasaswini.blackbox.sample.Scenarios');
  assert.match(frame!.method, /run/);
});

test('takes the source file of a merged lambda class from a sibling class', () => {
  // R8 merged both coroutine lambdas of OrderFeed into v5; only $1 kept a source-file entry.
  assert.deepEqual(show(mapping.frame(at('v5', 'i', 32))), ['io.github.yasaswini.blackbox.sample.OrderFeed$startRacingCoroutines$2.invokeSuspend(Scenarios.kt:106)']);
  assert.deepEqual(show(mapping.frame(at('v5', 'i', 56))), ['io.github.yasaswini.blackbox.sample.OrderFeed$startRacingCoroutines$1.invokeSuspend(Scenarios.kt:98)']);
});
