import app from "./app";
import { logger } from "./lib/logger";
import { pool } from "@workspace/db";
import { startKeepAliveJob } from "./lib/keepAlive";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function ensureTablesExist() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS saved_sessions (
        id serial PRIMARY KEY,
        user_id text NOT NULL UNIQUE,
        name text NOT NULL,
        cookie text NOT NULL,
        dtsg text,
        eaag_token text,
        session_token text NOT NULL,
        is_active boolean NOT NULL DEFAULT true,
        last_pinged timestamptz,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now()
      );
      ALTER TABLE saved_sessions ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
      ALTER TABLE saved_sessions ADD COLUMN IF NOT EXISTS last_pinged timestamptz;
      CREATE TABLE IF NOT EXISTS reactions (
        id serial PRIMARY KEY,
        post_url text NOT NULL,
        user_id text NOT NULL,
        reaction_type text NOT NULL DEFAULT 'LIKE',
        reacted_at timestamptz DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS app_users (
        id serial PRIMARY KEY,
        username text NOT NULL UNIQUE,
        password_hash text NOT NULL,
        created_at timestamptz DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS fb_cookie_accounts (
        id serial PRIMARY KEY,
        app_user_id integer NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        cookie text NOT NULL,
        cookie_type text NOT NULL CHECK (cookie_type IN ('fra', 'rpw', 'normal')),
        label text NOT NULL DEFAULT '',
        fb_user_id text NOT NULL DEFAULT '',
        fb_name text NOT NULL DEFAULT '',
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz DEFAULT now()
      );
    `);
    logger.info("Database tables verified/created");
  } catch (err) {
    logger.error({ err }, "Failed to ensure tables exist");
  } finally {
    client.release();
  }
}

ensureTablesExist().then(() => {
  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
    startKeepAliveJob();
  });
}).catch((err) => {
  logger.error({ err }, "Startup failed");
  process.exit(1);
});
