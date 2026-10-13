import { createClient, SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

/** Server-only Supabase client (service role). Never import from client components. */
export function db(): SupabaseClient {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}

/** Throw on Supabase errors so failures are never silent. */
export function must<T>(res: { data: T; error: { message: string } | null }, what: string): NonNullable<T> {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data as NonNullable<T>; // writes without .select() legitimately return null data
}

export async function logEvent(personId: string, step: string, message: string) {
  await db().from("job_events").insert({ person_id: personId, step, message });
}

export type Person = {
  id: string;
  name: string;
  linkedin_url: string;
  instagram_url: string;
  consent_source: string;
  gender: "man" | "woman" | null;
  avatar_url: string | null;
  status: string;
  error: string | null;
  created_at: string;
};

export type EvidenceRow = {
  person_id: string;
  id: string;
  source: "linkedin" | "instagram";
  kind: string;
  text: string;
  image_url: string | null;
  meta: Record<string, unknown>;
};
