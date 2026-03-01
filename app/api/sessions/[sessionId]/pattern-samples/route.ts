import { NextRequest, NextResponse } from "next/server";
import { executeTool } from "@/lib/query/tools-registry";
import { db } from "@/lib/db";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  try {
    const { sessionId } = await params;
    const patternSignature = req.nextUrl.searchParams.get("patternSignature");
    const startTime = req.nextUrl.searchParams.get("startTime");
    const endTime = req.nextUrl.searchParams.get("endTime");
    const fileIdParam = req.nextUrl.searchParams.get("fileId");
    const limitParam = req.nextUrl.searchParams.get("limit");

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
      const id = db.getFirstFileId(sessionId);
      if (id === null) {
        return NextResponse.json(
          { error: "No files found in this session" },
          { status: 404 }
        );
      }
      fileId = id;
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
    console.error("Pattern samples query failed:", err);
    return NextResponse.json(
      { error: "Failed to fetch pattern samples" },
      { status: 500 }
    );
  }
}
