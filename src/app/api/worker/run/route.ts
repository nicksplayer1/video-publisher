 import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getYoutubeClient } from "@/lib/youtube-client";
import { getYoutubeRefreshToken } from "@/lib/youtube-token";

export const runtime = "nodejs";

async function downloadFromStorage(path: string) {
  const tryBuckets = ["videos", "uploads"];
  let lastErr: any = null;

  for (const bucket of tryBuckets) {
    const { data, error } = await supabaseAdmin.storage.from(bucket).download(path);
    if (!error && data) {
      const arrayBuffer = await data.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }
    lastErr = error;
  }

  throw new Error(lastErr?.message ?? "Failed to download video from storage");
}

async function finalizePostIfDone(postId: string) {
  const { count, error } = await supabaseAdmin
    .from("post_targets")
    .select("id", { count: "exact", head: true })
    .eq("post_id", postId)
    .in("status", ["queued", "processing"]);

  if (error) throw new Error(error.message);

  if ((count ?? 0) === 0) {
    await supabaseAdmin
      .from("posts")
      .update({ status: "published", published_at: new Date().toISOString() })
      .eq("id", postId)
      .in("status", ["queued", "processing"]);
  }
}

export async function POST(request: Request) {
  // ✅ proteção por secret (se tiver WORKER_SECRET na Vercel)
  const required = process.env.WORKER_SECRET;
  if (required) {
    const got = request.headers.get("x-worker-secret");
    if (got !== required) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
  }

  const now = new Date().toISOString();

  // ✅ CORREÇÃO: video_path (seu schema)
  const { data: targets, error } = await supabaseAdmin
    .from("post_targets")
    .select(
      "id, post_id, platform, status, attempts, posts!inner(video_path, caption, scheduled_at, status)"
    )
    .eq("platform", "youtube")
    .eq("status", "queued")
    .eq("posts.status", "queued")
    .lte("posts.scheduled_at", now)
    .limit(5);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (!targets?.length) return NextResponse.json({ ok: true, ran: 0 });

  const refreshToken = await getYoutubeRefreshToken();
  const yt = getYoutubeClient(refreshToken);

  let ran = 0;

  for (const t of targets) {
    const post = (t as any).posts;

    // claim/lock
    const { data: claimed } = await supabaseAdmin
      .from("post_targets")
      .update({ status: "processing" })
      .eq("id", t.id)
      .eq("status", "queued")
      .select("id")
      .maybeSingle();

    if (!claimed) continue;

    try {
      const videoBuffer = await downloadFromStorage(post.video_path);

      const res = await yt.videos.insert({
        part: ["snippet", "status"],
        requestBody: {
          snippet: {
            title: (post.caption ?? "Video").slice(0, 90),
            description: post.caption ?? "",
          },
          status: { privacyStatus: "unlisted" },
        },
        media: { body: videoBuffer },
      });

      const videoId = res.data.id;
      const url = videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;

      await supabaseAdmin
        .from("post_targets")
        .update({
          status: "published",
          result_url: url,
          published_at: new Date().toISOString(),
          error: null,
        })
        .eq("id", t.id);

      await finalizePostIfDone(t.post_id);
      ran++;
    } catch (e: any) {
      const nextAttempts = (t as any).attempts ? Number((t as any).attempts) + 1 : 1;

      await supabaseAdmin
        .from("post_targets")
        .update({
          status: "failed",
          error: String(e?.message ?? e),
          attempts: nextAttempts,
        })
        .eq("id", t.id);
    }
  }

  return NextResponse.json({ ok: true, ran });
}