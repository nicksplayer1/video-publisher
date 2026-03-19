 import { getInstagramAccessToken } from "@/lib/instagram-token";

const IG_GRAPH_BASE = "https://graph.instagram.com";

type StoredInstagramToken = Awaited<ReturnType<typeof getInstagramAccessToken>>;

export type InstagramPublishResult = {
  instagram_user_id: string | null;
  username: string | null;
  creation_id: string;
  media_id: string;
  permalink: string | null;
  shortcode: string | null;
  status_code: string | null;
  raw: {
    create: unknown;
    status: unknown;
    publish: unknown;
    media: unknown;
  };
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson(res: Response) {
  const json = await res.json().catch(() => null);

  if (!res.ok) {
    const apiMessage =
      json?.error?.message ||
      json?.message ||
      `${res.status} ${res.statusText}`;

    throw new Error(`instagram api failed: ${apiMessage}`);
  }

  return json;
}

async function igPostForm(
  path: string,
  form: Record<string, string | undefined>,
  stored: StoredInstagramToken
) {
  const body = new URLSearchParams();

  for (const [key, value] of Object.entries(form)) {
    if (value != null && value !== "") {
      body.set(key, value);
    }
  }

  body.set("access_token", stored.access_token);

  const res = await fetch(`${IG_GRAPH_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    cache: "no-store",
  });

  return readJson(res);
}

async function igGet(
  path: string,
  params: Record<string, string | undefined>,
  stored: StoredInstagramToken
) {
  const url = new URL(`${IG_GRAPH_BASE}${path}`);

  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") {
      url.searchParams.set(key, value);
    }
  }

  url.searchParams.set("access_token", stored.access_token);

  const res = await fetch(url.toString(), {
    method: "GET",
    cache: "no-store",
  });

  return readJson(res);
}

async function createReelContainer(
  stored: StoredInstagramToken,
  videoUrl: string,
  caption: string
) {
  if (!stored.instagram_user_id) {
    throw new Error("No instagram_user_id stored");
  }

  return igPostForm(
    `/${stored.instagram_user_id}/media`,
    {
      media_type: "REELS",
      video_url: videoUrl,
      caption: caption ?? "",
    },
    stored
  );
}

async function getContainerStatus(
  stored: StoredInstagramToken,
  creationId: string
) {
  return igGet(
    `/${creationId}`,
    {
      fields: "id,status_code,status",
    },
    stored
  );
}

async function waitUntilContainerReady(
  stored: StoredInstagramToken,
  creationId: string,
  timeoutMs = 10 * 60 * 1000,
  pollIntervalMs = 5000
) {
  const startedAt = Date.now();
  let lastStatus: any = null;

  while (Date.now() - startedAt < timeoutMs) {
    lastStatus = await getContainerStatus(stored, creationId);

    const code = String(lastStatus?.status_code ?? "").toUpperCase();

    if (code === "FINISHED" || code === "PUBLISHED") {
      return lastStatus;
    }

    if (code === "ERROR" || code === "EXPIRED") {
      const extra = lastStatus?.status ? ` (${lastStatus.status})` : "";
      throw new Error(`instagram container failed: ${code}${extra}`);
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(
    `instagram container timeout after ${timeoutMs}ms: ${JSON.stringify(lastStatus)}`
  );
}

async function publishContainer(
  stored: StoredInstagramToken,
  creationId: string
) {
  if (!stored.instagram_user_id) {
    throw new Error("No instagram_user_id stored");
  }

  return igPostForm(
    `/${stored.instagram_user_id}/media_publish`,
    {
      creation_id: creationId,
    },
    stored
  );
}

async function getPublishedMedia(
  stored: StoredInstagramToken,
  mediaId: string
) {
  try {
    return await igGet(
      `/${mediaId}`,
      {
        fields: "id,permalink,shortcode,media_product_type,media_type",
      },
      stored
    );
  } catch {
    return null;
  }
}

export async function publishInstagramReelFromUrl(params: {
  videoUrl: string;
  caption: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<InstagramPublishResult> {
  const stored = await getInstagramAccessToken();

  const create = await createReelContainer(
    stored,
    params.videoUrl,
    params.caption
  );

  const creationId = create?.id as string | undefined;
  if (!creationId) {
    throw new Error(`instagram create container: missing id (${JSON.stringify(create)})`);
  }

  const status = await waitUntilContainerReady(
    stored,
    creationId,
    params.timeoutMs,
    params.pollIntervalMs
  );

  const publish = await publishContainer(stored, creationId);

  const mediaId = publish?.id as string | undefined;
  if (!mediaId) {
    throw new Error(`instagram media_publish: missing id (${JSON.stringify(publish)})`);
  }

  const media = await getPublishedMedia(stored, mediaId);

  return {
    instagram_user_id: stored.instagram_user_id ?? null,
    username: stored.username ?? null,
    creation_id: creationId,
    media_id: mediaId,
    permalink: (media?.permalink as string | undefined) ?? null,
    shortcode: (media?.shortcode as string | undefined) ?? null,
    status_code: (status?.status_code as string | undefined) ?? null,
    raw: {
      create,
      status,
      publish,
      media,
    },
  };
}