// app/api/sessions/[sessionId]/upload-credentials/route.ts
// Returns temporary AWS credentials for direct browser upload

import {
  STSClient,
  GetFederationTokenCommand,
} from "@aws-sdk/client-sts";

const stsClient = new STSClient({
  region: process.env.AWS_REGION || "eu-north-1",
});
const BUCKET = process.env.S3_BUCKET_NAME!;
const REGION = process.env.AWS_REGION || "eu-north-1";

export async function POST(
  req: Request,
  context: { params: Promise<{ sessionId: string }> }
) {
  try {
    const { sessionId } = await context.params;

    // Policy that grants limited permissions for the upload
    const policy = {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: [
            "s3:PutObject",
            "s3:GetObject",
            "s3:AbortMultipartUpload",
            "s3:ListMultipartUploadParts",
          ],
          Resource: [
            `arn:aws:s3:::${BUCKET}/raw-logs/${sessionId}/*`,
          ],
        },
        {
          Effect: "Allow",
          Action: "s3:ListBucketMultipartUploads",
          Resource: `arn:aws:s3:::${BUCKET}`,
          Condition: {
            StringLike: {
              "s3:prefix": `raw-logs/${sessionId}/*`,
            },
          },
        },
      ],
    };

    const command = new GetFederationTokenCommand({
      Name: `argus-upload-${sessionId.slice(-12)}`,
      Policy: JSON.stringify(policy),
      DurationSeconds: 3600, // 1 hour
    });

    const result = await stsClient.send(command);

    console.log(`[UPLOAD-CREDENTIALS] Generated temporary credentials for session ${sessionId}.`);

    return Response.json({
      credentials: result.Credentials,
      bucket: BUCKET,
      region: REGION,
    });
  } catch (error) {
    console.error("Error generating upload credentials:", error);
    return Response.json(
      { error: "Failed to generate upload credentials" },
      { status: 500 }
    );
  }
}
