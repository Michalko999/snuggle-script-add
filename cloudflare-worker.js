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
//        tabuľky si worker vytvorí sám. D1 je hneď konzistentná, takže zmena
//        z jedného mobilu je na druhom do pár sekúnd. Okrem položiek drží aj
//        nastavenia: naučené kategórie, poradie uličiek a históriu nákupov.
//      alebo staršie KV Namespace nabindované ako  LIST
//        KV sa na ostatné miesta Cloudflaru dostane až do ~60 s, preto je pomalšie.
//        Ak máš nabindované obe, zoznam sa pri prvom spustení sám prenesie z KV do D1.
//      (bez D1 aj KV appka funguje, len sa zoznam nesynchronizuje medzi zariadeniami)
//
// Upozornenia (Web Push) potrebujú D1. Kľúče na podpisovanie (VAPID) si worker
// vytvorí sám a uloží do D1; ak má nastavené premenné VAPID_PUBLIC a VAPID_PRIVATE,
// použije tie. Keď mobil pridá položky, ostatné mobily so zapnutými
// upozorneniami dostanú jedno upozornenie so zoznamom pridaného.
//
// Po zrušení pripomienok sa už nepoužívajú a môžeš ich v Cloudflare zmazať:
//   KV binding "reminders" a hlavne Cron Trigger */3 * * * * (inak sa spúšťa
//   každé 3 minúty nadarmo). Premenné VAPID_* môžu zostať — použijú sa na upozornenia.
// ───────────────────────────────────────────────────────────────────

const LIST_KEY = "shopping-list";

export default {
  async fetch(request, env, ctx) {
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

    // ── Upozornenia (Web Push) ──────────────────────────────────────
    if (path.startsWith("/push/")) {
      if (!env.DB) return json({ error: "Upozornenia potrebujú D1 databázu (binding DB)." }, 501, cors);
      await prepareD1(env);

      if (path === "/push/key" && request.method === "GET") {
        return json({ publicKey: (await vapidKeys(env)).publicKey }, 200, cors);
      }
      if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405, cors);
      let body;
      try { body = await request.json(); } catch { return json({ error: "Neplatné dáta" }, 400, cors); }

      if (path === "/push/subscribe") {
        const sub = body?.subscription;
        const deviceId = cleanDeviceId(body?.deviceId);
        if (!sub?.endpoint?.startsWith("https://") || !sub.keys?.p256dh || !sub.keys?.auth || !deviceId) {
          return json({ error: "Chýba subscription alebo deviceId" }, 400, cors);
        }
        // Jeden mobil = jedno prihlásenie; staré (napr. po reinštalácii) nahradíme.
        await env.DB.batch([
          env.DB.prepare("DELETE FROM push_subs WHERE device_id = ?1").bind(deviceId),
          env.DB.prepare("INSERT OR REPLACE INTO push_subs (endpoint, device_id, data, created_at) VALUES (?1, ?2, ?3, ?4)")
            .bind(sub.endpoint, deviceId, JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys }), Date.now()),
        ]);
        return json({ ok: true }, 200, cors);
      }
      if (path === "/push/unsubscribe") {
        const deviceId = cleanDeviceId(body?.deviceId);
        await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?1 OR device_id = ?2")
          .bind(String(body?.endpoint ?? ""), deviceId ?? "").run();
        return json({ ok: true }, 200, cors);
      }
      return json({ error: "Not Found" }, 404, cors);
    }

    // ── Synchronizácia zoznamu ──────────────────────────────────────
    if (path === "/list") {
      if (!env.DB && !env.LIST) {
        return json({ error: "Worker nemá nabindované úložisko (D1 'DB' ani KV 'LIST')." }, 501, cors);
      }

      // Nastavenia (naučené kategórie, poradie uličiek, história nákupov) sa
      // posielajú len tie, čo sa zmenili od verzie, ktorú už mobil má.
      const settingsSince = Number(new URL(request.url).searchParams.get("settingsSince")) || 0;

      if (request.method === "GET") {
        return json({ items: await loadItems(env), ...(await loadSettings(env, settingsSince)) }, 200, cors);
      }

      if (request.method === "PUT") {
        let items, settings, deviceId;
        try {
          const parsed = JSON.parse(await request.text());
          if (!Array.isArray(parsed.items)) throw new Error("chýba pole 'items'");
          items = parsed.items.filter(it => it && typeof it.id === "string");
          settings = validSettings(parsed.settings);
          deviceId = cleanDeviceId(parsed.deviceId);
        } catch (e) {
          return json({ error: "Neplatné dáta: " + e.message }, 400, cors);
        }
        if (settings.length) await mergeSettings(env, settings);
        // Položky, ktoré server ešte nepozná, sú novo pridané — ohlásime ich
        // ostatným mobilom. Odoslanie beží na pozadí, odpoveď nečaká.
        const added = env.DB && deviceId ? await newItems(env, items) : [];
        // Zlúčenie robí server, takže mobil, ktorý ešte nevidel cudziu zmenu,
        // ju svojím zoznamom neprepíše. Späť dostane už zlúčený zoznam.
        const merged = await mergeItems(env, items);
        if (added.length) ctx?.waitUntil(notifyOthers(env, deviceId, added).catch(e => console.log("[push]", e.message)));
        return json({
          items: merged,
          ...(await loadSettings(env, settingsSince)),
          updatedAt: Date.now(),
        }, 200, cors);
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
const SETTINGS_KEY = "shopping-settings";
let d1Ready = false;

async function prepareD1(env) {
  if (d1Ready) return;
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL)"
  );
  // server_at = kedy záznam prišiel na server; podľa neho mobil dostáva len novinky
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, server_at INTEGER NOT NULL, value TEXT NOT NULL)"
  );
  await env.DB.exec("CREATE INDEX IF NOT EXISTS settings_server_at ON settings (server_at)");
  await env.DB.exec("CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, device_id TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL)");
  await env.DB.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
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

// ── Nastavenia: každý kľúč zvlášť, novšia zmena (updatedAt) vyhráva ──

function validSettings(raw) {
  if (raw == null) return [];
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("'settings' musí byť objekt");
  const entries = Object.entries(raw);
  if (entries.length > 1000) throw new Error("príliš veľa nastavení naraz");
  return entries.filter(([key, entry]) =>
    key.length <= 200 && entry && typeof entry === "object" && Number.isFinite(Number(entry.updatedAt))
    && JSON.stringify(entry.value ?? null).length <= 4000);
}

async function mergeSettings(env, entries) {
  const now = Date.now();
  if (env.DB) {
    await prepareD1(env);
    const stmt = env.DB.prepare(
      `INSERT INTO settings (key, updated_at, server_at, value) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at, server_at = excluded.server_at, value = excluded.value
       WHERE excluded.updated_at > settings.updated_at`
    );
    const statements = entries.map(([key, e]) => stmt.bind(key, Number(e.updatedAt), now, JSON.stringify(e.value ?? null)));
    for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50));
    return;
  }
  const stored = JSON.parse((await env.LIST.get(SETTINGS_KEY)) ?? "{}");
  let changed = false;
  entries.forEach(([key, e]) => {
    if (!stored[key] || Number(e.updatedAt) > stored[key].updatedAt) {
      stored[key] = { value: e.value ?? null, updatedAt: Number(e.updatedAt), serverAt: now };
      changed = true;
    }
  });
  if (changed) await env.LIST.put(SETTINGS_KEY, JSON.stringify(stored));
}

async function loadSettings(env, since) {
  if (env.DB) {
    await prepareD1(env);
    const { results } = await env.DB.prepare("SELECT key, updated_at, value FROM settings WHERE server_at >= ?1").bind(since).all();
    const version = (await env.DB.prepare("SELECT MAX(server_at) AS v FROM settings").first("v")) ?? 0;
    return {
      settings: Object.fromEntries(results.map(r => [r.key, { value: JSON.parse(r.value), updatedAt: r.updated_at }])),
      settingsVersion: version,
    };
  }
  const stored = JSON.parse((await env.LIST.get(SETTINGS_KEY)) ?? "{}");
  const entries = Object.entries(stored);
  return {
    settings: Object.fromEntries(entries.filter(([, e]) => e.serverAt >= since).map(([k, e]) => [k, { value: e.value, updatedAt: e.updatedAt }])),
    settingsVersion: entries.reduce((max, [, e]) => Math.max(max, e.serverAt), 0),
  };
}

// ── Upozornenia na nové položky ────────────────────────────────────

function cleanDeviceId(raw) {
  return typeof raw === "string" && /^[A-Za-z0-9-]{8,64}$/.test(raw) ? raw : null;
}

async function newItems(env, incoming) {
  const candidates = incoming.filter(it => !it.deleted && !it.completed && typeof it.text === "string");
  if (!candidates.length) return [];
  await prepareD1(env);
  const known = new Set();
  for (let i = 0; i < candidates.length; i += 90) {
    const chunk = candidates.slice(i, i + 90);
    const { results } = await env.DB.prepare(`SELECT id FROM items WHERE id IN (${chunk.map((_, j) => `?${j + 1}`).join(",")})`)
      .bind(...chunk.map(it => it.id)).all();
    results.forEach(r => known.add(r.id));
  }
  return candidates.filter(it => !known.has(it.id));
}

function describeAdded(items) {
  const names = items.map(it => (it.qty ? `${it.text} (${it.qty})` : it.text));
  const n = names.length;
  if (n === 1) return { title: "Nákupný zoznam", body: `Pridané: ${names[0]}` };
  const word = n <= 4 ? "položky" : "položiek";
  const shown = names.slice(0, 5).join(", ");
  return { title: `Pridané ${n} ${word}`, body: n > 5 ? `${shown} a ďalšie ${n - 5}` : shown };
}

async function notifyOthers(env, fromDevice, items) {
  const { results } = await env.DB.prepare("SELECT endpoint, data FROM push_subs WHERE device_id != ?1").bind(fromDevice).all();
  if (!results.length) return;
  const message = { ...describeAdded(items), tag: "pridane" };
  const keys = await vapidKeys(env);
  await Promise.all(results.map(async row => {
    const status = await sendPush(keys, JSON.parse(row.data), message).catch(() => 0);
    // 404/410 = mobil upozornenia zrušil alebo appku odinštaloval
    if (status === 404 || status === 410) await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?1").bind(row.endpoint).run();
    else if (status >= 300 || status === 0) console.log(`[push] ${status} pre ${new URL(row.endpoint).host}`);
  }));
}

// Kľúče VAPID: z premenných, ak sú nastavené; inak ich worker raz vytvorí a uloží do D1.
async function vapidKeys(env) {
  const subject = env.VAPID_SUBJECT || "https://michalko999.github.io/snuggle-script-add/";
  if (env.VAPID_PUBLIC && env.VAPID_PRIVATE) return { publicKey: env.VAPID_PUBLIC, privateJwk: env.VAPID_PRIVATE, subject };
  let stored = await env.DB.prepare("SELECT value FROM meta WHERE key = 'vapid'").first("value");
  if (!stored) {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const publicKey = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
    const privateJwk = JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
    // Pri súbehu dvoch požiadaviek vyhrá prvý zápis a obe použijú ten istý kľúč.
    await env.DB.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('vapid', ?1)").bind(JSON.stringify({ publicKey, privateJwk })).run();
    stored = await env.DB.prepare("SELECT value FROM meta WHERE key = 'vapid'").first("value");
  }
  return { ...JSON.parse(stored), subject };
}

// ── Web Push (RFC 8291 aes128gcm + VAPID RFC 8292) ──────────────────

async function sendPush(keys, subscription, message) {
  const encrypted = await encryptPayload(subscription, JSON.stringify(message));
  const jwt = await vapidJWT(subscription.endpoint, keys.privateJwk, keys.subject);
  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "Authorization": `vapid t=${jwt}, k=${keys.publicKey}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": "86400",
      "Urgency": "high",
    },
    body: encrypted,
  });
  return res.status;
}

async function vapidJWT(endpoint, privateJwkStr, subject) {
  const u = new URL(endpoint);
  const aud = `${u.protocol}//${u.host}`;
  const header = { typ: "JWT", alg: "ES256" };
  const payload = { aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject || "mailto:admin@example.com" };
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const signingInput = `${enc(header)}.${enc(payload)}`;
  const jwk = JSON.parse(privateJwkStr);
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

async function encryptPayload(subscription, payloadStr) {
  const uaPublic = b64urlToBytes(subscription.keys.p256dh); // 65 B
  const authSecret = b64urlToBytes(subscription.keys.auth); // 16 B

  const serverKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", serverKeys.publicKey)); // 65 B
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, serverKeys.privateKey, 256));

  const hmac = async (keyBytes, dataBytes) => {
    const k = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", k, dataBytes));
  };

  // RFC 8291 — odvodenie IKM
  const keyInfo = concat(new TextEncoder().encode("WebPush: info\0"), uaPublic, asPublic);
  const prkKey = await hmac(authSecret, ecdhSecret);
  const ikm = (await hmac(prkKey, concat(keyInfo, Uint8Array.of(1)))).slice(0, 32);

  // RFC 8188 — obsahový kľúč
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(new TextEncoder().encode("Content-Encoding: aes128gcm\0"), Uint8Array.of(1)))).slice(0, 16);
  const nonce = (await hmac(prk, concat(new TextEncoder().encode("Content-Encoding: nonce\0"), Uint8Array.of(1)))).slice(0, 12);

  const plaintext = concat(new TextEncoder().encode(payloadStr), Uint8Array.of(2)); // 0x02 = posledný záznam
  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plaintext));

  // hlavička: salt(16) || rs(4) || idlen(1) || keyid(asPublic 65)
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false);
  header[20] = asPublic.length;
  header.set(asPublic, 21);

  return concat(header, ciphertext);
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

function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function b64url(arr) {
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...arrs) {
  const len = arrs.reduce((a, x) => a + x.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
