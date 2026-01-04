export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { executeTool } from "@/lib/query/tools-registry";
import { pool } from "@/lib/db/batch-client";

export async function GET(
  req: NextRequest,
  { params }: { params: { sessionId: string } }
) {
  try {
    const sessionId = params.sessionId;

    // Get the file ID from query params or from the session's first file
    const fileIdParam = req.nextUrl.searchParams.get("fileId");

    let fileId: number;

    if (fileIdParam) {
      fileId = parseInt(fileIdParam, 10);
    } else {
      // Get first file from session
      const result = await pool.query(
        `SELECT file_id FROM session_files WHERE session_id = $1 LIMIT 1`,
        [sessionId]
      );

      if (result.rows.length === 0) {
        return NextResponse.json(
          { error: "No files found in this session" },
          { status: 404 }
        );
      }

      fileId = result.rows[0].file_id;
    }

    const histogram = await executeTool("get_timeline_histogram", {
      file_id: fileId,
    });

    return NextResponse.json({
      sessionId,
      fileId,
      histogram,
    });
  } catch (err) {
    console.error("❌ Timeline histogram query failed:", err);
    return NextResponse.json(
      { error: "Failed to fetch timeline histogram" },
      { status: 500 }
    );
  }
}
