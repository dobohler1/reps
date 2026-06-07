import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Rep — stripe-webhook : auto-entitlement. Verifies Stripe's signature, then
// flips usage.entitled=true for the paying user. verify_jwt is FALSE because
// Stripe calls this without a Supabase JWT; we authenticate via the signature.
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const WHSEC = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

async function verifySig(raw: string, header: string | null): Promise<boolean> {
  if (!header) return false;
  let t = ""; const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=");
    if (k === "t") t = v; else if (k === "v1") v1.push(v);
  }
  if (!t || !v1.length) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(WHSEC), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${raw}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return v1.some((x) => x === hex);
}

async function entitle(uid: string | null, email: string | null) {
  if (uid) {
    const { error } = await sb.from("usage").upsert({ user_id: uid, entitled: true, ...(email ? { email } : {}), updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    if (error) throw error;
  }
  if (email) {
    const { error } = await sb.from("usage").update({ entitled: true, updated_at: new Date().toISOString() }).eq("email", email);
    if (error) throw error;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const raw = await req.text();
  const ok = await verifySig(raw, req.headers.get("stripe-signature"));
  if (!ok) return new Response("bad signature", { status: 400 });

  let event: any;
  try { event = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }

  try {
    if (event.type === "checkout.session.completed") {
      const s = event.data.object;
      await entitle(s.client_reference_id ?? null, (s.customer_details?.email) ?? s.customer_email ?? null);
    } else if (event.type === "invoice.paid") {
      const inv = event.data.object;
      await entitle(null, inv.customer_email ?? null);
    }
  } catch (e) {
    console.error("entitle error", String(e));
    return new Response("entitle failed", { status: 500 });
  }
  return new Response(JSON.stringify({ received: true }), { status: 200, headers: { "Content-Type": "application/json" } });
});
