import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function GET() {
  // 1) pega token salvo
  const { data, error } = await supabaseAdmin
    .from("tiktok_tokens")
    .select("access_token, expires_at, scope, open_id")
    .eq("id", "main")
    .single();

  if (error || !data?.access_token) {
    return NextResponse.json(
      { ok: false, where: "supabase_read", error: error?.message ?? "No token found" },
      { status: 500 }
    );
  }

  // 2) chama endpoint básico de user info (depende do produto; esse é o padrão mais comum no OpenAPI v2)
  // Se esse endpoint não existir no seu app/escopo, o retorno vai nos dizer qual é o correto.
  const fields = "open_id,union_id,avatar_url,display_name";
  const res = await fetch(
    `https://open.tiktokapis.com/v2/user/info/?fields=${encodeURIComponent(fields)}`,
    {
      headers: {
        Authorization: `Bearer ${data.access_token}`,
      },
    }
  );

  const txt = await res.text();
  let json: any = null;
  try { json = JSON.parse(txt); } catch {}

  return NextResponse.json({
    ok: res.ok,
    status: res.status,
    token: {
      expires_at: data.expires_at,
      scope: data.scope,
      open_id: data.open_id,
    },
    response: json ?? txt,
  });
}