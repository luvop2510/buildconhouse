import type { DocumentPickerAsset } from "expo-document-picker";
import { Platform } from "react-native";

import { api } from "@/src/api/client";

export type CatalogueOperation = "add" | "prices" | "update" | "sync" | "images";
export type CatalogueBrand = { id: string; name: string };
export type CatalogueCategory = CatalogueBrand & { brand_id?: string | null };
export type CatalogueProduct = CatalogueBrand & {
  listing_id?: string | null;
  sku: string;
  brand_id: string;
  category_id: string;
  finish?: string | null;
  size?: string | null;
  mrp: number;
  price: number;
};
export type CatalogueOptions = {
  capabilities: string[];
  brands: CatalogueBrand[];
  categories: CatalogueCategory[];
  part_bytes: number;
  max_bytes: number;
};
export type CatalogueJobRow = {
  row: number;
  sheet?: string | null;
  sku?: string | null;
  action?: string;
  delta?: Record<string, unknown>;
  previous_mrp?: number | null;
  errors?: string[];
  error?: string | null;
  outcome?: string;
};
export type CatalogueJob = {
  id: string;
  status: string;
  operation: CatalogueOperation;
  filename: string;
  size_bytes?: number;
  brand_id?: string | null;
  brand_name?: string | null;
  created_at?: string;
  created_by?: string;
  failed_phase?: string;
  summary?: Record<string, number>;
  result?: Record<string, number>;
  warnings?: string[];
  error?: string | null;
  rows?: CatalogueJobRow[];
  assets_to_attach?: number;
  categories_to_create?: number;
  missing_from_source_total?: number;
  stage?: string;
  processed_through?: number;
  total_rows?: number;
  rollback_result?: Record<string, number>;
};
export type CatalogueJobInput = {
  key: string;
  brand_id?: string;
  brand_name?: string;
  create_brand?: boolean;
  create_categories?: boolean;
  operation: CatalogueOperation;
  filename: string;
  size_bytes: number;
};
type ProductInput = {
  brand_id: string;
  category_id: string;
  sku: string;
  name: string;
  mrp: number;
  price?: number;
  finish?: string;
  size?: string;
  specs?: Record<string, string | number>;
};

export function cataloguePath(floorId: string, route: string, query: Record<string, string> = {}) {
  return `/catalog/management${route}?${new URLSearchParams({ ...query, floor_id: floorId })}`;
}

export function catalogueApi(floorId: string, activeFloorId: string, signal?: AbortSignal) {
  const path = (route: string) => cataloguePath(floorId, route);
  const options = { floorId: activeFloorId, signal, cacheMs: 0 };
  const job = (id: string) => `/jobs/${encodeURIComponent(id)}`;
  return {
    options: () => api.get<CatalogueOptions>(path("/options"), options),
    products: (filters: Record<string, string>, signal: AbortSignal) => api.get<{
      total: number; items: CatalogueProduct[]; next_skip: number | null;
    }>(cataloguePath(floorId, "/products", filters), { ...options, signal }),
    history: () => api.get<CatalogueJob[]>(path("/jobs"), options),
    job: (id: string, offset = 0) => api.get<CatalogueJob>(cataloguePath(floorId, job(id), { offset: String(offset), limit: "50" }), options),
    createBrand: (name: string) => api.post<CatalogueBrand>(path("/brands"), { name }, options),
    createCategory: (brand_id: string, name: string) => api.post<CatalogueCategory>(path("/categories"), { brand_id, name }, options),
    createProduct: (input: ProductInput) => api.post<{ id: string }>(path("/products"), input, options),
    start: (input: CatalogueJobInput) => api.post<CatalogueJob>(path("/jobs"), input, options),
    putPart: (id: string, index: number, data_base64: string) => api.put(path(`${job(id)}/parts/${index}`), { data_base64 }, options),
    command: (id: string, action: "preview" | "apply" | "resume" | "rollback") =>
      api.post<CatalogueJob>(path(`${job(id)}/${action}`), {}, options),
  };
}

export async function sendCatalogueParts(
  asset: DocumentPickerAsset,
  bytesPerPart: number,
  signal: AbortSignal,
  send: (index: number, data: string) => Promise<unknown>,
  progress: (percent: number) => void,
) {
  const { file, size } = asset;
  if (!size || !Number.isSafeInteger(bytesPerPart) || bytesPerPart <= 0 || bytesPerPart > 512 * 1024) {
    throw new Error("The workbook upload settings are invalid. Reload this page before trying again.");
  }
  const native = Platform.OS === "web" ? undefined : new (await import("expo-file-system")).File(asset.uri);
  if (!native && !file) throw new Error("Choose the workbook again to give the app access to the file.");
  for (let offset = 0, index = 0; offset < size; offset += bytesPerPart, index += 1) {
    if (signal.aborted) return;
    const end = Math.min(offset + bytesPerPart, size);
    let bytes: Uint8Array;
    if (native) {
      const handle = native.open();
      try {
        handle.offset = offset;
        bytes = handle.readBytes(end - offset);
      } finally { handle.close(); }
    } else {
      bytes = new Uint8Array(await file!.slice(offset, end).arrayBuffer());
    }
    if (bytes.length !== end - offset) throw new Error("The workbook changed. Select the original file to resume the upload.");
    if (signal.aborted) return;
    let binary = "";
    for (let i = 0; i < bytes.length; i += 4096) binary += String.fromCharCode(...bytes.subarray(i, i + 4096));
    await send(index, btoa(binary));
    if (!signal.aborted) progress(Math.round(end / size * 100));
  }
}
