import pg, {
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from "pg";

const { Pool } = pg;

interface PgError {
  message?: string;
  code?: string;
  toString?: () => string;
}

const ALLOWED_LEADING_KEYWORD = /^(with|select|explain|show)\b/i;

export function assertReadOnlySql(sql: string): void {
  const stripped = sql
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""')
    .replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g, "''")
    .trim();

  if (!ALLOWED_LEADING_KEYWORD.test(stripped)) {
    throw new Error(
      "Only SELECT, WITH, EXPLAIN, or SHOW statements are allowed.",
    );
  }

  const withoutTrailingSemi = stripped.replace(/;\s*$/, "");
  if (withoutTrailingSemi.includes(";")) {
    throw new Error("Multiple statements are not allowed.");
  }
}

function describeError(err: PgError | null | undefined): string {
  if (!err) return "unknown error";
  const parts: string[] = [];
  if (err.message) parts.push(err.message);
  if (err.code) parts.push(`(code ${err.code})`);
  if (!parts.length && err.toString) parts.push(err.toString());
  return parts.join(" ") || "connection failed";
}

export class ConnectionManager {
  private pools = new Map<string, pg.Pool>();

  isActive(name: string): boolean {
    return this.pools.has(name);
  }

  listActive(): string[] {
    return Array.from(this.pools.keys());
  }

  async connect(name: string, url: string, password?: string): Promise<void> {
    let finalUrl = url;
    if (password) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error("invalid connection URL");
      }
      parsed.password = password;
      finalUrl = parsed.toString();
    }
    if (this.pools.has(name)) await this.disconnect(name);
    const pool = new Pool({ connectionString: finalUrl });
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      await client.query("SELECT 1");
    } catch (err) {
      if (client) client.release();
      await pool.end().catch(() => {});
      throw new Error(describeError(err as PgError));
    }
    client.release();
    this.pools.set(name, pool);
  }

  async disconnect(name: string): Promise<void> {
    const pool = this.pools.get(name);
    if (!pool) return;
    this.pools.delete(name);
    await pool.end().catch(() => {});
  }

  async runReadOnly<T extends QueryResultRow = QueryResultRow>(
    name: string,
    fn: (client: PoolClient) => Promise<QueryResult<T>>,
  ): Promise<QueryResult<T>> {
    const pool = this.pools.get(name);
    if (!pool) {
      throw new Error(
        `Connection "${name}" is not active. Open the management UI to connect.`,
      );
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      await client.query("SET LOCAL statement_timeout = '15s'");
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '15s'");
      return await fn(client);
    } finally {
      try {
        await client.query("ROLLBACK");
      } catch {}
      client.release();
    }
  }

  async closeAll(): Promise<void> {
    const pools = Array.from(this.pools.values());
    this.pools.clear();
    await Promise.all(pools.map((p) => p.end().catch(() => {})));
  }
}
