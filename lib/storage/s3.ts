// lib/storage/s3.ts
import {
  S3Client,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

// Use default credential provider chain (works with ECS task role)
// Falls back to environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY) for local development
const s3 = new S3Client({
  region: process.env.AWS_REGION || "eu-north-1",
});

const BUCKET = process.env.S3_BUCKET_NAME!;

/**
 * Delete a single file from S3
 */
export async function deleteFromS3(key: string): Promise<void> {
  console.log(`🗑️ Deleting from S3: ${key}`);

  await s3.send(
    new DeleteObjectCommand({
      Bucket: BUCKET,
      Key: key,
    })
  );

  console.log(`✅ Deleted: ${key}`);
}

/**
 * Delete multiple files from S3
 */
export async function deleteMultipleFromS3(keys: string[]): Promise<void> {
  if (keys.length === 0) return;

  console.log(`🗑️ Batch deleting ${keys.length} files from S3`);

  // S3 allows max 1000 keys per request
  const chunks = [];
  for (let i = 0; i < keys.length; i += 1000) {
    chunks.push(keys.slice(i, i + 1000));
  }

  for (const chunk of chunks) {
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: {
          Objects: chunk.map((key) => ({ Key: key })),
          Quiet: true,
        },
      })
    );
  }

  console.log(`Deleted ${keys.length} files from S3`);
}

/**
 * List all object keys with a given prefix from S3
 */
export async function listObjectKeys(prefix: string): Promise<string[]> {
  console.log(`🔍 Listing objects in S3 with prefix: ${prefix}`);
  const command = new ListObjectsV2Command({
    Bucket: BUCKET,
    Prefix: prefix,
  });

  const { Contents } = await s3.send(command);
  if (!Contents) {
    return [];
  }

  const keys = Contents.map((c) => c.Key).filter((k): k is string => !!k);
  console.log(`Found ${keys.length} objects with prefix ${prefix}`);
  return keys;
}
