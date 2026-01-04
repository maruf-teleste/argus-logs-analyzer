import OpenAI from "openai";
import * as DuckAPI from "@/lib/ai/duckdb-api";
import { listSessionFiles } from "@/lib/ai/chat-history";

export async function executeToolCalls(
  sessionId: string,
  fileId: number,
  response: OpenAI.Chat.ChatCompletion
): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> {
  console.log("Inside executeToolCalls");

  if (!response?.choices?.[0]?.message?.tool_calls) {
    return [];
  }

  const toolCalls = response.choices[0].message.tool_calls;
  const results: OpenAI.Chat.ChatCompletionMessageParam[] = [];

  for (const tc of toolCalls) {
    const name = tc.function.name;
    let args: any = {};

    try {
      args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
    } catch {
      console.error("Failed to parse tool arguments");
    }

    // Auto-correct hallucinated file_ids
    const targetFileId =
      args.file_id && args.file_id !== fileId ? fileId : args.file_id || fileId;

    let data: any;

    try {
      switch (name) {
        // ============================================================
        // 1. THE DETECTIVE (Differential Analysis)
        // ============================================================
        case "detect_anomalies":
          data = await DuckAPI.detectAnomalies(
            targetFileId,
            args.problem_start,
            args.problem_end,
            {
              baselineStart: args.baseline_start,
              baselineEnd: args.baseline_end,
              minSpikeRatio: args.min_spike_ratio,
              severityFilter: args.severity_filter,
            }
          );
          break;

        // ============================================================
        // 2. DRILL DOWN (Pattern Examples)
        // ============================================================
        case "get_pattern_examples":
          data = await DuckAPI.getPatternExamples(
            targetFileId,
            args.fingerprint,
            {
              timeStart: args.time_start,
              timeEnd: args.time_end,
              limit: args.limit,
              includeContext: args.include_context,
            }
          );
          break;

        // ============================================================
        // 3. THE CHAIN BUILDER (Correlations)
        // ============================================================
        case "get_correlated_events":
          data = await DuckAPI.getCorrelatedEvents(
            targetFileId,
            args.anchor_line,
            args.correlation_type,
            args.window_seconds
          );
          break;

        // ============================================================
        // 4. THE OVERVIEW
        // ============================================================
        case "get_file_overview":
          data = await DuckAPI.getFileOverview(targetFileId);
          break;

        case "list_session_files":
          // This is imported from chat-history, so it's fine without DuckAPI prefix
          data = await listSessionFiles(sessionId);
          break;

        // ============================================================
        // 5. THE LIBRARIAN (Raw Logs - Legacy Support)
        // ============================================================

        case "get_logs":
          data = await DuckAPI.getLogs(targetFileId, {
            severity: args.severity,
            deviceId: args.device_id,
            component: args.component,
            thread: args.thread,
            searchText: args.search_text,
            limit: args.limit,
            order: args.order,
          });
          break;

        case "get_thread_context":
          data = await DuckAPI.getThreadContext(
            targetFileId,
            args.thread,
            args.line_number,
            args.context_lines
          );
          break;

        case "get_errors_with_stack_traces":
          data = await DuckAPI.getErrorsWithStackTraces(targetFileId, {
            exceptionClass: args.exception_class,
            component: args.component,
            deviceId: args.device_id,
            limit: args.limit,
          });
          break;

        case "get_log_by_line":
          // Ensure this matches the export name in duckdb-api.ts
          // It might be 'getLogByLineNumber' in your API file
          data = await DuckAPI.getLogByLineNumber(
            targetFileId,
            args.line_number,
            args.context_lines
          );
          break;

        case "get_exception_summary":
          data = await DuckAPI.getExceptionSummary(targetFileId);
          break;

        case "get_time_series":
          data = await DuckAPI.getTimeSeries(targetFileId, {
            interval: args.interval,
            severity: args.severity,
          });
          break;

        case "get_device_summary":
          data = await DuckAPI.getDeviceSummary(targetFileId, args.device_id);
          break;

        default:
          data = { error: `Unknown tool: ${name}` };
      }
    } catch (err: any) {
      console.error(`Tool execution failed for ${name}:`, err);
      data = { error: err.message || "Internal Tool Error" };
    }

    results.push({
      role: "tool",
      tool_call_id: tc.id,
      content: JSON.stringify(data),
    });
  }

  return results;
}
