// app/api/sessions/[sessionId]/upload-status/route.ts
// Check if a file upload/processing completed after stream disconnect

import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  context: { params: Promise<{ sessionId: string }> }
) {
  try {
    const { sessionId } = await context.params;
    const { searchParams } = new URL(req.url);
    const s3Key = searchParams.get("s3Key");

    if (!s3Key) {
      return Response.json({ error: "Missing s3Key" }, { status: 400 });
    }

    const session = db.getSession(sessionId);
    if (!session) {
      return Response.json(
        { status: "error", error: "Session not found" },
        { status: 404 }
      );
    }

    const file = db.getUploadStatus(sessionId);

    if (!file) {
      return Response.json({ status: "processing" });
    }

    const noCacheHeaders = { "Cache-Control": "no-store" };

    if (file.upload_status === "ready") {
      return Response.json({
        status: "complete",
        fileId: file.file_id,
        fileName: file.filename,
        stats: {
          totalLines: file.total_lines,
          errorCount: file.error_count,
          warnCount: file.warn_count,
        },
      }, { headers: noCacheHeaders });
    }

    if (file.upload_status === "error") {
      return Response.json({ status: "error", error: "Processing failed" }, { headers: noCacheHeaders });
    }

    return Response.json({ status: "processing" }, { headers: noCacheHeaders });
  } catch (error) {
    console.error("Error checking upload status:", error);
    return Response.json(
      { error: "Failed to check status" },
      { status: 500 }
    );
  }
}
