 import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getYoutubeClient } from "@/lib/youtube-client";
import { getYoutubeRefreshToken } from "@/lib/youtube-token";
import { Readable } from "node:stream";

export const runtime = "nodejs";

// muda esse texto quando fizer deploy pra confirmar que a Vercel atualizou
const WORKER_VERSION = "worker-v3-debug";

function unauthorized() {
  return NextResponse.json({ ok: false, error: "Unauthorized", version: WORKER_VERSION }, { status: 401 });
}

function extractStoragePath(videoPath: string) {
  // Aceita:
  // - uploads/xxx.mp4
  // - https://.../object/sign/videos/uploads/xxx.mp4?token=...
  // - https://.../object/videos/uploads/xxx.mp4
  // - https://.../storage/v1/object/sign/videos/uploads/xxx.mp4?... etc
  let path = videoPath.trim();

  if (path.startsWith("http")) {
    // pega tudo depois de /videos/
    const m = path.match(/\/videos\/(.+?)(\?|$)/);
    if (m?.[1]) path = m[1];
  }

  // garante que não vem com / no início
  path = path.replace(/^\/+/, "");

  return path;
}

async function downloadFromStorage(videoPath: string) {
  const path = extractStoragePath(videoPath);

  // ✅ seu bucket é "videos"
  const { data, error } = await supabaseAdmin.storage.from("videos").download(path);
  if (error) throw new Error(`storage.download: ${error.message} (path=${path})`);

  // data é Blob
  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function POST(req: Request) {
  // ✅ AUTH DO WORKER
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

  // 1) Pega targets do youtube queued
  const { data: targets, error: tErr } = await supabaseAdmin
    .from("post_targets")
    .select("id, post_id, platform, status, attempts")
    .eq("platform", "youtube")
    .eq("status", "queued")
    .limit(10);

  if (tErr) {
    return NextResponse.json({ ok: false, error: tErr.message, version: WORKER_VERSION }, { status: 500 });
  }

  if (!targets || targets.length === 0) {
    return NextResponse.json(
      { ok: true, ran: 0, version: WORKER_VERSION, debug: { targetsFound: 0, postsEligible: 0, targetsEligible: 0 } },
      { status: 200 }
    );
  }

  // 2) Busca posts desses targets que estão elegíveis (queued e scheduled_at <= now)
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

  // Targets realmente elegíveis = tem post elegível
  const eligibleTargets = targets.filter((t) => postById.has(t.post_id));

  // ✅ Debug: se ficar ran 0, você vai ver onde travou
  if (eligibleTargets.length === 0) {
    return NextResponse.json(
      {
        ok: true,
        ran: 0,
        version: WORKER_VERSION,
        debug: {
          targetsFound: targets.length,
          postsEligible: posts?.length ?? 0,
          targetsEligible: 0,
          nowIso,
        },
      },
      { status: 200 }
    );
  }

  // 3) auth youtube (refresh_token -> client)
  const refreshToken = await getYoutubeRefreshToken();
  const yt = getYoutubeClient(refreshToken);

  let ran = 0;

  for (const t of eligibleTargets) {
    const post = postById.get(t.post_id)!;

    try {
      // marca processing (e trava corrida)
      const { error: lockErr } = await supabaseAdmin
        .from("post_targets")
        .update({ status: "processing", error: null })
        .eq("id", t.id)
        .eq("status", "queued");

      if (lockErr) {
        // se não conseguiu travar, pula
        continue;
      }

      // baixa o vídeo do storage
      const videoBuffer = await downloadFromStorage(post.video_path);

      // ✅ ESSA é a correção do "pipe is not a function"
      // googleapis espera stream (pipe)
      const stream = Readable.from(videoBuffer);

      // upload youtube
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
      targetsFound: targets.length,
      postsEligible: posts?.length ?? 0,
      targetsEligible: eligibleTargets.length,
    },
  });
}