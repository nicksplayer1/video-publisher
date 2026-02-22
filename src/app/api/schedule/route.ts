import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { video_path, caption, scheduled_at } = body ?? {};

    if (!video_path || !scheduled_at) {
      return NextResponse.json(
        { ok: false, error: "Missing video_path or scheduled_at" },
        { status: 400 }
      );
    }

    const { data: post, error: postError } = await supabaseAdmin
      .from("posts")
      .insert({
        user_id: null,
        video_path,
        caption: caption ?? null,
        scheduled_at,
        status: "queued",
      })
      .select("id")
      .single();

    if (postError) {
      return NextResponse.json({ ok: false, error: postError.message }, { status: 500 });
    }

    const targets = ["youtube", "instagram", "tiktok"].map((platform) => ({
      post_id: post.id,
      platform,
      status: "queued",
    }));

    const { error: targetsError } = await supabaseAdmin.from("post_targets").insert(targets);

    if (targetsError) {
      return NextResponse.json({ ok: false, error: targetsError.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, post_id: post.id });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "schedule failed" }, { status: 500 });
  }
}
