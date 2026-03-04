 import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getYoutubeClient } from "@/lib/youtube-client";
import { getYoutubeRefreshToken } from "@/lib/youtube-token";
import { Readable } from "node:stream";

export const runtime = "nodejs";
const WORKER_VERSION = "worker-v6-youtube+tiktok";

/** ===== Helpers gerais ===== */

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
  const firstLine = c.split("\n")[0].trim();
  return (firstLine || "Video").slice(0, 90);
}

function nowIso() {
  return new Date().toISOString();
}

function inMs(ms: number) {
  return new Date(Date.now() + ms).toISOString();
}

/** ===== Finalização (igual seu worker) ===== */

async function finalizePosts(postIds: string[]) {
  const unique = Array.from(new Set(postIds)).filter(Boolean);
  if (unique.length === 0) return;

  const { data: allTargets, error } = await supabaseAdmin
    .from("post_targets")
    .select("post_id, status")
    .in("post_id", unique);

  if (error) return;

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
        published_at: nowIso(),
      })
      .eq("id", pid);
  }
}

/** ===== TikTok ===== */

type TikTokTokenRow = {
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null; // timestamptz
  token_type: string | null;
  open_id: string | null;
  scope: string | null;
};

function envOrThrow(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in env`);
  return v;
}

function isExpiringSoon(expiresAtIso: string | null, skewMs = 2 * 60 * 1000) {
  if (!expiresAtIso) return true;
  const t = new Date(expiresAtIso).getTime();
  return Number.isNaN(t) ? true : t <= Date.now() + skewMs;
}

async function getTikTokToken(): Promise<TikTokTokenRow> {
  const { data, error } = await supabaseAdmin
    .from("tiktok_tokens")
    .select("access_token, refresh_token, expires_at, token_type, open_id, scope")
    .eq("id", "main")
    .single();

  if (error) throw new Error(`tiktok_tokens read: ${error.message}`);
  return data as TikTokTokenRow;
}

async function refreshTikTokAccessToken(refreshToken: string) {
  const client_key = envOrThrow("TIKTOK_CLIENT_KEY");
  const client_secret = envOrThrow("TIKTOK_CLIENT_SECRET");

  // TikTok OAuth refresh (v2)
  const res = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key,
      client_secret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`tiktok refresh failed: ${res.status} ${res.statusText} ${JSON.stringify(json)}`);
  }

  // campos típicos: access_token, refresh_token, expires_in, token_type, open_id, scope
  const access_token = json?.access_token as string | undefined;
  const new_refresh_token = (json?.refresh_token as string | undefined) ?? refreshToken;
  const expires_in = Number(json?.expires_in ?? 0);

  if (!access_token) throw new Error(`tiktok refresh: missing access_token (${JSON.stringify(json)})`);

  const newExpiresAt = expires_in > 0 ? inMs(expires_in * 1000) : inMs(55 * 60 * 1000);

  await supabaseAdmin
    .from("tiktok_tokens")
    .update({
      access_token,
      refresh_token: new_refresh_token,
      expires_at: newExpiresAt,
      token_type: (json?.token_type as string | undefined) ?? "Bearer",
      open_id: (json?.open_id as string | undefined) ?? null,
      scope: (json?.scope as string | undefined) ?? null,
      updated_at: nowIso(),
    })
    .eq("id", "main");

  return { access_token, expires_at: newExpiresAt };
}

async function ensureTikTokAccessToken() {
  const row = await getTikTokToken();
  if (!row.refresh_token) throw new Error("No TikTok refresh_token stored");
  if (!row.access_token || isExpiringSoon(row.expires_at)) {
    return refreshTikTokAccessToken(row.refresh_token);
  }
  return { access_token: row.access_token, expires_at: row.expires_at ?? null };
}

type TikTokInitResponse = {
  publish_id: string;
  upload_url: string;
  video_size?: number;
  chunk_size?: number;
  total_chunk_count?: number;
};

async function tiktokInit(accessToken: string, caption: string, videoSize: number): Promise<TikTokInitResponse> {
  // Estrutura compatível com o fluxo “FILE_UPLOAD” (Inbox / publish API)
  // Observação: alguns apps exigem title separado; aqui usamos caption.
  const body = {
    post_info: {
      title: (caption ?? "").slice(0, 150), // seguro
      description: caption ?? "",
      disable_comment: false,
      disable_duet: false,
      disable_stitch: false,
      // privacy_level pode variar por app; omitimos para defaults do usuário
    },
    source_info: {
      source: "FILE_UPLOAD",
      video_size: videoSize,
      chunk_size: videoSize, // se a API devolver chunk_size no response, usamos depois
      total_chunk_count: 1,
    },
  };

  const res = await fetch("https://open.tiktokapis.com/v2/post/publish/video/init/", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`tiktok init failed: ${res.status} ${res.statusText} ${JSON.stringify(json)}`);

  // formato típico: { data: { publish_id, upload_url, ... }, error: { code, message, ... } }
  const data = json?.data ?? json;
  const publish_id = data?.publish_id as string | undefined;
  const upload_url = data?.upload_url as string | undefined;

  if (!publish_id || !upload_url) {
    throw new Error(`tiktok init: missing publish_id/upload_url (${JSON.stringify(json)})`);
  }

  return {
    publish_id,
    upload_url,
    video_size: Number(data?.video_size ?? videoSize),
    chunk_size: Number(data?.chunk_size ?? videoSize),
    total_chunk_count: Number(data?.total_chunk_count ?? 1),
  };
}

async function tiktokUpload(uploadUrl: string, video: Buffer, chunkSize: number) {
  const size = video.length;
  const cs = Math.max(1, chunkSize || size);
  let offset = 0;

  // Upload por chunks (quando necessário)
  while (offset < size) {
    const end = Math.min(offset + cs, size);
    const chunk = video.subarray(offset, end);

    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(chunk.length),
        // Muitos flows aceitam/precisam Content-Range:
        "Content-Range": `bytes ${offset}-${end - 1}/${size}`,
      },
      body: chunk,
    });

    const txt = await res.text().catch(() => "");
    if (!res.ok) {
      throw new Error(`tiktok upload failed: ${res.status} ${res.statusText} ${txt}`);
    }

    offset = end;
  }
}

async function tiktokStatus(accessToken: string, publishId: string) {
  // Tentativa 1: GET com querystring
  const url = new URL("https://open.tiktokapis.com/v2/post/publish/status/");
  url.searchParams.set("publish_id", publishId);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const json = await res.json().catch(() => null);
  if (res.ok) return json;

  // Fallback: POST (alguns apps/ambientes aceitam assim)
  const res2 = await fetch("https://open.tiktokapis.com/v2/post/publish/status/", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ publish_id: publishId }),
  });

  const json2 = await res2.json().catch(() => null);
  if (!res2.ok) {
    throw new Error(`tiktok status failed: ${res2.status} ${res2.statusText} ${JSON.stringify(json2 ?? json)}`);
  }
  return json2;
}

async function publishToTikTok(params: { caption: string; video: Buffer }) {
  const { access_token } = await ensureTikTokAccessToken();

  const init = await tiktokInit(access_token, params.caption, params.video.length);

  // Se a API devolver chunk_size menor, respeita
  const chunkSize = init.chunk_size && init.chunk_size > 0 ? init.chunk_size : params.video.length;
  await tiktokUpload(init.upload_url, params.video, chunkSize);

  const st = await tiktokStatus(access_token, init.publish_id);

  // status esperado no seu caso: SEND_TO_USER_INBOX
  // Guardamos o publish_id para rastrear.
  const statusStr =
    (st?.data?.status as string | undefined) ??
    (st?.status as string | undefined) ??
    (st?.data?.publish_status as string | undefined) ??
    "UNKNOWN";

  return {
    publish_id: init.publish_id,
    status: statusStr,
    raw: st,
  };
}

/** ===== Worker principal ===== */

export async function POST(req: Request) {
  const expected = process.env.WORKER_SECRET;
  if (!expected) {
    return NextResponse.json({ ok: false, error: "Missing WORKER_SECRET in env", version: WORKER_VERSION }, { status: 500 });
  }

  const got = req.headers.get("x-worker-secret") || "";
  if (got !== expected) return unauthorized();

  const now = nowIso();

  // 1) pega targets queued (YouTube + TikTok)
  const { data: targetsRaw, error: tErr } = await supabaseAdmin
    .from("post_targets")
    .select("id, post_id, platform, status, attempts")
    .in("platform", ["youtube", "tiktok"])
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
      debug: { nowIso: now, targetsFound: 0, postsEligible: 0, targetsEligible: 0 },
    });
  }

  // 2) busca posts elegíveis
  const postIds = targets.map((t) => t.post_id as string);

  const { data: posts, error: pErr } = await supabaseAdmin
    .from("posts")
    .select("id, status, scheduled_at, video_path, caption")
    .in("id", postIds)
    .eq("status", "queued")
    .lte("scheduled_at", now);

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
      debug: { nowIso: now, targetsFound: targets.length, postsEligible: posts?.length ?? 0, targetsEligible: 0 },
    });
  }

  // 3) prepara YouTube client SOMENTE se tiver target youtube
  const hasYoutube = eligibleTargets.some((t) => String(t.platform) === "youtube");
  const yt = hasYoutube ? getYoutubeClient(await getYoutubeRefreshToken()) : null;

  let ran = 0;
  let ranYoutube = 0;
  let ranTikTok = 0;

  const touchedPostIds: string[] = [];

  for (const t of eligibleTargets) {
    const postId = t.post_id as string;
    const post = postById.get(postId)!;
    const platform = String(t.platform);

    try {
      // lock: só processa se ainda estiver queued
      const { error: lockErr } = await supabaseAdmin
        .from("post_targets")
        .update({ status: "processing", error: null })
        .eq("id", t.id)
        .eq("status", "queued");

      if (lockErr) continue;

      const caption = (post.caption ?? "").trim();
      const videoBuffer = await downloadFromStorage(post.video_path);

      if (platform === "youtube") {
        if (!yt) throw new Error("YouTube client not initialized");

        const stream = Readable.from(videoBuffer);
        const title = buildTitleFromCaption(post.caption ?? null);

        const res = await yt.videos.insert(
          {
            part: ["snippet", "status"],
            requestBody: {
              snippet: { title, description: caption },
              status: { privacyStatus: "public" },
            },
            media: { body: stream },
          },
          {}
        );

        const videoId = res.data.id;
        const url = videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;

        await supabaseAdmin
          .from("post_targets")
          .update({ status: "published", result_url: url, published_at: nowIso(), error: null })
          .eq("id", t.id);

        ran++;
        ranYoutube++;
        touchedPostIds.push(postId);
        continue;
      }

      if (platform === "tiktok") {
        const out = await publishToTikTok({ caption, video: videoBuffer });

        // No modo inbox, o “resultado” útil é o publish_id (e status SEND_TO_USER_INBOX)
        await supabaseAdmin
          .from("post_targets")
          .update({
            status: "published",
            result_url: out.publish_id,
            published_at: nowIso(),
            error: out.status ? `TikTok:${out.status}` : null,
          })
          .eq("id", t.id);

        ran++;
        ranTikTok++;
        touchedPostIds.push(postId);
        continue;
      }

      // se cair aqui, plataforma não suportada
      throw new Error(`Unsupported platform: ${platform}`);
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : JSON.stringify(e);

      await supabaseAdmin
        .from("post_targets")
        .update({ status: "failed", error: msg, attempts: (t.attempts ?? 0) + 1 })
        .eq("id", t.id);

      touchedPostIds.push(postId);
    }
  }

  // 4) fecha posts (atualiza posts.status quando todos targets terminaram)
  await finalizePosts(touchedPostIds);

  return NextResponse.json({
    ok: true,
    ran,
    version: WORKER_VERSION,
    debug: {
      nowIso: now,
      targetsFound: targets.length,
      postsEligible: posts?.length ?? 0,
      targetsEligible: eligibleTargets.length,
      ranYoutube,
      ranTikTok,
      finalizedPosts: Array.from(new Set(touchedPostIds)).length,
    },
  });
}