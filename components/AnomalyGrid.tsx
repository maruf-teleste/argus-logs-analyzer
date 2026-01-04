"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { Loader2 } from "lucide-react";

const COLORS = {
  ERROR: "#ef4444",
  WARN: "#f59e0b",
  INFO: "#3b82f6",
  TRACE: "#8b5cf6",
};

interface Props {
  sessionId: string;
  fileId?: number;
  onBarClick: (start: string, end: string) => void;
  selectedStart?: string | null;
}

export function AnomalyGrid({
  sessionId,
  fileId,
  onBarClick,
  selectedStart,
}: Props) {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  /* -------------------------------------------
     FETCH DATA
  --------------------------------------------*/
  useEffect(() => {
    if (!sessionId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const url = new URL(
      `/api/sessions/${sessionId}/timeline`,
      window.location.origin
    );

    if (fileId) url.searchParams.append("fileId", fileId.toString());

    fetch(url.toString())
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load timeline");
        return res.json();
      })
      .then((d) => {
        setData(d.histogram || []);
        setLoading(false);
        setRetryCount(0);
      })
      .catch((err) => {
        console.error("Failed to load timeline:", err);

        if (retryCount === 0) {
          setTimeout(() => setRetryCount(1), 1000);
        } else {
          setError(err.message);
          setData([]);
          setLoading(false);
        }
      });
  }, [sessionId, fileId, retryCount]);

  /* -------------------------------------------
     PRECOMPUTE ERROR LOOKUP (STABLE)
  --------------------------------------------*/
  const errorMap = useMemo(() => {
    const map = new Map<string, boolean>();
    data.forEach((d) => {
      // Only mark as error if there are actual ERROR/FATAL logs
      const errorCount = Number(d.errors) || 0;
      map.set(String(d.time), errorCount > 0);
    });
    return map;
  }, [data]);

  // Generate a stable key for forcing re-renders when data changes
  const chartKey = useMemo(() => {
    if (!data.length) return "empty";
    // Create a hash based on data content
    const errorCount = data.filter((d) => Number(d.errors) > 0).length;
    return `chart-${data.length}-${errorCount}`;
  }, [data]);

  /* -------------------------------------------
     CUSTOM TICK COMPONENT (MEMOIZED)
  --------------------------------------------*/
  const CustomTick = useCallback(
    ({ x, y, payload }: any) => {
      const hasErrors = errorMap.get(String(payload.value)) || false;

      let displayTime = "--:--";
      try {
        const date = new Date(payload.value);
        if (!isNaN(date.getTime())) {
          displayTime = date.toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          });
        }
      } catch {
        // fallback already set
      }

      return (
        <g transform={`translate(${x},${y})`}>
          <text x={0} y={10} textAnchor="middle" fill="#64748b" fontSize={12}>
            {displayTime}
          </text>

          {/* ⚠️ ERROR INDICATOR: Only for actual ERROR/FATAL logs */}
          {hasErrors && (
            <circle
              cx={0}
              cy={24}
              r={5}
              fill="#ef4444"
              stroke="#ffffff"
              strokeWidth={2}
            />
          )}
        </g>
      );
    },
    [errorMap]
  );

  /* -------------------------------------------
     LOADING / ERROR / EMPTY STATES
  --------------------------------------------*/
  if (loading) {
    return (
      <div className="h-[400px] flex items-center justify-center">
        <Loader2 className="animate-spin w-10 h-10 text-blue-500" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-[400px] flex items-center justify-center text-red-600">
        {error}
      </div>
    );
  }

  if (!data.length) {
    return (
      <div className="h-[400px] flex items-center justify-center text-slate-500">
        No log data found
      </div>
    );
  }

  /* -------------------------------------------
     CHART
  --------------------------------------------*/
  return (
    <div className="h-[400px] w-full bg-slate-100 dark:bg-slate-950 p-6 rounded-xl border border-slate-200 dark:border-slate-700 shadow-lg">
      <ResponsiveContainer key={chartKey} width="100%" height="100%">
        <BarChart data={data} margin={{ top: 10, right: 10, bottom: 40 }}>
          <CartesianGrid
            strokeDasharray="3 3"
            vertical={false}
            stroke="currentColor"
            className="text-slate-200 dark:text-slate-700"
          />

          <XAxis dataKey="time" height={60} interval={0} tick={CustomTick} />

          <YAxis
            stroke="currentColor"
            className="text-slate-600 dark:text-slate-400"
            fontSize={12}
          />

          <Tooltip
            cursor={{ fill: "rgba(148,163,184,0.1)" }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;

              const dataPoint = payload[0]?.payload;
              const criticalCount = Number(dataPoint?.criticalSemanticErrors) || 0;
              const regularSemanticCount = Number(dataPoint?.semanticErrors) || 0;

              return (
                <div className="bg-slate-900 text-white text-xs rounded-lg p-3 shadow-xl min-w-[200px]">
                  <p className="font-bold mb-2">
                    {new Date(label).toLocaleString()}
                  </p>

                  {/* Log counts by severity */}
                  {payload.map((p: any) => (
                    <div key={p.name} className="flex justify-between gap-4 mb-1">
                      <span className="capitalize">{p.name}:</span>
                      <span className="font-mono">{p.value}</span>
                    </div>
                  ))}

                  {/* 🔴 CRITICAL SEMANTIC ISSUES - Always show if present */}
                  {criticalCount > 0 && (
                    <div className="mt-3 pt-2 border-t border-red-500/30">
                      <div className="flex items-start gap-2 text-red-400">
                        <span className="text-[10px] mt-0.5">⚠️</span>
                        <div className="flex-1">
                          <div className="text-[10px] font-semibold leading-relaxed">
                            {criticalCount} critical issue{criticalCount > 1 ? 's' : ''} detected
                          </div>
                          <div className="text-[9px] text-red-300/80 mt-0.5">
                            Database failures, 404s, connection errors
                          </div>
                          <div className="text-[9px] text-slate-400 mt-1">
                            Click to investigate →
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* 💡 REGULAR SEMANTIC HINT - Only if low count and no critical issues */}
                  {criticalCount === 0 && regularSemanticCount > 0 && regularSemanticCount <= 10 && (
                    <div className="mt-3 pt-2 border-t border-slate-700">
                      <div className="flex items-start gap-2 text-amber-300/80">
                        <span className="text-[10px] mt-0.5">💡</span>
                        <div className="flex-1">
                          <div className="text-[10px] leading-relaxed">
                            {regularSemanticCount} log{regularSemanticCount > 1 ? 's' : ''} mention failure keywords
                          </div>
                          <div className="text-[9px] text-slate-400 mt-0.5">
                            Click to check if unusual
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Generic prompt if many regular semantic matches */}
                  {criticalCount === 0 && regularSemanticCount > 10 && (
                    <div className="mt-3 pt-2 border-t border-slate-700">
                      <div className="text-[9px] text-slate-400 italic">
                        Click to analyze patterns
                      </div>
                    </div>
                  )}
                </div>
              );
            }}
          />

          {Object.keys(COLORS).map((key) => {
            const severity = key as keyof typeof COLORS;
            const dataKey =
              key === "ERROR"
                ? "errors"
                : key === "WARN"
                ? "warnings"
                : key.toLowerCase();

            return (
              <Bar
                key={key}
                dataKey={dataKey}
                stackId="a"
                fill={COLORS[severity]}
                name={key.toLowerCase()}
                onClick={(d) => handleClick(d, onBarClick)}
                cursor="pointer"
              >
                {data.map((entry, index) => {
                  const isSelected = !selectedStart || entry.time === selectedStart;

                  return (
                    <Cell
                      key={index}
                      fillOpacity={isSelected ? 1 : 0.2}
                    />
                  );
                })}
              </Bar>
            );
          })}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function handleClick(barData: any, cb: Function) {
  const row = barData?.payload;
  if (!row?.time) return;

  const normalized = row.time.replace(" ", "T").replace(",", ".");
  const start = new Date(normalized);

  if (isNaN(start.getTime())) {
    console.error("Invalid date:", row.time);
    return;
  }

  const end = new Date(start.getTime() + 15 * 60 * 1000);
  cb(start.toISOString(), end.toISOString());
}
