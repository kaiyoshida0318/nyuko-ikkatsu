import { createClient } from "@supabase/supabase-js";

export const NYUKO_AUTH_STORAGE_KEY = "nyuko-ikkatsu-supabase-auth-token";

function normalizeSupabaseProjectUrl(input: string | undefined): string {
  const trimmed = (input ?? "").trim().replace(/^['"]|['"]$/g, "").replace(/\/+$/, "");
  if (!trimmed) return "";

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";

    // 古い設定で /rest/v1 や /rest/v1/products まで入っていても、
    // Supabase Auth 用にはプロジェクトの origin だけを使う。
    return url.origin;
  } catch {
    return "";
  }
}

function normalizeSupabaseAnonKey(input: string | undefined): string {
  return (input ?? "").trim().replace(/^['"]|['"]$/g, "");
}

export const embeddedSupabaseUrl = normalizeSupabaseProjectUrl(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
);

export const embeddedSupabaseAnonKey = normalizeSupabaseAnonKey(
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);

export const isSupabaseConfigured = Boolean(
  embeddedSupabaseUrl && embeddedSupabaseAnonKey,
);

export const supabase = isSupabaseConfigured
  ? createClient(embeddedSupabaseUrl, embeddedSupabaseAnonKey, {
      auth: {
        storageKey: NYUKO_AUTH_STORAGE_KEY,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    })
  : null;

export function getSupabaseConfigError(): string | null {
  if (embeddedSupabaseUrl && embeddedSupabaseAnonKey) return null;
  return "NEXT_PUBLIC_SUPABASE_URL と NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してからビルドしてください。Supabase URL は https://xxxxx.supabase.co の形式にしてください。";
}
