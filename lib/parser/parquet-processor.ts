// lib/parser/parquet-processor.ts
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import * as parquet from "parquetjs-lite";
import { createReadStream, statSync, unlinkSync } from "fs";
import { createInterface } from "readline";
import { pool } from "@/lib/db/batch-client";
import * as os from "os";
import * as path from "path";
import { deleteFromS3 } from "@/lib/storage/s3";
// S3 Client
const s3 = new S3Client({
  region: process.env.AWS_REGION || "eu-north-1",
  // credentials: {
  //   accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
  //   secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  // },
});

const BUCKET = process.env.S3_BUCKET_NAME!;

// ============================================================
// TYPES
// ============================================================

interface ParsedLogEntry {
  line_number: number;
  timestamp: number | null;
  thread: string;
  thread_group: string;
  severity: string;
  component: string;
  message: string;
  device_id: string | null;
  ip_address: string | null;
  has_stack_trace: boolean;
  stack_trace: string | null;
  exception_class: string | null;
}

interface ProcessingStats {
  totalLines: number;
  parsedLines: number;
  skippedLines: number;
  errorCount: number;
  warnCount: number;
  infoCount: number;
  devices: Set<string>;
  threads: Set<string>;
  components: Set<string>;
  exceptionTypes: Set<string>;
  timeRangeStart: Date | null;
  timeRangeEnd: Date | null;
}

interface ProcessResult {
  fileId: number;
  parquetKey: string;
  stats: ProcessingStats;
}

// ============================================================
// MAIN FUNCTION
// ============================================================

export async function processLogFileToParquet(
  sessionId: string,
  filePath: string,
  filename: string,
  fileHash: string,
  onProgress?: (percent: number, stage: string) => void
): Promise<ProcessResult> {
  const fileSize = statSync(filePath).size;
  const fileSizeMB = fileSize / (1024 * 1024);

  console.log(`📁 Processing: ${filename} (${fileSizeMB.toFixed(2)} MB)`);

  onProgress?.(5, "Creating file record...");
  const fileRecord = await pool.query(
    `INSERT INTO session_files (session_id, filename, file_hash, size_mb, upload_status)
     VALUES ($1, $2, $3, $4, 'processing')
     RETURNING file_id`,
    [sessionId, filename, fileHash, fileSizeMB]
  );
  const fileId = fileRecord.rows[0].file_id;
  console.log(`   File ID: ${fileId}`);

  let uploadedS3Key: string | null = null;
  const parquetPath = path.join(os.tmpdir(), `${fileId}.parquet`);

  try {
    // Parse and write Parquet
    onProgress?.(10, "Parsing and converting to Parquet...");
    const stats = await parseAndWriteParquet(
      filePath,
      parquetPath,
      (percent) => {
        onProgress?.(10 + percent * 0.7, "Parsing logs...");
      }
    );

    // Upload to S3
    onProgress?.(80, "Uploading to S3...");
    const parquetKey = `logs/${sessionId}/${fileId}.parquet`;
    await uploadToS3(parquetPath, parquetKey);
    uploadedS3Key = parquetKey; // Track uploaded key
    console.log(`   Uploaded to: s3://${BUCKET}/${parquetKey}`);

    // Update database
    onProgress?.(90, "Saving metadata...");
    await pool.query(
      `UPDATE session_files SET
        parquet_key = $1,
        total_lines = $2,
        parsed_lines = $3,
        error_count = $4,
        warn_count = $5,
        info_count = $6,
        time_range_start = $7,
        time_range_end = $8,
        devices = $9,
        threads = $10,
        components = $11,
        exception_types = $12,
        upload_status = 'ready',
        processed_at = NOW()
       WHERE file_id = $13`,
      [
        parquetKey,
        stats.totalLines,
        stats.parsedLines,
        stats.errorCount,
        stats.warnCount,
        stats.infoCount,
        stats.timeRangeStart,
        stats.timeRangeEnd,
        Array.from(stats.devices),
        Array.from(stats.threads),
        Array.from(stats.components),
        Array.from(stats.exceptionTypes),
        fileId,
      ]
    );

    onProgress?.(100, "Complete");
    console.log(`✅ Processing complete!`);

    return { fileId, parquetKey, stats };
  } catch (error) {
    //  ROLLBACK: Delete S3 file if uploaded
    if (uploadedS3Key) {
      try {
        await deleteFromS3(uploadedS3Key);
        console.log(`Cleaned up S3 file: ${uploadedS3Key}`);
      } catch (cleanupError) {
        console.warn(
          "Failed to cleanup S3 parquet:",
          uploadedS3Key,
          cleanupError
        );
      }
    }

    // Mark as error in DB
    await pool.query(
      `UPDATE session_files SET upload_status = 'error' WHERE file_id = $1`,
      [fileId]
    );

    throw error;
  } finally {
    //  ALWAYS cleanup temp parquet file
    try {
      unlinkSync(parquetPath);
      console.log(`Cleaned up temp file: ${parquetPath}`);
    } catch (cleanupError) {
      console.warn("Failed to cleanup temp file:", parquetPath);
    }
  }
}

// ============================================================
// PARSE AND WRITE PARQUET
// ============================================================

async function parseAndWriteParquet(
  inputPath: string,
  outputPath: string,
  onProgress?: (percent: number) => void
): Promise<ProcessingStats> {
  const stats: ProcessingStats = {
    totalLines: 0,
    parsedLines: 0,
    skippedLines: 0,
    errorCount: 0,
    warnCount: 0,
    infoCount: 0,
    devices: new Set(),
    threads: new Set(),
    components: new Set(),
    exceptionTypes: new Set(),
    timeRangeStart: null,
    timeRangeEnd: null,
  };

  // Get file size for progress
  const { size: totalBytes } = statSync(inputPath);
  let bytesProcessed = 0;

  // Parquet schema
  const schema = new parquet.ParquetSchema({
    line_number: { type: "INT64" },
    timestamp: { type: "INT64", optional: true },
    thread: { type: "UTF8" },
    thread_group: { type: "UTF8" }, // this is new column
    severity: { type: "UTF8" },
    component: { type: "UTF8" },
    message: { type: "UTF8" },
    device_id: { type: "UTF8", optional: true },
    ip_address: { type: "UTF8", optional: true },
    has_stack_trace: { type: "BOOLEAN" },
    stack_trace: { type: "UTF8", optional: true },
    exception_class: { type: "UTF8", optional: true },
  });

  const writer = await parquet.ParquetWriter.openFile(schema, outputPath, {
    compression: "SNAPPY",
  });

  // Read and parse
  const fileStream = createReadStream(inputPath, { encoding: "utf-8" });
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  let currentEntry: ParsedLogEntry | null = null;
  let stackTraceLines: string[] = [];
  let lineNumber = 0;

  for await (const line of rl) {
    lineNumber++;
    bytesProcessed += Buffer.byteLength(line, "utf-8") + 1;
    stats.totalLines++;

    const parsed = parseLogLine(line, lineNumber);

    if (parsed) {
      // Save previous entry
      if (currentEntry) {
        if (stackTraceLines.length > 0) {
          currentEntry.has_stack_trace = true;
          currentEntry.stack_trace = stackTraceLines.join("\n");
          currentEntry.exception_class = extractExceptionClass(
            stackTraceLines[0]
          );
          if (currentEntry.exception_class) {
            stats.exceptionTypes.add(currentEntry.exception_class);
          }
        }
        await writer.appendRow(currentEntry);
        stats.parsedLines++;
      }

      currentEntry = parsed;
      stackTraceLines = [];

      // Update stats
      stats.threads.add(parsed.thread);
      stats.components.add(parsed.component);
      if (parsed.device_id) stats.devices.add(parsed.device_id);

      if (parsed.severity === "ERROR") stats.errorCount++;
      else if (parsed.severity === "WARN") stats.warnCount++;
      else if (parsed.severity === "INFO") stats.infoCount++;

      if (parsed.timestamp) {
        const ts = new Date(parsed.timestamp);
        if (!stats.timeRangeStart || ts < stats.timeRangeStart)
          stats.timeRangeStart = ts;
        if (!stats.timeRangeEnd || ts > stats.timeRangeEnd)
          stats.timeRangeEnd = ts;
      }
    } else if (currentEntry && isStackTraceLine(line)) {
      stackTraceLines.push(line);
    } else if (line.trim()) {
      stats.skippedLines++;
    }

    // Progress every 50K lines
    if (lineNumber % 50000 === 0) {
      onProgress?.((bytesProcessed / totalBytes) * 100);
    }
  }

  // Don't forget last entry
  if (currentEntry) {
    if (stackTraceLines.length > 0) {
      currentEntry.has_stack_trace = true;
      currentEntry.stack_trace = stackTraceLines.join("\n");
      currentEntry.exception_class = extractExceptionClass(stackTraceLines[0]);
      if (currentEntry.exception_class) {
        stats.exceptionTypes.add(currentEntry.exception_class);
      }
    }
    await writer.appendRow(currentEntry);
    stats.parsedLines++;
  }

  await writer.close();
  return stats;
}

// ============================================================
// LINE PARSER
// ============================================================

function parseLogLine(line: string, lineNumber: number): ParsedLogEntry | null {
  if (!line.trim()) return null;

  // 1. Parse Timestamp
  const timestampMatch = line.match(
    /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2},\d{3})/
  );
  if (!timestampMatch) return null;

  const raw = timestampMatch[1];
  // Don't add "Z" - treat timestamps as-is (local time from log file)
  const isoCandidate = raw.replace(",", ".").replace(" ", "T");
  const timestamp = Date.parse(isoCandidate); // Faster than new Date()
  if (isNaN(timestamp)) return null;

  // 2. Parse Thread & Thread Group
  const threadMatch = line.match(/\[([^\]]+)\]/);
  if (!threadMatch) return null;

  const fullThread = threadMatch[1];
  // Remove trailing numbers to get the group: "SchedulerService-118" -> "SchedulerService"
  const threadGroup = fullThread.replace(/[-\s]?\d+$/, "");

  // 3. Parse Metadata (Severity & Component)
  const afterThread = line.substring(line.indexOf("]") + 1).trim();
  const dashIndex = afterThread.indexOf(" - ");
  if (dashIndex === -1) return null;

  const metadataPart = afterThread.substring(0, dashIndex).trim();
  const message = afterThread.substring(dashIndex + 3).trim();

  // Split by first space only to separate Severity from Component (handles spaces in component)
  const firstSpace = metadataPart.indexOf(" ");
  if (firstSpace === -1) return null;

  const severity = metadataPart.substring(0, firstSpace).trim().toUpperCase();
  const component = metadataPart.substring(firstSpace + 1).trim();

  // 4. Extract Extra Metadata (Device/IP)
  let device_id: string | null = null;
  const deviceMatch =
    message.match(/device\s+(\d+)/i) ||
    message.match(/device_?id[=:\s]+(\d+)/i);
  if (deviceMatch) device_id = deviceMatch[1];

  let ip_address: string | null = null;
  const ipMatch = message.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
  if (ipMatch) ip_address = ipMatch[1];

  return {
    line_number: lineNumber,
    timestamp,
    thread: fullThread,
    thread_group: threadGroup, // <--- Populate new field
    severity,
    component,
    message,
    device_id,
    ip_address,
    has_stack_trace: false,
    stack_trace: null,
    exception_class: null,
  };
}

function isStackTraceLine(line: string): boolean {
  return (
    line.startsWith("\tat ") ||
    line.startsWith("    at ") ||
    line.match(/^\s+at\s+[\w.$]+\(/) !== null ||
    line.match(/^[\w.]+Exception:/) !== null ||
    line.match(/^[\w.]+Error:/) !== null ||
    line.match(/^Caused by:/) !== null ||
    line.match(/^\s*\.\.\..*more/) !== null
  );
}

function extractExceptionClass(line: string): string | null {
  const match = line.match(/^([\w.]+(?:Exception|Error)):/);
  if (match) {
    const parts = match[1].split(".");
    return parts[parts.length - 1];
  }
  return null;
}

// ============================================================
// S3 UPLOAD
// ============================================================

async function uploadToS3(filePath: string, key: string): Promise<void> {
  const fileStream = createReadStream(filePath);

  const upload = new Upload({
    client: s3,
    params: {
      Bucket: BUCKET,
      Key: key,
      Body: fileStream,
      ContentType: "application/octet-stream",
    },

    queueSize: 4,
    partSize: 10 * 1024 * 1024,
    leavePartsOnError: false,
  });

  upload.on("httpUploadProgress", (progress) => {
    // Only log every ~100MB to avoid spamming CloudWatch
  });

  await upload.done();
}
