# postgres-readonly-mcp

A Node.js [Model Context Protocol](https://modelcontextprotocol.io) server that exposes **read-only** access to one or more PostgreSQL databases.

Every query runs inside a `BEGIN TRANSACTION READ ONLY` block and is rolled back, so writes are blocked at the DB level even if the role has write privileges.

## How it works

1. Start the MCP server.
2. It boots a small local **management UI** on `http://127.0.0.1:7432` (printed to stderr on start).
3. Open the UI in a browser to:
   - Paste a PostgreSQL URL and give it a name.
   - See the list of saved connections.
   - **Connect / Disconnect** any saved connection.
   - Click a connection to edit its name, URL, or password.
   - Delete a connection.
4. MCP tools query whichever connections are currently active by name.
5. When the MCP server shuts down (SIGINT/SIGTERM), all DB pools are closed. Saved configs persist in `~/.postgres-readonly-mcp/connections.json`. To reconnect after restart, open the UI again and click **Connect**.

The management UI is bound to `127.0.0.1` only and never leaves your machine.

## Install & run

```bash
npm install
npm run build
npm start
# stderr:
#   postgres-readonly-mcp v0.2.0
#   Management UI: http://127.0.0.1:7432
#   Config file:   /Users/<you>/.postgres-readonly-mcp/connections.json
```

For development with auto-reload (uses `tsx`):

```bash
npm run dev
```

Override the UI port:

```bash
PORT=8123 npm start
```

## MCP tools

| Tool                | Args                                     | Purpose                                         |
| ------------------- | ---------------------------------------- | ----------------------------------------------- |
| `list_connections`  | —                                        | List saved connections and which are active.    |
| `query`             | `connection`, `sql`                      | Run a read-only SQL query on a named connection.|
| `list_tables`       | `connection`, `schema?`                  | List tables on a connection.                    |
| `describe_table`    | `connection`, `table`, `schema?`         | Show columns of a table.                        |

If a tool targets a connection that isn't active, it returns an error telling you to open the management UI and connect.

## Configure in Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "postgres-readonly": {
      "command": "node",
      "args": ["/absolute/path/to/postgres-readonly-mcp/dist/index.js"]
    }
  }
}
```

## Storage

Saved connections live in `~/.postgres-readonly-mcp/connections.json` (mode `0600`). The file stores the PostgreSQL URL **with the password stripped** — only host, port, user, and database name are persisted. Passwords are entered at the management UI on each `Connect` and live only in the pg pool's memory; they are never written to disk. After the MCP server restarts, you must re-enter the password to reconnect.

On first load after upgrading, any password embedded in an existing `connections.json` is automatically stripped from the file.

## Project layout

```
src/
  index.ts     # MCP server entry — wires stdio MCP transport + web UI
  store.ts     # Read/write connections.json
  manager.ts   # In-memory pg pools, keyed by connection name
  web.ts       # Local HTTP server: JSON API + serves the UI
  ui.ts        # HTML/CSS/JS for the management page
```

Source is TypeScript (ESM, NodeNext). `npm run build` compiles to `dist/`.
