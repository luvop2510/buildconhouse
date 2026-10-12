// Shared catalog data service.
// -----------------------------------------------------------------------------
// Catalog, Quotation Builder and any future product picker use this single
// pagination/filter/cache contract. Requests are de-duplicated, successful
// pages/reference data are cached briefly, and pagination is merged by product
// identity so repeated onEndReached events cannot introduce duplicates.
import { api, clearApiResponseCache } from "@/src/api/client";

export const CATALOG_PAGE_SIZE = 60;
export type CatalogSort = "source" | "popular" | "recent" | "price_asc" | "price_desc" | "name";
export type CatalogEntry = {
  entry_id: string; source_catalog: string; sheet_name: string;
  sheet_order: number; row_number: number; source_order: number;
  serial_number?: string | number | null; category_id: string; category_name: string;
  source_sku?: string | null; subcategory?: string | null;
  mrp?: number | null; price_status: "known" | "unspecified";
  name?: string | null; description?: string | null; source_status_note?: string | null;
  source_cells?: Record<string, unknown>;
};
export type CatalogMode = "products" | "families";

export type CatalogQuery = {
  mode?: CatalogMode;
  q?: string;
  brandId?: string | null;
  brandIds?: string[];
  categoryIds?: string[];
  subcategories?: string[];
  seriesValues?: string[];
  finishes?: string[];
  colours?: string[];
  sizes?: string[];
  categoryId?: string | null;
  subcategory?: string | null;
  series?: string | null;
  sort?: CatalogSort;
};

export type CatalogPage<T> = { total: number; items: T[] };
export type CatalogRequestOptions = { floorId?: string; signal?: AbortSignal };

const PAGE_TTL_MS = 60_000;
const REFERENCE_TTL_MS = 5 * 60_000;

function stableParams(query: CatalogQuery, skip: number, limit: number): URLSearchParams {
  const p = new URLSearchParams();
  p.set("limit", String(limit));
  p.set("skip", String(skip));
  if (query.mode !== "families") p.set("sort", query.sort || "popular");
  if (query.q?.trim()) p.set("q", query.q.trim());
  if (query.brandId) p.set("brand_id", query.brandId);
  if (query.categoryId) p.set("category_id", query.categoryId);
  if (query.subcategory) p.set("subcategory", query.subcategory);
  if (query.series) p.set("series", query.series);
  for (const [key, values] of Object.entries({ brand_ids: query.brandIds, category_ids: query.categoryIds,
    subcategories: query.subcategories, series_values: query.seriesValues, finishes: query.finishes,
    colours: query.colours, sizes: query.sizes })) {
    for (const value of [...new Set(values || [])].sort()) p.append(key, value);
  }
  return p;
}

async function cachedGet<T>(path: string, ttlMs: number, options?: CatalogRequestOptions): Promise<T> {
  // The API cache includes the active floor in its key. A path-only cache here
  // used to show the previous floor's catalog after switching business units.
  return api.get<T>(path, { ...options, cacheMs: ttlMs });
}

export function catalogQueryKey(query: CatalogQuery): string {
  return stableParams(query, 0, CATALOG_PAGE_SIZE).toString();
}

export async function fetchCatalogPage<T>(
  query: CatalogQuery,
  skip = 0,
  limit = CATALOG_PAGE_SIZE,
  options?: CatalogRequestOptions,
): Promise<CatalogPage<T>> {
  const params = stableParams(query, skip, limit);
  const endpoint = query.mode === "families" ? "/products/families" : "/products";
  return cachedGet<CatalogPage<T>>(`${endpoint}?${params.toString()}`, PAGE_TTL_MS, options);
}

type CatalogIdentity = {
  id?: string; family_key?: string | null; listing_id?: string | null;
  sample_product_id?: string; floor_id?: string | null;
  brand_id?: string | null; category_id?: string | null;
};

export function catalogItemKey(item: CatalogIdentity): string {
  if (item.listing_id) return JSON.stringify(['listing', item.listing_id]);
  if (item.id) return JSON.stringify(['product', item.id]);
  // Match the backend family card contract: supplier keys are only unique
  // within a floor, brand and category. A sample product may change on refresh.
  return JSON.stringify(['family', item.floor_id || '', item.brand_id || '',
    item.category_id || '', item.family_key ? ['key', item.family_key] : ['solo', item.sample_product_id || '']]);
}

export function mergeCatalogPage<T extends CatalogIdentity>(
  current: T[],
  incoming: T[],
): T[] {
  const seen = new Set(current.map(catalogItemKey));
  const next = [...current];
  for (const item of incoming) {
    if (!item.listing_id && !item.id && !item.family_key && !item.sample_product_id) continue;
    const key = catalogItemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(item);
  }
  return next;
}

export const catalogReferences = {
  brands: <T>(options?: CatalogRequestOptions) => cachedGet<T>("/brands", REFERENCE_TTL_MS, options),
  categories: <T>(brandId?: string | null, options?: CatalogRequestOptions) => cachedGet<T>(
    brandId ? `/categories?brand_id=${encodeURIComponent(brandId)}` : "/categories",
    REFERENCE_TTL_MS,
    options,
  ),
  hierarchy: <T>(options?: CatalogRequestOptions) => cachedGet<T>("/catalog/hierarchy", REFERENCE_TTL_MS, options),
};

export function clearCatalogCache(): void {
  clearApiResponseCache();
}
