 import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

/**
 * Próximos horários fixos (12, 18, 20, 22) a partir de "agora".
 * Retorna "count" datas futuras, respeitando o fuso do servidor (UTC no Vercel).
 */
function nextSlots(now: Date, count: number) {
  const slots = [
    { h: 12, m: 0 },
    { h: 18, m: 0 },
    { h: 20, m: 0 },
    { h: 22, m: 0 },
  ];

  const out: Date[] = [];
  let cursor = new Date(now);

  while (out.length < count) {
    const day = new Date(cursor);
    day.setHours(0, 0, 0, 0);

    let pushed = false;

    for (const s of slots) {
      const dt = new Date(day);
      dt.setHours(s.h, s.m, 0, 0);

      if (dt.getTime() > cursor.getTime()) {
        out.push(dt);
        cursor = new Date(dt.getTime() + 1000); // avança 1s para evitar repetição
        pushed = true;
        if (out.length >= count) break;
      }
    }

    // Se não conseguiu agendar nada no dia atual, avança para o próximo dia
    if (!pushed) {
      const nextDay = new Date(day);
      nextDay.setDate(nextDay.getDate() + 1);
      cursor = nextDay;
    }
  }

  return out;
}

type ScheduleItem = {
  // bucket é opcional e será ignorado (não existe coluna bucket em posts)
  bucket?: string;
  path: string;
  caption?: string;
  targets: string[]; // ["tiktok", "youtube", ...]
};

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);

    const items: ScheduleItem[] = Array.isArray(body?.items) ? body.items : [];
    if (!items.length) {
      return NextResponse.json(
        { ok: false, where: "validate", error: "Body must include items: []" },
        { status: 400 }
      );
    }

    // validação leve
    const cleaned: { path: string; caption: string; targets: string[] }[] = [];
    for (const it of items) {
      const path = String(it?.path ?? "").trim();
      const caption = String(it?.caption ?? "").trim();
      const targets = Array.isArray(it?.targets) ? it.targets.map((t) => String(t).trim()).filter(Boolean) : [];

      if (!path) {
        return NextResponse.json(
          { ok: false, where: "validate", error: "Each item must include path" },
          { status: 400 }
        );
      }
      if (!targets.length) {
        return NextResponse.json(
          { ok: false, where: "validate", error: `Item (${path}) must include targets: ["tiktok", ...]` },
          { status: 400 }
        );
      }

      cleaned.push({ path, caption, targets });
    }

    const now = new Date();
    const slots = nextSlots(now, cleaned.length);

    const created: Array<{
      post_id: string;
      scheduled_at: string;
      video_path: string;
      targets: string[];
    }> = [];

    // cria 1 post por item
    for (let i = 0; i < cleaned.length; i++) {
      const it = cleaned[i];
      const scheduledAt = slots[i];

      // ✅ Aqui é o ponto: NÃO inserir bucket.
      const { data: post, error: postErr } = await supabaseAdmin
        .from("posts")
        .insert({
          status: "queued",
          scheduled_at: scheduledAt.toISOString(),
          video_path: it.path, // exemplo: "uploads/video8.mp4"
          caption: it.caption ?? "",
        })
        .select("id, scheduled_at, video_path")
        .single();

      if (postErr) {
        return NextResponse.json(
          { ok: false, where: "insert_post", error: postErr.message },
          { status: 500 }
        );
      }

      const postId = post.id as string;

      // cria os targets desse post
      const targetsRows = it.targets.map((platform) => ({
        post_id: postId,
        platform,
        status: "queued",
        attempts: 0,
      }));

      const { error: targErr } = await supabaseAdmin.from("post_targets").insert(targetsRows);
      if (targErr) {
        return NextResponse.json(
          { ok: false, where: "insert_targets", error: targErr.message, post_id: postId },
          { status: 500 }
        );
      }

      created.push({
        post_id: postId,
        scheduled_at: post.scheduled_at,
        video_path: post.video_path,
        targets: it.targets,
      });
    }

    return NextResponse.json({
      ok: true,
      created: created.length,
      posts: created,
      nowIso: now.toISOString(),
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, where: "catch", error: e?.message ? String(e.message) : String(e) },
      { status: 500 }
    );
  }
}