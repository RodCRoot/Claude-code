import { NextResponse, type NextRequest } from "next/server";

/**
 * Security headers (incl. a per-request nonce-based Content-Security-Policy) + an optimistic
 * redirect for signed-out users on app routes. Real authorization happens server-side in every
 * page, action, and route handler.
 */
const APP_PREFIXES = ["/today", "/people", "/schedule", "/billing", "/training", "/science", "/performance", "/messages", "/documents", "/reports", "/settings", "/imports", "/kiosk"];

/**
 * Hosted checkout pages a payment form may be redirected to (Stripe Checkout / PayPal approval).
 * Only allowed as form targets on the invoice page that renders the "Pay" form; the app loads no
 * third-party scripts (no PayPal JS SDK / Stripe.js), so script-src stays first-party.
 */
const CHECKOUT_FORM_TARGETS = ["https://checkout.stripe.com", "https://www.paypal.com", "https://www.sandbox.paypal.com"];
const PAYMENT_PAGE = /^\/billing\/invoices\/[^/]+$/;

export function buildCsp(opts: { nonce: string; pathname: string; isDev: boolean; https: boolean }): string {
  const { nonce, pathname, isDev, https } = opts;
  const formAction = ["'self'", ...(PAYMENT_PAGE.test(pathname) ? CHECKOUT_FORM_TARGETS : [])];
  const directives = [
    `default-src 'self'`,
    // 'strict-dynamic': scripts loaded by nonce'd Next.js bundles are trusted; nothing else is.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' ${isDev ? "'unsafe-inline'" : `'nonce-${nonce}'`}`,
    // React `style={…}` attributes (progress bars, charts) — attributes cannot carry a nonce and
    // cannot execute script; <style> elements still require the nonce.
    `style-src-attr 'unsafe-inline'`,
    `img-src 'self' blob: data:`,
    `font-src 'self'`,
    `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
    `media-src 'self'`,
    `worker-src 'self' blob:`,
    `manifest-src 'self'`,
    `frame-src 'none'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action ${formAction.join(" ")}`,
    `frame-ancestors 'none'`,
    ...(https ? ["upgrade-insecure-requests"] : []),
  ];
  return directives.join("; ");
}

/**
 * Optional site-wide HTTP Basic Auth for a PRIVATE staging deployment (STAGING_BASIC_AUTH_USER +
 * STAGING_BASIC_AUTH_PASSWORD). It sits in front of the app's own login, so nobody without the
 * shared staging credential can even see the sign-in page. Exempt: the health check (load
 * balancer) and payment webhooks (providers can't send basic auth; they are signature-verified).
 */
const BASIC_AUTH_EXEMPT = [/^\/api\/health$/, /^\/api\/webhooks\//];

function timingSafeEqualStr(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export function basicAuthOk(authorization: string | null, user: string, password: string): boolean {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(authorization ?? "");
  if (!m) return false;
  let decoded: string;
  try {
    decoded = new TextDecoder().decode(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0)));
  } catch {
    return false;
  }
  const i = decoded.indexOf(":");
  if (i < 0) return false;
  // Evaluate both comparisons (no short-circuit) so timing doesn't reveal which part was wrong.
  const u = timingSafeEqualStr(decoded.slice(0, i), user);
  const p = timingSafeEqualStr(decoded.slice(i + 1), password);
  return u && p;
}

function makeNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const gateUser = process.env.STAGING_BASIC_AUTH_USER;
  const gatePass = process.env.STAGING_BASIC_AUTH_PASSWORD;
  if (gateUser && gatePass && !BASIC_AUTH_EXEMPT.some((r) => r.test(pathname)) && !basicAuthOk(request.headers.get("authorization"), gateUser, gatePass)) {
    return new NextResponse("Authentication required.", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Teamwork Hub staging", charset="UTF-8"', "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" },
    });
  }
  if (APP_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/")) && !request.cookies.has("tw_session")) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", pathname);

  // API route handlers return JSON/files and set their own (stricter) CSP where they serve bytes.
  const isApi = pathname.startsWith("/api/");
  let csp: string | null = null;
  if (!isApi) {
    const nonce = makeNonce();
    const https = request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https" || (process.env.APP_URL ?? "").startsWith("https://");
    csp = buildCsp({ nonce, pathname, isDev: process.env.NODE_ENV === "development", https });
    // Next.js reads the nonce from the request's CSP header and applies it to its own scripts/styles.
    requestHeaders.set("x-nonce", nonce);
    requestHeaders.set("Content-Security-Policy", csp);
  }

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  if (csp) res.headers.set("Content-Security-Policy", csp);
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(self)");
  if (process.env.NODE_ENV === "production") res.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  // Demo and staging deployments must never show up in search results.
  if (process.env.APP_MODE !== "production") res.headers.set("X-Robots-Tag", "noindex, nofollow");
  // Private data must never be cached by shared caches.
  if (!pathname.startsWith("/_next") && pathname !== "/" && !pathname.startsWith("/programs") && !pathname.startsWith("/classes")) {
    res.headers.set("Cache-Control", "private, no-store");
  }
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
