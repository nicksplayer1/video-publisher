import { NextResponse } from "next/server";
import { getInstagramAccessToken } from "@/lib/instagram-token";

export async function GET() {
  try {
    const stored = await getInstagramAccessToken();

    const url = new URL("https://graph.instagram.com/me");
    url.searchParams.set("fields", "user_id,username");
    url.searchParams.set("access_token", stored.access_token);

    const res = await fetch(url.toString(), {
      method: "GET",
      cache: "no-store",
    });

    const data = await res.json();

    if (!res.ok) {
      return NextResponse.json(
        {
          ok: false,
          message: "instagram api request failed",
          stored: {
            instagram_user_id: stored.instagram_user_id,
            username: stored.username,
            scope: stored.scope,
            expires_at: stored.expires_at,
          },
          api: data,
        },
        { status: res.status }
      );
    }

    return NextResponse.json({
      ok: true,
      message: "instagram token works",
      stored: {
        instagram_user_id: stored.instagram_user_id,
        username: stored.username,
        scope: stored.scope,
        expires_at: stored.expires_at,
      },
      api: data,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown error";

    return NextResponse.json(
      {
        ok: false,
        message,
      },
      { status: 500 }
    );
  }
}