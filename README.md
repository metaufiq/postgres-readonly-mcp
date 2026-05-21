# postgres-readonly-mcp

A Node.js [Model Context Protocol](https://modelcontextprotocol.io) server that exposes **read-only** access to one or more PostgreSQL databases.

Every query runs inside a `BEGIN TRANSACTION READ ONLY` block and is rolled back, so writes are blocked at the DB level even if the role has write privileges.

The server speaks MCP over **Streamable HTTP**, so a single instance can be shared by multiple MCP clients (e.g. several Claude Code sessions) simultaneously — all hitting the same pool of active DB connections.

## How it works

1. Start the MCP server once. It binds `http://127.0.0.1:7432`, serving:
   - `/`     — local **management UI**
   - `/mcp`  — MCP Streamable HTTP endpoint for clients
2. Open the UI in a browser to:
   - Paste a PostgreSQL URL and give it a name.
   - See the list of saved connections.
   - **Connect / Disconnect** any saved connection.
   - Click a connection to edit its name, URL, or password.
   - Delete a connection.
3. MCP tools query whichever connections are currently active by name.
4. When the MCP server shuts down (SIGINT/SIGTERM), all DB pools are closed. Saved configs persist in `connections.json` next to the server binary. To reconnect after restart, open the UI again and click **Connect**.

Both the management UI and the MCP endpoint are bound to `127.0.0.1` only and never leave your machine.

## Install & run

### Option A — Docker (recommended)

```bash
docker compose up -d --build
```

This builds the image and starts a long-running container that publishes the UI + MCP endpoint on `127.0.0.1:7432`. The container restarts automatically (`unless-stopped`), and `connections.json` is bind-mounted from the repo so saved configs persist on the host.

Common commands:

```bash
docker compose logs -f          # follow logs
docker compose restart          # restart after editing connections.json by hand
docker compose down             # stop and remove the container
docker compose up -d --build    # rebuild after pulling new code
```

**Connecting to a Postgres on your host machine:** inside the container, `localhost` refers to the container itself. Use `host.docker.internal` as the host in your connection URL instead — the `extra_hosts` mapping in `docker-compose.yml` makes this work on Linux as well as macOS/Windows.

### Option B — Run with Node directly

```bash
npm install
npm run build
npm start
# stderr:
#   postgres-readonly-mcp v0.3.0
#   Management UI: http://127.0.0.1:7432
#   MCP endpoint:  http://127.0.0.1:7432/mcp
#   Config file:   <repo>/connections.json
```

Run this once and leave it running (e.g. in a terminal tab, tmux pane, or as a `launchd` agent). All MCP clients connect to the same `/mcp` URL.

For development with auto-reload (uses `tsx`):

```bash
npm run dev
```

Override the UI port:

```bash
PORT=8123 npm start
```

(When running under Docker, override the port by changing the published port in `docker-compose.yml` rather than setting `PORT`.)

## MCP tools

| Tool                | Args                                     | Purpose                                         |
| ------------------- | ---------------------------------------- | ----------------------------------------------- |
| `list_connections`  | —                                        | List saved connections and which are active.    |
| `query`             | `connection`, `sql`                      | Run a read-only SQL query on a named connection.|
| `list_tables`       | `connection`, `schema?`                  | List tables on a connection.                    |
| `describe_table`    | `connection`, `table`, `schema?`         | Show columns of a table.                        |

If a tool targets a connection that isn't active, it returns an error telling you to open the management UI and connect.

## Configure in MCP clients

Once the server is running, point any MCP client at `http://127.0.0.1:7432/mcp`.

**Claude Code** — in your project's `.mcp.json` (or `~/.claude.json`):

```json
{
  "mcpServers": {
    "postgres-readonly": {
      "type": "http",
      "url": "http://127.0.0.1:7432/mcp"
    }
  }
}
```

**Claude Desktop** — in `~/Library/Application Support/Claude/claude_desktop_config.json`, same shape. Claude Desktop will share the running server with every Claude Code session.

## Storage

Saved connections live in `connections.json` at the repo root (mode `0600`, gitignored). Under Docker this file is bind-mounted into the container, so edits made in the UI persist on the host.

By default, the file stores the PostgreSQL URL **with the password stripped** — only host, port, user, and database name are persisted. Passwords are entered at the management UI on each `Connect` and live only in the pg pool's memory. After the MCP server restarts you must re-enter the password to reconnect.

If you tick **Save password in connections.json** (when adding a new connection or editing an existing one), the password is kept inside the stored URL and the entry is flagged with `"savePassword": true`. Connections with a saved password reconnect without prompting. Use this only on trusted machines — the file is `0600` but still plain text on disk.

On first load after upgrading, any password embedded in an existing `connections.json` entry that is **not** flagged `"savePassword": true` is automatically stripped from the file.

## Project layout

```
src/
  index.ts     # MCP server entry — wires Streamable HTTP MCP transport + web UI
  store.ts     # Read/write connections.json
  manager.ts   # In-memory pg pools, keyed by connection name
  web.ts       # Local HTTP server: JSON API + serves the UI
  ui.ts        # HTML/CSS/JS for the management page
```

Source is TypeScript (ESM, NodeNext). `npm run build` compiles to `dist/`.
