import { sql } from "@/lib/db/client";
import { NextRequest, NextResponse } from "next/server";

export async function GET(
  req: Request,
  { params }: { params: { sessionId: string } }
) {
  const { sessionId } = params;

  const session = await sql`
    SELECT 
      s.*,
      COUNT(DISTINCT sf.file_id) as file_count,
      COUNT(e.id) as event_count
    FROM sessions s
    LEFT JOIN session_files sf ON s.session_id = sf.session_id
    LEFT JOIN events e ON s.session_id = e.session_id
    WHERE s.session_id = ${sessionId}
    GROUP BY s.session_id
  `;

  if (session.length === 0) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  return NextResponse.json(session[0]);
}
