import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { CATEGORIES, categorizeText, scanList, type Category } from "@/lib/scan.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Moje Úlohy – Farebný zoznam" },
      { name: "description", content: "Inteligentný nákupný a úlohový zoznam s rozpoznávaním fotky a automatickou kategorizáciou." },
    ],
  }),
  component: TodoApp,
});

interface Todo {
  id: string;
  text: string;
  completed: boolean;
  category: Category;
}

const CATEGORY_STYLES: Record<Category, { dot: string; chip: string }> = {
  "Ovocie a zelenina":      { dot: "bg-emerald-500", chip: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  "Mliečne výrobky":        { dot: "bg-sky-400",     chip: "bg-sky-50 text-sky-700 border-sky-200" },
  "Mäso a ryby":            { dot: "bg-rose-500",    chip: "bg-rose-50 text-rose-700 border-rose-200" },
  "Pečivo":                 { dot: "bg-amber-500",   chip: "bg-amber-50 text-amber-700 border-amber-200" },
  "Cestoviny, ryža, múka":  { dot: "bg-yellow-500",  chip: "bg-yellow-50 text-yellow-800 border-yellow-200" },
  "Konzervy a omáčky":      { dot: "bg-orange-500",  chip: "bg-orange-50 text-orange-700 border-orange-200" },
  "Sladkosti a snacky":     { dot: "bg-pink-500",    chip: "bg-pink-50 text-pink-700 border-pink-200" },
  "Nápoje":                 { dot: "bg-cyan-500",    chip: "bg-cyan-50 text-cyan-700 border-cyan-200" },
  "Mrazené":                { dot: "bg-indigo-400",  chip: "bg-indigo-50 text-indigo-700 border-indigo-200" },
  "Drogéria a domácnosť":   { dot: "bg-violet-500",  chip: "bg-violet-50 text-violet-700 border-violet-200" },
  "Iné":                    { dot: "bg-slate-400",   chip: "bg-slate-100 text-slate-700 border-slate-200" },
};

const STORAGE_KEY = "todos-v2";
const PREFS_KEY = "category-prefs-v1";

// ——— Preferences (text -> category) ————————————————————————————

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function loadPrefs(): Record<string, Category> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, Category> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && (CATEGORIES as readonly string[]).includes(v)) {
        out[k] = v as Category;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function savePrefs(prefs: Record<string, Category>) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

// ——— Todos persistence ———————————————————————————————————————

function loadTodos(): Todo[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((t) => ({
      id: String(t.id ?? crypto.randomUUID()),
      text: String(t.text ?? ""),
      completed: Boolean(t.completed),
      category: (CATEGORIES as readonly string[]).includes(t.category) ? t.category : "Iné",
    }));
  } catch {
    return [];
  }
}

interface UndoState {
  message: string;
  entries: Array<{ todo: Todo; index: number }>;
}

function TodoApp() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [prefs, setPrefs] = useState<Record<string, Category>>({});
  const [hydrated, setHydrated] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [isScanning, setIsScanning] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [undoState, setUndoState] = useState<UndoState | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cameraInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);

  const scan = useServerFn(scanList);
  const categorize = useServerFn(categorizeText);

  useEffect(() => {
    setTodos(loadTodos());
    setPrefs(loadPrefs());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
  }, [todos, hydrated]);

  useEffect(() => {
    return () => {
      if (undoTimer.current) clearTimeout(undoTimer.current);
    };
  }, []);

  const triggerUndo = useCallback((state: UndoState) => {
    setUndoState(state);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndoState(null), 6000);
  }, []);

  const performUndo = () => {
    if (!undoState) return;
    setTodos((prev) => {
      const next = [...prev];
      // Insert in ascending index order so positions stay correct
      const sorted = [...undoState.entries].sort((a, b) => a.index - b.index);
      for (const { todo, index } of sorted) {
        next.splice(Math.min(index, next.length), 0, todo);
      }
      return next;
    });
    setUndoState(null);
    if (undoTimer.current) clearTimeout(undoTimer.current);
  };

  const applyPref = useCallback(
    (text: string, fallback: Category): Category => {
      const key = normalizeText(text);
      return prefs[key] ?? fallback;
    },
    [prefs],
  );

  const addOne = async () => {
    const text = inputValue.trim();
    if (!text) return;
    setInputValue("");
    const id = crypto.randomUUID();
    const pref = prefs[normalizeText(text)];
    setTodos((prev) => [{ id, text, completed: false, category: pref ?? "Iné" }, ...prev]);
    if (pref) return;
    try {
      const { category } = await categorize({ data: { text } });
      setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, category } : t)));
    } catch {
      // keep "Iné"
    }
  };

  const addMany = (items: Array<{ text: string; category: Category }>) => {
    const cleaned = items
      .map((i) => ({ text: i.text.trim(), category: applyPref(i.text, i.category) }))
      .filter((i) => i.text.length > 0)
      .map((i) => ({ id: crypto.randomUUID(), text: i.text, completed: false, category: i.category }));
    setTodos((prev) => [...cleaned, ...prev]);
  };

  const toggleTodo = (id: string) =>
    setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, completed: !t.completed } : t)));

  const setCategory = (id: string, category: Category) => {
    setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, category } : t)));
    const todo = todos.find((t) => t.id === id);
    if (!todo) return;
    const key = normalizeText(todo.text);
    if (!key) return;
    setPrefs((prev) => {
      const next = { ...prev, [key]: category };
      savePrefs(next);
      return next;
    });
  };

  const deleteTodo = (id: string) => {
    const index = todos.findIndex((t) => t.id === id);
    if (index === -1) return;
    const todo = todos[index];
    setTodos((prev) => prev.filter((t) => t.id !== id));
    triggerUndo({ message: `Vymazané: ${todo.text}`, entries: [{ todo, index }] });
  };

  const clearCompleted = () => {
    const entries: Array<{ todo: Todo; index: number }> = [];
    todos.forEach((t, i) => {
      if (t.completed) entries.push({ todo: t, index: i });
    });
    if (!entries.length) return;
    setTodos((prev) => prev.filter((t) => !t.completed));
    triggerUndo({ message: `Vymazaných ${entries.length} hotových`, entries });
  };

  const handleImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setIsScanning(true);
    setErrorMsg(null);
    try {
      const base64Data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(",")[1] ?? "");
        reader.onerror = () => reject(new Error("Nepodarilo sa načítať súbor."));
        reader.readAsDataURL(file);
      });
      const { items } = await scan({ data: { mimeType: file.type, base64Data } });
      if (!items.length) setErrorMsg("Na obrázku som nenašiel žiadne položky.");
      addMany(items);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Skenovanie zlyhalo.");
    } finally {
      setIsScanning(false);
    }
  };

  const grouped = useMemo(() => {
    const active = todos.filter((t) => !t.completed);
    const done = todos.filter((t) => t.completed);
    const byCategory = new Map<Category, Todo[]>();
    for (const cat of CATEGORIES) byCategory.set(cat, []);
    for (const t of active) byCategory.get(t.category)?.push(t);
    return {
      groups: CATEGORIES.map((c) => ({ category: c, items: byCategory.get(c) ?? [] })).filter((g) => g.items.length),
      done,
    };
  }, [todos]);

  const remaining = todos.filter((t) => !t.completed).length;

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100">
      <div className="max-w-md mx-auto flex flex-col p-4 md:p-6">
        <header className="mb-5 pt-2 flex items-end justify-between">
          <div>
            <h1 className="text-3xl font-bold text-slate-800 tracking-tight">Moje Úlohy</h1>
            <p className="text-xs text-slate-500 mt-1">
              {remaining} aktívnych · {todos.length - remaining} hotových
            </p>
          </div>
          {todos.some((t) => t.completed) && (
            <button
              onClick={clearCompleted}
              className="text-xs text-slate-500 hover:text-rose-600 underline-offset-2 hover:underline"
            >
              Vymazať hotové
            </button>
          )}
        </header>

        {/* Input */}
        <div className="sticky top-3 z-20 mb-5 bg-white/90 backdrop-blur p-1.5 rounded-xl shadow-md border border-slate-200">
          <div className="flex gap-1.5 items-center">
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void addOne();
                }
              }}
              placeholder={isScanning ? "Spracovávam…" : "Pridať úlohu…"}
              disabled={isScanning}
              className="flex-1 bg-transparent px-3 py-2 text-base outline-none placeholder:text-slate-400 disabled:opacity-50 min-w-0"
            />

            <div className="flex gap-1">
              <input type="file" accept="image/*" capture="environment" className="hidden" ref={cameraInputRef} onChange={handleImage} />
              <input type="file" accept="image/*" className="hidden" ref={galleryInputRef} onChange={handleImage} />

              <IconBtn title="Odfotiť" onClick={() => cameraInputRef.current?.click()} disabled={isScanning}>
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-5.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Z" />
                </svg>
              </IconBtn>

              <IconBtn title="Z galérie" onClick={() => galleryInputRef.current?.click()} disabled={isScanning}>
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6.75a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6.75v10.5a1.5 1.5 0 0 0 1.5 1.5Z" />
                </svg>
              </IconBtn>

              <button
                onClick={() => void addOne()}
                disabled={isScanning}
                className="bg-indigo-600 hover:bg-indigo-700 text-white w-9 h-9 rounded-lg flex items-center justify-center transition-transform active:scale-95 shadow-sm disabled:opacity-50"
                aria-label="Pridať"
              >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor" className="w-5 h-5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        {isScanning && (
          <div className="mb-4 flex items-center justify-center gap-2 text-indigo-600 font-medium text-sm">
            <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
            </svg>
            Spracovávam zoznam…
          </div>
        )}

        {errorMsg && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-sm">
            {errorMsg}
          </div>
        )}

        <div className="space-y-5 pb-24">
          {todos.length === 0 && !isScanning ? (
            <div className="text-center py-16">
              <p className="text-lg text-slate-400">Zoznam je prázdny</p>
              <p className="text-xs text-slate-400 mt-1">Odfoť alebo vlož nákupný lístok</p>
            </div>
          ) : (
            <>
              {grouped.groups.map(({ category, items }) => {
                const style = CATEGORY_STYLES[category];
                return (
                  <section key={category}>
                    <div className="flex items-center gap-2 mb-2 px-1">
                      <span className={`w-2 h-2 rounded-full ${style.dot}`} />
                      <h2 className="text-[11px] uppercase tracking-wider font-semibold text-slate-500">
                        {category}
                      </h2>
                      <span className="text-[11px] text-slate-400">· {items.length}</span>
                    </div>
                    <div className="space-y-2">
                      {items.map((todo) => (
                        <TodoRow
                          key={todo.id}
                          todo={todo}
                          onToggle={toggleTodo}
                          onDelete={deleteTodo}
                          onChangeCategory={setCategory}
                        />
                      ))}
                    </div>
                  </section>
                );
              })}

              {grouped.done.length > 0 && (
                <section>
                  <div className="flex items-center gap-2 mb-2 px-1">
                    <span className="w-2 h-2 rounded-full bg-green-500" />
                    <h2 className="text-[11px] uppercase tracking-wider font-semibold text-slate-500">
                      Hotové
                    </h2>
                    <span className="text-[11px] text-slate-400">· {grouped.done.length}</span>
                  </div>
                  <div className="space-y-2">
                    {grouped.done.map((todo) => (
                      <TodoRow
                        key={todo.id}
                        todo={todo}
                        onToggle={toggleTodo}
                        onDelete={deleteTodo}
                        onChangeCategory={setCategory}
                      />
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
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-30 w-[min(92vw,28rem)]">
          <div className="flex items-center gap-3 bg-slate-900 text-white px-4 py-3 rounded-xl shadow-lg border border-slate-800">
            <span className="flex-1 text-sm truncate">{undoState.message}</span>
            <button
              onClick={performUndo}
              className="text-indigo-300 hover:text-indigo-200 font-semibold text-sm px-2 py-1 -mr-1"
            >
              Vrátiť
            </button>
            <button
              onClick={() => setUndoState(null)}
              aria-label="Zavrieť"
              className="text-slate-400 hover:text-white"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function IconBtn({
  children,
  onClick,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className="bg-slate-50 hover:bg-slate-100 text-slate-500 w-9 h-9 rounded-lg flex items-center justify-center transition-all active:scale-95 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function TodoRow({
  todo,
  onToggle,
  onDelete,
  onChangeCategory,
}: {
  todo: Todo;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onChangeCategory: (id: string, category: Category) => void;
}) {
  const style = CATEGORY_STYLES[todo.category];
  return (
    <div
      className={`group flex items-center gap-3 px-4 py-3 rounded-xl transition-all border ${
        todo.completed ? "bg-green-50/60 border-green-100" : "bg-white border-slate-100 shadow-sm"
      }`}
    >
      <button
        onClick={() => onToggle(todo.id)}
        className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-colors flex-shrink-0 ${
          todo.completed ? "bg-green-500 border-green-500 text-white" : "border-slate-300 bg-white"
        }`}
        aria-label={todo.completed ? "Označiť ako neukončené" : "Označiť ako hotové"}
      >
        {todo.completed && (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
            <path
              fillRule="evenodd"
              d="M19.916 4.626a.75.75 0 0 1 .208 1.04l-9 13.5a.75.75 0 0 1-1.154.114l-6-6a.75.75 0 0 1 1.06-1.06l5.353 5.353 8.493-12.739a.75.75 0 0 1 1.04-.208Z"
              clipRule="evenodd"
            />
          </svg>
        )}
      </button>

      <span
        className={`flex-1 text-[12px] ${
          todo.completed ? "line-through text-slate-400" : "text-slate-800"
        }`}
      >
        {todo.text}
      </span>

      {/* Category chip with native select for category change */}
      <label
        className={`relative inline-flex items-center gap-1 text-[9px] font-medium px-1.5 py-0.5 rounded-full border cursor-pointer ${style.chip} ${
          todo.completed ? "opacity-60" : ""
        }`}
        title="Zmeniť kategóriu"
      >
        <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
        <span className="hidden sm:inline">{todo.category}</span>
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3 opacity-60">
          <path fillRule="evenodd" d="M12 15.5 5.5 9h13L12 15.5Z" clipRule="evenodd" />
        </svg>
        <select
          value={todo.category}
          onChange={(e) => onChangeCategory(todo.id, e.target.value as Category)}
          className="absolute inset-0 opacity-0 cursor-pointer"
          aria-label="Zmeniť kategóriu"
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>

      <button
        onClick={() => onDelete(todo.id)}
        className="text-slate-300 hover:text-rose-500 transition-colors sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100"
        aria-label="Vymazať"
      >
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
