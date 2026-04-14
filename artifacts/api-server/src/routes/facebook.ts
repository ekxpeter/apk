import { Router, type Request, type Response } from "express";
import { FbLoginBody, FbLoginCookieBody, FbToggleGuardBody } from "@workspace/api-zod";
import { randomBytes, randomUUID } from "crypto";

const router = Router();

async function getUserId(token: string): Promise<{ id: string; name: string } | null> {
  const res = await fetch(`https://graph.facebook.com/me?access_token=${token}`);
  if (res.status !== 200) return null;
  const info = await res.json();
  return { id: info.id, name: info.name };
}

async function getTokenFromCredentials(email: string, password: string): Promise<string | null> {
  const headers: Record<string, string> = {
    authorization: "OAuth 350685531728|62f8ce9f74b12f84c123cc23437a4a32",
    "x-fb-friendly-name": "Authenticate",
    "x-fb-connection-type": "Unknown",
    "accept-encoding": "gzip, deflate",
    "content-type": "application/x-www-form-urlencoded",
    "x-fb-http-engine": "Liger",
  };

  const adid = randomBytes(8).toString("hex");
  const deviceId = randomUUID();

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
    generate_session_cookies: "0",
    generate_machine_id: "0",
    fb_api_req_friendly_name: "authenticate",
  });

  const res = await fetch("https://b-graph.facebook.com/auth/login", {
    method: "POST",
    headers,
    body: body.toString(),
  });

  if (res.status !== 200) return null;
  const result = await res.json();
  return result.access_token || null;
}

async function getTokenFromCookie(cookie: string): Promise<string | null> {
  const headers: Record<string, string> = {
    cookie,
    "user-agent":
      "Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.5",
  };

  const res = await fetch(
    "https://business.facebook.com/content_management",
    { headers, redirect: "manual" }
  );

  const text = await res.text();
  const tokenMatch = text.match(/EAAG\w+/);
  if (tokenMatch) return tokenMatch[0];

  const dtsgMatch = text.match(/"DTSGInitialData".*?"token":"([^"]+)"/);
  if (!dtsgMatch) return null;

  const cUserMatch = cookie.match(/c_user=(\d+)/);
  if (!cUserMatch) return null;

  const dtsg = dtsgMatch[1];
  const userId = cUserMatch[1];

  const tokenRes = await fetch("https://graph.facebook.com/me?access_token=", {
    headers: { cookie },
  });
  const tokenText = await tokenRes.text();
  const eaagMatch = tokenText.match(/EAAG\w+/);
  if (eaagMatch) return eaagMatch[0];

  const apiRes = await fetch(
    `https://www.facebook.com/api/graphql/`,
    {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
        "user-agent":
          "Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36",
      },
      body: new URLSearchParams({
        fb_dtsg: dtsg,
        variables: JSON.stringify({ userID: userId }),
        doc_id: "5587632691339264",
      }).toString(),
    }
  );

  const apiText = await apiRes.text();
  const accessTokenMatch = apiText.match(/"access_token":"([^"]+)"/);
  if (accessTokenMatch) return accessTokenMatch[1];

  return null;
}

router.post("/fb/login", async (req: Request, res: Response) => {
  const parsed = FbLoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body" });
    return;
  }

  const { email, password } = parsed.data;

  const token = await getTokenFromCredentials(email, password);
  if (!token) {
    res.status(401).json({ message: "Failed to retrieve token. Check your credentials." });
    return;
  }

  const userInfo = await getUserId(token);
  if (!userInfo) {
    res.status(401).json({ message: "Invalid token received." });
    return;
  }

  res.json({ token, userId: userInfo.id, name: userInfo.name });
});

router.post("/fb/login-cookie", async (req: Request, res: Response) => {
  const parsed = FbLoginCookieBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body" });
    return;
  }

  const { cookie } = parsed.data;

  const cUserMatch = cookie.match(/c_user=(\d+)/);
  if (!cUserMatch) {
    res.status(401).json({ message: "Invalid cookie: c_user not found." });
    return;
  }

  const token = await getTokenFromCookie(cookie);
  if (!token) {
    res.status(401).json({ message: "Failed to extract token from cookie. Cookie may be expired." });
    return;
  }

  const userInfo = await getUserId(token);
  if (!userInfo) {
    res.status(401).json({
      message: "Could not fetch user info. Token may be invalid.",
    });
    return;
  }

  res.json({ token, userId: userInfo.id, name: userInfo.name });
});

router.post("/fb/guard", async (req: Request, res: Response) => {
  const parsed = FbToggleGuardBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body" });
    return;
  }

  const { token, enable } = parsed.data;

  const userInfo = await getUserId(token);
  if (!userInfo) {
    res.status(400).json({ message: "Invalid token." });
    return;
  }

  const data = {
    variables: JSON.stringify({
      "0": {
        is_shielded: enable,
        session_id: randomUUID(),
        actor_id: userInfo.id,
        client_mutation_id: randomUUID(),
      },
    }),
    method: "post",
    doc_id: "1477043292367183",
  };

  const fbRes = await fetch("https://graph.facebook.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `OAuth ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });

  const responseText = await fbRes.text();

  if (fbRes.status !== 200) {
    res.status(400).json({ message: `Request failed: ${responseText}` });
    return;
  }

  if (responseText.includes('"is_shielded":true')) {
    res.json({ success: true, isShielded: true, message: "Profile Guard activated successfully" });
  } else if (responseText.includes('"is_shielded":false')) {
    res.json({ success: true, isShielded: false, message: "Profile Guard deactivated successfully" });
  } else {
    res.json({ success: false, isShielded: false, message: `Unexpected response: ${responseText}` });
  }
});

export default router;
