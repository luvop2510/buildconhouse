// Customer Portal — responsive quotation detail (read-only).
import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { api } from "@/src/api/client";
import { Button, Card, StatusBadge } from "@/src/components/ui";
import {
  CustomerEmpty,
  CustomerError,
  CustomerHeader,
  CustomerPage,
  CustomerSectionHeading,
  CustomerSkeletonCard,
  formatCustomerDate,
} from "@/src/components/customer/CustomerPortal";
import { colors, money, spacing, type } from "@/src/theme/tokens";
import { useBp } from "@/src/design/responsive";
import { openPortalPdf } from "@/src/utils/portalPdf";

type Item = { id: string; name: string; sku: string; qty: number; unit_price: number; room?: string };
type Revision = { revision_no: number; created_at: string; reason?: string };
type BrandGroup = { brand_id: string | null; brand_name: string; item_count: number; subtotal: number };
type Detail = {
  id: string;
  number: string;
  status: string;
  created_at: string;
  valid_until?: string;
  items: Item[];
  grand_total: number;
  project_name?: string;
  revisions: Revision[];
  brands: BrandGroup[];
};

export default function CustomerQuotationDetail() {
  const { isPhone } = useBp();
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const router = useRouter();
  const [doc, setDoc] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(false);
    setDoc(null);
    if (!id) {
      setError(true);
      setLoading(false);
      return;
    }
    try {
      const result = await api.get<Detail>(`/portal/quotations/${id}`, { signal });
      if (!signal?.aborted) setDoc(result);
    } catch {
      if (!signal?.aborted) setError(true);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const download = async (key: string, path: string, filename: string) => {
    setDownloading(key);
    setDownloadError(false);
    try {
      await openPortalPdf(path, filename);
    } catch {
      setDownloadError(true);
    } finally {
      setDownloading(null);
    }
  };

  return (
    <CustomerPage
      testID="customer-quote-detail"
      header={(
        <CustomerHeader
          title={doc?.number || "Quotation"}
          subtitle={doc?.project_name || "Shared quotation"}
          back={() => router.back()}
        />
      )}
      contentStyle={styles.content}
    >
      {loading ? (
        <>
          <CustomerSkeletonCard detail />
          <CustomerSkeletonCard detail />
        </>
      ) : error || !doc ? (
        <CustomerError detail onRetry={() => { void load(); }} />
      ) : (
        <>
          {downloadError ? (
            <Card style={styles.downloadError}>
              <Feather name="alert-circle" size={16} color={colors.error} />
              <Text role="alert" aria-live="assertive" style={[type.bodyMuted, styles.downloadErrorCopy]}>The PDF could not be downloaded. Please try again.</Text>
            </Card>
          ) : null}

          <Card style={styles.summaryCard}>
            <View style={styles.summaryTop}>
              <View style={styles.summaryMeta}>
                <Text style={type.caption}>{formatCustomerDate(doc.created_at, true)}</Text>
                {doc.valid_until ? <Text style={type.caption}>Valid until {formatCustomerDate(doc.valid_until)}</Text> : null}
              </View>
              <StatusBadge status={doc.status} />
            </View>
            <View style={styles.totalBlock}>
              <Text style={type.caption}>Grand total</Text>
              <Text style={styles.grandTotal} numberOfLines={2}>{money(doc.grand_total)}</Text>
            </View>
            <Button
              testID="download-latest-pdf"
              label="Download quotation PDF"
              icon="download"
              fullWidth
              loading={downloading === "latest"}
              onPress={() => void download("latest", `/quotations/${doc.id}/portal-pdf`, `${doc.number}.pdf`)}
            />
          </Card>

          <CustomerSectionHeading title="Items" count={doc.items.length} />
          {doc.items.length === 0 ? (
            <Card style={styles.emptyCard}><CustomerEmpty title="No line items" subtitle="This quotation does not contain any items yet." /></Card>
          ) : (
            <Card style={styles.listCard}>
              {doc.items.map((item, index) => (
                <View key={item.id}>
                  {index > 0 ? <View style={styles.divider} /> : null}
                  <View style={[styles.itemRow, isPhone && styles.itemRowPhone]}>
                    <View style={styles.itemCopy}>
                      <Text style={type.bodyStrong} numberOfLines={3}>{item.name}</Text>
                      <Text style={type.caption} numberOfLines={3}>
                        {item.sku}{item.room ? ` · ${item.room}` : ""} · Qty {item.qty}
                      </Text>
                    </View>
                    <Text style={[styles.itemAmount, isPhone && styles.itemAmountPhone]} numberOfLines={2}>{money(item.qty * item.unit_price)}</Text>
                  </View>
                </View>
              ))}
            </Card>
          )}

          {doc.revisions?.length > 0 ? (
            <>
              <CustomerSectionHeading title="Previous revisions" />
              <Card style={styles.listCard}>
                {doc.revisions.map((revision, index) => (
                  <View key={revision.revision_no}>
                    {index > 0 ? <View style={styles.divider} /> : null}
                    <View style={[styles.actionRow, isPhone && styles.actionRowPhone]}>
                      <View style={styles.actionCopy}>
                        <Text style={type.bodyStrong}>Revision {revision.revision_no}</Text>
                        <Text style={type.caption} numberOfLines={3}>
                          {formatCustomerDate(revision.created_at)}{revision.reason ? ` · ${revision.reason}` : ""}
                        </Text>
                      </View>
                      <Button
                        testID={`download-revision-${revision.revision_no}`}
                        label="Download"
                        icon="download"
                        size="sm"
                        variant="secondary"
                        fullWidth={isPhone}
                        loading={downloading === `revision-${revision.revision_no}`}
                        onPress={() => void download(`revision-${revision.revision_no}`, `/quotations/${doc.id}/portal-pdf/revision/${revision.revision_no}`, `${doc.number}-rev${revision.revision_no}.pdf`)}
                      />
                    </View>
                  </View>
                ))}
              </Card>
            </>
          ) : null}

          {doc.brands?.length > 1 ? (
            <>
              <CustomerSectionHeading title="Download by brand" />
              <Card style={styles.listCard}>
                {doc.brands.map((brand, index) => {
                  const brandKey = brand.brand_id ?? "unassigned";
                  return (
                    <View key={brandKey}>
                      {index > 0 ? <View style={styles.divider} /> : null}
                      <View style={[styles.actionRow, isPhone && styles.actionRowPhone]}>
                        <View style={styles.brandCopy}>
                          <Feather name="tag" size={16} color={colors.onSurfaceMuted} />
                          <View style={styles.actionCopy}>
                            <Text style={type.bodyStrong} numberOfLines={3}>{brand.brand_name}</Text>
                            <Text style={type.caption} numberOfLines={2}>{brand.item_count} item{brand.item_count === 1 ? "" : "s"} · {money(brand.subtotal)}</Text>
                          </View>
                        </View>
                        <Button
                          testID={`download-brand-${brandKey}`}
                          label="Download"
                          icon="download"
                          size="sm"
                          variant="secondary"
                          fullWidth={isPhone}
                          loading={downloading === `brand-${brandKey}`}
                          onPress={() => void download(`brand-${brandKey}`, `/quotations/${doc.id}/portal-pdf/brand/${brandKey}`, `${doc.number}-${brand.brand_name}.pdf`)}
                        />
                      </View>
                    </View>
                  );
                })}
              </Card>
            </>
          ) : null}
        </>
      )}
    </CustomerPage>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: spacing.lg },
  downloadError: { flexDirection: "row", alignItems: "center", gap: spacing.sm, backgroundColor: colors.errorBg, borderColor: colors.errorBorder },
  downloadErrorCopy: { flex: 1, minWidth: 0, color: colors.error },
  summaryCard: { gap: spacing.lg },
  summaryTop: { flexDirection: "row", alignItems: "flex-start", flexWrap: "wrap", gap: spacing.sm },
  summaryMeta: { flex: 1, minWidth: 150, gap: 2 },
  totalBlock: { gap: 2 },
  grandTotal: { ...type.monoLg, fontSize: 28, lineHeight: 36 },
  emptyCard: { padding: 0 },
  listCard: { gap: 0 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: spacing.md },
  itemRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md },
  itemCopy: { flex: 1, minWidth: 0, gap: 4 },
  itemAmount: { ...type.bodyStrong, minWidth: 88, maxWidth: 116, textAlign: "right", fontVariant: ["tabular-nums"] },
  itemRowPhone: { flexDirection: "column", gap: spacing.xs },
  itemAmountPhone: { minWidth: 0, maxWidth: undefined, textAlign: "left" },
  actionRow: { flexDirection: "row", alignItems: "flex-start", flexWrap: "wrap", gap: spacing.md, minHeight: 44 },
  actionRowPhone: { flexDirection: "column", alignItems: "stretch", gap: spacing.sm },
  actionCopy: { flex: 1, minWidth: 150, gap: 4 },
  brandCopy: { flex: 1, minWidth: 150, flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
});
