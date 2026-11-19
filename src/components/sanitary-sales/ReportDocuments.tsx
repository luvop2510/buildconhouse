import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  sanitarySalesApi, type SanitaryDocument, type SanitaryLine,
  type SanitaryReport, type SanitaryValueBasis,
} from '@/src/api/sanitarySales';
import { SANITARY_FLOOR_ID } from '@/src/constants/floors';
import { Button, Txt } from '@/src/design/components';
import { color, radius, space } from '@/src/design/tokens';
import { downloadApiFile } from '@/src/utils/downloadFile';
import { InlineError, LedgerRow } from './LedgerUI';
import { amount, basisLabels, count, day, documentNoun, identityText, quantity, statusLabel } from './reportPresentation';

export function ReportDocuments({ rows, report, basis }: {
  rows: SanitaryDocument[]; report: SanitaryReport; basis: SanitaryValueBasis;
}) {
  const [expanded, setExpanded] = useState<string>();
  return <View>{rows.map((row, index) => {
    const open = expanded === row.id;
    const noun = documentNoun(report);
    const title = row.number || row.name || (noun === 'order' ? 'Placed order' : 'Quotation');
    return <View key={row.id} style={index ? styles.rule : undefined}>
      <LedgerRow title={title} subtitle={identityText(day(row.date), statusLabel(row.status), ...row.brands)}
        displayValue={amount(row.value)}
        valueNote={row.value != null && row.missing_value_lines > 0 ? 'Recorded subtotal' : undefined}
        testID={`sanitary-row-${row.id}`} open={open} onPress={() => setExpanded(open ? undefined : row.id)} />
      {open && <DocumentDetail row={row} basis={basis} pending={noun === 'quotation'} />}
    </View>;
  })}</View>;
}

function DocumentDetail({ row, basis, pending }: { row: SanitaryDocument; basis: SanitaryValueBasis; pending: boolean }) {
  return <View style={styles.detail}>
    <View style={styles.facts}>
      <View style={styles.fact}>
        <Txt v="caption">Customer</Txt>
        <Txt v="rowTitle">{row.customer_name || 'Customer unavailable'}</Txt>
      </View>
      <View style={styles.fact}>
        <Txt v="caption">Contact number</Txt>
        <Txt v="rowTitle" selectable>{row.contact || 'Contact unavailable'}</Txt>
      </View>
      {!pending && <View style={styles.fact}>
        <Txt v="caption">Related quotation</Txt>
        <Txt v="rowTitle">{row.quotation_number || 'Quotation unavailable'}</Txt>
        {row.quotation_date && <Txt v="sub">{day(row.quotation_date)}</Txt>}
      </View>}
    </View>
    {row.missing_value_lines > 0 && <Txt v="sub">
      {basisLabels[basis]} is unavailable for {count(row.missing_value_lines, 'product line')}.
    </Txt>}
    {pending && (row.pdf_available && row.quotation_id
      ? <SavedPdf quotationId={row.quotation_id} number={row.number || row.quotation_number} />
      : <Txt v="sub">Latest saved PDF unavailable.</Txt>)}
    {row.items.length > 0 && <View style={styles.products}>
      <Txt v="caption">Products · {basisLabels[basis]}</Txt>
      {row.items.map(line => <ProductLine key={line.id} line={line} />)}
    </View>}
  </View>;
}

function ProductLine({ line }: { line: SanitaryLine }) {
  const article = line.sku ? `Article ${line.sku}` : null;
  const description = identityText(line.brand, article, line.size, line.finish);
  return <View style={[styles.line, styles.rule]}>
    <View style={styles.productIdentity}>
      <Txt v="rowTitle">{line.name}</Txt>
      {description ? <Txt v="caption">{description}</Txt> : null}
    </View>
    <View style={styles.lineValue}>
      <Txt v="money" style={{ textAlign: 'right' }}>{amount(line.value)}</Txt>
      <Txt v="caption" style={{ textAlign: 'right' }}>{quantity(line.quantity, line.unit)}</Txt>
    </View>
  </View>;
}

function SavedPdf({ quotationId, number }: { quotationId: string; number: string | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const download = async () => {
    setBusy(true);
    setError('');
    try {
      const filename = `${number || 'Quotation'}-latest.pdf`;
      await downloadApiFile(sanitarySalesApi.pdfPath(quotationId), filename, 'quotation PDF', SANITARY_FLOOR_ID, setError);
    } catch {
      setError('Could not download the saved quotation PDF. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return <View style={{ gap: space.x2 }}>
    <Button label={busy ? 'Preparing PDF…' : 'Download latest PDF'} size="sm" icon="download"
      variant="secondary" loading={busy} testID={`sanitary-pdf-${quotationId}`} onPress={() => void download()} />
    {error ? <InlineError message={error} /> : null}
  </View>;
}

const styles = StyleSheet.create({
  rule: { borderTopWidth: 1, borderTopColor: color.line },
  detail: { marginBottom: space.x2, backgroundColor: color.canvas, padding: space.x3, gap: space.x3, borderRadius: radius.md },
  facts: { flexDirection: 'row', flexWrap: 'wrap', gap: space.x3 },
  fact: { minWidth: 0, flexGrow: 1, flexBasis: 120 },
  products: { gap: space.x2 },
  line: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-start', gap: space.x2, paddingTop: space.x2 },
  productIdentity: { flexGrow: 1, flexBasis: 136, minWidth: 0 },
  lineValue: { flexGrow: 1, alignItems: 'flex-end', minWidth: 0 },
});
