import type { ReactNode } from "react";

import type { Product } from "../helpers/types";

export type CatalogReorderListProps = {
  products: Product[];
  onReorder: (products: Product[]) => void;
  renderCard: (product: Product) => ReactNode;
  columns: number;
  disabled?: boolean;
};

export function moveCatalogProduct(products: Product[], from: number, to: number): Product[] {
  if (from === to || from < 0 || from >= products.length || to < 0 || to >= products.length) {
    return products;
  }
  const next = [...products];
  const [product] = next.splice(from, 1);
  next.splice(to, 0, product);
  return next;
}
