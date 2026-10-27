import { Platform } from "react-native";
import type { DocumentPickerAsset } from "expo-document-picker";
import { kitchenProjectsApi, type KitchenAttachment, type KitchenProject } from "@/src/api/kitchenProjects";
import { createPreparedNativeFile, savePreparedFile, sharePreparedNativeFile } from "@/src/utils/downloadFile";
import type { File as NativeFile, FileHandle } from "expo-file-system";

export const KITCHEN_MAX_FILE_BYTES = 25_000_000;
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
  progress: (percent: number) => void, transferStarted: (id: string) => void) {
  if (!file.size || file.size > KITCHEN_MAX_FILE_BYTES) throw new Error("Choose a nonempty file up to 25 MB (25,000,000 bytes).");
  if (Platform.OS === "web" && !file.file) throw new Error("The original selected file is unavailable. Choose it again.");
  const nativeFile = Platform.OS === "web" ? null : new (await import("expo-file-system")).File(file.uri);
  let native: FileHandle | undefined;
  try {
    const source = Platform.OS === "web" ? new Uint8Array(await file.file!.arrayBuffer()) : await nativeFile!.bytes();
    if (source.length !== file.size) throw new Error("The selected file changed. Choose it again.");
    const sha256 = await digest(source);
    native = nativeFile?.open();
    const transfer = await kitchenProjectsApi.beginTransfer(project.id, { expected_version: project.version,
      idempotency_key: key, filename: file.name, content_type: file.mimeType || "application/octet-stream", size_bytes: file.size, ...(sha256 ? { sha256 } : {}) });
    transferStarted(transfer.transfer_id);
    if (transfer.chunk_bytes !== PART_BYTES || transfer.size_bytes !== file.size) throw new Error("File transfer limits changed. Choose the file again.");
    if (transfer.state !== "completed") {
      for (let index = 0; index < transfer.part_count; index += 1) {
        const offset = index * PART_BYTES;
        let bytes: Uint8Array;
        if (Platform.OS === "web") bytes = new Uint8Array(await file.file!.slice(offset, Math.min(offset + PART_BYTES, file.size)).arrayBuffer());
        else { native!.offset = offset; bytes = native!.readBytes(Math.min(PART_BYTES, file.size - offset)); }
        await kitchenProjectsApi.uploadPart(project.id, transfer.transfer_id, index, encoded(bytes));
        progress(Math.floor((index + 1) * 95 / transfer.part_count));
      }
    }
    const saved = await kitchenProjectsApi.finishTransfer(project.id, transfer.transfer_id, project.version);
    progress(100);
    return saved;
  } finally { native?.close(); }
}

export async function downloadKitchenFile(projectId: string, attachment: KitchenAttachment, progress: (percent: number) => void) {
  if (!attachment.size_bytes || attachment.size_bytes > KITCHEN_MAX_FILE_BYTES) throw new Error("This file exceeds the supported download size.");
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let nativeFile: NativeFile | undefined;
  let handle: FileHandle | undefined;
  try {
    if (Platform.OS !== "web") {
      nativeFile = await createPreparedNativeFile(attachment.filename);
      handle = nativeFile.open();
    }
    const count = Math.ceil(attachment.size_bytes / PART_BYTES);
    let fullDigest = attachment.sha256;
    for (let index = 0; index < count; index += 1) {
      const response = await kitchenProjectsApi.downloadPart(projectId, attachment.id, index);
      const bytes = decoded(response.data_base64);
      if (response.index !== index || response.size_bytes !== attachment.size_bytes || bytes.length !== Math.min(PART_BYTES, attachment.size_bytes - index * PART_BYTES)) throw new Error("File part failed length verification.");
      const partDigest = await digest(bytes);
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
      if (resultDigest !== fullDigest) throw new Error("Downloaded file failed integrity verification.");
      return await sharePreparedNativeFile(nativeFile, attachment.filename, attachment.content_type, "project document");
    }
    const blob = new Blob(parts, { type: attachment.content_type });
    const resultDigest = await digest(new Uint8Array(await blob.arrayBuffer()));
    if (resultDigest !== fullDigest) throw new Error("Downloaded file failed integrity verification.");
    return await savePreparedFile(blob, attachment.filename, "project document");
  } finally {
    handle?.close();
    if (nativeFile?.exists) nativeFile.delete();
  }
}
