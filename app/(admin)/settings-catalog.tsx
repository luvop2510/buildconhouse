// Settings > Catalog — Import (link to the existing full pipeline), Export
// (real .xlsx download), Backup (real, dated JSON download of catalog
// collections). Restore is intentionally NOT offered — a bad restore could
// silently corrupt the live catalog right before launch; that's flagged
// honestly below instead of faking a button that does nothing safe.
import { useRouter } from "expo-router";
import { useState } from "react";
import { Text, View } from "react-native";

import { AdminPage } from "@/src/components/AdminPage";
import { Button, Card } from "@/src/components/ui";
import { downloadApiFile } from "@/src/utils/downloadFile";
import { colors, spacing, type } from "@/src/theme/tokens";

export default function SettingsCatalog() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, path: string, label: string) => {
    setBusy(key);
    const filename = key === "export" ? "buildcon-catalog.xlsx" : "buildcon-catalog-backup.json";
    await downloadApiFile(path, filename, label);
    setBusy(null);
  };

  return (
    <AdminPage title="Catalog tools" subtitle="Import, export & backup" back={() => router.back()}>
      <View style={{ gap: spacing.lg }}>
        <Card style={{ gap: spacing.sm }}>
          <Text style={type.overline}>Import</Text>
          <Text style={type.bodyMuted}>Bulk-add or update products from a spreadsheet, with a review step before anything goes live.</Text>
          <Button testID="open-catalog-import-btn" label="Open catalog import" icon="upload" variant="secondary" onPress={() => router.push("/(admin)/catalog/import")} />
        </Card>

        <Card style={{ gap: spacing.sm }}>
          <Text style={type.overline}>Export</Text>
          <Text style={type.bodyMuted}>Download the full catalog — every product, brand and category — as a spreadsheet.</Text>
          <Button testID="export-catalog-btn" label="Export catalog (.xlsx)" icon="download" loading={busy === "export"} onPress={() => run("export", "/catalog/export.xlsx", "catalog export")} />
        </Card>

        <Card style={{ gap: spacing.sm }}>
          <Text style={type.overline}>Backup</Text>
          <Text style={type.bodyMuted}>A dated JSON snapshot of products, brands & categories — useful to hand to support if something ever needs manual recovery.</Text>
          <Button testID="backup-catalog-btn" label="Download backup (.json)" icon="archive" variant="secondary" loading={busy === "backup"} onPress={() => run("backup", "/settings/catalog-backup", "backup")} />
        </Card>

        <Card style={{ gap: 6, backgroundColor: colors.surfaceTertiary, borderColor: colors.border }}>
          <Text style={type.overline}>Restore</Text>
          <Text style={type.bodyMuted}>Not available in-app. A bad restore could overwrite live data — if you ever need to recover from a backup file, that&apos;s a hands-on job, not a self-serve button.</Text>
        </Card>
      </View>
    </AdminPage>
  );
}
