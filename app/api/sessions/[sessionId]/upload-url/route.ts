// app/api/sessions/[sessionId]/upload-url/route.ts
// Returns pre-signed S3 URL for direct browser upload

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({
  region: process.env.AWS_REGION || "eu-north-1",
});

const BUCKET = process.env.S3_BUCKET_NAME!;

export async function POST(
  req: Request,
  context: { params: Promise<{ sessionId: string }> }
) {
  try {
    const { sessionId } = await context.params;
    const { fileName, fileSize, isGzipped } = await req.json();

    // Generate unique key for raw log file
    const timestamp = Date.now();
    const safeFilename = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const suffix = isGzipped ? ".gz" : "";
    const s3Key = `raw-logs/${sessionId}/${timestamp}-${safeFilename}${suffix}`;

    // Create pre-signed URL for upload (valid for 1 hour)
    const command = new PutObjectCommand({
      Bucket: BUCKET,
      Key: s3Key,
      ContentType: isGzipped ? "application/gzip" : "text/plain",
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });

    console.log(`[UPLOAD-URL] Generated pre-signed URL for: ${s3Key}`);
    console.log(`[UPLOAD-URL] Bucket: ${BUCKET}, Region: ${process.env.AWS_REGION}`);

    return Response.json({
      uploadUrl,
      s3Key,
      bucket: BUCKET,
    });
  } catch (error) {
    console.error("Error generating upload URL:", error);
    return Response.json(
      { error: "Failed to generate upload URL" },
      { status: 500 }
    );
  }
}