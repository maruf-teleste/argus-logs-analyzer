"use client";

import type React from "react";
import { useState, useEffect } from "react";
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
import type { ProactiveInsight } from "@/lib/ai/proactive-insights";

export default function LogAnalyzerDashboard() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null);
  const [isLoadingSessions, setIsLoadingSessions] = useState(true);
  const [activeTab, setActiveTab] = useState<"chat" | "analysis">("chat");
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [proactiveSuggestions, setProactiveSuggestions] = useState<ProactiveInsight[]>([]);

  useEffect(() => {
    loadSessions();
  }, []);

  useEffect(() => {
    if (selectedSession) {
      loadSessionStats(selectedSession.id);
      if (selectedSession.files.length > 0) {
        loadProactiveSuggestions(selectedSession.id);
        setActiveTab("chat");
      } else {
        setProactiveSuggestions([]);
      }
    }
  }, [selectedSession]);

  const loadSessions = async () => {
    setIsLoadingSessions(true);
    try {
      const response = await fetch("/api/sessions");
      if (!response.ok) throw new Error("Failed to load sessions");
      const data = await response.json();
      const normalized = (data.sessions ?? []).map((s) => ({
        ...s,
        createdAt: new Date(s.createdAt),
        expiresAt: new Date(s.expiresAt),
        files: (s.files ?? []).map((f) => ({
          ...f,
          uploadedAt: f.uploadedAt ? new Date(f.uploadedAt) : undefined,
        })),
      }));
      setSessions(normalized);
      // Automatically select the first session if available
      if (normalized.length > 0 && !selectedSession) {
        setSelectedSession(normalized[0]);
      }
      return normalized; // Return the sessions
    } catch (error) {
      console.error("Error loading sessions:", error);
    } finally {
      setIsLoadingSessions(false);
    }
  };

  const loadProactiveSuggestions = async (sessionId: string) => {
    try {
      const response = await fetch(`/api/sessions/${sessionId}/summary`);
      if (response.ok) {
        const data = await response.json();
        setProactiveSuggestions(data.insights || []);
      } else {
        setProactiveSuggestions([]);
      }
    } catch (error) {
      console.error("Error fetching proactive suggestions:", error);
      setProactiveSuggestions([]);
    }
  };

  const loadSessionStats = async (sessionId: string) => {
    if (!selectedSession || selectedSession.files.length === 0) return;
    try {
      const fileId = selectedSession.files[0].id;
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
    try {
      const response = await fetch(`/api/sessions/${sessionId}/delete`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Failed to delete session");
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      if (selectedSession?.id === sessionId) {
        setSelectedSession(sessions.length > 1 ? sessions[0] : null);
      }
    } catch (error) {
      console.error("Error deleting session:", error);
    }
  };

  const handleSessionSelect = (sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    if (session) {
      setSelectedSession(session);
    }
  };

  const handleFileUploadComplete = async () => {
    const allSessions = await loadSessions();
    if (allSessions && selectedSession) {
      const updatedSession = allSessions.find((s) => s.id === selectedSession.id);
      setSelectedSession(updatedSession || null);

      // Fetch proactive suggestions
      if (updatedSession) {
        await loadProactiveSuggestions(updatedSession.id);
      }
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
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)} className="flex-1 flex flex-col min-h-0">
            {selectedSession.files.length > 0 && (
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
              {selectedSession.files.length === 0 ? (
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
                      proactiveSuggestions={proactiveSuggestions}
                      clearSuggestions={() => setProactiveSuggestions([])}
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
                      fileId={selectedSession.files[0].id}
                    />
                  </TabsContent>
                </>
              )}
            </div>
          </Tabs>
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
