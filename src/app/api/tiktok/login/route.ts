 import { NextResponse } from "next/server";

export async function GET() {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const redirectUri = process.env.TIKTOK_REDIRECT_URI;

  if (!clientKey || !redirectUri) {
    return NextResponse.json(
      { ok: false, error: "Missing TIKTOK_CLIENT_KEY or TIKTOK_REDIRECT_URI" },
      { status: 500 }
    );
  }

  const state = crypto.randomUUID();

  const authUrl =
    "https://www.tiktok.com/v2/auth/authorize/?" +
    new URLSearchParams({
      client_key: clientKey,
      scope: "user.info.basic,video.upload",
      response_type: "code",
      redirect_uri: redirectUri,
      state,
    }).toString();

  const res = NextResponse.redirect(authUrl);

  // anti-CSRF básico
  res.cookies.set("tiktok_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 10 * 60,
  });

  return res;
}