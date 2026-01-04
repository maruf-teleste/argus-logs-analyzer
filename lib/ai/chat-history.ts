import { sql } from "@/lib/db/client";
import OpenAI from "openai";

export async function loadConversationHistory(
  sessionId: string
): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> {
  console.log("Loading history for session:", sessionId);
  try {
    const history = await sql`
      SELECT role, content
      FROM conversation_history
      WHERE session_id = ${sessionId}
      ORDER BY created_at ASC
      LIMIT 20
    `;

    return history.slice(-10).map((h: any) => ({
      role: h.role,
      content: h.content,
    }));
  } catch (err) {
    console.error("loadConversationHistory error:", err);
    return [];
  }
}

export async function saveConversationHistory(
  sessionId: string,
  role: "user" | "assistant",
  content: string
) {
  console.log("Saving to session:", sessionId);
  try {
    await sql`
      INSERT INTO conversation_history (session_id, role, content, created_at)
      VALUES (${sessionId}, ${role}, ${content}, NOW())
    `;
  } catch (err) {
    console.error("saveConversationHistory error:", err);
  }
}

export async function getSessionFile(sessionId: string) {
  const result = await sql`
    SELECT 
      file_id, filename, time_range_start, time_range_end, 
      error_count, warn_count, total_lines, upload_status
    FROM session_files 
    WHERE session_id = ${sessionId} AND upload_status = 'ready'
    ORDER BY file_id DESC
    LIMIT 1
  `;
  return result[0] || null;
}

export async function listSessionFiles(sessionId: string) {
  const result = await sql`
    SELECT file_id, filename, error_count, warn_count, total_lines, upload_status
    FROM session_files 
    WHERE session_id = ${sessionId} AND upload_status = 'ready'
    ORDER BY file_id DESC
  `;
  return Array.isArray(result) ? result : [];
}
