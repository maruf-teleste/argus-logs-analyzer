// lib/ai/duckdb-api.ts
// Auto-generated API client that syncs with tools-registry.ts
// No need to manually add functions - just use callTool()

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

// ============================================================
// CORE FETCH WRAPPER
// ============================================================
async function callDuckDB(action: string, params: any): Promise<any> {
  const response = await fetch(`${BASE_URL}/api/query/duckdb`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, params }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "DuckDB query failed");
  }

  return response.json();
}

// ============================================================
// GENERIC TOOL CALLER - Use this instead of individual functions
// ============================================================
export async function callTool(action: string, params: any): Promise<any> {
  return callDuckDB(action, params);
}

// ============================================================
// CONVENIENCE WRAPPERS (Optional - for better type safety)
// ============================================================

export async function detectAnomalies(
  fileId: number,
  problemStart: string,
  problemEnd: string,
  options?: {
    baselineStart?: string;
    baselineEnd?: string;
    minSpikeRatio?: number;
    severityFilter?: string[];
  }
) {
  return callTool("detect_anomalies", {
    file_id: fileId,
    problem_start: problemStart,
    problem_end: problemEnd,
    baseline_start: options?.baselineStart,
    baseline_end: options?.baselineEnd,
    min_spike_ratio: options?.minSpikeRatio,
    severity_filter: options?.severityFilter,
  });
}

export async function getPatternExamples(
  fileId: number,
  fingerprint: string,
  options?: {
    timeStart?: string;
    timeEnd?: string;
    limit?: number;
    includeContext?: boolean;
  }
) {
  return callTool("get_pattern_examples", {
    file_id: fileId,
    fingerprint,
    time_start: options?.timeStart,
    time_end: options?.timeEnd,
    limit: options?.limit,
    include_context: options?.includeContext,
  });
}

export async function getCorrelatedEvents(
  fileId: number,
  anchorLine: number,
  correlationType: "thread" | "trace_id" | "time_window" | "component",
  windowSeconds?: number
) {
  return callTool("get_correlated_events", {
    file_id: fileId,
    anchor_line: anchorLine,
    correlation_type: correlationType,
    window_seconds: windowSeconds,
  });
}

export async function getFileOverview(fileId: number) {
  return callTool("get_file_overview", { file_id: fileId });
}

export async function getLogs(fileId: number, options?: any) {
  return callTool("get_logs", { file_id: fileId, options });
}

export async function getThreadContext(
  fileId: number,
  thread: string,
  lineNumber: number,
  contextLines?: number
) {
  return callTool("get_thread_context", {
    file_id: fileId,
    thread,
    line_number: lineNumber,
    context_lines: contextLines,
  });
}

export async function getErrorsWithStackTraces(fileId: number, options?: any) {
  return callTool("get_errors_with_stack_traces", {
    file_id: fileId,
    options,
  });
}

export async function getLogByLineNumber(
  fileId: number,
  lineNumber: number,
  contextLines?: number
) {
  return callTool("get_log_by_line_number", {
    file_id: fileId,
    line_number: lineNumber,
    context_lines: contextLines,
  });
}

export async function getExceptionSummary(fileId: number) {
  return callTool("get_exception_summary", { file_id: fileId });
}

export async function getTimeSeries(fileId: number, options?: any) {
  return callTool("get_time_series", { file_id: fileId, options });
}

export async function getDeviceSummary(fileId: number, deviceId: string) {
  return callTool("get_device_summary", {
    file_id: fileId,
    device_id: deviceId,
  });
}

export async function getSeverityCounts(fileId: number) {
  return callTool("get_severity_counts", { file_id: fileId });
}

export async function searchAcrossFiles(
  fileIds: number[],
  searchText: string,
  options?: {
    severity?: string[];
    limit?: number;
  }
) {
  return callTool("search_across_files", {
    file_ids: fileIds,
    search_text: searchText,
    options,
  });
}

export async function getTimelineHistogram(fileId: number) {
  return callTool("get_timeline_histogram", { file_id: fileId });
}

export async function getAnomalyGrid(
  fileId: number,
  startTime: string,
  endTime: string,
  options?: {
    severityFilter?: string[];
    limit?: number;
    offset?: number;
  }
) {
  return callTool("get_anomaly_grid", {
    file_id: fileId,
    start_time: startTime,
    end_time: endTime,
    severity_filter: options?.severityFilter,
    limit: options?.limit,
    offset: options?.offset,
  });
}

export async function getPatternSamples(
  fileId: number,
  patternSignature: string,
  startTime: string,
  endTime: string
) {
  return callTool("get_pattern_samples", {
    file_id: fileId,
    pattern_signature: patternSignature,
    start_time: startTime,
    end_time: endTime,
  });
}

// ============================================================
// DEBUG TOOLS
// ============================================================

/**
 * 🔍 DEBUG: Find which logs are triggering semantic alerts
 * Use this to identify false positives and update IGNORE_PATTERNS
 */
export async function debugSemanticMatches(fileId: number) {
  return callTool("debug_semantic_matches", { file_id: fileId });
}

// ============================================================
// NON-DUCKDB APIS
// ============================================================

export async function listSessionFiles(sessionId: string) {
  const response = await fetch(`${BASE_URL}/api/sessions/${sessionId}/files`);
  if (!response.ok) return [];
  return response.json();
}
