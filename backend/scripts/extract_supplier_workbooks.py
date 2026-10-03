#!/usr/bin/env python3
"""Lossless ordered catalog extraction from XLSX XML; no application/database writes.

Public entry point: parse_workbook(path, brand, brand_order=0). Returned occurrences
retain duplicate articles, exact descriptions, headings, source coordinates, and all
price candidates. Grohe WC uses E (mrp 2026), falling back to F when E is blank, per user instruction. Call
extract_images(workbook, manifest, output_dir) separately to copy exact source bytes.
"""
from __future__ import annotations
import argparse, collections, csv, hashlib, io, json, posixpath, re, zipfile
from decimal import Decimal, InvalidOperation
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
      'r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
      'p':'http://schemas.openxmlformats.org/package/2006/relationships',
      'd':'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing',
      'a':'http://schemas.openxmlformats.org/drawingml/2006/main'}
IDENTITY_ALIASES = {
    '1800187': ('01800187','https://assets.hansgrohe.com.cn/mam/celum/celum_assets/16__hrgh2351_pdf.pdf'),
    '1500180': ('01500180','https://www.hansgrohe.com.au/articledetail-ibox-universal-2-basic-set-01500180?HGxH430=1'),
    '1400180': ('01400180','https://www.axor-design.com/uk/articledetail-axor-ibox-universal-2-basic-set-01400180'),
}

def file_sha256(path):
    digest=hashlib.sha256()
    with open(path,'rb') as f:
        for block in iter(lambda:f.read(4*1024*1024),b''):digest.update(block)
    return digest.hexdigest()

DEFAULTS = [('Hansgrohe',str(Path.home()/'Downloads'/'HANSGROHE MRP 2027-28.xlsx')),
            ('Grohe',str(Path.home()/'Downloads'/'GROHE 2026-27 final.xlsx'))]

def number(value):
    if value is None or isinstance(value,bool): return None
    text=str(value).strip().replace(',','').replace('₹','').strip()
    try:
        v=Decimal(text)
        if not v.is_finite(): return None
        return int(v) if v==v.to_integral_value() else float(v)
    except (InvalidOperation,ValueError): return None

def rels(z, part):
    rp=posixpath.join(posixpath.dirname(part),'_rels',posixpath.basename(part)+'.rels')
    if rp not in z.namelist(): return {}
    return {e.get('Id'):{**e.attrib,'resolved':posixpath.normpath(posixpath.join(posixpath.dirname(part),e.get('Target',''))).lstrip('/') if not e.get('Target','').startswith('/') else e.get('Target').lstrip('/')} for e in ET.fromstring(z.read(rp))}

def strings(z):
    if 'xl/sharedStrings.xml' not in z.namelist():return []
    return [''.join(e.itertext()) if not e.findall('.//s:t',NS) else ''.join(t.text or '' for t in e.findall('.//s:t',NS)) for e in ET.fromstring(z.read('xl/sharedStrings.xml'))]

def style_formats(z):
    e=ET.fromstring(z.read('xl/styles.xml'))
    fmt={0:'General',1:'0',2:'0.00',3:'#,##0',4:'#,##0.00',49:'@'}
    custom=e.find('s:numFmts',NS)
    if custom is not None:fmt.update({int(x.get('numFmtId')):x.get('formatCode') for x in custom})
    return [fmt.get(int(x.get('numFmtId',0)), 'builtin:'+x.get('numFmtId','0')) for x in e.find('s:cellXfs',NS)]

def decode(c, shared, formats):
    value=c.find('s:v',NS); raw=value.text if value is not None else None
    typ=c.get('t','n'); formula=c.find('s:f',NS)
    if typ=='s': val=shared[int(raw)] if raw is not None else None
    elif typ=='inlineStr':val=''.join(t.text or '' for t in c.findall('.//s:t',NS))
    elif typ in ('str','e'):val=raw
    elif typ=='b':val=raw=='1'
    else:val=number(raw) if raw is not None else None
    return {'value':val,'cell':c.get('r'),'type':typ,'xml_value':raw,
            'formula':formula.text if formula is not None else None,
            'number_format':formats[int(c.get('s',0))]}

def article_string(cell):
    v=cell['value']
    if v is None:return None
    s=str(v).strip()
    # Only actual zero padding formats justify restoring leading zeros.
    fmt=cell['number_format'].split(';')[0]
    if isinstance(v,(int,float)) and re.fullmatch(r'0+',fmt) and number(v)==int(v):s=str(int(v)).zfill(len(fmt))
    return s

def bounds(ref):
    start,end=(ref.split(':')+[ref])[:2]
    def one(x):
        m=re.fullmatch(r'([A-Z]+)(\d+)',x); col=0
        for c in m[1]:col=col*26+ord(c)-64
        return col,int(m[2])
    return one(start),one(end)

def image_manifest(z, sheet_xml, sheet_part, brand, sheet_name, sheet_order, products):
    result=[]; sr=rels(z,sheet_part); byrow={x['row']:x for x in products}
    merges=[(e.get('ref'),bounds(e.get('ref'))) for e in sheet_xml.findall('s:mergeCells/s:mergeCell',NS)]
    sheet_format=sheet_xml.find('s:sheetFormatPr',NS)
    default_ht=float(sheet_format.get('defaultRowHeight',15)) if sheet_format is not None else 15
    row_heights={int(e.get('r')):float(e.get('ht',default_ht)) for e in sheet_xml.findall('s:sheetData/s:row',NS)}
    row_y={1:0}
    for rn in range(1,max(row_heights,default=1)+1002):row_y[rn+1]=row_y[rn]+row_heights.get(rn,default_ht)*12700
    visual_assembly_articles={'47062140':'47904140','47062340':'47904340','47062300':'47904300'}
    for d in sheet_xml.findall('s:drawing',NS):
        dp=sr[d.get('{'+NS['r']+'}id')]['resolved']; dr=rels(z,dp)
        for index,anchor in enumerate(ET.fromstring(z.read(dp)),1):
            fr=anchor.find('d:from',NS); to=anchor.find('d:to',NS)
            if fr is None:continue
            row=int(fr.find('d:row',NS).text)+1; col=int(fr.find('d:col',NS).text)+1
            endrow=int(to.find('d:row',NS).text)+1 if to is not None else row
            endcol=int(to.find('d:col',NS).text)+1 if to is not None else col
            rowoff=int(fr.find('d:rowOff',NS).text or 0)
            extent=anchor.find('d:ext',NS)
            if to is None and extent is not None:
                remain=rowoff+int(extent.get('cy',0)); endrow=row
                while remain>row_heights.get(endrow,default_ht)*12700 and endrow<row+1000:
                    remain-=row_heights.get(endrow,default_ht)*12700;endrow+=1
            if to is not None and int(to.find('d:rowOff',NS).text or 0)==0 and endrow>row:endrow-=1
            bs=anchor.findall('.//a:blip',NS)
            for k,b in enumerate(bs,1):
                rid=b.get('{'+NS['r']+'}embed')
                if rid is None or rid not in dr:continue
                target=dr[rid]['resolved']; props=anchor.find('.//d:cNvPr',NS)
                start_y=row_y[row]+rowoff
                if to is not None:
                    stop_y=row_y[int(to.find('d:row',NS).text)+1]+int(to.find('d:rowOff',NS).text or 0)
                else:
                    stop_y=start_y+int(extent.get('cy',0)) if extent is not None else start_y
                overlaps=[]
                if stop_y>start_y:
                    for rn in range(row,endrow+2):
                        amount=max(0,min(stop_y,row_y[rn+1])-max(start_y,row_y[rn]))
                        if amount:overlaps.append({'row':rn,'overlap_emu':amount,'fraction':amount/(stop_y-start_y)})
                dominant=max(overlaps,key=lambda o:o['fraction']) if overlaps else None
                matching=[p['row'] for p in products if row<=p['row']<=endrow]
                mapped=None; reason='outside_product_image_column' if not(col<=4<=endcol) else 'ambiguous_multirow'
                if col<=4<=endcol:
                    if row==endrow and row in byrow:mapped=byrow[row]; reason='same_product_row'
                    else:
                        for merge,(start,end) in merges:
                            if start[0]<=4<=end[0] and start[1]<=row<=endrow<=end[1] and start[1] in byrow and len([r for r in byrow if start[1]<=r<=end[1]])==1:
                                mapped=byrow[start[1]];reason='single_product_merged_image_cell';break
                        if mapped is None and not matching:reason='no_product_at_anchor'
                proof=None;contextual=[]
                if mapped is None and col<=4<=endcol and dominant and dominant['fraction']>=0.9 and dominant['row'] in byrow:
                    mapped=byrow[dominant['row']];reason='geometric_dominant_exact_product_row'
                    proof=f"Original XML row heights and marker offsets place {dominant['fraction']:.4%} of this image height in physical row {dominant['row']}; no sibling image substituted."
                if mapped is None and brand=='Hansgrohe' and sheet_name=='WBM' and row in byrow and byrow[row]['article'] in visual_assembly_articles:
                    faucet=byrow[row];plate=byrow.get(row+1)
                    if plate and plate['article']==visual_assembly_articles[faucet['article']]:
                        mapped=faucet;reason='visually_verified_faucet_assembly'
                        proof='Original embedded image visually inspected in work/source-analysis/wbm-contact.png: wall-mounted MyEdition faucet with matching metal plate, anchored at faucet row and overlapping its separately listed matching-finish plate. Mapped as faucet assembly depiction; plate retained as contextual association, not an isolated product image.'
                        contextual=[plate['occurrence_id']]
                item={'image_id':f'{brand.lower()}:{sheet_order}:{index}:{k}', 'brand':brand,'sheet':sheet_name,'sheet_order':sheet_order,
                      'drawing_part':dp,'anchor_index':index,'anchor_type':anchor.tag.split('}')[-1],
                      'from_row':row,'to_row':endrow,'from_column':col,'to_column':endcol,'from_row_offset_emu':rowoff,
                      'zip_media_path':target,'media_bytes':z.getinfo(target).file_size,
                      'picture_name':props.get('name') if props is not None else None,
                      'picture_description':props.get('descr') if props is not None else None,
                      'occurrence_id':mapped['occurrence_id'] if mapped else None,
                      'article':mapped['article'] if mapped else None,'mapping_reason':reason,
                      'candidate_product_rows':matching,'vertical_overlap_by_row':overlaps,
                      'mapping_proof':proof,'contextual_occurrence_ids':contextual,
                      'extraction_relative_path':brand.lower()+'/'+posixpath.basename(target)}
                result.append(item)
                if mapped:mapped['images'].append(item['image_id'])
    return result

def enrich_image_integrity(z, manifest):
    """Record source hashes and dimensions; exact bytes remain inside the workbook."""
    try:
        from PIL import Image
    except ImportError:
        Image=None
    cache={}
    for item in manifest:
        target=item['zip_media_path']
        if target not in cache:
            raw=z.read(target)
            meta={'sha256':hashlib.sha256(raw).hexdigest(), 'width':None,'height':None,'image_format':None}
            if Image is not None:
                try:
                    with Image.open(io.BytesIO(raw)) as im:
                        meta.update(width=im.width,height=im.height,image_format=im.format)
                except Exception as exc:
                    meta['dimension_read_error']=type(exc).__name__
            cache[target]=meta
        item.update(cache[target])


def family_candidates(products):
    groups=collections.defaultdict(list)
    for p in products:
        sku=p['article'] or ''
        # Both brands' legacy eight-character codes use a five-character model stem.
        # New Grohe ten-character codes use a six-character stem. Bundle codes stay intact.
        if re.fullmatch(r'\d{5}[A-Za-z0-9]{3}',sku):stem=sku[:5]
        elif p['brand']=='Grohe' and re.fullmatch(r'\d{6}[A-Za-z0-9]{4}',sku):stem=sku[:6]
        else:continue
        groups[(p['brand'],stem)].append(p)
    out=[]
    for (brand,stem),rows in groups.items():
        skus=list(dict.fromkeys(p['article'] for p in rows))
        if len(skus)<2:continue
        family_id=f'{brand.lower()}:{stem}'
        item={'family_id':family_id,'brand':brand,'model_stem':stem,'articles':skus,
              'occurrence_ids':[p['occurrence_id'] for p in rows],
              'status':'candidate_requires_review',
              'reason':'shared SKU stem; suffix may denote finish, market, function, or revision; never merge products automatically'}
        out.append(item)
        for p in rows:p['variant_family_candidate']=family_id
    return out

def parse_workbook(path, brand, brand_order=0):
    path=Path(path)
    report={'brand':brand,'brand_order':brand_order,'workbook':str(path),'workbook_bytes':path.stat().st_size,'workbook_sha256':file_sha256(path),
            'sheets':[],'occurrences':[],'images':[],'anomalies':[]}
    with zipfile.ZipFile(path) as z:
        shared=strings(z); formats=style_formats(z); wb=ET.fromstring(z.read('xl/workbook.xml')); wr=rels(z,'xl/workbook.xml')
        for si,sheet in enumerate(wb.find('s:sheets',NS),1):
            name=sheet.get('name'); sp=wr[sheet.get('{'+NS['r']+'}id')]['resolved']; root=ET.fromstring(z.read(sp))
            info={'sheet':name,'sheet_order':si,'category_exact':name,'visibility':sheet.get('state','visible'),
                  'worksheet_part':sp,'headings':[],'nonproduct_rows':[],'product_occurrences':0,'populated_row_classifications':[],
                  'merged_cell_ranges':[e.get('ref') for e in root.findall('s:mergeCells/s:mergeCell',NS)]}
            report['sheets'].append(info); section=None; local=[]; serials=[]
            if name=='TOTAL':info['exclusion_reason']='quotation summary, not a product category'
            for rr in root.findall('s:sheetData/s:row',NS):
                rn=int(rr.get('r')); cells={re.sub(r'\d+$','',c.get('r')):decode(c,shared,formats) for c in rr.findall('s:c',NS)}
                vals={k:c['value'] for k,c in cells.items() if c['value'] is not None}
                if not vals:continue
                rowclass={'row':rn,'cells':vals,'classification':None}
                info['populated_row_classifications'].append(rowclass)
                if name=='TOTAL':rowclass['classification']='quotation_summary'
                if name=='TOTAL':info['nonproduct_rows'].append({'row':rn,'reason':'quotation_summary','cells':vals});continue
                a=vals.get('A'); b=vals.get('B'); desc=vals.get('C')
                header=isinstance(b,str) and 'Article' in b or isinstance(desc,str) and 'Discription' in desc
                total=isinstance(a,str) and a.strip().upper()=='TOTAL'
                if header or total:rowclass['classification']='column_header' if header else 'total'
                if header or total:info['nonproduct_rows'].append({'row':rn,'reason':'column_header' if header else 'total','cells':vals});continue
                if b is None and desc is None:
                    if isinstance(a,str):
                        rowclass['classification']='section_heading'
                        section=a;info['headings'].append({'row':rn,'cell':'A'+str(rn),'text_exact':a})
                        info['nonproduct_rows'].append({'row':rn,'reason':'section_heading','cells':vals})
                    else:
                        reason='empty_serial_slot' if isinstance(a,(int,float)) else 'metadata'
                        rowclass['classification']=reason
                        info['nonproduct_rows'].append({'row':rn,'reason':reason,'cells':vals})
                        if reason=='empty_serial_slot':report['anomalies'].append({'kind':reason,'sheet':name,'row':rn,'serial_raw':a})
                    continue
                rowclass['classification']='product'
                oi=f'{brand.lower()}:{si}:{rn}';rowclass['occurrence_id']=oi
                sku=article_string(cells['B']) if 'B' in cells else None
                alias=IDENTITY_ALIASES.get(sku) if brand=='Hansgrohe' else None
                price_cols=['E','F'] if brand=='Grohe' and name=='WC' else ['E']
                candidates=[{'column':k,'cell':k+str(rn),'label':'mrp 2026' if brand=='Grohe' and name=='WC' and k=='E' else 'MRP',
                             'raw':vals.get(k),'numeric':number(vals.get(k)), 'formula':cells.get(k,{}).get('formula')} for k in price_cols]
                priced=[p for p in candidates if p['numeric'] is not None]
                prices=set(p['numeric'] for p in priced)
                price=next(iter(prices)) if len(prices)==1 else None
                price_selection='single_mrp_column'
                if brand=='Grohe' and name=='WC':
                    preferred=next((c for c in candidates if c['column']=='E'),None)
                    fallback=next((c for c in candidates if c['column']=='F'),None)
                    chosen=preferred if preferred['raw'] is not None and str(preferred['raw']).strip() else fallback
                    price=chosen['numeric']
                    price_selection='user_instruction_E_mrp2026_then_F_when_E_blank'
                price_status='known_user_resolved_conflict' if len(prices)>1 and price is not None else 'known' if price is not None else 'unknown'
                p={'occurrence_id':oi,'brand':brand,'brand_order':brand_order,'workbook':path.name,'sheet_order':si,'sheet':name,'category_exact':name,
                   'section_heading_exact':section,'row':rn,'source_order':len(report['occurrences'])+1,
                   'order_in_sheet':len(local)+1,'serial_raw':a,'article_raw':b,'article':sku,
                   'article_number_format':cells.get('B',{}).get('number_format'),
                   'canonical_article':alias[0] if alias else sku,
                   'identity_aliases':[sku,alias[0]] if alias else [sku],
                   'identity_evidence':('Exact official manufacturer article confirmed: '+alias[1]) if alias else None,
                   'description_exact':desc,
                   'price_raw':candidates[0]['raw'] if len(candidates)==1 else {c['column']:c['raw'] for c in candidates},
                   'price':price,'price_status':price_status,'price_selection':price_selection,'source_price_conflict':len(prices)>1,
                   'price_candidates':candidates,'source_cells':cells,'images':[],'variant_family_candidate':None,
                   'discontinued_source':name=='DISCONTINUE','source_status_note':vals.get('F') if name=='DISCONTINUE' else None}
                p['source_search_text']=' '.join([brand,path.name,name,section or '',sku or '',p['canonical_article'] or '']+[str(v) for v in vals.values()])
                p['searchable_source_values']={k:v for k,v in vals.items()}
                p['description_cell_merged_ranges']=[ref for ref in info['merged_cell_ranges'] if bounds(ref)[0][0]<=3<=bounds(ref)[1][0] and bounds(ref)[0][1]<=rn<=bounds(ref)[1][1]]
                report['occurrences'].append(p);local.append(p)
                for kind,condition in [('missing_article',not sku),('missing_description',desc is None or not str(desc).strip()),('missing_price',not priced),('conflicting_source_prices',len(prices)>1),('serial_not_numeric',not isinstance(a,(int,float)))]:
                    if condition:report['anomalies'].append({'kind':kind,'sheet':name,'row':rn,'occurrence_id':oi,'article':sku})
                if brand=='Hansgrohe' and sku and sku.isdigit() and len(sku)!=8:
                    report['anomalies'].append({'kind':'article_length_requires_verification','sheet':name,'row':rn,'article':sku,'occurrence_id':oi,'number_format':p['article_number_format'],'note':('Original raw article preserved; canonical alias '+alias[0]+' verified at '+alias[1]) if alias else 'No leading zero is invented; verify manufacturer identity.'})
                if isinstance(a,(int,float)):serials.append((rn,a))
            info['product_occurrences']=len(local)
            for (r1,s1),(r2,s2) in zip(serials,serials[1:]):
                if s2!=s1+1:report['anomalies'].append({'kind':'serial_sequence_change','sheet':name,'row':r2,'previous_row':r1,'previous_serial':s1,'serial_raw':s2})
            report['images'].extend(image_manifest(z,root,sp,brand,name,si,local))
        enrich_image_integrity(z,report['images'])
        report['variant_families']=family_candidates(report['occurrences'])
        bysku=collections.defaultdict(list)
        for p in report['occurrences']:
            if p['article']:bysku[p['article']].append(p)
        report['duplicate_articles']=[]
        for sku,rows in bysku.items():
            if len(rows)>1:
                report['duplicate_articles'].append({'article':sku,'occurrence_ids':[p['occurrence_id'] for p in rows],
                    'price_conflict':len(set(p['price'] for p in rows if p['price'] is not None))>1,
                    'description_conflict':len(set(p['description_exact'] for p in rows))>1,
                    'category_conflict':len(set(p['category_exact'] for p in rows))>1,
                    'occurrences':[{'sheet':p['sheet'],'row':p['row'],'description_exact':p['description_exact'],'price':p['price']} for p in rows]})
        report['summary']={'product_occurrences':len(report['occurrences']),'distinct_articles':len(bysku),
             'missing_prices':sum(p['price_status']=='unknown' for p in report['occurrences']),
             'conflicting_source_prices':sum(p['source_price_conflict'] for p in report['occurrences']),
             'duplicate_articles':len(report['duplicate_articles']), 'embedded_media_files':len([x for x in z.namelist() if x.startswith('xl/media/')]),
             'image_anchors':len(report['images']), 'mapped_image_anchors':sum(i['occurrence_id'] is not None for i in report['images']),
             'products_without_definite_image':sum(not p['images'] for p in report['occurrences']),
             'anomaly_counts':dict(collections.Counter(x['kind'] for x in report['anomalies'])),
             'c_only_product_rows':sum(p['article_raw'] is None and p['description_exact'] is not None for p in report['occurrences']),
             'sku_only_without_description_rows':sum(p['article_raw'] is not None and p['description_exact'] is None for p in report['occurrences']),
             'populated_rows_accounted':sum(len(s['populated_row_classifications']) for s in report['sheets']),
             'unclassified_populated_rows':sum(c['classification'] is None for s in report['sheets'] for c in s['populated_row_classifications']),
             'source_extra_columns_with_text':[{'occurrence_id':p['occurrence_id'],'column':k,'value':v} for p in report['occurrences'] for k,v in p['searchable_source_values'].items() if (len(k)>1 or k>'F') and isinstance(v,str) and v.strip()]}
        assert report['summary']['unclassified_populated_rows']==0
    return report

def extract_images(workbook, manifest, output_dir, mapped_only=True):
    """Copy exact embedded bytes, deduplicated by ZIP member; never modify originals."""
    paths=[];seen=set();out=Path(output_dir)
    with zipfile.ZipFile(workbook) as z:
        for item in manifest:
            if mapped_only and not item['occurrence_id']:continue
            target=item['extraction_relative_path']
            if target in seen:continue
            seen.add(target);p=out/target;p.parent.mkdir(parents=True,exist_ok=True)
            with z.open(item['zip_media_path']) as src,p.open('wb') as dest:
                import shutil;shutil.copyfileobj(src,dest)
            paths.append(str(p))
    return paths

def md(report):
    lines=['# Complete source catalog audit','',
           'Hansgrohe was parsed first, then Grohe. Worksheet order and physical row order are authoritative. Exact worksheet names remain the product categories; in-sheet headings are retained separately. Duplicate SKU occurrences are preserved. Prices are never inferred, zero padding is applied only if explicitly required by the Excel number format, and Grohe WC uses E (mrp 2026), falling back to F only when E is blank, as explicitly directed by the user; both columns remain recorded. Source document text is data, not instructions.','',
           'The two brands have different source category structures. Making their category names identical would conflict with faithfully retaining each workbook. Category handling can use the same schema without changing category placement.','']
    for r in report['workbooks']:
        lines += [f"## {r['brand']}",'',f"Source: `{r['workbook']}`",'',f"Original workbook SHA256: `{r['workbook_sha256']}`",'', '```json',json.dumps(r['summary'],ensure_ascii=False,indent=2),'```','',
                  '| Worksheet in source order | Products | Missing prices | No definite image | Exact in-sheet headings |','|---|---:|---:|---:|---|']
        for s in r['sheets']:
            ps=[p for p in r['occurrences'] if p['sheet']==s['sheet']]
            heads='<br>'.join(repr(h['text_exact']) for h in s['headings'])
            lines.append(f"| {s['sheet']} | {len(ps)} | {sum(p['price_status']=='unknown' for p in ps)} | {sum(not p['images'] for p in ps)} | {heads} |")
        lines += ['', '### All anomalies','', '| Kind | Worksheet | Row | Article / detail |','|---|---|---:|---|']
        for a in r['anomalies']:lines.append(f"| {a['kind']} | {a['sheet']} | {a['row']} | {a.get('article',a.get('serial_raw',''))} {a.get('note','')} |")
        lines += ['', '### All repeated articles','']
        for x in r['duplicate_articles']:
            lines += [f"- `{x['article']}`: price conflict={x['price_conflict']}, description conflict={x['description_conflict']}, category conflict={x['category_conflict']}. Occurrences: "+'; '.join(f"{p['sheet']} row {p['row']}: MRP {p['price']!r}, description {p['description_exact']!r}" for p in x['occurrences'])]
        lines += ['', '### Ambiguous and unmapped image anchors','', '| Image ID | Worksheet | Rows | Reason | Possible product rows | Source media |','|---|---|---|---|---|---|']
        for i in r['images']:
            if i['occurrence_id'] is None:lines.append(f"| {i['image_id']} | {i['sheet']} | {i['from_row']}–{i['to_row']} | {i['mapping_reason']} | {i['candidate_product_rows']} | {i['zip_media_path']} |")
        lines += ['', '### Complete ordered product inventory','', '| Source order | Worksheet | Row | Serial raw | Article | Description exact (line breaks escaped) | Price | Price status |','|---:|---|---:|---|---|---|---:|---|']
        for p in r['occurrences']:
            d=str(p['description_exact']).replace('|','\\|').replace('\n','\\n')
            lines.append(f"| {p['source_order']} | {p['sheet']} | {p['row']} | {p['serial_raw']} | {p['article']} | {d} | {p['price']} | {p['price_status']} |")
        lines.append('')
    return '\n'.join(lines)

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--hansgrohe',default=DEFAULTS[0][1]);ap.add_argument('--grohe',default=DEFAULTS[1][1]);ap.add_argument('--output',default='work/source-analysis');ap.add_argument('--audit-prefix',default='outputs/source-catalog-audit');ap.add_argument('--extract-images',action='store_true');args=ap.parse_args()
    sources=[('Hansgrohe',args.hansgrohe),('Grohe',args.grohe)]
    reports=[parse_workbook(p,b,i) for i,(b,p) in enumerate(sources)]
    combined={'schema_version':1,'workbooks':reports,'ordered_occurrences':[p for r in reports for p in r['occurrences']],
              'images':[p for r in reports for p in r['images']],
              'policy':{'categories':'exact worksheet names; headings retained separately','order':'Hansgrohe first, then Grohe; original sheet and physical row order','duplicates':'retained as independent occurrences','price_conflicts':'WC user instruction: E mrp2026 first, F when E blank; both cells retained','families':'candidate only; review required'}}
    out=Path(args.output);out.mkdir(parents=True,exist_ok=True)
    for r in reports:
        (out/(r['brand'].lower()+'-source.json')).write_text(json.dumps(r,ensure_ascii=False,indent=2))
        if args.extract_images:extract_images(r['workbook'],r['images'],out/'images')
    prefix=Path(args.audit_prefix);prefix.parent.mkdir(parents=True,exist_ok=True)
    prefix.with_suffix('.json').write_text(json.dumps(combined,ensure_ascii=False,indent=2))
    prefix.with_suffix('.md').write_text(md(combined))
    resolution={'policy':'Images remain original bytes; row-height/offset geometry or visually verified exact source assembly only. Missing source data remains explicitly absent; no finish guessing.',
                'geometry_resolutions':[i for i in combined['images'] if i['mapping_reason']=='geometric_dominant_exact_product_row'],
                'visual_resolutions':[i for i in combined['images'] if i['mapping_reason']=='visually_verified_faucet_assembly'],
                'still_unmapped_anchors':[i for i in combined['images'] if i['occurrence_id'] is None],
                'products_without_source_image':[{'occurrence_id':p['occurrence_id'],'brand':p['brand'],'article':p['article'],'sheet':p['sheet'],'row':p['row'],'description_exact':p['description_exact']} for p in combined['ordered_occurrences'] if not p['images']]}
    (out/'image-resolution.json').write_text(json.dumps(resolution,ensure_ascii=False,indent=2))
    with prefix.with_suffix('.csv').open('w',newline='') as f:
        fields=['occurrence_id','brand','brand_order','sheet_order','sheet','section_heading_exact','row','source_order','order_in_sheet','serial_raw','article_raw','article','description_exact','price','price_status','variant_family_candidate','discontinued_source']
        w=csv.DictWriter(f,fieldnames=fields,extrasaction='ignore');w.writeheader();w.writerows(combined['ordered_occurrences'])
    print(json.dumps({r['brand']:r['summary'] for r in reports},ensure_ascii=False,indent=2))
if __name__=='__main__':main()
