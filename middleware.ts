import { NextRequest, NextResponse } from "next/server";

const REFRESH_COOKIE = "X-REFRESH-TOKEN";
const CANONICAL_HOST = "rvjp-dashboard.vercel.app";
const LEGACY_HOSTS = new Set(["rvjp-nextjs.vercel.app"]);

export default async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const host = req.headers.get("host")?.split(":")[0];

  if (host && LEGACY_HOSTS.has(host)) {
    const canonicalUrl = req.nextUrl.clone();
    canonicalUrl.protocol = "https";
    canonicalUrl.hostname = CANONICAL_HOST;
    canonicalUrl.port = "";
    return NextResponse.redirect(canonicalUrl, 308);
  }

  const hasRefreshCookie = Boolean(req.cookies.get(REFRESH_COOKIE)?.value);

  if (pathname === "/") {
    return NextResponse.redirect(
      new URL(hasRefreshCookie ? "/dashboard" : "/login", req.url),
    );
  }

  if (pathname === "/login" && hasRefreshCookie) {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  if (pathname === "/login" || pathname.startsWith("/health")) {
    return NextResponse.next();
  }

  if (!hasRefreshCookie) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon\\.ico|health|icons/|.*\\.png$|.*\\.jpg$|.*\\.jpeg$|.*\\.svg$|.*\\.ico$).*)"],
};
