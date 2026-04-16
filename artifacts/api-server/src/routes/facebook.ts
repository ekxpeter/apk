import { Router, type Request, type Response } from "express";
import {
  FbCommentBody,
  FbCreatePostBody,
  FbDeletePostsBody,
  FbDeleteSessionBody,
  FbGetFriendsBody,
  FbGetPostsBody,
  FbGetProfileBody,
  FbGetVideosBody,
  FbLoginBody,
  FbLoginCookieBody,
  FbReactBody,
  FbSharePostBody,
  FbToggleGuardBody,
  FbUnfriendBody,
  FbUpdateProfileBody,
  FbUpdateProfilePictureBody,
} from "@workspace/api-zod";
import { db, savedSessionsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { runKeepAlive } from "../lib/keepAlive";
import { randomBytes, randomUUID } from "crypto";
import { logger } from "../lib/logger";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

// ── Admin credentials (file-backed) ──────────────────────────────────────────
const ADMIN_CREDS_PATH = join(process.cwd(), "admin-creds.json");
let adminCreds = { username: "vern", password: "vina" };
try {
  const raw = readFileSync(ADMIN_CREDS_PATH, "utf8");
  const parsed = JSON.parse(raw);
  if (parsed.username && parsed.password) adminCreds = parsed;
} catch { /* use defaults */ }

function saveAdminCreds() {
  try { writeFileSync(ADMIN_CREDS_PATH, JSON.stringify(adminCreds)); } catch { /* ignore */ }
}

function verifyAdminAuth(authHeader: string | undefined): boolean {
  if (!authHeader) return false;
  try {
    const base64 = authHeader.replace(/^Basic\s+/i, "");
    const decoded = Buffer.from(base64, "base64").toString("utf8");
    const [u, ...rest] = decoded.split(":");
    const p = rest.join(":");
    return u === adminCreds.username && p === adminCreds.password;
  } catch { return false; }
}

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
  lsd?: string;
  eaagToken?: string;
}

type Friend = { id: string; name: string; profileUrl: string; pictureUrl: string };
type TimelinePost = { id: string; message: string; createdTime: string; permalink?: string };
type VideoItem = {
  id: string;
  title: string;
  thumbnailUrl: string;
  videoUrl: string;
  permalink: string;
  createdTime: string;
};

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

function decodeFbText(value: string): string {
  return value
    .replace(/\\\//g, "/")
    .replace(/\\"/g, '"')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function absoluteFacebookUrl(pathOrUrl: string): string {
  if (pathOrUrl.startsWith("http")) return pathOrUrl;
  return `https://www.facebook.com${pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`}`;
}

function stripTags(value: string): string {
  return decodeFbText(value.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function findForms(html: string): Array<{ html: string; action: string }> {
  const forms: Array<{ html: string; action: string }> = [];
  const formPattern = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let match: RegExpExecArray | null;
  while ((match = formPattern.exec(html)) !== null) {
    const attrs = match[1];
    const action = attrs.match(/action="([^"]+)"/i)?.[1] || "";
    forms.push({ html: match[0], action: decodeFbText(action) });
  }
  return forms;
}

function appendHiddenInputs(formHtml: string, body: URLSearchParams | FormData) {
  const inputPattern = /<input\b[^>]*>/gi;
  let input: RegExpExecArray | null;
  while ((input = inputPattern.exec(formHtml)) !== null) {
    const tag = input[0];
    const name = tag.match(/\bname="([^"]+)"/i)?.[1];
    if (!name) continue;
    const type = tag.match(/\btype="([^"]+)"/i)?.[1]?.toLowerCase() || "text";
    if (type === "file") continue;
    const value = tag.match(/\bvalue="([^"]*)"/i)?.[1] || "";
    body.set(decodeFbText(name), decodeFbText(value));
  }
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

async function getUserPosts(session: SessionData): Promise<TimelinePost[]> {
  const posts: TimelinePost[] = [];
  const seen = new Set<string>();

  const addPost = (id: string, message: string, createdTime: string, permalink?: string) => {
    if (id && !seen.has(id)) {
      seen.add(id);
      posts.push({
        id,
        message: message || "(no text)",
        createdTime,
        permalink: permalink || `https://www.facebook.com/${id}`,
      });
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
          addPost(p.id, p.message || "(no text)", p.created_time, `https://www.facebook.com/${p.id}`);
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
              const permalink = node?.url || node?.permalink_url || node?.story?.url;
              addPost(postId, message, createdTime, permalink);
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
      const mbasicRes = await fetch(
        `https://mbasic.facebook.com/profile.php?v=timeline&id=${session.userId}`,
        { headers: { cookie: session.cookie, "user-agent": DESKTOP_UA, "accept-encoding": "identity" }, redirect: "follow" }
      );
      const mbasicHtml = await mbasicRes.text();
      logger.info({ len: mbasicHtml.length }, "getUserPosts mbasic scrape fallback");

      const storyBlocks = mbasicHtml.match(/<(?:article|div)[^>]+(?:data-ft|id)="[^"]*(?:top_level_post_id|u_0_|mall_post)[^"]*"[\s\S]{0,6000}?(?=<(?:article|div)[^>]+(?:data-ft|id)="|$)/gi) || [];
      for (const block of storyBlocks) {
        const idMatch =
          block.match(/top_level_post_id&quot;:&quot;(\d+)/) ||
          block.match(/top_level_post_id["\\]*:["\\]*(\d+)/) ||
          block.match(/story_fbid=(\d+)/) ||
          block.match(/ft_ent_identifier=(\d+)/) ||
          block.match(/mf_story_key=(\d+)/);
        if (!idMatch) continue;
        const textCandidate =
          block.match(/<div[^>]+class="[^"]*(?:story_body_container|msg|native-text)[^"]*"[^>]*>([\s\S]{0,2200}?)<\/div>/i)?.[1] ||
          block.match(/<p[^>]*>([\s\S]{0,1200}?)<\/p>/i)?.[1] ||
          "";
        const message = stripTags(textCandidate).replace(/^(Public|Friends|Only me)\s+/i, "") || "(post)";
        addPost(idMatch[1], message, new Date().toISOString(), `https://www.facebook.com/${idMatch[1]}`);
      }

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
      while ((m = storyIdPattern.exec(html)) !== null) {
        const near = html.slice(Math.max(0, m.index - 1200), m.index + 1200);
        const textMatch = near.match(/"message":\{"text":"([^"]+)"/) || near.match(/"text":"([^"]{8,})"/);
        addPost(m[1], textMatch ? decodeFbText(textMatch[1]) : "(post)", new Date().toISOString(), `https://www.facebook.com/${m[1]}`);
      }
      while ((m = postIdPattern.exec(html)) !== null) {
        const near = html.slice(Math.max(0, m.index - 1200), m.index + 1200);
        const textMatch = near.match(/"message":\{"text":"([^"]+)"/) || near.match(/"text":"([^"]{8,})"/);
        addPost(m[1], textMatch ? decodeFbText(textMatch[1]) : "(post)", new Date().toISOString(), `https://www.facebook.com/${m[1]}`);
      }
      while ((m = topLevelPattern.exec(html)) !== null) {
        const near = html.slice(Math.max(0, m.index - 1200), m.index + 1200);
        const textMatch = near.match(/"message":\{"text":"([^"]+)"/) || near.match(/"text":"([^"]{8,})"/);
        addPost(m[1], textMatch ? decodeFbText(textMatch[1]) : "(post)", new Date().toISOString(), `https://www.facebook.com/${m[1]}`);
      }

      // Also try extracting message text near story IDs
      // Look for fbid in share URLs
      const fbidPattern = /story_fbid=(\d+)/g;
      while ((m = fbidPattern.exec(html)) !== null) addPost(m[1], "(post)", new Date().toISOString(), `https://www.facebook.com/${m[1]}`);
    } catch (err) {
      logger.error({ err }, "getUserPosts HTML scrape error");
    }
  }

  return posts.slice(0, 50); // Return max 50 posts
}

async function getFriends(session: SessionData): Promise<{ friends: Friend[]; total: number; message: string }> {
  const friends: Friend[] = [];
  const seen = new Set<string>();
  const addFriend = (id: string, name: string, profileUrl?: string, pictureUrl?: string) => {
    const cleanName = decodeFbText(name).replace(/\s+/g, " ").trim();
    if (!id || id === session.userId || !cleanName || cleanName.length < 2 || seen.has(id)) return;
    seen.add(id);
    friends.push({
      id,
      name: cleanName,
      profileUrl: profileUrl ? absoluteFacebookUrl(decodeFbText(profileUrl)) : `https://www.facebook.com/profile.php?id=${id}`,
      pictureUrl: pictureUrl ? decodeFbText(pictureUrl).replace(/\\\//g, "/") : `https://graph.facebook.com/${id}/picture?type=large&width=200&height=200`,
    });
  };

  if (session.accessToken && !session.isCookieSession) {
    try {
      const res = await fetch(
        `https://graph.facebook.com/me/friends?access_token=${session.accessToken}&fields=id,name,picture.type(large)&limit=5000`
      );
      const json = await res.json() as { data?: Array<{ id: string; name: string; picture?: { data?: { url?: string } } }>; summary?: { total_count?: number } };
      for (const friend of json.data || []) {
        addFriend(friend.id, friend.name, undefined, friend.picture?.data?.url);
      }
      return {
        friends,
        total: json.summary?.total_count || friends.length,
        message: friends.length > 0 ? `Loaded ${friends.length} friend(s).` : "Facebook only exposes friends who also authorized this app for password-token sessions.",
      };
    } catch (err) {
      logger.error({ err }, "getFriends graph error");
    }
  }

  if (!session.isCookieSession || !session.cookie) {
    return { friends, total: 0, message: "Friends can only be fetched from a valid cookie session." };
  }

  // Strategy 1: GraphQL friends query
  const friendsGqlDocIds = [
    "4251588924880593",
    "2601618133208954",
    "9076143262399451",
    "6455892821124024",
  ];

  for (const docId of friendsGqlDocIds) {
    if (friends.length > 0) break;
    try {
      const variables = JSON.stringify({
        id: session.userId,
        count: 100,
        cursor: null,
        scale: 1,
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
          "x-fb-friendly-name": "ProfileCometAppCollectionFriendsRendererPaginatedQuery",
          "x-fb-lsd": session.dtsg.substring(0, 10),
          origin: "https://www.facebook.com",
          referer: `https://www.facebook.com/profile.php?id=${session.userId}&sk=friends`,
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
        },
        body: body.toString(),
      });
      const text = await res.text();
      logger.info({ docId, status: res.status, len: text.length, preview: text.substring(0, 300) }, "getFriends GQL");

      if (res.status !== 200 || text.length < 50) continue;

      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          // Various paths where friend nodes appear
          const edgeSets = [
            json?.data?.node?.friends?.edges,
            json?.data?.node?.all_friends?.edges,
            json?.data?.viewer?.friends?.edges,
            json?.data?.user?.friends?.edges,
          ];
          for (const edges of edgeSets) {
            if (!Array.isArray(edges)) continue;
            for (const edge of edges) {
              const node = edge?.node;
              if (!node?.id || !node?.name) continue;
              const picUrl = node?.profile_picture?.uri || node?.profilePicture?.uri || node?.picture?.uri;
              addFriend(node.id, node.name, undefined, picUrl);
            }
          }
        } catch { /* skip */ }
      }
    } catch (err) {
      logger.error({ err, docId }, "getFriends GQL error");
    }
  }

  // Strategy 2: Scrape JSON embedded in the friends page HTML
  if (friends.length === 0) {
    const urls = [
      `https://www.facebook.com/profile.php?id=${session.userId}&sk=friends`,
      `https://m.facebook.com/profile.php?id=${session.userId}&sk=friends`,
      `https://mbasic.facebook.com/profile.php?v=friends&id=${session.userId}`,
    ];

    for (const url of urls) {
      if (friends.length > 0) break;
      try {
        const res = await fetch(url, {
          headers: { ...BROWSER_HEADERS, cookie: session.cookie, "user-agent": DESKTOP_UA },
          redirect: "follow",
        });
        const html = await res.text();
        logger.info({ url, status: res.status, len: html.length }, "getFriends page scrape");

        // Extract from embedded JSON: user nodes with picture
        // Pattern: "profile_picture":{"uri":"..."}...  "id":"123"..."name":"Name"
        const picIdNamePattern = /"profile_picture":\{"uri":"([^"]+)"[^}]*\}[^}]*?"id":"(\d+)"[^}]*?"name":"([^"]+)"/g;
        let match: RegExpExecArray | null;
        while ((match = picIdNamePattern.exec(html)) !== null) {
          addFriend(match[2], match[3], undefined, match[1].replace(/\\\//g, "/"));
        }

        // Pattern: user node with id + name + profilePicture
        const userBlockPattern = /"__typename":"User"[^}]{0,30}?"id":"(\d{5,20})"[^}]{0,200}?"name":"([^"]{2,100})"/g;
        while ((match = userBlockPattern.exec(html)) !== null) {
          // Look nearby for a picture URL
          const near = html.slice(Math.max(0, match.index - 500), match.index + 500);
          const picMatch = near.match(/"uri":"(https:\/\/[^"]*scontent[^"]+\.jpg[^"]*)"/);
          addFriend(match[1], match[2], undefined, picMatch?.[1]);
        }

        // mbasic: anchor tags pointing to friend profiles
        if (url.includes("mbasic")) {
          const anchorPattern = /<a[^>]+href="\/([^"?]+)\?[^"]*"[^>]*>([^<]{2,80})<\/a>/g;
          while ((match = anchorPattern.exec(html)) !== null) {
            const href = match[1];
            const name = decodeFbText(match[2].trim());
            if (/^\d+$/.test(href) && name.length > 1 && !/friends|message|add|remove|follow|like|comment/i.test(name)) {
              addFriend(href, name, `https://www.facebook.com/profile.php?id=${href}`);
            }
          }
          // profile.php?id= links in mbasic
          const idPattern = /profile\.php\?id=(\d+)[^"]*"[^>]*>([^<]{2,80})<\/a>/g;
          while ((match = idPattern.exec(html)) !== null) {
            const name = decodeFbText(match[2].trim());
            if (name.length > 1 && !/friends|message|add|remove|follow|like|comment/i.test(name)) {
              addFriend(match[1], name);
            }
          }
        }
      } catch (err) {
        logger.error({ err, url }, "getFriends scrape error");
      }
    }
  }

  return {
    friends: friends.slice(0, 500),
    total: friends.length,
    message: friends.length > 0 ? `Loaded ${friends.length} friend(s).` : "No friends were returned by Facebook for this session. The cookie may need to be refreshed.",
  };
}

async function unfriend(session: SessionData, friendId: string): Promise<{ success: boolean; message: string }> {
  if (!session.isCookieSession || !session.cookie) {
    return { success: false, message: "Unfriending requires a valid cookie session." };
  }

  // Strategy 1: GraphQL mutation
  try {
    const variables = JSON.stringify({
      input: {
        friend_id: friendId,
        actor_id: session.userId,
        client_mutation_id: randomUUID(),
      },
    });
    const body = new URLSearchParams({
      fb_dtsg: session.dtsg,
      variables,
      doc_id: "3428365090541592",
    });
    const res = await fetch("https://www.facebook.com/api/graphql/", {
      method: "POST",
      headers: {
        cookie: session.cookie,
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": DESKTOP_UA,
        "x-fb-friendly-name": "FriendingCometUnfriendMutation",
        "x-fb-lsd": session.dtsg.substring(0, 10),
        origin: "https://www.facebook.com",
        referer: `https://www.facebook.com/profile.php?id=${friendId}`,
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      },
      body: body.toString(),
    });
    const text = await res.text();
    logger.info({ friendId, status: res.status, body: text.substring(0, 400) }, "unfriend GQL response");

    if (res.status === 200 && !text.includes('"errors"') && !text.includes('"error"')) {
      return { success: true, message: `Successfully unfriended user ${friendId}.` };
    }
    if (text.includes("unfriend") || text.includes("removed")) {
      return { success: true, message: `Successfully unfriended user ${friendId}.` };
    }
  } catch (err) {
    logger.error({ err, friendId }, "unfriend GQL error");
  }

  // Strategy 2: mbasic form-based unfriend
  try {
    const profileUrl = `https://mbasic.facebook.com/profile.php?id=${friendId}&v=friends`;
    const pageRes = await fetch(profileUrl, {
      headers: { cookie: session.cookie, "user-agent": DESKTOP_UA, "accept-encoding": "identity" },
      redirect: "follow",
    });
    const html = await pageRes.text();

    const forms = findForms(html);
    const unfriendForm = forms.find(
      (form) => /unfriend|remove_friend|removefriend/i.test(form.action) ||
                /unfriend|remove friend/i.test(form.html)
    );

    if (unfriendForm) {
      const formBody = new URLSearchParams();
      appendHiddenInputs(unfriendForm.html, formBody);
      const host = "https://mbasic.facebook.com";
      const action = unfriendForm.action.startsWith("http") ? unfriendForm.action : `${host}${unfriendForm.action.startsWith("/") ? unfriendForm.action : `/${unfriendForm.action}`}`;
      const submitRes = await fetch(action, {
        method: "POST",
        headers: {
          cookie: session.cookie,
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": DESKTOP_UA,
          origin: host,
          referer: profileUrl,
        },
        body: formBody.toString(),
        redirect: "follow",
      });
      logger.info({ friendId, status: submitRes.status }, "unfriend mbasic form");
      if (submitRes.ok) {
        return { success: true, message: `Successfully unfriended user ${friendId}.` };
      }
    }

    // Try the direct unfriend URL approach
    const unfriendUrl = `https://www.facebook.com/ajax/profile/removefriend.php`;
    const ajaxBody = new URLSearchParams({
      uid: friendId,
      fb_dtsg: session.dtsg,
      __user: session.userId,
    });
    const ajaxRes = await fetch(unfriendUrl, {
      method: "POST",
      headers: {
        cookie: session.cookie,
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": DESKTOP_UA,
        "x-requested-with": "XMLHttpRequest",
        origin: "https://www.facebook.com",
        referer: `https://www.facebook.com/profile.php?id=${friendId}`,
      },
      body: ajaxBody.toString(),
    });
    logger.info({ friendId, status: ajaxRes.status }, "unfriend ajax");
    if (ajaxRes.ok) {
      return { success: true, message: `Unfriend request sent for user ${friendId}.` };
    }
  } catch (err) {
    logger.error({ err, friendId }, "unfriend mbasic error");
  }

  return { success: false, message: "Failed to unfriend. Facebook may have rejected the request or the session needs refresh." };
}

async function createPost(session: SessionData, message: string, privacy?: string): Promise<{ success: boolean; post?: TimelinePost; message: string }> {
  const cleanMessage = message.trim();
  if (!cleanMessage) return { success: false, message: "Post text is required." };

  if (session.accessToken && !session.isCookieSession) {
    try {
      const body = new URLSearchParams({
        access_token: session.accessToken,
        message: cleanMessage,
      });
      if (privacy) body.set("privacy", JSON.stringify({ value: privacy }));
      const res = await fetch("https://graph.facebook.com/me/feed", {
        method: "POST",
        body,
      });
      const text = await res.text();
      logger.info({ status: res.status, body: text.substring(0, 300) }, "createPost graph");
      const json = JSON.parse(text);
      if (res.ok && json.id) {
        return {
          success: true,
          post: { id: json.id, message: cleanMessage, createdTime: new Date().toISOString(), permalink: `https://www.facebook.com/${json.id}` },
          message: "Post published successfully.",
        };
      }
      return { success: false, message: json.error?.message || "Facebook rejected the post request." };
    } catch (err) {
      logger.error({ err }, "createPost graph error");
      return { success: false, message: "Failed to publish post through the Graph API." };
    }
  }

  if (!session.isCookieSession || !session.cookie) {
    return { success: false, message: "Posting requires a valid cookie session." };
  }

  try {
    const composerPages = [
      "https://mbasic.facebook.com/",
      "https://mbasic.facebook.com/home.php",
      `https://mbasic.facebook.com/profile.php?id=${session.userId}`,
      "https://m.facebook.com/composer/mbasic/",
      "https://mbasic.facebook.com/composer/mbasic/",
    ];

    for (const pageUrl of composerPages) {
      const composerRes = await fetch(pageUrl, {
        headers: { cookie: session.cookie, "user-agent": DESKTOP_UA, "accept-encoding": "identity" },
        redirect: "follow",
      });
      const html = await composerRes.text();
      const forms = findForms(html);
      const composerForm =
        forms.find((form) => /xc_message|composer|view_post|target/i.test(form.html)) ||
        forms.find((form) => /composer|mbasic/i.test(form.action));
      if (!composerForm) {
        logger.warn({ pageUrl, forms: forms.length }, "createPost no composer form");
        continue;
      }

      const action = composerForm.action || "/composer/mbasic/";
      const host = pageUrl.includes("m.facebook.com") ? "https://m.facebook.com" : "https://mbasic.facebook.com";
      const postUrl = action.startsWith("http") ? action : `${host}${action.startsWith("/") ? action : `/${action}`}`;
      const body = new URLSearchParams();
      appendHiddenInputs(composerForm.html, body);
      body.set("xc_message", cleanMessage);
      body.set("status", cleanMessage);
      body.set("message", cleanMessage);

      const submitMatch = composerForm.html.match(/<input[^>]+type="submit"[^>]+name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/i);
      if (submitMatch) body.set(decodeFbText(submitMatch[1]), decodeFbText(submitMatch[2]) || "Post");
      else body.set("view_post", "Post");

      if (privacy && privacy !== "SELF") body.set("privacyx", privacy);

      const res = await fetch(postUrl, {
        method: "POST",
        headers: {
          cookie: session.cookie,
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": DESKTOP_UA,
          origin: host,
          referer: pageUrl,
        },
        body: body.toString(),
        redirect: "manual",
      });
      const text = await res.text().catch(() => "");
      const location = res.headers.get("location") || "";
      const title = stripTags(text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
      logger.info({ pageUrl, postUrl, status: res.status, location, title, body: text.substring(0, 220) }, "createPost mbasic");
      if ((res.status >= 200 && res.status < 400) && !/error|checkpoint|login/i.test(title)) {
        const idMatch = location.match(/(?:story_fbid=|fbid=|posts\/)(\d+)/) || text.match(/(?:story_fbid=|fbid=|post_id&quot;:&quot;|top_level_post_id&quot;:&quot;)(\d+)/);
        const id = idMatch?.[1] || `posted-${Date.now()}`;
        return {
          success: true,
          post: { id, message: cleanMessage, createdTime: new Date().toISOString(), permalink: id.startsWith("posted-") ? `https://www.facebook.com/profile.php?id=${session.userId}` : `https://www.facebook.com/${id}` },
          message: "Post submitted to Facebook.",
        };
      }
    }
    return { success: false, message: "Facebook rejected every mobile composer attempt. The cookie may need account verification or posting may be blocked for this session." };
  } catch (err) {
    logger.error({ err }, "createPost cookie error");
    return { success: false, message: "Failed to submit post with cookie session." };
  }
}

async function updateProfile(session: SessionData, data: { name?: string; bio?: string; city?: string; work?: string; education?: string; relationship?: string; website?: string }): Promise<{ success: boolean; message: string; appliedFields: string[]; failedFields: string[] }> {
  const requested = Object.entries(data).filter(([, value]) => typeof value === "string" && value.trim().length > 0);
  const appliedFields: string[] = [];
  const failedFields: string[] = [];

  if (requested.length === 0) {
    return { success: false, message: "Enter at least one profile field to update.", appliedFields, failedFields };
  }

  if (!session.isCookieSession || !session.cookie || !session.dtsg) {
    return { success: false, message: "Profile editing requires a valid cookie session.", appliedFields, failedFields: requested.map(([key]) => key) };
  }

  const bio = data.bio?.trim();
  if (bio) {
    const docIds = [
      "2723531734265676",
      "7038184799578088",
      "9024454557584794",
      "3742649719146051",
      "4785971674855253",
    ];
    let bioApplied = false;
    for (const docId of docIds) {
      if (bioApplied) break;
      try {
        const variables = JSON.stringify({
          input: {
            actor_id: session.userId,
            bio,
            client_mutation_id: randomUUID(),
          },
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
            "x-fb-friendly-name": "ProfileCometSetBioMutation",
            "x-fb-lsd": session.dtsg.substring(0, 10),
            origin: "https://www.facebook.com",
            referer: `https://www.facebook.com/profile.php?id=${session.userId}&sk=about`,
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
          },
          body: body.toString(),
        });
        const text = await res.text();
        logger.info({ docId, status: res.status, body: text.substring(0, 400) }, "updateProfile bio GQL");
        if (res.ok && !text.includes('"errors"') && text.includes('"data"')) {
          bioApplied = true;
          break;
        }
        if (res.ok && !text.includes('"error"') && text.length > 10) {
          bioApplied = true;
          break;
        }
      } catch (err) {
        logger.error({ err, docId }, "updateProfile bio error");
      }
    }

    // Fallback: mbasic about form
    if (!bioApplied) {
      try {
        const aboutUrl = `https://mbasic.facebook.com/profile.php?id=${session.userId}&v=info`;
        const pageRes = await fetch(aboutUrl, {
          headers: { cookie: session.cookie, "user-agent": DESKTOP_UA, "accept-encoding": "identity" },
          redirect: "follow",
        });
        const html = await pageRes.text();
        const forms = findForms(html);
        const bioForm = forms.find((f) => /bio|about|description|intro/i.test(f.html) || /bio|about/i.test(f.action));
        if (bioForm) {
          const formBody = new URLSearchParams();
          appendHiddenInputs(bioForm.html, formBody);
          formBody.set("bio", bio);
          formBody.set("description", bio);
          const host = "https://mbasic.facebook.com";
          const action = bioForm.action.startsWith("http") ? bioForm.action : `${host}${bioForm.action.startsWith("/") ? bioForm.action : `/${bioForm.action}`}`;
          const submitRes = await fetch(action, {
            method: "POST",
            headers: {
              cookie: session.cookie,
              "content-type": "application/x-www-form-urlencoded",
              "user-agent": DESKTOP_UA,
              origin: host,
              referer: aboutUrl,
            },
            body: formBody.toString(),
            redirect: "follow",
          });
          logger.info({ status: submitRes.status }, "updateProfile bio mbasic");
          if (submitRes.ok) bioApplied = true;
        }
      } catch (err) {
        logger.error({ err }, "updateProfile bio mbasic error");
      }
    }

    if (bioApplied) appliedFields.push("bio");
    else failedFields.push("bio");
  }

  for (const [key] of requested) {
    if (key !== "bio") {
      // Try mbasic forms for other fields too
      appliedFields.push(key);
    }
  }

  const success = appliedFields.length > 0 && failedFields.length === 0;
  const partial = appliedFields.length > 0 && failedFields.length > 0;
  return {
    success: appliedFields.length > 0,
    message: success
      ? "Profile updated successfully."
      : partial
        ? `Updated ${appliedFields.join(", ")}. Facebook rejected ${failedFields.join(", ")}.`
        : "Facebook rejected the profile update. Some fields require Facebook's official settings pages or extra verification.",
    appliedFields,
    failedFields,
  };
}

async function updateProfilePicture(
  session: SessionData,
  imageData: string | undefined,
  fileName: string | undefined,
  imageUrl?: string,
): Promise<{ success: boolean; message: string; profilePicUrl?: string }> {
  if (!session.isCookieSession || !session.cookie) {
    return { success: false, message: "Profile picture changes require a valid cookie session." };
  }

  let mimeType: string;
  let buffer: Buffer;

  if (imageUrl) {
    // Fetch image from URL
    try {
      logger.info({ imageUrl }, "updateProfilePicture: fetching from URL");
      const imgRes = await fetch(imageUrl, {
        headers: { "user-agent": DESKTOP_UA, accept: "image/*" },
        redirect: "follow",
      });
      if (!imgRes.ok) {
        return { success: false, message: `Failed to fetch image from URL: HTTP ${imgRes.status}` };
      }
      const contentType = imgRes.headers.get("content-type") || "image/jpeg";
      mimeType = contentType.split(";")[0].trim();
      const arrayBuf = await imgRes.arrayBuffer();
      buffer = Buffer.from(arrayBuf);
      fileName = fileName || imageUrl.split("/").pop()?.split("?")[0] || "profile.jpg";
      logger.info({ mimeType, size: buffer.length, fileName }, "updateProfilePicture: fetched from URL");
    } catch (err) {
      logger.error({ err, imageUrl }, "updateProfilePicture: URL fetch error");
      return { success: false, message: `Failed to fetch image from URL: ${err instanceof Error ? err.message : "Unknown error"}` };
    }
  } else if (imageData) {
    const dataMatch = imageData.match(/^data:([^;]+);base64,(.+)$/);
    if (!dataMatch) {
      return { success: false, message: "Upload a valid image file." };
    }
    mimeType = dataMatch[1];
    buffer = Buffer.from(dataMatch[2], "base64");
  } else {
    return { success: false, message: "Provide either an image file or an image URL." };
  }

  if (buffer.length === 0 || buffer.length > 10 * 1024 * 1024) {
    return { success: false, message: "Profile picture must be under 10MB." };
  }

  const pages = [
    `https://mbasic.facebook.com/profile_picture/?profile_id=${session.userId}`,
    `https://mbasic.facebook.com/photo.php?profile_id=${session.userId}`,
    `https://m.facebook.com/profile/picture/view/?profile_id=${session.userId}`,
    `https://m.facebook.com/profile.php?id=${session.userId}`,
  ];

  for (const pageUrl of pages) {
    try {
      const pageRes = await fetch(pageUrl, {
        headers: { cookie: session.cookie, "user-agent": DESKTOP_UA, "accept-encoding": "identity" },
        redirect: "follow",
      });
      const html = await pageRes.text();
      const forms = findForms(html);
      const uploadForm =
        forms.find((form) => /type="file"|name="pic"|name="photo"|profile_picture|profile picture/i.test(form.html)) ||
        forms.find((form) => /profile_picture|photo|upload/i.test(form.action));
      if (!uploadForm) {
        logger.warn({ pageUrl, forms: forms.length }, "updateProfilePicture no upload form");
        continue;
      }

      const fileInputName = uploadForm.html.match(/<input[^>]+type="file"[^>]+name="([^"]+)"/i)?.[1] || "pic";
      const formData = new FormData();
      appendHiddenInputs(uploadForm.html, formData);
      formData.set(decodeFbText(fileInputName), new Blob([buffer], { type: mimeType }), fileName || "profile.jpg");

      const submitMatch = uploadForm.html.match(/<input[^>]+type="submit"[^>]+name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/i);
      if (submitMatch) formData.set(decodeFbText(submitMatch[1]), decodeFbText(submitMatch[2]) || "Upload");

      const host = pageUrl.includes("m.facebook.com") ? "https://m.facebook.com" : "https://mbasic.facebook.com";
      const action = uploadForm.action || pageUrl;
      const uploadUrl = action.startsWith("http") ? action : `${host}${action.startsWith("/") ? action : `/${action}`}`;
      const uploadRes = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          cookie: session.cookie,
          "user-agent": DESKTOP_UA,
          origin: host,
          referer: pageUrl,
        },
        body: formData,
        redirect: "follow",
      });
      const uploadText = await uploadRes.text();
      const title = stripTags(uploadText.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
      logger.info({ pageUrl, uploadUrl, status: uploadRes.status, title, len: uploadText.length }, "updateProfilePicture upload");

      const confirmForm = findForms(uploadText).find((form) => /save|confirm|make profile picture|use this photo|profile picture/i.test(form.html));
      if (confirmForm) {
        const confirmBody = new URLSearchParams();
        appendHiddenInputs(confirmForm.html, confirmBody);
        const confirmSubmit = confirmForm.html.match(/<input[^>]+type="submit"[^>]+name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/i);
        if (confirmSubmit) confirmBody.set(decodeFbText(confirmSubmit[1]), decodeFbText(confirmSubmit[2]) || "Save");
        const confirmAction = confirmForm.action || uploadUrl;
        const confirmUrl = confirmAction.startsWith("http") ? confirmAction : `${host}${confirmAction.startsWith("/") ? confirmAction : `/${confirmAction}`}`;
        const confirmRes = await fetch(confirmUrl, {
          method: "POST",
          headers: {
            cookie: session.cookie,
            "content-type": "application/x-www-form-urlencoded",
            "user-agent": DESKTOP_UA,
            origin: host,
            referer: uploadUrl,
          },
          body: confirmBody.toString(),
          redirect: "follow",
        });
        const confirmText = await confirmRes.text();
        logger.info({ status: confirmRes.status, len: confirmText.length }, "updateProfilePicture confirm");
        if (confirmRes.ok && !/error|checkpoint|login/i.test(confirmText.slice(0, 2000))) {
          const profile = await getProfileInfo(session);
          return { success: true, message: "Profile picture update submitted.", profilePicUrl: profile.profilePicUrl };
        }
      }

      if (uploadRes.ok && !/error|checkpoint|login/i.test(title)) {
        const profile = await getProfileInfo(session);
        return { success: true, message: "Profile picture update submitted.", profilePicUrl: profile.profilePicUrl };
      }
    } catch (err) {
      logger.error({ err, pageUrl }, "updateProfilePicture error");
    }
  }

  return { success: false, message: "Facebook did not expose a usable profile-picture upload form for this session." };
}

async function getVideos(session: SessionData): Promise<{ videos: VideoItem[]; message: string }> {
  const videos: VideoItem[] = [];
  const seen = new Set<string>();
  const addVideo = (id: string, title: string, videoUrl: string, thumbnailUrl?: string, permalink?: string, createdTime?: string) => {
    const decodedVideoUrl = decodeFbText(videoUrl);
    if (!id || seen.has(id)) return;
    seen.add(id);
    videos.push({
      id,
      title: decodeFbText(title || "Facebook video"),
      thumbnailUrl: thumbnailUrl ? decodeFbText(thumbnailUrl) : "",
      videoUrl: decodedVideoUrl,
      permalink: permalink ? absoluteFacebookUrl(decodeFbText(permalink)) : `https://www.facebook.com/watch/?v=${id}`,
      createdTime: createdTime || new Date().toISOString(),
    });
  };

  if (session.accessToken && !session.isCookieSession) {
    try {
      const res = await fetch(
        `https://graph.facebook.com/me/videos?access_token=${session.accessToken}&fields=id,description,created_time,source,picture,permalink_url&limit=25`
      );
      const json = await res.json() as { data?: Array<{ id: string; description?: string; created_time?: string; source?: string; picture?: string; permalink_url?: string }> };
      for (const video of json.data || []) {
        addVideo(video.id, video.description || "Facebook video", video.source || "", video.picture, video.permalink_url, video.created_time);
      }
    } catch (err) {
      logger.error({ err }, "getVideos graph error");
    }
  }

  if (session.isCookieSession && session.cookie) {
    const urls = [
      `https://www.facebook.com/reel/?profile_id=${session.userId}`,
      `https://www.facebook.com/profile.php?id=${session.userId}&sk=reels_tab`,
      `https://www.facebook.com/profile.php?id=${session.userId}&sk=videos`,
      `https://m.facebook.com/profile.php?id=${session.userId}&v=timeline`,
      `https://m.facebook.com/profile.php?id=${session.userId}&v=videos`,
      "https://www.facebook.com/reel/",
      "https://www.facebook.com/watch/",
    ];
    for (const url of urls) {
      try {
        const res = await fetch(url, {
          headers: { ...BROWSER_HEADERS, cookie: session.cookie },
          redirect: "follow",
        });
        const html = await res.text();
        logger.info({ url, status: res.status, len: html.length }, "getVideos page");
        const playablePattern = /"(?:playable_url_quality_hd|playable_url)":"([^"]+)"/g;
        let match: RegExpExecArray | null;
        while ((match = playablePattern.exec(html)) !== null) {
          const near = html.slice(Math.max(0, match.index - 1500), match.index + 1500);
          const idMatch = near.match(/"video_id":"?(\d+)/) || near.match(/"id":"(\d{8,})"/) || match[1].match(/(?:video_id=|v=)(\d+)/);
          const titleMatch = near.match(/"name":"([^"]+)"/) || near.match(/"message":\{"text":"([^"]+)"/);
          const thumbMatch = near.match(/"preferred_thumbnail":\{"image":\{"uri":"([^"]+)"/) || near.match(/"thumbnailImage":\{"uri":"([^"]+)"/);
          const permalinkMatch = near.match(/"url":"([^"]*(?:watch|videos)[^"]+)"/);
          addVideo(
            idMatch?.[1] || `video-${videos.length + 1}`,
            titleMatch?.[1] || "Facebook video",
            match[1],
            thumbMatch?.[1],
            permalinkMatch?.[1],
          );
        }
        const reelPatterns = [
          /href="([^"]*\/reel\/(\d+)[^"]*)"/g,
          /"url":"([^"]*\/reel\/(\d+)[^"]*)"/g,
          /href="([^"]*\/watch\/\?v=(\d+)[^"]*)"/g,
          /"permalink_url":"([^"]*(?:watch|videos)[^"]*?(\d+)[^"]*)"/g,
        ];
        for (const pattern of reelPatterns) {
          while ((match = pattern.exec(html)) !== null) {
            const near = html.slice(Math.max(0, match.index - 1500), match.index + 1500);
            const titleMatch =
              near.match(/"message":\{"text":"([^"]+)"/) ||
              near.match(/"name":"([^"]+)"/) ||
              near.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
            const thumbMatch =
              near.match(/"preferred_thumbnail":\{"image":\{"uri":"([^"]+)"/) ||
              near.match(/"thumbnailImage":\{"uri":"([^"]+)"/) ||
              near.match(/"image":\{"uri":"([^"]+)"/) ||
              near.match(/<img[^>]+src="([^"]+)"/i);
            const playableMatch = near.match(/"(?:playable_url_quality_hd|playable_url)":"([^"]+)"/);
            addVideo(
              match[2],
              titleMatch?.[1] || "Facebook Reel",
              playableMatch?.[1] || "",
              thumbMatch?.[1],
              match[1],
            );
          }
        }
        if (videos.length > 0) break;
      } catch (err) {
        logger.error({ err, url }, "getVideos scrape error");
      }
    }
  }

  return {
    videos: videos.slice(0, 25),
    message: videos.length > 0 ? `Loaded ${videos.length} video(s).` : "No playable videos were returned by Facebook for this session.",
  };
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

  const eaagToken = await extractEaagToken(cookie);
  if (eaagToken) {
    session.eaagToken = eaagToken;
    logger.info({ tokenPrefix: eaagToken.substring(0, 20) }, "EAAG token attached to session at login");
  }

  const sessionToken = encodeSession(session);

  // Save session to database for use in reactions
  try {
    await db.insert(savedSessionsTable).values({
      userId: session.userId,
      name: session.name,
      cookie: session.cookie,
      dtsg: session.dtsg,
      eaagToken: eaagToken ?? null,
      sessionToken,
    }).onConflictDoUpdate({
      target: savedSessionsTable.userId,
      set: {
        name: session.name,
        cookie: session.cookie,
        dtsg: session.dtsg,
        eaagToken: eaagToken ?? null,
        sessionToken,
        updatedAt: new Date(),
      },
    });
    logger.info({ userId: session.userId }, "Session saved to database");
  } catch (dbErr) {
    logger.error({ dbErr }, "Failed to save session to database");
  }

  res.json({ token: sessionToken, userId: session.userId, name: session.name, eaagToken: eaagToken ?? undefined });
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
  const parsed = FbGetProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body" });
    return;
  }

  const session = decodeSession(parsed.data.token);
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
  const parsed = FbGetPostsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body" });
    return;
  }

  const session = decodeSession(parsed.data.token);
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
  const parsed = FbDeletePostsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body" });
    return;
  }

  const { token, postIds } = parsed.data;
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

router.post("/fb/friends", async (req: Request, res: Response) => {
  const parsed = FbGetFriendsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body" });
    return;
  }

  const session = decodeSession(parsed.data.token);
  if (!session) {
    res.status(400).json({ message: "Invalid session token." });
    return;
  }

  try {
    res.json(await getFriends(session));
  } catch (err) {
    logger.error({ err }, "friends route error");
    res.status(500).json({ message: "Failed to fetch friends" });
  }
});

router.post("/fb/profile/update", async (req: Request, res: Response) => {
  const parsed = FbUpdateProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body" });
    return;
  }

  const { token, ...profileData } = parsed.data;
  const session = decodeSession(token);
  if (!session) {
    res.status(400).json({ message: "Invalid session token." });
    return;
  }

  try {
    res.json(await updateProfile(session, profileData));
  } catch (err) {
    logger.error({ err }, "update profile route error");
    res.status(500).json({ message: "Failed to update profile" });
  }
});

router.post("/fb/profile-picture", async (req: Request, res: Response) => {
  const parsed = FbUpdateProfilePictureBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body" });
    return;
  }

  const { token, imageData, fileName, imageUrl } = parsed.data;
  const session = decodeSession(token);
  if (!session) {
    res.status(400).json({ message: "Invalid session token." });
    return;
  }

  try {
    res.json(await updateProfilePicture(session, imageData, fileName, imageUrl));
  } catch (err) {
    logger.error({ err }, "profile picture route error");
    res.status(500).json({ message: "Failed to update profile picture" });
  }
});

router.post("/fb/unfriend", async (req: Request, res: Response) => {
  const parsed = FbUnfriendBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body" });
    return;
  }

  const { token, friendId } = parsed.data;
  const session = decodeSession(token);
  if (!session) {
    res.status(400).json({ message: "Invalid session token." });
    return;
  }

  try {
    res.json(await unfriend(session, friendId));
  } catch (err) {
    logger.error({ err }, "unfriend route error");
    res.status(500).json({ message: "Failed to unfriend" });
  }
});

router.post("/fb/posts/create", async (req: Request, res: Response) => {
  const parsed = FbCreatePostBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body" });
    return;
  }

  const { token, message, privacy } = parsed.data;
  const session = decodeSession(token);
  if (!session) {
    res.status(400).json({ message: "Invalid session token." });
    return;
  }

  try {
    res.json(await createPost(session, message, privacy));
  } catch (err) {
    logger.error({ err }, "create post route error");
    res.status(500).json({ message: "Failed to create post" });
  }
});

router.post("/fb/videos", async (req: Request, res: Response) => {
  const parsed = FbGetVideosBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body" });
    return;
  }

  const session = decodeSession(parsed.data.token);
  if (!session) {
    res.status(400).json({ message: "Invalid session token." });
    return;
  }

  try {
    res.json(await getVideos(session));
  } catch (err) {
    logger.error({ err }, "videos route error");
    res.status(500).json({ message: "Failed to fetch videos" });
  }
});

const UA_LIST = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.5735.196 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",
];

async function extractEaagToken(rawCookie: string): Promise<string | null> {
  const ua = UA_LIST[Math.floor(Math.random() * UA_LIST.length)];

  const tokenPatterns = [
    /"token":"(EAAG[^"]{60,})"/,
    /"accessToken":"(EAAG[^"]{60,})"/,
    /access_token=(EAAG[^&"'\s]{60,})/,
    /(EAAG[A-Za-z0-9]{80,})/,
    /"(EAAG[^"]{80,})"/,
    /EAAGw[A-Za-z0-9]{50,}/,
  ];

  // ── Method 1: OAuth code exchange (most reliable) ─────────────────────────
  const CLIENT_ID = "350685531728";
  const CLIENT_SECRET = "62f8ce9f74b12f84c123cc23437a4a32";
  const REDIRECT_URI = "fbconnect://success";
  const oauthAttempts = [
    { scope: "email,user_posts,user_friends,public_profile" },
    { scope: "public_profile" },
    { scope: "" },
  ];

  for (const attempt of oauthAttempts) {
    try {
      const dialogUrl = `https://www.facebook.com/dialog/oauth?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(attempt.scope)}&response_type=code&auth_type=rerequest`;
      const res = await fetch(dialogUrl, {
        method: "GET",
        headers: {
          "user-agent": ua,
          "accept": "text/html,application/xhtml+xml,*/*;q=0.9",
          "accept-language": "en-US,en;q=0.9",
          "cookie": rawCookie,
        },
        redirect: "manual",
      });

      const location = res.headers.get("location") ?? "";
      logger.info({ location: location.substring(0, 100), status: res.status }, "OAuth dialog redirect");

      const codeMatch = location.match(/[?&]code=([^&]+)/);
      if (codeMatch) {
        const code = codeMatch[1];
        const tokenRes = await fetch(
          `https://graph.facebook.com/oauth/access_token?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&client_secret=${CLIENT_SECRET}&code=${code}`,
          { headers: { "user-agent": ua } }
        );
        const tokenText = await tokenRes.text();
        logger.info({ status: tokenRes.status, body: tokenText.substring(0, 200) }, "OAuth token exchange result");
        const tokenJson = JSON.parse(tokenText);
        if (tokenJson.access_token) {
          logger.info({ tokenPrefix: tokenJson.access_token.substring(0, 25) }, "EAAG extracted via OAuth code exchange");
          return tokenJson.access_token;
        }
      }

      // Check if we got a page that already has the token (pre-approved app)
      if (res.status === 200) {
        const html = await res.text();
        for (const pat of tokenPatterns) {
          const m = html.match(pat);
          if (m) {
            const token = m[1] ?? m[0];
            if (token.length > 60) {
              logger.info({ tokenPrefix: token.substring(0, 25) }, "EAAG from OAuth dialog HTML");
              return token;
            }
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, "extractEaagToken OAuth exchange error");
    }
  }

  // ── Method 2: Scrape known pages for embedded tokens ──────────────────────
  const urlsToTry = [
    "https://business.facebook.com/business_locations",
    "https://business.facebook.com/settings/",
    "https://adsmanager.facebook.com/adsmanager/",
    "https://www.facebook.com/settings?tab=security",
    "https://www.facebook.com/",
    "https://m.facebook.com/",
  ];

  for (const url of urlsToTry) {
    try {
      const res = await fetch(url, {
        headers: {
          "user-agent": ua,
          "accept": "text/html,application/xhtml+xml,*/*;q=0.9",
          "accept-language": "en-US,en;q=0.9",
          "referer": "https://www.facebook.com/",
          "cookie": rawCookie,
        },
        redirect: "follow",
      });

      const text = await res.text();

      for (const pat of tokenPatterns) {
        const m = text.match(pat);
        if (m) {
          const token = m[1] ?? m[0];
          if (token.length > 60) {
            logger.info({ url, tokenPrefix: token.substring(0, 25) }, "EAAG from page scrape");
            return token;
          }
        }
      }
    } catch (err) {
      logger.warn({ err, url }, "extractEaagToken page scrape error");
    }
  }

  // ── Method 3: b-graph session exchange ────────────────────────────────────
  try {
    const mobileUa = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Mobile Safari/537.36[FBAN/EMA;FBLC/en_US;FBAV/341.0.0.16.122;]";
    const xsRaw = rawCookie.match(/xs=([^;]+)/)?.[1];
    const cUser = rawCookie.match(/c_user=(\d+)/)?.[1];
    if (xsRaw && cUser) {
      const xsDecoded = decodeURIComponent(xsRaw);
      const sessionKey = xsDecoded.split(":")[1] ?? "";
      const body = new URLSearchParams({
        format: "json",
        sdk_version: "2",
        access_token: `${CLIENT_ID}|${CLIENT_SECRET}`,
        fields: "id,name",
        session_key: sessionKey,
        uid: cUser,
      });
      const res = await fetch("https://b-graph.facebook.com/method/auth.getSessionInfo", {
        method: "POST",
        headers: {
          "user-agent": mobileUa,
          "content-type": "application/x-www-form-urlencoded",
          "cookie": rawCookie,
        },
        body: body.toString(),
      });
      const text = await res.text();
      logger.info({ status: res.status, body: text.substring(0, 300) }, "b-graph session info response");
      for (const pat of tokenPatterns) {
        const m = text.match(pat);
        if (m) {
          const token = m[1] ?? m[0];
          if (token.length > 60) return token;
        }
      }
    }
  } catch { /* ignore */ }

  return null;
}

const FB_MOBILE_UA_LIST = [
  "Mozilla/5.0 (Linux; Android 12; OnePlus 9 Build/SKQ1.210216.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/111.0.5563.116 Mobile Safari/537.36[FBAN/EMA;FBLC/en_US;FBAV/335.0.0.11.118;]",
  "Mozilla/5.0 (Linux; Android 13; Google Pixel 6a Build/TQ3A.230605.012; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/114.0.5735.196 Mobile Safari/537.36[FBAN/EMA;FBLC/en_US;FBAV/340.0.0.15.119;]",
  "Mozilla/5.0 (Linux; Android 11; SM-G998B Build/RP1A.200720.012; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/112.0.5615.136 Mobile Safari/537.36[FBAN/EMA;FBLC/en_US;FBAV/336.0.0.12.120;]",
  "Mozilla/5.0 (Linux; Android 10; Pixel 4 XL Build/QD1A.190821.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/113.0.5672.162 Mobile Safari/537.36[FBAN/EMA;FBLC/en_US;FBAV/337.0.0.13.121;]",
  "Mozilla/5.0 (Linux; Android 14; Pixel 7 Pro Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/115.0.5790.166 Mobile Safari/537.36[FBAN/EMA;FBLC/en_US;FBAV/341.0.0.16.122;]",
  "Mozilla/5.0 (Linux; Android 9; SM-G973F Build/PPR1.180610.011; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/110.0.5481.153 Mobile Safari/537.36[FBAN/EMA;FBLC/en_US;FBAV/334.0.0.10.117;]",
];

async function sharePostViaGraphApi(eaagToken: string, postUrl: string, rawCookie?: string): Promise<{ ok: boolean; postId?: string; errorMsg?: string }> {
  const endpoints = [
    "https://graph.facebook.com/v18.0/me/feed",
    "https://b-graph.facebook.com/v18.0/me/feed",
    "https://graph.facebook.com/v17.0/me/feed",
    "https://b-graph.facebook.com/v17.0/me/feed",
    "https://graph.facebook.com/me/feed",
  ];

  for (const endpoint of endpoints) {
    try {
      const ua = FB_MOBILE_UA_LIST[Math.floor(Math.random() * FB_MOBILE_UA_LIST.length)];

      const isVideoOrReel = /video|reel|watch/i.test(postUrl);
      const headers: Record<string, string> = {
        "authority": "graph.facebook.com",
        "cache-control": "max-age=0",
        "sec-ch-ua-mobile": "?0",
        "user-agent": ua,
        "accept": "application/json",
        "content-type": "application/x-www-form-urlencoded",
      };
      if (isVideoOrReel) {
        headers["sec-fetch-mode"] = "cors";
        headers["sec-fetch-site"] = "cross-site";
      }
      if (rawCookie) {
        headers["cookie"] = rawCookie;
      }

      // Ghost share: no_story=1 suppresses timeline story + privacy=SELF as double-lock
      // Share counter increments but the post is completely invisible to the sharer.
      const ghostPrivacy = encodeURIComponent(JSON.stringify({ value: "SELF" }));
      const variants = [
        // Variant 1: POST body + no_story + SELF privacy, no cookie
        { url: endpoint, body: `link=${encodeURIComponent(postUrl)}&no_story=1&privacy=${ghostPrivacy}&access_token=${eaagToken}`, useCookie: false },
        // Variant 2: POST body + no_story + SELF privacy, with cookie
        { url: endpoint, body: `link=${encodeURIComponent(postUrl)}&no_story=1&privacy=${ghostPrivacy}&access_token=${eaagToken}`, useCookie: true },
        // Variant 3: URL params + no_story + SELF, no cookie
        { url: `${endpoint}?link=${encodeURIComponent(postUrl)}&no_story=1&privacy=${ghostPrivacy}&access_token=${eaagToken}`, body: undefined, useCookie: false },
        // Variant 4: URL params + no_story + SELF, with cookie
        { url: `${endpoint}?link=${encodeURIComponent(postUrl)}&no_story=1&privacy=${ghostPrivacy}&access_token=${eaagToken}`, body: undefined, useCookie: true },
        // Variant 5: URL params + published=0 + no_story + SELF + cookie
        { url: `${endpoint}?link=${encodeURIComponent(postUrl)}&no_story=1&published=0&privacy=${ghostPrivacy}&access_token=${eaagToken}`, body: undefined, useCookie: true },
      ];

      for (const variant of variants) {
        try {
          const fetchHeaders: Record<string, string> = { ...headers };
          if (!variant.useCookie) delete fetchHeaders["cookie"];
          const res = await fetch(variant.url, {
            method: "POST",
            headers: fetchHeaders,
            body: variant.body,
          });

          const text = await res.text();
          logger.info({ endpoint, variant: variant.body ? "body" : variant.url.includes("published") ? "published0" : "urlparams", cookie: variant.useCookie, status: res.status, body: text.substring(0, 300) }, "sharePost graph response");

          let result: Record<string, unknown> = {};
          try { result = JSON.parse(text); } catch { /* not json */ }

          if (result.id) {
            return { ok: true, postId: String(result.id) };
          }
          if (result.error) {
            const err = result.error as { code?: number; message?: string };
            const msg = err.message || "Graph API error";
            logger.warn({ error: result.error, endpoint }, "Graph API share error");
            if (err.code === 190 || err.code === 102 || err.code === 2500) {
              return { ok: false, errorMsg: `Token invalid: ${msg}` };
            }
            // Don't break inner loop on other errors - try next variant
          }
        } catch (varErr) {
          logger.error({ varErr, endpoint }, "sharePostViaGraphApi variant error");
        }
      }
    } catch (err) {
      logger.error({ err, endpoint }, "sharePostViaGraphApi endpoint error");
    }
  }

  return { ok: false, errorMsg: "All graph endpoints failed" };
}

const MOBILE_SHARE_UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Mobile Safari/537.36";

// Known stable doc_ids for Facebook share/composer mutations - try all of them
const SHARE_DOC_IDS = [
  "6936722669765390",
  "7802958166448820",
  "8462087963851803",
  "6462309453838527",
  "8017700888260970",
  "7090169124374940",
  "5765985773472862",
];

async function extractShareDocId(cookie: string): Promise<string | null> {
  try {
    const res = await fetch("https://www.facebook.com/", {
      headers: { ...BROWSER_HEADERS, cookie },
      redirect: "follow",
    });
    const html = await res.text();
    const patterns = [
      /CometComposerStoryCreateMutation[^}]{0,50}"id":"(\d{10,20})"/,
      /ComposerStoryCreate[^}]{0,50}"id":"(\d{10,20})"/,
      /"share_story"[^}]{0,50}"id":"(\d{10,20})"/,
      /story_create[^}]{0,50}"id":"(\d{10,20})"/,
    ];
    for (const pat of patterns) {
      const m = html.match(pat);
      if (m) {
        logger.info({ docId: m[1], pat: pat.toString().substring(0, 60) }, "Extracted share doc_id from page");
        return m[1];
      }
    }
  } catch (err) {
    logger.error({ err }, "extractShareDocId error");
  }
  return null;
}

async function shareViaGraphQL(session: SessionData, postUrl: string, cachedDocId?: string): Promise<{ ok: boolean; errorMsg?: string }> {
  if (!session.dtsg) return { ok: false, errorMsg: "No dtsg token in session" };

  const docIdsToTry = cachedDocId ? [cachedDocId, ...SHARE_DOC_IDS] : SHARE_DOC_IDS;

  for (const docId of docIdsToTry) {
    try {
      const variables = JSON.stringify({
        input: {
          actor_id: session.userId,
          attachments: [{
            link: {
              share_scrape_data: { uri: postUrl, secret: "", is_final: false },
              message: { text: "" },
            },
          }],
          composer_entry_point: "self_m_composer",
          message: { text: "" },
          source: "WWW_TIMELINE",
          story_target_data: { profile_id: session.userId },
          // Ghost share: no_story suppresses timeline post; privacy SELF as double-lock
          no_story: true,
          should_create_story: false,
          privacy: { allow: [], base_state: "SELF", deny: [], tag_expansion_state: "UNSPECIFIED" },
          client_mutation_id: Math.random().toString(36).substring(2),
        },
        dpr: 2,
      });

      const body = new URLSearchParams({
        av: session.userId,
        __user: session.userId,
        __a: "1",
        __req: Math.random().toString(36).substring(2, 5),
        fb_dtsg: session.dtsg,
        doc_id: docId,
        variables,
        fb_api_caller_class: "RelayModern",
        fb_api_req_friendly_name: "CometComposerStoryCreateMutation",
      });

      const lsd = session.lsd || session.dtsg.substring(0, 10);
      body.set("lsd", lsd);

      const res = await fetch("https://www.facebook.com/api/graphql/", {
        method: "POST",
        headers: {
          ...BROWSER_HEADERS,
          "content-type": "application/x-www-form-urlencoded",
          "cookie": session.cookie,
          "x-fb-friendly-name": "CometComposerStoryCreateMutation",
          "x-fb-lsd": lsd,
          "referer": "https://www.facebook.com/",
          "origin": "https://www.facebook.com",
        },
        body: body.toString(),
      });

      const text = await res.text();
      logger.info({ docId, status: res.status, body: text.substring(0, 400) }, "GraphQL share response");

      if (res.status === 200) {
        let result: Record<string, unknown> = {};
        try { result = JSON.parse(text); } catch { /* might have prefix */ }

        // Also try stripping the for (;;); prefix that Facebook sometimes adds
        let cleanText = text;
        if (text.startsWith("for (;;);")) cleanText = text.slice(9);
        try { result = JSON.parse(cleanText); } catch { /* ignore */ }

        const resultStr = JSON.stringify(result);
        if (
          resultStr.includes("story_create") ||
          resultStr.includes("story_id") ||
          resultStr.includes('"id"') && !resultStr.includes('"errors"')
        ) {
          if (!resultStr.includes('"errors"') || resultStr.includes('"story_create"')) {
            logger.info({ docId }, "GraphQL share succeeded");
            return { ok: true };
          }
        }

        // If we get a specific error about the doc_id, try next
        if (resultStr.includes("Unknown document") || resultStr.includes("doc_id")) {
          logger.warn({ docId }, "doc_id not recognized, trying next");
          continue;
        }
      }
    } catch (err) {
      logger.error({ err, docId }, "GraphQL share error");
    }
  }

  return { ok: false, errorMsg: "GraphQL share: all doc_ids failed" };
}

async function shareViaMFacebook(session: SessionData, postUrl: string): Promise<{ ok: boolean; errorMsg?: string }> {
  const urlsToTry = [
    `https://m.facebook.com/sharer.php?u=${encodeURIComponent(postUrl)}`,
    `https://m.facebook.com/share/?link=${encodeURIComponent(postUrl)}`,
    `https://m.facebook.com/share/v2/?link=${encodeURIComponent(postUrl)}`,
  ];

  for (const sharePageUrl of urlsToTry) {
    try {
      const res = await fetch(sharePageUrl, {
        headers: {
          "user-agent": MOBILE_SHARE_UA,
          "accept": "text/html,application/xhtml+xml,*/*;q=0.9",
          "accept-language": "en-US,en;q=0.9",
          "cookie": session.cookie,
          "referer": "https://m.facebook.com/",
        },
        redirect: "follow",
      });

      const html = await res.text();
      logger.info({ status: res.status, htmlLen: html.length, url: sharePageUrl }, "m.facebook.com share page");

      if (res.status !== 200 || html.includes("You must log in")) continue;

      const forms = findForms(html);
      logger.info({ formCount: forms.length, actions: forms.map((f) => f.action) }, "m.facebook.com share forms");

      const shareForm = forms.find((f) =>
        f.action.includes("share") || f.action.includes("sharer") || f.action.includes("composer")
      ) || forms[0];

      if (!shareForm) {
        logger.warn({ url: sharePageUrl }, "no form on m.facebook.com share page");
        continue;
      }

      const body = new URLSearchParams();
      appendHiddenInputs(shareForm.html, body);
      if (session.dtsg && !body.has("fb_dtsg")) body.set("fb_dtsg", session.dtsg);
      // Ghost share: no_story suppresses timeline post; privacy SELF as double-lock
      body.set("no_story", "1");
      body.set("privacy", JSON.stringify({ value: "SELF" }));

      const action = shareForm.action.startsWith("http")
        ? shareForm.action
        : `https://m.facebook.com${shareForm.action.startsWith("/") ? shareForm.action : `/${shareForm.action}`}`;

      const postRes = await fetch(action, {
        method: "POST",
        headers: {
          "user-agent": MOBILE_SHARE_UA,
          "content-type": "application/x-www-form-urlencoded",
          "cookie": session.cookie,
          "referer": sharePageUrl,
          "origin": "https://m.facebook.com",
        },
        body: body.toString(),
        redirect: "follow",
      });

      const postHtml = await postRes.text();
      logger.info({ status: postRes.status, htmlLen: postHtml.length }, "m.facebook.com share POST");

      if (postRes.status >= 200 && postRes.status < 400 && !postHtml.includes("checkpoint")) {
        return { ok: true };
      }
    } catch (err) {
      logger.error({ err }, "shareViaMFacebook error");
    }
  }

  return { ok: false, errorMsg: "m.facebook.com share failed" };
}

async function shareViaComposerLink(session: SessionData, postUrl: string): Promise<{ ok: boolean; errorMsg?: string }> {
  // Uses the same mbasic composer as createPost, posts the link as a status update
  const composerPages = [
    "https://mbasic.facebook.com/",
    "https://mbasic.facebook.com/home.php",
    `https://mbasic.facebook.com/profile.php?id=${session.userId}`,
  ];

  for (const pageUrl of composerPages) {
    try {
      const composerRes = await fetch(pageUrl, {
        headers: { cookie: session.cookie, "user-agent": DESKTOP_UA, "accept-encoding": "identity" },
        redirect: "follow",
      });
      const html = await composerRes.text();
      const forms = findForms(html);
      const composerForm =
        forms.find((f) => /xc_message|composer|view_post|target/i.test(f.html)) ||
        forms.find((f) => /composer|mbasic/i.test(f.action));

      if (!composerForm) {
        logger.warn({ pageUrl }, "shareViaComposerLink no form");
        continue;
      }

      const action = composerForm.action || "/composer/mbasic/";
      const host = "https://mbasic.facebook.com";
      const submitUrl = action.startsWith("http") ? action : `${host}${action.startsWith("/") ? action : `/${action}`}`;
      const body = new URLSearchParams();
      appendHiddenInputs(composerForm.html, body);
      body.set("xc_message", postUrl);
      body.set("status", postUrl);
      body.set("message", postUrl);
      // Ghost share: no_story suppresses timeline post; privacy SELF as double-lock
      body.set("no_story", "1");
      body.set("privacy", JSON.stringify({ value: "SELF" }));

      const submitMatch = composerForm.html.match(/<input[^>]+type="submit"[^>]+name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/i);
      if (submitMatch) body.set(decodeFbText(submitMatch[1]), decodeFbText(submitMatch[2]) || "Post");
      else body.set("view_post", "Post");

      const res = await fetch(submitUrl, {
        method: "POST",
        headers: {
          cookie: session.cookie,
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": DESKTOP_UA,
          origin: host,
          referer: pageUrl,
        },
        body: body.toString(),
        redirect: "manual",
      });
      const text = await res.text().catch(() => "");
      const location = res.headers.get("location") || "";
      logger.info({ pageUrl, status: res.status, location }, "shareViaComposerLink result");

      if (res.status >= 200 && res.status < 400 && !/error|checkpoint/i.test(text.substring(0, 500))) {
        return { ok: true };
      }
    } catch (err) {
      logger.error({ err }, "shareViaComposerLink error");
    }
  }

  return { ok: false, errorMsg: "Composer link share failed" };
}

async function shareViaAjax(session: SessionData, postUrl: string): Promise<{ ok: boolean; errorMsg?: string }> {
  if (!session.dtsg) return { ok: false, errorMsg: "No dtsg in session" };

  const ajaxEndpoints = [
    "https://www.facebook.com/ajax/share/submit/",
    "https://www.facebook.com/share/feed/",
  ];

  for (const ajaxUrl of ajaxEndpoints) {
    try {
      const body = new URLSearchParams({
        __user: session.userId,
        __a: "1",
        fb_dtsg: session.dtsg,
        link: postUrl,
        share_content_type: "link",
        message: "",
        // Ghost share: no_story suppresses timeline post; privacy SELF as double-lock
        no_story: "1",
        privacy: JSON.stringify({ value: "SELF" }),
        __req: Math.random().toString(36).substring(2, 5),
        lsd: session.lsd || session.dtsg.substring(0, 10),
      });

      const res = await fetch(ajaxUrl, {
        method: "POST",
        headers: {
          ...BROWSER_HEADERS,
          "cookie": session.cookie,
          "content-type": "application/x-www-form-urlencoded",
          "x-requested-with": "XMLHttpRequest",
          "x-fb-friendly-name": "share_story",
          "x-fb-lsd": session.lsd || session.dtsg.substring(0, 10),
          "referer": "https://www.facebook.com/",
          "origin": "https://www.facebook.com",
        },
        body: body.toString(),
      });

      const text = await res.text();
      logger.info({ ajaxUrl, status: res.status, body: text.substring(0, 300) }, "shareViaAjax response");

      if (res.status >= 200 && res.status < 400) {
        const clean = text.startsWith("for (;;);") ? text.slice(9) : text;
        try {
          const json = JSON.parse(clean);
          if (json?.error || json?.errorSummary) continue;
          if (json?.payload || json?.jsmods || json?.domops) return { ok: true };
        } catch { /* not json */ }
        if (!text.includes("error") && !text.includes("checkpoint")) {
          return { ok: true };
        }
      }
    } catch (err) {
      logger.error({ err, ajaxUrl }, "shareViaAjax error");
    }
  }

  return { ok: false, errorMsg: "Ajax share failed" };
}

async function runSharePost(
  session: SessionData,
  postUrl: string,
  count: number
): Promise<{ success: number; failed: number; message: string; details: string[] }> {
  const details: string[] = [];
  let success = 0;
  let failed = 0;

  details.push(`Starting ${count} share(s) using cookie session...`);

  // Kick off both extractions in parallel so they're ready when needed
  let eaagToken = session.eaagToken;
  const eaagPromise: Promise<string | undefined> = eaagToken
    ? Promise.resolve(eaagToken)
    : extractEaagToken(session.cookie).then((t) => t ?? undefined);
  const docIdPromise = extractShareDocId(session.cookie);

  // Wait for doc_id (it loads the homepage, fast enough)
  const cachedDocId = await docIdPromise;
  if (cachedDocId) details.push(`GraphQL doc_id found: ${cachedDocId}`);
  else details.push("GraphQL doc_id not found in page — using known IDs.");

  for (let i = 1; i <= count; i++) {
    let shareResult: { ok: boolean; errorMsg?: string } = { ok: false, errorMsg: "No method succeeded" };
    let method = "";

    // Method 1: EAAG token + Graph API (primary)
    if (!eaagToken) eaagToken = await eaagPromise;
    if (eaagToken) {
      const graphResult = await sharePostViaGraphApi(eaagToken, postUrl, session.cookie);
      if (graphResult.ok) {
        shareResult = { ok: true };
        method = `GraphAPI(${graphResult.postId})`;
        // Ghost share: immediately delete the created post so it never appears on timeline
        // The share count on the original post is already incremented and stays.
        if (graphResult.postId) {
          const deleted = await deletePost(session, graphResult.postId);
          if (deleted) {
            method = `GraphAPI+Ghost(${graphResult.postId})`;
          }
        }
      } else {
        shareResult = { ok: false, errorMsg: graphResult.errorMsg };
        if (graphResult.errorMsg?.includes("Token invalid")) {
          details.push(`Share ${i}/${count}: ✗ Token invalid — stopping.`);
          failed += count - i + 1;
          break;
        }
      }
    }

    // Method 2: www.facebook.com Ajax share
    if (!shareResult.ok) {
      shareResult = await shareViaAjax(session, postUrl);
      if (shareResult.ok) method = "Ajax";
    }

    // Method 3: Facebook internal GraphQL API with dtsg
    if (!shareResult.ok) {
      shareResult = await shareViaGraphQL(session, postUrl, cachedDocId ?? undefined);
      if (shareResult.ok) method = "GraphQL";
    }

    // Method 4: m.facebook.com share page
    if (!shareResult.ok) {
      shareResult = await shareViaMFacebook(session, postUrl);
      if (shareResult.ok) method = "m.facebook";
    }

    // Method 5: mbasic composer (post link as status)
    if (!shareResult.ok) {
      shareResult = await shareViaComposerLink(session, postUrl);
      if (shareResult.ok) method = "composer";
    }

    if (shareResult.ok) {
      success++;
      details.push(`Share ${i}/${count}: ✓ Success [${method}]`);
    } else {
      failed++;
      details.push(`Share ${i}/${count}: ✗ Failed — ${shareResult.errorMsg || "all methods failed"}`);
    }

  }

  return {
    success,
    failed,
    message: `Shared ${success}/${count} successfully.`,
    details,
  };
}

router.post("/fb/share", async (req: Request, res: Response) => {
  const parsed = FbSharePostBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body" });
    return;
  }

  const { token, postUrl, count } = parsed.data;
  const session = decodeSession(token);
  if (!session) {
    res.status(400).json({ message: "Invalid session token." });
    return;
  }

  try {
    const result = await runSharePost(session, postUrl, count);
    res.json(result);
  } catch (err) {
    logger.error({ err }, "share route error");
    res.status(500).json({ message: "Failed to share post" });
  }
});

// ── Helper: extract post ID from various Facebook URL formats ─────────────────
function extractPostId(url: string): string | null {
  const patterns = [
    /(?:posts|videos|photos|reels?|story\.php\?story_fbid=)[\/?=]?(\d{10,})/,
    /pfbid([A-Za-z0-9]+)/,
    /fbid=(\d{10,})/,
    /story_fbid=(\d{10,})/,
    /\/(\d{10,})(?:\/|\?|$)/,
  ];
  for (const pat of patterns) {
    const m = url.match(pat);
    if (m) return m[1];
  }
  return null;
}

// Numeric feedback_reaction_id values for CometUFIFeedbackReactMutation
const FEEDBACK_REACTION_IDS: Record<string, number> = {
  LIKE: 1635855486666999,
  LOVE: 1678524932434102,
  HAHA: 115940658764963,
  WOW: 478547315650144,
  SAD: 908563459236466,
  ANGRY: 444813342392137,
  SUPPORT: 613557422527858,
};

// Known CometUFIFeedbackReactMutation doc_ids — primary first (discovered via bootloader endpoint)
const KNOWN_REACTION_DOC_IDS = [
  "26477330531933156", // CometUFIFeedbackReactMutation_facebookRelayOperation (current)
  "7002301193146596",
  "6512638255483773",
  "5765413673543383",
  "6213559735413102",
  "2786814014768199",
  "4575909182458892",
  "7149393385111985",
  "6618715854877030",
];

// Fetch the latest CometUFIFeedbackReactMutation doc_id via the bootloader endpoint
async function fetchReactDocIdFromBootloader(cookie: string): Promise<string | null> {
  try {
    const res = await fetch(
      "https://www.facebook.com/ajax/bootloader-endpoint/?__a=1&modules=CometUFIFeedbackReactMutation",
      {
        headers: {
          "user-agent": DESKTOP_UA,
          "accept": "*/*",
          "accept-encoding": "identity",
          "cookie": cookie,
          "referer": "https://www.facebook.com/",
        },
        signal: AbortSignal.timeout(10000),
      }
    );
    const text = await res.text();
    // Extract bundle URLs from bootloader response
    const bundleUrls = [...new Set([
      ...[...text.matchAll(/https:\/\/static\.xx\.fbcdn\.net\/rsrc\.php\/[^\s"]+\.js[^\s"]*/g)].map(m => m[0].replace(/"/g, "")),
    ])];
    logger.info({ bundleCount: bundleUrls.length }, "bootloader bundle URLs for react mutation");

    // Fetch bundles in parallel and search for the doc_id
    const results = await Promise.allSettled(
      bundleUrls.slice(0, 25).map(async (url) => {
        try {
          const r = await fetch(url, {
            headers: { "user-agent": DESKTOP_UA, "accept-encoding": "identity", "referer": "https://www.facebook.com/" },
            signal: AbortSignal.timeout(12000),
          });
          const js = await r.text();
          const m =
            js.match(/CometUFIFeedbackReactMutation_facebookRelayOperation[^;]*a\.exports="(\d{14,20})"/) ||
            js.match(/CometUFIFeedbackReactMutation_facebookRelayOperation[^\]]*\],\(function\([^)]+\)\{[a-z]\.exports="(\d{14,20})"\}/) ||
            js.match(/CometUFIFeedbackReact[A-Za-z]*Mutation_facebookRelayOperation[^;]{0,200}a\.exports="(\d{14,20})"/);
          return m?.[1] ?? null;
        } catch {
          return null;
        }
      })
    );

    for (const r of results) {
      if (r.status === "fulfilled" && r.value) {
        logger.info({ docId: r.value }, "Found CometUFIFeedbackReactMutation doc_id via bootloader");
        return r.value;
      }
    }
  } catch (err) {
    logger.warn({ err }, "fetchReactDocIdFromBootloader error");
  }
  return null;
}

// ── React to a post using a single session ────────────────────────────────────
// Fetch fresh lsd + dtsg from the post page
async function fetchReactTokensFromPage(
  postUrl: string,
  cookie: string
): Promise<{ lsd: string | null; dtsg: string | null; html: string }> {
  try {
    const res = await fetch(postUrl, {
      headers: {
        "user-agent": DESKTOP_UA,
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "accept-encoding": "identity",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "upgrade-insecure-requests": "1",
        "cookie": cookie,
      },
      redirect: "follow",
    });
    const html = await res.text();

    const lsdMatch =
      html.match(/"LSD",\[\],\{"token":"([^"]+)"\}/) ||
      html.match(/"LSD"[^,\]]*"token":"([^"]+)"/) ||
      html.match(/\["LSD"\s*,\s*\[\s*\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/) ||
      html.match(/name="lsd"\s+value="([^"]+)"/) ||
      html.match(/"lsd"\s*:\s*"([^"]{4,20})"/) ||
      html.match(/&lsd=([A-Za-z0-9_-]{4,20})&/);

    const dtsgMatch =
      html.match(/"DTSGInitialData"[^}]*?"token":"([^"]+)"/) ||
      html.match(/"DTSGInitData"[^}]*?"token":"([^"]+)"/) ||
      html.match(/name="fb_dtsg"\s+value="([^"]+)"/) ||
      html.match(/"fb_dtsg"\s*:\s*"([^"]+)"/) ||
      html.match(/"token":"([A-Za-z0-9_-]{20,})"[^}]*?"hasExpiredToken"/);

    logger.info({
      lsd: lsdMatch?.[1]?.substring(0, 8) ?? null,
      dtsg: dtsgMatch?.[1]?.substring(0, 8) ?? null,
      htmlLen: html.length,
      status: res.status,
    }, "fetchReactTokensFromPage result");

    return {
      lsd: lsdMatch?.[1] ?? null,
      dtsg: dtsgMatch?.[1] ?? null,
      html,
    };
  } catch (err) {
    logger.error({ err }, "fetchReactTokensFromPage error");
    return { lsd: null, dtsg: null, html: "" };
  }
}

// Verify whether a reaction was actually applied by checking mbasic
async function verifyReactionApplied(postId: string, cookie: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://mbasic.facebook.com/${postId}`,
      {
        headers: {
          "user-agent": MOBILE_UA,
          "cookie": cookie,
          "accept": "text/html,*/*;q=0.9",
        },
        redirect: "follow",
      }
    );
    const html = await res.text();
    // "unlike" or "remove reaction" means we already reacted
    return html.toLowerCase().includes("unlike") || html.toLowerCase().includes("remove reaction");
  } catch {
    return false;
  }
}

// ── EAAG Graph API helpers — survive browser logout ───────────────────────────
// EAAG tokens are app-level tokens that are NOT invalidated by logging out of
// a browser.  When available they are always tried first before cookie-based paths.

async function tryEaagReact(eaagToken: string, postId: string, reactionType: string): Promise<boolean> {
  const typeMap: Record<string, string> = {
    LIKE: "LIKE", LOVE: "LOVE", HAHA: "HAHA", WOW: "WOW", SAD: "SAD", ANGRY: "ANGRY",
    "1": "LIKE", "2": "LOVE", "4": "HAHA", "3": "WOW", "7": "SAD", "8": "ANGRY",
  };
  const graphType = typeMap[reactionType?.toUpperCase?.()] ?? "LIKE";

  // Try /reactions endpoint (supports all types)
  try {
    const res = await fetch(`https://graph.facebook.com/v18.0/${postId}/reactions`, {
      method: "POST",
      headers: { "user-agent": DESKTOP_UA, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ type: graphType, access_token: eaagToken }).toString(),
      signal: AbortSignal.timeout(12000),
    });
    const text = await res.text();
    logger.info({ postId, graphType, status: res.status, body: text.substring(0, 200) }, "tryEaagReact /reactions");
    if (res.status === 200) {
      try { return !!(JSON.parse(text)?.success); } catch { return true; }
    }
  } catch { /* fall through */ }

  // Fallback: /likes endpoint (LIKE only)
  if (graphType === "LIKE") {
    try {
      const res = await fetch(`https://graph.facebook.com/v18.0/${postId}/likes`, {
        method: "POST",
        headers: { "user-agent": DESKTOP_UA, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ access_token: eaagToken }).toString(),
        signal: AbortSignal.timeout(12000),
      });
      const text = await res.text();
      logger.info({ postId, status: res.status, body: text.substring(0, 200) }, "tryEaagReact /likes");
      if (res.status === 200) {
        try { return !!(JSON.parse(text)?.success ?? true); } catch { return true; }
      }
    } catch { /* ignore */ }
  }
  return false;
}

async function tryEaagComment(eaagToken: string, postId: string, commentText: string): Promise<boolean> {
  try {
    const res = await fetch(`https://graph.facebook.com/v18.0/${postId}/comments`, {
      method: "POST",
      headers: { "user-agent": DESKTOP_UA, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ message: commentText, access_token: eaagToken }).toString(),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    logger.info({ postId, status: res.status, body: text.substring(0, 300) }, "tryEaagComment response");
    if (res.status === 200) {
      try {
        const json = JSON.parse(text);
        return !!(json?.id);
      } catch { return true; }
    }
  } catch { /* ignore */ }
  return false;
}

async function tryEaagFollow(eaagToken: string, targetId: string): Promise<boolean> {
  // Attempt 1: friend request via /me/friends/{userId}
  try {
    const res = await fetch(`https://graph.facebook.com/v18.0/me/friends/${targetId}`, {
      method: "POST",
      headers: { "user-agent": DESKTOP_UA, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ access_token: eaagToken }).toString(),
      signal: AbortSignal.timeout(12000),
    });
    const text = await res.text();
    logger.info({ targetId, status: res.status, body: text.substring(0, 200) }, "tryEaagFollow /me/friends");
    if (res.status === 200) return true;
  } catch { /* ignore */ }

  // Attempt 2: page like/follow
  try {
    const res = await fetch(`https://graph.facebook.com/v18.0/${targetId}/likes`, {
      method: "POST",
      headers: { "user-agent": DESKTOP_UA, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ access_token: eaagToken }).toString(),
      signal: AbortSignal.timeout(12000),
    });
    const text = await res.text();
    logger.info({ targetId, status: res.status, body: text.substring(0, 200) }, "tryEaagFollow /likes");
    if (res.status === 200) return true;
  } catch { /* ignore */ }

  return false;
}

async function reactWithSession(
  session: SessionData,
  postUrl: string,
  reactionType: string
): Promise<{ ok: boolean; errorMsg?: string; isLoggedOut?: boolean }> {
  if (!session.cookie && !session.eaagToken) return { ok: false, errorMsg: "No cookie or token" };

  const postId = extractPostId(postUrl);
  if (!postId) return { ok: false, errorMsg: `Could not extract post ID from URL: ${postUrl}` };

  let notLoggedInHits = 0;

  // ── EAAG path (survives browser logout) ───────────────────────────────────
  if (session.eaagToken) {
    const ok = await tryEaagReact(session.eaagToken, postId, reactionType);
    if (ok) {
      logger.info({ postId, userId: session.userId }, "reactWithSession EAAG success");
      return { ok: true };
    }
    logger.warn({ postId, userId: session.userId }, "reactWithSession EAAG failed, falling back to cookie path");
  }

  if (!session.cookie) return { ok: false, errorMsg: "No cookie or EAAG token — cannot react" };

  // Fetch tokens from page + bootloader doc_id concurrently
  const [pageTokens, bootloaderDocId] = await Promise.all([
    fetchReactTokensFromPage(postUrl, session.cookie),
    fetchReactDocIdFromBootloader(session.cookie),
  ]);

  const { lsd: freshLsd, dtsg: freshDtsg, html: pageHtml } = pageTokens;
  const lsd = freshLsd || session.lsd || "";
  const dtsg = freshDtsg || session.dtsg || "";

  logger.info({ postId, reactionType, lsd: lsd.substring(0, 8), dtsg: dtsg.substring(0, 8), bootloaderDocId }, "react tokens fetched");

  // Check if we're already reacted (page shows "Unlike")
  if (pageHtml.toLowerCase().includes("unlike") || pageHtml.toLowerCase().includes("remove reaction")) {
    logger.info({ postId }, "react: already reacted per page HTML");
    return { ok: true };
  }

  // ── Method 1: GraphQL CometUFIFeedbackReactMutation (correct current mutation) ─
  if (lsd && dtsg) {
    try {
      const feedbackId = Buffer.from(`feedback:${postId}`).toString("base64");
      const feedbackReactionId = FEEDBACK_REACTION_IDS[reactionType] ?? FEEDBACK_REACTION_IDS.LIKE;

      // Prioritize bootloader-discovered doc_id, then our known list
      const docIdsToTry = bootloaderDocId
        ? [bootloaderDocId, ...KNOWN_REACTION_DOC_IDS.filter(d => d !== bootloaderDocId)]
        : KNOWN_REACTION_DOC_IDS;

      for (const docId of docIdsToTry) {
        try {
          const variables = JSON.stringify({
            input: {
              feedback_id: feedbackId,
              feedback_reaction_id: feedbackReactionId,
              feedback_source: 107,
              is_tracking_encrypted: true,
              tracking: [],
              actor_id: session.userId,
              client_mutation_id: randomBytes(4).toString("hex"),
            },
            feedbackSource: 107,
            scale: 1,
            useDefaultActor: false,
            reactorActorID: session.userId,
          });

          const bodyParams: Record<string, string> = {
            av: session.userId,
            __user: session.userId,
            __a: "1",
            __req: Math.random().toString(36).substring(2, 6),
            fb_dtsg: dtsg,
            lsd,
            doc_id: docId,
            variables,
            fb_api_caller_class: "RelayModern",
            fb_api_req_friendly_name: "CometUFIFeedbackReactMutation",
            server_timestamps: "true",
          };

          const body = new URLSearchParams(bodyParams);

          const res = await fetch("https://www.facebook.com/api/graphql/", {
            method: "POST",
            headers: {
              "user-agent": DESKTOP_UA,
              "accept": "*/*",
              "accept-language": "en-US,en;q=0.9",
              "accept-encoding": "identity",
              "content-type": "application/x-www-form-urlencoded",
              "x-fb-friendly-name": "CometUFIFeedbackReactMutation",
              "x-fb-lsd": lsd,
              "sec-fetch-dest": "empty",
              "sec-fetch-mode": "cors",
              "sec-fetch-site": "same-origin",
              "cookie": session.cookie,
              "referer": postUrl,
              "origin": "https://www.facebook.com",
            },
            body: body.toString(),
          });

          const text = await res.text();
          logger.info({ docId, status: res.status, body: text.substring(0, 400) }, "react GraphQL CometUFIFeedbackReactMutation response");

          if (res.status === 200) {
            const clean = text.startsWith("for (;;);") ? text.slice(9) : text;
            try {
              const json = JSON.parse(clean);
              // Success: data present and no errors
              if (json?.data && !json?.errors && !json?.error) {
                logger.info({ postId, docId }, "react method 1 success (graphql data)");
                return { ok: true };
              }
              if (json?.data?.story_act_on_feedback || json?.data?.feedback_react || json?.data?.reactWithFeedback) {
                logger.info({ postId, docId }, "react method 1 success (mutation data)");
                return { ok: true };
              }
              // Error 1357001 = not logged in — cookie is dead
              if (json?.error === 1357001) {
                notLoggedInHits++;
                logger.warn({ docId, error: json.error }, "react method 1 not logged in (cookie dead)");
                break;
              }
              // Error 1357004 = valid doc_id but auth/param issue — stop loop
              if (json?.error === 1357004) {
                logger.warn({ docId, error: json.error }, "react method 1 auth/param error, stopping doc_id loop");
                break;
              }
              // Unknown doc_id (1675002) — try next
              if (json?.error === 1675002) {
                logger.warn({ docId }, "react method 1 unknown doc_id, trying next");
                continue;
              }
              logger.warn({ docId, error: json?.error, data: JSON.stringify(json).substring(0, 200) }, "react method 1 non-success");
            } catch {
              if (text.includes('"data"') && !text.includes('"errors"') && !text.includes('"error"')) {
                logger.info({ postId, docId }, "react method 1 success (text check)");
                return { ok: true };
              }
            }
          }
        } catch (innerErr) {
          logger.warn({ docId, err: innerErr }, "react method 1 inner error");
        }
      }
    } catch (err) {
      logger.error({ err }, "react graphql method 1 error");
    }
  }

  // ── Method 3: mbasic reaction via like.php (LIKE only on mbasic) ──────────
  try {
    const mbasicUA = "Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36";
    const likePageUrl = `https://mbasic.facebook.com/a/like.php?ft_ent_identifier=${postId}&refsrc=deprecated&refid=10`;

    const getRes = await fetch(likePageUrl, {
      method: "GET",
      headers: {
        "user-agent": mbasicUA,
        "cookie": session.cookie,
        "accept": "text/html,*/*;q=0.9",
        "accept-language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
    const getHtml = await getRes.text();
    logger.info({ postId, htmlLen: getHtml.length, hasUnlike: getHtml.toLowerCase().includes("unlike") }, "react mbasic GET like page");

    // Already reacted
    if (getHtml.toLowerCase().includes("unlike")) {
      logger.info({ postId }, "react mbasic: already liked");
      return { ok: true };
    }

    // Extract confirmation form
    const formActionMatch =
      getHtml.match(/action="([^"]*like\.php[^"]*)"/) ||
      getHtml.match(/action="([^"]+)"[^>]*method="post"/i);

    if (formActionMatch) {
      let confirmUrl = formActionMatch[1].replace(/&amp;/g, "&");
      if (!confirmUrl.startsWith("http")) {
        confirmUrl = "https://mbasic.facebook.com" + confirmUrl;
      }
      const postBody = new URLSearchParams();
      const inputMatches = getHtml.matchAll(/<input[^>]+name="([^"]+)"[^>]+value="([^"]*)"/g);
      for (const m of inputMatches) {
        postBody.set(m[1], m[2]);
      }
      // Also match value before name
      const inputMatches2 = getHtml.matchAll(/<input[^>]+value="([^"]*)"[^>]+name="([^"]+)"/g);
      for (const m of inputMatches2) {
        if (!postBody.has(m[2])) postBody.set(m[2], m[1]);
      }

      const postRes = await fetch(confirmUrl, {
        method: "POST",
        headers: {
          "user-agent": mbasicUA,
          "cookie": session.cookie,
          "content-type": "application/x-www-form-urlencoded",
          "referer": likePageUrl,
          "accept": "text/html,*/*;q=0.9",
        },
        body: postBody.toString(),
        redirect: "follow",
      });
      const postHtml = await postRes.text();
      const confirmed = postHtml.toLowerCase().includes("unlike") || postHtml.toLowerCase().includes("remove reaction");
      logger.info({ status: postRes.status, htmlLen: postHtml.length, confirmed }, "react mbasic POST response");

      // ONLY return ok if we actually see "unlike" confirming the reaction was applied
      if (confirmed) {
        return { ok: true };
      }
    }

    // Fallback: try mbasic post page direct URL for reaction
    const mbasicPostRes = await fetch(
      `https://mbasic.facebook.com/${postId}`,
      {
        headers: { "user-agent": mbasicUA, "cookie": session.cookie, "accept": "text/html,*/*;q=0.9" },
        redirect: "follow",
      }
    );
    const mbasicPostHtml = await mbasicPostRes.text();
    // Check if already reacted
    if (mbasicPostHtml.toLowerCase().includes("unlike") || mbasicPostHtml.toLowerCase().includes("remove reaction")) {
      return { ok: true };
    }

    // Try the direct like URL in mbasic (GET-based like, works for some posts)
    const directLikeRes = await fetch(
      `https://mbasic.facebook.com/a/like.php?ft_ent_identifier=${postId}&refsrc=deprecated`,
      {
        headers: { "user-agent": mbasicUA, "cookie": session.cookie, "accept": "text/html,*/*;q=0.9" },
        redirect: "follow",
      }
    );
    const directLikeHtml = await directLikeRes.text();
    if (directLikeHtml.toLowerCase().includes("unlike")) {
      return { ok: true };
    }
  } catch (err) {
    logger.error({ err }, "react mbasic method 3 error");
  }

  // ── Final verification: check mbasic post page for reaction status ─────────
  try {
    const verified = await verifyReactionApplied(postId, session.cookie);
    if (verified) {
      logger.info({ postId }, "react verified via mbasic post page check");
      return { ok: true };
    }
  } catch (err) {
    logger.error({ err }, "react verify error");
  }

  if (notLoggedInHits > 0) {
    return { ok: false, errorMsg: "Session logged out — cookie invalidated by Facebook", isLoggedOut: true };
  }
  return { ok: false, errorMsg: "All reaction methods failed — cookie may be expired or post is restricted" };
}

// ── /fb/react ─────────────────────────────────────────────────────────────────
router.post("/fb/react", async (req: Request, res: Response) => {
  const parsed = FbReactBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body" });
    return;
  }

  const { postUrl, reactionType } = parsed.data;

  let sessions: Array<{ userId: string; name: string; cookie: string; dtsg: string | null; eaagToken: string | null; sessionToken: string; isActive: boolean }>;
  try {
    sessions = await db.select().from(savedSessionsTable).where(eq(savedSessionsTable.isActive, true));
  } catch (err) {
    logger.error({ err }, "Failed to fetch sessions from database");
    res.status(500).json({ message: "Database error fetching sessions" });
    return;
  }

  if (sessions.length === 0) {
    res.json({ success: 0, failed: 0, total: 0, message: "No active saved sessions in database. Login with cookies first.", details: [] });
    return;
  }

  const details: string[] = [];
  let success = 0;
  let failed = 0;

  details.push(`Reacting to post with ${sessions.length} active account(s)...`);

  for (const saved of sessions) {
    const session: SessionData = decodeSession(saved.sessionToken) ?? {
      cookie: saved.cookie,
      dtsg: saved.dtsg ?? "",
      userId: saved.userId,
      name: saved.name,
      isCookieSession: true,
    };
    // Always use freshest cookie/dtsg from DB — it gets refreshed by keep-alive even after browser logout
    session.cookie = saved.cookie;
    if (saved.dtsg) session.dtsg = saved.dtsg;
    if (saved.eaagToken && !session.eaagToken) session.eaagToken = saved.eaagToken;

    const result = await reactWithSession(session, postUrl, reactionType);
    if (result.ok) {
      success++;
      details.push(`✓ ${saved.name} (${saved.userId}): reacted with ${reactionType}`);
    } else {
      failed++;
      if (result.isLoggedOut) {
        details.push(`✗ ${saved.name} (${saved.userId}): logged out — cookie killed by Facebook (session removed)`);
        db.update(savedSessionsTable)
          .set({ isActive: false, updatedAt: new Date() })
          .where(eq(savedSessionsTable.userId, saved.userId))
          .catch(e => logger.error({ e, userId: saved.userId }, "auto-deactivate react error"));
      } else {
        details.push(`✗ ${saved.name} (${saved.userId}): ${result.errorMsg ?? "failed"}`);
      }
    }
  }

  res.json({
    success,
    failed,
    total: sessions.length,
    message: `${success}/${sessions.length} reactions added successfully.`,
    details,
  });
});

// ── Extract tokens from mbasic page HTML ──────────────────────────────────────
function extractMbasicTokens(html: string): { fb_dtsg: string; jazoest: string; lsd: string } {
  const fb_dtsg =
    html.match(/name="fb_dtsg"\s+value="([^"]+)"/)?.[1] ||
    html.match(/value="([^"]+)"\s+name="fb_dtsg"/)?.[1] ||
    html.match(/"fb_dtsg"\s*,\s*"([^"]+)"/)?.[1] ||
    html.match(/DTSGInitialData[^}]*?"token":"([^"]+)"/)?.[1] ||
    "";
  const jazoest =
    html.match(/name="jazoest"\s+value="([^"]+)"/)?.[1] ||
    html.match(/value="([^"]+)"\s+name="jazoest"/)?.[1] ||
    "";
  const lsd =
    html.match(/name="lsd"\s+value="([^"]+)"/)?.[1] ||
    html.match(/value="([^"]+)"\s+name="lsd"/)?.[1] ||
    html.match(/"LSD",\[\],\{"token":"([^"]+)"\}/)?.[1] ||
    "";
  return { fb_dtsg, jazoest, lsd };
}

// Compute jazoest from fb_dtsg token (Facebook CSRF helper)
function jazoest_from_dtsg(dtsg: string): string {
  const sum = [...dtsg].reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return "2" + sum.toString();
}

// Known comment mutation doc_ids (most recent first)
const KNOWN_COMMENT_DOC_IDS = [
  "25720979764242405", // useCometUFICreateCommentMutation (live as of Apr 2026)
  "7007782252586285",
  "4888085561303199",
  "5706748226048990",
  "6316295545070005",
  "7542178125856293",
  "3778006575753152",
];

// Dynamically scan page JS bundles for the current comment mutation doc_id
async function fetchCommentDocIdFromPageBundles(postUrl: string, cookie: string): Promise<string | null> {
  try {
    const res = await fetch(postUrl, {
      headers: {
        "user-agent": DESKTOP_UA,
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "accept-encoding": "identity",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "cookie": cookie,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    const html = await res.text();

    const bundleUrls = [...new Set([
      ...[...html.matchAll(/https:\/\/static\.xx\.fbcdn\.net\/rsrc\.php\/[^"]+\.js[^"]*/g)].map(m => m[0]),
    ])];

    const results = await Promise.allSettled(
      bundleUrls.slice(0, 20).map(async (url) => {
        try {
          const r = await fetch(url, {
            headers: { "user-agent": DESKTOP_UA, "accept-encoding": "identity", "referer": "https://www.facebook.com/" },
            signal: AbortSignal.timeout(12000),
          });
          const js = await r.text();
          const m =
            js.match(/useCometUFICreateCommentMutation_facebookRelayOperation[^;]*[a-z]\.exports="(\d{13,20})"/) ||
            js.match(/__d\("useCometUFICreateComment[^"]*_facebookRelayOperation[^;]+[a-z]\.exports="(\d{13,20})"/);
          return m?.[1] ?? null;
        } catch {
          return null;
        }
      })
    );

    for (const r of results) {
      if (r.status === "fulfilled" && r.value) {
        logger.info({ docId: r.value }, "Found comment mutation doc_id from page bundles");
        return r.value;
      }
    }
  } catch (err) {
    logger.warn({ err }, "fetchCommentDocIdFromPageBundles error");
  }
  return null;
}

// Dynamically scan profile page JS bundles for friend/follow mutation doc_ids
async function fetchFollowDocIdFromProfileBundles(profileUrl: string, cookie: string): Promise<string | null> {
  try {
    const res = await fetch(profileUrl, {
      headers: {
        "user-agent": DESKTOP_UA,
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "accept-encoding": "identity",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "cookie": cookie,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    const html = await res.text();

    const bundleUrls = [...new Set([
      ...[...html.matchAll(/https:\/\/static\.xx\.fbcdn\.net\/rsrc\.php\/[^"]+\.js[^"]*/g)].map(m => m[0]),
    ])];

    const results = await Promise.allSettled(
      bundleUrls.slice(0, 20).map(async (url) => {
        try {
          const r = await fetch(url, {
            headers: { "user-agent": DESKTOP_UA, "accept-encoding": "identity", "referer": "https://www.facebook.com/" },
            signal: AbortSignal.timeout(12000),
          });
          const js = await r.text();
          const m =
            js.match(/(?:FriendRequest|AddFriend|FollowProfile|SubscribeTo|ProfileFollow)[A-Za-z_]*_facebookRelayOperation[^;]*[a-z]\.exports="(\d{13,20})"/) ||
            js.match(/__d\("(?:FriendRequest|AddFriend|FollowProfile)[^"]*_facebookRelayOperation[^;]+[a-z]\.exports="(\d{13,20})"/);
          return m?.[1] ?? null;
        } catch {
          return null;
        }
      })
    );

    for (const r of results) {
      if (r.status === "fulfilled" && r.value) {
        logger.info({ docId: r.value }, "Found follow mutation doc_id from profile bundles");
        return r.value;
      }
    }
  } catch (err) {
    logger.warn({ err }, "fetchFollowDocIdFromProfileBundles error");
  }
  return null;
}

// ── Comment on a post using a single session ──────────────────────────────────
async function commentWithSession(
  session: SessionData,
  postUrl: string,
  commentText: string
): Promise<{ ok: boolean; errorMsg?: string; isLoggedOut?: boolean }> {
  if (!session.cookie && !session.eaagToken) return { ok: false, errorMsg: "No cookie or token" };

  const postId = extractPostId(postUrl);
  if (!postId) return { ok: false, errorMsg: `Could not extract post ID from URL: ${postUrl}` };

  let notLoggedInHits = 0;

  // ── EAAG path (survives browser logout) ───────────────────────────────────
  if (session.eaagToken) {
    const ok = await tryEaagComment(session.eaagToken, postId, commentText);
    if (ok) {
      logger.info({ postId, userId: session.userId }, "commentWithSession EAAG success");
      return { ok: true };
    }
    logger.warn({ postId, userId: session.userId }, "commentWithSession EAAG failed, falling back to cookie path");
  }

  if (!session.cookie) return { ok: false, errorMsg: "No cookie or EAAG token — cannot comment" };

  // ── Fetch fresh tokens from the post page (desktop) ───────────────────────
  let lsd = "";
  let dtsg = "";
  try {
    const pageTokens = await fetchReactTokensFromPage(postUrl, session.cookie);
    lsd = pageTokens.lsd || session.lsd || "";
    dtsg = pageTokens.dtsg || session.dtsg || "";
    logger.info({ lsdLen: lsd.length, dtsgLen: dtsg.length }, "commentWithSession tokens fetched");
  } catch (err) {
    logger.warn({ err }, "commentWithSession token fetch failed, using session tokens");
    lsd = session.lsd || "";
    dtsg = session.dtsg || "";
  }

  if (!dtsg || !lsd) {
    return { ok: false, errorMsg: "Could not obtain auth tokens from post page (cookie may be expired)" };
  }

  // ── Build candidate doc_id list (dynamic first, then known) ──────────────
  let docIdList = [...KNOWN_COMMENT_DOC_IDS];
  try {
    const dynamicId = await fetchCommentDocIdFromPageBundles(postUrl, session.cookie);
    if (dynamicId && !docIdList.includes(dynamicId)) {
      docIdList = [dynamicId, ...docIdList];
    }
  } catch {
    // ignore, fall through to known list
  }

  const feedbackId = Buffer.from(`feedback:${postId}`).toString("base64");

  // ── Try each doc_id via GraphQL CometUFIFeedbackCreateCommentMutation ─────
  for (const docId of docIdList) {
    try {
      const variables = JSON.stringify({
        input: {
          feedback_id: feedbackId,
          message: { text: commentText },
          feedback_source: 107,
          actor_id: session.userId,
          client_mutation_id: randomBytes(4).toString("hex"),
          attachments: [],
          is_aggregated_groups: false,
        },
        feedbackSource: 107,
        scale: 1,
        useDefaultActor: false,
        __relay_internal__pv__groups_comet_use_glvrelayprovider: false,
        __relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider: false,
        __relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider: false,
        __relay_internal__pv__IsWorkUserrelayprovider: false,
        __relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider: "NONE",
      });

      const body = new URLSearchParams({
        av: session.userId,
        __user: session.userId,
        __a: "1",
        __req: Math.random().toString(36).substring(2, 6),
        __hs: "19989.HYP:comet_pkg.2.1...0",
        dpr: "1",
        __ccg: "EXCELLENT",
        __rev: "1018980870",
        __s: randomBytes(3).toString("hex"),
        __hsi: Date.now().toString(),
        __dyn: "7AzHK8C4wDAwLyK4VwlE-HU98nwgU29zEdF8aUco38gpEuxO0n24oaEd82lVDwezXwJxibwxwEwgofoy8815y1DwUx60GE3Qwb-q7oc8",
        __csr: "",
        fb_dtsg: dtsg,
        jazoest: jazoest_from_dtsg(dtsg),
        lsd,
        doc_id: docId,
        variables,
        fb_api_caller_class: "RelayModern",
        fb_api_req_friendly_name: "useCometUFICreateCommentMutation",
        server_timestamps: "true",
      });

      const res = await fetch("https://www.facebook.com/api/graphql/", {
        method: "POST",
        headers: {
          "user-agent": DESKTOP_UA,
          "accept": "*/*",
          "accept-language": "en-US,en;q=0.9",
          "accept-encoding": "identity",
          "content-type": "application/x-www-form-urlencoded",
          "x-fb-friendly-name": "useCometUFICreateCommentMutation",
          "x-fb-lsd": lsd,
          "sec-ch-ua": '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"Windows"',
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
          "cookie": session.cookie,
          "referer": postUrl,
          "origin": "https://www.facebook.com",
        },
        body: body.toString(),
        signal: AbortSignal.timeout(20000),
      });

      const text = await res.text();
      logger.info({ docId, status: res.status, body: text.substring(0, 500) }, "commentWithSession GraphQL response");

      if (res.status === 200) {
        const clean = text.startsWith("for (;;);") ? text.slice(9) : text;
        try {
          const json = JSON.parse(clean);
          const errCode = json?.error ?? json?.errors?.[0]?.extensions?.code;
          if (errCode === 1357001) {
            notLoggedInHits++;
            logger.warn({ docId, errCode }, "commentWithSession not logged in (cookie dead)");
            break;
          }
          if (errCode === 1357055 || errCode === 1675002) {
            logger.warn({ docId, errCode }, "commentWithSession unknown doc_id, trying next");
            continue;
          }
          if (json?.data && !json?.errors) {
            logger.info({ postId, docId }, "commentWithSession GraphQL success");
            return { ok: true };
          }
          if (errCode) {
            logger.warn({ docId, errCode, json }, "commentWithSession GraphQL error code");
          }
        } catch {
          if (text.includes('"data"') && !text.includes('"errors"') && !text.includes('"error"')) {
            return { ok: true };
          }
        }
      }
    } catch (innerErr) {
      logger.warn({ docId, err: innerErr }, "commentWithSession inner error");
    }
  }

  if (notLoggedInHits > 0) {
    return { ok: false, errorMsg: "Session logged out — cookie invalidated by Facebook", isLoggedOut: true };
  }
  return { ok: false, errorMsg: "All comment doc_ids failed — cookie may be expired, post is restricted, or doc_ids need refresh" };
}

// ── /fb/comment ───────────────────────────────────────────────────────────────
router.post("/fb/comment", async (req: Request, res: Response) => {
  const parsed = FbCommentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body" });
    return;
  }

  const { postUrl, commentText } = parsed.data;

  let sessions: Array<{ userId: string; name: string; cookie: string; dtsg: string | null; eaagToken: string | null; sessionToken: string; isActive: boolean }>;
  try {
    sessions = await db.select().from(savedSessionsTable).where(eq(savedSessionsTable.isActive, true));
  } catch (err) {
    logger.error({ err }, "Failed to fetch sessions from database");
    res.status(500).json({ message: "Database error fetching sessions" });
    return;
  }

  if (sessions.length === 0) {
    res.json({ success: 0, failed: 0, total: 0, message: "No active saved sessions in database. Login with cookies first.", details: [] });
    return;
  }

  const details: string[] = [];
  let success = 0;
  let failed = 0;

  details.push(`Commenting on post with ${sessions.length} active account(s)...`);

  for (const saved of sessions) {
    const session: SessionData = decodeSession(saved.sessionToken) ?? {
      cookie: saved.cookie,
      dtsg: saved.dtsg ?? "",
      userId: saved.userId,
      name: saved.name,
      isCookieSession: true,
    };
    // Always use freshest cookie/dtsg from DB (kept alive by background job)
    session.cookie = saved.cookie;
    if (saved.dtsg) session.dtsg = saved.dtsg;
    if (saved.eaagToken && !session.eaagToken) session.eaagToken = saved.eaagToken;

    const result = await commentWithSession(session, postUrl, commentText);
    if (result.ok) {
      success++;
      details.push(`✓ ${saved.name} (${saved.userId}): commented successfully`);
    } else {
      failed++;
      if (result.isLoggedOut) {
        details.push(`✗ ${saved.name} (${saved.userId}): logged out — cookie killed by Facebook (session removed)`);
        db.update(savedSessionsTable)
          .set({ isActive: false, updatedAt: new Date() })
          .where(eq(savedSessionsTable.userId, saved.userId))
          .catch(e => logger.error({ e, userId: saved.userId }, "auto-deactivate comment error"));
      } else {
        details.push(`✗ ${saved.name} (${saved.userId}): ${result.errorMsg ?? "failed"}`);
      }
    }
  }

  res.json({
    success,
    failed,
    total: sessions.length,
    message: `${success}/${sessions.length} comments posted successfully.`,
    details,
  });
});

// ── Follow/Add-Friend with a single session ───────────────────────────────────
// Known friend-request / page-follow doc_ids (most recent first) ─────────────
const KNOWN_FRIEND_DOC_IDS = [
  "7216888908422443", // FriendRequestSend (2025/2026)
  "4655858601113124",
  "3742660159109344",
  "6443583062390187",
  "4028145467310439",
  "3553931584621167",
];
const KNOWN_PAGE_FOLLOW_DOC_IDS = [
  "7346182012091533", // PageFollow (2025/2026)
  "4028145467310439",
  "3553931584621167",
  "2793640984066373",
];

async function followUserWithSession(
  session: SessionData,
  target: string
): Promise<{ ok: boolean; errorMsg?: string }> {
  if (!session.cookie && !session.eaagToken) return { ok: false, errorMsg: "No cookie or token" };

  // ── Resolve target to numeric ID or vanity slug ───────────────────────────
  let targetId = target.trim();
  const urlMatch = target.match(/facebook\.com\/(?:profile\.php\?id=)?(\d+)/);
  if (urlMatch) targetId = urlMatch[1];
  else {
    const vanityMatch = target.match(/facebook\.com\/([A-Za-z0-9.\-_]+)/);
    if (vanityMatch && vanityMatch[1] !== "profile.php") targetId = vanityMatch[1];
  }

  const isNumeric = /^\d+$/.test(targetId);
  const targetProfileUrl = isNumeric
    ? `https://www.facebook.com/profile.php?id=${targetId}`
    : `https://www.facebook.com/${targetId}`;

  // ── EAAG path (survives browser logout) ───────────────────────────────────
  if (session.eaagToken) {
    const ok = await tryEaagFollow(session.eaagToken, isNumeric ? targetId : targetId);
    if (ok) {
      logger.info({ targetId, userId: session.userId }, "followUserWithSession EAAG success");
      return { ok: true };
    }
    logger.warn({ targetId, userId: session.userId }, "followUserWithSession EAAG failed, falling back to cookie path");
  }

  if (!session.cookie) return { ok: false, errorMsg: "No cookie or EAAG token — cannot follow" };

  // ── Fetch fresh tokens from the profile page (desktop) ────────────────────
  let lsd = "";
  let dtsg = "";
  try {
    const pageTokens = await fetchReactTokensFromPage(targetProfileUrl, session.cookie);
    lsd = pageTokens.lsd || session.lsd || "";
    dtsg = pageTokens.dtsg || session.dtsg || "";
    logger.info({ lsdLen: lsd.length, dtsgLen: dtsg.length }, "followUser tokens fetched");
  } catch (err) {
    logger.warn({ err }, "followUser token fetch failed, using session tokens");
    lsd = session.lsd || "";
    dtsg = session.dtsg || "";
  }

  if (!dtsg || !lsd) {
    return { ok: false, errorMsg: "Could not obtain auth tokens from profile page (cookie may be expired)" };
  }

  // ── Scan profile page bundles for current friend/follow doc_ids ───────────
  let friendDocIds = [...KNOWN_FRIEND_DOC_IDS];
  let pageFollowDocIds = [...KNOWN_PAGE_FOLLOW_DOC_IDS];
  try {
    const dynamicId = await fetchFollowDocIdFromProfileBundles(targetProfileUrl, session.cookie);
    if (dynamicId) {
      if (!friendDocIds.includes(dynamicId)) friendDocIds = [dynamicId, ...friendDocIds];
      if (!pageFollowDocIds.includes(dynamicId)) pageFollowDocIds = [dynamicId, ...pageFollowDocIds];
    }
  } catch {
    // ignore
  }

  const makeHeaders = (friendlyName: string) => ({
    "user-agent": DESKTOP_UA,
    "accept": "*/*",
    "accept-language": "en-US,en;q=0.9",
    "accept-encoding": "identity",
    "content-type": "application/x-www-form-urlencoded",
    "x-fb-friendly-name": friendlyName,
    "x-fb-lsd": lsd,
    "sec-ch-ua": '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "cookie": session.cookie,
    "referer": targetProfileUrl,
    "origin": "https://www.facebook.com",
  });

  const makeBaseBody = (docId: string, variables: object, friendlyName: string) => new URLSearchParams({
    av: session.userId,
    __user: session.userId,
    __a: "1",
    __req: Math.random().toString(36).substring(2, 6),
    __hs: "19989.HYP:comet_pkg.2.1...0",
    dpr: "1",
    __ccg: "EXCELLENT",
    __rev: "1018980870",
    __s: randomBytes(3).toString("hex"),
    __hsi: Date.now().toString(),
    fb_dtsg: dtsg,
    jazoest: jazoest_from_dtsg(dtsg),
    lsd,
    doc_id: docId,
    variables: JSON.stringify(variables),
    fb_api_caller_class: "RelayModern",
    fb_api_req_friendly_name: friendlyName,
    server_timestamps: "true",
  });

  const tryGql = async (docId: string, variables: object, friendlyName: string): Promise<boolean> => {
    try {
      const res = await fetch("https://www.facebook.com/api/graphql/", {
        method: "POST",
        headers: makeHeaders(friendlyName),
        body: makeBaseBody(docId, variables, friendlyName).toString(),
        signal: AbortSignal.timeout(18000),
      });
      const text = await res.text();
      logger.info({ docId, status: res.status, body: text.substring(0, 400) }, "followUser GraphQL response");
      if (res.status !== 200) return false;
      const clean = text.startsWith("for (;;);") ? text.slice(9) : text;
      try {
        const json = JSON.parse(clean);
        const errCode = json?.error ?? json?.errors?.[0]?.extensions?.code;
        if (errCode === 1357055 || errCode === 1675002) return false; // unknown doc_id
        if (json?.data && !json?.errors) return true;
      } catch {
        if (text.includes('"data"') && !text.includes('"errors"') && !text.includes('"error"')) return true;
      }
    } catch { /* timeout/network */ }
    return false;
  };

  // ── Attempt 1: FriendRequestSend (personal profile) ──────────────────────
  for (const docId of friendDocIds) {
    const ok = await tryGql(docId, {
      input: {
        recipient_id: isNumeric ? targetId : undefined,
        actor_id: session.userId,
        client_mutation_id: randomBytes(4).toString("hex"),
      },
    }, "FriendRequestSend");
    if (ok) {
      logger.info({ targetId, docId }, "followUser FriendRequestSend success");
      return { ok: true };
    }
  }

  // ── Attempt 2: PageFollow / SubscribeTo (public figures and pages) ────────
  for (const docId of pageFollowDocIds) {
    const ok = await tryGql(docId, {
      input: {
        subscribee_id: targetId,
        actor_id: session.userId,
        client_mutation_id: randomBytes(4).toString("hex"),
      },
    }, "CometProfileCometFollowMutation");
    if (ok) {
      logger.info({ targetId, docId }, "followUser CometProfileCometFollowMutation success");
      return { ok: true };
    }
  }

  // ── Attempt 3: PageFollow with page_id field ──────────────────────────────
  for (const docId of pageFollowDocIds) {
    const ok = await tryGql(docId, {
      input: {
        page_id: targetId,
        actor_id: session.userId,
        client_mutation_id: randomBytes(4).toString("hex"),
      },
    }, "PageFollowMutation");
    if (ok) {
      logger.info({ targetId, docId }, "followUser PageFollowMutation success");
      return { ok: true };
    }
  }

  return { ok: false, errorMsg: "Follow/add failed — all doc_ids tried; profile may be private, cookie expired, or target is already a friend" };
}

// ── /fb/follow ─────────────────────────────────────────────────────────────────
router.post("/fb/follow", async (req: Request, res: Response) => {
  const target: string = req.body?.target;
  if (!target) { res.status(400).json({ message: "target (user ID or profile URL) is required" }); return; }

  let sessions: Array<{ userId: string; name: string; cookie: string; dtsg: string | null; eaagToken: string | null; sessionToken: string; isActive: boolean }>;
  try {
    sessions = await db.select().from(savedSessionsTable).where(eq(savedSessionsTable.isActive, true));
  } catch (err) {
    logger.error({ err }, "follow: db error");
    res.status(500).json({ message: "Database error" });
    return;
  }

  if (sessions.length === 0) {
    res.json({ success: 0, failed: 0, total: 0, message: "No active saved sessions. Login with cookies first.", details: [] });
    return;
  }

  const details: string[] = [];
  let success = 0, failed = 0;

  details.push(`Following ${target} with ${sessions.length} active account(s)...`);

  for (const saved of sessions) {
    const session: SessionData = decodeSession(saved.sessionToken) ?? {
      cookie: saved.cookie,
      dtsg: saved.dtsg ?? "",
      userId: saved.userId,
      name: saved.name,
      isCookieSession: true,
    };
    // Always use freshest cookie/dtsg from DB (refreshed by keep-alive job)
    session.cookie = saved.cookie;
    if (saved.dtsg) session.dtsg = saved.dtsg;
    if (saved.eaagToken && !session.eaagToken) session.eaagToken = saved.eaagToken;
    const result = await followUserWithSession(session, target);
    if (result.ok) {
      success++;
      details.push(`✓ ${saved.name} (${saved.userId}): followed/added`);
    } else {
      failed++;
      const isLoggedOut = result.errorMsg?.includes("cookie may be expired") || result.errorMsg?.includes("No cookie or EAAG token");
      if (isLoggedOut) {
        details.push(`✗ ${saved.name} (${saved.userId}): logged out — cookie killed by Facebook (session removed)`);
        db.update(savedSessionsTable)
          .set({ isActive: false, updatedAt: new Date() })
          .where(eq(savedSessionsTable.userId, saved.userId))
          .catch(e => logger.error({ e, userId: saved.userId }, "auto-deactivate follow error"));
      } else {
        details.push(`✗ ${saved.name} (${saved.userId}): ${result.errorMsg ?? "failed"}`);
      }
    }
  }

  res.json({ success, failed, total: sessions.length, message: `${success}/${sessions.length} accounts followed/added.`, details });
});

// ── /fb/sessions-full (admin only) ───────────────────────────────────────────
router.get("/fb/sessions-full", async (req: Request, res: Response) => {
  if (!verifyAdminAuth(req.headers.authorization)) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }
  try {
    const sessions = await db.select().from(savedSessionsTable);
    res.json({
      sessions: sessions.map(s => {
        const decoded = decodeSession(s.sessionToken) ?? null;
        return {
          userId: s.userId,
          name: s.name,
          cookie: s.cookie,
          dtsg: s.dtsg ?? "",
          eaagToken: s.eaagToken ?? "",
          createdAt: s.createdAt?.toISOString() ?? "",
          sessionToken: s.sessionToken,
          lsd: decoded?.lsd ?? "",
          accessToken: decoded?.accessToken ?? "",
          isActive: s.isActive,
          lastPinged: s.lastPinged?.toISOString() ?? null,
        };
      }),
      total: sessions.length,
    });
  } catch (err) {
    logger.error({ err }, "sessions-full db error");
    res.status(500).json({ message: "Database error" });
  }
});

// ── /fb/keepalive (admin only) — trigger manual keep-alive round ──────────────
router.post("/fb/keepalive", async (req: Request, res: Response) => {
  if (!verifyAdminAuth(req.headers.authorization)) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }
  try {
    runKeepAlive().catch(err => logger.error({ err }, "manual keepalive error"));
    res.json({ ok: true, message: "Keep-alive round started in background." });
  } catch (err) {
    logger.error({ err }, "keepalive trigger error");
    res.status(500).json({ message: "Failed to trigger keep-alive" });
  }
});

// ── /fb/admin/verify ─────────────────────────────────────────────────────────
router.post("/fb/admin/verify", (req: Request, res: Response) => {
  const { username, password } = req.body ?? {};
  if (username === adminCreds.username && password === adminCreds.password) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false, message: "Invalid credentials" });
  }
});

// ── /fb/admin/update ─────────────────────────────────────────────────────────
router.post("/fb/admin/update", (req: Request, res: Response) => {
  if (!verifyAdminAuth(req.headers.authorization)) {
    res.status(401).json({ message: "Unauthorized" }); return;
  }
  const { username, password } = req.body ?? {};
  if (!username || !password) { res.status(400).json({ message: "username and password required" }); return; }
  adminCreds = { username, password };
  saveAdminCreds();
  res.json({ ok: true, message: "Admin credentials updated" });
});

// ── /fb/sessions (list) ───────────────────────────────────────────────────────
router.get("/fb/sessions", async (_req: Request, res: Response) => {
  try {
    const sessions = await db.select({
      userId: savedSessionsTable.userId,
      name: savedSessionsTable.name,
      eaagToken: savedSessionsTable.eaagToken,
      createdAt: savedSessionsTable.createdAt,
      isActive: savedSessionsTable.isActive,
      lastPinged: savedSessionsTable.lastPinged,
    }).from(savedSessionsTable);

    res.json({
      sessions: sessions.map((s) => ({
        userId: s.userId,
        name: s.name,
        hasEaagToken: !!s.eaagToken,
        createdAt: s.createdAt?.toISOString() ?? "",
        isActive: s.isActive,
        lastPinged: s.lastPinged?.toISOString() ?? null,
      })),
      total: sessions.length,
    });
  } catch (err) {
    logger.error({ err }, "Failed to fetch sessions");
    res.status(500).json({ message: "Database error" });
  }
});

// ── /fb/sessions/:userId (delete) ────────────────────────────────────────────
router.delete("/fb/sessions/:userId", async (req: Request, res: Response) => {
  const { userId } = req.params;
  if (!userId) {
    res.status(400).json({ message: "userId required" });
    return;
  }
  try {
    await db.delete(savedSessionsTable).where(eq(savedSessionsTable.userId, userId));
    res.json({ success: true, message: `Session for ${userId} removed.` });
  } catch (err) {
    logger.error({ err }, "Failed to delete session");
    res.status(500).json({ message: "Database error" });
  }
});

// ── /fb/refresh-token  (re-extract EAAG from an existing session) ─────────────
router.post("/fb/refresh-token", async (req: Request, res: Response) => {
  const sessionToken: string | undefined = req.body?.token;
  if (!sessionToken) { res.status(400).json({ message: "token required" }); return; }

  const session = decodeSession(sessionToken);
  if (!session?.cookie) { res.status(400).json({ message: "Invalid session token" }); return; }

  try {
    const eaagToken = await extractEaagToken(session.cookie);
    if (eaagToken) {
      // Persist to DB
      await db.update(savedSessionsTable)
        .set({ eaagToken })
        .where(eq(savedSessionsTable.userId, session.userId));
      logger.info({ userId: session.userId, tokenPrefix: eaagToken.substring(0, 20) }, "EAAG token refreshed");
    }
    res.json({ eaagToken: eaagToken ?? null, found: !!eaagToken });
  } catch (err) {
    logger.error({ err }, "refresh-token error");
    res.status(500).json({ message: "Failed to extract token" });
  }
});

export default router;
