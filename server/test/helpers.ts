import { fileURLToPath } from 'node:url';
import { ProtoWriter } from '../src/tombstone.ts';
import type { Envelope } from '../src/types.ts';

export const APP_ID = 'io.github.yasaswini.blackbox.sample';
export const SO_PATH = fileURLToPath(new URL('./fixtures/libcrashy-x86_64.so', import.meta.url));
export const BUILD_ID = 'f6e867daec391aaa130454b73656dcd48cd6fb4a';
export const APP_LIB = `/data/app/~~Zq3xWm1nR8==/${APP_ID}-Hk2wPq7vT4==/base.apk!libcrashy.so`;
const LIBC = '/apex/com.android.runtime/lib64/bionic/libc.so';
const LIBART = '/apex/com.android.art/lib64/libart.so';

let seq = 0;

export type EnvelopeOptions = {
  id?: string;
  sessionId?: string;
  timestamp?: number;
  app?: Partial<Envelope['app']>;
  device?: Partial<Envelope['device']>;
  breadcrumbs?: Envelope['breadcrumbs'];
  memory?: Envelope['memory'];
};

export function envelope(type: string, payload: Record<string, unknown>, o: EnvelopeOptions = {}): Envelope {
  seq++;
  return {
    schema: 1,
    id: o.id ?? `r${String(seq).padStart(6, '0')}`,
    type,
    sessionId: o.sessionId ?? 'session-1',
    timestamp: o.timestamp ?? 1_780_000_000_000 + seq,
    sdk: '1.0.0',
    app: { id: APP_ID, version: '1.0', build: 1, ...o.app },
    device: { manufacturer: 'Google', model: 'sdk_gphone64_x86_64', sdkInt: 34, ...o.device },
    ...(o.breadcrumbs ? { breadcrumbs: o.breadcrumbs } : {}),
    ...(o.memory ? { memory: o.memory } : {}),
    payload,
  };
}

type Frame = [relPc: bigint, functionName: string, offset: bigint, file: string, buildId: string];

function tombstone(signal: (w: ProtoWriter) => void, frames: Frame[], extra: (w: ProtoWriter) => void = () => {}): Uint8Array {
  const w = new ProtoWriter()
    .uint(1, 3) // x86_64
    .string(2, 'google/sdk_gphone64_x86_64/emu64xa:14/UE1A.230829.036.A4/11228894:userdebug/dev-keys')
    .string(4, '2026-07-01 10:00:00.123456789+0000')
    .uint(5, 4321)
    .uint(6, 4321)
    .string(9, APP_ID)
    .message(10, signal);
  extra(w);
  return w
    .message(16, (entry) =>
      entry.uint(1, 4321).message(2, (t) => {
        t.uint(1, 4321).string(2, 'main');
        for (const [relPc, fn, offset, file, buildId] of frames) {
          t.message(4, (f) => f.uint(1, relPc).uint(2, 0x7f3a_0000_0000n + relPc).string(4, fn).uint(5, offset).string(6, file).string(8, buildId));
        }
      }),
    )
    .finish();
}

/** What debuggerd records for the sample's native_crash scenario (null OrderRecord*). */
export function nullDerefTombstone(): Uint8Array {
  return tombstone(
    (s) => s.uint(1, 11).string(2, 'SIGSEGV').uint(3, 1).string(4, 'SEGV_MAPERR').uint(8, 1).uint(9, 4),
    [
      [0xa5bn, 'blackbox_sample_apply_discount', 11n, APP_LIB, BUILD_ID],
      [0x2c5e7cn, 'art_quick_generic_jni_trampoline', 44n, LIBART, 'b1c4a9'],
      [0x2b2e1an, 'art_quick_invoke_static_stub', 586n, LIBART, 'b1c4a9'],
    ],
    (w) => w.message(15, (c) => c.string(1, 'null pointer dereference')),
  );
}

/** What debuggerd records for the sample's native_abort scenario (strcpy into char[8]). */
export function fortifyTombstone(): Uint8Array {
  return tombstone(
    (s) => s.uint(1, 6).string(2, 'SIGABRT').uint(3, -6).string(4, 'SI_TKILL'),
    [
      [0x5c2b0n, 'abort', 368n, LIBC, 'e4a7f2'],
      [0x6f0a1n, '__fortify_fatal(char const*, ...)', 241n, LIBC, 'e4a7f2'],
      [0x6f7c4n, '__strcpy_chk', 84n, LIBC, 'e4a7f2'],
      [0xac9n, 'blackbox_sample_format_label', 41n, APP_LIB, BUILD_ID],
      [0xb3dn, 'Java_io_github_yasaswini_blackbox_sample_NativeCrashes_printReceiptLabel', 29n, APP_LIB, BUILD_ID],
      [0x2c5e7cn, 'art_quick_generic_jni_trampoline', 44n, LIBART, 'b1c4a9'],
    ],
    (w) => w.string(14, 'FORTIFY: strcpy: prevented 19-byte write into 8-byte buffer'),
  );
}

export const frame = (c: string, m: string, f: string | null, l: number) => ({ c, m, f, l });
