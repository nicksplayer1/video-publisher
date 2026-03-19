import { supabaseAdmin } from "@/lib/supabase-admin";

export async function getInstagramAccessToken() {
  const { data, error } = await supabaseAdmin
    .from("instagram_tokens")
    .select("access_token, instagram_user_id, username, scope, expires_at")
    .eq("id", "main")
    .single();

  if (error) {
    throw new Error(`instagram token fetch failed: ${error.message}`);
  }

  if (!data?.access_token) {
    throw new Error("No Instagram access_token stored");
  }

  return data;
}