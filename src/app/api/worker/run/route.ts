import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function POST() {
  // 1) pegar posts que já podem rodar
  const now = new Date().toISOString();

  const { data: posts, error } = await supabaseAdmin
    .from("posts")
    .select("id, status, scheduled_at")
    .eq("status", "queued")
    .lte("scheduled_at", now)
    .limit(10);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  if (!posts || posts.length === 0) {
    return NextResponse.json({ ok: true, ran: 0 });
  }

  // 2) processar um por um (MVP)
  for (const post of posts) {
    // marca post como processing
    await supabaseAdmin.from("posts").update({ status: "processing" }).eq("id", post.id);

    // pega targets do post
    const { data: targets } = await supabaseAdmin
      .from("post_targets")
      .select("id, platform, status")
      .eq("post_id", post.id);

    // 3) SIMULA “publicação”
    // (depois a gente troca por YouTube API)
    for (const t of targets ?? []) {
      await supabaseAdmin
        .from("post_targets")
        .update({
          status: "published",
          result_url: `simulated://${t.platform}/${post.id}`,
          error: null,
        })
        .eq("id", t.id);
    }

    // 4) marca post como published
    await supabaseAdmin.from("posts").update({ status: "published" }).eq("id", post.id);
  }

  return NextResponse.json({ ok: true, ran: posts.length });
}

// ✅ permite rodar no navegador e facilita Cron (GET)
export async function GET() {
  return POST();
}
