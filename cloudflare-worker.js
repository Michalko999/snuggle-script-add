// Cloudflare Worker — AI proxy pre nákupný zoznam + synchronizácia zoznamu
// ───────────────────────────────────────────────────────────────────
// Anthropic kľúč žije TU, nie v prehliadači. Appka posiela iba prístupový token.
//
// Nasadenie:
//   1. dash.cloudflare.com → Workers & Pages → tvoj worker → Edit code → vlož tento súbor
//   2. Settings → Variables and Secrets:
//        - ANTHROPIC_API_KEY (Secret) = kľúč z console.anthropic.com
//        - APP_TOKEN         (Secret) = ľubovoľné heslo; to isté zadáš v appke v ⚙️
//        - ALLOWED_ORIGINS   (Text, voliteľné) = https://michalko999.github.io
//   3. Settings → Bindings → KV Namespace → nabinduj ako  LIST
//        (bez neho appka funguje, len sa zoznam nesynchronizuje medzi zariadeniami)
//
// Po zrušení pripomienok sa už nepoužívajú a môžeš ich v Cloudflare zmazať:
//   premenné VAPID_PUBLIC / VAPID_PRIVATE / VAPID_SUBJECT, KV binding "reminders"
//   a hlavne Cron Trigger */3 * * * * (inak sa spúšťa každé 3 minúty nadarmo).
// ───────────────────────────────────────────────────────────────────

const LIST_KEY = "shopping-list";

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    // Bez tokenu sa k workeru (a teda k tvojim kreditom) nikto nedostane.
    if (!env.APP_TOKEN) {
      return json({ error: "Worker nemá nastavený APP_TOKEN." }, 500, cors);
    }
    if (request.headers.get("x-app-token") !== env.APP_TOKEN) {
      return json({ error: "Neplatný prístupový token." }, 401, cors);
    }

    const path = new URL(request.url).pathname;

    // ── Synchronizácia zoznamu ──────────────────────────────────────
    if (path === "/list") {
      if (!env.LIST) return json({ error: "Worker nemá nabindované KV úložisko 'LIST'." }, 501, cors);

      if (request.method === "GET") {
        const stored = await env.LIST.get(LIST_KEY);
        return new Response(stored ?? JSON.stringify({ items: [], updatedAt: 0 }), {
          headers: { ...cors, "content-type": "application/json" },
        });
      }

      if (request.method === "PUT") {
        const body = await request.text();
        try {
          const parsed = JSON.parse(body);
          if (!Array.isArray(parsed.items)) throw new Error("chýba pole 'items'");
        } catch (e) {
          return json({ error: "Neplatné dáta: " + e.message }, 400, cors);
        }
        await env.LIST.put(LIST_KEY, body);
        return json({ ok: true }, 200, cors);
      }

      return json({ error: "Method Not Allowed" }, 405, cors);
    }

    // ── AI proxy ────────────────────────────────────────────────────
    if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405, cors);
    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: "Worker nemá nastavený ANTHROPIC_API_KEY." }, 500, cors);
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: request.body,
    });
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: { ...cors, "content-type": "application/json" },
    });
  },
};

// ── Pomocné ─────────────────────────────────────────────────────────

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") ?? "";
  const allowed = (env.ALLOWED_ORIGINS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const allowOrigin = !allowed.length ? "*" : allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-app-token",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(obj, status = 200, cors = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}
