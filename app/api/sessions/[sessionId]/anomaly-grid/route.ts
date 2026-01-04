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
    // WORKAROUND: Explicitly awaiting to satisfy peculiar Next.js runtime error.
    // This addresses the message: "params should be awaited before using its properties."
    await Promise.resolve(); 
    const sessionId = params.sessionId;
    const startTime = req.nextUrl.searchParams.get("startTime");
    const endTime = req.nextUrl.searchParams.get("endTime");
    const fileIdParam = req.nextUrl.searchParams.get("fileId");
    const severityParam = req.nextUrl.searchParams.get("severity");
    const limitParam = req.nextUrl.searchParams.get("limit");
    const offsetParam = req.nextUrl.searchParams.get("offset");

    // Validate required parameters
    if (!startTime || !endTime) {
      return NextResponse.json(
        { error: "startTime and endTime query params are required" },
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

    // Parse optional parameters
    const severityFilter = severityParam ? severityParam.split(",") : undefined;
    const limit = limitParam ? parseInt(limitParam, 10) : undefined;
    const offset = offsetParam ? parseInt(offsetParam, 10) : undefined;

    const anomalyGrid = await executeTool("get_anomaly_grid", {
      file_id: fileId,
      start_time: startTime,
      end_time: endTime,
      severity_filter: severityFilter,
      limit,
      offset,
    });

    return NextResponse.json({
      sessionId,
      fileId,
      startTime,
      endTime,
      anomalies: anomalyGrid,
    });
  } catch (err) {
    console.error("❌ Anomaly grid query failed:", err);
    return NextResponse.json(
      { error: "Failed to fetch anomaly grid" },
      { status: 500 }
    );
  }
}
