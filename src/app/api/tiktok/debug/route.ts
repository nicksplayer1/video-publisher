import { NextResponse } from "next/server";

const redact = (s?: string) => (s ? s.slice(0, 4) + "..." + s.slice(-4) : null);

export async function GET() {
  const key = process.env.TIKTOK_CLIENT_KEY?.trim();
  const secret = process.env.TIKTOK_CLIENT_SECRET?.trim();
  const redirect = process.env.TIKTOK_REDIRECT_URI?.trim();

  return NextResponse.json({
    ok: true,
    key: redact(key),
    secret: secret ? "***" : null,
    redirect,
    nodeEnv: process.env.NODE_ENV,
  });
}