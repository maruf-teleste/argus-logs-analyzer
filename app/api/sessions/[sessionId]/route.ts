import { db } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET(
  _req: Request,
  context: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await context.params;

  const session = db.getSession(sessionId);

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  return NextResponse.json(session);
}
