import { Platform } from "react-native";

import { filterValues } from "./filters";
import { api, csrfHeaders, getToken } from "@/src/api/client";

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
  const token = await getToken();
  const selectedFloors = filterValues(floorId).filter(value => value !== "both");
  const workspaceFloor = selectedFloors.length === 1 ? selectedFloors[0] : null;
  const response = await fetch(`${api.base}/api/exports/page.xlsx`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      ...csrfHeaders(),
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(workspaceFloor ? { "X-Floor-Id": workspaceFloor } : {}),
    },
    body: JSON.stringify({ page: page.slice(0, 80), resource, sections: [{ name: section.slice(0, 80), rows: rows.map(row => row.map(cell => String(cell ?? ""))) }] }),
  });
  if (!response.ok) {
    const detail = await response.json().then(body => body?.detail).catch(() => null);
    throw new Error(typeof detail === "string" ? detail : "Excel export failed.");
  }
  const blob = await response.blob();
  const safeName = filename.replace(/[\\/]/g, "").replace(/\.xlsx$/i, "") + ".xlsx";
  if (Platform.OS !== "web") {
    const [{ File, Paths }, Sharing] = await Promise.all([import("expo-file-system"), import("expo-sharing")]);
    if (!await Sharing.isAvailableAsync()) throw new Error("Sharing is unavailable on this device.");
    const file = new File(Paths.cache, `${Date.now()}-${safeName}`);
    file.create();
    file.write(new Uint8Array(await blob.arrayBuffer()));
    await Sharing.shareAsync(file.uri, {
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      dialogTitle: `Save ${section} Excel`,
    });
    return;
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = safeName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
