import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function GET() {
  return NextResponse.json({ ok: true, route: "/api/tiktok/post/status", method: "GET" });
}

export async function POST(req: NextRequest) {
  try {
    const { publish_id } = await req.json().catch(() => ({}));

    if (!publish_id) {
      return NextResponse.json(
        { ok: false, error: "Missing publish_id" },
        { status: 400 }
      );
    }

    const { data: tok, error: tokErr } = await supabaseAdmin
      .from("tiktok_tokens")
      .select("access_token, scope, expires_at, open_id")
      .eq("id", "main")
      .single();

    if (tokErr || !tok?.access_token) {
      return NextResponse.json(
        { ok: false, where: "supabase_read_token", error: tokErr?.message ?? "No token" },
        { status: 500 }
      );
    }

    const res = await fetch("https://open.tiktokapis.com/v2/post/publish/status/fetch/", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tok.access_token}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({ publish_id }),
    });

    const raw = await res.text();
    let json: any = null;
    try { json = JSON.parse(raw); } catch {}

    // TikTok pode responder 200 com error.code != "ok"
    const apiErrorCode = json?.error?.code;
    const isOk = res.ok && (!apiErrorCode || apiErrorCode === "ok");

    return NextResponse.json({
      ok: isOk,
      where: "tiktok_status_fetch",
      status: res.status,
      publish_id,
      token: {
        open_id: tok.open_id,
        scope: tok.scope,
        expires_at: tok.expires_at,
      },
      response: json ?? raw,
    }, { status: isOk ? 200 : 502 });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, where: "catch", error: e?.message ?? String(e) },
      { status: 500 }
    );
  }
}