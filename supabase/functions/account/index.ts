import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Rep — account : free-tier status + email unlock. Backs the metered funnel
// (anonymous free → email unlock → pay). Service-role DB access only.
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const FREE_ANON = 6;   // AI calls before email unlock (tunable)
const FREE_EMAIL = 30; // AI calls after email unlock, before pay (tunable)
const USER_ID_RE = /^[a-zA-Z0-9:_@.\-]{3,160}$/;
const DEFAULT_ALLOWED_ORIGINS = "https://dobohler1.github.io,http://localhost:8000,http://127.0.0.1:8000,http://localhost:3000,http://127.0.0.1:3000";
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? DEFAULT_ALLOWED_ORIGINS).split(",").map((s) => s.trim()).filter(Boolean);

function cors(req: Request) {
  const origin = req.headers.get("origin") ?? "";
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0] ?? "https://dobohler1.github.io";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });
}
function statusOf(row: any) {
  const entitled = !!row.entitled;
  const limit = entitled ? null : (row.email_unlocked ? FREE_EMAIL : FREE_ANON);
  const remaining = entitled ? null : Math.max(0, (limit as number) - row.ai_calls);
  return { ai_calls: row.ai_calls, email_unlocked: row.email_unlocked, entitled, limit, remaining, has_email: !!row.email };
}
async function getOrCreate(userId: string) {
  let { data: row, error } = await sb.from("usage").select("*").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (!row) {
    const ins = await sb.from("usage").insert({ user_id: userId }).select().single();
    if (ins.error || !ins.data) throw ins.error ?? new Error("usage insert failed");
    row = ins.data;
  }
  return row;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "POST only" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json(req, { error: "invalid JSON" }, 400); }
  const { action, userId, email } = body ?? {};
  if (!userId || !USER_ID_RE.test(userId)) return json(req, { error: "valid userId required" }, 400);

  if (action === "status") {
    try {
      const row = await getOrCreate(userId);
      return json(req, { ok: true, ...statusOf(row) });
    } catch (e) {
      console.error("account status error", String(e));
      return json(req, { error: "account lookup failed" }, 500);
    }
  }
  if (action === "set-email") {
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(req, { error: "valid email required" }, 400);
    const { error } = await sb.from("usage").upsert(
      { user_id: userId, email, email_unlocked: true, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
    if (error) {
      console.error("set-email error", String(error));
      return json(req, { error: "email unlock failed" }, 500);
    }
    try {
      const row = await getOrCreate(userId);
      return json(req, { ok: true, ...statusOf(row) });
    } catch (e) {
      console.error("account refresh error", String(e));
      return json(req, { error: "account refresh failed" }, 500);
    }
  }
  return json(req, { error: "unknown action" }, 400);
});
