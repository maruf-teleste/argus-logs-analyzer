# Argus Log Analyzer - Codebase Guide

This document provides a high-level overview of the Argus Log Analyzer codebase, explaining its architecture, data flow, and core concepts. It's intended for developers looking to understand, maintain, or extend the application.

## 1. High-Level Overview

Argus is a modern web application designed for AI-powered analysis of network device logs. It allows users to upload log files, visualize log data over time, and use a natural language chat interface to query and understand complex log patterns.

**Core Technologies:**
- **Frontend:** Next.js (React) with TypeScript, styled with Tailwind CSS and Shadcn/ui components.
- **Backend:** Next.js API Routes running on a Node.js environment.
- **Database:** A PostgreSQL-compatible database is used for storing session and file metadata. The project uses `node-postgres` (pg) for database access.
- **Data Storage:** Raw log files are processed into the efficient **Apache Parquet** format and stored in an AWS S3 bucket for high-speed analytical queries.
- **AI Engine:** The AI logic is powered by OpenAI's `gpt-4o-mini` model, orchestrated by a custom tool-calling implementation.

---

## 2. Project Structure

The codebase is organized into several key directories:

- **/app**: Contains the application's routing structure, pages, and API endpoints, following the Next.js App Router conventions.
  - `app/page.tsx`: The main entry point and UI for the entire application.
  - `app/api/`: All backend API routes reside here.
- **/components**: Reusable React components that make up the UI.
  - `ui/`: Core, unstyled UI primitives from Shadcn/ui.
  - `LogAnalysis.tsx`: The orchestrator for the main analysis view.
  - `AnomalyGrid.tsx`: The interactive timeline chart.
  - `PatternTable.tsx`: The table that displays anomalous log patterns.
  - `ChatInterface.tsx`: The UI for the AI chat.
- **/lib**: Contains the core application logic, separated from the UI.
  - `lib/ai/`: The heart of the AI engine, including prompts, tool definitions, and the model interaction logic.
  - `lib/db/`: Database client setup and SQL queries.
  - `lib/parser/`: The log file processing pipeline (ETL).
  - `lib/query/`: The logic for executing analytical queries (tools) against the log data.
  - `lib/storage/`: S3 client and file handling logic.
- **/types**: TypeScript type definitions for shared data structures like `Session`.

---

## 3. Core Data Flow & Concepts

Understanding the lifecycle of a log analysis session is key to understanding the application.

### Step 1: Session and File Upload
A user begins by creating a **Session**, which acts as a container for one or more log files. When a file is uploaded (`<FileUpload />`), it's sent to the backend.

### Step 2: Backend Processing (The ETL Pipeline)
This is a critical, non-trivial step handled by `lib/parser/parquet-processor.ts`.
1.  A record for the file is created in the `session_files` database table.
2.  The raw log file is read line-by-line. The parser (`parseLogLine`) is designed to understand a specific log format, extracting structured data like `timestamp`, `severity`, `thread`, `component`, and `message`. It also intelligently groups multi-line Java stack traces with their parent error message.
3.  These structured log entries are converted into the **Parquet** format, a highly efficient columnar storage format ideal for fast queries.
4.  The resulting `.parquet` file is uploaded to a private S3 bucket.
5.  The `session_files` table in the database is updated with statistics (total lines, error counts, time range) and, most importantly, the S3 key of the Parquet file. The raw log file is discarded.

### Step 3: The Analysis View
The main page (`app/page.tsx`) renders the `<LogAnalysis />` component for the selected session. This component is the parent for the entire analysis UI. It holds the shared state, such as the selected `timeRange`.

- **`<AnomalyGrid />`**: This component queries the backend to get a histogram of log severities over time. It provides a high-level visual overview. When a user clicks on a bar, it updates the `timeRange` state in the parent `LogAnalysis` component.
- **`<PatternTable />`**: This component is the core of the "evidence-first" analysis. It watches the `timeRange` state. When a time range is selected, it queries the backend (`/api/sessions/.../anomaly-grid`) to get a list of statistically anomalous log patterns for that specific window, which it then displays in a table.

---

## 4. The AI Engine Explained (`lib/ai/`)

The AI is not a simple "summarize this text" black box. It's a sophisticated orchestrator that is guided by a strict methodology.

- **Orchestration:** The primary AI logic in `lib/ai/loganalyzer.ts` uses `gpt-4o-mini` with a set of predefined "tools". The AI's job is to decide *which tools to use* in what order to answer a user's question.

- **The Golden Rule:** The system prompt, defined in `lib/ai/prompts.ts`, enforces a critical rule: **always start with statistical analysis before looking at raw logs.** This prevents the AI from getting lost in noise and ensures its conclusions are based on evidence. For example, it's instructed to use the `detect_anomalies` tool first to identify what is unusual about a time period.

- **The AI's Toolbox (`lib/ai/tool-definitions.ts`):** The AI can't do anything it wants. Its capabilities are strictly defined by the available tools, which include:
  - `detect_anomalies`: Compares a "problem" time window to a "baseline" to find new or spiking log patterns. This is the cornerstone of an investigation.
  - `get_pattern_examples`: Fetches raw log samples that match a specific pattern signature.
  - `get_correlated_events`: Finds logs that are related to a given event by thread ID, trace ID, or time.
  - `summarize_exceptions`: Extracts and summarizes stack traces.

- **Execution (`lib/ai/tool-executor.ts` & `lib/query/`):** When the AI decides to use a tool (e.g., `detect_anomalies`), the `tool-executor` acts as a bridge. It calls the appropriate function in `lib/query/`, which then executes a fast query (using DuckDB) against the Parquet file stored in S3.

---

## 5. Database (`lib/db/`)

The database stores metadata, not the log content itself.
- **`client.ts`**: Configures the connection to the PostgreSQL database.
- **`queries.ts`**: Contains all the application's SQL queries.
- **Key Tables:**
  - `sessions`: Stores session information (ID, name, creation date).
  - `session_files`: Stores metadata for each file, including its name, size, processing status, statistics, and the S3 key for its Parquet file.
  - `events`: (This seems to be an old or unused table, as the primary data is now stored in Parquet files in S3).

---

## 6. How to Extend the System

### Adding a New AI Tool
This is the most powerful way to extend the system's analytical capabilities.
1.  **Define the Tool:** Add a new tool definition in `lib/ai/tool-definitions.ts`. Specify its name, description, and input parameters (using a Zod schema for validation).
2.  **Implement the Query:** Create a new function in a relevant file under `lib/query/` that performs the actual data query. This function will likely use DuckDB to query the Parquet file from S3.
3.  **Register the Tool:** Add your new query function to the `TOOL_REGISTRY` in `lib/query/tools-registry.ts`.
4.  **Teach the AI:** Update the `SYSTEM_PROMPT` in `lib/ai/prompts.ts` with instructions on what the new tool does and in what situations the AI should use it. This is a critical step.

### Adding a New UI Component
1.  Create your component in the `/components` directory.
2.  If it needs data, create a new API endpoint in `/app/api/`.
3.  Integrate the component into the main page by modifying `app/page.tsx` or one of its children, like `components/LogAnalysis.tsx`.
