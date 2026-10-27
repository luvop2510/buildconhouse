/** Column widths exclude the row's shared gutters and inter-column gaps. */
export type TableColumn = { label: string; flex?: number; width?: number; align?: "left" | "right" | "center" };
export function tableMinWidth(columns: readonly TableColumn[], gap: number, padding: number) {
  return columns.reduce((sum, column) => sum + (column.width ?? 120 * (column.flex ?? 1)), 0)
    + Math.max(0, columns.length - 1) * gap + padding * 2;
}
export function tableColumnLayout(column: Pick<TableColumn, "width" | "flex">) {
  return column.width !== undefined
    ? { width: column.width, flexGrow: 0, flexShrink: 0, minWidth: 0 }
    : { flexBasis: 0, flexGrow: column.flex ?? 1, flexShrink: 1, minWidth: 0 };
}

/** Handle only the scroll region itself; child links, fields and shortcuts keep their keys. */
export function handleTableScrollKey(event: {
  key: string; target: unknown; currentTarget: { scrollLeft: number; scrollWidth: number; clientWidth: number };
  altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; preventDefault: () => void;
}) {
  if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const region = event.currentTarget;
  const end = Math.max(0, region.scrollWidth - region.clientWidth);
  const step = Math.max(40, Math.round(region.clientWidth * 0.8));
  const position = event.key === "Home" ? 0 : event.key === "End" ? end
    : event.key === "ArrowLeft" ? Math.max(0, region.scrollLeft - step)
    : event.key === "ArrowRight" ? Math.min(end, region.scrollLeft + step) : null;
  if (position === null) return;
  event.preventDefault();
  region.scrollLeft = position;
}
