import { filterValues } from "./filters";
import { api, beginIdentityOperation, csrfHeaders, getToken } from "@/src/api/client";
import { savePreparedFile } from "./downloadFile";

/** Export explicit rows for one business section; no DOM scraping or page-wide dump. */
export async function downloadSectionExcel({
  page, section, rows, filename, floorId, resource, signal,
}: {
  page: string;
  section: string;
  rows: (string | number | null | undefined)[][];
  filename: string;
  floorId?: string | null;
  resource: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  if (rows.length < 2) throw new Error("There are no rows to export.");
  if (rows.length > 5000 || rows.some(row => row.length > 30 || row.some(cell => String(cell ?? "").length > 2000))) {
    throw new Error("This section is too large for one Excel file. Narrow the filters and try again.");
  }
  const operation = beginIdentityOperation();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  operation.signal.addEventListener("abort", cancel, { once: true });
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted || operation.signal.aborted) controller.abort();
  const isCurrent = () => !controller.signal.aborted && operation.isCurrent();
  try {
    const token = await getToken();
    if (!isCurrent()) return false;
    const selectedFloors = filterValues(floorId).filter(value => value !== "both");
    const workspaceFloor = selectedFloors.length === 1 ? selectedFloors[0] : null;
    const response = await fetch(`${api.base}/api/exports/page.xlsx`, {
      method: "POST",
      signal: controller.signal,
      credentials: "same-origin",
      headers: {
        ...csrfHeaders(),
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(workspaceFloor ? { "X-Floor-Id": workspaceFloor } : {}),
      },
      body: JSON.stringify({ page: page.slice(0, 80), resource, sections: [{ name: section.slice(0, 80), rows: rows.map(row => row.map(cell => String(cell ?? ""))) }] }),
    });
    if (!isCurrent()) return false;
    if (!response.ok) {
      const detail = await response.json().then(body => body?.detail).catch(() => null);
      if (!isCurrent()) return false;
      throw new Error(typeof detail === "string" ? detail : "Excel export failed.");
    }
    const blob = await response.blob();
    if (!isCurrent()) return false;
    const safeName = filename.replace(/[\\/]/g, "").replace(/\.xlsx$/i, "") + ".xlsx";
    return await savePreparedFile(blob, safeName, `${section} Excel`, { ...operation, signal: controller.signal, isCurrent });
  } catch (error) {
    if (isCurrent()) throw error;
    return false;
  } finally {
    operation.signal.removeEventListener("abort", cancel);
    signal?.removeEventListener("abort", cancel);
    operation.finish();
  }
}
