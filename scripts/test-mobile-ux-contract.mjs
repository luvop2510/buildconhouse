import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const scaffold = read("../src/components/mobile/AppScaffold.tsx");
assert.match(scaffold, /edges=\{phoneSafeArea \? \["top", "left", "right"\] : \[\]\}/);
assert.match(scaffold, /edges=\{\["bottom"\]\}/);

const adminShell = read("../app/(admin)/_layout.tsx");
// Every viewport reads the same destinations; floor and permission filtering
// precedes the phone priority list, including the two notebook departments.
const navigation = read("../src/design/navigation.ts");
assert.match(adminShell, /import \{ PRIMARY, SECONDARY, TILES_ITEMS, type NavItem \} from "@\/src\/design\/navigation"/);
assert.match(adminShell, /const all = \[\.\.\.visible\(PRIMARY\), \.\.\.tilesNav\.items, \.\.\.visible\(SECONDARY\)\]/);
// Exercise the actual priority expression rather than pinning its source spelling.
const priorityExpression = adminShell.match(/const priorities = ([\s\S]*?);\n\s*const more/);
assert.ok(priorityExpression, "Phone navigation must define its visible priority destinations");
const prioritiesFor = new Function("all", "notebook", "selectedFloorId", "KITCHEN_FLOOR_ID", "FURNITURE_FLOOR_ID", "TILES_FLOOR_ID", `return (${priorityExpression[1]});`);
const destination = (match, href = `/${match}`) => ({ match, href });
const kitchenDestinations = ["kitchen-lead", "kitchen-visit", "kitchen-cad", "kitchen-design", "kitchen-quotation", "kitchen-order", "kitchen-production", "kitchen-installation", "kitchen-completed"].map(key => destination(key));
const sharedDestinations = [destination("walkins"), destination("followups"), destination("customers"), destination("settings")];
const priorityMatches = (all, floor) => prioritiesFor(all, ["second-floor", "third-floor"].includes(floor), floor, "second-floor", "third-floor", "ground-floor").map(item => item.match);
assert.deepEqual(priorityMatches([destination("dashboard"), destination("kitchen-dashboard"), ...kitchenDestinations, ...sharedDestinations], "second-floor"), ["dashboard", "kitchen-dashboard", "kitchen-lead"]);
assert.deepEqual(priorityMatches([destination("dashboard"), kitchenDestinations[1], ...sharedDestinations], "second-floor"), ["dashboard"], "A hidden Kitchen destination must not be reintroduced into the phone bar");
assert.deepEqual(priorityMatches([...sharedDestinations, destination("furniture-quotations", "/notebook/furniture-quotations")], "third-floor"), ["walkins", "followups", "furniture-quotations"]);
assert.deepEqual(priorityMatches(["dashboard", "catalog", "quotations", "followups", "payments"].map(key => destination(key)), "first-floor"), ["dashboard", "catalog", "quotations", "followups"]);
assert.match(adminShell, /selectedFloorId === KITCHEN_FLOOR_ID \|\| selectedFloorId === FURNITURE_FLOOR_ID/);
assert.match(adminShell, /hasAccess\(item\.match\)/);
assert.match(adminShell, /bottom-nav-notebook-workspace/);
assert.match(adminShell, /const more = all\.filter/);
assert.doesNotMatch(adminShell, /bottom-fab-new-quotation/);
// A phone has one workspace switcher, above the active page. The More sheet
// must not mount a second copy that can race a route transition.
assert.doesNotMatch(adminShell, /<Sheet open=\{moreOpen\}[\s\S]*?title="Workspace">\s*<FloorSwitcher/);
assert.match(navigation, /match: "quotations", floors: \[SANITARY_FLOOR_ID\]/);
assert.match(navigation, /match: "purchases", floors: \[SANITARY_FLOOR_ID\]/);
assert.doesNotMatch(navigation, /quotation-follow-up|Kitchen lead notebook|Furniture lead notebook/);
assert.match(navigation, /match: "catalog", floors: \[SANITARY_FLOOR_ID, TILES_FLOOR_ID\]/);

const permissions = read("../src/hooks/use-permissions.ts");
assert.match(permissions, /tiles:\s*"tiles"/);
const accessProfiles = read("../src/access-profiles.ts");
assert.match(accessProfiles, /tiles:\s*"\/\(admin\)\/tiles"/);

const phoneSafeAreaRoutes = [
  "../app/(admin)/payments.tsx",
  "../app/(admin)/payments-list.tsx",
  "../app/(admin)/quotations/[id]/place-order.tsx",
  "../app/(admin)/customers/index.tsx",
  "../app/(admin)/customers/new.tsx",
  "../app/(admin)/customers/[id].tsx",
  "../app/(admin)/customers/[id]/edit.tsx",
  "../app/(admin)/walkins/index.tsx",
  "../app/(admin)/walkins/new.tsx",
  "../app/(admin)/walkins/[id].tsx",
  "../app/(admin)/purchase-orders/[id].tsx",
];
for (const path of phoneSafeAreaRoutes) {
  assert.match(read(path), /edges=\{isPhone \? \[\] : \["top"\]\}/, `${path} bypasses AppScaffold's phone top inset`);
}

const followups = read("../app/(admin)/followups.tsx");
// Follow-ups deliberately uses one full-width workspace. Selecting a customer
// opens a transient preview sheet rather than reserving a permanent desktop
// context column.
assert.match(followups, /renderFollowupList\(isPhone, !isPhone\)/);
assert.match(followups, /const ownsScroll = phone \|\| includeWorkspaceHeader/);
assert.match(followups, /ListHeaderComponent=\{ownsScroll/);
assert.match(followups, /scrollEnabled=\{ownsScroll\}/);
assert.match(followups, /const \[customerPreviewOpen, setCustomerPreviewOpen\] = useState\(false\)/);
assert.match(followups, /visible=\{customerPreviewOpen\}/);
assert.match(followups, /persistent right-hand panel/);
assert.match(followups, /const listRequestVersion = useRef\(0\)/);
assert.match(followups, /\/followups\/page\?\$\{params\.toString\(\)\}/);
assert.match(followups, /testID="followups-previous-page"/);
assert.match(followups, /testID="followups-next-page"/);
assert.match(followups, /style=\{styles\.mobileDetailScroll\} contentContainerStyle=\{styles\.mobileDetailContent\}/);

const legacyBottomSheet = read("../src/components/BottomSheet.tsx");
assert.match(legacyBottomSheet, /import \{ Sheet \} from "@\/src\/design\/components"/);
assert.doesNotMatch(legacyBottomSheet, /\bModal\b/);

const tileMovementSheets = read("../src/components/tiles/TileMovementSheets.tsx");
assert.match(tileMovementSheets, /import \{ Sheet \} from "@\/src\/design\/components"/);
assert.doesNotMatch(tileMovementSheets, /\bModal\b/);
assert.match(tileMovementSheets, /footer=\{<SheetFooter/);
assert.match(tileMovementSheets, /accessibilityLabel=\{`Enter quantity for \$\{name\}`\}/);

const tilesPicker = read("../src/components/tiles/TilesProductPicker.tsx");
assert.match(tilesPicker, /Could not load the tile catalog/);
assert.match(tilesPicker, /Retry loading tile catalog/);
assert.doesNotMatch(tilesPicker, /setResults\(\[\]\); setTotal\(0\);/);

const purchases = read("../app/(admin)/purchases.tsx");
assert.match(purchases, /import \{ Sheet \} from "@\/src\/design\/components"/);
assert.doesNotMatch(purchases, /\bModal\b/);
assert.match(purchases, /accessibilityRole="button"/);

const productImages = read("../src/components/catalog/ProductImageManager.tsx");
assert.match(productImages, /const \{ isPhone \} = useBp\(\)/);
assert.doesNotMatch(productImages, /winW >= 640/);

const catalogImport = read("../app/(admin)/catalog/import.tsx");
assert.match(catalogImport, /const \{ isPhone \} = useBp\(\)/);
assert.match(catalogImport, /styles\.reviewActionsPhone/);
assert.match(catalogImport, /styles\.urlRowPhone/);

const assignments = read("../app/(admin)/followup-assignments.tsx");
assert.match(assignments, /isPhone && styles\.rowPhone/);
assert.match(assignments, /statusMetaPhone/);

const paymentsList = read("../app/(admin)/payments-list.tsx");
assert.match(paymentsList, /isPhone && styles\.searchPhone/);
assert.match(paymentsList, /isPhone && styles\.pageButtonsPhone/);

const tileTable = read("../src/components/tiles/TileTable.tsx");
assert.match(tileTable, /scrollOwner === "parent"/);
assert.match(tileTable, /const innerScroll = Boolean\(fillViewport\).*scrollOwner === "self"/);
assert.match(tileTable, /enabled=\{innerScroll\}/);
assert.match(tileTable, /data\.map\(renderMobileRow\)/);

const systemSettings = read("../app/(admin)/settings-system.tsx");
assert.match(systemSettings, /scroll=\{false\}/);
assert.match(systemSettings, /<ScrollView/);

const notebook = read("../src/components/notebook/NotebookScreen.tsx");
assert.match(notebook, /const \{ isPhone \} = useBp\(\)/);
assert.match(notebook, /<FlatList/);
assert.match(notebook, /testID="notebook-list"/);
assert.doesNotMatch(notebook, /<DataTable/);

const quotationDetail = read("../app/(admin)/quotations/[id]/index.tsx");
assert.match(quotationDetail, /isPhone \? \(\s*<IconButton icon="download"/);
assert.match(quotationDetail, /linkedPoRowPhone/);

const customerDetail = read("../app/(admin)/customers/[id].tsx");
assert.match(customerDetail, /const openQuotation = \(quotation: Quotation\)/);
assert.match(customerDetail, /const manageQuotation = \(quotation: Quotation\)/);
assert.match(customerDetail, /\/\(admin\)\/tiles\/\$\{quotation\.doc_type === "tiles_selection" \? "selection" : "quotation"\}\?id=\$\{quotation\.id\}/);

const quotationList = read("../app/(admin)/quotations/index.tsx");
// Completed is the sole quotation lifecycle list and retains delivered orders.
assert.doesNotMatch(quotationList, /quotations-fulfilled-toggle/);
assert.match(quotationList, /doc_type: "standard", view: outcome \|\| \(completed \? "completed" : "pending"\)/);
assert.match(quotationList, /summary: "true"/);
assert.match(quotationList, /purchase_completion_status === "completed"/);
assert.match(quotationList, /100% completed/);
assert.match(quotationList, /quotations-lifecycle-toggle/);

const tileList = read("../app/(admin)/tiles/index.tsx");
assert.doesNotMatch(tileList, /tiles-fulfilled-toggle/);
assert.match(tileList, /doc_type=\$\{docType\}&view=\$\{completed \? "completed" : "pending"\}/);
assert.match(tileList, /DOC_TYPES.*\["tiles_selection", "tiles_quotation"\]/);
assert.match(tileList, /Promise\.all\(DOC_TYPES\.map\(loadType\)\)/);
assert.match(tileList, /floorId: "ground-floor"/);
assert.match(tileList, /if \(!floor.ready \|\| scopeRef.current !== scope\) return/);
assert.match(tileList, /purchase_completion_status === "completed"/);
assert.match(tileList, /tiles-lifecycle-toggle/);

const builderShell = read("../src/components/quotation/layout/BuilderShell.tsx");
const quotationPane = read("../src/components/quotation/panes/QuotationPane.tsx");
const explorer = read("../src/components/quotation/catalog/ProductExplorer.tsx");
assert.match(builderShell, /mobileWorkspaceCollapsed/);
assert.match(quotationPane, /collapse-quotation-workspace/);
assert.match(quotationPane, /expand-quotation-workspace/);
assert.match(explorer, /initialNumToRender=\{catalogGridRows\(numCols, showCompactFilters \? 20 : 16\)\}/);

const placeOrder = read("../app/(admin)/quotations/[id]/place-order.tsx");
assert.match(placeOrder, /confirmBarPhone: \{ flexDirection: "column", alignItems: "stretch" \}/);
assert.match(placeOrder, /fullWidth=\{isPhone\}/);

const productModal = read("../src/components/quotation/sheets/ProductModal.tsx");
assert.match(productModal, /phoneSheet: \{/);
assert.match(productModal, /bodyPhone: \{ flexDirection: "column"/);
assert.match(productModal, /edges=\{isPhone \? \["bottom"\] : \[\]\}/);

const customProduct = read("../src/components/quotation/sheets/CustomProductSheet.tsx");
assert.match(customProduct, /\[styles\.grid, isPhone && styles\.phoneGrid\]/);

console.log("mobile shell, sheet, list ownership, quotation flow, and notebook navigation contracts passed");
