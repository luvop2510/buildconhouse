import type { ReactNode } from "react";
import DraggableFlatList, { RenderItemParams } from "react-native-draggable-flatlist";

import { spacing } from "@/src/theme/tokens";
import { useBuilder } from "../context/BuilderContext";
import type { BuilderRow } from "../helpers/types";
import { EmptyRoom } from "./EmptyRoom";
import { LineRow } from "./LineRow";
import { RoomHeaderRow } from "./RoomHeaderRow";

type ProductRow = Extract<BuilderRow, { kind: "line" }>;

export function QuotationCanvas({ compact = false, scrollHeader }: { compact?: boolean; scrollHeader?: ReactNode }) {
  const b = useBuilder();
  const header = b.flatRows.find(row => row.kind === "room-header");
  const products = b.flatRows.filter((row): row is ProductRow => row.kind === "line");

  const renderItem = ({ item, drag, isActive }: RenderItemParams<ProductRow>) => (
    <LineRow line={item.line} drag={drag} isActive={isActive} catDiscs={b.s.categoryDiscounts}
      projDisc={b.s.projectDiscount} roomDiscs={b.s.roomDiscounts} compact={compact} />
  );

  return (
    <DraggableFlatList
      ListHeaderComponent={<>{scrollHeader}{header ? <RoomHeaderRow key={header.id} {...header} /> : null}</>}
      ListEmptyComponent={<EmptyRoom compact={compact} />}
      data={products}
      keyExtractor={row => row.id}
      onDragEnd={b.onLinesDragEnd}
      renderItem={renderItem}
      style={{ flex: 1, minHeight: 0 }}
      containerStyle={{ flex: 1, minHeight: 0, overflow: "hidden" }}
      contentContainerStyle={{ paddingHorizontal: compact ? spacing.xxl : spacing.md, paddingTop: spacing.md, gap: 6, paddingBottom: 32 }}
      activationDistance={10}
      keyboardShouldPersistTaps="handled"
      testID="receipt-list"
    />
  );
}
