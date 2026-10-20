import { handleAdminCollection } from "@/server/admin-handlers";

export const dynamic = "force-dynamic";

export function GET(request: Request, context: { params: Promise<{ resource: string }> }) {
  return context.params.then(({ resource }) => handleAdminCollection(request, resource, "GET"));
}

export function POST(request: Request, context: { params: Promise<{ resource: string }> }) {
  return context.params.then(({ resource }) => handleAdminCollection(request, resource, "POST"));
}
