import { createHash } from 'node:crypto';
import { parseAnrTrace, type AnrThread } from './anrTrace.ts';
import { classifyJvm, classifyMainThread, classifyNative, formatJava, shortJava, simpleName, type ThreadInfo } from './classify.ts';
import type { JavaFrame, Mapping } from './retrace.ts';
import { symbolize, type SymbolizedLocation } from './symbolize.ts';
import { parseTombstone } from './tombstone.ts';
import type { Analysis, DisplayFrame, Envelope, IssueKind } from './types.ts';

export type AnalyzeContext = {
  mapping(appVersion: string, build: number): Mapping | null;
  symbolFile(buildId: string): string | null;
  symbolizer: string | null;
};

type RawFrame = { c: string; m: string; f?: string; l?: number };

export function fingerprint(kind: IssueKind, parts: string[]): string {
  return createHash('sha1').update([kind, ...parts].join('|')).digest('hex').slice(0, 16);
}

// Lambda and anonymous-class numbering changes between builds; it must not split issues.
export const normalizeFrame = (f: JavaFrame) =>
  `${f.className.replace(/\$\$ExternalSynthetic\w+?\d+/g, '$$Synthetic').replace(/\$\d+/g, '$N')}.${f.method.replace(/\$\d+$/, '').replace(/^lambda\$(\w+)\$\d+$/, 'lambda$$$1')}`;

function toJava(frames: RawFrame[] | undefined): JavaFrame[] {
  return (frames ?? []).map((f) => ({ className: String(f.c), method: String(f.m), file: f.f ?? null, line: typeof f.l === 'number' ? f.l : 0 }));
}

class JavaView {
  private readonly appId: string;
  private readonly mapping: Mapping | null;
  constructor(appId: string, mapping: Mapping | null) {
    this.appId = appId;
    this.mapping = mapping;
  }
  get retraced(): boolean {
    return this.mapping !== null;
  }
  frames(raw: JavaFrame[], thrown?: string): JavaFrame[] {
    return this.mapping ? this.mapping.frames(raw, thrown) : raw;
  }
  type(name: string): string {
    return this.mapping ? this.mapping.className(name) : name;
  }
  isInApp = (f: JavaFrame) => f.className.startsWith(this.appId);
  display = (frames: JavaFrame[]): DisplayFrame[] => frames.slice(0, 40).map((f) => ({ text: formatJava(f), inApp: this.isInApp(f), kind: 'java' as const }));
  topParts(frames: JavaFrame[], n = 3): string[] {
    const app = frames.filter(this.isInApp);
    return (app.length > 0 ? app : frames).slice(0, n).map(normalizeFrame);
  }
}

const baseName = (path: string) => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('!')) + 1);

/** The most frequent value; ties go to preferred values, then to the earliest. */
function mostCommon<T>(values: T[], preferred: (v: T) => boolean = () => false): T {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: { v: T; n: number } | null = null;
  for (const [v, n] of counts) {
    if (!best || n > best.n || (n === best.n && preferred(v) && !preferred(best.v))) best = { v, n };
  }
  return best!.v;
}

type NativeFrameIn = { relPc: bigint; buildId: string | null; symbol: string | null; module: string };
type NativeFrameOut = NativeFrameIn & { functionName: string | null; file: string | null; line: number; inApp: boolean; inlined: boolean };

const isAppModule = (module: string) => (/\/data\/app\//.test(module) || /base\.apk!/.test(module)) && !/libblackbox\.so$/.test(module);
// Inlined NDK headers (FORTIFY string.h, libc++) are toolchain code, not app code.
const isToolchainSource = (file: string) => /\/sysroot\/|\/toolchains\/llvm\/|\/sources\/cxx-stl\//.test(file.replace(/\\/g, '/'));

async function resolveNative(frames: NativeFrameIn[], ctx: AnalyzeContext): Promise<{ frames: NativeFrameOut[]; symbolicated: boolean }> {
  const resolved = new Map<number, SymbolizedLocation[]>();
  if (ctx.symbolizer) {
    const byBuild = new Map<string, number[]>();
    frames.forEach((f, i) => {
      if (f.buildId && ctx.symbolFile(f.buildId)) byBuild.set(f.buildId, [...(byBuild.get(f.buildId) ?? []), i]);
    });
    for (const [buildId, indexes] of byBuild) {
      try {
        const results = await symbolize(ctx.symbolizer, ctx.symbolFile(buildId)!, indexes.map((i) => frames[i]!.relPc));
        results.forEach((chain, k) => chain.length > 0 && resolved.set(indexes[k]!, chain));
      } catch {
        // Symbolication is best effort; the raw frames are still useful.
      }
    }
  }
  const out = frames.flatMap((f, i): NativeFrameOut[] => {
    const appModule = isAppModule(f.module);
    const chain = resolved.get(i);
    if (!chain) return [{ ...f, functionName: f.symbol, file: null, line: 0, inApp: appModule, inlined: false }];
    return chain.map((s, k) => ({
      ...f,
      functionName: s.functionName,
      file: s.file ? baseName(s.file.replace(/\\/g, '/')) : null,
      line: s.line,
      inApp: appModule && !isToolchainSource(s.file),
      inlined: k < chain.length - 1,
    }));
  });
  return { frames: out, symbolicated: resolved.size > 0 };
}

function nativeDisplay(frames: NativeFrameOut[]): DisplayFrame[] {
  let n = 0;
  return frames.slice(0, 40).map((f) => ({
    text: `${f.inlined ? '(inlined)' : `#${String(n++).padStart(2, '0')}`} ${baseName(f.module)} ${f.functionName ?? `+0x${f.relPc.toString(16)}`}${f.file ? ` (${f.file}:${f.line})` : ''}`,
    inApp: f.inApp,
    kind: 'native' as const,
  }));
}

const nativeLocation = (f: NativeFrameOut | undefined) =>
  f ? `${f.functionName ?? `${baseName(f.module)}+0x${f.relPc.toString(16)}`}${f.file ? ` (${f.file}:${f.line})` : ''}` : 'unknown code';

const nativeParts = (signal: string, frames: NativeFrameOut[]) => {
  const app = frames.filter((f) => f.inApp);
  return [signal, ...(app.length > 0 ? app : frames).slice(0, 3).map((f) => `${baseName(f.module)}:${f.functionName ?? f.relPc.toString(16)}`)];
};

const SIGNALS: Record<number, string> = { 4: 'SIGILL', 5: 'SIGTRAP', 6: 'SIGABRT', 7: 'SIGBUS', 8: 'SIGFPE', 11: 'SIGSEGV', 31: 'SIGSYS' };

function threadsFrom(raw: { name: string; state: string; frames: RawFrame[] }[] | undefined, view: JavaView): ThreadInfo[] {
  return (raw ?? []).map((t) => ({ name: String(t.name), state: String(t.state), frames: view.frames(toJava(t.frames)) }));
}

const displayThreads = (threads: ThreadInfo[], view: JavaView) =>
  threads
    .filter((t) => t.frames.some(view.isInApp))
    .slice(0, 6)
    .map((t) => ({ name: t.name, state: t.state, frames: view.display(t.frames.slice(0, 12)) }));

/** Turns a report into a grouped, explained issue occurrence; null for metric-only reports. */
export async function analyze(r: Envelope, ctx: AnalyzeContext): Promise<Analysis | null> {
  const view = new JavaView(r.app.id, ctx.mapping(r.app.version, r.app.build));
  const p = r.payload;

  switch (r.type) {
    case 'jvm_crash':
    case 'non_fatal': {
      const chain: { type: string; message: string | null; frames: JavaFrame[] }[] = [];
      for (let e = p.exception; e && chain.length < 5; e = e.cause) {
        const type = view.type(String(e.type));
        // R8 can inline the exception's constructor into the throwing method; the JVM never shows
        // those frames, so neither do we.
        const retraced = view.frames(toJava(e.frames), type);
        const own = retraced.findIndex((f) => !(f.method === '<init>' && f.className === type));
        chain.push({ type, message: e.message ?? null, frames: own > 0 ? retraced.slice(own) : retraced });
      }
      if (chain.length === 0) return null;
      const frames = chain[0]!.frames;
      const others = threadsFrom(p.threads, view);
      const kind: IssueKind = r.type === 'jvm_crash' ? 'crash' : 'non_fatal';
      const classified = classifyJvm({
        chain,
        frames,
        crashThread: { name: String(p.thread?.name ?? '?'), main: Boolean(p.thread?.main) },
        otherThreads: others,
        isInApp: view.isInApp,
        memory: r.memory,
      });
      const appFrame = frames.find(view.isInApp) ?? frames[0];
      const c =
        kind === 'non_fatal' && classified.category === 'Uncaught exception'
          ? { ...classified, category: 'Handled exception', explanation: `${simpleName(chain[0]!.type)} was caught and reported from ${appFrame ? shortJava(appFrame) : 'app code'}.` }
          : classified;
      return {
        ...c,
        kind,
        title: `${simpleName(chain[0]!.type)}${chain[0]!.message ? `: ${String(chain[0]!.message).slice(0, 140)}` : ''}`,
        location: appFrame ? shortJava(appFrame) : '',
        frames: view.display(frames),
        threads: c.category === 'Race condition' ? displayThreads(others, view) : undefined,
        fingerprint: fingerprint(kind, [chain[0]!.type, ...view.topParts(frames)]),
        retraced: view.retraced,
        symbolicated: false,
      };
    }

    case 'native_crash': {
      const raw: NativeFrameIn[] = (p.frames ?? []).map((f: { relPc: string; buildId: string | null; symbol: string | null; module: string }) => ({
        relPc: BigInt(f.relPc ?? '0x0'),
        buildId: f.buildId ?? null,
        symbol: f.symbol ?? null,
        module: String(f.module ?? '?'),
      }));
      const { frames, symbolicated } = await resolveNative(raw, ctx);
      const top = frames.find((f) => f.inApp) ?? frames[0];
      const signalName = String(p.signalName ?? SIGNALS[p.signal] ?? `signal ${p.signal}`);
      const c = classifyNative({
        signalName,
        code: Number(p.code ?? 0),
        faultAddress: BigInt(p.faultAddress ?? '0x0'),
        location: nativeLocation(top),
        topModule: frames[0]?.module ?? '',
        hasInAppFrame: frames.some((f) => f.inApp),
        functionNames: frames.flatMap((f) => (f.functionName ? [f.functionName] : [])),
      });
      return {
        ...c,
        kind: 'native_crash',
        title: `${signalName} in ${top?.functionName ?? baseName(top?.module ?? 'unknown')}`,
        location: nativeLocation(top),
        frames: nativeDisplay(frames),
        fingerprint: fingerprint('native_crash', nativeParts(signalName, frames)),
        retraced: false,
        symbolicated,
        evidence: [...c.evidence, 'Captured by the in-process signal handler'],
      };
    }

    case 'app_exit':
      return analyzeExit(r, ctx, view);

    case 'app_hang': {
      const samples: JavaFrame[][] = (p.mainThreadSamples ?? []).map((s: RawFrame[]) => view.frames(toJava(s)));
      if (samples.length === 0) return null;
      const others = threadsFrom(p.threads, view);
      const blockedMs = Number(p.blockedMs ?? 0);
      const runs = samples.map((frames) => ({
        frames,
        key: view.topParts(frames, 1)[0] ?? '',
        c: classifyMainThread({ source: 'hang', mainState: p.mainThreadState ?? null, mainFrames: frames, otherThreads: others, isInApp: view.isInApp, blockedMs }),
      }));
      // Samples taken while the main thread stayed blocked vote for the cause; within the winning
      // cause, the app frame seen most often is where the time went.
      const category = mostCommon(runs.map((r) => r.c.category), (c) => c !== 'Main thread busy');
      const inCategory = runs.filter((r) => r.c.category === category);
      const key = mostCommon(inCategory.map((r) => r.key));
      const { frames, c } = inCategory.find((r) => r.key === key)!;
      const appFrame = frames.find(view.isInApp) ?? frames[0];
      return {
        ...c,
        kind: 'hang',
        title: `Main thread blocked ${p.ongoing ? '≥' : ''}${(blockedMs / 1000).toFixed(1)} s: ${c.category}`,
        location: appFrame ? shortJava(appFrame) : '',
        frames: view.display(frames),
        threads: displayThreads(others, view),
        fingerprint: fingerprint('hang', [c.category, ...view.topParts(frames, 2)]),
        retraced: view.retraced,
        symbolicated: false,
        evidence: [...c.evidence, `${inCategory.length} of ${samples.length} main-thread samples${p.ongoing ? '; the process ended while still blocked' : ''}`],
      };
    }

    case 'leak': {
      const className = String(p.className ?? 'unknown');
      return {
        kind: 'leak',
        category: 'Memory leak',
        confidence: 'high',
        title: `${simpleName(className)} leaked`,
        location: className,
        explanation: `${className} was still reachable ${(Number(p.retainedMs ?? 0) / 1000).toFixed(1)} s after ${String(p.description ?? 'it should have been released')}, even after a forced garbage collection. Typical causes: a static field, a listener or callback that was never unregistered, or a long-running task that captured it.`,
        evidence: [`Retained for ${p.retainedMs} ms`, r.memory ? `Java heap in use: ${(r.memory.heapUsedKb / 1024).toFixed(1)} MB` : 'Heap size not reported'],
        frames: [],
        fingerprint: fingerprint('leak', [className]),
        retraced: false,
        symbolicated: false,
      };
    }

    case 'jank': {
      const frames = Number(p.frames ?? 0);
      const slow = Number(p.slowFrames ?? 0);
      const frozen = Number(p.frozenFrames ?? 0);
      const screen = String(p.screen ?? 'unknown');
      if (frames === 0 || (frozen === 0 && slow / frames < 0.25)) return null;
      const pct = Math.round((slow / frames) * 100);
      return {
        kind: 'jank',
        category: frozen > 0 ? 'Frozen frames' : 'Slow rendering',
        confidence: 'high',
        title: `${frozen > 0 ? 'Frozen frames' : 'Slow rendering'} on ${simpleName(screen)}`,
        location: screen,
        explanation: `${pct}% of ${frames} frames missed their deadline${frozen > 0 ? `, and ${frozen} frame(s) took 700 ms or more` : ''}; the worst frame took ${p.worstFrameMs} ms. Look for work in onDraw, layout or the main-thread message queue on this screen.`,
        evidence: [`Slow: ${slow}/${frames}`, `Frozen: ${frozen}`, `Worst frame: ${p.worstFrameMs} ms at ${p.refreshRateHz} Hz`],
        frames: [],
        fingerprint: fingerprint('jank', [screen]),
        retraced: false,
        symbolicated: false,
      };
    }

    default:
      return null;
  }
}

async function analyzeExit(r: Envelope, ctx: AnalyzeContext, view: JavaView): Promise<Analysis | null> {
  const p = r.payload;
  const reason = String(p.reason ?? 'UNKNOWN');

  if (reason === 'ANR' && p.traceFormat === 'anr-text' && typeof p.trace === 'string') {
    const dump = parseAnrTrace(p.trace);
    const main = dump.main;
    if (!main) return null;
    const asInfo = (t: AnrThread): ThreadInfo => ({ name: t.name, state: t.state, frames: view.frames(t.frames) });
    const mainFrames = view.frames(main.frames);
    const lock = main.waitingToLock;
    const holderThread = lock?.heldByTid != null ? dump.threads.find((t) => t.tid === lock.heldByTid) ?? null : null;
    const deadlock = Boolean(holderThread?.waitingToLock && main.heldLocks.includes(holderThread.waitingToLock.address));
    const others = dump.threads.filter((t) => t !== main).map(asInfo);
    const c = classifyMainThread({
      source: 'anr',
      mainState: main.state,
      mainFrames,
      waitingToLock: lock ? { type: lock.type, holder: holderThread ? asInfo(holderThread) : null, holderTid: lock.heldByTid, deadlock } : null,
      otherThreads: others,
      isInApp: view.isInApp,
    });
    const appFrame = mainFrames.find(view.isInApp) ?? mainFrames[0];
    return {
      ...c,
      kind: 'anr',
      title: `ANR: ${c.category}`,
      location: appFrame ? shortJava(appFrame) : '',
      frames: view.display(mainFrames),
      threads: holderThread ? [{ name: holderThread.name, state: holderThread.state, frames: view.display(view.frames(holderThread.frames).slice(0, 12)) }] : displayThreads(others, view),
      fingerprint: fingerprint('anr', [c.category, ...view.topParts(mainFrames, 2)]),
      retraced: view.retraced,
      symbolicated: false,
      evidence: [...c.evidence, `From the system ANR dump (${dump.threads.length} threads), process exit status ${p.status}`],
    };
  }

  if (reason === 'CRASH_NATIVE' && p.traceFormat === 'tombstone-proto-base64' && typeof p.trace === 'string') {
    const t = parseTombstone(Buffer.from(p.trace, 'base64'));
    const thread = t.crashingThread;
    const raw: NativeFrameIn[] = (thread?.frames ?? []).map((f) => ({
      relPc: f.relPc,
      buildId: f.buildId || null,
      symbol: f.functionName || null,
      module: f.fileName,
    }));
    const { frames, symbolicated } = await resolveNative(raw, ctx);
    const top = frames.find((f) => f.inApp) ?? frames[0];
    const signalName = t.signal.name || SIGNALS[t.signal.number] || `signal ${t.signal.number}`;
    const c = classifyNative({
      signalName,
      code: t.signal.code,
      codeName: t.signal.codeName,
      faultAddress: t.signal.faultAddress,
      abortMessage: t.abortMessage,
      causes: t.causes,
      location: nativeLocation(top),
      topModule: frames[0]?.module ?? '',
      hasInAppFrame: frames.some((f) => f.inApp),
      functionNames: frames.flatMap((f) => (f.functionName ? [f.functionName] : [])),
    });
    return {
      ...c,
      kind: 'native_crash',
      title: `${signalName} in ${top?.functionName ?? baseName(top?.module ?? 'unknown')}`,
      location: nativeLocation(top),
      frames: nativeDisplay(frames),
      fingerprint: fingerprint('native_crash', nativeParts(signalName, frames)),
      retraced: false,
      symbolicated,
      evidence: [...c.evidence, `From the Android tombstone (${t.arch}, thread "${thread?.name ?? '?'}")`],
    };
  }

  const importance = Number(p.importance ?? 0);
  const visibility = importance <= 100 ? 'foreground' : importance <= 200 ? 'visible' : importance <= 300 ? 'service' : 'cached';
  const exits: Record<string, { category: string; explanation: string }> = {
    LOW_MEMORY: {
      category: 'Low-memory kill',
      explanation: `The low-memory killer stopped the process while it was ${visibility} (PSS ${Math.round(Number(p.pssKb ?? 0) / 1024)} MB). Reduce memory held while in the background and respond to onTrimMemory.`,
    },
    EXCESSIVE_RESOURCE_USAGE: { category: 'Killed for resource use', explanation: `The system killed the process for excessive resource use: ${p.description ?? 'no detail'}.` },
    SIGNALED: { category: 'Killed by signal', explanation: `The process was killed by signal ${p.status} while ${visibility}${p.description ? `: ${p.description}` : ''}.` },
    INITIALIZATION_FAILURE: { category: 'Initialization failure', explanation: 'The process failed while starting up.' },
  };
  const known = exits[reason];
  if (!known) return null; // CRASH and other reasons are covered by in-process reports.
  return {
    ...known,
    kind: 'exit',
    confidence: 'medium',
    title: `${known.category} (${visibility})`,
    location: String(p.processName ?? r.app.id),
    evidence: [`ApplicationExitInfo reason ${reason}`, `Importance ${importance} (${visibility})`],
    frames: [],
    fingerprint: fingerprint('exit', [reason, visibility]),
    retraced: false,
    symbolicated: false,
  };
}
