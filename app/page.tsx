"use client";

import type React from "react";
import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SessionList } from "@/components/SessionCard";
import { FileUpload } from "@/components/FileUpload";
import { ChatInterface } from "@/components/ChatInterface";
import { LogAnalysis } from "@/components/LogAnalysis";
import {
  Plus,
  Database,
  MessageSquare,
  Sparkles,
  AlertCircle,
  FileText,
  BarChart3,
  Menu,
  X,
  Loader2,
} from "lucide-react";
import type { Session } from "@/types/session";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import Image from "next/image";
import { cn } from "@/lib/utils";
export default function LogAnalyzerDashboard() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null);
  const [isLoadingSessions, setIsLoadingSessions] = useState(true);
  const [activeTab, setActiveTab] = useState<"chat" | "analysis">("chat");
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isPreparingFile, setIsPreparingFile] = useState(false);

  // Tracks whether an upload is in progress so we can poll independently
  const uploadInProgressRef = useRef(false);

  // Ref to avoid stale closure in callbacks captured by long-running XHRs
  const selectedSessionRef = useRef(selectedSession);
  selectedSessionRef.current = selectedSession;

  // Fetch and normalize sessions from the API.
  // Does NOT auto-select or set isLoadingSessions — callers control that.
  const fetchSessions = useCallback(async (): Promise<Session[] | null> => {
    try {
      const response = await fetch("/api/sessions", { cache: "no-store" });
      if (!response.ok) throw new Error("Failed to load sessions");
      const data = await response.json();
      return (data.sessions ?? []).map((s: any) => ({
        ...s,
        createdAt: new Date(s.createdAt),
        expiresAt: new Date(s.expiresAt),
        files: (s.files ?? []).map((f: any) => ({
          ...f,
          uploadedAt: f.uploadedAt ? new Date(f.uploadedAt) : undefined,
        })),
      }));
    } catch (error) {
      console.error("Error fetching sessions:", error);
      return null;
    }
  }, []);

  const loadSessions = async () => {
    setIsLoadingSessions(true);
    try {
      const normalized = await fetchSessions();
      if (!normalized) return undefined;
      setSessions(normalized);
      if (normalized.length > 0 && !selectedSessionRef.current) {
        setSelectedSession(normalized[0]);
      }
      return normalized;
    } finally {
      setIsLoadingSessions(false);
    }
  };

  useEffect(() => {
    loadSessions();
  }, []);

  useEffect(() => {
    if (selectedSession) {
      loadSessionStats(selectedSession.id);
      if (selectedSession.files.some((f) => f.status === "ready")) {
        setActiveTab("chat");
      }
    }
  }, [selectedSession]);

  useEffect(() => {
    const handleTabSwitch = (event: CustomEvent) => {
      const { tab } = event.detail;
      if (tab === "chat" || tab === "analysis") {
        setActiveTab(tab);
      }
    };

    window.addEventListener("switchTab", handleTabSwitch as EventListener);

    return () => {
      window.removeEventListener("switchTab", handleTabSwitch as EventListener);
    };
  }, []);

  // ── Failsafe: independently poll for file readiness ──
  // When an upload is in progress and the current session has no files,
  // poll every 3s to detect when the file becomes ready. This catches
  // cases where the SSE → callback chain fails through ALB.
  useEffect(() => {
    const session = selectedSession;
    if (!session || session.files.some((f) => f.status === "ready")) return;

    const interval = setInterval(async () => {
      if (!uploadInProgressRef.current) return; // no upload, skip

      try {
        const res = await fetch(
          `/api/sessions/${session.id}/upload-status?s3Key=check`,
          { cache: "no-store" }
        );
        const data = await res.json();

        if (data.status === "complete") {
          console.log("[failsafe] File ready detected via polling");
          uploadInProgressRef.current = false;

          const allSessions = await fetchSessions();
          if (allSessions) {
            const updated = allSessions.find((s) => s.id === session.id);
            if (updated && updated.files.some((f) => f.status === "ready")) {
              setSessions(allSessions);
              setSelectedSession(updated);
              setIsPreparingFile(false);
            }
          }
        }
      } catch {
        // Network error — next poll will retry
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [selectedSession, fetchSessions]);

  const loadSessionStats = async (sessionId: string) => {
    if (!selectedSession) return;
    const readyFile = selectedSession.files.find((f) => f.status === "ready");
    if (!readyFile) return;
    try {
      const fileId = readyFile.id;
      const response = await fetch(
        `/api/sessions/${sessionId}/stats?fileId=${fileId}`
      );
      if (!response.ok) throw new Error("Failed to load stats");
      const data = await response.json();
      setSessionStats(data);
    } catch (error) {
      console.error("Error loading stats:", error);
    }
  };

  const createNewSession = async () => {
    try {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `Session ${new Date().toLocaleDateString()}`,
        }),
      });
      if (!response.ok) throw new Error("Failed to create session");
      const data = await response.json();
      const newSession: Session = {
        id: data.sessionId,
        name: `Session ${new Date().toLocaleDateString()}`,
        createdAt: new Date(),
        createdBy: "User",
        expiresAt: new Date(data.expiresAt),
        files: [],
        totalLines: 0,
        totalErrors: 0,
        totalWarnings: 0,
        status: "active",
      };
      setSessions((prev) => [newSession, ...prev]);
      setSelectedSession(newSession);
    } catch (error) {
      console.error("Error creating session:", error);
    }
  };

  const deleteSession = async (sessionId: string) => {
    if (!confirm("Are you sure you want to delete this session?")) return;

    // Optimistic UI update — remove immediately, revert on error
    const previousSessions = sessions;
    const previousSelected = selectedSession;

    setSessions((prev) => {
      const remaining = prev.filter((s) => s.id !== sessionId);
      if (selectedSession?.id === sessionId) {
        setSelectedSession(remaining.length > 0 ? remaining[0] : null);
      }
      return remaining;
    });

    try {
      const response = await fetch(`/api/sessions/${sessionId}/delete`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Failed to delete session");
    } catch (error) {
      console.error("Error deleting session, reverting:", error);
      // Revert on failure
      setSessions(previousSessions);
      setSelectedSession(previousSelected);
    }
  };

  const handleSessionSelect = (sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    if (session) {
      setSelectedSession(session);
    }
  };

  const handleFileUploadComplete = async () => {
    const current = selectedSessionRef.current;
    if (!current) return;

    console.log("[upload-complete] Callback fired for session:", current.id);
    uploadInProgressRef.current = false; // SSE chain worked, stop failsafe polling
    setIsPreparingFile(true);

    try {
      // 1. Verify the file is fully processed and AI-ready before transitioning.
      let fileReady = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          const res = await fetch(
            `/api/sessions/${current.id}/upload-status?s3Key=check`,
            { cache: "no-store" }
          );
          const data = await res.json();
          console.log(`[upload-complete] upload-status attempt ${attempt}:`, data.status);
          if (data.status === "complete") { fileReady = true; break; }
          if (data.status === "error") break;
        } catch (err) {
          console.warn("[upload-complete] upload-status fetch error:", err);
        }
        await new Promise((r) => setTimeout(r, 1000));
      }

      if (!fileReady) {
        console.warn("[upload-complete] File not ready after polling, proceeding anyway");
      }

      // 2. Fetch session data with retries — ALB might return stale data on first try
      let updatedSession: Session | null = null;
      for (let retry = 0; retry < 3; retry++) {
          const allSessions = await fetchSessions();
          if (allSessions) {
            setSessions(allSessions);
            const found = allSessions.find((s) => s.id === current.id);
            if (found && found.files.some((f) => f.status === "ready")) {
              updatedSession = found;
              console.log("[upload-complete] Session found with ready files");
              break;
            }
          }
        console.log(`[upload-complete] Retry ${retry + 1}: session has no files yet, waiting...`);
        await new Promise((r) => setTimeout(r, 2000));
      }

      if (updatedSession) {
        setSelectedSession(updatedSession);
      } else {
        console.error("[upload-complete] Failed to find session with files after retries");
        // Failsafe polling effect will continue trying
        uploadInProgressRef.current = true;
      }
    } finally {
      setIsPreparingFile(false);
    }
  };

  return (
    <div className="flex h-screen bg-background text-foreground">
      {/* Sidebar */}
      <aside
        className={cn(
          "bg-card border-r border-border/60 flex flex-col transition-all duration-300 ease-in-out",
          isSidebarOpen ? "w-80" : "w-0"
        )}
      >
        <div className="flex items-center justify-between h-20 border-b border-border/60 p-4">
          <div className="flex items-center gap-2">
            <Image
              src="/Teleste_logo_blue.svg"
              alt="Argus Log Analyzer"
              width={32}
              height={32}
            />
            <h1 className="text-lg font-semibold">Argus</h1>
          </div>
          <Button variant="ghost" size="icon" onClick={createNewSession}>
            <Plus className="w-5 h-5" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          <SessionList
            sessions={sessions}
            selectedSessionId={selectedSession?.id}
            onSelectSession={handleSessionSelect}
            onDeleteSession={deleteSession}
            isLoading={isLoadingSessions}
            emptyMessage="No sessions yet."
          />
        </div>
        <div className="p-4 border-t border-border/60">
          <Button variant="outline" className="w-full" onClick={loadSessions}>
            Refresh Sessions
          </Button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-h-0">
        <header className="flex items-center justify-between h-20 border-b border-border/60 px-6 flex-shrink-0">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            >
              {isSidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </Button>
            <div>
              <h2 className="text-xl font-semibold">
                {selectedSession
                  ? selectedSession.files?.length > 0
                    ? selectedSession.files[0].name
                    : "New Session"
                  : "Welcome"}
              </h2>
              <p className="text-sm text-muted-foreground">
                AI-Powered Network Device Log Analysis
              </p>
            </div>
          </div>
        </header>

        {selectedSession ? (
          (() => {
            const readyFile = selectedSession.files.find((f) => f.status === "ready");
            const hasReadyFile = Boolean(readyFile);
            return (
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)} className="flex-1 flex flex-col min-h-0">
            {hasReadyFile && (
              <div className="px-6 py-4 border-b border-border/60">
                <TabsList>
                  <TabsTrigger value="chat" className="gap-2">
                    <MessageSquare className="w-4 h-4" />
                    AI Chat
                    <Sparkles className="w-3 h-3 text-yellow-400" />
                  </TabsTrigger>
                  <TabsTrigger value="analysis" className="gap-2">
                    <BarChart3 className="w-4 h-4" />
                    Analysis
                  </TabsTrigger>
                </TabsList>
              </div>
            )}

            <div className="flex-1 overflow-y-auto">
              {isPreparingFile ? (
                <div className="flex flex-col items-center justify-center h-full text-center p-6 gap-4">
                  <Loader2 className="w-8 h-8 text-primary animate-spin" />
                  <div>
                    <h3 className="text-lg font-semibold">Preparing your analysis...</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      Verifying file is ready for AI queries
                    </p>
                  </div>
                </div>
              ) : !hasReadyFile ? (
                <div className="flex flex-col items-center justify-center h-full text-center p-6">
                    <Card className="w-full max-w-lg">
                        <CardHeader>
                            <CardTitle>Upload a Log File</CardTitle>
                            <CardDescription>
                                To get started, upload a log file to this session.
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <FileUpload
                                sessionId={selectedSession.id}
                                onUploadStart={() => { uploadInProgressRef.current = true; }}
                                onUploadComplete={handleFileUploadComplete}
                                onUploadError={(err) => console.error("Upload error:", err)}
                            />
                        </CardContent>
                    </Card>
                </div>
              ) : (
                <>
                  <TabsContent value="chat" className="h-full">
                    <ChatInterface
                      sessionId={selectedSession.id}
                    />
                  </TabsContent>
                  <TabsContent value="analysis" className="p-6">
                    {sessionStats && (
                        <Card className="mb-6">
                        <CardHeader>
                            <CardTitle>Session Stats</CardTitle>
                        </CardHeader>
                        <CardContent className="flex items-center gap-6 text-sm">
                            <span className="flex items-center gap-1.5">
                            <FileText className="w-4 h-4 text-muted-foreground" />
                            {sessionStats.totalLines.toLocaleString()} lines
                            </span>
                            <span className="flex items-center gap-1.5 text-red-500">
                            <AlertCircle className="w-4 h-4" />
                            {sessionStats.totalErrors.toLocaleString()} errors
                            </span>
                        </CardContent>
                        </Card>
                    )}
                    <LogAnalysis
                      sessionId={selectedSession.id}
                      fileId={readyFile?.id}
                    />
                  </TabsContent>
                </>
              )}
            </div>
          </Tabs>
            );
          })()
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-6">
            <div className="flex items-center gap-4 mb-4">
              <Image
                src="/Teleste_logo_blue.svg"
                alt="Argus Log Analyzer"
                width={64}
                height={64}
              />
            </div>
            <h1 className="text-3xl font-bold mb-2">Welcome to Argus</h1>
            <p className="text-muted-foreground max-w-md">
              Create a new session or select an existing one from the sidebar to begin analyzing your log files.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}

// Types
interface SessionStats {
  fileCount: number;
  totalLines: number;
  totalErrors: number;
  totalWarnings: number;
  deviceCount: number;
  timeRange: {
    start: string | null;
    end: string | null;
  };
  topDevices: Array<{ device: string; errorCount: number }>;
  topExceptions: Array<{ exception: string; count: number }>;
}
