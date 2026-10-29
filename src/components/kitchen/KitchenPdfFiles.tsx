import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { Text } from "@/src/components/AppText";
import { kitchenProjectsApi, type KitchenAttachment, type KitchenOwnFileTransfer, type KitchenProject } from "@/src/api/kitchenProjects";
import { ErrorNotice, displayDate } from "./shared";
import { KitchenOption } from "./KitchenFilters";
import { useKitchenDraft, useKitchenProject } from "./KitchenProjectState";
import { downloadKitchenFile, uploadKitchenFile, KITCHEN_MAX_PDF_BYTES, KITCHEN_MAX_FILE_BYTES } from "./KitchenFileTransport";
import { KitchenButton as Button, kitchenType as type } from "./KitchenPrimitives";
import { kitchenApprovalDate } from "./KitchenVersions";
import { spacing } from "@/src/theme/tokens";

export function KitchenPdfFile({ project, file, selected, onSelect, disabled, testID, photo = false }: { photo?: boolean; project: KitchenProject; file: KitchenAttachment; selected?: boolean; onSelect?: () => void; disabled?: boolean; testID: string }) {
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
      if (open && Platform.OS === "web" && !preview) throw new Error(`Allow this browser to open a ${photo ? "photo" : "PDF"} preview, then try again.`);
      await downloadKitchenFile(project.id, file, () => {}, preview || undefined);
    } catch (failure) {
      preview?.close();
      setError(failure instanceof Error ? failure.message : `The ${photo ? "photo" : "PDF"} could not be opened. Try again.`);
    } finally { pending.current = false; setBusy(false); }
  };
  const uploadDate = file.upload_date || kitchenApprovalDate(file.uploaded_at) || "";
  return <View style={{ gap: spacing.sm }} testID={testID}>
    <Text style={type.bodyStrong}>{file.filename}{selected ? " · Finalize PDF" : ""}</Text>
    <Text style={type.caption}>Uploaded: {uploadDate ? displayDate(uploadDate) : "Historical date not recorded"}</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
      {onSelect ? <KitchenOption label={selected ? "Finalize PDF · Selected" : "Finalize PDF"} accessibilityLabel={`Finalize PDF: ${file.filename}`} active={selected} disabled={disabled} onPress={onSelect} testID={`${testID}-final`} /> : null}
      <Button label={photo ? "Open photo" : "Open PDF"} variant="secondary" disabled={busy} onPress={() => void download(true)} testID={`${testID}-open`} />
      <Button label={photo ? "Download photo" : "Download PDF"} variant="secondary" disabled={busy} onPress={() => void download(false)} testID={`${testID}-download`} />
    </View>
    {error ? <Text accessibilityRole="alert" style={type.bodyMuted}>{error}</Text> : null}
  </View>;
}

type PdfTransfer = Pick<KitchenOwnFileTransfer, "project_id" | "transfer_id" | "filename" | "state">;

/** Uploads attach private files; the parent explicitly saves its PDF selection. */
export function KitchenPdfFiles({ project, attachmentIds, finalId, onAdd, onSelect, disabled, selectionDisabled = false, label, testID, draftKey, fileKind = "pdf" }: { fileKind?: "pdf" | "photo"; project: KitchenProject; attachmentIds: string[]; finalId: string; onAdd: (id: string) => void | boolean | Promise<void | boolean>; onSelect: (id: string) => void; disabled: boolean; selectionDisabled?: boolean; label?: string; testID: string; draftKey: string }) {
  const { policy, documentSubmission: submission, updateProject, reload } = useKitchenProject();
  const photo = fileKind === "photo";
  const noun = photo ? "photo" : "PDF";
  const [picked, setPicked] = useKitchenDraft<DocumentPicker.DocumentPickerAsset | null>(`${draftKey}.picked`, null);
  const [uploadedFile, setUploadedFile] = useKitchenDraft<{ id: string; fingerprint: string } | null>(`${draftKey}.uploaded`, null);
  const [progress, setProgress] = useState(0);
  const scopeKey = `${project.id}:${draftKey}`;
  const scope = useRef({ key: scopeKey, live: true });
  if (scope.current.key !== scopeKey) scope.current = { key: scopeKey, live: true };
  const pending = useRef(false);
  const transferRevision = useRef(0);
  const [operation, setOperation] = useState<{ scope: string; kind: "upload" | "discard" } | null>(null);
  const uploading = operation?.scope === scopeKey && operation.kind === "upload";
  const discarding = operation?.scope === scopeKey && operation.kind === "discard";
  const [transferState, setTransferState] = useState<{ scope: string; transfer: PdfTransfer } | null>(null);
  const unfinished = transferState?.scope === scopeKey ? transferState.transfer : null;
  const setUnfinished = (transfer: PdfTransfer | null) => {
    transferRevision.current += 1;
    setTransferState(transfer ? { scope: scopeKey, transfer } : null);
  };
  useEffect(() => {
    const currentScope = scope.current;
    currentScope.live = true;
    const revision = transferRevision.current;
    const controller = new AbortController();
    kitchenProjectsApi.ownTransfer(project.id, controller.signal).then(value => {
      // A status read started before begin/discard cannot restore obsolete state.
      if (currentScope.live && scope.current === currentScope && transferRevision.current === revision) {
        setTransferState(value.transfer ? { scope: currentScope.key, transfer: value.transfer } : null);
      }
    }).catch(() => { /* Starting an upload still validates the transfer state on the server. */ });
    return () => { currentScope.live = false; controller.abort(); };
  }, [project.id, scopeKey]);
  const files = (project.attachments || []).filter(file => photo ? ["image/jpeg", "image/png"].includes(file.content_type) : file.content_type === "application/pdf");
  const included = files.filter(file => attachmentIds.includes(file.id));
  const pick = async () => {
    if (pending.current || submission.busy || disabled) return;
    const currentScope = scope.current;
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: photo ? ["image/jpeg", "image/png"] : "application/pdf", copyToCacheDirectory: true, multiple: false });
      if (!result.canceled && currentScope.live && scope.current === currentScope) { submission.clearFeedback(); setPicked(result.assets[0]); setUploadedFile(null); }
    } catch { if (currentScope.live && scope.current === currentScope) submission.setError(`The ${noun} picker could not open. Try again.`); }
  };
  const upload = async () => {
    if (!picked || !policy?.files || pending.current || submission.busy || disabled) return;
    if (!(photo ? /\.(jpe?g|png)$/i : /\.pdf$/i).test(picked.name) || !picked.size || picked.size > Math.min(policy.files.max_bytes, photo ? KITCHEN_MAX_FILE_BYTES : KITCHEN_MAX_PDF_BYTES)) { submission.setError(photo ? "Choose a nonempty JPG or PNG photo up to 25 MB. The server validates its content." : "Choose a nonempty PDF up to 10 MB (10,000,000 bytes). The server validates its content."); return; }
    const currentScope = scope.current;
    const active = () => currentScope.live && scope.current === currentScope;
    const input = { id: project.id, uri: picked.uri, name: picked.name, size: picked.size };
    const fingerprint = JSON.stringify(input);
    let addedFileId = uploadedFile?.fingerprint === fingerprint ? uploadedFile.id : undefined;
    pending.current = true; setOperation({ scope: scopeKey, kind: "upload" }); setProgress(addedFileId ? 100 : 0);
    try {
      submission.clearFeedback();
      if (!addedFileId) {
        const uploaded = await submission.submit(input, key => uploadKitchenFile(project, picked, key,
          percent => { if (active()) setProgress(percent); },
          (transfer_id, transfer) => { if (active()) setUnfinished({ project_id: project.id, transfer_id, filename: picked.name, state: transfer?.state || "open" }); }), value => {
          if (!active()) return;
          const uploadedEvent = [...(value.activity || [])].reverse().find(row => row.type === "attachment.added" && row.payload?.filename === picked.name && value.attachments?.some(file => file.id === row.payload?.attachment_id));
          const file = value.attachments?.find(row => row.id === uploadedEvent?.payload?.attachment_id)
            || value.attachments?.find(row => !project.attachments?.some(previous => previous.id === row.id) && row.filename === picked.name)
            || value.attachments?.filter(row => row.filename === picked.name && row.size_bytes === picked.size).at(-1);
          updateProject(value);
          setUnfinished(null);
          addedFileId = file?.id;
          if (!file) { submission.setError(`The ${noun} uploaded, but its saved file could not be identified. Reload Kitchen and choose it again to retry.`); return; }
          setUploadedFile({ id: file.id, fingerprint });
        });
        if (!uploaded || !addedFileId || !active()) return;
      }
      setProgress(100);
      const accepted = await onAdd(addedFileId);
      if (!active()) return;
      if (accepted === false) {
        submission.setError(`The ${noun} uploaded. Its stage entry is waiting to be saved. Retry to finish; the saved file will be reused.`);
        return;
      }
      setPicked(null); setUploadedFile(null); setProgress(0);
    } catch (failure) {
      if (active()) submission.setError(`${failure instanceof Error ? failure.message : `The ${noun} entry could not be saved.`} Your file selection has been kept.`);
    } finally { pending.current = false; if (active()) setOperation(null); }
  };
  const discard = async () => {
    if (!unfinished || pending.current || submission.busy) return;
    const currentScope = scope.current;
    const transfer = unfinished;
    pending.current = true; setOperation({ scope: scopeKey, kind: "discard" });
    try {
      await submission.submit({ project_id: transfer.project_id, transfer_id: transfer.transfer_id, discard: true },
        () => kitchenProjectsApi.cancelTransfer(transfer.project_id, transfer.transfer_id), () => {
          if (currentScope.live && scope.current === currentScope) { setUnfinished(null); submission.clearFeedback(); }
        });
    } finally { pending.current = false; if (currentScope.live && scope.current === currentScope) setOperation(null); }
  };
  const busy = submission.busy || uploading || discarding;
  const progressLabel = discarding ? `Discarding unfinished ${noun} upload…` : progress === 0 ? `Preparing ${noun}…` : progress < 95 ? `Uploading ${noun} · ${progress}%` : progress < 100 ? `Verifying and saving ${noun}…` : `Saving ${noun} entry…`;
  return <View style={{ gap: spacing.md }} testID={testID}>
    {label ? <Text style={type.bodyStrong}>{label}</Text> : null}
    {!disabled ? <Text style={type.caption}>{photo ? "JPG or PNG · Up to 25 MB per photo. Add more photos after each upload." : "PDF · Up to 10 MB (10,000,000 bytes) per file."}</Text> : null}
    {included.map(file => <KitchenPdfFile key={file.id} project={project} file={file} photo={photo} selected={!photo && file.id === finalId} onSelect={photo ? undefined : () => onSelect(file.id)} disabled={disabled || selectionDisabled || busy} testID={`${testID}-${file.id}`} />)}
    {!disabled ? <>
      <Button label={photo ? "Choose photo" : label ? `Choose ${label} PDF` : "Choose PDF"} variant="secondary" disabled={busy || !policy?.files} onPress={pick} testID={`${testID}-pick`} />
      {picked ? <><Text style={type.body}>{picked.name}</Text><Button label={uploading ? progressLabel : uploadedFile ? `Retry saving ${noun} entry` : photo ? "Upload photo" : "Upload PDF"} disabled={busy || !policy?.files} loading={uploading} onPress={upload} testID={`${testID}-upload`} /></> : null}
      {!policy?.files ? <Text style={type.bodyMuted}>{photo ? "Photo" : "PDF"} upload settings are unavailable. Reload Kitchen setup before uploading.</Text> : null}
      {unfinished && (!submission.busy || discarding) ? <>
        <Text style={type.caption}>{unfinished.project_id !== project.id ? "An unfinished upload belongs to another project." : `An unfinished ${noun} upload is waiting.`}{unfinished.filename ? ` ${unfinished.filename}` : ""}</Text>
        {unfinished.state === "open" ? <Button label={discarding ? `Discarding ${noun} upload…` : unfinished.project_id !== project.id ? `Discard other project’s unfinished ${noun} upload` : `Discard unfinished ${noun} upload`} variant="secondary" disabled={busy} loading={discarding} onPress={discard} testID={`${testID}-discard`} /> : <Text style={type.caption}>{unfinished.project_id !== project.id ? "Verification has started. Open that project to retry its upload." : "Verification has started. Retry this upload to check its saved result."}</Text>}
      </> : null}
    </> : null}
    {uploading || discarding ? <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }} testID={`${testID}-progress`} accessibilityLiveRegion="polite"><ActivityIndicator size="small" /><Text style={type.caption}>{progressLabel}</Text></View> : null}
    <ErrorNotice error={submission.error} stale={submission.stale} onReload={reload} />
  </View>;
}
