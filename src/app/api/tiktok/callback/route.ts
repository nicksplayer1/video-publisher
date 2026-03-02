import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDesc = url.searchParams.get("error_description");

  if (error) {
    return NextResponse.json({ ok: false, error, errorDesc }, { status: 400 });
  }
  if (!code) {
    return NextResponse.json({ ok: false, error: "Missing code" }, { status: 400 });
  }

  // valida state (se cookie existir)
  const cookie = req.headers.get("cookie") ?? "";
  const cookieState = cookie.match(/tiktok_oauth_state=([^;]+)/)?.[1];
  if (cookieState && state && cookieState !== state) {
    return NextResponse.json({ ok: false, error: "Invalid state" }, { status: 400 });
  }

  const clientKey = process.env.TIKTOK_CLIENT_KEY!;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET!;
  const redirectUri = process.env.TIKTOK_REDIRECT_URI!;

  const tokenRes = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });

  const tokenJson: any = await tokenRes.json();

  if (!tokenRes.ok) {
    return NextResponse.json({ ok: false, tokenJson }, { status: 400 });
  }

  const access_token = tokenJson.access_token as string;
  const refresh_token = (tokenJson.refresh_token as string) ?? "";
  const expires_in = tokenJson.expires_in as number; // segundos
  const scope = tokenJson.scope as string | undefined;
  const token_type = tokenJson.token_type as string | undefined;

  const expires_at = new Date(Date.now() + expires_in * 1000).toISOString();

  // precisa existir a tabela tiktok_tokens (vou te passar SQL logo abaixo)
  const { error: upErr } = await supabaseAdmin
    .from("tiktok_tokens")
    .upsert(
      [{ id: "main", access_token, refresh_token, expires_at, scope, token_type }],
      { onConflict: "id" }
    );

  if (upErr) {
    return NextResponse.json({ ok: false, error: upErr.message }, { status: 500 });
  }

  // volta pro site
  return NextResponse.redirect(new URL("/?tiktok=connected", url.origin));
}