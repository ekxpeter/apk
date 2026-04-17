import { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";

const router = Router();

const BAD_TITLES = new Set([
  "error", "facebook", "log into facebook", "login",
  "create new account", "checkpoint", "sign up for facebook",
]);

function requireAuth(req: Request, res: Response): boolean {
  const session = req.session as any;
  if (!session.userId) {
    res.status(401).json({ message: "Not authenticated" });
    return false;
  }
  return true;
}

router.get("/accs", async (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const session = req.session as any;
  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT id, label, cookie_type, fb_user_id, fb_name, is_active, created_at FROM fb_cookie_accounts WHERE app_user_id = $1 ORDER BY cookie_type, created_at DESC",
      [session.userId]
    );
    const rows = result.rows as Array<{
      id: number;
      label: string;
      cookie_type: string;
      fb_user_id: string;
      fb_name: string;
      is_active: boolean;
      created_at: string;
    }>;
    const fra = rows.filter(r => r.cookie_type === "fra");
    const rpw = rows.filter(r => r.cookie_type === "rpw");
    const normal = rows.filter(r => r.cookie_type === "normal");
    res.json({ fra, rpw, normal, total: rows.length });
  } catch (err) {
    logger.error({ err }, "Get accounts error");
    res.status(500).json({ message: "Server error" });
  } finally {
    client.release();
  }
});

router.post("/accs/add", async (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const session = req.session as any;
  const { cookie, cookie_type, label } = req.body as {
    cookie?: string;
    cookie_type?: string;
    label?: string;
  };

  if (!cookie || !cookie_type) {
    res.status(400).json({ message: "cookie and cookie_type are required" });
    return;
  }
  const validTypes = ["fra", "rpw", "normal"];
  if (!validTypes.includes(cookie_type)) {
    res.status(400).json({ message: "cookie_type must be fra, rpw, or normal" });
    return;
  }

  let fbUserId = "";
  let fbName = "";

  try {
    const cUserMatch = cookie.match(/c_user=(\d+)/);
    if (cUserMatch) fbUserId = cUserMatch[1];

    const profileUrl = fbUserId
      ? `https://www.facebook.com/profile.php?id=${fbUserId}`
      : "https://mbasic.facebook.com/";

    const profileRes = await fetch(profileUrl, {
      headers: {
        cookie,
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "accept-language": "en-US,en;q=0.9",
        "accept-encoding": "identity",
        "accept": "text/html,application/xhtml+xml,*/*;q=0.8",
      },
      redirect: "follow",
    });
    const html = await profileRes.text();

    const ogTitleMatch = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/);
    if (ogTitleMatch && !BAD_TITLES.has(ogTitleMatch[1].trim().toLowerCase())) {
      fbName = ogTitleMatch[1].trim();
    }
    if (!fbName) {
      const titleMatch = html.match(/<title>([^<]+)<\/title>/);
      if (titleMatch && !BAD_TITLES.has(titleMatch[1].trim().toLowerCase())) {
        fbName = titleMatch[1]
          .replace(" | Facebook", "")
          .replace(" - Facebook", "")
          .trim();
      }
    }
    if (!fbName) {
      const m2 = html.match(/>\s*([A-Z][a-z]+(?: [A-Z][a-z]+)+)\s*<\/(?:span|a|h1)>/);
      if (m2 && !BAD_TITLES.has(m2[1].trim().toLowerCase())) {
        fbName = m2[1].trim();
      }
    }
  } catch {
    // Non-fatal
  }

  const effectiveLabel = label || fbName || fbUserId || "Unknown";

  const client = await pool.connect();
  try {
    await client.query(
      "INSERT INTO fb_cookie_accounts (app_user_id, cookie, cookie_type, label, fb_user_id, fb_name) VALUES ($1, $2, $3, $4, $5, $6)",
      [session.userId, cookie.trim(), cookie_type, effectiveLabel, fbUserId, fbName]
    );
    res.json({ message: "Account added", fbUserId, fbName: fbName || fbUserId || effectiveLabel });
  } catch (err) {
    logger.error({ err }, "Add account error");
    res.status(500).json({ message: "Failed to add account" });
  } finally {
    client.release();
  }
});

router.delete("/accs/:id", async (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const session = req.session as any;
  const { id } = req.params;
  const client = await pool.connect();
  try {
    const result = await client.query(
      "DELETE FROM fb_cookie_accounts WHERE id = $1 AND app_user_id = $2 RETURNING id",
      [id, session.userId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ message: "Account not found" });
      return;
    }
    res.json({ message: "Account removed" });
  } catch (err) {
    logger.error({ err }, "Delete account error");
    res.status(500).json({ message: "Server error" });
  } finally {
    client.release();
  }
});

export default router;
