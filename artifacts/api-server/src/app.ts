import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import cookieParser from "cookie-parser";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import path from "node:path";
import fs from "node:fs";
import router from "./routes";
import { logger } from "./lib/logger";
import { pool } from "@workspace/db";

const SESSION_SECRET = process.env["SESSION_SECRET"] || "fbhandling-super-secret-change-me-2024";

const rawCorsOrigins = process.env["CORS_ORIGIN"];
const allowedOrigins: Set<string> | null = rawCorsOrigins
  ? new Set(rawCorsOrigins.split(",").map((o) => o.trim()).filter(Boolean))
  : null;

const PgStore = connectPgSimple(session);

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
app.use(
  session({
    name: "fbhandling.sid",
    store: new PgStore({
      pool,
      tableName: "user_sessions",
    }),
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

app.use("/api", router);

const frontendDist = path.resolve(__dirname, "../../fb-guard/dist/public");
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.use((_req, res) => {
    res.sendFile(path.join(frontendDist, "index.html"));
  });
  logger.info({ frontendDist }, "Serving frontend static files");
} else {
  logger.warn({ frontendDist }, "Frontend build not found — only API routes active");
}

export default app;
