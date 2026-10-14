// Product Image Manager (LC-1 Priority 4) — Admin-only image CRUD for a
// single product, layered on top of the existing media pipeline
// (backend/routes/media_routes.py + services/media_service.py, which already
// handles Supabase storage, SHA-1 dedupe, orphan-safe replace/delete, and
// automatic catalog-cache refresh). This component is the first UI consumer
// of that pipeline — no backend redesign, purely wiring.
//
// Flow: system image picker preserving source pixels ->
// preview screen (Save / choose another / cancel) -> multipart upload.
// "Replace" reuses the exact same pick+preview flow, just tagged with the
// media id being swapped so the backend keeps its role/primary/position.
import Feather from "@expo/vector-icons/Feather";
import * as ImagePicker from "expo-image-picker";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/src/components/AppText";

import { api } from "@/src/api/client";
import { toast } from "@/src/components/Toast";
import { Badge, Button, ConfirmDialog, EmptyState, Sheet } from "@/src/components/ds";
import { ProductImage } from "@/src/components/ProductImage";
import { colors, PRODUCT_IMAGE_ASPECT_RATIO, radius, spacing, type } from "@/src/theme/tokens";
import { appendImageUpload } from "@/src/utils/appendImageUpload";
import { useBp } from "@/src/design/responsive";

type MediaItem = {
  id: string; public_url?: string | null; source_type: string; role: string;
  is_primary: boolean; sort_order: number; quality: string;
};

type Pending = { uri: string; mimeType: string; file?: File; fileName?: string | null; fileSize?: number; replaceId?: string };

/** The actual grid/upload/preview/delete UI, with no Sheet chrome of its own
 * — reusable as a standalone drawer (see ProductImageManager below) OR
 * embedded as the "Media" section inside the unified ProductEditor. Exactly
 * one implementation of the upload flow exists in the whole app; both
 * call sites render this same component. */
export function ProductImageManagerBody({
  productId, onChanged,
}: {
  productId: string;
  /** Called after any successful upload/replace/delete/set-primary so the
   * caller can refetch the product and pick up the new hero_image_url/gallery
   * (the backend already invalidates its own catalog cache; this is what
   * makes THIS screen reflect it immediately without a manual reload). */
  onChanged?: () => void;
}) {
  const { isPhone } = useBp();
  const cols = isPhone ? 2 : 3;
  const lifecycle = useRef<AbortController | null>(null);
  const uploading = useRef(false);
  const [media, setMedia] = useState<MediaItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const list = await api.get<MediaItem[]>(`/products/${productId}/media`, { signal });
      if (!signal?.aborted) setMedia(list);
    } catch (e: any) {
      if (signal?.aborted) return;
      toast.error(e?.message || "Couldn't load images");
      setMedia([]);
    }
  }, [productId]);

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    uploading.current = false;
    setBusy(false);
    setMedia(null);
    setPending(null);
    setConfirmDeleteId(null);
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const pick = async (replaceId?: string) => {
    const controller = lifecycle.current;
    try {
    // Image-only selection uses the system picker without broad library access.
    const result = await ImagePicker.launchImageLibraryAsync({
      // Preserve the original pixels for the backend's quality assessment and
      // the full-size catalog/PDF views. ProductImage uses a contain fit, so
      // a forced 16:10 crop is neither necessary nor desirable here.
      mediaTypes: ["images"], quality: 1, allowsEditing: false,
    });
    if (controller?.signal.aborted || result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    setPending({ uri: asset.uri, mimeType: asset.mimeType || "image/jpeg", file: asset.file, fileName: asset.fileName, fileSize: asset.fileSize, replaceId });
    } catch (error: any) {
      if (!controller?.signal.aborted) toast.error(error?.message || "Could not choose the product photo");
    }
  };

  const confirmUpload = async () => {
    if (!pending || uploading.current) return;
    uploading.current = true;
    const controller = lifecycle.current;
    setBusy(true);
    try {
      const form = new FormData();
      await appendImageUpload(form, pending);
      if (controller?.signal.aborted) return;
      if (!pending.replaceId) {
        form.append("source_type", "internal");
        form.append("is_primary", String(!media?.length));
      }
      const path = pending.replaceId
        ? `/products/${productId}/media/${pending.replaceId}/replace`
        : `/products/${productId}/media`;
      await api.upload(path, form, { signal: controller?.signal });
      if (controller?.signal.aborted) return;
      toast.success(pending.replaceId ? "Image replaced" : "Image added");
      setPending(null);
      await load(controller?.signal);
      if (!controller?.signal.aborted) onChanged?.();
    } catch (e: any) {
      if (!controller?.signal.aborted && e?.name !== "AbortError") toast.error(e?.message || "Upload failed");
    } finally {
      if (lifecycle.current === controller) uploading.current = false;
      if (!controller?.signal.aborted) setBusy(false);
    }
  };

  const setPrimary = async (id: string) => {
    const controller = lifecycle.current;
    try {
      await api.patch(`/media/${id}`, { is_primary: true }, { signal: controller?.signal });
      if (controller?.signal.aborted) return;
      await load(controller?.signal);
      if (!controller?.signal.aborted) onChanged?.();
    } catch (e: any) { if (!controller?.signal.aborted) toast.error(e?.message || "Couldn't update"); }
  };

  const doDelete = async () => {
    if (!confirmDeleteId) return;
    const controller = lifecycle.current;
    setBusy(true);
    try {
      await api.delete(`/media/${confirmDeleteId}`, { signal: controller?.signal });
      if (controller?.signal.aborted) return;
      toast.success("Image deleted");
      setConfirmDeleteId(null);
      await load(controller?.signal);
      if (!controller?.signal.aborted) onChanged?.();
    } catch (e: any) {
      if (!controller?.signal.aborted) toast.error(e?.message || "Couldn't delete");
    } finally {
      if (!controller?.signal.aborted) setBusy(false);
    }
  };

  return (
    <>
      {pending ? (
        <View style={styles.previewWrap}>
          <Text style={type.overline}>Preview</Text>
          <View style={styles.previewImage}>
            <ProductImage source={pending.uri} style={{ width: "100%", height: "100%" }} contentFit="contain" fallbackLabel="" borderRadius={0} />
          </View>
          <Text style={[type.caption, { textAlign: "center" }]}>
            {pending.replaceId
              ? "This will replace the existing image in the same spot."
              : "This will be added to the product's gallery."}
          </Text>
          <Button
            label="Choose a different photo"
            variant="secondary" icon="image" style={{ width: "100%" }}
            disabled={busy} onPress={() => pick(pending.replaceId)} testID="image-retake"
          />
          <View style={styles.previewActions}>
            <Button label="Cancel" variant="secondary" style={{ flex: 1 }} disabled={busy} onPress={() => setPending(null)} testID="image-preview-cancel" />
            <Button
              label={pending.replaceId ? "Save replacement" : "Save image"}
              style={{ flex: 1 }} loading={busy} onPress={confirmUpload} testID="image-preview-save"
            />
          </View>
        </View>
      ) : media === null ? (
        <View style={{ padding: spacing.xxl, alignItems: "center" }}>
          <ActivityIndicator color={colors.brand} />
        </View>
      ) : (
        <View style={{ padding: spacing.lg, gap: spacing.lg }}>
          <Button label="Add photo" icon="upload" onPress={() => pick()} testID="image-add-btn" />
          {media.length === 0 ? (
            <EmptyState icon="image" title="No images yet" subtitle="Add the first photo for this product." />
          ) : (
            <View style={styles.grid}>
              {media.map((m) => (
                <View key={m.id} style={[styles.tile, { width: cols === 2 ? "47%" : "31%" }]} testID={`media-tile-${m.id}`}>
                  <View style={styles.thumbWrap}>
                    {m.public_url ? (
                      <ProductImage source={m.public_url} style={{ width: "100%", height: "100%" }} contentFit="contain" fallbackLabel="" borderRadius={0} disableSkeleton />
                    ) : (
                      <Feather name="image" size={22} color={colors.onSurfaceMuted} />
                    )}
                    {m.is_primary ? (
                      <View style={styles.primaryBadge}><Badge label="Primary" tone="brand" size="sm" /></View>
                    ) : null}
                  </View>
                  <Text style={type.caption} numberOfLines={1}>{m.source_type} · {m.role}</Text>
                  <View style={styles.actionsRow}>
                    {!m.is_primary ? (
                      <Pressable onPress={() => setPrimary(m.id)} style={styles.miniAction} testID={`media-set-primary-${m.id}`}>
                        <Feather name="star" size={12} color={colors.onSurfaceSecondary} />
                        <Text style={styles.miniActionLabel}>Primary</Text>
                      </Pressable>
                    ) : null}
                    <Pressable onPress={() => pick(m.id)} style={styles.miniAction} testID={`media-replace-${m.id}`}>
                      <Feather name="refresh-cw" size={12} color={colors.onSurfaceSecondary} />
                      <Text style={styles.miniActionLabel}>Replace</Text>
                    </Pressable>
                    <Pressable onPress={() => setConfirmDeleteId(m.id)} style={styles.miniAction} testID={`media-delete-${m.id}`}>
                      <Feather name="trash-2" size={12} color={colors.error} />
                      <Text style={[styles.miniActionLabel, { color: colors.error }]}>Delete</Text>
                    </Pressable>
                  </View>
                </View>
              ))}
            </View>
          )}
        </View>
      )}

      <ConfirmDialog
        visible={!!confirmDeleteId}
        onClose={() => setConfirmDeleteId(null)}
        onConfirm={doDelete}
        title="Delete this image?"
        description="This removes it from storage permanently. The action itself stays in the product's audit history."
        confirmLabel="Delete"
        tone="danger"
        loading={busy}
        testID="confirm-delete-media"
      />
    </>
  );
}

/** Standalone drawer entry point (used from the Catalog product detail's
 * quick "Manage images" affordance). Just wraps ProductImageManagerBody in
 * a Sheet — all the actual logic lives in the body component above. */
export function ProductImageManager({
  productId, visible, onClose, onChanged,
}: {
  productId: string;
  visible: boolean;
  onClose: () => void;
  onChanged?: () => void;
}) {
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Manage images"
      subtitle="Upload, replace, or remove product photos"
      variant="drawer"
      width={640}
      testID="product-image-manager"
    >
      {visible ? <ProductImageManagerBody productId={productId} onChanged={onChanged} /> : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  previewWrap: { padding: spacing.lg, gap: spacing.lg, alignItems: "center" },
  previewImage: {
    width: 220, aspectRatio: PRODUCT_IMAGE_ASPECT_RATIO, borderRadius: radius.md, overflow: "hidden",
    backgroundColor: colors.surfaceTertiary, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  previewActions: { flexDirection: "row", gap: spacing.sm, width: "100%" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md },
  tile: { gap: 6 },
  thumbWrap: {
    aspectRatio: PRODUCT_IMAGE_ASPECT_RATIO, borderRadius: radius.md, overflow: "hidden", backgroundColor: colors.surfaceTertiary,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    alignItems: "center", justifyContent: "center", position: "relative",
  },
  primaryBadge: { position: "absolute", top: 6, left: 6 },
  actionsRow: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  miniAction: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 8, paddingVertical: 5, borderRadius: radius.sm,
    backgroundColor: colors.surfaceSecondary, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  miniActionLabel: { fontSize: 10, fontWeight: "600", color: colors.onSurfaceSecondary },
});
