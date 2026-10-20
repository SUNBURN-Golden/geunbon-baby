import { z } from "zod";
import {
  brandInputSchema,
  brandPatchSchema,
  eventInputSchema,
  eventPatchSchema,
  groupBuyInputSchema,
  groupBuyPatchSchema,
  modelInputSchema,
  modelPatchSchema,
  priceInputSchema,
  pricePatchSchema,
  reviewSchema,
} from "@/lib/schemas";
import { assertAdmin } from "@/server/auth";
import {
  createBrand,
  createEvent,
  createGroupBuy,
  createModel,
  createPrice,
  deleteBrand,
  deleteEvent,
  deleteGroupBuy,
  deleteModel,
  deletePrice,
  listBrands,
  listEvents,
  listGroupBuys,
  listModels,
  listPrices,
  updateBrand,
  updateEvent,
  updateGroupBuy,
  updateModel,
  updatePrice,
} from "@/server/catalog";
import { listSubmissions, listSubscribers, reviewSubmission } from "@/server/inbox";
import { jsonError, jsonOk, readJson, withErrors } from "@/server/http";
import { getSql } from "@/server/sql";

const idSchema = z.uuid("잘못된 ID입니다.");

export function handleAdminCollection(request: Request, resource: string, method: "GET" | "POST") {
  return withErrors(async () => {
    assertAdmin(request);
    const sql = await getSql();
    if (method === "GET") {
      if (resource === "brands") return jsonOk(await listBrands(sql));
      if (resource === "models") return jsonOk(await listModels(sql));
      if (resource === "prices") return jsonOk(await listPrices(sql));
      if (resource === "group-buys") return jsonOk(await listGroupBuys(sql));
      if (resource === "events") return jsonOk(await listEvents(sql));
      if (resource === "submissions") return jsonOk(await listSubmissions(sql));
      if (resource === "subscribers") return jsonOk(await listSubscribers(sql));
      return jsonError("not_found", "없는 자원입니다.", 404);
    }
    const body = await readJson(request);
    if (resource === "brands") return jsonOk(await createBrand(sql, brandInputSchema.parse(body)), undefined, 201);
    if (resource === "models") return jsonOk(await createModel(sql, modelInputSchema.parse(body)), undefined, 201);
    if (resource === "prices") return jsonOk(await createPrice(sql, stripConfirm(priceInputSchema.parse(body))), undefined, 201);
    if (resource === "group-buys") {
      return jsonOk(await createGroupBuy(sql, stripConfirm(groupBuyInputSchema.parse(body))), undefined, 201);
    }
    if (resource === "events") return jsonOk(await createEvent(sql, stripConfirm(eventInputSchema.parse(body))), undefined, 201);
    return jsonError("not_found", "없는 자원입니다.", 404);
  });
}

export function handleAdminItem(request: Request, resource: string, id: string, method: "PATCH" | "DELETE") {
  return withErrors(async () => {
    assertAdmin(request);
    const parsedId = idSchema.parse(id);
    const sql = await getSql();
    if (method === "DELETE") {
      if (resource === "brands") return jsonOk(await deleteBrand(sql, parsedId));
      if (resource === "models") return jsonOk(await deleteModel(sql, parsedId));
      if (resource === "prices") return jsonOk(await deletePrice(sql, parsedId));
      if (resource === "group-buys") return jsonOk(await deleteGroupBuy(sql, parsedId));
      if (resource === "events") return jsonOk(await deleteEvent(sql, parsedId));
      return jsonError("not_found", "없는 자원입니다.", 404);
    }
    const body = await readJson(request);
    if (resource === "brands") return jsonOk(await updateBrand(sql, parsedId, brandPatchSchema.parse(body)));
    if (resource === "models") return jsonOk(await updateModel(sql, parsedId, modelPatchSchema.parse(body)));
    if (resource === "prices") return jsonOk(await updatePrice(sql, parsedId, stripConfirm(pricePatchSchema.parse(body))));
    if (resource === "group-buys") {
      return jsonOk(await updateGroupBuy(sql, parsedId, stripConfirm(groupBuyPatchSchema.parse(body))));
    }
    if (resource === "events") return jsonOk(await updateEvent(sql, parsedId, stripConfirm(eventPatchSchema.parse(body))));
    if (resource === "submissions") {
      const review = reviewSchema.parse(body);
      return jsonOk(await reviewSubmission(sql, parsedId, review.status));
    }
    return jsonError("not_found", "없는 자원입니다.", 404);
  });
}

function stripConfirm<T extends Record<string, unknown>>(input: T) {
  const rest = { ...input };
  delete rest.confirmRealPrice;
  delete rest.confirmRealListing;
  delete rest.confirmRealEvent;
  return rest;
}
