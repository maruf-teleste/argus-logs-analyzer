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
  maxFiles?: number;
  maxSizeMB?: number;
  acceptedFileTypes?: string[];
  className?: string;
}

export function FileUpload({
  sessionId,
  onUploadComplete,
  onUploadError,
  maxFiles = 10,
  acceptedFileTypes = [".log", ".txt"],
  className,
}: FileUploadProps) {
  const [uploads, setUploads] = useState<UploadProgress[]>([]);
  const [isDragActive, setIsDragActive] = useState(false);

  const uploadFile = (file: File) => {
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

    const formData = new FormData();
    formData.append("file", file);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/sessions/${sessionId}/upload`);
    xhr.responseType = "text";

    /* ===============================
     REAL UPLOAD PROGRESS (0–40%)
     =============================== */
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;

      const progress = Math.round((e.loaded / e.total) * 40);
      setUploads((prev) =>
        prev.map((u) =>
          u.fileId === fileId ? { ...u, progress, stage: "uploading" } : u
        )
      );
    };

    /* ===============================
     REAL SERVER PROGRESS (SSE)
     =============================== */
    let lastIndex = 0;

    xhr.onprogress = () => {
      const chunk = xhr.responseText.slice(lastIndex);
      lastIndex = xhr.responseText.length;

      const lines = chunk.split("\n");

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;

        try {
          const msg = JSON.parse(line.slice(6));
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
            onUploadComplete?.(
              msg.payload.fileId,
              msg.payload.stats.totalLines
            );

            setTimeout(() => {
              setUploads((prev) => prev.filter((u) => u.fileId !== fileId));
            }, 3000);
          }

          if (msg.stage === "error") {
            const errorMessage =
              typeof msg.payload === "string"
                ? msg.payload
                : msg.payload?.error || "Upload failed";

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

    xhr.onerror = () => {
      setUploads((prev) =>
        prev.map((u) =>
          u.fileId === fileId
            ? { ...u, stage: "error", error: "Network error" }
            : u
        )
      );
      onUploadError?.("Network error");
    };

    xhr.send(formData);
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
      case "starting":
        return "Starting...";
      case "uploading":
        return "Uploading...";
      case "hashing":
        return "Calculating hash...";
      case "parsing":
        return "Parsing logs (It may take a minute or more for large files)...";
      case "writing_parquet":
        return "Writing Parquet...";
      case "uploading_to_s3":
        return "Uploading to S3...";
      case "saving_metadata":
        return "Saving metadata...";
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
                  {(upload.stage === "uploading" ||
                    upload.stage === "parsing" ||
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
