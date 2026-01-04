export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { analyzeLogsWithAI } from "@/lib/ai/loganalyzer";
import { sql } from "@/lib/db/client";

export async function POST(
  req: Request,
  context: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await context.params;
  const { question } = await req.json();

  try {
    const startTime = Date.now();

    const answer = await analyzeLogsWithAI(sessionId, question);

    const processingTime = Date.now() - startTime;

    // Save to conversation history
    await sql`
      INSERT INTO conversation_history (session_id, role, content, metadata)
      VALUES
        (${sessionId}, 'user', ${question}, ${{}}),
        (${sessionId}, 'assistant', ${answer}, ${JSON.stringify({
      processingTime,
    })})
    `;

    return Response.json({
      answer,
      metadata: { processingTime },
    });
  } catch (error) {
    console.error("❌ Query error:", error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
