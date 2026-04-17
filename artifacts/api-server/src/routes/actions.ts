import { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import { reactWithCookieOnly, commentWithCookieOnly, followWithCookieOnly } from "./facebook";

const router = Router();

function requireAuth(req: Request, res: Response): boolean {
  const session = req.session as any;
  if (!session.userId) {
    res.status(401).json({ message: "Not authenticated" });
    return false;
  }
  return true;
}

async function getAccountsByType(
  appUserId: number,
  cookieType: string,
  limit?: number
): Promise<Array<{ id: number; cookie: string; label: string; fb_user_id: string; fb_name: string }>> {
  const client = await pool.connect();
  try {
    const q = limit
      ? `SELECT id, cookie, label, fb_user_id, fb_name FROM fb_cookie_accounts WHERE app_user_id = $1 AND cookie_type = $2 AND is_active = true ORDER BY created_at LIMIT $3`
      : `SELECT id, cookie, label, fb_user_id, fb_name FROM fb_cookie_accounts WHERE app_user_id = $1 AND cookie_type = $2 AND is_active = true ORDER BY created_at`;
    const params = limit ? [appUserId, cookieType, limit] : [appUserId, cookieType];
    const result = await client.query(q, params);
    return result.rows as Array<{ id: number; cookie: string; label: string; fb_user_id: string; fb_name: string }>;
  } finally {
    client.release();
  }
}

router.post("/actions/react", async (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const session = req.session as any;

  const { postUrl, reactionType = "LIKE", cookieType = "normal", count } = req.body as {
    postUrl?: string;
    reactionType?: string;
    cookieType?: string;
    count?: number;
  };

  if (!postUrl) {
    res.status(400).json({ message: "postUrl is required" });
    return;
  }

  let accounts: Awaited<ReturnType<typeof getAccountsByType>>;
  try {
    accounts = await getAccountsByType(session.userId, cookieType, count && count > 0 ? count : undefined);
  } catch (err) {
    logger.error({ err }, "actions/react: db error");
    res.status(500).json({ message: "Database error" });
    return;
  }

  if (accounts.length === 0) {
    res.json({
      success: 0,
      failed: 0,
      total: 0,
      message: `No active ${cookieType.toUpperCase()} accounts found. Add cookies first.`,
      details: [],
    });
    return;
  }

  const details: string[] = [];
  let success = 0;
  let failed = 0;

  details.push(`Reacting to post with ${accounts.length} ${cookieType.toUpperCase()} account(s)...`);
  logger.info({ postUrl, reactionType, cookieType, accountCount: accounts.length }, "actions/react started");

  for (const acc of accounts) {
    const name = acc.fb_name || acc.label || `uid:${acc.fb_user_id}`;
    try {
      const result = await reactWithCookieOnly(acc.cookie, postUrl, reactionType);
      if (result.ok) {
        success++;
        details.push(`✓ ${name}: reacted ${reactionType}`);
        logger.info({ name, postUrl, reactionType }, "react success");
      } else {
        failed++;
        details.push(`✗ ${name}: ${result.errorMsg ?? "failed"}`);
        logger.warn({ name, error: result.errorMsg }, "react failed");
      }
    } catch (err: any) {
      failed++;
      details.push(`✗ ${name}: ${err?.message ?? "unexpected error"}`);
      logger.error({ name, err }, "react error");
    }
  }

  res.json({
    success,
    failed,
    total: accounts.length,
    message: `${success}/${accounts.length} reactions sent.`,
    details,
  });
});

router.post("/actions/comment", async (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const session = req.session as any;

  const { postUrl, commentText, cookieType = "normal", count } = req.body as {
    postUrl?: string;
    commentText?: string;
    cookieType?: string;
    count?: number;
  };

  if (!postUrl || !commentText) {
    res.status(400).json({ message: "postUrl and commentText are required" });
    return;
  }

  let accounts: Awaited<ReturnType<typeof getAccountsByType>>;
  try {
    accounts = await getAccountsByType(session.userId, cookieType, count && count > 0 ? count : undefined);
  } catch (err) {
    logger.error({ err }, "actions/comment: db error");
    res.status(500).json({ message: "Database error" });
    return;
  }

  if (accounts.length === 0) {
    res.json({
      success: 0,
      failed: 0,
      total: 0,
      message: `No active ${cookieType.toUpperCase()} accounts found.`,
      details: [],
    });
    return;
  }

  const details: string[] = [];
  let success = 0;
  let failed = 0;

  details.push(`Commenting on post with ${accounts.length} ${cookieType.toUpperCase()} account(s)...`);

  for (const acc of accounts) {
    const name = acc.fb_name || acc.label || `uid:${acc.fb_user_id}`;
    try {
      const result = await commentWithCookieOnly(acc.cookie, postUrl, commentText);
      if (result.ok) {
        success++;
        details.push(`✓ ${name}: commented`);
      } else {
        failed++;
        details.push(`✗ ${name}: ${result.errorMsg ?? "failed"}`);
      }
    } catch (err: any) {
      failed++;
      details.push(`✗ ${name}: ${err?.message ?? "unexpected error"}`);
    }
  }

  res.json({
    success,
    failed,
    total: accounts.length,
    message: `${success}/${accounts.length} comments sent.`,
    details,
  });
});

router.post("/actions/follow", async (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const session = req.session as any;

  const { targetUrl, cookieType = "normal", count } = req.body as {
    targetUrl?: string;
    cookieType?: string;
    count?: number;
  };

  if (!targetUrl) {
    res.status(400).json({ message: "targetUrl is required" });
    return;
  }

  let accounts: Awaited<ReturnType<typeof getAccountsByType>>;
  try {
    accounts = await getAccountsByType(session.userId, cookieType, count && count > 0 ? count : undefined);
  } catch (err) {
    logger.error({ err }, "actions/follow: db error");
    res.status(500).json({ message: "Database error" });
    return;
  }

  if (accounts.length === 0) {
    res.json({
      success: 0,
      failed: 0,
      total: 0,
      message: `No active ${cookieType.toUpperCase()} accounts found.`,
      details: [],
    });
    return;
  }

  const details: string[] = [];
  let success = 0;
  let failed = 0;

  details.push(`Following ${targetUrl} with ${accounts.length} ${cookieType.toUpperCase()} account(s)...`);

  for (const acc of accounts) {
    const name = acc.fb_name || acc.label || `uid:${acc.fb_user_id}`;
    try {
      const result = await followWithCookieOnly(acc.cookie, targetUrl);
      if (result.ok) {
        success++;
        details.push(`✓ ${name}: follow sent`);
      } else {
        failed++;
        details.push(`✗ ${name}: ${result.errorMsg ?? "failed"}`);
      }
    } catch (err: any) {
      failed++;
      details.push(`✗ ${name}: ${err?.message ?? "unexpected error"}`);
    }
  }

  res.json({
    success,
    failed,
    total: accounts.length,
    message: `${success}/${accounts.length} follows sent.`,
    details,
  });
});

export default router;
