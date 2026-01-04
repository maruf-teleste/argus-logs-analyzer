"use client";

import { Button } from "@/components/ui/button";
import {
  Database,
  Clock,
  Trash2,
  Loader2,
  FileText,
  AlertCircle,
} from "lucide-react";
import type { Session } from "@/types/session";
import { cn } from "@/lib/utils";

interface SessionListProps {
  sessions: Session[];
  selectedSessionId?: string;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId:string) => void;
  isLoading: boolean;
  emptyMessage: string;
}

export function SessionList({
  sessions,
  selectedSessionId,
  onSelectSession,
  onDeleteSession,
  isLoading,
  emptyMessage,
}: SessionListProps) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        <p>{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="space-y-2 p-2">
      {sessions.map((session) => (
        <SessionCard
          key={session.id}
          session={session}
          isSelected={session.id === selectedSessionId}
          onSelect={() => onSelectSession(session.id)}
          onDelete={() => onDeleteSession(session.id)}
        />
      ))}
    </div>
  );
}

interface SessionCardProps {
  session: Session;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

export function SessionCard({
  session,
  isSelected,
  onSelect,
  onDelete,
}: SessionCardProps) {
  const fileLabel =
    session.files?.length > 0 ? session.files[0].name : "New Session";

  return (
    <div
      className={cn(
        "group flex items-center justify-between rounded-lg p-3 text-sm font-medium cursor-pointer",
        isSelected
          ? "bg-primary/10 text-primary"
          : "hover:bg-muted"
      )}
      onClick={onSelect}
    >
      <div className="flex items-center gap-3 min-w-0">
        <FileText className="w-4 h-4 shrink-0" />
        <span className="truncate" title={fileLabel}>
          {fileLabel}
        </span>
      </div>
      <Button
        variant="ghost"
        size="icon"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className={cn(
          "w-6 h-6 rounded-md shrink-0 opacity-0 group-hover:opacity-100",
           isSelected ? "hover:bg-primary/20" : "hover:bg-destructive/10 hover:text-destructive"
        )}
      >
        <Trash2 className="w-3.5 h-3.5" />
      </Button>
    </div>
  );
}

