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
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE!;
const REFRESH_TOKEN_MAX_AGE = 60 * 60 * 24 * 7; // 7일
const TEMP_ACCESS_TOKEN = "rvjp-temporary-mock-access-token";
const TEMP_REFRESH_TOKEN = "rvjp-temporary-mock-refresh-token";

export async function POST(request: NextRequest) {
  const { email, password } = (await request.json()) as {
    email: string;
    password: string;
  };

  // TODO: 임시 우회 로그인입니다. 운영 Auth0 메일/로그인 이슈 해결 후 반드시 제거하고 Auth0 흐름으로 복구하세요.
  if (/^\d+$/.test(String(password ?? ""))) {
    const response = NextResponse.json({
      accessToken: TEMP_ACCESS_TOKEN,
      expiresIn: REFRESH_TOKEN_MAX_AGE,
      user: {
        email: "temporary@riverse.local",
        name: "RIVERSE 임시 접속",
      },
    });

    response.cookies.set("X-REFRESH-TOKEN", TEMP_REFRESH_TOKEN, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: REFRESH_TOKEN_MAX_AGE,
    });

    return response;
  }

  const auth0Res = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "password",
      client_id: AUTH0_CLIENT_ID,
      client_secret: AUTH0_CLIENT_SECRET,
      audience: AUTH0_AUDIENCE,
      scope: "openid profile email offline_access",
      username: email,
      password,
    }),
  });

  const data = await auth0Res.json();

  if (!auth0Res.ok) {
    return NextResponse.json(
      { error: data.error_description ?? data.error },
      { status: auth0Res.status },
    );
  }

  // ADMIN role 체크
  const roles = extractRoles(data.access_token);
  if (!roles.includes("ADMIN")) {
    return NextResponse.json(
      { error: "관리자 권한이 없습니다. 관리자에게 문의하세요." },
      { status: 403 },
    );
  }

  const response = NextResponse.json({
    accessToken: data.access_token,
    expiresIn: data.expires_in,
  });

  response.cookies.set("X-REFRESH-TOKEN", data.refresh_token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: REFRESH_TOKEN_MAX_AGE,
  });

  return response;
}
