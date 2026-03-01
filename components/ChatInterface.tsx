"use client";

import type React from "react";

import { useState, useRef, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Send,
  Loader2,
  User,
  AlertCircle,
  CheckCircle2,
  Clock,
  Search,
  Sparkles,
  ChevronDown,
  ChevronRight,
  Brain,
  Database,
  BookOpen,
  Wrench,
  Zap,
  Copy,
  Check,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@/types/session";
import { formatDistanceToNow } from "date-fns";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface ChatInterfaceProps {
  sessionId: string;
  className?: string;
}

interface ConversationRow {
  id: string;
  role: ChatMessage["role"];
  content: string;
  timestamp: string;
  metadata?: ChatMessage["metadata"] | null;
}

interface SourceCounts {
  tools: number;
  sql: number;
  docs: number;
}

export function ChatInterface({
  sessionId,
  className,
}: ChatInterfaceProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [agentStage, setAgentStage] = useState<{
    stage: string;
    message: string;
    workers?: string[];
  } | null>(null);
  const [agentActivities, setAgentActivities] = useState<
    Array<{
      id: string;
      kind: "tool" | "sql" | "kb";
      name: string;
      detail?: string;
    }>
  >([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchHistory() {
      try {
        const res = await fetch(`/api/sessions/${sessionId}/conversation`);
        if (!res.ok) throw new Error("Failed to load history");
        const { messages: rows } = await res.json();
        if (cancelled) return;

        setMessages(
          (rows as ConversationRow[]).map((row) => ({
            id: row.id,
            role: row.role,
            content: row.content,
            timestamp: new Date(row.timestamp),
            metadata: row.metadata ?? {},
          })),
        );
      } catch (err) {
        console.error("History load failed:", err);
      }
    }

    fetchHistory();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  // ✅ NEW: Check for pre-filled query from URL parameters or sessionStorage
  useEffect(() => {
    if (typeof window === "undefined") return;

    // First check sessionStorage (for navigation from PatternTable)
    const storedQuery = sessionStorage.getItem("pendingAIQuery");
    if (storedQuery) {
      setInput(storedQuery);
      sessionStorage.removeItem("pendingAIQuery");
      setTimeout(() => {
        textareaRef.current?.focus();
      }, 100);
      return;
    }

    // Fallback to URL parameters
    const params = new URLSearchParams(window.location.search);
    const prefilledQuery = params.get("query");

    if (prefilledQuery) {
      setInput(decodeURIComponent(prefilledQuery));

      // Clear the URL parameter (optional - keeps URL clean)
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.delete("query");
      window.history.replaceState({}, "", newUrl.toString());

      setTimeout(() => {
        textareaRef.current?.focus();
      }, 100);
    }
  }, []);

  // ✅ NEW: Listen for switchTab events to update input
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleTabSwitch = (event: CustomEvent) => {
      const { query } = event.detail;
      if (query) {
        setInput(query);
        setTimeout(() => {
          textareaRef.current?.focus();
        }, 100);
      }
    };

    window.addEventListener("switchTab", handleTabSwitch as EventListener);

    return () => {
      window.removeEventListener("switchTab", handleTabSwitch as EventListener);
    };
  }, []);

  const sendMessage = async (messageContent?: string) => {
    const message = messageContent || input;
    if (!message.trim() || isLoading) return;

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: "user",
      content: message,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);
    setAgentStage(null);
    setAgentActivities([]);

    try {
      const response = await fetch(`/api/sessions/${sessionId}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: message }),
      });

      if (!response.ok) throw new Error("Query failed");

      // Read SSE stream
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalAnswer = "";
      let finalMetadata: Partial<NonNullable<ChatMessage["metadata"]>> = {};

      if (!reader) throw new Error("No response body");

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));

            if (event.stage === "complete") {
              finalAnswer = event.answer || "";
              finalMetadata = event.metadata || {};
            } else if (event.stage === "error") {
              finalAnswer = event.answer || "An error occurred.";
            } else {
              // Progress event
              setAgentStage({
                stage: event.stage,
                message: event.message,
                workers: event.workers,
              });

              if (event.activity?.name) {
                setAgentActivities((prev) => {
                  const id = `${event.activity.kind || "tool"}:${event.activity.name}:${event.activity.detail || ""}`;
                  if (prev.some((a) => a.id === id)) return prev;

                  const next = [
                    ...prev,
                    {
                      id,
                      kind: (event.activity.kind || "tool") as
                        | "tool"
                        | "sql"
                        | "kb",
                      name: String(event.activity.name),
                      detail: event.activity.detail
                        ? String(event.activity.detail)
                        : undefined,
                    },
                  ];
                  return next.slice(-6);
                });
              }
            }
          } catch {
            // Skip malformed SSE lines
          }
        }
      }

      const assistantMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: finalAnswer || "I couldn't generate a response.",
        timestamp: new Date(),
        metadata: {
          processingTime: finalMetadata.processingTime,
          reasoning: finalMetadata.reasoning,
          toolsUsed: finalMetadata.toolsUsed,
          sqlQueries: finalMetadata.sqlQueries,
          kbKeywords: finalMetadata.kbKeywords,
          workerCount: finalMetadata.workerCount,
          successCount: finalMetadata.successCount,
        },
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch {
      const errorMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content:
          "Sorry, I encountered an error processing your query. Please try again.",
        timestamp: new Date(),
        metadata: {
          intent: "UNKNOWN",
          entities: {},
        },
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
      setAgentStage(null);
      textareaRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const liveSourceCounts = getLiveSourceCountsFromWorkers(agentStage?.workers);

  return (
    <Card
      className={cn(
        "flex h-full flex-col overflow-hidden rounded-none border-0 bg-background shadow-none",
        className,
      )}
    >
      <CardHeader className="border-b border-border/50 px-6 pb-3 pt-4">
        <CardTitle className="flex items-center gap-2.5 text-base">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-100 to-orange-100 flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-amber-600" />
          </div>
          <div className="flex-1">
            <span className="font-semibold text-foreground">Log Analyzer</span>
            <p className="text-[11px] text-muted-foreground font-normal mt-0.5">
              Ask questions about your logs in natural language
            </p>
          </div>
        </CardTitle>
      </CardHeader>

      <CardContent className="flex-1 flex flex-col p-0 overflow-hidden min-h-0">
        {/* Messages Area */}
        <ScrollArea className="flex-1 bg-gradient-to-b from-background via-background to-muted/10 px-4 py-8">
          <div className="mx-auto w-full max-w-3xl space-y-8">
            {messages.length === 0 ? (
              <EmptyState setInput={setInput} />
            ) : (
              messages.map((message) => (
                <MessageBubble key={message.id} message={message} />
              ))
            )}

            {/* Loading indicator with real-time agent activity */}
            {isLoading && (
              <div className="max-w-[92%] animate-in fade-in slide-in-from-bottom-4 duration-300 rounded-2xl border border-border/50 bg-card/80 px-3.5 py-3 backdrop-blur-sm">
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center bg-gradient-to-br from-amber-100 to-orange-100 mt-0.5">
                    <Sparkles className="w-3.5 h-3.5 text-amber-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    {/* Activity feed */}
                    <div className="space-y-1.5">
                      {/* Stage indicator */}
                      <div className="flex items-center gap-2">
                        <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />
                        <span className="text-sm font-medium text-foreground">
                          {!agentStage || agentStage.stage === "planning"
                            ? "Thinking..."
                            : agentStage.stage === "synthesizing"
                              ? "Writing response..."
                            : "Analyzing your logs..."}
                        </span>
                      </div>
                      <p className="pl-5.5 text-[11px] text-muted-foreground/70">
                        {formatSourceSummary(liveSourceCounts)}
                      </p>

                      {/* Real-time plan reasoning */}
                      {agentStage?.message &&
                        agentStage.stage === "planning" &&
                        agentStage.message !== "Planning analysis approach..." && (
                          <p className="text-xs text-muted-foreground pl-5.5 leading-relaxed animate-in fade-in duration-300">
                            {agentStage.message}
                          </p>
                        )}

                      {/* Live activity items */}
                      {agentActivities.length > 0 && (
                        <div className="pl-5.5 space-y-1 pt-0.5">
                          {agentActivities.map((activity, idx) => (
                            <div
                              key={activity.id}
                              className={cn(
                                "flex items-center gap-2 text-xs animate-in fade-in slide-in-from-left-2 duration-200",
                                idx === agentActivities.length - 1
                                  ? "text-foreground/70"
                                  : "text-muted-foreground/50",
                              )}
                            >
                              {idx === agentActivities.length - 1 ? (
                                <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                              ) : (
                                <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                              )}
                              <span>{activity.name}</span>
                              {activity.detail && (
                                <span className="text-muted-foreground/40 truncate max-w-[200px]">
                                  - {activity.detail}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </ScrollArea>

        {/* Input Area */}
        <div className="border-t border-border/50 bg-background/95 px-4 py-4 backdrop-blur supports-[backdrop-filter]:bg-background/85">
          <div className="mx-auto w-full max-w-3xl space-y-3">
            <div className="flex gap-3 items-end">
              <div className="flex-1 relative">
                <Textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                  }}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask about errors, devices, or timelines..."
                  className="resize-y min-h-[52px] max-h-[500px] rounded-2xl border-border/70 bg-card/95 px-4 py-3 text-[14px] shadow-sm focus-visible:ring-2 focus-visible:ring-primary/20"
                  rows={input.length > 200 ? 8 : 1}
                />
              </div>
              <Button
                onClick={() => sendMessage()}
                disabled={!input.trim() || isLoading}
                size="lg"
                className="h-[56px] w-[56px] shrink-0 rounded-2xl shadow-md transition-all duration-200 hover:shadow-lg disabled:opacity-50"
              >
                {isLoading ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <Send className="w-5 h-5" />
                )}
              </Button>
            </div>

          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// Message Bubble Component
interface MessageBubbleProps {
  message: ChatMessage;
}

function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex items-start gap-3 flex-row-reverse animate-in fade-in slide-in-from-bottom-2 duration-300">
        <div className="h-7 w-7 shrink-0 rounded-full bg-primary mt-0.5 flex items-center justify-center">
          <User className="w-3.5 h-3.5 text-primary-foreground" />
        </div>
        <div className="flex-1 flex flex-col items-end space-y-1 min-w-0">
          <div className="max-w-[85%] rounded-2xl rounded-tr-md bg-primary px-4 py-2.5 text-primary-foreground shadow-sm">
            <p className="text-[13.5px] leading-relaxed whitespace-pre-wrap break-words">
              {message.content}
            </p>
          </div>
          <span className="text-[11px] text-muted-foreground/50 px-1">
            {formatDistanceToNow(message.timestamp, { addSuffix: true })}
          </span>
        </div>
      </div>
    );
  }

  // Assistant message - rich card
  return <AssistantCard message={message} />;
}

const markdownComponents: Components = {
  pre({ children }) {
    return <>{children}</>;
  },
  code({ className, children }) {
    const code = String(children ?? "").replace(/\n$/, "");
    const hasLanguage = Boolean(className?.includes("language-"));
    const hasLineBreak = /\r?\n/.test(code);
    const isLongSingleLine = code.length > 120;

    if (hasLanguage || hasLineBreak || isLongSingleLine) {
      const language = className?.replace("language-", "").trim() || "text";
      return <MarkdownCodeBlock code={code} language={language} />;
    }
    return (
      <code className="rounded bg-muted/70 px-1.5 py-0.5 text-[12.5px] text-foreground">
        {code}
      </code>
    );
  },
  table({ children }) {
    return (
      <div className="my-4 overflow-x-auto rounded-lg border border-border/40">
        <table className="w-full">{children}</table>
      </div>
    );
  },
  a({ href, children }) {
    const isExternal = href?.startsWith("http");
    return (
      <a
        href={href}
        target={isExternal ? "_blank" : undefined}
        rel={isExternal ? "noopener noreferrer" : undefined}
      >
        {children}
      </a>
    );
  },
};

function normalizeAssistantMarkdown(content: string): string {
  return content.replace(
    /```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)\r?\n```/g,
    (block, _language, body) => {
      const trimmed = String(body ?? "").replace(/\r/g, "").trim();
      if (!trimmed) return block;
      if (/\r?\n/.test(trimmed)) return block;
      if (trimmed.length > 48) return block;
      if (trimmed.includes("`")) return block;
      if (!/[a-zA-Z0-9]/.test(trimmed)) return block;
      return `\`${trimmed}\``;
    },
  );
}

function MarkdownCodeBlock({
  code,
  language,
}: {
  code: string;
  language: string;
}) {
  const [copied, setCopied] = useState(false);
  const label = (language || "text").toLowerCase();

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="my-4 overflow-hidden rounded-xl border border-slate-700/40 bg-slate-950 shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-700/40 bg-slate-900/80 px-3 py-1.5">
        <span className="text-[10px] uppercase tracking-wide text-slate-300">
          {label}
        </span>
        <button
          onClick={handleCopy}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-slate-300 transition-colors hover:bg-slate-800 hover:text-slate-100"
          title="Copy code"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 text-emerald-400" />
              Copied
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              Copy
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 py-3 text-[12.5px] leading-relaxed text-slate-100">
        <code>{code}</code>
      </pre>
    </div>
  );
}

// Rich assistant response card - Claude/ChatGPT style
function AssistantCard({ message }: { message: ChatMessage }) {
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const meta = message.metadata;
  const renderedContent = normalizeAssistantMarkdown(message.content);
  const analysisTaskCount = meta?.workerCount || 0;
  const completedTaskCount = meta?.successCount || 0;
  const finalSourceCounts = getSourceCountsFromMetadata(meta);
  const hasAgentMeta =
    meta?.reasoning ||
    (meta?.toolsUsed && meta.toolsUsed.length > 0) ||
    (meta?.sqlQueries && meta.sqlQueries.length > 0);

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const formatTime = (ms?: number) => {
    if (!ms) return null;
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  return (
    <div className="flex items-start gap-3 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center bg-gradient-to-br from-amber-100 to-orange-100 mt-0.5">
        <Sparkles className="w-3.5 h-3.5 text-amber-600" />
      </div>

      <div className="flex-1 min-w-0 space-y-1">
        {/* Collapsible agent thinking */}
        {hasAgentMeta && (
          <button
            onClick={() => setThinkingOpen(!thinkingOpen)}
            className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors mb-1"
          >
            {thinkingOpen ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
            <Brain className="w-3 h-3" />
            <span>{formatSourceSummary(finalSourceCounts)}</span>
            <span className="text-muted-foreground/50">
              ({completedTaskCount}/{analysisTaskCount} tasks)
            </span>
            {meta?.processingTime && (
              <span className="text-muted-foreground/50">
                &middot; {formatTime(meta.processingTime)}
              </span>
            )}
          </button>
        )}

        {thinkingOpen && hasAgentMeta && (
          <div className="rounded-lg bg-muted/50 border border-border/50 px-3.5 py-3 mb-2 space-y-2.5 text-xs animate-in fade-in slide-in-from-top-1 duration-200">
            {meta?.reasoning && (
              <p className="text-muted-foreground leading-relaxed">
                {meta.reasoning}
              </p>
            )}
            <div className="flex flex-wrap gap-1.5">
              {meta?.toolsUsed?.map((tool) => (
                <span key={tool} className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 border border-blue-200/60">
                  <Wrench className="w-2.5 h-2.5" />
                  {friendlyToolLabel(tool)}
                </span>
              ))}
              {meta?.sqlQueries?.map((q, i) => (
                <span key={i} className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-200/60">
                  <Database className="w-2.5 h-2.5" />
                  {q}
                </span>
              ))}
              {meta?.kbKeywords && meta.kbKeywords.length > 0 && (
                <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-violet-50 text-violet-600 border border-violet-200/60">
                  <BookOpen className="w-2.5 h-2.5" />
                  Docs: {meta.kbKeywords.slice(0, 3).join(", ")}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Markdown response body */}
        <div className="agent-response prose prose-slate prose-sm max-w-none
          [&>*:first-child]:mt-0 [&>*:last-child]:mb-0

          prose-headings:text-foreground prose-headings:font-semibold prose-headings:tracking-tight
          prose-h1:text-lg prose-h1:mt-6 prose-h1:mb-3
          prose-h2:text-[15px] prose-h2:mt-7 prose-h2:mb-3 prose-h2:pb-2 prose-h2:border-b prose-h2:border-border/40
          prose-h3:text-[14px] prose-h3:mt-5 prose-h3:mb-2 prose-h3:text-foreground/90
          prose-h4:text-xs prose-h4:mt-4 prose-h4:mb-1.5 prose-h4:font-semibold prose-h4:uppercase prose-h4:tracking-wider prose-h4:text-muted-foreground

          prose-p:text-[13.5px] prose-p:text-foreground/80 prose-p:leading-[1.75] prose-p:my-3

          prose-strong:text-foreground prose-strong:font-semibold
          prose-em:text-foreground/60

          prose-ul:my-3 prose-ul:pl-0 prose-ol:my-3 prose-ol:pl-0
          prose-li:text-[13.5px] prose-li:text-foreground/80 prose-li:leading-[1.75] prose-li:my-1
          prose-li:marker:text-muted-foreground/50

          prose-code:text-[12.5px] prose-code:text-foreground prose-code:bg-muted/70 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:font-normal prose-code:before:content-none prose-code:after:content-none

          prose-a:text-primary prose-a:font-medium prose-a:no-underline hover:prose-a:underline

          prose-hr:border-border/40 prose-hr:my-6

          prose-blockquote:border-l-[3px] prose-blockquote:border-primary/30 prose-blockquote:bg-primary/[0.03] prose-blockquote:rounded-r-lg prose-blockquote:pl-4 prose-blockquote:pr-3 prose-blockquote:py-2 prose-blockquote:text-foreground/60 prose-blockquote:not-italic prose-blockquote:my-4

          prose-table:my-4 prose-table:text-[12.5px] prose-table:w-full
          prose-table:rounded-lg prose-table:overflow-hidden prose-table:border prose-table:border-border/40 prose-table:bg-card
          prose-thead:bg-muted/60
          prose-th:text-foreground prose-th:font-semibold prose-th:px-4 prose-th:py-2.5 prose-th:text-left prose-th:text-xs prose-th:uppercase prose-th:tracking-wider
          prose-td:text-foreground/70 prose-td:px-4 prose-td:py-2.5 prose-td:border-t prose-td:border-border/30
        ">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={markdownComponents}
          >
            {renderedContent}
          </ReactMarkdown>
        </div>

        {/* Action bar */}
        <div className="flex items-center gap-1 pt-1">
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 text-[11px] text-muted-foreground/50 hover:text-muted-foreground transition-colors px-2 py-1 rounded-md hover:bg-muted/50"
            title="Copy response"
          >
            {copied ? (
              <>
                <Check className="w-3 h-3 text-emerald-500" />
                <span className="text-emerald-500">Copied</span>
              </>
            ) : (
              <>
                <Copy className="w-3 h-3" />
                <span>Copy</span>
              </>
            )}
          </button>
          {!hasAgentMeta && meta?.processingTime && (
            <span className="text-[11px] text-muted-foreground/40 flex items-center gap-1 px-2">
              <Zap className="w-3 h-3" />
              {formatTime(meta.processingTime)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function getLiveSourceCountsFromWorkers(workers?: string[]): SourceCounts {
  if (!workers || workers.length === 0) {
    return { tools: 0, sql: 0, docs: 0 };
  }

  let sql = 0;
  let docs = 0;
  let tools = 0;

  for (const worker of workers) {
    if (worker === "sql_query") {
      sql += 1;
      continue;
    }
    if (worker === "knowledge_base") {
      docs += 1;
      continue;
    }
    tools += 1;
  }

  return { tools, sql, docs };
}

function getSourceCountsFromMetadata(
  meta?: ChatMessage["metadata"],
): SourceCounts {
  return {
    tools: meta?.toolsUsed?.length || 0,
    sql: meta?.sqlQueries?.length || 0,
    docs: meta?.kbKeywords && meta.kbKeywords.length > 0 ? 1 : 0,
  };
}

function formatSourceSummary(counts: SourceCounts): string {
  return `Sources - Tools ${counts.tools} - SQL ${counts.sql} - Docs ${counts.docs}`;
}

// Short labels for tools in the reasoning badges
function friendlyToolLabel(tool: string): string {
  const map: Record<string, string> = {
    get_file_overview: "File Overview",
    get_logs: "Log Query",
    get_errors_with_stack_traces: "Stack Traces",
    get_exception_summary: "Exceptions",
    detect_anomalies: "Anomalies",
    get_pattern_examples: "Patterns",
    get_correlated_events: "Correlations",
    get_thread_context: "Thread Context",
    get_time_series: "Time Series",
    get_device_summary: "Device Health",
    get_log_by_line_number: "Line Lookup",
    list_session_files: "File List",
  };
  return map[tool] || tool.replace(/_/g, " ");
}

// Empty State Component
function EmptyState({ setInput }: { setInput: (value: string) => void }) {
  const examples = [
    {
      title: "Find a specific error",
      query: "Show me errors with exception 'UsernameNotFoundException'",
    },
    {
      title: "Analyze a device",
      query: "Analyze device 3003 for anomalies in the last 2 hours",
    },
    {
      title: "Get an overview",
      query: "Give me an overview of all events",
    },
    {
      title: "Check recent activity",
      query: "What happened between 10:25 and 10:30 AM?",
    },
  ];

  return (
    <div className="flex flex-col items-center justify-center py-12 text-center animate-in fade-in duration-500">
      <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-amber-100 to-orange-100 flex items-center justify-center mb-6 shadow-sm">
        <Sparkles className="w-8 h-8 text-amber-600" />
      </div>
      <h3 className="text-xl font-semibold mb-2">Ready for Analysis</h3>
      <p className="text-sm text-muted-foreground mb-8 max-w-md leading-relaxed">
        Query your logs using natural language, or try an example below.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full max-w-2xl mt-4">
        {examples.map((example, i) => (
          <button
            key={i}
            onClick={() => setInput(example.query)}
            className="w-full text-left p-4 rounded-xl bg-card border border-border/50 hover:border-primary/40 hover:shadow-md transition-all duration-200 cursor-pointer group"
          >
            <p className="font-semibold text-sm text-foreground mb-1 group-hover:text-primary transition-colors">
              {example.title}
            </p>
            <p className="text-xs text-muted-foreground">
              &quot;{example.query}&quot;
            </p>
          </button>
        ))}
      </div>
    </div>
  );
}


