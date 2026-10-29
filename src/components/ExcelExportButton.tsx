import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Text } from "@/src/components/AppText";
import { Button } from "@/src/design/controls";
import { toast } from "@/src/components/Toast";
import { beginIdentityOperation } from "@/src/api/client";
import { useAuth } from "@/src/state/auth";
import { hasGrantAccess } from "@/src/team-delegation";
import { downloadSectionExcel } from "@/src/utils/sectionExcel";
import { color, text } from "@/src/design/tokens";

export type ExcelRows = (string | number | null | undefined)[][];

/** Explicit section data only; a paged source supplies every matching row before download. */
export function ExcelExportButton({
  resource, page, section, filename, rows, loadRows, floorId, testID, disabled = false, scopeKey,
}: {
  resource: string; page: string; section: string; filename: string;
  rows?: ExcelRows;
  loadRows?: (signal: AbortSignal, onProgress: (message: string) => void) => Promise<ExcelRows>;
  floorId?: string | null; testID?: string; disabled?: boolean; scopeKey?: string;
}) {
  const { staff } = useAuth();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const active = useRef<{ controller: AbortController; key: string } | null>(null);
  const mounted = useRef(true);
  const key = JSON.stringify([resource, page, section, filename, floorId, scopeKey]);
  const scope = useRef(key);
  scope.current = key;
  useEffect(() => {
    if (active.current && active.current.key !== key) active.current.controller.abort();
  }, [key]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; active.current?.controller.abort(); };
  }, []);
  const floors = (floorId || "").split(",").filter(Boolean);
  const allowed = staff?.role === "owner" || (!staff?.custom_access && Boolean(staff)) || (
    floors.length > 0 && floors.every(floor => hasGrantAccess(staff?.access_grants, floor, resource, "export"))
  );
  if (!allowed || (resource === "sales_data" && staff?.role !== "owner")) return null;

  const exportRows = async () => {
    if (active.current || disabled) return;
    const operation = beginIdentityOperation();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    operation.signal.addEventListener("abort", cancel, { once: true });
    active.current = { controller, key };
    setBusy(true); setProgress("Preparing Excel…");
    const isCurrent = () => active.current?.controller === controller && scope.current === key && !controller.signal.aborted && operation.isCurrent();
    try {
      const data = loadRows ? await loadRows(controller.signal, message => { if (isCurrent()) setProgress(message); }) : rows || [];
      if (!isCurrent()) return;
      setProgress("Creating Excel file…");
      const saved = await downloadSectionExcel({ resource, page, section, filename, rows: data, floorId, signal: controller.signal });
      if (isCurrent() && saved) toast.success("Excel export ready");
    } catch (error) {
      if (isCurrent()) toast.error(error instanceof Error ? error.message : "Could not export this section");
    } finally {
      operation.signal.removeEventListener("abort", cancel);
      operation.finish();
      if (active.current?.controller === controller) { active.current = null; if (mounted.current) { setBusy(false); setProgress(""); } }
    }
  };
  return <View style={{ alignItems: "flex-start", maxWidth: "100%", gap: 4 }}>
    <Button testID={testID} label={busy ? "Exporting…" : "Export Excel"} icon="download" variant="secondary" size="sm" loading={busy} disabled={disabled || (!loadRows && (!rows || rows.length < 2))} onPress={() => void exportRows()} />
    {busy ? <Text role="status" accessibilityLiveRegion="polite" style={[text.caption, { color: color.inkMid }]}>{progress}</Text> : null}
  </View>;
}
