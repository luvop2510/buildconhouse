import { Text } from "@/src/components/AppText";
import { Alert, Button } from '@/src/components/ui';
import { Overlay } from '@/src/design/Overlay';
import { colors, type } from '@/src/theme/tokens';
import { useBuilder } from '../context/BuilderContext';

/** Recovery stays available until the salesperson explicitly restores or discards it. */
export function DraftRecoverySheet() {
  const b = useBuilder();
  const draft = b.recoveryDraft;
  return <Overlay open={Boolean(draft)} onClose={() => {}} dismissable={false}
    title="Recover quotation draft" testID="draft-recovery"
    footer={<>
      <Button label="Restore draft" loading={b.recoveryBusy} onPress={() => void b.restoreLocalDraft()} />
      <Button label="Discard draft" variant="secondary" disabled={b.recoveryBusy} onPress={b.dismissRecovery} />
    </>}>
    <Text style={type.body}>Unsaved changes are stored on this device for this department.</Text>
    {draft ? <Text style={[type.bodyStrong, { color: colors.onSurface }]}>
      {draft.quotationNumber || draft.state.header.projectName || 'New quotation'} · {draft.state.lines.length} item{draft.state.lines.length === 1 ? '' : 's'}
    </Text> : null}
    <Text style={type.bodyMuted}>Restore your work to continue. If the saved quotation has newer changes, recovery creates a separate draft.</Text>
    {b.recoveryError ? <Alert tone="error" title={b.recoveryError} /> : null}
  </Overlay>;
}
