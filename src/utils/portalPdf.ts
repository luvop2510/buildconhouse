// Customer Portal's three PDF actions must save a file, including on iOS and
// iPadOS, rather than opening the in-browser viewer with no Files option.
import { downloadApiFile } from "@/src/utils/downloadFile";

export async function openPortalPdf(path: string, fallbackName = "quotation.pdf"): Promise<void> {
  await downloadApiFile(path, fallbackName, "PDF");
}
