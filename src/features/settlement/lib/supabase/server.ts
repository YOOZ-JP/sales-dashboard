import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "./types";

/**
 * Server-side (RSC / Route Handler / Server Action) Supabase client.
 *
 * Uses the anon key + cookie session. For cron / migration / importer use
 * `createServiceClient()` instead which bypasses auth via the service role.
 */
export async function createClient() {
  const cookieStore = await cookies();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "Supabase env vars missing — set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.",
    );
  }

  return createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Called from a Server Component — ignore if middleware is refreshing.
        }
      },
    },
  });
}

/**
 * Admin / service-role client.
 *
 * Use only server-side (migrations, importer, cron). Never ship this to
 * the browser. Accepts a fallback URL (useful for scripts that pass in
 * env loaded from a `.env.local` file).
 */
export function createServiceClient(opts: {
  url?: string;
  serviceRoleKey?: string;
} = {}) {
  const url = opts.url ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = opts.serviceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Supabase service env vars missing — set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  // Lazy require so the browser bundle never loads this.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createClient } = require("@supabase/supabase-js") as typeof import("@supabase/supabase-js");
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** True iff NEXT_PUBLIC_SUPABASE_URL is set and not a placeholder. */
export function hasSupabaseEnv(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return false;
  if (url.includes("YOUR-PROJECT")) return false;
  if (key.startsWith("eyJ...")) return false;
  return true;
}

export function hasServiceRoleKey(): boolean {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return !!key && !key.startsWith("eyJ...");
}
