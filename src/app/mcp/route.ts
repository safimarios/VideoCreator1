// خادم MCP على المسار /mcp — النقل Streamable HTTP عبر SDK الرسمي
// لا JSON-RPC يدوي: McpServer + WebStandardStreamableHTTPTransport (Request/Response قياسية)
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SERVER_INFO, SERVER_INSTRUCTIONS, registerTools } from "@/lib/mcpTools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// جلسات نشطة في ذاكرة النسخة (Serverless: كل نسخة تحتفظ بجلساتها)
const sessions = new Map<string, { server: McpServer; transport: WebStandardStreamableHTTPServerTransport }>();

// حماية اختيارية: إن ضُبط MCP_ACCESS_TOKEN يُطلب Bearer token على /mcp
function authorized(req: Request): boolean {
  const token = process.env.MCP_ACCESS_TOKEN;
  if (!token) return true;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${token}`;
}

function jsonRpcError(status: number, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status });
}

function createSession(): { server: McpServer; transport: WebStandardStreamableHTTPServerTransport } {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server);
  // استجابات JSON مباشرة (متوافقة مع المواصفة وأسهل في Serverless من بث SSE لكل نداء)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
  });
  void server.connect(transport);
  return { server, transport };
}

export async function POST(req: Request): Promise<Response> {
  if (!authorized(req)) {
    return jsonRpcError(401, -32001, "مطلوب توثيق: Authorization: Bearer <MCP_ACCESS_TOKEN>");
  }

  const sessionId = req.headers.get("mcp-session-id");
  let session = sessionId ? sessions.get(sessionId) : undefined;

  if (sessionId && !session) {
    return jsonRpcError(404, -32001, "جلسة غير موجودة أو منتهية — أعد التهيئة بـ initialize");
  }
  if (!session) {
    session = createSession();
  }

  let corrupted = false;
  try {
    // النقل القياسي يعيد Response مباشرة مع ترويسة mcp-session-id عند التهيئة
    return await session.transport.handleRequest(req);
  } catch (e) {
    // جلسة تالفة أو خطأ غير متوقع — نظّف الجلسة
    corrupted = true;
    const sid = session.transport.sessionId;
    if (sid) sessions.delete(sid);
    try { await session.transport.close(); } catch { /* تجاهل */ }
    return jsonRpcError(400, -32700, `طلب غير صالح: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    // احفظ الجلسة بعد أول initialize فقط (sessionId يُولَّد أثناء handleRequest)
    if (!corrupted) {
      const sid = session.transport.sessionId;
      if (sid && !sessions.has(sid)) sessions.set(sid, session);
    }
  }
}

export async function GET(): Promise<Response> {
  // لا نقدم بث SSE استقباليًا — مسموح بالمواصفة (405)
  return jsonRpcError(405, -32001, "Method Not Allowed — استخدم POST لرسائل JSON-RPC");
}

export async function DELETE(req: Request): Promise<Response> {
  if (!authorized(req)) {
    return jsonRpcError(401, -32001, "مطلوب توثيق: Authorization: Bearer <MCP_ACCESS_TOKEN>");
  }
  const sessionId = req.headers.get("mcp-session-id");
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
      sessions.delete(sessionId);
      try { await session.transport.close(); } catch { /* تجاهل */ }
    }
  }
  return new Response(null, { status: 200 });
}
