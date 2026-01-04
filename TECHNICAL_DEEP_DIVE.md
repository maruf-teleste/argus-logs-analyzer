# Argus Technical Deep Dive

This document provides a detailed technical explanation of the core architectural concepts of the Argus Log Analyzer, focusing on the anomaly detection engine, the AI's toolkit, and the data querying layer.

---

## 1. The Anomaly Detection Engine: Differential Analysis

The system's primary strength is not just finding errors, but finding *what is abnormal*. It does this using a technique called **differential analysis**. This directly addresses your question about comparing "pattern spikes."

The core logic resides in the `detect_anomalies` AI tool. Here is how it works step-by-step:

**The Goal:** To compare a "problem" time window (e.g., 10:30-10:45, when an issue was reported) to a "baseline" time window (e.g., 10:15-10:30, which represents normal operation).

**Step 1: Parallel Pattern Aggregation**
The system does **not** read raw logs. Instead, it runs two parallel database queries against the structured Parquet data:
- **Query A:** Groups all logs within the **baseline** window by their `pattern_signature` and gets a frequency count for each pattern.
  - *Result (Baseline Map):* `{'Pattern_A': 10, 'Pattern_B': 105}`
- **Query B:** Does the same for the **problem** window.
  - *Result (Problem Map):* `{'Pattern_A': 150, 'Pattern_B': 110, 'Pattern_C': 25}`

**Step 2: The Comparison Algorithm**
The backend code then iterates through the "Problem Map" and compares each entry to the "Baseline Map":

1.  **Is the pattern new?**
    - The algorithm checks if `Pattern_C` exists in the Baseline Map. It doesn't.
    - **Conclusion:** `Pattern_C` is flagged as a **"New"** anomaly. This is a very high-signal indicator of a change in system behavior.

2.  **Has the pattern spiked significantly?**
    - The algorithm looks at `Pattern_A`. It exists in both maps.
    - It calculates the percentage increase: `(150 - 10) / 10 = 1400%`.
    - This value is compared against a hardcoded threshold (e.g., > 200%).
    - **Conclusion:** `1400%` is far above the threshold, so `Pattern_A` is flagged as a **"Spike"** anomaly.

3.  **Is the pattern stable (noise)?**
    - The algorithm looks at `Pattern_B`. It exists in both maps.
    - It calculates the percentage increase: `(110 - 105) / 105 = 4.7%`.
    - **Conclusion:** This is below the threshold and is considered normal fluctuation or "noise." It is ignored.

**Step 3: The Result**
The `detect_anomalies` tool returns a clean, ranked list containing only the high-signal items: `['Pattern_C (New)', 'Pattern_A (Spike)']`. This is the data that powers the `PatternTable` UI, giving the analyst a focused view of what actually *changed*.

---

## 2. In-Depth AI Toolkit (`lib/ai/tool-definitions.ts`)

The AI's capabilities are strictly defined by its tools. Here are the most important ones:

#### `detect_anomalies`
- **Purpose:** The primary investigation tool. It performs the differential analysis described above.
- **Inputs:** `start_time_problem`, `end_time_problem`, `start_time_baseline`, `end_time_baseline`, `file_id`.
- **Under the Hood:** Executes the two parallel aggregation queries and runs the comparison algorithm. The AI is prompted to use this *first* before any other tool.

#### `get_pattern_examples`
- **Purpose:** To bridge the gap from a statistical anomaly to the raw evidence.
- **Inputs:** `pattern_signature` (the ID of the pattern), `time_range`, `limit`.
- **Under the Hood:** Executes a targeted `SELECT * ... WHERE pattern_signature = ?` query against the Parquet file. This is how the UI can show you the exact raw log messages that make up a pattern like "Login Failed".

#### `get_correlated_events`
- **Purpose:** To build a narrative or "story" around a single log entry. This is essential for root cause analysis.
- **Inputs:** A specific log's `timestamp`, its `thread_id`, and a time `window` (e.g., 5 seconds before and after).
- **Under the Hood:** This is a powerful query. It selects all logs that share the same `thread_id` (or `trace_id` if available) within the specified time window. This allows the AI to trace a process flow, for example, seeing the request, the authentication attempt, the database call, and the resulting error, all within the same thread of execution.

#### `summarize_exceptions`
- **Purpose:** To get a quick overview of all software crashes within a time frame.
- **Inputs:** `start_time`, `end_time`, `file_id`.
- **Under the Hood:** Runs a query `SELECT exception_class, COUNT(*) ... WHERE has_stack_trace = true ... GROUP BY exception_class`. This quickly answers questions like "Are we seeing a lot of NullPointerExceptions?".

---

## 3. The Data Layer: DuckDB + S3 + Parquet

This combination is the secret to the application's performance. The system does **not** load the entire log file into memory or a traditional database.

#### How DuckDB Queries Work
1.  **DuckDB is an "in-process" analytical database.** This means it runs as part of the backend Node.js application itself, without needing a separate database server.

2.  **It Queries S3 Directly.** When an AI tool needs data, a query function builds a special SQL statement for DuckDB. Critically, the `FROM` clause does not point to a local table, but directly to the file in S3:
    ```sql
    SELECT thread_id, message
    FROM 's3://argus-log-bucket/logs/session-abc/file-123.parquet'
    WHERE severity = 'ERROR';
    ```

3.  **Parquet Makes it Fast.** The Parquet format stores data in columns. When DuckDB receives the query above, its S3 integration is smart enough to know that it only needs to read the `severity`, `thread_id`, and `message` columns. It completely ignores the bytes for all other columns (like `timestamp`, `component`, etc.), dramatically reducing the amount of data downloaded from S3.

4.  **Predicate Pushdown.** DuckDB also performs "predicate pushdown." It analyzes the `WHERE severity = 'ERROR'` clause and tries to filter the data as early as possible, often while the data is still being streamed from S3, further minimizing memory usage.

In summary, the combination of **S3** for storage, **Parquet** for columnar structure, and **DuckDB** for direct, intelligent querying allows the application to perform complex analytical queries on huge log files with very high performance.
