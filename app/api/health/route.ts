// app/api/health/route.ts
// Health check endpoint for ALB target group health checks

import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const { ok, latencyMs } = db.healthCheck();

    if (!ok) throw new Error("DB health check failed");

    return Response.json(
      {
        status: "ok",
        timestamp: new Date().toISOString(),
        service: "log-analyzer",
        database: "connected",
        dbLatency: `${latencyMs}ms`,
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-cache, no-store, must-revalidate",
        },
      }
    );
  } catch (error) {
    return Response.json(
      {
        status: "unhealthy",
        timestamp: new Date().toISOString(),
        service: "log-analyzer",
        database: "disconnected",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-cache, no-store, must-revalidate",
        },
      }
    );
  }
}
