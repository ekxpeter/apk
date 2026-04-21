import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const dbReady = Boolean(process.env.DATABASE_URL);
  const data = HealthCheckResponse.parse({ status: dbReady ? "ok" : "degraded" });
  res.status(dbReady ? 200 : 503).json({
    ...data,
    db: dbReady ? "connected" : "DATABASE_URL not set — add PostgreSQL and redeploy",
  });
});

export default router;
