export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { executeTool } from "@/lib/query/tools-registry";
import { db } from "@/lib/db";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ sessionId: string }> }
) {
  try {
    const { sessionId } = await context.params;

    const fileIdParam = req.nextUrl.searchParams.get("fileId");

    let fileId: number;

    if (fileIdParam) {
      fileId = parseInt(fileIdParam, 10);
    } else {
      const id = db.getFirstFileId(sessionId);
      if (id === null) {
        return NextResponse.json(
          { error: "No files found in this session" },
          { status: 404 }
        );
      }
      fileId = id;
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
    console.error("Timeline histogram query failed:", err);
    return NextResponse.json(
      { error: "Failed to fetch timeline histogram" },
      { status: 500 }
    );
  }
}
