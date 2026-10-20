import { loginSchema } from "@/lib/schemas";
import { adminPassword, createSessionValue, passwordsMatch, requestIsHttps, sessionCookie } from "@/server/auth";
import { jsonError, jsonOk, readJson, withErrors } from "@/server/http";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return withErrors(async () => {
    const body = loginSchema.parse(await readJson(request));
    const expected = adminPassword();
    if (!expected || !passwordsMatch(body.password, expected)) {
      return jsonError("unauthorized", "비밀번호가 올바르지 않습니다.", 401);
    }
    return jsonOk({ authenticated: true }, undefined, 200, {
      headers: { "set-cookie": sessionCookie(createSessionValue(), requestIsHttps(request)) },
    });
  });
}
