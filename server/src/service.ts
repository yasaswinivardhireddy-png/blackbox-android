import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyze, type AnalyzeContext } from './analyze.ts';
import { Store } from './db.ts';
import { findConcentrations, type SegmentStat } from './hotspots.ts';
import { HttpError } from './http.ts';
import { Mapping } from './retrace.ts';
import { readBuildId } from './symbolize.ts';
import { REPORT_TYPES, type Analysis, type Envelope } from './types.ts';

const ID = /^[0-9a-zA-Z_-]{1,64}$/;

export type IngestResult = { accepted: string[]; rejected: { id: string | null; error: string }[]; duplicates: number };

function validate(input: unknown): Envelope {
  const r = input as Envelope;
  if (typeof r !== 'object' || r === null) throw new Error('report must be an object');
  if (r.schema !== 1) throw new Error('unsupported schema');
  if (typeof r.id !== 'string' || !ID.test(r.id)) throw new Error('invalid id');
  if (!REPORT_TYPES.includes(r.type as (typeof REPORT_TYPES)[number])) throw new Error(`unknown type ${String(r.type)}`);
  if (typeof r.sessionId !== 'string' || r.sessionId.length > 64) throw new Error('invalid sessionId');
  if (typeof r.timestamp !== 'number') throw new Error('invalid timestamp');
  if (typeof r.app?.id !== 'string' || typeof r.app?.version !== 'string') throw new Error('invalid app');
  if (typeof r.device?.manufacturer !== 'string' || typeof r.device?.model !== 'string' || typeof r.device?.sdkInt !== 'number') throw new Error('invalid device');
  if (typeof r.payload !== 'object' || r.payload === null) throw new Error('invalid payload');
  return r;
}

const percentile = (sorted: number[], q: number) => (sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!);

// JVM breadcrumbs are {t, c, m}; the native ring buffer stores "<ms> <category>: <message>".
function normalizeCrumb(c: unknown): { t: number; c: string; m: string } {
  if (typeof c === 'object' && c !== null) {
    const o = c as { t?: number; c?: string; m?: string };
    return { t: Number(o.t ?? 0), c: String(o.c ?? ''), m: String(o.m ?? '') };
  }
  const m = /^(\d+) ([^:]+): (.*)$/s.exec(String(c));
  return m ? { t: Number(m[1]), c: m[2]!, m: m[3]! } : { t: 0, c: '', m: String(c) };
}

// The SDK rewrites a hang report while the hang continues; a longer version replaces the stored one.
function isLongerHang(r: Envelope, storedBody: string): boolean {
  return r.type === 'app_hang' && Number(r.payload.blockedMs ?? 0) > Number((JSON.parse(storedBody) as Envelope).payload?.blockedMs ?? 0);
}

export class Service {
  readonly store: Store;
  readonly symbolizer: string | null;
  private readonly symbolDir: string;
  private readonly mappingDir: string;
  private readonly tempRoot: string | null;
  private mappings = new Map<string, Mapping | null>();
  private readonly ctx: AnalyzeContext;

  constructor(dataDir: string | null, symbolizer: string | null) {
    this.tempRoot = dataDir ? null : mkdtempSync(join(tmpdir(), 'blackbox-'));
    const root = dataDir ?? this.tempRoot!;
    this.symbolizer = symbolizer;
    this.symbolDir = join(root, 'symbols');
    this.mappingDir = join(root, 'mappings');
    mkdirSync(this.symbolDir, { recursive: true });
    mkdirSync(this.mappingDir, { recursive: true });
    this.store = new Store(dataDir ? join(dataDir, 'blackbox.db') : ':memory:');
    this.ctx = {
      symbolizer,
      symbolFile: (buildId) => this.store.get<{ path: string }>('SELECT path FROM symbols WHERE build_id = ?', buildId)?.path ?? null,
      mapping: (version, build) => this.mapping(version, build),
    };
  }

  private mapping(version: string, build: number): Mapping | null {
    const key = `${version}#${build}`;
    if (!this.mappings.has(key)) {
      const row = this.store.get<{ path: string }>('SELECT path FROM mappings WHERE app_version = ? AND app_build = ?', version, build);
      this.mappings.set(key, row ? Mapping.parse(readFileSync(row.path, 'utf8')) : null);
    }
    return this.mappings.get(key)!;
  }

  uploadSymbols(bytes: Buffer, name: string): { buildId: string; name: string; size: number } {
    const buildId = readBuildId(bytes);
    if (!buildId) throw new HttpError(400, 'no_build_id', 'Upload an unstripped ELF shared library with a GNU build ID');
    const path = join(this.symbolDir, `${buildId}-${name.replace(/[^\w.-]/g, '_')}`);
    writeFileSync(path, bytes);
    this.store.run(
      'INSERT INTO symbols (build_id, name, path, size, uploaded_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(build_id) DO UPDATE SET path = excluded.path, size = excluded.size',
      buildId,
      name,
      path,
      bytes.length,
      Date.now(),
    );
    return { buildId, name, size: bytes.length };
  }

  uploadMapping(text: string, version: string, build: number): { classes: number } {
    if (!version || !Number.isInteger(build) || build < 0) throw new HttpError(400, 'invalid_version', 'Pass ?version=<versionName>&build=<versionCode>');
    const mapping = Mapping.parse(text);
    if (mapping.classCount === 0) throw new HttpError(400, 'invalid_mapping', 'No class mappings found');
    const path = join(this.mappingDir, `${version.replace(/[^\w.-]/g, '_')}-${build}.txt`);
    writeFileSync(path, text);
    this.store.run(
      'INSERT INTO mappings (app_version, app_build, path, classes, uploaded_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(app_version, app_build) DO UPDATE SET path = excluded.path, classes = excluded.classes',
      version,
      build,
      path,
      mapping.classCount,
      Date.now(),
    );
    this.mappings.set(`${version}#${build}`, mapping);
    return { classes: mapping.classCount };
  }

  async ingest(input: unknown): Promise<IngestResult> {
    const list = (input as { reports?: unknown[] })?.reports;
    if (!Array.isArray(list)) throw new HttpError(400, 'invalid_batch', 'Expected {"reports": [...]}');
    if (list.length > 500) throw new HttpError(413, 'batch_too_large', 'At most 500 reports per batch');
    const result: IngestResult = { accepted: [], rejected: [], duplicates: 0 };
    const prepared: { r: Envelope; analysis: Analysis | null }[] = [];
    // Analysis may run the symbolizer, so it happens before the write transaction.
    for (const item of list) {
      let r: Envelope;
      try {
        r = validate(item);
      } catch (error) {
        const id = typeof (item as Envelope)?.id === 'string' ? (item as Envelope).id : null;
        result.rejected.push({ id, error: (error as Error).message });
        continue;
      }
      const stored = this.store.get<{ body: string }>('SELECT body FROM reports WHERE id = ?', r.id);
      if (stored && !isLongerHang(r, stored.body)) {
        result.duplicates++;
        result.accepted.push(r.id);
        continue;
      }
      try {
        prepared.push({ r, analysis: await analyze(r, this.ctx) });
      } catch (error) {
        result.rejected.push({ id: r.id, error: `processing failed: ${(error as Error).message}` });
      }
    }
    // One commit per batch; a savepoint per report keeps one bad report from failing the rest.
    this.store.transaction(() => {
      for (const { r, analysis } of prepared) {
        try {
          if (this.store.savepoint(() => this.write(r, analysis)) === 'duplicate') result.duplicates++;
          result.accepted.push(r.id);
        } catch (error) {
          result.rejected.push({ id: r.id, error: `processing failed: ${(error as Error).message}` });
        }
      }
    });
    return result;
  }

  private write(r: Envelope, analysis: Analysis | null): 'new' | 'updated' | 'duplicate' {
    const existing = this.store.get<{ body: string; issue_id: string | null }>('SELECT body, issue_id FROM reports WHERE id = ?', r.id);
    const body = JSON.stringify(r);
    const analysisJson = analysis ? JSON.stringify(analysis) : null;
    if (existing) {
      if (!isLongerHang(r, existing.body)) return 'duplicate';
      this.store.run('UPDATE reports SET body = ?, analysis = ?, issue_id = ? WHERE id = ?', body, analysisJson, analysis?.fingerprint ?? null, r.id);
      const moved = existing.issue_id !== (analysis?.fingerprint ?? null);
      if (moved && existing.issue_id) this.releaseEvent(existing.issue_id);
      if (analysis) this.upsertIssue(analysis, r, moved ? 1 : 0);
      return 'updated';
    }
    // On Android 12+ one native crash arrives twice: from the in-process signal handler and as
    // the system tombstone. Count it once, under the tombstone's more complete analysis.
    const twin = analysis?.kind === 'native_crash' ? this.nativeTwin(r) : null;
    const joinsTombstone = twin !== null && r.type === 'native_crash';
    this.store.run(
      `INSERT INTO reports (id, type, session_id, ts, received_at, app_version, app_build, manufacturer, model, sdk_int, issue_id, body, analysis)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.id, r.type, r.sessionId, r.timestamp, Date.now(), r.app.version, r.app.build, r.device.manufacturer, r.device.model, r.device.sdkInt,
      joinsTombstone ? twin.issue_id : analysis?.fingerprint ?? null, body, analysisJson,
    );
    this.recordSession(r);
    if (analysis && !joinsTombstone) {
      this.upsertIssue(analysis, r, 1);
      if (twin) {
        this.store.run('UPDATE reports SET issue_id = ? WHERE id = ?', analysis.fingerprint, twin.id);
        this.releaseEvent(twin.issue_id);
      }
    }
    return 'new';
  }

  private nativeTwin(r: Envelope): { id: string; issue_id: string } | null {
    return (
      this.store.get<{ id: string; issue_id: string }>(
        `SELECT id, issue_id FROM reports
         WHERE session_id = ? AND type = ? AND issue_id IS NOT NULL AND json_extract(analysis, '$.kind') = 'native_crash' LIMIT 1`,
        r.sessionId,
        r.type === 'native_crash' ? 'app_exit' : 'native_crash',
      ) ?? null
    );
  }

  /** Removes one occurrence from an issue, deleting the issue when no report points at it any more. */
  private releaseEvent(issueId: string): void {
    this.store.run('UPDATE issues SET events = events - 1 WHERE id = ?', issueId);
    const latest = this.store.get<{ id: string }>('SELECT id FROM reports WHERE issue_id = ? ORDER BY ts DESC LIMIT 1', issueId);
    if (latest) this.store.run('UPDATE issues SET sample_report_id = ? WHERE id = ?', latest.id, issueId);
    else this.store.run('DELETE FROM issues WHERE id = ?', issueId);
  }

  private recordSession(r: Envelope): void {
    this.store.run(
      `INSERT INTO sessions (id, started_at, app_version, manufacturer, model, sdk_int) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET started_at = CASE WHEN ? = 'session' THEN excluded.started_at ELSE sessions.started_at END`,
      r.sessionId, r.timestamp, r.app.version, r.device.manufacturer, r.device.model, r.device.sdkInt, r.type,
    );
    const p = r.payload;
    if (r.type === 'jvm_crash' || r.type === 'native_crash' || (r.type === 'app_exit' && (p.reason === 'CRASH' || p.reason === 'CRASH_NATIVE'))) {
      this.store.run('UPDATE sessions SET crashed = 1 WHERE id = ?', r.sessionId);
    }
    if (r.type === 'app_exit' && p.reason === 'ANR') this.store.run('UPDATE sessions SET anr = 1 WHERE id = ?', r.sessionId);
    if (r.type === 'app_hang') this.store.run('UPDATE sessions SET hang = 1 WHERE id = ?', r.sessionId);
    if (r.type === 'jank') {
      this.store.run(
        'INSERT INTO jank (report_id, session_id, screen, frames, slow, frozen, worst_ms) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
        r.id, r.sessionId, String(p.screen ?? '?'), Number(p.frames ?? 0), Number(p.slowFrames ?? 0), Number(p.frozenFrames ?? 0), Number(p.worstFrameMs ?? 0),
      );
    }
    if (r.type === 'startup') {
      this.store.run(
        'INSERT INTO startups (report_id, session_id, start_type, duration_ms, sdk_init_us) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
        r.id, r.sessionId, String(p.startType ?? 'cold'), Number(p.durationMs ?? 0), Number(p.sdkInitMicros ?? 0),
      );
    }
  }

  private upsertIssue(a: Analysis, r: Envelope, increment: number): void {
    this.store.run(
      `INSERT INTO issues (id, kind, title, location, category, explanation, confidence, first_seen, last_seen, events, sample_report_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET events = issues.events + ?, last_seen = max(issues.last_seen, excluded.last_seen),
         sample_report_id = excluded.sample_report_id, explanation = excluded.explanation, confidence = excluded.confidence, title = excluded.title`,
      a.fingerprint, a.kind, a.title, a.location, a.category, a.explanation, a.confidence, r.timestamp, r.timestamp, increment, r.id, increment,
    );
  }

  overview() {
    const s = this.store.get<{ sessions: number; crashed: number; anr: number; hang: number }>(
      'SELECT COUNT(*) AS sessions, COALESCE(SUM(crashed), 0) AS crashed, COALESCE(SUM(anr), 0) AS anr, COALESCE(SUM(hang), 0) AS hang FROM sessions',
    )!;
    const kinds = this.store.all<{ kind: string; issues: number; events: number }>('SELECT kind, COUNT(*) AS issues, SUM(events) AS events FROM issues GROUP BY kind');
    const cold = this.store.all<{ d: number }>("SELECT duration_ms AS d FROM startups WHERE start_type = 'cold' ORDER BY d").map((x) => x.d);
    const init = this.store.all<{ u: number }>('SELECT sdk_init_us AS u FROM startups WHERE sdk_init_us > 0 ORDER BY u').map((x) => x.u);
    const jank = this.store.get<{ frames: number; slow: number; frozen: number }>(
      'SELECT COALESCE(SUM(frames), 0) AS frames, COALESCE(SUM(slow), 0) AS slow, COALESCE(SUM(frozen), 0) AS frozen FROM jank',
    )!;
    const rate = (n: number) => (s.sessions === 0 ? null : n / s.sessions);
    return {
      sessions: s.sessions,
      crashFreeSessions: s.sessions === 0 ? null : 1 - s.crashed / s.sessions,
      anrRate: rate(s.anr),
      hangRate: rate(s.hang),
      issuesByKind: Object.fromEntries(kinds.map((k) => [k.kind, { issues: k.issues, events: k.events }])),
      coldStartMs: { count: cold.length, p50: percentile(cold, 0.5), p90: percentile(cold, 0.9) },
      sdkInitUs: { count: init.length, p50: percentile(init, 0.5), p90: percentile(init, 0.9) },
      frames: { total: jank.frames, slowShare: jank.frames === 0 ? null : jank.slow / jank.frames, frozen: jank.frozen },
    };
  }

  issues(kind?: string) {
    const rows = this.store.all<Record<string, unknown>>(
      `SELECT i.*, (SELECT COUNT(DISTINCT r.session_id) FROM reports r WHERE r.issue_id = i.id) AS sessions
       FROM issues i ${kind ? 'WHERE i.kind = ?' : ''} ORDER BY sessions DESC, i.last_seen DESC LIMIT 200`,
      ...(kind ? [kind] : []),
    );
    return rows;
  }

  issue(id: string) {
    const issue = this.store.get<Record<string, unknown>>('SELECT * FROM issues WHERE id = ?', id);
    if (!issue) throw new HttpError(404, 'not_found', 'Issue not found');
    const sample = this.store.get<{ body: string; analysis: string }>('SELECT body, analysis FROM reports WHERE id = ?', String(issue.sample_report_id))!;
    const body = JSON.parse(sample.body) as Envelope;
    let crumbs: unknown[] = body.breadcrumbs ?? body.payload.breadcrumbs ?? [];
    if (crumbs.length === 0) {
      // A tombstone has no breadcrumbs, but the signal handler's report of the same crash does.
      const twin = this.store.get<{ body: string }>(
        "SELECT body FROM reports WHERE session_id = ? AND issue_id = ? AND id != ? AND type = 'native_crash'",
        body.sessionId,
        id,
        body.id,
      );
      crumbs = twin ? (JSON.parse(twin.body) as Envelope).payload.breadcrumbs ?? [] : [];
    }
    const breakdown = (column: string) =>
      this.store.all<{ value: string; sessions: number }>(
        `SELECT ${column} AS value, COUNT(DISTINCT session_id) AS sessions FROM reports WHERE issue_id = ? GROUP BY ${column} ORDER BY sessions DESC LIMIT 8`,
        id,
      );
    return {
      ...issue,
      analysis: JSON.parse(sample.analysis),
      sample: { id: body.id, type: body.type, timestamp: body.timestamp, app: body.app, device: body.device, breadcrumbs: crumbs.map(normalizeCrumb), keys: body.keys ?? {} },
      byManufacturer: breakdown('manufacturer'),
      byOsVersion: breakdown('sdk_int'),
      byAppVersion: breakdown('app_version'),
      hotspots: this.hotspotsFor(id),
    };
  }

  private fleet(): { total: number; segments: SegmentStat[] } {
    const total = this.store.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions')!.n;
    const segments: SegmentStat[] = [];
    const add = (dimension: string, sql: string) =>
      this.store.all<{ value: string; n: number }>(sql).forEach((row) => segments.push({ dimension, value: String(row.value), sessions: row.n }));
    add('manufacturer', 'SELECT manufacturer AS value, COUNT(*) AS n FROM sessions GROUP BY manufacturer');
    add('android', 'SELECT sdk_int AS value, COUNT(*) AS n FROM sessions GROUP BY sdk_int');
    add('model', 'SELECT model AS value, COUNT(*) AS n FROM sessions GROUP BY model');
    add('manufacturer+android', "SELECT manufacturer || ' / API ' || sdk_int AS value, COUNT(*) AS n FROM sessions GROUP BY manufacturer, sdk_int");
    return { total, segments };
  }

  private hotspotsFor(issueId: string, fleet = this.fleet()) {
    const issueTotal = this.store.get<{ n: number }>('SELECT COUNT(DISTINCT session_id) AS n FROM reports WHERE issue_id = ?', issueId)!.n;
    const segments: SegmentStat[] = [];
    const add = (dimension: string, expr: string) =>
      this.store
        .all<{ value: string; n: number }>(
          `SELECT ${expr} AS value, COUNT(DISTINCT r.session_id) AS n FROM reports r JOIN sessions s ON s.id = r.session_id WHERE r.issue_id = ? GROUP BY value`,
          issueId,
        )
        .forEach((row) => segments.push({ dimension, value: String(row.value), sessions: row.n }));
    add('manufacturer', 's.manufacturer');
    add('android', 's.sdk_int');
    add('model', 's.model');
    add('manufacturer+android', "s.manufacturer || ' / API ' || s.sdk_int");
    return findConcentrations(fleet.total, fleet.segments, issueTotal, segments);
  }

  hotspots() {
    const fleet = this.fleet();
    const result = [];
    for (const issue of this.store.all<{ id: string; title: string; kind: string; category: string }>('SELECT id, title, kind, category FROM issues')) {
      const found = this.hotspotsFor(issue.id, fleet);
      if (found.length > 0) result.push({ issue, segments: found });
    }
    return { sessions: fleet.total, flagged: result };
  }

  jank() {
    return this.store.all(
      `SELECT screen, COUNT(*) AS visits, SUM(frames) AS frames, SUM(slow) AS slow, SUM(frozen) AS frozen, MAX(worst_ms) AS worstMs
       FROM jank GROUP BY screen ORDER BY CAST(SUM(slow) AS REAL) / SUM(frames) DESC`,
    );
  }

  report(id: string) {
    const row = this.store.get<{ body: string; analysis: string | null }>('SELECT body, analysis FROM reports WHERE id = ?', id);
    if (!row) throw new HttpError(404, 'not_found', 'Report not found');
    return { report: JSON.parse(row.body), analysis: row.analysis ? JSON.parse(row.analysis) : null };
  }

  reportsOfSession(sessionId: string) {
    return this.store.all<{ id: string; type: string; issue_id: string | null }>('SELECT id, type, issue_id FROM reports WHERE session_id = ? ORDER BY ts', sessionId);
  }

  close(): void {
    this.store.close();
    if (this.tempRoot) rmSync(this.tempRoot, { recursive: true, force: true });
  }
}
