import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import {
  Facebook,
  LogOut,
  Plus,
  Trash2,
  Loader2,
  Cookie,
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
  AlertCircle,
  Frown,
  Angry,
  Minus,
  Settings2,
  Play,
  X,
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

const TYPE_META: Record<CookieType, { label: string; color: string; bg: string; border: string; dot: string }> = {
  fra: {
    label: "FRA",
    color: "text-purple-700",
    bg: "bg-purple-50",
    border: "border-purple-200",
    dot: "bg-purple-500",
  },
  rpw: {
    label: "RPW",
    color: "text-amber-700",
    bg: "bg-amber-50",
    border: "border-amber-200",
    dot: "bg-amber-500",
  },
  normal: {
    label: "Normal",
    color: "text-blue-700",
    bg: "bg-blue-50",
    border: "border-blue-200",
    dot: "bg-blue-500",
  },
};

const REACTIONS: Array<{ type: ReactionType; label: string; emoji: string; color: string }> = [
  { type: "LIKE", label: "Like", emoji: "👍", color: "bg-blue-100 text-blue-700 border-blue-300" },
  { type: "LOVE", label: "Love", emoji: "❤️", color: "bg-red-100 text-red-700 border-red-300" },
  { type: "HAHA", label: "Haha", emoji: "😂", color: "bg-yellow-100 text-yellow-700 border-yellow-300" },
  { type: "WOW", label: "Wow", emoji: "😮", color: "bg-yellow-100 text-yellow-700 border-yellow-300" },
  { type: "SAD", label: "Sad", emoji: "😢", color: "bg-indigo-100 text-indigo-700 border-indigo-300" },
  { type: "ANGRY", label: "Angry", emoji: "😡", color: "bg-orange-100 text-orange-700 border-orange-300" },
];

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
    <div className={`rounded-2xl border-2 ${meta.border} overflow-hidden shadow-sm`}>
      <div
        className={`flex items-center justify-between px-4 py-3 cursor-pointer select-none ${meta.bg}`}
        onClick={() => setOpen(o => !o)}
      >
        <div className="flex items-center gap-2.5">
          <span className={`w-2.5 h-2.5 rounded-full ${meta.dot} shadow-sm`} />
          <span className={`font-bold text-sm ${meta.color}`}>{meta.label} Cookies</span>
          <span className={`text-xs font-bold ${meta.color} bg-white/80 rounded-full px-2 py-0.5 border ${meta.border}`}>
            {accounts.length} accs
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={e => { e.stopPropagation(); setAdding(a => !a); }}
            className={`flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-lg ${meta.color} bg-white border ${meta.border} hover:opacity-80 transition-all`}
          >
            <Plus className="w-3 h-3" /> Add
          </button>
          {open ? <ChevronUp className={`w-4 h-4 ${meta.color}`} /> : <ChevronDown className={`w-4 h-4 ${meta.color}`} />}
        </div>
      </div>

      {adding && (
        <form onSubmit={handleAdd} className="px-4 py-3 bg-white border-b border-slate-100 space-y-2">
          {addError && (
            <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{addError}</div>
          )}
          <textarea
            value={cookieInput}
            onChange={e => setCookieInput(e.target.value)}
            placeholder="Paste full Facebook cookie string..."
            className="w-full text-xs border border-slate-200 rounded-xl p-3 bg-slate-50 resize-none focus:outline-none focus:ring-2 focus:ring-blue-400 font-mono"
            rows={3}
            required
          />
          <input
            type="text"
            value={labelInput}
            onChange={e => setLabelInput(e.target.value)}
            placeholder="Label (optional)"
            className="w-full text-xs border border-slate-200 rounded-xl px-3 py-2 bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-400"
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
              className="px-3 py-2 rounded-xl text-xs font-semibold text-slate-500 border border-slate-200 hover:bg-slate-50"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </form>
      )}

      {open && (
        <div className="bg-white">
          {accounts.length === 0 ? (
            <div className="py-6 text-center text-xs text-slate-400">
              No {meta.label} accounts yet. Click Add to start.
            </div>
          ) : (
            <div className="divide-y divide-slate-50 max-h-48 overflow-y-auto">
              {accounts.map(acc => (
                <div key={acc.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50 transition-colors">
                  <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${acc.is_active ? meta.dot : "bg-slate-300"}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-slate-700 truncate">
                      {acc.fb_name || acc.label || "Unknown"}
                    </div>
                    {acc.fb_user_id && (
                      <div className="text-[10px] text-slate-400 font-mono">uid: {acc.fb_user_id}</div>
                    )}
                  </div>
                  <button
                    onClick={() => handleDelete(acc.id)}
                    disabled={deleting === acc.id}
                    className="p-1.5 rounded-lg text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors flex-shrink-0"
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
      const body: Record<string, unknown> = {
        cookieType,
        count: effectiveCount,
      };
      if (action === "react") {
        body.postUrl = url.trim();
        body.reactionType = reaction;
      } else if (action === "comment") {
        body.postUrl = url.trim();
        body.commentText = commentText.trim();
      } else {
        body.targetUrl = url.trim();
      }

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
    <div className="rounded-2xl border-2 border-slate-200 overflow-hidden shadow-sm">
      <div className="bg-gradient-to-r from-slate-800 to-slate-700 px-5 py-3 flex items-center gap-2">
        <Settings2 className="w-4 h-4 text-slate-300" />
        <span className="font-bold text-sm text-white">Action Panel</span>
      </div>

      <form onSubmit={handleRun} className="bg-white p-5 space-y-5">
        <div>
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 block">Action Type</label>
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
                    ? "border-[#1877F2] bg-blue-50 text-[#1877F2]"
                    : "border-slate-200 text-slate-500 hover:border-slate-300 hover:bg-slate-50"
                }`}
              >
                {a.icon}
                {a.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 block">
            {action === "follow" ? "Profile / Page URL" : "Post URL"}
          </label>
          <input
            type="url"
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="https://facebook.com/..."
            className="w-full text-sm border border-slate-200 rounded-xl px-4 py-2.5 bg-slate-50 focus:outline-none focus:ring-2 focus:ring-[#1877F2] focus:border-transparent transition-all"
            required
          />
        </div>

        <div>
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 block">Cookie Pool</label>
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
                      ? `${meta.border} ${meta.bg} ${meta.color}`
                      : "border-slate-200 text-slate-500 hover:border-slate-300 hover:bg-slate-50"
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
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
              Accounts to Use
            </label>
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
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 block">Reaction</label>
            <div className="grid grid-cols-3 gap-2">
              {REACTIONS.map(r => (
                <button
                  key={r.type}
                  type="button"
                  onClick={() => setReaction(r.type)}
                  className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border-2 text-xs font-semibold transition-all ${
                    reaction === r.type
                      ? r.color + " border-current"
                      : "border-slate-200 text-slate-500 hover:border-slate-300 hover:bg-slate-50"
                  }`}
                >
                  <span className="text-base">{r.emoji}</span>
                  <span>{r.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {action === "comment" && (
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 block">Comment Text</label>
            <textarea
              value={commentText}
              onChange={e => setCommentText(e.target.value)}
              placeholder="Enter comment to post..."
              className="w-full text-sm border border-slate-200 rounded-xl px-4 py-3 bg-slate-50 resize-none focus:outline-none focus:ring-2 focus:ring-[#1877F2] focus:border-transparent transition-all"
              rows={3}
              required
            />
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">
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
          <div className="rounded-xl border border-slate-200 overflow-hidden">
            <div className={`px-4 py-2.5 flex items-center gap-3 ${result.failed === 0 ? "bg-green-50" : result.success === 0 ? "bg-red-50" : "bg-amber-50"}`}>
              <div className="flex gap-3 text-sm">
                <span className="flex items-center gap-1.5 text-green-700 font-semibold">
                  <CheckCircle className="w-4 h-4" /> {result.success} done
                </span>
                {result.failed > 0 && (
                  <span className="flex items-center gap-1.5 text-red-600 font-semibold">
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
    <div className="min-h-screen bg-slate-100">
      <header className="bg-[#1877F2] shadow-lg sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Facebook className="w-6 h-6 text-white" />
            <span className="text-white font-black text-lg tracking-tight">FBGuard</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right hidden sm:block">
              <div className="text-white font-semibold text-sm leading-tight">{user?.username}</div>
              <div className="text-blue-200 text-[10px]">{accounts.total} accounts total</div>
            </div>
            <button
              onClick={handleLogout}
              className="flex items-center gap-1.5 bg-white/10 hover:bg-white/20 text-white text-xs font-semibold px-3 py-2 rounded-xl transition-all border border-white/20"
            >
              <LogOut className="w-3.5 h-3.5" /> Logout
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        <div className="grid grid-cols-3 gap-3">
          {(["fra", "rpw", "normal"] as CookieType[]).map(t => {
            const meta = TYPE_META[t];
            const cnt = accounts[t]?.length ?? 0;
            return (
              <div key={t} className={`rounded-2xl border-2 ${meta.border} ${meta.bg} p-4 flex flex-col items-center gap-1`}>
                <span className={`text-2xl font-black ${meta.color}`}>{cnt}</span>
                <span className={`text-xs font-bold ${meta.color}`}>{meta.label}</span>
                <span className="text-[10px] text-slate-400">accounts</span>
              </div>
            );
          })}
        </div>

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
