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

const STORAGE_KEY = "todos-v3";
const PREFS_KEY = "category-prefs-v2";
const APIKEY_KEY = "anthropic-api-key";
const SORT_MODE_KEY = "sort-by-category-v1";

function normalize(text) {
  return text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]+/g, " ").trim();
}

function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

// ── Anthropic API helpers ────────────────────────────────────────

async function callAnthropic(apiKey, messages, system = null, maxTokens = 512) {
  const body = { model: "claude-haiku-4-5-20251001", max_tokens: maxTokens, messages };
  if (system) body.system = system;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "anthropic-dangerous-direct-browser-calls": "true",
    },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new Error("Neplatný API kľúč. Skontroluj ho v nastaveniach.");
  if (res.status === 429) throw new Error("Príliš veľa požiadaviek. Skús neskôr.");
  if (!res.ok) { const t = await res.text().catch(() => ""); throw new Error(`API chyba ${res.status}: ${t}`); }
  return res.json();
}

async function scanImage(apiKey, mimeType, base64Data) {
  const prompt = `Prečítaj tento nákupný zoznam a extrahuj všetky položky. Pre každú urči kategóriu z: ${CATEGORIES.join(", ")}. Odpovedz LEN validným JSON poľom bez markdown, napr: [{"text":"mlieko","category":"Mliečne výrobky"}]`;
  const data = await callAnthropic(apiKey, [{
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: mimeType, data: base64Data } },
      { type: "text", text: prompt },
    ],
  }], null, 1024);
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
  const [val, setVal] = useState("");
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: "1rem" }}>
      <div style={{ background: "#fff", borderRadius: "1rem", padding: "1.5rem", maxWidth: 400, width: "100%", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
        <h2 style={{ fontSize: "1.125rem", fontWeight: 700, marginBottom: "0.5rem", color: "#1e293b" }}>Nastav Anthropic API kľúč</h2>
        <p style={{ fontSize: "0.8rem", color: "#64748b", marginBottom: "1rem", lineHeight: 1.5 }}>
          Kľúč nájdeš na <a href="https://console.anthropic.com" target="_blank" rel="noreferrer" style={{ color: "#4f46e5" }}>console.anthropic.com</a> → API Keys. Ukladá sa len v tvojom prehliadači.
        </p>
        <input
          type="password"
          value={val}
          onChange={e => setVal(e.target.value)}
          onKeyDown={e => e.key === "Enter" && val.trim() && onSave(val.trim())}
          placeholder="sk-ant-..."
          style={{ width: "100%", border: "1.5px solid #e2e8f0", borderRadius: "0.5rem", padding: "0.6rem 0.8rem", fontSize: "0.875rem", outline: "none", marginBottom: "1rem" }}
          autoFocus
        />
        <button
          onClick={() => val.trim() && onSave(val.trim())}
          disabled={!val.trim()}
          style={{ width: "100%", background: "#4f46e5", color: "#fff", border: "none", borderRadius: "0.5rem", padding: "0.65rem", fontWeight: 600, fontSize: "0.9rem", cursor: val.trim() ? "pointer" : "not-allowed", opacity: val.trim() ? 1 : 0.5 }}
        >
          Uložiť a pokračovať
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
      {/* Checkbox */}
      <button onClick={() => onToggle(todo.id)} style={{
        width: 22, height: 22, borderRadius: "50%", border: "2px solid",
        borderColor: todo.completed ? "#22c55e" : "#cbd5e1",
        background: todo.completed ? "#22c55e" : "#fff",
        color: "#fff", cursor: "pointer", flexShrink: 0,
        display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.15s",
      }}>
        {todo.completed && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>}
      </button>

      {/* Text */}
      <span style={{
        flex: 1, fontSize: "0.75rem", lineHeight: 1.4,
        color: todo.completed ? "#94a3b8" : "#1e293b",
        textDecoration: todo.completed ? "line-through" : "none",
      }}>{todo.text}</span>

      {/* Category chip */}
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

      {/* Delete */}
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
  const undoTimer = useRef(null);
  const cameraRef = useRef(null);
  const galleryRef = useRef(null);

  useEffect(() => {
    setTodos(loadJSON(STORAGE_KEY, []));
    setPrefs(loadJSON(PREFS_KEY, {}));
    const storedSortMode = localStorage.getItem(SORT_MODE_KEY);
    if (storedSortMode !== null) setSortByCategory(storedSortMode === "true");
    const key = localStorage.getItem(APIKEY_KEY);
    if (key) setApiKey(key);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
  }, [todos, hydrated]);

  const saveApiKey = (key) => {
    localStorage.setItem(APIKEY_KEY, key);
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
    } catch { /* keep Iné */ }
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
      const base64Data = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result.split(",")[1] ?? "");
        r.onerror = () => rej(new Error("Nepodarilo sa načítať súbor."));
        r.readAsDataURL(file);
      });
      const items = await scanImage(apiKey, file.type, base64Data);
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
              <h1 style={{ fontSize: "1.75rem", fontWeight: 800, color: "#1e293b", letterSpacing: "-0.03em" }}>Moje Úlohy</h1>
              <p style={{ fontSize: "0.7rem", color: "#94a3b8", marginTop: "0.15rem" }}>
                {remaining} aktívnych · {todos.length - remaining} hotových
              </p>
            </div>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              {todos.some(t => t.completed) && (
                <button onClick={clearCompleted} style={{ fontSize: "0.7rem", color: "#94a3b8", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>
                  Vymazať hotové
                </button>
              )}
              <button onClick={() => setShowApiModal(true)} title="Nastavenia API kľúča" style={{ ...btnStyle, width: 30, height: 30 }}>
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

        {/* Error */}
        {errorMsg && (
          <div style={{ marginBottom: "1rem", padding: "0.6rem 0.875rem", borderRadius: "0.75rem", background: "#fff1f2", border: "1px solid #fecdd3", color: "#be123c", fontSize: "0.78rem" }}>
            {errorMsg}
          </div>
        )}

        {/* No API key warning */}
        {!apiKey && !showApiModal && (
          <div style={{ marginBottom: "1rem", padding: "0.75rem 0.875rem", borderRadius: "0.75rem", background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", fontSize: "0.78rem", lineHeight: 1.5 }}>
            ⚠️ Bez API kľúča funguje manuálne pridávanie, ale nie skenovanie fotiek.{" "}
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
