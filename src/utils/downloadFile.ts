// Shared "fetch an authenticated file from the API and open/save it" helper.
// Used by BOTH the customer portal (PDFs) and staff Settings (catalog
// export/backup) so there is exactly ONE implementation of this fetch/blob/
// open dance in the whole app instead of one per screen.
import { Linking, Platform } from "react-native";

import { api, beginIdentityOperation, getRequestFloorId, getToken, type IdentityOperation } from "@/src/api/client";
import { toast } from "@/src/components/Toast";
import type { File as NativeFile } from "expo-file-system";

export async function createPreparedNativeFile(filename: string): Promise<NativeFile> {
  const { File, Paths } = await import("expo-file-system");
  const safeName = filename.replace(/[\\/]/g, "").trim() || "download";
  const file = new File(Paths.cache, `${Date.now()}-${Math.random().toString(36).slice(2)}-${safeName}`);
  file.create();
  return file;
}

/** The caller owns the temporary file and removes it after the share sheet closes. */
export async function sharePreparedNativeFile(file: NativeFile, filename: string, contentType: string, errorLabel = "file", guard?: IdentityOperation): Promise<boolean> {
  const operation = guard || beginIdentityOperation();
  try {
    if (!operation.isCurrent()) return false;
    const Sharing = await import("expo-sharing");
    if (!operation.isCurrent()) return false;
    const available = await Sharing.isAvailableAsync();
    if (!operation.isCurrent()) return false;
    if (!available) {
      toast.show("Sharing is unavailable on this device");
      return false;
    }
    const extension = filename.split(".").pop()?.toLowerCase();
    const mimeType = extension === "pdf" ? "application/pdf"
      : extension === "pptx" ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      : extension === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : extension === "csv" ? "text/csv" : contentType || "application/octet-stream";
    await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: `Save ${errorLabel} to Files or share` });
    return operation.isCurrent();
  } finally {
    if (!guard) operation.finish();
  }
}

// React Native's Blob implements FileReader, but not Blob.arrayBuffer().
function nativeBlobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the downloaded file."));
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      const comma = value.indexOf(",");
      if (comma < 0 || !value.slice(0, comma).endsWith(";base64")) reject(new Error("Invalid downloaded file."));
      else resolve(value.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}

async function fetchApiBlob(path: string, errorLabel: string, floorId: string | undefined, operation: IdentityOperation): Promise<Blob | null> {
  // Capture the selected workspace before token hydration can yield to a floor switch.
  const floor = floorId === undefined ? getRequestFloorId() : Promise.resolve(floorId);
  const [token, requestFloorId] = await Promise.all([getToken(), floor]);
  if (!operation.isCurrent()) return null;
  if (!token && Platform.OS !== "web") {
    toast.show("Please sign in again");
    return null;
  }
  try {
    const res = await fetch(`${api.base}/api${path}`, {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(requestFloorId ? { "X-Floor-Id": requestFloorId } : {}) }, credentials: "same-origin", signal: operation.signal,
    });
    if (!operation.isCurrent()) return null;
    if (!res.ok) {
      let detail = "";
      try { detail = String((await res.json())?.detail || ""); } catch { /* non-JSON gateway response */ }
      if (!operation.isCurrent()) return null;
      toast.show(detail || (res.status === 404 ? `That ${errorLabel} isn't available` : `Couldn't download the ${errorLabel}`));
      return null;
    }
    const blob = await res.blob();
    return operation.isCurrent() ? blob : null;
  } catch {
    if (operation.isCurrent()) toast.show(`Couldn't download the ${errorLabel} — check your connection`);
    return null;
  }
}

// Fetching/generating a PDF outlives Safari's original tap activation. Keep
// the app open and give the user a fresh tap once the actual file is ready.
function saveMobileBrowserFile(blob: Blob, filename: string, errorLabel: string, operation: IdentityOperation): Promise<boolean> {
  return new Promise((resolve) => {
    if (!operation.isCurrent()) { resolve(false); return; }
    const dialog = document.createElement("dialog");
    dialog.setAttribute("aria-label", `Save ${errorLabel}`);
    dialog.setAttribute("data-testid", "mobile-file-save");
    Object.assign(dialog.style, {
      border: "1px solid #ddd", borderRadius: "16px", padding: "24px",
      maxWidth: "min(420px, calc(100vw - 32px))", width: "100%", boxSizing: "border-box",
      fontFamily: "inherit", color: "#202020", background: "#fff",
    });
    const title = document.createElement("h2");
    title.textContent = "Your file is ready";
    title.style.margin = "0 0 12px";
    const description = document.createElement("p");
    description.id = "mobile-file-save-description";
    dialog.setAttribute("aria-describedby", description.id);
    description.textContent = `${filename}. On iPhone or iPad, choose Save to Files in the share sheet. Otherwise, tap Download; if your browser opens a preview, use its Share menu to save the file.`;
    const actions = document.createElement("div");
    Object.assign(actions.style, { display: "flex", flexWrap: "wrap", gap: "12px", marginTop: "20px" });
    let settled = false;
    const finish = (saved: boolean) => {
      if (settled) return;
      settled = true;
      operation.signal.removeEventListener("abort", cancelled);
      if (typeof dialog.close === "function" && dialog.open) dialog.close();
      dialog.remove();
      resolve(saved);
    };
    const cancelled = () => finish(false);
    operation.signal.addEventListener("abort", cancelled, { once: true });
    const button = (label: string, action: () => void) => {
      const element = document.createElement("button");
      element.type = "button";
      element.textContent = label;
      Object.assign(element.style, { minHeight: "44px", padding: "10px 18px", borderRadius: "8px", border: "1px solid #aaa", font: "inherit", cursor: "pointer" });
      element.onclick = action;
      actions.appendChild(element);
      return element;
    };
    let saveOrShare: HTMLButtonElement | null = null;
    const download = button("Download", () => {
      if (!operation.isCurrent()) { finish(false); return; }
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 120_000);
      finish(true);
    });
    download.setAttribute("data-testid", "mobile-file-download");
    // Web Share is optional. Capability probes can throw in embedded browsers.
    try {
      if (typeof globalThis.File === "function" && typeof navigator.share === "function" && typeof navigator.canShare === "function") {
        const file = new globalThis.File([blob], filename, { type: blob.type || "application/octet-stream" });
        if (navigator.canShare({ files: [file] })) {
          saveOrShare = button("Save or share", () => {
            if (!operation.isCurrent()) { finish(false); return; }
            // Invoke share synchronously from this fresh user gesture.
            try {
              void navigator.share({ files: [file] }).then(() => finish(operation.isCurrent())).catch((error) => {
                if (operation.isCurrent() && error?.name !== "AbortError") toast.show(`Couldn't share the ${errorLabel} — use Download instead`);
              });
            } catch { if (operation.isCurrent()) toast.show(`Couldn't share the ${errorLabel} — use Download instead`); }
          });
          actions.insertBefore(saveOrShare, download);
        }
      }
    } catch { /* Download remains available when file sharing is unsupported. */ }
    button("Cancel", () => finish(false));
    dialog.oncancel = (event) => { event.preventDefault(); finish(false); };
    dialog.append(title, description, actions);
    document.body.appendChild(dialog);
    try {
      if (typeof dialog.showModal !== "function") throw new Error("Dialog unsupported");
      dialog.showModal();
    } catch {
      // Older iOS/embedded browsers still get a usable fresh-tap save panel.
      dialog.setAttribute("open", "");
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      Object.assign(dialog.style, { display: "block", position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)", margin: "0", zIndex: "2147483647", boxShadow: "0 0 0 100vmax rgba(0,0,0,.5)" });
      dialog.onkeydown = (event) => {
        if (event.key === "Escape") { event.preventDefault(); finish(false); }
        if (event.key === "Tab") {
          const buttons = Array.from(actions.children) as HTMLButtonElement[];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          event.preventDefault();
          buttons[(index + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length].focus();
        }
      };
    }
    (saveOrShare || download).focus();
  });
}

// Download an authenticated file UNDER A SPECIFIC FILENAME (the tiles
// documents must save as "<Customer Name> <DD-MM-YYYY>.pdf", never
// "quotation.pdf") — window.open() ignores Content-Disposition for blob:
// URLs, so desktop web uses an <a download> click instead. Native shares a
// named local file; mobile web offers a fresh Save/Share tap after fetching.
export async function downloadApiFile(path: string, filename: string, errorLabel = "file", floorId?: string): Promise<boolean> {
  const operation = beginIdentityOperation();
  try {
    const blob = await fetchApiBlob(path, errorLabel, floorId, operation);
    return blob && operation.isCurrent() ? await savePreparedFile(blob, filename, errorLabel, operation) : false;
  } finally { operation.finish(); }
}

/** Save already authenticated, verified bytes through the same device file UI. */
export async function savePreparedFile(blob: Blob, filename: string, errorLabel = "file", guard?: IdentityOperation): Promise<boolean> {
  const operation = guard || beginIdentityOperation();
  try {
    if (!operation.isCurrent()) return false;
    if (Platform.OS !== "web") {
      let file: NativeFile | undefined;
      const removePrivateFile = () => { if (file?.exists) file.delete(); };
      operation.signal.addEventListener("abort", removePrivateFile, { once: true });
      try {
        const base64 = await nativeBlobBase64(blob);
        if (!operation.isCurrent()) return false;
        file = await createPreparedNativeFile(filename);
        if (!operation.isCurrent()) return false;
        file.write(base64, { encoding: "base64" });
        return await sharePreparedNativeFile(file, filename, blob.type, errorLabel, operation);
      } catch {
        if (operation.isCurrent()) toast.show(`Couldn't open the ${errorLabel}`);
        return false;
      } finally {
        operation.signal.removeEventListener("abort", removePrivateFile);
        removePrivateFile();
      }
    }
    const mobileBrowser = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
      || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (mobileBrowser) return await saveMobileBrowserFile(blob, filename, errorLabel, operation);
    if (!operation.isCurrent()) return false;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return true;
  } finally { if (!guard) operation.finish(); }
}

// File-only sharing: a browser share payload contains the PDF attachment and no URL.
// Fetching loses transient activation, so web uses a fresh user tap in the file panel.
export async function shareApiPdf(path: string, filename: string, floorId?: string): Promise<boolean> {
  if (Platform.OS !== "web") return downloadApiFile(path, filename, "PDF", floorId);
  const operation = beginIdentityOperation();
  try {
    const blob = await fetchApiBlob(path, "PDF", floorId, operation);
    if (!blob || !operation.isCurrent()) return false;
    if (blob.type && blob.type !== "application/pdf") {
      toast.show("The PDF could not be prepared. Try again.");
      return false;
    }
    return await saveMobileBrowserFile(blob, filename, "PDF", operation);
  } finally { operation.finish(); }
}

// Print an authenticated PDF: web renders it into a hidden iframe and calls
// print() so the browser's print dialog opens directly on the document;
// native falls back to opening the PDF (the OS viewer offers Print).
export async function printApiFile(path: string, errorLabel = "file", floorId?: string): Promise<void> {
  if (Platform.OS !== "web") {
    await openApiFile(path, errorLabel, floorId);
    return;
  }
  const operation = beginIdentityOperation();
  let waitingForFrame = false;
  try {
    const blob = await fetchApiBlob(path, errorLabel, floorId, operation);
    if (!blob || !operation.isCurrent()) return;
    const url = URL.createObjectURL(blob);
    const frame = document.createElement("iframe");
    let removed = false;
    const cleanup = () => {
      if (removed) return;
      removed = true;
      operation.signal.removeEventListener("abort", cleanup);
      frame.onload = null;
      frame.remove();
      URL.revokeObjectURL(url);
      operation.finish();
    };
    frame.style.position = "fixed";
    frame.style.right = "0";
    frame.style.bottom = "0";
    frame.style.width = "0";
    frame.style.height = "0";
    frame.style.border = "0";
    frame.src = url;
    frame.onload = () => {
      if (!operation.isCurrent()) { cleanup(); return; }
      try {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
      } catch {
        if (operation.isCurrent()) window.open(url, "_blank", "noopener,noreferrer");
      }
    };
    operation.signal.addEventListener("abort", cleanup, { once: true });
    document.body.appendChild(frame);
    waitingForFrame = true;
    // Retain identity cancellation until the private print frame is removed.
    setTimeout(cleanup, 120_000);
  } finally { if (!waitingForFrame) operation.finish(); }
}

export async function openApiFile(path: string, errorLabel = "file", floorId?: string): Promise<void> {
  const operation = beginIdentityOperation();
  try {
    const blob = await fetchApiBlob(path, errorLabel, floorId, operation);
    if (!blob || !operation.isCurrent()) return;
    if (Platform.OS === "web") {
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return;
    }
    const base64 = await nativeBlobBase64(blob);
    if (operation.isCurrent()) await Linking.openURL(`data:${blob.type || "application/octet-stream"};base64,${base64}`);
  } catch { if (operation.isCurrent()) toast.show(`Couldn't open the ${errorLabel}`); }
  finally { operation.finish(); }
}
