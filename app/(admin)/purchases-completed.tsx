import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { api } from "@/src/api/client";
import { getPurchaseCustomerWorkspace, getPurchasesPage, type PurchaseCustomerWorkspace, type PurchaseItem } from "@/src/api/purchases";
import { HistorySheet } from "@/src/components/purchases/MovementEngine";
import { toast } from "@/src/components/Toast";
import { Button, EmptyState, ErrorState, PageHeader } from "@/src/components/ds";
import { useBp } from "@/src/design/responsive";
import { useFloorAccess } from "@/src/hooks/use-floor-access";
import { colors, spacing } from "@/src/theme/tokens";
import { downloadSectionExcel } from "@/src/utils/sectionExcel";
import { CustomerNavigator, CustomerPurchasePanel } from "./purchases";

type CompletedCustomer = { id: string; name: string; count: number; quantity: number; completed_at?: string | null };

export default function CompletedPurchases() {
  const router = useRouter();
  const { isPhone } = useBp();
  const { selectedFloorId } = useFloorAccess();
  const [customers, setCustomers] = useState<CompletedCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<PurchaseCustomerWorkspace | null>(null);
  const [products, setProducts] = useState<PurchaseItem[]>([]);
  const [nextSkip, setNextSkip] = useState<number | null>(null);
  const [loadingWorkspace, setLoadingWorkspace] = useState(false);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const selectedCustomer = useRef(selectedId);
  selectedCustomer.current = selectedId;
  const requestSequence = useRef(0);
  const activeFloor = useRef(selectedFloorId);
  activeFloor.current = selectedFloorId;

  const load = useCallback(async (skip = 0) => {
    if (!selectedFloorId || activeFloor.current !== selectedFloorId) return;
    const sequence = ++requestSequence.current;
    if (skip) setLoadingMore(true); else setLoading(true);
    setError(null);
    try {
      const page = await api.get<CompletedCustomer[]>(`/purchases/customers/completed?skip=${skip}&limit=100`, { floorId: selectedFloorId });
      if (activeFloor.current !== selectedFloorId || sequence !== requestSequence.current) return;
      setCustomers((current) => skip ? [...current, ...page] : page); setHasMore(page.length === 100);
    } catch (cause: any) { if (activeFloor.current === selectedFloorId && sequence === requestSequence.current) setError(cause?.detail || "Could not load completed customers."); }
    finally { if (activeFloor.current === selectedFloorId && sequence === requestSequence.current) { setLoading(false); setLoadingMore(false); } }
  }, [selectedFloorId]);
  useFocusEffect(useCallback(() => { setCustomers([]); setSelectedId(null); setWorkspace(null); setProducts([]); setHistoryId(null); void load(); return () => { requestSequence.current += 1; }; }, [load]));

  useEffect(() => {
    if (!selectedId || !selectedFloorId) return;
    const controller = new AbortController();
    setLoadingWorkspace(true); setWorkspace(null); setProducts([]);
    Promise.all([getPurchaseCustomerWorkspace(selectedId, controller.signal, selectedFloorId), getPurchasesPage({ view: "stock", customer: selectedId, limit: 100 }, controller.signal, selectedFloorId)])
      .then(([detail, page]) => { if (!controller.signal.aborted && activeFloor.current === selectedFloorId && selectedCustomer.current === selectedId) { if (page.total === 0 || page.summaries.stage_counts.dispatched !== page.total) { throw new Error("This customer has active products and is no longer 100% complete. Refresh the list."); } setWorkspace(detail); setProducts(page.items); setNextSkip(page.next_skip); } })
      .catch((cause) => { if (!controller.signal.aborted && activeFloor.current === selectedFloorId && selectedCustomer.current === selectedId) { setSelectedId(null); toast.error(cause?.detail || cause?.message || "Could not load customer purchases"); } })
      .finally(() => { if (!controller.signal.aborted && activeFloor.current === selectedFloorId && selectedCustomer.current === selectedId) setLoadingWorkspace(false); });
    return () => controller.abort();
  }, [selectedId, selectedFloorId]);

  const loadMoreProducts = async () => {
    if (!selectedId || nextSkip === null || loadingWorkspace || activeFloor.current !== selectedFloorId) return;
    setLoadingWorkspace(true);
    try {
      const page = await getPurchasesPage({ view: "stock", customer: selectedId, skip: nextSkip, limit: 100 }, undefined, selectedFloorId);
      if (activeFloor.current !== selectedFloorId || selectedCustomer.current !== selectedId) return;
      setProducts((current) => [...current, ...page.items]); setNextSkip(page.next_skip);
    } catch (cause: any) { if (activeFloor.current === selectedFloorId && selectedCustomer.current === selectedId) toast.error(cause?.detail || "Could not load more products"); }
    finally { if (activeFloor.current === selectedFloorId && selectedCustomer.current === selectedId) setLoadingWorkspace(false); }
  };
  const exportRows = () => void downloadSectionExcel({ resource: "purchases",
    page: "Purchases", section: "100% completed customers", filename: "purchases-completed-customers.xlsx",
    rows: [["Customer", "Delivered products", "Delivered quantity", "Last delivered"], ...customers.map((customer) => [customer.name, customer.count, customer.quantity, customer.completed_at || ""])],
  }).catch((cause: unknown) => toast.error(cause instanceof Error ? cause.message : "Could not export completed customers"));

  return <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={isPhone ? [] : ["top"]}>
    <ScrollView contentContainerStyle={{ width: "100%", maxWidth: 1000, alignSelf: "center", padding: isPhone ? spacing.md : spacing.xl, gap: spacing.lg, paddingBottom: 100 }}>
      <PageHeader embedded title="100% Customers" subtitle="Every active product dispatched and delivered" back={() => router.back()} />
      {!loading && !error && customers.length > 0 ? <Button label="Export completed customers .xlsx" icon="download" variant="secondary" onPress={exportRows} /> : null}
      {error ? <ErrorState title="Completed customers unavailable" subtitle={error} onRetry={() => void load()} /> : !loading && customers.length === 0 ? <EmptyState icon="check-circle" title="No completed customers yet" subtitle="Customers appear once every active product is dispatched. Partial dispatch stays in active purchases." /> : <CustomerNavigator completed loading={loading} customers={customers.map((customer) => ({ ...customer, company: `${customer.count} delivered products · ${customer.quantity} units${customer.completed_at ? ` · ${new Date(customer.completed_at).toLocaleDateString("en-IN")}` : ""}` }))} onOpen={setSelectedId} />}
      {hasMore && !loading ? <Button label={loadingMore ? "Loading…" : "Load more customers"} variant="secondary" disabled={loadingMore} onPress={() => void load(customers.length)} /> : null}
    </ScrollView>
    <CustomerPurchasePanel visible={!!selectedId} loading={loadingWorkspace && !workspace} workspace={workspace} products={products} readOnly onClose={() => setSelectedId(null)} onMove={() => {}} onTransfer={() => {}} onHistory={(item) => setHistoryId(item.item_id)} onLoadMore={nextSkip !== null ? () => void loadMoreProducts() : undefined} loadingMore={loadingWorkspace} />
    <HistorySheet visible={!!historyId} itemId={historyId} onClose={() => setHistoryId(null)} />
  </SafeAreaView>;
}
