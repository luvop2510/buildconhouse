import { createElement, useRef, useState } from "react";
import { Platform } from "react-native";
import type { DocumentPickerAsset } from "expo-document-picker";
import { colors } from "@/src/theme/tokens";

/** Web drops enter the same selection and validation flow as the file picker. */
export function KitchenFileDrop({ disabled, onFile, onError, onChoose, pdfOnly = false }: { disabled: boolean; onFile: (file: DocumentPickerAsset) => void; onError: (message: string) => void; onChoose?: () => void; pdfOnly?: boolean }) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  if (Platform.OS !== "web") return null;
  const choose = () => { if (!disabled) onChoose?.(); };
  const fileDrag = (event: React.DragEvent<HTMLDivElement>) => Array.from(event.dataTransfer.types || []).includes("Files");
  return createElement("div", {
    role: onChoose ? "button" : "region", "aria-label": pdfOnly ? "Drop a PDF here" : "Drop a document here",
    "aria-disabled": disabled, "data-testid": "kitchen-file-drop", "data-dragging": dragging && !disabled,
    tabIndex: onChoose && !disabled ? 0 : undefined,
    onClick: choose,
    onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => { if (onChoose && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); choose(); } },
    onDragEnter: (event: React.DragEvent<HTMLDivElement>) => { event.preventDefault(); event.stopPropagation(); if (!disabled && fileDrag(event)) { depth.current += 1; setDragging(true); } },
    onDragLeave: (event: React.DragEvent<HTMLDivElement>) => { event.preventDefault(); event.stopPropagation(); depth.current = Math.max(0, depth.current - 1); if (!depth.current) setDragging(false); },
    onDragOver: (event: React.DragEvent<HTMLDivElement>) => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = disabled ? "none" : "copy"; },
    onDrop: (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault(); event.stopPropagation(); depth.current = 0; setDragging(false);
      if (disabled) return;
      const files = Array.from(event.dataTransfer.files);
      if (files.length !== 1 || pdfOnly && (!/\.pdf$/i.test(files[0].name) || files[0].type && !["application/pdf", "application/octet-stream"].includes(files[0].type.toLowerCase()))) { onError(pdfOnly ? "Drop one PDF file." : "Drop one document at a time."); return; }
      const file = files[0];
      onFile({ name: file.name, size: file.size, lastModified: file.lastModified, mimeType: file.type || (pdfOnly ? "application/pdf" : "application/octet-stream"), uri: `dropped:${globalThis.crypto.randomUUID()}`, file });
    },
    style: { border: `1px dashed ${dragging && !disabled ? colors.brand : colors.borderStrong}`, borderRadius: 8, padding: 12, minHeight: 44,
      color: colors.onSurfaceSecondary, backgroundColor: dragging && !disabled ? colors.brandTint : colors.surfaceSecondary, opacity: disabled ? 0.5 : 1,
      cursor: disabled ? "default" : onChoose ? "pointer" : "default" },
  }, dragging && !disabled ? (pdfOnly ? "Release to select this PDF" : "Release to select this document") : pdfOnly ? "Drop a PDF here, or use Choose PDF." : "Drop a document here, or use Choose document.");
}
