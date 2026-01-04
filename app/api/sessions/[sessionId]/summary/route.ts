import { NextResponse } from "next/server";
import { getProactiveInsights } from "@/lib/ai/proactive-insights";

export async function GET(
  req: Request,
  { params }: { params: { sessionId: string } }
) {
  try {
    const { sessionId } = params;
    const insights = await getProactiveInsights(sessionId);
    return NextResponse.json({ insights });
  } catch (error) {
    console.error("Error fetching proactive insights:", error);
    return NextResponse.json(
      { error: "Failed to fetch proactive insights" },
      { status: 500 }
    );
  }
}