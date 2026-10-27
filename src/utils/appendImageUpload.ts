import { Platform } from "react-native";
import { uriToBlob } from "./uriToBlob";

export type UploadImage = { uri: string; mimeType?: string | null; fileName?: string | null; fileSize?: number; file?: File };

/** Browsers require a Blob; native FormData streams the system picker's URI. */
export async function appendImageUpload(form: FormData, image: UploadImage): Promise<void> {
  if (image.fileSize && image.fileSize > 20 * 1024 * 1024) throw new Error("Choose a product photo smaller than 20 MB.");
  const mime = image.mimeType || "image/jpeg";
  const name = image.fileName || `product-photo.${(mime.split("/")[1] || "jpg").replace("jpeg", "jpg")}`;
  if (Platform.OS === "web") {
    // Expo's web picker supplies the original File. Fetching its blob URI is
    // blocked by production connect-src; use the bytes already selected locally.
    const blob = image.file || await uriToBlob(image.uri);
    if (blob.size > 20 * 1024 * 1024) throw new Error("Choose a product photo smaller than 20 MB.");
    const prepared = await prepareWebPhoto(blob.type ? blob : new Blob([blob], { type: mime }));
    form.append("file", prepared, prepared.type === mime ? name : `product-photo.${prepared.type.split("/")[1]}`);
  } else {
    form.append("file", { uri: image.uri, name, type: mime } as unknown as Blob);
  }
}

const WEB_PHOTO_BYTES = 3 * 1024 * 1024;
const SUPPORTED_MIMES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"]);

/** Bound hosted multipart bodies while preserving small original photographs. */
export async function prepareWebPhoto(blob: Blob): Promise<Blob> {
  if (blob.size <= WEB_PHOTO_BYTES && SUPPORTED_MIMES.has(blob.type)) return blob;
  const url = URL.createObjectURL(blob);
  try {
    const decoded = await new Promise<HTMLImageElement>((resolve, reject) => {
      const picture = new Image();
      picture.onload = () => resolve(picture);
      picture.onerror = () => reject(new Error("This photo format could not be read. Choose a JPG, PNG or WebP photo."));
      picture.src = url;
    });
    const scale = Math.min(1, 2400 / Math.max(decoded.naturalWidth, decoded.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(decoded.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(decoded.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not prepare the photo. Choose a smaller JPG, PNG or WebP photo.");
    const transparent = blob.type === "image/png" || blob.type === "image/webp";
    const types = transparent ? ["image/webp", "image/jpeg"] : ["image/jpeg"];
    for (const type of types) {
      if (type === "image/jpeg") { ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      ctx.drawImage(decoded, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.9, 0.8, 0.65]) {
        const compressed = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, quality));
        if (compressed && compressed.type === type && compressed.size <= WEB_PHOTO_BYTES) return compressed;
      }
    }
    throw new Error("This photo is too large to upload. Choose a smaller JPG, PNG or WebP photo.");
  } finally { URL.revokeObjectURL(url); }
}
