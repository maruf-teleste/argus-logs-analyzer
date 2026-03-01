// lib/db/repository.ts
// Repository interface for database operations.
// Swap implementations (SQLite → Postgres) by changing the export in index.ts.

export interface SessionRow {
  session_id: string;
  name: string;
  created_at: string;
  expires_at: string | null;
  status: string;
}

export interface SessionWithStats extends SessionRow {
  file_count: number;
  total_lines: number;
  total_errors: number;
  total_warnings: number;
  earliest_log: string | null;
  latest_log: string | null;
}

export interface FileRow {
  file_id: number;
  session_id: string;
  filename: string;
  original_filename: string | null;
  file_hash: string | null;
  size_mb: number | null;
  parquet_key: string | null;
  s3_key: string | null;
  total_lines: number | null;
  parsed_lines: number | null;
  error_count: number;
  warn_count: number;
  info_count: number;
  time_range_start: string | null;
  time_range_end: string | null;
  devices: string | null;
  threads: string | null;
  components: string | null;
  exception_types: string | null;
  upload_status: string;
  processed_at: string | null;
  uploaded_at: string | null;
  stats: string | null;
  findings: string | null;
}

export interface FileProcessingResult {
  parquetKey: string;
  totalLines: number;
  parsedLines: number;
  errorCount: number;
  warnCount: number;
  infoCount: number;
  timeRangeStart: Date | null;
  timeRangeEnd: Date | null;
  devices: string[];
  threads: string[];
  components: string[];
  exceptionTypes: string[];
  findings?: string;  // JSON string of Finding[]
}

export interface StatsRow {
  total_logs: number;
  error_count: number;
  warn_count: number;
  unique_patterns: number;
  start_time: string | null;
  end_time: string | null;
}

export interface MessageRow {
  id: number;
  session_id: string;
  role: string;
  content: string;
  metadata: string | null;
  created_at: string;
}

export interface IRepository {
  // Sessions
  createSession(name: string): {
    session_id: string;
    name: string;
    created_at: string;
    expires_at: string;
    status: string;
  };
  getSession(sessionId: string): SessionRow | null;
  listSessions(): SessionWithStats[];
  listSessionFiles(): FileRow[];
  deleteSession(sessionId: string): { session_id: string; name: string } | null;

  // Files
  createFile(sessionId: string, filename: string, fileHash: string, sizeMb: number): number;
  getFile(fileId: number): FileRow | null;
  getSessionFiles(sessionId: string): FileRow[];
  getFirstFileId(sessionId: string): number | null;
  getFileByHash(fileHash: string, sessionId?: string): { file_id: number; session_id: string; name: string | null } | null;
  getParquetKey(fileId: number): string | null;
  getParquetKeys(sessionId: string): string[];
  updateFileAfterProcessing(fileId: number, data: FileProcessingResult): void;
  updateFileStatus(fileId: number, status: string): void;
  deleteFilesByHash(fileHash: string): void;
  getSessionStats(sessionId: string, fileId?: number): StatsRow | null;
  getUploadStatus(sessionId: string): FileRow | null;

  // Conversations
  saveMessage(sessionId: string, role: string, content: string, metadata?: string): void;
  saveTwoMessages(
    sessionId: string,
    role1: string, content1: string, metadata1: string | null,
    role2: string, content2: string, metadata2: string | null
  ): void;
  getConversation(sessionId: string, limit?: number): MessageRow[];
  getConversationHistory(sessionId: string, limit?: number): { role: string; content: string }[];
  deleteConversation(sessionId: string): void;

  // Health
  healthCheck(): { ok: boolean; latencyMs: number };
}
