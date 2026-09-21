import { useState, useEffect, useRef, useCallback, useMemo } from "react";

const CATEGORIES = [
  "Ovocie a zelenina",
  "Mliečne výrobky",
  "Mäso a ryby",
  "Pečivo",
  "Cestoviny, ryža, múka",
  "Konzervy a omáčky",
  "Sladkosti a snacky",
  "Nápoje",
  "Mrazené",
  "Drogéria a domácnosť",
  "Iné",
];

const CATEGORY_STYLES = {
  "Ovocie a zelenina":     { dot: "#10b981", chip: { bg: "#ecfdf5", color: "#047857", border: "#a7f3d0" } },
  "Mliečne výrobky":       { dot: "#38bdf8", chip: { bg: "#f0f9ff", color: "#0369a1", border: "#bae6fd" } },
  "Mäso a ryby":           { dot: "#f43f5e", chip: { bg: "#fff1f2", color: "#be123c", border: "#fecdd3" } },
  "Pečivo":                { dot: "#f59e0b", chip: { bg: "#fffbeb", color: "#b45309", border: "#fde68a" } },
  "Cestoviny, ryža, múka": { dot: "#eab308", chip: { bg: "#fefce8", color: "#854d0e", border: "#fef08a" } },
  "Konzervy a omáčky":     { dot: "#f97316", chip: { bg: "#fff7ed", color: "#c2410c", border: "#fed7aa" } },
  "Sladkosti a snacky":    { dot: "#ec4899", chip: { bg: "#fdf2f8", color: "#be185d", border: "#fbcfe8" } },
  "Nápoje":                { dot: "#06b6d4", chip: { bg: "#ecfeff", color: "#0e7490", border: "#a5f3fc" } },
  "Mrazené":               { dot: "#818cf8", chip: { bg: "#eef2ff", color: "#4338ca", border: "#c7d2fe" } },
  "Drogéria a domácnosť":  { dot: "#a855f7", chip: { bg: "#faf5ff", color: "#7e22ce", border: "#e9d5ff" } },
  "Iné":                   { dot: "#94a3b8", chip: { bg: "#f8fafc", color: "#475569", border: "#e2e8f0" } },
};

const APP_VERSION = "2.0";
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
5. Každej položke prirad kategóriu zo zoznamu povolených hodnôt`;

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
    system: "Zaraď položku nákupného zoznamu do jednej z povolených kategórií.",
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
  return {
    id: item.id ?? crypto.randomUUID(),
    text: item.text ?? "",
    qty: item.qty ?? "",
    completed: !!item.completed,
    category: CATEGORIES.includes(item.category) ? item.category : "Iné",
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

function SettingsModal({ catOrder, onMoveCategory, onSave, onClose }) {
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

        <p style={{ fontSize: "0.78rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>Poradie kategórií</p>
        <p style={{ fontSize: "0.75rem", color: "#64748b", marginBottom: "8px", lineHeight: 1.5 }}>
          Zoraď ich tak, ako chodíš obchodom.
        </p>
        <div style={{ border: "1px solid #e2e8f0", borderRadius: "0.5rem", marginBottom: "1.25rem", overflow: "hidden" }}>
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
    setPrefs(loadJSON(PREFS_KEY, {}));
    const storedSortMode = localStorage.getItem(SORT_MODE_KEY);
    if (storedSortMode !== null) setSortByCategory(storedSortMode === "true");

    const storedOrder = loadJSON(CAT_ORDER_KEY, null);
    if (Array.isArray(storedOrder)) {
      const known = storedOrder.filter(c => CATEGORIES.includes(c));
      setCatOrder([...known, ...CATEGORIES.filter(c => !known.includes(c))]);
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
          display: "flex", gap: "0.375rem", alignItems: "center",
        }}>
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addOne(); } }}
            placeholder={isScanning ? "Spracovávam…" : "Pridať položku…"}
            disabled={isScanning}
            style={{
              flex: 1, background: "transparent", border: "none", outline: "none",
              padding: "0.4rem 0.5rem", fontSize: "0.875rem", color: "#1e293b",
              minWidth: 0,
            }}
          />
          <input type="file" accept="image/*" capture="environment" ref={cameraRef} onChange={handleImage} style={{ display: "none" }} />
          <input type="file" accept="image/*" ref={galleryRef} onChange={handleImage} style={{ display: "none" }} />

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

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
