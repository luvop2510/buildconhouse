import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/src/api/client";
import {
  CATALOG_PAGE_SIZE, fetchCatalogPage, getCatalogProductOrder, saveCatalogProductOrder,
  type CatalogOrderScope,
} from "@/src/services/catalogService";
import { familyCardToProduct, type CatalogFamily } from "../context/BuilderContext";
import type { Product } from "../helpers/types";

type Draft = {
  scopeKey: string;
  version: number | null;
  products: Product[];
  phase: "loading" | "ready" | "saving";
  error?: string;
  reloadRequired?: boolean;
};

type Operation = { scopeKey: string; read?: AbortController };

async function loadOrderProducts(scope: CatalogOrderScope, version: number, signal: AbortSignal) {
  const products: Product[] = [];
  const seen = new Set<string>();
  let total: number | undefined;
  let skip = 0;
  do {
    const page = await fetchCatalogPage<CatalogFamily>({
      mode: "families", sort: "default", brandId: scope.brandId, categoryId: scope.categoryId,
    }, skip, CATALOG_PAGE_SIZE, { floorId: scope.floorId, signal });
    if ((total !== undefined && page.total !== total)
        || (page.order_version !== undefined && page.order_version !== version)
        || (!page.items.length && skip < page.total)) {
      throw new Error("The catalog changed while loading. Reload the order and try again.");
    }
    total = page.total;
    for (const family of page.items) {
      const product = familyCardToProduct(family);
      if (!product || seen.has(product.id)) throw new Error("The catalog changed while loading. Reload the order and try again.");
      seen.add(product.id);
      products.push(product);
    }
    skip += page.items.length;
  } while (skip < total);
  return products;
}

export function useCatalogProductOrder(scope: CatalogOrderScope | null, onSaved: () => void) {
  const scopeKey = scope ? JSON.stringify([scope.floorId, scope.brandId, scope.categoryId]) : "";
  const [permission, setPermission] = useState<{ scopeKey: string; allowed: boolean } | null>(null);
  const [openDraft, setOpenDraft] = useState<Draft | null>(null);
  const operation = useRef<Operation | null>(null);
  const draft = openDraft?.scopeKey === scopeKey ? openDraft : null;
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;

  useEffect(() => {
    if (!scope) return;
    const controller = new AbortController();
    void getCatalogProductOrder(scope, controller.signal).then(({ can_reorder }) => {
      if (!controller.signal.aborted) setPermission({ scopeKey, allowed: can_reorder });
    }).catch(() => {
      if (!controller.signal.aborted) setPermission({ scopeKey, allowed: false });
    });
    return () => {
      controller.abort();
      if (operation.current?.scopeKey === scopeKey) {
        operation.current.read?.abort();
        operation.current = null;
      }
      setOpenDraft((current) => current?.scopeKey === scopeKey ? null : current);
    };
  }, [scope, scopeKey]);

  const canReorder = permission?.scopeKey === scopeKey && permission.allowed;

  const start = useCallback(async () => {
    if (!scope || !canReorder || operation.current) return;
    const read = new AbortController();
    const request = { scopeKey, read };
    operation.current = request;
    setOpenDraft({ scopeKey, version: null, products: [], phase: "loading" });
    try {
      const initial = await getCatalogProductOrder(scope, read.signal);
      if (!initial.can_reorder) throw new Error("You no longer have permission to reorder these products.");
      const products = await loadOrderProducts(scope, initial.version, read.signal);
      if (operation.current === request && currentScope.current === scopeKey) {
        setOpenDraft({ scopeKey, version: initial.version, products, phase: "ready" });
      }
    } catch (error) {
      if (operation.current === request && currentScope.current === scopeKey) {
        setOpenDraft({ scopeKey, version: null, products: [], phase: "ready", reloadRequired: true,
          error: error instanceof Error ? error.message : "Could not load the catalog order." });
      }
    } finally {
      if (operation.current === request) operation.current = null;
    }
  }, [scope, scopeKey, canReorder]);

  const cancel = useCallback(() => {
    if (operation.current && !operation.current.read) return;
    operation.current?.read?.abort();
    operation.current = null;
    setOpenDraft(null);
  }, []);

  const reorder = useCallback((products: Product[]) => {
    setOpenDraft((current) => current?.scopeKey === scopeKey && current.phase === "ready"
      ? { ...current, products } : current);
  }, [scopeKey]);

  const save = useCallback(async () => {
    if (!scope || !draft || draft.phase !== "ready" || draft.version === null
        || draft.reloadRequired || !draft.products.length || operation.current) return;
    const request = { scopeKey };
    operation.current = request;
    setOpenDraft({ ...draft, phase: "saving", error: undefined });
    try {
      await saveCatalogProductOrder(scope, draft.version, draft.products.map((product) => product.id));
      if (operation.current === request && currentScope.current === scopeKey) {
        setOpenDraft(null);
        onSaved();
      }
    } catch (error) {
      if (operation.current === request && currentScope.current === scopeKey) {
        const conflict = error instanceof ApiError && error.status === 409;
        setOpenDraft({ ...draft, phase: "ready", reloadRequired: conflict,
          error: error instanceof Error ? error.message : "Could not save the catalog order." });
      }
    } finally {
      if (operation.current === request) operation.current = null;
    }
  }, [scope, scopeKey, draft, onSaved]);

  return { canReorder, draft, start, cancel, reorder, save };
}
