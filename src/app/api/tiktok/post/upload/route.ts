 import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function GET() {
  return NextResponse.json({ ok: true, route: "/api/tiktok/post/upload", method: "GET" });
}

export async function POST(req: NextRequest) {
  try {
    const { bucket, path, upload_url, chunk_size, video_size } = await req.json().catch(() => ({}));

    if (!bucket || !path || !upload_url || !chunk_size || !video_size) {
      return NextResponse.json(
        { ok: false, error: "Missing bucket/path/upload_url/chunk_size/video_size" },
        { status: 400 }
      );
    }

    // 1) baixa o arquivo do Supabase Storage
    const { data: file, error: dlErr } = await supabaseAdmin.storage
      .from(bucket)
      .download(path);

    if (dlErr || !file) {
      return NextResponse.json(
        { ok: false, where: "supabase_download", error: dlErr?.message ?? "Download failed" },
        { status: 500 }
      );
    }

    const buf = new Uint8Array(await file.arrayBuffer());

    if (buf.byteLength !== Number(video_size)) {
      return NextResponse.json(
        {
          ok: false,
          where: "size_mismatch",
          error: `Downloaded size (${buf.byteLength}) != video_size (${video_size})`,
        },
        { status: 400 }
      );
    }

    const total = buf.byteLength;
    const chunk = Number(chunk_size);

    let part = 0;

    for (let start = 0; start < total; start += chunk) {
      const endExclusive = Math.min(start + chunk, total);
      const endInclusive = endExclusive - 1;

      const piece = buf.slice(start, endExclusive);

      const res = await fetch(upload_url, {
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(piece.byteLength),
          "Content-Range": `bytes ${start}-${endInclusive}/${total}`,
        },
        body: piece,
      });

      const txt = await res.text().catch(() => "");

      if (!res.ok) {
        return NextResponse.json(
          {
            ok: false,
            where: "tiktok_upload_chunk",
            status: res.status,
            part,
            range: `bytes ${start}-${endInclusive}/${total}`,
            response: txt,
          },
          { status: 502 }
        );
      }

      part++;
    }

    return NextResponse.json({ ok: true, uploaded: true, parts: part });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, where: "catch", error: e?.message ?? String(e) },
      { status: 500 }
    );
  }
}