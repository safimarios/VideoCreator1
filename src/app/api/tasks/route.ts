// بيانات لوحة المهام — أحدث المهام + الإحصائيات
import { listRecentTasks, taskStats, type TaskStatus, type Task } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? 20)));
  const type = url.searchParams.get("type") as Task["type"] | null;
  const status = url.searchParams.get("status") as TaskStatus | null;

  const [tasks, stats] = await Promise.all([
    listRecentTasks(limit, { type: type ?? undefined, status: status ?? undefined }),
    taskStats(),
  ]);

  return Response.json({
    stats,
    tasks: tasks.map((t) => ({
      id: t.id,
      type: t.type,
      model: t.model,
      provider: t.provider,
      status: t.status,
      progress: t.progress,
      prompt: t.prompt,
      resultUrls: t.resultUrls,
      errorMessage: t.errorMessage,
      attemptsCount: t.attempts.length,
      createdAt: t.createdAt,
      completedAt: t.completedAt,
    })),
  });
}
