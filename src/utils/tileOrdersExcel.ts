import type {
  BrandLandingCard, CompletedTileOrder, CustomerOrderCard, DispatchListRow,
  GodownInventoryRow, MaterialMovementRow,
} from "../api/tileOrders";

export type TileExportSection = "customer" | "brands" | "history" | "inventory" | "dispatch-list" | "material-register";
export type TileExportRow = CustomerOrderCard | BrandLandingCard | CompletedTileOrder | GodownInventoryRow | DispatchListRow | MaterialMovementRow;
export const TILE_EXPORT_NAMES: Record<TileExportSection, string> = {
  customer: "Customer orders", brands: "Release queue", history: "Completed orders",
  inventory: "Go-down stock", "dispatch-list": "Dispatch board", "material-register": "Movement register",
};

export { collectPagedExportRows as collectTileExportRows } from "./pagedExcel";

export function tileExportCells(section: TileExportSection, data: TileExportRow[]): (string | number | null | undefined)[][] {
  switch (section) {
    case "customer": return [["Customer", "Phone", "Order", "Order date", "Brands", "Products", "Boxes", "Value", "Status", "Completion %", "Waiting days"], ...data.map(value => {
      const row = value as CustomerOrderCard;
      return [row.customer_name, row.customer_phone, row.number, row.order_date, row.brands.map(brand => brand.brand_name).join(", "), row.total_products, row.total_boxes, row.total_value, row.overall_status, row.completion_percentage, row.waiting_days];
    })];
    case "brands": return [["Brand", "Active orders", "Supplier silent days"], ...data.map(value => {
      const row = value as BrandLandingCard;
      return [row.brand_name, row.active_orders, row.max_supplier_silent_days];
    })];
    case "history": return [["Customer", "Order", "Completion date", "Brands", "Products and quantities", "Final amount", "Status", "Delivery notes", "Chalans", "Dispatches"], ...data.map(value => {
      const row = value as CompletedTileOrder;
      return [row.customer, row.order_number, row.completion_date, row.brands.join(", "), row.products.map(item => `${item.product} · ${item.sku || "No SKU"} · ${item.size || "No size"} · ${item.quantity} ${item.quantity_unit}`).join("; "), row.final_amount, row.delivery_status, row.delivery_notes, row.chalan_references.map(item => item.number).join(", "), row.dispatch_references.map(item => item.number).join(", ")];
    })];
    case "inventory": return [["Customer", "Name", "Brand", "Product", "Size", "Arrival date"], ...data.map(value => {
      const row = value as GodownInventoryRow;
      return [row.customer, row.name, row.brand, row.product, row.size, row.arrival_date];
    })];
    case "dispatch-list": return [["Customer", "Brand", "Tile", "Size", "SKU", "Quantity", "Unit", "Source", "Dispatch", "Dispatch date", "Chalan", "Vehicle", "Driver", "Status", "Performed by"], ...data.map(value => {
      const row = value as DispatchListRow;
      return [row.customer_name, row.brand_name, row.tile_name, row.tile_size, row.sku, row.boxes, row.quantity_unit, row.source, row.dispatch_number, row.dispatch_date, row.chalan_number, row.vehicle_number, row.driver_name, row.status, row.performed_by_name];
    })];
    case "material-register": return [["Date", "Movement", "Customer", "Brand", "Tile", "Series", "Finish", "Size", "SKU", "Quantity", "Unit", "Source", "Destination", "Dispatch", "Chalan", "Performed by"], ...data.map(value => {
      const row = value as MaterialMovementRow;
      return [row.created_at, row.movement_type.replace(/_/g, " "), row.customer_name, row.brand_name, row.tile_name, row.series, row.finish, row.size, row.sku, row.boxes, row.quantity_unit, row.source, row.destination, row.dispatch_number, row.chalan_number, row.performed_by_name];
    })];
  }
}
