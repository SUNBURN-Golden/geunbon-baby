import { devPasswordHint, isAdminRequest } from "@/server/auth";
import { jsonOk } from "@/server/http";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return jsonOk({
    authenticated: isAdminRequest(request),
    devHint: devPasswordHint(),
  });
}
