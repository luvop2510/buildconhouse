// AI Catalog Import — supplier price tables with review before import
// Steps: pick brand → pick file → Claude extracts → human review → import
import { Feather } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View,
} from "react-native";

import { AdminPage } from "@/src/components/AdminPage";
import { Badge, Button, Card, EmptyState, ErrorState } from "@/src/components/ui";
import { toast } from "@/src/components/Toast";
import { api, csrfHeaders, getToken } from "@/src/api/client";
import { colors, radius, spacing, type } from "@/src/theme/tokens";
import { uriToBlob } from "@/src/utils/uriToBlob";
import { useBp } from "@/src/design/responsive";

const SUPPORTED = ["Hansgrohe", "Grohe", "Vitra", "Geberit", "MCM", "GRANOLAND"] as const;
type Brand = typeof SUPPORTED[number];
const MISSING = "[MISSING DATA]";
// Keep bulk edits gentle on the API and on the browser. This is deliberately
// small: the server remains the authority for row updates.
const ROW_PATCH_CONCURRENCY = 4;
const REVIEW_PAGE_SIZE = 50;

type Row = {
  row_id: string; brand: string; name: string; sku: string; category: string;
  finish: string; material: string; dimensions: string; warranty: string;
  mrp: number | string; price: number | string; confidence: number;
  issues: string[]; status: "pending" | "accepted" | "rejected";
  import_state?: "succeeded" | "failed";
  import_error?: string | null;
};

type Job = {
  id: string; filename: string; source_type: "excel" | "pdf" | "csv";
  supplier_name: string; total_rows: number; accepted_rows: number;
  rejected_rows: number; status: string; rows: Row[]; created_at: string;
  import_progress?: { completed: number; failed: number; total: number };
  extraction?: {
    pages: number; raw_rows: number; parsed_rows: number;
    images_found: number; images_mapped: number; warnings?: string[];
  };
  certification?: {
    overall_score: number; production_ready: boolean;
    extraction_accuracy: number; sku_accuracy: number; price_accuracy: number;
    category_accuracy: number; variant_accuracy: number; image_accuracy: number;
    duplicate_score: number; missing_data_score: number;
    total_products: number; products_ready: number; products_needing_review: number;
    families_detected: number; duplicates_sku: number;
    missing_images: number; missing_mrp: number; missing_categories: number;
    variant_conflicts?: string[]; category_conflicts?: string[]; warnings?: string[];
  };
};

type RowOperation = {
  busy?: boolean;
  failedPatch?: Record<string, unknown>;
  error?: string;
};

function requestError(error: any) {
  return error?.detail || error?.message || "Could not save this row. Try again.";
}

async function runBounded<T>(items: T[], worker: (item: T) => Promise<void>, concurrency = ROW_PATCH_CONCURRENCY) {
  let next = 0;
  const consume = async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, consume));
}

export default function CatalogImport() {
  const router = useRouter();
  const { isPhone } = useBp();
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [jobsError, setJobsError] = useState(false);
  const [brand, setBrand] = useState<Brand>("Hansgrohe");
  const [current, setCurrent] = useState<Job | null>(null);
  const [uploading, setUploading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [rowOperations, setRowOperations] = useState<Record<string, RowOperation>>({});
  const [acceptingAll, setAcceptingAll] = useState(false);
  const [reviewPage, setReviewPage] = useState(0);
  const [retryingImportRows, setRetryingImportRows] = useState<Record<string, boolean>>({});
  const processingJobId = current?.status === "processing" ? current.id : null;

  useEffect(() => {
    setRowOperations({});
    setReviewPage(0);
  }, [current?.id]);

  const loadJobs = useCallback(async () => {
    setJobsError(false);
    try { setJobs(await api.get<Job[]>("/catalog/imports")); }
    catch { setJobsError(true); }
  }, []);
  useEffect(() => { loadJobs(); }, [loadJobs]);

  // Approval runs as a bounded server-side job. Poll only while that job is
  // active, keeping the review visible so failed rows can be retried safely.
  useEffect(() => {
    if (!processingJobId) return;
    let active = true;
    const refresh = async () => {
      try {
        const job = await api.get<Job>(`/catalog/imports/${processingJobId}`);
        if (!active) return;
        setCurrent((previous) => previous?.id === processingJobId ? job : previous);
        if (job.status !== "processing") void loadJobs();
      } catch {
        // Keep the last known status and let the next poll recover from a
        // transient network failure; avoid noisy toasts every few seconds.
      }
    };
    void refresh();
    const timer = setInterval(refresh, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [processingJobId, loadJobs]);

  const pickAndUpload = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        multiple: false, copyToCacheDirectory: true,
        type: [
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "application/vnd.ms-excel", "application/pdf", "text/csv",
        ],
      });
      if (res.canceled || !res.assets?.[0]) return;
      const asset = res.assets[0];
      setUploading(true);
      const token = await getToken();

      const form = new FormData();
      form.append("brand", brand);
      const blob = await uriToBlob(asset.uri);
      form.append("file", blob, asset.name || "upload");

      const r = await fetch(`${api.base}/api/catalog/imports`, {
        method: "POST",
        // This multipart request bypasses the JSON API wrapper, so it must
        // explicitly carry the browser session's double-submit CSRF header.
        // (On web getToken() is intentionally null: auth is cookie-backed.)
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...csrfHeaders() },
        body: form,
        credentials: "same-origin",
      });
      const text = await r.text();
      if (!r.ok) {
        toast.error(text || `Upload failed (${r.status})`);
        return;
      }
      const job = JSON.parse(text) as Job;
      setCurrent(job);
      toast.success(`Extracted ${job.total_rows} rows via Claude Sonnet 4.5`);
      loadJobs();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong");
    } finally {
      setUploading(false);
    }
  };

  const saveRowPatch = async (row: Row, patch: Record<string, unknown>) => {
    if (!current || importing || current.status === "processing" || rowOperations[row.row_id]?.busy) return;
    const jobId = current.id;
    setCurrent((job) => job && job.id === jobId ? {
      ...job, rows: job.rows.map((candidate) => candidate.row_id === row.row_id ? { ...candidate, ...patch } : candidate),
    } : job);
    setRowOperations((operations) => ({ ...operations, [row.row_id]: { busy: true } }));
    try {
      await api.patch(`/catalog/imports/${jobId}/rows/${row.row_id}`, patch);
      setRowOperations((operations) => {
        const { [row.row_id]: _, ...rest } = operations;
        return rest;
      });
    } catch (error: any) {
      setRowOperations((operations) => ({
        ...operations,
        [row.row_id]: { failedPatch: patch, error: requestError(error) },
      }));
    }
  };

  const acceptAll = async () => {
    if (!current || acceptingAll || importing) return;
    const candidates = current.rows.filter((row) => row.status !== "accepted" && !rowOperations[row.row_id]?.busy);
    if (!candidates.length) return;
    setAcceptingAll(true);
    try {
      await runBounded(candidates, (row) => saveRowPatch(row, { status: "accepted" }));
    } finally {
      setAcceptingAll(false);
    }
  };

  const toggleRow = (row: Row, status: Row["status"]) => saveRowPatch(row, { status });
  const editField = (row: Row, field: keyof Row, value: unknown) => saveRowPatch(row, { [field]: value });
  const retryRowSave = (row: Row) => {
    const failedPatch = rowOperations[row.row_id]?.failedPatch;
    if (failedPatch) void saveRowPatch(row, failedPatch);
  };

  const retryImportRow = async (row: Row) => {
    if (!current || retryingImportRows[row.row_id]) return;
    setRetryingImportRows((rows) => ({ ...rows, [row.row_id]: true }));
    try {
      const job = await api.post<Job>(`/catalog/imports/${current.id}/rows/${row.row_id}/retry`);
      setCurrent((previous) => previous && previous.id === current.id ? { ...previous, status: job.status || "processing" } : previous);
      toast.success(`Retry queued for ${row.name}`);
    } catch (error: any) {
      toast.error(requestError(error));
    } finally {
      setRetryingImportRows((rows) => {
        const { [row.row_id]: _, ...rest } = rows;
        return rest;
      });
    }
  };

  const importAccepted = async () => {
    if (!current) return;
    setImporting(true);
    try {
      const res = await api.post<{ status: "processing"; progress: Job["import_progress"] }>(`/catalog/imports/${current.id}/approve`);
      setCurrent((job) => job ? { ...job, status: res.status, import_progress: res.progress } : job);
      toast.success("Import queued. This review will update as rows finish.");
    } catch (e: any) {
      toast.error(e?.detail || "Import failed");
    } finally {
      setImporting(false);
    }
  };

  // ---------- Review View ----------
  if (current) {
    const accepted = current.rows.filter((r) => r.status === "accepted").length;
    const rejected = current.rows.filter((r) => r.status === "rejected").length;
    const pending = current.rows.filter((r) => r.status === "pending").length;
    const cert = current.certification;
    const ext = current.extraction;
    const pageCount = Math.max(1, Math.ceil(current.rows.length / REVIEW_PAGE_SIZE));
    const safePage = Math.min(reviewPage, pageCount - 1);
    const pageRows = current.rows.slice(safePage * REVIEW_PAGE_SIZE, (safePage + 1) * REVIEW_PAGE_SIZE);
    const processing = importing || current.status === "processing";
    const changesInFlight = acceptingAll || Object.values(rowOperations).some((operation) => operation.busy);
    const progress = current.import_progress;
    return (
      <AdminPage
        title={`Review · ${current.supplier_name}`}
        subtitle={`${current.filename} · ${current.total_rows} products · Review before importing`}
        right={
          <View style={[styles.reviewActions, isPhone && styles.reviewActionsPhone]}>
            <Button label="Discard" variant="secondary" onPress={() => setCurrent(null)} disabled={processing || changesInFlight} testID="discard-import" fullWidth={isPhone} />
            <Button label={acceptingAll ? "Accepting…" : "Accept all"} icon="check-square" variant="secondary" onPress={acceptAll} disabled={processing || changesInFlight} loading={acceptingAll} testID="accept-all" fullWidth={isPhone} />
            <Button
              label={processing ? "Processing…" : `Import ${accepted} products`}
              icon="upload-cloud"
              onPress={importAccepted}
              loading={processing}
              disabled={accepted === 0 || changesInFlight || processing}
              testID="import-accepted"
              fullWidth={isPhone}
            />
          </View>
        }
      >
        {cert ? (
          <Card style={styles.certCard}>
            <View style={[styles.certHead, isPhone && styles.certHeadPhone]}>
              <View style={styles.certScore}>
                <Text style={styles.certScoreNum}>{cert.overall_score}%</Text>
                <Text style={styles.certScoreLabel}>Certification</Text>
              </View>
              <View style={{ flex: 1, gap: 4 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <Text style={type.titleLg}>{cert.production_ready ? "Production ready" : "Needs human review"}</Text>
                  <Badge tone={cert.production_ready ? "success" : "warning"} label={cert.production_ready ? "CERTIFIED" : "REVIEW"} />
                </View>
                <Text style={type.bodyMuted}>
                  {cert.products_ready} of {cert.total_products} products fully validated · {cert.families_detected} product families detected
                  {ext ? ` · ${ext.images_mapped}/${ext.images_found} images mapped` : ""}
                </Text>
              </View>
            </View>

            <View style={styles.scoresGrid}>
              {[
                ["SKU", cert.sku_accuracy], ["Price", cert.price_accuracy],
                ["Category", cert.category_accuracy], ["Variants", cert.variant_accuracy],
                ["Images", cert.image_accuracy], ["Duplicates", cert.duplicate_score],
              ].map(([k, v]) => (
                <View key={String(k)} style={styles.scorePill}>
                  <Text style={type.caption}>{k as string}</Text>
                  <Text style={[type.mono, { fontWeight: "700", color: (v as number) >= 90 ? colors.success : (v as number) >= 70 ? colors.warning : colors.error }]}>{v}%</Text>
                </View>
              ))}
            </View>

            {cert.duplicates_sku || cert.missing_mrp || cert.missing_images || cert.missing_categories ? (
              <View style={styles.issueSummary}>
                {cert.duplicates_sku ? <Badge tone="error" label={`${cert.duplicates_sku} duplicate SKUs`} /> : null}
                {cert.missing_mrp ? <Badge tone="warning" label={`${cert.missing_mrp} missing MRP`} /> : null}
                {cert.missing_categories ? <Badge tone="warning" label={`${cert.missing_categories} missing category`} /> : null}
                {cert.missing_images ? <Badge tone="warning" label={`${cert.missing_images} without image`} /> : null}
              </View>
            ) : null}
          </Card>
        ) : null}

        <View style={{ flexDirection: "row", gap: 8 }}>
          <Badge tone="success" label={`${accepted} accepted`} />
          <Badge tone="warning" label={`${pending} pending`} />
          <Badge tone="error" label={`${rejected} rejected`} />
        </View>

        {processing && progress ? <View accessibilityLiveRegion="polite" style={styles.importProgress}><ActivityIndicator size="small" color={colors.brand} /><Text style={type.caption}>Importing in the background: {progress.completed + progress.failed} / {progress.total} complete{progress.failed ? ` · ${progress.failed} failed` : ""}</Text></View> : null}

        <View accessibilityLabel={`Review page ${safePage + 1} of ${pageCount}. Showing ${pageRows.length} of ${current.rows.length} import rows.`} style={[styles.reviewPagination, isPhone && styles.reviewPaginationPhone]}>
          <Text style={type.caption}>Showing {safePage * REVIEW_PAGE_SIZE + 1}–{Math.min((safePage + 1) * REVIEW_PAGE_SIZE, current.rows.length)} of {current.rows.length}</Text>
          <View style={styles.pageActions}>
            <Pressable accessibilityRole="button" accessibilityLabel="Previous review page" accessibilityState={{ disabled: safePage === 0 }} disabled={safePage === 0} onPress={() => setReviewPage((page) => Math.max(0, page - 1))} style={[styles.pageButton, safePage === 0 && styles.disabledControl]}><Feather name="chevron-left" size={16} color={colors.onSurface} /></Pressable>
            <Text style={type.caption}>Page {safePage + 1} / {pageCount}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Next review page" accessibilityState={{ disabled: safePage >= pageCount - 1 }} disabled={safePage >= pageCount - 1} onPress={() => setReviewPage((page) => Math.min(pageCount - 1, page + 1))} style={[styles.pageButton, safePage >= pageCount - 1 && styles.disabledControl]}><Feather name="chevron-right" size={16} color={colors.onSurface} /></Pressable>
          </View>
        </View>

        <FlatList
          data={pageRows}
          keyExtractor={(r) => r.row_id}
          scrollEnabled={false}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={5}
          contentContainerStyle={{ gap: spacing.sm }}
          renderItem={({ item }) => {
            const operation = rowOperations[item.row_id];
            const disabled = processing || Boolean(operation?.busy);
            return (
            <Card style={styles.rowCard}>
              <View style={styles.rowHead}>
                <View style={{ flex: 1, gap: 2 }}>
                  <TextInput
                    testID={`row-name-${item.row_id}`}
                    defaultValue={item.name === MISSING ? "" : item.name}
                    onEndEditing={(event) => editField(item, "name", event.nativeEvent.text || MISSING)}
                    editable={!disabled}
                    accessibilityLabel={`Product name for ${item.sku === MISSING ? "unspecified SKU" : item.sku}`}
                    placeholder="Product name"
                    placeholderTextColor={colors.onSurfaceMuted}
                    style={styles.rowNameInput}
                  />
                  <View style={{ flexDirection: "row", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <Text style={type.mono}>{item.sku === MISSING ? "no-sku" : item.sku}</Text>
                    <Text style={type.caption}>· {item.category}</Text>
                    {item.confidence < 0.7 ? <Badge tone="warning" label={`${Math.round(item.confidence * 100)}%`} /> : null}
                  </View>
                </View>
                <View style={{ flexDirection: "row", gap: 6 }}>
                  <Pressable
                    testID={`reject-${item.row_id}`}
                    onPress={() => toggleRow(item, "rejected")}
                    disabled={disabled}
                    accessibilityRole="button"
                    accessibilityLabel={`Reject ${item.name}`}
                    accessibilityState={{ disabled, selected: item.status === "rejected" }}
                    style={[styles.iconBtn, item.status === "rejected" && { backgroundColor: colors.errorBg }, disabled && styles.disabledControl]}
                  >
                    <Feather name="x" size={14} color={item.status === "rejected" ? colors.error : colors.onSurfaceMuted} />
                  </Pressable>
                  <Pressable
                    testID={`accept-${item.row_id}`}
                    onPress={() => toggleRow(item, "accepted")}
                    disabled={disabled}
                    accessibilityRole="button"
                    accessibilityLabel={`Accept ${item.name}`}
                    accessibilityState={{ disabled, selected: item.status === "accepted" }}
                    style={[styles.iconBtn, item.status === "accepted" && { backgroundColor: colors.successBg }, disabled && styles.disabledControl]}
                  >
                    <Feather name="check" size={14} color={item.status === "accepted" ? colors.success : colors.onSurfaceMuted} />
                  </Pressable>
                </View>
              </View>

              <View style={styles.rowFields}>
                <FieldInput label="MRP ₹" value={item.mrp} onCommit={(v) => editField(item, "mrp", v === "" ? MISSING : Number(v))} keyboardType="decimal-pad" testID={`mrp-${item.row_id}`} disabled={disabled} accessibilityLabel={`MRP for ${item.name}`} />
                <FieldInput label="PRICE ₹" value={item.price} onCommit={(v) => editField(item, "price", v === "" ? MISSING : Number(v))} keyboardType="decimal-pad" testID={`price-${item.row_id}`} disabled={disabled} accessibilityLabel={`Price for ${item.name}`} />
                <FieldInput label="FINISH" value={item.finish} onCommit={(v) => editField(item, "finish", v || MISSING)} disabled={disabled} accessibilityLabel={`Finish for ${item.name}`} />
                <FieldInput label="MATERIAL" value={item.material} onCommit={(v) => editField(item, "material", v || MISSING)} disabled={disabled} accessibilityLabel={`Material for ${item.name}`} />
              </View>

              {operation?.busy ? <View accessibilityLiveRegion="polite" style={styles.rowSaveState}><ActivityIndicator size="small" color={colors.brand} /><Text style={type.caption}>Saving row…</Text></View> : null}
              {operation?.error ? <View accessibilityLiveRegion="polite" style={styles.rowFailure}><Text style={[type.caption, { color: colors.error, flex: 1 }]}>Save failed: {operation.error}</Text><Pressable testID={`retry-save-${item.row_id}`} accessibilityRole="button" accessibilityLabel={`Retry saving ${item.name}`} onPress={() => retryRowSave(item)} style={styles.retryButton}><Feather name="rotate-cw" size={13} color={colors.error} /><Text style={[type.caption, { color: colors.error, fontWeight: "700" }]}>Retry</Text></Pressable></View> : null}
              {item.import_state === "failed" ? <View accessibilityLiveRegion="polite" style={styles.rowFailure}><Text style={[type.caption, { color: colors.error, flex: 1 }]}>Import failed: {item.import_error || "Unknown import error"}</Text><Pressable testID={`retry-import-${item.row_id}`} accessibilityRole="button" accessibilityLabel={`Retry importing ${item.name}`} disabled={Boolean(retryingImportRows[item.row_id])} onPress={() => retryImportRow(item)} style={[styles.retryButton, retryingImportRows[item.row_id] && styles.disabledControl]}>{retryingImportRows[item.row_id] ? <ActivityIndicator size="small" color={colors.error} /> : <Feather name="rotate-cw" size={13} color={colors.error} />}<Text style={[type.caption, { color: colors.error, fontWeight: "700" }]}>Retry import</Text></Pressable></View> : null}
              {item.import_state === "succeeded" ? <View accessibilityLiveRegion="polite" style={styles.rowImported}><Feather name="check-circle" size={13} color={colors.success} /><Text style={[type.caption, { color: colors.success }]}>Imported</Text></View> : null}

              {item.issues?.length ? (
                <View style={styles.issueRow}>
                  <Feather name="alert-triangle" size={12} color={colors.warning} />
                  <Text style={[type.caption, { color: colors.warning, flex: 1 }]} numberOfLines={2}>
                    {item.issues.join(" · ")}
                  </Text>
                </View>
              ) : null}
            </Card>
            );
          }}
        />
      </AdminPage>
    );
  }

  const importFromUrl = async () => {
    if (!urlInput) return;
    setUploading(true);
    try {
      const job = await api.post<Job>("/catalog/imports/from-url", { brand, url: urlInput });
      setCurrent(job);
      toast.success(`Extracted ${job.total_rows} products · ${job.certification?.overall_score}% certified`);
      loadJobs();
      setUrlInput("");
    } catch (e: any) {
      toast.error(e?.detail || "Import failed");
    } finally {
      setUploading(false);
    }
  };

  // ---------- List / Upload View ----------
  return (
    <AdminPage
      title="AI Catalog Import"
      subtitle="Upload supplier price-lists — BuildCon House extracts, classifies, maps images and produces a certification report. Only 5 supplier brands are supported."
      right={
        <Pressable
          testID="back-to-catalog"
          onPress={() => router.back()}
          style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
        >
          <Feather name="chevron-left" size={16} color={colors.onSurface} />
          <Text style={{ fontSize: 13, fontWeight: "500" }}>Back</Text>
        </Pressable>
      }
    >
      {/* Uploader */}
      <Card>
        <Text style={type.overline}>Step 1 · Supplier</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
          {SUPPORTED.map((b) => (
            <Pressable
              key={b}
              testID={`brand-${b}`}
              onPress={() => setBrand(b)}
              style={[styles.brandChip, brand === b && styles.brandChipActive]}
            >
              <Text style={{ fontSize: 13, fontWeight: "700", color: brand === b ? colors.onBrand : colors.onSurface }}>{b}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={[type.overline, { marginTop: spacing.lg }]}>Step 2 · File</Text>
        <Pressable
          testID="upload-file"
          onPress={pickAndUpload}
          style={[styles.dropzone, uploading && { opacity: 0.6 }]}
        >
          {uploading ? (
            <>
              <ActivityIndicator color={colors.brand} />
              <Text style={[type.body, { marginTop: 8, fontWeight: "600" }]}>Claude is reading the catalog…</Text>
              <Text style={type.caption}>Extraction, normalization and classification typically take 3–15 seconds.</Text>
            </>
          ) : (
            <>
              <View style={styles.dropIcon}><Feather name="upload-cloud" size={24} color={colors.brand} /></View>
              <Text style={[type.titleMd, { marginTop: 12 }]}>Upload {brand} supplier catalog</Text>
              <Text style={[type.bodyMuted, { textAlign: "center", maxWidth: 380 }]}>
                Excel (.xlsx / .xls), PDF or CSV. The supplier file is always the source of truth — nothing is invented.
              </Text>
              <View style={{ flexDirection: "row", gap: 6, marginTop: 12, flexWrap: "wrap", justifyContent: "center" }}>
                <Badge label=".xlsx" />
                <Badge label=".xls" />
                <Badge label=".pdf" />
                <Badge label=".csv" />
              </View>
            </>
          )}
        </Pressable>

        <Text style={[type.overline, { marginTop: spacing.lg }]}>Or import from URL</Text>
        <View style={[styles.urlRow, isPhone && styles.urlRowPhone]}>
          <TextInput
            testID="url-input"
            value={urlInput}
            onChangeText={setUrlInput}
            placeholder="https://supplier.com/2026-pricelist.pdf"
            placeholderTextColor={colors.onSurfaceMuted}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.urlInput}
          />
          <Button label="Fetch" icon="link" onPress={importFromUrl} disabled={!urlInput || uploading} testID="fetch-url" fullWidth={isPhone} />
        </View>
      </Card>

      {/* Recent jobs */}
      <View>
        <Text style={type.overline}>Recent imports</Text>
        <View style={{ height: 8 }} />
        {jobsError ? <ErrorState title="Couldn't load import history" subtitle="Check your connection and try again." onRetry={loadJobs} /> : !jobs ? null : jobs.length === 0 ? (
          <EmptyState icon="database" title="No imports yet" subtitle="Upload your first supplier catalog to see the pipeline in action." />
        ) : (
          <Card style={{ padding: 0 }}>
            {jobs.map((j, i) => (
              <Pressable
                key={j.id}
                testID={`job-${j.id}`}
                onPress={async () => {
                  const full = await api.get<Job>(`/catalog/imports/${j.id}`);
                  setCurrent(full);
                }}
                style={({ pressed }) => [styles.jobRow, {
                  borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth, borderColor: colors.border,
                  backgroundColor: pressed ? colors.surfaceTertiary : "transparent",
                }]}
              >
                <View style={styles.jobIcon}>
                  <Feather name={j.source_type === "pdf" ? "file-text" : j.source_type === "csv" ? "database" : "grid"} size={16} color={colors.onSurface} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 13, fontWeight: "600" }} numberOfLines={1}>{j.filename}</Text>
                  <Text style={type.caption}>
                    {j.supplier_name} · {j.total_rows} rows · {new Date(j.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                  </Text>
                </View>
                <Badge
                  tone={j.status === "imported" ? "success" : j.status === "classified" ? "warning" : "neutral"}
                  label={j.status}
                />
              </Pressable>
            ))}
          </Card>
        )}
      </View>
    </AdminPage>
  );
}

function FieldInput({ label, value, onCommit, keyboardType = "default", testID, disabled = false, accessibilityLabel }: {
  label: string; value: string | number; onCommit: (v: string) => void;
  keyboardType?: "default" | "decimal-pad"; testID?: string; disabled?: boolean; accessibilityLabel: string;
}) {
  const display = value === MISSING || value === undefined || value === null ? "" : String(value);
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        defaultValue={display}
        onEndEditing={(event) => onCommit(event.nativeEvent.text)}
        editable={!disabled}
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ disabled }}
        keyboardType={keyboardType}
        placeholder={MISSING}
        placeholderTextColor={colors.warning}
        style={styles.fieldInput}
        selectTextOnFocus
        testID={testID}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  brandChip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSecondary,
  },
  brandChipActive: { backgroundColor: colors.brand, borderColor: colors.brand },
  dropzone: {
    marginTop: 8, alignItems: "center", justifyContent: "center", gap: 4,
    padding: spacing.xl, borderRadius: radius.md, borderWidth: 2, borderColor: colors.border,
    borderStyle: "dashed", backgroundColor: colors.surfaceTertiary,
  },
  dropIcon: {
    width: 48, height: 48, borderRadius: 999, backgroundColor: colors.brandTertiary,
    alignItems: "center", justifyContent: "center",
  },
  jobRow: {
    flexDirection: "row", alignItems: "center", gap: spacing.md, padding: spacing.md,
  },
  jobIcon: {
    width: 36, height: 36, borderRadius: 8, backgroundColor: colors.surfaceTertiary,
    alignItems: "center", justifyContent: "center",
  },
  rowCard: { padding: spacing.md, gap: spacing.sm },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowNameInput: {
    fontSize: 15, fontWeight: "700", color: colors.onSurface, padding: 0, paddingVertical: 2,
  },
  iconBtn: {
    width: 30, height: 30, borderRadius: 6, borderWidth: 1, borderColor: colors.border,
    alignItems: "center", justifyContent: "center", backgroundColor: colors.surfaceSecondary,
  },
  rowFields: {
    flexDirection: "row", gap: 6, flexWrap: "wrap",
  },
  field: {
    borderWidth: 1, borderColor: colors.border, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4,
    minWidth: 110, flex: 1, backgroundColor: colors.surface,
  },
  fieldLabel: { fontSize: 9, color: colors.onSurfaceMuted, fontWeight: "700", letterSpacing: 0.5 },
  fieldInput: {
    fontSize: 13, color: colors.onSurface, padding: 0, minWidth: 60,
  },
  issueRow: {
    flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.warningBg,
    padding: 8, borderRadius: 6,
  },
  urlInput: {
    flex: 1, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10, fontSize: 13, color: colors.onSurface,
  },
  urlRow: { flexDirection: "row", gap: 8, marginTop: 8 },
  urlRowPhone: { flexDirection: "column" },
  certCard: {
    padding: spacing.lg, gap: spacing.md, borderColor: colors.brandTertiary,
  },
  certHead: { flexDirection: "row", alignItems: "center", gap: spacing.lg },
  certHeadPhone: { alignItems: "flex-start" },
  certScore: {
    width: 96, height: 96, borderRadius: 48, backgroundColor: colors.surfaceInverse,
    alignItems: "center", justifyContent: "center",
  },
  certScoreNum: { color: colors.onBrand, fontSize: 26, fontWeight: "800", letterSpacing: -0.5 },
  certScoreLabel: { color: "rgba(255,255,255,0.7)", fontSize: 10, letterSpacing: 1.2, fontWeight: "600" },
  scoresGrid: {
    flexDirection: "row", gap: 8, flexWrap: "wrap",
  },
  scorePill: {
    flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 999, backgroundColor: colors.surfaceTertiary,
  },
  issueSummary: {
    flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4,
  },
  reviewPagination: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },
  reviewPaginationPhone: { alignItems: "flex-start", flexDirection: "column" },
  reviewActions: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  reviewActionsPhone: { flexDirection: "column", width: "100%" },
  pageActions: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  pageButton: { minWidth: 36, minHeight: 36, borderWidth: 1, borderColor: colors.border, borderRadius: 6, alignItems: "center", justifyContent: "center" },
  disabledControl: { opacity: 0.5 },
  rowSaveState: { flexDirection: "row", gap: 6, alignItems: "center" },
  rowFailure: { flexDirection: "row", gap: 8, alignItems: "center", backgroundColor: colors.errorBg, padding: 8, borderRadius: 6 },
  rowImported: { flexDirection: "row", gap: 6, alignItems: "center", backgroundColor: colors.successBg, padding: 8, borderRadius: 6 },
  importProgress: { flexDirection: "row", gap: 8, alignItems: "center", backgroundColor: colors.brandTertiary, padding: 10, borderRadius: 6 },
  retryButton: { minHeight: 36, paddingHorizontal: 8, flexDirection: "row", alignItems: "center", gap: 4, borderWidth: 1, borderColor: colors.error, borderRadius: 6 },
});