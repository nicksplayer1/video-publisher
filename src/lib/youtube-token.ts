import { supabaseAdmin } from "@/lib/supabase-admin";

export async function getYoutubeRefreshToken() {
  const { data, error } = await supabaseAdmin
    .from("youtube_tokens")
    .select("refresh_token")
    .eq("id", "main")
    .single();

  if (error) throw new Error(error.message);
  if (!data?.refresh_token) throw new Error("No YouTube refresh_token stored");

  return data.refresh_token as string;
}