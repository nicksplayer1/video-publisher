import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

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
        cursor = new Date(dt.getTime() + 1000);
        pushed = true;
        if (out.length >= count) break;
      }
    }

    if (!pushed) {
      const tomorrow = new Date(day);
      tomorrow.setDate(day.getDate() + 1);
      cursor = tomorrow;
    }
  }
  return out;
}

export async function POST(req: NextRequest) {
  const { items } = await req.json().catch(() => ({}));

  // items: [{ bucket, path, caption, targets: ["tiktok","youtube"] }]
  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ ok: false, error: "Missing items[]" }, { status: 400 });
  }

  const slots = nextSlots(new Date(), items.length);

  const created: any[] = [];

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const scheduled_at = slots[i].toISOString();

    // 1) cria post
    const { data: post, error: postErr } = await supabaseAdmin
      .from("posts")
      .insert({
        status: "queued",
        scheduled_at,
        caption: it.caption ?? "",
        bucket: it.bucket ?? "videos",
        path: it.path,
      })
      .select("id, scheduled_at")
      .single();

    if (postErr || !post?.id) {
      return NextResponse.json({ ok: false, where: "insert_post", error: postErr?.message }, { status: 500 });
    }

    // 2) cria targets
    const targets = Array.isArray(it.targets) ? it.targets : ["tiktok"];
    const rows = targets.map((p: string) => ({
      post_id: post.id,
      platform: p,
      platform_status: "queued",
      attempts: 0,
    }));

    const { error: tgErr } = await supabaseAdmin.from("post_targets").insert(rows);
    if (tgErr) {
      return NextResponse.json({ ok: false, where: "insert_targets", error: tgErr.message }, { status: 500 });
    }

    created.push({ post_id: post.id, scheduled_at, targets });
  }

  return NextResponse.json({ ok: true, created });
}