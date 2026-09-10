import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const scaffold = read("../src/components/mobile/AppScaffold.tsx");
assert.match(scaffold, /edges=\{\["top", "left", "right"\]\}/);
assert.match(scaffold, /edges=\{\["bottom"\]\}/);

const adminShell = read("../app/(admin)/_layout.tsx");
assert.match(adminShell, /if \(contextualNotebookTabs\)/);
assert.match(adminShell, /styles\.notebookPhoneBar/);
assert.match(adminShell, /bottom-nav-notebook-workspace/);
assert.doesNotMatch(adminShell, /bottom-fab-new-quotation[\s\S]{0,600}contextualNotebookTabs/);

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
assert.match(followups, /isPhone \? renderFollowupList\(true\)/);
assert.match(followups, /const ownsScroll = phone \|\| includeWorkspaceHeader/);
assert.match(followups, /ListHeaderComponent=\{ownsScroll/);
assert.match(followups, /scrollEnabled=\{ownsScroll\}/);
assert.match(followups, /isDesktop \? \(\s*<View style=\{\{ flex: 1, flexDirection: "row"/);
assert.match(followups, /renderFollowupList\(false, true\)/);
assert.match(followups, /const listRequestVersion = useRef\(0\)/);
assert.match(followups, /\/followups\/page\?\$\{params\.toString\(\)\}/);
assert.match(followups, /testID="followups-previous-page"/);
assert.match(followups, /testID="followups-next-page"/);
assert.match(followups, /style=\{styles\.mobileDetailScroll\} contentContainerStyle=\{styles\.mobileDetailContent\}/);
assert.match(followups, /flexBasis: "48%"/);
assert.match(followups, /maxWidth: "48%"/);

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
assert.match(notebook, /<View style=\{styles\.list\}>/);
assert.match(notebook, /<LeadCard key=\{row\.id\}/);
assert.doesNotMatch(notebook, /<DataTable/);

const quotationDetail = read("../app/(admin)/quotations/[id]/index.tsx");
assert.match(quotationDetail, /isPhone \? \(\s*<IconButton icon="download"/);
assert.match(quotationDetail, /linkedPoRowPhone/);

const placeOrder = read("../app/(admin)/quotations/[id]/place-order.tsx");
assert.match(placeOrder, /confirmBarPhone: \{ flexDirection: "column", alignItems: "stretch" \}/);
assert.match(placeOrder, /fullWidth=\{isPhone\}/);

const productModal = read("../src/components/quotation/sheets/ProductModal.tsx");
assert.match(productModal, /phoneSheet: \{/);
assert.match(productModal, /bodyPhone: \{ flexDirection: "column"/);
assert.match(productModal, /edges=\{isPhone \? \["bottom"\] : \[\]\}/);

const customProduct = read("../src/components/quotation/sheets/CustomProductSheet.tsx");
assert.match(customProduct, /\[styles\.grid, isPhone && styles\.phoneGrid\]/);

console.log("mobile shell, sheet, list ownership, quotation flow, and notebook navigation contracts: 55 assertions passed");
