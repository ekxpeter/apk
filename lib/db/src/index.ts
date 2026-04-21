import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import pg from "pg";
import path from "node:path";
import fs from "node:fs";
import * as schema from "./schema";

const { Pool } = pg;

export const usingSqlite: boolean = !process.env.DATABASE_URL;
export const usingPglite: boolean = usingSqlite;

interface PgLikeClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
  release: () => void;
}

interface PgLikePool {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
  connect: () => Promise<PgLikeClient>;
  end: () => Promise<void>;
  on: (...args: unknown[]) => void;
}

let _sqlite: any = null;
let _pool: PgLikePool | null = null;
let _db: any = null;

function getSqlite(): any {
  if (!_sqlite) {
    const Database = require("better-sqlite3");
    const dataDir =
      process.env.SQLITE_DIR ||
      process.env.PGLITE_DIR ||
      path.resolve(process.cwd(), ".sqlite-data");
    fs.mkdirSync(dataDir, { recursive: true });
    const dbFile = path.join(dataDir, "app.db");
    _sqlite = new Database(dbFile);
    _sqlite.pragma("journal_mode = WAL");
    _sqlite.pragma("foreign_keys = ON");
  }
  return _sqlite;
}

function translateDdl(sql: string): string {
  let s = sql;
  s = s.replace(/\bserial\s+PRIMARY\s+KEY\b/gi, "INTEGER PRIMARY KEY AUTOINCREMENT");
  s = s.replace(/\bbigserial\s+PRIMARY\s+KEY\b/gi, "INTEGER PRIMARY KEY AUTOINCREMENT");
  s = s.replace(/\btimestamptz\b/gi, "TEXT");
  s = s.replace(/\btimestamp(?:\s*\(\s*\d+\s*\))?(?:\s+with(?:out)?\s+time\s+zone)?\b/gi, "TEXT");
  s = s.replace(/\bvarchar\s*\(\s*\d+\s*\)/gi, "TEXT");
  s = s.replace(/\bvarchar\b/gi, "TEXT");
  s = s.replace(/\bjsonb?\b/gi, "TEXT");
  s = s.replace(/\bboolean\b/gi, "INTEGER");
  s = s.replace(/\bDEFAULT\s+true\b/gi, "DEFAULT 1");
  s = s.replace(/\bDEFAULT\s+false\b/gi, "DEFAULT 0");
  s = s.replace(/\bnow\(\)/gi, "(datetime('now'))");
  s = s.replace(/\bCURRENT_TIMESTAMP\b/gi, "(datetime('now'))");
  s = s.replace(/\s+COLLATE\s+"[^"]+"/gi, "");
  return s;
}

function translateParams(sql: string): string {
  return sql.replace(/\$(\d+)/g, "?");
}

function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    if (c === ";" && !inSingle && !inDouble) {
      const s = buf.trim();
      if (s) out.push(s);
      buf = "";
    } else {
      buf += c;
    }
  }
  const last = buf.trim();
  if (last) out.push(last);
  return out;
}

function isIgnorableDdlError(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("duplicate column") ||
    m.includes("already exists") ||
    (m.includes("near \"exists\"") && m.includes("syntax"))
  );
}

function translateBoolParam(p: unknown): unknown {
  if (typeof p === "boolean") return p ? 1 : 0;
  return p;
}

async function sqliteExec(
  sql: string,
  params?: unknown[],
): Promise<{ rows: any[]; rowCount: number }> {
  const db = getSqlite();
  let translated = translateParams(sql);

  const upper = translated.trim().toUpperCase();
  const isDdl =
    upper.startsWith("CREATE ") ||
    upper.startsWith("ALTER ") ||
    upper.startsWith("DROP ");

  if (isDdl) {
    translated = translateDdl(translated);
    const stmts = splitStatements(translated);
    for (const raw of stmts) {
      let stmt = raw;
      const isAlterAddCol = /^ALTER\s+TABLE\s+\S+\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b/i.test(stmt);
      if (isAlterAddCol) {
        stmt = stmt.replace(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/i, "ADD COLUMN");
      }
      try {
        db.exec(stmt);
      } catch (e: any) {
        const msg = String(e?.message || "");
        if (isAlterAddCol && isIgnorableDdlError(msg)) continue;
        if (isIgnorableDdlError(msg)) continue;
        throw e;
      }
    }
    return { rows: [], rowCount: 0 };
  }

  const safeParams = (params ?? []).map(translateBoolParam);
  const stmt = db.prepare(translated);
  const isSelect = upper.startsWith("SELECT") || /\bRETURNING\b/i.test(translated);
  if (isSelect) {
    const rows = stmt.all(...safeParams);
    return { rows: rows as any[], rowCount: rows.length };
  }
  const info = stmt.run(...safeParams);
  return { rows: [], rowCount: Number(info.changes) || 0 };
}

function makeSqliteAdapter(): PgLikePool {
  const client: PgLikeClient = {
    query: sqliteExec,
    release: () => {},
  };
  return {
    query: sqliteExec,
    connect: async () => client,
    end: async () => {
      if (_sqlite) _sqlite.close();
    },
    on: () => {},
  };
}

function getPool(): PgLikePool {
  if (!_pool) {
    if (process.env.DATABASE_URL) {
      _pool = new Pool({ connectionString: process.env.DATABASE_URL }) as unknown as PgLikePool;
    } else {
      _pool = makeSqliteAdapter();
    }
  }
  return _pool;
}

function getDb(): any {
  if (!_db) {
    if (process.env.DATABASE_URL) {
      _db = drizzlePg(getPool() as unknown as pg.Pool, { schema });
    } else {
      _db = new Proxy(
        {},
        {
          get() {
            throw new Error(
              "drizzle ORM is not available in embedded SQLite mode; use raw pool.query() instead",
            );
          },
        },
      );
    }
  }
  return _db;
}

export const pool: any = new Proxy({} as PgLikePool, {
  get(_, prop) {
    return (getPool() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

export const db: any = new Proxy(
  {},
  {
    get(_, prop) {
      return (getDb() as unknown as Record<string | symbol, unknown>)[prop];
    },
  },
);

export * from "./schema";
