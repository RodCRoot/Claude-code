import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mockClient } from "aws-sdk-client-mock";
import { DeleteObjectCommand, GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createObjectStore, deleteStoredBytes, LocalDiskStore, setObjectStoreForTests, storageConfigFromEnv, type ObjectStore } from "@/lib/storage";
import { S3ObjectStore } from "@/lib/storage-s3";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("storage config from env", () => {
  it("defaults to local disk under STORAGE_DIR", () => {
    expect(storageConfigFromEnv({})).toEqual({ backend: "local", dir: "./.storage" });
    expect(storageConfigFromEnv({ STORAGE_BACKEND: "local", STORAGE_DIR: "/srv/files" })).toEqual({ backend: "local", dir: "/srv/files" });
  });

  it("s3 requires bucket + region and names only the missing variables", () => {
    expect(() => storageConfigFromEnv({ STORAGE_BACKEND: "s3" })).toThrow("STORAGE_BACKEND=s3 requires S3_BUCKET, S3_REGION");
    expect(() => storageConfigFromEnv({ STORAGE_BACKEND: "gcs" })).toThrow(/must be "local" or "s3"/);
    expect(() => storageConfigFromEnv({ STORAGE_BACKEND: "s3", S3_BUCKET: "b", S3_REGION: "us-east-2", S3_SSE: "off" })).toThrow(/S3_SSE/);
  });

  it("s3 config: SSE defaults to AES256; endpoint/path-style/prefix/KMS are optional", () => {
    expect(storageConfigFromEnv({ STORAGE_BACKEND: "s3", S3_BUCKET: "tw", S3_REGION: "us-east-2" })).toEqual({
      backend: "s3",
      bucket: "tw",
      region: "us-east-2",
      endpoint: undefined,
      forcePathStyle: false,
      prefix: undefined,
      sse: "AES256",
      kmsKeyId: undefined,
    });
    const r2 = storageConfigFromEnv({
      STORAGE_BACKEND: "S3",
      S3_BUCKET: "tw",
      S3_REGION: "auto",
      S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
      S3_FORCE_PATH_STYLE: "true",
      S3_PREFIX: "staging",
      S3_SSE: "aws:kms",
      S3_KMS_KEY_ID: "alias/tw",
    });
    expect(r2).toMatchObject({ backend: "s3", endpoint: "https://acct.r2.cloudflarestorage.com", forcePathStyle: true, prefix: "staging", sse: "aws:kms", kmsKeyId: "alias/tw" });
    expect(createObjectStore(r2)).toBeInstanceOf(S3ObjectStore);
    expect(createObjectStore({ backend: "local", dir: "/tmp/x" })).toBeInstanceOf(LocalDiskStore);
  });
});

describe("local disk backend", () => {
  let dir: string;
  let store: LocalDiskStore;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tw-storage-"));
    store = new LocalDiskStore(dir);
  });
  afterAll(async () => {
    setObjectStoreForTests(null);
    await rm(dir, { recursive: true, force: true });
  });

  it("put/get round-trips bytes into nested keys with private file mode, no temp files left", async () => {
    await store.put("org/kind/2026-10-12/a.txt", bytes("hello"));
    expect(new TextDecoder().decode(await store.get("org/kind/2026-10-12/a.txt"))).toBe("hello");
    const st = await stat(path.join(dir, "org/kind/2026-10-12/a.txt"));
    expect(st.mode & 0o077).toBe(0);
    expect(await readdir(path.join(dir, "org/kind/2026-10-12"))).toEqual(["a.txt"]);
    await store.put("org/kind/2026-10-12/a.txt", bytes("v2"));
    expect(new TextDecoder().decode(await store.get("org/kind/2026-10-12/a.txt"))).toBe("v2");
  });

  it("delete removes the object and is idempotent", async () => {
    await store.put("org/x/b.bin", bytes("bye"));
    await store.delete("org/x/b.bin");
    await expect(store.get("org/x/b.bin")).rejects.toThrow();
    await expect(store.delete("org/x/b.bin")).resolves.toBeUndefined();
  });

  it("rejects keys that escape the root (including sibling-prefix directories)", async () => {
    for (const k of ["../evil", "a/../../evil", `../${path.basename(dir)}-evil/x`, "/etc/passwd", ""]) {
      await expect(store.put(k, bytes("x"))).rejects.toThrow("invalid storage key");
      await expect(store.delete(k)).rejects.toThrow("invalid storage key");
    }
  });

  it("deleteStoredBytes is best-effort: counts failures instead of throwing", async () => {
    await store.put("org/y/c.txt", bytes("c"));
    const failing: ObjectStore = {
      put: store.put.bind(store),
      get: store.get.bind(store),
      delete: async (k) => {
        if (k.includes("boom")) throw new Error("network down");
        return store.delete(k);
      },
    };
    setObjectStoreForTests(failing);
    expect(await deleteStoredBytes(["org/y/c.txt", "org/y/boom.txt"])).toEqual({ deleted: 1, failed: 1 });
    await expect(store.get("org/y/c.txt")).rejects.toThrow();
  });
});

describe("S3 backend (mocked client)", () => {
  const s3 = mockClient(S3Client);
  beforeEach(() => s3.reset());

  const make = (over: Partial<ConstructorParameters<typeof S3ObjectStore>[0]> = {}) =>
    new S3ObjectStore({ bucket: "tw-staging", region: "us-east-2", sse: "AES256", ...over }, new S3Client({ region: "us-east-2" }));

  it("put sends a private, server-side-encrypted object (no ACL) under the prefix", async () => {
    s3.on(PutObjectCommand).resolves({});
    await make({ prefix: "/staging/" }).put("org/form_pdf/2026-10-12/f.pdf", bytes("%PDF"));
    const calls = s3.commandCalls(PutObjectCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0].args[0].input;
    expect(input).toMatchObject({ Bucket: "tw-staging", Key: "staging/org/form_pdf/2026-10-12/f.pdf", ServerSideEncryption: "AES256", ContentLength: 4 });
    expect(input).not.toHaveProperty("ACL");
    expect(input).not.toHaveProperty("SSEKMSKeyId");
  });

  it("SSE-KMS passes the key id; S3_SSE=none omits the header", async () => {
    s3.on(PutObjectCommand).resolves({});
    await make({ sse: "aws:kms", kmsKeyId: "alias/tw" }).put("k1", bytes("a"));
    await make({ sse: "none" }).put("k2", bytes("b"));
    const [kms, none] = s3.commandCalls(PutObjectCommand).map((c) => c.args[0].input);
    expect(kms).toMatchObject({ ServerSideEncryption: "aws:kms", SSEKMSKeyId: "alias/tw" });
    expect(none.ServerSideEncryption).toBeUndefined();
  });

  it("get returns the body bytes; a missing key becomes an ENOENT-style error", async () => {
    s3.on(GetObjectCommand, { Bucket: "tw-staging", Key: "org/a.txt" }).resolves({
      Body: { transformToByteArray: async () => bytes("from s3") } as never,
    });
    s3.on(GetObjectCommand, { Bucket: "tw-staging", Key: "org/missing.txt" }).rejects(new NoSuchKey({ message: "nope", $metadata: {} }));
    const store = make();
    expect(new TextDecoder().decode(await store.get("org/a.txt"))).toBe("from s3");
    await expect(store.get("org/missing.txt")).rejects.toMatchObject({ code: "ENOENT", message: "stored object not found" });
  });

  it("delete issues DeleteObject for the prefixed key", async () => {
    s3.on(DeleteObjectCommand).resolves({});
    await make({ prefix: "p" }).delete("org/a.txt");
    expect(s3.commandCalls(DeleteObjectCommand)[0].args[0].input).toEqual({ Bucket: "tw-staging", Key: "p/org/a.txt" });
  });

  it("rejects traversal / absolute keys before calling S3", async () => {
    const store = make();
    for (const k of ["../x", "a/../b", "/abs", "a\\b", ""]) await expect(store.put(k, bytes("x"))).rejects.toThrow("invalid storage key");
    expect(s3.calls()).toHaveLength(0);
  });
});
