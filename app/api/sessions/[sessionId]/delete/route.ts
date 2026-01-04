// app/api/sessions/[sessionId]/delete/route.ts
import { sql } from "@/lib/db/client";
import { NextRequest, NextResponse } from "next/server";
import { deleteMultipleFromS3 } from "@/lib/storage/s3";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  try {
    const { sessionId } = await params;
    console.log("🗑️ Deleting session:", sessionId);

    // 1️ Get all parquet keys for this session
    const files = await sql<{ parquet_key: string | null }[]>`
      SELECT parquet_key
      FROM session_files
      WHERE session_id = ${sessionId}
        AND parquet_key IS NOT NULL
    `;

    // 2️ Delete all Parquet files from S3
    const keysToDelete = files
      .map((f) => f.parquet_key)
      .filter((key): key is string => key !== null);

    if (keysToDelete.length > 0) {
      try {
        await deleteMultipleFromS3(keysToDelete);
        console.log(`Deleted ${keysToDelete.length} files from S3`);
      } catch (err) {
        console.warn("ailed to delete some S3 files:", err);
        // Continue with DB deletion even if S3 fails
      }
    }

    // 3 Delete DB rows
    await sql`DELETE FROM session_files WHERE session_id = ${sessionId}`;
    await sql`DELETE FROM conversation_history WHERE session_id = ${sessionId}`;

    const result = await sql`
      DELETE FROM sessions
      WHERE session_id = ${sessionId}
      RETURNING session_id, name
    `;

    if (result.length === 0) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    console.log(`Session "${result[0].name}" deleted successfully`);

    return NextResponse.json({
      success: true,
      message: `Session "${result[0].name}" deleted successfully`,
      sessionId: result[0].session_id,
    });
  } catch (error) {
    console.error("Delete session error:", error);
    return NextResponse.json(
      { error: "Failed to delete session" },
      { status: 500 }
    );
  }
}
