import { useEffect, useState } from "react";
import { formatPhone } from "@/src/utils/phone";
import { usePathname } from "expo-router";
import { Pressable, View } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { Text } from "@/src/components/AppText";
import { EmptyState, ErrorState, LoadingState, SearchField, Sheet } from "@/src/components/ds";
import { NavigationLink } from "@/src/design/NavigationLink";
import { kitchenProjectsApi, STAGE_LABELS, type KitchenPage, type KitchenProject } from "@/src/api/kitchenProjects";
import { KitchenButton as Button, kitchenColors as colors, kitchenType as type } from "./KitchenPrimitives";

/** Search every authorized stage; queue filters never narrow this customer lookup. */
export function KitchenCustomerSearch({ inline = false, compact = false }: { inline?: boolean; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  if (inline) return <SearchResults returnTo={pathname} />;
  return <>
    {compact ? <Pressable accessibilityRole="button" accessibilityLabel="Search all Kitchen customers" onPress={() => setOpen(true)} testID="kitchen-universal-search-open" style={{ minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" }}><Feather name="search" size={20} color={colors.onSurfaceSecondary} /></Pressable> : <Button label="Search customers" icon="search" variant="ghost" onPress={() => setOpen(true)} testID="kitchen-universal-search-open" />}
    <Sheet scroll visible={open} onClose={() => setOpen(false)} title="Search all Kitchen customers" testID="kitchen-universal-search-sheet">
      {open ? <SearchResults returnTo={pathname} onSelect={() => setOpen(false)} /> : null}
    </Sheet>
  </>;
}

function SearchResults({ returnTo, onSelect }: { returnTo: string; onSelect?: () => void }) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [response, setResponse] = useState<{ key: string; value: KitchenPage<KitchenProject> } | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const term = search.trim();
  const queryKey = JSON.stringify([term, page]);
  const result = response?.key === queryKey ? response.value : null;
  useEffect(() => {
    const controller = new AbortController();
    setResponse(null); setFailure(null); setLoading(Boolean(term));
    if (!term) return () => controller.abort();
    const timer = setTimeout(() => {
      kitchenProjectsApi.list({ search: term, page, limit: 20 }, controller.signal)
        .then(value => { if (!controller.signal.aborted) setResponse({ key: queryKey, value }); })
        .catch(error => { if (!controller.signal.aborted) setFailure(error instanceof Error ? error.message : "Please try again."); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [term, page, queryKey, retry]);
  return <View style={{ gap: 16, minWidth: 0 }} testID="kitchen-universal-search-region">
    <SearchField accessibilityLabel="Search all Kitchen customers" placeholder="Name, phone or project" value={search} maxLength={250} onChangeText={value => { setSearch(value); setPage(1); }} onClear={() => { setSearch(""); setPage(1); }} testID="kitchen-universal-search" />
    <Text style={type.caption}>Search all nine stages by name, contact or project.</Text>
    {!term ? null : loading ? <LoadingState label="Searching Kitchen customers…" /> : failure ? <ErrorState title="Customer search unavailable" subtitle={failure} onRetry={() => setRetry(value => value + 1)} /> : result ? <>
      <Text style={type.caption} accessibilityLiveRegion="polite">{result.total} matching {result.total === 1 ? "project" : "projects"}{result.total > 20 ? ` · Page ${page} of ${Math.ceil(result.total / 20)}` : ""}</Text>
      {!result.rows.length ? <EmptyState title="No matching Kitchen customers" subtitle="Try a different name, phone number or project reference." /> : result.rows.map(project => <NavigationLink key={project.id} href={`/kitchen/${encodeURIComponent(project.id)}/stages/${project.stage}?details=1&returnTo=${encodeURIComponent(returnTo)}` as any} onPress={onSelect} testID={`kitchen-search-project-${project.id}`} accessibilityLabel={`View ${project.customer.name}, ${STAGE_LABELS[project.stage]}, ${project.project_reference || project.reference}`} style={({ hovered, pressed }) => ({ padding: 16, gap: 6, minHeight: 72, borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: hovered || pressed ? colors.surfaceTertiary : colors.surfaceSecondary })}>
        <Text style={type.bodyStrong}>{project.customer.name}</Text>
        <Text style={type.body}>{STAGE_LABELS[project.stage]} · {project.status || project.lifecycle_status || "In progress"}</Text>
        <Text style={type.caption}>{[project.project_reference || project.reference, formatPhone(project.customer.phone), project.customer.property_name, project.customer.city].filter(Boolean).join(" · ")}</Text>
      </NavigationLink>)}
      {result.total > 20 ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}><Button label="Previous results" variant="secondary" disabled={page <= 1} onPress={() => setPage(value => value - 1)} /><Button label="Next results" variant="secondary" disabled={page * 20 >= result.total} onPress={() => setPage(value => value + 1)} /></View> : null}
    </> : null}
  </View>;
}
