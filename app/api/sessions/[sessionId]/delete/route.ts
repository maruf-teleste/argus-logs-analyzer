// app/api/sessions/[sessionId]/delete/route.ts
import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { deleteMultipleFromS3, listObjectKeys } from "@/lib/storage/s3";
import { PARQUET_DIR } from "@/lib/query/duckdb-client";
import { rmSync } from "fs";
import * as path from "path";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  try {
    const { sessionId } = await params;
    console.log("Deleting session:", sessionId);

    // 1. Get all parquet keys before deleting DB rows
    const parquetKeys = db.getParquetKeys(sessionId);

    // 2. Delete local parquet files
    const localDir = path.join(PARQUET_DIR, "logs", sessionId);
    try {
      rmSync(localDir, { recursive: true, force: true });
      console.log(`Deleted local parquet dir: ${localDir}`);
    } catch (err) {
      console.warn("Failed to delete local parquet dir:", err);
    }

    // 3. Delete DB rows first (fast, makes UI consistent immediately)
    const result = db.deleteSession(sessionId);

    if (!result) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    console.log(`Session "${result.name}" deleted from DB`);

    // 4. Fire-and-forget S3 cleanup — don't block the response.
    // DB rows are already gone so the UI stays consistent immediately.
    if (parquetKeys.length > 0) {
      (async () => {
        try {
          const rawLogKeys = await listObjectKeys(`raw-logs/${sessionId}/`);
          const keysToDelete = [...parquetKeys, ...rawLogKeys];
          if (keysToDelete.length > 0) {
            await deleteMultipleFromS3(keysToDelete);
            console.log(
              `Cleaned up ${keysToDelete.length} S3 files for session ${sessionId}`
            );
          }
        } catch (err) {
          console.warn("S3 cleanup failed (non-blocking):", err);
        }
      })();
    }

    return NextResponse.json({
      success: true,
      message: `Session "${result.name}" deleted successfully`,
      sessionId: result.session_id,
    });
  } catch (error) {
    console.error("Delete session error:", error);
    return NextResponse.json(
      { error: "Failed to delete session" },
      { status: 500 }
    );
  }
}
