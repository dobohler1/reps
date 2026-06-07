import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Rep — analyze-work : vision proxy. Judges correctness + names the SPECIFIC
// misconception + a NUDGE + teacher-style MARKUP coordinates. Used for the
// initial diagnosis AND for grading re-test attempts. Quota-metered by user_id.
// ---------------------------------------------------------------------------

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = "claude-sonnet-4-6";
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const FREE_ANON = 6, FREE_EMAIL = 30;
const MAX_IMAGE_BASE64_CHARS = 5_000_000;
const USER_ID_RE = /^[a-zA-Z0-9:_@.\-]{3,160}$/;
const DEFAULT_ALLOWED_ORIGINS = "https://dobohler1.github.io,http://localhost:8000,http://127.0.0.1:8000,http://localhost:3000,http://127.0.0.1:3000";
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? DEFAULT_ALLOWED_ORIGINS).split(",").map((s) => s.trim()).filter(Boolean);
type GateResult = { allow: true } | { allow: false; need: string; used?: number; limit?: number };

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

async function gate(userId?: string): Promise<GateResult> {
  if (!userId || !USER_ID_RE.test(userId)) return { allow: false, need: "identity" };
  let { data: row, error } = await sb.from("usage").select("*").eq("user_id", userId).maybeSingle();
  if (error) return { allow: false, need: "server" };
  if (!row) {
    const ins = await sb.from("usage").insert({ user_id: userId }).select().single();
    if (ins.error || !ins.data) return { allow: false, need: "server" };
    row = ins.data;
  }
  if (row.entitled) return { allow: true };
  const limit = row.email_unlocked ? FREE_EMAIL : FREE_ANON;
  if (row.ai_calls >= limit) return { allow: false, need: row.email_unlocked ? "pay" : "email", used: row.ai_calls, limit };
  return { allow: true };
}

async function bumpUsage(userId: string) {
  const { error } = await sb.rpc("bump_ai_calls", { uid: userId });
  return !error;
}

const SYSTEM = `You are a master Algebra 1 diagnostician for Science on the Court, trained on years of teaching students of color. A student attempted a problem and showed handwritten work on a scratch canvas. Look at THEIR ACTUAL WORK and:
1. Judge whether the work reaches a correct final answer (reached_correct_answer).
2. Name the single most likely SPECIFIC misconception driving any error — not a generic topic label. If correct, set misconception to "none".
3. Produce TEACHER-STYLE MARKUP: 0-3 marks anchored to regions of the image, like a teacher's red pen. Coordinates are normalized 0-1 with (0,0)=top-left, (1,1)=bottom-right; x,y = top-left of the region, w,h = its size. Prefer COARSE regions (a whole step/line, not a single character). Circle or strike the error, underline what to fix, arrow to point, check a correct step. Each mark's note is <=6 words.

Rules:
- Diagnose from what is visibly written, not what a typical student does.
- Be specific: "distributed the negative only to the first term" beats "sign error".
- ANGEL ON THE SHOULDER: coaching_hint is a short nudge that hands the NEXT step back to the student. NEVER give the full solution or final answer. If correct, coaching_hint is brief, specific praise.
- If the canvas has no relevant work (blank/doodles), set work_visible=false, reached_correct_answer=false, marks=[], and base the hint on the problem itself.`;

const TOOL = {
  name: "report_diagnosis",
  description: "Report correctness, the diagnosed misconception, a coaching nudge, and teacher-style markup.",
  input_schema: {
    type: "object",
    properties: {
      reached_correct_answer: { type: "boolean", description: "Does the visible work reach a correct final answer?" },
      work_visible: { type: "boolean", description: "Did the canvas contain relevant work?" },
      misconception: { type: "string", description: "Short specific label (<=12 words), or 'none' if correct." },
      explanation: { type: "string", description: "1-2 sentences: what the student did, citing their work." },
      coaching_hint: { type: "string", description: "A short nudge handing the next step back to the student. NO full solution. If correct, brief praise." },
      try_representation: { type: "string", description: "If stuck, an alternate way to see it (visual/numeric/analogy). Else empty string." },
      confidence: { type: "string", enum: ["low", "medium", "high"] },
      marks: {
        type: "array",
        description: "Teacher-style markup, 0-3 items, anchored to image regions. Coarse regions, normalized 0-1 coords.",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["circle", "strike", "underline", "arrow", "check"] },
            x: { type: "number", description: "left of region, 0-1" },
            y: { type: "number", description: "top of region, 0-1" },
            w: { type: "number", description: "width, 0-1" },
            h: { type: "number", description: "height, 0-1" },
            note: { type: "string", description: "<=6 words" },
          },
          required: ["type", "x", "y", "w", "h"],
        },
      },
    },
    required: ["reached_correct_answer", "work_visible", "misconception", "explanation", "coaching_hint", "confidence"],
  },
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "POST only" }, 405);
  if (!ANTHROPIC_API_KEY) return json(req, { error: "server misconfigured: missing key" }, 500);

  let body: any;
  try { body = await req.json(); } catch { return json(req, { error: "invalid JSON body" }, 400); }

  const { image, problem, skill, solution, selfGrade, userId } = body ?? {};
  if (!image || !problem) return json(req, { error: "need image and problem" }, 400);

  const g = await gate(userId);
  if (!g.allow) return json(req, { ok: false, gated: true, need: g.need, used: g.used, limit: g.limit }, 200);
  if (!await bumpUsage(userId)) return json(req, { error: "usage tracking failed" }, 500);

  const m = /^data:(image\/[a-zA-Z]+);base64,(.+)$/s.exec(image);
  if (!m) return json(req, { error: "image must be a base64 data URL" }, 400);
  const media_type = m[1];
  const data = m[2];
  if (data.length > MAX_IMAGE_BASE64_CHARS) return json(req, { error: "image too large" }, 413);

  const userText = `PROBLEM: ${problem}\nSKILL TESTED: ${skill ?? "—"}\nCORRECT SOLUTION (reference only, do NOT reveal): ${solution ?? "—"}\nSTUDENT SELF-GRADE: ${selfGrade ?? "—"}\n\nThe attached image is the student's handwritten scratch work. Judge correctness, diagnose, and mark it up.`;

  const payload = {
    model: MODEL,
    max_tokens: 900,
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: "tool", name: "report_diagnosis" },
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type, data } },
      { type: "text", text: userText },
    ] }],
  };

  let resp: Response;
  try {
    resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) { return json(req, { error: "upstream fetch failed", detail: String(e) }, 502); }

  if (!resp.ok) { const t = await resp.text(); return json(req, { error: "anthropic error", status: resp.status, detail: t.slice(0, 600) }, 502); }

  const out = await resp.json();
  const tu = (out.content ?? []).find((c: any) => c.type === "tool_use");
  if (!tu) { const text = (out.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n"); return json(req, { ok: false, error: "no structured output", raw: text.slice(0, 600) }, 200); }

  return json(req, { ok: true, ...tu.input });
});
