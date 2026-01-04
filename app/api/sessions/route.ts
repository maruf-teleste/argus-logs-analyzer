// app/api/sessions/route.ts
import { sql } from "@/lib/db/client";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    // Get all sessions with aggregated stats
    const sessions = await sql`
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
          WHEN COUNT(sf.file_id) FILTER (WHERE sf.upload_status = 'processing') > 0 THEN 'processing'
          WHEN COUNT(sf.file_id) FILTER (WHERE sf.upload_status = 'ready') > 0 THEN 'ready'
          WHEN s.expires_at < NOW() THEN 'expired'
          ELSE 'active'
        END as status
      FROM sessions s
      LEFT JOIN session_files sf ON s.session_id = sf.session_id
      GROUP BY s.session_id, s.name, s.created_at, s.expires_at
      ORDER BY s.created_at DESC
    `;

    // Get files for each session
    const files = await sql`
      SELECT 
        file_id,
        session_id,
        filename,
        size_mb,
        total_lines,
        parsed_lines,
        error_count,
        warn_count,
        upload_status,
        uploaded_at
      FROM session_files
      WHERE upload_status IN ('ready', 'processing', 'error')
      ORDER BY uploaded_at DESC
    `;

    // Map files to sessions
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
          status: f.upload_status === "ready" ? "ready" : "processing",
          progress: f.upload_status === "ready" ? 100 : 50,
          uploadedAt: f.uploaded_at,
        })),
    }));

    return NextResponse.json({ sessions: sessionsWithFiles });
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

    const result = await sql`
      INSERT INTO sessions (name, expires_at, status)
      VALUES (
        ${name},
        NOW() + INTERVAL '48 hours',
        'active'
      )
      RETURNING session_id, name, created_at, expires_at, status
    `;

    const session = result[0];

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
