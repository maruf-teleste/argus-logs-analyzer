// // app/api/sessions/[sessionId]/chat/route.ts
// import { openai } from "@ai-sdk/openai";
// import { streamText, convertToModelMessages } from "ai";
// import { detectIntent } from "@/lib/analysis/intent-detector";
// import { buildQueryPlan } from "@/lib/analysis/query-builder";
// import { sql } from "@/lib/db/client";

// export const maxDuration = 30;

// export async function POST(
//   req: Request,
//   context: { params: Promise<{ sessionId: string }> }
// ) {
//   const { sessionId } = await context.params;
//   const { messages } = await req.json();

//   const lastMessage = messages[messages.length - 1];
//   const question = lastMessage.content;

//   console.log("🔍 Query:", question);

//   // Your existing logic
//   const intent = detectIntent(question);
//   const queryPlan = buildQueryPlan(sessionId, intent);
//   const events = await queryPlan.execute();

//   console.log("📊 Intent:", intent.type);
//   console.log("📦 Events:", events.length);

//   const systemPrompt = `You are a network log analysis expert.

// Query Type: ${intent.type}
// Results: ${events.length} events

// ${
//   events.length > 0
//     ? `Log Events:\n${JSON.stringify(events.slice(0, 20), null, 2)}`
//     : "No events found."
// }

// Analyze and explain concisely.`;

//   const result = streamText({
//     model: openai("gpt-4o-mini"),
//     messages: [
//       { role: "system", content: systemPrompt },
//       ...convertToModelMessages(messages),
//     ],
//     onFinish: async ({ text }) => {
//       await sql`
//         INSERT INTO conversation_history (session_id, role, content, metadata)
//         VALUES
//           (${sessionId}, 'user', ${question}, ${JSON.stringify({ intent })}),
//           (${sessionId}, 'assistant', ${text}, ${JSON.stringify({
//         result_count: events.length,
//       })})
//       `;
//       console.log("💾 Saved");
//     },
//   });

//   return result.toUIMessageStreamResponse();
// }
