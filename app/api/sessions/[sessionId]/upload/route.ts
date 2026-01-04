// app/api/sessions/[sessionId]/upload/route.ts

import { sql } from "@/lib/db/client";
import { calculateHashFromFile } from "@/lib/utils/file-hash";
import { processLogFileToParquet } from "@/lib/parser/parquet-processor";
import os from "os";
import path from "path";
import { mkdir, unlink } from "fs/promises";
import { createWriteStream } from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

export const runtime = "nodejs";

/* ---------- SSE helper ---------- */
function createSSE() {
  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  function send(progress: number, stage: string, payload?: any) {
    writer.write(
      encoder.encode(
        `data: ${JSON.stringify({ progress, stage, payload })}\n\n`
      )
    );
  }

  return { stream, send, close: () => writer.close() };
}

/* ---------- route ---------- */
export async function POST(
  req: Request,
  context: { params: Promise<{ sessionId: string }> }
) {
  const { stream, send, close } = createSSE();
  let tmpPath: string | null = null;

  (async () => {
    try {
      // ✅ FIX: unwrap params properly
      const { sessionId } = await context.params;

      send(0, "starting");

      const formData = await req.formData();
      const file = formData.get("file");

      if (!(file instanceof File)) {
        send(0, "error", "No file provided");
        return;
      }

      /* upload → disk */
      send(5, "uploading");

      const safeFilename = path
        .basename(file.name)
        .replace(/[\\/\s]+/g, "_")
        .slice(0, 200);

      const tmpDir = path.join(os.tmpdir(), "argus-log-uploads");
      await mkdir(tmpDir, { recursive: true });

      tmpPath = path.join(tmpDir, `${sessionId}-${Date.now()}-${safeFilename}`);

      await pipeline(
        Readable.fromWeb(file.stream() as any),
        createWriteStream(tmpPath)
      );

      send(40, "uploading");

      /* hashing */
      send(45, "hashing");
      const fileHash = await calculateHashFromFile(tmpPath);
      send(50, "hashing");

      /* duplicate check */
      const existing = await sql`
        SELECT sf.file_id, sf.session_id, s.name
        FROM session_files sf
        LEFT JOIN sessions s ON sf.session_id = s.session_id
        WHERE sf.file_hash = ${fileHash}
      `;

      if (existing.length > 0) {
        const e = existing[0];

        if (!e.session_id || !e.name) {
          await sql`DELETE FROM session_files WHERE file_hash = ${fileHash}`;
        } else {
          send(0, "error", {
            error: "File already uploaded",
            existingSessionId: e.session_id,
            existingSessionName: e.name,
          });
          return;
        }
      }

      /* parsing → parquet → s3 */
      const result = await processLogFileToParquet(
        sessionId,
        tmpPath,
        file.name,
        fileHash,
        (percent, stage) => {
          const p = percent > 1 ? percent / 100 : percent;
          const overall = Math.min(95, 50 + Math.floor(p * 45));
          send(overall, stage);
        }
      );

      send(100, "complete", {
        fileId: result.fileId,
        parquetKey: result.parquetKey,
        stats: result.stats,
      });
    } catch (err) {
      send(0, "error", err instanceof Error ? err.message : "Upload failed");
    } finally {
      if (tmpPath) await unlink(tmpPath).catch(() => {});
      close();
    }
  })();

  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
