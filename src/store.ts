import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = path.join(DIR, "connections.json");

export interface Connection {
  name: string;
  url: string;
}

export function configPath(): string {
  return FILE;
}

export function stripPassword(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) {
      u.password = "";
      return u.toString();
    }
    return url;
  } catch {
    return url;
  }
}

export async function loadAll(): Promise<Connection[]> {
  let raw: Connection[];
  try {
    const txt = await fs.readFile(FILE, "utf8");
    const data = JSON.parse(txt) as { connections?: unknown };
    raw = Array.isArray(data.connections)
      ? (data.connections as Connection[])
      : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  let dirty = false;
  const cleaned = raw.map((c) => {
    const stripped = stripPassword(c.url);
    if (stripped !== c.url) dirty = true;
    return { name: c.name, url: stripped };
  });
  if (dirty) await saveAll(cleaned);
  return cleaned;
}

async function saveAll(connections: Connection[]): Promise<void> {
  await fs.mkdir(DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(FILE, JSON.stringify({ connections }, null, 2), {
    mode: 0o600,
  });
}

export async function upsert({
  name,
  url,
}: Connection): Promise<Connection[]> {
  if (!name || typeof name !== "string") throw new Error("name required");
  if (!url || typeof url !== "string") throw new Error("url required");
  const cleanUrl = stripPassword(url);
  const list = await loadAll();
  const idx = list.findIndex((c) => c.name === name);
  if (idx >= 0) list[idx] = { name, url: cleanUrl };
  else list.push({ name, url: cleanUrl });
  await saveAll(list);
  return list;
}

export async function remove(name: string): Promise<Connection[]> {
  const list = (await loadAll()).filter((c) => c.name !== name);
  await saveAll(list);
  return list;
}

export async function rename(
  oldName: string,
  newName: string,
): Promise<Connection[]> {
  if (oldName === newName) return await loadAll();
  const list = await loadAll();
  if (list.some((c) => c.name === newName)) {
    throw new Error(`A connection named "${newName}" already exists`);
  }
  const idx = list.findIndex((c) => c.name === oldName);
  if (idx < 0) throw new Error(`Connection "${oldName}" not found`);
  list[idx].name = newName;
  await saveAll(list);
  return list;
}

export async function get(name: string): Promise<Connection | null> {
  const list = await loadAll();
  return list.find((c) => c.name === name) ?? null;
}
