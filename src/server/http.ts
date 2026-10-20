import { ZodError } from "zod";
import { DomainError } from "@/server/errors";

export function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
  };
}

export function jsonOk<T>(
  data: T,
  meta?: Record<string, unknown>,
  status = 200,
  options?: { cors?: boolean; headers?: Record<string, string> },
) {
  return Response.json(
    { ok: true as const, data, meta: { apiVersion: 1, ...(meta ?? {}) } },
    {
      status,
      headers: {
        "cache-control": "no-store",
        ...(options?.cors ? corsHeaders() : {}),
        ...(options?.headers ?? {}),
      },
    },
  );
}

export function jsonError(code: string, message: string, status: number, options?: { cors?: boolean }) {
  return Response.json(
    { ok: false as const, error: { code, message } },
    {
      status,
      headers: {
        "cache-control": "no-store",
        ...(options?.cors ? corsHeaders() : {}),
      },
    },
  );
}

export function optionsResponse() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    throw new DomainError(400, "invalid_json", "JSON 본문을 읽을 수 없습니다.");
  }
}

export function toErrorResponse(error: unknown, cors = false) {
  if (error instanceof DomainError) return jsonError(error.code, error.message, error.status, { cors });
  if (error instanceof ZodError) {
    return jsonError("invalid_input", error.issues[0]?.message ?? "입력을 확인해 주세요.", 400, { cors });
  }
  const code = typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : "";
  if (code === "23505") return jsonError("conflict", "이미 같은 값이 있습니다.", 409, { cors });
  if (code === "23503") return jsonError("conflict", "연결된 데이터가 있어 처리할 수 없습니다.", 409, { cors });
  if (code === "23514" || code === "22P02") {
    return jsonError("invalid_input", "값이 허용 범위를 벗어났습니다.", 400, { cors });
  }
  console.error(error);
  return jsonError("internal", "요청을 처리하지 못했습니다.", 500, { cors });
}

export async function withErrors(fn: () => Promise<Response>, cors = false) {
  try {
    return await fn();
  } catch (error) {
    return toErrorResponse(error, cors);
  }
}
