import { createElement } from "react";
import { Platform } from "react-native";
import type { DocumentPickerAsset } from "expo-document-picker";

/** Web drops enter the same selection and validation flow as the file picker. */
export function KitchenFileDrop({ disabled, onFile, onError, pdfOnly = false }: { disabled: boolean; onFile: (file: DocumentPickerAsset) => void; onError: (message: string) => void; pdfOnly?: boolean }) {
  if (Platform.OS !== "web") return null;
  return createElement("div", {
    role: "region", "aria-label": pdfOnly ? "Drop a PDF here" : "Drop a document here",
    onDragOver: (event: React.DragEvent<HTMLDivElement>) => { event.preventDefault(); event.dataTransfer.dropEffect = disabled ? "none" : "copy"; },
    onDrop: (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (disabled) return;
      const files = Array.from(event.dataTransfer.files);
      if (files.length !== 1 || pdfOnly && !/\.pdf$/i.test(files[0].name)) { onError(pdfOnly ? "Drop one PDF file." : "Drop one document at a time."); return; }
      const file = files[0];
      onFile({ name: file.name, size: file.size, lastModified: file.lastModified, mimeType: file.type || (pdfOnly ? "application/pdf" : "application/octet-stream"), uri: `dropped:${globalThis.crypto.randomUUID()}`, file });
    },
    style: { border: "1px dashed #8b8b8b", borderRadius: 6, padding: 12, color: "#555", opacity: disabled ? 0.5 : 1 },
  }, pdfOnly ? "Drop a PDF here, or use Choose PDF." : "Drop a document here, or use Choose document.");
}
