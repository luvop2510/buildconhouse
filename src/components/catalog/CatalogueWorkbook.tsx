import { randomUUID } from "expo-crypto";
import { useCallback, useEffect, useRef, useState } from "react";
import { Switch, View } from "react-native";
import type { DocumentPickerAsset } from "expo-document-picker";

import {
  catalogueApi, cataloguePath, sendCatalogueParts, type CatalogueJob, type CatalogueJobInput,
  type CatalogueOperation, type CatalogueOptions,
} from "@/src/api/catalogueManagement";
import { Text } from "@/src/components/AppText";
import { ConfirmDialog, Dropdown } from "@/src/components/ds";
import { Alert, Button, Card, TextField } from "@/src/components/ui";
import { colors, spacing, type } from "@/src/theme/tokens";
import { downloadApiFile } from "@/src/utils/downloadFile";
import { storage } from "@/src/utils/storage";
import { catalogueError } from "./CatalogueManualForms";

const OPERATIONS: { id: CatalogueOperation; label: string; requires: string[] }[] = [
  { id: "add", label: "Add new products", requires: ["catalogue_bulk", "catalogue_products_add"] },
  { id: "prices", label: "Update prices only", requires: ["catalogue_prices"] },
  { id: "update", label: "Update existing products", requires: ["catalogue_bulk", "catalogue_products_edit"] },
  { id: "sync", label: "Add and update products", requires: ["catalogue_bulk", "catalogue_products_add", "catalogue_products_edit"] },
  { id: "images", label: "Update product images", requires: ["catalogue_images"] },
];
const STATUS: Record<string, string> = {
  upload: "Waiting for workbook", queued: "Reading and validating workbook", preview: "Ready to review",
  applying: "Applying changes", complete: "Import complete", failed: "Import needs attention",
  rolling_back: "Reversing import", rolled_back: "Import reversed",
};
const STAGES: Record<string, string> = {
  reading: "Reading the workbook",
  validating: "Validating products",
  processing_images: "Processing product images",
};
const COUNTS: Record<string, string> = {
  add: "New products", update: "Updated products", price: "Price changes", image: "Image changes",
  unchanged: "Unchanged", rejected: "Rejected", applied: "Rows applied", conflict: "Conflicts", restored: "Changes reversed",
  added: "Products added", updated: "Products updated", prices_updated: "Prices updated", images_updated: "Images updated",
};
const IN_PROGRESS = new Set(["queued", "applying", "rolling_back"]);
const NEW_BRAND = "__new";
const PAGE_SIZE = 50;
const supportedFile = /\.(xlsx|csv|pdf)$/i;
const displayOperation = (id: CatalogueOperation) => OPERATIONS.find(operation => operation.id === id)?.label || id;
const displayStatus = (status: string) => STATUS[status] || status.replaceAll("_", " ");
const displayDate = (value?: string) => {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
};
const money = (amount: number) => amount.toLocaleString("en-IN", { style: "currency", currency: "INR" });

export function CatalogueWorkbook({
  options, actorId, floorId, activeFloorId, signal, request, refresh,
}: {
  options: CatalogueOptions;
  actorId: string;
  floorId: string;
  activeFloorId: string;
  signal: AbortSignal;
  request: ReturnType<typeof catalogueApi>;
  refresh: () => void;
}) {
  const permits = (capability: string) => options.capabilities.includes(capability);
  const allowed = OPERATIONS.filter(operation => operation.requires.every(permits));
  const canView = permits("catalogue_view");
  const canHistory = permits("catalogue_history");
  const canReverse = permits("catalogue_rollback");
  const [operationId, setOperationId] = useState<CatalogueOperation>(allowed[0]?.id || "add");
  const operation = allowed.find(operation => operation.id === operationId) || allowed[0];
  const canExportPrices = operation?.id === "prices" && permits("catalogue_prices");
  const [brandId, setBrandId] = useState("");
  const [newBrand, setNewBrand] = useState("");
  const [createCategories, setCreateCategories] = useState(false);
  const [asset, setAsset] = useState<DocumentPickerAsset | null>(null);
  const selection = useRef<{ key: string; signature: string } | null>(null);
  const [job, setJob] = useState<CatalogueJob | null>(null);
  const rememberedJob = useRef("");
  const jobId = job?.id;
  const status = job?.status;
  const [rowOffset, setRowOffset] = useState(0);
  const [history, setHistory] = useState<CatalogueJob[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState("");
  const pendingAction = useRef(false);
  const [failure, setFailure] = useState("");
  const [confirm, setConfirm] = useState<"apply" | "rollback" | null>(null);
  const storageKey = `forge.catalogue.active-job.${actorId}.${floorId}`;
  const brand = options.brands.find(brand => brand.id === brandId);
  const creatingBrand = brandId === NEW_BRAND;
  const canCreateBrand = permits("catalogue_brands") && (operation?.id === "add" || operation?.id === "sync");
  const canCreateCategory = permits("catalogue_categories") && Boolean(operation && ["add", "update", "sync"].includes(operation.id));
  const publish = useCallback((next: CatalogueJob) => {
    if (signal.aborted || !next.id) return;
    setJob(next);
    if (rememberedJob.current !== next.id) {
      rememberedJob.current = next.id;
      void storage.setItem(storageKey, next.id);
    }
  }, [signal, storageKey]);

  useEffect(() => {
    if (!allowed.length && !canHistory) return;
    let current = true;
    void storage.getItem<string>(storageKey, "").then(id => id && current && !signal.aborted ? request.job(id) : null)
      .then(saved => { if (saved && current && !signal.aborted && !pendingAction.current) publish(saved); })
      .catch(() => {});
    return () => { current = false; };
  }, [allowed.length, canHistory, request, signal, storageKey, publish]);

  useEffect(() => {
    if (!jobId || !status || !IN_PROGRESS.has(status) || busy) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await request.job(jobId);
        if (!current || signal.aborted || pendingAction.current) return;
        publish(data);
        setFailure("");
        if (data.status === "complete" || data.status === "rolled_back") refresh();
        else if (IN_PROGRESS.has(data.status)) timer = setTimeout(poll, 1500);
      } catch {
        if (current && !signal.aborted) {
          setFailure("The progress check was interrupted. Reopen this import to check its status.");
          timer = setTimeout(poll, 5000);
        }
      }
    };
    timer = setTimeout(poll, 900);
    return () => { current = false; clearTimeout(timer); };
  }, [jobId, status, busy, request, publish, refresh, signal]);

  const run = async (name: string, action: () => Promise<void>, fallback: string) => {
    if (pendingAction.current || signal.aborted) return;
    pendingAction.current = true;
    setBusy(name); setFailure("");
    try { await action(); }
    catch (error) { if (!signal.aborted) setFailure(catalogueError(error, fallback)); }
    finally {
      pendingAction.current = false;
      if (!signal.aborted) setBusy("");
    }
  };
  const chooseFile = () => run("choose", async () => {
    const picker = await import("expo-document-picker");
    const result = await picker.getDocumentAsync({ type: "*/*", copyToCacheDirectory: true, multiple: false, base64: false });
    if (result.canceled || signal.aborted) return;
    const file = result.assets[0];
    const size = file.file?.size ?? file.size;
    if (!supportedFile.test(file.name) || !size || size > options.max_bytes) {
      setFailure(`Choose a nonempty XLSX, CSV or PDF file up to ${Math.floor(options.max_bytes / 1024 ** 2)} MB.`);
      return;
    }
    if (job?.status === "upload" && (file.name !== job.filename || job.size_bytes && size !== job.size_bytes)) {
      setFailure("Select the original workbook to resume this upload.");
      return;
    }
    setAsset({ ...file, size }); setProgress(0);
    if (!job) selection.current = null;
  }, "Could not select the file. Try choosing it again.");

  const upload = () => run("upload", async () => {
    if (!asset?.size || !operation && !job) return;
    const settings: Omit<CatalogueJobInput, "key"> | undefined = job ? undefined : {
      operation: operation!.id, filename: asset.name, size_bytes: asset.size,
      ...(creatingBrand ? { brand_name: newBrand.trim(), create_brand: true } : { brand_id: brandId }),
      ...(canCreateCategory && createCategories ? { create_categories: true } : {}),
    };
    let target = job;
    if (!target && settings) {
      const signature = JSON.stringify(settings);
      if (selection.current?.signature !== signature) selection.current = { signature, key: randomUUID() };
      target = await request.start({ ...settings, key: selection.current.key });
      if (!target.id) throw new Error("No import identity was returned.");
      publish(target);
    }
    if (!target || signal.aborted || target.status !== "upload") return;
    setProgress(0);
    await sendCatalogueParts(asset, options.part_bytes, signal, (index, bytes) => request.putPart(target.id, index, bytes), setProgress);
    if (signal.aborted) return;
    publish(await request.command(target.id, "preview"));
  }, "The upload stopped. Re-select the same file if needed, then retry this import.");

  const openHistory = () => run("history", async () => {
    const jobs = await request.history();
    if (!signal.aborted) { setHistory(jobs); setShowHistory(true); }
  }, "Could not load import history. Try again.");
  const openJob = (id: string, offset = 0) => run("job", async () => {
    const data = await request.job(id, offset);
    if (!signal.aborted) {
      if (jobId !== id) { setAsset(null); setProgress(0); }
      publish(data); setRowOffset(offset);
    }
  }, "Could not load this import. Try again.");
  const command = (action: "apply" | "resume" | "rollback") => {
    if (!job) return;
    return run(action, async () => {
      const result = await request.command(job.id, action);
      if (signal.aborted) return;
      publish(result); setConfirm(null); setRowOffset(0);
      if (result.status === "complete" || result.status === "rolled_back") refresh();
    }, "Could not confirm the import action. Refresh this import to check its status.");
  };

  const clearJob = () => {
    if (pendingAction.current) return;
    setJob(null); setProgress(0); setAsset(null); setFailure(""); setRowOffset(0);
    selection.current = null; rememberedJob.current = ""; void storage.removeItem(storageKey);
  };
  const download = (kind: "template" | "export" | "prices" | "errors") => run(kind, async () => {
    const activeOperation = kind === "prices" ? "prices" : kind === "export" ? "add" : operation?.id || "add";
    const query: Record<string, string> = kind === "errors" ? {} : { operation: activeOperation };
    if (kind === "export" || kind === "prices") query.brand_id = brandId;
    const route = kind === "errors" ? `/jobs/${encodeURIComponent(jobId || "")}/errors.xlsx` : `/${kind === "prices" ? "export" : kind}.xlsx`;
    await downloadApiFile(cataloguePath(floorId, route, query), `buildcon-${floorId}-${kind}.xlsx`, `catalogue ${kind}`, activeFloorId);
  }, "Could not download the workbook. Please try again.");

  const ownsJob = !job?.created_by || job.created_by === actorId;
  const canActOnJob = ownsJob && allowed.some(operation => operation.id === job?.operation);
  const canResume = job?.failed_phase === "rolling_back" ? canReverse : canActOnJob;
  const reversible = job?.status === "complete" || job?.status === "failed" && job.failed_phase === "applying";
  const validBrand = Boolean(brand || creatingBrand && canCreateBrand && newBrand.trim());
  const chosenFile = asset?.name || job?.filename;
  const actionable = Object.entries(job?.summary || {}).some(([key, count]) => ["add", "update", "price", "image"].includes(key) && count > 0);
  const currentRows = job?.rows || [];

  if (!canView && !allowed.length && !canHistory && !canReverse) return null;
  return <>
    {canView || allowed.length ? <Card testID="catalogue-workbook" style={{ gap: spacing.md }}>
      <Text accessibilityRole="header" style={type.titleMd}>Excel workbooks</Text>
      {allowed.length ? <Dropdown testID="catalogue-operation" label={operation?.label || "Choose import type"}
        items={allowed.map(item => ({ label: item.label, disabled: Boolean(job || busy), onPress: () => {
          setOperationId(item.id); setCreateCategories(false);
          if (creatingBrand && item.id !== "add" && item.id !== "sync") setBrandId("");
        } }))} /> : null}
      <Dropdown testID="catalogue-workbook-brand" label={creatingBrand ? "Create a brand" : brand?.name || "Choose a brand"}
        items={[...options.brands.map(item => ({ label: item.name, disabled: Boolean(job || busy), onPress: () => setBrandId(item.id) })),
          ...(canCreateBrand ? [{ label: "Create a brand", disabled: Boolean(job || busy), onPress: () => setBrandId(NEW_BRAND) }] : [])]} />
      {creatingBrand && canCreateBrand ? <TextField label="New brand name" value={newBrand} editable={!job && !busy} onChangeText={setNewBrand} maxLength={100} /> : null}
      <View style={styles.actions}>
        {allowed.length ? <Button label="Download Excel template" icon="download" variant="secondary"
          disabled={Boolean(busy)} loading={busy === "template"} onPress={() => void download("template")} /> : null}
        {canView ? <Button label="Export existing catalogue" icon="download" variant="secondary"
          disabled={!brand || Boolean(busy)} loading={busy === "export"} onPress={() => void download("export")} /> : null}
        {canExportPrices ? <Button label="Export brand price workbook" icon="download" variant="secondary"
          disabled={!brand || Boolean(busy)} loading={busy === "prices"} onPress={() => void download("prices")} /> : null}
      </View>
      {allowed.length && (!job || job.status === "upload" && canActOnJob) ? <>
        <Text style={type.bodyMuted}>{operation?.id === "prices"
          ? "Export your brand, fill the New MRP column offline, then upload it here. Leave unchanged prices blank."
          : "Fill the downloaded template offline. For product photos, place one photo on its product row in Excel."}</Text>
        {!job && canCreateCategory ? <View style={styles.actions}>
          <Switch value={createCategories} onValueChange={setCreateCategories} disabled={Boolean(busy)} accessibilityLabel="Create missing categories" />
          <Text style={type.body}>Create missing categories</Text>
        </View> : null}
        <View style={styles.actions}>
          <Button label="Choose workbook" icon="upload" variant="secondary" disabled={Boolean(busy) || !job && !validBrand}
            loading={busy === "choose"} onPress={() => void chooseFile()} />
          {asset ? <Button label={job ? "Resume upload" : "Upload and preview"} loading={busy === "upload"}
            disabled={Boolean(busy) || !job && !validBrand} onPress={() => void upload()} /> : null}
        </View>
        {chosenFile ? <Text accessibilityLiveRegion="polite" style={type.bodyMuted}>{chosenFile}{busy === "upload" ? ` · ${progress}% uploaded` : ""}</Text> : null}
      </> : null}
    </Card> : null}

    {failure ? <Alert tone="error" title={failure} /> : null}

    {job ? <Card testID="catalogue-active-import" style={{ gap: spacing.md }}>
      <View accessibilityLiveRegion="polite" style={{ gap: spacing.xs }}>
        <Text accessibilityRole="header" style={type.titleMd}>{displayStatus(job.status)}</Text>
        <Text style={type.bodyMuted}>{[job.filename, job.brand_name, displayOperation(job.operation)].filter(Boolean).join(" · ")}</Text>
      </View>
      {job.error ? <Alert tone="error" title={job.error} /> : null}
      {job.warnings?.length ? <View style={{ gap: spacing.xs }}>
        {job.warnings.slice(0, 5).map((warning, index) => <Text key={index} style={type.bodyMuted}>{warning}</Text>)}
      </View> : null}
      {job.status === "queued" && job.stage && STAGES[job.stage] ? <Text accessibilityLiveRegion="polite" style={type.bodyMuted}>{STAGES[job.stage]}</Text> : null}
      {job.status === "applying" && typeof job.processed_through === "number" ? <Text accessibilityLiveRegion="polite" style={type.bodyMuted}>{job.processed_through + 1} rows checked</Text> : null}
      <JobCounts values={job.rollback_result || job.result || job.summary}
        assets={job.status === "preview" ? job.assets_to_attach : undefined}
        categories={job.status === "preview" ? job.categories_to_create : undefined} />
      {job.missing_from_source_total ? <Text style={type.bodyMuted}>
        {job.missing_from_source_total} saved articles absent from this source. Download the report for article numbers.
      </Text> : null}
      {currentRows.length && ["preview", "complete", "failed", "rolled_back"].includes(job.status) ? <>
        <Text accessibilityRole="header" style={type.titleSm}>{job.status === "preview" ? "Preview changes" : "Rows"}</Text>
        {currentRows.map(row => <View key={`${row.sheet || ""}:${row.row}:${row.sku || ""}`}
          style={{ borderTopColor: colors.divider, borderTopWidth: 1, paddingVertical: spacing.sm, gap: 4 }}>
          <Text style={type.bodyStrong}>{[row.sheet, `Row ${row.row}`, row.sku].filter(Boolean).join(" · ")}</Text>
          <Text style={type.bodyMuted}>{COUNTS[row.action || ""] || row.action || "Check row"}{row.outcome ? ` · ${row.outcome}` : ""}</Text>
          {typeof row.previous_mrp === "number" && typeof row.delta?.mrp === "number" ?
            <Text style={type.body}>{money(row.previous_mrp)} → {money(row.delta.mrp)}</Text> : null}
          {row.errors?.length || row.error ? <Text style={[type.bodyMuted, { color: colors.error }]}>{[...(row.errors || []), row.error].filter(Boolean).join(" · ")}</Text> : null}
        </View>)}
        {(job.total_rows || 0) > PAGE_SIZE ? <View style={styles.actions}>
          <Button label="Previous rows" variant="secondary" disabled={!rowOffset || Boolean(busy)}
            onPress={() => void openJob(job.id, Math.max(0, rowOffset - PAGE_SIZE))} />
          <Text style={type.bodyMuted}>{rowOffset + 1}–{rowOffset + currentRows.length} of {job.total_rows}</Text>
          <Button label="Next rows" variant="secondary" disabled={rowOffset + PAGE_SIZE >= (job.total_rows || 0) || Boolean(busy)}
            onPress={() => void openJob(job.id, rowOffset + PAGE_SIZE)} />
        </View> : null}
      </> : null}
      <View style={styles.actions}>
        {job.status === "preview" && canActOnJob && actionable ? <Button label="Confirm import" icon="check"
          disabled={Boolean(busy)} onPress={() => setConfirm("apply")} /> : null}
        {job.status === "failed" && canResume ? <Button label="Resume import" icon="refresh-cw" variant="secondary"
          loading={busy === "resume"} disabled={Boolean(busy)} onPress={() => void command("resume")} /> : null}
        {reversible && canReverse ? <Button label="Reverse import" variant="secondary" icon="rotate-ccw"
          disabled={Boolean(busy)} onPress={() => setConfirm("rollback")} /> : null}
        {["preview", "complete", "failed", "rolled_back"].includes(job.status) ?
          <Button label="Download error report" variant="secondary" icon="download" loading={busy === "errors"}
            disabled={Boolean(busy)} onPress={() => void download("errors")} /> : null}
        <Button label="Refresh status" variant="ghost" disabled={Boolean(busy)} onPress={() => void openJob(job.id, rowOffset)} />
        {allowed.length && !IN_PROGRESS.has(job.status) ? <Button label="Start another import" variant="ghost" disabled={Boolean(busy)} onPress={clearJob} /> : null}
      </View>
    </Card> : null}

    {canHistory ? <Card style={{ gap: spacing.md }} testID="catalogue-history">
      <Text accessibilityRole="header" style={type.titleMd}>Import history</Text>
      <Button label={showHistory ? "Refresh import history" : "View import history"} variant="secondary" icon="clock"
        loading={busy === "history"} disabled={Boolean(busy)} onPress={() => void openHistory()} />
      {showHistory && !history?.length ? <Text style={type.bodyMuted}>No imports yet for this department.</Text> : null}
      {showHistory ? history?.map(item => <View key={item.id} style={{ borderTopColor: colors.divider, borderTopWidth: 1, paddingTop: spacing.sm, gap: 4 }}>
        <Text style={type.bodyStrong}>{item.filename}</Text>
        <Text style={type.bodyMuted}>{[item.brand_name, displayDate(item.created_at), displayStatus(item.status)].filter(Boolean).join(" · ")}</Text>
        <Button label={`Open ${item.filename}`} variant="ghost" size="sm" disabled={Boolean(busy)}
          onPress={() => void openJob(item.id)} />
      </View>) : null}
    </Card> : null}

    <ConfirmDialog visible={Boolean(confirm)} onClose={() => { if (!pendingAction.current) setConfirm(null); }}
      onConfirm={() => { if (confirm) void command(confirm); }} tone={confirm === "rollback" ? "danger" : "brand"}
      title={confirm === "rollback" ? "Reverse this import?" : "Apply the verified changes?"}
      description={confirm === "rollback"
        ? "Only changes from this import that still match its results will be reversed. Later edits are kept."
        : "The catalogue will be updated with the accepted rows. Rejected rows will remain in the error report."}
      confirmLabel={confirm === "rollback" ? "Reverse import" : "Apply changes"}
      loading={Boolean(busy)} error={failure || undefined} testID="catalogue-confirm" />
  </>;
}

function JobCounts({ values, assets, categories }: { values?: Record<string, number>; assets?: number; categories?: number }) {
  const entries = Object.entries(values || {}).filter(([label, count]) => label in COUNTS && typeof count === "number");
  if (!entries.length && !assets && !categories) return null;
  return <View style={styles.actions} testID="catalogue-import-counts">
    {entries.map(([label, count]) => <View key={label} style={{ backgroundColor: colors.surfaceSecondary, borderRadius: 8, padding: spacing.sm }}>
      <Text style={type.titleSm}>{count.toLocaleString("en-IN")}</Text>
      <Text style={type.caption}>{COUNTS[label]}</Text>
    </View>)}
    {assets ? <Text style={type.bodyMuted}>{assets} images to attach</Text> : null}
    {categories ? <Text style={type.bodyMuted}>{categories} new categories</Text> : null}
  </View>;
}

const styles = { actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing.sm } as const };
