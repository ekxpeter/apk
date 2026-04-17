import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import {
  Facebook,
  LogOut,
  Plus,
  Trash2,
  Loader2,
  ChevronDown,
  ChevronUp,
  Zap,
  MessageCircle,
  UserPlus,
  CheckCircle,
  XCircle,
  ThumbsUp,
  Heart,
  Laugh,
  Settings2,
  Play,
  X,
  Menu,
  Sun,
  Moon,
  Users,
  Shield,
  Code2,
  ExternalLink,
  CalendarDays,
  Activity,
  Star,
  Info,
} from "lucide-react";

type CookieType = "fra" | "rpw" | "normal";
type ReactionType = "LIKE" | "LOVE" | "HAHA" | "WOW" | "SAD" | "ANGRY";
type ActionType = "react" | "comment" | "follow";

type Account = {
  id: number;
  label: string;
  cookie_type: CookieType;
  fb_user_id: string;
  fb_name: string;
  is_active: boolean;
  created_at: string;
};

type AccountsData = {
  fra: Account[];
  rpw: Account[];
  normal: Account[];
  total: number;
};

type ActionResult = {
  success: number;
  failed: number;
  total: number;
  message: string;
  details: string[];
};

type AppUser = {
  id: number;
  username: string;
  created_at: string;
};

function useDarkMode() {
  const [dark, setDark] = useState(() => {
    if (typeof window === "undefined") return false;
    const stored = localStorage.getItem("fbhandling-theme");
    if (stored) return stored === "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });

  useEffect(() => {
    const root = document.documentElement;
    if (dark) {
      root.classList.add("dark");
      localStorage.setItem("fbhandling-theme", "dark");
    } else {
      root.classList.remove("dark");
      localStorage.setItem("fbhandling-theme", "light");
    }
  }, [dark]);

  return [dark, setDark] as const;
}

const TYPE_META: Record<CookieType, { label: string; color: string; bg: string; border: string; dot: string; darkBg: string; darkBorder: string; darkColor: string }> = {
  fra: {
    label: "FRA",
    color: "text-purple-700",
    bg: "bg-purple-50",
    border: "border-purple-200",
    dot: "bg-purple-500",
    darkBg: "dark:bg-purple-950/40",
    darkBorder: "dark:border-purple-800",
    darkColor: "dark:text-purple-300",
  },
  rpw: {
    label: "RPW",
    color: "text-amber-700",
    bg: "bg-amber-50",
    border: "border-amber-200",
    dot: "bg-amber-500",
    darkBg: "dark:bg-amber-950/40",
    darkBorder: "dark:border-amber-800",
    darkColor: "dark:text-amber-300",
  },
  normal: {
    label: "Normal",
    color: "text-blue-700",
    bg: "bg-blue-50",
    border: "border-blue-200",
    dot: "bg-blue-500",
    darkBg: "dark:bg-blue-950/40",
    darkBorder: "dark:border-blue-800",
    darkColor: "dark:text-blue-300",
  },
};

const REACTIONS: Array<{ type: ReactionType; label: string; icon: React.ReactNode; color: string; darkColor: string }> = [
  { type: "LIKE",  label: "Like",  icon: <ThumbsUp className="w-4 h-4" />,  color: "bg-blue-100 text-blue-700 border-blue-300",    darkColor: "dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-700" },
  { type: "LOVE",  label: "Love",  icon: <Heart className="w-4 h-4" />,      color: "bg-red-100 text-red-700 border-red-300",       darkColor: "dark:bg-red-900/40 dark:text-red-300 dark:border-red-700" },
  { type: "HAHA",  label: "Haha",  icon: <Laugh className="w-4 h-4" />,      color: "bg-yellow-100 text-yellow-700 border-yellow-300", darkColor: "dark:bg-yellow-900/40 dark:text-yellow-300 dark:border-yellow-700" },
  { type: "WOW",   label: "Wow",   icon: <Zap className="w-4 h-4" />,        color: "bg-yellow-100 text-yellow-700 border-yellow-300", darkColor: "dark:bg-yellow-900/40 dark:text-yellow-300 dark:border-yellow-700" },
  { type: "SAD",   label: "Sad",   icon: <MessageCircle className="w-4 h-4" />, color: "bg-indigo-100 text-indigo-700 border-indigo-300", darkColor: "dark:bg-indigo-900/40 dark:text-indigo-300 dark:border-indigo-700" },
  { type: "ANGRY", label: "Angry", icon: <Activity className="w-4 h-4" />,   color: "bg-orange-100 text-orange-700 border-orange-300", darkColor: "dark:bg-orange-900/40 dark:text-orange-300 dark:border-orange-700" },
];

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

function BurgerMenu({
  open,
  onClose,
  dark,
  onToggleDark,
  currentUser,
}: {
  open: boolean;
  onClose: () => void;
  dark: boolean;
  onToggleDark: () => void;
  currentUser: { id: number; username: string } | null;
}) {
  const [users, setUsers] = useState<AppUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [activeSection, setActiveSection] = useState<"users" | "about" | null>(null);

  useEffect(() => {
    if (open) {
      setUsersLoading(true);
      fetch("/api/admin/users", { credentials: "include" })
        .then(r => r.ok ? r.json() : { users: [] })
        .then(d => setUsers(d.users ?? []))
        .catch(() => setUsers([]))
        .finally(() => setUsersLoading(false));
    }
  }, [open]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    if (open) document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/50 backdrop-blur-sm z-40 transition-opacity duration-300 ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={onClose}
      />
      <div
        className={`fixed top-0 right-0 h-full w-80 max-w-[90vw] z-50 flex flex-col transition-transform duration-300 ease-in-out shadow-2xl ${open ? "translate-x-0" : "translate-x-full"} bg-white dark:bg-gray-900`}
      >
        <div className="flex items-center justify-between px-5 py-4 bg-[#1877F2] flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <Menu className="w-5 h-5 text-white" />
            <span className="text-white font-bold text-base">Menu</span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="p-4 space-y-3">

            <div className="flex items-center justify-between px-4 py-3 rounded-2xl border border-slate-200 dark:border-gray-700 bg-slate-50 dark:bg-gray-800">
              <div className="flex items-center gap-3">
                {dark ? <Moon className="w-5 h-5 text-indigo-400" /> : <Sun className="w-5 h-5 text-amber-500" />}
                <div>
                  <div className="text-sm font-bold text-slate-700 dark:text-slate-200">
                    {dark ? "Dark Mode" : "Light Mode"}
                  </div>
                  <div className="text-[10px] text-slate-400 dark:text-slate-500">Toggle appearance</div>
                </div>
              </div>
              <button
                onClick={onToggleDark}
                className={`relative w-12 h-6 rounded-full transition-colors duration-300 focus:outline-none ${dark ? "bg-indigo-500" : "bg-slate-300"}`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-md transition-transform duration-300 flex items-center justify-center ${dark ? "translate-x-6" : "translate-x-0"}`}
                >
                  {dark
                    ? <Moon className="w-3 h-3 text-indigo-500" />
                    : <Sun className="w-3 h-3 text-amber-500" />
                  }
                </span>
              </button>
            </div>

            <div className="rounded-2xl border border-slate-200 dark:border-gray-700 overflow-hidden">
              <button
                onClick={() => setActiveSection(s => s === "users" ? null : "users")}
                className="w-full flex items-center justify-between px-4 py-3 bg-slate-50 dark:bg-gray-800 hover:bg-slate-100 dark:hover:bg-gray-750 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <Users className="w-5 h-5 text-[#1877F2]" />
                  <div className="text-left">
                    <div className="text-sm font-bold text-slate-700 dark:text-slate-200">Registered Users</div>
                    <div className="text-[10px] text-slate-400 dark:text-slate-500">{users.length} accounts on this panel</div>
                  </div>
                </div>
                {activeSection === "users"
                  ? <ChevronUp className="w-4 h-4 text-slate-400" />
                  : <ChevronDown className="w-4 h-4 text-slate-400" />
                }
              </button>
              {activeSection === "users" && (
                <div className="border-t border-slate-100 dark:border-gray-700 bg-white dark:bg-gray-900">
                  {usersLoading ? (
                    <div className="flex justify-center py-6">
                      <Loader2 className="w-5 h-5 text-[#1877F2] animate-spin" />
                    </div>
                  ) : users.length === 0 ? (
                    <div className="py-4 text-center text-xs text-slate-400">No users found</div>
                  ) : (
                    <div className="divide-y divide-slate-50 dark:divide-gray-800 max-h-56 overflow-y-auto">
                      {users.map((u, i) => (
                        <div key={u.id} className="flex items-center gap-3 px-4 py-2.5">
                          <div className="w-7 h-7 rounded-full bg-[#1877F2] flex items-center justify-center flex-shrink-0">
                            <span className="text-white font-bold text-xs">{u.username[0]?.toUpperCase()}</span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="text-xs font-bold text-slate-700 dark:text-slate-200 truncate">{u.username}</span>
                              {u.id === currentUser?.id && (
                                <span className="text-[9px] font-bold text-[#1877F2] bg-blue-50 dark:bg-blue-900/30 px-1.5 py-0.5 rounded-full">you</span>
                              )}
                            </div>
                            <div className="flex items-center gap-1 text-[10px] text-slate-400">
                              <CalendarDays className="w-2.5 h-2.5" />
                              {formatDate(u.created_at)}
                            </div>
                          </div>
                          <span className="text-[10px] text-slate-300 dark:text-gray-600">#{i + 1}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-slate-200 dark:border-gray-700 overflow-hidden">
              <button
                onClick={() => setActiveSection(s => s === "about" ? null : "about")}
                className="w-full flex items-center justify-between px-4 py-3 bg-slate-50 dark:bg-gray-800 hover:bg-slate-100 dark:hover:bg-gray-750 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <Info className="w-5 h-5 text-[#1877F2]" />
                  <div className="text-left">
                    <div className="text-sm font-bold text-slate-700 dark:text-slate-200">About</div>
                    <div className="text-[10px] text-slate-400 dark:text-slate-500">Created by Team Devx</div>
                  </div>
                </div>
                {activeSection === "about"
                  ? <ChevronUp className="w-4 h-4 text-slate-400" />
                  : <ChevronDown className="w-4 h-4 text-slate-400" />
                }
              </button>
              {activeSection === "about" && (
                <div className="border-t border-slate-100 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 space-y-4">
                  <div className="flex items-center gap-3 p-3 rounded-xl bg-gradient-to-r from-[#1877F2]/10 to-blue-50 dark:from-[#1877F2]/20 dark:to-blue-950/30 border border-blue-100 dark:border-blue-900">
                    <div className="w-10 h-10 rounded-xl bg-[#1877F2] flex items-center justify-center flex-shrink-0 shadow-lg shadow-blue-500/30">
                      <Facebook className="w-5 h-5 text-white" />
                    </div>
                    <div>
                      <div className="text-sm font-black text-[#1877F2]">Fb Handling</div>
                      <div className="text-[10px] text-slate-500 dark:text-slate-400">Mass Automation Panel v1.0</div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                      <Code2 className="w-3.5 h-3.5 text-[#1877F2]" />
                      <span>Built and maintained by</span>
                    </div>
                    <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-50 dark:bg-gray-800 border border-slate-100 dark:border-gray-700">
                      <Star className="w-4 h-4 text-amber-500 fill-amber-500" />
                      <span className="text-sm font-bold text-slate-700 dark:text-slate-200">Team Devx</span>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                      <Shield className="w-3.5 h-3.5 text-[#1877F2]" />
                      <span>Features</span>
                    </div>
                    <div className="space-y-1.5">
                      {[
                        "Multi-pool FB cookie management",
                        "Mass reaction automation (LIKE/LOVE/HAHA/WOW/SAD/ANGRY)",
                        "Mass comment posting",
                        "Mass page/profile follow",
                        "FRA, RPW & Normal cookie pools",
                        "Persistent sessions across restarts",
                        "Multi-user panel support",
                      ].map((f, i) => (
                        <div key={i} className="flex items-start gap-2 text-[11px] text-slate-600 dark:text-slate-300">
                          <CheckCircle className="w-3.5 h-3.5 text-green-500 flex-shrink-0 mt-0.5" />
                          {f}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                      <UserPlus className="w-3.5 h-3.5 text-[#1877F2]" />
                      <span>Developer</span>
                    </div>
                    <a
                      href="https://www.facebook.com/profile.php?id=100003531260174"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-[#1877F2] hover:bg-[#1565C0] active:bg-[#0D47A1] transition-colors group"
                    >
                      <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center flex-shrink-0">
                        <Facebook className="w-4 h-4 text-white" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-bold text-white">Developer Profile</div>
                        <div className="text-[10px] text-blue-200 truncate">facebook.com/Team Devx Dev</div>
                      </div>
                      <ExternalLink className="w-3.5 h-3.5 text-blue-200 group-hover:text-white transition-colors" />
                    </a>
                  </div>
                </div>
              )}
            </div>

          </div>
        </div>

        <div className="flex-shrink-0 border-t border-slate-100 dark:border-gray-800 px-4 py-3 bg-slate-50 dark:bg-gray-900">
          <div className="text-center text-[10px] text-slate-400 dark:text-slate-600">
            Fb Handling &copy; 2024 &mdash; Team Devx
          </div>
        </div>
      </div>
    </>
  );
}

function PoolCard({
  type,
  accounts,
  onRefresh,
}: {
  type: CookieType;
  accounts: Account[];
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [adding, setAdding] = useState(false);
  const [cookieInput, setCookieInput] = useState("");
  const [labelInput, setLabelInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [addError, setAddError] = useState("");
  const meta = TYPE_META[type];

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAddError("");
    if (!cookieInput.trim()) return;
    setLoading(true);
    try {
      const res = await fetch("/api/accs/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ cookie: cookieInput.trim(), cookie_type: type, label: labelInput.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { setAddError(data.message || "Failed to add"); return; }
      setCookieInput("");
      setLabelInput("");
      setAdding(false);
      onRefresh();
    } catch {
      setAddError("Network error");
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: number) {
    setDeleting(id);
    try {
      await fetch(`/api/accs/${id}`, { method: "DELETE", credentials: "include" });
      onRefresh();
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className={`rounded-2xl border-2 ${meta.border} ${meta.darkBorder} overflow-hidden shadow-sm`}>
      <div
        className={`flex items-center justify-between px-4 py-3 cursor-pointer select-none ${meta.bg} ${meta.darkBg}`}
        onClick={() => setOpen(o => !o)}
      >
        <div className="flex items-center gap-2.5">
          <span className={`w-2.5 h-2.5 rounded-full ${meta.dot} shadow-sm`} />
          <span className={`font-bold text-sm ${meta.color} ${meta.darkColor}`}>{meta.label} Cookies</span>
          <span className={`text-xs font-bold ${meta.color} ${meta.darkColor} bg-white/80 dark:bg-black/20 rounded-full px-2 py-0.5 border ${meta.border} ${meta.darkBorder}`}>
            {accounts.length} accs
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={e => { e.stopPropagation(); setAdding(a => !a); }}
            className={`flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-lg ${meta.color} ${meta.darkColor} bg-white dark:bg-black/20 border ${meta.border} ${meta.darkBorder} hover:opacity-80 transition-all`}
          >
            <Plus className="w-3 h-3" /> Add
          </button>
          {open ? <ChevronUp className={`w-4 h-4 ${meta.color} ${meta.darkColor}`} /> : <ChevronDown className={`w-4 h-4 ${meta.color} ${meta.darkColor}`} />}
        </div>
      </div>

      {adding && (
        <form onSubmit={handleAdd} className="px-4 py-3 bg-white dark:bg-gray-800 border-b border-slate-100 dark:border-gray-700 space-y-2">
          {addError && (
            <div className="text-xs text-red-600 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2">{addError}</div>
          )}
          <textarea
            value={cookieInput}
            onChange={e => setCookieInput(e.target.value)}
            placeholder="Paste full Facebook cookie string..."
            className="w-full text-xs border border-slate-200 dark:border-gray-600 rounded-xl p-3 bg-slate-50 dark:bg-gray-900 dark:text-slate-200 resize-none focus:outline-none focus:ring-2 focus:ring-blue-400 font-mono"
            rows={3}
            required
          />
          <input
            type="text"
            value={labelInput}
            onChange={e => setLabelInput(e.target.value)}
            placeholder="Label (optional)"
            className="w-full text-xs border border-slate-200 dark:border-gray-600 rounded-xl px-3 py-2 bg-slate-50 dark:bg-gray-900 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={loading}
              className={`flex-1 py-2 rounded-xl text-xs font-bold text-white transition-all flex items-center justify-center gap-1.5 ${meta.dot} hover:opacity-90 active:scale-95 disabled:opacity-60`}
            >
              {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
              {loading ? "Adding..." : "Add Account"}
            </button>
            <button
              type="button"
              onClick={() => { setAdding(false); setAddError(""); }}
              className="px-3 py-2 rounded-xl text-xs font-semibold text-slate-500 border border-slate-200 dark:border-gray-600 hover:bg-slate-50 dark:hover:bg-gray-700"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </form>
      )}

      {open && (
        <div className="bg-white dark:bg-gray-900">
          {accounts.length === 0 ? (
            <div className="py-6 text-center text-xs text-slate-400 dark:text-slate-600">
              No {meta.label} accounts yet. Click Add to start.
            </div>
          ) : (
            <div className="divide-y divide-slate-50 dark:divide-gray-800 max-h-48 overflow-y-auto">
              {accounts.map(acc => (
                <div key={acc.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50 dark:hover:bg-gray-800 transition-colors">
                  <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${acc.is_active ? meta.dot : "bg-slate-300"}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-slate-700 dark:text-slate-200 truncate">
                      {acc.fb_name || acc.label || "Unknown"}
                    </div>
                    {acc.fb_user_id && (
                      <div className="text-[10px] text-slate-400 dark:text-slate-600 font-mono">uid: {acc.fb_user_id}</div>
                    )}
                  </div>
                  <button
                    onClick={() => handleDelete(acc.id)}
                    disabled={deleting === acc.id}
                    className="p-1.5 rounded-lg text-slate-300 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors flex-shrink-0"
                  >
                    {deleting === acc.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ActionPanel({ accounts }: { accounts: AccountsData }) {
  const [action, setAction] = useState<ActionType>("react");
  const [url, setUrl] = useState("");
  const [cookieType, setCookieType] = useState<CookieType>("normal");
  const [reaction, setReaction] = useState<ReactionType>("LIKE");
  const [commentText, setCommentText] = useState("");
  const [count, setCount] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [error, setError] = useState("");
  const logsRef = useRef<HTMLDivElement>(null);

  const maxCount = accounts[cookieType]?.length ?? 0;
  const effectiveCount = count === 0 ? maxCount : Math.min(count, maxCount);

  useEffect(() => {
    if (logsRef.current) logsRef.current.scrollTop = logsRef.current.scrollHeight;
  }, [result]);

  async function handleRun(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setResult(null);
    if (!url.trim()) { setError("URL is required"); return; }
    if (action === "comment" && !commentText.trim()) { setError("Comment text is required"); return; }
    if (maxCount === 0) { setError(`No ${TYPE_META[cookieType].label} accounts found. Add some first.`); return; }

    setLoading(true);
    try {
      const endpoint = `/api/actions/${action}`;
      const body: Record<string, unknown> = { cookieType, count: effectiveCount };
      if (action === "react") { body.postUrl = url.trim(); body.reactionType = reaction; }
      else if (action === "comment") { body.postUrl = url.trim(); body.commentText = commentText.trim(); }
      else { body.targetUrl = url.trim(); }

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.message || "Action failed"); return; }
      setResult(data as ActionResult);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-2xl border-2 border-slate-200 dark:border-gray-700 overflow-hidden shadow-sm">
      <div className="bg-gradient-to-r from-slate-800 to-slate-700 dark:from-gray-900 dark:to-gray-800 px-5 py-3 flex items-center gap-2">
        <Settings2 className="w-4 h-4 text-slate-300" />
        <span className="font-bold text-sm text-white">Action Panel</span>
      </div>

      <form onSubmit={handleRun} className="bg-white dark:bg-gray-900 p-5 space-y-5">
        <div>
          <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2 block">Action Type</label>
          <div className="grid grid-cols-3 gap-2">
            {[
              { type: "react" as const, icon: <ThumbsUp className="w-4 h-4" />, label: "React" },
              { type: "comment" as const, icon: <MessageCircle className="w-4 h-4" />, label: "Comment" },
              { type: "follow" as const, icon: <UserPlus className="w-4 h-4" />, label: "Follow" },
            ].map(a => (
              <button
                key={a.type}
                type="button"
                onClick={() => { setAction(a.type); setResult(null); setError(""); }}
                className={`flex flex-col items-center gap-1.5 py-3 rounded-xl border-2 text-xs font-semibold transition-all ${
                  action === a.type
                    ? "border-[#1877F2] bg-blue-50 dark:bg-blue-900/20 text-[#1877F2]"
                    : "border-slate-200 dark:border-gray-700 text-slate-500 dark:text-slate-400 hover:border-slate-300 hover:bg-slate-50 dark:hover:bg-gray-800"
                }`}
              >
                {a.icon}
                {a.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2 block">
            {action === "follow" ? "Profile / Page URL" : "Post URL"}
          </label>
          <input
            type="url"
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="https://facebook.com/..."
            className="w-full text-sm border border-slate-200 dark:border-gray-600 rounded-xl px-4 py-2.5 bg-slate-50 dark:bg-gray-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-[#1877F2] focus:border-transparent transition-all"
            required
          />
        </div>

        <div>
          <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2 block">Cookie Pool</label>
          <div className="grid grid-cols-3 gap-2">
            {(["fra", "rpw", "normal"] as CookieType[]).map(t => {
              const meta = TYPE_META[t];
              const cnt = accounts[t]?.length ?? 0;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => { setCookieType(t); setCount(0); }}
                  className={`flex flex-col items-center gap-1 py-2.5 rounded-xl border-2 text-xs font-semibold transition-all ${
                    cookieType === t
                      ? `${meta.border} ${meta.darkBorder} ${meta.bg} ${meta.darkBg} ${meta.color} ${meta.darkColor}`
                      : "border-slate-200 dark:border-gray-700 text-slate-500 dark:text-slate-400 hover:border-slate-300 hover:bg-slate-50 dark:hover:bg-gray-800"
                  }`}
                >
                  <span className="font-bold">{meta.label}</span>
                  <span className={`text-[10px] ${cookieType === t ? meta.color : "text-slate-400"}`}>{cnt} accs</span>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Accounts to Use</label>
            <span className="text-xs font-bold text-[#1877F2]">
              {effectiveCount} / {maxCount}
              {count === 0 && maxCount > 0 && <span className="text-slate-400 font-normal"> (all)</span>}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={maxCount}
            value={count}
            onChange={e => setCount(Number(e.target.value))}
            className="w-full accent-[#1877F2]"
          />
          <div className="flex justify-between text-[10px] text-slate-400 mt-0.5">
            <span>All</span>
            <span>{maxCount}</span>
          </div>
        </div>

        {action === "react" && (
          <div>
            <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2 block">Reaction</label>
            <div className="grid grid-cols-3 gap-2">
              {REACTIONS.map(r => (
                <button
                  key={r.type}
                  type="button"
                  onClick={() => setReaction(r.type)}
                  className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border-2 text-xs font-semibold transition-all ${
                    reaction === r.type
                      ? r.color + " " + r.darkColor + " border-current"
                      : "border-slate-200 dark:border-gray-700 text-slate-500 dark:text-slate-400 hover:border-slate-300 hover:bg-slate-50 dark:hover:bg-gray-800"
                  }`}
                >
                  {r.icon}
                  <span>{r.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {action === "comment" && (
          <div>
            <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2 block">Comment Text</label>
            <textarea
              value={commentText}
              onChange={e => setCommentText(e.target.value)}
              placeholder="Enter comment to post..."
              className="w-full text-sm border border-slate-200 dark:border-gray-600 rounded-xl px-4 py-3 bg-slate-50 dark:bg-gray-800 dark:text-slate-200 resize-none focus:outline-none focus:ring-2 focus:ring-[#1877F2] focus:border-transparent transition-all"
              rows={3}
              required
            />
          </div>
        )}

        {error && (
          <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm rounded-xl px-4 py-3">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading || maxCount === 0}
          className="w-full bg-[#1877F2] hover:bg-[#1565C0] active:bg-[#0D47A1] text-white font-bold py-3.5 rounded-xl transition-all duration-200 shadow-lg shadow-blue-500/30 hover:shadow-blue-500/40 hover:-translate-y-0.5 active:translate-y-0 active:shadow-none disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none flex items-center justify-center gap-2 text-sm"
        >
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Running {effectiveCount} accounts...
            </>
          ) : (
            <>
              <Play className="w-4 h-4" />
              Run {action === "react" ? `${reaction} Reaction` : action === "comment" ? "Comment" : "Follow"} ({effectiveCount} accs)
            </>
          )}
        </button>

        {result && (
          <div className="rounded-xl border border-slate-200 dark:border-gray-700 overflow-hidden">
            <div className={`px-4 py-2.5 flex items-center gap-3 ${result.failed === 0 ? "bg-green-50 dark:bg-green-950/30" : result.success === 0 ? "bg-red-50 dark:bg-red-950/30" : "bg-amber-50 dark:bg-amber-950/30"}`}>
              <div className="flex gap-3 text-sm">
                <span className="flex items-center gap-1.5 text-green-700 dark:text-green-400 font-semibold">
                  <CheckCircle className="w-4 h-4" /> {result.success} done
                </span>
                {result.failed > 0 && (
                  <span className="flex items-center gap-1.5 text-red-600 dark:text-red-400 font-semibold">
                    <XCircle className="w-4 h-4" /> {result.failed} failed
                  </span>
                )}
              </div>
            </div>
            <div
              ref={logsRef}
              className="bg-slate-900 px-4 py-3 max-h-36 overflow-y-auto space-y-0.5 font-mono text-[11px]"
            >
              {result.details.map((line, i) => (
                <div
                  key={i}
                  className={
                    line.startsWith("✓") ? "text-green-400" :
                    line.startsWith("✗") ? "text-red-400" :
                    "text-slate-400"
                  }
                >
                  {line}
                </div>
              ))}
            </div>
          </div>
        )}
      </form>
    </div>
  );
}

export default function Dashboard() {
  const [, navigate] = useLocation();
  const [user, setUser] = useState<{ id: number; username: string } | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [accounts, setAccounts] = useState<AccountsData>({ fra: [], rpw: [], normal: [], total: 0 });
  const [accsLoading, setAccsLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dark, setDark] = useDarkMode();

  useEffect(() => {
    fetch("/api/auth/me", { credentials: "include" })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => setUser(data))
      .catch(() => navigate("/login"))
      .finally(() => setAuthLoading(false));
  }, []);

  useEffect(() => {
    if (user) fetchAccounts();
  }, [user]);

  async function fetchAccounts() {
    setAccsLoading(true);
    try {
      const res = await fetch("/api/accs", { credentials: "include" });
      if (res.ok) setAccounts(await res.json());
    } finally {
      setAccsLoading(false);
    }
  }

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    navigate("/login");
  }

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#1877F2] to-[#0D47A1]">
        <Loader2 className="w-8 h-8 text-white animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 dark:bg-gray-950 transition-colors duration-300">
      <header className="bg-[#1877F2] shadow-lg sticky top-0 z-30">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Facebook className="w-6 h-6 text-white" />
            <span className="text-white font-black text-lg tracking-tight">Fb Handling</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="text-right hidden sm:block">
              <div className="text-white font-semibold text-sm leading-tight">{user?.username}</div>
              <div className="text-blue-200 text-[10px]">{accounts.total} accounts total</div>
            </div>
            <button
              onClick={handleLogout}
              className="flex items-center gap-1.5 bg-white/10 hover:bg-white/20 text-white text-xs font-semibold px-3 py-2 rounded-xl transition-all border border-white/20"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Logout</span>
            </button>
            <button
              onClick={() => setMenuOpen(true)}
              className="flex items-center justify-center w-9 h-9 rounded-xl bg-white/10 hover:bg-white/20 border border-white/20 text-white transition-all active:scale-95"
              aria-label="Open menu"
            >
              <Menu className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      <BurgerMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        dark={dark}
        onToggleDark={() => setDark(d => !d)}
        currentUser={user}
      />

      <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        <div className="grid grid-cols-3 gap-3">
          {(["fra", "rpw", "normal"] as CookieType[]).map(t => {
            const meta = TYPE_META[t];
            const cnt = accounts[t]?.length ?? 0;
            return (
              <div key={t} className={`rounded-2xl border-2 ${meta.border} ${meta.darkBorder} ${meta.bg} ${meta.darkBg} p-4 flex flex-col items-center gap-1`}>
                <span className={`text-2xl font-black ${meta.color} ${meta.darkColor}`}>{cnt}</span>
                <span className={`text-xs font-bold ${meta.color} ${meta.darkColor}`}>{meta.label}</span>
                <span className="text-[10px] text-slate-400 dark:text-slate-500">accounts</span>
              </div>
            );
          })}
        </div>

        {accsLoading && (
          <div className="flex justify-center py-2">
            <Loader2 className="w-5 h-5 text-[#1877F2] animate-spin" />
          </div>
        )}

        <div className="space-y-3">
          {(["fra", "rpw", "normal"] as CookieType[]).map(t => (
            <PoolCard
              key={t}
              type={t}
              accounts={accounts[t] ?? []}
              onRefresh={fetchAccounts}
            />
          ))}
        </div>

        <ActionPanel accounts={accounts} />
      </div>
    </div>
  );
}
