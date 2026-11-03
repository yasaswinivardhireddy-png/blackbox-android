// Parses the ART thread dump that Android captures for an ANR (ApplicationExitInfo, REASON_ANR).

export type AnrFrame = { className: string; method: string; file: string | null; line: number };

export type AnrThread = {
  name: string;
  tid: number;
  state: string;
  daemon: boolean;
  frames: AnrFrame[];
  nativeFrames: string[];
  waitingToLock: { address: string; type: string; heldByTid: number | null } | null;
  heldLocks: string[];
};

export type AnrDump = { pid: number | null; commandLine: string | null; threads: AnrThread[]; main: AnrThread | null };

const HEADER = /^"(.*)"\s+(daemon\s+)?prio=\d+\s+tid=(\d+)\s+(\S+)/;
const FRAME = /^\s+at (.+)\((.*)\)\s*$/;
const NATIVE = /^\s+native: (#\d+ pc .*)$/;
const WAITING_TO_LOCK = /^\s+- waiting to lock <(0x[0-9a-fA-F]+)> \(a ([^)]+)\)(?: held by thread (\d+))?/;
const LOCKED = /^\s+- locked <(0x[0-9a-fA-F]+)>/;

export function parseFrameLocation(location: string): { file: string | null; line: number } {
  if (location === 'Native method') return { file: null, line: -2 };
  const colon = location.lastIndexOf(':');
  if (colon > 0 && /^\d+$/.test(location.slice(colon + 1))) {
    const file = location.slice(0, colon);
    return { file: file === 'Unknown Source' ? null : file, line: Number(location.slice(colon + 1)) };
  }
  return { file: location === 'Unknown Source' ? null : location, line: -1 };
}

export function parseAnrTrace(text: string): AnrDump {
  const dump: AnrDump = { pid: null, commandLine: null, threads: [], main: null };
  let current: AnrThread | null = null;
  let sections = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('----- pid ')) {
      sections++;
      if (sections > 1) break; // Only the first process in the dump is the app.
      dump.pid = Number(line.slice(10).split(' ')[0]) || null;
      continue;
    }
    if (line.startsWith('Cmd line:')) {
      dump.commandLine ??= line.slice(9).trim();
      continue;
    }
    const header = HEADER.exec(line);
    if (header) {
      current = {
        name: header[1]!,
        tid: Number(header[3]),
        state: header[4]!,
        daemon: Boolean(header[2]),
        frames: [],
        nativeFrames: [],
        waitingToLock: null,
        heldLocks: [],
      };
      dump.threads.push(current);
      continue;
    }
    if (!current) continue;
    const frame = FRAME.exec(line);
    if (frame) {
      const qualified = frame[1]!;
      const dot = qualified.lastIndexOf('.');
      const { file, line: lineNumber } = parseFrameLocation(frame[2]!);
      current.frames.push({ className: qualified.slice(0, dot), method: qualified.slice(dot + 1), file, line: lineNumber });
      continue;
    }
    const native = NATIVE.exec(line);
    if (native) {
      current.nativeFrames.push(native[1]!.trim());
      continue;
    }
    const waiting = WAITING_TO_LOCK.exec(line);
    if (waiting) {
      current.waitingToLock = { address: waiting[1]!, type: waiting[2]!, heldByTid: waiting[3] ? Number(waiting[3]) : null };
      continue;
    }
    const locked = LOCKED.exec(line);
    if (locked) current.heldLocks.push(locked[1]!);
  }
  dump.main = dump.threads.find((t) => t.name === 'main') ?? dump.threads.find((t) => t.tid === 1) ?? null;
  return dump;
}
