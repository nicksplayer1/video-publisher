 import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

// GET só pra você testar no browser e confirmar que a rota existe no deploy
export async function GET() {
  return NextResponse.json({ ok: true, route: "/api/tiktok/post/init", method: "GET" });
}

// POST: faz o INIT do upload no TikTok (inbox upload)
export async function POST(req: NextRequest) {
  try {
    const { bucket, path, chunk_size } = await req.json().catch(() => ({}));

    if (!bucket || !path) {
      return NextResponse.json(
        { ok: false, error: "Missing bucket or path" },
        { status: 400 }
      );
    }

    // 1) pega access_token do TikTok salvo no Supabase
    const { data: tok, error: tokErr } = await supabaseAdmin
      .from("tiktok_tokens")
      .select("access_token")
      .eq("id", "main")
      .single();

    if (tokErr || !tok?.access_token) {
      return NextResponse.json(
        {
          ok: false,
          where: "supabase_read_token",
          error: tokErr?.message ?? "No TikTok access_token found",
        },
        { status: 500 }
      );
    }

    // 2) baixa o arquivo do Supabase Storage para descobrir o tamanho (video_size)
    const { data: file, error: dlErr } = await supabaseAdmin.storage
      .from(bucket)
      .download(path);

    if (dlErr || !file) {
      return NextResponse.json(
        {
          ok: false,
          where: "supabase_download",
          error: dlErr?.message ?? "Download failed",
          bucket,
          path,
        },
        { status: 500 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const video_size = arrayBuffer.byteLength;

    // 3) chunk config
    const chunk =
      typeof chunk_size === "number" && chunk_size > 0
        ? chunk_size
        : 10 * 1024 * 1024; // 10MB

    const total_chunk_count = Math.ceil(video_size / chunk);

    // 4) chama o INIT do TikTok (inbox upload)
    const payload = {
      source_info: {
        source: "FILE_UPLOAD",
        video_size,
        chunk_size: chunk,
        total_chunk_count,
      },
    };

    const res = await fetch(
      "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tok.access_token}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify(payload),
      }
    );

    const raw = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(raw);
    } catch {}

    if (!res.ok || json?.error?.code && json.error.code !== "ok") {
      return NextResponse.json(
        {
          ok: false,
          where: "tiktok_init",
          status: res.status,
          response: json ?? raw,
          sent: payload,
        },
        { status: 502 }
      );
    }

    // Resposta típica: { data: { publish_id, upload_url }, error: { code:"ok", ... } }
    const upload_url = json?.data?.upload_url;
    const publish_id = json?.data?.publish_id;

    if (!upload_url || !publish_id) {
      return NextResponse.json(
        {
          ok: false,
          where: "tiktok_init_parse",
          response: json ?? raw,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      publish_id,
      upload_url,
      video_size,
      chunk_size: chunk,
      total_chunk_count,
      bucket,
      path,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, where: "catch", error: e?.message ?? String(e) },
      { status: 500 }
    );
  }
}