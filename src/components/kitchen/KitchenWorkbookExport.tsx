import { useRef, useState } from "react";
import { View } from "react-native";
import { Alert } from "@/src/components/ds";
import { KITCHEN_FLOOR_ID } from "@/src/constants/floors";
import { downloadApiFile } from "@/src/utils/downloadFile";
import { KitchenButton as Button } from "./KitchenPrimitives";
import { errorText } from "./shared";

/** Every queue downloads the complete permitted Kitchen dataset, not its page. */
export function KitchenWorkbookExport() {
  const busy = useRef(false);
  const [exporting, setExporting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const download = async () => {
    if (busy.current) return;
    busy.current = true;
    setExporting(true);
    setFailure(null);
    try {
      await downloadApiFile("/kitchen-projects/export.xlsx", "kitchen-customers.xlsx", "Kitchen customer workbook", KITCHEN_FLOOR_ID);
    } catch (error) {
      setFailure(errorText(error));
    } finally {
      busy.current = false;
      setExporting(false);
    }
  };
  return <View style={{ gap: 8, maxWidth: "100%" }}>
    <Button label="Export all customers" icon="download" variant="secondary" loading={exporting} onPress={() => void download()} testID="kitchen-projects-export-excel" />
    {failure ? <Alert tone="error" title="Export unavailable" description={`${failure} Try Export all customers again.`} /> : null}
  </View>;
}
