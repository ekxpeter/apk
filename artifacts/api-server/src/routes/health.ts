import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { usingPglite } from "@workspace/db";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.status(200).json({
    ...data,
    db: usingPglite ? "embedded-pglite" : "postgres",
  });
});

export default router;
