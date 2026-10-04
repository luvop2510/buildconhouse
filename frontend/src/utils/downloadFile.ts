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

// Fetching/generating a PDF outlives Safari's original tap activation. Keep
// the app open and give the user a fresh tap once the actual file is ready.
function saveMobileBrowserFile(blob: Blob, filename: string, errorLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.setAttribute("aria-label", `Save ${errorLabel}`);
    dialog.setAttribute("data-testid", "mobile-file-save");
    Object.assign(dialog.style, {
      border: "1px solid #ddd", borderRadius: "16px", padding: "24px",
      maxWidth: "min(420px, calc(100vw - 32px))", width: "100%", boxSizing: "border-box",
      fontFamily: "system-ui, sans-serif", color: "#202020", background: "#fff",
    });
    const title = document.createElement("h2");
    title.textContent = "Your file is ready";
    title.style.margin = "0 0 12px";
    const description = document.createElement("p");
    description.id = "mobile-file-save-description";
    dialog.setAttribute("aria-describedby", description.id);
    description.textContent = `${filename} — tap Download to save it. If your browser opens a preview, use its Share menu to save the file.`;
    const actions = document.createElement("div");
    Object.assign(actions.style, { display: "flex", flexWrap: "wrap", gap: "12px", marginTop: "20px" });
    let settled = false;
    const finish = (saved: boolean) => {
      if (settled) return;
      settled = true;
      if (typeof dialog.close === "function" && dialog.open) dialog.close();
      dialog.remove();
      resolve(saved);
    };
    const button = (label: string, action: () => void) => {
      const element = document.createElement("button");
      element.type = "button";
      element.textContent = label;
      Object.assign(element.style, { minHeight: "44px", padding: "10px 18px", borderRadius: "8px", border: "1px solid #aaa", font: "inherit", cursor: "pointer" });
      element.onclick = action;
      actions.appendChild(element);
      return element;
    };
    const download = button("Download", () => {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      // Older mobile viewers can ignore download; a new tab preserves the app.
      anchor.target = "_blank";
      anchor.rel = "noopener";
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
          button("Share or save", () => {
            // Invoke share synchronously from this fresh user gesture.
            try {
              void navigator.share({ files: [file] }).then(() => finish(true)).catch((error) => {
                if (error?.name !== "AbortError") toast.show(`Couldn't share the ${errorLabel} — use Download instead`);
              });
            } catch { toast.show(`Couldn't share the ${errorLabel} — use Download instead`); }
          });
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
    download.focus();
  });
}

// Download an authenticated file UNDER A SPECIFIC FILENAME (the tiles
// documents must save as "<Customer Name> <DD-MM-YYYY>.pdf", never
// "quotation.pdf") — window.open() ignores Content-Disposition for blob:
// URLs, so desktop web uses an <a download> click instead. Native shares a
// named local file; mobile web offers a fresh Save/Share tap after fetching.
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
  const mobileBrowser = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const blob = await fetchApiBlob(path, errorLabel, floorId);
  if (!blob) return false;
  if (mobileBrowser) return saveMobileBrowserFile(blob, filename, errorLabel);
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
