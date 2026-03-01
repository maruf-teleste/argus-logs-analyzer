"use client";

import { useState } from "react";
import { AnomalyGrid } from "./AnomalyGrid";
import { PatternTable } from "./PatternTable";
import { X } from "lucide-react";

interface Props {
  sessionId: string;
  fileId?: string | number;
}

export function LogAnalysis({ sessionId, fileId }: Props) {
  const normalizedFileId =
    fileId === undefined ? undefined : Number.isNaN(Number(fileId)) ? undefined : Number(fileId);

  const [timeRange, setTimeRange] = useState<{
    start: string | null;
    end: string | null;
  }>({ start: null, end: null });

  const handleBarClick = (start: string, end: string) => {
    setTimeRange({ start, end });
  };

  const clearSelection = () => {
    setTimeRange({ start: null, end: null });
  };

  return (
    <div className="space-y-6">
      {timeRange.start && timeRange.end && (
        <div className="bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-950/50 dark:to-indigo-950/50 border border-blue-200 dark:border-blue-800 rounded-2xl p-5 flex items-center justify-between shadow-lg backdrop-blur-sm">
          <div>
            <p className="text-sm font-bold text-blue-900 dark:text-blue-100">
              Analyzing 15-minute window
            </p>
            <p className="text-xs text-blue-700 dark:text-blue-300 font-mono mt-1.5 bg-white/50 dark:bg-black/20 px-2 py-1 rounded inline-block">
              {new Date(timeRange.start).toLocaleTimeString()} →{" "}
              {new Date(timeRange.end).toLocaleTimeString()} UTC
            </p>
          </div>
          <button
            onClick={clearSelection}
            className="px-4 py-2 bg-slate-100 dark:bg-slate-950 hover:bg-blue-100 dark:hover:bg-slate-800 border border-blue-300 dark:border-blue-700 rounded-lg text-sm font-semibold text-blue-700 dark:text-blue-300 flex items-center gap-2 transition-all duration-200 shadow-sm hover:shadow-md"
          >
            <X className="w-4 h-4" />
            Clear
          </button>
        </div>
      )}

      {/* Histogram */}
      <AnomalyGrid
        sessionId={sessionId}
        fileId={normalizedFileId}
        onBarClick={handleBarClick}
        selectedStart={timeRange.start}
      />

      {/* Pattern Table */}
      <PatternTable
        sessionId={sessionId}
        fileId={normalizedFileId}
        startTime={timeRange.start}
        endTime={timeRange.end}
      />
    </div>
  );
}
