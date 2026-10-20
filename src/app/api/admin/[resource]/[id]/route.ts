import { handleAdminItem } from "@/server/admin-handlers";

export const dynamic = "force-dynamic";

export function PATCH(request: Request, context: { params: Promise<{ resource: string; id: string }> }) {
  return context.params.then(({ resource, id }) => handleAdminItem(request, resource, id, "PATCH"));
}

export function DELETE(request: Request, context: { params: Promise<{ resource: string; id: string }> }) {
  return context.params.then(({ resource, id }) => handleAdminItem(request, resource, id, "DELETE"));
}
