import { ExcelExportButton } from "@/src/components/ExcelExportButton";
import { tileOrdersApi } from "@/src/api/tileOrders";
import { collectTileExportRows, tileExportCells, TILE_EXPORT_NAMES, type TileExportSection, type TileExportRow } from "@/src/utils/tileOrdersExcel";

export function TileOrdersExcelButton({ section, params, testID, disabled }: {
  section: TileExportSection; params?: Record<string, string | undefined>; testID?: string; disabled?: boolean;
}) {
  const loadRows = async (signal: AbortSignal, onProgress: (message: string) => void) => {
    const rows = await collectTileExportRows<TileExportRow>(async page => {
      const query = { ...params, page, page_size: 100 };
      switch (section) {
        case "customer": { const result = await tileOrdersApi.listCustomerOrders(query, signal); return { ...result, rows: result.orders }; }
        case "brands": { const result = await tileOrdersApi.listBrands(query, signal); return { ...result, rows: result.brands }; }
        case "history": return tileOrdersApi.listHistory(query, signal);
        case "inventory": return tileOrdersApi.listInventory(query, signal);
        case "dispatch-list": return tileOrdersApi.listDispatchList(query, signal);
        case "material-register": return tileOrdersApi.listMovements(query, signal);
      }
    }, signal, onProgress);
    return tileExportCells(section, rows);
  };
  return <ExcelExportButton resource="orders" page="Tile Orders" section={TILE_EXPORT_NAMES[section]} filename={`tile-orders-${section}.xlsx`} floorId="ground-floor" testID={testID || `tile-orders-${section}-export`} disabled={disabled} loadRows={loadRows} scopeKey={JSON.stringify(params || {})} />;
}
