// lib/query/duckdb-client.ts
import * as duckdb from "duckdb";
import * as path from "path";
import * as fs from "fs";
import { db as appDb } from "@/lib/db";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { pipeline } from "stream/promises";
import { Readable } from "stream";

// Local parquet cache directory — DuckDB reads from here, not S3
export const PARQUET_DIR = path.resolve(process.env.PARQUET_DIR || "./data/parquet");

interface AnomalyDetectionParams {
  file_id: number;
  problem_start: string; // ISO timestamp
  problem_end: string;
  baseline_start?: string; // If not provided, auto-select
  baseline_end?: string;
  min_spike_ratio?: number; // Default 3x = anomaly
  min_occurrences?: number; // Minimum count in problem window
  severity_filter?: string[]; // Optional: only analyze certain severities
}

// ============================================================
// DUCKDB SETUP
// ============================================================

let db: duckdb.Database | null = null;
let conn: duckdb.Connection | null = null;
let initPromise: Promise<duckdb.Connection> | null = null;
let lastCredentialRefresh = 0;

// Refresh credentials every 15 minutes to be safe (ECS tokens last ~1hr)
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

async function refreshCredentials(connection: duckdb.Connection) {
  try {
    const credentialProvider = fromNodeProviderChain();
    const credentials = await credentialProvider();

    // Use prepared statements logic or simple interpolation (safe here as AWS keys are base64)
    connection.run(`
      SET s3_region='${process.env.AWS_REGION || "eu-north-1"}';
      SET s3_access_key_id='${credentials.accessKeyId}';
      SET s3_secret_access_key='${credentials.secretAccessKey}';
      ${
        credentials.sessionToken
          ? `SET s3_session_token='${credentials.sessionToken}';`
          : "RESET s3_session_token;"
      }
    `);

    lastCredentialRefresh = Date.now();
    console.log("DuckDB AWS credentials refreshed");
  } catch (error) {
    console.error("Failed to refresh AWS credentials for DuckDB", error);
    throw error;
  }
}

async function initializeDb(): Promise<duckdb.Connection> {
  // 1. Initialize DB and Connection
  db = new duckdb.Database(":memory:");
  conn = db.connect();

  // 2. Install Extensions once
  await new Promise<void>((resolve, reject) => {
    conn!.run("INSTALL httpfs; LOAD httpfs;", (err: any) => {
      if (err) reject(err);
      else resolve();
    });
  });

  // 3. Set initial credentials
  await refreshCredentials(conn);

  return conn;
}

async function getConnection(): Promise<duckdb.Connection> {
  // Prevent race conditions by caching the Promise, not just the result
  if (!initPromise) {
    initPromise = initializeDb();
  }

  const connection = await initPromise;

  if (Date.now() - lastCredentialRefresh > REFRESH_INTERVAL_MS) {
    await refreshCredentials(connection);
  }

  return connection;
}

function convertBigInts(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "bigint") return Number(obj);
  if (Array.isArray(obj)) return obj.map(convertBigInts);
  if (typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, convertBigInts(v)])
    );
  }
  return obj;
}

export async function runQuery<T = any>(sql: string): Promise<T[]> {
  return new Promise(async (resolve, reject) => {
    try {
      const connection = await getConnection();
      connection.all(sql, (err: Error | null, rows: any) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(convertBigInts((rows || []) as any[]) as T[]);
      });
    } catch (e) {
      reject(e);
    }
  });
}

// ============================================================
// GET PARQUET PATH FROM FILE ID (with S3 recovery)
// ============================================================

const s3 = new S3Client({ region: process.env.AWS_REGION || "eu-north-1" });
const BUCKET = process.env.S3_BUCKET_NAME!;
const recoveryPromises = new Map<string, Promise<string>>();

async function getParquetKey(fileId: number): Promise<string> {
  const key = appDb.getParquetKey(fileId);
  if (!key) {
    throw new Error(`File ${fileId} not found or not processed`);
  }
  // Ensure file exists locally (auto-recover from S3 if container restarted)
  await ensureLocalParquet(key);
  return key;
}

export async function getLocalParquetPath(fileId: number): Promise<string> {
  const key = await getParquetKey(fileId);
  return localPath(key);
}

function localPath(key: string): string {
  return path.join(PARQUET_DIR, key).replace(/\\/g, "/");
}

/**
 * Ensure parquet file exists locally. If missing (e.g. container restart),
 * recover from S3 backup automatically.
 */
async function ensureLocalParquet(key: string): Promise<string> {
  if (process.env.PARQUET_SAFE_RECOVERY !== "0") {
    return ensureLocalParquetSafe(key);
  }

  const fp = localPath(key);
  if (fs.existsSync(fp)) return fp;

  console.log(`[RECOVERY] Local parquet missing: ${fp} — downloading from S3...`);
  const dir = path.dirname(fp);
  fs.mkdirSync(dir, { recursive: true });

  const response = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  if (!response.Body) throw new Error(`S3 recovery failed: no body for ${key}`);

  await pipeline(response.Body as Readable, fs.createWriteStream(fp));
  console.log(`[RECOVERY] Restored from S3: ${fp}`);
  return fp;
}

async function ensureLocalParquetSafe(key: string): Promise<string> {
  const fp = localPath(key);

  if (fs.existsSync(fp)) {
    const stats = fs.statSync(fp);
    if (stats.size > 0) return fp;
    try {
      fs.unlinkSync(fp);
    } catch {
      // ignore cleanup errors for corrupted/partial files
    }
  }

  const inFlight = recoveryPromises.get(key);
  if (inFlight) {
    await inFlight;
    return fp;
  }

  const recoveryPromise = (async (): Promise<string> => {
    const dir = path.dirname(fp);
    fs.mkdirSync(dir, { recursive: true });

    const tmpPath = `${fp}.download-${process.pid}-${Date.now()}.tmp`;
    try {
      const response = await s3.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: key })
      );
      if (!response.Body) throw new Error(`S3 recovery failed: no body for ${key}`);

      await pipeline(response.Body as Readable, fs.createWriteStream(tmpPath));
      fs.renameSync(tmpPath, fp);
      console.log(`[RECOVERY] Restored from S3 (safe): ${fp}`);
      return fp;
    } catch (err) {
      if (fs.existsSync(tmpPath)) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // ignore temp cleanup errors
        }
      }
      throw err;
    } finally {
      recoveryPromises.delete(key);
    }
  })();

  recoveryPromises.set(key, recoveryPromise);
  return recoveryPromise;
}

/* ============================================================
   FINGERPRINT SQL - The Universal Pattern Normalizer

   Turns: "Error reading module 3002 at 172.18.40.59 uuid=abc-123"
   Into:  "Error reading module <N> at <IP> uuid=<UUID>"
============================================================ */

const FINGERPRINT_SQL = `
  REGEXP_REPLACE(
    REGEXP_REPLACE(
      REGEXP_REPLACE(
        REGEXP_REPLACE(
          REGEXP_REPLACE(
            REGEXP_REPLACE(message,
              '\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}[.,]?\\d*', '<TIMESTAMP>', 'g'),
            '\\d+\\.\\d+\\.\\d+\\.\\d+(/\\d+)?', '<IP>', 'g'),
          '[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}', '<UUID>', 'g'),
        '#\\d+', '#<N>', 'g'),
      '=\\d+', '=<N>', 'g'),
    '\\b\\d{4,}\\b', '<N>', 'g'
  )
`;

/* ============================================================
   CRITICAL KEYWORDS - High-priority failures that ALWAYS need attention

   These are the "drop everything and investigate" patterns:
   - Database/service failures
   - Network connectivity issues
   - HTTP error codes
   - Authentication failures
============================================================ */
const CRITICAL_KEYWORDS = [
  "database.*(?:failed|timeout|unreachable|error)",
  "connection\\s+(?:refused|timeout|failed|lost)",
  "service\\s+(?:unreachable|unavailable|timeout)",
  "cannot\\s+connect",
  "authentication\\s+failed",
  "authorization\\s+failed",
  "error\\s+[45]\\d{2}", // HTTP 4xx, 5xx errors
  "exception.*(?:timeout|refused|unreachable)",
  "fatal.*(?:error|failure)",
  "timeout when communicating to element", // Element communication failures
].join("|");

/* ============================================================
   FAILURE KEYWORDS - Regular semantic patterns (less critical)

   These indicate potential issues but might be background noise:
   - Generic "failed", "timeout"
   - Retry attempts
   - Circuit breaker states
============================================================ */
const FAILURE_KEYWORDS = [
  "error reading",
  "failed",
  "failure",
  "timeout",
  "timed out",
  "refused",
  "unreachable",
  "denied",
  "rejected",
  "disconnected",
  "latency high",
  "degraded",
  "exhausted",
  "queue full",
  "circuit breaker",
  "retry limit",
  "unable to",
  // Note: "Timeout when communicating to element" moved to CRITICAL_KEYWORDS
].join("|");

/* ============================================================
   IGNORE PATTERNS - False Positive Filter

   Exclude logs that contain failure keywords but are actually harmless
   Examples:
   - "Check failed: false" (validation passed)
   - "0 failed uploads" (success message)
   - "Disconnected from optional cache" (expected behavior)

   HOW TO UPDATE:
   1. Run debugSemanticMatches(fileId) to find noisy patterns
   2. Add the exact phrases here
   3. Test that alerts decrease without missing real issues
============================================================ */
const IGNORE_PATTERNS = [
  "check failed: false",
  "0 failed",
  "validation failed: false",
  "\\b0\\s+errors?\\b", // "0 errors", "0 error"
  "\\b0\\s+timeouts?\\b", // "0 timeouts"
  "successfully.*failed", // "successfully handled failed request"
  "retries?.*succeeded", // "retry succeeded"
  "recovered from.*failure", // "recovered from failure"
  "optional.*disconnected", // "optional service disconnected"
  "expected.*timeout", // "expected timeout"
  // WebSocket / STOMP status dumps (NOT failures)
  "WebSocketSession\\[",
  "stompSubProtocol\\[processed",
  "stompBrokerRelay\\[",
  "sockJsScheduler\\[pool size",
  "inboundChannel\\[pool size",
  "outboundChannel\\[pool size",
  "Error reading Luminato.*Client error 404",
].join("|");

// ============================================================
// QUERY FUNCTIONS
// ============================================================
// lib/query/duckdb-client.ts

export async function detectAnomalies(fileId: number, params: any) {
  const key = await getParquetKey(fileId);

  const minSpikeRatio = params.min_spike_ratio || 3;
  const minOccurrences = params.min_occurrences || 5;

  // 2. Get the ACTUAL file limits first
  const meta = await runQuery(`
    SELECT MIN(timestamp) as min_ts, MAX(timestamp) as max_ts
    FROM read_parquet('${localPath(key)}')
  `);
  const fileMin = Number(meta[0].min_ts);
  const fileMax = Number(meta[0].max_ts);

  // 3. Parse AI's requested dates
  let pStart = params.problem_start
    ? new Date(params.problem_start).getTime()
    : 0;
  let pEnd = params.problem_end ? new Date(params.problem_end).getTime() : 0;

  // 4. THE SANITY CHECK
  const isInvalidDate = pStart < fileMin || pStart > fileMax;

  if (!pStart || !pEnd || isInvalidDate) {
    if (isInvalidDate && pStart > 0) {
      console.log(
        `⚠️ AI Hallucinated Date ${
          params.problem_start
        }. Valid range: ${new Date(fileMin).toISOString()} - ${new Date(
          fileMax
        ).toISOString()}. Overriding with file max.`
      );
    }
    // Default to LAST 5 MINUTES
    pEnd = fileMax;
    pStart = fileMax - 5 * 60 * 1000;

    // Baseline: The 5 minutes before that
    params.baseline_end = new Date(pStart).toISOString();
    params.baseline_start = new Date(pStart - 5 * 60 * 1000).toISOString();
  }

  // 5. Calculate Baseline Windows
  const bEnd = params.baseline_end
    ? new Date(params.baseline_end).getTime()
    : pStart - 60000;
  const bStart = params.baseline_start
    ? new Date(params.baseline_start).getTime()
    : bEnd - (pEnd - pStart);

  // 6. The SQL Query with Semantic Awareness
  const sql = `
    WITH fingerprinted AS (
      SELECT
        line_number,
        severity,
        component,
        message,
        ${FINGERPRINT_SQL} as fingerprint,
        -- 🔍 SEMANTIC SCORING: 3-tier importance system
        CASE
          WHEN severity IN ('ERROR', 'FATAL') THEN 100
          -- 🔴 TIER 1: Critical semantic issues (database failures, 404s, connection refused)
          WHEN regexp_matches(message, '(?i)(${CRITICAL_KEYWORDS})')
               AND NOT regexp_matches(message, '(?i)(${IGNORE_PATTERNS})')
          THEN 90
          -- 🟠 TIER 2: Regular semantic issues (generic failures, retries)
          WHEN regexp_matches(message, '(?i)(${FAILURE_KEYWORDS})')
               AND NOT regexp_matches(message, '(?i)(${IGNORE_PATTERNS})')
          THEN 80
          ELSE 0
        END as importance_score,
        CASE
           WHEN timestamp BETWEEN ${pStart} AND ${pEnd} THEN 'problem'
           WHEN timestamp BETWEEN ${bStart} AND ${bEnd} THEN 'baseline'
           ELSE 'outside'
        END as time_window
      FROM read_parquet('${localPath(key)}')
      WHERE timestamp BETWEEN ${bStart} AND ${pEnd}
    ),
    stats AS (
      SELECT
        fingerprint,
        severity,
        component,
        MAX(importance_score) as importance_score, -- Keep highest score found
        COUNT(*) FILTER (WHERE time_window = 'problem') as problem_count,
        COUNT(*) FILTER (WHERE time_window = 'baseline') as baseline_count,
        ANY_VALUE(message) FILTER (WHERE time_window = 'problem') as example
      FROM fingerprinted
      WHERE time_window IN ('problem', 'baseline')
      GROUP BY fingerprint, severity, component
    )
    SELECT
      *,
      problem_count - baseline_count as delta,
      CASE
        WHEN baseline_count = 0 THEN problem_count * 100.0
        ELSE ROUND(CAST(problem_count AS FLOAT) / baseline_count, 2)
      END as spike_ratio,
      -- 📝 Human-readable reason for this anomaly
      CASE
        WHEN importance_score = 100 THEN 'Critical Severity'
        WHEN importance_score = 80 AND baseline_count = 0 THEN 'New Failure Pattern (Hidden in INFO)'
        WHEN importance_score = 80 THEN 'Spike in Failure Keywords'
        WHEN baseline_count = 0 THEN 'New Log Pattern'
        ELSE 'Frequency Spike (' || CAST(spike_ratio AS VARCHAR) || 'x)'
      END as reason_for_attention
    FROM stats
    WHERE
      -- TIER 1: CRITICAL - Always show if present
      (importance_score = 100 AND problem_count > 0)
      OR
      -- TIER 2: SUSPICIOUS - Must be new OR have 2x spike
      (importance_score = 80 AND
        (baseline_count = 0 OR
         CAST(problem_count AS FLOAT) / baseline_count >= 2.0))
      OR
      -- TIER 3: STATISTICAL SPIKE - Standard anomaly detection
      (importance_score = 0 AND
        problem_count >= ${minOccurrences} AND
        (baseline_count = 0 OR
         CAST(problem_count AS FLOAT) / NULLIF(baseline_count, 0) >= ${minSpikeRatio}))
    ORDER BY
      importance_score DESC,
      delta DESC
    LIMIT 100
  `;

  return runQuery(sql);
}

/* ============================================================
   TOOL 2: get_pattern_examples (Drill Down)
   
   After finding an anomaly pattern, get real examples
============================================================ */

interface PatternExamplesParams {
  file_id: number;
  fingerprint: string; // The pattern to find examples of
  time_start?: string;
  time_end?: string;
  limit?: number;
  include_context?: boolean; // Include surrounding lines
}

// lib/query/duckdb-client.ts

export async function getPatternExamples(
  fileId: number,
  fingerprint: string,
  params: any
) {
  const key = await getParquetKey(fileId);
  const limit = params.limit || 5;

  // 1. Time Filtering
  const timeClause =
    params.timeStart && params.timeEnd
      ? `AND timestamp BETWEEN '${params.timeStart}' AND '${params.timeEnd}'`
      : "";

  // 2. Fuzzy Matching (The Fix for AI Summary)
  // We search both the raw message AND the calculated fingerprint
  const safeFingerprint = fingerprint.replace(/'/g, "''");

  const query = `
    SELECT 
      line_number,
      timestamp,
      severity,
      thread,
      component,
      message,
      CASE WHEN stack_trace IS NOT NULL 
        THEN substr(stack_trace, 1, 500) 
        ELSE NULL 
      END as stack_trace_preview
    FROM read_parquet('${localPath(key)}')
    WHERE 
      (
        message ILIKE '%${safeFingerprint}%' 
        OR 
        ${FINGERPRINT_SQL} ILIKE '%${safeFingerprint}%'
      )
      ${timeClause}
    ORDER BY timestamp DESC
    LIMIT ${limit}
  `;

  const examples = await runQuery(query);

  // 3. Context Logic (Fixed Variable Assignment)
  let context = null;
  if (params.includeContext && examples.length > 0) {
    // If we have examples, grab context around the FIRST one
    const targetLine = examples[0].line_number;

    // Note: Parquet files might not be perfectly ordered by line_number if processed in parallel,
    // but usually sufficient for context.
    const contextQuery = `
      SELECT line_number, timestamp, severity, thread, component, message
      FROM read_parquet('${localPath(key)}')
      WHERE line_number BETWEEN ${targetLine - 5} AND ${targetLine + 5}
      ORDER BY line_number ASC
    `;

    // 🔴 BUG FIX: You were re-running 'query' here. Changed to 'contextQuery'.
    context = await runQuery(contextQuery);
  }

  return {
    pattern: fingerprint,
    example_count: examples.length,
    examples: examples,
    context: context,
    note: "These are actual log lines matching the anomaly pattern",
  };
}

/* ============================================================
   TOOL 3: get_correlated_events (The Chain Builder)
   
   Find events that happened on the same thread/trace
   around the time of an anomaly
============================================================ */

interface CorrelatedEventsParams {
  file_id: number;
  anchor_line: number; // The line number to investigate
  correlation_type: "thread" | "trace_id" | "time_window" | "component";
  window_seconds?: number; // For time_window correlation
}

export async function getCorrelatedEvents(params: CorrelatedEventsParams) {
  const key = await getParquetKey(params.file_id);
  const windowSeconds = params.window_seconds || 5;

  // First, get the anchor line details
  const anchorQuery = `
    SELECT
      line_number, timestamp, severity, thread, component, message,
      regexp_extract(message, '[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}') as trace_id
    FROM read_parquet('${localPath(key)}')
    WHERE line_number = ${params.anchor_line}
  `;
  const anchor = (await runQuery(anchorQuery))[0];

  if (!anchor) {
    return { error: "Anchor line not found" };
  }

  let correlationClause: string;
  let correlationDescription: string;

  switch (params.correlation_type) {
    case "thread":
      correlationClause = `thread = '${anchor.thread}'`;
      correlationDescription = `Same thread: ${anchor.thread}`;
      break;
    case "trace_id":
      if (!anchor.trace_id) {
        return { error: "No trace ID found in anchor line", anchor };
      }
      correlationClause = `message LIKE '%${anchor.trace_id}%'`;
      correlationDescription = `Same trace ID: ${anchor.trace_id}`;
      break;
    case "component":
      correlationClause = `component = '${anchor.component}'`;
      correlationDescription = `Same component: ${anchor.component}`;
      break;
    case "time_window":
    default:
      correlationClause = `
        timestamp >= '${anchor.timestamp}'::TIMESTAMP - INTERVAL '${windowSeconds} seconds'
        AND timestamp <= '${anchor.timestamp}'::TIMESTAMP + INTERVAL '${windowSeconds} seconds'
      `;
      correlationDescription = `Within ${windowSeconds}s of incident`;
  }

  const query = `
    SELECT
      line_number,
      timestamp,
      severity,
      thread,
      component,
      message,
      CASE WHEN line_number = ${
        params.anchor_line
      } THEN '>>> ANCHOR <<<' ELSE '' END as marker
    FROM read_parquet('${localPath(key)}')
    WHERE ${correlationClause}
      AND line_number BETWEEN ${params.anchor_line - 100} AND ${
    params.anchor_line + 100
  }
    ORDER BY line_number
    LIMIT 50
  `;

  const events = await runQuery(query);

  return {
    anchor: anchor,
    correlation: correlationDescription,
    event_count: events.length,
    events: events,
    suggestion:
      events.length > 20
        ? "Many correlated events - try filtering by severity or narrowing time window"
        : null,
  };
}

/* ============================================================
   TOOL 4: get_file_overview (Enhanced Stats)
   
   Quick file statistics with noise classification
============================================================ */

export async function getFileOverviewEnhanced(fileId: number) {
  const key = await getParquetKey(fileId);
  const fullPath = localPath(key); // Helper to ensure consistent path usage

  const query = `
    WITH categorized AS (
      SELECT 
        timestamp,  -- ✅ FIX 1: Added timestamp here so the outer query can see it
        severity,
        component,
        CASE 
          WHEN component = 'TsempUdpSocket' AND message LIKE '%message%' THEN 'POLLING_NOISE'
          WHEN component = 'ThreadPoolExecutorStatisticsLogger' THEN 'METRICS_NOISE'
          WHEN message LIKE '%priority queue sizes%' THEN 'METRICS_NOISE'
          WHEN component = 'TsempElementMessenger' AND message LIKE '%Response%' THEN 'POLLING_NOISE'
          WHEN severity IN ('ERROR', 'WARN') THEN 'SIGNAL'
          WHEN message LIKE '%Event %' THEN 'SIGNAL'
          ELSE 'OTHER'
        END as category
       FROM read_parquet('${fullPath}') 
    )
    SELECT 
      COUNT(*) as total_lines,
      COUNT(*) FILTER (WHERE severity = 'ERROR') as error_count,
      COUNT(*) FILTER (WHERE severity = 'WARN') as warn_count,
      COUNT(*) FILTER (WHERE severity = 'INFO') as info_count,
      COUNT(*) FILTER (WHERE severity = 'DEBUG') as debug_count,
      COUNT(*) FILTER (WHERE severity = 'TRACE') as trace_count,
      COUNT(*) FILTER (WHERE category = 'POLLING_NOISE') as polling_noise_count,
      COUNT(*) FILTER (WHERE category = 'METRICS_NOISE') as metrics_noise_count,
      COUNT(*) FILTER (WHERE category = 'SIGNAL') as signal_count,
      ROUND(COUNT(*) FILTER (WHERE category IN ('POLLING_NOISE', 'METRICS_NOISE')) * 100.0 / COUNT(*), 2) as noise_percentage,
      MIN(timestamp) as time_start,
      MAX(timestamp) as time_end
    FROM categorized
  `;

  const stats = (await runQuery(query))[0];

  // Get top components
  const componentsQuery = `
    SELECT component, COUNT(*) as count
    FROM read_parquet('${fullPath}')
    GROUP BY component
    ORDER BY count DESC
    LIMIT 10
  `;
  const topComponents = await runQuery(componentsQuery);

  return {
    ...stats,
    top_components: topComponents,
    interpretation: {
      noise_level:
        stats.noise_percentage > 90
          ? "HIGH (>90% is routine telemetry - this is normal for logs)"
          : stats.noise_percentage > 70
          ? "MODERATE"
          : "LOW (unusual for EMS logs - investigate)",
      error_rate: `${((stats.error_count / stats.total_lines) * 100).toFixed(
        4
      )}%`,
      signal_to_noise: `${stats.signal_count} meaningful events in ${stats.total_lines} total lines`,
    },
  };
}

/**
 * Get all logs from a file with optional filters
 */
export async function getLogs(
  fileId: number,
  options?: {
    severity?: string[];
    deviceId?: string;
    component?: string;
    thread?: string;
    searchText?: string;
    limit?: number;
    order?: "asc" | "desc";
  }
): Promise<any[]> {
  const key = await getParquetKey(fileId);
  const conditions: string[] = [];

  if (options?.severity?.length) {
    conditions.push(`severity IN ('${options.severity.join("','")}')`);
  }
  if (options?.deviceId) {
    conditions.push(`device_id = '${options.deviceId}'`);
  }
  if (options?.component) {
    conditions.push(`component = '${options.component}'`);
  }
  if (options?.thread) {
    conditions.push(`thread = '${options.thread}'`);
  }
  if (options?.searchText) {
    conditions.push(`message ILIKE '%${options.searchText}%'`);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const orderDir = options?.order === "asc" ? "ASC" : "DESC";
  const limit = options?.limit || 100;

  const sql = `
    SELECT 
      line_number,
      timestamp,
      thread,
      severity,
      component,
      message,
      device_id,
      has_stack_trace,
      exception_class
    FROM read_parquet('${localPath(key)}')
    ${whereClause}
    ORDER BY line_number ${orderDir}
    LIMIT ${limit}
  `;

  return runQuery(sql);
}

/**
 * Get thread context - logs before/after a specific line on same thread
 */
export async function getThreadContext(
  fileId: number,
  thread: string,
  lineNumber: number,
  contextLines: number = 10
): Promise<any[]> {
  const key = await getParquetKey(fileId);

  const sql = `
    SELECT
      line_number,
      timestamp,
      thread,
      severity,
      component,
      message,
      message AS raw_line,
      has_stack_trace,
      stack_trace,
      exception_class,
      CASE WHEN line_number = ${lineNumber} THEN true ELSE false END AS is_anchor
    FROM read_parquet('${localPath(key)}')
    WHERE thread = '${thread}'
      AND line_number BETWEEN ${lineNumber - contextLines} AND ${
    lineNumber + contextLines
  }
    ORDER BY line_number ASC
  `;

  return runQuery(sql);
}

/**
 * Get errors with stack traces
 */
export async function getErrorsWithStackTraces(
  fileId: number,
  options?: {
    exceptionClass?: string;
    component?: string;
    deviceId?: string;
    limit?: number;
  }
): Promise<any[]> {
  const key = await getParquetKey(fileId);
  const conditions: string[] = ["has_stack_trace = true"];

  if (options?.exceptionClass) {
    conditions.push(`exception_class = '${options.exceptionClass}'`);
  }
  if (options?.component) {
    conditions.push(`component = '${options.component}'`);
  }
  if (options?.deviceId) {
    conditions.push(`device_id = '${options.deviceId}'`);
  }

  const sql = `
    SELECT 
      line_number,
      timestamp,
      thread,
      severity,
      component,
      message,
      device_id,
      exception_class,
      stack_trace
    FROM read_parquet('${localPath(key)}')
    WHERE ${conditions.join(" AND ")}
    ORDER BY timestamp DESC
    LIMIT ${options?.limit || 20}
  `;

  return runQuery(sql);
}

/**
 * Get log by line number with context
 */
export async function getLogByLineNumber(
  fileId: number,
  lineNumber: number,
  contextLines: number = 5
): Promise<any[]> {
  const key = await getParquetKey(fileId);

  const sql = `
    SELECT
      line_number,
      timestamp,
      thread,
      severity,
      component,
      message,
      message AS raw_line,
      device_id,
      has_stack_trace,
      stack_trace,
      CASE WHEN line_number = ${lineNumber} THEN true ELSE false END AS is_anchor
    FROM read_parquet('${localPath(key)}')
    WHERE line_number BETWEEN ${lineNumber - contextLines} AND ${
    lineNumber + contextLines
  }
    ORDER BY line_number ASC
  `;

  return runQuery(sql);
}

/**
 * Get time-based context - logs before/after a specific timestamp
 * BALANCED APPROACH: Fetches equal number of logs before and after the anchor
 */
export async function getTimeBasedContext(
  fileId: number,
  anchorTimestamp: number,
  timeWindowSeconds: number = 30,
  thread?: string,
  anchorLineNumber?: number
): Promise<any[]> {
  const key = await getParquetKey(fileId);
  const threadClause = thread ? `AND thread = '${thread}'` : "";
  const limit = Math.floor(timeWindowSeconds); // Use as count limit instead of time

  // Strategy: Fetch N logs before + anchor + N logs after
  // This ensures balanced results even when there are many logs at same timestamp

  const sql = `
    WITH anchor_log AS (
      -- Get the anchor log itself
      SELECT
        line_number,
        timestamp,
        thread,
        severity,
        component,
        message,
        message AS raw_line,
        device_id,
        has_stack_trace,
        stack_trace,
        true AS is_anchor,
        0 AS sort_order
      FROM read_parquet('${localPath(key)}')
      WHERE line_number = ${anchorLineNumber || -1}
    ),
    logs_before AS (
      -- Get N logs BEFORE the anchor (by timestamp, then line_number)
      SELECT
        line_number,
        timestamp,
        thread,
        severity,
        component,
        message,
        message AS raw_line,
        device_id,
        has_stack_trace,
        stack_trace,
        false AS is_anchor,
        -1 AS sort_order
      FROM read_parquet('${localPath(key)}')
      WHERE (timestamp < ${anchorTimestamp}
             OR (timestamp = ${anchorTimestamp} AND line_number < ${anchorLineNumber || -1}))
        ${threadClause}
      ORDER BY timestamp DESC, line_number DESC
      LIMIT ${limit}
    ),
    logs_after AS (
      -- Get N logs AFTER the anchor (by timestamp, then line_number)
      SELECT
        line_number,
        timestamp,
        thread,
        severity,
        component,
        message,
        message AS raw_line,
        device_id,
        has_stack_trace,
        stack_trace,
        false AS is_anchor,
        1 AS sort_order
      FROM read_parquet('${localPath(key)}')
      WHERE (timestamp > ${anchorTimestamp}
             OR (timestamp = ${anchorTimestamp} AND line_number > ${anchorLineNumber || -1}))
        ${threadClause}
      ORDER BY timestamp ASC, line_number ASC
      LIMIT ${limit}
    )
    -- Combine: before + anchor + after
    SELECT * FROM logs_before
    UNION ALL
    SELECT * FROM anchor_log
    UNION ALL
    SELECT * FROM logs_after
    ORDER BY timestamp ASC, line_number ASC
  `;

  return runQuery(sql);
}

/**
 * Get severity counts (for stats)
 */
export async function getSeverityCounts(fileId: number): Promise<any[]> {
  const key = await getParquetKey(fileId);

  const sql = `
    SELECT severity, COUNT(*) as count
    FROM read_parquet('${localPath(key)}')
    GROUP BY severity
    ORDER BY count DESC
  `;

  return runQuery(sql);
}

/**
 * Get device summary
 */
export async function getDeviceSummary(
  fileId: number,
  deviceId: string
): Promise<any> {
  const key = await getParquetKey(fileId);

  const sql = `
    SELECT 
      device_id,
      COUNT(*) as total_events,
      SUM(CASE WHEN severity = 'ERROR' THEN 1 ELSE 0 END) as error_count,
      SUM(CASE WHEN severity = 'WARN' THEN 1 ELSE 0 END) as warn_count,
      MIN(timestamp) as first_seen,
      MAX(timestamp) as last_seen,
      COUNT(DISTINCT thread) as thread_count
    FROM read_parquet('${localPath(key)}')
    WHERE device_id = '${deviceId}'
    GROUP BY device_id
  `;

  const rows = await runQuery(sql);
  return rows[0] || null;
}

/**
 * Get exception summary — returns both formal (stack-trace column) and
 * text-extracted exceptions from message/stack_trace content
 */
export async function getExceptionSummary(fileId: number) {
  const key = await getParquetKey(fileId);
  const fp = localPath(key);

  // 1. Formal: from exception_class column (existing logic)
  const formal = await runQuery(`
    SELECT exception_class, COUNT(*) as count,
      MIN(timestamp) as first_seen, MAX(timestamp) as last_seen,
      COUNT(DISTINCT thread) as affected_threads,
      COUNT(DISTINCT device_id) as affected_devices
    FROM read_parquet('${fp}')
    WHERE has_stack_trace = true AND exception_class IS NOT NULL
    GROUP BY exception_class
    ORDER BY count DESC
  `);

  // 2. Text-extracted: scan message + stack_trace for exception patterns
  const fromText = await runQuery(`
    WITH extracted AS (
      SELECT unnest(regexp_extract_all(
        COALESCE(message,'') || ' ' || COALESCE(stack_trace,''),
        '[A-Za-z][A-Za-z0-9_.]*(?:Exception|Error)'
      )) as exc_name
      FROM read_parquet('${fp}')
    )
    SELECT exc_name, COUNT(*) as count
    FROM extracted
    WHERE length(exc_name) > 5
    GROUP BY exc_name
    ORDER BY count DESC
    LIMIT 30
  `);

  return { formal, fromText };
}

/**
 * Get failing devices — top IPs/devices ranked by exception count
 */
export async function getFailingDevices(fileId: number) {
  const key = await getParquetKey(fileId);
  return runQuery(`
    SELECT
      ip_address,
      COUNT(*) as total_events,
      COUNT(*) FILTER (WHERE has_stack_trace = true) as exception_events,
      COUNT(*) FILTER (WHERE severity = 'WARN') as warn_count,
      COUNT(DISTINCT exception_class) as distinct_exceptions,
      array_agg(DISTINCT exception_class)
        FILTER (WHERE exception_class IS NOT NULL) as exception_types,
      COUNT(DISTINCT thread) as affected_threads
    FROM read_parquet('${localPath(key)}')
    WHERE ip_address IS NOT NULL
    GROUP BY ip_address
    ORDER BY exception_events DESC
    LIMIT 50
  `);
}

/**
 * Get time series (hourly aggregates)
 */
export async function getTimeSeries(
  fileId: number,
  options?: {
    interval?: "minute" | "hour" | "day";
    severity?: string[];
  }
): Promise<any[]> {
  const key = await getParquetKey(fileId);
  const interval = options?.interval || "hour";

  const truncExpr =
    interval === "minute"
      ? "DATE_TRUNC('minute', to_timestamp(timestamp/1000))"
      : interval === "day"
      ? "DATE_TRUNC('day', to_timestamp(timestamp/1000))"
      : "DATE_TRUNC('hour', to_timestamp(timestamp/1000))";

  const severityFilter = options?.severity?.length
    ? `WHERE severity IN ('${options.severity.join("','")}')`
    : "";

  const sql = `
    SELECT 
      ${truncExpr} as time_bucket,
      severity,
      COUNT(*) as count
    FROM read_parquet('${localPath(key)}')
    ${severityFilter}
    GROUP BY time_bucket, severity
    ORDER BY time_bucket ASC
  `;

  return runQuery(sql);
}

/**
 * Search across multiple files
 */
export async function searchAcrossFiles(
  fileIds: number[],
  searchText: string,
  options?: {
    severity?: string[];
    limit?: number;
  }
): Promise<any[]> {
  // Resolve and recover local parquet files first (important on ECS task restarts)
  const parquetFiles = (
    await Promise.all(
      fileIds.map(async (id) => {
        try {
          const filePath = await getLocalParquetPath(id);
          return `'${filePath}'`;
        } catch {
          return null;
        }
      })
    )
  ).filter(Boolean) as string[];

  if (parquetFiles.length === 0) return [];

  const files = parquetFiles.join(", ");

  const conditions = [`message ILIKE '%${searchText}%'`];
  if (options?.severity?.length) {
    conditions.push(`severity IN ('${options.severity.join("','")}')`);
  }

  const sql = `
    SELECT
      line_number,
      timestamp,
      thread,
      severity,
      component,
      message,
      device_id
    FROM read_parquet([${files}])
    WHERE ${conditions.join(" AND ")}
    ORDER BY timestamp DESC
    LIMIT ${options?.limit || 100}
  `;

  return runQuery(sql);
}

// ============================================================
// TIMELINE & PATTERN ANALYSIS FUNCTIONS
// ============================================================

/**
 * Get timeline histogram - Powers the top bar chart
 * Uses time_bucket to aggregate data into 15-minute chunks efficiently
 */
export async function getTimelineHistogram(fileId: number) {
  const key = await getParquetKey(fileId);

  // 🔍 SEMANTIC-AWARE HISTOGRAM: Detects "hidden failures" in INFO logs
  const sql = `
    SELECT
      CAST(DATE_TRUNC('minute', to_timestamp(timestamp/1000)) AS TEXT) as time_minute,
      COUNT(*) FILTER (WHERE severity = 'ERROR') as error_count,
      COUNT(*) FILTER (WHERE severity = 'WARN') as warn_count,
      COUNT(*) FILTER (WHERE severity IN ('INFO', 'DEBUG')) as info_count,
      COUNT(*) FILTER (WHERE severity = 'TRACE') as trace_count,

      -- 🔴 CRITICAL semantic issues (database failures, 404s, connection refused)
      COUNT(*) FILTER (WHERE
        regexp_matches(message, '(?i)(${CRITICAL_KEYWORDS})')
        AND NOT regexp_matches(message, '(?i)(${IGNORE_PATTERNS})')
      ) as critical_semantic_count,

      -- 🟠 REGULAR semantic issues (generic failures - might be noise)
      COUNT(*) FILTER (WHERE
        regexp_matches(message, '(?i)(${FAILURE_KEYWORDS})')
        AND NOT regexp_matches(message, '(?i)(${IGNORE_PATTERNS})')
        AND NOT regexp_matches(message, '(?i)(${CRITICAL_KEYWORDS})')
      ) as semantic_error_count
    FROM read_parquet('${localPath(key)}')
    WHERE timestamp IS NOT NULL
    GROUP BY time_minute
    ORDER BY time_minute ASC
  `;

  const result = await runQuery(sql);
  console.log(`📊 Timeline query returned ${result.length} time buckets`);

  // Group by 15-minute intervals in JavaScript
  const grouped = new Map<string, any>();

  for (const row of result) {
    if (!row.time_minute) continue;

    // Now this works because row.time_minute is a string
    const date = new Date(row.time_minute);

    if (isNaN(date.getTime())) {
      console.warn(`⚠️ Invalid time_minute skipped: ${row.time_minute}`);
      continue;
    }

    // Round down to 15-minute intervals
    const minutes = date.getMinutes();
    const roundedMinutes = Math.floor(minutes / 15) * 15;
    date.setMinutes(roundedMinutes, 0, 0);

    const key = date.toISOString();

    if (!grouped.has(key)) {
      grouped.set(key, {
        time: key,
        errors: 0,
        warnings: 0,
        info: 0,
        trace: 0,
        criticalSemanticErrors: 0, // 🔴 Critical issues (database failures, 404s)
        semanticErrors: 0, // 🟠 Regular semantic issues
        total: 0,
      });
    }

    const bucket = grouped.get(key)!;
    bucket.errors += Number(row.error_count || 0);
    bucket.warnings += Number(row.warn_count || 0);
    bucket.info += Number(row.info_count || 0);
    bucket.trace += Number(row.trace_count || 0);
    bucket.criticalSemanticErrors += Number(row.critical_semantic_count || 0);
    bucket.semanticErrors += Number(row.semantic_error_count || 0);
    bucket.total = bucket.errors + bucket.warnings + bucket.info + bucket.trace;
  }

  const finalResult = Array.from(grouped.values()).sort((a, b) =>
    a.time.localeCompare(b.time)
  );

  console.log(`📊 Returning ${finalResult.length} 15-minute buckets`);
  return finalResult;
}

/**
 * Get anomaly grid - Powers the Main Table when a user clicks a time bar
 * Uses the exact FINGERPRINT_SQL constant so the pattern signatures match detectAnomalies logic
 */
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
  const key = await getParquetKey(fileId);

  // Convert JS Dates to DuckDB Timestamp format
  const startTs = new Date(startTime).getTime();
  const endTs = new Date(endTime).getTime();

  // Build severity filter clause
  const severityClause = options?.severityFilter?.length
    ? `AND severity IN ('${options.severityFilter.join("','")}')`
    : "";

  // Pagination - Increased limit to ensure critical patterns aren't cut off
  const limit = options?.limit || 200;
  const offset = options?.offset || 0;

  const sql = `
    WITH clustered_logs AS (
      SELECT
        severity,
        component,
        message,
        -- Reuse the exact same Regex logic
        ${FINGERPRINT_SQL} as pattern_signature,
        -- 🔍 Calculate importance for sorting (3-tier system)
        CASE
          WHEN severity IN ('ERROR', 'FATAL') THEN 100
          -- 🔴 TIER 1: Critical semantic (database failures, 404s, connection refused)
          WHEN regexp_matches(message, '(?i)(${CRITICAL_KEYWORDS})')
               AND NOT regexp_matches(message, '(?i)(${IGNORE_PATTERNS})')
          THEN 90
          -- 🟠 TIER 2: Regular semantic (generic failures)
          WHEN regexp_matches(message, '(?i)(${FAILURE_KEYWORDS})')
               AND NOT regexp_matches(message, '(?i)(${IGNORE_PATTERNS})')
          THEN 80
          ELSE 0
        END as importance_score
      FROM read_parquet('${localPath(key)}')
      WHERE timestamp >= ${startTs}
        AND timestamp < ${endTs}
        ${severityClause}
    )
    SELECT
      pattern_signature,
      ANY_VALUE(severity) as severity,
      ANY_VALUE(component) as component,
      MAX(importance_score) as importance_score,
      COUNT(*) as count
    FROM clustered_logs
    GROUP BY pattern_signature
    -- ✅ CRITICAL FIX: Show failures first, then by frequency
    ORDER BY
      importance_score DESC,  -- Errors/Failures first
      count DESC              -- Then by frequency
    LIMIT ${limit}
    OFFSET ${offset}
  `;

  return await runQuery(sql);
}

/**
 * Get pattern samples - Fetches raw logs for the AI Drawer
 * Re-runs the regex in the WHERE clause to find raw lines that match the clicked pattern
 */
export async function getPatternSamples(
  fileId: number,
  patternSignature: string,
  startTime: string,
  endTime: string
) {
  const key = await getParquetKey(fileId);
  const startTs = new Date(startTime).getTime();
  const endTs = new Date(endTime).getTime();

  // Escape single quotes in the pattern to prevent SQL injection/errors
  const safePattern = patternSignature.replace(/'/g, "''");

  const sql = `
    SELECT
      line_number,
      timestamp,
      severity,
      component,
      thread,
      message
    FROM read_parquet('${localPath(key)}')
    WHERE timestamp >= ${startTs}
      AND timestamp < ${endTs}
      -- Re-calculate fingerprint on the fly to match
      AND (${FINGERPRINT_SQL}) = '${safePattern}'
    ORDER BY timestamp ASC
    LIMIT 10
  `;

  const rows = await runQuery(sql);

  // Return clean JSON for the AI with all necessary fields
  return rows.map((row: any) => ({
    line_number: row.line_number,
    timestamp: new Date(row.timestamp).toISOString(),
    severity: row.severity,
    component: row.component,
    thread: row.thread,
    message: row.message,
  }));
}

/**
 * 🔍 DEBUG TOOL: Find which logs are triggering semantic alerts
 * Use this to identify false positives and add them to IGNORE_PATTERNS
 */
export async function debugSemanticMatches(fileId: number) {
  const key = await getParquetKey(fileId);

  const sql = `
    SELECT
      message,
      severity,
      COUNT(*) as count
    FROM read_parquet('${localPath(key)}')
    WHERE regexp_matches(message, '(?i)(${FAILURE_KEYWORDS})')
    GROUP BY message, severity
    ORDER BY count DESC
    LIMIT 20
  `;

  const results = await runQuery(sql);
  console.log("⚠️ TOP 20 SEMANTIC MATCHES (Check for false positives):");
  results.forEach((r: any) => {
    console.log(`  [${r.severity}] ${r.message} (${r.count}x)`);
  });
  return results;
}
