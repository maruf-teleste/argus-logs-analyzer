"use client";

import { useEffect, useState, useMemo, useRef } from "react";
import { Loader2, ChevronRight, Filter, AlertCircle } from "lucide-react";

interface Pattern {
  pattern_signature: string;
  severity: string;
  component: string;
  count: number;
  importance_score: number; // 🟢 ADD THIS - Comes from backend
}

interface Props {
  sessionId: string;
  fileId?: number;
  startTime: string | null;
  endTime: string | null;
}

const severityColors: Record<string, string> = {
  ERROR:
    "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20 dark:border-red-500/30",
  CRITICAL:
    "bg-red-600/15 text-red-700 dark:text-red-300 border-red-600/30 dark:border-red-600/40",
  WARN: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20 dark:border-amber-500/30",
  INFO: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20 dark:border-blue-500/30",
  TRACE:
    "bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20 dark:border-slate-500/30",
};

// 🔍 Helper: Get display label based on importance score
const getDisplaySeverity = (pattern: Pattern): string => {
  if (pattern.importance_score === 100) return "ERROR"; // Actual ERROR/FATAL severity
  if (pattern.importance_score === 90) return "CRITICAL"; // 🔴 Critical semantic (DB failures, 404s, connection errors)
  return pattern.severity; // Keep original severity for everything else
};

export function PatternTable({ sessionId, fileId, startTime, endTime }: Props) {
  const [patterns, setPatterns] = useState<Pattern[]>([]);
  const [loading, setLoading] = useState(false);

  // ✅ New State: Controls whether we hide INFO/DEBUG logs
  const [showCriticalOnly, setShowCriticalOnly] = useState(true);

  const [selectedPattern, setSelectedPattern] = useState<string | null>(null);
  const [samples, setSamples] = useState<any[]>([]);
  const [loadingSamples, setLoadingSamples] = useState(false);

  // ✅ NEW: Track loading state per sample for context
  const [loadingContext, setLoadingContext] = useState<Record<number, boolean>>(
    {}
  );
  const [expandedContext, setExpandedContext] = useState<Record<number, any>>(
    {}
  );

  // ✅ NEW: Refs for auto-scrolling to anchor logs
  const anchorRefs = useRef<Record<number, HTMLDivElement | null>>({});

  // ✅ NEW: Track if we've loaded INFO/TRACE patterns for current time range
  const [hasLoadedInfoTrace, setHasLoadedInfoTrace] = useState(false);
  const LIMIT = 100; // Load up to 100 patterns at once

  // ✅ Phase 1: Load ALL patterns (sorted by importance), then filter client-side
  useEffect(() => {
    if (!startTime || !endTime) {
      setPatterns([]);
      setLoading(false);
      setHasLoadedInfoTrace(false);
      return;
    }

    setLoading(true);
    setPatterns([]);
    setHasLoadedInfoTrace(true); // Mark as loaded since we're fetching everything

    const url = new URL(
      `/api/sessions/${sessionId}/anomaly-grid`,
      window.location.origin
    );
    url.searchParams.append("startTime", startTime);
    url.searchParams.append("endTime", endTime);
    // ✅ Load ALL severities - backend sorts by importance_score
    // Frontend will filter based on showCriticalOnly toggle
    url.searchParams.append("limit", LIMIT.toString());
    if (fileId) url.searchParams.append("fileId", fileId.toString());

    fetch(url.toString())
      .then((res) => res.json())
      .then((data) => {
        const anomalies = data.anomalies || [];
        setPatterns(anomalies);
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load patterns:", err);
        setPatterns([]);
        setLoading(false);
      });
  }, [sessionId, fileId, startTime, endTime]);

  // ✅ Phase 2: Removed - now loading all patterns upfront in Phase 1
  // Client-side filtering handles the "Show Critical Only" toggle

  // ✅ FIXED: Filter and sort by importance_score
  const displayedPatterns = useMemo(() => {
    let filtered = patterns;

    // Filter based on toggle: "Show Critical Only"
    if (showCriticalOnly) {
      filtered = patterns.filter((p) => {
        // Show if: importance_score >= 90 (ERROR or CRITICAL semantic)
        // OR severity is ERROR/WARN (even if importance is lower)
        return (
          p.importance_score >= 90 ||
          p.severity === "ERROR" ||
          p.severity === "WARN"
        );
      });
    }

    // Sort: importance_score DESC, then count DESC
    return filtered.sort((a, b) => {
      if (a.importance_score !== b.importance_score) {
        return b.importance_score - a.importance_score; // Higher score first
      }
      return b.count - a.count; // Higher count first
    });
  }, [patterns, showCriticalOnly]);

  const loadSamples = async (patternSig: string) => {
    setLoadingSamples(true);
    const url = new URL(
      `/api/sessions/${sessionId}/pattern-samples`,
      window.location.origin
    );
    url.searchParams.append("patternSignature", patternSig);
    url.searchParams.append("startTime", startTime!);
    url.searchParams.append("endTime", endTime!);
    url.searchParams.append("limit", "50"); // Add limit
    if (fileId) url.searchParams.append("fileId", fileId.toString());

    try {
      const res = await fetch(url.toString());
      const data = await res.json();
      setSamples(data.samples || []);
    } catch (err) {
      console.error(err);
    }
    setLoadingSamples(false);
  };

  const handlePatternClick = (pattern: string) => {
    setSelectedPattern(pattern);
    setExpandedContext({}); // ✅ Clear cached context when opening new pattern
    loadSamples(pattern);
  };

  // ✅ NEW: Load context (±20 logs) for a specific sample
  const loadContext = async (sampleIndex: number, sample: any) => {
    // Set loading state for this specific sample
    setLoadingContext((prev) => ({ ...prev, [sampleIndex]: true }));

    try {
      // Use time-based context to get chronological logs before/after
      const url = new URL(
        `/api/sessions/${sessionId}/log-context`,
        window.location.origin
      );
      url.searchParams.append(
        "lineNumber",
        sample.line_number?.toString() || "0"
      );
      url.searchParams.append("contextLines", "10"); // ±10 seconds of context
      if (fileId) url.searchParams.append("fileId", fileId.toString());
      // DON'T filter by thread - we want to see ALL logs in the time window
      // if (sample.thread) url.searchParams.append("thread", sample.thread);

      const res = await fetch(url.toString());
      const data = await res.json();

      // Store the context logs for this sample
      setExpandedContext((prev) => ({
        ...prev,
        [sampleIndex]: data.logs || [],
      }));

      // Auto-scroll to the anchor log after a brief delay
      setTimeout(() => {
        anchorRefs.current[sampleIndex]?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      }, 100);
    } catch (err) {
      console.error("Failed to load context:", err);
      setExpandedContext((prev) => ({
        ...prev,
        [sampleIndex]: { error: "Failed to load context" },
      }));
    } finally {
      setLoadingContext((prev) => ({ ...prev, [sampleIndex]: false }));
    }
  };

  // ✅ NEW: Toggle context visibility
  const toggleContext = (sampleIndex: number, sample: any) => {
    const isExpanded = expandedContext[sampleIndex];

    if (isExpanded) {
      // Collapse - remove from expandedContext
      setExpandedContext((prev) => {
        const updated = { ...prev };
        delete updated[sampleIndex];
        return updated;
      });
    } else {
      // Expand - load context
      loadContext(sampleIndex, sample);
    }
  };

  // ✅ NEW: Ask AI about a specific log
  const askAIAboutLog = (sample: any) => {
    // Build detailed query for AI with the EXACT original log
    // Format timestamp to match log format: YYYY-MM-DD HH:MM:SS
    const date = new Date(sample.timestamp);
    const timestamp = date.getFullYear() + '-' +
                     String(date.getMonth() + 1).padStart(2, '0') + '-' +
                     String(date.getDate()).padStart(2, '0') + ' ' +
                     String(date.getHours()).padStart(2, '0') + ':' +
                     String(date.getMinutes()).padStart(2, '0') + ':' +
                     String(date.getSeconds()).padStart(2, '0');

    const query = `Analyze this log and explain what caused it:

=== LOG DETAILS ===
Timestamp: ${timestamp}
Severity: ${sample.severity}
Component: ${sample.component || "Unknown"}
${sample.thread ? `Thread: ${sample.thread}` : ""}
${sample.line_number ? `Line: ${sample.line_number}` : ""}

=== ORIGINAL LOG ===
${sample.message}

Please analyze the root cause, check for related events, and explain what happened.`;

    // Store query in sessionStorage for ChatInterface to pick up
    sessionStorage.setItem("pendingAIQuery", query);

    // Navigate to chat tab using URL parameters
    const currentUrl = new URL(window.location.href);
    currentUrl.searchParams.set("tab", "chat");
    currentUrl.searchParams.set("query", encodeURIComponent(query));

    // Use pushState to avoid full page reload
    window.history.pushState({}, "", currentUrl.toString());

    // Dispatch custom event to notify parent component
    window.dispatchEvent(
      new CustomEvent("switchTab", { detail: { tab: "chat", query } })
    );
  };

  // -- RENDER STATES --

  if (!startTime || !endTime) {
    return (
      <div className="bg-gradient-to-br from-slate-100 to-slate-200 dark:from-slate-950 dark:to-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 p-8 text-center shadow-sm">
        <p className="text-slate-500 dark:text-slate-400 font-medium">
          Click a time bucket above to view log patterns
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="bg-gradient-to-br from-slate-100 to-slate-200 dark:from-slate-950 dark:to-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 p-12 flex flex-col items-center justify-center gap-3 shadow-sm">
        <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
        <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">
          Analyzing log data...
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-slate-100 dark:bg-slate-950 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-lg overflow-hidden backdrop-blur-sm">
        {/* HEADER AREA */}
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-700 bg-gradient-to-r from-slate-50 to-slate-100 dark:from-slate-800 dark:to-slate-900 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h3 className="font-bold text-slate-900 dark:text-white text-lg flex items-center gap-2">
              Log Patterns{" "}
              <span className="opacity-50 font-normal">
                ({patterns.length})
              </span>
            </h3>
            <p className="text-xs font-mono text-slate-600 dark:text-slate-400 mt-1">
              {new Date(startTime).toLocaleTimeString()} →{" "}
              {new Date(endTime).toLocaleTimeString()} UTC
            </p>
          </div>

          {/* ✅ THE TOGGLE SWITCH */}
          <div className="flex items-center gap-3 bg-white dark:bg-slate-900 px-3 py-1.5 rounded-full border border-slate-200 dark:border-slate-700 shadow-sm">
            <div
              className="flex items-center gap-2 cursor-pointer select-none"
              onClick={() => setShowCriticalOnly(!showCriticalOnly)}
            >
              <div
                className={`w-9 h-5 rounded-full p-1 transition-colors duration-200 ease-in-out ${
                  showCriticalOnly
                    ? "bg-red-500"
                    : "bg-slate-300 dark:bg-slate-600"
                }`}
              >
                <div
                  className={`w-3 h-3 bg-white rounded-full shadow-sm transform transition-transform duration-200 ${
                    showCriticalOnly ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </div>
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                {showCriticalOnly ? "Critical Only" : "Show All Logs"}
              </span>
            </div>
          </div>
        </div>

        {/* LIST AREA */}
        <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-[500px] overflow-y-auto">
          {displayedPatterns.length === 0 ? (
            <div className="p-12 text-center text-slate-400 dark:text-slate-500 flex flex-col items-center gap-2">
              {showCriticalOnly ? (
                <>
                  <AlertCircle className="w-8 h-8 opacity-50" />
                  <p>No Errors or Warnings found.</p>
                  <button
                    onClick={() => setShowCriticalOnly(false)}
                    className="text-xs text-blue-500 hover:underline"
                  >
                    Switch to "Show All" to see info logs
                  </button>
                </>
              ) : (
                <p>No patterns found in this time range.</p>
              )}
            </div>
          ) : (
            displayedPatterns.map((p, idx) => (
              <div
                key={idx}
                onClick={() => handlePatternClick(p.pattern_signature)}
                className="p-5 hover:bg-slate-200 dark:hover:bg-slate-900 cursor-pointer transition-all duration-200 group relative"
              >
                {/* Border accent for Errors and Critical issues */}
                {(p.severity === "ERROR" || p.importance_score >= 90) && (
                  <div className="absolute left-0 top-0 bottom-0 w-1 bg-red-500" />
                )}

                <div className="flex items-start gap-3 pl-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2 flex-wrap">
                      <span
                        className={`px-2.5 py-1 text-xs font-semibold rounded-lg border ${
                          severityColors[getDisplaySeverity(p)] ||
                          severityColors.INFO
                        }`}
                      >
                        {getDisplaySeverity(p)}
                      </span>
                      <span className="text-xs text-slate-600 dark:text-slate-400 font-medium bg-slate-100 dark:bg-slate-800 px-2 py-1 rounded">
                        {p.component}
                      </span>
                      <span className="text-xs font-bold text-slate-700 dark:text-slate-300 ml-auto bg-slate-100 dark:bg-slate-800 px-2.5 py-1 rounded-lg">
                        {p.count}
                      </span>
                    </div>
                    <p
                      className="text-sm font-mono text-slate-700 dark:text-slate-300 break-all leading-relaxed line-clamp-2"
                      title={p.pattern_signature}
                    >
                      {p.pattern_signature}
                    </p>
                  </div>
                  <ChevronRight className="w-5 h-5 text-slate-300 dark:text-slate-600 group-hover:text-blue-500 dark:group-hover:text-blue-400 mt-2 transition-colors" />
                </div>
              </div>
            ))
          )}

          {/* Load More: Removed - all patterns loaded upfront */}
        </div>
      </div>

      {/* MODAL (Keep existing code) */}
      {selectedPattern && (
        <div
          className="fixed inset-0 bg-black/60 dark:bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          onClick={() => setSelectedPattern(null)}
        >
          <div
            className="bg-slate-100 dark:bg-slate-950 rounded-2xl max-w-4xl w-full max-h-[80vh] overflow-hidden shadow-2xl border border-slate-200 dark:border-slate-700 flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-700 bg-gradient-to-r from-slate-50 to-slate-100 dark:from-slate-800 dark:to-slate-900 shrink-0">
              <h3 className="font-bold text-slate-900 dark:text-white text-lg">
                Sample Logs
              </h3>
              <p className="text-xs font-mono text-slate-600 dark:text-slate-400 mt-1 truncate">
                {selectedPattern}
              </p>
            </div>

            <div className="p-6 overflow-y-auto flex-1">
              {loadingSamples ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-slate-400 dark:text-slate-500" />
                </div>
              ) : samples.length === 0 ? (
                <p className="text-center text-slate-400 dark:text-slate-500 py-12">
                  No samples found
                </p>
              ) : (
                <div className="space-y-3">
                  {samples.map((s, i) => {
                    const isExpanded = expandedContext[i];
                    const isLoading = loadingContext[i];

                    return (
                      <div
                        key={i}
                        className="border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden shadow-sm"
                      >
                        {/* Header: Timestamp + Severity */}
                        <div className="px-4 py-2 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700 flex items-center gap-3 text-xs flex-wrap">
                          <span className="text-slate-500 font-mono">
                            {new Date(s.timestamp).toLocaleTimeString()}
                          </span>
                          <span
                            className={`px-2 py-0.5 font-semibold rounded text-[10px] border ${
                              severityColors[s.severity] || severityColors.INFO
                            }`}
                          >
                            {s.severity}
                          </span>
                          {s.component && (
                            <span className="text-slate-500 font-mono">
                              {s.component}
                            </span>
                          )}
                        </div>

                        {/* Message */}
                        <div className="p-3 bg-white dark:bg-slate-900">
                          <p className="text-xs font-mono text-slate-700 dark:text-slate-300 break-all">
                            {s.message}
                          </p>
                        </div>

                        {/* ✅ ACTION BUTTONS */}
                        <div className="px-4 py-2 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-200 dark:border-slate-700 flex gap-2">
                          <button
                            onClick={() => toggleContext(i, s)}
                            disabled={isLoading}
                            className="text-xs px-3 py-1.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 text-slate-700 dark:text-slate-300 font-medium"
                          >
                            {isLoading ? (
                              <>
                                <Loader2 className="w-3 h-3 animate-spin" />
                                Loading...
                              </>
                            ) : isExpanded ? (
                              "Hide Timeline"
                            ) : (
                              "Show Timeline Context"
                            )}
                          </button>
                          <button
                            onClick={() => askAIAboutLog(s)}
                            className="text-xs px-3 py-1.5 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors flex items-center gap-1.5 font-medium"
                          >
                            Ask AI About This
                          </button>
                        </div>

                        {/* ✅ EXPANDABLE CONTEXT AREA */}
                        {isExpanded && (
                          <div className="border-t border-slate-200 dark:border-slate-700 bg-slate-900 text-slate-200 max-h-96 overflow-y-auto">
                            {Array.isArray(isExpanded) ? (
                              isExpanded.length > 0 ? (
                                <div className="p-3 space-y-0.5">
                                  {isExpanded.map((log: any, idx: number) => {
                                    const isAnchor = log.is_anchor === true;
                                    return (
                                      <div
                                        key={idx}
                                        ref={
                                          isAnchor
                                            ? (el) => {
                                                anchorRefs.current[i] = el;
                                              }
                                            : null
                                        }
                                        className={`font-mono text-[11px] px-3 py-2 rounded transition-colors ${
                                          isAnchor
                                            ? "bg-yellow-500/30 border-l-4 border-yellow-500 shadow-lg"
                                            : "hover:bg-slate-800/50"
                                        }`}
                                      >
                                        <div className="flex items-start gap-3">
                                          {/* Timestamp */}
                                          <span className="text-slate-400 font-mono text-[11px] min-w-[90px] flex-shrink-0">
                                            {log.timestamp
                                              ? new Date(
                                                  log.timestamp
                                                ).toLocaleTimeString()
                                              : ""}
                                          </span>

                                          {/* Severity Badge */}
                                          <span
                                            className={`px-1.5 py-0.5 rounded text-[10px] font-bold min-w-[50px] text-center flex-shrink-0 ${
                                              log.severity === "ERROR"
                                                ? "bg-red-500/20 text-red-400 border border-red-500/30"
                                                : log.severity === "WARN"
                                                ? "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                                                : "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                                            }`}
                                          >
                                            {log.severity}
                                          </span>

                                          {/* Anchor Indicator */}
                                          {isAnchor && (
                                            <span className="text-yellow-500 font-bold text-xs flex-shrink-0">
                                              ← SELECTED
                                            </span>
                                          )}

                                          {/* Log Message */}
                                          <span className="text-slate-300 flex-1 break-all font-mono text-[11px] leading-relaxed">
                                            {log.raw_line || log.message}
                                          </span>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : (
                                <p className="p-4 text-center text-slate-400 text-xs">
                                  No context logs found
                                </p>
                              )
                            ) : isExpanded?.error ? (
                              <p className="p-4 text-center text-red-400 text-xs">
                                {isExpanded.error}
                              </p>
                            ) : null}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-700 flex justify-end bg-slate-50 dark:bg-slate-800/50 shrink-0">
              <button
                onClick={() => setSelectedPattern(null)}
                className="px-5 py-2.5 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 rounded-lg text-sm font-semibold transition-colors"
              >
                Close Inspector
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
