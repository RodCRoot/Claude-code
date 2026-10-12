import { afterAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { closeTestDb } from "./helpers/db";
import { GET } from "@/app/api/health/route";
import { getPool } from "@/db";
import { basicAuthOk, buildCsp, proxy } from "@/proxy";

afterAll(closeTestDb);

describe("GET /api/health", () => {
  it("200 {status: ok} when the database answers; nothing else is disclosed", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("503 {status: unavailable} without leaking the error when the database fails", async () => {
    const spy = vi.spyOn(getPool(), "query").mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2") as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ status: "unavailable" });
    expect(body).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|hunter2/);
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toContain("health_check_failed");
    spy.mockRestore();
    err.mockRestore();
  });
});

describe("Content-Security-Policy", () => {
  const directives = (csp: string) => Object.fromEntries(csp.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1).join(" ")]));

  it("production policy: nonce + strict-dynamic, no unsafe-eval/inline scripts, no third-party script hosts", () => {
    const d = directives(buildCsp({ nonce: "abc123", pathname: "/today", isDev: false, https: true }));
    expect(d["script-src"]).toBe("'self' 'nonce-abc123' 'strict-dynamic'");
    expect(d["style-src"]).toBe("'self' 'nonce-abc123'");
    expect(d["object-src"]).toBe("'none'");
    expect(d["frame-ancestors"]).toBe("'none'");
    expect(d["base-uri"]).toBe("'self'");
    expect(d["form-action"]).toBe("'self'");
    expect(d["connect-src"]).toBe("'self'");
    expect("upgrade-insecure-requests" in d).toBe(true);
    expect(JSON.stringify(d)).not.toMatch(/unsafe-eval|paypal|stripe/);
  });

  it("only the invoice payment page may post to hosted checkout", () => {
    const pay = directives(buildCsp({ nonce: "n", pathname: "/billing/invoices/123e4567-e89b-12d3-a456-426614174000", isDev: false, https: true }));
    expect(pay["form-action"]).toBe("'self' https://checkout.stripe.com https://www.paypal.com https://www.sandbox.paypal.com");
    expect(pay["script-src"]).not.toMatch(/paypal|stripe/);
    const list = directives(buildCsp({ nonce: "n", pathname: "/billing/invoices", isDev: false, https: true }));
    expect(list["form-action"]).toBe("'self'");
  });

  it("development adds unsafe-eval (React debugging) and HMR websockets; http omits upgrade-insecure-requests", () => {
    const d = directives(buildCsp({ nonce: "n", pathname: "/", isDev: true, https: false }));
    expect(d["script-src"]).toContain("'unsafe-eval'");
    expect(d["connect-src"]).toContain("ws:");
    expect("upgrade-insecure-requests" in d).toBe(false);
  });

  it("proxy sets a fresh nonce per request on pages (header + x-nonce), and no CSP on /api", () => {
    const a = proxy(new NextRequest("http://localhost:3105/login"));
    const b = proxy(new NextRequest("http://localhost:3105/login"));
    const nonceOf = (csp: string | null) => /'nonce-([^']+)'/.exec(csp ?? "")?.[1];
    const na = nonceOf(a.headers.get("content-security-policy"));
    expect(na).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(na).not.toBe(nonceOf(b.headers.get("content-security-policy")));
    expect(a.headers.get("x-middleware-request-x-nonce")).toBe(na);
    const api = proxy(new NextRequest("http://localhost:3105/api/health"));
    expect(api.headers.get("content-security-policy")).toBeNull();
    expect(api.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("private staging gate (STAGING_BASIC_AUTH_*)", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64");

  it("basicAuthOk accepts only the exact credential", () => {
    expect(basicAuthOk(`Basic ${b64("staff:pa:ss")}`, "staff", "pa:ss")).toBe(true);
    expect(basicAuthOk(`Basic ${b64("staff:wrong")}`, "staff", "pa:ss")).toBe(false);
    expect(basicAuthOk(`Basic ${b64("staf:pa:ss")}`, "staff", "pa:ss")).toBe(false);
    expect(basicAuthOk(`Basic ${b64("nocolon")}`, "staff", "pa:ss")).toBe(false);
    expect(basicAuthOk("Bearer abc", "staff", "pa:ss")).toBe(false);
    expect(basicAuthOk(null, "staff", "pa:ss")).toBe(false);
  });

  it("when configured, every page needs the credential except health and webhooks", () => {
    process.env.STAGING_BASIC_AUTH_USER = "staff";
    process.env.STAGING_BASIC_AUTH_PASSWORD = "s3cret-staging";
    try {
      const denied = proxy(new NextRequest("http://localhost:3105/login"));
      expect(denied.status).toBe(401);
      expect(denied.headers.get("www-authenticate")).toMatch(/^Basic realm=/);
      const ok = proxy(new NextRequest("http://localhost:3105/login", { headers: { authorization: `Basic ${b64("staff:s3cret-staging")}` } }));
      expect(ok.status).toBe(200);
      expect(ok.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(proxy(new NextRequest("http://localhost:3105/api/health")).status).toBe(200);
      expect(proxy(new NextRequest("http://localhost:3105/api/webhooks/stripe", { method: "POST" })).status).toBe(200);
      expect(proxy(new NextRequest("http://localhost:3105/api/files/x")).status).toBe(401);
    } finally {
      delete process.env.STAGING_BASIC_AUTH_USER;
      delete process.env.STAGING_BASIC_AUTH_PASSWORD;
    }
    expect(proxy(new NextRequest("http://localhost:3105/login")).status).toBe(200);
  });
});
