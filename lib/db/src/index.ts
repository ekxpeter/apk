import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import path from "node:path";
import fs from "node:fs";
import * as schema from "./schema";

const { Pool } = pg;

export const usingPglite: boolean = !process.env.DATABASE_URL;

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

let _pglite: PGlite | null = null;
let _pool: PgLikePool | null = null;
let _db: any = null;

function getPglite(): PGlite {
  if (!_pglite) {
    const dataDir =
      process.env.PGLITE_DIR ||
      path.resolve(process.cwd(), ".pglite-data");
    fs.mkdirSync(dataDir, { recursive: true });
    _pglite = new PGlite(dataDir);
  }
  return _pglite;
}

async function pgliteExec(
  sql: string,
  params?: unknown[],
): Promise<{ rows: any[]; rowCount: number }> {
  const pglite = getPglite();
  if (params && params.length > 0) {
    const r = await pglite.query(sql, params as any[]);
    return { rows: r.rows as any[], rowCount: r.affectedRows ?? r.rows.length };
  }
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (trimmed.includes(";")) {
    await pglite.exec(sql);
    return { rows: [], rowCount: 0 };
  }
  const r = await pglite.query(sql);
  return { rows: r.rows as any[], rowCount: r.affectedRows ?? r.rows.length };
}

function makePgliteAdapter(): PgLikePool {
  const client: PgLikeClient = {
    query: pgliteExec,
    release: () => {},
  };
  return {
    query: pgliteExec,
    connect: async () => client,
    end: async () => {
      if (_pglite) await _pglite.close();
    },
    on: () => {},
  };
}

function getPool(): PgLikePool {
  if (!_pool) {
    if (process.env.DATABASE_URL) {
      _pool = new Pool({ connectionString: process.env.DATABASE_URL }) as unknown as PgLikePool;
    } else {
      _pool = makePgliteAdapter();
    }
  }
  return _pool;
}

function getDb(): any {
  if (!_db) {
    if (process.env.DATABASE_URL) {
      _db = drizzlePg(getPool() as unknown as pg.Pool, { schema });
    } else {
      _db = drizzlePglite(getPglite(), { schema });
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
