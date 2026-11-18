import Feather from "@expo/vector-icons/Feather";
import { AccessibilityInfo, Pressable, StyleSheet, View } from "react-native";
import DraggableFlatList, { ScaleDecorator, type RenderItemParams } from "react-native-draggable-flatlist";

import { catalogItemKey, type CatalogOrderProduct } from "@/src/services/catalogService";
import { colors, radius, spacing } from "@/src/theme/tokens";

import { moveCatalogProduct, type CatalogReorderListProps } from "./CatalogReorderList.shared";

export function CatalogReorderList({ products, onReorder, renderCard, disabled }: CatalogReorderListProps) {
  const move = (from: number, to: number) => {
    if (disabled) return;
    const next = moveCatalogProduct(products, from, to);
    if (next === products) return;
    onReorder(next);
    AccessibilityInfo.announceForAccessibility(`${next[to].name} moved to position ${to + 1} of ${next.length}.`);
  };

  const renderItem = ({ item, drag, isActive, getIndex }: RenderItemParams<CatalogOrderProduct>) => {
    const index = getIndex() ?? -1;
    const actions = [
      ...(index > 0 ? [{ name: "moveUp", label: "Move up" }] : []),
      ...(index >= 0 && index < products.length - 1 ? [{ name: "moveDown", label: "Move down" }] : []),
    ];
    return (
      <ScaleDecorator activeScale={1.025}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Reorder ${item.name}`}
          accessibilityHint="Hold the card to drag. Use accessibility actions to move up or down."
          accessibilityActions={actions}
          onAccessibilityAction={({ nativeEvent }) => {
            if (nativeEvent.actionName === "moveUp") move(index, index - 1);
            if (nativeEvent.actionName === "moveDown") move(index, index + 1);
          }}
          disabled={disabled}
          onLongPress={drag}
          delayLongPress={260}
          style={[styles.row, isActive && styles.active]}
          testID={`catalog-drag-${item.id}`}
        >
          <Feather name="menu" color={colors.onSurfaceSecondary} size={17} />
          <View style={styles.card} pointerEvents="none">{renderCard(item)}</View>
        </Pressable>
      </ScaleDecorator>
    );
  };

  return (
    <DraggableFlatList
      data={products}
      keyExtractor={catalogItemKey}
      onDragEnd={({ from, to }) => move(from, to)}
      renderItem={renderItem}
      style={styles.list}
      containerStyle={styles.list}
      contentContainerStyle={styles.content}
      activationDistance={8}
      autoscrollThreshold={58}
      keyboardShouldPersistTaps="handled"
      testID="catalog-reorder-list"
    />
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, minHeight: 0 },
  content: { padding: spacing.s12, gap: spacing.s8 },
  row: {
    flexDirection: "row", alignItems: "center", gap: spacing.s8,
    backgroundColor: colors.surfaceSecondary, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, padding: spacing.s4,
  },
  active: { borderColor: colors.brand, backgroundColor: colors.brandTint },
  card: { flex: 1, minWidth: 0 },
});
