import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function GET() {
  // pega access token
  const { data, error } = await supabaseAdmin
    .from("tiktok_tokens")
    .select("access_token, open_id, scope")
    .eq("id", "main")
    .single();

  if (error || !data?.access_token) {
    return NextResponse.json(
      { ok: false, where: "supabase_read", error: error?.message ?? "No token found" },
      { status: 500 }
    );
  }

  // Esse endpoint abaixo é um "placeholder" pra testar posting.
  // Vamos chamar um endpoint de posting "init" típico; se estiver errado, o erro do TikTok vai nos guiar.
  const payload = {
    // título/legenda só pra teste (sem upload ainda)
    post_info: {
      title: "teste post api",
    },
    // tipo/placeholder
    source_info: {
      source: "FILE_UPLOAD",
    },
  };

  const res = await fetch("https://open.tiktokapis.com/v2/post/publish/inbox/video/init/", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${data.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const txt = await res.text();
  let json: any = null;
  try { json = JSON.parse(txt); } catch {}

  return NextResponse.json({
    ok: res.ok,
    status: res.status,
    scope: data.scope,
    response: json ?? txt,
  });
}