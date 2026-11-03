import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Reads the GNU build ID (NT_GNU_BUILD_ID note) from an ELF shared library. */
export function readBuildId(elf: Buffer): string | null {
  if (elf.length < 64 || elf.readUInt32BE(0) !== 0x7f454c46) return null;
  const is64 = elf[4] === 2;
  const little = elf[5] === 1;
  const u16 = (o: number) => (little ? elf.readUInt16LE(o) : elf.readUInt16BE(o));
  const u32 = (o: number) => (little ? elf.readUInt32LE(o) : elf.readUInt32BE(o));
  const u64 = (o: number) => Number(little ? elf.readBigUInt64LE(o) : elf.readBigUInt64BE(o));
  const phoff = is64 ? u64(0x20) : u32(0x1c);
  const phentsize = u16(is64 ? 0x36 : 0x2a);
  const phnum = u16(is64 ? 0x38 : 0x2c);
  for (let i = 0; i < phnum; i++) {
    const ph = phoff + i * phentsize;
    if (u32(ph) !== 4) continue; // PT_NOTE
    const offset = is64 ? u64(ph + 0x08) : u32(ph + 0x04);
    const size = is64 ? u64(ph + 0x20) : u32(ph + 0x10);
    let p = offset;
    while (p + 12 <= offset + size && p + 12 <= elf.length) {
      const namesz = u32(p);
      const descsz = u32(p + 4);
      const type = u32(p + 8);
      const name = p + 12;
      const desc = name + ((namesz + 3) & ~3);
      if (type === 3 && namesz === 4 && elf.toString('latin1', name, name + 3) === 'GNU') {
        return elf.subarray(desc, desc + descsz).toString('hex');
      }
      p = desc + ((descsz + 3) & ~3);
    }
  }
  return null;
}

export type SymbolizedLocation = { functionName: string; file: string; line: number };

/** Finds llvm-symbolizer: $LLVM_SYMBOLIZER, or the newest NDK under $ANDROID_NDK_HOME / $ANDROID_HOME. */
export function findSymbolizer(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.LLVM_SYMBOLIZER && existsSync(env.LLVM_SYMBOLIZER)) return env.LLVM_SYMBOLIZER;
  const exe = process.platform === 'win32' ? 'llvm-symbolizer.exe' : 'llvm-symbolizer';
  const host = process.platform === 'win32' ? 'windows-x86_64' : process.platform === 'darwin' ? 'darwin-x86_64' : 'linux-x86_64';
  const ndkRoots: string[] = [];
  if (env.ANDROID_NDK_HOME) ndkRoots.push(env.ANDROID_NDK_HOME);
  const sdk = env.ANDROID_HOME ?? env.ANDROID_SDK_ROOT;
  if (sdk && existsSync(join(sdk, 'ndk'))) {
    for (const v of readdirSync(join(sdk, 'ndk')).sort().reverse()) ndkRoots.push(join(sdk, 'ndk', v));
  }
  for (const root of ndkRoots) {
    const candidate = join(root, 'toolchains', 'llvm', 'prebuilt', host, 'bin', exe);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolves module-relative addresses to function, file and line with llvm-symbolizer and the
 * unstripped library uploaded for that build ID, using one process per library per report.
 * Each address yields its inline chain, innermost function first; an empty list if unknown.
 */
export async function symbolize(tool: string, library: string, relPcs: bigint[]): Promise<SymbolizedLocation[][]> {
  if (relPcs.length === 0) return [];
  const { stdout } = await run(tool, ['--output-style=JSON', '--demangle', '--obj', library, ...relPcs.map((pc) => `0x${pc.toString(16)}`)], {
    maxBuffer: 16 * 1024 * 1024,
    timeout: 15_000,
  });
  type Entry = { Symbol?: { FunctionName?: string; FileName?: string; Line?: number }[] };
  // Addresses given as arguments produce one JSON array; older versions print one object per line.
  const text = stdout.trim();
  let entries: Entry[];
  try {
    const parsed = JSON.parse(text) as Entry | Entry[];
    entries = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    entries = text.split('\n').flatMap((line) => {
      try {
        return [JSON.parse(line) as Entry];
      } catch {
        return [];
      }
    });
  }
  return relPcs.map((_, i) =>
    (entries[i]?.Symbol ?? [])
      .filter((s) => s.FunctionName && s.FunctionName !== '??')
      .map((s) => ({ functionName: s.FunctionName!, file: s.FileName ?? '', line: s.Line ?? 0 })),
  );
}
