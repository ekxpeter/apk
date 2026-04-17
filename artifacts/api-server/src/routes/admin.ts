import { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";

const router = Router();

function requireAuth(req: Request, res: Response, next: () => void) {
  const session = req.session as any;
  if (!session.userId) {
    res.status(401).json({ message: "Not authenticated" });
    return;
  }
  next();
}

router.get("/admin/users", requireAuth, async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT id, username, created_at FROM app_users ORDER BY created_at DESC`
    );
    res.json({ users: result.rows });
  } catch (err) {
    logger.error({ err }, "Admin users error");
    res.status(500).json({ message: "Server error" });
  } finally {
    client.release();
  }
});

export default router;
