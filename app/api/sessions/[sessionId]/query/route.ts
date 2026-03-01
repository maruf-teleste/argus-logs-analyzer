export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { runAgentPipeline } from "@/lib/ai/orchestrator";
import { loadConversationHistory, getSessionFile } from "@/lib/ai/chat-history";
import { db } from "@/lib/db";

export async function POST(
  req: Request,
  context: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await context.params;
  const { question } = await req.json();
  const startTime = Date.now();

  // SSE stream setup
  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  let closed = false;

  function send(data: any) {
    if (closed) return;
    try {
      writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
    } catch {
      closed = true;
    }
  }

  req.signal.addEventListener("abort", () => {
    closed = true;
  });

  (async () => {
    try {
      // Simple conversational check
      const simple = handleSimple(question);
      if (simple) {
        try {
          db.saveTwoMessages(sessionId, "user", question, null, "assistant", simple, null);
        } catch (err) {
          console.warn("Failed to save simple message (session may be deleted):", err);
        }
        send({ stage: "complete", answer: simple });
        writer.close();
        return;
      }

      // Get active file (briefly wait for upload->ready transitions)
      const activeFile = await waitForActiveFile(sessionId);
      if (!activeFile) {
        const upload = db.getUploadStatus(sessionId);
        const msg =
          upload?.upload_status === "processing"
            ? "Your file is still processing. Please try again in a few seconds."
            : "I don't see any uploaded logs in this session yet. Please upload a file first.";
        send({ stage: "complete", answer: msg });
        writer.close();
        return;
      }

      const fileContext = `[ACTIVE CONTEXT]
You are analyzing a specific log file. DO NOT HALLUCINATE IDs.

- ACTIVE FILE ID: ${activeFile.file_id} (Use this for ALL tool calls)
- FILENAME: "${activeFile.filename}"
- LOG START: ${activeFile.time_range_start || "Unknown"}
- LOG END:   ${activeFile.time_range_end || "Unknown"}

[RULES]
1. When calling 'detect_anomalies', ensure timestamps match the "LOG START" and "LOG END" above.
2. If the user asks "What happened at 10:45?", they mean 10:45 inside the dates above.
3. Do NOT guess year. Use the year from the logs above.`;

      const conversationHistory = await loadConversationHistory(sessionId);

      // Run the agent pipeline with progress streaming
      const result = await runAgentPipeline(
        sessionId,
        question,
        activeFile.file_id,
        fileContext,
        conversationHistory,
        (progress) => send(progress)
      );

      const processingTime = Date.now() - startTime;

      // Save conversation (session may have been deleted mid-request)
      try {
        db.saveTwoMessages(
          sessionId,
          "user", question, null,
          "assistant", result.answer, JSON.stringify({ processingTime, ...result.metadata })
        );
      } catch (err) {
        console.warn("Failed to save conversation (session may be deleted):", err);
      }

      send({
        stage: "complete",
        answer: result.answer,
        metadata: {
          processingTime,
          ...result.metadata,
        },
      });
    } catch (err: any) {
      console.error("Agent pipeline error:", err);
      send({
        stage: "error",
        answer: handleAIError(err),
      });
    } finally {
      if (!closed) {
        closed = true;
        await writer.close().catch(() => {});
      }
    }
  })();

  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

async function waitForActiveFile(
  sessionId: string
): Promise<Awaited<ReturnType<typeof getSessionFile>> | null> {
  const timeoutMs = 20_000;
  const intervalMs = 500;
  const deadline = Date.now() + timeoutMs;

  let file = await getSessionFile(sessionId);
  if (file) return file;

  while (Date.now() < deadline) {
    const upload = db.getUploadStatus(sessionId);
    if (!upload || upload.upload_status === "error") break;

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    file = await getSessionFile(sessionId);
    if (file) return file;
  }

  return null;
}

function handleSimple(q: string): string | null {
  const clean = q.toLowerCase().trim();
  if (["hi", "hello", "hey"].includes(clean)) return "Hello! How can I help with your logs?";
  if (clean.includes("thanks")) return "You're welcome!";
  return null;
}

function handleAIError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("OpenAI") || msg.includes("API")) {
    return "I'm having trouble connecting to the AI service. Please try again in a moment.";
  }
  if (msg.includes("timeout")) {
    return "The analysis is taking longer than expected. Please try a more specific question.";
  }
  return "I encountered an unexpected issue. Please try rephrasing your question.";
}
