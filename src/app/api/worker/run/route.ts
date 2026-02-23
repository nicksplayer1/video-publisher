 import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function unauthorized() {
  return new Response("Unauthorized", { status: 401 });
}

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

async function runWorker() {
  const supabase = getAdminClient();

  // 1) Buscar posts que já venceram e ainda estão queued
  const nowIso = new Date().toISOString();

  const { data: posts, error: fetchErr } = await supabase
    .from("posts")
    .select("id")
    .eq("status", "queued")
    .lte("scheduled_at", nowIso)
    .limit(50);

  if (fetchErr) {
    return NextResponse.json({ ok: false, error: fetchErr.message }, { status: 500 });
  }

  const ids = (posts ?? []).map((p) => p.id);

  if (ids.length === 0) {
    return NextResponse.json({ ok: true, ran: 0 });
  }

  // 2) Marcar como published (simulado)
  const { error: updPostsErr } = await supabase
    .from("posts")
    .update({ status: "published", published_at: nowIso })
    .in("id", ids);

  if (updPostsErr) {
    return NextResponse.json({ ok: false, error: updPostsErr.message }, { status: 500 });
  }

  // 3) Atualizar targets (simulado)
  const { error: updTargetsErr } = await supabase
    .from("post_targets")
    .update({
      status: "published",
      published_at: nowIso,
      result_url: "simulated://published",
    })
    .in("post_id", ids);

  if (updTargetsErr) {
    return NextResponse.json({ ok: false, error: updTargetsErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, ran: ids.length });
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const key = searchParams.get("key");

  if (!process.env.WORKER_SECRET || key !== process.env.WORKER_SECRET) {
    return unauthorized();
  }

  return runWorker();
}

export async function POST(req: Request) {
  const { searchParams } = new URL(req.url);
  const key = searchParams.get("key");

  if (!process.env.WORKER_SECRET || key !== process.env.WORKER_SECRET) {
    return unauthorized();
  }

  return runWorker();
}