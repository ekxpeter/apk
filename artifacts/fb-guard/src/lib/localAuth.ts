const USERS_KEY = "fbg_local_users_v1";
const SESSION_KEY = "fbg_local_session_v1";

type LocalUser = { username: string; passwordHash: string; createdAt: string };
type LocalSession = { username: string; loggedInAt: string };

async function hash(s: string): Promise<string> {
  const data = new TextEncoder().encode(`fbg::${s}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function readUsers(): LocalUser[] {
  try {
    return JSON.parse(localStorage.getItem(USERS_KEY) || "[]");
  } catch {
    return [];
  }
}

function writeUsers(users: LocalUser[]) {
  localStorage.setItem(USERS_KEY, JSON.stringify(users));
}

export async function localRegister(username: string, password: string) {
  const u = username.trim().toLowerCase();
  if (u.length < 3) throw new Error("Username must be at least 3 characters");
  if (password.length < 6) throw new Error("Password must be at least 6 characters");
  const users = readUsers();
  if (users.some((x) => x.username === u)) {
    throw new Error("Username already exists");
  }
  users.push({
    username: u,
    passwordHash: await hash(password),
    createdAt: new Date().toISOString(),
  });
  writeUsers(users);
  setLocalSession(u);
  return { username: u };
}

export async function localLogin(username: string, password: string) {
  const u = username.trim().toLowerCase();
  const users = readUsers();
  const user = users.find((x) => x.username === u);
  if (!user) throw new Error("Account not found");
  const ph = await hash(password);
  if (user.passwordHash !== ph) throw new Error("Wrong password");
  setLocalSession(u);
  return { username: u };
}

export function setLocalSession(username: string) {
  const session: LocalSession = { username, loggedInAt: new Date().toISOString() };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function getLocalSession(): LocalSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearLocalSession() {
  localStorage.removeItem(SESSION_KEY);
}

export function hasLocalAccount(username?: string): boolean {
  const users = readUsers();
  if (!username) return users.length > 0;
  return users.some((x) => x.username === username.trim().toLowerCase());
}
