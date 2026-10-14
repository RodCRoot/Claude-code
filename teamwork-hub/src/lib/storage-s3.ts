import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import type { ObjectStore } from "./storage";

/**
 * S3-compatible object store (AWS S3, Cloudflare R2, Backblaze B2, MinIO, …).
 *
 * - Objects are private: no ACL is ever set (bucket defaults / Object Ownership apply) and
 *   nothing is served from the bucket directly — bytes leave only through auth-checked
 *   route handlers, exactly as with the local backend.
 * - Server-side encryption on every PUT: SSE-S3 (`AES256`, default) or SSE-KMS (`aws:kms`
 *   with optional S3_KMS_KEY_ID). `S3_SSE=none` is only for providers that always encrypt at
 *   rest and reject the header.
 * - Credentials come from the standard AWS provider chain (AWS_ACCESS_KEY_ID /
 *   AWS_SECRET_ACCESS_KEY env vars, shared config/profile, web identity, ECS/EC2 role). They are
 *   never read or logged by this module.
 */
export type S3StoreConfig = {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  prefix?: string;
  sse: "AES256" | "aws:kms" | "none";
  kmsKeyId?: string;
};

export class S3ObjectStore implements ObjectStore {
  readonly client: S3Client;
  constructor(
    private cfg: S3StoreConfig,
    client?: S3Client,
  ) {
    this.client =
      client ??
      new S3Client({
        region: cfg.region,
        ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
        ...(cfg.forcePathStyle ? { forcePathStyle: true } : {}),
      });
  }

  /** Bucket key for a storage key; rejects traversal/absolute keys like the local backend. */
  objectKey(key: string): string {
    if (!key || key.startsWith("/") || key.split("/").some((seg) => seg === ".." || seg === ".") || key.includes("\\") || key.includes("\0")) {
      throw new Error("invalid storage key");
    }
    const prefix = (this.cfg.prefix ?? "").replace(/^\/+|\/+$/g, "");
    return prefix ? `${prefix}/${key}` : key;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const input: PutObjectCommandInput = {
      Bucket: this.cfg.bucket,
      Key: this.objectKey(key),
      Body: bytes,
      ContentLength: bytes.byteLength,
      ContentType: "application/octet-stream",
    };
    if (this.cfg.sse === "AES256") input.ServerSideEncryption = "AES256";
    if (this.cfg.sse === "aws:kms") {
      input.ServerSideEncryption = "aws:kms";
      if (this.cfg.kmsKeyId) input.SSEKMSKeyId = this.cfg.kmsKeyId;
    }
    await this.client.send(new PutObjectCommand(input));
  }

  async get(key: string): Promise<Uint8Array> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: this.objectKey(key) }));
      if (!res.Body) throw new Error("object has no body");
      return await res.Body.transformToByteArray();
    } catch (e) {
      if (e instanceof NoSuchKey || (e as { name?: string })?.name === "NoSuchKey") {
        throw Object.assign(new Error("stored object not found"), { code: "ENOENT" });
      }
      throw e;
    }
  }

  /** Idempotent: deleting a missing key succeeds (S3 semantics). */
  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: this.objectKey(key) }));
  }
}
