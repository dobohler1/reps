import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Rep — generate-retest : authors ONE fresh practice problem isolating a skill
// and targeting a misconception, at the source difficulty. Quota-metered.
// ---------------------------------------------------------------------------

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = "claude-sonnet-4-6";
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const FREE_ANON = 6, FREE_EMAIL = 30;
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

const SYSTEM = `You are an expert Algebra 1 problem author for Science on the Court. Author ONE fresh practice problem that isolates the given SKILL and specifically targets the given MISCONCEPTION, at the SAME difficulty as the source problem.

Rules:
- Vary the numbers and context so it is clearly a new problem, not the source reworded.
- It must be cleanly solvable by hand by a middle/early-high-school student.
- The problem must give a real chance to make (and correct) the named misconception.
- Use plain ASCII math notation consistent with the source (e.g., sqrt(), ^, /, *). Do NOT use LaTeX or dollar signs.
- Provide a complete, correct worked solution and the final answer.
- If attempt > 1, nudge the difficulty/representation slightly so the student sees the idea a new way.`;

const TOOL = {
  name: "emit_problem",
  description: "Emit a fresh targeted practice problem with its worked solution.",
  input_schema: {
    type: "object",
    properties: {
      problem: { type: "string", description: "The problem statement, plain ASCII math." },
      skill: { type: "string", description: "Short label of the skill being practiced." },
      solution: { type: "string", description: "Complete worked solution, step by step, plain ASCII." },
      final_answer: { type: "string", description: "The final answer only." },
    },
    required: ["problem", "solution", "final_answer"],
  },
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "POST only" }, 405);
  if (!ANTHROPIC_API_KEY) return json(req, { error: "server misconfigured: missing key" }, 500);

  let body: any;
  try { body = await req.json(); } catch { return json(req, { error: "invalid JSON body" }, 400); }

  const { skill, misconception, sourceProblem, attempt, userId } = body ?? {};
  if (!skill && !sourceProblem) return json(req, { error: "need skill or sourceProblem" }, 400);

  const g = await gate(userId);
  if (!g.allow) return json(req, { ok: false, gated: true, need: g.need, used: g.used, limit: g.limit }, 200);
  if (!await bumpUsage(userId)) return json(req, { error: "usage tracking failed" }, 500);

  const userText = `SKILL: ${skill ?? "—"}\nTARGET MISCONCEPTION: ${misconception ?? "—"}\nSOURCE PROBLEM (match its difficulty, do NOT copy): ${sourceProblem ?? "—"}\nATTEMPT NUMBER: ${attempt ?? 1}\n\nAuthor one fresh practice problem.`;

  const payload = {
    model: MODEL,
    max_tokens: 700,
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: "tool", name: "emit_problem" },
    messages: [{ role: "user", content: userText }],
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
  if (!tu) return json(req, { ok: false, error: "no structured output" }, 200);

  return json(req, { ok: true, ...tu.input });
});
