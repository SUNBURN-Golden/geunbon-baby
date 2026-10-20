import { clearSessionCookie, requestIsHttps } from "@/server/auth";
import { jsonOk } from "@/server/http";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return jsonOk({ authenticated: false }, undefined, 200, {
    headers: { "set-cookie": clearSessionCookie(requestIsHttps(request)) },
  });
}
