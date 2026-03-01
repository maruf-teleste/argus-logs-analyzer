// app/api/sessions/[sessionId]/upload/route.ts

import { db } from "@/lib/db";
import { calculateHashFromFile } from "@/lib/utils/file-hash";
import { processLogFileToParquet } from "@/lib/parser/parquet-processor";
import os from "os";
import path from "path";
import { mkdir, unlink } from "fs/promises";
import { createWriteStream } from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

export const runtime = "nodejs";
export const maxDuration = 300; // 5 minutes for large file uploads

// Suppress ResponseAborted errors from client disconnects
if (typeof process !== 'undefined') {
  process.on('unhandledRejection', (reason: any) => {
    if (reason && reason.name === 'ResponseAborted') {
      return;
    }
    console.error('Unhandled rejection:', reason);
  });
}

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
      console.log("Client disconnected during upload, continuing in background");
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

  // Handle client abort
  req.signal.addEventListener("abort", () => {
    console.log("Client aborted request, continuing upload in background");
    markClosed();
  });

  (async () => {
    try {
      const { sessionId } = await context.params;

      send(0, "starting");

      const formData = await req.formData();
      const file = formData.get("file");

      if (!(file instanceof File)) {
        send(0, "error", "No file provided");
        return;
      }

      /* upload -> disk */
      send(5, "uploading");

      const safeFilename = path
        .basename(file.name)
        .replace(/[\\/\s]+/g, "_")
        .slice(0, 200);

      const tmpDir = path.join(os.tmpdir(), "argus-log-uploads");
      await mkdir(tmpDir, { recursive: true });

      tmpPath = path.join(tmpDir, `${sessionId}-${Date.now()}-${safeFilename}`);

      console.log(`[UPLOAD] Receiving file: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)}MB)`);
      const uploadStart = Date.now();
      let bytesReceived = 0;

      const fileStream = Readable.fromWeb(file.stream() as any);
      const writeStream = createWriteStream(tmpPath);

      fileStream.on('data', (chunk) => {
        bytesReceived += chunk.length;
        const percentReceived = ((bytesReceived / file.size) * 100).toFixed(1);
        if (bytesReceived % (100 * 1024 * 1024) < chunk.length) {
          console.log(`[UPLOAD] Received ${percentReceived}% (${(bytesReceived / 1024 / 1024).toFixed(1)}MB)`);
        }
      });

      await pipeline(fileStream, writeStream);

      const uploadDuration = ((Date.now() - uploadStart) / 1000).toFixed(2);
      console.log(`[UPLOAD] File received in ${uploadDuration}s`);

      send(40, "uploading");

      /* hashing */
      send(45, "hashing");
      const fileHash = await calculateHashFromFile(tmpPath);
      send(50, "hashing");

      /* duplicate check (per-session only — different sessions can upload same file) */
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

      /* parsing -> parquet -> s3 */
      console.log(`Starting parquet processing for ${file.name} (${(file.size / 1024 / 1024).toFixed(2)}MB)`);
      const result = await processLogFileToParquet(
        sessionId,
        tmpPath,
        file.name,
        fileHash,
        (percent, stage) => {
          const p = percent > 1 ? percent / 100 : percent;
          const overall = Math.min(95, 50 + Math.floor(p * 45));
          if (overall % 10 === 0 || stage === "complete") {
            console.log(`Upload progress: ${overall}% - ${stage}`);
          }
          send(overall, stage);
        }
      );
      console.log(`Parquet processing complete for ${file.name}`);

      send(100, "complete", {
        fileId: result.fileId,
        parquetKey: result.parquetKey,
        stats: result.stats,
      });
    } catch (err) {
      console.error("[UPLOAD] Error:", err);
      send(0, "error", err instanceof Error ? err.message : "Upload failed");
    } finally {
      if (tmpPath) await unlink(tmpPath).catch(() => {});
      try {
        close();
      } catch (err) {
        // Stream already closed by client disconnect, ignore
      }
    }
  })();

  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Keep-Alive": "timeout=600, max=100",
      "X-Accel-Buffering": "no",
    },
  });
}
