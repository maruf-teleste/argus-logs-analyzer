// app/api/query/duckdb/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { executeTool, getAvailableTools } from "@/lib/query/tools-registry";

export async function POST(req: NextRequest) {
  try {
    const { action, params } = await req.json();

    if (!action) {
      return Response.json({ error: "Missing action" }, { status: 400 });
    }

    // Execute the tool using the registry
    const result = await executeTool(action, params);

    return Response.json(result);
  } catch (error) {
    console.error("DuckDB API error:", error);

    // Check if it's an unknown action error
    if (error instanceof Error && error.message.startsWith("Unknown action")) {
      const availableTools = getAvailableTools();
      return Response.json(
        {
          error: error.message,
          available_actions: availableTools,
        },
        { status: 400 }
      );
    }

    return Response.json(
      {
        error: error instanceof Error ? error.message : "DuckDB query failed",
      },
      { status: 500 }
    );
  }
}
