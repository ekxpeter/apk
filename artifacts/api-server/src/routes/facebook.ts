import { Router, type Request, type Response } from "express";
import {
  FbCreatePostBody,
  FbDeletePostsBody,
  FbGetFriendsBody,
  FbGetPostsBody,
  FbGetProfileBody,
  FbGetVideosBody,
  FbLoginBody,
  FbLoginCookieBody,
  FbToggleGuardBody,
  FbUpdateProfileBody,
} from "@workspace/api-zod";
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
      while ((m = storyIdPattern.exec(html)) !== null) addPost(m[1], "(post)", new Date().toISOString(), `https://www.facebook.com/${m[1]}`);
      while ((m = postIdPattern.exec(html)) !== null) addPost(m[1], "(post)", new Date().toISOString(), `https://www.facebook.com/${m[1]}`);
      while ((m = topLevelPattern.exec(html)) !== null) addPost(m[1], "(post)", new Date().toISOString(), `https://www.facebook.com/${m[1]}`);

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
    const cleanName = decodeFbText(name).replace(/\s+/g, " ");
    if (!id || id === session.userId || !cleanName || seen.has(id)) return;
    seen.add(id);
    friends.push({
      id,
      name: cleanName,
      profileUrl: profileUrl ? absoluteFacebookUrl(decodeFbText(profileUrl)) : `https://www.facebook.com/profile.php?id=${id}`,
      pictureUrl: pictureUrl ? decodeFbText(pictureUrl) : `https://graph.facebook.com/${id}/picture?type=large`,
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
        message: friends.length > 0 ? "Friends loaded." : "Facebook only exposes friends who also authorized this app for password-token sessions.",
      };
    } catch (err) {
      logger.error({ err }, "getFriends graph error");
    }
  }

  if (!session.isCookieSession || !session.cookie) {
    return { friends, total: 0, message: "Friends can only be fetched from a valid cookie session." };
  }

  const urls = [
    `https://mbasic.facebook.com/profile.php?v=friends&id=${session.userId}`,
    `https://m.facebook.com/profile.php?id=${session.userId}&sk=friends`,
    `https://www.facebook.com/profile.php?id=${session.userId}&sk=friends`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { ...BROWSER_HEADERS, cookie: session.cookie, "user-agent": DESKTOP_UA },
        redirect: "follow",
      });
      const html = await res.text();
      logger.info({ url, status: res.status, len: html.length }, "getFriends page");

      const anchorPattern = /<a[^>]+href="([^"]*(?:profile\.php\?id=|\/friends\/hovercard\/mbasic\/\?uid=|facebook\.com\/)[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      let match: RegExpExecArray | null;
      while ((match = anchorPattern.exec(html)) !== null) {
        const href = decodeFbText(match[1]);
        const body = match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        const idMatch = href.match(/(?:id=|uid=)(\d+)/) || href.match(/facebook\.com\/(\d+)/);
        if (!idMatch) continue;
        const name = decodeFbText(body);
        if (name.length > 1 && name.length < 90 && !/friends|message|add|remove|follow/i.test(name)) {
          addFriend(idMatch[1], name, href);
        }
      }

      const jsonPattern = /"__typename":"User","id":"(\d+)"[\s\S]{0,300}?"name":"([^"]+)"/g;
      while ((match = jsonPattern.exec(html)) !== null) {
        addFriend(match[1], match[2]);
      }

      const picPattern = /"profile_picture":\{"uri":"([^"]+)"[\s\S]{0,160}?"id":"(\d+)"[\s\S]{0,120}?"name":"([^"]+)"/g;
      while ((match = picPattern.exec(html)) !== null) {
        addFriend(match[2], match[3], undefined, match[1]);
      }

      if (friends.length > 0) break;
    } catch (err) {
      logger.error({ err, url }, "getFriends scrape error");
    }
  }

  return {
    friends: friends.slice(0, 500),
    total: friends.length,
    message: friends.length > 0 ? `Loaded ${friends.length} friend(s).` : "No friends were returned by Facebook for this session.",
  };
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
    const composerRes = await fetch("https://mbasic.facebook.com/", {
      headers: { cookie: session.cookie, "user-agent": DESKTOP_UA, "accept-encoding": "identity" },
      redirect: "follow",
    });
    const html = await composerRes.text();
    const formMatch = html.match(/<form[^>]+method="post"[^>]+action="([^"]*(?:composer|mbasic)[^"]*)"[\s\S]*?<\/form>/i);
    const formHtml = formMatch?.[0] || html;
    const action = formMatch?.[1] ? decodeFbText(formMatch[1]) : "/composer/mbasic/";
    const postUrl = action.startsWith("http") ? action : `https://mbasic.facebook.com${action.startsWith("/") ? action : `/${action}`}`;
    const body = new URLSearchParams();
    const inputPattern = /<input[^>]+name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/g;
    let match: RegExpExecArray | null;
    while ((match = inputPattern.exec(formHtml)) !== null) {
      body.set(decodeFbText(match[1]), decodeFbText(match[2]));
    }
    body.set("xc_message", cleanMessage);
    body.set("view_post", "Post");

    const res = await fetch(postUrl, {
      method: "POST",
      headers: {
        cookie: session.cookie,
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": DESKTOP_UA,
        origin: "https://mbasic.facebook.com",
        referer: "https://mbasic.facebook.com/",
      },
      body: body.toString(),
      redirect: "manual",
    });
    const text = await res.text().catch(() => "");
    logger.info({ status: res.status, location: res.headers.get("location"), body: text.substring(0, 300) }, "createPost mbasic");
    if ((res.status >= 200 && res.status < 400) && !text.includes("error") && !text.includes("checkpoint")) {
      const location = res.headers.get("location") || "";
      const idMatch = location.match(/(?:story_fbid=|fbid=|posts\/)(\d+)/) || text.match(/(?:story_fbid=|fbid=|post_id&quot;:&quot;)(\d+)/);
      const id = idMatch?.[1] || `local-${Date.now()}`;
      return {
        success: true,
        post: { id, message: cleanMessage, createdTime: new Date().toISOString(), permalink: id.startsWith("local-") ? "https://www.facebook.com/" : `https://www.facebook.com/${id}` },
        message: "Post submitted to Facebook.",
      };
    }
    return { success: false, message: "Facebook did not accept the post. The account may need verification or the cookie may be restricted." };
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
    const docIds = ["2723531734265676", "7038184799578088", "9024454557584794"];
    let bioApplied = false;
    for (const docId of docIds) {
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
            origin: "https://www.facebook.com",
            referer: `https://www.facebook.com/profile.php?id=${session.userId}&sk=about`,
          },
          body: body.toString(),
        });
        const text = await res.text();
        logger.info({ docId, status: res.status, body: text.substring(0, 300) }, "updateProfile bio");
        if (res.ok && !text.includes('"errors"') && !text.includes('"error"')) {
          bioApplied = true;
          break;
        }
      } catch (err) {
        logger.error({ err, docId }, "updateProfile bio error");
      }
    }
    if (bioApplied) appliedFields.push("bio");
    else failedFields.push("bio");
  }

  for (const [key] of requested) {
    if (key !== "bio") failedFields.push(key);
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

async function getVideos(session: SessionData): Promise<{ videos: VideoItem[]; message: string }> {
  const videos: VideoItem[] = [];
  const seen = new Set<string>();
  const addVideo = (id: string, title: string, videoUrl: string, thumbnailUrl?: string, permalink?: string, createdTime?: string) => {
    const decodedVideoUrl = decodeFbText(videoUrl);
    if (!id || !decodedVideoUrl || seen.has(id)) return;
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
      `https://www.facebook.com/profile.php?id=${session.userId}&sk=videos`,
      `https://m.facebook.com/profile.php?id=${session.userId}&v=videos`,
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

export default router;
