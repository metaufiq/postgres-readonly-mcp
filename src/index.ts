#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  IncomingMessage,
  Server as HttpServer,
  ServerResponse,
} from "node:http";
import { ConnectionManager, assertReadOnlySql } from "./manager.js";
import { startWebServer } from "./web.js";
import * as store from "./store.js";

const port = Number(process.env.PORT || 7432);
const host = process.env.HOST || "127.0.0.1";
const manager = new ConnectionManager();

const TOOLS = [
    {
      name: "list_connections",
      description:
        "List all saved PostgreSQL connections and which are currently active.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "query",
      description:
        "Run a read-only SQL query against a named, active connection. Wrapped in BEGIN TRANSACTION READ ONLY / ROLLBACK.",
      inputSchema: {
        type: "object",
        properties: {
          connection: {
            type: "string",
            description: "Name of a saved & active connection.",
          },
          sql: { type: "string", description: "The SQL query to execute." },
        },
        required: ["connection", "sql"],
      },
    },
    {
      name: "list_tables",
      description: "List user tables on a named connection.",
      inputSchema: {
        type: "object",
        properties: {
          connection: { type: "string" },
          schema: { type: "string" },
        },
        required: ["connection"],
      },
    },
    {
      name: "describe_table",
      description: "Show column definitions for a table on a named connection.",
      inputSchema: {
        type: "object",
        properties: {
          connection: { type: "string" },
          schema: { type: "string", default: "public" },
          table: { type: "string" },
        },
        required: ["connection", "table"],
      },
    },
];

type ToolArgs = Record<string, unknown>;
type ToolResult = { content: { type: "text"; text: string }[] };
type ToolHandler = (args: ToolArgs) => Promise<ToolResult>;

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

const toolHandlers: Record<string, ToolHandler> = {
  async list_connections() {
    const saved = await store.loadAll();
    return textResult(
      saved.map((c) => ({ name: c.name, active: manager.isActive(c.name) })),
    );
  },

  async query(a) {
    const conn = String(a.connection ?? "");
    const sql = String(a.sql ?? "");
    assertReadOnlySql(sql);
    const result = await manager.runReadOnly(conn, (client) =>
      client.query(sql),
    );
    return textResult(result.rows);
  },

  async list_tables(a) {
    const conn = String(a.connection ?? "");
    const schema = a.schema ? String(a.schema) : null;
    const result = await manager.runReadOnly(conn, (client) =>
      schema
        ? client.query(
            "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
            [schema],
          )
        : client.query(
            "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name",
          ),
    );
    return textResult(result.rows);
  },

  async describe_table(a) {
    const conn = String(a.connection ?? "");
    const schema = a.schema ? String(a.schema) : "public";
    const table = String(a.table ?? "");
    const result = await manager.runReadOnly(conn, (client) =>
      client.query(
        "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position",
        [schema, table],
      ),
    );
    return textResult(result.rows);
  },
};

function createMcpServer(): Server {
  const server = new Server(
    { name: "postgres-readonly-mcp", version: "0.3.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const handler = toolHandlers[name];
    try {
      if (!handler) throw new Error(`Unknown tool: ${name}`);
      return await handler(args as ToolArgs);
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  });

  return server;
}

const transports = new Map<string, StreamableHTTPServerTransport>();

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

function jsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    }),
  );
}

async function mcpHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const sessionId = req.headers["mcp-session-id"];
  const sid = Array.isArray(sessionId) ? sessionId[0] : sessionId;

  if (sid) {
    const existing = transports.get(sid);
    if (!existing) {
      jsonRpcError(res, 404, -32001, "Session not found");
      return;
    }
    await existing.handleRequest(req, res);
    return;
  }

  if (req.method !== "POST") {
    jsonRpcError(res, 400, -32000, "Missing Mcp-Session-Id header");
    return;
  }

  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    jsonRpcError(res, 400, -32700, "Parse error");
    return;
  }

  if (!isInitializeRequest(body)) {
    jsonRpcError(res, 400, -32600, "Invalid Request: expected initialize");
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (newSid) => {
      transports.set(newSid, transport);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) transports.delete(transport.sessionId);
  };
  const mcpServer = createMcpServer();
  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, body);
}

let webServer: HttpServer | undefined;
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    webServer?.close();
  } catch {}
  for (const t of transports.values()) {
    try {
      await t.close();
    } catch {}
  }
  transports.clear();
  await manager.closeAll();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function main(): Promise<void> {
  const { server: wsv } = await startWebServer({
    manager,
    port,
    host,
    mcpHandler,
  });
  webServer = wsv;
  const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  const url = `http://${displayHost}:${port}`;
  console.error(`postgres-readonly-mcp v0.3.0`);
  console.error(`Management UI: ${url}`);
  console.error(`MCP endpoint:  ${url}/mcp`);
  console.error(`Config file:   ${store.configPath()}`);
}

main().catch((err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `Port ${port} is in use. Another postgres-readonly-mcp is already running — point Claude at http://127.0.0.1:${port}/mcp instead of spawning a new one.`,
    );
    process.exit(0);
  }
  console.error("Fatal:", err);
  process.exit(1);
});
