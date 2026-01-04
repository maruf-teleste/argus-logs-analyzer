"use client";

import type React from "react";

import { useState, useRef, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Send,
  Loader2,
  Bot,
  User,
  AlertCircle,
  CheckCircle2,
  Clock,
  Search,
  Sparkles,
  FileSearch,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatMessage, QueryIntent } from "@/types/session";
import { formatDistanceToNow } from "date-fns";
import type { ProactiveInsight } from "@/lib/ai/proactive-insights";

interface ChatInterfaceProps {
  sessionId: string;
  className?: string;
  proactiveSuggestions?: ProactiveInsight[];
  clearSuggestions?: () => void;
}

export function ChatInterface({
  sessionId,
  className,
  proactiveSuggestions = [],
  clearSuggestions = () => {},
}: ChatInterfaceProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isSuggestionsLoading, setIsSuggestionsLoading] = useState(true); // New state

  useEffect(() => {
    if (proactiveSuggestions && proactiveSuggestions.length > 0) {
      setIsSuggestionsLoading(false);
    } else if (proactiveSuggestions && proactiveSuggestions.length === 0) {
      setIsSuggestionsLoading(false); // No suggestions, but done loading
    } else {
      setIsSuggestionsLoading(true); // Still loading or no data yet
    }
  }, [proactiveSuggestions]);

  useEffect(() => {
    let cancelled = false;

    async function fetchHistory() {
      try {
        const res = await fetch(`/api/sessions/${sessionId}/conversation`);
        if (!res.ok) throw new Error("Failed to load history");
        const { messages: rows } = await res.json();
        if (cancelled) return;

        setMessages(
          (rows as any[]).map((row) => ({
            id: row.id,
            role: row.role,
            content: row.content,
            timestamp: new Date(row.timestamp),
            metadata: row.metadata ?? {},
          }))
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

    clearSuggestions();

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: "user",
      content: message,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);

    try {
      const response = await fetch(`/api/sessions/${sessionId}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: message }),
      });

      if (!response.ok) throw new Error("Query failed");

      const data = await response.json();

      const assistantMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: data.answer,
        timestamp: new Date(),
        metadata: {
          intent: data.intent,
          entities: data.entities,
          resultCount: data.events?.length || 0,
          processingTime: data.metadata?.processingTime,
        },
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (error) {
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
      textareaRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const getIntentBadge = (intent?: QueryIntent) => {
    if (!intent || intent === "UNKNOWN") return null;

    const intentConfig = {
      ROOT_CAUSE: {
        label: "Root Cause",
        className: "bg-red-500/10 text-red-400 border-red-500/30",
      },
      DEVICE_OVERVIEW: {
        label: "Device Overview",
        className: "bg-blue-500/10 text-blue-400 border-blue-500/30",
      },
      ERROR_SEARCH: {
        label: "Error Search",
        className: "bg-yellow-500/10 text-yellow-400 border-yellow-500/30",
      },
      TIMELINE: {
        label: "Timeline",
        className: "bg-purple-500/10 text-purple-400 border-purple-500/30",
      },
      ANALYSIS: {
        label: "Analysis",
        className: "bg-green-500/10 text-green-400 border-green-500/30",
      },
    };

    const config = intentConfig[intent];
    if (!config) return null;

    return (
      <Badge variant="outline" className={cn("text-xs", config.className)}>
        {config.label}
      </Badge>
    );
  };

  return (
    <Card className={cn("flex flex-col h-full overflow-hidden", className)}>
      <CardHeader className="pb-4 border-b bg-gradient-to-br from-background to-muted/20">
        <CardTitle className="flex items-center gap-2.5 text-lg">
          <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center ring-2 ring-primary/20">
            <Bot className="w-5 h-5 text-primary" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <span>AI Log Analyzer</span>
              <Sparkles className="w-4 h-4 text-yellow-500 animate-pulse" />
            </div>
            <p className="text-xs text-muted-foreground font-normal mt-0.5">
              Ask questions about your logs in natural language
            </p>
          </div>
        </CardTitle>
      </CardHeader>

      <CardContent className="flex-1 flex flex-col p-0 overflow-hidden min-h-0">
        {/* Messages Area */}
        <ScrollArea className="flex-1 px-4 py-6">
          <div className="space-y-6 max-w-4xl mx-auto">
            {messages.length === 0 ? (
              <EmptyState
                setInput={setInput}
              />
            ) : (
              messages.map((message, index) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  getIntentBadge={getIntentBadge}
                  isLatest={index === messages.length - 1}
                />
              ))
            )}

            {/* Loading indicator */}
            {isLoading && (
              <div className="flex items-start gap-3 animate-in fade-in slide-in-from-bottom-4 duration-300">
                <div className="flex-shrink-0 w-9 h-9 rounded-full bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center ring-2 ring-primary/10">
                  <Bot className="w-5 h-5 text-primary" />
                </div>
                <div className="flex-1 mt-1">
                  <div className="bg-muted/50 backdrop-blur-sm rounded-2xl rounded-tl-sm p-4 inline-block shadow-sm">
                    <div className="flex items-center gap-2">
                      <Loader2 className="w-4 h-4 text-primary animate-spin" />
                      <span className="text-sm text-muted-foreground">
                        Analyzing...
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </ScrollArea>

        {/* Input Area */}
        <div className="p-4 border-t bg-gradient-to-br from-background to-muted/10 backdrop-blur-sm">
          <div className="max-w-4xl mx-auto space-y-3">
            {/* Proactive Suggestions Area */}
            {isSuggestionsLoading ? (
              <div className="w-full max-w-lg mb-4 text-center">
                <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wide flex items-center justify-center gap-2">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Analyzing for suggestions...
                </p>
              </div>
            ) : proactiveSuggestions.length > 0 && (
              <SuggestionChips
                suggestions={proactiveSuggestions}
                onSuggestionClick={(query) => {
                  setInput(query);
                  sendMessage(query);
                }}
              />
            )}

            <div className="flex gap-3 items-end">
              <div className="flex-1 relative">
                <Textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask about errors, devices, or timelines..."
                  className="resize-y min-h-[56px] max-h-[500px] rounded-xl border-border/50 focus-visible:ring-2 focus-visible:ring-primary/20 shadow-sm"
                  rows={input.length > 200 ? 8 : 1}
                />
              </div>
              <Button
                onClick={sendMessage}
                disabled={!input.trim() || isLoading}
                size="lg"
                className="h-[56px] w-[56px] rounded-xl shadow-md hover:shadow-lg transition-all duration-200 disabled:opacity-50 flex-shrink-0"
              >
                {isLoading ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <Send className="w-5 h-5" />
                )}
              </Button>
            </div>

            {/* Quick Actions */}
            <div className="flex flex-wrap gap-2">
              <QuickActionButton
                onClick={() => setInput("Show me all errors")}
                icon={<AlertCircle className="w-3.5 h-3.5" />}
              >
                Show Errors
              </QuickActionButton>
              <QuickActionButton
                onClick={() => setInput("Give me an overview")}
                icon={<Search className="w-3.5 h-3.5" />}
              >
                Overview
              </QuickActionButton>
              <QuickActionButton
                onClick={() => setInput("What happened in the last hour?")}
                icon={<Clock className="w-3.5 h-3.5" />}
              >
                Recent Activity
              </QuickActionButton>
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
  getIntentBadge: (intent?: QueryIntent) => React.ReactNode;
  isLatest?: boolean;
}

function MessageBubble({
  message,
  getIntentBadge,
  isLatest,
}: MessageBubbleProps) {
  const isUser = message.role === "user";

  return (
    <div
      className={cn(
        "flex items-start gap-3 animate-in fade-in slide-in-from-bottom-2 duration-300",
        isUser && "flex-row-reverse"
      )}
    >
      {/* Avatar */}
      <div
        className={cn(
          "flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center ring-2 shadow-sm",
          isUser
            ? "bg-gradient-to-br from-primary to-primary/80 ring-primary/20"
            : "bg-gradient-to-br from-muted to-muted/50 ring-border/50"
        )}
      >
        {isUser ? (
          <User className="w-5 h-5 text-primary-foreground" />
        ) : (
          <Bot className="w-5 h-5 text-foreground" />
        )}
      </div>

      {/* Message Content */}
      <div
        className={cn(
          "flex-1 space-y-2 min-w-0",
          isUser && "flex flex-col items-end"
        )}
      >
        <div
          className={cn(
            "rounded-2xl p-4 max-w-[85%] inline-block shadow-sm backdrop-blur-sm",
            isUser
              ? "bg-primary text-primary-foreground rounded-tr-sm"
              : "bg-muted/50 rounded-tl-sm border border-border/50"
          )}
        >
          <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
            {message.content}
          </p>
        </div>

        {/* Metadata */}
        <div
          className={cn(
            "flex items-center gap-2 text-xs text-muted-foreground px-2",
            isUser && "flex-row-reverse"
          )}
        >
          <span className="font-medium">
            {formatDistanceToNow(message.timestamp, { addSuffix: true })}
          </span>

          {message.metadata?.intent && getIntentBadge(message.metadata.intent)}

          {message.metadata?.resultCount !== undefined && (
            <Badge variant="outline" className="text-xs gap-1 bg-background/50">
              <CheckCircle2 className="w-3 h-3" />
              {message.metadata.resultCount}
            </Badge>
          )}

          {message.metadata?.processingTime && (
            <span className="text-xs opacity-70">
              {message.metadata.processingTime}ms
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// Empty State Component
function EmptyState({
  setInput,
}: {
  setInput: (value: string) => void;
}) {
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
      <div className="w-20 h-20 rounded-full bg-gradient-to-br from-primary/10 to-primary/5 flex items-center justify-center mb-6 ring-4 ring-primary/10 shadow-lg">
        <FileSearch className="w-10 h-10 text-primary" />
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
            className="w-full text-left p-4 rounded-xl bg-muted/40 border border-border/50 hover:border-primary/50 hover:bg-muted/60 hover:shadow-lg transition-all duration-200 cursor-pointer group"
          >
            <p className="font-semibold text-sm text-foreground mb-1 group-hover:text-primary transition-colors">{example.title}</p>
            <p className="text-xs text-muted-foreground">"{example.query}"</p>
          </button>
        ))}
      </div>
    </div>
  );
}

// Suggestion Chips Component
function SuggestionChips({
  suggestions,
  onSuggestionClick,
}: {
  suggestions: ProactiveInsight[];
  onSuggestionClick: (query: string) => void;
}) {
  return (
    <div className="w-full max-w-2xl mx-auto mb-4 animate-in fade-in duration-300">
        <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wide mb-3 text-center">
          Proactive Insights
        </p>
        <div className="flex flex-wrap gap-3 justify-center">
            {suggestions.map((suggestion, i) => (
                <button
                    key={i}
                    onClick={() => onSuggestionClick(suggestion.query)}
                    className="flex items-center gap-2 text-sm px-4 py-2.5 rounded-full bg-yellow-500/10 border border-yellow-500/30 hover:bg-yellow-500/20 hover:shadow-md transition-all duration-200 cursor-pointer group"
                >
                    <AlertCircle className="w-4 h-4 text-yellow-500" />
                    <span className="text-yellow-300 group-hover:text-yellow-200">
                        {suggestion.title}
                    </span>
                </button>
            ))}
        </div>
    </div>
  );
}


// Quick Action Button
interface QuickActionButtonProps {
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}

function QuickActionButton({
  onClick,
  icon,
  children,
}: QuickActionButtonProps) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      className="text-xs h-8 gap-1.5 rounded-full hover:bg-muted/80 transition-all duration-200 border-border/50 hover:border-primary/30 hover:shadow-sm bg-transparent"
    >
      {icon}
      {children}
    </Button>
  );
}
