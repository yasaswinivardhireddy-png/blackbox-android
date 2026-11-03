import { DatabaseSync, type StatementSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  app_version TEXT NOT NULL,
  app_build INTEGER NOT NULL,
  manufacturer TEXT NOT NULL,
  model TEXT NOT NULL,
  sdk_int INTEGER NOT NULL,
  issue_id TEXT,
  body TEXT NOT NULL,
  analysis TEXT
);
CREATE INDEX IF NOT EXISTS reports_by_issue ON reports (issue_id, ts);
CREATE INDEX IF NOT EXISTS reports_by_session ON reports (session_id);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  app_version TEXT NOT NULL,
  manufacturer TEXT NOT NULL,
  model TEXT NOT NULL,
  sdk_int INTEGER NOT NULL,
  crashed INTEGER NOT NULL DEFAULT 0,
  anr INTEGER NOT NULL DEFAULT 0,
  hang INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  location TEXT NOT NULL,
  category TEXT NOT NULL,
  explanation TEXT NOT NULL,
  confidence TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  sample_report_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jank (
  report_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  screen TEXT NOT NULL,
  frames INTEGER NOT NULL,
  slow INTEGER NOT NULL,
  frozen INTEGER NOT NULL,
  worst_ms REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS startups (
  report_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  start_type TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  sdk_init_us INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS symbols (build_id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, uploaded_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS mappings (
  app_version TEXT NOT NULL,
  app_build INTEGER NOT NULL,
  path TEXT NOT NULL,
  classes INTEGER NOT NULL,
  uploaded_at INTEGER NOT NULL,
  PRIMARY KEY (app_version, app_build)
);
`;

type Param = string | number | bigint | null;

export class Store {
  readonly db: DatabaseSync;
  private cache = new Map<string, StatementSync>();

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) this.cache.set(sql, (s = this.db.prepare(sql)));
    return s;
  }

  run(sql: string, ...params: Param[]): number {
    return Number(this.stmt(sql).run(...params).changes);
  }

  get<T>(sql: string, ...params: Param[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: Param[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Runs fn inside the current transaction; on error only fn's changes are undone. */
  savepoint<T>(fn: () => T): T {
    this.db.exec('SAVEPOINT item');
    try {
      const result = fn();
      this.db.exec('RELEASE item');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK TO item; RELEASE item');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
