// lib/db/sqlite-repository.ts
import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";
import type {
  IRepository,
  SessionRow,
  SessionWithStats,
  FileRow,
  FileProcessingResult,
  StatsRow,
  MessageRow,
} from "./repository";

export class SQLiteRepository implements IRepository {
  private db: Database.Database;

  constructor(dbPath: string) {
    // Ensure directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  // --------------------------------------------------
  // Schema
  // --------------------------------------------------
  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6)))),
        name TEXT NOT NULL DEFAULT 'Untitled',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT,
        status TEXT NOT NULL DEFAULT 'active'
      );

      CREATE TABLE IF NOT EXISTS session_files (
        file_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        filename TEXT NOT NULL,
        original_filename TEXT,
        file_hash TEXT,
        size_mb REAL,
        parquet_key TEXT,
        s3_key TEXT,
        total_lines INTEGER,
        parsed_lines INTEGER,
        error_count INTEGER DEFAULT 0,
        warn_count INTEGER DEFAULT 0,
        info_count INTEGER DEFAULT 0,
        time_range_start TEXT,
        time_range_end TEXT,
        devices TEXT,
        threads TEXT,
        components TEXT,
        exception_types TEXT,
        upload_status TEXT NOT NULL DEFAULT 'uploading',
        processed_at TEXT,
        uploaded_at TEXT DEFAULT (datetime('now')),
        stats TEXT,
        findings TEXT
      );

      CREATE TABLE IF NOT EXISTS conversation_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        role TEXT NOT NULL CHECK(role IN ('user','assistant')),
        content TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Additive migrations for columns added after initial schema
    this.addColumnIfMissing("session_files", "findings", "TEXT");
  }

  private addColumnIfMissing(table: string, column: string, type: string) {
    const cols = this.db.pragma(`table_info(${table})`) as { name: string }[];
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  // --------------------------------------------------
  // Sessions
  // --------------------------------------------------
  createSession(name: string) {
    const sessionId = crypto.randomUUID();
    const stmt = this.db.prepare(`
      INSERT INTO sessions (session_id, name, expires_at, status)
      VALUES (?, ?, datetime('now', '+48 hours'), 'active')
    `);
    stmt.run(sessionId, name || "Untitled");

    const row = this.db.prepare(`SELECT * FROM sessions WHERE session_id = ?`).get(sessionId) as any;
    return {
      session_id: row.session_id,
      name: row.name,
      created_at: row.created_at,
      expires_at: row.expires_at,
      status: row.status,
    };
  }

  getSession(sessionId: string): SessionRow | null {
    return (this.db.prepare(`SELECT * FROM sessions WHERE session_id = ?`).get(sessionId) as SessionRow) ?? null;
  }

  listSessions(): SessionWithStats[] {
    return this.db.prepare(`
      SELECT
        s.session_id,
        s.name,
        s.created_at,
        s.expires_at,
        COUNT(sf.file_id) as file_count,
        COALESCE(SUM(sf.total_lines), 0) as total_lines,
        COALESCE(SUM(sf.error_count), 0) as total_errors,
        COALESCE(SUM(sf.warn_count), 0) as total_warnings,
        MIN(sf.time_range_start) as earliest_log,
        MAX(sf.time_range_end) as latest_log,
        CASE
          WHEN COUNT(CASE WHEN sf.upload_status = 'processing' THEN 1 END) > 0 THEN 'processing'
          WHEN COUNT(CASE WHEN sf.upload_status = 'ready' THEN 1 END) > 0 THEN 'ready'
          WHEN s.expires_at < datetime('now') THEN 'expired'
          ELSE 'active'
        END as status
      FROM sessions s
      LEFT JOIN session_files sf ON s.session_id = sf.session_id
      GROUP BY s.session_id, s.name, s.created_at, s.expires_at
      ORDER BY s.created_at DESC
    `).all() as SessionWithStats[];
  }

  listSessionFiles(): FileRow[] {
    return this.db.prepare(`
      SELECT *
      FROM session_files
      WHERE upload_status IN ('ready', 'processing', 'error')
      ORDER BY uploaded_at DESC
    `).all() as FileRow[];
  }

  deleteSession(sessionId: string): { session_id: string; name: string } | null {
    const session = this.db.prepare(`SELECT session_id, name FROM sessions WHERE session_id = ?`).get(sessionId) as { session_id: string; name: string } | undefined;
    if (!session) return null;

    const deleteAll = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM session_files WHERE session_id = ?`).run(sessionId);
      this.db.prepare(`DELETE FROM conversation_history WHERE session_id = ?`).run(sessionId);
      this.db.prepare(`DELETE FROM sessions WHERE session_id = ?`).run(sessionId);
    });
    deleteAll();
    return session;
  }

  // --------------------------------------------------
  // Files
  // --------------------------------------------------
  createFile(sessionId: string, filename: string, fileHash: string, sizeMb: number): number {
    const result = this.db.prepare(`
      INSERT INTO session_files (session_id, filename, file_hash, size_mb, upload_status)
      VALUES (?, ?, ?, ?, 'processing')
    `).run(sessionId, filename, fileHash, sizeMb);
    return Number(result.lastInsertRowid);
  }

  getFile(fileId: number): FileRow | null {
    return (this.db.prepare(`SELECT * FROM session_files WHERE file_id = ?`).get(fileId) as FileRow) ?? null;
  }

  getSessionFiles(sessionId: string): FileRow[] {
    return this.db.prepare(`
      SELECT * FROM session_files
      WHERE session_id = ? AND upload_status = 'ready'
      ORDER BY file_id DESC
    `).all(sessionId) as FileRow[];
  }

  getFirstFileId(sessionId: string): number | null {
    const row = this.db.prepare(`
      SELECT file_id FROM session_files WHERE session_id = ? LIMIT 1
    `).get(sessionId) as { file_id: number } | undefined;
    return row?.file_id ?? null;
  }

  getFileByHash(fileHash: string, sessionId?: string): { file_id: number; session_id: string; name: string | null } | null {
    // Only check within the same session — different sessions can have the same file
    if (sessionId) {
      const row = this.db.prepare(`
        SELECT sf.file_id, sf.session_id, s.name
        FROM session_files sf
        LEFT JOIN sessions s ON sf.session_id = s.session_id
        WHERE sf.file_hash = ? AND sf.session_id = ?
      `).get(fileHash, sessionId) as { file_id: number; session_id: string; name: string | null } | undefined;
      return row ?? null;
    }
    const row = this.db.prepare(`
      SELECT sf.file_id, sf.session_id, s.name
      FROM session_files sf
      LEFT JOIN sessions s ON sf.session_id = s.session_id
      WHERE sf.file_hash = ?
    `).get(fileHash) as { file_id: number; session_id: string; name: string | null } | undefined;
    return row ?? null;
  }

  getParquetKey(fileId: number): string | null {
    const row = this.db.prepare(`SELECT parquet_key FROM session_files WHERE file_id = ?`).get(fileId) as { parquet_key: string | null } | undefined;
    return row?.parquet_key ?? null;
  }

  getParquetKeys(sessionId: string): string[] {
    const rows = this.db.prepare(`
      SELECT parquet_key FROM session_files
      WHERE session_id = ? AND parquet_key IS NOT NULL
    `).all(sessionId) as { parquet_key: string }[];
    return rows.map((r) => r.parquet_key);
  }

  updateFileAfterProcessing(fileId: number, data: FileProcessingResult): void {
    this.db.prepare(`
      UPDATE session_files SET
        parquet_key = ?,
        total_lines = ?,
        parsed_lines = ?,
        error_count = ?,
        warn_count = ?,
        info_count = ?,
        time_range_start = ?,
        time_range_end = ?,
        devices = ?,
        threads = ?,
        components = ?,
        exception_types = ?,
        findings = ?,
        upload_status = 'ready',
        processed_at = datetime('now')
      WHERE file_id = ?
    `).run(
      data.parquetKey,
      data.totalLines,
      data.parsedLines,
      data.errorCount,
      data.warnCount,
      data.infoCount,
      data.timeRangeStart?.toISOString() ?? null,
      data.timeRangeEnd?.toISOString() ?? null,
      JSON.stringify(data.devices),
      JSON.stringify(data.threads),
      JSON.stringify(data.components),
      JSON.stringify(data.exceptionTypes),
      data.findings ?? null,
      fileId,
    );
  }

  updateFileStatus(fileId: number, status: string): void {
    this.db.prepare(`UPDATE session_files SET upload_status = ? WHERE file_id = ?`).run(status, fileId);
  }

  deleteFilesByHash(fileHash: string): void {
    this.db.prepare(`DELETE FROM session_files WHERE file_hash = ?`).run(fileHash);
  }

  getSessionStats(sessionId: string, fileId?: number): StatsRow | null {
    if (fileId) {
      const row = this.db.prepare(`
        SELECT
          total_lines as total_logs,
          error_count,
          warn_count,
          0 as unique_patterns,
          time_range_start as start_time,
          time_range_end as end_time
        FROM session_files
        WHERE session_id = ? AND file_id = ? AND upload_status = 'ready'
      `).get(sessionId, fileId) as StatsRow | undefined;
      return row ?? null;
    }

    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(total_lines), 0) as total_logs,
        COALESCE(SUM(error_count), 0) as error_count,
        COALESCE(SUM(warn_count), 0) as warn_count,
        0 as unique_patterns,
        MIN(time_range_start) as start_time,
        MAX(time_range_end) as end_time
      FROM session_files
      WHERE session_id = ? AND upload_status = 'ready'
    `).get(sessionId) as StatsRow | undefined;
    return row ?? null;
  }

  getUploadStatus(sessionId: string): FileRow | null {
    const row = this.db.prepare(`
      SELECT *
      FROM session_files
      WHERE session_id = ?
      ORDER BY file_id DESC
      LIMIT 1
    `).get(sessionId) as FileRow | undefined;
    return row ?? null;
  }

  // --------------------------------------------------
  // Conversations
  // --------------------------------------------------
  saveMessage(sessionId: string, role: string, content: string, metadata?: string): void {
    this.db.prepare(`
      INSERT INTO conversation_history (session_id, role, content, metadata, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(sessionId, role, content, metadata ?? null);
  }

  saveTwoMessages(
    sessionId: string,
    role1: string, content1: string, metadata1: string | null,
    role2: string, content2: string, metadata2: string | null,
  ): void {
    const insert = this.db.prepare(`
      INSERT INTO conversation_history (session_id, role, content, metadata, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `);
    const tx = this.db.transaction(() => {
      insert.run(sessionId, role1, content1, metadata1);
      insert.run(sessionId, role2, content2, metadata2);
    });
    tx();
  }

  getConversation(sessionId: string, limit: number = 50): MessageRow[] {
    return this.db.prepare(`
      SELECT id, session_id, role, content, metadata, created_at
      FROM conversation_history
      WHERE session_id = ?
      ORDER BY created_at ASC
      LIMIT ?
    `).all(sessionId, limit) as MessageRow[];
  }

  getConversationHistory(sessionId: string, limit: number = 10): { role: string; content: string }[] {
    const rows = this.db.prepare(`
      SELECT role, content
      FROM conversation_history
      WHERE session_id = ?
      ORDER BY created_at ASC
      LIMIT 20
    `).all(sessionId) as { role: string; content: string }[];
    return rows.slice(-limit);
  }

  deleteConversation(sessionId: string): void {
    this.db.prepare(`DELETE FROM conversation_history WHERE session_id = ?`).run(sessionId);
  }

  // --------------------------------------------------
  // Health
  // --------------------------------------------------
  healthCheck(): { ok: boolean; latencyMs: number } {
    const start = Date.now();
    try {
      this.db.prepare(`SELECT 1`).get();
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }
}
