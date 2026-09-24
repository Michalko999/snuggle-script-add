import { useState, useEffect, useRef, useCallback, useMemo } from "react";

const CATEGORIES = [
  "Ovocie a zelenina",
  "Pečivo",
  "Mlieko, syry, maslo",
  "Jogurty a dezerty",
  "Mäso a hydina",
  "Údeniny a šunka",
  "Ryby",
  "Mrazené",
  "Cestoviny a ryža",
  "Múka, cukor, pečenie",
  "Konzervy a omáčky",
  "Sladkosti",
  "Slané snacky",
  "Nápoje",
  "Káva a čaj",
  "Alkohol",
  "Drogéria a hygiena",
  "Domácnosť a čistenie",
  "Iné",
];

// Staršie, hrubšie kategórie. Položky a naučené opravy z nich prenesieme
// do najbližšej novej kategórie, nech nespadnú do „Iné".
const LEGACY_CATEGORIES = {
  "Mliečne výrobky": "Mlieko, syry, maslo",
  "Mäso a ryby": "Mäso a hydina",
  "Cestoviny, ryža, múka": "Cestoviny a ryža",
  "Sladkosti a snacky": "Sladkosti",
  "Drogéria a domácnosť": "Drogéria a hygiena",
};

function migrateCategory(category) {
  return LEGACY_CATEGORIES[category] ?? category;
}

const CATEGORY_STYLES = {
  "Ovocie a zelenina":    { dot: "#10b981", chip: { bg: "#ecfdf5", color: "#047857", border: "#a7f3d0" } },
  "Pečivo":               { dot: "#f59e0b", chip: { bg: "#fffbeb", color: "#b45309", border: "#fde68a" } },
  "Mlieko, syry, maslo":  { dot: "#38bdf8", chip: { bg: "#f0f9ff", color: "#0369a1", border: "#bae6fd" } },
  "Jogurty a dezerty":    { dot: "#3b82f6", chip: { bg: "#eff6ff", color: "#1d4ed8", border: "#bfdbfe" } },
  "Mäso a hydina":        { dot: "#f43f5e", chip: { bg: "#fff1f2", color: "#be123c", border: "#fecdd3" } },
  "Údeniny a šunka":      { dot: "#ef4444", chip: { bg: "#fef2f2", color: "#b91c1c", border: "#fecaca" } },
  "Ryby":                 { dot: "#14b8a6", chip: { bg: "#f0fdfa", color: "#0f766e", border: "#99f6e4" } },
  "Mrazené":              { dot: "#818cf8", chip: { bg: "#eef2ff", color: "#4338ca", border: "#c7d2fe" } },
  "Cestoviny a ryža":     { dot: "#eab308", chip: { bg: "#fefce8", color: "#854d0e", border: "#fef08a" } },
  "Múka, cukor, pečenie": { dot: "#d4a373", chip: { bg: "#fdf6ec", color: "#a16207", border: "#f0dcc0" } },
  "Konzervy a omáčky":    { dot: "#f97316", chip: { bg: "#fff7ed", color: "#c2410c", border: "#fed7aa" } },
  "Sladkosti":            { dot: "#ec4899", chip: { bg: "#fdf2f8", color: "#be185d", border: "#fbcfe8" } },
  "Slané snacky":         { dot: "#d946ef", chip: { bg: "#fdf4ff", color: "#a21caf", border: "#f5d0fe" } },
  "Nápoje":               { dot: "#06b6d4", chip: { bg: "#ecfeff", color: "#0e7490", border: "#a5f3fc" } },
  "Káva a čaj":           { dot: "#78350f", chip: { bg: "#f5efe9", color: "#78350f", border: "#e5d3c3" } },
  "Alkohol":              { dot: "#7c3aed", chip: { bg: "#f5f3ff", color: "#6d28d9", border: "#ddd6fe" } },
  "Drogéria a hygiena":   { dot: "#a855f7", chip: { bg: "#faf5ff", color: "#7e22ce", border: "#e9d5ff" } },
  "Domácnosť a čistenie": { dot: "#22c55e", chip: { bg: "#f0fdf4", color: "#15803d", border: "#bbf7d0" } },
  "Iné":                  { dot: "#94a3b8", chip: { bg: "#f8fafc", color: "#475569", border: "#e2e8f0" } },
};

const APP_VERSION = "2.4";
const STORAGE_KEY = "todos-v3";
const PREFS_KEY = "category-prefs-v2";
const PROXY_KEY = "anthropic-proxy-url";
const TOKEN_KEY = "app-token-v1";
const SORT_MODE_KEY = "sort-by-category-v1";
const CAT_ORDER_KEY = "category-order-v1";
const LEGACY_APIKEY_KEY = "anthropic-api-key";
// Nastavenia, ktoré sa synchronizujú medzi mobilmi (pozri mergeSettings)
const SETTINGS_KEY = "synced-settings-v1";
const SETTINGS_DIRTY_KEY = "synced-settings-dirty-v1";
const HISTORY_SEEDED_KEY = "history-seeded-v1";
const DEVICE_ID_KEY = "device-id-v1";

// Zmazané položky sa nechávajú ako náhrobok, aby sa mazanie prenieslo
// na ostatné zariadenia a položka sa pri synchronizácii nevrátila.
const TOMBSTONE_MS = 7 * 24 * 60 * 60 * 1000;

// Kým je appka otvorená, pýta sa na zmeny z druhého mobilu takto často.
// Vlastnú zmenu odošle skoro hneď — krátke čakanie len zlúči rýchle ťuknutia.
const POLL_MS = 4000;
const PUSH_DELAY_MS = 500;

const SCAN_MODEL = "claude-sonnet-5";
const CATEGORIZE_MODEL = "claude-haiku-4-5";

function workerBase() {
  const raw = (localStorage.getItem(PROXY_KEY) ?? "").trim();
  if (!raw) return "";
  try { return new URL(raw).origin; } catch { return ""; }
}

function appToken() {
  return (localStorage.getItem(TOKEN_KEY) ?? "").trim();
}

// Náhodné id tohto mobilu — worker podľa neho vie, komu upozornenie neposlať.
function deviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(DEVICE_ID_KEY, id); }
  return id;
}

function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .trim();
}

function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

// Naučené opravy ukazujú na názvy kategórií, tak ich po premenovaní prepíšeme.
function migratePrefs(stored) {
  const next = {};
  let changed = false;
  Object.entries(stored ?? {}).forEach(([key, value]) => {
    const category = migrateCategory(value);
    if (CATEGORIES.includes(category)) next[key] = category;
    if (category !== value || !CATEGORIES.includes(category)) changed = true;
  });
  if (changed) localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  return next;
}

// Vlastné poradie kategórií si nechávame; nové kategórie doplníme k tej,
// vedľa ktorej sú v predvolenom poradí, nie na koniec zoznamu.
function mergeCatOrder(stored) {
  const order = [];
  stored.forEach(value => {
    const category = migrateCategory(value);
    if (CATEGORIES.includes(category) && !order.includes(category)) order.push(category);
  });
  CATEGORIES.forEach((category, i) => {
    if (order.includes(category)) return;
    let at = -1; // bez predchodcu ide kategória na začiatok
    for (let j = i - 1; j >= 0; j--) {
      const found = order.indexOf(CATEGORIES[j]);
      if (found !== -1) { at = found; break; }
    }
    order.splice(at + 1, 0, category);
  });
  return order;
}

// ── Synchronizované nastavenia ───────────────────────────────────
// Jeden plochý slovník: „pref:<položka>" = naučená kategória, „hist:<položka>" =
// história nákupov, „catOrder" = poradie uličiek. Každý záznam nesie čas zmeny
// a pri zlúčení s druhým mobilom vyhrá novší — rovnako ako pri položkách.

function mergeSettings(local, incoming) {
  let merged = local;
  Object.entries(incoming ?? {}).forEach(([key, entry]) => {
    if (!entry || typeof entry !== "object") return;
    const mine = merged[key];
    if (!mine || (entry.updatedAt ?? 0) > (mine.updatedAt ?? 0)) {
      if (merged === local) merged = { ...local };
      merged[key] = { value: entry.value, updatedAt: entry.updatedAt ?? 0 };
    }
  });
  return merged; // ten istý objekt, ak sa nič nezmenilo
}

function pickSettings(settings, prefix) {
  const out = {};
  Object.entries(settings).forEach(([key, entry]) => {
    if (key.startsWith(prefix) && entry.value != null) out[key.slice(prefix.length)] = entry.value;
  });
  return out;
}

// ── Rozbor napísaného textu ──────────────────────────────────────
// „mlieko 2 l, 6 vajec; chlieb" → tri položky s množstvom. AI potom ešte opraví
// tvar slov („vajec" → „Vajcia"), ale zoznam sa ukáže hneď aj bez nej.

const QTY_UNITS = "kusov|kusy|kus|ks|x|×|litre|litrov|litra|liter|ml|dl|cl|l|dkg|dag|kg|g|balenia|balenie|bal|fľaše|fľaša|fl|plechovky|plechovka|krabice|krabica";
const QTY_NUM = "\\d+(?:[.,]\\d+)?";
const QTY_LEAD = new RegExp(`^(${QTY_NUM})\\s*(${QTY_UNITS})?\\.?\\s+(.+)$`, "i");
const QTY_TRAIL = new RegExp(`^(.+?)\\s+(${QTY_NUM})\\s*(${QTY_UNITS})?\\.?$`, "i");
const QTY_TRAIL_X = /^(.+?)\s+[x×]\s*(\d+)$/i;
const UNIT_ALIASES = {
  kus: "ks", kusy: "ks", kusov: "ks", l: "L", liter: "L", litre: "L", litrov: "L", litra: "L",
  dag: "dkg", balenie: "bal", balenia: "bal", "fľaša": "fl", "fľaše": "fl",
  plechovka: "plech", plechovky: "plech", krabica: "krab", krabice: "krab",
};

function formatQty(num, unit) {
  const u = (unit ?? "").toLowerCase();
  if (!u || u === "x" || u === "×") return `${num}x`;
  return `${num} ${UNIT_ALIASES[u] ?? u}`;
}

// Samotné číslo bez jednotky berieme ako počet kusov len vtedy, keď je malé
// a celé — „Coca-Cola 1,5" alebo „Rama 500" nechá tak, ako sú napísané.
const plainCount = num => /^\d+$/.test(num) && Number(num) >= 1 && Number(num) <= 99;

function parseEntry(raw) {
  const s = raw.replace(/\s+/g, " ").trim();
  let m = s.match(QTY_LEAD);
  if (m && (m[2] || plainCount(m[1]))) return { raw: s, text: m[3].trim(), qty: formatQty(m[1], m[2]) };
  m = s.match(QTY_TRAIL_X);
  if (m) return { raw: s, text: m[1].trim(), qty: formatQty(m[2], "x") };
  m = s.match(QTY_TRAIL);
  if (m && (m[3] || plainCount(m[2]))) return { raw: s, text: m[1].trim(), qty: formatQty(m[2], m[3]) };
  return { raw: s, text: s, qty: "" };
}

// Čiarka medzi číslicami („1,5 kg") nie je oddeľovač. Nadiktovaný text nemá
// čiarky, tak tam delíme aj na „a" / „aj"; zvyšok rozdelí AI.
function splitInput(raw, { voice = false } = {}) {
  const sep = voice ? /;|\n|(?<!\d),|,(?!\d)|\s+(?:a|aj|potom)\s+/i : /;|\n|(?<!\d),|,(?!\d)/;
  return raw.split(sep).map(part => part.trim()).filter(Boolean).map(parseEntry).filter(e => e.text);
}

// ── Anthropic cez vlastný Cloudflare Worker ──────────────────────
// Kľúč je uložený vo Workeri; prehliadač posiela iba prístupový token.

async function callAnthropic(payload) {
  const base = workerBase();
  if (!base) throw new Error("Najprv nastav URL Cloudflare Workera (⚙️ hore vpravo).");
  let res;
  try {
    res = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json", "x-app-token": appToken() },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    throw new Error(`Sieťová chyba: ${e.message}`);
  }
  if (res.status === 401) throw new Error("Neplatný prístupový token — skontroluj ho v nastaveniach.");
  if (res.status === 429) throw new Error("Príliš veľa požiadaviek. Skús neskôr.");
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Chyba ${res.status}: ${detail.slice(0, 200)}`);
  }
  return res.json();
}

// output_config.format garantuje, že odpoveď je validný JSON podľa schémy
function firstJSON(data) {
  const text = (data.content ?? []).find(b => b.type === "text")?.text ?? "";
  return JSON.parse(text);
}

async function resizeImage(file, maxPx = 1024) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataURL = canvas.toDataURL("image/jpeg", 0.85);
      resolve({ base64: dataURL.split(",")[1], mimeType: "image/jpeg" });
    };
    img.onerror = () => reject(new Error("Nepodarilo sa načítať obrázok."));
    img.src = url;
  });
}

const SCAN_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          qty: { type: "string" },
          category: { type: "string", enum: CATEGORIES },
        },
        required: ["text", "qty", "category"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

async function scanImage(mimeType, base64Data) {
  const system = `Si expertný čítač slovenských nákupných zoznamov (tlačených aj písaných rukou).
PRAVIDLÁ:
1. Prečítaj text v obrázku doslovne — neupravuj, nevymýšľaj, nepridávaj položky ktoré tam nie sú
2. Ignoruj prečiarknuté položky
3. Množstvo a jednotku ("2x", "1 L", "500 g") daj do poľa "qty"; v poli "text" nechaj iba názov položky. Ak množstvo nie je uvedené, "qty" nechaj prázdne
4. Jednoslovné skratky dokonči len ak je to jednoznačné (napr. "toaletný" → "toaletný papier")
5. Každej položke prirad najpresnejšiu kategóriu zo zoznamu povolených hodnôt.
   Rozhoduje oddelenie v obchode, nie surovina: mrazená zelenina patrí do „Mrazené",
   saláma a šunka do „Údeniny a šunka", čokoláda do „Sladkosti", chipsy do „Slané snacky",
   pivo a víno do „Alkohol", mlieko a syry do „Mlieko, syry, maslo", jogurt do „Jogurty a dezerty".
   „Iné" použi len vtedy, keď sa položka naozaj nikam nehodí`;

  const data = await callAnthropic({
    model: SCAN_MODEL,
    max_tokens: 8000,
    system,
    output_config: { effort: "medium", format: { type: "json_schema", schema: SCAN_SCHEMA } },
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mimeType, data: base64Data } },
        { type: "text", text: "Extrahuj položky z tohto nákupného zoznamu." },
      ],
    }],
  });

  if (data.stop_reason === "max_tokens") {
    throw new Error("Zoznam je príliš dlhý — skús odfotiť menšiu časť.");
  }
  const parsed = firstJSON(data);
  return (parsed.items ?? []).filter(i => i.text && CATEGORIES.includes(i.category));
}

const PARSE_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          source: { type: "integer" },
          text: { type: "string" },
          qty: { type: "string" },
          category: { type: "string", enum: CATEGORIES },
        },
        required: ["source", "text", "qty", "category"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

// Dostane očíslované riadky tak, ako ich človek napísal alebo nadiktoval,
// a vráti položky v základnom tvare s množstvom a kategóriou. Jeden riadok
// sa môže rozpadnúť na viac položiek (nadiktované „rožky maslo a dve mlieka").
async function parseItems(lines) {
  const data = await callAnthropic({
    model: CATEGORIZE_MODEL,
    max_tokens: 2048,
    system: `Dostaneš očíslované riadky, ktoré človek napísal alebo nadiktoval do nákupného zoznamu.
Pre každú položku vráť:
- source: číslo riadku, z ktorého pochádza
- text: názov v základnom tvare (1. pád), s veľkým začiatočným písmenom, bez množstva — „6 vajec" → „Vajcia", „dve mlieka" → „Mlieko", „kúp chlieb" → „Chlieb"
- qty: množstvo číslicami s jednotkou („2x", „1 L", „500 g", „20 dkg"); počet kusov ako „6x"; ak množstvo nie je uvedené, nechaj prázdne
- category: najpresnejšia kategória zo zoznamu povolených hodnôt

Ak riadok obsahuje viac vecí (napr. „rožky maslo a dve mlieka"), rozdeľ ho na samostatné položky s rovnakým source. Viacslovný názov jednej veci nedeľ („kuracie prsia", „mrazený hrášok"). Nič nepridávaj ani nevymýšľaj a nemeň položku na inú vec.

Pri kategórii rozhoduje oddelenie v obchode, nie surovina: mrazená zelenina patrí do „Mrazené",
saláma a šunka do „Údeniny a šunka", čokoláda do „Sladkosti", chipsy do „Slané snacky",
pivo a víno do „Alkohol", mlieko a syry do „Mlieko, syry, maslo", jogurt do „Jogurty a dezerty".
„Iné" použi len vtedy, keď sa položka naozaj nikam nehodí.`,
    output_config: { format: { type: "json_schema", schema: PARSE_SCHEMA } },
    messages: [{ role: "user", content: lines.map((line, i) => `${i}: ${line}`).join("\n") }],
  });
  if (data.stop_reason === "max_tokens") throw new Error("Zadanie je príliš dlhé — skús ho rozdeliť.");
  return (firstJSON(data).items ?? [])
    .filter(it => Number.isInteger(it.source) && it.source >= 0 && it.source < lines.length && it.text?.trim())
    .map(it => ({
      source: it.source,
      text: it.text.trim(),
      qty: (it.qty ?? "").trim(),
      category: CATEGORIES.includes(it.category) ? it.category : "Iné",
    }));
}

// ── Synchronizácia zoznamu a nastavení cez Worker ────────────────
// settingsSince: najnovšia verzia nastavení, ktorú už mobil má — server
// pošle len tie, čo sa odvtedy zmenili.

async function fetchList(settingsSince = 0) {
  const base = workerBase();
  if (!base) return null;
  const res = await fetch(`${base}/list?settingsSince=${settingsSince}`, { headers: { "x-app-token": appToken() } });
  if (res.status === 501) return null; // worker nemá nabindované KV
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Novší worker vráti už zlúčený zoznam aj nastavenia (so zmenami z druhého
// mobilu), starší len { ok: true } — vtedy vráti null.
async function putList(items, settings, settingsSince, { keepalive = false } = {}) {
  const base = workerBase();
  if (!base) return null;
  const res = await fetch(`${base}/list?settingsSince=${settingsSince}`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-app-token": appToken() },
    body: JSON.stringify({ items, settings, deviceId: deviceId(), updatedAt: Date.now() }),
    keepalive,
  });
  if (res.status === 501) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json().catch(() => null);
  return Array.isArray(data?.items) ? data : null;
}

function normalizeItem(item) {
  const category = migrateCategory(item.category);
  return {
    id: item.id ?? crypto.randomUUID(),
    text: item.text ?? "",
    qty: item.qty ?? "",
    completed: !!item.completed,
    category: CATEGORIES.includes(category) ? category : "Iné",
    createdAt: item.createdAt ?? item.updatedAt ?? 0,
    updatedAt: item.updatedAt ?? 0,
    deleted: !!item.deleted,
  };
}

// Poradie musí vyjsť rovnako na každom zariadení, inak si dva mobily
// donekonečna prepisujú zoznam len kvôli inému poradiu tých istých položiek.
function sortItems(items) {
  return [...items].sort((a, b) =>
    (b.createdAt - a.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// Zlúčenie dvoch zoznamov: pri rovnakom id vyhráva novšia zmena.
function mergeLists(local, remote) {
  const byId = new Map();
  [...local, ...remote].forEach(raw => {
    const item = normalizeItem(raw);
    const prev = byId.get(item.id);
    if (!prev || item.updatedAt > prev.updatedAt) byId.set(item.id, item);
  });
  const cutoff = Date.now() - TOMBSTONE_MS;
  return sortItems([...byId.values()].filter(it => !(it.deleted && it.updatedAt < cutoff)));
}

// ── Upozornenia (Web Push) ───────────────────────────────────────

const pushSupported = () =>
  "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function b64urlToUint8(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

async function workerPost(path, body) {
  const res = await fetch(`${workerBase()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-app-token": appToken() },
    body: JSON.stringify(body),
  });
  if (res.status === 501) throw new Error("Worker nemá pripojenú D1 databázu — upozornenia bez nej nefungujú.");
  if (!res.ok) throw new Error(`Worker odpovedal chybou ${res.status}.`);
}

async function enablePush() {
  if (Notification.permission !== "granted" && (await Notification.requestPermission()) !== "granted") {
    throw new Error("Upozornenia sú zablokované — povoľ ich v nastaveniach prehliadača pre túto stránku.");
  }
  const res = await fetch(`${workerBase()}/push/key`, { headers: { "x-app-token": appToken() } });
  if (res.status === 501) throw new Error("Worker nemá pripojenú D1 databázu — upozornenia bez nej nefungujú.");
  if (res.status === 404 || res.status === 405) throw new Error("Worker je starší — nahraj doň nový cloudflare-worker.js.");
  if (!res.ok) throw new Error(`Worker odpovedal chybou ${res.status}.`);
  const { publicKey } = await res.json();
  const reg = await navigator.serviceWorker.ready;
  const key = b64urlToUint8(publicKey);
  let sub = await reg.pushManager.getSubscription();
  // Staré prihlásenie s iným kľúčom (napr. z pripomienok) treba najprv zrušiť.
  const sameKey = sub?.options?.applicationServerKey &&
    new Uint8Array(sub.options.applicationServerKey).every((b, i) => b === key[i]);
  if (sub && !sameKey) { await sub.unsubscribe(); sub = null; }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await workerPost("/push/subscribe", { subscription: sub.toJSON(), deviceId: deviceId() });
}

async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  await workerPost("/push/unsubscribe", { endpoint: sub?.endpoint ?? "", deviceId: deviceId() }).catch(() => {});
  await sub?.unsubscribe();
}

// ── Components ───────────────────────────────────────────────────

function SettingsModal({ catOrder, onMoveCategory, onSave, onClose, push, onTogglePush }) {
  const [proxy, setProxy] = useState(() => localStorage.getItem(PROXY_KEY) ?? "");
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) ?? "");
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: "1rem" }}>
      <div style={{ background: "#fff", borderRadius: "1rem", padding: "1.5rem", maxWidth: 440, width: "100%", maxHeight: "88vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
        <h2 style={{ fontSize: "1.125rem", fontWeight: 700, marginBottom: "1rem", color: "#1e293b" }}>Nastavenia</h2>

        <p style={{ fontSize: "0.78rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>URL Cloudflare Workera</p>
        <p style={{ fontSize: "0.75rem", color: "#64748b", marginBottom: "6px", lineHeight: 1.5 }}>
          Worker drží Anthropic kľúč a synchronizuje zoznam. Postup je v súbore <strong>cloudflare-worker.js</strong> v repozitári.
        </p>
        <input
          type="url"
          value={proxy}
          onChange={e => setProxy(e.target.value)}
          placeholder="https://moj-worker.username.workers.dev"
          style={{ width: "100%", border: "1.5px solid #e2e8f0", borderRadius: "0.5rem", padding: "0.6rem 0.8rem", fontSize: "0.875rem", outline: "none", marginBottom: "1rem", boxSizing: "border-box" }}
          autoFocus
        />

        <p style={{ fontSize: "0.78rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>Prístupový token</p>
        <p style={{ fontSize: "0.75rem", color: "#64748b", marginBottom: "6px", lineHeight: 1.5 }}>
          To isté heslo, aké má Worker v premennej <code>APP_TOKEN</code>.
        </p>
        <input
          type="password"
          value={token}
          onChange={e => setToken(e.target.value)}
          placeholder="heslo z APP_TOKEN"
          style={{ width: "100%", border: "1.5px solid #e2e8f0", borderRadius: "0.5rem", padding: "0.6rem 0.8rem", fontSize: "0.875rem", outline: "none", marginBottom: "1.25rem", boxSizing: "border-box" }}
        />

        <p style={{ fontSize: "0.78rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>Upozornenia</p>
        <p style={{ fontSize: "0.75rem", color: "#64748b", marginBottom: "8px", lineHeight: 1.5 }}>
          {push.state === "unsupported"
            ? "Tento prehliadač upozornenia nevie. Na iPhone pridaj appku na plochu (Safari → Zdieľať → Pridať na plochu) a zapni ich z nej."
            : "Keď na inom mobile niekto pridá položku, tento mobil ukáže upozornenie — aj keď je appka zatvorená. Zapína sa na každom mobile zvlášť."}
        </p>
        {push.state !== "unsupported" && (
          <button onClick={onTogglePush} disabled={push.state === "busy" || !push.configured}
            style={{
              width: "100%", marginBottom: push.error ? "6px" : "1.25rem", padding: "0.6rem", borderRadius: "0.5rem",
              fontSize: "0.85rem", fontWeight: 600, cursor: push.state === "busy" || !push.configured ? "not-allowed" : "pointer",
              border: "1px solid", opacity: push.configured ? 1 : 0.5,
              ...(push.state === "on"
                ? { background: "#ecfdf5", borderColor: "#a7f3d0", color: "#047857" }
                : { background: "#eef2ff", borderColor: "#c7d2fe", color: "#4338ca" }),
            }}>
            {!push.configured ? "Najprv ulož URL Workera a token"
              : push.state === "busy" ? "Chvíľu…"
              : push.state === "on" ? "✓ Zapnuté na tomto mobile — vypnúť"
              : "Zapnúť upozornenia"}
          </button>
        )}
        {push.error && <p style={{ fontSize: "0.75rem", color: "#be123c", marginBottom: "1.25rem", lineHeight: 1.5 }}>{push.error}</p>}

        <p style={{ fontSize: "0.78rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>Poradie kategórií</p>
        <p style={{ fontSize: "0.75rem", color: "#64748b", marginBottom: "8px", lineHeight: 1.5 }}>
          Zoraď ich tak, ako chodíš obchodom.
        </p>
        <div style={{ border: "1px solid #e2e8f0", borderRadius: "0.5rem", marginBottom: "1.25rem", maxHeight: 260, overflowY: "auto" }}>
          {catOrder.map((cat, i) => (
            <div key={cat} style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.35rem 0.5rem 0.35rem 0.7rem", borderBottom: i < catOrder.length - 1 ? "1px solid #f1f5f9" : "none" }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: CATEGORY_STYLES[cat]?.dot ?? "#94a3b8", flexShrink: 0 }} />
              <span style={{ flex: 1, fontSize: "0.8rem", color: "#1e293b" }}>{cat}</span>
              <button onClick={() => onMoveCategory(i, -1)} disabled={i === 0} title="Vyššie"
                style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 6, width: 26, height: 24, cursor: i === 0 ? "not-allowed" : "pointer", opacity: i === 0 ? 0.4 : 1, color: "#475569" }}>▲</button>
              <button onClick={() => onMoveCategory(i, 1)} disabled={i === catOrder.length - 1} title="Nižšie"
                style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 6, width: 26, height: 24, cursor: i === catOrder.length - 1 ? "not-allowed" : "pointer", opacity: i === catOrder.length - 1 ? 0.4 : 1, color: "#475569" }}>▼</button>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button
            onClick={onClose}
            style={{ flex: 1, background: "#f8fafc", color: "#475569", border: "1px solid #e2e8f0", borderRadius: "0.5rem", padding: "0.65rem", fontWeight: 600, fontSize: "0.9rem", cursor: "pointer" }}
          >
            Zavrieť
          </button>
          <button
            onClick={() => onSave(proxy.trim(), token.trim())}
            style={{ flex: 2, background: "#4f46e5", color: "#fff", border: "none", borderRadius: "0.5rem", padding: "0.65rem", fontWeight: 600, fontSize: "0.9rem", cursor: "pointer" }}
          >
            Uložiť
          </button>
        </div>
      </div>
    </div>
  );
}

function TodoRow({ todo, onToggle, onDelete, onChangeCategory, onEdit, showCategory, flash }) {
  const style = CATEGORY_STYLES[todo.category] ?? CATEGORY_STYLES["Iné"];
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(todo.text);
  const [qty, setQty] = useState(todo.qty ?? "");

  const startEdit = () => {
    setText(todo.text);
    setQty(todo.qty ?? "");
    setEditing(true);
  };

  const commit = () => {
    setEditing(false);
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed !== todo.text || qty.trim() !== (todo.qty ?? "")) onEdit(todo.id, trimmed, qty.trim());
  };

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: "0.625rem",
      padding: "0.6rem 0.875rem", borderRadius: "0.75rem", border: "1px solid",
      borderColor: flash ? "#fcd34d" : todo.completed ? "#bbf7d0" : "#f1f5f9",
      background: flash ? "#fffbeb" : todo.completed ? "rgba(240,253,244,0.7)" : "#fff",
      boxShadow: todo.completed ? "none" : "0 1px 3px rgba(0,0,0,0.06)",
      transition: "all 0.15s",
    }}>
      <button onClick={() => onToggle(todo.id)} title={todo.completed ? "Vrátiť do zoznamu" : "Mám v košíku"} style={{
        width: 22, height: 22, borderRadius: "50%", border: "2px solid",
        borderColor: todo.completed ? "#22c55e" : "#cbd5e1",
        background: todo.completed ? "#22c55e" : "#fff",
        color: "#fff", cursor: "pointer", flexShrink: 0,
        display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.15s",
      }}>
        {todo.completed && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>}
      </button>

      {editing ? (
        <>
          <input
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
            autoFocus
            style={{ flex: 1, minWidth: 0, border: "1.5px solid #c7d2fe", borderRadius: 6, padding: "0.25rem 0.4rem", fontSize: "0.75rem", outline: "none", color: "#1e293b" }}
          />
          <input
            value={qty}
            onChange={e => setQty(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
            placeholder="množstvo"
            style={{ width: 70, flexShrink: 0, border: "1.5px solid #c7d2fe", borderRadius: 6, padding: "0.25rem 0.4rem", fontSize: "0.7rem", outline: "none", color: "#1e293b" }}
          />
          <button onClick={commit} title="Uložiť" style={{ background: "#4f46e5", color: "#fff", border: "none", borderRadius: 6, padding: "3px 8px", fontSize: "0.7rem", fontWeight: 600, cursor: "pointer", flexShrink: 0 }}>OK</button>
        </>
      ) : (
        <>
          <span
            onClick={startEdit}
            title="Klikni pre úpravu"
            style={{
              flex: 1, fontSize: "0.75rem", lineHeight: 1.4, cursor: "text", minWidth: 0,
              color: todo.completed ? "#94a3b8" : "#1e293b",
              textDecoration: todo.completed ? "line-through" : "none",
            }}
          >
            {todo.qty ? (
              <span style={{
                display: "inline-block", marginRight: 6, padding: "1px 5px", borderRadius: 4,
                background: todo.completed ? "#f1f5f9" : "#eef2ff", color: todo.completed ? "#94a3b8" : "#4338ca",
                fontSize: "0.65rem", fontWeight: 700,
              }}>{todo.qty}</span>
            ) : null}
            {todo.text}
          </span>

          {showCategory && (
            <label style={{
              position: "relative", display: "inline-flex", alignItems: "center", gap: 3,
              fontSize: "0.6rem", fontWeight: 600, padding: "2px 7px", borderRadius: 999,
              border: "1px solid", borderColor: style.chip.border,
              background: style.chip.bg, color: style.chip.color,
              cursor: "pointer", flexShrink: 0, opacity: todo.completed ? 0.6 : 1,
              whiteSpace: "nowrap",
            }}>
              <span style={{ width: 5, height: 5, borderRadius: "50%", background: style.dot, flexShrink: 0 }} />
              <span>{todo.category}</span>
              <select
                value={todo.category}
                onChange={e => onChangeCategory(todo.id, e.target.value)}
                style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer", width: "100%", height: "100%" }}
              >
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
          )}

          <button onClick={() => onDelete(todo.id)} title="Odstrániť" style={{
            background: "none", border: "none", cursor: "pointer",
            color: "#cbd5e1", padding: "2px", borderRadius: 4, flexShrink: 0,
            display: "flex", alignItems: "center",
          }}
            onMouseEnter={e => e.currentTarget.style.color = "#f43f5e"}
            onMouseLeave={e => e.currentTarget.style.color = "#cbd5e1"}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </>
      )}
    </div>
  );
}

// ── Main App ─────────────────────────────────────────────────────

export default function App() {
  const [todos, setTodos] = useState([]);
  const [settings, setSettings] = useState({});
  const [hydrated, setHydrated] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [input, setInput] = useState("");
  const [isScanning, setIsScanning] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);
  const [notice, setNotice] = useState(null);
  const [flashId, setFlashId] = useState(null);
  const [undoState, setUndoState] = useState(null);
  const [sortByCategory, setSortByCategory] = useState(true);
  const [syncState, setSyncState] = useState("off"); // off | syncing | ok | error
  const [listening, setListening] = useState(false);
  const [pushState, setPushState] = useState("off"); // unsupported | off | on | busy
  const [pushError, setPushError] = useState(null);

  const undoTimer = useRef(null);
  const noticeTimer = useRef(null);
  const flashTimer = useRef(null);
  const pushTimer = useRef(null);
  const cameraRef = useRef(null);
  const galleryRef = useRef(null);
  const todosRef = useRef([]);
  const lastSyncedRef = useRef("");
  const settingsRef = useRef({});
  const dirtySettingsRef = useRef(new Set()); // kľúče, ktoré ešte neodišli na server
  const settingsVersionRef = useRef(0);
  // Starší worker nastavenia nepozná; kým to nevieme, skúšame ich posielať.
  const serverKeepsSettingsRef = useRef(true);
  const recognitionRef = useRef(null);
  // Kým AI dolaďuje práve pridané položky, so synchronizáciou chvíľu počkáme —
  // druhý mobil tak dostane jedno upozornenie s hotovými názvami, nie dve.
  const aiPendingRef = useRef({ count: 0, since: 0 });

  useEffect(() => { todosRef.current = todos; }, [todos]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  // Odvodené z nastavení: naučené kategórie, história nákupov, poradie uličiek
  const prefs = useMemo(() => {
    const out = {};
    Object.entries(pickSettings(settings, "pref:")).forEach(([key, value]) => {
      const category = migrateCategory(value);
      if (CATEGORIES.includes(category)) out[key] = category;
    });
    return out;
  }, [settings]);
  const history = useMemo(() => pickSettings(settings, "hist:"), [settings]);
  const catOrderSetting = settings.catOrder?.value;
  const catOrder = useMemo(
    () => mergeCatOrder(Array.isArray(catOrderSetting) ? catOrderSetting : CATEGORIES),
    [catOrderSetting]);

  const persistSettings = (next) => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* plné úložisko */ }
  };
  const persistDirty = () => {
    localStorage.setItem(SETTINGS_DIRTY_KEY, JSON.stringify([...dirtySettingsRef.current]));
  };

  // Zapíše zmenené nastavenia a označí ich na odoslanie druhému mobilu.
  const writeSettings = useCallback((changes) => {
    const now = Date.now();
    const next = { ...settingsRef.current };
    Object.entries(changes).forEach(([key, value]) => {
      next[key] = { value, updatedAt: now };
      dirtySettingsRef.current.add(key);
    });
    settingsRef.current = next;
    setSettings(next);
    persistSettings(next);
    persistDirty();
  }, []);

  // Každé pridanie položky sa zapíše do histórie — z nej sú ponuky „Často kupuješ".
  const recordHistory = useCallback((items) => {
    const changes = {};
    items.forEach(item => {
      const key = normalize(item.text);
      if (!key) return;
      const prev = changes[`hist:${key}`] ?? settingsRef.current[`hist:${key}`]?.value;
      changes[`hist:${key}`] = {
        text: item.text, category: item.category,
        count: (prev?.count ?? 0) + 1, lastAt: Date.now(),
      };
    });
    if (Object.keys(changes).length) writeSettings(changes);
  }, [writeSettings]);

  useEffect(() => {
    // Kľúč sa kedysi držal v prehliadači; teraz žije vo Workeri, tak ho odtiaľto zmažeme.
    localStorage.removeItem(LEGACY_APIKEY_KEY);

    const storedTodos = sortItems(loadJSON(STORAGE_KEY, []).map(normalizeItem));
    setTodos(storedTodos);
    const storedSortMode = localStorage.getItem(SORT_MODE_KEY);
    if (storedSortMode !== null) setSortByCategory(storedSortMode === "true");

    let stored = loadJSON(SETTINGS_KEY, null);
    const dirty = new Set(loadJSON(SETTINGS_DIRTY_KEY, []));
    if (!stored || typeof stored !== "object") {
      // Prvé spustenie tejto verzie: naučené kategórie a poradie uličiek boli
      // len v tomto mobile. Čas 1 = pošli ich na server, ale novšie tam vyhrá.
      stored = {};
      Object.entries(migratePrefs(loadJSON(PREFS_KEY, {}))).forEach(([key, category]) => {
        stored[`pref:${key}`] = { value: category, updatedAt: 1 };
      });
      const oldOrder = loadJSON(CAT_ORDER_KEY, null);
      if (Array.isArray(oldOrder)) stored.catOrder = { value: mergeCatOrder(oldOrder), updatedAt: 1 };
      Object.keys(stored).forEach(key => dirty.add(key));
    }
    if (!localStorage.getItem(HISTORY_SEEDED_KEY)) {
      // Históriu naplníme z toho, čo už v zozname je alebo bolo za posledný týždeň.
      storedTodos.forEach(item => {
        const key = normalize(item.text);
        if (!key) return;
        const prev = stored[`hist:${key}`]?.value;
        stored[`hist:${key}`] = {
          value: { text: item.text, category: item.category, count: (prev?.count ?? 0) + 1, lastAt: Math.max(prev?.lastAt ?? 0, item.createdAt) },
          updatedAt: 1,
        };
        dirty.add(`hist:${key}`);
      });
      localStorage.setItem(HISTORY_SEEDED_KEY, "1");
    }
    dirtySettingsRef.current = dirty;
    settingsRef.current = stored;
    setSettings(stored);
    persistSettings(stored);
    persistDirty();

    setConfigured(!!workerBase());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
  }, [todos, hydrated]);

  const showNotice = useCallback((msg) => {
    setNotice(msg);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3000);
  }, []);

  const flashItem = useCallback((id) => {
    setFlashId(id);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashId(null), 1500);
  }, []);

  // ── Synchronizácia ─────────────────────────────────────────────
  // Zoznam a nastavenia zo servera zlúčime s lokálnymi a zapamätáme si, čo server má.
  const adoptRemote = useCallback((remote) => {
    const remoteItems = Array.isArray(remote.items) ? remote.items : [];
    const merged = mergeLists(todosRef.current, remoteItems);
    if (JSON.stringify(merged) !== JSON.stringify(todosRef.current)) setTodos(merged);
    lastSyncedRef.current = JSON.stringify(sortItems(remoteItems.map(normalizeItem)));

    if (remote.settings && typeof remote.settings === "object") {
      const next = mergeSettings(settingsRef.current, remote.settings);
      if (next !== settingsRef.current) {
        settingsRef.current = next;
        setSettings(next);
        persistSettings(next);
      }
    }
    if (Number.isFinite(remote.settingsVersion)) {
      settingsVersionRef.current = Math.max(settingsVersionRef.current, remote.settingsVersion);
    }
  }, []);

  const pull = useCallback(async () => {
    if (!workerBase()) return;
    try {
      const remote = await fetchList(settingsVersionRef.current);
      if (!remote) { setSyncState("off"); return; }
      adoptRemote(remote);
      setSyncState("ok");
    } catch {
      setSyncState("error");
    }
  }, [adoptRemote]);

  const push = useCallback(async (opts) => {
    if (!workerBase()) return;
    const items = todosRef.current;
    const payload = JSON.stringify(items);
    const sent = {};
    dirtySettingsRef.current.forEach(key => {
      if (settingsRef.current[key]) sent[key] = settingsRef.current[key];
    });
    const hasSettings = Object.keys(sent).length > 0;
    if (payload === lastSyncedRef.current && !(hasSettings && serverKeepsSettingsRef.current)) return;
    const ai = aiPendingRef.current;
    if (ai.count > 0 && !opts?.keepalive && Date.now() - ai.since < 8000) return;
    setSyncState("syncing");
    try {
      const remote = await putList(items, hasSettings ? sent : undefined, settingsVersionRef.current, opts);
      // Odoslané nastavenia už nie sú „na odoslanie" — ale len keď ich server naozaj
      // uložil (starší worker ich zahodí) a medzitým sa znova nezmenili.
      serverKeepsSettingsRef.current = Number.isFinite(remote?.settingsVersion);
      if (serverKeepsSettingsRef.current) {
        Object.entries(sent).forEach(([key, entry]) => {
          if (settingsRef.current[key]?.updatedAt === entry.updatedAt) dirtySettingsRef.current.delete(key);
        });
        persistDirty();
      }
      if (remote) adoptRemote(remote);
      else lastSyncedRef.current = payload;
      setSyncState("ok");
    } catch {
      setSyncState("error");
    }
  }, [adoptRemote]);

  // Po stiahnutí skúsime aj odoslať — inak by zmena spravená offline ležala
  // v mobile dovtedy, kým sa zoznamu znova nedotkneš. Pri pomalej sieti
  // sa dopyty nenavrstvujú: kým jeden beží, ďalší sa preskočí.
  const pushRef = useRef(push);
  pushRef.current = push;

  const syncing = useRef(false);
  const syncNow = useCallback(async () => {
    if (syncing.current) return;
    syncing.current = true;
    try { await pull(); await push(); } finally { syncing.current = false; }
  }, [pull, push]);

  useEffect(() => {
    if (!hydrated || !configured) return;
    syncNow();
    const iv = setInterval(() => { if (document.visibilityState === "visible") syncNow(); }, POLL_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") { syncNow(); return; }
      // Mobil sa zamyká / appka ide do pozadia: neodoslanú zmenu pošli hneď,
      // keepalive ju dokončí, aj keď prehliadač stránku uspí.
      clearTimeout(pushTimer.current);
      push({ keepalive: true });
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", syncNow);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", syncNow);
    };
  }, [hydrated, configured, syncNow, push]);

  // Service worker dal vedieť, že prišlo upozornenie — stiahni zoznam hneď.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (e) => { if (e.data?.type === "sync") syncNow(); };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [syncNow]);

  // Sú upozornenia na tomto mobile zapnuté? Ak áno, pripomeň to workeru
  // (mohol prihlásenie zabudnúť, napr. po výmene databázy).
  useEffect(() => {
    if (!hydrated) return;
    if (!pushSupported()) { setPushState("unsupported"); return; }
    if (!configured) return;
    let cancelled = false;
    navigator.serviceWorker.ready
      .then(reg => reg.pushManager.getSubscription())
      .then(sub => {
        if (cancelled) return;
        const on = !!sub && Notification.permission === "granted";
        setPushState(on ? "on" : "off");
        if (on) workerPost("/push/subscribe", { subscription: sub.toJSON(), deviceId: deviceId() }).catch(() => {});
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [hydrated, configured]);

  const togglePush = async () => {
    const wasOn = pushState === "on";
    setPushState("busy");
    setPushError(null);
    try {
      if (wasOn) { await disablePush(); setPushState("off"); }
      else { await enablePush(); setPushState("on"); }
    } catch (err) {
      setPushError(err.message ?? "Upozornenia sa nepodarilo zapnúť.");
      setPushState(wasOn ? "on" : "off");
    }
  };

  useEffect(() => {
    if (!hydrated || !configured) return;
    clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(push, PUSH_DELAY_MS);
    return () => clearTimeout(pushTimer.current);
  }, [todos, settings, hydrated, configured, push]);

  // ── Nastavenia ─────────────────────────────────────────────────
  const saveSettings = (proxyUrl, token) => {
    if (proxyUrl) localStorage.setItem(PROXY_KEY, proxyUrl);
    else localStorage.removeItem(PROXY_KEY);
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
    setConfigured(!!workerBase());
    setShowSettings(false);
    setErrorMsg(null);
  };

  const moveCategory = (index, dir) => {
    const target = index + dir;
    if (target < 0 || target >= catOrder.length) return;
    const next = [...catOrder];
    [next[index], next[target]] = [next[target], next[index]];
    writeSettings({ catOrder: next });
  };

  // ── Operácie so zoznamom ───────────────────────────────────────
  const triggerUndo = useCallback((message, ids) => {
    setUndoState({ message, ids });
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndoState(null), 6000);
  }, []);

  const performUndo = () => {
    if (!undoState) return;
    const ids = new Set(undoState.ids);
    setTodos(prev => prev.map(t => ids.has(t.id) ? { ...t, deleted: false, updatedAt: Date.now() } : t));
    setUndoState(null);
    clearTimeout(undoTimer.current);
  };

  const findActiveDuplicate = (text) => {
    const key = normalize(text);
    if (!key) return null;
    return todosRef.current.find(t => !t.deleted && normalize(t.text) === key) ?? null;
  };

  // Položka, ktorá už v zozname je: zablikne, a ak bola kúpená, vráti sa späť.
  const bringBack = (duplicate) => {
    flashItem(duplicate.id);
    showNotice(`„${duplicate.text}" už v zozname je.`);
    if (duplicate.completed) {
      setTodos(prev => prev.map(t => t.id === duplicate.id ? { ...t, completed: false, updatedAt: Date.now() } : t));
    }
  };

  // Pridá napísaný alebo nadiktovaný text: rozdelí ho na položky, vytiahne
  // množstvá a hneď ich ukáže. Položky, ktoré appka ešte nepozná, potom opraví AI
  // (základný tvar, množstvo, kategória, rozdelenie nadiktovaného textu).
  const addText = async (raw, { voice = false } = {}) => {
    const entries = splitInput(raw, { voice });
    if (!entries.length) return;
    setInput("");

    const now = Date.now();
    const fresh = [];
    const taken = new Set(todosRef.current.filter(t => !t.deleted).map(t => normalize(t.text)));
    let duplicate = null;
    entries.forEach(entry => {
      const key = normalize(entry.text);
      if (!key) return;
      if (taken.has(key)) { duplicate ??= findActiveDuplicate(entry.text); return; }
      taken.add(key);
      const known = prefs[key] ?? history[key]?.category;
      const item = normalizeItem({
        id: crypto.randomUUID(), text: entry.text, qty: entry.qty,
        category: known ?? "Iné", createdAt: now, updatedAt: now,
      });
      // Známu položku netreba posielať AI — pokiaľ nejde o diktovanie, ktoré treba rozdeliť.
      fresh.push({ item, raw: entry.raw, known: !!prefs[key] && !voice });
    });
    if (duplicate) bringBack(duplicate);
    if (!fresh.length) return;
    setTodos(prev => sortItems([...fresh.map(f => f.item), ...prev]));

    const unknown = fresh.filter(f => !f.known);
    recordHistory(fresh.filter(f => f.known).map(f => f.item));
    if (!unknown.length) return;
    if (!configured) { recordHistory(unknown.map(f => f.item)); return; }

    let parsed;
    const ai = aiPendingRef.current;
    if (!ai.count) ai.since = Date.now();
    ai.count++;
    try {
      parsed = await parseItems(unknown.map(f => f.raw));
    } catch (err) {
      recordHistory(unknown.map(f => f.item));
      setErrorMsg(err.message ?? "Kategorizácia zlyhala.");
      return;
    } finally {
      ai.count--;
      // Odložené odoslanie teraz dobehne (aj keď AI nič nezmenila).
      clearTimeout(pushTimer.current);
      pushTimer.current = setTimeout(() => pushRef.current(), PUSH_DELAY_MS);
    }

    // Náhrady spočítame vopred, aby sme ich poznali aj pre históriu.
    const snapshot = todosRef.current;
    const provisional = new Set(unknown.map(f => f.item.id));
    const takenKeys = new Set(snapshot.filter(t => !t.deleted && !provisional.has(t.id)).map(t => normalize(t.text)));
    const plans = [];
    unknown.forEach((f, source) => {
      const results = parsed.filter(r => r.source === source);
      if (!results.length) { takenKeys.add(normalize(f.item.text)); return; }
      const replacement = [];
      results.forEach(r => {
        const key = normalize(r.text);
        if (!key || takenKeys.has(key)) return;
        takenKeys.add(key);
        replacement.push(normalizeItem({
          ...f.item,
          id: replacement.length ? crypto.randomUUID() : f.item.id,
          text: r.text,
          qty: r.qty || (results.length === 1 ? f.item.qty : ""),
          category: prefs[key] ?? r.category,
          updatedAt: Date.now(),
        }));
      });
      plans.push({ original: f.item, replacement });
    });

    setTodos(prev => {
      let next = prev;
      plans.forEach(({ original, replacement }) => {
        const current = next.find(t => t.id === original.id);
        // Medzitým ju niekto upravil, odškrtol alebo zmazal — nechaj ju tak.
        if (!current || current.updatedAt !== original.updatedAt || current.deleted || current.completed) return;
        next = next.filter(t => t.id !== original.id);
        // Pôvodnú položku zmazať náhrobkom (nie len vyhodiť), aby sa nevrátila zo servera.
        if (replacement[0]?.id !== original.id) next.push({ ...current, deleted: true, updatedAt: Date.now() });
        next = [...replacement, ...next];
      });
      return next === prev ? prev : sortItems(next);
    });
    const unchanged = unknown.filter(f => !plans.some(p => p.original.id === f.item.id)).map(f => f.item);
    recordHistory([...plans.flatMap(p => p.replacement), ...unchanged]);
  };

  const addOne = () => addText(input);

  // Ťuk na ponuku: položka s kategóriou, ktorú appka už pozná — bez volania AI.
  const addSuggestion = (entry) => {
    const duplicate = findActiveDuplicate(entry.text);
    const rest = input.split(/;|\n|(?<!\d),|,(?!\d)/).slice(0, -1).join(", ");
    setInput(rest ? `${rest}, ` : "");
    if (duplicate) { bringBack(duplicate); return; }
    const now = Date.now();
    const item = normalizeItem({
      id: crypto.randomUUID(), text: entry.text,
      category: prefs[normalize(entry.text)] ?? entry.category ?? "Iné", createdAt: now, updatedAt: now,
    });
    setTodos(prev => sortItems([item, ...prev]));
    recordHistory([item]);
  };

  // ── Diktovanie (Web Speech API, slovenčina) ─────────────────────
  const addTextRef = useRef(addText);
  addTextRef.current = addText;
  const toggleVoice = () => {
    if (recognitionRef.current) { recognitionRef.current.stop(); return; }
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) return;
    const recognition = new Recognition();
    recognition.lang = "sk-SK";
    recognition.interimResults = true;
    recognition.continuous = false;
    const typed = input.trim();
    let heard = "";
    recognition.onresult = (e) => {
      let interim = "";
      heard = "";
      for (const result of e.results) {
        if (result.isFinal) heard += result[0].transcript;
        else interim += result[0].transcript;
      }
      setInput([typed, (heard + interim).trim()].filter(Boolean).join(", "));
    };
    recognition.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setErrorMsg("Appka nemá prístup k mikrofónu — povoľ ho v nastaveniach prehliadača.");
      } else if (e.error !== "no-speech" && e.error !== "aborted") {
        setErrorMsg(`Diktovanie zlyhalo (${e.error}).`);
      }
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setListening(false);
      const text = [typed, heard.trim()].filter(Boolean).join(", ");
      if (heard.trim()) addTextRef.current(text, { voice: true });
      else setInput(typed);
    };
    recognitionRef.current = recognition;
    setListening(true);
    setErrorMsg(null);
    recognition.start();
  };

  const toggleSortByCategory = () => {
    setSortByCategory(prev => {
      const next = !prev;
      localStorage.setItem(SORT_MODE_KEY, String(next));
      return next;
    });
  };

  const handleImage = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!workerBase()) { setShowSettings(true); return; }
    setIsScanning(true);
    setErrorMsg(null);
    try {
      const { base64: base64Data, mimeType } = await resizeImage(file, 1600);
      const items = await scanImage(mimeType, base64Data);
      if (!items.length) { setErrorMsg("Na obrázku som nenašiel žiadne položky."); return; }

      const fresh = [];
      let skipped = 0;
      const seen = new Set(todosRef.current.filter(t => !t.deleted).map(t => normalize(t.text)));
      items.forEach(i => {
        const text = i.text.trim();
        if (!text) return;
        const key = normalize(text);
        if (seen.has(key)) { skipped++; return; }
        seen.add(key);
        const now = Date.now();
        fresh.push(normalizeItem({
          id: crypto.randomUUID(), text, qty: (i.qty ?? "").trim(),
          category: prefs[key] ?? i.category, createdAt: now, updatedAt: now,
        }));
      });

      if (fresh.length) setTodos(prev => sortItems([...fresh, ...prev]));
      recordHistory(fresh);
      showNotice(
        skipped
          ? `Pridaných ${fresh.length} · ${skipped} už v zozname bolo`
          : `Pridaných ${fresh.length} položiek`
      );
    } catch (err) {
      setErrorMsg(err.message ?? "Skenovanie zlyhalo.");
    } finally {
      setIsScanning(false);
    }
  };

  const toggleTodo = id => setTodos(prev => prev.map(t =>
    t.id === id ? { ...t, completed: !t.completed, updatedAt: Date.now() } : t));

  const deleteTodo = id => {
    const todo = todosRef.current.find(t => t.id === id);
    if (!todo) return;
    setTodos(prev => prev.map(t => t.id === id ? { ...t, deleted: true, updatedAt: Date.now() } : t));
    triggerUndo(`Vymazané: ${todo.text}`, [id]);
  };

  const editTodo = (id, text, qty) => {
    setTodos(prev => prev.map(t => t.id === id ? { ...t, text, qty, updatedAt: Date.now() } : t));
  };

  const setCategory = (id, category) => {
    setTodos(prev => prev.map(t => t.id === id ? { ...t, category, updatedAt: Date.now() } : t));
    const todo = todosRef.current.find(t => t.id === id);
    if (!todo) return;
    const key = normalize(todo.text);
    if (!key) return;
    const hist = settingsRef.current[`hist:${key}`]?.value;
    writeSettings({
      [`pref:${key}`]: category,
      ...(hist ? { [`hist:${key}`]: { ...hist, category } } : {}),
    });
  };

  const clearCompleted = () => {
    const ids = todosRef.current.filter(t => !t.deleted && t.completed).map(t => t.id);
    if (!ids.length) return;
    const idSet = new Set(ids);
    setTodos(prev => prev.map(t => idSet.has(t.id) ? { ...t, deleted: true, updatedAt: Date.now() } : t));
    triggerUndo(`Vymazaných ${ids.length} kúpených`, ids);
  };

  // ── Odvodené dáta ──────────────────────────────────────────────
  const visible = useMemo(() => todos.filter(t => !t.deleted), [todos]);

  const grouped = useMemo(() => {
    const active = visible.filter(t => !t.completed);
    const done = visible.filter(t => t.completed);
    if (!sortByCategory) {
      return { groups: active.length ? [{ category: null, items: active }] : [], done };
    }
    const byCategory = new Map(CATEGORIES.map(c => [c, []]));
    active.forEach(t => byCategory.get(t.category)?.push(t));
    return {
      groups: catOrder.map(c => ({ category: c, items: byCategory.get(c) ?? [] })).filter(g => g.items.length),
      done,
    };
  }, [visible, sortByCategory, catOrder]);

  // Ponuky pod poľom: bez písania to, čo kupuješ najčastejšie; počas písania
  // našepkávač z histórie (hľadá sa v poslednej položke za čiarkou).
  const suggestions = useMemo(() => {
    const onList = new Set(visible.filter(t => !t.completed).map(t => normalize(t.text)));
    const query = normalize(input.split(/;|\n|(?<!\d),|,(?!\d)/).pop() ?? "");
    const pool = Object.entries(history)
      .filter(([key, h]) => h?.text && !onList.has(key) && key !== query);
    if (query) {
      return pool
        .filter(([key]) => key.includes(query))
        .sort(([ka, a], [kb, b]) => (kb.startsWith(query) - ka.startsWith(query)) || (b.count - a.count))
        .slice(0, 6).map(([, h]) => h);
    }
    return pool
      .filter(([, h]) => h.count >= 2)
      .sort(([, a], [, b]) => (b.count - a.count) || (b.lastAt - a.lastAt))
      .slice(0, 8).map(([, h]) => h);
  }, [history, visible, input]);
  const canDictate = typeof window !== "undefined" && !!(window.SpeechRecognition ?? window.webkitSpeechRecognition);

  const remaining = visible.filter(t => !t.completed).length;
  const inCart = visible.length - remaining;

  const btnStyle = {
    background: "#f8fafc", border: "1px solid #e2e8f0", color: "#64748b",
    width: 36, height: 36, borderRadius: "0.5rem", cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
    transition: "background 0.1s",
  };

  const syncLabel = { off: "", syncing: "Ukladám…", ok: "Synchronizované", error: "Offline" }[syncState];
  const syncColor = { off: "#cbd5e1", syncing: "#f59e0b", ok: "#22c55e", error: "#f43f5e" }[syncState];

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(to bottom, #f8fafc, #f1f5f9)" }}>
      {showSettings && (
        <SettingsModal
          catOrder={catOrder}
          onMoveCategory={moveCategory}
          onSave={saveSettings}
          onClose={() => setShowSettings(false)}
          push={{ state: pushState, error: pushError, configured }}
          onTogglePush={togglePush}
        />
      )}

      <div style={{ maxWidth: 448, margin: "0 auto", padding: "1rem 1rem 6rem" }}>

        {/* Header */}
        <header style={{ marginBottom: "1.25rem", paddingTop: "0.5rem" }}>
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
            <div>
              <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem" }}>
                <h1 style={{ fontSize: "1.75rem", fontWeight: 800, color: "#1e293b", letterSpacing: "-0.03em" }}>Nákupný zoznam</h1>
                <span style={{ fontSize: "0.65rem", fontWeight: 600, color: "#cbd5e1" }}>v{APP_VERSION}</span>
              </div>
              <p style={{ fontSize: "0.7rem", color: "#94a3b8", marginTop: "0.15rem", display: "flex", alignItems: "center", gap: "0.4rem" }}>
                <span>zostáva {remaining} · v košíku {inCart}</span>
                {syncLabel && (
                  <span title={syncLabel} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: syncColor, display: "inline-block" }} />
                    {syncLabel}
                  </span>
                )}
              </p>
            </div>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              {inCart > 0 && (
                <button onClick={clearCompleted} style={{ fontSize: "0.7rem", color: "#94a3b8", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>
                  Vymazať kúpené
                </button>
              )}
              <button onClick={() => setShowSettings(true)} title="Nastavenia" style={{ ...btnStyle, width: 30, height: 30 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
              </button>
            </div>
          </div>

          <div style={{ marginTop: "0.75rem", display: "flex", justifyContent: "flex-end" }}>
            <button
              onClick={toggleSortByCategory}
              title="Triedenie do kategórií"
              style={{
                display: "flex", alignItems: "center", gap: "0.4rem",
                background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 999,
                padding: "0.3rem 0.6rem 0.3rem 0.7rem", cursor: "pointer",
              }}
            >
              <span style={{ fontSize: "0.7rem", fontWeight: 600, color: "#64748b" }}>Triedenie do kategórií</span>
              <span style={{
                width: 30, height: 17, borderRadius: 999, position: "relative", flexShrink: 0,
                background: sortByCategory ? "#4f46e5" : "#cbd5e1", transition: "background 0.15s",
              }}>
                <span style={{
                  position: "absolute", top: 2, left: sortByCategory ? 15 : 2,
                  width: 13, height: 13, borderRadius: "50%", background: "#fff",
                  transition: "left 0.15s", boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
                }} />
              </span>
            </button>
          </div>
        </header>

        {/* Input bar */}
        <div style={{
          position: "sticky", top: 12, zIndex: 20,
          background: "rgba(255,255,255,0.92)", backdropFilter: "blur(8px)",
          borderRadius: "0.875rem", boxShadow: "0 2px 12px rgba(0,0,0,0.1)",
          border: "1px solid #e2e8f0", padding: "0.375rem", marginBottom: "1.25rem",
        }}>
        <div style={{ display: "flex", gap: "0.375rem", alignItems: "center" }}>
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addOne(); } }}
            placeholder={isScanning ? "Spracovávam…" : listening ? "Počúvam…" : "Pridať položku…"}
            disabled={isScanning}
            style={{
              flex: 1, background: "transparent", border: "none", outline: "none",
              padding: "0.4rem 0.5rem", fontSize: "0.875rem", color: "#1e293b",
              minWidth: 0,
            }}
          />
          <input type="file" accept="image/*" capture="environment" ref={cameraRef} onChange={handleImage} style={{ display: "none" }} />
          <input type="file" accept="image/*" ref={galleryRef} onChange={handleImage} style={{ display: "none" }} />

          {canDictate && (
            <button onClick={toggleVoice} disabled={isScanning} title={listening ? "Zastaviť diktovanie" : "Nadiktovať"} aria-pressed={listening}
              style={{ ...btnStyle, ...(listening ? { background: "#fee2e2", borderColor: "#fca5a5", color: "#dc2626", animation: "pulse 1.2s ease-in-out infinite" } : {}) }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="17" x2="12" y2="22"/></svg>
            </button>
          )}
          <button onClick={() => cameraRef.current?.click()} disabled={isScanning} title="Odfotiť" style={btnStyle}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
          </button>
          <button onClick={() => galleryRef.current?.click()} disabled={isScanning} title="Z galérie" style={btnStyle}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          </button>
          <button onClick={addOne} disabled={isScanning || !input.trim()} title="Pridať" style={{
            background: "#4f46e5", color: "#fff", border: "none",
            width: 36, height: 36, borderRadius: "0.5rem", cursor: input.trim() && !isScanning ? "pointer" : "not-allowed",
            display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
            opacity: input.trim() && !isScanning ? 1 : 0.5, transition: "opacity 0.15s",
          }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
        </div>

        {suggestions.length > 0 && !isScanning && (
          <div style={{ display: "flex", alignItems: "center", gap: "0.35rem", overflowX: "auto", padding: "0.4rem 0.2rem 0.1rem", scrollbarWidth: "none" }}>
            {!input.trim() && <span style={{ fontSize: "0.65rem", fontWeight: 600, color: "#94a3b8", whiteSpace: "nowrap", paddingRight: 2 }}>Často:</span>}
            {suggestions.map(h => (
              <button key={h.text} onClick={() => addSuggestion(h)} title={`Pridať ${h.text}`}
                style={{
                  flexShrink: 0, whiteSpace: "nowrap", cursor: "pointer",
                  fontSize: "0.72rem", fontWeight: 600, padding: "0.3rem 0.6rem", borderRadius: 999,
                  background: "#eef2ff", color: "#4338ca", border: "1px solid #c7d2fe",
                }}>
                + {h.text}
              </button>
            ))}
          </div>
        )}
        </div>

        {/* Scanning indicator */}
        {isScanning && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "0.5rem", color: "#4f46e5", fontSize: "0.8rem", fontWeight: 600, marginBottom: "1rem" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: "spin 1s linear infinite" }}>
              <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
            </svg>
            Spracovávam zoznam…
          </div>
        )}

        {/* Notice */}
        {notice && (
          <div style={{ marginBottom: "1rem", padding: "0.6rem 0.875rem", borderRadius: "0.75rem", background: "#eef2ff", border: "1px solid #c7d2fe", color: "#4338ca", fontSize: "0.78rem" }}>
            {notice}
          </div>
        )}

        {/* Error */}
        {errorMsg && (
          <div style={{ marginBottom: "1rem", padding: "0.6rem 0.875rem", borderRadius: "0.75rem", background: "#fff1f2", border: "1px solid #fecdd3", color: "#be123c", fontSize: "0.78rem" }}>
            {errorMsg}
          </div>
        )}

        {/* Not configured warning */}
        {!configured && !showSettings && (
          <div style={{ marginBottom: "1rem", padding: "0.75rem 0.875rem", borderRadius: "0.75rem", background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", fontSize: "0.78rem", lineHeight: 1.5 }}>
            Bez nastaveného Workera funguje ručné pridávanie, ale nie skenovanie fotiek ani synchronizácia medzi zariadeniami.{" "}
            <button onClick={() => setShowSettings(true)} style={{ color: "#4f46e5", background: "none", border: "none", cursor: "pointer", textDecoration: "underline", fontSize: "inherit" }}>
              Nastaviť
            </button>
          </div>
        )}

        {/* List */}
        <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
          {visible.length === 0 && !isScanning ? (
            <div style={{ textAlign: "center", paddingTop: "4rem" }}>
              <p style={{ fontSize: "1rem", color: "#94a3b8" }}>Zoznam je prázdny</p>
              <p style={{ fontSize: "0.75rem", color: "#94a3b8", marginTop: "0.25rem" }}>
                Odfoť alebo vlož nákupný lístok
              </p>
            </div>
          ) : (
            <>
              {grouped.groups.map(({ category, items }) => (
                <section key={category ?? "all"}>
                  {category && (
                    <div style={{ display: "flex", alignItems: "center", gap: "0.375rem", marginBottom: "0.5rem", paddingLeft: "0.25rem" }}>
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: CATEGORY_STYLES[category]?.dot ?? "#94a3b8", flexShrink: 0 }} />
                      <span style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700, color: "#94a3b8" }}>{category}</span>
                      <span style={{ fontSize: "0.65rem", color: "#cbd5e1" }}>· {items.length}</span>
                    </div>
                  )}
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                    {items.map(todo => (
                      <TodoRow key={todo.id} todo={todo} onToggle={toggleTodo} onDelete={deleteTodo}
                        onChangeCategory={setCategory} onEdit={editTodo} showCategory={sortByCategory} flash={flashId === todo.id} />
                    ))}
                  </div>
                </section>
              ))}
              {grouped.done.length > 0 && (
                <section>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.375rem", marginBottom: "0.5rem", paddingLeft: "0.25rem" }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#22c55e", flexShrink: 0 }} />
                    <span style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700, color: "#94a3b8" }}>V košíku</span>
                    <span style={{ fontSize: "0.65rem", color: "#cbd5e1" }}>· {grouped.done.length}</span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                    {grouped.done.map(todo => (
                      <TodoRow key={todo.id} todo={todo} onToggle={toggleTodo} onDelete={deleteTodo}
                        onChangeCategory={setCategory} onEdit={editTodo} showCategory={sortByCategory} flash={flashId === todo.id} />
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>

      {/* Undo snackbar */}
      {undoState && (
        <div style={{ position: "fixed", bottom: "1.25rem", left: "50%", transform: "translateX(-50%)", zIndex: 30, width: "min(92vw, 28rem)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", background: "#0f172a", color: "#fff", padding: "0.75rem 1rem", borderRadius: "0.875rem", boxShadow: "0 8px 30px rgba(0,0,0,0.25)" }}>
            <span style={{ flex: 1, fontSize: "0.8rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{undoState.message}</span>
            <button onClick={performUndo} style={{ color: "#a5b4fc", background: "none", border: "none", cursor: "pointer", fontWeight: 700, fontSize: "0.8rem" }}>Vrátiť</button>
            <button onClick={() => setUndoState(null)} style={{ color: "#64748b", background: "none", border: "none", cursor: "pointer", display: "flex" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>
      )}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(220,38,38,0.35); } 50% { box-shadow: 0 0 0 6px rgba(220,38,38,0); } }`}</style>
    </div>
  );
}
