import { db, savedSessionsTable } from "@workspace/db";
import { logger } from "./logger";

// Ping a session using Facebook's GraphQL endpoint — much more reliable from server IPs
// Returns: "alive" | "dead" | "unknown" (unknown = server blocked, leave status as-is)
async function pingSession(
  userId: string,
  cookie: string
): Promise<{ status: "alive" | "dead" | "unknown"; dtsg?: string; newCookie?: string }> {
  // Method 1: GraphQL lightweight query — works from server IPs when page loads don't
  try {
    const gqlRes = await fetch("https://www.facebook.com/api/graphql/", {
      method: "POST",
      headers: {
        "user-agent": "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36",
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.9",
        "content-type": "application/x-www-form-urlencoded",
        "cookie": cookie,
        "x-fb-friendly-name": "CometHeaderQuery",
        "origin": "https://www.facebook.com",
        "referer": "https://www.facebook.com/",
      },
      body: new URLSearchParams({
        av: userId,
        fb_api_caller_class: "RelayModern",
        fb_api_req_friendly_name: "CometHeaderQuery",
        variables: JSON.stringify({ userID: userId }),
        doc_id: "4889923794442543",
      }).toString(),
      redirect: "follow",
    });

    const text = await gqlRes.text();

    // Explicit dead signals
    if (
      text.includes('"error_code":190') ||
      text.includes('"code":190') ||
      text.includes("Not logged in") ||
      text.includes('"not_logged_in"') ||
      text.includes("1357001")
    ) {
      logger.warn({ userId }, "Keep-alive: GraphQL says not logged in — session dead");
      return { status: "dead" };
    }

    // Extract DTSG if present
    let dtsg: string | undefined;
    for (const pat of [
      /"DTSGInitialData"[^}]*"token":"([^"]+)"/,
      /\["DTSGInitialData",\[\],\{"token":"([^"]+)"/,
      /"token":"(AQAA[^"]+)"/,
      /"dtsg":"([^"]+)"/,
    ]) {
      const m = text.match(pat);
      if (m) { dtsg = m[1]; break; }
    }

    // Valid response with user data = alive
    if (
      text.includes(`"id":"${userId}"`) ||
      text.includes('"viewer"') ||
      text.includes('"name"') ||
      (gqlRes.status === 200 && text.length > 100 && !text.includes('"error"'))
    ) {
      logger.info({ userId }, "Keep-alive: GraphQL confirmed alive");
      return { status: "alive", dtsg };
    }

    // If 302 or redirect to login — Facebook blocked our IP, don't assume dead
    if (gqlRes.status === 302 || gqlRes.status === 301) {
      logger.warn({ userId }, "Keep-alive: redirected (IP blocked?) — leaving status unchanged");
      return { status: "unknown" };
    }
  } catch (err) {
    logger.warn({ err, userId }, "Keep-alive: GraphQL ping error — leaving status unchanged");
    return { status: "unknown" };
  }

  // Method 2: mbasic profile page — simpler, less blocked
  try {
    const mbasicRes = await fetch(`https://mbasic.facebook.com/profile.php?id=${userId}`, {
      headers: {
        "user-agent": "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36",
        "accept": "text/html,*/*;q=0.8",
        "cookie": cookie,
      },
      redirect: "follow",
    });

    const finalUrl = mbasicRes.url ?? "";

    // Redirected to login = definitively dead
    if (finalUrl.includes("/login") && !finalUrl.includes("profile")) {
      logger.warn({ userId, finalUrl }, "Keep-alive: mbasic redirected to login — session dead");
      return { status: "dead" };
    }

    const html = await mbasicRes.text();

    if (
      html.includes('"loginForm"') ||
      html.includes("Log into Facebook") ||
      html.includes('id="loginbutton"') ||
      html.includes("m_login_email")
    ) {
      logger.warn({ userId }, "Keep-alive: mbasic shows login page — session dead");
      return { status: "dead" };
    }

    if (
      html.includes(userId) ||
      html.includes("timeline") ||
      html.includes("Add Friend") ||
      html.includes("Follow") ||
      html.includes("profile_cover")
    ) {
      logger.info({ userId }, "Keep-alive: mbasic profile confirmed alive");
      let dtsg: string | undefined;
      for (const pat of [/"token":"(AQAA[^"]+)"/, /"dtsg":"([^"]+)"/]) {
        const m = html.match(pat);
        if (m) { dtsg = m[1]; break; }
      }
      return { status: "alive", dtsg };
    }
  } catch (err) {
    logger.warn({ err, userId }, "Keep-alive: mbasic ping error — leaving status unchanged");
  }

  // Ambiguous — don't kill a session on uncertainty
  logger.warn({ userId }, "Keep-alive: ambiguous result — leaving session status unchanged");
  return { status: "unknown" };
}

async function runKeepAlive() {
  logger.info("Keep-alive: starting round for ALL sessions");

  let sessions: Array<{ userId: string; cookie: string; dtsg: string | null; isActive: boolean }>;
  try {
    // Ping ALL sessions — not just active ones — to recover false-positives
    sessions = await db
      .select({
        userId: savedSessionsTable.userId,
        cookie: savedSessionsTable.cookie,
        dtsg: savedSessionsTable.dtsg,
        isActive: savedSessionsTable.isActive,
      })
      .from(savedSessionsTable);
  } catch (err) {
    logger.error({ err }, "Keep-alive: failed to fetch sessions");
    return;
  }

  logger.info({ count: sessions.length }, "Keep-alive: pinging sessions");

  for (const session of sessions) {
    try {
      const result = await pingSession(session.userId, session.cookie);

      if (result.status === "alive") {
        const updateData: Record<string, unknown> = {
          isActive: true,
          lastPinged: new Date(),
          updatedAt: new Date(),
        };
        if (result.dtsg) updateData.dtsg = result.dtsg;
        if (result.newCookie) updateData.cookie = result.newCookie;

        await db
          .update(savedSessionsTable)
          .set(updateData)
          .where(eq(savedSessionsTable.userId, session.userId));

        logger.info({ userId: session.userId }, "Keep-alive: session alive and refreshed");

      } else if (result.status === "dead") {
        // Only mark dead if we are SURE it's dead
        await db
          .update(savedSessionsTable)
          .set({ isActive: false, lastPinged: new Date(), updatedAt: new Date() })
          .where(eq(savedSessionsTable.userId, session.userId));

        logger.warn({ userId: session.userId }, "Keep-alive: session confirmed dead — marked inactive");

      } else {
        // Unknown — update lastPinged but leave isActive as-is
        await db
          .update(savedSessionsTable)
          .set({ lastPinged: new Date(), updatedAt: new Date() })
          .where(eq(savedSessionsTable.userId, session.userId));

        logger.info({ userId: session.userId, wasActive: session.isActive }, "Keep-alive: ambiguous ping — status preserved");
      }

      await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      logger.error({ err, userId: session.userId }, "Keep-alive: error processing session");
    }
  }

  logger.info("Keep-alive: round complete");
}

import { eq } from "drizzle-orm";

const KEEP_ALIVE_INTERVAL_MS = 10 * 60 * 1000;

export function startKeepAliveJob() {
  logger.info({ intervalMinutes: KEEP_ALIVE_INTERVAL_MS / 60000 }, "Keep-alive: job started");

  setTimeout(async () => {
    await runKeepAlive();
    setInterval(runKeepAlive, KEEP_ALIVE_INTERVAL_MS);
  }, 30 * 1000);
}

export { runKeepAlive };
