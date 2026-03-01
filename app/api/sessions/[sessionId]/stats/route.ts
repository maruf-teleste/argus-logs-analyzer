// app/api/sessions/[sessionId]/stats/route.ts

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET(
  request: Request,
  context: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await context.params;
  const { searchParams } = new URL(request.url);
  const fileId = searchParams.get('fileId');

  try {
    const stats = db.getSessionStats(sessionId, fileId ? Number(fileId) : undefined);

    if (!stats || stats.total_logs === 0) {
      return NextResponse.json({ error: 'No data found for this session.' }, { status: 404 });
    }

    const serializedStats = {
      totalLines: Number(stats.total_logs),
      totalErrors: Number(stats.error_count),
      totalWarnings: Number(stats.warn_count || 0),
      uniquePatterns: Number(stats.unique_patterns),
      startTime: stats.start_time,
      endTime: stats.end_time,
    };

    return NextResponse.json(serializedStats);
  } catch (error) {
    console.error(`[API STATS] Failed to get stats for session ${sessionId}:`, error);
    return NextResponse.json({ error: 'An internal error occurred.' }, { status: 500 });
  }
}
