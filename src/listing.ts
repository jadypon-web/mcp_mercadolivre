// Helpers for building complete listings (create_item / update_item) and for
// checking what is still missing on a listing after it is published.
import { z } from "zod";
import { MeliApiError, meliDelete, meliGet, meliPost } from "./meli-client.js";

// ---------------------------------------------------------------------------
// Shared input schemas
// ---------------------------------------------------------------------------

export const attributeInput = z
  .object({
    id: z.string().describe("Attribute id, e.g. 'BRAND', 'MODEL', 'GTIN', 'SELLER_SKU'"),
    value_id: z
      .string()
      .optional()
      .describe(
        "Id of the allowed value (from get_category_attributes allowed_values). Prefer this for closed-list attributes"
      ),
    value_name: z
      .string()
      .optional()
      .describe(
        "Value as text, e.g. 'Tigre' or '25 mm'. For number+unit attributes write the number and the unit"
      ),
  })
  .refine((a) => a.value_id !== undefined || a.value_name !== undefined, {
    message: "Each attribute needs value_id or value_name",
  });

export const saleTermInput = z
  .object({
    id: z
      .string()
      .describe("Sale term id, e.g. 'WARRANTY_TYPE', 'WARRANTY_TIME', 'MANUFACTURING_TIME'"),
    value_id: z.string().optional(),
    value_name: z.string().optional(),
  })
  .refine((a) => a.value_id !== undefined || a.value_name !== undefined, {
    message: "Each sale term needs value_id or value_name",
  });

export const variationInput = z.object({
  attribute_combinations: z
    .array(attributeInput)
    .min(1)
    .describe(
      "What makes this variation different, e.g. [{id:'COLOR', value_name:'Branco'}]. Only attributes with allow_variations=true"
    ),
  available_quantity: z.number().int().min(0).describe("Stock of this variation"),
  price: z
    .number()
    .positive()
    .optional()
    .describe("Price of this variation (defaults to the item price)"),
  pictures: z
    .array(z.string())
    .optional()
    .describe(
      "Pictures of this variation: public URLs or picture ids from upload_picture. They are also added to the item pictures"
    ),
  seller_sku: z.string().optional().describe("SKU of this variation (saved as SELLER_SKU)"),
  attributes: z
    .array(attributeInput)
    .optional()
    .describe("Per-variation attributes with variation_attribute=true, e.g. GTIN"),
});

export type AttributeInput = z.infer<typeof attributeInput>;
export type SaleTermInput = z.infer<typeof saleTermInput>;
export type VariationInput = z.infer<typeof variationInput>;

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const URL_RE = /^https?:\/\//i;

// A picture can be a public URL (Meli downloads it) or the id returned by
// upload_picture. They go to the API in different keys.
export function toPictures(list: string[]): Array<{ source: string } | { id: string }> {
  return list.map((p) => (URL_RE.test(p) ? { source: p } : { id: p }));
}

function cleanValue<T extends { id: string; value_id?: string; value_name?: string }>(
  a: T
): Record<string, string> {
  const out: Record<string, string> = { id: a.id };
  if (a.value_id !== undefined) out.value_id = a.value_id;
  if (a.value_name !== undefined) out.value_name = a.value_name;
  return out;
}

// Merges attribute lists by id; later entries win. SELLER_SKU is added from
// seller_sku when it was not passed explicitly.
export function buildAttributes(
  attributes: AttributeInput[] | undefined,
  sellerSku: string | undefined
): Array<Record<string, string>> | undefined {
  const map = new Map<string, Record<string, string>>();
  for (const a of attributes ?? []) map.set(a.id, cleanValue(a));
  if (sellerSku !== undefined && !map.has("SELLER_SKU")) {
    map.set("SELLER_SKU", { id: "SELLER_SKU", value_name: sellerSku });
  }
  return map.size > 0 ? [...map.values()] : undefined;
}

export interface WarrantyInput {
  warranty_type?: string;
  warranty_time?: string;
  manufacturing_time?: string;
  sale_terms?: SaleTermInput[];
}

// Warranty / manufacturing-time shortcuts become sale_terms. Explicit
// sale_terms win over the shortcuts; `existing` (current item terms) is kept
// for ids not being changed, because a PUT replaces the whole list.
export function buildSaleTerms(
  input: WarrantyInput,
  existing: Array<Record<string, unknown>> = []
): Array<Record<string, string>> | undefined {
  const map = new Map<string, Record<string, string>>();
  for (const t of existing) {
    const id = String(t.id ?? "");
    if (!id) continue;
    const kept: Record<string, string> = { id };
    if (t.value_id) kept.value_id = String(t.value_id);
    if (t.value_name) kept.value_name = String(t.value_name);
    map.set(id, kept);
  }
  const before = map.size;
  let changed = false;
  const set = (id: string, value_name: string | undefined) => {
    if (value_name === undefined) return;
    map.set(id, { id, value_name });
    changed = true;
  };
  set("WARRANTY_TYPE", input.warranty_type);
  set("WARRANTY_TIME", input.warranty_time);
  set("MANUFACTURING_TIME", input.manufacturing_time);
  for (const t of input.sale_terms ?? []) {
    map.set(t.id, cleanValue(t));
    changed = true;
  }
  // "Sem garantia" has no time; drop a stale WARRANTY_TIME in that case.
  const type = map.get("WARRANTY_TYPE");
  if (type && /sem garantia|sin garant|no warranty/i.test(type.value_name ?? "")) {
    map.delete("WARRANTY_TIME");
  }
  if (!changed && map.size === before) return undefined;
  return map.size > 0 ? [...map.values()] : undefined;
}

export function buildVariations(
  variations: VariationInput[],
  itemPrice: number | undefined
): { variations: Array<Record<string, unknown>>; extraPictures: string[] } {
  const extraPictures: string[] = [];
  const out = variations.map((v) => {
    const pics = v.pictures ?? [];
    extraPictures.push(...pics);
    const variation: Record<string, unknown> = {
      attribute_combinations: v.attribute_combinations.map(cleanValue),
      available_quantity: v.available_quantity,
    };
    const price = v.price ?? itemPrice;
    if (price !== undefined) variation.price = price;
    if (pics.length > 0) variation.picture_ids = pics;
    const attrs = buildAttributes(v.attributes, v.seller_sku);
    if (attrs) variation.attributes = attrs;
    return variation;
  });
  return { variations: out, extraPictures };
}

// ---------------------------------------------------------------------------
// Category metadata
// ---------------------------------------------------------------------------

export function hasTag(attr: Record<string, unknown>, tag: string): boolean {
  const tags = attr.tags;
  if (Array.isArray(tags)) return tags.includes(tag);
  if (tags && typeof tags === "object") {
    return (tags as Record<string, unknown>)[tag] === true;
  }
  return false;
}

export const TAG_NAMES = [
  "required",
  "catalog_required",
  "conditional_required",
  "new_required",
  "allow_variations",
  "variation_attribute",
  "multivalued",
  "hidden",
  "read_only",
  "fixed",
  "inferred",
] as const;

export function tagList(attr: Record<string, unknown>): string[] {
  return TAG_NAMES.filter((t) => hasTag(attr, t));
}

// Attributes the seller can actually fill (Meli hides or locks some of them).
// Package size attributes are tagged hidden but are mandatory on publish;
// they are filled through create_item's package parameter instead.
const PACKAGE_IDS = new Set([
  "SELLER_PACKAGE_HEIGHT",
  "SELLER_PACKAGE_WIDTH",
  "SELLER_PACKAGE_LENGTH",
  "SELLER_PACKAGE_WEIGHT",
]);

export function isFillable(attr: Record<string, unknown>): boolean {
  if (PACKAGE_IDS.has(String(attr.id))) return false;
  return !hasTag(attr, "hidden") && !hasTag(attr, "read_only") && !hasTag(attr, "fixed");
}

export function isRequired(attr: Record<string, unknown>, condition = "new"): boolean {
  if (hasTag(attr, "required") || hasTag(attr, "catalog_required")) return true;
  if (condition === "new" && hasTag(attr, "new_required")) return true;
  return false;
}

const categoryCache = new Map<string, Array<Record<string, unknown>>>();

export async function getCategoryAttributes(
  categoryId: string
): Promise<Array<Record<string, unknown>>> {
  const cached = categoryCache.get(categoryId);
  if (cached) return cached;
  const data = await meliGet<Array<Record<string, unknown>>>(
    `/categories/${categoryId}/attributes`
  );
  const list = Array.isArray(data) ? data : [];
  categoryCache.set(categoryId, list);
  return list;
}

export async function getCategorySettings(
  categoryId: string
): Promise<Record<string, unknown>> {
  try {
    const cat = await meliGet<{ settings?: Record<string, unknown> }>(
      `/categories/${categoryId}`
    );
    return cat.settings ?? {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// User Products model (family_name instead of title)
// ---------------------------------------------------------------------------

let userProductSeller: boolean | undefined;

export async function isUserProductSeller(): Promise<boolean> {
  if (userProductSeller !== undefined) return userProductSeller;
  try {
    const me = await meliGet<{ tags?: string[] }>("/users/me");
    userProductSeller = (me.tags ?? []).includes("user_product_seller");
  } catch {
    userProductSeller = false;
  }
  return userProductSeller;
}

export function isUserProductItem(item: Record<string, unknown>): boolean {
  const tags = Array.isArray(item.tags) ? (item.tags as string[]) : [];
  return (
    (item.family_name !== undefined && item.family_name !== null) ||
    tags.includes("user_product_listing")
  );
}

// ---------------------------------------------------------------------------
// Completeness check
// ---------------------------------------------------------------------------

export interface MissingAttribute {
  id: string;
  name: string;
  required: boolean;
}

// Compares the attributes to be sent with the category definition and returns
// what is still empty (required first).
export function missingAttributes(
  categoryAttrs: Array<Record<string, unknown>>,
  filledIds: Set<string>,
  condition = "new"
): MissingAttribute[] {
  const missing: MissingAttribute[] = [];
  for (const a of categoryAttrs) {
    const id = String(a.id ?? "");
    if (!id || filledIds.has(id) || !isFillable(a)) continue;
    // Attributes that only make sense per variation are checked there.
    if (hasTag(a, "allow_variations") && !isRequired(a, condition)) continue;
    missing.push({ id, name: String(a.name ?? id), required: isRequired(a, condition) });
  }
  return missing.sort((x, y) => Number(y.required) - Number(x.required));
}

export interface QualityReport {
  item_id: string;
  status?: unknown;
  sub_status?: unknown;
  health?: unknown;
  complete: boolean;
  problems: string[];
  missing_required_attributes: MissingAttribute[];
  empty_optional_attributes: MissingAttribute[];
  flex?: boolean;
  meli_warnings: unknown[];
}

function hasValue(a: Record<string, unknown>): boolean {
  return Boolean(a.value_id || a.value_name || (Array.isArray(a.values) && a.values.length));
}

export async function checkListingQuality(itemId: string): Promise<QualityReport> {
  const item = await meliGet<Record<string, unknown>>(`/items/${itemId}`);
  const problems: string[] = [];

  let descriptionText = "";
  try {
    const d = await meliGet<{ plain_text?: string; text?: string }>(
      `/items/${itemId}/description`
    );
    descriptionText = (d.plain_text ?? d.text ?? "").trim();
  } catch (err) {
    if (!(err instanceof MeliApiError && err.status === 404)) throw err;
  }
  if (!descriptionText) problems.push("Sem descrição");

  const pictures = Array.isArray(item.pictures) ? item.pictures : [];
  if (pictures.length === 0) problems.push("Sem fotos");

  const saleTerms = (Array.isArray(item.sale_terms) ? item.sale_terms : []) as Array<
    Record<string, unknown>
  >;
  const warrantyType = saleTerms.find((t) => t.id === "WARRANTY_TYPE");
  if (!warrantyType) problems.push("Sem tipo de garantia (WARRANTY_TYPE)");
  else if (
    !/sem garantia|sin garant|no warranty/i.test(String(warrantyType.value_name ?? "")) &&
    !saleTerms.find((t) => t.id === "WARRANTY_TIME")
  ) {
    problems.push("Garantia sem prazo (WARRANTY_TIME)");
  }

  const itemAttrs = (Array.isArray(item.attributes) ? item.attributes : []) as Array<
    Record<string, unknown>
  >;
  const filled = new Set(itemAttrs.filter(hasValue).map((a) => String(a.id)));
  // Attributes filled on every variation also count as filled.
  const variations = (Array.isArray(item.variations) ? item.variations : []) as Array<
    Record<string, unknown>
  >;
  if (variations.length > 0) {
    const perVariation = variations.map(
      (v) =>
        new Set(
          [
            ...((v.attribute_combinations as Array<Record<string, unknown>>) ?? []),
            ...((v.attributes as Array<Record<string, unknown>>) ?? []),
          ]
            .filter(hasValue)
            .map((a) => String(a.id))
        )
    );
    for (const id of perVariation[0] ?? []) {
      if (perVariation.every((s) => s.has(id))) filled.add(id);
    }
  }
  if (!filled.has("SELLER_SKU") && !item.seller_custom_field) {
    problems.push("Sem SKU (SELLER_SKU) — o UpSeller usa esse código para vincular o anúncio");
  }

  const categoryAttrs = await getCategoryAttributes(String(item.category_id));
  const missing = missingAttributes(categoryAttrs, filled, String(item.condition ?? "new"));
  const missingRequired = missing.filter((m) => m.required);
  const emptyOptional = missing.filter((m) => !m.required);
  if (missingRequired.length > 0) {
    problems.push(`${missingRequired.length} característica(s) obrigatória(s) vazia(s)`);
  }
  if (emptyOptional.length > 0) {
    problems.push(`${emptyOptional.length} característica(s) opcional(is) vazia(s)`);
  }

  let health: unknown;
  try {
    const h = await meliGet<Record<string, unknown>>(`/items/${itemId}/health`);
    health = h.health ?? h.level ?? undefined;
  } catch {
    health = undefined;
  }

  const tags = Array.isArray(item.tags) ? (item.tags as string[]) : [];
  const flex = tags.includes("self_service_in")
    ? true
    : tags.includes("self_service_out")
      ? false
      : undefined;

  return {
    item_id: itemId,
    status: item.status,
    sub_status: item.sub_status,
    health,
    complete: problems.length === 0,
    problems,
    missing_required_attributes: missingRequired,
    empty_optional_attributes: emptyOptional,
    flex,
    meli_warnings: Array.isArray(item.warnings) ? item.warnings : [],
  };
}

// ---------------------------------------------------------------------------
// Envios Flex (same-day delivery by the seller) per item
// ---------------------------------------------------------------------------

export async function setFlex(
  siteId: string,
  itemId: string,
  enabled: boolean
): Promise<{ flex: boolean; note?: string }> {
  const path = `/flex/sites/${siteId}/items/${itemId}/v2`;
  if (enabled) await meliPost(path);
  else await meliDelete(path);
  return { flex: enabled };
}

export async function getFlex(siteId: string, itemId: string): Promise<unknown> {
  try {
    return await meliGet<unknown>(`/flex/sites/${siteId}/items/${itemId}/v2`);
  } catch (err) {
    if (err instanceof MeliApiError && err.status === 404) return { flex: false };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Wholesale prices (preço por quantidade / atacado, B2B buyers)
// ---------------------------------------------------------------------------

export const wholesaleTierInput = z
  .object({
    min_quantity: z
      .number()
      .int()
      .min(2)
      .describe("Minimum units for this price, e.g. 3"),
    price: z
      .number()
      .positive()
      .optional()
      .describe("Unit price from this quantity on"),
    discount_percent: z
      .number()
      .gt(0)
      .lt(100)
      .optional()
      .describe("Or a % off the item's regular price, e.g. 5 for 5%"),
  })
  .refine((t) => (t.price === undefined) !== (t.discount_percent === undefined), {
    message: "Each tier needs exactly one of price or discount_percent",
  });

export type WholesaleTier = z.infer<typeof wholesaleTierInput>;

interface PriceNode {
  id?: string;
  type?: string;
  amount?: number;
  currency_id?: string;
  conditions?: { context_restrictions?: string[]; min_purchase_unit?: number };
}

// Replaces the item's wholesale table. Meli deletes any existing standard
// price node whose id is not sent, so the regular (non-quantity) standard
// prices are always sent back by id. An empty tier list removes the table.
export async function setWholesalePrices(
  itemId: string,
  tiers: WholesaleTier[]
): Promise<{ base_price: number; tiers: Array<{ min_quantity: number; price: number }> }> {
  if (tiers.length > 5) throw new Error("Meli allows at most 5 wholesale prices per item.");
  const current = await meliGet<{ prices?: PriceNode[] }>(`/items/${itemId}/prices`);
  const standard = (current.prices ?? []).filter((p) => p.type === "standard");
  const regular = standard.filter((p) => !p.conditions?.min_purchase_unit);
  const base = regular.find((p) => !(p.conditions?.context_restrictions ?? []).length) ?? regular[0];
  if (!base?.amount) throw new Error("Could not read the item's regular price.");
  const currency = base.currency_id ?? "BRL";

  const computed = tiers
    .map((t) => ({
      min_quantity: t.min_quantity,
      price:
        t.price ??
        Math.floor(base.amount! * (1 - (t.discount_percent ?? 0) / 100) * 100) / 100,
    }))
    .sort((a, b) => a.min_quantity - b.min_quantity);

  const seen = new Set<number>();
  let last = base.amount;
  for (const t of computed) {
    if (seen.has(t.min_quantity)) throw new Error(`Repeated min_quantity ${t.min_quantity}.`);
    seen.add(t.min_quantity);
    if (t.price >= last) {
      throw new Error(
        `Wholesale price for ${t.min_quantity}+ units (${t.price}) must be lower than the previous price (${last}).`
      );
    }
    last = t.price;
  }

  const body = {
    prices: [
      ...regular.filter((p) => p.id).map((p) => ({ id: p.id })),
      ...computed.map((t) => ({
        type: "standard",
        amount: t.price,
        currency_id: currency,
        conditions: {
          context_restrictions: ["channel_marketplace", "user_type_business"],
          min_purchase_unit: t.min_quantity,
        },
      })),
    ],
  };
  await meliPost(`/items/${itemId}/prices/standard/quantity`, body);
  return { base_price: base.amount, tiers: computed };
}
