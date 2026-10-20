import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { DomainError } from "@/server/errors";

export const SESSION_COOKIE = "geunbon_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export function sessionSecret() {
  const fromEnv = process.env.ADMIN_SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  if (process.env.NODE_ENV === "production") {
    throw new DomainError(500, "misconfigured", "서버 세션 설정이 필요합니다.");
  }
  return "dev-only-geunbon-session-secret";
}

export function adminPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  if (process.env.NODE_ENV === "production") return null;
  return "geunbon-dev";
}

export function devPasswordHint() {
  if (process.env.NODE_ENV === "production") return null;
  if (process.env.ADMIN_PASSWORD) return null;
  return "geunbon-dev";
}

export function createSessionValue(now = Date.now()) {
  const expiry = Math.floor(now / 1000) + MAX_AGE_SECONDS;
  return sign(expiry);
}

export function verifySession(value: string | undefined | null, now = Date.now()) {
  if (!value) return false;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const [version, expiryText, mac] = parts;
  if (version !== "v1" || !expiryText || !mac) return false;
  const expiry = Number(expiryText);
  if (!Number.isFinite(expiry) || expiry * 1000 < now) return false;
  const expected = createHmac("sha256", sessionSecret()).update(`v1.${expiryText}`).digest("base64url");
  const actualBuffer = Buffer.from(mac);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function sign(expiry: number) {
  const payload = `v1.${expiry}`;
  const mac = createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export function requestIsHttps(request: Request) {
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded) {
    const proto = forwarded.split(",")[0]?.trim().toLowerCase();
    return proto === "https";
  }
  return new URL(request.url).protocol === "https:";
}

export function sessionCookie(value: string, secure: boolean) {
  const flag = secure ? "; Secure" : "";
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_SECONDS}${flag}`;
}

export function clearSessionCookie(secure: boolean) {
  const flag = secure ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${flag}`;
}

export function readCookie(request: Request, name: string) {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function isAdminRequest(request: Request) {
  return verifySession(readCookie(request, SESSION_COOKIE));
}

export function assertAdmin(request: Request) {
  if (!isAdminRequest(request)) {
    throw new DomainError(401, "unauthorized", "로그인이 필요합니다.");
  }
}

export function passwordsMatch(input: string, expected: string) {
  const actual = createHash("sha256").update(input).digest();
  const wanted = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actual, wanted);
}
