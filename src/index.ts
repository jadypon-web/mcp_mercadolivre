#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import { config, rootDir } from "./config.js";
import {
  MeliApiError,
  meliDelete,
  meliGet,
  meliGetRaw,
  meliPost,
  meliPostForm,
  meliPut,
} from "./meli-client.js";
import {
  ALL_TOOLS,
  auditLog,
  containsContactInfo,
  CONTACT_INFO_MESSAGE,
  isWriteTool,
  resolveSafety,
  toolAllowed,
} from "./safety.js";
import { enforceTokenPermissions, loadTokens } from "./token-store.js";
import { runAuthFlow } from "./auth-flow.js";
import {
  attributeInput,
  buildAttributes,
  buildSaleTerms,
  buildVariations,
  checkListingQuality,
  getCategoryAttributes,
  getCategorySettings,
  getFlex,
  setFlex,
  setWholesalePrices,
  wholesaleTierInput,
  hasTag,
  isFillable,
  isRequired,
  isUserProductItem,
  isUserProductSeller,
  missingAttributes,
  saleTermInput,
  tagList,
  toPictures,
  variationInput,
} from "./listing.js";

const server = new McpServer({
  name: "mcp-mercadolivre",
  version: "1.0.0",
});

const safety = resolveSafety();
enforceTokenPermissions();

// Registers a tool only when the active safety config allows it, and wraps
// write tools with audit logging (one JSON line per invocation).
type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function registerTool<Args extends ZodRawShape>(
  name: string,
  meta: { description: string; inputSchema: Args },
  handler: (
    args: z.objectOutputType<Args, ZodTypeAny>
  ) => Promise<ToolResult> | ToolResult
): void {
  if (!toolAllowed(name, safety)) return;
  server.registerTool(
    name,
    meta,
    (async (args: unknown) => {
      if (!isWriteTool(name))
        return handler(args as z.objectOutputType<Args, ZodTypeAny>);
      const ts = new Date().toISOString();
      const result = await handler(args as z.objectOutputType<Args, ZodTypeAny>);
      auditLog({
        ts,
        tool: name,
        params: JSON.stringify(args ?? {}).slice(0, 500),
        result: result?.isError ? "error" : "ok",
      });
      return result;
    }) as never
  );
}

const registeredCount = ALL_TOOLS.filter((t) => toolAllowed(t, safety)).length;
console.error(
  `Safety: profile=${safety.profile}, read_only=${safety.readOnly}, tools=${registeredCount}/${ALL_TOOLS.length}`
);

const SITE_CURRENCY: Record<string, string> = {
  MLB: "BRL",
  MLA: "ARS",
  MLM: "MXN",
  MLC: "CLP",
  MCO: "COP",
  MLU: "UYU",
  MPE: "PEN",
};

// Compact JSON (no indentation, no nulls/empty arrays) keeps tool results
// small, which saves a lot of tokens on long listing sessions.
function ok(data: unknown) {
  const text = JSON.stringify(data, (_k, v) =>
    v === null || (Array.isArray(v) && v.length === 0) ? undefined : v
  );
  return { content: [{ type: "text" as const, text: text ?? "{}" }] };
}

function fail(err: unknown) {
  let message = err instanceof Error ? err.message : String(err);
  if (err instanceof MeliApiError && err.details !== undefined) {
    message += `\nMeli response body: ${JSON.stringify(err.details)}`;
  }
  if (/No tokens stored|refresh_token|invalid_grant/i.test(message)) {
    message +=
      "\nThe Mercado Livre account is not connected (or the authorization expired). Call the connect_account tool and authorize in the browser.";
  }
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

// "~/Downloads/foto.jpg" or "%USERPROFILE%\\Downloads\\foto.jpg" -> absolute path.
function expandHome(p: string): string {
  const home = os.homedir();
  return p
    .replace(/^~(?=$|[\\/])/, home)
    .replace(/%USERPROFILE%/gi, home);
}

function errText(err: unknown): string {
  let msg = err instanceof Error ? err.message : String(err);
  if (err instanceof MeliApiError && err.details !== undefined) {
    msg += ` | ${JSON.stringify(err.details)}`;
  }
  return msg;
}

async function getMyUserId(): Promise<number> {
  const me = await meliGet<{ id: number }>("/users/me");
  return me.id;
}

// ---------------------------------------------------------------------------
// Conexão da conta
// ---------------------------------------------------------------------------

registerTool(
  "connect_account",
  {
    description:
      "Connect (or reconnect) the seller's Mercado Livre account. Opens a page in the user's browser — the first time, a local form where the user types the App ID and Client Secret (never ask for them in the chat); then the Mercado Livre authorization page; Meli only accepts https return addresses, so after allowing, the user pastes the address of the page that didn't load into the local page — and waits up to 10 minutes. Tell the user to follow the steps on the page that opened; tokens are then saved and renewed automatically. Use it on first use, or whenever another tool says the account is not connected. Tell the user to look at the browser window that opened.",
    inputSchema: {
      force: z
        .boolean()
        .optional()
        .default(false)
        .describe("Reconnect even if an account is already connected"),
    },
  },
  async ({ force }) => {
    try {
      if (!force && loadTokens()) {
        try {
          const me = await meliGet<{ id: number; nickname?: string }>("/users/me");
          return ok({ connected: true, user_id: me.id, nickname: me.nickname, note: "Already connected. Use force=true to reconnect." });
        } catch {
          // stored tokens no longer work: fall through to a new authorization
        }
      }
      const result = await runAuthFlow();
      if (!result.ok) {
        return fail(new Error(`${result.message}${result.authUrl ? `\nIf the browser did not open, open this link: ${result.authUrl}` : ""}`));
      }
      const me = await meliGet<{ id: number; nickname?: string }>("/users/me");
      return ok({ connected: true, user_id: me.id, nickname: me.nickname });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Busca & leitura
// ---------------------------------------------------------------------------

registerTool(
  "search_products",
  {
    description:
      "Search public listings on Mercado Livre for the configured site (ML_SITE_ID, default MLB = Brazil). Use this to research competitors, market prices, or find item/category ids by keyword — it searches the whole marketplace, NOT the seller's own listings (use get_my_items for that). Results are paginated: use limit (max 50) and offset to page through. Returns total count plus a compact list with id, title, price, currency, permalink, thumbnail, condition (new/used) and free-shipping flag.",
    inputSchema: {
      query: z
        .string()
        .describe("Search text, e.g. 'iphone 13 128gb'"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe("Max results per page, 1-50 (default 10)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Pagination offset; combine with limit to fetch further pages"),
      category: z
        .string()
        .optional()
        .describe("Restrict search to a category id, e.g. 'MLB1055' (get ids from predict_category)"),
      price_min: z
        .number()
        .optional()
        .describe("Minimum price filter (inclusive), combined with price_max"),
      price_max: z
        .number()
        .optional()
        .describe("Maximum price filter (inclusive), combined with price_min"),
    },
  },
  async ({ query, limit, offset, category, price_min, price_max }) => {
    try {
      let price: string | undefined;
      if (price_min !== undefined || price_max !== undefined) {
        price = `${price_min ?? "*"}-${price_max ?? "*"}`;
      }
      const data = await meliGet<{
        results?: Array<Record<string, unknown>>;
        paging?: { total?: number };
      }>(`/sites/${config.siteId}/search`, {
        q: query,
        limit,
        offset,
        category,
        price,
      });
      const results = (data.results ?? []).map((r) => {
        const shipping = (r.shipping ?? {}) as { free_shipping?: boolean };
        return {
          id: r.id,
          title: r.title,
          price: r.price,
          currency: r.currency_id,
          permalink: r.permalink,
          thumbnail: r.thumbnail,
          condition: r.condition,
          free_shipping: shipping.free_shipping ?? false,
        };
      });
      return ok({ total: data.paging?.total ?? results.length, results });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "get_item",
  {
    description:
      "Get full details of a single Mercado Livre listing by its item id. The id must be the complete id including the site prefix, e.g. 'MLB123456789' — bare numbers do not work. Use this to inspect a specific listing (yours or a competitor's) in depth: stock, sales count, pictures and attributes. For bulk listing of the seller's own items use get_my_items instead. Returns title, price, currency, available_quantity, sold_quantity, condition, status (active/paused/closed/...), permalink, picture URLs and attributes (id/name/value).",
    inputSchema: {
      item_id: z
        .string()
        .describe("Full item id with site prefix, e.g. 'MLB123456789'"),
    },
  },
  async ({ item_id }) => {
    try {
      const item = await meliGet<Record<string, unknown>>(`/items/${item_id}`);
      const pictures = Array.isArray(item.pictures)
        ? (item.pictures as Array<{ url?: string }>).map((p) => p.url)
        : [];
      const attributes = Array.isArray(item.attributes)
        ? (item.attributes as Array<Record<string, unknown>>).map((a) => ({
            id: a.id,
            name: a.name,
            value: a.value_name,
          }))
        : [];
      return ok({
        id: item.id,
        title: item.title,
        price: item.price,
        currency: item.currency_id,
        available_quantity: item.available_quantity,
        sold_quantity: item.sold_quantity,
        condition: item.condition,
        status: item.status,
        permalink: item.permalink,
        pictures,
        attributes,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "get_my_items",
  {
    description:
      "List the authenticated seller's own listings, with optional status filter. Use this whenever the user asks about 'my listings/ads/products' — for marketplace-wide search use search_products instead. Status filter values: 'active' (published and visible), 'paused' (temporarily hidden), 'closed' (finished; items with sales usually end here). Results are paginated via limit/offset; each entry is hydrated with id, title, status, price, currency and permalink. Requires authentication.",
    inputSchema: {
      status: z
        .enum(["active", "paused", "closed"])
        .optional()
        .describe("Filter by listing status: active, paused or closed. Omit to list all statuses"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(20)
        .describe("Max items to return, 1-100 (default 20)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Pagination offset"),
    },
  },
  async ({ status, limit, offset }) => {
    try {
      const userId = await getMyUserId();
      const search = await meliGet<{
        results?: string[];
        paging?: { total?: number };
      }>(`/users/${userId}/items/search`, { status, limit, offset });
      const ids = search.results ?? [];
      if (ids.length === 0) {
        return ok({ total: search.paging?.total ?? 0, items: [] });
      }
      const multi = await meliGet<
        Array<{ code: number; body?: Record<string, unknown> }>
      >("/items", { ids: ids.slice(0, 50).join(",") });
      const items = multi
        .filter((entry) => entry.code === 200 && entry.body)
        .map((entry) => ({
          id: entry.body!.id,
          title: entry.body!.title,
          status: entry.body!.status,
          price: entry.body!.price,
          currency: entry.body!.currency_id,
          permalink: entry.body!.permalink,
        }));
      return ok({ total: search.paging?.total ?? items.length, items });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "get_questions",
  {
    description:
      "List pre-sale questions buyers asked on the authenticated seller's listings, newest first. Use status='UNANSWERED' to find questions still waiting for a reply — that is the most common use case, since unanswered questions hurt conversion. Other status values: 'ANSWERED', 'DELETED', 'BANNED', 'DISABLED'. Use item_id to restrict to one listing. Each question comes back with its id (needed by answer_question), text, item id, status, creation date (ISO 8601), and the answer (text + date) when one exists. Requires authentication.",
    inputSchema: {
      status: z
        .string()
        .optional()
        .describe(
          "Filter by question status: 'UNANSWERED', 'ANSWERED', 'DELETED', 'BANNED' or 'DISABLED'. Omit to list all; use UNANSWERED to find pending questions"
        ),
      item_id: z
        .string()
        .optional()
        .describe("Restrict to a single item id, e.g. 'MLB123456789'"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(20)
        .describe("Max questions to return, 1-50 (default 20)"),
    },
  },
  async ({ status, item_id, limit }) => {
    try {
      const sellerId = await getMyUserId();
      const data = await meliGet<{
        questions?: Array<Record<string, unknown>>;
        total?: number;
      }>("/questions/search", {
        seller_id: sellerId,
        status,
        item: item_id,
        limit,
        sort_fields: "date_created",
        sort_types: "DESC",
      });
      const questions = (data.questions ?? []).map((q) => {
        const answer = q.answer as
          | { text?: string; date_created?: string }
          | undefined;
        return {
          id: q.id,
          item_id: q.item_id,
          status: q.status,
          text: q.text,
          date_created: q.date_created,
          answer: answer
            ? { text: answer.text, date_created: answer.date_created }
            : null,
        };
      });
      return ok({ total: data.total ?? questions.length, questions });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "get_orders",
  {
    description:
      "List the authenticated seller's orders (sales), newest first (sort=date_desc). Use this for questions about recent sales, revenue, or what a specific buyer purchased. The optional status filter accepts Mercado Livre order statuses such as 'confirmed', 'payment_required', 'payment_in_process', 'paid', 'shipped', 'delivered' and 'cancelled'. Each order includes id, creation date (ISO 8601), status, total amount, currency, buyer nickname, and line items with item id, title, quantity and unit price. Paginated via limit/offset. Requires authentication.",
    inputSchema: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe("Max orders to return, 1-50 (default 10)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Pagination offset"),
      status: z
        .string()
        .optional()
        .describe(
          "Order status filter, e.g. 'paid', 'confirmed', 'shipped', 'delivered', 'cancelled'. Omit to list all"
        ),
    },
  },
  async ({ limit, offset, status }) => {
    try {
      const sellerId = await getMyUserId();
      const data = await meliGet<{
        results?: Array<Record<string, unknown>>;
        paging?: { total?: number };
      }>("/orders/search", {
        seller: sellerId,
        sort: "date_desc",
        limit,
        offset,
        "order.status": status,
      });
      const orders = (data.results ?? []).map((o) => {
        const buyer = (o.buyer ?? {}) as { nickname?: string };
        const orderItems = Array.isArray(o.order_items)
          ? (o.order_items as Array<Record<string, unknown>>).map((oi) => {
              const item = (oi.item ?? {}) as { id?: string; title?: string };
              return {
                id: item.id,
                title: item.title,
                quantity: oi.quantity,
                unit_price: oi.unit_price,
              };
            })
          : [];
        return {
          id: o.id,
          date_created: o.date_created,
          status: o.status,
          total_amount: o.total_amount,
          currency: o.currency_id,
          buyer_nickname: buyer.nickname ?? null,
          items: orderItems,
        };
      });
      return ok({ total: data.paging?.total ?? orders.length, orders });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Publicação (apoio à criação de anúncios)
// ---------------------------------------------------------------------------

registerTool(
  "predict_category",
  {
    description:
      "Predict the best Mercado Livre category for a product title. ALWAYS call this BEFORE create_item: create_item requires a category_id, and publishing in the wrong category hurts visibility and can be rejected. Pass the product title you intend to publish and pick the top prediction. After choosing a category, call get_category_attributes to discover which attributes are mandatory for that category. Returns a list of predicted categories with id, name and full path (e.g. 'Celulares e Telefones > Celulares e Smartphones').",
    inputSchema: {
      title: z
        .string()
        .describe("Product title to classify, e.g. 'iPhone 13 128GB Meia-noite'"),
    },
  },
  async ({ title }) => {
    try {
      // The old /category_predictor endpoint was retired (404); domain
      // discovery is the current one and also suggests attribute values.
      const data = await meliGet<
        Array<{
          category_id?: string;
          category_name?: string;
          domain_id?: string;
          domain_name?: string;
          attributes?: Array<{ id?: string; value_id?: string; value_name?: string }>;
        }>
      >(`/sites/${config.siteId}/domain_discovery/search`, { q: title, limit: 5 });
      const predictions = (Array.isArray(data) ? data : []).map((p) => ({
        id: p.category_id,
        name: p.category_name,
        domain_id: p.domain_id,
        domain_name: p.domain_name,
        suggested_attributes: (p.attributes ?? []).map((a) => ({
          id: a.id,
          value_id: a.value_id,
          value_name: a.value_name,
        })),
      }));
      return ok({ predictions });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "get_category_attributes",
  {
    description:
      "Get ALL attributes (características) of a Mercado Livre category. Call this AFTER picking a category with predict_category and BEFORE create_item. Fill every attribute where fillable=true — required ones block publication, and empty optional ones lower the listing quality. 'required' covers the tags required, catalog_required and (for new items) new_required; 'tags' also shows conditional_required (becomes mandatory depending on other values, e.g. GTIN vs EMPTY_GTIN_REASON), allow_variations (can differ per variation) and variation_attribute (goes inside each variation). For closed lists, send the value_id from allowed_values. Large lists (e.g. BRAND) can be narrowed with value_filter. Also returns the category sale terms (warranty, manufacturing time) and max_title_length.",
    inputSchema: {
      category_id: z
        .string()
        .describe("Category id returned by predict_category, e.g. 'MLB1055'"),
      value_filter: z
        .string()
        .optional()
        .describe("Only return allowed values whose name contains this text (case-insensitive), e.g. 'Tigre'"),
      max_values: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .default(25)
        .describe("Max allowed values returned per attribute (default 25 to save tokens). values_total shows the full count; use value_filter to find a specific one"),
      include_hidden: z
        .boolean()
        .optional()
        .default(false)
        .describe("Also list hidden/read-only attributes the seller cannot fill (default false)"),
      include_details: z
        .boolean()
        .optional()
        .default(false)
        .describe("Also return hint, tooltip and group of each attribute (default false, to save tokens)"),
    },
  },
  async ({ category_id, value_filter, max_values, include_hidden, include_details }) => {
    try {
      const data = await getCategoryAttributes(category_id);
      const filter = value_filter?.toLowerCase();
      const attributes = data
        .filter((a) => include_hidden || isFillable(a))
        .map((a) => {
          const all = Array.isArray(a.values)
            ? (a.values as Array<{ id?: string; name?: string }>)
            : [];
          const matching = filter
            ? all.filter((v) => (v.name ?? "").toLowerCase().includes(filter))
            : all;
          return {
            id: a.id,
            name: a.name,
            value_type: a.value_type,
            required: isRequired(a),
            fillable: isFillable(a),
            tags: tagList(a).filter((t) => t !== "required"),
            hint: include_details ? a.hint : undefined,
            tooltip: include_details ? a.tooltip : undefined,
            value_max_length: a.value_max_length,
            allowed_units: Array.isArray(a.allowed_units)
              ? (a.allowed_units as Array<{ id?: string; name?: string }>).map((u) => u.id ?? u.name)
              : undefined,
            default_unit: a.default_unit,
            group: include_details ? a.attribute_group_name : undefined,
            values_total: all.length || undefined,
            allowed_values: all.length
              ? matching.slice(0, max_values).map((v) => ({ id: v.id, name: v.name }))
              : undefined,
          };
        })
        .sort((x, y) => Number(y.required) - Number(x.required));

      const [settings, saleTerms] = await Promise.all([
        getCategorySettings(category_id),
        meliGet<Array<Record<string, unknown>>>(`/categories/${category_id}/sale_terms`).catch(
          () => []
        ),
      ]);
      const USEFUL_TERMS = ["WARRANTY_TYPE", "WARRANTY_TIME", "MANUFACTURING_TIME", "INVOICE"];
      const sale_terms = (Array.isArray(saleTerms) ? saleTerms : [])
        .filter((t) => !hasTag(t, "hidden"))
        .filter((t) => include_details || USEFUL_TERMS.includes(String(t.id)))
        .map((t) => ({
          id: t.id,
          name: t.name,
          value_type: t.value_type,
          required: hasTag(t, "required"),
          allowed_units: Array.isArray(t.allowed_units)
            ? (t.allowed_units as Array<{ id?: string; name?: string }>).map((u) => u.id ?? u.name)
            : undefined,
          allowed_values: Array.isArray(t.values)
            ? (t.values as Array<{ id?: string; name?: string }>).map((v) => ({ id: v.id, name: v.name }))
            : undefined,
        }));

      return ok({
        category_id,
        max_title_length: settings.max_title_length,
        max_pictures_per_item: settings.max_pictures_per_item,
        total_attributes: attributes.length,
        required_count: attributes.filter((a) => a.required).length,
        attributes,
        sale_terms,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "get_listing_types",
  {
    description:
      "List the listing types (exposure plans) available on the configured site, e.g. 'gold_special' (Clássica) and 'gold_pro' (Premium). Each type has different fees and exposure; higher tiers usually charge more commission but boost visibility. Call this (optionally together with get_listing_prices) before create_item to choose the listing_type_id. Returns ids and names.",
    inputSchema: {},
  },
  async () => {
    try {
      const data = await meliGet<Array<{ id?: string; name?: string }>>(
        `/sites/${config.siteId}/listing_types`
      );
      const listing_types = (Array.isArray(data) ? data : []).map((t) => ({
        id: t.id,
        name: t.name,
      }));
      return ok({ listing_types });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "get_listing_prices",
  {
    description:
      "Estimate the selling fees for publishing an item at a given price, optionally for a specific category and listing type. Use this BEFORE create_item so the seller knows the commission cost of each exposure plan (Clássica vs Premium) before committing. Returns one entry per listing type with the sale fee percentage, fee amount and related flags for the given price.",
    inputSchema: {
      price: z
        .number()
        .describe("Intended sale price in the site currency (e.g. BRL for MLB)"),
      category_id: z
        .string()
        .optional()
        .describe("Category id (from predict_category) for a category-accurate fee"),
      listing_type_id: z
        .string()
        .optional()
        .describe("Listing type id, e.g. 'gold_special'. Omit to get Clássico and Premium"),
    },
  },
  async ({ price, category_id, listing_type_id }) => {
    try {
      const data = await meliGet<unknown>(
        `/sites/${config.siteId}/listing_prices`,
        { price, category_id, listing_type_id }
      );
      // With listing_type_id Meli answers a single object, not a list.
      const list = (Array.isArray(data) ? data : data ? [data] : []) as Array<
        Record<string, unknown>
      >;
      const options = list
        .filter((o) => !listing_type_id || o.listing_type_id === listing_type_id)
        .filter((o) => listing_type_id || ["gold_special", "gold_pro"].includes(String(o.listing_type_id)))
        .map((o) => {
          const fee = (o.sale_fee_details ?? {}) as Record<string, unknown>;
          return {
            listing_type_id: o.listing_type_id,
            listing_type_name: o.listing_type_name,
            total_fee: o.sale_fee_amount ?? fee.gross_amount,
            percentage_fee: fee.percentage_fee ?? fee.meli_percentage_fee,
            fixed_fee: fee.fixed_fee,
            fee_details: fee,
          };
        });
      return ok({ price, options });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Gestão de anúncios (escrita)
// ---------------------------------------------------------------------------

const warrantyShape = {
  warranty_type: z
    .string()
    .optional()
    .describe("Warranty type as Meli names it in MLB: 'Garantia do vendedor', 'Garantia de fábrica' or 'Sem garantia'"),
  warranty_time: z
    .string()
    .optional()
    .describe("Warranty duration with unit, e.g. '90 dias', '6 meses', '1 anos'. Omit when 'Sem garantia'"),
  manufacturing_time: z
    .string()
    .optional()
    .describe("Extra days before shipping (prazo de disponibilidade), e.g. '5 dias'. Omit when the item ships right away — it lowers exposure"),
  sale_terms: z
    .array(saleTermInput)
    .optional()
    .describe("Raw sale terms (see get_category_attributes sale_terms). Overrides the warranty/manufacturing shortcuts with the same id"),
};

const flexWholesaleShape = {
  flex: z
    .boolean()
    .optional()
    .describe("true = turn on Envios Flex (same-day delivery) for this listing; false = turn it off. The account must already be enabled for Flex"),
  wholesale: z
    .array(wholesaleTierInput)
    .max(5)
    .optional()
    .describe("Wholesale price table (preço de atacado, shown to business buyers), up to 5 tiers, e.g. [{min_quantity:3, discount_percent:5},{min_quantity:6, discount_percent:8}]. Prices must go down as quantity goes up. On update_item, [] removes the table"),
};

registerTool(
  "create_item",
  {
    description:
      "Create and PUBLISH a COMPLETE new listing on Mercado Livre — real write operation: the item becomes public and fees apply when it sells. Confirm the details with the user first. Flow: (1) predict_category; (2) get_category_attributes and fill EVERY fillable attribute (required ones are checked here before sending; empty optional ones are reported); (3) optionally get_listing_prices; (4) create_item with title (or family_name), price, stock, description, pictures, attributes, warranty, seller_sku and, when the product has options like color/size, variations. Pictures accept public URLs or ids from upload_picture. Accounts on Meli's 'User Products' model publish with family_name instead of title — this is detected automatically. After publishing, the tool re-reads the listing and returns a quality report listing anything still empty (description, pictures, warranty, SKU, attributes) so it can be fixed with update_item right away.",
    inputSchema: {
      title: z
        .string()
        .max(120)
        .optional()
        .describe("Listing title. Limit depends on the category (max_title_length, usually 60). Required unless family_name is given"),
      family_name: z
        .string()
        .max(120)
        .optional()
        .describe("Generic product name for accounts on the User Products model (Meli builds the title from it). Defaults to title when the account needs it"),
      category_id: z
        .string()
        .describe("Category id from predict_category, e.g. 'MLB1055'"),
      price: z.number().positive().describe("Sale price in currency_id"),
      available_quantity: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Stock quantity. Required when there are no variations (with variations each one has its own stock)"),
      condition: z
        .enum(["new", "used", "not_specified"])
        .optional()
        .default("new")
        .describe("Item condition (default 'new')"),
      listing_type_id: z
        .string()
        .optional()
        .default("gold_special")
        .describe("'gold_special' (Clássico, default) or 'gold_pro' (Premium)"),
      buying_mode: z
        .string()
        .optional()
        .default("buy_it_now")
        .describe("Keep 'buy_it_now' unless the user explicitly wants something else"),
      currency_id: z
        .string()
        .optional()
        .describe("ISO currency. Defaults to the site currency (BRL for MLB)"),
      description: z
        .string()
        .describe("Plain-text description (no HTML, no emojis). Required: listings without description lose quality"),
      pictures: z
        .array(z.string())
        .min(1)
        .describe("Pictures in display order: public image URLs and/or picture ids returned by upload_picture"),
      attributes: z
        .array(attributeInput)
        .optional()
        .describe("Item attributes (características). Include every fillable attribute from get_category_attributes; use value_id for closed lists"),
      seller_sku: z
        .string()
        .optional()
        .describe("Your internal product code, saved as attribute SELLER_SKU (used by ERPs like UpSeller to link the listing)"),
      seller_custom_field: z
        .string()
        .optional()
        .describe("Free internal reference field (not the SKU)"),
      ...warrantyShape,
      ...flexWholesaleShape,
      variations: z
        .array(variationInput)
        .optional()
        .describe("Variations (e.g. colors or sizes) when one listing sells several options"),
      video_id: z
        .string()
        .optional()
        .describe("Video id from upload_video"),
      shipping: z
        .record(z.unknown())
        .optional()
        .describe("Shipping object, e.g. {mode:'me2', free_shipping:true, local_pick_up:false}"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Extra item tags, e.g. ['immediate_payment']"),
      allow_missing_required: z
        .boolean()
        .optional()
        .default(false)
        .describe("Send even if required attributes are missing (default false: the tool stops and lists them)"),
      check_quality: z
        .boolean()
        .optional()
        .default(true)
        .describe("Re-read the listing after publishing and report what is still empty (default true)"),
    },
  },
  async (input) => {
    try {
      if (!input.title && !input.family_name) {
        return fail(new Error("Provide title (or family_name)."));
      }
      if (!input.variations?.length && input.available_quantity === undefined) {
        return fail(new Error("Provide available_quantity (or variations, each with its own stock)."));
      }

      const attributes = buildAttributes(input.attributes, input.seller_sku);
      const categoryAttrs = await getCategoryAttributes(input.category_id);

      // Check required attributes before sending, so Meli doesn't reject it.
      const filled = new Set((attributes ?? []).map((a) => a.id));
      for (const v of input.variations ?? []) {
        for (const a of v.attribute_combinations) filled.add(a.id);
        for (const a of v.attributes ?? []) filled.add(a.id);
        if (v.seller_sku) filled.add("SELLER_SKU");
      }
      const missing = missingAttributes(categoryAttrs, filled, input.condition);
      const missingRequired = missing.filter((m) => m.required);
      if (missingRequired.length > 0 && !input.allow_missing_required) {
        return fail(
          new Error(
            `Required attributes missing — nothing was published. Fill these and call again: ${missingRequired
              .map((m) => `${m.id} (${m.name})`)
              .join(", ")}`
          )
        );
      }

      // Classic listings use title; User Products accounts use family_name.
      const useFamilyName = await isUserProductSeller();
      const body: Record<string, unknown> = {
        category_id: input.category_id,
        price: input.price,
        condition: input.condition,
        listing_type_id: input.listing_type_id,
        buying_mode: input.buying_mode,
        currency_id: input.currency_id ?? SITE_CURRENCY[config.siteId] ?? "BRL",
      };
      if (useFamilyName) {
        body.family_name = input.family_name ?? input.title;
      } else {
        const title = input.title ?? input.family_name ?? "";
        const settings = await getCategorySettings(input.category_id);
        const maxTitle = Number(settings.max_title_length ?? 60);
        if (title.length > maxTitle) {
          return fail(
            new Error(`Title has ${title.length} characters; this category allows ${maxTitle}.`)
          );
        }
        body.title = title;
      }

      let pictureList = [...input.pictures];
      if (input.variations?.length) {
        const built = buildVariations(input.variations, input.price);
        body.variations = built.variations;
        for (const p of built.extraPictures) if (!pictureList.includes(p)) pictureList.push(p);
      } else {
        body.available_quantity = input.available_quantity;
      }
      body.pictures = toPictures(pictureList);
      body.description = { plain_text: input.description };
      if (attributes) body.attributes = attributes;
      const saleTerms = buildSaleTerms(input);
      if (saleTerms) body.sale_terms = saleTerms;
      if (input.seller_custom_field !== undefined) body.seller_custom_field = input.seller_custom_field;
      if (input.video_id !== undefined) body.video_id = input.video_id;
      if (input.shipping !== undefined) body.shipping = input.shipping;
      if (input.tags !== undefined) body.tags = input.tags;

      const created = await meliPost<Record<string, unknown>>("/items", body);
      const itemId = String(created.id);

      // Some accounts ignore the inline description; make sure it is there.
      const followUps: string[] = [];
      try {
        const d = await meliGet<{ plain_text?: string }>(`/items/${itemId}/description`);
        if (!(d.plain_text ?? "").trim()) {
          await meliPut(`/items/${itemId}/description`, { plain_text: input.description }, { api_version: 2 });
          followUps.push("description re-sent");
        }
      } catch (err) {
        if (err instanceof MeliApiError && err.status === 404) {
          await meliPost(`/items/${itemId}/description`, { plain_text: input.description });
          followUps.push("description created");
        } else {
          followUps.push(`description check failed: ${(err as Error).message}`);
        }
      }

      // Flex and wholesale prices have their own endpoints, after creation.
      if (input.flex !== undefined) {
        try {
          await setFlex(config.siteId, itemId, input.flex);
          followUps.push(input.flex ? "flex on" : "flex off");
        } catch (err) {
          followUps.push(`flex failed: ${errText(err)}`);
        }
      }
      if (input.wholesale?.length) {
        try {
          const w = await setWholesalePrices(itemId, input.wholesale);
          followUps.push(
            `wholesale: ${w.tiers.map((t) => `${t.min_quantity}+ = ${t.price}`).join(", ")}`
          );
        } catch (err) {
          followUps.push(`wholesale failed: ${errText(err)}`);
        }
      }

      const result: Record<string, unknown> = {
        id: itemId,
        title: created.title,
        family_name: created.family_name,
        status: created.status,
        permalink: created.permalink,
        listing_model: useFamilyName ? "user_products (family_name)" : "classic (title)",
        warnings: created.warnings ?? [],
        follow_ups: followUps,
      };
      if (input.check_quality) {
        try {
          result.quality = await checkListingQuality(itemId);
        } catch (err) {
          result.quality = `quality check failed: ${(err as Error).message}`;
        }
      } else if (missing.length > 0) {
        result.empty_attributes = missing;
      }
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "update_item",
  {
    description:
      "Edit ANY editable part of an existing listing: price, stock, title/family_name, description, pictures, attributes, SKU, warranty and other sale terms, shipping, variations, video and listing type (Clássico→Premium). Only the fields you pass are changed. Notes: title/family_name can only change while the item has no sales; pictures REPLACE the current set unless append_pictures=true; listing type can usually be changed only once; category cannot be changed. Each part is applied separately and the result says which parts succeeded. Ends with a quality report of what is still empty.",
    inputSchema: {
      item_id: z
        .string()
        .describe("Full item id with site prefix, e.g. 'MLB123456789'"),
      price: z.number().positive().optional().describe("New sale price"),
      available_quantity: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("New stock quantity (items without variations)"),
      title: z
        .string()
        .max(120)
        .optional()
        .describe("New title; on User Products listings it is applied as family_name. Only while the item has no sales"),
      family_name: z
        .string()
        .max(120)
        .optional()
        .describe("New family_name (User Products listings). Only while there are no sales"),
      description: z
        .string()
        .optional()
        .describe("New plain-text description (replaces the current one)"),
      pictures: z
        .array(z.string())
        .optional()
        .describe("Pictures (public URLs or ids from upload_picture). Replaces the current pictures unless append_pictures=true"),
      append_pictures: z
        .boolean()
        .optional()
        .default(false)
        .describe("Keep the current pictures and add these after them"),
      attributes: z
        .array(attributeInput)
        .optional()
        .describe("Attributes to set or change; attributes not listed are kept"),
      seller_sku: z.string().optional().describe("Set the SKU (SELLER_SKU attribute)"),
      seller_custom_field: z.string().optional().describe("Free internal reference field"),
      ...warrantyShape,
      ...flexWholesaleShape,
      shipping: z
        .record(z.unknown())
        .optional()
        .describe("Shipping object, e.g. {free_shipping:true}"),
      variations: z
        .array(z.record(z.unknown()))
        .optional()
        .describe("Full variations array as Meli expects it. Existing variations must keep their 'id'; omitted ones are deleted. Read get_item first"),
      video_id: z
        .string()
        .optional()
        .describe("Video id from upload_video"),
      listing_type_id: z
        .string()
        .optional()
        .describe("Change exposure: 'gold_special' (Clássico) or 'gold_pro' (Premium)"),
      check_quality: z
        .boolean()
        .optional()
        .default(true)
        .describe("Report what is still empty after the update (default true)"),
    },
  },
  async (input) => {
    const { item_id } = input;
    const applied: string[] = [];
    const errors: string[] = [];
    const step = async (name: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
        applied.push(name);
      } catch (err) {
        let msg = (err as Error).message;
        if (err instanceof MeliApiError && err.details !== undefined) {
          msg += ` | ${JSON.stringify(err.details)}`;
        }
        errors.push(`${name}: ${msg}`);
      }
    };

    try {
      const current = await meliGet<Record<string, unknown>>(`/items/${item_id}`);
      const isUP = isUserProductItem(current);

      // 1) Fields that go in PUT /items/{id}
      const body: Record<string, unknown> = {};
      if (input.price !== undefined) body.price = input.price;
      if (input.available_quantity !== undefined) body.available_quantity = input.available_quantity;
      if (input.title !== undefined && !isUP) body.title = input.title;
      if (input.video_id !== undefined) body.video_id = input.video_id;
      if (input.shipping !== undefined) body.shipping = input.shipping;
      if (input.variations !== undefined) body.variations = input.variations;
      if (input.seller_custom_field !== undefined) body.seller_custom_field = input.seller_custom_field;

      const attributes = buildAttributes(input.attributes, input.seller_sku);
      if (attributes) body.attributes = attributes;

      const saleTerms = buildSaleTerms(
        input,
        (current.sale_terms as Array<Record<string, unknown>>) ?? []
      );
      if (saleTerms) body.sale_terms = saleTerms;

      if (input.pictures !== undefined) {
        const existing = input.append_pictures
          ? ((current.pictures as Array<{ id?: string }>) ?? [])
              .map((p) => p.id)
              .filter((id): id is string => Boolean(id))
          : [];
        body.pictures = [...existing.map((id) => ({ id })), ...toPictures(input.pictures)];
      }

      if (Object.keys(body).length > 0) {
        await step(`item fields (${Object.keys(body).join(", ")})`, () =>
          meliPut(`/items/${item_id}`, body)
        );
      }

      // 2) family_name (User Products) — also used for title on UP listings
      const familyName = input.family_name ?? (isUP ? input.title : undefined);
      if (familyName !== undefined) {
        await step("family_name", () =>
          meliPut(`/items/${item_id}/family_name`, { family_name: familyName })
        );
      }

      // 3) Description has its own endpoint
      if (input.description !== undefined) {
        await step("description", async () => {
          try {
            await meliPut(
              `/items/${item_id}/description`,
              { plain_text: input.description },
              { api_version: 2 }
            );
          } catch (err) {
            if (err instanceof MeliApiError && (err.status === 404 || err.status === 400)) {
              await meliPost(`/items/${item_id}/description`, { plain_text: input.description });
            } else {
              throw err;
            }
          }
        });
      }

      // 4) Listing type has its own endpoint
      if (
        input.listing_type_id !== undefined &&
        input.listing_type_id !== current.listing_type_id
      ) {
        await step("listing_type", () =>
          meliPost(`/items/${item_id}/listing_type`, { id: input.listing_type_id })
        );
      }

      // 5) Flex and wholesale prices
      if (input.flex !== undefined) {
        await step(input.flex ? "flex on" : "flex off", () =>
          setFlex(config.siteId, item_id, input.flex!)
        );
      }
      if (input.wholesale !== undefined) {
        await step(input.wholesale.length ? "wholesale prices" : "wholesale removed", () =>
          setWholesalePrices(item_id, input.wholesale!)
        );
      }

      if (applied.length === 0 && errors.length === 0) {
        return fail(new Error("Provide at least one field to update."));
      }

      const result: Record<string, unknown> = { id: item_id, applied, errors };
      if (input.check_quality) {
        try {
          result.quality = await checkListingQuality(item_id);
        } catch (err) {
          result.quality = `quality check failed: ${(err as Error).message}`;
        }
      }
      return errors.length > 0 && applied.length === 0
        ? { ...ok(result), isError: true }
        : ok(result);
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "set_flex",
  {
    description:
      "Check, turn on or turn off Envios Flex (same-day delivery done by the seller) on one listing. Omit 'enabled' to just check. The seller account must already be subscribed to Flex in Mercado Livre.",
    inputSchema: {
      item_id: z.string().describe("Item id, e.g. 'MLB123456789'"),
      enabled: z.boolean().optional().describe("true = turn on, false = turn off, omit = only check"),
    },
  },
  async ({ item_id, enabled }) => {
    try {
      if (enabled === undefined) return ok({ item_id, flex: await getFlex(config.siteId, item_id) });
      return ok({ item_id, ...(await setFlex(config.siteId, item_id, enabled)) });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "set_wholesale_prices",
  {
    description:
      "Set (or remove, with an empty list) the wholesale price table of a listing — preço de atacado / preço por quantidade, shown to business buyers. Up to 5 tiers; each tier is a minimum quantity and either a unit price or a % off the regular price. Prices must go down as quantity goes up. Replaces the current table. If Meli warns about a tier price, remove that tier instead of forcing it.",
    inputSchema: {
      item_id: z.string().describe("Item id, e.g. 'MLB123456789'"),
      tiers: z.array(wholesaleTierInput).max(5).describe("e.g. [{min_quantity:3, discount_percent:5},{min_quantity:6, discount_percent:8}]"),
    },
  },
  async ({ item_id, tiers }) => {
    try {
      return ok({ item_id, ...(await setWholesalePrices(item_id, tiers)) });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "check_listing_quality",
  {
    description:
      "Check what is still missing on a listing: description, pictures, warranty, SKU, required and optional attributes (características), plus Meli's own health score when available. Use it after creating or editing, or to audit existing listings. Returns complete=true only when nothing is empty.",
    inputSchema: {
      item_id: z
        .string()
        .describe("Item id with site prefix, e.g. 'MLB123456789'"),
    },
  },
  async ({ item_id }) => {
    try {
      return ok(await checkListingQuality(item_id));
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "update_item_status",
  {
    description:
      "Change the visibility status of a listing: 'pause' temporarily hides it (reversible), 'activate' re-publishes a paused item, and 'close' finishes the listing. WARNING: closing is effectively irreversible for items that had sales — a closed item cannot be reactivated; a new listing would have to be created. Because of that, action='close' is refused unless confirm=true is passed explicitly. Always confirm with the user before closing. Paused items keep their history and can be reactivated at any time with 'activate'. Returns the item id and its new status.",
    inputSchema: {
      item_id: z
        .string()
        .describe("Full item id with site prefix, e.g. 'MLB123456789'"),
      action: z
        .enum(["pause", "activate", "close"])
        .describe(
          "Action to apply: 'pause' (hide, reversible), 'activate' (re-publish a paused item), 'close' (finish; irreversible when the item has sales)"
        ),
      confirm: z
        .boolean()
        .optional()
        .describe(
          "Required for action='close': must be exactly true to confirm the irreversible closing. Ignored for pause/activate"
        ),
    },
  },
  async ({ item_id, action, confirm }) => {
    try {
      if (action === "close" && confirm !== true) {
        return fail(
          new Error(
            "Closing an item is irreversible. Call again with confirm: true to proceed."
          )
        );
      }
      const statusMap = { pause: "paused", activate: "active", close: "closed" } as const;
      const updated = await meliPut<Record<string, unknown>>(
        `/items/${item_id}`,
        { status: statusMap[action] }
      );
      return ok({ id: updated.id ?? item_id, status: updated.status ?? statusMap[action] });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Perguntas (escrita)
// ---------------------------------------------------------------------------

registerTool(
  "answer_question",
  {
    description:
      "Post a public answer to a buyer's pre-sale question. The answer is visible to everyone viewing the listing and CANNOT be edited or deleted afterwards — confirm the exact text with the user before sending. Get the question_id from get_questions (typically with status='UNANSWERED'). Returns the answer id, text, status and creation date.",
    inputSchema: {
      question_id: z
        .number()
        .describe("Numeric question id from get_questions"),
      text: z
        .string()
        .describe("Answer text; public and irreversible once posted"),
    },
  },
  async ({ question_id, text }) => {
    try {
      const answer = await meliPost<Record<string, unknown>>("/answers", {
        question_id,
        text,
      });
      return ok({
        id: answer.id,
        question_id,
        text: answer.text,
        status: answer.status,
        date_created: answer.date_created,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "upload_picture",
  {
    description:
      "Upload a picture to the seller's Mercado Livre account and get back a picture id. Provide exactly ONE of: url (a public image URL that Meli will download) or file_path (a local image file, uploaded as multipart). Use the returned id in create_item's pictures when the images are local files; for images already hosted at a public URL, passing the URL directly to create_item also works. Returns the picture id, source URL and size variations.",
    inputSchema: {
      url: z
        .string()
        .url()
        .optional()
        .describe("Public URL of the image; Meli downloads it"),
      file_path: z
        .string()
        .optional()
        .describe("Absolute path to a local image file (jpg/png); sent as multipart upload"),
    },
  },
  async ({ url, file_path }) => {
    try {
      if ((url === undefined) === (file_path === undefined)) {
        return fail(
          new Error("Provide exactly one of 'url' or 'file_path'.")
        );
      }
      let picture: Record<string, unknown>;
      if (url !== undefined) {
        picture = await meliPost<Record<string, unknown>>("/pictures", {
          source: url,
        });
      } else {
        const localPath = expandHome(file_path!);
        const buffer = await readFile(localPath);
        const form = new FormData();
        form.append(
          "file",
          new Blob([new Uint8Array(buffer)]),
          path.basename(localPath)
        );
        picture = await meliPostForm<Record<string, unknown>>(
          "/pictures",
          form
        );
      }
      const variations = Array.isArray(picture.variations)
        ? (picture.variations as Array<Record<string, unknown>>).map((v) => ({
            size: v.size,
            url: v.url,
          }))
        : [];
      return ok({
        id: picture.id,
        source: picture.source ?? url,
        max_size: picture.max_size,
        variations,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm"]);

registerTool(
  "upload_video",
  {
    description:
      "Upload a product video from a local file to the seller's Mercado Livre account and get back a video_id. Pass that video_id to create_item or update_item to attach the video to a listing. Only local files are supported (mp4, mov, avi, mkv, webm). Meli enforces size/duration limits on product videos — very large or long files are rejected by the API, and in that case the API error is returned as-is so you can adjust the file and retry. Returns the video_id plus basic response info (id, max size/quality when present).",
    inputSchema: {
      file_path: z
        .string()
        .describe("Absolute path to a local video file (.mp4, .mov, .avi, .mkv or .webm)"),
    },
  },
  async ({ file_path }) => {
    try {
      const ext = path.extname(file_path).toLowerCase();
      if (!VIDEO_EXTENSIONS.has(ext)) {
        return fail(
          new Error(
            `Unsupported video extension '${ext || "(none)"}'; expected one of: ${[...VIDEO_EXTENSIONS].join(", ")}.`
          )
        );
      }
      let buffer: Buffer;
      try {
        buffer = await readFile(file_path);
      } catch {
        return fail(new Error(`File not found or unreadable: ${file_path}`));
      }
      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(buffer)]),
        path.basename(file_path)
      );
      const video = await meliPostForm<Record<string, unknown>>(
        "/pictures",
        form
      );
      return ok({
        video_id: video.video_id ?? video.id,
        id: video.id,
        max_size: video.max_size,
        quality: video.quality,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Envios
// ---------------------------------------------------------------------------

registerTool(
  "get_shipment",
  {
    description:
      "Get the shipping details of a sale: status, substatus, tracking number, dates (ISO 8601), receiver address, shipped items and logistic type (e.g. 'me2', 'flex', 'self_service'). Shipment ids come from orders: each order returned by get_orders has a shipping id (order.shipping.id) — if you only have an order id, call get_orders first to find the shipment id. Status values include 'pending', 'ready_to_ship', 'shipped', 'delivered' and 'cancelled'. Use get_shipment_label to download the printable label for the shipment.",
    inputSchema: {
      shipment_id: z
        .number()
        .describe("Numeric shipment id, taken from an order's shipping.id"),
    },
  },
  async ({ shipment_id }) => {
    try {
      const s = await meliGet<Record<string, unknown>>(
        `/shipments/${shipment_id}`
      );
      const address = (s.receiver_address ?? {}) as Record<string, unknown>;
      const city = (address.city ?? {}) as { name?: string };
      const state = (address.state ?? {}) as { name?: string };
      const items = Array.isArray(s.shipping_items)
        ? (s.shipping_items as Array<Record<string, unknown>>).map((i) => ({
            id: i.id,
            title: i.description,
            quantity: i.quantity,
          }))
        : [];
      return ok({
        id: s.id,
        status: s.status,
        substatus: s.substatus,
        logistic_type: s.logistic_type,
        tracking_number: s.tracking_number,
        tracking_method: s.tracking_method,
        date_created: s.date_created,
        date_shipped: s.date_shipped,
        date_delivered: s.date_delivered,
        receiver_address: {
          receiver_name: address.receiver_name,
          address_line: address.address_line,
          city: city.name ?? address.city,
          state: state.name ?? address.state,
          zip_code: address.zip_code,
        },
        items,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "get_shipment_label",
  {
    description:
      "Download the Mercado Envios shipping label for a shipment and save it to a local file. Returns the absolute file path and size in bytes so the user can open/print it. The label comes back as PDF (default) or ZPL2 for thermal printers. Gotchas: the label only exists after the shipment is 'ready_to_ship', and some logistic types (e.g. flex / self-service) do not have a printable label — in those cases Meli returns an error, which is surfaced as-is. Shipment ids come from orders (order.shipping.id); call get_orders first if you only have an order id.",
    inputSchema: {
      shipment_id: z
        .number()
        .describe("Numeric shipment id, taken from an order's shipping.id"),
      response_type: z
        .enum(["pdf", "zpl2"])
        .optional()
        .default("pdf")
        .describe("Label format: 'pdf' (default) or 'zpl2' for Zebra thermal printers"),
    },
  },
  async ({ shipment_id, response_type }) => {
    try {
      const { contentType, data } = await meliGetRaw(
        "/shipment_labels",
        { shipment_ids: shipment_id, response_type },
        "application/pdf"
      );
      const ext = response_type === "zpl2" ? "zpl" : "pdf";
      const labelsDir = path.join(rootDir, "labels");
      await mkdir(labelsDir, { recursive: true });
      const filePath = path.join(labelsDir, `label_${shipment_id}.${ext}`);
      await writeFile(filePath, data);
      return ok({
        file_path: filePath,
        size_bytes: data.length,
        content_type: contentType,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Mensagens (pós-venda)
// ---------------------------------------------------------------------------

registerTool(
  "get_order_messages",
  {
    description:
      "Read the post-sale message conversation with the buyer of a specific order. Use this to see what the buyer asked after the purchase (delivery questions, invoice requests, etc.). The pack id in the messaging API equals the order id. Returns each message with sender/recipient (user id + role, e.g. 'buyer'/'seller'), text, date (ISO 8601) and whether it was read. To reply, use send_message with the same order id.",
    inputSchema: {
      order_id: z
        .number()
        .describe("Numeric order id from get_orders"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(20)
        .describe("Max messages to return, 1-50 (default 20)"),
    },
  },
  async ({ order_id, limit }) => {
    try {
      const sellerId = await getMyUserId();
      const data = await meliGet<{
        paging?: { total?: number };
        messages?: Array<Record<string, unknown>>;
      }>(`/messages/packs/${order_id}/sellers/${sellerId}`, { limit });
      const messages = (data.messages ?? []).map((m) => {
        const to = m.to as
          | { user_id?: number; role?: string }
          | Array<{ user_id?: number; role?: string }>
          | undefined;
        return {
          id: m.id,
          from: m.from,
          to,
          text: m.text,
          date: m.date,
          read: Boolean(m.date_read ?? m.read),
        };
      });
      return ok({ total: data.paging?.total ?? messages.length, messages });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "send_message",
  {
    description:
      "Send a post-sale message to the buyer of a specific order — this is a REAL message delivered to the buyer, so confirm the exact text with the user before sending. Only for post-sale communication tied to an order. Important Mercado Livre moderation rules: messages are moderated and must NOT contain contact information — no links, phone numbers, e-mails or social media handles; violations can lead to sanctions on the seller's account, up to suspension. Text is limited to 350 characters. Use get_order_messages first to read the conversation context. Returns the sent message id, moderation status and date.",
    inputSchema: {
      order_id: z
        .number()
        .describe("Numeric order id from get_orders"),
      text: z
        .string()
        .max(350)
        .describe("Message text, max 350 characters; no links, phone numbers or e-mails (moderated)"),
    },
  },
  async ({ order_id, text }) => {
    try {
      if (containsContactInfo(text)) {
        return fail(new Error(CONTACT_INFO_MESSAGE));
      }
      const sellerId = await getMyUserId();
      const order = await meliGet<{ buyer?: { id?: number } }>(
        `/orders/${order_id}`
      );
      const buyerId = order.buyer?.id;
      if (!buyerId) {
        return fail(
          new Error(`Could not find the buyer of order ${order_id}.`)
        );
      }
      const sent = await meliPost<Record<string, unknown>>(
        `/messages/packs/${order_id}/sellers/${sellerId}`,
        { from: { user_id: sellerId }, to: { user_id: buyerId }, text }
      );
      return ok({
        id: sent.id,
        order_id,
        status: sent.status,
        moderation_status: sent.moderation_status,
        date: sent.date,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Reclamações & Devoluções
// ---------------------------------------------------------------------------

registerTool(
  "get_claims",
  {
    description:
      "Search the authenticated seller's claims (reclamações) — buyer complaints opened against sales. Open claims hurt seller reputation and have response deadlines, so use this to find claims needing attention (e.g. status 'opened'). Optional status filter and date range (ISO 8601); results are paginated with limit/offset. Returns a compact list with claim id, type (e.g. 'claim', 'return'), status, stage (e.g. 'claim', 'mediation'), resource_id (the related order id), reason id and creation date. Call get_claim_detail on a claim id for the full picture.",
    inputSchema: {
      status: z
        .string()
        .optional()
        .describe("Claim status filter, e.g. 'opened', 'closed'. Omit to list all"),
      date_from: z
        .string()
        .optional()
        .describe("Only claims created on/after this date (ISO 8601, e.g. '2026-01-01T00:00:00.000-03:00')"),
      date_to: z
        .string()
        .optional()
        .describe("Only claims created on/before this date (ISO 8601)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe("Max claims to return, 1-50 (default 10)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Pagination offset"),
    },
  },
  async ({ status, date_from, date_to, limit, offset }) => {
    try {
      const sellerId = await getMyUserId();
      const data = await meliGet<{
        paging?: { total?: number };
        data?: Array<Record<string, unknown>>;
        results?: Array<Record<string, unknown>>;
      }>("/post-purchase/claims/search", {
        seller_id: sellerId,
        status,
        "date_created.from": date_from,
        "date_created.to": date_to,
        limit,
        offset,
      });
      const raw = data.data ?? data.results ?? [];
      const claims = raw.map((c) => ({
        id: c.id,
        type: c.type,
        status: c.status,
        stage: c.stage,
        resource_id: c.resource_id,
        reason_id: c.reason_id,
        date_created: c.date_created,
      }));
      return ok({ total: data.paging?.total ?? claims.length, claims });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "get_claim_detail",
  {
    description:
      "Get the full details of a single claim (reclamação), including its type, status, stage, reason, related order id, the parties involved (complainant = buyer, respondent = seller), the resolution when the claim is closed, and the recent messages in the claim thread. Use this after get_claims to understand a specific claim before replying with send_claim_message. If the messages endpoint is unavailable, messages are simply omitted — the rest of the detail is still returned.",
    inputSchema: {
      claim_id: z
        .number()
        .describe("Numeric claim id from get_claims"),
    },
  },
  async ({ claim_id }) => {
    try {
      const c = await meliGet<Record<string, unknown>>(
        `/post-purchase/claims/${claim_id}`
      );
      const players = Array.isArray(c.players)
        ? (c.players as Array<Record<string, unknown>>).map((p) => ({
            role: p.role,
            user_id: p.user_id,
            type: p.type,
          }))
        : [];
      const resolution = (c.resolution ?? null) as Record<string, unknown> | null;

      let messages: Array<Record<string, unknown>> | undefined;
      try {
        const raw = await meliGet<unknown>(
          `/post-purchase/claims/${claim_id}/messages`
        );
        const list = Array.isArray(raw)
          ? raw
          : ((raw as { data?: Array<Record<string, unknown>> }).data ?? []);
        messages = (list as Array<Record<string, unknown>>).map((m) => ({
          from: m.sender_role,
          text: m.message,
          date: m.date_created,
        }));
      } catch {
        messages = undefined;
      }

      return ok({
        id: c.id,
        type: c.type,
        status: c.status,
        stage: c.stage,
        reason_id: c.reason_id,
        resource_id: c.resource_id,
        players,
        resolution,
        date_created: c.date_created,
        last_updated: c.last_updated,
        ...(messages !== undefined ? { messages } : {}),
      });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "send_claim_message",
  {
    description:
      "Send a message inside a claim (reclamação) thread as the seller. This is a REAL message visible to the buyer AND to Mercado Livre's mediation team — it becomes part of the claim record, so confirm the exact text with the user before sending. The same moderation rules as buyer messaging apply: no contact information, links, phone numbers or e-mails, under risk of sanctions. Use get_claim_detail first to read the thread context. Returns the created message id and date.",
    inputSchema: {
      claim_id: z
        .number()
        .describe("Numeric claim id from get_claims"),
      text: z
        .string()
        .describe("Message text; visible to buyer and Meli mediation, no contact info or links"),
    },
  },
  async ({ claim_id, text }) => {
    try {
      if (containsContactInfo(text)) {
        return fail(new Error(CONTACT_INFO_MESSAGE));
      }
      const sent = await meliPost<Record<string, unknown>>(
        `/post-purchase/claims/${claim_id}/messages`,
        { sender_role: "respondent", message: text }
      );
      return ok({
        id: sent.id,
        claim_id,
        date_created: sent.date_created,
        status: sent.status,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "get_returns",
  {
    description:
      "List the authenticated seller's product returns (devoluções) — items buyers sent back, usually linked to a claim. Use this to track return requests and their statuses; call get_claim_detail on the linked claim id for the full context and message thread. Returns a compact list with return id, claim id, order id, status and creation date, paginated with limit/offset. Accounts without returns may yield an API error — it is surfaced gracefully instead of crashing.",
    inputSchema: {
      status: z
        .string()
        .optional()
        .describe("Return status filter, e.g. 'opened', 'closed'. Omit to list all"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe("Max returns to return, 1-50 (default 10)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Pagination offset"),
    },
  },
  async ({ status, limit, offset }) => {
    try {
      const sellerId = await getMyUserId();
      const data = await meliGet<{
        paging?: { total?: number };
        data?: Array<Record<string, unknown>>;
        results?: Array<Record<string, unknown>>;
      }>("/post-purchase/returns/search", {
        seller_id: sellerId,
        status,
        limit,
        offset,
      });
      const raw = data.data ?? data.results ?? [];
      const returns = raw.map((r) => ({
        id: r.id,
        claim_id: r.claim_id,
        order_id: r.order_id,
        status: r.status,
        date_created: r.date_created,
      }));
      return ok({ total: data.paging?.total ?? returns.length, returns });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Reputação & Métricas
// ---------------------------------------------------------------------------

registerTool(
  "get_seller_reputation",
  {
    description:
      "Get a seller's reputation profile on Mercado Livre — the authenticated account by default, or any seller by user_id (public data). Use this to check the seller's reputation thermometer and service metrics. The level_id is Meli's color scale: red (1_red) is worst, then orange/yellow/light_green, up to green (5_green) — plus Mercado Líder tiers in power_seller_status (e.g. 'silver', 'gold', 'platinum') for top sellers. Metrics include the rates of claims, delayed handling time and cancellations over the last period; keeping these low is what maintains a green reputation. Returns nickname, registration date, transaction totals (total/completed/canceled) and each metric with its rate and value.",
    inputSchema: {
      user_id: z
        .number()
        .optional()
        .describe("Seller user id; omit to check the authenticated account"),
    },
  },
  async ({ user_id }) => {
    try {
      const id = user_id ?? (await getMyUserId());
      const user = await meliGet<Record<string, unknown>>(`/users/${id}`);
      const rep = (user.seller_reputation ?? {}) as Record<string, unknown>;
      const transactions = (rep.transactions ?? {}) as Record<string, unknown>;
      const metrics = (rep.metrics ?? {}) as Record<string, unknown>;
      const pickMetric = (key: string) => {
        const m = (metrics[key] ?? {}) as Record<string, unknown>;
        return { rate: m.rate, value: m.value, period: m.period };
      };
      return ok({
        user_id: user.id,
        nickname: user.nickname,
        registration_date: user.registration_date,
        level_id: rep.level_id,
        power_seller_status: rep.power_seller_status,
        transactions: {
          total: transactions.total,
          completed: transactions.completed,
          canceled: transactions.canceled,
          period: transactions.period,
        },
        metrics: {
          claims: pickMetric("claims"),
          delayed_handling_time: pickMetric("delayed_handling_time"),
          cancellations: pickMetric("cancellations"),
        },
      });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "get_item_visits",
  {
    description:
      "Get the number of page visits per listing in a date range (defaults to the last 30 days when no dates are given). Use this to measure listing traffic — a powerful combo is get_my_items + get_item_visits to find listings with many views but few or no sales (a sign the price, pictures or listing type may need work). Accepts up to 50 item ids at once; returns one entry per item id with the total visits in the range.",
    inputSchema: {
      item_ids: z
        .array(z.string())
        .min(1)
        .max(50)
        .describe("Item ids (with site prefix, e.g. 'MLB123456789'), max 50"),
      date_from: z
        .string()
        .optional()
        .describe("Start of the range, YYYY-MM-DD. Defaults to 30 days ago"),
      date_to: z
        .string()
        .optional()
        .describe("End of the range, YYYY-MM-DD. Defaults to today"),
    },
  },
  async ({ item_ids, date_from, date_to }) => {
    try {
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      const to = date_to ?? fmt(new Date());
      const from =
        date_from ?? fmt(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000));
      const data = await meliGet<unknown>("/items/visits", {
        ids: item_ids.join(","),
        date_from: from,
        date_to: to,
      });
      // Meli may answer an array of {itemId: visits} objects or a plain map
      let visitsMap: Record<string, number> = {};
      if (Array.isArray(data)) {
        for (const entry of data) {
          if (entry && typeof entry === "object") {
            visitsMap = { ...visitsMap, ...(entry as Record<string, number>) };
          }
        }
      } else if (data && typeof data === "object") {
        visitsMap = data as Record<string, number>;
      }
      const visits = item_ids.map((id) => ({
        item_id: id,
        visits: visitsMap[id] ?? 0,
      }));
      return ok({ date_from: from, date_to: to, visits });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------

registerTool(
  "search_catalog",
  {
    description:
      "Search Mercado Livre's product catalog. Catalog products are shared listings where multiple sellers compete for the buy box on price and reputation — opt-ing into catalog can bring much more traffic than a standalone listing. Use this to find the catalog_product_id for a product you sell, then inspect it with get_catalog_product and link your listing with create_catalog_listing. Returns a compact list with product id, name, thumbnail and main attributes, paginated with limit/offset.",
    inputSchema: {
      query: z
        .string()
        .describe("Product search text, e.g. 'iPhone 13 128GB'"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe("Max results per page, 1-50 (default 10)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Pagination offset"),
    },
  },
  async ({ query, limit, offset }) => {
    try {
      const data = await meliGet<{
        results?: Array<Record<string, unknown>>;
        paging?: { total?: number };
      }>("/products/search", {
        site_id: config.siteId,
        q: query,
        limit,
        offset,
      });
      const products = (data.results ?? []).map((p) => {
        const attributes = Array.isArray(p.attributes)
          ? (p.attributes as Array<Record<string, unknown>>)
              .slice(0, 10)
              .map((a) => ({ id: a.id, name: a.name, value: a.value_name }))
          : [];
        return {
          id: p.id,
          name: p.name,
          thumbnail: p.thumbnail,
          attributes,
        };
      });
      return ok({ total: data.paging?.total ?? products.length, products });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "get_catalog_product",
  {
    description:
      "Get full details of a catalog product, including who is currently winning the buy box (buy_box_winner: price and seller id). Use this after search_catalog to study the competition before linking your listing with create_catalog_listing — the winner's price is the reference your listing must beat (along with reputation and shipping) to take the buy box. Returns name, attributes, picture URLs, main features and the buy box winner when present.",
    inputSchema: {
      product_id: z
        .string()
        .describe("Catalog product id from search_catalog, e.g. 'MLB15171222'"),
    },
  },
  async ({ product_id }) => {
    try {
      const p = await meliGet<Record<string, unknown>>(
        `/products/${product_id}`
      );
      const attributes = Array.isArray(p.attributes)
        ? (p.attributes as Array<Record<string, unknown>>).map((a) => ({
            id: a.id,
            name: a.name,
            value: a.value_name,
          }))
        : [];
      const pictures = Array.isArray(p.pictures)
        ? (p.pictures as Array<{ url?: string }>).map((pic) => pic.url)
        : [];
      const winner = (p.buy_box_winner ?? null) as Record<
        string,
        unknown
      > | null;
      const features = Array.isArray(p.main_features)
        ? (p.main_features as Array<Record<string, unknown>>).map(
            (f) => f.text
          )
        : [];
      return ok({
        id: p.id,
        name: p.name,
        domain_id: p.domain_id,
        attributes,
        pictures,
        main_features: features,
        buy_box_winner: winner
          ? {
              item_id: winner.item_id,
              seller_id: winner.seller_id,
              price: winner.price,
              currency: winner.currency_id,
            }
          : null,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "create_catalog_listing",
  {
    description:
      "Opt one of your EXISTING listings into catalog competition by linking it to a catalog product — this is a real write operation. The listing keeps its identity but starts competing for the buy box under catalog rules: display and sales conditions change (e.g. free-shipping and price rules may differ from a standalone listing). Confirm with the user before calling. Flow: search_catalog → get_catalog_product (check the winner's price) → create_catalog_listing. The item must belong to the authenticated seller and match the catalog product. Returns the linked item id, status and permalink.",
    inputSchema: {
      item_id: z
        .string()
        .describe("Your existing item id (with site prefix), e.g. 'MLB123456789'"),
      catalog_product_id: z
        .string()
        .describe("Catalog product id from search_catalog, e.g. 'MLB15171222'"),
    },
  },
  async ({ item_id, catalog_product_id }) => {
    try {
      const linked = await meliPost<Record<string, unknown>>(
        "/items/catalog_listings",
        { item_id, catalog_id: catalog_product_id }
      );
      return ok({
        id: linked.id ?? item_id,
        catalog_product_id: linked.catalog_product_id ?? catalog_product_id,
        status: linked.status,
        permalink: linked.permalink,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Preço e mercado
// ---------------------------------------------------------------------------

registerTool(
  "get_price_suggestion",
  {
    description:
      "Get Mercado Livre's competitive price suggestion for one of your listings — the price Meli estimates would make the listing more competitive, based on comparable sales. Use it when the user asks whether a listing is priced right or wants to undercut the competition. Gotcha: not every listing has a suggestion (insufficient data); in that case the endpoint returns partial data and whatever comes back is surfaced as-is. Returns current price, suggested price and the basis of the suggestion when present.",
    inputSchema: {
      item_id: z
        .string()
        .describe("Item id with site prefix, e.g. 'MLB123456789'"),
    },
  },
  async ({ item_id }) => {
    try {
      const data = await meliGet<Record<string, unknown>>(
        `/suggestions/items/${item_id}/details`
      );
      return ok({
        item_id,
        current_price: data.current_price ?? null,
        suggested_price: data.suggested_price ?? null,
        basis: data.basis ?? null,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "get_trends",
  {
    description:
      "Get the trending search terms on the marketplace (top searches buyers are making right now). Great for product research and demand discovery; pass a category_id to see niche trends within a specific category (find ids with get_site_categories or predict_category). Returns keyword + URL for each trend, trimmed to the requested limit.",
    inputSchema: {
      category_id: z
        .string()
        .optional()
        .describe("Restrict trends to a category id, e.g. 'MLB1055'. Omit for site-wide top searches"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(20)
        .describe("Max trends to return, 1-50 (default 20)"),
    },
  },
  async ({ category_id, limit }) => {
    try {
      const path = category_id
        ? `/trends/${config.siteId}/${category_id}`
        : `/trends/${config.siteId}`;
      const data = await meliGet<unknown>(path);
      const list = Array.isArray(data)
        ? data
        : ((data as { results?: Array<Record<string, unknown>> }).results ??
          []);
      const trends = (list as Array<Record<string, unknown>>)
        .slice(0, limit)
        .map((t) => ({ keyword: t.keyword, url: t.url }));
      return ok({ site: config.siteId, category_id: category_id ?? null, trends });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "convert_currency",
  {
    description:
      "Get the current Mercado Livre exchange rate between two currencies (e.g. USD → BRL). Useful for cross-border pricing or comparing prices across Meli sites. Returns the conversion ratio and both currency codes.",
    inputSchema: {
      from: z
        .string()
        .describe("Source currency ISO code, e.g. 'USD'"),
      to: z
        .string()
        .describe("Target currency ISO code, e.g. 'BRL'"),
    },
  },
  async ({ from, to }) => {
    try {
      const data = await meliGet<Record<string, unknown>>(
        "/currency_conversions/search",
        { from, to }
      );
      return ok({
        from: data.currency_from ?? from,
        to: data.currency_to ?? to,
        ratio: data.ratio,
        mercado_pago_ratio: data.mercado_pago_ratio ?? null,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Categorias (navegação pela árvore)
// ---------------------------------------------------------------------------

registerTool(
  "get_site_categories",
  {
    description:
      "List the top-level categories of the configured site (MLB by default). This is the entry point for browsing the category tree: pick a category here, then drill down with get_category to reach a leaf category usable in create_item. For a title-driven shortcut to the right leaf category, predict_category is usually faster. Returns a list of {id, name}.",
    inputSchema: {},
  },
  async () => {
    try {
      const data = await meliGet<Array<{ id?: string; name?: string }>>(
        `/sites/${config.siteId}/categories`
      );
      const categories = (Array.isArray(data) ? data : []).map((c) => ({
        id: c.id,
        name: c.name,
      }));
      return ok({ site: config.siteId, categories });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "get_category",
  {
    description:
      "Get details of a category: its name, full path from the root, child categories (to keep drilling down the tree) and the listing settings that apply to it — including constraints relevant BEFORE create_item such as max pictures per item and max description length. A category with no children is a leaf and can be used as category_id in create_item; then call get_category_attributes for its mandatory attributes.",
    inputSchema: {
      category_id: z
        .string()
        .describe("Category id, e.g. 'MLB1055' (from get_site_categories or predict_category)"),
    },
  },
  async ({ category_id }) => {
    try {
      const c = await meliGet<Record<string, unknown>>(
        `/categories/${category_id}`
      );
      const settings = (c.settings ?? {}) as Record<string, unknown>;
      return ok({
        id: c.id,
        name: c.name,
        path_from_root: Array.isArray(c.path_from_root)
          ? (c.path_from_root as Array<Record<string, unknown>>).map((n) => ({
              id: n.id,
              name: n.name,
            }))
          : [],
        children_categories: Array.isArray(c.children_categories)
          ? (c.children_categories as Array<Record<string, unknown>>).map(
              (n) => ({ id: n.id, name: n.name })
            )
          : [],
        total_items_in_this_category: c.total_items_in_this_category,
        settings: {
          max_pictures_per_item: settings.max_pictures_per_item,
          max_description_length: settings.max_description_length,
          max_title_length: settings.max_title_length,
          vip_subdomain: settings.vip_subdomain,
          adult_content: settings.adult_content,
          buying_allowed: settings.buying_allowed,
        },
      });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Perguntas — blacklist
// ---------------------------------------------------------------------------

registerTool(
  "manage_question_blacklist",
  {
    description:
      "Manage the seller's questions blacklist. 'list' shows the blocked users; 'block' prevents a user from asking questions on your listings; 'unblock' reverses it. Use 'block' only for abusive users — note this ONLY blocks new questions from that user; they can still buy from you, and blocking/unblocking is a real change to the account, so confirm with the user first. Get user ids from buyers' questions (get_questions) or orders.",
    inputSchema: {
      action: z
        .enum(["list", "block", "unblock"])
        .describe("What to do: 'list' (read-only), 'block' or 'unblock' a user"),
      user_id: z
        .number()
        .optional()
        .describe("User id to block/unblock (required for those actions; ignored for 'list')"),
    },
  },
  async ({ action, user_id }) => {
    try {
      if (safety.readOnly && action !== "list") {
        return fail(
          new Error(
            `Read-only mode (ML_READ_ONLY=true): action '${action}' is not allowed; only 'list' is available.`
          )
        );
      }
      const sellerId = await getMyUserId();
      if (action === "list") {
        const data = await meliGet<Record<string, unknown>>(
          `/users/${sellerId}/questions_blacklist`
        );
        const users = Array.isArray(data.users)
          ? (data.users as Array<Record<string, unknown>>).map((u) => ({
              id: u.id,
              nickname: u.nickname,
            }))
          : [];
        return ok({ blocked_users: users });
      }
      if (user_id === undefined) {
        return fail(
          new Error(`user_id is required for the '${action}' action.`)
        );
      }
      if (action === "block") {
        await meliPost<unknown>(
          `/users/${user_id}/questions_blacklist`,
          undefined,
          { seller_id: sellerId }
        );
        return ok({ action, user_id, blocked: true });
      }
      await meliDelete<unknown>(`/users/${user_id}/questions_blacklist`, {
        seller_id: sellerId,
      });
      return ok({ action, user_id, blocked: false });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Promoções
// ---------------------------------------------------------------------------

registerTool(
  "get_promotions",
  {
    description:
      "List the promotions/campaigns Mercado Livre offers to the authenticated seller (daily deals, lightning deals, etc.) — both campaigns you can join (status 'candidate') and ones already running ('started'). Use this to discover discount opportunities, then inspect participants with get_promotion_items or join with add_item_to_promotion. May legitimately return an empty list when there are no active campaigns for the account. Returns a compact list with id, type, status, title and start/finish dates, paginated with limit/offset.",
    inputSchema: {
      status: z
        .string()
        .optional()
        .describe("Promotion status filter, e.g. 'candidate' (can join) or 'started' (running). Omit to list all"),
      promotion_type: z
        .string()
        .optional()
        .describe("Promotion type filter, e.g. 'DEAL', 'LIGHTNING'. Omit to list all types"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe("Max promotions to return, 1-50 (default 10)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Pagination offset"),
    },
  },
  async ({ status, promotion_type, limit, offset }) => {
    try {
      const sellerId = await getMyUserId();
      const data = await meliGet<{
        paging?: { total?: number };
        results?: Array<Record<string, unknown>>;
      }>("/seller-promotions/promotions", {
        seller_id: sellerId,
        status,
        promotion_type,
        limit,
        offset,
      });
      const promotions = (data.results ?? []).map((p) => ({
        id: p.id,
        type: p.type,
        status: p.status,
        title: p.title ?? p.name,
        start_date: p.start_date,
        finish_date: p.finish_date,
      }));
      return ok({
        total: data.paging?.total ?? promotions.length,
        promotions,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "get_promotion_items",
  {
    description:
      "List the items already participating in a specific promotion campaign, with their promotional price, original price and status. Use this to check which of your items are in a campaign (and at what price) after adding them with add_item_to_promotion, or to audit active discounts. Get the promotion_id from get_promotions. Paginated with limit/offset.",
    inputSchema: {
      promotion_id: z
        .string()
        .describe("Promotion id from get_promotions"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(20)
        .describe("Max items to return, 1-50 (default 20)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Pagination offset"),
    },
  },
  async ({ promotion_id, limit, offset }) => {
    try {
      const sellerId = await getMyUserId();
      const data = await meliGet<{
        paging?: { total?: number };
        results?: Array<Record<string, unknown>>;
      }>(`/seller-promotions/promotions/${promotion_id}/items`, {
        seller_id: sellerId,
        limit,
        offset,
      });
      const items = (data.results ?? []).map((i) => ({
        item_id: i.item_id ?? i.id,
        price: i.price,
        original_price: i.original_price,
        status: i.status,
      }));
      return ok({ total: data.paging?.total ?? items.length, items });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "add_item_to_promotion",
  {
    description:
      "Submit one of your items to a promotion campaign with the offered deal price — this is a REAL write operation: if Meli approves, the item starts being sold at the promotional price for the campaign duration. Confirm the price with the user before calling. Flow: get_promotions (find a 'candidate' campaign) → add_item_to_promotion with the deal_price within the campaign's allowed range. Returns the submission result with item id and status.",
    inputSchema: {
      item_id: z
        .string()
        .describe("Your item id (with site prefix), e.g. 'MLB123456789'"),
      promotion_id: z
        .string()
        .describe("Promotion id from get_promotions"),
      deal_price: z
        .number()
        .positive()
        .describe("Promotional price offered for the item during the campaign"),
      top_deal_price: z
        .number()
        .positive()
        .optional()
        .describe("Optional lower price for extra exposure within the campaign (top deal)"),
    },
  },
  async ({ item_id, promotion_id, deal_price, top_deal_price }) => {
    try {
      const sellerId = await getMyUserId();
      const body: Record<string, unknown> = { promotion_id, deal_price };
      if (top_deal_price !== undefined) body.top_deal_price = top_deal_price;
      const result = await meliPost<Record<string, unknown>>(
        `/seller-promotions/items/${item_id}`,
        body,
        { seller_id: sellerId }
      );
      return ok({
        item_id: result.item_id ?? item_id,
        promotion_id,
        price: result.price ?? deal_price,
        status: result.status,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Mercado Ads (Product Ads)
// ---------------------------------------------------------------------------

registerTool(
  "get_ads_campaigns",
  {
    description:
      "List the seller's Mercado Ads (Product Ads) campaigns. Use this for advertising questions: which campaigns exist, their status, daily budget and bidding strategy. Gotcha: this requires the advertising scope granted to the app and an active ads account — if either is missing, Meli answers with a scope/permission error, which is surfaced clearly so you know the feature isn't available. Get campaign ids here, then check performance with get_ads_campaign_metrics. Returns a compact list with campaign id, name, status, budget and strategy.",
    inputSchema: {
      status: z
        .string()
        .optional()
        .describe("Campaign status filter, e.g. 'active', 'paused'. Omit to list all"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(20)
        .describe("Max campaigns to return, 1-50 (default 20)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Pagination offset"),
    },
  },
  async ({ status, limit, offset }) => {
    try {
      const sellerId = await getMyUserId();
      const data = await meliGet<{
        paging?: { total?: number };
        results?: Array<Record<string, unknown>>;
      }>("/advertising/product_ads/campaigns", {
        user_id: sellerId,
        status,
        limit,
        offset,
      });
      const campaigns = (data.results ?? []).map((c) => ({
        id: c.id,
        name: c.name ?? c.title,
        status: c.status,
        budget: c.budget ?? c.daily_budget,
        strategy: c.strategy ?? c.bidding_strategy,
      }));
      return ok({
        total: data.paging?.total ?? campaigns.length,
        campaigns,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "get_ads_campaign_metrics",
  {
    description:
      "Get performance metrics of a Mercado Ads campaign over a date range (defaults to the last 30 days): impressions, clicks, CTR, cost, attributed sales and ACOS when present. Use this to evaluate ad spend efficiency — a high ACOS means advertising costs eat a large share of the revenue it generates. Get campaign ids from get_ads_campaigns. Requires the advertising scope; scope errors are surfaced clearly. Date format: YYYY-MM-DD.",
    inputSchema: {
      campaign_id: z
        .number()
        .describe("Campaign id from get_ads_campaigns"),
      date_from: z
        .string()
        .optional()
        .describe("Start of the range, YYYY-MM-DD. Defaults to 30 days ago"),
      date_to: z
        .string()
        .optional()
        .describe("End of the range, YYYY-MM-DD. Defaults to today"),
    },
  },
  async ({ campaign_id, date_from, date_to }) => {
    try {
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      const to = date_to ?? fmt(new Date());
      const from =
        date_from ?? fmt(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000));
      const data = await meliGet<Record<string, unknown>>(
        `/advertising/product_ads/campaigns/${campaign_id}/metrics`,
        { date_from: from, date_to: to }
      );
      const m = ((data.metrics ?? data.summary ?? data) ?? {}) as Record<
        string,
        unknown
      >;
      return ok({
        campaign_id,
        date_from: from,
        date_to: to,
        impressions: m.impressions,
        clicks: m.clicks,
        ctr: m.ctr,
        cost: m.cost,
        sales: m.sales ?? m.sales_quantity,
        revenue: m.revenue ?? m.sales_amount,
        acos: m.acos,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Fulfillment (Full)
// ---------------------------------------------------------------------------

registerTool(
  "get_fulfillment_stock",
  {
    description:
      "List the seller's stock stored at Mercado Livre fulfillment centers (Full), with available and non-sellable (e.g. damaged) quantities. Use this for inventory questions about Full — for regular (seller-shipped) stock use get_my_items/get_item instead. Gotcha: this only works for accounts enrolled in Full; otherwise Meli answers with an error, which is surfaced clearly.",
    inputSchema: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(50)
        .describe("Max stock entries to return, 1-100 (default 50)"),
    },
  },
  async ({ limit }) => {
    try {
      const sellerId = await getMyUserId();
      const data = await meliGet<{
        inventory?: Array<Record<string, unknown>>;
        results?: Array<Record<string, unknown>>;
      }>("/fulfillment/stock", { seller_id: sellerId, limit });
      const raw = data.inventory ?? data.results ?? [];
      const stock = raw.map((s) => ({
        inventory_id: s.inventory_id ?? s.id,
        seller_sku: s.seller_sku ?? s.sku,
        available_quantity: s.available_quantity,
        damaged_quantity: s.damaged_quantity ?? null,
        not_sellable_quantity: s.not_sellable_quantity ?? null,
      }));
      return ok({ total: stock.length, stock });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Mercado Shops & Depósitos
// ---------------------------------------------------------------------------

registerTool(
  "get_mercado_shop",
  {
    description:
      "Get the seller's Mercado Shop info (id, name, URL, status) if the account has one. Mercado Shops is an optional storefront feature — accounts without a shop get a graceful 'no shop' response instead of a hard error. Use this when the user asks about their store page or wants the shop URL.",
    inputSchema: {},
  },
  async () => {
    try {
      const sellerId = await getMyUserId();
      try {
        const shop = await meliGet<Record<string, unknown>>(
          `/users/${sellerId}/shop`
        );
        return ok({
          shop_id: shop.shop_id ?? shop.id,
          name: shop.name ?? shop.shop_name,
          url: shop.url ?? shop.permalink,
          status: shop.status,
        });
      } catch (firstErr) {
        try {
          const data = await meliGet<{
            results?: Array<Record<string, unknown>>;
          }>("/shops/search", { seller_id: sellerId });
          const shop = (data.results ?? [])[0];
          if (!shop) {
            return ok({
              shop: null,
              message: "This account does not have a Mercado Shop.",
            });
          }
          return ok({
            shop_id: shop.shop_id ?? shop.id,
            name: shop.name ?? shop.shop_name,
            url: shop.url ?? shop.permalink,
            status: shop.status,
          });
        } catch {
          return ok({
            shop: null,
            message: `This account does not appear to have a Mercado Shop (${
              firstErr instanceof Error ? firstErr.message : String(firstErr)
            }).`,
          });
        }
      }
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "get_warehouses",
  {
    description:
      "List the seller's registered warehouses (multi-origin stock locations / depósitos) with their ids, descriptions and addresses. Useful for accounts shipping from multiple addresses and for setting up shipping options per origin. Accounts without registered warehouses get an empty list or a clear API error.",
    inputSchema: {},
  },
  async () => {
    try {
      const sellerId = await getMyUserId();
      const data = await meliGet<unknown>("/user-warehouses", {
        seller_id: sellerId,
      });
      const list = Array.isArray(data)
        ? data
        : ((data as { results?: Array<Record<string, unknown>> }).results ??
          []);
      const warehouses = (list as Array<Record<string, unknown>>).map((w) => {
        const address = (w.address ?? {}) as Record<string, unknown>;
        return {
          id: w.id ?? w.warehouse_id,
          description: w.description ?? w.name,
          city: address.city,
          state: address.state,
          stock_location: w.stock_location ?? null,
        };
      });
      return ok({ total: warehouses.length, warehouses });
    } catch (err) {
      return fail(err);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("MCP Mercado Livre server running on stdio");
