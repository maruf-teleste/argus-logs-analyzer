/**
 * 🔍 DEBUG SCRIPT: Find False Positive Semantic Alerts
 *
 * This script helps you identify which logs are triggering semantic alerts
 * so you can add them to IGNORE_PATTERNS in lib/query/duckdb-client.ts
 *
 * USAGE:
 * 1. Find your file_id from the database or UI (check session_files table)
 * 2. Run: npx tsx scripts/debug-semantic-alerts.ts <file_id>
 * 3. Review the output for false positives
 * 4. Add noisy patterns to IGNORE_PATTERNS constant
 *
 * EXAMPLE OUTPUT:
 * ⚠️ TOP 20 SEMANTIC MATCHES (Check for false positives):
 *   [INFO] Check failed: false (50,000x)  <-- ADD THIS TO IGNORE_PATTERNS
 *   [INFO] 0 failed uploads (12,000x)     <-- ADD THIS TO IGNORE_PATTERNS
 *   [ERROR] Database connection timeout (45x)  <-- REAL ERROR, KEEP IT
 */

import { debugSemanticMatches } from '../lib/query/duckdb-client';

async function main() {
  const fileId = parseInt(process.argv[2]);

  if (!fileId || isNaN(fileId)) {
    console.error('❌ Usage: npx tsx scripts/debug-semantic-alerts.ts <file_id>');
    console.error('   Example: npx tsx scripts/debug-semantic-alerts.ts 123');
    process.exit(1);
  }

  console.log(`🔍 Analyzing semantic matches for file_id: ${fileId}\n`);

  try {
    const results = await debugSemanticMatches(fileId);

    console.log('\n📊 RESULTS:');
    console.log('━'.repeat(80));

    if (results.length === 0) {
      console.log('✅ No semantic matches found! Your IGNORE_PATTERNS are working perfectly.');
      return;
    }

    console.log(`\nFound ${results.length} patterns matching FAILURE_KEYWORDS:\n`);

    results.forEach((r: any, idx: number) => {
      const severity = r.severity.padEnd(6);
      const count = String(r.count).padStart(6);
      const message = r.message.substring(0, 70);

      // Highlight potential false positives
      const isSuspicious =
        r.count > 1000 ||
        r.severity === 'INFO' ||
        r.message.match(/false|0\s+(failed|error|timeout)/i);

      const marker = isSuspicious ? '⚠️  FALSE POSITIVE?' : '   ';

      console.log(`${idx + 1}. ${marker} [${severity}] (${count}x) ${message}`);
    });

    console.log('\n' + '━'.repeat(80));
    console.log('\n💡 HOW TO FIX:');
    console.log('1. Look for high-count INFO logs (likely false positives)');
    console.log('2. Copy the exact phrase from the message');
    console.log('3. Add it to IGNORE_PATTERNS in lib/query/duckdb-client.ts');
    console.log('\nExample:');
    console.log('  const IGNORE_PATTERNS = [');
    console.log('    "check failed: false",  // <-- Add this');
    console.log('    "0 failed",');
    console.log('    // ... other patterns');
    console.log('  ].join("|");');
    console.log('\n');

  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

main();
