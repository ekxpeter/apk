import { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";

const router = Router();

const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function requireAuth(req: Request, res: Response): boolean {
  const session = req.session as any;
  if (!session.userId) {
    res.status(401).json({ message: "Not authenticated" });
    return false;
  }
  return true;
}

async function getAccountsByType(appUserId: number, cookieType: string, limit?: number): Promise<Array<{ id: number; cookie: string; label: string; fb_user_id: string; fb_name: string }>> {
  const client = await pool.connect();
  try {
    const q = limit
      ? `SELECT id, cookie, label, fb_user_id, fb_name FROM fb_cookie_accounts WHERE app_user_id = $1 AND cookie_type = $2 AND is_active = true LIMIT $3`
      : `SELECT id, cookie, label, fb_user_id, fb_name FROM fb_cookie_accounts WHERE app_user_id = $1 AND cookie_type = $2 AND is_active = true`;
    const params = limit ? [appUserId, cookieType, limit] : [appUserId, cookieType];
    const result = await client.query(q, params);
    return result.rows as Array<{ id: number; cookie: string; label: string; fb_user_id: string; fb_name: string }>;
  } finally {
    client.release();
  }
}

async function fetchFbPage(url: string, cookie: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      cookie,
      "user-agent": DESKTOP_UA,
      "accept-language": "en-US,en;q=0.9",
      "accept-encoding": "identity",
      "accept": "text/html,application/xhtml+xml,*/*",
    },
    redirect: "follow",
  });
  return res.text();
}

function extractTokens(html: string) {
  const fb_dtsg =
    html.match(/name="fb_dtsg"\s+value="([^"]+)"/)?.[1] ||
    html.match(/value="([^"]+)"\s+name="fb_dtsg"/)?.[1] ||
    html.match(/"fb_dtsg"\s*,\s*"([^"]+)"/)?.[1] ||
    html.match(/DTSGInitialData[^}]*?"token":"([^"]+)"/)?.[1] || "";
  const lsd =
    html.match(/name="lsd"\s+value="([^"]+)"/)?.[1] ||
    html.match(/value="([^"]+)"\s+name="lsd"/)?.[1] ||
    html.match(/"LSD",\[\],\{"token":"([^"]+)"\}/)?.[1] || "";
  const jazoest =
    html.match(/name="jazoest"\s+value="([^"]+)"/)?.[1] ||
    html.match(/value="([^"]+)"\s+name="jazoest"/)?.[1] || "";
  return { fb_dtsg, lsd, jazoest };
}

function extractPostId(postUrl: string): string {
  const m1 = postUrl.match(/\/posts\/(\d+)/);
  if (m1) return m1[1];
  const m2 = postUrl.match(/story_fbid=(\d+)/);
  if (m2) return m2[1];
  const m3 = postUrl.match(/\/(\d{10,})/);
  if (m3) return m3[1];
  return "";
}

function isLoggedOut(html: string): boolean {
  return html.includes("You must log in") ||
    html.includes("login_form") ||
    html.includes("id=\"loginbutton\"") ||
    html.includes("/login/?next=");
}

async function reactWithCookie(cookie: string, postUrl: string, reactionType: string): Promise<{ ok: boolean; msg: string }> {
  try {
    const normalizedUrl = postUrl.startsWith("http") ? postUrl : `https://www.facebook.com/${postUrl}`;
    const html = await fetchFbPage(normalizedUrl, cookie);
    if (isLoggedOut(html)) return { ok: false, msg: "Session expired / logged out" };

    const { fb_dtsg, lsd } = extractTokens(html);
    const postId = extractPostId(normalizedUrl);
    if (!postId) return { ok: false, msg: "Could not extract post ID" };

    const REACTION_MAP: Record<string, number> = {
      LIKE: 1, LOVE: 2, HAHA: 4, WOW: 3, SAD: 7, ANGRY: 8, CARE: 16,
    };
    const feedbackReactionId = REACTION_MAP[reactionType.toUpperCase()] ?? 1;

    const body = new URLSearchParams({
      av: "",
      __user: "",
      __a: "1",
      __req: "k",
      __hs: "20088.HYP:comet_pkg.2.1.0.0.0",
      dpr: "1",
      __ccg: "GOOD",
      __rev: "1015752478",
      __s: "x:x:x",
      __hsi: "7431590854069048000",
      __dyn: "7AzHK4HwkEng5K8G6EjBWo2nDaxm5o4G3q0Bo1uXwgEvwNw9G2S7o8K2Wq1Nxa",
      __csr: "",
      __comet_req: "15",
      lsd: lsd || "",
      jazoest: "25381",
      __spin_r: "1015752478",
      __spin_b: "trunk",
      __spin_t: String(Math.floor(Date.now() / 1000)),
      fb_dtsg: fb_dtsg || "",
      variables: JSON.stringify({
        input: {
          feedback_id: Buffer.from(`feedback:${postId}`).toString("base64"),
          feedback_reaction_id: feedbackReactionId,
          feedback_source: "OBJECT",
          is_tracking_encrypted: true,
          actor_id: "",
          client_mutation_id: Math.floor(Math.random() * 10000).toString(),
        },
      }),
      doc_id: "25988847695563145",
    });

    const reactRes = await fetch("https://www.facebook.com/api/graphql/", {
      method: "POST",
      headers: {
        cookie,
        "user-agent": DESKTOP_UA,
        "content-type": "application/x-www-form-urlencoded",
        "x-fb-friendly-name": "CometUFIFeedbackReactMutation",
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.9",
        "accept-encoding": "identity",
        "origin": "https://www.facebook.com",
        "referer": normalizedUrl,
      },
      body: body.toString(),
      redirect: "follow",
    });

    const text = await reactRes.text();
    if (text.includes("errors") && !text.includes('"errors":[]')) {
      const fallback = await likeWithMbasic(cookie, postId, reactionType);
      return fallback;
    }
    return { ok: true, msg: `Reacted ${reactionType}` };
  } catch (err: any) {
    return { ok: false, msg: err?.message || "Unknown error" };
  }
}

async function likeWithMbasic(cookie: string, postId: string, _reactionType: string): Promise<{ ok: boolean; msg: string }> {
  try {
    const url = `https://mbasic.facebook.com/${postId}`;
    const html = await fetchFbPage(url, cookie);
    if (isLoggedOut(html)) return { ok: false, msg: "Session expired" };
    const likeMatch = html.match(/href="(\/a\/like[^"]+)"/);
    if (!likeMatch) return { ok: false, msg: "No like button found on mbasic" };
    const likeUrl = `https://mbasic.facebook.com${likeMatch[1].replace(/&amp;/g, "&")}`;
    const likeRes = await fetch(likeUrl, {
      headers: { cookie, "user-agent": DESKTOP_UA, "accept-encoding": "identity" },
      redirect: "follow",
    });
    const likeHtml = await likeRes.text();
    if (likeHtml.includes("Unlike") || likeHtml.includes("Remove Reaction")) return { ok: true, msg: "Liked via mbasic" };
    return { ok: false, msg: "mbasic like uncertain" };
  } catch (err: any) {
    return { ok: false, msg: err?.message || "mbasic error" };
  }
}

async function commentWithCookie(cookie: string, postUrl: string, commentText: string): Promise<{ ok: boolean; msg: string }> {
  try {
    const normalizedUrl = postUrl.startsWith("http") ? postUrl : `https://www.facebook.com/${postUrl}`;
    const html = await fetchFbPage(normalizedUrl, cookie);
    if (isLoggedOut(html)) return { ok: false, msg: "Session expired / logged out" };

    const { fb_dtsg, lsd } = extractTokens(html);
    const postId = extractPostId(normalizedUrl);
    if (!postId) return { ok: false, msg: "Could not extract post ID" };

    const body = new URLSearchParams({
      av: "",
      __user: "",
      __a: "1",
      fb_dtsg: fb_dtsg || "",
      lsd: lsd || "",
      variables: JSON.stringify({
        input: {
          feedback_id: Buffer.from(`feedback:${postId}`).toString("base64"),
          message: { text: commentText },
          reply_target_clicked: false,
          is_tracking_encrypted: true,
          tracking: [],
          feedback_source: "OBJECT",
          actor_id: "",
          client_mutation_id: Math.floor(Math.random() * 100000).toString(),
          idempotence_token: `client:${Date.now()}`,
          session_id: `${Date.now()}`,
        },
      }),
      doc_id: "25720979764242405",
    });

    await fetch("https://www.facebook.com/api/graphql/", {
      method: "POST",
      headers: {
        cookie,
        "user-agent": DESKTOP_UA,
        "content-type": "application/x-www-form-urlencoded",
        "x-fb-friendly-name": "useCometUFICreateCommentMutation",
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.9",
        "accept-encoding": "identity",
        "origin": "https://www.facebook.com",
        "referer": normalizedUrl,
      },
      body: body.toString(),
      redirect: "follow",
    });
    return { ok: true, msg: "Commented" };
  } catch (err: any) {
    return { ok: false, msg: err?.message || "Unknown error" };
  }
}

async function followWithCookie(cookie: string, targetUrl: string): Promise<{ ok: boolean; msg: string }> {
  try {
    const normalizedUrl = targetUrl.startsWith("http") ? targetUrl : `https://www.facebook.com/${targetUrl}`;
    const html = await fetchFbPage(normalizedUrl, cookie);
    if (isLoggedOut(html)) return { ok: false, msg: "Session expired / logged out" };
    const { fb_dtsg, lsd } = extractTokens(html);
    const m = normalizedUrl.match(/facebook\.com\/(?:profile\.php\?id=(\d+)|([^/?#]+))/);
    const profileId = m?.[1] || m?.[2] || "";

    const body = new URLSearchParams({
      av: "",
      __user: "",
      __a: "1",
      fb_dtsg: fb_dtsg || "",
      lsd: lsd || "",
      variables: JSON.stringify({
        input: {
          subscribe_to_id: profileId,
          attribution_id_v2: "FriendingCometFriendsPage_friendingcometfriendspage",
          actor_id: "",
          client_mutation_id: Math.floor(Math.random() * 1000).toString(),
        },
      }),
      doc_id: "7216888908422443",
    });

    await fetch("https://www.facebook.com/api/graphql/", {
      method: "POST",
      headers: {
        cookie,
        "user-agent": DESKTOP_UA,
        "content-type": "application/x-www-form-urlencoded",
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.9",
        "accept-encoding": "identity",
        "origin": "https://www.facebook.com",
        "referer": normalizedUrl,
      },
      body: body.toString(),
      redirect: "follow",
    });
    return { ok: true, msg: "Follow/add-friend sent" };
  } catch (err: any) {
    return { ok: false, msg: err?.message || "Unknown error" };
  }
}

router.post("/actions/react", async (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const session = req.session as any;
  const { postUrl, reactionType = "LIKE", cookieType = "normal", count } = req.body as {
    postUrl?: string; reactionType?: string; cookieType?: string; count?: number;
  };
  if (!postUrl) { res.status(400).json({ message: "postUrl is required" }); return; }

  let accounts: Awaited<ReturnType<typeof getAccountsByType>>;
  try {
    accounts = await getAccountsByType(session.userId, cookieType, count);
  } catch (err) {
    res.status(500).json({ message: "Database error" });
    return;
  }
  if (accounts.length === 0) {
    res.json({ success: 0, failed: 0, total: 0, message: `No ${cookieType.toUpperCase()} accounts found.`, details: [] });
    return;
  }

  const details: string[] = [];
  let success = 0, failed = 0;

  for (const acc of accounts) {
    const name = acc.fb_name || acc.label;
    const result = await reactWithCookie(acc.cookie, postUrl, reactionType);
    if (result.ok) {
      success++;
      details.push(`✓ ${name}: reacted ${reactionType}`);
    } else {
      failed++;
      details.push(`✗ ${name}: ${result.msg}`);
    }
  }

  res.json({ success, failed, total: accounts.length, message: `${success}/${accounts.length} reactions sent.`, details });
});

router.post("/actions/comment", async (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const session = req.session as any;
  const { postUrl, commentText, cookieType = "normal", count } = req.body as {
    postUrl?: string; commentText?: string; cookieType?: string; count?: number;
  };
  if (!postUrl || !commentText) { res.status(400).json({ message: "postUrl and commentText are required" }); return; }

  let accounts: Awaited<ReturnType<typeof getAccountsByType>>;
  try {
    accounts = await getAccountsByType(session.userId, cookieType, count);
  } catch (err) {
    res.status(500).json({ message: "Database error" });
    return;
  }
  if (accounts.length === 0) {
    res.json({ success: 0, failed: 0, total: 0, message: `No ${cookieType.toUpperCase()} accounts found.`, details: [] });
    return;
  }

  const details: string[] = [];
  let success = 0, failed = 0;

  for (const acc of accounts) {
    const name = acc.fb_name || acc.label;
    const result = await commentWithCookie(acc.cookie, postUrl, commentText);
    if (result.ok) {
      success++;
      details.push(`✓ ${name}: commented`);
    } else {
      failed++;
      details.push(`✗ ${name}: ${result.msg}`);
    }
  }

  res.json({ success, failed, total: accounts.length, message: `${success}/${accounts.length} comments sent.`, details });
});

router.post("/actions/follow", async (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const session = req.session as any;
  const { targetUrl, cookieType = "normal", count } = req.body as {
    targetUrl?: string; cookieType?: string; count?: number;
  };
  if (!targetUrl) { res.status(400).json({ message: "targetUrl is required" }); return; }

  let accounts: Awaited<ReturnType<typeof getAccountsByType>>;
  try {
    accounts = await getAccountsByType(session.userId, cookieType, count);
  } catch (err) {
    res.status(500).json({ message: "Database error" });
    return;
  }
  if (accounts.length === 0) {
    res.json({ success: 0, failed: 0, total: 0, message: `No ${cookieType.toUpperCase()} accounts found.`, details: [] });
    return;
  }

  const details: string[] = [];
  let success = 0, failed = 0;

  for (const acc of accounts) {
    const name = acc.fb_name || acc.label;
    const result = await followWithCookie(acc.cookie, targetUrl);
    if (result.ok) {
      success++;
      details.push(`✓ ${name}: follow sent`);
    } else {
      failed++;
      details.push(`✗ ${name}: ${result.msg}`);
    }
  }

  res.json({ success, failed, total: accounts.length, message: `${success}/${accounts.length} follows sent.`, details });
});

export default router;
