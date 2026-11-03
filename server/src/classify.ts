import type { JavaFrame } from './retrace.ts';
import type { Classification } from './types.ts';

// Root-cause heuristics. Each rule names a bug class and explains the evidence behind it, so an
// engineer can act on the report without reading the whole stack trace.

export const simpleName = (className: string) => className.slice(className.lastIndexOf('.') + 1);
export const outerClass = (className: string) => className.split('$')[0]!;

export function formatJava(f: JavaFrame): string {
  const where = f.line === -2 ? 'Native method' : `${f.file ?? 'Unknown Source'}${f.line && f.line > 0 ? `:${f.line}` : ''}`;
  return `${f.className}.${f.method}(${where})`;
}

export function shortJava(f: JavaFrame): string {
  const where = f.file ? ` (${f.file}${f.line && f.line > 0 ? `:${f.line}` : ''})` : '';
  return `${simpleName(f.className)}.${f.method}${where}`;
}

export type ThreadInfo = { name: string; state: string; frames: JavaFrame[] };

export type JvmInput = {
  chain: { type: string; message: string | null }[];
  frames: JavaFrame[];
  crashThread: { name: string; main: boolean };
  otherThreads: ThreadInfo[];
  isInApp: (f: JavaFrame) => boolean;
  memory?: { heapUsedKb: number; heapMaxKb: number };
};

const COLLECTIONS = /^java\.util\.(ArrayList|HashMap|LinkedList|ArrayDeque|AbstractList|HashSet|LinkedHashMap|TreeMap)/;

export function classifyJvm(input: JvmInput): Classification {
  const top = input.chain[0]!;
  const appFrame = input.frames.find(input.isInApp);
  const where = appFrame ? shortJava(appFrame) : input.frames[0] ? shortJava(input.frames[0]) : 'unknown code';
  const types = input.chain.map((c) => c.type);
  const message = top.message ?? '';

  if (types.includes('java.lang.OutOfMemoryError')) {
    const m = input.memory;
    const heap = m ? `${(m.heapUsedKb / 1024).toFixed(1)} MB of a ${(m.heapMaxKb / 1024).toFixed(0)} MB Java heap` : 'the Java heap';
    return {
      category: 'Out of memory',
      confidence: 'high',
      explanation: `${where} requested memory when ${heap} was in use. Something keeps growing without a bound; caches and lists that are never trimmed are the usual cause.`,
      evidence: [m ? `Heap in use at crash: ${heap}` : 'OutOfMemoryError in the exception chain', `Allocation site: ${where}`],
    };
  }

  const collectionFault = input.frames.slice(0, 6).some((f) => COLLECTIONS.test(f.className));
  if (types.includes('java.util.ConcurrentModificationException') ||
      (collectionFault && /ArrayIndexOutOfBounds|NoSuchElement|IndexOutOfBounds/.test(top.type) && !input.crashThread.main)) {
    const crashClass = appFrame ? outerClass(appFrame.className) : null;
    const concurrent = crashClass
      ? input.otherThreads.find((t) => t.frames.some((f) => input.isInApp(f) && outerClass(f.className) === crashClass))
      : undefined;
    const concurrentFrame = concurrent?.frames.find((f) => input.isInApp(f) && outerClass(f.className) === crashClass);
    return {
      category: 'Race condition',
      confidence: concurrent ? 'high' : 'medium',
      explanation: concurrent
        ? `A collection was modified by one thread while thread "${input.crashThread.name}" iterated it in ${where}. At the moment of the crash, thread "${concurrent.name}" was running ${concurrentFrame ? shortJava(concurrentFrame) : simpleName(crashClass!)} in the same class. Guard the shared state with a lock, confine it to one thread, or use a concurrent collection.`
        : `A non-thread-safe collection was modified while ${where} was iterating it on thread "${input.crashThread.name}". Guard the shared state or confine it to a single thread.`,
      evidence: [
        `${simpleName(top.type)} on ${input.crashThread.main ? 'the main thread' : `background thread "${input.crashThread.name}"`}`,
        ...(concurrent ? [`Concurrent access from thread "${concurrent.name}" (${concurrent.state})`] : []),
      ],
    };
  }

  if (/BadTokenException/.test(top.type) || (/IllegalStateException/.test(top.type) && /onSaveInstanceState|not attached to|FragmentManager/.test(message))) {
    return {
      category: 'Lifecycle misuse',
      confidence: 'high',
      explanation: `${where} touched UI or fragment state after its Activity finished or saved its state. Check the lifecycle state before showing dialogs or committing fragment transactions.`,
      evidence: [`${simpleName(top.type)}: ${message}`],
    };
  }

  if (/SecurityException/.test(top.type) && /RECEIVER_(NOT_)?EXPORTED/.test(message)) {
    return {
      category: 'Platform behavior change',
      confidence: 'high',
      explanation: 'Apps targeting Android 14 must pass RECEIVER_EXPORTED or RECEIVER_NOT_EXPORTED when registering a receiver for non-system broadcasts. Only Android 14+ devices throw, so this appears as an OS-version-specific crash.',
      evidence: [`Thrown in ${where}`],
    };
  }

  if (/ForegroundServiceStartNotAllowedException/.test(top.type)) {
    return {
      category: 'Platform behavior change',
      confidence: 'high',
      explanation: 'Android 12+ blocks starting foreground services from the background. Start the service while the app is visible, or use WorkManager expedited work.',
      evidence: [`Thrown in ${where}`],
    };
  }

  if (/TransactionTooLargeException/.test(top.type)) {
    return { category: 'Binder transaction too large', confidence: 'high', explanation: `${where} sent more than about 1 MB through a Binder transaction (often a large saved-instance-state Bundle or Intent extra).`, evidence: [top.type] };
  }

  if (/DeadObjectException|DeadSystemException/.test(top.type)) {
    return { category: 'Remote process died', confidence: 'medium', explanation: `The process on the other end of a Binder call from ${where} died.`, evidence: [top.type] };
  }

  if (/NullPointerException/.test(top.type)) {
    return { category: 'Null dereference', confidence: 'high', explanation: `A null reference was used in ${where}. ${message}`.trim(), evidence: [message || top.type] };
  }

  if (/IllegalStateException|IllegalArgumentException/.test(top.type)) {
    return {
      category: 'Failed precondition',
      confidence: 'medium',
      explanation: `A check in ${where} rejected the app's state: "${message}". Validate the input before calling, or handle this state explicitly.`,
      evidence: [`${simpleName(top.type)} from ${where}`],
    };
  }

  return { category: 'Uncaught exception', confidence: 'low', explanation: `${simpleName(top.type)} was thrown in ${where} and not caught.`, evidence: [top.type] };
}

export type NativeInput = {
  signalName: string;
  code: number;
  codeName?: string;
  faultAddress: bigint;
  abortMessage?: string;
  causes?: string[];
  location: string;
  topModule: string;
  hasInAppFrame: boolean;
  functionNames?: string[];
};

export function classifyNative(n: NativeInput): Classification {
  const fault = `0x${n.faultAddress.toString(16)}`;
  const codeName = n.codeName || (n.signalName === 'SIGSEGV' ? (n.code === 2 ? 'SEGV_ACCERR' : n.code === 1 ? 'SEGV_MAPERR' : `code ${n.code}`) : `code ${n.code}`);
  const causes = n.causes ?? [];
  // Without an abort message (the in-process handler cannot read it), the checked libc entry
  // point on the stack, such as __strcpy_chk, still identifies a FORTIFY failure.
  const fortifyFrame = n.signalName === 'SIGABRT' ? n.functionNames?.find((f) => /^__\w+_chk$|^__fortify_fatal/.test(f)) : undefined;

  if ((n.abortMessage && /FORTIFY/.test(n.abortMessage)) || fortifyFrame) {
    return {
      category: 'Buffer overflow (FORTIFY)',
      confidence: 'high',
      explanation: `Bionic's FORTIFY check stopped a write past the end of a fixed-size buffer in ${n.location}${n.abortMessage ? `: "${n.abortMessage}"` : ` (detected by ${fortifyFrame})`}. Size the buffer for the input, or use a bounded copy such as strlcpy or snprintf.`,
      evidence: [n.abortMessage ? `Abort message: ${n.abortMessage}` : `${fortifyFrame} on the crashing stack`, `${n.signalName} raised by abort()`],
    };
  }

  const memoryCause = causes.find((c) => /use-after-free|double free|buffer overflow|buffer underflow|invalid free/i.test(c));
  if (memoryCause) {
    return { category: 'Heap memory corruption', confidence: 'high', explanation: `The allocator detected ${memoryCause} in ${n.location}.`, evidence: causes };
  }

  // Treble partitions the device maker customizes: vendor, odm, product, system_ext.
  if (!n.hasInAppFrame && /^\/(vendor|odm|product|system_ext)\//.test(n.topModule)) {
    return {
      category: 'OEM library crash',
      confidence: 'medium',
      explanation: `The crash is inside ${n.topModule}, a library the device maker ships, with no app frame on the stack. Check whether it is limited to one manufacturer or model, and work around the API call that reaches it.`,
      evidence: [`${n.signalName} in ${n.topModule}`],
    };
  }

  if (n.signalName === 'SIGSEGV' && n.faultAddress < 0x1000n) {
    return {
      category: 'Null pointer dereference',
      confidence: 'high',
      explanation: `${n.signalName} (${codeName}) at fault address ${fault}: memory just past address 0 was accessed, which is what reading a field through a null struct pointer does. Crash site: ${n.location}.`,
      evidence: [`Fault address ${fault} is inside the first page`, ...causes.map((c) => `Debuggerd: ${c}`)],
    };
  }

  if (n.signalName === 'SIGSEGV' || n.signalName === 'SIGBUS') {
    return {
      category: 'Invalid memory access',
      confidence: 'medium',
      explanation: `${n.signalName} (${codeName}) at ${fault} in ${n.location}: a dangling, uninitialized or out-of-bounds pointer.`,
      evidence: [`Fault address ${fault}`, ...causes],
    };
  }

  if (n.signalName === 'SIGABRT') {
    return {
      category: 'Abort',
      confidence: n.abortMessage ? 'high' : 'low',
      explanation: n.abortMessage ? `The process aborted in ${n.location}: "${n.abortMessage}".` : `abort() was called in ${n.location} (a failed assertion or an unhandled C++ exception).`,
      evidence: n.abortMessage ? [`Abort message: ${n.abortMessage}`] : ['SIGABRT without an abort message'],
    };
  }

  if (n.signalName === 'SIGFPE') {
    return { category: 'Arithmetic error', confidence: 'medium', explanation: `Integer division by zero or overflow in ${n.location}.`, evidence: [n.signalName] };
  }

  return { category: 'Native crash', confidence: 'low', explanation: `${n.signalName} in ${n.location}.`, evidence: [n.signalName] };
}

export type MainThreadInput = {
  source: 'anr' | 'hang';
  mainState: string | null;
  mainFrames: JavaFrame[];
  waitingToLock?: { type: string; holder: ThreadInfo | null; holderTid: number | null; deadlock: boolean } | null;
  otherThreads: ThreadInfo[];
  isInApp: (f: JavaFrame) => boolean;
  blockedMs?: number;
};

const BLOCKING_RULES: { category: string; advice: string; test: (f: JavaFrame) => boolean }[] = [
  {
    category: 'SharedPreferences flush on main thread',
    advice: 'Pending SharedPreferences.apply() writes are flushed synchronously during Activity and Service lifecycle callbacks. Move to DataStore or batch the writes.',
    test: (f) => /QueuedWork$/.test(f.className) || (/SharedPreferencesImpl/.test(f.className) && /commit|awaitLoadedLocked/.test(f.method)),
  },
  {
    category: 'Disk I/O on main thread',
    advice: 'Move file and database work to a background thread (a coroutine on Dispatchers.IO or an executor).',
    test: (f) => /^java\.io\.(FileOutputStream|FileInputStream|RandomAccessFile|FileDescriptor)$|^libcore\.io\.|^android\.system\.Os$|^java\.nio\.channels\.FileChannel|^android\.database\.sqlite\./.test(f.className),
  },
  {
    category: 'Network I/O on main thread',
    advice: 'Never block the UI thread on the network; use an asynchronous client call.',
    test: (f) => /^java\.net\.|^okhttp3\.|^com\.android\.okhttp\.|^javax\.net\.ssl\./.test(f.className),
  },
  {
    category: 'Binder IPC on main thread',
    advice: 'A synchronous call to another process blocked the UI thread. Cache the result or move the call off the main thread.',
    test: (f) => f.className === 'android.os.BinderProxy' && f.method.startsWith('transact'),
  },
  {
    category: 'Main thread sleeping',
    advice: 'Replace the sleep with a delayed callback or coroutine delay().',
    test: (f) => (f.className === 'java.lang.Thread' && f.method === 'sleep') || (f.className === 'android.os.SystemClock' && f.method === 'sleep'),
  },
  {
    category: 'Main thread waiting',
    advice: 'The main thread is parked on a future, latch or condition. Make the dependency asynchronous.',
    test: (f) => (f.className === 'java.lang.Object' && f.method === 'wait') || /LockSupport$/.test(f.className) || /CountDownLatch|FutureTask|CompletableFuture/.test(f.className),
  },
];

export function classifyMainThread(m: MainThreadInput): Classification {
  const appFrame = m.mainFrames.find(m.isInApp);
  const where = appFrame ? shortJava(appFrame) : m.mainFrames[0] ? shortJava(m.mainFrames[0]) : 'unknown code';
  const subject = m.source === 'anr' ? 'The system declared an ANR:' : `The main thread was unresponsive for ${m.blockedMs ?? 0} ms:`;
  const blocked = /^blocked$/i.test(m.mainState ?? '');

  if (m.waitingToLock || blocked) {
    let holder = m.waitingToLock?.holder ?? null;
    const confidence: Classification['confidence'] = holder ? 'high' : 'medium';
    if (!holder && appFrame) {
      // Without a lock owner (the in-process watchdog cannot see one), suspect the thread
      // running code of the same class.
      const cls = outerClass(appFrame.className);
      holder = m.otherThreads.find((t) => t.frames.some((f) => m.isInApp(f) && outerClass(f.className) === cls)) ?? null;
    }
    const holderFrame = holder?.frames.find(m.isInApp);
    if (m.waitingToLock?.deadlock && holder) {
      return {
        category: 'Deadlock',
        confidence: 'high',
        explanation: `${subject} the main thread (${where}) and thread "${holder.name}"${holderFrame ? ` (${shortJava(holderFrame)})` : ''} each hold a lock the other is waiting for. Acquire the locks in one consistent order.`,
        evidence: [`Main thread waits for a lock owned by "${holder.name}"`, `"${holder.name}" waits for a lock owned by the main thread`],
      };
    }
    const holderText = holder
      ? `thread "${holder.name}" (${holder.state.toLowerCase()}${holderFrame ? ` in ${shortJava(holderFrame)}` : ''})${m.waitingToLock?.holder ? '' : ', which is running code of the same class,'}`
      : 'another thread';
    return {
      category: 'Lock contention',
      confidence,
      explanation: `${subject} ${where} is waiting for a lock${m.waitingToLock ? ` on ${m.waitingToLock.type}` : ''} held by ${holderText}. Do not do slow work while holding a lock the UI thread needs, or read the state without blocking.`,
      evidence: [
        `Main thread state: ${m.mainState ?? 'Blocked'}`,
        ...(m.waitingToLock?.holderTid ? [`Lock owner: tid ${m.waitingToLock.holderTid}${holder ? ` ("${holder.name}")` : ''}`] : []),
        ...(holderFrame ? [`Owner is in ${shortJava(holderFrame)}`] : []),
      ],
    };
  }

  for (const frame of m.mainFrames.slice(0, 12)) {
    const rule = BLOCKING_RULES.find((r) => r.test(frame));
    if (rule) {
      return {
        category: rule.category,
        confidence: 'high',
        explanation: `${subject} ${where} is blocked in ${shortJava(frame)}. ${rule.advice}`,
        evidence: [`Blocking call: ${frame.className}.${frame.method}`, `Called from: ${where}`],
      };
    }
  }

  return {
    category: 'Main thread busy',
    confidence: 'low',
    explanation: `${subject} the main thread was executing ${where} the whole time (CPU-bound work). Profile it with Perfetto or simpleperf and move the work off the UI thread.`,
    evidence: [`Top frame: ${m.mainFrames[0] ? formatJava(m.mainFrames[0]) : 'none'}`],
  };
}
