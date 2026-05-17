import http, {
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import * as store from "./store.js";
import { HTML } from "./ui.js";
import type { ConnectionManager } from "./manager.js";

interface UrlInfo {
  host: string;
  port: string;
  db: string;
  user: string;
}

function urlInfo(connStr: string): UrlInfo | null {
  try {
    const u = new URL(connStr);
    return {
      host: u.hostname,
      port: u.port,
      db: u.pathname.replace(/^\//, ""),
      user: decodeURIComponent(u.username || ""),
    };
  } catch {
    return null;
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) {
        req.destroy();
        reject(new Error("payload too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export interface StartWebServerOptions {
  manager: ConnectionManager;
  port?: number;
  host?: string;
}

export interface StartWebServerResult {
  server: Server;
  url: string;
}

export function startWebServer({
  manager,
  port = 7432,
  host = "127.0.0.1",
}: StartWebServerOptions): Promise<StartWebServerResult> {
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(
        req.url ?? "/",
        `http://${req.headers.host || "localhost"}`,
      );

      if (req.method === "GET" && u.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(HTML);
        return;
      }

      if (req.method === "GET" && u.pathname === "/api/connections") {
        const list = await store.loadAll();
        return json(res, 200, {
          connections: list.map((c) => ({
            name: c.name,
            url_info: urlInfo(c.url),
            active: manager.isActive(c.name),
          })),
        });
      }

      if (req.method === "POST" && u.pathname === "/api/connections") {
        const body = await readJson(req);
        if (!body.name || !body.url) {
          return json(res, 400, { error: "name and url required" });
        }
        const name = String(body.name);
        const url = String(body.url);
        await store.upsert({ name, url });
        if (body.connect) {
          let password: string | undefined;
          try {
            const parsed = new URL(url);
            if (parsed.password) password = decodeURIComponent(parsed.password);
          } catch {}
          const saved = await store.get(name);
          if (saved) {
            try {
              await manager.connect(name, saved.url, password);
            } catch (err) {
              return json(res, 502, { error: (err as Error).message });
            }
          }
        }
        return json(res, 200, { ok: true });
      }

      const itemMatch = u.pathname.match(/^\/api\/connections\/([^/]+)$/);
      if (itemMatch && req.method === "PUT") {
        const name = decodeURIComponent(itemMatch[1]);
        const body = await readJson(req);
        const existing = await store.get(name);
        if (!existing) return json(res, 404, { error: "not found" });

        const wasActive = manager.isActive(name);
        if (wasActive) await manager.disconnect(name);

        let currentName = name;
        if (body.name && body.name !== name) {
          await store.rename(name, String(body.name));
          currentName = String(body.name);
        }
        if (body.url) {
          await store.upsert({ name: currentName, url: String(body.url) });
        }
        return json(res, 200, { ok: true, name: currentName });
      }

      if (itemMatch && req.method === "DELETE") {
        const name = decodeURIComponent(itemMatch[1]);
        await manager.disconnect(name);
        await store.remove(name);
        return json(res, 200, { ok: true });
      }

      const actMatch = u.pathname.match(
        /^\/api\/connections\/([^/]+)\/(connect|disconnect)$/,
      );
      if (actMatch && req.method === "POST") {
        const name = decodeURIComponent(actMatch[1]);
        const action = actMatch[2];
        if (action === "disconnect") {
          await manager.disconnect(name);
          return json(res, 200, { ok: true });
        }
        const body: Record<string, unknown> = await readJson(req).catch(
          () => ({}),
        );
        const cfg = await store.get(name);
        if (!cfg) return json(res, 404, { error: "not found" });
        const password =
          typeof body.password === "string" && body.password
            ? body.password
            : undefined;
        try {
          await manager.connect(name, cfg.url, password);
          return json(res, 200, { ok: true });
        } catch (err) {
          return json(res, 502, { error: (err as Error).message });
        }
      }

      json(res, 404, { error: "not found" });
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      resolve({ server, url: `http://${host}:${port}` });
    });
  });
}
