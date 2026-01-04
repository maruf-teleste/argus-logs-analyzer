import { NextRequest, NextResponse } from "next/server";
import { executeTool } from "@/lib/query/tools-registry";
import { pool } from "@/lib/db/batch-client";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ sessionId: string }> }
) {
  try {
    const { sessionId } = await context.params;
    const lineNumber = req.nextUrl.searchParams.get("lineNumber");
    const contextLines = req.nextUrl.searchParams.get("contextLines") || "20";
    const thread = req.nextUrl.searchParams.get("thread");
    const fileIdParam = req.nextUrl.searchParams.get("fileId");

    // Validate required parameters
    if (!lineNumber) {
      return NextResponse.json(
        { error: "lineNumber query param is required" },
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

    // Step 1: Get the anchor log to extract its timestamp
    const anchorLog = await executeTool("get_log_by_line_number", {
      file_id: fileId,
      line_number: parseInt(lineNumber, 10),
      context_lines: 0, // Only fetch the anchor log itself
    });

    if (!anchorLog || anchorLog.length === 0 || !anchorLog[0]?.timestamp) {
      return NextResponse.json(
        { error: "Anchor log not found or missing timestamp" },
        { status: 404 }
      );
    }

    const anchorTimestamp = anchorLog[0].timestamp;
    const anchorLineNumber = parseInt(lineNumber, 10);

    // Step 2: Fetch balanced context (N logs before + anchor + N logs after)
    // contextLines is now the COUNT of logs before/after (default 10 = 10 before + 10 after)
    const rawLogs = await executeTool("get_time_based_context", {
      file_id: fileId,
      anchor_timestamp: anchorTimestamp,
      time_window_seconds: parseInt(contextLines, 10), // Actually used as count limit
      thread: thread && thread !== "null" && thread !== "undefined" ? thread : undefined,
      anchor_line_number: anchorLineNumber,
    });

    // Step 3: Add the 'is_anchor' flag to the original log line
    const logs = (rawLogs || []).map((log: any) => {
        if (log.line_number === anchorLineNumber) {
            return { ...log, is_anchor: true };
        }
        return log;
    });

    return NextResponse.json({
      sessionId,
      fileId,
      lineNumber: parseInt(lineNumber, 10),
      anchorTimestamp,
      timeWindowSeconds: parseInt(contextLines, 10),
      thread: thread || null,
      logs: logs,
      note: `Showing ${contextLines} logs before and ${contextLines} logs after the anchor (balanced view)`,
    });
  } catch (err) {
    console.error("❌ Log context query failed:", err);
    return NextResponse.json(
      { error: "Failed to fetch log context" },
      { status: 500 }
    );
  }
}
