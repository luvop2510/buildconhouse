type ExportPage<T> = { rows: T[]; total: number; page: number; has_more: boolean; next_page: number | null };

/** Fetch every filtered page. A changing or oversized dataset fails without a partial workbook. */
export async function collectPagedExportRows<T>(
  readPage: (page: number) => Promise<ExportPage<T>>,
  signal: AbortSignal,
  onProgress: (message: string) => void,
): Promise<T[]> {
  const rows: T[] = [];
  let page = 1, total: number | undefined;
  while (true) {
    if (signal.aborted) throw new Error("Export cancelled");
    const result = await readPage(page);
    if (signal.aborted) throw new Error("Export cancelled");
    if (!Number.isSafeInteger(result.total) || result.total < 0 || result.total > 4999) {
      throw new Error("This export exceeds 4,999 rows. Narrow the filters and try again.");
    }
    if (result.page !== page) throw new Error("The export returned an unexpected page. Try again.");
    total ??= result.total;
    if (total !== result.total) throw new Error("The list changed during export. Try exporting again.");
    rows.push(...result.rows);
    if (rows.length > total || rows.length > 4999) throw new Error("The list changed during export. Try exporting again.");
    onProgress(`Reading ${rows.length} of ${total} rows…`);
    if (!result.has_more) {
      if (rows.length !== total) throw new Error("The list changed during export. Try exporting again.");
      return rows;
    }
    if (!result.rows.length || !Number.isSafeInteger(result.next_page) || result.next_page! <= page) {
      throw new Error("The export could not read the complete list. Try again.");
    }
    page = result.next_page!;
  }
}

