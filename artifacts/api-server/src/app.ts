import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import cookieParser from "cookie-parser";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import createMemoryStore from "memorystore";
import path from "node:path";
import fs from "node:fs";
import router from "./routes";
import { logger } from "./lib/logger";
import { pool, usingPglite } from "@workspace/db";

const SESSION_SECRET = process.env["SESSION_SECRET"] || "fbhandling-super-secret-change-me-2024";

const rawCorsOrigins = process.env["CORS_ORIGIN"];
const allowedOrigins: Set<string> | null = rawCorsOrigins
  ? new Set(rawCorsOrigins.split(",").map((o) => o.trim()).filter(Boolean))
  : null;

const PgStore = connectPgSimple(session);
const MemoryStore = createMemoryStore(session);

const app: Express = express();

app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(
  cors({
    credentials: true,
    origin(requestOrigin, callback) {
      if (!allowedOrigins) {
        return callback(null, true);
      }
      if (!requestOrigin || allowedOrigins.has(requestOrigin)) {
        return callback(null, true);
      }
      logger.warn({ origin: requestOrigin }, "CORS: blocked request from unlisted origin");
      callback(new Error(`Origin ${requestOrigin} not allowed by CORS policy`));
    },
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const sessionStore = usingPglite
  ? new MemoryStore({ checkPeriod: 24 * 60 * 60 * 1000 })
  : new PgStore({ pool, tableName: "user_sessions" });

if (usingPglite) {
  logger.warn(
    "DATABASE_URL not set — using embedded PGlite database. " +
    "Data persists for the lifetime of the process; attach a real Postgres for durable storage.",
  );
}

app.use(
  session({
    name: "fbhandling.sid",
    store: sessionStore,
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: "lax",
    },
  })
);

app.use("/api", (req, res, next) => {
  router(req, res, (err?: unknown) => {
    if (err) {
      logger.error({ err, path: req.path }, "API route error");
      if (!res.headersSent) {
        res.status(500).json({ message: "Server error", error: String(err) });
      }
      return;
    }
    if (!res.headersSent) {
      res.status(404).json({ message: `API route not found: ${req.method} ${req.originalUrl}` });
    }
  });
});

const frontendCandidates = [
  path.resolve(__dirname, "../../fb-guard/dist/public"),
  path.resolve(process.cwd(), "artifacts/fb-guard/dist/public"),
];
const frontendDist = frontendCandidates.find((p) => fs.existsSync(p));

if (frontendDist) {
  app.use(express.static(frontendDist));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(frontendDist, "index.html"));
  });
  logger.info({ frontendDist }, "Serving frontend static files");
} else {
  logger.warn({ tried: frontendCandidates }, "Frontend build not found — only API routes active");
}

export default app;
