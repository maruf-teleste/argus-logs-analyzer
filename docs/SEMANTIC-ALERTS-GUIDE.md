# 🔍 Semantic Alerts & False Positive Management

## Overview

Your log analyzer now uses **Semantic Analysis** to detect hidden failures in INFO/DEBUG logs that contain failure keywords like "timeout", "failed", "refused", etc.

**Problem Solved:** Traditional severity-based alerting misses critical issues like:
- `INFO: Database connection timeout` (real problem)
- `WARN: Service unreachable` (real problem)

**New Problem:** Too many false positives from harmless logs like:
- `INFO: Check failed: false` (validation passed)
- `INFO: 0 failed uploads` (success message)

This guide shows you how to fix false positives while keeping real alerts.

---

## 🛠️ Phase 1: Identify False Positives

### Option A: Via Browser Console (Quick)

1. Open your browser DevTools console
2. Upload a log file and note the `file_id`
3. Run:
```javascript
fetch('/api/query/duckdb', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    action: 'debug_semantic_matches',
    params: { file_id: 123 }  // Replace with your file_id
  })
})
.then(r => r.json())
.then(data => console.table(data))
```

### Option B: Via Debug Script (Recommended)

```bash
# Find your file_id first (check database or UI)
npx tsx scripts/debug-semantic-alerts.ts 123
```

### Example Output

```
⚠️ TOP 20 SEMANTIC MATCHES (Check for false positives):
  1. ⚠️  FALSE POSITIVE? [INFO  ] (50000x) Check failed: false
  2. ⚠️  FALSE POSITIVE? [INFO  ] (12000x) 0 failed uploads
  3.    [ERROR ] (   45x) Database connection timeout
  4.    [WARN  ] (   23x) Service unreachable - retrying
  5. ⚠️  FALSE POSITIVE? [DEBUG ] ( 8000x) Validation failed: false
```

**What to look for:**
- ✅ **Keep:** Low count ERROR/WARN logs (real problems)
- ❌ **Ignore:** High count INFO/DEBUG logs (false positives)

---

## 🔧 Phase 2: Fix False Positives

### Step 1: Open the Configuration File

```
lib/query/duckdb-client.ts
```

### Step 2: Find the IGNORE_PATTERNS Constant

Look for this section (around line 132):

```typescript
const IGNORE_PATTERNS = [
  "check failed: false",
  "0 failed",
  "validation failed: false",
  // ... existing patterns
].join("|");
```

### Step 3: Add Your Noisy Patterns

Copy the **exact phrase** from the debug output:

```typescript
const IGNORE_PATTERNS = [
  // ✅ Existing patterns
  "check failed: false",
  "0 failed",
  "validation failed: false",

  // 🟢 NEW: Add your noisy patterns here
  "successfully handled failed request",  // From your debug output
  "retry succeeded after failure",        // From your debug output
  "optional cache disconnected",          // From your debug output

  // Regular expressions (advanced)
  "\\b0\\s+errors?\\b",          // Matches "0 errors", "0 error"
  "\\b0\\s+timeouts?\\b",        // Matches "0 timeouts", "0 timeout"
].join("|");
```

### Step 4: Restart Your Server

```bash
# If using dev server
npm run dev

# The changes will take effect immediately
```

---

## 📊 How It Works

### Before (Too Many Alerts)

```
Timeline Chart:
┌────┬────┬────┬────┐
│🔴 │🔴 │🔴 │🔴 │  All bars are red (50,000 "Check failed: false" logs)
└────┴────┴────┴────┘
```

### After (Only Real Issues)

```
Timeline Chart:
┌────┬────┬────┬────┐
│    │    │🔴 │    │  Only bars with real issues highlighted
└────┴────┴────┴────┘
       Real database timeout ↗
```

---

## 🧪 Testing Your Changes

### 1. Upload a Test Log

Upload a file that contains both:
- ✅ Real failures: `ERROR: Connection timeout`
- ❌ False positives: `INFO: 0 failed uploads`

### 2. Check the Timeline Chart

- Bars should only be highlighted for real issues
- Tooltip should show accurate "High Priority Issues" count

### 3. Check the Anomaly Table

Run anomaly detection and verify:
- False positives are filtered out
- Real errors still appear with importance_score=80 or 100

---

## 🎯 Best Practices

### ✅ DO:

1. **Add exact phrases** from your logs (case-insensitive)
2. **Test after each change** to verify alerts decrease
3. **Document why** you're ignoring a pattern (use comments)
4. **Use regex** for patterns with numbers: `\\b0\\s+errors?\\b`

### ❌ DON'T:

1. **Don't ignore everything** - you'll miss real issues
2. **Don't use broad patterns** like just "failed" (too broad)
3. **Don't forget** to restart the server after changes
4. **Don't skip testing** - verify real errors still alert

---

## 📝 Common False Positive Patterns

Add these if you see them in your logs:

```typescript
const IGNORE_PATTERNS = [
  // Validation Success Messages
  "check failed: false",
  "validation failed: false",
  "test failed: false",

  // Zero Count Success Messages
  "0 failed",
  "0 errors?",
  "0 timeouts?",
  "0 rejected",

  // Recovery Messages
  "successfully.*failed",        // "successfully handled failed request"
  "retries?.*succeeded",         // "retry succeeded"
  "recovered from.*failure",

  // Expected Disconnections
  "optional.*disconnected",
  "graceful.*disconnect",
  "client disconnected normally",

  // Expected Timeouts
  "expected.*timeout",
  "normal.*timeout",
  "keep-?alive timeout",

  // Debug/Test Messages
  "simulated failure",
  "test.*failed.*expected",
].join("|");
```

---

## 🚨 Troubleshooting

### Problem: Still seeing too many alerts

**Solution:** Run the debug script again and add more patterns

```bash
npx tsx scripts/debug-semantic-alerts.ts 123
```

### Problem: Missing real errors now

**Solution:** Your IGNORE_PATTERNS are too broad. Remove generic patterns and use exact phrases:

```typescript
// ❌ BAD: Too broad - will ignore "Connection failed"
"failed"

// ✅ GOOD: Specific - only ignores validation success
"validation failed: false"
```

### Problem: Chart and table don't match

**Solution:** Make sure **both** `detectAnomalies` and `getTimelineHistogram` use the same IGNORE_PATTERNS.

Check these lines:
- Line 227-229 in `detectAnomalies`
- Line 886-889 in `getTimelineHistogram`

Both should have:
```typescript
AND NOT regexp_matches(message, '(?i)(${IGNORE_PATTERNS})')
```

---

## 🎓 Advanced: Custom Ignore Patterns Per Session

If different log files need different ignore patterns, you can:

1. Store custom patterns in the database (`session_settings` table)
2. Pass them as a parameter to `detectAnomalies`
3. Merge them with the global IGNORE_PATTERNS

Example:

```typescript
export async function detectAnomalies(fileId: number, params: any) {
  // Global patterns (always applied)
  const globalIgnore = IGNORE_PATTERNS;

  // User-provided patterns (optional)
  const customIgnore = params.ignore_patterns?.join("|") || "";

  // Combine them
  const ignorePattern = customIgnore
    ? `${globalIgnore}|${customIgnore}`
    : globalIgnore;

  // Use ignorePattern in SQL...
}
```

---

## 📚 Further Reading

- [Regex Guide](https://regexr.com/) - Test your ignore patterns
- [DuckDB Pattern Matching](https://duckdb.org/docs/sql/functions/patternmatching) - SQL regex syntax
- [Log Analysis Best Practices](https://www.datadoghq.com/blog/log-patterns/) - Industry standards

---

## 📞 Support

If you're still experiencing false positive storms:

1. Run `debugSemanticMatches(fileId)` and share the output
2. Check server logs for pattern matching errors
3. Verify your IGNORE_PATTERNS syntax (use a regex tester)

Happy debugging! 🎉
