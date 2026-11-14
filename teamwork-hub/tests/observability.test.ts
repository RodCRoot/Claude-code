import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyKey,
  formatLog,
  initMonitoring,
  redact,
  redactString,
  REDACTED,
  REDACTED_EMAIL,
  REDACTED_HEALTH,
  reportError,
  scrubSentryEvent,
  sentryClient,
  serializeError,
} from "@/lib/observability";

describe("redactString", () => {
  it("scrubs emails, bearer/basic credentials, JWTs, provider keys, URL passwords, and secret query params", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefghijk_-";
    const s = redactString(
      `user alex.parker@example.test failed; Authorization: Bearer abc.def-123456789; Basic dXNlcjpwYXNzd29yZA==; ` +
        `jwt=${jwt}; key sk_live_51Habcdef123 whsec_test_abcdef1234; ` +
        `postgres://teamwork:s3cr3t@db.internal:5432/hub; https://x.test/cb?code=AUTHCODE&state=1&token=tok123`,
    );
    expect(s).not.toMatch(/alex\.parker|abc\.def-123456789|dXNlcjpwYXNzd29yZA|s3cr3t|AUTHCODE|tok123|sk_live_51H|whsec_test_abc|eyJhbGci/);
    expect(s).toContain(REDACTED_EMAIL);
    expect(s).toContain(`postgres://teamwork:${REDACTED}@db.internal:5432/hub`);
    expect(s).toContain("state=1");
  });

  it("scrubs long hex secrets (session secrets, refresh tokens) but keeps UUIDs and short ids", () => {
    const hex = "d468dd42a28bc0624dbbabff7faed2088280a5e2cd62ae5808a6cd84d577fab0";
    const uuid = "466976be-f66d-4889-b49c-7a6df032b2dd";
    expect(redactString(`secret ${hex} for ${uuid}`)).toBe(`secret ${REDACTED} for ${uuid}`);
  });
});

describe("redact (structured fields)", () => {
  it("classifies keys on word boundaries", () => {
    expect(classifyKey("password")).toBe("secret");
    expect(classifyKey("SESSION_SECRET")).toBe("secret");
    expect(classifyKey("refreshToken")).toBe("secret");
    expect(classifyKey("authorization")).toBe("secret");
    expect(classifyKey("api_key")).toBe("secret");
    expect(classifyKey("wellnessScore")).toBe("health");
    expect(classifyKey("injuryNotes")).toBe("health");
    expect(classifyKey("body_map")).toBe("health");
    expect(classifyKey("rpe")).toBe("health");
    expect(classifyKey("medicalConditions")).toBe("health");
    expect(classifyKey("guardianEmail")).toBe("contact");
    expect(classifyKey("phone")).toBe("contact");
    // Not sensitive: no false positives on look-alike words.
    for (const k of ["purpose", "authorId", "storageKey", "dedupeKey", "sessionId", "where", "type", "status", "orgId", "attempts"]) {
      expect(classifyKey(k), k).toBeNull();
    }
  });

  it("masks secrets, health data, and contact fields deeply, keeping ids and shape", () => {
    const input = {
      where: "action",
      orgId: "466976be-f66d-4889-b49c-7a6df032b2dd",
      user: { id: "u1", email: "alex.parker@example.test", password: "hunter2" },
      headers: { authorization: "Bearer xyz123456789", cookie: "tw_session=abc", "user-agent": "Mozilla" },
      athlete: { firstName: "Maya", wellness: { sleep: 4, soreness: 7 }, injuries: ["ACL"], healthNotes: "asthma" },
      list: [{ token: "t" }, { note: "contact jordan.parker@example.test" }],
      emptySecret: "",
      nothing: null,
    };
    const out = redact(input);
    expect(out.where).toBe("action");
    expect(out.orgId).toBe(input.orgId);
    expect(out.user).toEqual({ id: "u1", email: REDACTED, password: REDACTED });
    expect(out.headers).toEqual({ authorization: REDACTED, cookie: REDACTED, "user-agent": "Mozilla" });
    expect(out.athlete).toEqual({ firstName: "Maya", wellness: REDACTED_HEALTH, injuries: REDACTED_HEALTH, healthNotes: REDACTED_HEALTH });
    expect(out.list).toEqual([{ token: REDACTED }, { note: REDACTED_HEALTH }]);
    expect(out.emptySecret).toBe("");
    expect(out.nothing).toBeNull();
    // Input untouched.
    expect(input.user.password).toBe("hunter2");
  });

  it("survives cycles, depth, bytes, dates, maps, and bigints", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    const out = redact({ a, deep, bytes: new Uint8Array(5), at: new Date("2026-10-12T00:00:00Z"), m: new Map([["secret", "x"]]), n: BigInt(5) });
    expect((out.a as Record<string, unknown>).self).toBe("[circular]");
    expect(JSON.stringify(out.deep)).toContain("[depth]");
    expect(out.bytes).toBe("[5 bytes]");
    expect(out.at).toBe("2026-10-12T00:00:00.000Z");
    expect(out.m).toEqual({ secret: REDACTED });
    expect(out.n).toBe("5");
  });

  it("serializes errors with redacted message, stack, and cause", () => {
    const e = new Error("insert failed for dana.brooks@example.test", { cause: Object.assign(new Error("password authentication failed for postgres://u:pw@h/db"), { code: "28P01" }) });
    const s = serializeError(e);
    expect(s.message).toBe(`insert failed for ${REDACTED_EMAIL}`);
    expect(String(s.stack)).not.toContain("dana.brooks");
    expect(s.cause).toMatchObject({ code: "28P01" });
    expect(JSON.stringify(s)).not.toContain(":pw@");
  });
});

describe("log lines and Sentry scrubbing", () => {
  afterEach(() => vi.restoreAllMocks());

  it("formatLog emits one JSON object with redacted fields", () => {
    const line = formatLog("error", "job_failed", { jobId: "j1", payload: { to: "x@y.test", apiKey: "k", soreness: 9 } });
    const parsed = JSON.parse(line);
    expect(parsed).toMatchObject({ level: "error", msg: "job_failed", jobId: "j1", payload: { to: REDACTED_EMAIL, apiKey: REDACTED, soreness: REDACTED_HEALTH } });
    expect(typeof parsed.t).toBe("string");
    expect(line).not.toContain("x@y.test");
  });

  it("reportError logs redacted JSON to stderr and is a no-op for Sentry without SENTRY_DSN", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const prev = process.env.SENTRY_DSN;
    delete process.env.SENTRY_DSN;
    expect(await initMonitoring("web")).toBeNull();
    expect(sentryClient()).toBeNull();
    reportError(new Error("boom for maya.parker@example.test"), { where: "action", formData: { password: "p" } });
    expect(spy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(String(spy.mock.calls[0][0]));
    expect(parsed).toMatchObject({ level: "error", msg: "unexpected_error", where: "action", formData: { password: REDACTED } });
    expect(parsed.error.message).toBe(`boom for ${REDACTED_EMAIL}`);
    if (prev !== undefined) process.env.SENTRY_DSN = prev;
  });

  it("scrubSentryEvent drops cookies/bodies/query strings and redacts extras", () => {
    const ev = scrubSentryEvent({
      request: {
        method: "POST",
        url: "https://hub.test/billing/invoices/1?token=abc",
        headers: { cookie: "tw_session=s", authorization: "Bearer z", "user-agent": "UA" },
        cookies: { tw_session: "s" },
        data: { password: "p" },
        query_string: "token=abc",
      },
      user: { id: "u1", email: "a@b.test", ip_address: "1.2.3.4" },
      extra: { athleteNotes: "knee pain", email: "a@b.test", objectId: "o1" },
      exception: { values: [{ type: "Error", value: "failed for a@b.test" }] },
    });
    expect(ev.request).toEqual({ method: "POST", url: "https://hub.test/billing/invoices/1", headers: { "user-agent": "UA" } });
    expect(ev.user).toEqual({ id: "u1" });
    expect(ev.extra).toEqual({ athleteNotes: REDACTED_HEALTH, email: REDACTED, objectId: "o1" });
    expect(JSON.stringify(ev.exception)).not.toContain("a@b.test");
  });
});
