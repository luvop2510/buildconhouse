import type { ReactNode } from "react";

import type { CatalogOrderProduct } from "@/src/services/catalogService";

export type CatalogReorderListProps = {
  products: CatalogOrderProduct[];
  onReorder: (products: CatalogOrderProduct[]) => void;
  renderCard: (product: CatalogOrderProduct) => ReactNode;
  columns: number;
  disabled?: boolean;
};

export function moveCatalogProduct(products: CatalogOrderProduct[], from: number, to: number): CatalogOrderProduct[] {
  if (from === to || from < 0 || from >= products.length || to < 0 || to >= products.length) {
    return products;
  }
  const next = [...products];
  const [product] = next.splice(from, 1);
  next.splice(to, 0, product);
  return next;
}
