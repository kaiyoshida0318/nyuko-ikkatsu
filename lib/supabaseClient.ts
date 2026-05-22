import { createClient } from "@supabase/supabase-js";

export const embeddedSupabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";

export const embeddedSupabaseAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";

export const isSupabaseConfigured = Boolean(
  embeddedSupabaseUrl && embeddedSupabaseAnonKey,
);

export const supabase = isSupabaseConfigured
  ? createClient(embeddedSupabaseUrl, embeddedSupabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

export function getSupabaseConfigError(): string | null {
  if (embeddedSupabaseUrl && embeddedSupabaseAnonKey) return null;
  return "NEXT_PUBLIC_SUPABASE_URL と NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してからビルドしてください。";
}
