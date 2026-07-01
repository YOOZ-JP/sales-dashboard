import { NextResponse } from "next/server";

const REFRESH_COOKIE = "X-REFRESH-TOKEN";

function hasCookie(header: string | null, name: string): boolean {
  if (!header) return false;
  return header
    .split(";")
    .map((part) => part.trim())
    .some((part) => part.startsWith(`${name}=`) && part.length > name.length + 1);
}

export function requireSettlementApiAuth(request: Request): NextResponse | null {
  if (!hasCookie(request.headers.get("cookie"), REFRESH_COOKIE)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
