import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");

    if (!file || !(file instanceof File)) {
      return NextResponse.json({ ok: false, error: "Missing file" }, { status: 400 });
    }

    const ext = (file.name.split(".").pop() || "mp4").toLowerCase();
    const safeExt = ext.replace(/[^a-z0-9]/g, "") || "mp4";
    const path = `uploads/${Date.now()}-${Math.random().toString(16).slice(2)}.${safeExt}`;

    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    const { error } = await supabaseAdmin.storage
      .from("videos")
      .upload(path, bytes, {
        contentType: file.type || "video/mp4",
        upsert: false,
      });

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, video_path: path });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "upload failed" }, { status: 500 });
  }
}
