import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { analyze, fingerprint, normalizeFrame } from '../src/analyze.ts';
import { classifyJvm, classifyNative } from '../src/classify.ts';
import { findConcentrations, wilsonLowerBound } from '../src/hotspots.ts';
import { Mapping, type JavaFrame } from '../src/retrace.ts';
import { APP_ID, envelope, frame } from './helpers.ts';

const j = (className: string, method: string, file: string | null, line: number): JavaFrame => ({ className, method, file, line });
const isInApp = (f: JavaFrame) => f.className.startsWith(APP_ID);
const jvm = (type: string, message: string | null, frames: JavaFrame[], extra: Partial<Parameters<typeof classifyJvm>[0]> = {}) =>
  classifyJvm({ chain: [{ type, message }], frames, crashThread: { name: 'main', main: true }, otherThreads: [], isInApp, ...extra });

test('explains an out-of-memory crash with the heap state', () => {
  const c = jvm('java.lang.OutOfMemoryError', 'Failed to allocate a 8388624 byte allocation with 6291456 free bytes', [j(`${APP_ID}.ImageCache`, 'fillForever', 'Scenarios.kt', 116)], {
    memory: { heapUsedKb: 190_000, heapMaxKb: 196_608 },
  });
  assert.equal(c.category, 'Out of memory');
  assert.match(c.explanation, /185\.5 MB of a 192 MB Java heap/);
});

test('finds the concurrent writer behind a ConcurrentModificationException', () => {
  const c = classifyJvm({
    chain: [{ type: 'java.util.ConcurrentModificationException', message: null }],
    frames: [
      j('java.util.ArrayList$Itr', 'checkForComodification', 'ArrayList.java', 1095),
      j('java.util.ArrayList$Itr', 'next', 'ArrayList.java', 1049),
      j(`${APP_ID}.OrderFeed$startRacingCoroutines$2`, 'invokeSuspend', 'Scenarios.kt', 106),
    ],
    crashThread: { name: 'DefaultDispatcher-worker-2', main: false },
    otherThreads: [
      { name: 'DefaultDispatcher-worker-3', state: 'RUNNABLE', frames: [j('kotlinx.coroutines.scheduling.CoroutineScheduler$Worker', 'run', 'CoroutineScheduler.kt', 688)] },
      { name: 'DefaultDispatcher-worker-1', state: 'RUNNABLE', frames: [j('java.util.ArrayList', 'add', 'ArrayList.java', 482), j(`${APP_ID}.OrderFeed$startRacingCoroutines$1`, 'invokeSuspend', 'Scenarios.kt', 98)] },
    ],
    isInApp,
  });
  assert.equal(c.category, 'Race condition');
  assert.equal(c.confidence, 'high');
  assert.match(c.explanation, /thread "DefaultDispatcher-worker-1" was running OrderFeed\$startRacingCoroutines\$1\.invokeSuspend/);
});

test('treats a background NPE during a concurrent collection write as a race', () => {
  // Captured on the CI emulator: the reader coroutine hit a null element while the writer
  // coroutine was inside ArrayList.add on another dispatcher thread.
  const c = classifyJvm({
    chain: [{ type: 'java.lang.NullPointerException', message: "Attempt to invoke virtual method 'java.lang.Class java.lang.Object.getClass()' on a null object reference" }],
    frames: [
      j(`${APP_ID}.OrderFeed$startRacingCoroutines$2`, 'invokeSuspend', 'Scenarios.kt', 106),
      j('kotlin.coroutines.jvm.internal.BaseContinuationImpl', 'resumeWith', 'ContinuationImpl.kt', 34),
      j('kotlinx.coroutines.DispatchedTask', 'run', 'DispatchedTask.kt', 100),
    ],
    crashThread: { name: 'DefaultDispatcher-worker-2', main: false },
    otherThreads: [
      { name: 'main', state: 'RUNNABLE', frames: [j('android.os.MessageQueue', 'nativePollOnce', null, -2), j('android.os.Looper', 'loop', 'Looper.java', 294)] },
      { name: 'DefaultDispatcher-worker-1', state: 'RUNNABLE', frames: [j('java.util.ArrayList', 'add', 'ArrayList.java', 473), j(`${APP_ID}.OrderFeed$startRacingCoroutines$1`, 'invokeSuspend', 'Scenarios.kt', 98)] },
    ],
    isInApp,
  });
  assert.deepEqual([c.category, c.confidence], ['Race condition', 'high']);
  assert.match(c.explanation, /thread "DefaultDispatcher-worker-1" was running OrderFeed\$startRacingCoroutines\$1\.invokeSuspend \(Scenarios\.kt:98\) in the same class and modifying a collection/);
  // The same NPE with no concurrent writer in that class stays a plain null dereference.
  assert.equal(jvm('java.lang.NullPointerException', null, [j(`${APP_ID}.OrderFeed$startRacingCoroutines$2`, 'invokeSuspend', 'Scenarios.kt', 106)], { crashThread: { name: 'DefaultDispatcher-worker-2', main: false } }).category, 'Null dereference');
});

test('hides an exception constructor that R8 inlined into the throwing method', async () => {
  const mapping = Mapping.parse(readFileSync(new URL('./fixtures/mapping-excerpt.txt', import.meta.url), 'utf8'));
  const report = envelope('non_fatal', {
    thread: { name: 'main', main: true },
    exception: { type: `${APP_ID}.PaymentDeclinedException`, message: 'Card declined', frames: [frame('m6', 'a', 'SourceFile', 55)] },
  });
  const a = (await analyze(report, { mapping: () => mapping, symbolFile: () => null, symbolizer: null }))!;
  assert.equal(a.location, 'PaymentClient.chargeAndReport (Scenarios.kt:125)');
  assert.equal(a.category, 'Handled exception');
  assert.deepEqual(a.frames.map((f) => f.text), [`${APP_ID}.PaymentClient.chargeAndReport(Scenarios.kt:125)`, `${APP_ID}.Scenarios.run(Scenarios.kt:44)`]);
});

test('recognizes platform behavior changes, null dereferences and failed preconditions', () => {
  const at = [j(`${APP_ID}.PromoReceiver`, 'register', 'PromoReceiver.kt', 21)];
  assert.equal(jvm('java.lang.SecurityException', `${APP_ID}: One of RECEIVER_EXPORTED or RECEIVER_NOT_EXPORTED should be specified when a receiver isn't being registered exclusively for system broadcasts`, at).category, 'Platform behavior change');
  assert.equal(jvm('java.lang.NullPointerException', 'Attempt to invoke virtual method on a null object reference', at).category, 'Null dereference');
  const precondition = jvm('java.lang.IllegalStateException', 'Cannot submit an empty cart', [j(`${APP_ID}.CheckoutService`, 'submit', 'Scenarios.kt', 53)]);
  assert.equal(precondition.category, 'Failed precondition');
  assert.match(precondition.explanation, /CheckoutService\.submit \(Scenarios\.kt:53\)/);
});

test('classifies native crashes by signal, fault address and module', () => {
  const base = { code: 1, location: 'blackbox_sample_apply_discount (crashy.cpp:23)', topModule: '/data/app/x/base.apk!libcrashy.so', hasInAppFrame: true };
  assert.equal(classifyNative({ ...base, signalName: 'SIGSEGV', faultAddress: 0x4n }).category, 'Null pointer dereference');
  assert.equal(classifyNative({ ...base, signalName: 'SIGSEGV', faultAddress: 0xdead_beefn }).category, 'Invalid memory access');
  assert.equal(classifyNative({ ...base, signalName: 'SIGSEGV', faultAddress: 0x10n, topModule: '/vendor/lib64/libmigui.so', hasInAppFrame: false }).category, 'OEM library crash');
  assert.equal(classifyNative({ ...base, signalName: 'SIGABRT', faultAddress: 0n, causes: [], abortMessage: 'Scudo ERROR: invalid chunk state' }).category, 'Abort');
  assert.equal(classifyNative({ ...base, signalName: 'SIGSEGV', faultAddress: 0x7a00n, causes: ['use-after-free, 16 bytes into a 32-byte allocation'] }).category, 'Heap memory corruption');
});

test('keeps fingerprints stable across lambda and anonymous-class renumbering', () => {
  assert.equal(normalizeFrame(j(`${APP_ID}.Feed$1`, 'run', null, 0)), normalizeFrame(j(`${APP_ID}.Feed$2`, 'run', null, 0)));
  assert.equal(normalizeFrame(j(`${APP_ID}.Feed`, 'lambda$load$3', null, 0)), normalizeFrame(j(`${APP_ID}.Feed`, 'lambda$load$7', null, 0)));
  assert.equal(
    normalizeFrame(j(`${APP_ID}.Feed$$ExternalSyntheticLambda0`, 'run', null, 0)),
    normalizeFrame(j(`${APP_ID}.Feed$$ExternalSyntheticLambda4`, 'run', null, 0)),
  );
  assert.notEqual(fingerprint('crash', ['a']), fingerprint('anr', ['a']));
});

test('groups the same crash from different lines and messages into one issue', async () => {
  const crash = (line: number, message: string) =>
    envelope('jvm_crash', {
      thread: { name: 'main', main: true },
      exception: { type: 'java.lang.IllegalStateException', message, frames: [frame(`${APP_ID}.CheckoutService`, 'submit', 'Scenarios.kt', line), frame(`${APP_ID}.Scenarios`, 'run', 'Scenarios.kt', 35)] },
      threads: [],
    });
  const ctx = { mapping: () => null, symbolFile: () => null, symbolizer: null };
  const a = (await analyze(crash(53, 'Cannot submit an empty cart'), ctx))!;
  const b = (await analyze(crash(54, 'Cannot submit cart 42'), ctx))!;
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(a.title, 'IllegalStateException: Cannot submit an empty cart');
});

test('computes a conservative share with the Wilson lower bound', () => {
  assert.equal(wilsonLowerBound(0, 0), 0);
  assert.ok(Math.abs(wilsonLowerBound(40, 40) - 0.9124) < 0.001);
  assert.ok(wilsonLowerBound(5, 10) < 0.5);
});

test('flags only small segments that hold most of an issue', () => {
  const fleet = [
    { dimension: 'manufacturer', value: 'Samsung', sessions: 600 },
    { dimension: 'manufacturer', value: 'Xiaomi', sessions: 250 },
    { dimension: 'manufacturer', value: 'Google', sessions: 150 },
  ];
  const onXiaomi = findConcentrations(1000, fleet, 40, [{ dimension: 'manufacturer', value: 'Xiaomi', sessions: 38 }, { dimension: 'manufacturer', value: 'Samsung', sessions: 2 }]);
  assert.deepEqual(onXiaomi.map((c) => c.value), ['Xiaomi']);
  assert.ok(Math.abs(onXiaomi[0]!.lift - 3.8) < 1e-9);
  // The majority manufacturer explains nothing, and tiny issues are not judged.
  assert.deepEqual(findConcentrations(1000, fleet, 40, [{ dimension: 'manufacturer', value: 'Samsung', sessions: 40 }]), []);
  assert.deepEqual(findConcentrations(1000, fleet, 10, [{ dimension: 'manufacturer', value: 'Xiaomi', sessions: 10 }]), []);
});
