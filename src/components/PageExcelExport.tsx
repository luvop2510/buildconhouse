import { Feather } from "@expo/vector-icons";
import { useSegments } from "expo-router";
import React, { useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { api, getToken } from "@/src/api/client";
import { Sheet } from "@/src/design/components";
import { color, font } from "@/src/design/tokens";

type Section = { name: string; rows: string[][] };

function pageRoot(): HTMLElement | null {
  return document.querySelector('[role="main"]');
}

function sectionNames(): string[] {
  const root = pageRoot();
  if (!root) return [];
  return Array.from(root.querySelectorAll('h1,h2,h3,[role="heading"],[aria-expanded]'))
    .map((node) => (node as HTMLElement).innerText?.split("\n")[0]?.trim())
    .filter((name): name is string => Boolean(name))
    .filter((name, index, all) => all.indexOf(name) === index)
    .slice(0, 30);
}

/** Capture the complete rendered page DOM, including content below the fold. */
function capturePage(selectedSection: string, brand: string): Section[] {
  const root = pageRoot();
  if (!root) return [];
  const needle = brand.trim().toLocaleLowerCase();
  if (needle && selectedSection === "all") {
    // A catalog card or table row contains the brand and its product/order
    // details together. Keep that complete record instead of exporting only
    // the isolated text line that happened to contain the brand name.
    const recordNodes = Array.from(root.querySelectorAll('tr,[role="row"],[data-testid^="family-"],[data-testid^="product-"]')) as HTMLElement[];
    const matching = recordNodes.filter((node) => !recordNodes.some((other) => other !== node && other.contains(node)))
      .map((node) => (node.innerText || "").split(/\n+|\t+/).map((cell) => cell.trim()).filter(Boolean))
      .filter((row) => row.join(" ").toLocaleLowerCase().includes(needle));
    if (matching.length) return [{ name: `Brand ${brand.trim()}`, rows: matching }];
  }
  const headings = sectionNames();
  const raw = (root.innerText || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const groups: Section[] = [{ name: "Overview", rows: [] }];
  let current = groups[0];
  for (const line of raw) {
    const heading = headings.find((name) => line === name || line.startsWith(`${name} `));
    if (heading) {
      current = { name: heading, rows: [] };
      groups.push(current);
    } else {
      current.rows.push([line]);
    }
  }

  // Preserve table columns in Excel even when the browser renders them as
  // tab-separated text. This also makes a brand match keep the whole row.
  for (const group of groups) {
    group.rows = group.rows.map((row) => row[0].includes("\t") ? row[0].split("\t").map((cell) => cell.trim()) : row);
  }
  return groups
    .filter((group) => selectedSection === "all" || group.name === selectedSection)
    .map((group) => ({ ...group, rows: needle ? group.rows.filter((row) => row.join(" ").toLocaleLowerCase().includes(needle)) : group.rows }))
    .filter((group) => group.rows.length > 0);
}

export function PageExcelExport() {
  const segments = useSegments() as string[];
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState("all");
  const [brand, setBrand] = useState("");
  const [names, setNames] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const page = useMemo(() => segments.filter((part) => !part.startsWith("(")).join(" / ") || "Overview", [segments]);

  if (Platform.OS !== "web") return null;

  const start = () => {
    setNames(sectionNames());
    setSection("all");
    setBrand("");
    setError("");
    setOpen(true);
  };

  const download = async () => {
    const sections = capturePage(section, brand);
    if (!sections.length) {
      setError("No rows match this section and brand. Try the whole page or another brand.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const token = await getToken();
      if (!token) throw new Error("Please sign in again.");
      const response = await fetch(`${api.base}/api/exports/page.xlsx`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ page, sections }),
      });
      if (!response.ok) throw new Error(`Excel export failed (${response.status}).`);
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `buildcon-${page.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.xlsx`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Excel export failed.");
    } finally {
      setBusy(false);
    }
  };

  return <>
    <Pressable testID="page-export-open" accessibilityRole="button" accessibilityLabel="Export this page to Excel" onPress={start} style={{ alignSelf: "flex-end", flexDirection: "row", gap: 7, alignItems: "center", paddingHorizontal: 12, paddingVertical: 7, margin: 8, borderWidth: 1, borderColor: color.line, borderRadius: 8, backgroundColor: color.surface }}>
      <Feather name="download" size={14} color={color.ink} />
      <Text style={{ color: color.ink, fontFamily: font.medium, fontSize: 12 }}>Export Excel</Text>
    </Pressable>
    <Sheet open={open} onClose={() => setOpen(false)} title="Export this page">
      <View style={{ gap: 12, padding: 16 }}>
        <Text style={{ color: color.inkSoft, fontFamily: font.regular, fontSize: 13 }}>Export all rendered content, one section, or rows matching a brand.</Text>
        <ScrollView style={{ maxHeight: 160 }}>
          {["all", ...names].map((name) => <Pressable key={name} testID={`page-export-section-${name}`} onPress={() => setSection(name)} style={{ paddingVertical: 9, paddingHorizontal: 10, backgroundColor: section === name ? color.accentTint : "transparent", borderRadius: 6 }}>
            <Text style={{ color: color.ink, fontFamily: font.medium, fontSize: 13 }}>{name === "all" ? "Entire page" : name}</Text>
          </Pressable>)}
        </ScrollView>
        <TextInput testID="page-export-brand" accessibilityLabel="Filter exported rows by brand" placeholder="Brand (optional)" value={brand} onChangeText={setBrand} style={{ borderWidth: 1, borderColor: color.line, borderRadius: 7, padding: 10, color: color.ink }} />
        {error ? <Text style={{ color: "#B42318", fontSize: 12 }}>{error}</Text> : null}
        <Pressable testID="page-export-download" accessibilityRole="button" accessibilityLabel="Download Excel file" disabled={busy} onPress={() => void download()} style={{ alignItems: "center", padding: 12, borderRadius: 7, backgroundColor: color.action, opacity: busy ? 0.6 : 1 }}>
          <Text style={{ color: color.onAction, fontFamily: font.semibold }}>{busy ? "Preparing…" : "Download .xlsx"}</Text>
        </Pressable>
      </View>
    </Sheet>
  </>;
}
