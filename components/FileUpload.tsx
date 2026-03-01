"use client";

import { useCallback, useState } from "react";
import { useDropzone } from "react-dropzone";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Upload,
  FileText,
  X,
  CheckCircle2,
  AlertCircle,
  Loader2,
  File,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { UploadProgress } from "@/types/session";

interface FileUploadProps {
  sessionId: string;
  onUploadComplete?: (fileId: string, eventsCount: number) => void;
  onUploadError?: (error: string) => void;
  onUploadStart?: () => void;
  maxFiles?: number;
  maxSizeMB?: number;
  acceptedFileTypes?: string[];
  className?: string;
}

export function FileUpload({
  sessionId,
  onUploadComplete,
  onUploadError,
  onUploadStart,
  maxFiles = 10,
  acceptedFileTypes = [".log", ".txt"],
  className,
}: FileUploadProps) {
  const [uploads, setUploads] = useState<UploadProgress[]>([]);
  const [isDragActive, setIsDragActive] = useState(false);

  // Poll for completion when stream disconnects
  const pollForCompletion = async (fileId: string, s3Key: string, fileName: string) => {
    console.log("Polling for completion...");
    setUploads((prev) =>
      prev.map((u) =>
        u.fileId === fileId
          ? { ...u, stage: "processing", progress: 85 }
          : u
      )
    );

    const maxAttempts = 60; // Poll for up to 10 minutes (60 * 10s)
    let attempts = 0;

    const poll = async (): Promise<void> => {
      try {
        const response = await fetch(
          `/api/sessions/${sessionId}/upload-status?s3Key=${encodeURIComponent(s3Key)}`
        );
        const data = await response.json();

        if (data.status === "complete") {
          console.log("✅ Upload completed in background!");
          setUploads((prev) =>
            prev.map((u) =>
              u.fileId === fileId
                ? { ...u, stage: "complete", progress: 100 }
                : u
            )
          );

          onUploadComplete?.(data.fileId, data.stats?.totalLines || 0);

          setTimeout(() => {
            setUploads((prev) => prev.filter((u) => u.fileId !== fileId));
          }, 3000);
        } else if (attempts < maxAttempts) {
          // Still processing, poll again
          attempts++;
          setUploads((prev) =>
            prev.map((u) =>
              u.fileId === fileId
                ? { ...u, progress: Math.min(95, 85 + attempts) }
                : u
            )
          );
          setTimeout(poll, 10000); // Poll every 10 seconds
        } else {
          // Timeout
          setUploads((prev) =>
            prev.map((u) =>
              u.fileId === fileId
                ? {
                    ...u,
                    stage: "error",
                    error: "Processing timeout - check server logs",
                  }
                : u
            )
          );
        }
      } catch (err) {
        console.error("Polling error:", err);
        if (attempts < maxAttempts) {
          attempts++;
          setTimeout(poll, 10000);
        }
      }
    };

    poll();
  };

  const uploadFile = async (file: File) => {
    const fileId = `${Date.now()}-${file.name}`;

    // Add to upload list
    setUploads((prev) => [
      ...prev,
      {
        fileId,
        fileName: file.name,
        progress: 0,
        stage: "uploading",
      },
    ]);

    try {
      /* Step 0: Compress file with gzip in browser */
      setUploads((prev) =>
        prev.map((u) =>
          u.fileId === fileId ? { ...u, progress: 0, stage: "compressing" } : u
        )
      );

      let uploadBlob: Blob = file;
      let isGzipped = false;

      if (typeof CompressionStream !== "undefined") {
        try {
          const cs = new CompressionStream("gzip");
          const compressedStream = file.stream().pipeThrough(cs);
          uploadBlob = await new Response(compressedStream).blob();
          isGzipped = true;
          const ratio = ((1 - uploadBlob.size / file.size) * 100).toFixed(0);
          console.log(
            `Compressed ${file.name}: ${(file.size / 1024 / 1024).toFixed(1)}MB → ${(uploadBlob.size / 1024 / 1024).toFixed(1)}MB (${ratio}% smaller)`
          );
        } catch (err) {
          console.warn("Gzip compression failed, uploading uncompressed:", err);
        }
      }

      /* Step 1: Get pre-signed S3 URL */
      setUploads((prev) =>
        prev.map((u) =>
          u.fileId === fileId ? { ...u, progress: 0, stage: "preparing" } : u
        )
      );

      const urlResponse = await fetch(`/api/sessions/${sessionId}/upload-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: file.name,
          fileSize: uploadBlob.size,
          isGzipped,
        }),
      });

      if (!urlResponse.ok) throw new Error("Failed to get upload URL");

      const { uploadUrl, s3Key } = await urlResponse.json();
      console.log("Got S3 upload URL, key:", s3Key);

      /* Step 2: Upload directly to S3 (0-40%) */
      const s3xhr = new XMLHttpRequest();
      s3xhr.open("PUT", uploadUrl);
      s3xhr.timeout = 0;

      // Set content type based on compression
      s3xhr.setRequestHeader(
        "Content-Type",
        isGzipped ? "application/gzip" : "text/plain"
      );

      s3xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const progress = Math.round((e.loaded / e.total) * 40);
        setUploads((prev) =>
          prev.map((u) =>
            u.fileId === fileId ? { ...u, progress, stage: "uploading" } : u
          )
        );
      };

      await new Promise((resolve, reject) => {
        s3xhr.onload = () => {
          console.log("S3 upload response:", s3xhr.status, s3xhr.statusText);
          if (s3xhr.status === 200) {
            console.log("S3 upload successful for:", file.name);
            resolve(null);
          }
          else reject(new Error(`S3 upload failed: ${s3xhr.status} ${s3xhr.statusText}`));
        };
        s3xhr.onerror = (e) => {
          console.error("S3 upload error event:", e);
          reject(new Error("S3 upload network error - check CORS and bucket permissions"));
        };
        console.log("Starting S3 upload for file:", file.name, "size:", uploadBlob.size, isGzipped ? "(gzipped)" : "");
        s3xhr.send(uploadBlob);
      });

      console.log("S3 upload complete, notifying server to process...");
      onUploadStart?.();

      /* Step 3: Notify server to process (40-100%) */
      setUploads((prev) =>
        prev.map((u) =>
          u.fileId === fileId ? { ...u, progress: 40, stage: "processing" } : u
        )
      );

      const processXhr = new XMLHttpRequest();
      processXhr.open("POST", `/api/sessions/${sessionId}/process`);
      processXhr.setRequestHeader("Content-Type", "application/json");
      processXhr.responseType = "text";
      processXhr.timeout = 0;

      console.log("Sending process request with:", { s3Key, fileName: file.name });

      /* Server-side progress via SSE (40-100%) */
      let lastIndex = 0;

      let receivedComplete = false;

      // Process SSE lines from a chunk of text.
      // Extracted so both onprogress and onload can use it.
      const processSSELines = (text: string) => {
        const lines = text.split("\n");
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const msg = JSON.parse(line.slice(6));

            // Skip keepalive pings from server
            if (msg.payload?.ping) continue;

            const safeProgress = Math.max(
              0,
              Math.min(100, Number(msg.progress) || 0)
            );

            setUploads((prev) =>
              prev.map((u) =>
                u.fileId === fileId
                  ? {
                      ...u,
                      progress: Math.max(u.progress, safeProgress),
                      stage: msg.stage,
                    }
                  : u
              )
            );

            if (msg.stage === "complete") {
              receivedComplete = true;
              console.log("[FileUpload] SSE complete received, calling onUploadComplete");
              try {
                onUploadComplete?.(
                  msg.payload?.fileId ?? fileId,
                  msg.payload?.stats?.totalLines ?? 0
                );
              } catch (err) {
                console.error("[FileUpload] onUploadComplete callback error:", err);
              }

              setTimeout(() => {
                setUploads((prev) => prev.filter((u) => u.fileId !== fileId));
              }, 3000);
            }

            if (msg.stage === "error") {
              receivedComplete = true; // Don't poll after error
              const errorMessage =
                typeof msg.payload === "string"
                  ? msg.payload
                  : msg.payload?.error || "Processing failed";

              setUploads((prev) =>
                prev.map((u) =>
                  u.fileId === fileId
                    ? {
                        ...u,
                        stage: "error",
                        error: errorMessage,
                      }
                    : u
                )
              );

              onUploadError?.(errorMessage);
            }
          } catch {
            // Ignore malformed partial chunks
          }
        }
      };

      processXhr.onprogress = () => {
          const text = processXhr.responseText;
          const chunk = text.slice(lastIndex);

          // Only process up to the last complete message boundary (\n\n)
          // to avoid losing messages split across TCP segments by ALB
          const lastBoundary = chunk.lastIndexOf("\n\n");
          if (lastBoundary === -1) return; // No complete messages yet

          const complete = chunk.slice(0, lastBoundary + 2);
          lastIndex += lastBoundary + 2;

          processSSELines(complete);
      };

      // When the XHR finishes (onload/onerror/onabort), process any
      // remaining data that onprogress may have missed (e.g. the final
      // "complete" event arrived but onprogress didn't fire for it).
      const handleStreamEnd = (reason: string) => {
        if (!receivedComplete) {
          const remaining = processXhr.responseText.slice(lastIndex);
          if (remaining.length > 0) {
            processSSELines(remaining);
          }
        }
        if (!receivedComplete) {
          console.log(`SSE stream ended (${reason}), polling for status...`);
          pollForCompletion(fileId, s3Key, file.name);
        }
      };

      processXhr.onload = () => handleStreamEnd("closed");
      processXhr.onerror = () => handleStreamEnd("error");
      processXhr.onabort = () => handleStreamEnd("aborted");

      processXhr.send(JSON.stringify({ s3Key, fileName: file.name, isGzipped }));
    } catch (error) {
      console.error("Upload error:", error);
      setUploads((prev) =>
        prev.map((u) =>
          u.fileId === fileId
            ? {
                ...u,
                stage: "error",
                error: error instanceof Error ? error.message : "Upload failed",
              }
            : u
        )
      );
      onUploadError?.(
        error instanceof Error ? error.message : "Upload failed"
      );
    }
  };

  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      setIsDragActive(false);

      // Validate file count
      if (acceptedFiles.length > maxFiles) {
        onUploadError?.(`Maximum ${maxFiles} files allowed`);
        return;
      }

      // 🔥 Duplicate check for current session
      for (const file of acceptedFiles) {
        if (uploads.some((u) => u.fileName === file.name)) {
          onUploadError?.(
            `File "${file.name}" was already uploaded in this session`
          );
          return;
        }
      }

      // Upload all files
      acceptedFiles.forEach(uploadFile);
    },
    [sessionId, maxFiles, uploads]
  );

  const { getRootProps, getInputProps } = useDropzone({
    onDrop,
    accept: acceptedFileTypes.reduce(
      (acc, type) => ({ ...acc, [type]: [] }),
      {}
    ),
    maxFiles,
    onDragEnter: () => setIsDragActive(true),
    onDragLeave: () => setIsDragActive(false),
  });

  const removeUpload = (fileId: string) => {
    setUploads((prev) => prev.filter((u) => u.fileId !== fileId));
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const getStageText = (stage: string) => {
    switch (stage) {
      case "compressing":
        return "Compressing file...";
      case "preparing":
        return "Preparing upload...";
      case "starting":
        return "Starting...";
      case "uploading":
        return "Uploading to S3...";
      case "processing":
        return "Processing...";
      case "downloading":
        return "Server downloading from S3...";
      case "hashing":
        return "Calculating hash...";
      case "parsing":
        return "Parsing logs (It may take a minute or more for large files)...";
      case "writing_parquet":
        return "Writing Parquet...";
      case "uploading_to_s3":
        return "Saving Parquet to S3...";
      case "saving_metadata":
        return "Saving metadata...";
      case "findings":
        return "Analyzing patterns...";
      case "complete":
        return "Complete";
      case "error":
        return "Error";
      default:
        return stage;
    }
  };

  return (
    <div className={cn("space-y-4", className)}>
      {/* Drop Zone */}
      <Card
        {...getRootProps()}
        className={cn(
          "upload-zone cursor-pointer",
          isDragActive && "upload-zone-active"
        )}
      >
        <CardContent className="flex flex-col items-center justify-center py-12 px-6">
          <input {...getInputProps()} />

          <div
            className={cn(
              "w-16 h-16 rounded-full flex items-center justify-center mb-4 transition-all duration-300",
              isDragActive ? "bg-primary/20 glow-primary" : "bg-muted/20"
            )}
          >
            <Upload
              className={cn(
                "w-8 h-8 transition-colors",
                isDragActive ? "text-primary" : "text-muted-foreground"
              )}
            />
          </div>

          <div className="text-center space-y-2">
            <p className="text-lg font-medium">
              {isDragActive ? "Drop files here" : "Drop log files here"}
            </p>
          </div>

          {/* <Button
            variant="outline"
            className="mt-4"
            onClick={(e) => e.stopPropagation()}
          >
            <FileText className="w-4 h-4 mr-2" />
            Select Files
          </Button> */}
        </CardContent>
      </Card>

      {/* Upload Progress List */}
      {uploads.length > 0 && (
        <Card className="glass-card">
          <CardContent className="p-4 space-y-3">
            {uploads.map((upload) => (
              <div
                key={upload.fileId}
                className="flex items-center gap-3 p-3 rounded-lg bg-muted/20"
              >
                {/* Status Icon */}
                <div className="flex-shrink-0">
                  {upload.stage === "complete" && (
                    <CheckCircle2 className="w-5 h-5 text-green-400" />
                  )}
                  {upload.stage === "error" && (
                    <AlertCircle className="w-5 h-5 text-red-400" />
                  )}
                  {(upload.stage === "compressing" ||
                    upload.stage === "preparing" ||
                    upload.stage === "starting" ||
                    upload.stage === "uploading" ||
                    upload.stage === "processing" ||
                    upload.stage === "downloading" ||
                    upload.stage === "parsing" ||
                    upload.stage === "writing_parquet" ||
                    upload.stage === "uploading_to_s3" ||
                    upload.stage === "saving_metadata" ||
                    upload.stage === "findings" ||
                    upload.stage === "inserting") && (
                    <Loader2 className="w-5 h-5 text-primary spinner" />
                  )}
                </div>

                {/* File Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium truncate">
                      {upload.fileName}
                    </span>
                    <span className="text-xs text-muted-foreground ml-2">
                      {upload.progress}%
                    </span>
                  </div>

                  <Progress
                    value={upload.progress}
                    className={cn(
                      "h-1.5 mb-1",
                      upload.stage === "error" && "bg-destructive/20"
                    )}
                  />

                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">
                      {getStageText(upload.stage)}
                    </span>
                    {upload.error && (
                      <span className="text-xs text-red-400">
                        {upload.error}
                      </span>
                    )}
                  </div>
                </div>

                {/* Remove Button */}
                {(upload.stage === "complete" || upload.stage === "error") && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="flex-shrink-0 h-8 w-8 p-0"
                    onClick={() => removeUpload(upload.fileId)}
                  >
                    <X className="w-4 h-4" />
                  </Button>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// // Compact File Upload for inline use
// export function CompactFileUpload({
//   sessionId,
//   onUploadComplete,
//   onUploadError,
// }: Pick<FileUploadProps, "sessionId" | "onUploadComplete" | "onUploadError">) {
//   const [isUploading, setIsUploading] = useState(false);

//   const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
//     const file = e.target.files?.[0];
//     if (!file) return;

//     setIsUploading(true);

//     try {
//       const formData = new FormData();
//       formData.append("file", file);

//       const response = await fetch(`/api/sessions/${sessionId}/upload`, {
//         method: "POST",
//         body: formData,
//       });

//       if (!response.ok) throw new Error("Upload failed");

//       const data = await response.json();
//       onUploadComplete?.(data.fileId, data.eventsInserted);
//     } catch (error) {
//       const errorMessage =
//         error instanceof Error ? error.message : "Upload failed";
//       onUploadError?.(errorMessage);
//     } finally {
//       setIsUploading(false);
//     }
//   };

//   return (
//     <div className="relative">
//       <input
//         type="file"
//         id="file-upload"
//         className="hidden"
//         accept=".log,.txt"
//         onChange={handleFileSelect}
//         disabled={isUploading}
//       />
//       <label htmlFor="file-upload">
//         <Button
//           variant="outline"
//           disabled={isUploading}
//           className="cursor-pointer"
//           asChild
//         >
//           <span>
//             {isUploading ? (
//               <>
//                 <Loader2 className="w-4 h-4 mr-2 spinner" />
//                 Uploading...
//               </>
//             ) : (
//               <>
//                 <Upload className="w-4 h-4 mr-2" />
//                 Upload File
//               </>
//             )}
//           </span>
//         </Button>
//       </label>
//     </div>
//   );
// }
