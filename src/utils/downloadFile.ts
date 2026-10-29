// Shared "fetch an authenticated file from the API and open/save it" helper.
// Used by BOTH the customer portal (PDFs) and staff Settings (catalog
// export/backup) so there is exactly ONE implementation of this fetch/blob/
// open dance in the whole app instead of one per screen.
import { Linking, Platform } from "react-native";

import { api, beginIdentityOperation, getRequestFloorId, getToken, type IdentityOperation } from "@/src/api/client";
import { toast } from "@/src/components/Toast";
import type { Directory as NativeDirectory, File as NativeFile } from "expo-file-system";

const nativeDirectories = new WeakMap<NativeFile, NativeDirectory>();

export async function createPreparedNativeFile(filename: string): Promise<NativeFile> {
  const { Directory, File, Paths } = await import("expo-file-system");
  const safeName = filename.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").trim().replace(/^\.+$/, "") || "download";
  const directory = new Directory(Paths.cache, `prepared-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  directory.create();
  try {
    const file = new File(directory, safeName);
    file.create();
    nativeDirectories.set(file, directory);
    return file;
  } catch (error) { directory.delete(); throw error; }
}

export function removePreparedNativeFile(file?: NativeFile): void {
  if (!file) return;
  const directory = nativeDirectories.get(file);
  if (directory) {
    if (directory.exists) directory.delete();
    nativeDirectories.delete(file);
  } else if (file.exists) file.delete();
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

function quotationDownloadFilename(path: string, disposition: string | null | undefined): string | null {
  if (!path.startsWith("/quotations/") || !/\/(?:portal-)?pdf(?:\/|\?|$)/.test(path) || !disposition) return null;
  const encoded = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  const plain = disposition.match(/filename\s*=\s*"([^"]+)"/i);
  try {
    const name = encoded ? decodeURIComponent(encoded[1].trim()) : plain?.[1];
    const safe = name?.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").trim();
    return safe?.toLowerCase().endsWith(".pdf") ? safe : null;
  } catch { return null; }
}

async function fetchApiBlob(path: string, errorLabel: string, floorId: string | undefined, operation: IdentityOperation, onFilename?: (name: string) => void): Promise<Blob | null> {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  const deadline = setTimeout(() => { timedOut = true; cancel(); }, 30_000);
  if (operation.signal.aborted) cancel();
  else operation.signal.addEventListener("abort", cancel, { once: true });
  // Some native readers ignore fetch cancellation. Settle the caller as well
  // as aborting transport, and observe late results without publishing them.
  const wait = <T,>(work: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const aborted = () => {
      controller.signal.removeEventListener("abort", aborted);
      reject(new Error("Download cancelled"));
    };
    // Observe work even if already cancelled: credential/body readers can
    // reject later despite ignoring abort and must not become unhandled errors.
    work.then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", aborted));
    if (controller.signal.aborted) { aborted(); return; }
    controller.signal.addEventListener("abort", aborted, { once: true });
  });
  try {
    // Capture the selected workspace before token hydration can yield to a floor switch.
    const floor = floorId === undefined ? getRequestFloorId() : Promise.resolve(floorId);
    const [token, requestFloorId] = await wait(Promise.all([Promise.resolve().then(getToken), floor]));
    if (!operation.isCurrent()) return null;
    if (!token && Platform.OS !== "web") {
      toast.show("Please sign in again");
      return null;
    }
    const res = await wait(fetch(`${api.base}/api${path}`, {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(requestFloorId ? { "X-Floor-Id": requestFloorId } : {}) }, credentials: "same-origin", signal: controller.signal,
    }));
    if (!operation.isCurrent()) return null;
    if (!res.ok) {
      let detail = "";
      try { detail = String((await wait(res.json()))?.detail || ""); }
      catch (error) { if (controller.signal.aborted) throw error; /* non-JSON gateway response */ }
      if (!operation.isCurrent()) return null;
      toast.show(detail || (res.status === 404 ? `That ${errorLabel} isn't available` : `Couldn't download the ${errorLabel}`));
      return null;
    }
    const blob = await wait(res.blob());
    if (!operation.isCurrent()) return null;
    const filename = quotationDownloadFilename(path, res.headers?.get("Content-Disposition"));
    if (filename) onFilename?.(filename);
    return blob;
  } catch {
    if (operation.isCurrent()) toast.show(timedOut
      ? `Downloading the ${errorLabel} timed out — try again`
      : `Couldn't download the ${errorLabel} — check your connection`);
    return null;
  } finally {
    clearTimeout(deadline);
    operation.signal.removeEventListener("abort", cancel);
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

// Quotation names come from the authenticated response; other files keep the
// caller's name. Blob URLs lose Content-Disposition, so retain the chosen name
// through the browser download and native file-sharing paths.
export async function downloadApiFile(path: string, filename: string, errorLabel = "file", floorId?: string): Promise<boolean> {
  const operation = beginIdentityOperation();
  try {
    const blob = await fetchApiBlob(path, errorLabel, floorId, operation, name => { filename = name; });
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
      const removePrivateFile = () => removePreparedNativeFile(file);
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
    const blob = await fetchApiBlob(path, "PDF", floorId, operation, name => { filename = name; });
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
