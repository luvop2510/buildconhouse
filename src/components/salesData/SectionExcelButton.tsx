import { ExcelExportButton } from "@/src/components/ExcelExportButton";

/** A download action attached to one explicit analytics section. */
export function SectionExcelButton(props: {
  testID: string; page: string; section: string; filename: string;
  rows: (string | number | null | undefined)[][]; floorId?: string | null;
}) {
  if (props.rows.length < 2) return null;
  return <ExcelExportButton {...props} resource="sales_data" />;
}
