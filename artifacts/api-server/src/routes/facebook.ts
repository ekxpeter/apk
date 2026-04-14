import { Router, type Request, type Response } from "express";
import { FbLoginBody, FbLoginCookieBody, FbToggleGuardBody } from "@workspace/api-zod";
import { randomBytes, randomUUID } from "crypto";
import { logger } from "../lib/logger";

const router = Router();

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const MOBILE_UA =
  "Dalvik/2.1.0 (Linux; U; Android 12; SM-G991B Build/SP1A.210812.016)";

const BROWSER_HEADERS = {
  "user-agent": DESKTOP_UA,
  "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "accept-encoding": "identity",
  "sec-ch-ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
  "upgrade-insecure-requests": "1",
  "cache-control": "max-age=0",
};

interface SessionData {
  cookie: string;
  dtsg: string;
  userId: string;
  name: string;
  isCookieSession: boolean;
  accessToken?: string;
}

function encodeSession(s: SessionData): string {
  return Buffer.from(JSON.stringify(s)).toString("base64");
}

function decodeSession(token: string): SessionData | null {
  try {
    return JSON.parse(Buffer.from(token, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function parseCookieString(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) result[key] = decodeURIComponent(val);
  }
  return result;
}

async function getUserInfoFromGraph(accessToken: string): Promise<{ id: string; name: string } | null> {
  try {
    const res = await fetch(
      `https://graph.facebook.com/me?access_token=${accessToken}&fields=id,name`
    );
    const text = await res.text();
    logger.info({ status: res.status, body: text.substring(0, 300) }, "getUserInfo graph response");
    if (res.status !== 200) return null;
    const info = JSON.parse(text);
    if (!info.id) return null;
    return { id: info.id, name: info.name || info.id };
  } catch (err) {
    logger.error({ err }, "getUserInfo error");
    return null;
  }
}

async function getTokenFromCredentials(
  email: string,
  password: string
): Promise<string | null> {
  const adid = randomBytes(8).toString("hex");
  const deviceId = randomUUID();

  // Try multiple client IDs - some bypass checkpoint more reliably
  const clientIds = [
    "350685531728|62f8ce9f74b12f84c123cc23437a4a32",
    "256002347743983|374e8b19b1ae34c84dae4a58a1f0df07",
    "350685531728|62f8ce9f74b12f84c123cc23437a4a32",
  ];

  for (const clientId of clientIds) {
    const body = new URLSearchParams({
      adid,
      format: "json",
      device_id: deviceId,
      email,
      password,
      generate_analytics_claims: "0",
      credentials_type: "password",
      source: "login",
      error_detail_type: "button_with_disabled",
      enroll_misauth: "false",
      generate_session_cookies: "1",
      generate_machine_id: "0",
      fb_api_req_friendly_name: "authenticate",
      trynum: "1",
      locale: "en_US",
    });

    try {
      const res = await fetch("https://b-graph.facebook.com/auth/login", {
        method: "POST",
        headers: {
          authorization: `OAuth ${clientId}`,
          "x-fb-friendly-name": "Authenticate",
          "x-fb-connection-type": "MOBILE.LTE",
          "accept-encoding": "gzip, deflate",
          "content-type": "application/x-www-form-urlencoded",
          "x-fb-http-engine": "Liger",
          "x-fb-client-ip": "True",
          "x-fb-server-cluster": "True",
          "user-agent": MOBILE_UA,
        },
        body: body.toString(),
      });
      const text = await res.text();
      logger.info({ status: res.status, body: text.substring(0, 500) }, "FB credential login response");

      if (res.status !== 200) continue;
      const result = JSON.parse(text);

      // If we hit a checkpoint, note it but continue trying
      if (result.error?.code === 401 || result.error?.type === "OAuthException") {
        logger.warn({ error: result.error }, "Checkpoint/OAuth error");
        continue;
      }

      if (result.access_token) return result.access_token;
    } catch (err) {
      logger.error({ err }, "credential login error");
    }
  }
  return null;
}

async function loginWithCookie(
  rawCookie: string
): Promise<SessionData | null> {
  const cUserMatch = rawCookie.match(/c_user=(\d+)/);
  if (!cUserMatch) {
    logger.warn("No c_user in cookie");
    return null;
  }
  const userId = cUserMatch[1];

  const pagesToTry = [
    `https://www.facebook.com/`,
    `https://www.facebook.com/profile.php?id=${userId}`,
    `https://m.facebook.com/`,
    `https://www.facebook.com/settings`,
  ];

  for (const url of pagesToTry) {
    try {
      const res = await fetch(url, {
        headers: { ...BROWSER_HEADERS, cookie: rawCookie },
        redirect: "follow",
      });

      const html = await res.text();
      logger.info({ url, status: res.status, htmlLen: html.length }, "cookie page fetch");

      const isLoggedIn =
        html.includes('"USER_ID"') ||
        html.includes('"user_id"') ||
        html.includes(userId) ||
        html.includes("DTSGInitialData");

      if (!isLoggedIn) {
        logger.warn({ url }, "Page does not appear to be logged in");
        continue;
      }

      let dtsg: string | null = null;
      const dtsgPatterns = [
        /"DTSGInitialData"[^}]*"token":"([^"]+)"/,
        /\["DTSGInitialData",\[\],\{"token":"([^"]+)"/,
        /"token":"(AQAA[^"]+)"/,
        /fb_dtsg.*?value="([^"]+)"/,
        /"name":"fb_dtsg","value":"([^"]+)"/,
        /"dtsg":"([^"]+)"/,
      ];

      for (const pat of dtsgPatterns) {
        const m = html.match(pat);
        if (m) {
          dtsg = m[1];
          logger.info({ pattern: pat.toString(), dtsg: dtsg.substring(0, 20) }, "Found dtsg");
          break;
        }
      }

      if (!dtsg) {
        logger.warn({ url }, "No dtsg found on page");
        continue;
      }

      let name = userId;
      const namePatterns = [
        /"NAME":"([^"]+)"/,
        /"name":"([^"]+)","__typename":"User"/,
        new RegExp(`"id":"${userId}"[^}]*"name":"([^"]+)"`),
        /<title>([^<]+)<\/title>/,
      ];
      for (const pat of namePatterns) {
        const m = html.match(pat);
        if (m && m[1] && m[1].length < 100) {
          name = m[1].replace(/&#x[0-9a-f]+;/g, "").trim();
          if (name && name !== "Facebook") {
            logger.info({ name }, "Found user name");
            break;
          }
        }
      }

      return { cookie: rawCookie, dtsg, userId, name, isCookieSession: true };
    } catch (err) {
      logger.error({ err, url }, "cookie page fetch error");
    }
  }

  logger.warn({ userId }, "All cookie login strategies exhausted");
  return null;
}

async function fetchProfileHtml(cookie: string, userId: string): Promise<string | null> {
  const urls = [
    `https://www.facebook.com/profile.php?id=${userId}`,
    `https://www.facebook.com/profile.php?id=${userId}&sk=about`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { ...BROWSER_HEADERS, cookie },
        redirect: "follow",
      });
      const html = await res.text();
      logger.info({ url, status: res.status, len: html.length }, "fetchProfileHtml");
      if (html.length > 100000) return html;
    } catch (err) {
      logger.error({ err }, "fetchProfileHtml error");
    }
  }
  return null;
}

async function getProfileInfo(session: SessionData): Promise<{
  profilePicUrl: string;
  friendsCount: number;
  gender: string;
  postCount: number;
  parsedCookies: Record<string, string>;
}> {
  const userId = session.userId;
  let profilePicUrl = "";
  let friendsCount = 0;
  let gender = "Unknown";
  let postCount = 0;

  if (session.isCookieSession && session.cookie) {
    // Fetch the full profile page with real browser headers
    const html = await fetchProfileHtml(session.cookie, userId);

    if (html) {
      // ── Profile Picture ──────────────────────────────────────────────────
      // Try patterns found working in actual FB HTML
      const picPatterns = [
        /"profile_picture":\{"__typename":"ProfilePhoto"[^}]*"uri":"([^"]+)"/,
        /"profile_picture":\{[^}]*"uri":"([^"]+)"/,
        /"profilePicture":\{[^}]*"uri":"([^"]+)"/,
        /"photo_url":"(https:\\\/\\\/scontent[^"]+)"/,
        /og:image[^>]*content="([^"]+)"/,
        /"uri":"(https:\\\/\\\/scontent[^"]+\.jpg[^"]*)"/,
      ];
      for (const pat of picPatterns) {
        const m = html.match(pat);
        if (m && m[1] && m[1].includes("scontent")) {
          profilePicUrl = m[1].replace(/\\\//g, "/");
          logger.info({ pat: pat.toString().substring(0, 60), url: profilePicUrl.substring(0, 80) }, "Found profile pic");
          break;
        }
      }

      // ── Gender ──────────────────────────────────────────────────────────
      const genderPatterns = [
        /"gender":"([^"]+)"/,
        /"GENDER":"([^"]+)"/,
        /"viewer_gender":"([^"]+)"/,
      ];
      for (const pat of genderPatterns) {
        const m = html.match(pat);
        if (m && m[1]) {
          const g = m[1].toUpperCase();
          if (g === "MALE") gender = "Male";
          else if (g === "FEMALE") gender = "Female";
          else gender = m[1];
          logger.info({ gender }, "Found gender");
          break;
        }
      }

      // ── Friends Count ─────────────────────────────────────────────────────
      // Only match reasonably-sized friend counts (≤ 8 digits, not a UID)
      const friendsPatterns: RegExp[] = [
        /"friends":\{"__typename":"FriendsConnection","count":(\d{1,8})/,
        /"friends":\{[^}]{0,80}"count":(\d{1,8})/,
        /"friend_count":(\d{1,8})/,
        /"friendCount":(\d{1,8})/,
        /"mutual_friends":\{[^}]{0,80}"count":(\d{1,8})/,
        /(\d{1,6}) [Ff]riends/,
      ];
      for (const pat of friendsPatterns) {
        const m = html.match(pat);
        if (m && m[1]) {
          const n = parseInt(m[1].replace(/,/g, ""), 10);
          if (!isNaN(n) && n < 10000000) { friendsCount = n; break; }
        }
      }

      // Also try the friends sub-page
      if (friendsCount === 0) {
        try {
          const friendsRes = await fetch(
            `https://www.facebook.com/profile.php?id=${userId}&sk=friends`,
            { headers: { ...BROWSER_HEADERS, cookie: session.cookie }, redirect: "follow" }
          );
          const friendsHtml = await friendsRes.text();
          for (const pat of friendsPatterns) {
            const m = friendsHtml.match(pat);
            if (m && m[1]) {
              const n = parseInt(m[1].replace(/,/g, ""), 10);
              if (!isNaN(n) && n < 10000000) { friendsCount = n; break; }
            }
          }
          // Count actual friend cards on the page as a rough count
          if (friendsCount === 0) {
            const cardMatches = friendsHtml.match(/"__typename":"User","id":"\d+"/g);
            if (cardMatches) {
              const uniq = new Set(cardMatches);
              uniq.delete(`"__typename":"User","id":"${userId}"`);
              if (uniq.size > 0) friendsCount = uniq.size;
            }
          }
        } catch (err) {
          logger.error({ err }, "friends page fetch error");
        }
      }

      // ── Post Count ───────────────────────────────────────────────────────
      const postPatterns = [
        /"post_count":(\d+)/,
        /"timeline_posts":\{[^}]*"count":(\d+)/,
        /"postsCount":(\d+)/,
        /"Posts":\{[^}]*"count":(\d+)/,
      ];
      for (const pat of postPatterns) {
        const m = html.match(pat);
        if (m && m[1]) {
          postCount = parseInt(m[1], 10);
          break;
        }
      }
    }
  }

  // Fallback profile picture via graph API (handles public profiles or when HTML extraction failed)
  if (!profilePicUrl) {
    try {
      const picRes = await fetch(
        `https://graph.facebook.com/${userId}/picture?type=large&redirect=false`
      );
      if (picRes.ok) {
        const picJson = await picRes.json() as { data?: { url?: string; is_silhouette?: boolean } };
        if (picJson?.data?.url && !picJson.data.is_silhouette) {
          profilePicUrl = picJson.data.url;
        }
      }
    } catch { /* ignore */ }
  }

  // Final fallback — blank (frontend will show default avatar)
  if (!profilePicUrl) profilePicUrl = "";

  const parsedCookies = session.isCookieSession ? parseCookieString(session.cookie) : {};

  logger.info({ profilePicUrl: profilePicUrl.substring(0, 60), friendsCount, gender, postCount }, "getProfileInfo result");
  return { profilePicUrl, friendsCount, gender, postCount, parsedCookies };
}

async function getUserPosts(session: SessionData): Promise<Array<{ id: string; message: string; createdTime: string }>> {
  const posts: Array<{ id: string; message: string; createdTime: string }> = [];
  const seen = new Set<string>();

  const addPost = (id: string, message: string, createdTime: string) => {
    if (id && !seen.has(id)) {
      seen.add(id);
      posts.push({ id, message: message || "(no text)", createdTime });
    }
  };

  // OAuth path
  if (session.accessToken && !session.isCookieSession) {
    try {
      const graphRes = await fetch(
        `https://graph.facebook.com/me/posts?access_token=${session.accessToken}&fields=id,message,created_time&limit=25`
      );
      if (graphRes.ok) {
        const graphJson = await graphRes.json() as { data?: Array<{ id: string; message?: string; created_time: string }> };
        for (const p of graphJson?.data || []) {
          addPost(p.id, p.message || "(no text)", p.created_time);
        }
      }
    } catch (err) {
      logger.error({ err }, "getUserPosts graph error");
    }
    return posts;
  }

  if (!session.isCookieSession || !session.cookie || !session.dtsg) return posts;

  // Try multiple GraphQL doc_ids for timeline posts
  const docIds = [
    "7268703163238739",
    "4889935097752973",
    "9015426468489944",
    "4859640990749441",
    "7315374748528579",
  ];

  for (const docId of docIds) {
    try {
      const variables = JSON.stringify({
        userID: session.userId,
        count: 10,
        cursor: null,
        privacySelectorRenderLocation: "COMET_STREAM",
        timelineNavAppSection: "TIMELINE",
        scale: 1,
        id: session.userId,
      });

      const body = new URLSearchParams({
        fb_dtsg: session.dtsg,
        variables,
        doc_id: docId,
      });

      const res = await fetch("https://www.facebook.com/api/graphql/", {
        method: "POST",
        headers: {
          cookie: session.cookie,
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": DESKTOP_UA,
          "x-fb-friendly-name": "ProfileCometTimelineFeedQuery",
          "x-fb-lsd": session.dtsg.substring(0, 10),
          origin: "https://www.facebook.com",
          referer: `https://www.facebook.com/profile.php?id=${session.userId}`,
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
        },
        body: body.toString(),
      });

      const text = await res.text();
      logger.info({ docId, status: res.status, len: text.length, preview: text.substring(0, 200) }, "getUserPosts GQL");

      if (res.status !== 200 || text.length < 100) continue;

      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          // Various response shapes Facebook uses
          const edgeSources = [
            json?.data?.node?.timeline_feed_units?.edges,
            json?.data?.node?.timeline_list_feed_units?.edges,
            json?.data?.viewer?.newsFeedConnection?.edges,
            json?.data?.user?.timeline_feed_units?.edges,
          ];

          for (const edges of edgeSources) {
            if (!Array.isArray(edges)) continue;
            for (const edge of edges) {
              const node = edge?.node;
              if (!node) continue;
              const postId = node?.post_id || node?.id || node?.story_id;
              const message =
                node?.message?.text ||
                node?.comet_sections?.content?.story?.message?.text ||
                node?.story?.message?.text || "";
              const ct = node?.creation_time || node?.created_time || 0;
              const createdTime = ct ? new Date(ct * 1000).toISOString() : new Date().toISOString();
              addPost(postId, message, createdTime);
            }
          }
        } catch { /* skip non-JSON */ }
      }

      if (posts.length > 0) break; // Got some posts, stop trying
    } catch (err) {
      logger.error({ err, docId }, "getUserPosts GQL error");
    }
  }

  // Fallback: scrape timeline HTML for post IDs
  if (posts.length === 0) {
    try {
      const timelineRes = await fetch(
        `https://www.facebook.com/profile.php?id=${session.userId}`,
        { headers: { ...BROWSER_HEADERS, cookie: session.cookie }, redirect: "follow" }
      );
      const html = await timelineRes.text();
      logger.info({ len: html.length }, "getUserPosts HTML scrape fallback");

      // Extract story/post IDs from timeline HTML
      const storyIdPattern = /"story_id":"(\d+)"/g;
      const postIdPattern = /"post_id":"(\d+)"/g;
      const topLevelPattern = /"top_level_post_id":"(\d+)"/g;

      let m: RegExpExecArray | null;
      while ((m = storyIdPattern.exec(html)) !== null) addPost(m[1], "(post)", new Date().toISOString());
      while ((m = postIdPattern.exec(html)) !== null) addPost(m[1], "(post)", new Date().toISOString());
      while ((m = topLevelPattern.exec(html)) !== null) addPost(m[1], "(post)", new Date().toISOString());

      // Also try extracting message text near story IDs
      // Look for fbid in share URLs
      const fbidPattern = /story_fbid=(\d+)/g;
      while ((m = fbidPattern.exec(html)) !== null) addPost(m[1], "(post)", new Date().toISOString());
    } catch (err) {
      logger.error({ err }, "getUserPosts HTML scrape error");
    }
  }

  return posts.slice(0, 50); // Return max 50 posts
}

async function deletePost(session: SessionData, postId: string): Promise<boolean> {
  if (!session.isCookieSession || !session.cookie || !session.dtsg) {
    return false;
  }

  try {
    const clientMutationId = randomUUID();
    const variables = JSON.stringify({
      input: {
        story_id: postId,
        actor_id: session.userId,
        client_mutation_id: clientMutationId,
      },
    });

    const body = new URLSearchParams({
      fb_dtsg: session.dtsg,
      variables,
      doc_id: "5765892403444841",
    });

    const res = await fetch("https://www.facebook.com/api/graphql/", {
      method: "POST",
      headers: {
        cookie: session.cookie,
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": DESKTOP_UA,
        "x-fb-friendly-name": "CometDeletePostDialogMutation",
        origin: "https://www.facebook.com",
        referer: `https://www.facebook.com/profile.php?id=${session.userId}`,
      },
      body: body.toString(),
    });

    const text = await res.text();
    logger.info({ postId, status: res.status, body: text.substring(0, 300) }, "deletePost response");

    return res.status === 200 && !text.includes('"errors"');
  } catch (err) {
    logger.error({ err, postId }, "deletePost error");
    return false;
  }
}

async function toggleGuard(
  session: SessionData,
  enable: boolean
): Promise<{ success: boolean; isShielded: boolean; message: string }> {
  const sessionId = randomUUID();
  const clientMutationId = randomUUID();

  if (session.accessToken && !session.isCookieSession) {
    const variables = JSON.stringify({
      "0": {
        is_shielded: enable,
        session_id: sessionId,
        actor_id: session.userId,
        client_mutation_id: clientMutationId,
      },
    });
    const res = await fetch("https://graph.facebook.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `OAuth ${session.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        variables,
        method: "post",
        doc_id: "1477043292367183",
      }),
    });
    const text = await res.text();
    logger.info({ status: res.status, body: text.substring(0, 400) }, "toggleGuard oauth response");
    return parseGuardResponse(text, res.status);
  }

  const variatesFlat = JSON.stringify({
    is_shielded: enable,
    session_id: sessionId,
    actor_id: session.userId,
    client_mutation_id: clientMutationId,
  });

  const variablesInput = JSON.stringify({
    input: {
      is_shielded: enable,
      actor_id: session.userId,
      session_id: sessionId,
      client_mutation_id: clientMutationId,
    },
  });

  const variablesMobile = JSON.stringify({
    "0": {
      is_shielded: enable,
      session_id: sessionId,
      actor_id: session.userId,
      client_mutation_id: clientMutationId,
    },
  });

  for (const [label, variables] of [
    ["flat", variatesFlat],
    ["input", variablesInput],
    ["mobile_wrapper", variablesMobile],
  ] as [string, string][]) {
    const body = new URLSearchParams({
      fb_dtsg: session.dtsg,
      variables,
      method: "post",
      doc_id: "1477043292367183",
    });

    const res = await fetch("https://www.facebook.com/api/graphql/", {
      method: "POST",
      headers: {
        cookie: session.cookie,
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": DESKTOP_UA,
        "x-fb-friendly-name": "ProfileCometSetProfileShieldMutation",
        "x-fb-lsd": session.dtsg.substring(0, 10),
        origin: "https://www.facebook.com",
        referer: `https://www.facebook.com/profile.php?id=${session.userId}`,
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      },
      body: body.toString(),
    });

    const text = await res.text();
    logger.info({ label, status: res.status, body: text.substring(0, 600) }, "toggleGuard cookie response");

    if (text.includes('"is_shielded":true') || text.includes('"is_shielded":false')) {
      return parseGuardResponse(text, res.status);
    }

    if (!text.includes("missing_required_variable_value") && !text.includes("noncoercible_argument_value")) {
      return parseGuardResponse(text, res.status);
    }
    logger.warn({ label }, "Variable format failed, trying next format");
  }

  return { success: false, isShielded: false, message: "Guard toggle failed: all variable formats rejected by Facebook." };
}

function parseGuardResponse(
  text: string,
  status: number
): { success: boolean; isShielded: boolean; message: string } {
  if (status !== 200) {
    return { success: false, isShielded: false, message: `Request failed (${status}): ${text.substring(0, 200)}` };
  }

  const lines = text.split("\n");
  for (const line of lines) {
    if (line.includes('"is_shielded":true')) {
      return { success: true, isShielded: true, message: "Profile Guard activated successfully" };
    }
    if (line.includes('"is_shielded":false')) {
      return { success: true, isShielded: false, message: "Profile Guard deactivated successfully" };
    }
  }

  if (text.includes('"is_shielded":true')) {
    return { success: true, isShielded: true, message: "Profile Guard activated successfully" };
  }
  if (text.includes('"is_shielded":false')) {
    return { success: true, isShielded: false, message: "Profile Guard deactivated successfully" };
  }
  if (text.includes('"errors"') || text.includes('"error"')) {
    return { success: false, isShielded: false, message: `Error: ${text.substring(0, 300)}` };
  }

  return { success: false, isShielded: false, message: `Unexpected response: ${text.substring(0, 300)}` };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

router.post("/fb/login", async (req: Request, res: Response) => {
  const parsed = FbLoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body" });
    return;
  }

  const { email, password } = parsed.data;
  const accessToken = await getTokenFromCredentials(email, password);
  if (!accessToken) {
    res.status(401).json({
      message:
        "Failed to retrieve token. Check your email/password. Facebook may require a checkpoint on cloud IPs — try using the Cookie Login method instead.",
    });
    return;
  }

  const userInfo = await getUserInfoFromGraph(accessToken);
  if (!userInfo) {
    res.status(401).json({ message: "Token received but user info lookup failed." });
    return;
  }

  const session: SessionData = {
    cookie: "",
    dtsg: "",
    userId: userInfo.id,
    name: userInfo.name,
    isCookieSession: false,
    accessToken,
  };

  res.json({ token: encodeSession(session), userId: userInfo.id, name: userInfo.name });
});

router.post("/fb/login-cookie", async (req: Request, res: Response) => {
  const parsed = FbLoginCookieBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body" });
    return;
  }

  const { cookie } = parsed.data;
  if (!cookie.includes("c_user=")) {
    res.status(401).json({ message: "Invalid cookie: c_user not found." });
    return;
  }

  const session = await loginWithCookie(cookie);
  if (!session) {
    res.status(401).json({
      message:
        "Failed to authenticate with cookie. The cookie may be expired or Facebook is blocking server access.",
    });
    return;
  }

  res.json({ token: encodeSession(session), userId: session.userId, name: session.name });
});

router.post("/fb/guard", async (req: Request, res: Response) => {
  const parsed = FbToggleGuardBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body" });
    return;
  }

  const { token, enable } = parsed.data;
  const session = decodeSession(token);
  if (!session) {
    res.status(400).json({ message: "Invalid session token." });
    return;
  }

  const result = await toggleGuard(session, enable);
  res.json(result);
});

router.post("/fb/profile", async (req: Request, res: Response) => {
  const { token } = req.body as { token?: string };
  if (!token) {
    res.status(400).json({ message: "token is required" });
    return;
  }

  const session = decodeSession(token);
  if (!session) {
    res.status(400).json({ message: "Invalid session token." });
    return;
  }

  try {
    const profile = await getProfileInfo(session);
    res.json(profile);
  } catch (err) {
    logger.error({ err }, "profile route error");
    res.status(500).json({ message: "Failed to fetch profile info" });
  }
});

router.post("/fb/posts", async (req: Request, res: Response) => {
  const { token } = req.body as { token?: string };
  if (!token) {
    res.status(400).json({ message: "token is required" });
    return;
  }

  const session = decodeSession(token);
  if (!session) {
    res.status(400).json({ message: "Invalid session token." });
    return;
  }

  try {
    const posts = await getUserPosts(session);
    res.json({ posts });
  } catch (err) {
    logger.error({ err }, "posts route error");
    res.status(500).json({ message: "Failed to fetch posts" });
  }
});

router.post("/fb/delete-posts", async (req: Request, res: Response) => {
  const { token, postIds } = req.body as { token?: string; postIds?: string[] };
  if (!token || !postIds || !Array.isArray(postIds)) {
    res.status(400).json({ message: "token and postIds are required" });
    return;
  }

  const session = decodeSession(token);
  if (!session) {
    res.status(400).json({ message: "Invalid session token." });
    return;
  }

  let deleted = 0;
  let failed = 0;

  for (const postId of postIds) {
    const ok = await deletePost(session, postId);
    if (ok) deleted++;
    else failed++;
  }

  res.json({ deleted, failed, message: `Deleted ${deleted} post(s), ${failed} failed.` });
});

export default router;
