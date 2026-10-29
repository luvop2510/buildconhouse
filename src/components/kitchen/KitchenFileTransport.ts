import { Platform } from "react-native";
import type { DocumentPickerAsset } from "expo-document-picker";
import { kitchenProjectsApi, type KitchenAttachment, type KitchenFileTransfer, type KitchenProject } from "@/src/api/kitchenProjects";
import { beginIdentityOperation } from "@/src/api/client";
import { createPreparedNativeFile, removePreparedNativeFile, savePreparedFile, sharePreparedNativeFile } from "@/src/utils/downloadFile";
import type { File as NativeFile, FileHandle } from "expo-file-system";

export const KITCHEN_MAX_FILE_BYTES = 25_000_000;
export const KITCHEN_MAX_PDF_BYTES = 10_000_000;
const PART_BYTES = 512 * 1024;
function encoded(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 4096) binary += String.fromCharCode(...bytes.subarray(offset, offset + 4096));
  return btoa(binary);
}
function decoded(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}
async function digest(bytes: Uint8Array) {
  let hash: ArrayBuffer;
  if (Platform.OS === "web") {
    if (!globalThis.crypto?.subtle) throw new Error("File integrity verification requires a secure connection. Open the app over HTTPS and retry.");
    hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  } else {
    const Crypto = await import("expo-crypto");
    hash = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new Uint8Array(bytes).buffer);
  }
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("");
}

export async function uploadKitchenFile(project: KitchenProject, file: DocumentPickerAsset, key: string,
  progress: (percent: number) => void, transferStarted: (id: string, transfer?: KitchenFileTransfer) => void) {
  const maximum = /\.pdf$/i.test(file.name) || file.mimeType === "application/pdf" ? KITCHEN_MAX_PDF_BYTES : KITCHEN_MAX_FILE_BYTES;
  if (!file.size || file.size > maximum) throw new Error(`Choose a nonempty file up to ${maximum === KITCHEN_MAX_PDF_BYTES ? "10 MB (10,000,000 bytes) for PDFs" : "25 MB (25,000,000 bytes)"}.`);
  if (Platform.OS === "web" && !file.file) throw new Error("The original selected file is unavailable. Choose it again.");
  progress(0);
  const nativeFile = Platform.OS === "web" ? null : new (await import("expo-file-system")).File(file.uri);
  const source = Platform.OS === "web" ? new Uint8Array(await file.file!.arrayBuffer()) : await nativeFile!.bytes();
  if (source.length !== file.size) throw new Error("The selected file changed. Choose it again.");
  const sha256 = await digest(source);
  const transfer = await kitchenProjectsApi.beginTransfer(project.id, { expected_version: project.version,
    idempotency_key: key, filename: file.name, content_type: file.mimeType || "application/octet-stream", size_bytes: file.size, sha256 });
  transferStarted(transfer.transfer_id, transfer);
  if (transfer.chunk_bytes !== PART_BYTES || transfer.size_bytes !== file.size || transfer.part_count !== Math.ceil(file.size / PART_BYTES)) throw new Error("File transfer limits changed. Choose the file again.");
  // A lost finish response can leave the same transfer finishing or completed.
  // Its immutable parts are already present; only the exact finish receipt can
  // resolve it. PUT would reject that state and permanently block this retry.
  if (transfer.state === "open") {
    for (let index = 0; index < transfer.part_count; index += 1) {
      const offset = index * PART_BYTES;
      // Send the bytes that were hashed, even if the selected native file is
      // replaced while the network request is pending.
      await kitchenProjectsApi.uploadPart(project.id, transfer.transfer_id, index, encoded(source.subarray(offset, Math.min(offset + PART_BYTES, file.size))));
      progress(Math.floor((index + 1) * 95 / transfer.part_count));
    }
  }
  progress(95);
  const saved = await kitchenProjectsApi.finishTransfer(project.id, transfer.transfer_id, project.version);
  progress(100);
  return saved;
}

export async function downloadKitchenFile(projectId: string, attachment: KitchenAttachment, progress: (percent: number) => void, preview?: Window) {
  if (!attachment.size_bytes || attachment.size_bytes > KITCHEN_MAX_FILE_BYTES) throw new Error("This file exceeds the supported download size.");
  const operation = beginIdentityOperation();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let nativeFile: NativeFile | undefined;
  let handle: FileHandle | undefined;
  const cancelPublication = () => {
    if (preview && !preview.closed) preview.close();
    handle?.close(); handle = undefined;
    removePreparedNativeFile(nativeFile);
    parts.length = 0;
  };
  operation.signal.addEventListener("abort", cancelPublication, { once: true });
  try {
    if (Platform.OS !== "web") {
      nativeFile = await createPreparedNativeFile(attachment.filename);
      if (!operation.isCurrent()) return false;
      handle = nativeFile.open();
    }
    const count = Math.ceil(attachment.size_bytes / PART_BYTES);
    let fullDigest = attachment.sha256;
    for (let index = 0; index < count; index += 1) {
      const response = await kitchenProjectsApi.downloadPart(projectId, attachment.id, index);
      if (!operation.isCurrent()) return false;
      const bytes = decoded(response.data_base64);
      if (response.index !== index || response.size_bytes !== attachment.size_bytes || bytes.length !== Math.min(PART_BYTES, attachment.size_bytes - index * PART_BYTES)) throw new Error("File part failed length verification.");
      const partDigest = await digest(bytes);
      if (!operation.isCurrent()) return false;
      if (partDigest !== response.sha256) throw new Error("File part failed integrity verification.");
      if (fullDigest && fullDigest !== response.file_sha256) throw new Error("File changed during download.");
      fullDigest = response.file_sha256;
      if (handle) handle.writeBytes(bytes);
      else parts.push(new Uint8Array(bytes));
      progress(Math.floor((index + 1) * 100 / count));
    }
    if (nativeFile) {
      handle!.close(); handle = undefined;
      const resultDigest = await digest(await nativeFile.bytes());
      if (!operation.isCurrent()) return false;
      if (resultDigest !== fullDigest) throw new Error("Downloaded file failed integrity verification.");
      return await sharePreparedNativeFile(nativeFile, attachment.filename, attachment.content_type, "project document", operation);
    }
    const blob = new Blob(parts, { type: attachment.content_type });
    const resultDigest = await digest(new Uint8Array(await blob.arrayBuffer()));
    if (!operation.isCurrent()) return false;
    if (resultDigest !== fullDigest) throw new Error("Downloaded file failed integrity verification.");
    if (preview) {
      if (preview.closed) throw new Error("The PDF preview was closed. Open it again.");
      const url = URL.createObjectURL(blob);
      preview.location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 120_000);
      return true;
    }
    return await savePreparedFile(blob, attachment.filename, "project document", operation);
  } catch (error) {
    if (!operation.isCurrent()) return false;
    throw error;
  } finally {
    operation.signal.removeEventListener("abort", cancelPublication);
    operation.finish();
    handle?.close();
    removePreparedNativeFile(nativeFile);
  }
}
