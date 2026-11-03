import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "./config.ts";

// The same client code talks to real S3; only the endpoint differs.
export const s3 = new S3Client({
  endpoint: config.S3_ENDPOINT,
  region: config.S3_REGION,
  forcePathStyle: true, // MinIO/SeaweedFS serve buckets as /bucket/key, not bucket.host/key
  credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
  // Without this the SDK signs a CRC32 of the *empty* body into presigned PUT
  // URLs, so storage rejects the client's real bytes with BadDigest.
  requestChecksumCalculation: "WHEN_REQUIRED",
});

// Two buckets (PROJECT_OVERVIEW "Blob Storage"): originals stay private in
// S3_BUCKET; everything a viewer may fetch goes to the public-read MEDIA_BUCKET.
// Output keys are attempt-scoped, so two attempts of one job never overwrite
// each other's files, and each object is immutable once written.

export function originalKey(videoId: string): string {
  return `originals/${videoId}/source`;
}

export function renditionPrefix(videoId: string, height: number, attempt: number): string {
  return `renditions/${videoId}/${height}/a${attempt}/`;
}

export function thumbnailKey(videoId: string, attempt: number): string {
  return `thumbnails/${videoId}/a${attempt}.jpg`;
}

/** Browser-facing URL for an object in the media bucket (the CDN from M6 on). */
export function mediaUrl(key: string): string {
  return `${config.MEDIA_PUBLIC_URL}/${key}`;
}

// Attempt-scoped keys are never rewritten, so caches may keep them forever.
const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * A time-limited URL that lets the client PUT bytes for exactly one key,
 * without the bytes ever passing through the API server.
 */
export function presignUpload(key: string, contentLength: number): Promise<string> {
  return getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: config.S3_BUCKET, Key: key, ContentLength: contentLength }),
    { expiresIn: config.UPLOAD_URL_TTL_SECONDS },
  );
}

/** Returns the object's size, or null if it does not exist. */
export async function headObjectSize(key: string): Promise<number | null> {
  try {
    const res = await s3.send(new HeadObjectCommand({ Bucket: config.S3_BUCKET, Key: key }));
    return res.ContentLength ?? 0;
  } catch (err) {
    if (err instanceof S3ServiceException && err.$metadata.httpStatusCode === 404) return null;
    throw err;
  }
}

/** Streams an original from the private bucket to a local file (for ffprobe/ffmpeg). */
export async function downloadOriginal(key: string, toPath: string, signal?: AbortSignal): Promise<void> {
  // `exactOptionalPropertyTypes` forbids passing `signal: undefined`, hence the `? : {}`.
  const res = await s3.send(
    new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }),
    signal ? { abortSignal: signal } : {},
  );
  // In Node the SDK's Body is a Readable stream; pipeline() is the
  // backpressure-aware `shutil.copyfileobj`.
  await pipeline(res.Body as Readable, createWriteStream(toPath), signal ? { signal } : {});
}

/** Uploads a local file to the public media bucket. Returns its size in bytes. */
export async function uploadMediaFile(key: string, fromPath: string, contentType: string): Promise<number> {
  const { size } = await stat(fromPath);
  await s3.send(
    new PutObjectCommand({
      Bucket: config.MEDIA_BUCKET,
      Key: key,
      Body: createReadStream(fromPath),
      ContentLength: size,
      ContentType: contentType,
      CacheControl: IMMUTABLE,
    }),
  );
  return size;
}

/** Every object under `prefix` in the media bucket, as key → size. */
export async function listMediaObjects(prefix: string): Promise<Map<string, number>> {
  const objects = new Map<string, number>();
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: config.MEDIA_BUCKET, Prefix: prefix, ContinuationToken: token }),
    );
    for (const o of page.Contents ?? []) objects.set(o.Key!, o.Size ?? 0);
    token = page.NextContinuationToken;
  } while (token);
  return objects;
}

/**
 * Creates both buckets if missing and (re)applies their CORS rule. Safe to run
 * repeatedly. Public read on the media bucket is storage configuration (an
 * anonymous identity in infra/seaweedfs-s3.json; a bucket policy or CDN
 * origin access on AWS), not something the app grants itself.
 */
export async function ensureBuckets(): Promise<void> {
  for (const bucket of [config.S3_BUCKET, config.MEDIA_BUCKET]) await ensureBucket(bucket);
}

async function ensureBucket(bucket: string): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  }
  // The browser uploads straight to storage from another origin (the UI), so
  // storage itself must allow that origin. The API is never in the byte path.
  // The media bucket needs the same rule for GETs once the player (M6) fetches
  // playlists and segments with XHR.
  await s3.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: config.CORS_ORIGINS,
            AllowedMethods: ["PUT", "GET", "HEAD"],
            AllowedHeaders: ["*"],
            ExposeHeaders: ["ETag"],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    }),
  );
}
