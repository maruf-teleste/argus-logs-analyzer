// scripts/test-log-analyzer.ts

import { sql } from "@/lib/db/client";

const TEST_SESSION_ID = "54262db2-52aa-46c3-a3ca-ca6170f3c470"; // Replace with your session

interface TestResult {
  name: string;
  status: "PASS" | "FAIL";
  rowCount?: number;
  error?: string;
  duration: number;
}

async function runTests(): Promise<void> {
  const results: TestResult[] = [];

  console.log("🧪 Starting Log Analyzer Test Suite\n");
  console.log("=".repeat(60));

  // Test 1: Basic connection
  results.push(await testQuery("Basic connection", sql`SELECT 1 as test`));

  // Test 2: Get all logs (no filter)
  results.push(
    await testQuery(
      "Get all logs",
      sql`SELECT * FROM events WHERE session_id = ${TEST_SESSION_ID} LIMIT 10`
    )
  );

  // Test 3: Filter by severity (single)
  results.push(
    await testQuery(
      "Filter by severity = ERROR",
      sql`SELECT * FROM events WHERE session_id = ${TEST_SESSION_ID} AND severity = 'ERROR'`
    )
  );

  // Test 4: Filter by severity (array with ANY)
  results.push(
    await testQuery(
      "Filter by severity ANY(['ERROR', 'WARN'])",
      sql`SELECT * FROM events WHERE session_id = ${TEST_SESSION_ID} AND severity = ANY(${[
        "ERROR",
        "WARN",
      ]}::text[])`
    )
  );

  // Test 5: Filter by component (array)
  results.push(
    await testQuery(
      "Filter by component ANY",
      sql`SELECT * FROM events WHERE session_id = ${TEST_SESSION_ID} AND component = ANY(${[
        "DeviceConnector",
        "DevicePollTask",
      ]}::text[])`
    )
  );

  // Test 6: ILIKE search
  results.push(
    await testQuery(
      "ILIKE search for device 3002",
      sql`SELECT * FROM events WHERE session_id = ${TEST_SESSION_ID} AND message ILIKE ${"%3002%"}`
    )
  );

  // Test 7: Combined severity + ILIKE
  results.push(
    await testQuery(
      "Severity ERROR + ILIKE 3002",
      sql`SELECT * FROM events 
        WHERE session_id = ${TEST_SESSION_ID} 
          AND severity = ANY(${["ERROR"]}::text[])
          AND message ILIKE ${"%3002%"}`
    )
  );

  // Test 8: Count by severity (used in getLogStats)
  results.push(
    await testQuery(
      "Count by severity (getLogStats)",
      sql`SELECT severity, COUNT(*) as count FROM events WHERE session_id = ${TEST_SESSION_ID} GROUP BY severity`
    )
  );

  // Test 9: Top components (used in getLogStats)
  results.push(
    await testQuery(
      "Top components",
      sql`SELECT component, COUNT(*) as count 
        FROM events 
        WHERE session_id = ${TEST_SESSION_ID} 
        GROUP BY component 
        ORDER BY count DESC 
        LIMIT 5`
    )
  );

  // Test 10: Time range (used in getLogStats)
  results.push(
    await testQuery(
      "Time range MIN/MAX",
      sql`SELECT MIN(timestamp_utc) as earliest, MAX(timestamp_utc) as latest 
        FROM events 
        WHERE session_id = ${TEST_SESSION_ID}`
    )
  );

  // Test 11: Frequency analysis
  results.push(
    await testQuery(
      "Frequency analysis (message grouping)",
      sql`SELECT message, severity, component, COUNT(*) as count
        FROM events
        WHERE session_id = ${TEST_SESSION_ID} AND severity = ANY(${[
        "ERROR",
        "WARN",
      ]}::text[])
        GROUP BY message, severity, component
        ORDER BY count DESC
        LIMIT 10`
    )
  );

  // Test 12: Time series (DATE_TRUNC)
  results.push(
    await testQuery(
      "Time series (DATE_TRUNC hour)",
      sql`SELECT DATE_TRUNC('hour', timestamp_utc) as time_bucket, severity, COUNT(*) as count
        FROM events
        WHERE session_id = ${TEST_SESSION_ID}
        GROUP BY time_bucket, severity
        ORDER BY time_bucket ASC`
    )
  );

  // Test 13: Order ASC
  results.push(
    await testQuery(
      "Order by timestamp ASC",
      sql`SELECT timestamp_utc, severity, message 
        FROM events 
        WHERE session_id = ${TEST_SESSION_ID} 
        ORDER BY timestamp_utc ASC 
        LIMIT 5`
    )
  );

  // Test 14: Order DESC
  results.push(
    await testQuery(
      "Order by timestamp DESC",
      sql`SELECT timestamp_utc, severity, message 
        FROM events 
        WHERE session_id = ${TEST_SESSION_ID} 
        ORDER BY timestamp_utc DESC 
        LIMIT 5`
    )
  );

  // Test 15: Check thread column
  results.push(
    await testQuery(
      "Select thread column",
      sql`SELECT thread FROM events WHERE session_id = ${TEST_SESSION_ID} LIMIT 5`
    )
  );

  // Test 16: Check metadata column
  results.push(
    await testQuery(
      "Select metadata column",
      sql`SELECT metadata FROM events WHERE session_id = ${TEST_SESSION_ID} LIMIT 5`
    )
  );

  // Test 17: Metadata JSONB query (if column exists)
  results.push(
    await testQuery(
      "Metadata JSONB query",
      sql`SELECT * FROM events 
        WHERE session_id = ${TEST_SESSION_ID} 
          AND metadata IS NOT NULL 
          AND metadata != '{}'::jsonb
        LIMIT 5`
    )
  );

  // Print results
  console.log("\n" + "=".repeat(60));
  console.log("📊 TEST RESULTS\n");

  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;

  for (const result of results) {
    const icon = result.status === "PASS" ? "✅" : "❌";
    const rowInfo =
      result.rowCount !== undefined ? ` (${result.rowCount} rows)` : "";
    const timeInfo = ` [${result.duration}ms]`;
    console.log(`${icon} ${result.name}${rowInfo}${timeInfo}`);
    if (result.error) {
      console.log(`   └─ Error: ${result.error}`);
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log(
    `\n📈 Summary: ${passed} passed, ${failed} failed out of ${results.length} tests\n`
  );

  // List issues found
  if (failed > 0) {
    console.log("⚠️  ISSUES TO FIX:");
    results
      .filter((r) => r.status === "FAIL")
      .forEach((r) => {
        console.log(`   - ${r.name}: ${r.error}`);
      });
  }

  // Check for data issues
  console.log("\n🔍 DATA QUALITY CHECKS:");
  await checkDataQuality(TEST_SESSION_ID);
}

async function testQuery(
  name: string,
  queryPromise: Promise<any>
): Promise<TestResult> {
  const start = Date.now();
  try {
    const result = await queryPromise;
    const rows = Array.isArray(result) ? result : [];
    return {
      name,
      status: "PASS",
      rowCount: rows.length,
      duration: Date.now() - start,
    };
  } catch (err: any) {
    return {
      name,
      status: "FAIL",
      error: err.message || String(err),
      duration: Date.now() - start,
    };
  }
}

async function checkDataQuality(sessionId: string): Promise<void> {
  // Check for NULL timestamps
  const nullTimestamps = await sql`
    SELECT COUNT(*) as count FROM events 
    WHERE session_id = ${sessionId} AND timestamp_utc IS NULL
  `;
  const nullCount = Number(nullTimestamps[0]?.count ?? 0);
  if (nullCount > 0) {
    console.log(`   ⚠️  ${nullCount} rows have NULL timestamp_utc`);
  } else {
    console.log(`   ✅ All timestamps populated`);
  }

  // Check for NULL/empty thread
  const nullThread = await sql`
    SELECT COUNT(*) as count FROM events 
    WHERE session_id = ${sessionId} AND (thread IS NULL OR thread = '')
  `;
  const nullThreadCount = Number(nullThread[0]?.count ?? 0);
  if (nullThreadCount > 0) {
    console.log(`   ⚠️  ${nullThreadCount} rows have NULL/empty thread`);
  } else {
    console.log(`   ✅ All threads populated`);
  }

  // Check for NULL/empty metadata
  const nullMetadata = await sql`
    SELECT COUNT(*) as count FROM events 
    WHERE session_id = ${sessionId} AND (metadata IS NULL OR metadata = '{}'::jsonb)
  `;
  const nullMetaCount = Number(nullMetadata[0]?.count ?? 0);
  if (nullMetaCount > 0) {
    console.log(`   ⚠️  ${nullMetaCount} rows have NULL/empty metadata`);
  } else {
    console.log(`   ✅ All metadata populated`);
  }

  // Check severity distribution
  const severities = await sql`
    SELECT severity, COUNT(*) as count 
    FROM events 
    WHERE session_id = ${sessionId} 
    GROUP BY severity
  `;
  console.log(`   📊 Severity distribution:`, severities);
}

// Run the tests
runTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Test suite failed:", err);
    process.exit(1);
  });
