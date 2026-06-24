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

const APP_VERSION = "1.5";
const STORAGE_KEY = "todos-v3";
const PREFS_KEY = "category-prefs-v2";
const APIKEY_KEY = "anthropic-api-key";
const PROXY_KEY = "anthropic-proxy-url";
const SORT_MODE_KEY = "sort-by-category-v1";
const REMINDERS_KEY = "reminders-v1";
const PUSH_ENABLED_KEY = "push-enabled-v1";

// Základná URL Cloudflare Workera (odvodená z AI proxy URL)
function pushBase() {
  const proxy = (localStorage.getItem(PROXY_KEY) ?? "").trim();
  if (!proxy) return "";
  try { return new URL(proxy).origin; } catch { return ""; }
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function normalize(text) {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").trim();
}

function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

// Zobrazí notifikáciu bezpečne. Na Androide/PWA je `new Notification()` zakázaný
// (vyhodí výnimku), preto uprednostníme ServiceWorker. Nikdy nehádže výnimku,
// aby pád notifikácie nezhodil celú appku (biela obrazovka).
function showReminderNotification(text) {
  try {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.ready
        .then(reg => reg.showNotification("Pripomienka", { body: text }))
        .catch(() => { try { new Notification("Pripomienka", { body: text }); } catch { /* ignore */ } });
    } else {
      new Notification("Pripomienka", { body: text });
    }
  } catch { /* notifikácia nesmie nikdy zhodiť aplikáciu */ }
}

// ── Anthropic API helpers ────────────────────────────────────────

async function callAnthropic(apiKey, messages, system = null, maxTokens = 512, model = "claude-haiku-4-5-20251001") {
  const proxyUrl = localStorage.getItem(PROXY_KEY) ?? "";
  const url = proxyUrl.trim() || "https://api.anthropic.com/v1/messages";
  const body = { model, max_tokens: maxTokens, messages };
  if (system) body.system = system;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    const hint = proxyUrl.trim() ? "" : " Nastav Cloudflare Worker proxy v nastaveniach.";
    throw new Error(`Sieťová chyba: ${e.message}.${hint}`);
  }
  if (res.status === 401) throw new Error("Neplatný API kľúč. Skontroluj ho v nastaveniach.");
  if (res.status === 429) throw new Error("Príliš veľa požiadaviek. Skús neskôr.");
  if (!res.ok) { const t = await res.text().catch(() => ""); throw new Error(`API chyba ${res.status}: ${t}`); }
  return res.json();
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

async function scanImage(apiKey, mimeType, base64Data) {
  const system = `Si expertný čítač slovenských nákupných zoznamov (tlačených aj písaných rukou).
PRAVIDLÁ:
1. Prečítaj text v obrázku doslovne — neupravuj, nevymýšľaj, nepridávaj položky ktoré tam nie sú
2. Ignoruj prečiarknuté položky
3. Odstráň len čísla a jednotky (napr. "2x" "1L" "kg") — samotné slovo ponechaj
4. Jednoslovné skratky dokonči len ak je to jednoznačné (napr. "toaletný" → "toaletný papier")
5. Každej položke prirad kategóriu z: ${CATEGORIES.join(", ")}
6. Odpovedz VÝHRADNE validným JSON poľom, bez akéhokoľvek ďalšieho textu: [{"text":"...","category":"..."}]`;
  const data = await callAnthropic(apiKey, [{
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: mimeType, data: base64Data } },
      { type: "text", text: "Extrahuj položky z tohto nákupného zoznamu." },
    ],
  }], system, 2048, "claude-sonnet-4-6");
  const raw = data.content?.[0]?.text ?? "";
  const clean = raw.replace(/```json|```/g, "").trim();
  try {
    const parsed = JSON.parse(clean);
    return Array.isArray(parsed) ? parsed.filter(i => i.text && CATEGORIES.includes(i.category)) : [];
  } catch { return []; }
}

async function categorizeItem(apiKey, text) {
  const data = await callAnthropic(apiKey,
    [{ role: "user", content: text }],
    `Zaraď položku nákupného zoznamu do JEDNEJ z kategórií: ${CATEGORIES.join(", ")}. Odpovedz LEN názvom kategórie.`,
    32
  );
  const raw = (data.content?.[0]?.text ?? "").trim();
  return CATEGORIES.find(c => raw.toLowerCase().includes(c.toLowerCase())) ?? "Iné";
}

// ── Components ───────────────────────────────────────────────────

function ApiKeyModal({ onSave }) {
  const [val, setVal] = useState(() => localStorage.getItem(APIKEY_KEY) ?? "");
  const [proxy, setProxy] = useState(() => localStorage.getItem(PROXY_KEY) ?? "");
  const canSave = val.trim();
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: "1rem" }}>
      <div style={{ background: "#fff", borderRadius: "1rem", padding: "1.5rem", maxWidth: 420, width: "100%", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
        <h2 style={{ fontSize: "1.125rem", fontWeight: 700, marginBottom: "1rem", color: "#1e293b" }}>Nastavenia AI</h2>

        <p style={{ fontSize: "0.78rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>Anthropic API kľúč</p>
        <p style={{ fontSize: "0.75rem", color: "#64748b", marginBottom: "6px", lineHeight: 1.5 }}>
          Nájdeš na <a href="https://console.anthropic.com" target="_blank" rel="noreferrer" style={{ color: "#4f46e5" }}>console.anthropic.com</a> → API Keys.
        </p>
        <input
          type="password"
          value={val}
          onChange={e => setVal(e.target.value)}
          placeholder="sk-ant-..."
          style={{ width: "100%", border: "1.5px solid #e2e8f0", borderRadius: "0.5rem", padding: "0.6rem 0.8rem", fontSize: "0.875rem", outline: "none", marginBottom: "1rem" }}
          autoFocus
        />

        <p style={{ fontSize: "0.78rem", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>Cloudflare Worker URL <span style={{ fontWeight: 400, color: "#94a3b8" }}>(proxy pre CORS)</span></p>
        <p style={{ fontSize: "0.75rem", color: "#64748b", marginBottom: "6px", lineHeight: 1.5 }}>
          Povinné pre použitie z webu. Postup: <strong>cloudflare-worker.js</strong> v repozitári → nasaď na Cloudflare Workers → sem vlož URL.
        </p>
        <input
          type="url"
          value={proxy}
          onChange={e => setProxy(e.target.value)}
          placeholder="https://moj-proxy.username.workers.dev"
          style={{ width: "100%", border: "1.5px solid #e2e8f0", borderRadius: "0.5rem", padding: "0.6rem 0.8rem", fontSize: "0.875rem", outline: "none", marginBottom: "1.25rem" }}
        />

        <button
          onClick={() => canSave && onSave(val.trim(), proxy.trim())}
          disabled={!canSave}
          style={{ width: "100%", background: "#4f46e5", color: "#fff", border: "none", borderRadius: "0.5rem", padding: "0.65rem", fontWeight: 600, fontSize: "0.9rem", cursor: canSave ? "pointer" : "not-allowed", opacity: canSave ? 1 : 0.5 }}
        >
          Uložiť
        </button>
      </div>
    </div>
  );
}

function TodoRow({ todo, onToggle, onDelete, onChangeCategory, showCategory }) {
  const style = CATEGORY_STYLES[todo.category] ?? CATEGORY_STYLES["Iné"];
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: "0.625rem",
      padding: "0.6rem 0.875rem", borderRadius: "0.75rem", border: "1px solid",
      borderColor: todo.completed ? "#bbf7d0" : "#f1f5f9",
      background: todo.completed ? "rgba(240,253,244,0.7)" : "#fff",
      boxShadow: todo.completed ? "none" : "0 1px 3px rgba(0,0,0,0.06)",
      transition: "all 0.15s",
    }}>
      <button onClick={() => onToggle(todo.id)} style={{
        width: 22, height: 22, borderRadius: "50%", border: "2px solid",
        borderColor: todo.completed ? "#22c55e" : "#cbd5e1",
        background: todo.completed ? "#22c55e" : "#fff",
        color: "#fff", cursor: "pointer", flexShrink: 0,
        display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.15s",
      }}>
        {todo.completed && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>}
      </button>

      <span style={{
        flex: 1, fontSize: "0.75rem", lineHeight: 1.4,
        color: todo.completed ? "#94a3b8" : "#1e293b",
        textDecoration: todo.completed ? "line-through" : "none",
      }}>{todo.text}</span>

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

      <button onClick={() => onDelete(todo.id)} style={{
        background: "none", border: "none", cursor: "pointer",
        color: "#cbd5e1", padding: "2px", borderRadius: 4, flexShrink: 0,
        display: "flex", alignItems: "center",
      }}
        onMouseEnter={e => e.currentTarget.style.color = "#f43f5e"}
        onMouseLeave={e => e.currentTarget.style.color = "#cbd5e1"}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  );
}

function ReminderRow({ reminder, onDelete }) {
  const dt = new Date(reminder.datetime);
  const diffMs = dt.getTime() - Date.now();

  const timeLabel = (() => {
    if (reminder.fired || diffMs <= 0) return "Uplynulo";
    const m = Math.round(diffMs / 60000);
    if (m < 60) return `o ${m} min`;
    const h = Math.floor(diffMs / 3600000);
    if (h < 24) return `o ${h} h`;
    return `o ${Math.floor(diffMs / 86400000)} d`;
  })();

  const dateLabel = dt.toLocaleDateString("sk-SK", { day: "numeric", month: "long" }) +
    ", " + dt.toLocaleTimeString("sk-SK", { hour: "2-digit", minute: "2-digit" });

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: "0.625rem",
      padding: "0.7rem 0.875rem", borderRadius: "0.75rem", border: "1px solid",
      borderColor: reminder.fired ? "#bbf7d0" : "#f1f5f9",
      background: reminder.fired ? "rgba(240,253,244,0.7)" : "#fff",
      boxShadow: reminder.fired ? "none" : "0 1px 3px rgba(0,0,0,0.06)",
    }}>
      <div style={{ flexShrink: 0, color: reminder.fired ? "#22c55e" : "#4f46e5", display: "flex" }}>
        {reminder.fired
          ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
        }
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{
          fontSize: "0.8rem",
          color: reminder.fired ? "#94a3b8" : "#1e293b",
          textDecoration: reminder.fired ? "line-through" : "none",
          margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{reminder.text}</p>
        <p style={{ fontSize: "0.68rem", color: "#94a3b8", margin: 0, marginTop: "2px" }}>
          {dateLabel}{" · "}
          <span style={{ color: reminder.fired ? "#94a3b8" : "#4f46e5", fontWeight: 600 }}>
            {timeLabel}
          </span>
        </p>
      </div>

      <button onClick={() => onDelete(reminder.id)} style={{
        background: "none", border: "none", cursor: "pointer",
        color: "#cbd5e1", padding: "2px", borderRadius: 4, flexShrink: 0,
        display: "flex", alignItems: "center",
      }}
        onMouseEnter={e => e.currentTarget.style.color = "#f43f5e"}
        onMouseLeave={e => e.currentTarget.style.color = "#cbd5e1"}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  );
}

// ── Main App ─────────────────────────────────────────────────────

export default function App() {
  const [todos, setTodos] = useState([]);
  const [prefs, setPrefs] = useState({});
  const [hydrated, setHydrated] = useState(false);
  const [apiKey, setApiKey] = useState(null);
  const [showApiModal, setShowApiModal] = useState(false);
  const [input, setInput] = useState("");
  const [isScanning, setIsScanning] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);
  const [undoState, setUndoState] = useState(null);
  const [sortByCategory, setSortByCategory] = useState(true);
  const [activeTab, setActiveTab] = useState("zoznam");
  const [reminders, setReminders] = useState([]);
  const [remInput, setRemInput] = useState("");
  const [remDatetime, setRemDatetime] = useState("");
  const [notifPermission, setNotifPermission] = useState("default");
  const [pushEnabled, setPushEnabled] = useState(false);
  const [remError, setRemError] = useState(null);
  const [pushBusy, setPushBusy] = useState(false);

  const undoTimer = useRef(null);
  const cameraRef = useRef(null);
  const galleryRef = useRef(null);
  const remTimersRef = useRef({});
  const pushSubRef = useRef(null);
  const pushEnabledRef = useRef(false);

  const scheduleOne = useCallback((r) => {
    const diff = new Date(r.datetime).getTime() - Date.now();
    if (diff <= 0 || remTimersRef.current[r.id]) return;
    remTimersRef.current[r.id] = setTimeout(() => {
      delete remTimersRef.current[r.id];
      // Pri zapnutom push posiela upozornenie server (aj keď je appka zatvorená),
      // takže lokálne nezobrazujeme, aby neprišlo dvakrát.
      if (!pushEnabledRef.current) showReminderNotification(r.text);
      setReminders(prev => {
        const next = prev.map(x => x.id === r.id ? { ...x, fired: true } : x);
        localStorage.setItem(REMINDERS_KEY, JSON.stringify(next));
        return next;
      });
    }, diff);
  }, []);

  // Pošle aktuálny zoznam pripomienok + predplatné na Worker (KV)
  const syncReminders = useCallback(async (list, sub) => {
    const base = pushBase();
    const subscription = sub || pushSubRef.current;
    if (!base || !subscription) return;
    const payload = list
      .filter(r => !r.fired)
      .map(r => ({ id: r.id, text: r.text, time: new Date(r.datetime).getTime() }));
    try {
      await fetch(`${base}/push/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription, reminders: payload }),
      });
    } catch { /* ticho — skúsi sa znova pri ďalšej zmene */ }
  }, []);

  useEffect(() => {
    setTodos(loadJSON(STORAGE_KEY, []));
    setPrefs(loadJSON(PREFS_KEY, {}));
    const storedSortMode = localStorage.getItem(SORT_MODE_KEY);
    if (storedSortMode !== null) setSortByCategory(storedSortMode === "true");
    const key = localStorage.getItem(APIKEY_KEY);
    if (key) setApiKey(key);

    const perm = "Notification" in window ? Notification.permission : "denied";
    setNotifPermission(perm);
    const pe = localStorage.getItem(PUSH_ENABLED_KEY) === "true";
    setPushEnabled(pe);
    pushEnabledRef.current = pe;
    const now = Date.now();
    const stored = loadJSON(REMINDERS_KEY, []);
    let needsSave = false;
    const initialized = stored.map(r => {
      if (!r.fired && new Date(r.datetime).getTime() <= now) {
        // Pri zapnutom push už zmeškané poslal server — lokálne neopakujeme.
        if (!pe) showReminderNotification(r.text);
        needsSave = true;
        return { ...r, fired: true };
      }
      return r;
    });
    if (needsSave) localStorage.setItem(REMINDERS_KEY, JSON.stringify(initialized));
    setReminders(initialized);

    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    reminders.filter(r => !r.fired).forEach(scheduleOne);
    return () => {
      Object.values(remTimersRef.current).forEach(clearTimeout);
      remTimersRef.current = {};
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, scheduleOne]);

  useEffect(() => {
    if (hydrated) localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
  }, [todos, hydrated]);

  useEffect(() => { pushEnabledRef.current = pushEnabled; }, [pushEnabled]);

  // Pri štarte (ak je push zapnutý) obnov predplatné a zosynchronizuj zoznam
  useEffect(() => {
    if (!hydrated || !pushEnabled) return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.ready
      .then(reg => reg.pushManager.getSubscription())
      .then(sub => { if (sub) { pushSubRef.current = sub; syncReminders(reminders, sub); } })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, pushEnabled]);

  // Po každej zmene pripomienok pošli aktuálny zoznam na server
  useEffect(() => {
    if (hydrated && pushEnabled) syncReminders(reminders);
  }, [reminders, hydrated, pushEnabled, syncReminders]);

  const saveApiKey = (key, proxyUrl = "") => {
    localStorage.setItem(APIKEY_KEY, key);
    if (proxyUrl) localStorage.setItem(PROXY_KEY, proxyUrl);
    else localStorage.removeItem(PROXY_KEY);
    setApiKey(key);
    setShowApiModal(false);
  };

  const triggerUndo = useCallback((state) => {
    setUndoState(state);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndoState(null), 6000);
  }, []);

  const performUndo = () => {
    if (!undoState) return;
    setTodos(prev => {
      const next = [...prev];
      [...undoState.entries].sort((a, b) => a.index - b.index).forEach(({ todo, index }) => {
        next.splice(Math.min(index, next.length), 0, todo);
      });
      return next;
    });
    setUndoState(null);
    clearTimeout(undoTimer.current);
  };

  const addOne = async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    const id = crypto.randomUUID();
    const pref = prefs[normalize(text)];
    setTodos(prev => [{ id, text, completed: false, category: pref ?? "Iné" }, ...prev]);
    if (pref || !apiKey || !sortByCategory) return;
    try {
      const category = await categorizeItem(apiKey, text);
      setTodos(prev => prev.map(t => t.id === id ? { ...t, category } : t));
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
    if (!apiKey) { setShowApiModal(true); return; }
    setIsScanning(true);
    setErrorMsg(null);
    try {
      const { base64: base64Data, mimeType } = await resizeImage(file, 1600);
      const items = await scanImage(apiKey, mimeType, base64Data);
      if (!items.length) { setErrorMsg("Na obrázku som nenašiel žiadne položky."); return; }
      const newTodos = items.map(i => ({
        id: crypto.randomUUID(), text: i.text.trim(),
        completed: false, category: prefs[normalize(i.text)] ?? i.category,
      })).filter(t => t.text);
      setTodos(prev => [...newTodos, ...prev]);
    } catch (err) {
      setErrorMsg(err.message ?? "Skenovanie zlyhalo.");
    } finally {
      setIsScanning(false);
    }
  };

  const toggleTodo = id => setTodos(prev => prev.map(t => t.id === id ? { ...t, completed: !t.completed } : t));

  const deleteTodo = id => {
    const index = todos.findIndex(t => t.id === id);
    if (index === -1) return;
    const todo = todos[index];
    setTodos(prev => prev.filter(t => t.id !== id));
    triggerUndo({ message: `Vymazané: ${todo.text}`, entries: [{ todo, index }] });
  };

  const setCategory = (id, category) => {
    setTodos(prev => prev.map(t => t.id === id ? { ...t, category } : t));
    const todo = todos.find(t => t.id === id);
    if (!todo) return;
    const key = normalize(todo.text);
    if (!key) return;
    setPrefs(prev => { const next = { ...prev, [key]: category }; localStorage.setItem(PREFS_KEY, JSON.stringify(next)); return next; });
  };

  const clearCompleted = () => {
    const entries = todos.map((t, i) => ({ todo: t, index: i })).filter(e => e.todo.completed);
    if (!entries.length) return;
    setTodos(prev => prev.filter(t => !t.completed));
    triggerUndo({ message: `Vymazaných ${entries.length} hotových`, entries });
  };

  // Zapne upozornenia na pozadí (Web Push cez Cloudflare Worker)
  const enablePush = async () => {
    setRemError(null);
    const base = pushBase();
    if (!base) { setRemError("Najprv nastav Cloudflare Worker URL v nastaveniach (ozubené koliesko hore)."); return; }
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setRemError("Tento prehliadač nepodporuje upozornenia na pozadí.");
      return;
    }
    setPushBusy(true);
    try {
      const perm = await Notification.requestPermission();
      setNotifPermission(perm);
      if (perm !== "granted") { setRemError("Bez povolenia upozornení to nepôjde."); return; }

      const keyRes = await fetch(`${base}/push/key`);
      const { publicKey } = await keyRes.json();
      if (!publicKey) { setRemError("Worker nevrátil VAPID kľúč. Skontroluj nastavenie Workera (VAPID_PUBLIC)."); return; }

      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
      }
      pushSubRef.current = sub;
      localStorage.setItem(PUSH_ENABLED_KEY, "true");
      setPushEnabled(true);
      pushEnabledRef.current = true;
      await syncReminders(reminders, sub);
    } catch (e) {
      setRemError("Nepodarilo sa zapnúť upozornenia na pozadí: " + (e?.message ?? e));
    } finally {
      setPushBusy(false);
    }
  };

  const disablePush = async () => {
    setRemError(null);
    setPushBusy(true);
    try {
      const base = pushBase();
      const sub = pushSubRef.current || (await navigator.serviceWorker.ready.then(r => r.pushManager.getSubscription()).catch(() => null));
      // odhlás na serveri (prázdny zoznam) aj v prehliadači
      if (base && sub) {
        try {
          await fetch(`${base}/push/sync`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ subscription: sub, reminders: [] }),
          });
        } catch { /* ignore */ }
      }
      if (sub) { try { await sub.unsubscribe(); } catch { /* ignore */ } }
      pushSubRef.current = null;
      localStorage.removeItem(PUSH_ENABLED_KEY);
      setPushEnabled(false);
      pushEnabledRef.current = false;
    } finally {
      setPushBusy(false);
    }
  };

  const addReminder = () => {
    const text = remInput.trim();
    if (!text || !remDatetime) return;
    const r = { id: crypto.randomUUID(), text, datetime: remDatetime, fired: false };
    setReminders(prev => {
      const next = [...prev, r];
      localStorage.setItem(REMINDERS_KEY, JSON.stringify(next));
      return next;
    });
    scheduleOne(r);
    setRemInput("");
    setRemDatetime("");
  };

  const deleteReminder = useCallback((id) => {
    if (remTimersRef.current[id]) {
      clearTimeout(remTimersRef.current[id]);
      delete remTimersRef.current[id];
    }
    setReminders(prev => {
      const next = prev.filter(r => r.id !== id);
      localStorage.setItem(REMINDERS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const grouped = useMemo(() => {
    const active = todos.filter(t => !t.completed);
    const done = todos.filter(t => t.completed);
    if (!sortByCategory) {
      return { groups: active.length ? [{ category: null, items: active }] : [], done };
    }
    const byCategory = new Map(CATEGORIES.map(c => [c, []]));
    active.forEach(t => byCategory.get(t.category)?.push(t));
    return {
      groups: CATEGORIES.map(c => ({ category: c, items: byCategory.get(c) ?? [] })).filter(g => g.items.length),
      done,
    };
  }, [todos, sortByCategory]);

  const remaining = todos.filter(t => !t.completed).length;
  const pendingReminders = reminders.filter(r => !r.fired).length;
  const sortedReminders = [...reminders].sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

  const btnStyle = {
    background: "#f8fafc", border: "1px solid #e2e8f0", color: "#64748b",
    width: 36, height: 36, borderRadius: "0.5rem", cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
    transition: "background 0.1s",
  };

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(to bottom, #f8fafc, #f1f5f9)" }}>
      {showApiModal && <ApiKeyModal onSave={saveApiKey} />}

      <div style={{ maxWidth: 448, margin: "0 auto", padding: "1rem 1rem 6rem" }}>

        {/* Header */}
        <header style={{ marginBottom: "1.25rem", paddingTop: "0.5rem" }}>
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
            <div>
              <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem" }}>
                <h1 style={{ fontSize: "1.75rem", fontWeight: 800, color: "#1e293b", letterSpacing: "-0.03em" }}>Moje Úlohy</h1>
                <span style={{ fontSize: "0.65rem", fontWeight: 600, color: "#cbd5e1" }}>v{APP_VERSION}</span>
              </div>
              <p style={{ fontSize: "0.7rem", color: "#94a3b8", marginTop: "0.15rem" }}>
                {remaining} aktívnych · {todos.length - remaining} hotových
              </p>
            </div>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              {activeTab === "zoznam" && todos.some(t => t.completed) && (
                <button onClick={clearCompleted} style={{ fontSize: "0.7rem", color: "#94a3b8", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>
                  Vymazať hotové
                </button>
              )}
              <button onClick={() => setShowApiModal(true)} title="Nastavenia API kľúča" style={{ ...btnStyle, width: 30, height: 30 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
              </button>
            </div>
          </div>

          {activeTab === "zoznam" && (
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
          )}
        </header>

        {/* Tab bar */}
        <div style={{ display: "flex", borderRadius: "0.875rem", background: "#f1f5f9", padding: "4px", marginBottom: "1.25rem", gap: "4px" }}>
          {[["zoznam", "Zoznam"], ["pripomienky", "Pripomienky"]].map(([key, label]) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              style={{
                flex: 1, padding: "0.45rem 0", borderRadius: "0.625rem", border: "none",
                fontWeight: 600, fontSize: "0.8rem", cursor: "pointer",
                background: activeTab === key ? "#fff" : "transparent",
                color: activeTab === key ? "#1e293b" : "#94a3b8",
                boxShadow: activeTab === key ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                transition: "all 0.15s", display: "flex", alignItems: "center", justifyContent: "center", gap: "0.35rem",
              }}
            >
              {label}
              {key === "pripomienky" && pendingReminders > 0 && (
                <span style={{
                  background: "#4f46e5", color: "#fff",
                  borderRadius: 999, fontSize: "0.6rem", fontWeight: 700,
                  minWidth: 16, height: 16, display: "inline-flex", alignItems: "center", justifyContent: "center",
                  padding: "0 4px",
                }}>
                  {pendingReminders}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* ── Zoznam tab ── */}
        {activeTab === "zoznam" && (
          <>
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

            {/* Error */}
            {errorMsg && (
              <div style={{ marginBottom: "1rem", padding: "0.6rem 0.875rem", borderRadius: "0.75rem", background: "#fff1f2", border: "1px solid #fecdd3", color: "#be123c", fontSize: "0.78rem" }}>
                {errorMsg}
              </div>
            )}

            {/* No API key warning */}
            {!apiKey && !showApiModal && (
              <div style={{ marginBottom: "1rem", padding: "0.75rem 0.875rem", borderRadius: "0.75rem", background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", fontSize: "0.78rem", lineHeight: 1.5 }}>
                Bez API kľúča funguje manuálne pridávanie, ale nie skenovanie fotiek.{" "}
                <button onClick={() => setShowApiModal(true)} style={{ color: "#4f46e5", background: "none", border: "none", cursor: "pointer", textDecoration: "underline", fontSize: "inherit" }}>
                  Nastaviť kľúč
                </button>
              </div>
            )}

            {/* List */}
            <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
              {todos.length === 0 && !isScanning ? (
                <div style={{ textAlign: "center", paddingTop: "4rem" }}>
                  <p style={{ fontSize: "1rem", color: "#94a3b8" }}>Zoznam je prázdny</p>
                  <p style={{ fontSize: "0.75rem", color: "#94a3b8", marginTop: "0.25rem" }}>
                    {sortByCategory ? "Odfoť alebo vlož nákupný lístok" : "Pridaj svoju prvú úlohu"}
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
                          <TodoRow key={todo.id} todo={todo} onToggle={toggleTodo} onDelete={deleteTodo} onChangeCategory={setCategory} showCategory={sortByCategory} />
                        ))}
                      </div>
                    </section>
                  ))}
                  {grouped.done.length > 0 && (
                    <section>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.375rem", marginBottom: "0.5rem", paddingLeft: "0.25rem" }}>
                        <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#22c55e", flexShrink: 0 }} />
                        <span style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700, color: "#94a3b8" }}>Hotové</span>
                        <span style={{ fontSize: "0.65rem", color: "#cbd5e1" }}>· {grouped.done.length}</span>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                        {grouped.done.map(todo => (
                          <TodoRow key={todo.id} todo={todo} onToggle={toggleTodo} onDelete={deleteTodo} onChangeCategory={setCategory} showCategory={sortByCategory} />
                        ))}
                      </div>
                    </section>
                  )}
                </>
              )}
            </div>
          </>
        )}

        {/* ── Pripomienky tab ── */}
        {activeTab === "pripomienky" && (
          <div>
            {/* Upozornenia na pozadí (Web Push) */}
            <div style={{ marginBottom: "1rem", padding: "0.75rem 0.875rem", borderRadius: "0.75rem", background: pushEnabled ? "#ecfdf5" : "#f8fafc", border: `1px solid ${pushEnabled ? "#a7f3d0" : "#e2e8f0"}` }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", minWidth: 0 }}>
                  <span style={{ color: pushEnabled ? "#059669" : "#94a3b8", display: "flex", flexShrink: 0 }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
                  </span>
                  <span style={{ fontSize: "0.8rem", fontWeight: 600, color: pushEnabled ? "#047857" : "#475569" }}>
                    {pushEnabled ? "Upozornenia na pozadí sú zapnuté" : "Upozornenia na pozadí"}
                  </span>
                </div>
                <button
                  onClick={pushEnabled ? disablePush : enablePush}
                  disabled={pushBusy}
                  style={{
                    flexShrink: 0, border: "none", borderRadius: "0.5rem",
                    padding: "0.4rem 0.8rem", fontWeight: 600, fontSize: "0.75rem",
                    cursor: pushBusy ? "wait" : "pointer", opacity: pushBusy ? 0.6 : 1,
                    background: pushEnabled ? "#fff" : "#4f46e5",
                    color: pushEnabled ? "#64748b" : "#fff",
                    boxShadow: pushEnabled ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
                  }}
                >
                  {pushBusy ? "Moment…" : pushEnabled ? "Vypnúť" : "Zapnúť"}
                </button>
              </div>
              {!pushEnabled && (
                <p style={{ fontSize: "0.72rem", color: "#64748b", margin: 0, marginTop: "0.5rem", lineHeight: 1.5 }}>
                  Po zapnutí ťa appka upozorní v presný čas, aj keď ju máš zatvorenú. Najlepšie funguje, ak appku pridáš na plochu (Inštalovať).
                </p>
              )}
            </div>

            {/* Chyba / blokované upozornenia */}
            {(remError || notifPermission === "denied") && (
              <div style={{ marginBottom: "1rem", padding: "0.6rem 0.875rem", borderRadius: "0.75rem", background: "#fff1f2", border: "1px solid #fecdd3", color: "#be123c", fontSize: "0.78rem", lineHeight: 1.5 }}>
                {remError || "Upozornenia sú zablokované. Povoľ ich v nastaveniach prehliadača."}
              </div>
            )}

            {/* Add form */}
            <div style={{ background: "#fff", borderRadius: "0.875rem", border: "1px solid #e2e8f0", padding: "1rem", marginBottom: "1.25rem", boxShadow: "0 1px 4px rgba(0,0,0,0.06)" }}>
              <input
                type="text"
                value={remInput}
                onChange={e => setRemInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addReminder(); } }}
                placeholder="Čo ti mám pripomenúť?"
                style={{ width: "100%", border: "1.5px solid #e2e8f0", borderRadius: "0.5rem", padding: "0.5rem 0.75rem", fontSize: "0.875rem", outline: "none", marginBottom: "0.625rem", boxSizing: "border-box" }}
              />
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <input
                  type="datetime-local"
                  value={remDatetime}
                  onChange={e => setRemDatetime(e.target.value)}
                  style={{ flex: 1, border: "1.5px solid #e2e8f0", borderRadius: "0.5rem", padding: "0.5rem 0.625rem", fontSize: "0.875rem", outline: "none", minWidth: 0, color: "#1e293b" }}
                />
                <button
                  onClick={addReminder}
                  disabled={!remInput.trim() || !remDatetime}
                  style={{
                    background: "#4f46e5", color: "#fff", border: "none", borderRadius: "0.5rem",
                    padding: "0.5rem 1rem", fontWeight: 600, fontSize: "0.875rem",
                    cursor: remInput.trim() && remDatetime ? "pointer" : "not-allowed",
                    opacity: remInput.trim() && remDatetime ? 1 : 0.5, whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                >
                  Pridať
                </button>
              </div>
            </div>

            {/* Reminders list */}
            {reminders.length === 0 ? (
              <div style={{ textAlign: "center", paddingTop: "3rem" }}>
                <p style={{ fontSize: "1rem", color: "#94a3b8" }}>Žiadne pripomienky</p>
                <p style={{ fontSize: "0.75rem", color: "#94a3b8", marginTop: "0.25rem" }}>Pridaj svoju prvú pripomienku vyššie</p>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {sortedReminders.map(r => (
                  <ReminderRow key={r.id} reminder={r} onDelete={deleteReminder} />
                ))}
              </div>
            )}
          </div>
        )}
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
