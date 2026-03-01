import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getYoutubeClient } from "@/lib/youtube-client";
import { getYoutubeRefreshToken } from "@/lib/youtube-token";
import { Readable } from "node:stream";

export const runtime = "nodejs";
const WORKER_VERSION = "worker-v5-finalize-posts";

function unauthorized() {
  return NextResponse.json({ ok: false, error: "Unauthorized", version: WORKER_VERSION }, { status: 401 });
}

function extractStoragePath(videoPath: string) {
  let path = (videoPath ?? "").trim();
  if (!path) return "";

  // se vier URL pública do supabase, tenta extrair /videos/<path>
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

function buildTitleFromCaption(caption: string | null) {
  const c = (caption ?? "").trim();
  if (!c) return "Video";

  // usa a primeira linha como título, e limita (YouTube aceita bem mais, mas aqui é seguro)
  const firstLine = c.split("\n")[0].trim();
  return (firstLine || "Video").slice(0, 90);
}

async function finalizePosts(postIds: string[]) {
  const unique = Array.from(new Set(postIds)).filter(Boolean);
  if (unique.length === 0) return;

  // Pega todos os targets desses posts e decide o status final
  const { data: allTargets, error } = await supabaseAdmin
    .from("post_targets")
    .select("post_id, status")
    .in("post_id", unique);

  if (error) return; // não mata o worker por causa disso

  const byPost = new Map<string, string[]>();
  for (const t of allTargets ?? []) {
    const pid = t.post_id as string | null;
    if (!pid) continue;
    const arr = byPost.get(pid) ?? [];
    arr.push(String(t.status));
    byPost.set(pid, arr);
  }

  for (const pid of unique) {
    const statuses = byPost.get(pid) ?? [];

    // Se não tem targets, não mexe
    if (statuses.length === 0) continue;

    const stillRunning = statuses.some((s) => s === "queued" || s === "processing");
    if (stillRunning) continue;

    const allPublished = statuses.every((s) => s === "published");
    const allFailed = statuses.every((s) => s === "failed");

    let finalStatus: "published" | "failed" | "partial";
    if (allPublished) finalStatus = "published";
    else if (allFailed) finalStatus = "failed";
    else finalStatus = "partial";

    await supabaseAdmin
      .from("posts")
      .update({
        status: finalStatus,
        // se sua tabela tiver published_at, ótimo; se não tiver, remova esta linha
        published_at: new Date().toISOString(),
      })
      .eq("id", pid);
  }
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
  const postIds = targets.map((t) => t.post_id as string);

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
  const eligibleTargets = targets.filter((t) => postById.has(t.post_id as string));

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
  const touchedPostIds: string[] = [];

  for (const t of eligibleTargets) {
    const postId = t.post_id as string;
    const post = postById.get(postId)!;

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

      const caption = (post.caption ?? "").trim();
      const title = buildTitleFromCaption(post.caption ?? null);

      const res = await yt.videos.insert({
        part: ["snippet", "status"],
        requestBody: {
          snippet: {
            title,
            description: caption,
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
      touchedPostIds.push(postId);
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : JSON.stringify(e);

      await supabaseAdmin
        .from("post_targets")
        .update({ status: "failed", error: msg, attempts: (t.attempts ?? 0) + 1 })
        .eq("id", t.id);

      touchedPostIds.push(postId);
    }
  }

  // ✅ 4) fecha posts (atualiza posts.status quando todos targets terminaram)
  await finalizePosts(touchedPostIds);

  return NextResponse.json({
    ok: true,
    ran,
    version: WORKER_VERSION,
    debug: {
      nowIso,
      targetsFound: targets.length,
      postsEligible: posts?.length ?? 0,
      targetsEligible: eligibleTargets.length,
      finalizedPosts: Array.from(new Set(touchedPostIds)).length,
    },
  });
}