// app/api/sessions/[sessionId]/process/route.ts
// Process uploaded file from S3 -> Parquet -> Database

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { db } from "@/lib/db";
import { calculateHashFromFile } from "@/lib/utils/file-hash";
import { processLogFileToParquet } from "@/lib/parser/parquet-processor";
import os from "os";
import path from "path";
import { mkdir, unlink } from "fs/promises";
import { createWriteStream } from "fs";
import { createGunzip } from "zlib";
import { pipeline } from "stream/promises";
import { Readable } from "stream";

export const runtime = "nodejs";
export const maxDuration = 300; // 5 minutes for large file processing

const s3 = new S3Client({
  region: process.env.AWS_REGION || "eu-north-1",
});

const BUCKET = process.env.S3_BUCKET_NAME!;

/* ---------- SSE helper ---------- */
function createSSE() {
  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  let isClosed = false;

  function send(progress: number, stage: string, payload?: any) {
    if (isClosed) return;

    try {
      writer.write(
        encoder.encode(
          `data: ${JSON.stringify({ progress, stage, payload })}\n\n`
        )
      );
    } catch (err) {
      console.log("Client disconnected during processing, continuing in background");
      isClosed = true;
    }
  }

  return {
    stream,
    send,
    markClosed: () => {
      isClosed = true;
    },
    close: () => {
      if (!isClosed) {
        isClosed = true;
        try {
          writer.close();
        } catch (err) {
          // Already closed, ignore
        }
      }
    },
  };
}

/* ---------- route ---------- */
export async function POST(
  req: Request,
  context: { params: Promise<{ sessionId: string }> }
) {
  const { stream, send, close, markClosed } = createSSE();
  let tmpPath: string | null = null;

  req.signal.addEventListener("abort", () => {
    console.log("Client aborted request, continuing processing in background");
    markClosed();
  });

  // Send keepalive pings every 15s to prevent ALB idle timeout
  const keepaliveInterval = setInterval(() => {
    send(0, "keepalive", { ping: true });
  }, 15_000);

  (async () => {
    try {
      const { sessionId } = await context.params;

      const body = await req.json();
      console.log(`[PROCESS] Request body:`, body);

      const { s3Key, fileName, isGzipped } = body;

      if (!s3Key || !fileName) {
        throw new Error(`Missing required fields: s3Key=${s3Key}, fileName=${fileName}`);
      }

      // Verify session exists before processing (FK constraint guard)
      const session = db.getSession(sessionId);
      if (!session) {
        send(0, "error", "Session not found. It may have been deleted.");
        return;
      }

      send(0, "starting");

      /* Download from S3 -> disk */
      send(5, "downloading");
      console.log(`[PROCESS] Downloading from S3: ${s3Key}`);

      const tmpDir = path.join(os.tmpdir(), "argus-log-uploads");
      await mkdir(tmpDir, { recursive: true });

      tmpPath = path.join(tmpDir, `${sessionId}-${Date.now()}-${fileName}`);

      const command = new GetObjectCommand({
        Bucket: BUCKET,
        Key: s3Key,
      });

      const response = await s3.send(command);

      if (!response.Body) {
        throw new Error("No file body in S3 response");
      }

      const downloadStart = Date.now();

      try {
        if (isGzipped) {
          console.log(`[PROCESS] Decompressing gzipped file...`);
          await pipeline(
            response.Body as Readable,
            createGunzip(),
            createWriteStream(tmpPath)
          );
        } else {
          await pipeline(
            response.Body as Readable,
            createWriteStream(tmpPath)
          );
        }
        const downloadDuration = ((Date.now() - downloadStart) / 1000).toFixed(2);
        console.log(`[PROCESS] Downloaded${isGzipped ? ' + decompressed' : ''} from S3 in ${downloadDuration}s`);
      } catch (err) {
        console.error(`[PROCESS] Error downloading from S3:`, err);
        throw new Error(`Failed to download from S3: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }

      send(40, "downloading");

      /* Hashing */
      send(45, "hashing");
      const fileHash = await calculateHashFromFile(tmpPath);
      send(50, "hashing");

      /* Duplicate check (per-session only — different sessions can upload same file) */
      const existing = db.getFileByHash(fileHash, sessionId);

      if (existing) {
        if (!existing.session_id || !existing.name) {
          db.deleteFilesByHash(fileHash);
        } else {
          send(0, "error", {
            error: "File already uploaded",
            existingSessionId: existing.session_id,
            existingSessionName: existing.name,
          });
          return;
        }
      }

      /* Parsing -> Parquet -> S3 */
      console.log(`[PROCESS] Starting parquet processing for ${fileName}`);
      console.log(`[PROCESS] Temp file path: ${tmpPath}`);

      const fs = await import('fs');
      const stats = await fs.promises.stat(tmpPath);
      console.log(`[PROCESS] File size: ${stats.size} bytes`);

      const result = await processLogFileToParquet(
        sessionId,
        tmpPath,
        fileName,
        fileHash,
        (percent, stage) => {
          const p = percent > 1 ? percent / 100 : percent;
          const overall = Math.min(95, 50 + Math.floor(p * 45));
          if (overall % 10 === 0 || stage === "complete") {
            console.log(`[PROCESS] Progress: ${overall}% - ${stage}`);
          }
          send(overall, stage);
        }
      );
      console.log(`[PROCESS] Complete - fileId: ${result.fileId}`);

      send(100, "complete", {
        fileId: result.fileId,
        parquetKey: result.parquetKey,
        stats: result.stats,
      });
    } catch (err) {
      console.error("[PROCESS] Error caught:", err);
      console.error("[PROCESS] Error stack:", err instanceof Error ? err.stack : 'No stack trace');
      const errorMsg = err instanceof Error ? err.message : "Processing failed";
      console.error("[PROCESS] Error message:", errorMsg);
      send(0, "error", errorMsg);
    } finally {
      clearInterval(keepaliveInterval);
      if (tmpPath) await unlink(tmpPath).catch(() => {});
      try {
        close();
      } catch (err) {
        // Stream already closed, ignore
      }
    }
  })();

  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
