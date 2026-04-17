import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";

const router = Router();

router.post("/auth/register", async (req: Request, res: Response) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) {
    res.status(400).json({ message: "Username and password are required" });
    return;
  }
  if (username.length < 3) {
    res.status(400).json({ message: "Username must be at least 3 characters" });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ message: "Password must be at least 6 characters" });
    return;
  }
  const client = await pool.connect();
  try {
    const existing = await client.query("SELECT id FROM app_users WHERE username = $1", [username.toLowerCase()]);
    if (existing.rows.length > 0) {
      res.status(409).json({ message: "Username already taken" });
      return;
    }
    const hash = await bcrypt.hash(password, 10);
    await client.query(
      "INSERT INTO app_users (username, password_hash) VALUES ($1, $2)",
      [username.toLowerCase(), hash]
    );
    logger.info({ username }, "User registered");
    res.json({ message: "Registration successful" });
  } catch (err) {
    logger.error({ err }, "Register error");
    res.status(500).json({ message: "Server error" });
  } finally {
    client.release();
  }
});

router.post("/auth/login", async (req: Request, res: Response) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) {
    res.status(400).json({ message: "Username and password are required" });
    return;
  }
  const client = await pool.connect();
  try {
    const result = await client.query("SELECT id, username, password_hash FROM app_users WHERE username = $1", [username.toLowerCase()]);
    if (result.rows.length === 0) {
      res.status(401).json({ message: "Invalid username or password" });
      return;
    }
    const user = result.rows[0] as { id: number; username: string; password_hash: string };
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      res.status(401).json({ message: "Invalid username or password" });
      return;
    }
    (req.session as any).userId = user.id;
    (req.session as any).username = user.username;
    logger.info({ username: user.username }, "User logged in");
    res.json({ id: user.id, username: user.username });
  } catch (err) {
    logger.error({ err }, "Login error");
    res.status(500).json({ message: "Server error" });
  } finally {
    client.release();
  }
});

router.post("/auth/logout", (req: Request, res: Response) => {
  req.session.destroy(() => {
    res.clearCookie("fbguard.sid");
    res.json({ message: "Logged out" });
  });
});

router.get("/auth/me", (req: Request, res: Response) => {
  const session = req.session as any;
  if (!session.userId) {
    res.status(401).json({ message: "Not authenticated" });
    return;
  }
  res.json({ id: session.userId, username: session.username });
});

export default router;
