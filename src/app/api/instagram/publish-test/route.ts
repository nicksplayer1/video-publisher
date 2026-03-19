import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { publishInstagramReelFromUrl } from "@/lib/instagram-client";

export const runtime = "nodejs";

function extractStoragePath(videoPath: string) {
  let path = (videoPath ?? "").trim();
  if (!path) return "";

  if (path.startsWith("http")) {
    const m = path.match(/\/videos\/(.+?)(\?|$)/);
    if (m?.[1]) path = m[1];
  }

  return path.replace(/^\/+/, "");
}

async function createSignedVideoUrl(videoPath: string, expiresIn = 3600) {
  const path = extractStoragePath(videoPath);
  if (!path) throw new Error("video_path empty/invalid");

  const { data, error } = await supabaseAdmin.storage
    .from("videos")
    .createSignedUrl(path, expiresIn);

  if (error) {
    throw new Error(`storage.createSignedUrl: ${error.message}`);
  }

  if (!data?.signedUrl) {
    throw new Error("storage.createSignedUrl: missing signedUrl");
  }

  return {
    path,
    signedUrl: data.signedUrl,
  };
}

async function resolveInput(input: {
  post_id?: string;
  video_path?: string;
  caption?: string;
}) {
  const postId = (input.post_id ?? "").trim();

  if (postId) {
    const { data, error } = await supabaseAdmin
      .from("posts")
      .select("id, video_path, caption")
      .eq("id", postId)
      .single();

    if (error) {
      throw new Error(`posts read failed: ${error.message}`);
    }

    return {
      postId: data.id as string,
      videoPath: String(data.video_path ?? ""),
      caption: String(data.caption ?? ""),
    };
  }

  const videoPath = (input.video_path ?? "").trim();
  const caption = (input.caption ?? "").trim();

  if (!videoPath) {
    throw new Error("Missing post_id or video_path");
  }

  return {
    postId: null,
    videoPath,
    caption,
  };
}

async function handlePublish(input: {
  post_id?: string;
  video_path?: string;
  caption?: string;
  url_expires_in?: string | number;
}) {
  const resolved = await resolveInput(input);

  const expiresInRaw =
    typeof input.url_expires_in === "number"
      ? input.url_expires_in
      : Number(input.url_expires_in ?? 3600);

  const expiresIn = Number.isFinite(expiresInRaw) && expiresInRaw > 0
    ? Math.floor(expiresInRaw)
    : 3600;

  const signed = await createSignedVideoUrl(resolved.videoPath, expiresIn);

  const result = await publishInstagramReelFromUrl({
    videoUrl: signed.signedUrl,
    caption: resolved.caption,
    timeoutMs: 10 * 60 * 1000,
    pollIntervalMs: 5000,
  });

  return {
    ok: true,
    source: {
      post_id: resolved.postId,
      video_path: resolved.videoPath,
      caption: resolved.caption,
      signed_storage_path: signed.path,
      signed_url_expires_in: expiresIn,
    },
    result,
  };
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);

    const data = await handlePublish({
      post_id: searchParams.get("post_id") ?? undefined,
      video_path: searchParams.get("video_path") ?? undefined,
      caption: searchParams.get("caption") ?? undefined,
      url_expires_in: searchParams.get("url_expires_in") ?? undefined,
    });

    return NextResponse.json(data);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown error";

    return NextResponse.json(
      {
        ok: false,
        error: message,
      },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));

    const data = await handlePublish({
      post_id: typeof body.post_id === "string" ? body.post_id : undefined,
      video_path: typeof body.video_path === "string" ? body.video_path : undefined,
      caption: typeof body.caption === "string" ? body.caption : undefined,
      url_expires_in:
        typeof body.url_expires_in === "string" || typeof body.url_expires_in === "number"
          ? body.url_expires_in
          : undefined,
    });

    return NextResponse.json(data);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown error";

    return NextResponse.json(
      {
        ok: false,
        error: message,
      },
      { status: 500 }
    );
  }
}