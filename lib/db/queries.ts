import { sql } from "./client";
import type { Session } from "@/types/session";

export async function createSession(name?: string): Promise<string> {
  const sessionId = crypto.randomUUID();
  await sql`
    INSERT INTO sessions (session_id, name, expires_at)
    VALUES (${sessionId}, ${name || "Untitled"}, NOW() + INTERVAL '7 days')
  `;
  return sessionId;
}

export async function addFileToSession(
  sessionId: string,
  filename: string,
  fileHash: string
): Promise<number> {
  const result = await sql`
    INSERT INTO session_files (session_id, filename, file_hash)
    VALUES (${sessionId}, ${filename}, ${fileHash})
    RETURNING file_id
  `;
  return result[0].file_id;
}

export async function getSession(
  sessionId: string
): Promise<Session | undefined> {
  const result = await sql`
    SELECT s.*,
      COUNT(DISTINCT sf.file_id) as file_count,
      COUNT(e.id) as event_count
    FROM sessions s
    LEFT JOIN session_files sf ON s.session_id = sf.session_id
    LEFT JOIN events e ON s.session_id = e.session_id
    WHERE s.session_id = ${sessionId}
    GROUP BY s.session_id
  `;
  return result[0];
}

export async function getSessionStats(
  sessionId: string,
  fileId?: number
): Promise<{
  total_logs: number;
  error_count: number;
  warn_count: number;
  unique_patterns: number;
  start_time: Date | null;
  end_time: Date | null;
} | null> {
  try {
    // If fileId is provided, get stats for that specific file
    // Otherwise, aggregate stats across all files in the session
    if (fileId) {
      const result = await sql`
        SELECT
          total_lines as total_logs,
          error_count,
          warn_count,
          0 as unique_patterns,
          time_range_start as start_time,
          time_range_end as end_time
        FROM session_files
        WHERE session_id = ${sessionId}
          AND file_id = ${fileId}
          AND upload_status = 'ready'
      `;
      return result[0] || null;
    } else {
      // Aggregate across all files in session
      const result = await sql`
        SELECT
          COALESCE(SUM(total_lines), 0) as total_logs,
          COALESCE(SUM(error_count), 0) as error_count,
          COALESCE(SUM(warn_count), 0) as warn_count,
          0 as unique_patterns,
          MIN(time_range_start) as start_time,
          MAX(time_range_end) as end_time
        FROM session_files
        WHERE session_id = ${sessionId}
          AND upload_status = 'ready'
      `;
      return result[0] || null;
    }
  } catch (error) {
    console.error("[DB] Error getting session stats:", error);
    return null;
  }
}
