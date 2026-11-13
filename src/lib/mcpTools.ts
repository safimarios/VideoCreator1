// تعريف أدوات MCP الخمس — الأوصاف بالإنجليزية كما في المواصفة (العميل يقرأها)
// ونتائج الاستدعاء تُصاغ بالعربية
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  runGeneration,
  runMerge,
  refreshTask,
  NoKeysError,
  type Notify,
} from "./coordinator";
import { listRecentTasks, type Task } from "./turso";
import { ParamsError } from "./errors";

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

// ---------------- صياغة الردود العربية ----------------

function linksBlock(urls: string[]): string {
  return urls.map((u) => `الرابط المباشر: ${u}`).join("\n\n");
}

export function formatTaskResponse(task: Task): { text: string; isError: boolean } {
  if (task.status === "completed" && task.resultUrls.length) {
    if (task.type === "image") {
      const first = task.resultUrls[0];
      const rest = task.resultUrls.length > 1 ? `\n\n${linksBlock(task.resultUrls.slice(1))}` : "";
      return { text: `✅ تم توليد الصورة بنجاح\n\n![image](${first})\n\nالرابط المباشر: ${first}${rest}`, isError: false };
    }
    if (task.type === "merge") {
      return {
        text: `✅ تم دمج المقاطع بنجاح\n\n${linksBlock(task.resultUrls)}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`,
        isError: false,
      };
    }
    return { text: `✅ تم توليد الفيديو بنجاح\n\n${linksBlock(task.resultUrls)}`, isError: false };
  }
  if (task.status === "failed") {
    return { text: `❌ فشلت المهمة: ${task.errorMessage ?? "سبب غير معروف"}`, isError: true };
  }
  return {
    text: `⏳ المهمة قيد المعالجة — task_id: ${task.id}\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`,
    isError: false,
  };
}

const TYPE_LABEL: Record<string, string> = { image: "صورة", video: "فيديو", merge: "دمج" };
const STATUS_LABEL: Record<string, string> = {
  completed: "مكتملة",
  failed: "فاشلة",
  processing: "قيد المعالجة",
  pending: "بالانتظار",
};

function formatListResponse(tasks: Task[]): string {
  if (!tasks.length) return "لا توجد وسائط مخزنة بعد — ولّد صورة أو فيديو أولًا بـ generate_image أو generate_video.";
  const lines = tasks.map((t) => {
    const head = `• [${TYPE_LABEL[t.type] ?? t.type}] ${STATUS_LABEL[t.status] ?? t.status} — ${t.model} — task_id: ${t.id}`;
    const urls = t.resultUrls.length ? `\n  ${t.resultUrls.join("\n  ")}` : "";
    const err = t.status === "failed" && t.errorMessage ? `\n  السبب: ${t.errorMessage}` : "";
    return `${head}${urls}${err}`;
  });
  return `أحدث الوسائط المخزنة (${tasks.length}):\n\n${lines.join("\n\n")}`;
}

// ---------------- مخططات الأدوات (مطابقة للمواصفة حرفيًا) ----------------

const imageSchema = {
  prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
  model: z
    .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
    .default("gpt-image-2-6/flare-text-to-image")
    .optional(),
  aspect_ratio: z
    .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
    .default("auto")
    .optional(),
  resolution: z.enum(["1K", "2K", "4K"]).default("1K").optional(),
  background: z.enum(["auto", "transparent", "opaque"]).default("auto").optional().describe("Only applied at 1K."),
  output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png").optional(),
  wait_seconds: z.number().int().min(0).max(240).default(90).optional(),
};

const videoSchema = {
  prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
  image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
  model: z
    .enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
    .default("grok-imagine-video-1-5-preview")
    .optional(),
  aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto").optional(),
  resolution: z.enum(["480p", "720p", "1080p"]).default("480p").optional(),
  enable_audio: z.boolean().default(true).optional(),
  duration: z.number().int().min(1).max(15).default(8).optional().describe("Duration in seconds."),
  wait_seconds: z.number().int().min(0).max(240).default(25).optional(),
};

// الدمج بلا resolution/fps — خدمة الدمج تثبّت المخرج، والحد 10 مقاطع
const mergeSchema = {
  urls: z
    .array(z.string())
    .min(2)
    .max(10)
    .optional()
    .describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video."),
  task_ids: z
    .array(z.string())
    .min(2)
    .max(10)
    .optional()
    .describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."),
  wait_seconds: z.number().int().min(0).max(240).default(60).optional(),
};

const getTaskSchema = {
  task_id: z.string(),
};

const listMediaSchema = {
  type: z.enum(["image", "video", "merge"]).optional(),
  status: z.enum(["completed", "failed", "processing"]).optional(),
  limit: z.number().int().min(1).max(50).default(10).optional(),
};

// ---------------- التسجيل في خادم MCP ----------------

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

// بناء دالة بث التقدم من _meta.progressToken إن زوّدها العميل
function notifyFromExtra(extra: RequestHandlerExtra<never, never>): Notify | undefined {
  const meta = (extra as { _meta?: { progressToken?: string | number } })._meta;
  const token = meta?.progressToken;
  if (token === undefined) return undefined;
  return (info: { progress: number; total: number; message: string }) => {
    void extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress: info.progress, total: info.total, message: info.message },
      } as never)
      .catch(() => undefined);
  };
}

function toResult(r: { text: string; isError: boolean }): ToolResult {
  return { content: [{ type: "text", text: r.text }], isError: r.isError };
}

export function registerTools(server: McpServer): void {
  const run = async (fn: () => Promise<{ text: string; isError: boolean }>): Promise<ToolResult> => {
    try {
      return toResult(await fn());
    } catch (e) {
      // سجّل الخطأ كاملًا في سجل السيرفر (دون إرسال تفاصيل المفاتيح للعميل)
      console.error("[tool-error]", e instanceof Error ? e.stack : e);
      if (e instanceof NoKeysError) return toResult({ text: e.message, isError: false });
      if (e instanceof ParamsError) {
        const t = e.message.startsWith("❌") ? e.message : `❌ ${e.message}`;
        return toResult({ text: t, isError: true });
      }
      const msg = e instanceof Error ? e.message : String(e);
      // أي خطأ آخر يُعرض دون الإشارة لمفاتيح أو رصيد
      const safe = /key|balance|credit|quota|402|401|unauthorized/i.test(msg)
        ? "تعذر إكمال الطلب حاليًا — أعد المحاولة"
        : msg;
      return toResult({ text: `❌ ${safe}`, isError: true });
    }
  };

  server.registerTool(
    "generate_image",
    {
      title: "Generate Image",
      description:
        "Generate an image using gpt-image-2-6/flare-text-to-image with automatic failover across all active keys. Return the image URL if it completes within the wait window; otherwise return a task_id. Call get_task about every 10 seconds until completed, then show the URL and stop polling.",
      inputSchema: imageSchema,
    },
    async (args, extra) =>
      run(async () => {
        const task = await runGeneration({
          type: "image",
          args: args as Record<string, unknown>,
          waitSeconds: Number((args as { wait_seconds?: number }).wait_seconds ?? 90),
          notify: notifyFromExtra(extra as unknown as RequestHandlerExtra<never, never>),
        });
        return formatTaskResponse(task);
      })
  );

  server.registerTool(
    "generate_video",
    {
      title: "Generate Video",
      description:
        "Generate a video using grok-imagine-video-1-5-preview (native synchronized audio, optional image-to-video). Video generation takes minutes: wait briefly while streaming progress, then return a task_id. Poll using get_task about every 10 seconds.",
      inputSchema: videoSchema,
    },
    async (args, extra) =>
      run(async () => {
        const task = await runGeneration({
          type: "video",
          args: args as Record<string, unknown>,
          waitSeconds: Number((args as { wait_seconds?: number }).wait_seconds ?? 25),
          notify: notifyFromExtra(extra as unknown as RequestHandlerExtra<never, never>),
        });
        return formatTaskResponse(task);
      })
  );

  server.registerTool(
    "merge_videos",
    {
      title: "Merge Videos",
      description:
        "Merge multiple clips into one final video in the order provided. Pass urls (public direct video URLs, such as links returned by generate_video) or task_ids (completed video tasks whose URLs are looked up in the database in order; ideal after generating multiple clips). Merging is usually quick: wait briefly while streaming progress, then return a merge task_id; track it using get_task. the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: mergeSchema,
    },
    async (args, extra) =>
      run(async () => {
        const task = await runMerge({
          args: args as { urls?: string[]; task_ids?: string[] },
          waitSeconds: Number((args as { wait_seconds?: number }).wait_seconds ?? 60),
          notify: notifyFromExtra(extra as unknown as RequestHandlerExtra<never, never>),
        });
        return formatTaskResponse(task);
      })
  );

  server.registerTool(
    "get_task",
    {
      title: "Get Task",
      description:
        "Track any task by its ID: image or video generation and merging. Reads from Turso and refreshes status from the provider/service if it is still running. Poll about every 10 seconds; when completed, show the result URLs to the user and stop polling.",
      inputSchema: getTaskSchema,
    },
    async (args) =>
      run(async () => {
        const task = await refreshTask(String((args as { task_id: string }).task_id));
        return formatTaskResponse(task);
      })
  );

  server.registerTool(
    "list_media",
    {
      title: "List Media",
      description:
        "Retrieve the most recent stored images, videos, and merged videos, with their URLs, from the database without generating them again.",
      inputSchema: listMediaSchema,
    },
    async (args) =>
      run(async () => {
        const a = args as { type?: "image" | "video" | "merge"; status?: "completed" | "failed" | "processing"; limit?: number };
        const tasks = await listRecentTasks(Number(a.limit ?? 10), { type: a.type, status: a.status });
        return { text: formatListResponse(tasks), isError: false };
      })
  );
}
