// Shared "fetch an authenticated file from the API and open/save it" helper.
// Used by BOTH the customer portal (PDFs) and staff Settings (catalog
// export/backup) so there is exactly ONE implementation of this fetch/blob/
// open dance in the whole app instead of one per screen.
import { Linking, Platform } from "react-native";

import { api, getToken } from "@/src/api/client";
import { toast } from "@/src/components/Toast";

async function fetchApiBlob(path: string, errorLabel: string, floorId?: string): Promise<Blob | null> {
  const token = await getToken();
  if (!token && Platform.OS !== "web") {
    toast.show("Please sign in again");
    return null;
  }
  try {
    const res = await fetch(`${api.base}/api${path}`, {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(floorId ? { "X-Floor-Id": floorId } : {}) }, credentials: "same-origin",
    });
    if (!res.ok) {
      let detail = "";
      try { detail = String((await res.json())?.detail || ""); } catch { /* non-JSON gateway response */ }
      toast.show(detail || (res.status === 404 ? `That ${errorLabel} isn't available` : `Couldn't download the ${errorLabel}`));
      return null;
    }
    return await res.blob();
  } catch {
    toast.show(`Couldn't download the ${errorLabel} — check your connection`);
    return null;
  }
}

// Download an authenticated file UNDER A SPECIFIC FILENAME (the tiles
// documents must save as "<Customer Name> <DD-MM-YYYY>.pdf", never
// "quotation.pdf") — window.open() ignores Content-Disposition for blob:
// URLs, so desktop web uses an <a download> click instead. Native shares a
// named local file; mobile web uses the server's attachment response.
export async function downloadApiFile(path: string, filename: string, errorLabel = "file", floorId?: string): Promise<boolean> {
  if (Platform.OS !== "web") {
    const blob = await fetchApiBlob(path, errorLabel, floorId);
    if (!blob) return false;
    try {
      const [{ File, Paths }, Sharing] = await Promise.all([
        import("expo-file-system"), import("expo-sharing"),
      ]);
      if (!await Sharing.isAvailableAsync()) {
        toast.show("Sharing is unavailable on this device");
        return false;
      }
      const safeName = filename.replace(/[\\/]/g, "").trim() || "download";
      const file = new File(Paths.cache, `${Date.now()}-${safeName}`);
      file.create();
      file.write(new Uint8Array(await blob.arrayBuffer()));
      const extension = safeName.split(".").pop()?.toLowerCase();
      const mimeType = extension === "pdf" ? "application/pdf"
        : extension === "pptx" ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        : extension === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : extension === "csv" ? "text/csv" : blob.type || "application/octet-stream";
      await Sharing.shareAsync(file.uri, {
        mimeType,
        dialogTitle: `Save or share ${errorLabel}`,
      });
      return true;
    } catch {
      toast.show(`Couldn't open the ${errorLabel}`);
      return false;
    }
  }
  // Mobile Safari may ignore a delayed click on a blob: download link.
  // A tokenized attachment URL downloads through the browser's normal path.
  const mobileBrowser = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (mobileBrowser && /\.(pdf|pptx)$/i.test(filename)) {
    try {
      window.location.assign(await api.authenticatedUrl(path, floorId));
      return true;
    } catch {
      toast.show(`Couldn't download the ${errorLabel}`);
      return false;
    }
  }
  const blob = await fetchApiBlob(path, errorLabel, floorId);
  if (!blob) return false;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}

// Print an authenticated PDF: web renders it into a hidden iframe and calls
// print() so the browser's print dialog opens directly on the document;
// native falls back to opening the PDF (the OS viewer offers Print).
export async function printApiFile(path: string, errorLabel = "file", floorId?: string): Promise<void> {
  if (Platform.OS !== "web") {
    await openApiFile(path, errorLabel, floorId);
    return;
  }
  const blob = await fetchApiBlob(path, errorLabel, floorId);
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const frame = document.createElement("iframe");
  frame.style.position = "fixed";
  frame.style.right = "0";
  frame.style.bottom = "0";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";
  frame.src = url;
  frame.onload = () => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } catch {
      window.open(url, "_blank");
    }
  };
  document.body.appendChild(frame);
  // Give the print dialog ample time before tearing the frame down.
  setTimeout(() => { frame.remove(); URL.revokeObjectURL(url); }, 120_000);
}

export async function openApiFile(path: string, errorLabel = "file", floorId?: string): Promise<void> {
  const token = await getToken();
  if (!token && Platform.OS !== "web") {
    toast.show("Please sign in again");
    return;
  }
  try {
    const res = await fetch(`${api.base}/api${path}`, {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(floorId ? { "X-Floor-Id": floorId } : {}) }, credentials: "same-origin",
    });
    if (!res.ok) {
      toast.show(res.status === 404 ? `That ${errorLabel} isn't available` : `Couldn't download the ${errorLabel}`);
      return;
    }
    const blob = await res.blob();
    if (Platform.OS === "web") {
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return;
    }
    const reader = new FileReader();
    reader.onloadend = () => Linking.openURL(reader.result as string);
    reader.readAsDataURL(blob);
  } catch {
    toast.show(`Couldn't download the ${errorLabel} — check your connection`);
  }
}
