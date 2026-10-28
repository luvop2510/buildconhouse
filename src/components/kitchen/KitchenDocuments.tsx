import { useEffect, useState } from "react";
import { Platform, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { Text } from "@/src/components/AppText";
import { Alert, Button, Sheet } from "@/src/components/ds";
import { kitchenProjectsApi, type KitchenProject, type KitchenPolicy } from "@/src/api/kitchenProjects";
import { downloadApiFile } from "@/src/utils/downloadFile";
import { KITCHEN_FLOOR_ID } from "@/src/constants/floors";
import { ErrorNotice, KitchenPanel } from "./shared";
import { useKitchenDraft, useKitchenProject } from "./KitchenProjectState";
import { uploadKitchenFile, downloadKitchenFile, KITCHEN_MAX_FILE_BYTES, KITCHEN_MAX_PDF_BYTES } from "./KitchenFileTransport";
import { spacing, type } from "@/src/theme/tokens";

export function DocumentChoice({ project, value, onChange, disabled, label = "Project document" }: { project: KitchenProject; value: string; onChange: (value: string) => void; disabled?: boolean; label?: string }) {
  const [open, setOpen] = useState(false);
  return <View style={{ gap: spacing.sm }}><Text style={type.label}>{label}</Text>
    {project.attachments?.length ? <Button label={project.attachments.find(file => file.id === value)?.filename || "Choose a document"} variant="secondary" disabled={disabled} onPress={() => setOpen(true)} /> : <Text style={type.caption}>Upload a file through Details → Actions → Documents, then select it here.</Text>}
    <Sheet scroll visible={open} onClose={() => setOpen(false)} title={label}>
      <Button label="No attachment" variant="ghost" onPress={() => { onChange(""); setOpen(false); }} />
      {(project.attachments || []).map(file => <Button key={file.id} label={file.filename} variant="secondary" onPress={() => { onChange(file.id); setOpen(false); }} />)}
    </Sheet>
  </View>;
}
export function KitchenDocuments({ project, policy, disabled, onUpdated, onReload }: { project: KitchenProject; policy: KitchenPolicy | null; disabled: boolean; onUpdated: (value: KitchenProject) => void; onReload: () => void }) {
  const { documentSubmission: submission } = useKitchenProject();
  const [picked, setPicked] = useKitchenDraft<DocumentPicker.DocumentPickerAsset | null>("documents.picked", null);
  const [savingFile, setSavingFile] = useState(false);
  const setTransferError = submission.setError;
  const [progress, setProgress] = useState(0);
  const [unfinished, setUnfinished] = useState<{ transfer_id: string; project_id: string } | null>(null);
  useEffect(() => { let live = true; kitchenProjectsApi.ownTransfer(project.id).then(value => { if (live) setUnfinished(value.transfer); }).catch(() => { if (live && !disabled) setTransferError("Unfinished upload status could not be checked. Reload before starting a large file."); }); return () => { live = false; }; }, [project.id, disabled, setTransferError]);
  const files = policy?.files;
  const canUpload = !disabled;
  const pick = async () => {
    try { const result = await DocumentPicker.getDocumentAsync({ type: "*/*", copyToCacheDirectory: true, multiple: false }); if (!result.canceled) { submission.clearFeedback(); setPicked(result.assets[0]); } }
    catch { submission.setError("The file picker could not open. Try again."); }
  };
  const upload = () => {
    if (!picked || !files) return;
    if (!/\.(pdf|jpe?g|png|docx|xlsx)$/i.test(picked.name)) { submission.setError("Choose a PDF, JPG/JPEG, PNG, DOCX or XLSX file. The server also validates its content."); return; }
    const pdf = /\.pdf$/i.test(picked.name) || picked.mimeType === "application/pdf";
    const maximum = Math.min(files.max_bytes, pdf ? KITCHEN_MAX_PDF_BYTES : KITCHEN_MAX_FILE_BYTES);
    if (!picked.size || picked.size > maximum) { submission.setError(`Choose a nonempty ${pdf ? "PDF up to 10 MB" : "file up to 25 MB"} (${maximum.toLocaleString()} bytes).`); return; }
    void submission.submit({ id: project.id, uri: picked.uri, name: picked.name, size: picked.size }, async key => {
      if (picked.size! > (files.single_request_max_bytes || 768 * 1024)) return uploadKitchenFile(project, picked, key, setProgress, transfer_id => setUnfinished({ transfer_id, project_id: project.id }));
      const form = new FormData(); form.append("expected_version", String(project.version)); form.append("idempotency_key", key);
      if (Platform.OS === "web") {
        if (!picked.file) throw new Error("The original selected file is unavailable. Choose it again.");
        form.append("file", picked.file, picked.name);
      } else form.append("file", { uri: picked.uri, type: picked.mimeType || "application/octet-stream", name: picked.name } as unknown as Blob);
      return kitchenProjectsApi.upload(project.id, form);
    }, value => { setPicked(null); setUnfinished(null); setProgress(0); onUpdated(value); });
  };
  return <View style={{ gap: spacing.lg }} testID="kitchen-documents-page"><KitchenPanel title="Private documents">
    {(project.attachments || []).map(file => <View key={file.id} style={{ gap: spacing.sm }}><Text style={type.body}>{file.filename} · {Math.ceil(file.size_bytes / 1024)} KiB</Text><Button label={`Download ${file.filename}`} variant="secondary" disabled={savingFile} onPress={() => { setSavingFile(true); void (file.size_bytes > 768 * 1024 ? downloadKitchenFile(project.id, file, setProgress) : downloadApiFile(kitchenProjectsApi.attachmentPath(project.id, file.id), file.filename, "project document", KITCHEN_FLOOR_ID)).catch(error => submission.setError(error instanceof Error ? error.message : "File download failed. Retry the download.")).finally(() => { setSavingFile(false); setProgress(0); }); }} /></View>)}
    {!project.attachments?.length ? <Text style={type.bodyMuted}>No documents uploaded.</Text> : null}
  </KitchenPanel><KitchenPanel title="Add a document">
    <Text style={type.bodyMuted}>Files remain private. Sharing with the customer is recorded in the relevant stage.</Text>
    {!files ? <Alert tone="info" title="Upload settings unavailable" description="Ask the owner to complete Kitchen setup." /> : <Text style={type.caption}>PDF up to 10 MB (10,000,000 bytes); JPG/JPEG, PNG, DOCX or XLSX up to 25 MB (25,000,000 bytes). Larger files transfer in private, verified parts.</Text>}
    {canUpload && files ? <><Button label="Choose document" variant="secondary" disabled={submission.busy} onPress={() => void pick()} testID="kitchen-document-pick" />{picked ? <><Text style={type.body}>{picked.name}</Text><Button label="Upload selected document" loading={submission.busy} onPress={upload} testID="kitchen-document-upload" /></> : null}</> : null}
    {unfinished && !submission.busy ? <Alert tone="info" title="Unfinished file transfer" description="Choose the same file and retry to resume safely, or discard its temporary parts. No file is attached until verification finishes." action={<Button label="Discard unfinished upload" variant="secondary" onPress={() => { void kitchenProjectsApi.cancelTransfer(unfinished.project_id, unfinished.transfer_id).then(() => { setUnfinished(null); submission.clearFeedback(); }).catch(error => submission.setError(String(error?.message || "Could not discard temporary parts."))); }} testID="kitchen-file-discard" />} /> : null}
  </KitchenPanel>
    {(submission.busy || savingFile) && progress > 0 ? <Text accessibilityLiveRegion="polite" style={type.body} testID="kitchen-file-progress">File transfer {progress}%{progress === 95 ? " · Verifying and saving…" : ""}</Text> : null}
    <ErrorNotice error={submission.error} stale={submission.stale} onReload={onReload} />
  </View>;
}
