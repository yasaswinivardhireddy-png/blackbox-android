// Retraces R8/ProGuard-obfuscated stack frames using mapping.txt.
//
// Mapping format (R8):
//   original.Class -> a.b:
//   # {"id":"sourceFile","fileName":"Scenarios.kt"}
//       1:4:void submit(Cart):52:55 -> a          minified lines 1-4 map to original lines 52-55
//       5:5:void validate():60:60 -> a            consecutive lines with one minified range form an
//       5:5:void submit(Cart):56 -> a             inline chain: innermost frame first, then callers
//       int total -> b                            fields have no parentheses
//
// JSON comments after a member carry metadata: "com.android.tools.r8.synthesized" marks compiler-
// generated frames (hidden from retraced stacks), and "com.android.tools.r8.rewriteFrame" drops
// inlined inner frames when a given exception is thrown at that position (implicit null checks).

export type JavaFrame = { className: string; method: string; file?: string | null; line?: number };

type Rewrite = { throws: string[]; removeInnerFrames: number };

type Member = {
  obf: string;
  original: string;
  originalClass: string | null;
  params: string;
  minStart: number | null;
  minEnd: number | null;
  origStart: number | null;
  origEnd: number | null;
  rewrite: Rewrite | null;
};

type ClassMapping = { original: string; obf: string; sourceFile: string | null; synthesized: boolean; methods: Member[] };

const CLASS_LINE = /^(\S+) -> (\S+):$/;
const METHOD_LINE = /^\s+(?:(\d+):(\d+):)?\S+ ([^\s(]+)\(([^)]*)\)(?::(\d+)(?::(\d+))?)? -> (\S+)$/;
const REWRITE_ACTION = /^removeInnerFrames\((\d+)\)$/;

function metadata(comment: string): Record<string, unknown> | null {
  const start = comment.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(comment.slice(start)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export class Mapping {
  private byObf = new Map<string, ClassMapping>();
  private byOriginal = new Map<string, ClassMapping>();
  // Compiler-generated methods (lambda bridges, outlines), keyed by class.method(params).
  private synthesizedMethods = new Set<string>();
  private defaultExt: 'kt' | 'java' = 'java';

  static parse(text: string): Mapping {
    const mapping = new Mapping();
    let current: ClassMapping | null = null;
    let last: Member | null = null;
    // Metadata comments describe the line they follow: a class header, a method or a field.
    let scope: 'none' | 'class' | 'method' | 'field' = 'none';
    for (const line of text.split('\n')) {
      const trimmed = line.trimEnd();
      if (trimmed === '') continue;
      if (trimmed.trimStart().startsWith('#')) {
        const info = metadata(trimmed);
        if (!info || !current) continue;
        if (scope === 'class') {
          if (info.id === 'sourceFile' && typeof info.fileName === 'string') current.sourceFile = info.fileName;
          else if (info.id === 'com.android.tools.r8.synthesized') current.synthesized = true;
        } else if (scope === 'method' && last) {
          if (info.id === 'com.android.tools.r8.synthesized') mapping.synthesizedMethods.add(memberKey(last, current));
          else if (info.id === 'com.android.tools.r8.rewriteFrame') {
            const conditions = Array.isArray(info.conditions) ? (info.conditions as string[]) : [];
            const action = Array.isArray(info.actions) ? REWRITE_ACTION.exec(String(info.actions[0])) : null;
            if (action) {
              last.rewrite = {
                throws: conditions.flatMap((c) => /^throws\(L(.+);\)$/.exec(c)?.[1]?.replace(/\//g, '.') ?? []),
                removeInnerFrames: Number(action[1]),
              };
            }
          }
        }
        continue;
      }
      if (!line.startsWith(' ')) {
        const m = CLASS_LINE.exec(trimmed);
        last = null;
        scope = m ? 'class' : 'none';
        if (m) {
          current = { original: m[1]!, obf: m[2]!, sourceFile: null, synthesized: false, methods: [] };
          mapping.byObf.set(current.obf, current);
          mapping.byOriginal.set(current.original, current);
        }
        continue;
      }
      if (!current) continue;
      const m = METHOD_LINE.exec(trimmed);
      if (!m) {
        last = null;
        scope = 'field';
        continue;
      }
      scope = 'method';
      const qualified = m[3]!;
      const dot = qualified.lastIndexOf('.');
      // Qualifiers without a package are relative to the package of the enclosing class.
      const owner = dot >= 0 ? qualified.slice(0, dot) : null;
      const pkg = current.original.slice(0, current.original.lastIndexOf('.') + 1);
      last = {
        obf: m[7]!,
        original: dot >= 0 ? qualified.slice(dot + 1) : qualified,
        originalClass: owner && !owner.includes('.') && pkg ? `${pkg}${owner}` : owner,
        params: m[4]!,
        minStart: m[1] !== undefined ? Number(m[1]) : null,
        minEnd: m[2] !== undefined ? Number(m[2]) : null,
        origStart: m[5] !== undefined ? Number(m[5]) : null,
        origEnd: m[6] !== undefined ? Number(m[6]) : null,
        rewrite: null,
      };
      current.methods.push(last);
    }
    const files = [...mapping.byObf.values()].map((c) => c.sourceFile ?? '');
    mapping.defaultExt = files.filter((f) => f.endsWith('.kt')).length >= files.filter((f) => f.endsWith('.java')).length ? 'kt' : 'java';
    return mapping;
  }

  get classCount(): number {
    return this.byObf.size;
  }

  /** Original name of an obfuscated class, or the name unchanged. */
  className(obf: string): string {
    return this.byObf.get(obf)?.original ?? obf;
  }

  private sourceFileOf(className: string): string | null {
    const outer = className.split('$')[0]!;
    return this.byOriginal.get(className)?.sourceFile ?? this.byOriginal.get(outer)?.sourceFile ?? null;
  }

  // R8 records no source file for classes that were fully inlined and removed; like R8's retrace,
  // infer one from the class name and the language of the class it was inlined into.
  private fileFor(className: string, cls: ClassMapping, fallback: string | null): string | null {
    const known = this.sourceFileOf(className);
    if (known) return known;
    if (className === cls.original) return cls.sourceFile ?? fallback;
    const context = cls.sourceFile ?? fallback ?? '';
    const ext = context.endsWith('.kt') ? 'kt' : context.endsWith('.java') ? 'java' : this.defaultExt;
    const outer = className.slice(className.lastIndexOf('.') + 1).split('$')[0]!;
    return `${ext === 'kt' ? outer.replace(/Kt$/, '') : outer}.${ext}`;
  }

  private isSynthesized(m: Member, cls: ClassMapping): boolean {
    const owner = this.byOriginal.get(m.originalClass ?? cls.original);
    return this.synthesizedMethods.has(memberKey(m, cls)) || (owner?.synthesized ?? false);
  }

  /**
   * Retraces one frame. Inlined calls expand into several frames, innermost first. For the top
   * frame of an exception, pass the thrown type so R8's rewriteFrame rules can apply.
   */
  frame(frame: JavaFrame, thrown?: string): JavaFrame[] {
    const cls = this.byObf.get(frame.className);
    if (!cls) return [frame];
    const line = frame.line ?? 0;
    const candidates = cls.methods.filter((m) => m.obf === frame.method);
    const file = cls.sourceFile ?? frame.file ?? null;
    if (candidates.length === 0) return [{ className: cls.original, method: frame.method, file, line }];

    const inRange = line > 0 ? candidates.filter((m) => m.minStart !== null && m.minStart <= line && line <= m.minEnd!) : [];
    if (inRange.length === 0) {
      const pool = candidates.filter((m) => m.minStart === null);
      const chosen = pool.length > 0 ? pool : candidates;
      const names = [...new Set(chosen.map((m) => `${m.originalClass ?? cls.original}#${m.original}`))];
      const first = chosen[0]!;
      const className = first.originalClass ?? cls.original;
      return [{
        className,
        method: names.length === 1 ? first.original : names.map((n) => n.split('#')[1]).join('|'),
        file: this.fileFor(className, cls, file),
        line: first.origStart ?? line,
      }];
    }

    // The first matching entry starts an inline chain; the chain is every entry with that same range.
    const head = inRange[0]!;
    let chain = inRange.filter((m) => m.minStart === head.minStart && m.minEnd === head.minEnd);
    if (thrown) {
      const rule = chain.find((m) => m.rewrite?.throws.includes(thrown))?.rewrite;
      if (rule) chain = chain.slice(Math.min(rule.removeInnerFrames, chain.length - 1));
    }
    const visible = chain.filter((m) => !this.isSynthesized(m, cls));
    return (visible.length > 0 ? visible : chain).map((m) => {
      const className = m.originalClass ?? cls.original;
      return { className, method: m.original, file: this.fileFor(className, cls, file), line: originalLine(m, line) };
    });
  }

  frames(frames: JavaFrame[], thrown?: string): JavaFrame[] {
    return frames.flatMap((f, i) => this.frame(f, i === 0 ? thrown : undefined));
  }
}

function memberKey(m: Member, cls: ClassMapping): string {
  return `${m.originalClass ?? cls.original}.${m.original}(${m.params})`;
}

function originalLine(m: Member, line: number): number {
  if (m.origStart === null) return line;
  if (m.origEnd !== null && m.minStart !== null && m.minEnd !== null && m.origEnd - m.origStart === m.minEnd - m.minStart) {
    return m.origStart + (line - m.minStart);
  }
  return m.origStart;
}
