import { NextResponse, type NextRequest } from "next/server";

/**
 * Security headers + an optimistic redirect for signed-out users on app routes.
 * Real authorization happens server-side in every page, action, and route handler.
 */
const APP_PREFIXES = ["/today", "/people", "/schedule", "/billing", "/training", "/science", "/performance", "/messages", "/documents", "/reports", "/settings", "/imports", "/kiosk"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (APP_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/")) && !request.cookies.has("tw_session")) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", pathname);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(self)");
  if (process.env.NODE_ENV === "production") res.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  // Private data must never be cached by shared caches.
  if (!pathname.startsWith("/_next") && pathname !== "/" && !pathname.startsWith("/programs") && !pathname.startsWith("/classes")) {
    res.headers.set("Cache-Control", "private, no-store");
  }
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
