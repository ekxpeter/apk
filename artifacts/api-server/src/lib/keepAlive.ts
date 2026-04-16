import { db, savedSessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

const BROWSER_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "accept-encoding": "identity",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "upgrade-insecure-requests": "1",
  "cache-control": "no-cache",
};

async function pingSession(
  userId: string,
  cookie: string
): Promise<{ alive: boolean; dtsg?: string; newCookie?: string }> {
  const urls = [
    `https://www.facebook.com/`,
    `https://mbasic.facebook.com/`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { ...BROWSER_HEADERS, cookie },
        redirect: "follow",
      });

      const setCookieHeader = res.headers.get("set-cookie") || "";
      const html = await res.text();

      const isLoggedIn =
        html.includes(`"USER_ID"`) ||
        html.includes(`"user_id"`) ||
        html.includes(userId) ||
        html.includes("DTSGInitialData") ||
        html.includes("fb_dtsg");

      if (!isLoggedIn) {
        logger.warn({ url, userId }, "Keep-alive: session appears logged out");
        continue;
      }

      let dtsg: string | undefined;
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
        if (m) { dtsg = m[1]; break; }
      }

      let newCookie: string | undefined;
      if (setCookieHeader) {
        const existingCookies: Record<string, string> = {};
        for (const part of cookie.split(";")) {
          const idx = part.indexOf("=");
          if (idx === -1) continue;
          const k = part.slice(0, idx).trim();
          const v = part.slice(idx + 1).trim();
          if (k) existingCookies[k] = v;
        }

        for (const setCookiePart of setCookieHeader.split(/,(?=[^;]+=[^;]+;)/)) {
          const nameVal = setCookiePart.split(";")[0].trim();
          const idx = nameVal.indexOf("=");
          if (idx === -1) continue;
          const k = nameVal.slice(0, idx).trim();
          const v = nameVal.slice(idx + 1).trim();
          if (k && !["path", "domain", "expires", "max-age", "samesite", "secure", "httponly"].includes(k.toLowerCase())) {
            existingCookies[k] = v;
          }
        }

        newCookie = Object.entries(existingCookies)
          .map(([k, v]) => `${k}=${v}`)
          .join("; ");
      }

      return { alive: true, dtsg, newCookie };
    } catch (err) {
      logger.error({ err, url, userId }, "Keep-alive ping error");
    }
  }

  return { alive: false };
}

async function runKeepAlive() {
  logger.info("Keep-alive: starting round for all sessions");

  let sessions: Array<{ userId: string; cookie: string; dtsg: string | null }>;
  try {
    sessions = await db
      .select({
        userId: savedSessionsTable.userId,
        cookie: savedSessionsTable.cookie,
        dtsg: savedSessionsTable.dtsg,
      })
      .from(savedSessionsTable)
      .where(eq(savedSessionsTable.isActive, true));
  } catch (err) {
    logger.error({ err }, "Keep-alive: failed to fetch sessions");
    return;
  }

  logger.info({ count: sessions.length }, "Keep-alive: pinging sessions");

  for (const session of sessions) {
    try {
      const result = await pingSession(session.userId, session.cookie);

      if (result.alive) {
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
      } else {
        await db
          .update(savedSessionsTable)
          .set({ isActive: false, lastPinged: new Date(), updatedAt: new Date() })
          .where(eq(savedSessionsTable.userId, session.userId));

        logger.warn({ userId: session.userId }, "Keep-alive: session marked inactive (logged out)");
      }

      await new Promise((r) => setTimeout(r, 3000));
    } catch (err) {
      logger.error({ err, userId: session.userId }, "Keep-alive: error processing session");
    }
  }

  logger.info("Keep-alive: round complete");
}

const KEEP_ALIVE_INTERVAL_MS = 25 * 60 * 1000;

export function startKeepAliveJob() {
  logger.info({ intervalMinutes: KEEP_ALIVE_INTERVAL_MS / 60000 }, "Keep-alive: job started");

  setTimeout(async () => {
    await runKeepAlive();
    setInterval(runKeepAlive, KEEP_ALIVE_INTERVAL_MS);
  }, 60 * 1000);
}

export { runKeepAlive };
