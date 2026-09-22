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

const APP_VERSION = "2.2";
const STORAGE_KEY = "todos-v3";
const PREFS_KEY = "category-prefs-v2";
const PROXY_KEY = "anthropic-proxy-url";
const TOKEN_KEY = "app-token-v1";
const SORT_MODE_KEY = "sort-by-category-v1";
const CAT_ORDER_KEY = "category-order-v1";
const LEGACY_APIKEY_KEY = "anthropic-api-key";

// Zmazané položky sa nechávajú ako náhrobok, aby sa mazanie prenieslo
// na ostatné zariadenia a položka sa pri synchronizácii nevrátila.
const TOMBSTONE_MS = 7 * 24 * 60 * 60 * 1000;

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

const CATEGORY_SCHEMA = {
  type: "object",
  properties: { category: { type: "string", enum: CATEGORIES } },
  required: ["category"],
  additionalProperties: false,
};

async function categorizeItem(text) {
  const data = await callAnthropic({
    model: CATEGORIZE_MODEL,
    max_tokens: 256,
    system: `Zaraď položku nákupného zoznamu do najpresnejšej z povolených kategórií.
Rozhoduje oddelenie v obchode, nie surovina: mrazená zelenina patrí do „Mrazené",
saláma a šunka do „Údeniny a šunka", čokoláda do „Sladkosti", chipsy do „Slané snacky",
pivo a víno do „Alkohol", mlieko a syry do „Mlieko, syry, maslo", jogurt do „Jogurty a dezerty".
„Iné" použi len vtedy, keď sa položka naozaj nikam nehodí.`,
    output_config: { format: { type: "json_schema", schema: CATEGORY_SCHEMA } },
    messages: [{ role: "user", content: text }],
  });
  const category = firstJSON(data).category;
  return CATEGORIES.includes(category) ? category : "Iné";
}

// ── Synchronizácia zoznamu cez Worker (KV) ───────────────────────

async function fetchList() {
  const base = workerBase();
  if (!base) return null;
  const res = await fetch(`${base}/list`, { headers: { "x-app-token": appToken() } });
  if (res.status === 501) return null; // worker nemá nabindované KV
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function putList(items) {
  const base = workerBase();
  if (!base) return;
  const res = await fetch(`${base}/list`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-app-token": appToken() },
    body: JSON.stringify({ items, updatedAt: Date.now() }),
  });
  if (res.status === 501) return;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

// ── Components ───────────────────────────────────────────────────

// Číslo uličky = poradie kategórie v obchode (nastavuje sa v ⚙️).
function aisleNumber(catOrder, category) {
  return String(catOrder.indexOf(category) + 1).padStart(2, "0");
}

const monoMeta = { fontFamily: "var(--mono)", fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted)" };
const lineInput = {
  minWidth: 0, height: 40, padding: "0 2px", border: "none", borderBottom: "2px solid var(--ink)",
  outline: "none", background: "transparent", fontSize: 16, color: "var(--ink)",
};
const pillButton = (filled) => ({
  height: 40, padding: "0 16px", borderRadius: 999, cursor: "pointer", fontSize: 14, fontWeight: 500,
  border: "1.5px solid var(--ink)", background: filled ? "var(--ink)" : "transparent", color: filled ? "var(--paper)" : "var(--ink)",
});

function SettingsModal({ catOrder, onMoveCategory, sortByCategory, onToggleSort, onSave, onClose }) {
  const [proxy, setProxy] = useState(() => localStorage.getItem(PROXY_KEY) ?? "");
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) ?? "");
  const label = { ...monoMeta, marginBottom: 4 };
  const hint = { fontSize: 13, color: "var(--muted)", marginBottom: 6, lineHeight: 1.5 };
  const arrow = disabled => ({
    width: 36, height: 36, borderRadius: "50%", border: "1.5px solid var(--line)", background: "transparent",
    color: "var(--ink-2)", fontSize: 11, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.35 : 1,
  });
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(42,37,32,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: "1rem" }}>
      <div style={{ background: "var(--paper)", borderRadius: 6, padding: "22px 20px", maxWidth: 440, width: "100%", maxHeight: "88vh", overflowY: "auto", boxShadow: "0 24px 60px -20px rgba(60,45,30,0.5)" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", paddingBottom: 12, marginBottom: 16, borderBottom: "1.5px dashed var(--rule)" }}>
          <h2 style={{ fontFamily: "var(--serif)", fontStyle: "italic", fontWeight: 500, fontSize: 28, letterSpacing: "-0.02em" }}>Nastavenia</h2>
          <span style={monoMeta}>v{APP_VERSION}</span>
        </div>

        <p style={label}>URL Cloudflare Workera</p>
        <p style={hint}>Worker drží Anthropic kľúč a synchronizuje zoznam. Postup je v súbore <strong>cloudflare-worker.js</strong> v repozitári.</p>
        <input type="url" value={proxy} onChange={e => setProxy(e.target.value)} autoFocus
          placeholder="https://moj-worker.username.workers.dev" className="input-line"
          style={{ ...lineInput, width: "100%", marginBottom: 18 }} />

        <p style={label}>Prístupový token</p>
        <p style={hint}>To isté heslo, aké má Worker v premennej <code>APP_TOKEN</code>.</p>
        <input type="password" value={token} onChange={e => setToken(e.target.value)}
          placeholder="heslo z APP_TOKEN" className="input-line"
          style={{ ...lineInput, width: "100%", marginBottom: 20 }} />

        <label style={{ display: "flex", alignItems: "center", gap: 12, minHeight: 44, marginBottom: 14, cursor: "pointer", fontSize: 15 }}>
          <input type="checkbox" checked={sortByCategory} onChange={onToggleSort}
            style={{ width: 22, height: 22, accentColor: "var(--brick)", flexShrink: 0 }} />
          Triediť položky do uličiek
        </label>

        <p style={label}>Poradie uličiek</p>
        <p style={hint}>Zoraď ich tak, ako chodíš obchodom — podľa toho sa očíslujú.</p>
        <div style={{ borderTop: "1.5px dashed var(--rule)", borderBottom: "1.5px dashed var(--rule)", marginBottom: 20, maxHeight: 264, overflowY: "auto" }}>
          {catOrder.map((cat, i) => (
            <div key={cat} style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 44 }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 12, fontWeight: 500, color: "var(--brick)", width: 20 }}>{String(i + 1).padStart(2, "0")}</span>
              <span style={{ flex: 1, fontSize: 15 }}>{cat}</span>
              <button onClick={() => onMoveCategory(i, -1)} disabled={i === 0} aria-label={`${cat} vyššie`} style={arrow(i === 0)}>▲</button>
              <button onClick={() => onMoveCategory(i, 1)} disabled={i === catOrder.length - 1} aria-label={`${cat} nižšie`} style={arrow(i === catOrder.length - 1)}>▼</button>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onClose} style={{ ...pillButton(false), flex: 1, height: 48 }}>Zavrieť</button>
          <button onClick={() => onSave(proxy.trim(), token.trim())} style={{ ...pillButton(true), flex: 2, height: 48 }}>Uložiť</button>
        </div>
      </div>
    </div>
  );
}

function TodoRow({ todo, onToggle, onDelete, onChangeCategory, onEdit, showCategory, flash }) {
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
  const onKey = e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); };

  const done = todo.completed;

  return (
    <div style={{ borderRadius: 4, margin: "0 -6px", padding: "0 6px", background: flash ? "#fbeec4" : "transparent", transition: "background 0.3s" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, minHeight: 44 }}>
        <button onClick={() => onToggle(todo.id)} aria-label={done ? "Vrátiť do zoznamu" : "Označiť ako kúpené"} style={{
          width: 44, height: 44, margin: "0 -11px", padding: 0, flexShrink: 0, background: "none", border: "none", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <span style={{
            width: 22, height: 22, borderRadius: 4, border: `1.5px solid ${done ? "var(--brick)" : "var(--box)"}`,
            background: done ? "var(--brick)" : "transparent", color: "var(--paper)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            {done && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>}
          </span>
        </button>

        <button onClick={startEdit} aria-label={`Upraviť ${todo.text}`} style={{
          flex: 1, minWidth: 0, display: "flex", alignItems: "baseline", gap: 12, padding: "10px 0",
          background: "none", border: "none", cursor: "text", textAlign: "left", color: "inherit",
        }}>
          <span style={{
            fontSize: 16, lineHeight: 1.35, overflowWrap: "anywhere",
            color: done ? "var(--done)" : "var(--ink)", textDecoration: done ? "line-through" : "none",
            textDecorationColor: "var(--brick)", textDecorationThickness: 2,
          }}>{todo.text}</span>
          {todo.qty ? (
            <>
              <span style={{ flex: 1, minWidth: 12, height: 1, borderBottom: "2px dotted var(--rule)" }} />
              <span style={{ fontFamily: "var(--mono)", fontSize: 14, whiteSpace: "nowrap", flexShrink: 0, color: done ? "var(--done-qty)" : "var(--ink-2)" }}>{todo.qty}</span>
            </>
          ) : null}
        </button>
      </div>

      {/* Úprava sa rozbalí pod riadkom — tu sa dá aj zmeniť ulička a položka zmazať */}
      {editing && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "2px 0 14px 34px" }}>
          <div style={{ display: "flex", gap: 10 }}>
            <input value={text} onChange={e => setText(e.target.value)} onKeyDown={onKey} autoFocus aria-label="Názov položky" style={{ ...lineInput, flex: 1 }} />
            <input value={qty} onChange={e => setQty(e.target.value)} onKeyDown={onKey} placeholder="množstvo" aria-label="Množstvo"
              className="input-line" style={{ ...lineInput, width: 88, fontFamily: "var(--mono)", fontSize: 16, textAlign: "right" }} />
          </div>
          {showCategory && (
            <select value={todo.category} onChange={e => onChangeCategory(todo.id, e.target.value)} aria-label="Ulička"
              style={{ ...lineInput, width: "100%", borderBottom: "1.5px solid var(--line)", fontSize: 15, cursor: "pointer" }}>
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={() => { setEditing(false); onDelete(todo.id); }}
              style={{ height: 40, padding: "0 4px", background: "none", border: "none", color: "var(--brick)", fontSize: 14, fontWeight: 500, cursor: "pointer" }}>
              Vymazať
            </button>
            <span style={{ flex: 1 }} />
            <button onClick={() => setEditing(false)} style={{ ...pillButton(false), border: "none" }}>Zrušiť</button>
            <button onClick={commit} style={pillButton(true)}>Uložiť</button>
          </div>
        </div>
      )}
    </div>
  );
}

function AisleHeading({ no, name, extra }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 10, paddingBottom: 4 }}>
      <span style={{ fontFamily: "var(--mono)", fontSize: 12, fontWeight: 500, color: "var(--brick)" }}>{no}</span>
      <span style={{ fontFamily: "var(--serif)", fontSize: 19, fontWeight: 700, letterSpacing: "-0.01em" }}>{name}</span>
      {extra}
    </div>
  );
}

// ── Main App ─────────────────────────────────────────────────────

export default function App() {
  const [todos, setTodos] = useState([]);
  const [prefs, setPrefs] = useState({});
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
  const [catOrder, setCatOrder] = useState(CATEGORIES);
  const [syncState, setSyncState] = useState("off"); // off | syncing | ok | error

  const undoTimer = useRef(null);
  const noticeTimer = useRef(null);
  const flashTimer = useRef(null);
  const pushTimer = useRef(null);
  const cameraRef = useRef(null);
  const galleryRef = useRef(null);
  const todosRef = useRef([]);
  const lastSyncedRef = useRef("");

  useEffect(() => { todosRef.current = todos; }, [todos]);

  useEffect(() => {
    // Kľúč sa kedysi držal v prehliadači; teraz žije vo Workeri, tak ho odtiaľto zmažeme.
    localStorage.removeItem(LEGACY_APIKEY_KEY);

    setTodos(sortItems(loadJSON(STORAGE_KEY, []).map(normalizeItem)));
    setPrefs(migratePrefs(loadJSON(PREFS_KEY, {})));
    const storedSortMode = localStorage.getItem(SORT_MODE_KEY);
    if (storedSortMode !== null) setSortByCategory(storedSortMode === "true");

    const storedOrder = loadJSON(CAT_ORDER_KEY, null);
    if (Array.isArray(storedOrder)) {
      const order = mergeCatOrder(storedOrder);
      setCatOrder(order);
      localStorage.setItem(CAT_ORDER_KEY, JSON.stringify(order));
    }

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
  const pull = useCallback(async () => {
    if (!workerBase()) return;
    try {
      const remote = await fetchList();
      if (!remote) { setSyncState("off"); return; }
      const remoteItems = Array.isArray(remote.items) ? remote.items : [];
      const merged = mergeLists(todosRef.current, remoteItems);
      if (JSON.stringify(merged) !== JSON.stringify(todosRef.current)) setTodos(merged);
      lastSyncedRef.current = JSON.stringify(remoteItems.map(normalizeItem));
      setSyncState("ok");
    } catch {
      setSyncState("error");
    }
  }, []);

  const push = useCallback(async () => {
    if (!workerBase()) return;
    const items = todosRef.current;
    const payload = JSON.stringify(items);
    if (payload === lastSyncedRef.current) return;
    setSyncState("syncing");
    try {
      await putList(items);
      lastSyncedRef.current = payload;
      setSyncState("ok");
    } catch {
      setSyncState("error");
    }
  }, []);

  // Po stiahnutí skúsime aj odoslať — inak by zmena spravená offline ležala
  // v mobile dovtedy, kým sa zoznamu znova nedotkneš.
  const syncNow = useCallback(async () => { await pull(); await push(); }, [pull, push]);

  useEffect(() => {
    if (!hydrated || !configured) return;
    syncNow();
    const iv = setInterval(() => { if (document.visibilityState === "visible") syncNow(); }, 15000);
    const onVisible = () => { if (document.visibilityState === "visible") syncNow(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", syncNow);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", syncNow);
    };
  }, [hydrated, configured, syncNow]);

  useEffect(() => {
    if (!hydrated || !configured) return;
    clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(push, 1500);
    return () => clearTimeout(pushTimer.current);
  }, [todos, hydrated, configured, push]);

  // ── Nastavenia ─────────────────────────────────────────────────
  const saveSettings = (proxyUrl, token) => {
    if (proxyUrl) localStorage.setItem(PROXY_KEY, proxyUrl);
    else localStorage.removeItem(PROXY_KEY);
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
    localStorage.setItem(CAT_ORDER_KEY, JSON.stringify(catOrder));
    setConfigured(!!workerBase());
    setShowSettings(false);
    setErrorMsg(null);
  };

  const moveCategory = (index, dir) => {
    setCatOrder(prev => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      localStorage.setItem(CAT_ORDER_KEY, JSON.stringify(next));
      return next;
    });
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

  const addOne = async () => {
    const text = input.trim();
    if (!text) return;

    const duplicate = findActiveDuplicate(text);
    if (duplicate) {
      setInput("");
      flashItem(duplicate.id);
      showNotice(`„${duplicate.text}" už v zozname je.`);
      if (duplicate.completed) {
        setTodos(prev => prev.map(t => t.id === duplicate.id ? { ...t, completed: false, updatedAt: Date.now() } : t));
      }
      return;
    }

    setInput("");
    const id = crypto.randomUUID();
    const pref = prefs[normalize(text)];
    const now = Date.now();
    setTodos(prev => sortItems([normalizeItem({ id, text, category: pref ?? "Iné", createdAt: now, updatedAt: now }), ...prev]));
    if (pref || !configured || !sortByCategory) return;
    try {
      const category = await categorizeItem(text);
      setTodos(prev => prev.map(t => t.id === id ? { ...t, category, updatedAt: Date.now() } : t));
    } catch (err) { setErrorMsg(err.message ?? "Kategorizácia zlyhala."); }
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
    setPrefs(prev => { const next = { ...prev, [key]: category }; localStorage.setItem(PREFS_KEY, JSON.stringify(next)); return next; });
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
    const done = visible.filter(t => t.completed)
      .sort((a, b) => (a.updatedAt - b.updatedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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

  const remaining = visible.filter(t => !t.completed).length;
  const inCart = visible.length - remaining;

  const syncLabel = { off: "", syncing: "ukladám…", ok: "synchr. ✓", error: "offline" }[syncState];
  const today = new Date().toLocaleDateString("sk-SK", { weekday: "short", day: "numeric", month: "numeric" });
  const hasText = !!input.trim();
  const noteStyle = (color) => ({
    margin: "14px 14px 0", padding: "10px 14px", borderRadius: 6, border: `1.5px dashed ${color}`,
    color, fontSize: 14, lineHeight: 1.5,
  });
  const circle = (size) => ({
    width: size, height: size, borderRadius: "50%", flexShrink: 0, cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center",
  });
  const rowProps = todo => ({
    todo, onToggle: toggleTodo, onDelete: deleteTodo, onChangeCategory: setCategory, onEdit: editTodo,
    showCategory: sortByCategory, flash: flashId === todo.id,
  });

  return (
    <div style={{ minHeight: "100vh", paddingBottom: "calc(130px + env(safe-area-inset-bottom))" }}>
      {showSettings && (
        <SettingsModal
          catOrder={catOrder}
          onMoveCategory={moveCategory}
          sortByCategory={sortByCategory}
          onToggleSort={toggleSortByCategory}
          onSave={saveSettings}
          onClose={() => setShowSettings(false)}
        />
      )}

      <div style={{ maxWidth: 448, margin: "0 auto" }}>

        {/* Hlavička */}
        <header style={{ padding: "26px 24px 0", display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={monoMeta}>{today}{syncLabel ? ` · ${syncLabel}` : ""}</div>
            <h1 style={{ fontFamily: "var(--serif)", fontSize: 38, fontWeight: 500, fontStyle: "italic", letterSpacing: "-0.02em", lineHeight: 1.05 }}>Nákupný lístok</h1>
          </div>
          <button onClick={() => setShowSettings(true)} aria-label="Nastavenia" style={{ ...circle(44), border: "1.5px solid var(--line)", background: "transparent", color: "var(--ink-2)" }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><line x1="5" y1="8" x2="19" y2="8"/><line x1="5" y1="16" x2="19" y2="16"/><circle cx="10" cy="8" r="2.2" fill="var(--desk)"/><circle cx="14" cy="16" r="2.2" fill="var(--desk)"/></svg>
          </button>
        </header>

        {notice && <div style={noteStyle("var(--ink-2)")}>{notice}</div>}
        {errorMsg && <div style={noteStyle("var(--brick)")}>{errorMsg}</div>}
        {!configured && !showSettings && (
          <div style={noteStyle("var(--muted)")}>
            Bez nastaveného Workera funguje ručné pridávanie, ale nie skenovanie fotiek ani synchronizácia medzi zariadeniami.{" "}
            <button onClick={() => setShowSettings(true)} style={{ color: "var(--ink)", fontWeight: 600, background: "none", border: "none", cursor: "pointer", textDecoration: "underline", fontSize: "inherit" }}>
              Nastaviť
            </button>
          </div>
        )}

        {/* Lístok */}
        <div className="receipt" style={{
          margin: "18px 14px 0", background: "var(--paper)", borderRadius: "6px 6px 0 0", padding: "18px 18px 22px",
          boxShadow: "0 1px 0 var(--rule), 0 16px 30px -18px rgba(60,45,30,0.35)",
          display: "flex", flexDirection: "column", gap: 18,
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontFamily: "var(--mono)", fontSize: 12, color: "var(--muted)", paddingBottom: 12, borderBottom: "1.5px dashed var(--rule)" }}>
            <span>POLOŽIEK {visible.length}</span>
            <span>V KOŠÍKU {inCart}</span>
            <span style={{ color: "var(--brick)", fontWeight: 500 }}>ZOSTÁVA {remaining}</span>
          </div>

          {isScanning && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, ...monoMeta, color: "var(--brick)" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: "spin 1s linear infinite" }}><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
              Čítam lístok…
            </div>
          )}

          {visible.length === 0 && !isScanning && (
            <div style={{ textAlign: "center", padding: "28px 0 20px" }}>
              <p style={{ fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 22 }}>Lístok je prázdny</p>
              <p style={{ fontSize: 14, color: "var(--muted)", marginTop: 6 }}>Dopíš položku alebo odfoť papierový lístok.</p>
            </div>
          )}

          {grouped.groups.map(({ category, items }) => (
            <section key={category ?? "all"} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {category && <AisleHeading no={aisleNumber(catOrder, category)} name={category} />}
              {items.map(todo => <TodoRow key={todo.id} {...rowProps(todo)} />)}
            </section>
          ))}

          {/* Kúpené idú na koniec lístka, naposledy kúpené úplne dole */}
          {grouped.done.length > 0 && (
            <section style={{ display: "flex", flexDirection: "column", gap: 2, paddingTop: grouped.groups.length ? 14 : 0, borderTop: grouped.groups.length ? "1.5px dashed var(--rule)" : "none" }}>
              <AisleHeading no="✓" name="V košíku" extra={
                <>
                  <span style={{ flex: 1 }} />
                  <button onClick={clearCompleted} style={{ fontFamily: "var(--mono)", fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--brick)", background: "none", border: "none", cursor: "pointer", padding: "12px 0", margin: "-12px 0" }}>
                    Vymazať kúpené
                  </button>
                </>
              } />
              {grouped.done.map(todo => <TodoRow key={todo.id} {...rowProps(todo)} />)}
            </section>
          )}
        </div>
      </div>

      {/* Spodná lišta: dopísanie, galéria a fotka lístka */}
      <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 20, background: "var(--desk)", borderTop: "1px solid var(--rule)" }}>
        <div style={{ maxWidth: 448, margin: "0 auto", padding: "14px 20px calc(30px + env(safe-area-inset-bottom))", display: "flex", gap: 12, alignItems: "center" }}>
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addOne(); } }}
            placeholder={isScanning ? "Čítam lístok…" : "Dopíš na lístok…"}
            disabled={isScanning}
            aria-label="Nová položka"
            enterKeyHint="done"
            className="input-line"
            style={{ ...lineInput, flex: 1, height: 52, padding: "0 4px", fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 19 }}
          />
          <input type="file" accept="image/*" capture="environment" ref={cameraRef} onChange={handleImage} style={{ display: "none" }} />
          <input type="file" accept="image/*" ref={galleryRef} onChange={handleImage} style={{ display: "none" }} />

          <button onClick={() => galleryRef.current?.click()} disabled={isScanning} aria-label="Z galérie"
            style={{ ...circle(52), border: "1.5px solid var(--ink)", background: "transparent", color: "var(--ink)", opacity: isScanning ? 0.4 : 1 }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="1.6"/><path d="M21 15l-5-5L5 21"/></svg>
          </button>
          {/* Keď je niečo napísané, veľké tlačidlo pridáva; inak fotí lístok */}
          <button onClick={hasText ? addOne : () => cameraRef.current?.click()} disabled={isScanning} aria-label={hasText ? "Pridať na lístok" : "Odfotiť lístok"}
            style={{ ...circle(60), border: "none", background: "var(--brick)", color: "var(--paper)", boxShadow: "0 8px 18px -8px rgba(181,72,42,0.7)", opacity: isScanning ? 0.6 : 1 }}>
            {isScanning ? (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: "spin 1s linear infinite" }}><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
            ) : hasText ? (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            ) : (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.8l1.5-2h4.4l1.5 2h1.8A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z"/><circle cx="12" cy="12.5" r="3.5"/></svg>
            )}
          </button>
        </div>
      </div>

      {/* Undo snackbar */}
      {undoState && (
        <div style={{ position: "fixed", bottom: "calc(116px + env(safe-area-inset-bottom))", left: "50%", transform: "translateX(-50%)", zIndex: 30, width: "min(92vw, 28rem)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, background: "var(--ink)", color: "var(--paper)", padding: "6px 8px 6px 16px", borderRadius: 999, boxShadow: "0 10px 30px -10px rgba(42,37,32,0.6)" }}>
            <span style={{ flex: 1, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{undoState.message}</span>
            <button onClick={performUndo} style={{ height: 36, padding: "0 12px", color: "#f2b8a4", background: "none", border: "none", cursor: "pointer", fontWeight: 600, fontSize: 14 }}>Vrátiť</button>
            <button onClick={() => setUndoState(null)} aria-label="Zavrieť" style={{ ...circle(36), color: "var(--done-qty)", background: "none", border: "none" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
