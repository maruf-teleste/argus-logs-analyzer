// Session and File Types
export interface LogFile {
  id: string;
  name: string;
  sizeMb?: number; // Changed from 'size' to match DB
  status: "uploading" | "parsing" | "ready" | "error";
  progress: number;
  uploadedAt?: Date;
  totalLines?: number;
  parsedLines?: number;
  errorCount?: number;
  warnCount?: number;
}

export interface Session {
  id: string;
  name: string;
  createdAt: Date;
  createdBy: string;
  expiresAt: Date;
  files: LogFile[];
  status: "active" | "ready" | "processing" | "expired" | "error";
  totalLines?: number;
  totalErrors?: number;
  totalWarnings?: number;
  deviceCount?: number;
  timeRange?: {
    start: string | null;
    end: string | null;
  };
}
// Log Event Types
export type LogSeverity = "ERROR" | "WARN" | "INFO" | "DEBUG" | "TRACE";

export interface LogEvent {
  id: string;
  sessionId: string;
  sourceFileId: string;
  timestamp: Date;
  severity: LogSeverity;
  component: string;
  thread?: string;
  message: string;
  userName?: string;
  ipAddress?: string;
  elementId?: number;
  rawLine: string;
}

// Chat and Query Types
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
  metadata?: {
    intent?: QueryIntent;
    entities?: ExtractedEntities;
    resultCount?: number;
    processingTime?: number;
  };
}

export type QueryIntent =
  | "ROOT_CAUSE"
  | "DEVICE_OVERVIEW"
  | "ERROR_SEARCH"
  | "TIMELINE"
  | "ANALYSIS"
  | "UNKNOWN";

export interface ExtractedEntities {
  deviceId?: number;
  elementId?: number;
  timestamp?: string;
  severity?: LogSeverity;
  component?: string;
  ipAddress?: string;
  timeRange?: {
    start?: string;
    end?: string;
  };
}

export interface QueryResponse {
  answer: string;
  intent: QueryIntent;
  entities: ExtractedEntities;
  events: LogEvent[];
  metadata: {
    eventCount: number;
    timeRange?: {
      start: Date;
      end: Date;
    };
    processingTime: number;
  };
}

// API Response Types
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface SessionCreateResponse {
  sessionId: string;
  expiresAt: string;
}

export interface FileUploadResponse {
  fileId: string;
  eventsInserted: number;
  parseTime: number;
}

export interface QueryRequest {
  sessionId: string;
  question: string;
}

// UI State Types
export interface UploadProgress {
  fileId: string;
  fileName: string;
  progress: number;
  stage:
    | "uploading"
    | "hashing"
    | "parsing"
    | "inserting"
    | "complete"
    | "error";
  error?: string;
}

export interface SessionStats {
  totalFiles: number;
  totalEvents: number;
  errorCount: number;
  warningCount: number;
  timeRange?: {
    start: Date;
    end: Date;
  };
  topComponents: Array<{
    name: string;
    count: number;
  }>;
}

// Utility Types
export interface TimeRange {
  start: Date;
  end: Date;
}

export interface DateFilter {
  from?: Date;
  to?: Date;
}

export interface SeverityFilter {
  ERROR?: boolean;
  WARN?: boolean;
  INFO?: boolean;
  DEBUG?: boolean;
  TRACE?: boolean;
}
