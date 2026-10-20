import { submissionSchema } from "@/lib/schemas";
import { createSubmission } from "@/server/inbox";
import { jsonOk, optionsResponse, readJson, withErrors } from "@/server/http";
import { getSql } from "@/server/sql";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return optionsResponse();
}

export function POST(request: Request) {
  return withErrors(async () => {
    const parsed = submissionSchema.parse(await readJson(request));
    const { company, ...payload } = parsed;
    if (company.trim()) return jsonOk({ status: "pending" }, undefined, 201, { cors: true });
    const contactEmail = "contactEmail" in payload && payload.contactEmail ? payload.contactEmail : null;
    await createSubmission(await getSql(), { kind: parsed.kind, payload, contactEmail });
    return jsonOk({ status: "pending" }, undefined, 201, { cors: true });
  }, true);
}
