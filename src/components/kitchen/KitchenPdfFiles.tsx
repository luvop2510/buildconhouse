import { useEffect, useRef, useState } from "react";
import { Platform, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { Text } from "@/src/components/AppText";
import { kitchenProjectsApi, type KitchenAttachment, type KitchenProject } from "@/src/api/kitchenProjects";
import { ErrorNotice, displayDate } from "./shared";
import { KitchenOption } from "./KitchenFilters";
import { useKitchenDraft, useKitchenProject } from "./KitchenProjectState";
import { downloadKitchenFile, uploadKitchenFile, KITCHEN_MAX_PDF_BYTES } from "./KitchenFileTransport";
import { KitchenButton as Button, kitchenType as type } from "./KitchenPrimitives";
import { kitchenApprovalDate } from "./KitchenVersions";
import { spacing } from "@/src/theme/tokens";

export function KitchenPdfFile({ project, file, selected, onSelect, disabled, testID }: { project: KitchenProject; file: KitchenAttachment; selected?: boolean; onSelect?: () => void; disabled?: boolean; testID: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const download = async (open: boolean) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true); setError(null);
    // Reserve the preview during the tap so browsers can open it after verification.
    const preview = open && Platform.OS === "web" ? window.open("about:blank", "_blank") : undefined;
    if (preview) preview.opener = null;
    try {
      if (open && Platform.OS === "web" && !preview) throw new Error("Allow this browser to open a PDF preview, then try again.");
      await downloadKitchenFile(project.id, file, () => {}, preview || undefined);
    } catch (failure) {
      preview?.close();
      setError(failure instanceof Error ? failure.message : "The PDF could not be opened. Try again.");
    } finally { pending.current = false; setBusy(false); }
  };
  const uploadDate = file.upload_date || kitchenApprovalDate(file.uploaded_at) || "";
  return <View style={{ gap: spacing.sm }} testID={testID}>
    <Text style={type.bodyStrong}>{file.filename}{selected ? " · Finalize PDF" : ""}</Text>
    <Text style={type.caption}>Uploaded: {uploadDate ? displayDate(uploadDate) : "Historical date not recorded"}</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
      {onSelect ? <KitchenOption label={selected ? "Finalize PDF · Selected" : "Finalize PDF"} accessibilityLabel={`Finalize PDF: ${file.filename}`} active={selected} disabled={disabled} onPress={onSelect} testID={`${testID}-final`} /> : null}
      <Button label="Open PDF" variant="secondary" disabled={busy} onPress={() => void download(true)} testID={`${testID}-open`} />
      <Button label="Download PDF" variant="secondary" disabled={busy} onPress={() => void download(false)} testID={`${testID}-download`} />
    </View>
    {error ? <Text accessibilityRole="alert" style={type.bodyMuted}>{error}</Text> : null}
  </View>;
}

/** Uploads attach private files; the parent explicitly saves its PDF selection. */
export function KitchenPdfFiles({ project, attachmentIds, finalId, onAdd, onSelect, disabled, selectionDisabled = false, label, testID, draftKey }: { project: KitchenProject; attachmentIds: string[]; finalId: string; onAdd: (id: string) => void | Promise<void>; onSelect: (id: string) => void; disabled: boolean; selectionDisabled?: boolean; label?: string; testID: string; draftKey: string }) {
  const { policy, documentSubmission: submission, updateProject, reload } = useKitchenProject();
  const [picked, setPicked] = useKitchenDraft<DocumentPicker.DocumentPickerAsset | null>(`${draftKey}.picked`, null);
  const [progress, setProgress] = useState(0);
  const [unfinished, setUnfinished] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    kitchenProjectsApi.ownTransfer(project.id).then(value => { if (live) setUnfinished(value.transfer?.transfer_id || null); }).catch(() => { /* Starting an upload still validates the transfer state on the server. */ });
    return () => { live = false; };
  }, [project.id]);
  const files = (project.attachments || []).filter(file => file.content_type === "application/pdf");
  const included = files.filter(file => attachmentIds.includes(file.id));
  const pick = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: "application/pdf", copyToCacheDirectory: true, multiple: false });
      if (!result.canceled) { submission.clearFeedback(); setPicked(result.assets[0]); }
    } catch { submission.setError("The PDF picker could not open. Try again."); }
  };
  const upload = async () => {
    if (!picked || !policy?.files) return;
    if (!/\.pdf$/i.test(picked.name) || !picked.size || picked.size > Math.min(policy.files.max_bytes, KITCHEN_MAX_PDF_BYTES)) { submission.setError("Choose a nonempty PDF up to 10 MB (10,000,000 bytes). The server validates its content."); return; }
    let addedFileId: string | undefined;
    const uploaded = await submission.submit({ id: project.id, uri: picked.uri, name: picked.name, size: picked.size }, key => uploadKitchenFile(project, picked, key, setProgress, setUnfinished), value => {
      const uploadedEvent = [...(value.activity || [])].reverse().find(row => row.type === "attachment.added" && row.payload?.filename === picked.name && value.attachments?.some(file => file.id === row.payload?.attachment_id));
      const file = value.attachments?.find(row => row.id === uploadedEvent?.payload?.attachment_id)
        || value.attachments?.find(row => !project.attachments?.some(previous => previous.id === row.id) && row.filename === picked.name)
        || value.attachments?.filter(row => row.filename === picked.name && row.size_bytes === picked.size).at(-1);
      updateProject(value);
      addedFileId = file?.id;
      if (!file) { submission.setError("The PDF uploaded, but its saved file could not be identified. Reload Kitchen and choose the PDF again to retry."); return; }
      setPicked(null); setUnfinished(null); setProgress(0);
    });
    if (uploaded && addedFileId) await onAdd(addedFileId);
  };
  return <View style={{ gap: spacing.md }} testID={testID}>
    {label ? <Text style={type.bodyStrong}>{label}</Text> : null}
    {!disabled ? <Text style={type.caption}>PDF · Up to 10 MB (10,000,000 bytes) per file.</Text> : null}
    {included.map(file => <KitchenPdfFile key={file.id} project={project} file={file} selected={file.id === finalId} onSelect={() => onSelect(file.id)} disabled={disabled || selectionDisabled || submission.busy} testID={`${testID}-${file.id}`} />)}
    {!disabled ? <>
      <Button label={label ? `Choose ${label} PDF` : "Choose PDF"} variant="secondary" disabled={submission.busy || !policy?.files} onPress={() => void pick()} testID={`${testID}-pick`} />
      {picked ? <><Text style={type.body}>{picked.name}</Text><Button label="Upload PDF" disabled={submission.busy || !policy?.files} loading={submission.busy} onPress={upload} testID={`${testID}-upload`} /></> : null}
      {!policy?.files ? <Text style={type.bodyMuted}>PDF upload settings are unavailable. Reload Kitchen setup before uploading.</Text> : null}
      {unfinished && !submission.busy ? <Button label="Discard unfinished PDF upload" variant="secondary" onPress={() => { void kitchenProjectsApi.cancelTransfer(project.id, unfinished).then(() => { setUnfinished(null); submission.clearFeedback(); }).catch(() => submission.setError("Temporary upload could not be discarded. Try again.")); }} testID={`${testID}-discard`} /> : null}
    </> : null}
    {submission.busy && progress > 0 ? <Text accessibilityLiveRegion="polite" style={type.caption}>PDF upload {progress}%{progress === 95 ? " · Verifying…" : ""}</Text> : null}
    <ErrorNotice error={submission.error} stale={submission.stale} onReload={reload} />
  </View>;
}
