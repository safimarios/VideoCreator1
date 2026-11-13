// منسّق التوليد — قلب المشروع
// سياسة التبديل التسلسلي «لا توقف أبدًا»:
// 1) المرشحون يُجرَّبون بترتيب إضافة المفاتيح الصارم (created_at ASC, id ASC)
// 2) فشل مفتاح/رصيد في منتصف المهمة → إعادة إنشاء نفس المهمة بنفس task_id على المفتاح التالي بصمت
// 3) فشل على كل المفاتيح → المهمة تبقى processing وتُعاد المحاولة مع كل get_task (تهدئة 45 ثانية)
// 4) نموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح أو الرصيد أبدًا
import { randomUUID } from "crypto";
import {
  getKeyPool,
  getTask,
  getKey,
  insertTask,
  updateTask,
  bumpKeyCounters,
  setKeyStatus,
  type ApiKey,
  type Task,
  type TaskAttempt,
} from "./turso";
import { classifyProviderError, ParamsError, isKeyOrBalanceMessage } from "./errors";
import { findModel, type ModelDef } from "./models";
import { adapterFor, type RawInput } from "./providers";
import * as merger from "./merger";

export interface ProgressInfo {
  progress: number;
  total: number;
  message: string;
}
export type Notify = (info: ProgressInfo) => void;

const POLL_INTERVAL_MS = 3_000;
const RETRY_COOLDOWN_MS = 45_000;

// لا توجد مفاتيح نشطة — رسالة عربية كما في المواصفة (توجيه للإدارة، وليس خطأ مفاتيح يُعرض للنموذج)
export class NoKeysError extends Error {
  constructor(model: string) {
    super(`❌ لا توجد مفاتيح نشطة لخدمة ${model}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`);
    this.name = "NoKeysError";
  }
}

// تنظيف رسالة الخطأ قبل عرضها للعميل — لا ذكر للمفاتيح أو الرصيد إطلاقًا
function sanitizeErrorForClient(msg: string): string {
  if (!msg) return "تعذر إكمال المهمة";
  if (isKeyOrBalanceMessage(msg)) return "تعذر إكمال المهمة حاليًا — تُجرى محاولة تلقائية من جديد";
  return msg;
}

function attemptRecord(key: ApiKey, ok: boolean, errorClass?: string, error?: string): TaskAttempt {
  return {
    provider: key.provider,
    keyId: key.id,
    keyLabel: key.label || key.id.slice(0, 8),
    ok,
    errorClass,
    error: error ? error.slice(0, 300) : undefined,
    at: new Date().toISOString(),
  };
}

interface CreateOutcome {
  provider: string;
  key: ApiKey;
  providerTaskId: string | null;
  syncUrls?: string[]; // للصور المتزامنة (CometAPI) — اكتملت فورًا
}

function safeParse(json: string): Record<string, unknown> {
  try { return JSON.parse(json) as Record<string, unknown>; } catch { return {}; }
}

// تجربة المرشحين بالترتيب حتى نجاح الإنشاء — تسجيل كل محاولة وتحديث عدّادات المفاتيح دائمًا
async function attemptCreation(taskId: string, model: ModelDef, input: RawInput): Promise<CreateOutcome | null> {
  const pool = await getKeyPool(model.providers);
  if (!pool.length) throw new NoKeysError(model.canonical);

  for (const key of pool) {
    const adapter = adapterFor(key.provider as "kie" | "cometapi");
    const providerModel = model.providerModel[key.provider] ?? model.canonical;
    try {
      // الصور: إن دعم المزود التوليد المتزامن استخدمه فورًا (CometAPI)
      if (model.type === "image" && adapter.createImageSync) {
        const { urls } = await adapter.createImageSync(key, providerModel, input);
        await bumpKeyCounters(key.id, true);
        await updateTask(
          taskId,
          { provider: key.provider, keyId: key.id, providerTaskId: null, status: "completed", progress: 100, resultUrls: urls },
          attemptRecord(key, true)
        );
        return { provider: key.provider, key, providerTaskId: null, syncUrls: urls };
      }
      const { providerTaskId } = await adapter.createTask(key, providerModel, input);
      await bumpKeyCounters(key.id, true);
      await updateTask(taskId, { provider: key.provider, keyId: key.id, providerTaskId, status: "processing" }, attemptRecord(key, true));
      return { provider: key.provider, key, providerTaskId };
    } catch (e) {
      const c = classifyProviderError(e);
      const errText = `${c.cls}: ${c.message}`;
      await bumpKeyCounters(key.id, false, errText);
      // مفتاح مرفوض → disabled تلقائيًا | رصيد منتهٍ → exhausted (يبقى في القاعدة)
      if (c.cls === "disabled") await setKeyStatus(key.id, "disabled", errText);
      if (c.cls === "exhausted") await setKeyStatus(key.id, "exhausted", errText);
      await updateTask(taskId, {}, attemptRecord(key, false, c.cls, c.message));
      if (c.cls === "params") {
        // معطيات تالفة — توقف فورًا، تبديل المفاتيح لن يحلها
        throw new ParamsError(c.message);
      }
      // disabled/exhausted/provider/temporary → انتقل للمرشح التالي
    }
  }

  // فشل الإنشاء على كل المفاتيح → تبقى processing برسالة داخلية، وتُعاد المحاولة عند get_task
  await updateTask(taskId, {
    status: "processing",
    progress: 0,
    errorMessage: "بانتظار توفر مفتاح صالح…",
    paramsJson: JSON.stringify({ raw: input, lastAllFailedAt: new Date().toISOString() }),
  });
  return null;
}

function buildRawInput(args: Record<string, unknown>): RawInput {
  const input: RawInput = { prompt: String(args.prompt ?? "") };
  if (typeof args.image_url === "string" && args.image_url) input.image_url = args.image_url;
  if (typeof args.aspect_ratio === "string" && args.aspect_ratio !== "auto") input.aspect_ratio = args.aspect_ratio;
  if (typeof args.resolution === "string" && args.resolution !== "auto") input.resolution = args.resolution;
  if (typeof args.background === "string" && args.background !== "auto") input.background = args.background;
  if (typeof args.output_format === "string" && args.output_format !== "auto") input.output_format = args.output_format;
  if (typeof args.duration === "number") input.duration = args.duration;
  // enable_audio مقبولة في المخطط لكن المزودان يولّدان الصوت دائمًا (مقاس من التوثيق) — لا تُرسل
  return input;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function remainingSeconds(deadline: number): number {
  return Math.max(0, Math.round((deadline - Date.now()) / 1000));
}

// استرجاع المعطيات الخام من المهمة المخزنة (لإعادة الإنشاء بعد التبديل)
function rawInputOf(task: Task): RawInput {
  const params = safeParse(task.paramsJson) as { raw?: RawInput };
  return params.raw ?? { prompt: task.prompt };
}

// إعادة إنشاء نفس المهمة بنفس task_id على المفتاح التالي (4.3.2) — صامتة تمامًا للعميل
async function recreateWithNextKey(taskId: string, model: ModelDef): Promise<CreateOutcome | null> {
  const task = await getTask(taskId);
  if (!task) return null;
  try {
    return await attemptCreation(taskId, model, rawInputOf(task));
  } catch {
    return null; // لا مفاتيح على الإطلاق → تبقى processing بانتظار مفتاح صالح
  }
}

// حلقة انتظار قصيرة: استطلاع كل 3 ثوانٍ مع بث تقدم حتى نهاية النافذة
async function waitForCompletion(taskId: string, model: ModelDef, outcome: CreateOutcome, waitSeconds: number, notify?: Notify): Promise<Task> {
  const deadline = Date.now() + waitSeconds * 1000;
  const adapter = adapterFor(outcome.key.provider as "kie" | "cometapi");
  let lastProgress = 5;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    let result;
    try {
      result = await adapter.checkTask(outcome.key, outcome.providerTaskId!);
    } catch (e) {
      const c = classifyProviderError(e);
      if (c.cls === "disabled" || c.cls === "exhausted") {
        // المفتاح فسد أثناء الاستطلاع → علّمه وأعد الإنشاء على المفتاح التالي
        if (c.cls === "disabled") await setKeyStatus(outcome.key.id, "disabled", `${c.cls}: ${c.message}`);
        if (c.cls === "exhausted") await setKeyStatus(outcome.key.id, "exhausted", `${c.cls}: ${c.message}`);
        await bumpKeyCounters(outcome.key.id, false, `${c.cls}: ${c.message}`);
        await updateTask(taskId, {}, attemptRecord(outcome.key, false, c.cls, c.message));
        const retry = await recreateWithNextKey(taskId, model);
        if (retry) {
          return retry.syncUrls
            ? (await getTask(taskId))!
            : await waitForCompletion(taskId, model, retry, remainingSeconds(deadline), notify);
        }
        return (await getTask(taskId))!;
      }
      continue; // أخطاء مؤقتة/شبكة → استمر بالاستطلاع حتى نهاية النافذة
    }

    if (result.status === "completed" && result.urls?.length) {
      await updateTask(taskId, { status: "completed", progress: 100, resultUrls: result.urls, errorMessage: null });
      notify?.({ progress: 100, total: 100, message: "اكتمل التوليد" });
      return (await getTask(taskId))!;
    }
    if (result.status === "failed") {
      const reason = String(result.error ?? "");
      if (isKeyOrBalanceMessage(reason)) {
        // فشل مفتاح/رصيد في منتصف المهمة → أعد الإنشاء بنفس task_id على المفتاح التالي
        await bumpKeyCounters(outcome.key.id, false, reason.slice(0, 300));
        await updateTask(taskId, {}, attemptRecord(outcome.key, false, "midtask-key", reason));
        const retry = await recreateWithNextKey(taskId, model);
        if (retry) {
          return retry.syncUrls
            ? (await getTask(taskId))!
            : await waitForCompletion(taskId, model, retry, remainingSeconds(deadline), notify);
        }
        return (await getTask(taskId))!;
      }
      // فشل حقيقي (سياسة/معطيات) → فشل نهائي برسالة منظفة
      await updateTask(taskId, { status: "failed", errorMessage: sanitizeErrorForClient(reason) });
      return (await getTask(taskId))!;
    }

    // قيد المعالجة → حدّث التقدم وبثّ إشعارًا كل ~3 ثوانٍ
    lastProgress = Math.max(lastProgress, Math.min(99, result.progress ?? lastProgress + 2));
    await updateTask(taskId, { progress: lastProgress });
    notify?.({ progress: lastProgress, total: 100, message: `قيد التوليد… ${lastProgress}%` });
  }

  notify?.({ progress: lastProgress, total: 100, message: "لا يزال قيد المعالجة — تابع بـ get_task" });
  return (await getTask(taskId))!;
}

function defaultModel(type: "image" | "video"): ModelDef {
  const m = findModel(type === "image" ? "gpt-image-2-6/flare-text-to-image" : "grok-imagine-video-1-5-preview");
  if (!m) throw new Error("model registry broken");
  return m;
}

// توليد صورة أو فيديو — التدفق الكامل (قسم 6 من المواصفة)
export async function runGeneration(opts: {
  type: "image" | "video";
  args: Record<string, unknown>;
  waitSeconds: number;
  notify?: Notify;
}): Promise<Task> {
  const model = opts.args.model ? findModel(String(opts.args.model)) : defaultModel(opts.type);
  if (!model) {
    throw new ParamsError(
      `موديل غير معروف: ${String(opts.args.model)}. المتاح: gpt-image-2-6/flare-text-to-image، grok-imagine-video-1-5-preview`
    );
  }
  const input = buildRawInput(opts.args);
  if (!input.prompt || !input.prompt.trim()) {
    throw new ParamsError("الوصف (prompt) مطلوب ولا يمكن أن يكون فارغًا");
  }

  // سجّل المهمة في Turso قبل أي نداء خارجي — تبقى قابلة للتتبع حتى لو انقطع الاتصال
  const taskId = randomUUID();
  await insertTask({
    id: taskId,
    model: model.canonical,
    type: opts.type,
    prompt: input.prompt,
    paramsJson: JSON.stringify({ raw: input }),
    status: "processing",
  });

  const outcome = await attemptCreation(taskId, model, input);
  if (!outcome) return (await getTask(taskId))!; // بانتظار مفتاح صالح — processing
  if (outcome.syncUrls) return (await getTask(taskId))!; // صورة متزامنة اكتملت فورًا

  return waitForCompletion(taskId, model, outcome, opts.waitSeconds, opts.notify);
}

// استطلاع واحد سريع (يُستخدم من get_task — لا يحجب طويلًا)
async function singleCheck(taskId: string, model: ModelDef, outcome: CreateOutcome): Promise<Task> {
  const adapter = adapterFor(outcome.key.provider as "kie" | "cometapi");
  let result;
  try {
    result = await adapter.checkTask(outcome.key, outcome.providerTaskId!);
  } catch (e) {
    const c = classifyProviderError(e);
    if (c.cls === "disabled" || c.cls === "exhausted") {
      if (c.cls === "disabled") await setKeyStatus(outcome.key.id, "disabled", `${c.cls}: ${c.message}`);
      if (c.cls === "exhausted") await setKeyStatus(outcome.key.id, "exhausted", `${c.cls}: ${c.message}`);
      await bumpKeyCounters(outcome.key.id, false, `${c.cls}: ${c.message}`);
      await updateTask(taskId, {}, attemptRecord(outcome.key, false, c.cls, c.message));
      await recreateWithNextKey(taskId, model);
    }
    return (await getTask(taskId))!; // مؤقت أو بعد إعادة الإنشاء — الحالة تُكشف في get_task القادم
  }

  if (result.status === "completed" && result.urls?.length) {
    await updateTask(taskId, { status: "completed", progress: 100, resultUrls: result.urls, errorMessage: null });
  } else if (result.status === "failed") {
    const reason = String(result.error ?? "");
    if (isKeyOrBalanceMessage(reason)) {
      await bumpKeyCounters(outcome.key.id, false, reason.slice(0, 300));
      await updateTask(taskId, {}, attemptRecord(outcome.key, false, "midtask-key", reason));
      await recreateWithNextKey(taskId, model);
    } else {
      await updateTask(taskId, { status: "failed", errorMessage: sanitizeErrorForClient(reason) });
    }
  } else if (typeof result.progress === "number") {
    const current = (await getTask(taskId))?.progress ?? 0;
    await updateTask(taskId, { progress: Math.max(current, Math.min(99, result.progress)) });
  }
  return (await getTask(taskId))!;
}

// تحديث مهمة جارية من المزود — تُستدعى من get_task
export async function refreshTask(taskId: string): Promise<Task> {
  const task = await getTask(taskId);
  if (!task) throw new ParamsError(`مهمة غير موجودة: ${taskId}`);
  if (task.status !== "processing" && task.status !== "pending") return task;

  if (task.provider === "merger") return refreshMergeTask(task);

  const model = findModel(task.model) ?? defaultModel(task.type === "image" ? "image" : "video");

  // لم يُنشأ لدى المزود بعد (فشل على كل المفاتيح سابقًا) → أعد المحاولة بعد التهدئة (~45 ثانية)
  if (!task.provider || !task.providerTaskId) {
    const params = safeParse(task.paramsJson) as { lastAllFailedAt?: string };
    if (params.lastAllFailedAt && Date.now() - new Date(params.lastAllFailedAt).getTime() < RETRY_COOLDOWN_MS) {
      return task; // ضمن فترة التهدئة — لا نضغط المزودين
    }
    const retry = await recreateWithNextKey(taskId, model);
    if (!retry) return (await getTask(taskId))!;
    if (retry.syncUrls) return (await getTask(taskId))!;
    return singleCheck(taskId, model, retry);
  }

  const key = await findKeyById(task.keyId);
  if (!key) {
    // المفتاح المعطّل يدويًا أو حُذف → أعد الإنشاء على المفتاح التالي
    await recreateWithNextKey(taskId, model);
    return (await getTask(taskId))!;
  }
  return singleCheck(taskId, model, { provider: task.provider, key, providerTaskId: task.providerTaskId });
}

async function findKeyById(keyId: string | null): Promise<ApiKey | null> {
  if (!keyId) return null;
  const k = await getKey(keyId);
  // المفتاح المعطّل يدويًا لا يُستخدم — المعلّم exhausted يبقى في التجربة (المواصفة 4.1)
  if (!k || k.status === "disabled") return null;
  return k;
}

// قفل في الذاكرة يمنع تشغيل process مرتين متزامنتين (runMerge و get_task)
const processInFlight = new Set<string>();

// إطلاق process خلفيًا وبمرة واحدة فقط
function fireProcessOnce(taskId: string, jobId: string): void {
  if (processInFlight.has(jobId)) return;
  processInFlight.add(jobId);
  void (async () => {
    try {
      const job = await merger.startMergeProcess(jobId);
      if (job.status === "done") {
        await updateTask(taskId, {
          status: "completed",
          progress: 100,
          resultUrls: [merger.mergerResultUrl(job.jobId, job.videoUrl, job.downloadUrl)],
          errorMessage: null,
        });
      } else if (job.status === "failed") {
        await updateTask(taskId, { status: "failed", errorMessage: sanitizeErrorForClient(job.error ?? "فشل الدمج") });
      } else {
        await updateTask(taskId, { progress: Math.max(0, job.progress) });
      }
    } catch (e) {
      if (e instanceof merger.MergerHttpError) {
        // خطأ معلن من الخدمة = فشل حتمي فوري (لا إعادة محاولة)
        await updateTask(taskId, { status: "failed", errorMessage: sanitizeMergerError(e) });
      }
      // أخطاء الشبكة مؤقتة — الاستطلاع في get_task سيكشف الحالة لاحقًا
    } finally {
      processInFlight.delete(jobId);
    }
  })();
}

function sanitizeMergerError(e: merger.MergerHttpError): string {
  if (e.status === 404) return "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)";
  return `فشل الدمج: ${e.message.slice(0, 200)}`;
}

// حل مصادر الدمج: task_ids أولًا (من القاعدة) ثم urls المباشرة بنفس ترتيبها
export interface MergeResolution {
  urls: string[];
  failures: Array<{ task_id?: string; url?: string; reason: string }>;
}

export async function resolveMergeSources(args: { urls?: string[]; task_ids?: string[] }): Promise<MergeResolution> {
  const resolved: string[] = [];
  const failures: MergeResolution["failures"] = [];

  for (const tid of args.task_ids ?? []) {
    const t = await getTask(String(tid));
    if (t && t.status === "completed" && t.resultUrls.length > 0 && t.type !== "image") {
      resolved.push(t.resultUrls[0]);
    } else if (!t) {
      failures.push({ task_id: String(tid), reason: "مهمة غير موجودة" });
    } else if (t.status !== "completed") {
      failures.push({ task_id: String(tid), reason: `المهمة ليست مكتملة (الحالة: ${t.status})` });
    } else {
      failures.push({ task_id: String(tid), reason: "لا توجد روابط نتيجة مخزنة" });
    }
  }
  for (const u of args.urls ?? []) {
    if (/^https?:\/\/\S+$/i.test(String(u))) {
      resolved.push(String(u));
    } else {
      failures.push({ url: String(u), reason: "رابط غير صالح (يجب أن يكون http/https مباشرًا وعامًا)" });
    }
  }
  return { urls: resolved, failures };
}

// دمج مقاطع — runMerge (قسم 7.3)
export async function runMerge(opts: {
  args: { urls?: string[]; task_ids?: string[]; wait_seconds?: number };
  waitSeconds: number;
  notify?: Notify;
}): Promise<Task> {
  const notify = opts.notify;
  const { urls, failures } = await resolveMergeSources(opts.args);

  if (urls.length < 2) {
    let detail = "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.";
    if (failures.length) {
      detail += "\nتفاصيل المصادر غير الصالحة:";
      for (const f of failures) detail += `\n- ${f.task_id ? `task_id ${f.task_id}` : `url ${f.url}`}: ${f.reason}`;
    }
    throw new ParamsError(detail);
  }
  if (urls.length > 10) {
    throw new ParamsError("❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).");
  }

  // سجّل مهمة الدمج في Turso أولًا
  const taskId = randomUUID();
  await insertTask({
    id: taskId,
    provider: "merger",
    model: "video-merger",
    type: "merge",
    prompt: `دمج ${urls.length} مقاطع`,
    paramsJson: JSON.stringify({ urls, processStarted: false }),
    status: "processing",
  });

  let job: merger.MergerJob;
  try {
    job = await merger.createMergeJob(urls);
  } catch (e) {
    if (e instanceof merger.MergerHttpError) {
      await updateTask(taskId, { status: "failed", errorMessage: sanitizeMergerError(e) });
      return (await getTask(taskId))!;
    }
    // شبكتنا = مؤقت — مهمة بدون jobId، وget_task سيعيد الإنشاء بعد التهدئة
    await updateTask(taskId, { errorMessage: "بانتظار إعادة الاتصال بخدمة الدمج…" });
    return (await getTask(taskId))!;
  }

  await updateTask(taskId, { providerTaskId: job.jobId });
  fireProcessOnce(taskId, job.jobId);

  // نافذة انتظار: استطلاع كل 3 ثوانٍ مع كتابة كل تحديث في Turso فورًا
  const deadline = Date.now() + opts.waitSeconds * 1000;
  let lastProgress = 0;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const st = await merger.getMergeJob(job.jobId);
      if (st.status === "done") {
        await updateTask(taskId, {
          status: "completed",
          progress: 100,
          resultUrls: [merger.mergerResultUrl(job.jobId, st.videoUrl, st.downloadUrl)],
          errorMessage: null,
        });
        notify?.({ progress: 100, total: 100, message: "اكتمل الدمج" });
        return (await getTask(taskId))!;
      }
      if (st.status === "failed") {
        await updateTask(taskId, { status: "failed", errorMessage: sanitizeErrorForClient(st.error ?? "فشل الدمج") });
        return (await getTask(taskId))!;
      }
      lastProgress = Math.max(lastProgress, st.progress);
      await updateTask(taskId, { progress: Math.min(99, lastProgress) });
      notify?.({ progress: Math.min(99, lastProgress), total: 100, message: `قيد الدمج… ${Math.min(99, lastProgress)}%` });
    } catch {
      // أخطاء شبكتنا مؤقتة → استمر بالاستعلام حتى نهاية النافذة
    }
  }

  notify?.({ progress: lastProgress, total: 100, message: "لا يزال الدمج قيد المعالجة — تابع بـ get_task" });
  return (await getTask(taskId))!;
}

// تحديث مهمة دمج جارية — refreshMergeTask (قسم 7.3.6)
export async function refreshMergeTask(task: Task): Promise<Task> {
  const params = safeParse(task.paramsJson) as { urls?: string[]; processStarted?: boolean; lastAllFailedAt?: string };

  // لم تُنشأ مهمة لدى الخدمة بعد → أعد الإنشاء بعد التهدئة
  if (!task.providerTaskId) {
    if (params.lastAllFailedAt && Date.now() - new Date(params.lastAllFailedAt).getTime() < RETRY_COOLDOWN_MS) return task;
    if (!params.urls || params.urls.length < 2) return task;
    try {
      const job = await merger.createMergeJob(params.urls);
      await updateTask(task.id, { providerTaskId: job.jobId, errorMessage: null });
      fireProcessOnce(task.id, job.jobId);
    } catch (e) {
      if (e instanceof merger.MergerHttpError) {
        await updateTask(task.id, { status: "failed", errorMessage: sanitizeMergerError(e) });
      } else {
        await updateTask(task.id, { paramsJson: JSON.stringify({ ...params, lastAllFailedAt: new Date().toISOString() }) });
      }
    }
    return (await getTask(task.id))!;
  }

  let st: merger.MergerJob;
  try {
    st = await merger.getMergeJob(task.providerTaskId);
  } catch (e) {
    if (e instanceof merger.MergerHttpError) {
      // 404 = حُذفت المهمة من الخدمة أو انتهت صلاحيتها → فشل نهائي
      await updateTask(task.id, { status: "failed", errorMessage: sanitizeMergerError(e) });
      return (await getTask(task.id))!;
    }
    return task; // شبكة — تبقى processing
  }

  if (st.status === "done") {
    await updateTask(task.id, {
      status: "completed",
      progress: 100,
      resultUrls: [merger.mergerResultUrl(st.jobId, st.videoUrl, st.downloadUrl)],
      errorMessage: null,
    });
  } else if (st.status === "failed") {
    await updateTask(task.id, { status: "failed", errorMessage: sanitizeErrorForClient(st.error ?? "فشل الدمج") });
  } else {
    // قيد المعالجة ولم يُنفَّذ process بعد → أطلقه الآن (القفل يمنع التزامن)
    if (!params.processStarted) {
      await updateTask(task.id, { paramsJson: JSON.stringify({ ...params, processStarted: true }) });
      fireProcessOnce(task.id, st.jobId);
    }
    await updateTask(task.id, { progress: Math.min(99, st.progress || task.progress) });
  }
  return (await getTask(task.id))!;
}
