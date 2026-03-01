// lib/ai/orchestrator.ts
// Agent Architecture: Orchestrator (1 LLM) → Parallel Workers (0 LLM) → Synthesizer (1 LLM)
// The orchestrator can use pre-defined tools OR write custom DuckDB SQL queries.

import OpenAI from "openai";
import { SYSTEM_PROMPT } from "./prompts";
import * as DuckAPI from "./duckdb-api";
import { listSessionFiles } from "./chat-history";
import { runQuery, getLocalParquetPath } from "@/lib/query/duckdb-client";
import { searchKB, formatKBResults } from "./kb-worker";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

/* ============================================================
   TYPES
============================================================ */

export interface AgentProgress {
  stage: "planning" | "executing" | "synthesizing" | "complete" | "error";
  message: string;
  workers?: string[];
  activity?: {
    kind: "tool" | "sql" | "kb";
    name: string;
    detail?: string;
  };
}

export interface AgentMetadata {
  reasoning: string;
  toolsUsed: string[];
  sqlQueries: string[];
  kbKeywords: string[];
  workerCount: number;
  successCount: number;
}

export interface AgentResult {
  answer: string;
  metadata: AgentMetadata;
}

interface ToolCall {
  name: string;
  args: Record<string, any>;
}

interface SQLQuery {
  description: string; // what this query answers
  sql: string; // DuckDB SQL — {{FILE}} placeholder replaced with parquet path
}

interface OrchestratorPlan {
  tools: ToolCall[];
  sqlQueries: SQLQuery[];
  kbKeywords: string[];
  reasoning: string;
}

interface WorkerResult {
  tool: string;
  result: any;
  error?: string;
}

/* ============================================================
   PARQUET SCHEMA (for the planner)
============================================================ */

const PARQUET_SCHEMA = `
Parquet file columns (DuckDB SQL):
  line_number    INT64       -- sequential line number in original log file
  timestamp      INT64       -- unix epoch milliseconds (nullable)
  thread         VARCHAR     -- Java thread name, e.g. "ElementMessageQueue-417"
  thread_group   VARCHAR     -- thread group, e.g. "ElementMessageQueue"
  severity       VARCHAR     -- ERROR, WARN, INFO, DEBUG, TRACE
  component      VARCHAR     -- Java class/logger name
  message        VARCHAR     -- log message text
  device_id      VARCHAR     -- device ID extracted from message (nullable)
  ip_address     VARCHAR     -- IP address extracted from message (nullable)
  has_stack_trace BOOLEAN    -- true if this line has a Java stack trace
  stack_trace    VARCHAR     -- full stack trace text (nullable)
  exception_class VARCHAR    -- Java exception class name (nullable)

Use read_parquet('{{FILE}}') to query. Timestamps are epoch ms — use epoch_ms(timestamp) to convert to TIMESTAMP.
Example: SELECT severity, COUNT(*) FROM read_parquet('{{FILE}}') GROUP BY severity
Example: SELECT message FROM read_parquet('{{FILE}}') WHERE severity = 'ERROR' LIMIT 10
Example: SELECT component, COUNT(*) as cnt FROM read_parquet('{{FILE}}') WHERE severity = 'ERROR' GROUP BY component ORDER BY cnt DESC
`;

/* ============================================================
   ORCHESTRATOR — 1 LLM call to plan
============================================================ */

async function planAnalysis(
  question: string,
  fileId: number,
  fileContext: string,
  conversationHistory: OpenAI.Chat.ChatCompletionMessageParam[],
): Promise<OrchestratorPlan> {
  const planPrompt = `You are an analysis planner for a log analysis system. Given the user's question, plan what data to gather to give a COMPLETE answer in one pass.

You have two ways to gather data:
1. Pre-built tools (convenient shortcuts for common operations)
2. Custom SQL queries against DuckDB parquet files (for anything the tools don't cover)

PRE-BUILT TOOLS:
- get_file_overview: File stats, severity counts, noise classification
- get_errors_with_stack_traces: Errors with Java stack traces (can filter by exception_class, component, device_id)
- get_exception_summary: Count of each exception type
- detect_anomalies: Find patterns that spiked in a time window vs baseline (needs problem_start, problem_end timestamps)
- get_pattern_examples: Get log lines matching a fingerprint pattern
- get_correlated_events: Find related events around a line number (by thread, trace_id, time_window, component)
- get_logs: Filtered log query (severity, component, device, search_text, limit)
- get_thread_context: Logs before/after a line on the same thread
- get_time_series: Severity counts bucketed by minute/hour/day
- get_device_summary: Health summary for a specific device
- get_failing_devices: Top failing IPs/devices ranked by exception count, with exception types per device
- get_log_by_line_number: Get a specific line with context
- list_session_files: List all files in this session

${PARQUET_SCHEMA}

Active file_id: ${fileId}
${fileContext}

Output valid JSON:
{
  "tools": [{"name": string, "args": object}],      // pre-built tools, file_id: ${fileId}
  "sqlQueries": [{"description": string, "sql": string}],  // custom DuckDB SQL, use {{FILE}} placeholder
  "kbKeywords": string[],                            // search Argus knowledge base
  "reasoning": string                                // brief explanation
}

RULES:
1. ALWAYS use file_id: ${fileId} for tools. Use {{FILE}} in SQL queries.
2. Be THOROUGH — gather 2-5 data points. Better to over-fetch than under-fetch.
3. Use SQL when the question needs something tools can't do (custom aggregations, specific filters, counting, grouping).
4. For overview/summary: get_file_overview + get_errors_with_stack_traces + get_exception_summary
5. For errors: get_errors_with_stack_traces + SQL for custom error analysis
6. For time-based questions: detect_anomalies + relevant SQL
7. For "how many X" or "which components" or counting questions: prefer SQL
8. ALWAYS add LIMIT 50 to SQL queries to prevent huge results
9. For greetings: {"tools":[], "sqlQueries":[], "kbKeywords":[], "reasoning":"greeting"}
10. ALWAYS include errors data when the file has errors
11. Use kbKeywords for Argus-specific concepts (exceptions, alarms, polling, configuration)
12. For "why is X not working" or troubleshooting: ALWAYS include get_exception_summary + get_failing_devices
13. get_exception_summary returns BOTH formal stack-trace exceptions AND text-extracted exceptions from message/stack_trace content`;

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: planPrompt },
    ...conversationHistory.slice(-4),
    { role: "user", content: question },
  ];

  const response = await withRetry(() =>
    openai.chat.completions.create({
      model: "gpt-5.2",
      temperature: 0,
      max_completion_tokens: 800,
      messages,
      response_format: { type: "json_object" },
    }),
  );

  const content = response.choices[0].message.content || "{}";
  try {
    const plan = JSON.parse(content);
    return {
      tools: Array.isArray(plan.tools) ? plan.tools : [],
      sqlQueries: Array.isArray(plan.sqlQueries) ? plan.sqlQueries : [],
      kbKeywords: Array.isArray(plan.kbKeywords) ? plan.kbKeywords : [],
      reasoning: plan.reasoning || "",
    };
  } catch {
    return {
      tools: [{ name: "get_file_overview", args: { file_id: fileId } }],
      sqlQueries: [],
      kbKeywords: [],
      reasoning: "Fallback — failed to parse orchestrator output",
    };
  }
}

/* ============================================================
   WORKERS — 0 LLM calls, parallel execution
============================================================ */

// Execute a pre-defined tool
async function executeSingleTool(
  sessionId: string,
  fileId: number,
  toolName: string,
  args: Record<string, any>,
  onProgress?: (progress: AgentProgress) => void,
): Promise<WorkerResult> {
  const targetFileId = args.file_id || fileId;

  const summarize = (value: unknown) => {
    if (value === undefined || value === null || value === "") return "";
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  };

  const toolLabels: Record<string, string> = {
    detect_anomalies: "Detect anomalies",
    get_pattern_examples: "Get pattern examples",
    get_correlated_events: "Get correlated events",
    get_file_overview: "Get file overview",
    list_session_files: "List session files",
    get_logs: "Get logs",
    get_thread_context: "Get thread context",
    get_errors_with_stack_traces: "Get errors with stack traces",
    get_log_by_line: "Get log by line",
    get_log_by_line_number: "Get log by line number",
    get_exception_summary: "Get exception summary",
    get_time_series: "Get time series",
    get_device_summary: "Get device summary",
    get_failing_devices: "Get failing devices",
  };

  const toolDetail =
    summarize(args.fingerprint) ||
    summarize(args.search_text) ||
    summarize(args.component) ||
    summarize(args.exception_class) ||
    summarize(args.device_id) ||
    summarize(args.thread) ||
    summarize(args.line_number);

  onProgress?.({
    stage: "executing",
    message: "Executing analysis workers...",
    activity: {
      kind: "tool",
      name: toolLabels[toolName] || toolName,
      detail: toolDetail || undefined,
    },
  });

  try {
    let data: any;

    switch (toolName) {
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
          },
        );
        break;
      case "get_pattern_examples":
        data = await DuckAPI.getPatternExamples(
          targetFileId,
          args.fingerprint,
          {
            timeStart: args.time_start,
            timeEnd: args.time_end,
            limit: args.limit,
            includeContext: args.include_context,
          },
        );
        break;
      case "get_correlated_events":
        data = await DuckAPI.getCorrelatedEvents(
          targetFileId,
          args.anchor_line,
          args.correlation_type,
          args.window_seconds,
        );
        break;
      case "get_file_overview":
        data = await DuckAPI.getFileOverview(targetFileId);
        break;
      case "list_session_files":
        data = await listSessionFiles(sessionId);
        break;
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
          args.context_lines,
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
      case "get_log_by_line_number":
        data = await DuckAPI.getLogByLineNumber(
          targetFileId,
          args.line_number,
          args.context_lines,
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
      case "get_failing_devices":
        data = await DuckAPI.getFailingDevices(targetFileId);
        break;
      default:
        data = { error: `Unknown tool: ${toolName}` };
    }
    return { tool: toolName, result: data };
  } catch (err: any) {
    console.error(`Worker [${toolName}] failed:`, err.message);
    return { tool: toolName, result: null, error: err.message };
  }
}

// Execute a custom SQL query (read-only, with safety limits)
async function executeCustomSQL(
  fileId: number,
  query: SQLQuery,
  onProgress?: (progress: AgentProgress) => void,
): Promise<WorkerResult> {
  try {
    onProgress?.({
      stage: "executing",
      message: "Executing analysis workers...",
      activity: {
        kind: "sql",
        name: "Run custom SQL",
        detail: query.description,
      },
    });

    const parquetPath = await getLocalParquetPath(fileId);

    // Replace {{FILE}} placeholder with actual path
    let sql = query.sql.replace(/\{\{FILE\}\}/g, parquetPath);

    // Safety: enforce LIMIT if not present
    if (!/\bLIMIT\b/i.test(sql)) {
      sql = sql.replace(/;?\s*$/, " LIMIT 100");
    }

    // Safety: block mutations
    const forbidden =
      /\b(DROP|DELETE|INSERT|UPDATE|ALTER|CREATE|TRUNCATE|COPY)\b/i;
    if (forbidden.test(sql)) {
      return {
        tool: `sql: ${query.description}`,
        result: null,
        error: "Write operations not allowed",
      };
    }

    console.log(`[AGENT SQL] ${query.description}: ${sql.slice(0, 200)}`);
    const rows = await runQuery(sql);

    return {
      tool: `sql: ${query.description}`,
      result: rows,
    };
  } catch (err: any) {
    console.error(`[AGENT SQL] Failed: ${query.description}`, err.message);
    return {
      tool: `sql: ${query.description}`,
      result: null,
      error: err.message,
    };
  }
}

/* ============================================================
   SYNTHESIZER — 1 LLM call to merge
============================================================ */

async function synthesize(
  question: string,
  fileContext: string,
  workerResults: WorkerResult[],
  kbContext: string,
  conversationHistory: OpenAI.Chat.ChatCompletionMessageParam[],
): Promise<string> {
  const resultsText = workerResults
    .map((wr) => {
      if (wr.error) return `[${wr.tool}] ERROR: ${wr.error}`;
      const json = JSON.stringify(wr.result);
      return `[${wr.tool}] ${json.length > 5000 ? json.slice(0, 5000) + "...(truncated)" : json}`;
    })
    .join("\n\n");

  const kbSection = kbContext
    ? `\n\nARGUS KNOWLEDGE BASE REFERENCE:\n${kbContext}`
    : "";

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "system", content: fileContext },
    ...conversationHistory.slice(-6),
    {
      role: "user",
      content: `${question}\n\n---\nDATA FROM ANALYSIS WORKERS:\n${resultsText}${kbSection}`,
    },
  ];

  const response = await withRetry(() =>
    openai.chat.completions.create({
      model: "gpt-5.2",
      temperature: 0.4,
      max_completion_tokens: 2000,
      messages,
    }),
  );

  return (
    response.choices[0].message.content || "I couldn't generate a response."
  );
}

/* ============================================================
   MAIN PIPELINE: Orchestrator → Workers → Synthesizer
============================================================ */

export async function runAgentPipeline(
  sessionId: string,
  question: string,
  fileId: number,
  fileContext: string,
  conversationHistory: OpenAI.Chat.ChatCompletionMessageParam[],
  onProgress: (progress: AgentProgress) => void,
): Promise<AgentResult> {
  // Step 1: Orchestrator plans
  onProgress({ stage: "planning", message: "Planning analysis approach..." });
  console.log(`[AGENT] Planning for question: "${question.slice(0, 80)}"`);

  const plan = await planAnalysis(
    question,
    fileId,
    fileContext,
    conversationHistory,
  );
  console.log(
    `[AGENT] Plan: ${plan.tools.length} tools, ${plan.sqlQueries.length} SQL queries, kb=${plan.kbKeywords.length} keywords`,
  );
  console.log(`[AGENT] Reasoning: ${plan.reasoning}`);

  // Stream the plan so the UI can show it in real-time
  onProgress({
    stage: "planning",
    message: plan.reasoning,
    plan: {
      tools: plan.tools.map((t) => t.name),
      sqlQueries: plan.sqlQueries.map((q) => q.description),
      kbKeywords: plan.kbKeywords,
    },
  } as any);

  const hasKB = plan.kbKeywords.length > 0;
  const hasWork = plan.tools.length > 0 || plan.sqlQueries.length > 0 || hasKB;

  if (!hasWork) {
    onProgress({ stage: "synthesizing", message: "Generating response..." });
    const answer = await synthesize(
      question,
      fileContext,
      [],
      "",
      conversationHistory,
    );
    return {
      answer,
      metadata: {
        reasoning: plan.reasoning,
        toolsUsed: [],
        sqlQueries: [],
        kbKeywords: [],
        workerCount: 0,
        successCount: 0,
      },
    };
  }

  // Step 2: Execute all workers in parallel
  const workerNames: string[] = [
    ...plan.tools.map((t) => t.name),
    ...plan.sqlQueries.map(() => `sql_query`),
    ...(hasKB ? ["knowledge_base"] : []),
  ];

  onProgress({
    stage: "executing",
    message: `Running ${workerNames.length} analysis task${workerNames.length > 1 ? "s" : ""}...`,
    workers: workerNames,
  });

  const workerPromises: Promise<WorkerResult>[] = [
    // Pre-defined tools
    ...plan.tools.map((tc) =>
      executeSingleTool(sessionId, fileId, tc.name, tc.args, onProgress),
    ),
    // Custom SQL queries
    ...plan.sqlQueries.map((q) => executeCustomSQL(fileId, q, onProgress)),
  ];

  let kbContext = "";
  if (hasKB) {
    onProgress({
      stage: "executing",
      message: "Executing analysis workers...",
      activity: {
        kind: "kb",
        name: "Search knowledge base",
        detail: `${plan.kbKeywords.slice(0, 3).join(", ")}${plan.kbKeywords.length > 3 ? "…" : ""}`,
      },
    });
    workerPromises.push(
      Promise.resolve(
        (() => {
          const { sections } = searchKB(plan.kbKeywords, 5, 1500);
          kbContext = formatKBResults(sections);
          return {
            tool: "knowledge_base",
            result:
              sections.length > 0
                ? `Found ${sections.length} relevant KB sections`
                : "No matching KB sections",
          };
        })(),
      ),
    );
  }

  const workerResults = await Promise.all(workerPromises);

  const successCount = workerResults.filter((r) => !r.error).length;
  console.log(
    `[AGENT] Workers complete: ${successCount}/${workerResults.length} succeeded`,
  );

  // Step 3: Synthesize
  onProgress({
    stage: "synthesizing",
    message: "Synthesizing final answer...",
  });
  const answer = await synthesize(
    question,
    fileContext,
    workerResults,
    kbContext,
    conversationHistory,
  );

  onProgress({ stage: "complete", message: "Done" });
  return {
    answer,
    metadata: {
      reasoning: plan.reasoning,
      toolsUsed: plan.tools.map((t) => t.name),
      sqlQueries: plan.sqlQueries.map((q) => q.description),
      kbKeywords: plan.kbKeywords,
      workerCount: workerResults.length,
      successCount: successCount,
    },
  };
}

/* ============================================================
   HELPERS
============================================================ */

async function withRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (retries <= 0) throw err;
    await new Promise((r) => setTimeout(r, 500 * (3 - retries)));
    return withRetry(fn, retries - 1);
  }
}
