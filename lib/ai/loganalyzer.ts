// lib/ai/logAnalyzer.ts
import OpenAI from "openai";
import { SYSTEM_PROMPT } from "@/lib/ai/prompts";
import { TOOL_DEFINITIONS } from "@/lib/ai/tool-definitions";
import { executeToolCalls } from "@/lib/ai/tool-executor";
import {
  loadConversationHistory,
  saveConversationHistory,
  getSessionFile,
} from "@/lib/ai/chat-history";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

/* ============================================================
   MAIN ENTRY POINT
============================================================ */

export async function analyzeLogsWithAI(
  sessionId: string,
  question: string
): Promise<string> {
  // 1. Simple conversational check (saves tokens)
  const simple = handleSimpleConversation(question);
  if (simple) return simple;

  // 2. Get Active File Context
  const activeFile = await getSessionFile(sessionId);

  if (!activeFile) {
    return "I don't see any uploaded logs in this session yet. Please upload a file first.";
  }

  const fileId = activeFile.file_id;

  // 3. Construct System Context
  const contextSystemMessage: OpenAI.Chat.ChatCompletionMessageParam = {
    role: "system",
    content: `
      [ACTIVE CONTEXT]
      You are analyzing a specific log file. DO NOT HALLUCINATE IDs.
      
      - ACTIVE FILE ID: ${fileId} (Use this for ALL tool calls)
      - FILENAME: "${activeFile.filename}"
      - LOG START: ${activeFile.time_range_start || "Unknown"}
      - LOG END:   ${activeFile.time_range_end || "Unknown"}
      
      [RULES]
      1. When calling 'detect_anomalies', ensure timestamps match the "LOG START" and "LOG END" above.
      2. If the user asks "What happened at 10:45?", they mean 10:45 inside the dates above.
      3. Do NOT guess year. Use the year from the logs above.
    `,
  };

  // 4. Build Message Chain
  const conversationHistory = await loadConversationHistory(sessionId);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    contextSystemMessage,
    ...conversationHistory,
    { role: "user", content: question },
  ];

  console.log(
    `AI Context Injected: File ${fileId} (${activeFile.time_range_start} - ${activeFile.time_range_end})`
  );

  try {
    // 5. Run the AI Loop
    let response = await callModelWithTools(messages);
    let iterations = 0;
    const MAX_ITERATIONS = 8;

    while (hasToolCalls(response) && iterations < MAX_ITERATIONS) {
      const toolCalls = response.choices[0].message.tool_calls || [];

      console.log(
        `\n🔄 Iteration ${iterations + 1} | Calls: ${toolCalls.length}`
      );

      // Execute the tools (logic is now in tool-executor.ts)
      const toolMessages = await executeToolCalls(sessionId, fileId, response);

      if (toolMessages.length === 0) {
        console.error("No tool messages returned");
        break;
      }

      // Append Assistant's Intent + Tool Results
      messages.push({
        role: "assistant",
        content: response.choices[0].message.content,
        tool_calls: response.choices[0].message.tool_calls,
      });
      messages.push(...toolMessages);

      // Recursive Call
      response = await callModelWithTools(messages);
      iterations++;
    }

    const finalMessage =
      response.choices[0].message.content || "I couldn't generate a response.";

    // 6. Save History
    await saveConversationHistory(sessionId, "user", question);
    await saveConversationHistory(sessionId, "assistant", finalMessage);

    return finalMessage;
  } catch (err) {
    console.error("AI log analyzer error:", err);
    return handleAIError(err);
  }
}

/* ============================================================
   HELPERS
============================================================ */

function handleSimpleConversation(q: string): string | null {
  const clean = q.toLowerCase().trim();
  if (["hi", "hello", "hey"].includes(clean))
    return "Hello! How can I help with your logs?";
  if (clean.includes("thanks")) return "You're welcome!";
  return null;
}

function handleAIError(err: unknown): string {
  const errorMessage = err instanceof Error ? err.message : String(err);

  if (errorMessage.includes("OpenAI") || errorMessage.includes("API")) {
    return "I'm having trouble connecting to the AI service right now. Please try again in a moment.";
  }
  if (errorMessage.includes("timeout")) {
    return "The analysis is taking longer than expected. Please try asking a more specific question.";
  }

  return "I encountered an unexpected issue. Please try rephrasing your question.";
}

async function callModelWithTools(
  messages: OpenAI.Chat.ChatCompletionMessageParam[]
) {
  return withRetry(() =>
    openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.4,
      max_tokens: 1500,
      messages,
      tools: TOOL_DEFINITIONS,
      tool_choice: "auto",
    })
  );
}

function hasToolCalls(response: OpenAI.Chat.ChatCompletion): boolean {
  const msg = response.choices[0].message;
  return Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
}

async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (retries <= 0) throw err;
    await new Promise((r) => setTimeout(r, 300 * (4 - retries)));
    return withRetry(fn, retries - 1);
  }
}
