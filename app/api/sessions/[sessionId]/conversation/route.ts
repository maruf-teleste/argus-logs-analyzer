import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  context: { params: Promise<{ sessionId: string }> }
) {
  try {
    const { sessionId } = await context.params;

    const rows = db.getConversation(sessionId, 50);

    const messages = rows.map((row) => ({
      id: row.id?.toString() ?? crypto.randomUUID(),
      role: row.role,
      content: row.content,
      timestamp: new Date(row.created_at).toISOString(),
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
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
