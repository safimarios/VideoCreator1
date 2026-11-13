"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ---------------- أنواع ----------------

interface HealthState {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  models: Array<{ canonical: string; type: string; providers: string[] }>;
  merger: { base: string; healthy: boolean };
  authRequired: boolean;
}

interface KeyRow {
  id: string;
  provider: string;
  label: string;
  maskedKey: string;
  status: string;
  usageCount: number;
  successCount: number;
  failCount: number;
  lastUsedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

interface TaskRow {
  id: string;
  type: string;
  model: string;
  provider: string | null;
  status: string;
  progress: number;
  prompt: string;
  resultUrls: string[];
  errorMessage: string | null;
  attemptsCount: number;
  createdAt: string;
}

interface Stats {
  total: number;
  completed: number;
  failed: number;
  inProgress: number;
}

const TYPE_AR: Record<string, string> = { image: "صورة", video: "فيديو", merge: "دمج" };
const STATUS_AR: Record<string, string> = {
  completed: "مكتملة",
  failed: "فاشلة",
  processing: "قيد المعالجة",
  pending: "بالانتظار",
};

const TOOL_CHIPS: Array<{ name: string; desc: string }> = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي (gpt-image-2-6/flare-text-to-image)" },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن أصلي (grok-imagine-video-1-5-preview)" },
  { name: "merge_videos", desc: "دمج عدة مقاطع بترتيب معين عبر urls أو task_ids" },
  { name: "get_task", desc: "تتبع أي مهمة بمعرفها حتى الاكتمال" },
  { name: "list_media", desc: "استرجاع أحدث الوسائط المخزنة بروابطها" },
];

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "completed" || status === "active"
      ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
      : status === "failed"
        ? "bg-red-500/15 text-red-300 border-red-500/40"
        : status === "exhausted"
          ? "bg-amber-500/15 text-amber-300 border-amber-500/40"
          : status === "disabled"
            ? "bg-gray-500/15 text-gray-300 border-gray-500/40"
            : "bg-cyan-500/15 text-cyan-300 border-cyan-500/40";
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-[11px] ${cls}`}>
      {STATUS_AR[status] ?? status}
    </span>
  );
}

export default function Dashboard() {
  const [health, setHealth] = useState<HealthState | null>(null);
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [stats, setStats] = useState<Stats>({ total: 0, completed: 0, failed: 0, inProgress: 0 });

  // نموذج إضافة مفتاح
  const [provider, setProvider] = useState("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keysMsg, setKeysMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [tab, setTab] = useState<"chatgpt" | "claude" | "cursor">("chatgpt");
  const [copied, setCopied] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const mcpUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    return `${window.location.origin}/mcp`;
  }, []);

  const loadHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health");
      setHealth((await res.json()) as HealthState);
    } catch {
      setHealth(null);
    }
  }, []);

  const loadKeys = useCallback(async () => {
    try {
      const res = await fetch("/api/keys");
      const data = (await res.json()) as { keys: KeyRow[] };
      setKeys(data.keys ?? []);
    } catch {
      /* تجاهل */
    }
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks?limit=20");
      const data = (await res.json()) as { tasks: TaskRow[]; stats: Stats };
      setTasks(data.tasks ?? []);
      setStats(data.stats ?? { total: 0, completed: 0, failed: 0, inProgress: 0 });
    } catch {
      /* تجاهل */
    }
  }, []);

  useEffect(() => {
    loadHealth();
    loadKeys();
    loadTasks();
    const t = setInterval(() => {
      loadHealth();
      loadTasks();
    }, 5000); // تحديث تلقائي كل ~5 ثوانٍ
    return () => clearInterval(t);
  }, [loadHealth, loadKeys, loadTasks]);

  const addKey = async () => {
    setKeysMsg(null);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey.trim(), label: label.trim() }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setKeysMsg({ ok: false, text: data.error ?? "فشل إضافة المفتاح" });
      } else {
        setKeysMsg({ ok: true, text: "تمت إضافة المفتاح بنجاح" });
        setApiKey("");
        setLabel("");
        await loadKeys();
      }
    } catch {
      setKeysMsg({ ok: false, text: "تعذر الاتصال بالسيرفر" });
    }
  };

  const toggleKey = async (id: string, status: string) => {
    await fetch(`/api/keys/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: status === "disabled" ? "activate" : "disable" }),
    });
    await loadKeys();
  };

  const deleteKey = async (id: string) => {
    await fetch(`/api/keys/${id}`, { method: "DELETE" });
    await loadKeys();
  };

  const copyText = async (text: string, tag: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(null), 1800);
    } catch {
      /* المتصفح رفض النسخ */
    }
  };

  const connJson = useMemo(() => {
    const auth = health?.authRequired
      ? { url: mcpUrl, headers: { Authorization: "Bearer <MCP_ACCESS_TOKEN>" } }
      : { url: mcpUrl };
    if (tab === "chatgpt") {
      return JSON.stringify({ mcpServers: { "media-generator": auth } }, null, 2);
    }
    if (tab === "claude") {
      return JSON.stringify({ mcpServers: { "media-generator": { type: "http", ...auth } } }, null, 2);
    }
    return JSON.stringify({ mcpServers: { "media-generator": auth } }, null, 2);
  }, [tab, mcpUrl, health?.authRequired]);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 space-y-8">
      {/* الهيدر + حالة الصحة */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold bg-gradient-to-l from-cyan-300 to-violet-300 bg-clip-text text-transparent">
            مولد الوسائط — خادم MCP
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            توليد الصور والفيديو ودمج المقاطع مع مفاتيح متسلسلة وتبديل تلقائي
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          {health ? (
            health.ok ? (
              <span className="rounded-full border border-emerald-500/40 bg-emerald-500/15 px-3 py-1 text-emerald-300">
                Turso متصل
              </span>
            ) : (
              <span className="rounded-full border border-red-500/40 bg-red-500/15 px-3 py-1 text-red-300">
                غير متصل
              </span>
            )
          ) : (
            <span className="rounded-full border border-red-500/40 bg-red-500/15 px-3 py-1 text-red-300">
              غير متصل
            </span>
          )}
          {health && (
            <span
              className={`rounded-full border px-3 py-1 ${
                health.merger.healthy
                  ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                  : "border-amber-500/40 bg-amber-500/15 text-amber-300"
              }`}
            >
              خدمة الدمج: {health.merger.healthy ? "جاهزة" : "غير متاحة"}
            </span>
          )}
          {health?.authRequired && (
            <span className="rounded-full border border-cyan-500/40 bg-cyan-500/15 px-3 py-1 text-cyan-300">
              محمي بـ Bearer token
            </span>
          )}
        </div>
      </header>

      {/* أ) مدير المفاتيح */}
      <section className="card p-5">
        <h2 className="text-lg font-bold mb-3">مدير المفاتيح</h2>
        <p className="text-xs text-slate-400 mb-4 leading-6">
          أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند أي خطأ
          أو نفاد رصيد دون توقف.
        </p>

        <div className="grid gap-3 md:grid-cols-4 mb-4">
          <select value={provider} onChange={(e) => setProvider(e.target.value)} className="md:col-span-1">
            <option value="kie">kie.ai</option>
            <option value="cometapi">CometAPI</option>
          </select>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="تسمية اختيارية (مثال: حساب رئيسي)"
            className="md:col-span-1"
          />
          <input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="الصق مفتاح API هنا"
            className="md:col-span-2"
            dir="ltr"
          />
        </div>
        <div className="flex items-center gap-3 mb-2">
          <button onClick={addKey} className="btn btn-primary" disabled={!apiKey.trim()}>
            إضافة المفتاح
          </button>
          {keysMsg && (
            <span className={`text-xs ${keysMsg.ok ? "text-emerald-300" : "text-red-300"}`}>{keysMsg.text}</span>
          )}
        </div>

        <div className="mt-4 space-y-2">
          {keys.length === 0 && <p className="text-sm text-slate-500">لا توجد مفاتيح بعد — أضف مفتاحًا للبدء.</p>}
          {keys.map((k) => (
            <div key={k.id} className="rounded-xl border border-[#24305c] bg-[#0d1230] p-3 flex flex-wrap items-center gap-3">
              <StatusBadge status={k.status} />
              <span className="text-xs text-slate-300 font-mono" dir="ltr">
                {k.maskedKey}
              </span>
              <span className="text-xs text-slate-500">{k.provider}</span>
              {k.label && <span className="text-xs text-cyan-300">{k.label}</span>}
              <span className="text-[11px] text-slate-500">
                استخدام: {k.usageCount} · نجاح: {k.successCount} · فشل: {k.failCount}
              </span>
              {k.lastError && (
                <span className="text-[11px] text-amber-300/80 truncate max-w-xs" title={k.lastError}>
                  {k.lastError}
                </span>
              )}
              <div className="ms-auto flex gap-2">
                <button onClick={() => toggleKey(k.id, k.status)} className="btn text-xs">
                  {k.status === "disabled" ? "تنشيط" : "تعطيل"}
                </button>
                <button onClick={() => deleteKey(k.id)} className="btn text-xs text-red-300 hover:border-red-400">
                  حذف
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ب) لوحة المهام */}
      <section className="card p-5">
        <h2 className="text-lg font-bold mb-3">لوحة المهام</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          {[
            { label: "الإجمالي", value: stats.total, cls: "text-slate-200" },
            { label: "مكتملة", value: stats.completed, cls: "text-emerald-300" },
            { label: "فاشلة", value: stats.failed, cls: "text-red-300" },
            { label: "جارية", value: stats.inProgress, cls: "text-cyan-300" },
          ].map((s) => (
            <div key={s.label} className="rounded-xl border border-[#24305c] bg-[#0d1230] p-3 text-center">
              <div className={`text-2xl font-extrabold ${s.cls}`}>{s.value}</div>
              <div className="text-xs text-slate-500 mt-1">{s.label}</div>
            </div>
          ))}
        </div>

        <div className="space-y-2">
          {tasks.length === 0 && <p className="text-sm text-slate-500">لا توجد مهام بعد.</p>}
          {tasks.map((t) => (
            <div key={t.id} className="rounded-xl border border-[#24305c] bg-[#0d1230] p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <StatusBadge status={t.status} />
                <span className="text-cyan-300">{TYPE_AR[t.type] ?? t.type}</span>
                <span className="text-slate-400 font-mono" dir="ltr">
                  {t.model}
                </span>
                <span className="text-slate-600">·</span>
                <span className="text-slate-500 font-mono" dir="ltr">
                  {t.id.slice(0, 8)}…
                </span>
                <span className="text-slate-500">
                  محاولات: {t.attemptsCount}
                </span>
                <span className="ms-auto text-slate-500" dir="ltr">
                  {t.createdAt}
                </span>
              </div>
              {t.prompt && <p className="text-xs text-slate-400 mt-2 line-clamp-2">{t.prompt}</p>}
              {(t.status === "processing" || t.status === "pending") && (
                <div className="mt-2 h-1.5 rounded-full bg-[#1a2350] overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-l from-cyan-400 to-violet-400 transition-all"
                    style={{ width: `${t.progress}%` }}
                  />
                </div>
              )}
              {t.status === "failed" && t.errorMessage && (
                <p className="text-xs text-red-300 mt-2">{t.errorMessage}</p>
              )}
              {t.resultUrls.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {t.resultUrls.map((u) => (
                    <a
                      key={u}
                      href={u}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-cyan-300 underline break-all"
                      dir="ltr"
                    >
                      {u.length > 70 ? `${u.slice(0, 70)}…` : u}
                    </a>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ج) ربط السيرفر */}
      <section className="card p-5">
        <h2 className="text-lg font-bold mb-3">ربط السيرفر</h2>

        <div className="flex items-center gap-2 mb-4">
          <input readOnly value={mcpUrl} dir="ltr" className="font-mono text-xs" />
          <button onClick={() => copyText(mcpUrl, "url")} className="btn whitespace-nowrap">
            {copied === "url" ? "تم النسخ ✓" : "نسخ"}
          </button>
        </div>

        <div className="flex gap-2 mb-3 text-xs">
          {(
            [
              { id: "chatgpt", label: "ChatGPT / GPT Agents" },
              { id: "claude", label: "Claude Desktop" },
              { id: "cursor", label: "Cursor / Windsurf / Cline" },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`btn ${tab === t.id ? "border-cyan-400 text-cyan-300" : ""}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <pre className="json">{connJson}</pre>
        <div className="flex items-center justify-between mt-2">
          <p className="text-[11px] text-slate-500">
            {tab === "chatgpt" &&
              "في ChatGPT: Settings → Connectors → Create → Custom MCP server وضع الرابط في «Server URL»."}
            {tab === "claude" && "ضعه في ملف claude_desktop_config.json ثم أعد تشغيل Claude Desktop."}
            {tab === "cursor" && "ضعه في mcp.json داخل إعدادات العميل ثم أعد التشغيل."}
          </p>
          <button onClick={() => copyText(connJson, "json")} className="btn text-xs whitespace-nowrap">
            {copied === "json" ? "تم النسخ ✓" : "نسخ JSON"}
          </button>
        </div>

        <div className="mt-5">
          <h3 className="text-sm font-bold mb-2">الأدوات المتاحة</h3>
          <div className="flex flex-wrap gap-2">
            {TOOL_CHIPS.map((c) => (
              <div key={c.name} className="chip">
                <span className="font-mono text-cyan-300" dir="ltr">
                  {c.name}
                </span>
                <span className="text-slate-400"> — {c.desc}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200 leading-6">
          الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند اكتمال
          المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا تنقطع
          العملية.
        </div>
      </section>

      <footer className="text-center text-[11px] text-slate-600 pb-6">
        media-generator-mcp v1.2.0 — الملفات تبقى على بنية المزودين، ونخزّن الروابط فقط
      </footer>
    </main>
  );
}
