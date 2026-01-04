import { NextResponse } from "next/server";
import { sql } from "@/lib/db/client";

export async function GET(
  _req: Request,
  context: { params: { sessionId: string } }
) {
  try {
    const { sessionId } = await context.params;

    const rows = await sql`
      SELECT id, role, content, metadata, created_at
      FROM conversation_history
      WHERE session_id = ${sessionId}
      ORDER BY created_at ASC
      LIMIT 50
    `;

    const messages = rows.map((row: any) => ({
      id: row.id?.toString() ?? crypto.randomUUID(),
      role: row.role,
      content: row.content,
      timestamp: new Date(row.created_at).toISOString(),
      metadata: row.metadata ?? undefined,
    }));

    return NextResponse.json({ messages });
  } catch (error) {
    console.error("Failed to load conversation history:", error);
    return NextResponse.json(
      { error: "Failed to load conversation history" },
      { status: 500 }
    );
  }
}
