# DuckDB Query Tools - Modular Architecture

This directory contains a modular system for managing DuckDB query tools. The architecture eliminates code duplication by centralizing tool definitions.

## Architecture Overview

```
┌─────────────────────┐
│  duckdb-client.ts   │  ← Core implementations (SQL queries, business logic)
└──────────┬──────────┘
           │
           ↓
┌─────────────────────┐
│ tools-registry.ts   │  ← Central registry - maps tool names to implementations
└──────────┬──────────┘
           │
           ├──────────────────────────┐
           ↓                          ↓
┌─────────────────────┐    ┌─────────────────────┐
│   route.ts (API)    │    │  duckdb-api.ts      │
│ Auto-executes tools │    │  (Client wrapper)   │
└─────────────────────┘    └─────────────────────┘
```

## How to Add a New Tool

You now only need to edit **2 files** instead of 3:

### Step 1: Implement the function in `duckdb-client.ts`

```typescript
export async function myNewTool(
  fileId: number,
  customParam: string
): Promise<any[]> {
  const key = await getParquetKey(fileId);

  const sql = `
    SELECT * FROM read_parquet('${s3Path(key)}')
    WHERE custom_field = '${customParam}'
    LIMIT 100
  `;

  return runQuery(sql);
}
```

### Step 2: Register it in `tools-registry.ts`

```typescript
export const TOOLS: Record<string, ToolDefinition> = {
  // ... existing tools ...

  my_new_tool: {
    name: 'my_new_tool',
    implementation: client.myNewTool,
    paramMapper: (p) => [p.file_id, p.custom_param],
  },
};
```

### That's it!

The API route and client wrapper will automatically work. No need to edit:
- ❌ `app/api/query/duckdb/route.ts` (auto-handles all tools)
- ❌ `lib/ai/duckdb-api.ts` (use `callTool()` or add a typed wrapper if needed)

## Using the New Tool

### Option 1: Using the generic `callTool()` (recommended for new tools)

```typescript
import { callTool } from '@/lib/ai/duckdb-api';

const result = await callTool('my_new_tool', {
  file_id: 123,
  custom_param: 'test',
});
```

### Option 2: Add a typed wrapper (optional, for better DX)

In `duckdb-api.ts`, add:

```typescript
export async function myNewTool(fileId: number, customParam: string) {
  return callTool('my_new_tool', {
    file_id: fileId,
    custom_param: customParam,
  });
}
```

## Benefits

1. **Single source of truth**: Tool definitions live in `tools-registry.ts`
2. **No duplication**: API route handler and client wrapper are auto-generated
3. **Type safety**: TypeScript ensures parameter mapping is correct
4. **Easy maintenance**: Adding/removing tools only requires 2 file changes
5. **Better errors**: Unknown actions return list of available tools

## File Responsibilities

| File | Purpose | Edit when adding tools? |
|------|---------|------------------------|
| `duckdb-client.ts` | Core SQL implementations | ✅ Yes |
| `tools-registry.ts` | Tool name → implementation mapping | ✅ Yes |
| `route.ts` | Generic API endpoint | ❌ No |
| `duckdb-api.ts` | Client wrapper (optional typed functions) | ⚠️ Optional |

## Example: Before vs After

### Before (had to edit 3 files)

**File 1: duckdb-client.ts**
```typescript
export async function getTool() { /* ... */ }
```

**File 2: route.ts**
```typescript
handlers: {
  get_tool: (p) => client.getTool(p.file_id, p.param)
}
```

**File 3: duckdb-api.ts**
```typescript
export async function getTool(fileId, param) {
  return callDuckDB('get_tool', { file_id: fileId, param });
}
```

### After (only edit 2 files)

**File 1: duckdb-client.ts**
```typescript
export async function getTool() { /* ... */ }
```

**File 2: tools-registry.ts**
```typescript
TOOLS = {
  get_tool: {
    name: 'get_tool',
    implementation: client.getTool,
    paramMapper: (p) => [p.file_id, p.param]
  }
}
```

**Files 3 & 4: No changes needed!** ✨
