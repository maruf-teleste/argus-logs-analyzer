// app/api/sessions/route.ts
import { db } from "@/lib/db";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const sessions = db.listSessions();
    const files = db.listSessionFiles();

    const sessionsWithFiles = sessions.map((s) => ({
      id: s.session_id,
      name: s.name,
      createdAt: s.created_at,
      createdBy: "User",
      expiresAt: s.expires_at,
      status: s.status,
      totalLines: Number(s.total_lines),
      totalErrors: Number(s.total_errors),
      totalWarnings: Number(s.total_warnings),
      timeRange: {
        start: s.earliest_log,
        end: s.latest_log,
      },
      files: files
        .filter((f) => f.session_id === s.session_id)
        .map((f) => ({
          id: f.file_id.toString(),
          name: f.filename,
          sizeMb: Number(f.size_mb),
          totalLines: Number(f.total_lines),
          parsedLines: Number(f.parsed_lines),
          errorCount: Number(f.error_count),
          warnCount: Number(f.warn_count),
          status:
            f.upload_status === "ready"
              ? "ready"
              : f.upload_status === "error"
              ? "error"
              : "processing",
          progress:
            f.upload_status === "ready"
              ? 100
              : f.upload_status === "error"
              ? 0
              : 50,
          uploadedAt: f.uploaded_at,
        })),
    }));

    return NextResponse.json({ sessions: sessionsWithFiles }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("Error fetching sessions:", error);
    return NextResponse.json(
      { error: "Failed to fetch sessions" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { name } = body;

    if (!name || typeof name !== "string") {
      return NextResponse.json(
        { error: "Session name is required" },
        { status: 400 }
      );
    }

    const session = db.createSession(name);

    return NextResponse.json({
      success: true,
      sessionId: session.session_id,
      name: session.name,
      createdAt: session.created_at,
      expiresAt: session.expires_at,
      status: session.status,
    });
  } catch (error) {
    console.error("Error creating session:", error);
    return NextResponse.json(
      { error: "Failed to create session" },
      { status: 500 }
    );
  }
}
