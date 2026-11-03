import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze, type AnalyzeContext } from '../src/analyze.ts';
import { parseAnrTrace } from '../src/anrTrace.ts';
import { envelope, frame } from './helpers.ts';

const ctx: AnalyzeContext = { mapping: () => null, symbolFile: () => null, symbolizer: null };

const HEADER = `----- pid 4321 at 2026-07-01 10:00:05.123456789+0000 -----
Cmd line: io.github.yasaswini.blackbox.sample
Build fingerprint: 'google/sdk_gphone64_x86_64/emu64xa:14/UE1A.230829.036.A4/11228894:userdebug/dev-keys'
ABI: 'x86_64'
Build type: optimized
DALVIK THREADS (18):
`;

const LOOPER = `  at android.os.Handler.handleCallback(Handler.java:958)
  at android.os.Handler.dispatchMessage(Handler.java:99)
  at android.os.Looper.loopOnce(Looper.java:205)
  at android.os.Looper.loop(Looper.java:294)
  at android.app.ActivityThread.main(ActivityThread.java:8177)
  at java.lang.reflect.Method.invoke(Native method)
  at com.android.internal.os.RuntimeInit$MethodAndArgsCaller.run(RuntimeInit.java:552)
  at com.android.internal.os.ZygoteInit.main(ZygoteInit.java:971)
`;

const mainBlocked = (heldByMain = '') => `"main" prio=5 tid=1 Blocked
  | group="main" sCount=1 ucsCount=0 flags=1 obj=0x72a3c8b8 self=0x7f8d2c3e1000
  | sysTid=4321 nice=-10 cgrp=top-app sched=0/0 handle=0x7f8e1a2b34f8
  | state=S schedstat=( 812345678 123456789 512 ) utm=60 stm=21 core=2 HZ=100
  | stack=0x7ffd3a1e0000-0x7ffd3a1e2000 stackSize=8188KB
  | held mutexes=
  at io.github.yasaswini.blackbox.sample.InventoryRepository.countOnMainThread(Scenarios.kt:72)
  - waiting to lock <0x0c5a1f2e> (a java.lang.Object) held by thread 23
  at io.github.yasaswini.blackbox.sample.InventoryRepository.refreshThenCount(Scenarios.kt:70)
${heldByMain}  at io.github.yasaswini.blackbox.sample.Scenarios.run(Scenarios.kt:38)
  at io.github.yasaswini.blackbox.sample.MainActivity.onCreate$lambda$2(MainActivity.kt:48)
${LOOPER}`;

const refreshSleeping = `"inventory-refresh" prio=5 tid=23 Sleeping
  | group="main" sCount=1 ucsCount=0 flags=1 obj=0x13280a48 self=0x7f8d2c3f4c00
  | sysTid=4398 nice=0 cgrp=top-app sched=0/0 handle=0x7f8b9e5fdcb0
  | held mutexes=
  at java.lang.Thread.sleep(Native method)
  - sleeping on <0x0d2e3f40> (a java.lang.Object)
  at java.lang.Thread.sleep(Thread.java:450)
  - locked <0x0d2e3f40> (a java.lang.Object)
  at java.lang.Thread.sleep(Thread.java:355)
  at android.os.SystemClock.sleep(SystemClock.java:131)
  at io.github.yasaswini.blackbox.sample.InventoryRepository.refreshThenCount$lambda$1(Scenarios.kt:65)
  - locked <0x0c5a1f2e> (a java.lang.Object)
  at kotlin.concurrent.ThreadsKt$thread$thread$1.run(Thread.kt:30)
`;

const refreshWaitingForMain = `"inventory-refresh" prio=5 tid=23 Blocked
  | group="main" sCount=1 ucsCount=0 flags=1 obj=0x13280a48 self=0x7f8d2c3f4c00
  at io.github.yasaswini.blackbox.sample.InventoryRepository.refreshThenCount$lambda$1(Scenarios.kt:66)
  - waiting to lock <0x0aa11bb2> (a java.lang.Object) held by thread 1
  - locked <0x0c5a1f2e> (a java.lang.Object)
  at kotlin.concurrent.ThreadsKt$thread$thread$1.run(Thread.kt:30)
`;

const mainFsync = `"main" prio=5 tid=1 Native
  | group="main" sCount=1 ucsCount=0 flags=1 obj=0x72a3c8b8 self=0x7f8d2c3e1000
  native: #00 pc 000000000009f35a  /apex/com.android.runtime/lib64/bionic/libc.so (fsync+10) (BuildId: 8a4e9b1f)
  at libcore.io.Linux.fsync(Native method)
  at libcore.io.ForwardingOs.fsync(ForwardingOs.java:202)
  at libcore.io.BlockGuardOs.fsync(BlockGuardOs.java:162)
  at java.io.FileDescriptor.sync(Native method)
  at io.github.yasaswini.blackbox.sample.ReceiptArchive.saveAllOnMainThread(Scenarios.kt:84)
  at io.github.yasaswini.blackbox.sample.Scenarios.run(Scenarios.kt:39)
${LOOPER}`;

const dump = (...threads: string[]) => `${HEADER}${threads.join('\n')}\n----- end 4321 -----\n\n----- pid 1234 at 2026-07-01 10:00:05.2 -----\nCmd line: system_server\n"main" prio=5 tid=1 Native\n`;

const anr = (trace: string) => envelope('app_exit', { reason: 'ANR', traceFormat: 'anr-text', trace, status: 0, importance: 100 });

test('parses the ART thread dump of the app process only', () => {
  const d = parseAnrTrace(dump(mainBlocked(), refreshSleeping));
  assert.equal(d.pid, 4321);
  assert.equal(d.commandLine, 'io.github.yasaswini.blackbox.sample');
  assert.deepEqual(d.threads.map((t) => [t.name, t.tid, t.state]), [['main', 1, 'Blocked'], ['inventory-refresh', 23, 'Sleeping']]);
  assert.deepEqual(d.main?.waitingToLock, { address: '0x0c5a1f2e', type: 'java.lang.Object', heldByTid: 23 });
  assert.ok(d.threads[1]!.heldLocks.includes('0x0c5a1f2e'));
  assert.equal(d.main?.frames.find((f) => f.method === 'invoke')?.line, -2);
});

test('names the thread that holds the lock the main thread is waiting for', async () => {
  const a = (await analyze(anr(dump(mainBlocked(), refreshSleeping)), ctx))!;
  assert.equal(a.kind, 'anr');
  assert.equal(a.category, 'Lock contention');
  assert.equal(a.confidence, 'high');
  assert.equal(a.location, 'InventoryRepository.countOnMainThread (Scenarios.kt:72)');
  assert.match(a.explanation, /thread "inventory-refresh" \(sleeping in InventoryRepository\.refreshThenCount\$lambda\$1/);
  assert.equal(a.threads?.[0]?.name, 'inventory-refresh');
});

test('detects a lock-order deadlock', async () => {
  const a = (await analyze(anr(dump(mainBlocked('  - locked <0x0aa11bb2> (a java.lang.Object)\n'), refreshWaitingForMain)), ctx))!;
  assert.equal(a.category, 'Deadlock');
  assert.equal(a.confidence, 'high');
});

test('recognizes disk I/O on the main thread', async () => {
  const a = (await analyze(anr(dump(mainFsync)), ctx))!;
  assert.equal(a.category, 'Disk I/O on main thread');
  assert.equal(a.location, 'ReceiptArchive.saveAllOnMainThread (Scenarios.kt:84)');
  assert.match(a.explanation, /Linux\.fsync/);
});

test('infers the likely lock holder for an in-process hang without lock information', async () => {
  const main = [
    frame('io.github.yasaswini.blackbox.sample.InventoryRepository', 'countOnMainThread', 'Scenarios.kt', 72),
    frame('io.github.yasaswini.blackbox.sample.InventoryRepository', 'refreshThenCount', 'Scenarios.kt', 70),
    frame('android.os.Looper', 'loop', 'Looper.java', 294),
  ];
  const report = envelope('app_hang', {
    blockedMs: 4500,
    thresholdMs: 2000,
    ongoing: false,
    mainThreadState: 'BLOCKED',
    mainThreadSamples: [main, main, main],
    threads: [
      {
        name: 'inventory-refresh',
        state: 'TIMED_WAITING',
        frames: [
          frame('java.lang.Thread', 'sleep', null, -2),
          frame('android.os.SystemClock', 'sleep', 'SystemClock.java', 131),
          frame('io.github.yasaswini.blackbox.sample.InventoryRepository', 'refreshThenCount$lambda$1', 'Scenarios.kt', 65),
        ],
      },
      { name: 'Signal Catcher', state: 'WAITING', frames: [] },
    ],
  });
  const a = (await analyze(report, ctx))!;
  assert.equal(a.kind, 'hang');
  assert.equal(a.category, 'Lock contention');
  assert.equal(a.confidence, 'medium');
  assert.match(a.explanation, /inventory-refresh/);
  assert.ok(a.evidence.includes('3 of 3 main-thread samples'));
  assert.equal(a.title, 'Main thread blocked 4.5 s: Lock contention');
});

test('groups hangs by where the main thread spent most samples', async () => {
  const busy = [frame('io.github.yasaswini.blackbox.sample.ChartView', 'onDraw', 'ChartView.kt', 40), frame('android.view.View', 'draw', 'View.java', 23000)];
  const other = [frame('io.github.yasaswini.blackbox.sample.ChartView', 'measure', 'ChartView.kt', 12)];
  const payload = (samples: unknown[]) => ({ blockedMs: 2500, ongoing: false, mainThreadState: 'RUNNABLE', mainThreadSamples: samples, threads: [] });
  const a = (await analyze(envelope('app_hang', payload([busy, busy, other])), ctx))!;
  const b = (await analyze(envelope('app_hang', payload([other, busy, busy])), ctx))!;
  assert.equal(a.category, 'Main thread busy');
  assert.equal(a.location, 'ChartView.onDraw (ChartView.kt:40)');
  assert.equal(a.fingerprint, b.fingerprint);
});
