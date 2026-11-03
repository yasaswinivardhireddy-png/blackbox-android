// Decodes Android 12+ native-crash tombstones (protobuf), as returned by
// ApplicationExitInfo.getTraceInputStream() for REASON_CRASH_NATIVE.
// Field numbers follow AOSP system/core/debuggerd/proto/tombstone.proto.

export type TombstoneFrame = {
  relPc: bigint;
  pc: bigint;
  functionName: string;
  functionOffset: bigint;
  fileName: string;
  buildId: string;
};

export type TombstoneThread = { id: number; name: string; frames: TombstoneFrame[] };

export type Tombstone = {
  arch: string;
  buildFingerprint: string;
  timestamp: string;
  pid: number;
  tid: number;
  commandLine: string[];
  signal: { number: number; name: string; code: number; codeName: string; hasFaultAddress: boolean; faultAddress: bigint };
  abortMessage: string;
  causes: string[];
  threads: TombstoneThread[];
  crashingThread: TombstoneThread | null;
};

const ARCH = ['arm32', 'arm64', 'x86', 'x86_64', 'riscv64', 'none'];

type Field = { no: number; wire: number; varint: bigint; bytes: Uint8Array };

function* fields(buf: Uint8Array): Generator<Field> {
  let pos = 0;
  const varint = (): bigint => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (pos >= buf.length) throw new Error('Truncated varint');
      const byte = buf[pos++]!;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 70n) throw new Error('Varint too long');
    }
  };
  const empty = new Uint8Array(0);
  while (pos < buf.length) {
    const key = Number(varint());
    const no = key >>> 3;
    const wire = key & 7;
    if (wire === 0) {
      yield { no, wire, varint: varint(), bytes: empty };
    } else if (wire === 2) {
      const len = Number(varint());
      if (pos + len > buf.length) throw new Error('Truncated field');
      yield { no, wire, varint: 0n, bytes: buf.subarray(pos, pos + len) };
      pos += len;
    } else if (wire === 1) {
      let v = 0n;
      for (let i = 0; i < 8; i++) v |= BigInt(buf[pos + i]!) << BigInt(8 * i);
      pos += 8;
      yield { no, wire, varint: v, bytes: empty };
    } else if (wire === 5) {
      let v = 0n;
      for (let i = 0; i < 4; i++) v |= BigInt(buf[pos + i]!) << BigInt(8 * i);
      pos += 4;
      yield { no, wire, varint: v, bytes: empty };
    } else {
      throw new Error(`Unsupported wire type ${wire}`);
    }
  }
}

const text = (b: Uint8Array) => Buffer.from(b).toString('utf8');
const int32 = (v: bigint) => Number(BigInt.asIntN(32, v));

function frame(buf: Uint8Array): TombstoneFrame {
  const f: TombstoneFrame = { relPc: 0n, pc: 0n, functionName: '', functionOffset: 0n, fileName: '', buildId: '' };
  for (const x of fields(buf)) {
    if (x.no === 1) f.relPc = x.varint;
    else if (x.no === 2) f.pc = x.varint;
    else if (x.no === 4) f.functionName = text(x.bytes);
    else if (x.no === 5) f.functionOffset = x.varint;
    else if (x.no === 6) f.fileName = text(x.bytes);
    else if (x.no === 8) f.buildId = text(x.bytes);
  }
  return f;
}

function thread(buf: Uint8Array): TombstoneThread {
  const t: TombstoneThread = { id: 0, name: '', frames: [] };
  for (const x of fields(buf)) {
    if (x.no === 1) t.id = int32(x.varint);
    else if (x.no === 2) t.name = text(x.bytes);
    else if (x.no === 4) t.frames.push(frame(x.bytes));
  }
  return t;
}

export function parseTombstone(buf: Uint8Array): Tombstone {
  const t: Tombstone = {
    arch: ARCH[0]!, // proto3 omits the zero value, ARM32
    buildFingerprint: '',
    timestamp: '',
    pid: 0,
    tid: 0,
    commandLine: [],
    signal: { number: 0, name: '', code: 0, codeName: '', hasFaultAddress: false, faultAddress: 0n },
    abortMessage: '',
    causes: [],
    threads: [],
    crashingThread: null,
  };
  for (const x of fields(buf)) {
    switch (x.no) {
      case 1: t.arch = ARCH[Number(x.varint)] ?? 'unknown'; break;
      case 2: t.buildFingerprint = text(x.bytes); break;
      case 4: t.timestamp = text(x.bytes); break;
      case 5: t.pid = Number(x.varint); break;
      case 6: t.tid = Number(x.varint); break;
      case 9: t.commandLine.push(text(x.bytes)); break;
      case 10:
        for (const s of fields(x.bytes)) {
          if (s.no === 1) t.signal.number = int32(s.varint);
          else if (s.no === 2) t.signal.name = text(s.bytes);
          else if (s.no === 3) t.signal.code = int32(s.varint);
          else if (s.no === 4) t.signal.codeName = text(s.bytes);
          else if (s.no === 8) t.signal.hasFaultAddress = s.varint !== 0n;
          else if (s.no === 9) t.signal.faultAddress = s.varint;
        }
        break;
      case 14: t.abortMessage = text(x.bytes); break;
      case 15:
        for (const c of fields(x.bytes)) if (c.no === 1) t.causes.push(text(c.bytes));
        break;
      case 16: {
        // map<uint32, Thread> entries: key = 1, value = 2
        for (const entry of fields(x.bytes)) if (entry.no === 2) t.threads.push(thread(entry.bytes));
        break;
      }
    }
  }
  t.crashingThread = t.threads.find((th) => th.id === t.tid) ?? null;
  return t;
}

/** Minimal encoder, used by tests and the fleet simulator to build realistic tombstones. */
export class ProtoWriter {
  private parts: number[] = [];

  private varint(v: bigint): void {
    let x = BigInt.asUintN(64, v);
    while (x >= 0x80n) {
      this.parts.push(Number((x & 0x7fn) | 0x80n));
      x >>= 7n;
    }
    this.parts.push(Number(x));
  }

  uint(no: number, v: number | bigint): this {
    this.varint(BigInt((no << 3) | 0));
    this.varint(BigInt(v));
    return this;
  }

  bytes(no: number, b: Uint8Array): this {
    this.varint(BigInt((no << 3) | 2));
    this.varint(BigInt(b.length));
    for (const x of b) this.parts.push(x);
    return this;
  }

  string(no: number, s: string): this {
    return this.bytes(no, Buffer.from(s, 'utf8'));
  }

  message(no: number, build: (w: ProtoWriter) => void): this {
    const inner = new ProtoWriter();
    build(inner);
    return this.bytes(no, inner.finish());
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}
