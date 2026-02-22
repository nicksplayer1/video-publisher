import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function GET() {
  const { data, error } = await supabaseAdmin
    .from("posts")
    .select("id")
    .limit(1);

  return NextResponse.json({
    ok: !error,
    error: error?.message ?? null,
    sample: data ?? null,
  });
}
