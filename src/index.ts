#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Server as HttpServer } from "node:http";
import { ConnectionManager, assertReadOnlySql } from "./manager.js";
import { startWebServer } from "./web.js";
import * as store from "./store.js";

const port = Number(process.env.PORT || 7432);
const host = process.env.HOST || "127.0.0.1";
const manager = new ConnectionManager();

const server = new Server(
  { name: "postgres-readonly-mcp", version: "0.3.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const a = args as Record<string, unknown>;
  try {
    if (name === "list_connections") {
      const saved = await store.loadAll();
      const out = saved.map((c) => ({
        name: c.name,
        active: manager.isActive(c.name),
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
      };
    }

    const conn = String(a.connection ?? "");

    if (name === "query") {
      const sql = String(a.sql ?? "");
      assertReadOnlySql(sql);
      const result = await manager.runReadOnly(conn, (client) =>
        client.query(sql),
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
      };
    }

    if (name === "list_tables") {
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
      return {
        content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
      };
    }

    if (name === "describe_table") {
      const schema = a.schema ? String(a.schema) : "public";
      const table = String(a.table ?? "");
      const result = await manager.runReadOnly(conn, (client) =>
        client.query(
          "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position",
          [schema, table],
        ),
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
      isError: true,
    };
  }
});

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
});

let webServer: HttpServer | undefined;
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    webServer?.close();
  } catch {}
  try {
    await transport.close();
  } catch {}
  await manager.closeAll();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function main(): Promise<void> {
  await server.connect(transport);
  const { server: wsv } = await startWebServer({
    manager,
    port,
    host,
    mcpHandler: (req, res) => transport.handleRequest(req, res),
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
