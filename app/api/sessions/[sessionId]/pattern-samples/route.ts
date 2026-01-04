import { NextRequest, NextResponse } from "next/server";
import { executeTool } from "@/lib/query/tools-registry";
import { pool } from "@/lib/db/batch-client";

export async function GET(
  req: NextRequest,
  { params }: { params: { sessionId: string } }
) {
  try {
    const sessionId = params.sessionId;
    const patternSignature = req.nextUrl.searchParams.get("patternSignature");
    const startTime = req.nextUrl.searchParams.get("startTime");
    const endTime = req.nextUrl.searchParams.get("endTime");
    const fileIdParam = req.nextUrl.searchParams.get("fileId");
    const limitParam = req.nextUrl.searchParams.get("limit");

    // Validate required parameters
    if (!patternSignature || !startTime || !endTime) {
      return NextResponse.json(
        {
          error:
            "patternSignature, startTime, and endTime query params are required",
        },
        { status: 400 }
      );
    }

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

    const limit = limitParam ? parseInt(limitParam, 10) : 50;

    const samples = await executeTool("get_pattern_samples", {
      file_id: fileId,
      pattern_signature: patternSignature,
      start_time: startTime,
      end_time: endTime,
      limit: limit,
    });

    return NextResponse.json({
      sessionId,
      fileId,
      patternSignature,
      startTime,
      endTime,
      samples,
    });
  } catch (err) {
    console.error("❌ Pattern samples query failed:", err);
    return NextResponse.json(
      { error: "Failed to fetch pattern samples" },
      { status: 500 }
    );
  }
}
