 // src/app/api/tiktok/callback/route.ts
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

function redact(str?: string | null) {
  if (!str) return null;
  if (str.length <= 8) return "***";
  return str.slice(0, 4) + "..." + str.slice(-4);
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    const error_description = url.searchParams.get("error_description");

    console.log("[tiktok/callback] query", {
      hasCode: !!code,
      state: state ? redact(state) : null,
      error,
      error_description,
    });

    if (error) {
      return NextResponse.json(
        { ok: false, where: "tiktok_redirect", error, error_description },
        { status: 400 }
      );
    }

    if (!code) {
      return NextResponse.json(
        { ok: false, where: "missing_code", error: "No code in callback" },
        { status: 400 }
      );
    }

    const clientKey = process.env.TIKTOK_CLIENT_KEY;
    const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
    const redirectUri = process.env.TIKTOK_REDIRECT_URI;

    console.log("[tiktok/callback] env check", {
      clientKey: redact(clientKey),
      clientSecret: clientSecret ? "***" : null,
      redirectUri,
    });

    if (!clientKey || !clientSecret || !redirectUri) {
      return NextResponse.json(
        { ok: false, where: "env", error: "Missing TikTok env vars" },
        { status: 500 }
      );
    }

    // IMPORTANT: TikTok costuma exigir x-www-form-urlencoded.
    const body = new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    });

    console.log("[tiktok/callback] exchanging code for token...", {
      redirectUri,
      code: redact(code),
    });

    // Endpoint pode variar por produto/versão. Se você já tinha um endpoint definido, mantenha o MESMO.
    // Aqui fica como exemplo; se seu app usa outro endpoint oficial, substitua.
    const tokenRes = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const rawText = await tokenRes.text();
    let tokenJson: any = null;

    try {
      tokenJson = JSON.parse(rawText);
    } catch {
      // se não vier JSON, loga o texto cru
    }

    console.log("[tiktok/callback] token response", {
      ok: tokenRes.ok,
      status: tokenRes.status,
      bodyPreview: rawText?.slice(0, 300),
    });

    if (!tokenRes.ok) {
      return NextResponse.json(
        {
          ok: false,
          where: "token_exchange",
          status: tokenRes.status,
          response: tokenJson ?? rawText,
        },
        { status: 502 }
      );
    }

    // Ajuste conforme formato real que seu endpoint retorna
    const access_token =
      tokenJson?.access_token || tokenJson?.data?.access_token;
    const refresh_token =
      tokenJson?.refresh_token || tokenJson?.data?.refresh_token;
    const expires_in =
      tokenJson?.expires_in || tokenJson?.data?.expires_in;
    const open_id = tokenJson?.open_id || tokenJson?.data?.open_id;
    const scope = tokenJson?.scope || tokenJson?.data?.scope;

    if (!access_token) {
      return NextResponse.json(
        {
          ok: false,
          where: "token_parse",
          error: "No access_token in token response",
          response: tokenJson ?? rawText,
        },
        { status: 500 }
      );
    }

    const expires_at = expires_in
      ? new Date(Date.now() + Number(expires_in) * 1000).toISOString()
      : null;

    // Salvar no Supabase (upsert num registro fixo, ex: id="main")
    const { error: dbErr } = await supabaseAdmin
      .from("tiktok_tokens")
      .upsert(
        {
          id: "main",
          access_token,
          refresh_token,
          expires_at,
          open_id,
          scope: typeof scope === "string" ? scope : JSON.stringify(scope),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" }
      );

    if (dbErr) {
      console.log("[tiktok/callback] supabase error", dbErr);
      return NextResponse.json(
        { ok: false, where: "supabase", error: dbErr.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      connected: true,
      open_id,
      expires_at,
    });
  } catch (e: any) {
    console.log("[tiktok/callback] unhandled error", e);
    return NextResponse.json(
      { ok: false, where: "catch", error: e?.message ?? String(e) },
      { status: 500 }
    );
  }
}