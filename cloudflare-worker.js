// Cloudflare Worker — Anthropic AI proxy + Web Push pre pripomienky
// ───────────────────────────────────────────────────────────────────
// Nasadenie:
//   1. dash.cloudflare.com → Workers & Pages → tvoj worker → Edit code → vlož tento súbor
//   2. Settings → Variables:
//        - VAPID_PUBLIC   (Text)   = verejný kľúč (application server key)
//        - VAPID_SUBJECT  (Text)   = mailto:tvoj@email.sk
//        - VAPID_PRIVATE  (Secret) = privátny JWK (jeden riadok)
//   3. Settings → Bindings → KV Namespace: vytvor namespace a nabinduj ako  REMINDERS
//   4. Settings → Triggers → Cron Triggers: pridaj  * * * * *  (každú minútu)
// ───────────────────────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "x-api-key, anthropic-version, content-type",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname;

    // ── Web Push: verejný kľúč ──────────────────────────────────────
    if (path === "/push/key" && request.method === "GET") {
      return json({ publicKey: env.VAPID_PUBLIC ?? "" });
    }

    // ── Web Push: synchronizácia predplatného + pripomienok ─────────
    if (path === "/push/sync" && request.method === "POST") {
      try {
        const { subscription, reminders } = await request.json();
        if (!subscription?.endpoint) return json({ error: "missing subscription" }, 400);
        const key = "sub:" + (await sha256hex(subscription.endpoint));
        const existing = await env.REMINDERS.get(key, "json");
        const sentIds = new Set((existing?.reminders ?? []).filter(r => r.sent).map(r => r.id));
        const merged = (reminders ?? [])
          .filter(r => r && r.id && typeof r.time === "number")
          .map(r => ({ id: r.id, text: r.text ?? "", time: r.time, sent: sentIds.has(r.id) }));
        await env.REMINDERS.put(key, JSON.stringify({ subscription, reminders: merged }));
        return json({ ok: true, stored: merged.length });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    // ── AI proxy (pôvodné správanie) ────────────────────────────────
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: CORS });

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": request.headers.get("x-api-key") ?? "",
        "anthropic-version": request.headers.get("anthropic-version") ?? "2023-06-01",
        "content-type": "application/json",
      },
      body: request.body,
    });
    const body = await response.text();
    return new Response(body, { status: response.status, headers: { ...CORS, "content-type": "application/json" } });
  },

  // ── Cron: každú minútu pošli dozreté pripomienky ──────────────────
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDueReminders(env));
  },
};

// ── Odoslanie dozretých pripomienok ─────────────────────────────────

async function sendDueReminders(env) {
  const now = Date.now();
  const list = await env.REMINDERS.list({ prefix: "sub:" });
  for (const k of list.keys) {
    const data = await env.REMINDERS.get(k.name, "json");
    if (!data?.subscription) continue;
    let changed = false;
    let gone = false;

    for (const r of data.reminders ?? []) {
      if (!r.sent && r.time <= now) {
        try {
          const status = await sendPush(env, data.subscription, "Pripomienka", r.text);
          if (status === 404 || status === 410) gone = true;
        } catch (e) { /* skús nabudúce */ }
        r.sent = true;
        changed = true;
      }
    }

    if (gone) { await env.REMINDERS.delete(k.name); continue; }

    // upraď staré (viac ako deň po termíne)
    const before = (data.reminders ?? []).length;
    data.reminders = (data.reminders ?? []).filter(r => r.time > now - 86400000);
    if (changed || data.reminders.length !== before) {
      if (data.reminders.length) await env.REMINDERS.put(k.name, JSON.stringify(data));
      else await env.REMINDERS.delete(k.name);
    }
  }
}

// ── Web Push (RFC 8291 aes128gcm + VAPID RFC 8292) ──────────────────

async function sendPush(env, subscription, title, body) {
  const payload = JSON.stringify({ title, body });
  const encrypted = await encryptPayload(subscription, payload);
  const jwt = await vapidJWT(subscription.endpoint, env.VAPID_PRIVATE, env.VAPID_SUBJECT);
  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "Authorization": `vapid t=${jwt}, k=${env.VAPID_PUBLIC}`,
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

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, "content-type": "application/json" } });
}

async function sha256hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
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
