import OpenAI from "openai";

export const TOOL_DEFINITIONS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "detect_anomalies",
      description: `DIFFERENTIAL ANALYSIS: Finds patterns that spiked during a problem period compared to a baseline.
      
        USE THIS FIRST when asked:
        - "What happened at X time?"
        - "Why did it fail?"
        - "What's the root cause?"
        - "What changed?"

        Returns patterns that are NEW or SIGNIFICANTLY INCREASED vs baseline.
        Example: If "Device timeout" appears 500 times during incident but only 2 times in baseline, that's your anomaly.`,

      parameters: {
        type: "object",
        properties: {
          file_id: { type: "number" },
          problem_start: {
            type: "string",
            description: "ISO timestamp - start of problem window",
          },
          problem_end: {
            type: "string",
            description: "ISO timestamp - end of problem window",
          },
          baseline_start: {
            type: "string",
            description:
              "Optional: start of baseline (auto-calculated if omitted)",
          },
          baseline_end: {
            type: "string",
            description:
              "Optional: end of baseline (auto-calculated if omitted)",
          },
          min_spike_ratio: {
            type: "number",
            description:
              "Minimum spike ratio to count as anomaly (default: 3x)",
          },
          severity_filter: {
            type: "array",
            items: { type: "string" },
            description: "Optional: only analyze certain severities",
          },
        },
        required: ["file_id", "problem_start", "problem_end"],
      },
    },
  },

  // DRILL DOWN - Get real examples of a pattern
  {
    type: "function",
    function: {
      name: "get_pattern_examples",
      description: `After detect_anomalies finds a pattern, use this to see actual log lines.
Returns real examples of logs matching a fingerprint pattern.`,
      parameters: {
        type: "object",
        properties: {
          file_id: { type: "number" },
          fingerprint: {
            type: "string",
            description: "The pattern fingerprint from detect_anomalies",
          },
          time_start: { type: "string" },
          time_end: { type: "string" },
          limit: { type: "number", default: 5 },
          include_context: {
            type: "boolean",
            description: "Include surrounding lines for first example",
          },
        },
        required: ["file_id", "fingerprint"],
      },
    },
  },

  // THE CHAIN BUILDER - Follow the thread
  {
    type: "function",
    function: {
      name: "get_correlated_events",
      description: `Find related events around a specific log line.
Correlate by: thread (same execution path), trace_id (distributed trace), 
time_window (nearby in time), or component.`,
      parameters: {
        type: "object",
        properties: {
          file_id: { type: "number" },
          anchor_line: {
            type: "number",
            description: "The line number to investigate around",
          },
          correlation_type: {
            type: "string",
            enum: ["thread", "trace_id", "time_window", "component"],
            description: "How to find related events",
          },
          window_seconds: {
            type: "number",
            description: "For time_window: seconds before/after",
          },
        },
        required: ["file_id", "anchor_line", "correlation_type"],
      },
    },
  },

  // THE OVERVIEW - File statistics
  {
    type: "function",
    function: {
      name: "get_file_overview",
      description: `Get file statistics with noise classification.
Shows: total lines, severity counts, noise percentage, time range.
USE THIS FIRST for "summarize" or "what's in this file" questions.`,
      parameters: {
        type: "object",
        properties: {
          file_id: { type: "number" },
        },
        required: ["file_id"],
      },
    },
  },

  // RAW LOGS - Direct access (constrained)
  {
    type: "function",
    function: {
      name: "get_raw_logs",
      description: `Get filtered raw logs. USE SPARINGLY - prefer detect_anomalies for investigation.
Stack traces are truncated to prevent token explosion.`,
      parameters: {
        type: "object",
        properties: {
          file_id: { type: "number" },
          severity: {
            type: "array",
            items: {
              type: "string",
              enum: ["ERROR", "WARN", "INFO", "DEBUG", "TRACE"],
            },
          },
          component: { type: "string" },
          search_text: { type: "string" },
          time_start: { type: "string" },
          time_end: { type: "string" },
          exclude_noise: {
            type: "boolean",
            default: true,
            description: "Filter out known telemetry noise patterns",
          },
          limit: { type: "number", default: 30, maximum: 100 },
        },
        required: ["file_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_session_files",
      description:
        "List all log files in the current session with their IDs, names, and error counts. Always call this first if you don't know the file_id.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_logs",
      description: "Get filtered logs from Parquet file.",
      parameters: {
        type: "object",
        properties: {
          file_id: { type: "number", description: "File ID" },
          severity: {
            type: "array",
            items: { type: "string", enum: ["ERROR", "WARN", "INFO", "DEBUG"] },
          },
          device_id: { type: "string" },
          component: { type: "string" },
          thread: { type: "string" },
          search_text: { type: "string", description: "Search in message" },
          limit: { type: "number", default: 50 },
          order: { type: "string", enum: ["asc", "desc"], default: "desc" },
        },
        required: ["file_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_thread_context",
      description:
        "Get logs before/after a specific line on the SAME THREAD. Essential for understanding what led to an error.",
      parameters: {
        type: "object",
        properties: {
          file_id: { type: "number" },
          thread: {
            type: "string",
            description: "Thread name (e.g., Device3002Worker-1)",
          },
          line_number: { type: "number", description: "Target line number" },
          context_lines: {
            type: "number",
            default: 10,
            description: "Lines before/after",
          },
        },
        required: ["file_id", "thread", "line_number"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_errors_with_stack_traces",
      description:
        "Get errors that have Java stack traces. Can filter by exception class.",
      parameters: {
        type: "object",
        properties: {
          file_id: { type: "number" },
          exception_class: {
            type: "string",
            description: "e.g., BadCredentialsException, NullPointerException",
          },
          component: { type: "string" },
          device_id: { type: "string" },
          limit: { type: "number", default: 10 },
        },
        required: ["file_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_log_by_line",
      description:
        "Get a specific log line by line number, with surrounding context.",
      parameters: {
        type: "object",
        properties: {
          file_id: { type: "number" },
          line_number: { type: "number" },
          context_lines: { type: "number", default: 5 },
        },
        required: ["file_id", "line_number"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_exception_summary",
      description:
        "Get summary of all Java exception types found in the file with counts.",
      parameters: {
        type: "object",
        properties: {
          file_id: { type: "number" },
        },
        required: ["file_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_time_series",
      description: "Get severity counts bucketed by time interval.",
      parameters: {
        type: "object",
        properties: {
          file_id: { type: "number" },
          interval: {
            type: "string",
            enum: ["minute", "hour", "day"],
            default: "hour",
          },
          severity: { type: "array", items: { type: "string" } },
        },
        required: ["file_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_device_summary",
      description: "Get health summary for a specific device.",
      parameters: {
        type: "object",
        properties: {
          file_id: { type: "number" },
          device_id: { type: "string" },
        },
        required: ["file_id", "device_id"],
      },
    },
  },
];
