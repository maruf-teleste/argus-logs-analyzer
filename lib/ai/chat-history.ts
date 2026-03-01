import { db } from "@/lib/db";
import OpenAI from "openai";

export async function loadConversationHistory(
  sessionId: string
): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> {
  console.log("Loading history for session:", sessionId);
  try {
    const history = db.getConversationHistory(sessionId, 10);
    return history.map((h) => ({
      role: h.role as "user" | "assistant",
      content: h.content,
    }));
  } catch (err) {
    console.error("loadConversationHistory error:", err);
    return [];
  }
}

export async function saveConversationHistory(
  sessionId: string,
  role: "user" | "assistant",
  content: string
) {
  console.log("Saving to session:", sessionId);
  try {
    db.saveMessage(sessionId, role, content);
  } catch (err) {
    console.error("saveConversationHistory error:", err);
  }
}

export async function getSessionFile(sessionId: string) {
  const files = db.getSessionFiles(sessionId);
  return files[0] ?? null;
}

export async function listSessionFiles(sessionId: string) {
  return db.getSessionFiles(sessionId);
}
