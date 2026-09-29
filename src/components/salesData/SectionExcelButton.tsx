import { Button } from "@/src/components/ui";
import { toast } from "@/src/components/Toast";
import { downloadSectionExcel } from "@/src/utils/sectionExcel";

/** A download action attached to one explicit analytics section. */
export function SectionExcelButton({ testID, page, section, filename, rows, floorId }: {
  testID: string;
  page: string;
  section: string;
  filename: string;
  rows: (string | number | null | undefined)[][];
  floorId?: string | null;
}) {
  if (rows.length < 2) return null;
  return <Button testID={testID} label="Export Excel" icon="download" variant="secondary" onPress={() => void downloadSectionExcel({ page, section, filename, rows, floorId }).catch((error: unknown) => toast.show(error instanceof Error ? error.message : `Could not export ${section.toLowerCase()}`))} />;
}
