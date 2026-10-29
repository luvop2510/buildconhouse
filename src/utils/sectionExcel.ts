import { filterValues } from "./filters";
import { api, beginIdentityOperation, csrfHeaders, getToken } from "@/src/api/client";
import { savePreparedFile } from "./downloadFile";

/** Export explicit rows for one business section; no DOM scraping or page-wide dump. */
export async function downloadSectionExcel({
  page, section, rows, filename, floorId, resource,
}: {
  page: string;
  section: string;
  rows: (string | number | null | undefined)[][];
  filename: string;
  floorId?: string | null;
  resource: string;
}): Promise<void> {
  if (rows.length < 2) throw new Error("There are no rows to export.");
  const operation = beginIdentityOperation();
  try {
  const token = await getToken();
  if (!operation.isCurrent()) return;
  const selectedFloors = filterValues(floorId).filter(value => value !== "both");
  const workspaceFloor = selectedFloors.length === 1 ? selectedFloors[0] : null;
  const response = await fetch(`${api.base}/api/exports/page.xlsx`, {
    method: "POST",
    signal: operation.signal,
    credentials: "same-origin",
    headers: {
      ...csrfHeaders(),
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(workspaceFloor ? { "X-Floor-Id": workspaceFloor } : {}),
    },
    body: JSON.stringify({ page: page.slice(0, 80), resource, sections: [{ name: section.slice(0, 80), rows: rows.map(row => row.map(cell => String(cell ?? ""))) }] }),
  });
  if (!operation.isCurrent()) return;
  if (!response.ok) {
    const detail = await response.json().then(body => body?.detail).catch(() => null);
    if (!operation.isCurrent()) return;
    throw new Error(typeof detail === "string" ? detail : "Excel export failed.");
  }
  const blob = await response.blob();
  if (!operation.isCurrent()) return;
  const safeName = filename.replace(/[\\/]/g, "").replace(/\.xlsx$/i, "") + ".xlsx";
  await savePreparedFile(blob, safeName, `${section} Excel`, operation);
  } catch (error) {
    if (operation.isCurrent()) throw error;
  } finally {
    operation.finish();
  }
}
