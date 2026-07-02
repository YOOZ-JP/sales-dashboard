import { NextResponse } from "next/server";

const REFRESH_COOKIE = "X-REFRESH-TOKEN";
const TEMP_REFRESH_TOKEN="rvjp-temporary-mock-refresh-token";

function getCookie(header: string | null, name: string): string | null {
  const match = header
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`) && part.length > name.length + 1);
  if (!match) return null;
  return decodeURIComponent(match.slice(name.length + 1));
}

function isAcceptedRefreshToken(token: string | null): boolean {
  if (!token) return false;

  // Current temporary dashboard access issues a fixed refresh cookie. Do not
  // accept an arbitrary cookie value here: these settlement routes can use the
  // Supabase service role and must require a cookie value issued by our login
  // route, not just a caller-supplied cookie name.
  if (token === TEMP_REFRESH_TOKEN) return true;

  return false;
}

export function requireSettlementApiAuth(request: Request): NextResponse | null {
  const token = getCookie(request.headers.get("cookie"), REFRESH_COOKIE);
  if (!isAcceptedRefreshToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
