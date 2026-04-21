export const API_BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "");

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export function apiFetch(path: string, opts?: RequestInit): Promise<Response> {
  return fetch(apiUrl(path), opts);
}
