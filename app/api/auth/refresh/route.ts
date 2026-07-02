import { NextRequest, NextResponse } from "next/server";

const ROLES_NAMESPACE = "https://api.riverse.net/roles";

function extractRoles(accessToken: string): string[] {
  try {
    const payload = JSON.parse(
      Buffer.from(accessToken.split(".")[1], "base64url").toString(),
    );
    return payload[ROLES_NAMESPACE] ?? [];
  } catch {
    return [];
  }
}

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN!;
const AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID!;
const AUTH0_CLIENT_SECRET = process.env.AUTH0_CLIENT_SECRET!;
const REFRESH_TOKEN_MAX_AGE = 60 * 60 * 24 * 7;
const TEMP_ACCESS_TOKEN = "rvjp-temporary-mock-access-token";
const TEMP_REFRESH_TOKEN = "rvjp-temporary-mock-refresh-token";

export async function POST(request: NextRequest) {
  const refreshToken = request.cookies.get("X-REFRESH-TOKEN")?.value;
  if (!refreshToken) {
    return NextResponse.json({ error: "No refresh token" }, { status: 401 });
  }

  // TODO: 임시 우회 로그인입니다. 운영 Auth0 복구 후 제거하세요.
  if (refreshToken === TEMP_REFRESH_TOKEN) {
    return NextResponse.json({
      accessToken: TEMP_ACCESS_TOKEN,
      expiresIn: REFRESH_TOKEN_MAX_AGE,
    });
  }

  const auth0Res = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: AUTH0_CLIENT_ID,
      client_secret: AUTH0_CLIENT_SECRET,
      refresh_token: refreshToken,
    }),
  });

  const data = await auth0Res.json();

  if (!auth0Res.ok) {
    const response = NextResponse.json(
      { error: "Refresh failed" },
      { status: 401 },
    );
    response.cookies.set("X-REFRESH-TOKEN", "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
    return response;
  }

  // ADMIN role 체크 — role이 제거된 사용자는 refresh 시 차단
  const roles = extractRoles(data.access_token);
  if (!roles.includes("ADMIN")) {
    const forbidden = NextResponse.json(
      { error: "관리자 권한이 없습니다." },
      { status: 403 },
    );
    forbidden.cookies.set("X-REFRESH-TOKEN", "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
    return forbidden;
  }

  const response = NextResponse.json({
    accessToken: data.access_token,
    expiresIn: data.expires_in,
  });

  // Refresh Token Rotation
  if (data.refresh_token) {
    response.cookies.set("X-REFRESH-TOKEN", data.refresh_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: REFRESH_TOKEN_MAX_AGE,
    });
  }

  return response;
}
