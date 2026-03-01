// lib/query/tools-registry.ts
// Central registry for all DuckDB query tools
// Add new tools here - they'll automatically work in API routes and client

import * as client from "./duckdb-client";
//
export type ToolDefinition = {
  name: string;
  implementation: (...args: any[]) => Promise<any>;
  paramMapper?: (params: any) => any[];
};

export const TOOLS: Record<string, ToolDefinition> = {
  // Anomaly Detection & Analysis
  detect_anomalies: {
    name: "detect_anomalies",
    implementation: client.detectAnomalies,
    paramMapper: (p) => [p.file_id, p],
  },

  get_pattern_examples: {
    name: "get_pattern_examples",
    implementation: client.getPatternExamples,
    paramMapper: (p) => [p.file_id, p.fingerprint, p],
  },

  get_correlated_events: {
    name: "get_correlated_events",
    implementation: client.getCorrelatedEvents,
    paramMapper: (p) => [p],
  },

  // File Overview & Stats
  get_file_overview: {
    name: "get_file_overview",
    implementation: client.getFileOverviewEnhanced,
    paramMapper: (p) => [p.file_id],
  },

  get_severity_counts: {
    name: "get_severity_counts",
    implementation: client.getSeverityCounts,
    paramMapper: (p) => [p.file_id],
  },

  get_exception_summary: {
    name: "get_exception_summary",
    implementation: client.getExceptionSummary,
    paramMapper: (p) => [p.file_id],
  },

  get_time_series: {
    name: "get_time_series",
    implementation: client.getTimeSeries,
    paramMapper: (p) => [p.file_id, p.options],
  },

  // Timeline & Pattern Analysis
  get_timeline_histogram: {
    name: "get_timeline_histogram",
    implementation: client.getTimelineHistogram,
    paramMapper: (p) => [p.file_id],
  },

  get_anomaly_grid: {
    name: "get_anomaly_grid",
    implementation: client.getAnomalyGrid,
    paramMapper: (p) => [
      p.file_id,
      p.start_time,
      p.end_time,
      {
        severityFilter: p.severity_filter,
        limit: p.limit,
        offset: p.offset,
      },
    ],
  },

  get_pattern_samples: {
    name: "get_pattern_samples",
    implementation: client.getPatternSamples,
    paramMapper: (p) => [
      p.file_id,
      p.pattern_signature,
      p.start_time,
      p.end_time,
    ],
  },

  // Log Retrieval
  get_logs: {
    name: "get_logs",
    implementation: client.getLogs,
    paramMapper: (p) => [p.file_id, p.options],
  },

  get_log_by_line_number: {
    name: "get_log_by_line_number",
    implementation: client.getLogByLineNumber,
    paramMapper: (p) => [p.file_id, p.line_number, p.context_lines],
  },

  get_thread_context: {
    name: "get_thread_context",
    implementation: client.getThreadContext,
    paramMapper: (p) => [p.file_id, p.thread, p.line_number, p.context_lines],
  },

  get_time_based_context: {
    name: "get_time_based_context",
    implementation: client.getTimeBasedContext,
    paramMapper: (p) => [
      p.file_id,
      p.anchor_timestamp,
      p.time_window_seconds,
      p.thread,
      p.anchor_line_number,
    ],
  },

  // Error Analysis
  get_errors_with_stack_traces: {
    name: "get_errors_with_stack_traces",
    implementation: client.getErrorsWithStackTraces,
    paramMapper: (p) => [p.file_id, p.options],
  },

  // Device Analysis
  get_failing_devices: {
    name: "get_failing_devices",
    implementation: client.getFailingDevices,
    paramMapper: (p) => [p.file_id],
  },

  get_device_summary: {
    name: "get_device_summary",
    implementation: client.getDeviceSummary,
    paramMapper: (p) => [p.file_id, p.device_id],
  },

  // Cross-File Search
  search_across_files: {
    name: "search_across_files",
    implementation: client.searchAcrossFiles,
    paramMapper: (p) => [p.file_ids, p.search_text, p.options],
  },

  // 🔍 DEBUG TOOLS
  debug_semantic_matches: {
    name: "debug_semantic_matches",
    implementation: client.debugSemanticMatches,
    paramMapper: (p) => [p.file_id],
  },
};

// Helper to execute a tool
export async function executeTool(action: string, params: any): Promise<any> {
  const tool = TOOLS[action];

  if (!tool) {
    throw new Error(`Unknown action: ${action}`);
  }

  const args = tool.paramMapper ? tool.paramMapper(params) : [params];
  return tool.implementation(...args);
}

// Get list of all available tools
export function getAvailableTools(): string[] {
  return Object.keys(TOOLS);
}
