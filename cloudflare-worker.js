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
//   3. Settings → Bindings → D1 database → nabinduj ako  DB   (odporúčané)
//        Storage & Databases → D1 → Create database (napr. "nakupny-zoznam"),
//        tabuľku si worker vytvorí sám. D1 je hneď konzistentná, takže zmena
//        z jedného mobilu je na druhom do pár sekúnd.
//      alebo staršie KV Namespace nabindované ako  LIST
//        KV sa na ostatné miesta Cloudflaru dostane až do ~60 s, preto je pomalšie.
//        Ak máš nabindované obe, zoznam sa pri prvom spustení sám prenesie z KV do D1.
//      (bez D1 aj KV appka funguje, len sa zoznam nesynchronizuje medzi zariadeniami)
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
      if (!env.DB && !env.LIST) {
        return json({ error: "Worker nemá nabindované úložisko (D1 'DB' ani KV 'LIST')." }, 501, cors);
      }

      if (request.method === "GET") {
        return json({ items: await loadItems(env) }, 200, cors);
      }

      if (request.method === "PUT") {
        let items;
        try {
          const parsed = JSON.parse(await request.text());
          if (!Array.isArray(parsed.items)) throw new Error("chýba pole 'items'");
          items = parsed.items.filter(it => it && typeof it.id === "string");
        } catch (e) {
          return json({ error: "Neplatné dáta: " + e.message }, 400, cors);
        }
        // Zlúčenie robí server, takže mobil, ktorý ešte nevidel cudziu zmenu,
        // ju svojím zoznamom neprepíše. Späť dostane už zlúčený zoznam.
        return json({ items: await mergeItems(env, items), updatedAt: Date.now() }, 200, cors);
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

// ── Úložisko zoznamu ───────────────────────────────────────────────
// D1: jeden riadok na položku; pri rovnakom id vyhrá novšia zmena (updated_at).
// KV: celý zoznam pod jedným kľúčom, zlúčený v workeri.

const TOMBSTONE_MS = 7 * 24 * 60 * 60 * 1000; // rovnako ako v appke
let d1Ready = false;

async function prepareD1(env) {
  if (d1Ready) return;
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL)"
  );
  // Prvé spustenie s D1: prenes doterajší zoznam z KV, nech sa nič nestratí.
  if (env.LIST) {
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM items").first("n");
    if (!count) {
      const stored = await env.LIST.get(LIST_KEY);
      const items = stored ? (JSON.parse(stored).items ?? []) : [];
      if (items.length) await upsertD1(env, items);
    }
  }
  d1Ready = true;
}

async function upsertD1(env, items) {
  const stmt = env.DB.prepare(
    `INSERT INTO items (id, updated_at, deleted, data) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, deleted = excluded.deleted, data = excluded.data
     WHERE excluded.updated_at > items.updated_at`
  );
  const statements = items.map(it => stmt.bind(it.id, Number(it.updatedAt) || 0, it.deleted ? 1 : 0, JSON.stringify(it)));
  // D1 obmedzuje veľkosť jednej dávky, tak po kúskoch
  for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50));
}

async function loadItems(env) {
  if (env.DB) {
    await prepareD1(env);
    const { results } = await env.DB.prepare("SELECT data FROM items").all();
    return results.map(r => JSON.parse(r.data));
  }
  const stored = await env.LIST.get(LIST_KEY);
  return stored ? (JSON.parse(stored).items ?? []) : [];
}

async function mergeItems(env, incoming) {
  const cutoff = Date.now() - TOMBSTONE_MS;
  if (env.DB) {
    await prepareD1(env);
    await upsertD1(env, incoming);
    await env.DB.prepare("DELETE FROM items WHERE deleted = 1 AND updated_at < ?1").bind(cutoff).run();
    return loadItems(env);
  }
  const byId = new Map();
  [...(await loadItems(env)), ...incoming].forEach(it => {
    const prev = byId.get(it.id);
    if (!prev || (Number(it.updatedAt) || 0) > (Number(prev.updatedAt) || 0)) byId.set(it.id, it);
  });
  const merged = [...byId.values()].filter(it => !(it.deleted && it.updatedAt < cutoff));
  await env.LIST.put(LIST_KEY, JSON.stringify({ items: merged, updatedAt: Date.now() }));
  return merged;
}

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
