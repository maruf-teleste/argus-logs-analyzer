import { getSessionFile } from "@/lib/ai/chat-history";
import { getExceptionSummary, detectAnomalies } from "@/lib/ai/duckdb-api";

export interface ProactiveInsight {
  type: "exception" | "pattern";
  title: string;
  query: string;
}

export async function getProactiveInsights(
  sessionId: string
): Promise<ProactiveInsight[]> {
  const activeFile = await getSessionFile(sessionId);
  if (!activeFile || !activeFile.file_id) {
    return [];
  }

  const fileId = activeFile.file_id;
  const insights: ProactiveInsight[] = [];

  try {
    // 1. Get top exceptions
    const exceptionSummary = await getExceptionSummary(fileId);
    if (exceptionSummary && exceptionSummary.length > 0) {
      const topException = exceptionSummary[0];
      insights.push({
        type: "exception",
        title: `High count of ${topException.exception_class}`,
        query: `Show me errors with exception ${topException.exception_class}`,
      });
    }

    // 2. Get top patterns (using detectAnomalies as a proxy)
    if (activeFile.time_range_start && activeFile.time_range_end) {
      const anomalies = await detectAnomalies(
        fileId,
        activeFile.time_range_start,
        activeFile.time_range_end,
        {
            minSpikeRatio: 1, // We want all patterns, not just spikes
            severityFilter: ["ERROR", "WARN"],
        }
      );

      if (anomalies && anomalies.length > 0) {
        // Take top 2 anomalies that are not exceptions
        const topAnomalies = anomalies
          .filter(a => !a.fingerprint.toLowerCase().includes('exception'))
          .slice(0, 2);

        for (const anomaly of topAnomalies) {
          insights.push({
            type: "pattern",
            title: `Frequent pattern: ${anomaly.fingerprint}`,
            query: `Show me logs with pattern "${anomaly.fingerprint}"`,
          });
        }
      }
    }

    return insights;
  } catch (error) {
    console.error("Error generating proactive insights:", error);
    return [];
  }
}
