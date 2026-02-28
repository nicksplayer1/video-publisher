 import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getYoutubeClient } from "@/lib/youtube-client";
import { getYoutubeRefreshToken } from "@/lib/youtube-token";
import { Readable } from "node:stream";

export const runtime = "nodejs";
const WORKER_VERSION = "worker-v4-null-safe";

function unauthorized() {
  return NextResponse.json({ ok: false, error: "Unauthorized", version: WORKER_VERSION }, { status: 401 });
}

function extractStoragePath(videoPath: string) {
  let path = (videoPath ?? "").trim();

  if (!path) return "";

  if (path.startsWith("http")) {
    const m = path.match(/\/videos\/(.+?)(\?|$)/);
    if (m?.[1]) path = m[1];
  }

  return path.replace(/^\/+/, "");
}

async function downloadFromStorage(videoPath: string) {
  const path = extractStoragePath(videoPath);
  if (!path) throw new Error("video_path empty/invalid");

  const { data, error } = await supabaseAdmin.storage.from("videos").download(path);
  if (error) throw new Error(`storage.download: ${error.message} (path=${path})`);

  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function POST(req: Request) {
  const expected = process.env.WORKER_SECRET;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "Missing WORKER_SECRET in env", version: WORKER_VERSION },
      { status: 500 }
    );
  }

  const got = req.headers.get("x-worker-secret") || "";
  if (got !== expected) return unauthorized();

  const nowIso = new Date().toISOString();

  // 1) pega targets youtube queued (já filtrando post_id NOT NULL)
  const { data: targetsRaw, error: tErr } = await supabaseAdmin
    .from("post_targets")
    .select("id, post_id, platform, status, attempts")
    .eq("platform", "youtube")
    .eq("status", "queued")
    .not("post_id", "is", null)
    .limit(20);

  if (tErr) {
    return NextResponse.json({ ok: false, error: tErr.message, version: WORKER_VERSION }, { status: 500 });
  }

  const targets = (targetsRaw ?? []).filter((t) => !!t.post_id);

  if (targets.length === 0) {
    return NextResponse.json({
      ok: true,
      ran: 0,
      version: WORKER_VERSION,
      debug: { nowIso, targetsFound: 0, postsEligible: 0, targetsEligible: 0 },
    });
  }

  // 2) busca posts elegíveis
  const postIds = targets.map((t) => t.post_id);

  const { data: posts, error: pErr } = await supabaseAdmin
    .from("posts")
    .select("id, status, scheduled_at, video_path, caption")
    .in("id", postIds)
    .eq("status", "queued")
    .lte("scheduled_at", nowIso);

  if (pErr) {
    return NextResponse.json({ ok: false, error: pErr.message, version: WORKER_VERSION }, { status: 500 });
  }

  const postById = new Map(posts?.map((p) => [p.id, p]) ?? []);
  const eligibleTargets = targets.filter((t) => postById.has(t.post_id));

  if (eligibleTargets.length === 0) {
    return NextResponse.json({
      ok: true,
      ran: 0,
      version: WORKER_VERSION,
      debug: {
        nowIso,
        targetsFound: targets.length,
        postsEligible: posts?.length ?? 0,
        targetsEligible: 0,
      },
    });
  }

  // 3) auth youtube
  const refreshToken = await getYoutubeRefreshToken();
  const yt = getYoutubeClient(refreshToken);

  let ran = 0;

  for (const t of eligibleTargets) {
    const post = postById.get(t.post_id)!;

    try {
      // lock: só processa se ainda estiver queued
      const { error: lockErr } = await supabaseAdmin
        .from("post_targets")
        .update({ status: "processing", error: null })
        .eq("id", t.id)
        .eq("status", "queued");

      if (lockErr) continue;

      const videoBuffer = await downloadFromStorage(post.video_path);

      // ✅ correção do pipe: stream
      const stream = Readable.from(videoBuffer);

      const res = await yt.videos.insert({
        part: ["snippet", "status"],
        requestBody: {
          snippet: {
            title: (post.caption ?? "Video").slice(0, 90),
            description: post.caption ?? "",
          },
          status: { privacyStatus: "public" },
        },
        media: { body: stream },
      });

      const videoId = res.data.id;
      const url = videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;

      await supabaseAdmin
        .from("post_targets")
        .update({ status: "published", result_url: url, published_at: new Date().toISOString(), error: null })
        .eq("id", t.id);

      ran++;
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : JSON.stringify(e);

      await supabaseAdmin
        .from("post_targets")
        .update({ status: "failed", error: msg, attempts: (t.attempts ?? 0) + 1 })
        .eq("id", t.id);
    }
  }

  return NextResponse.json({
    ok: true,
    ran,
    version: WORKER_VERSION,
    debug: {
      nowIso,
      targetsFound: targets.length,
      postsEligible: posts?.length ?? 0,
      targetsEligible: eligibleTargets.length,
    },
  });
}