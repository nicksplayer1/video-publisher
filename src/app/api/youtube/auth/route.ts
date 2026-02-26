 export const runtime = "nodejs";

import { NextResponse } from "next/server";

export async function GET() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return NextResponse.json(
      {
        ok: false,
        error: "Missing env vars",
        hasClientId: !!clientId,
        hasRedirectUri: !!redirectUri,
      },
      { status: 500 }
    );
  }

  const scopes = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube",
  ];

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("access_type", "offline"); // refresh_token
  url.searchParams.set("prompt", "consent"); // força refresh_token na 1ª vez
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("include_granted_scopes", "true");

  return NextResponse.redirect(url.toString());
}