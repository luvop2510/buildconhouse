"""Read supplier stock workbooks without modifying them.

Run with the bundled document Python. JSON contains supplier provenance and local
image paths; keep it and embedded media outside Git. Blank quantity inputs remain
unknown even where Excel caches a default-zero formula result.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import math
import operator
import re
import warnings
from collections import defaultdict
from pathlib import Path
from copy import deepcopy
from uuid import NAMESPACE_URL, uuid5

WORKBOOKS = {
    "STOCK GROHE.xlsx": "Grohe", "DURAVIT STOCK.xlsx": "Duravit",
    "GEBERIT STOCK.xlsx": "Geberit", "STOCK VITRA NEW.xlsx": "Vitra",
    "VITRA BASIN.xlsx": "Vitra", "STOCK HANSGROHE.xlsx": "Hansgrohe",
    "GROHE BASIN-WC  STOCK.xlsx": "Grohe",
}


def number(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(value):
        return float(value)
    if isinstance(value, str):
        text = value.strip()
        if re.fullmatch(r"\d+(?:\.\d+)?", text):
            return float(text)
        # Quantities include explicit annotations, such as '(WC)1' or
        # 'BAULINE CONCIL WM=2'; preserve that annotation in source cells.
        match = re.fullmatch(r".*?=\s*(\d+(?:\.\d+)?)", text)
        if not match:
            match = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*\([^\d]*\)\s*", text)
        if not match:
            match = re.fullmatch(r"\s*\([^\d]*\)\s*(\d+(?:\.\d+)?)\s*", text)
        if not match:
            match = re.fullmatch(r"[^\d]+?(\d+(?:\.\d+)?)", text)
        if match:
            return float(match.group(1))
    return None


def code_text(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(int(value)) if float(value).is_integer() else str(value)
    return str(value or "").strip()


def code_key(value):
    return re.sub(r"[^A-Z0-9]", "", code_text(value).upper())


def formula_total(formula, row_values):
    """Evaluate only the workbook's simple arithmetic cell references."""
    if not isinstance(formula, str) or not formula.startswith("="):
        return None
    expression = re.sub(r"\$?([A-Z]+)\$?\d+", lambda m: str(number(row_values.get(m[1])) or 0), formula[1:].upper())
    try:
        tree = ast.parse(expression, mode="eval")
        def evaluate(node):
            if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
                return node.value
            if isinstance(node, ast.BinOp) and type(node.op) in {ast.Add, ast.Sub, ast.Mult, ast.Div}:
                return {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv}[type(node.op)](evaluate(node.left), evaluate(node.right))
            raise ValueError("Unsupported formula")
        return float(evaluate(tree.body))
    except (SyntaxError, ValueError, TypeError, ZeroDivisionError):
        return None


def quantity(raw, cached, *, qty_col, total_col="G", movement=True, in_col="E"):
    movement_cols = ([in_col] if in_col else []) + ["F"]
    inputs = [raw.get(qty_col)] + ([raw.get(col) for col in movement_cols] if movement else [])
    explicit_total = raw.get(total_col)
    if all(value is None or value == "" for value in inputs):
        if not isinstance(explicit_total, str) or not explicit_total.startswith("="):
            return number(explicit_total), []
        return None, ["Formula default zero has no recorded quantity input"]
    notes = []
    base = number(raw.get(qty_col))
    if raw.get(qty_col) is not None and base is None:
        return None, ["Unparseable source quantity"]
    if movement and any(raw.get(col) not in (None, "") and number(raw.get(col)) is None for col in movement_cols):
        if number(explicit_total) is not None:
            return number(explicit_total), ["Used explicit recorded TOTAL; movement annotation retained without inference"]
        return None, ["Unparseable source movement quantity"]
    calculated = formula_total(explicit_total, raw)
    if calculated is not None:
        result = calculated
        if number(cached.get(total_col)) is not None and cached[total_col] != calculated:
            notes.append("Cached total differs from evaluated source formula")
        if movement and number(raw.get("F")) and "F" not in explicit_total.upper():
            result -= number(raw.get("F"))
            notes.append("Corrected source total formula that excludes OUT column; subtracted recorded OUT")
        if movement and in_col and number(raw.get(in_col)) and in_col not in explicit_total.upper():
            result += number(raw.get(in_col))
            notes.append("Corrected source total formula that excludes IN column; added recorded IN")
    elif number(cached.get(total_col)) is not None:
        result = number(cached[total_col])
    else:
        result = (base or 0) + (number(raw.get(in_col)) or 0 if in_col else 0) - (number(raw.get("F")) or 0) if movement else base
    if result is not None and result < 0:
        return None, notes + ["Negative quantity requires reconciliation"]
    return result, notes


def split_seats(text, qty):
    text = code_text(text)
    if not text or text.upper() in {"PENDING", "WITH SEAT COVER"}:
        return []
    parts = text.split("/")
    if len(parts) == 1:
        return [(text, qty, [])]
    if all(re.fullmatch(r"[^=]+=[0-9.]+", part.strip()) for part in parts):
        result = [(part.split("=")[0].strip(), number(part.split("=")[1]), []) for part in parts]
        if qty is not None and sum(row[1] for row in result) != qty:
            return [(text, qty, ["Seat split quantities differ from seat total"])]
        return result
    return [(text, qty, ["Alternative seat article numbers have no quantity split"])]


def extract_workbooks(source_dir, output_dir):
    import openpyxl
    output_dir.mkdir(parents=True, exist_ok=True)
    rows, files = [], []
    for filename, brand in WORKBOOKS.items():
        path = source_dir / filename
        files.append({"file": filename, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            formulas = openpyxl.load_workbook(path, data_only=False)
            cached_book = openpyxl.load_workbook(path, data_only=True)
        for sheet in formulas:
            cached_sheet = cached_book[sheet.title]
            images = defaultdict(list)
            for image in sheet._images:
                anchor_row = image.anchor._from.row + 1
                data = image._data()
                digest = hashlib.sha256(data).hexdigest()
                media_path = output_dir / "images" / f"{digest}.{image.format}"
                media_path.parent.mkdir(exist_ok=True)
                media_path.write_bytes(data)
                images[anchor_row].append({"path": str(media_path.resolve()), "sha256": digest, "column": image.anchor._from.col + 1, "width": image.width, "height": image.height})
            section = None
            wc_layout = filename == "STOCK VITRA NEW.xlsx"
            for r in range(3, sheet.max_row + 1):
                raw = {cell.column_letter: cell.value for cell in sheet[r] if cell.value is not None}
                cached = {cell.column_letter: cell.value for cell in cached_sheet[r] if cell.value is not None}
                code_col, qty_col = ("A", "B") if wc_layout else ("B", "D" if filename in {"STOCK GROHE.xlsx", "STOCK HANSGROHE.xlsx"} else "C")
                article = code_text(raw.get(code_col))
                if raw.get("A") == "*":
                    section = article
                    continue
                if not article and not images[r]:
                    continue
                # Template row numbers and footer counters are not products.
                if article.upper() in {"BASIN", "BESIN", "DURAVIT WC", "DURAVIT EXTRA SEAT COVER", "DURAVIT URINAL FILTER"}:
                    section = article
                    continue
                qty, notes = quantity(raw, cached, qty_col=qty_col, in_col=None if wc_layout else "E")
                sku = article.split("(")[0].strip()
                source = {"file": filename, "sheet": sheet.title, "row": r, "article_cell": f"{code_col}{r}", "quantity_cell": f"{qty_col}{r}", "raw_article": article, "raw_cells": raw, "cached_cells": cached, "section": section, "embedded_images": images[r]}
                rows.append({"brand": brand, "sku": sku, "raw_article": article, "qty": qty, "quantity_missing": qty is None, "quantity_notes": notes, "kind": "wc" if wc_layout else "product", "sources": [source]})
                if wc_layout:
                    for seat, seat_qty, seat_notes in split_seats(raw.get("C"), number(raw.get("D"))):
                        rows.append({"brand": brand, "sku": seat, "raw_article": seat, "qty": seat_qty, "quantity_missing": seat_qty is None, "quantity_notes": seat_notes, "kind": "seat", "sources": [{**source, "article_cell": f"C{r}", "quantity_cell": f"D{r}", "raw_article": seat, "embedded_images": []}]})
        files[-1]["extraction_warnings"] = sorted({str(w.message) for w in caught})
        formulas.close()
        cached_book.close()
    result = {"files": files, "rows": rows}
    (output_dir / "extracted.json").write_text(json.dumps(result, indent=2, default=str))
    return result


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def identity(*parts):
    return str(uuid5(NAMESPACE_URL, "forge:godown-workbook:" + json.dumps(parts)))


def deduplicate_mirrors(rows):
    """Collapse only the verified Grohe WC/seat summary and template mirrors.

    Independent repeated lines remain independent lots. A matching blank
    template is not an extra unknown stock quantity; preserve its provenance.
    """
    rows = deepcopy(rows)
    dedicated = {code_key(row["sku"]): row for row in rows if row["sources"][0]["file"] == "GROHE BASIN-WC  STOCK.xlsx"}
    # The workbook spells this seat with a 5; the mirrored section spells SH.
    # This reviewed transcription equivalence only dedupes inventory sources;
    # it does not silently match a catalog product.
    mirror_keys = {**dedicated}
    if "1045835H00" in dedicated:
        mirror_keys["104583SH00"] = dedicated["1045835H00"]
    kept, decisions = [], []
    for row in rows:
        source = row["sources"][0]
        target = mirror_keys.get(code_key(row["sku"])) if row["brand"] == "Grohe" and source["file"] == "STOCK GROHE.xlsx" else None
        if target and (source["row"] >= 617 or row["qty"] is None or row["qty"] == target["qty"]):
            target["sources"].extend(row["sources"])
            decisions.append({"kind": "verified_grohe_wc_summary_mirror", "source": {"file": source["file"], "row": source["row"]}, "target": {"file": target["sources"][0]["file"], "row": target["sources"][0]["row"]}})
        else:
            kept.append(row)
    return kept, decisions


CATALOG_WORKBOOKS = {
    "GROHE  grohe.xlsx": "Grohe",
    "SHOWERS HANSGROHE.xlsx": "Hansgrohe", "BM.xlsx": "Hansgrohe",
    "TBM.xlsx": "Hansgrohe", "WBM.xlsx": "Hansgrohe", "HFAV.xlsx": "Hansgrohe",
    "Single lever.xlsx": "Hansgrohe", "3hole.xlsx": "Hansgrohe",
    "Holder.xlsx": "Hansgrohe", "Showerhose.xlsx": "Hansgrohe",
    "rail.xlsx": "Hansgrohe", "kitchen.xlsx": "Hansgrohe", "Ceramic.xlsx": "Hansgrohe",
    "VITRA Price Table 2026.xlsx": "Vitra",
}


def extract_catalog_sources(source_dir, output_dir):
    """Only named supplier catalogs, never customer quotation/price offers."""
    import openpyxl
    records = []
    for filename, brand in CATALOG_WORKBOOKS.items():
        path = source_dir / filename
        if not path.exists():
            continue
        sha = hashlib.sha256(path.read_bytes()).hexdigest()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            book = openpyxl.load_workbook(path, data_only=True)
        for sheet in book:
            images = defaultdict(list)
            for image in sheet._images:
                data = image._data()
                digest = hashlib.sha256(data).hexdigest()
                local = output_dir / "images" / f"{digest}.{image.format}"
                local.parent.mkdir(parents=True, exist_ok=True)
                local.write_bytes(data)
                images[(image.anchor._from.row + 1, image.anchor._from.col + 1)].append({"path": str(local.resolve()), "sha256": digest})
            for row_no, cells in enumerate(sheet.iter_rows(max_col=25, values_only=True), 1):
                columns = (3, 7, 11, 15, 19) if brand == "Vitra" else (2,)
                for col in columns:
                    sku = code_text(cells[col - 1])
                    name = " · ".join(code_text(v) for v in cells[:2] if v) if brand == "Vitra" else code_text(cells[2])
                    if not sku or not name or not re.fullmatch(r"[A-Za-z0-9.-]{6,22}", sku) or not any(c.isdigit() for c in sku):
                        continue
                    raw_price = cells[col + 1] if brand == "Vitra" else cells[4]
                    price = number(raw_price.replace(",", "")) if isinstance(raw_price, str) else number(raw_price)
                    image_col = col + 1 if brand == "Vitra" else 4
                    image_rows = images[(row_no, image_col)]
                    records.append({"brand": brand, "sku": sku, "name": name, "mrp": price, "image_local": image_rows[0] if len(image_rows) == 1 else None, "provenance": {"file": filename, "sha256": sha, "sheet": sheet.title, "row": row_no}})
        book.close()
    # GROHE PDF text consistently lays out exact article / description / MRP.
    pdf = output_dir / "GROHE PRICING 2026.pdf.txt"
    if pdf.exists():
        lines, page = pdf.read_text().splitlines(), None
        for i, line in enumerate(lines):
            if line.startswith("PAGE "):
                page = line.removeprefix("PAGE ")
            sku = line.strip()
            if not re.fullmatch(r"[0-9]{5}[A-Z0-9]{3,5}", sku):
                continue
            description = []
            for next_line in lines[i + 1:i + 12]:
                match = re.fullmatch(r"\s*`([0-9,]+)\s*", next_line)
                if match:
                    if description:
                        records.append({"brand": "Grohe", "sku": sku, "name": " ".join(description), "mrp": float(match[1].replace(",", "")), "image_local": None, "provenance": {"file": "GROHE PRICING 2026.pdf", "page": page}})
                    break
                if re.fullmatch(r"[0-9]{5}[A-Z0-9]{3,5}", next_line.strip()) or next_line.startswith("PAGE "):
                    break
                description.append(next_line.strip())
    pdf = output_dir / "GEBERIT_MRP_Catalogue_-2026.pdf.txt"
    if pdf.exists():
        page = None
        for line in pdf.read_text().splitlines():
            if line.startswith("PAGE "):
                page = line.removeprefix("PAGE ")
            match = re.search(r"(\d{3}\.\d{3}\.[A-Za-z0-9]{2}\.\d)\s+MRP:\s*`([0-9,]+)", line)
            if match:
                records.append({"brand": "Geberit", "sku": match[1], "name": None, "mrp": float(match[2].replace(",", "")), "image_local": None, "provenance": {"file": "GEBERIT_MRP_Catalogue_-2026.pdf", "page": page}})
    return records


def build_manifest(extracted, snapshot, catalog_sources=(), duravit=None, *, actor_id, batch_id, source_root, aliases=None, enrichment=None):
    floor = "first-floor"
    brand_ids = {row["name"].casefold(): row["id"] for row in snapshot["brands"] if row.get("floor_id") == floor}
    categories = {row["id"]: row["name"] for row in snapshot["categories"] if row.get("floor_id") == floor}
    index, supplements, media = defaultdict(list), defaultdict(list), defaultdict(list)
    for product in snapshot["products"]:
        if product.get("floor_id") == floor and product.get("active", True):
            keys = {code_key(product["sku"])} | {code_key(entry["source_sku"]) for entry in product.get("catalog_entries", []) if entry.get("source_sku")}
            for key in keys:
                index[(product["brand_id"], key)].append(product)
    for row in catalog_sources:
        supplements[(row["brand"].casefold(), code_key(row["sku"]))].append(row)
    for row in snapshot["product_media"]:
        if row.get("floor_id") == floor and row.get("role") in ("hero", "gallery") and row.get("public_url"):
            media[row["product_id"]].append(row)
    rows, decisions = deduplicate_mirrors(extracted["rows"])
    lots, new_products, new_brands = [], [], []
    duravit = duravit or {}
    aliases = aliases or {}
    enrichment = enrichment or {}
    products_by_id = {r["id"]: r for r in snapshot["products"] if r.get("floor_id") == floor and r.get("active", True)}
    duravit_brand = identity("brand", "duravit", floor)
    if any(row["brand"] == "Duravit" for row in rows) and "duravit" not in brand_ids:
        new_brands.append({"id": duravit_brand, "floor_id": floor, "name": "Duravit", "slug": "duravit"})
        brand_ids["duravit"] = duravit_brand
    for row in rows:
        source = row["sources"][0]
        lot_id = identity(batch_id, source["file"], source["sheet"], source["row"], row["kind"], row["sku"])
        brand_id = brand_ids.get(row["brand"].casefold())
        candidates = index[(brand_id, code_key(row["sku"]))]
        product = candidates[0] if len(candidates) == 1 else None
        alias = aliases.get(f"{row['brand']}|{row['sku']}")
        if alias:
            candidate = products_by_id.get(alias.get("product_id"))
            if not candidate or candidate["brand_id"] != brand_id or not alias.get("evidence"):
                raise ValueError("Reviewed SKU alias needs same-floor/brand catalog product and evidence")
            product = candidate
        extra = supplements[(row["brand"].casefold(), code_key(row["sku"]))]
        prices = {r["mrp"] for r in extra if r.get("mrp") is not None}
        # Existing catalog identity and price take precedence over local
        # conflicting workbooks. Missing prices require one consistent value.
        price = product.get("mrp") if product and product.get("price_status") != "unspecified" else (next(iter(prices)) if len(prices) == 1 else None)
        name = product["name"] if product else next((r["name"] for r in extra if r.get("name")), row["raw_article"] or f"Unidentified {row['brand']} item")
        image = None
        local_image = None
        if product:
            candidates_media = sorted([m for m in media[product["id"]] if m.get("brand_id") == product["brand_id"] and str(m.get("mime") or "").startswith("image/")], key=lambda m: (not m.get("is_primary"), m.get("role") != "hero", m.get("sort_order", 0)))
            image = candidates_media[0]["public_url"] if candidates_media else (product.get("hero_image_url") or next(iter(product.get("images") or []), None))
        if not image:
            local_image = next((r["image_local"] for r in extra if r.get("image_local")), None)
            if not local_image:
                embedded = [i for s in row["sources"] for i in s["embedded_images"]]
                if len({i["sha256"] for i in embedded}) == 1:
                    local_image = {k: embedded[0][k] for k in ("path", "sha256")}
        if row["brand"] == "Duravit":
            verified = duravit.get(row["sku"]) or duravit.get(f"Duravit|{row['sku']}") or {}
            name = verified.get("name") or row["raw_article"]
            image = verified.get("image")
            local_image = verified.get("image_local")
            if isinstance(local_image, str):
                local_image = {"path": local_image, "sha256": verified["image_sha256"]}
            price = None
            category_name = verified.get("category_name") or ("Basins" if source["section"] == "BESIN" else "Water Closets" if source["section"] == "DURAVIT WC" else "Accessories")
            if category_name == "Toilets":
                category_name = "Water Closets"
            category_id = verified.get("category_id") or next((id for id, n in categories.items() if n.casefold() == category_name.casefold()), None)
            if not category_id:
                raise ValueError("Duravit needs an existing first-floor category")
            product = {"id": identity("product", floor, "duravit", row["sku"]), "floor_id": floor, "brand_id": brand_id, "category_id": category_id, "sku": verified.get("canonical_sku") or verified.get("sku") or row["sku"], "name": name, "description": row["raw_article"], "mrp": 0, "price": 0, "price_status": "unspecified", "active": True, "stock": 0, "images": [image] if image else [], "catalog_source": "godown_workbook_duravit", "specs": {"price_status": "unspecified", "stock_source_article": row["raw_article"], "stock_source_section": source["section"], "manufacturer_provenance": verified.get("provenance")}}
            new_products.append(product)
        recovered = enrichment.get(f"{row['brand']}|{row['sku']}") or {}
        if recovered and not recovered.get("source"):
            raise ValueError("Remaining enrichment requires exact-code source evidence")
        if not image and not local_image and recovered:
            image = recovered.get("image")
            local_image = recovered.get("image_local")
            if isinstance(local_image, str):
                local_image = {"path": local_image, "sha256": recovered["image_sha256"]}
        if price is None and row["brand"] != "Duravit" and recovered.get("unit_price") is not None:
            price = recovered["unit_price"]
        lot = {"id": lot_id, "floor_id": floor, "product_id": product["id"] if product else f"godown:{lot_id}", "sku": row["sku"], "name": name, "brand_id": brand_id, "brand_name": row["brand"], "category_id": product.get("category_id") if product else None, "category": categories.get(product.get("category_id")) if product else None, "image": image, "mrp": price, "unit_price": price, "discount_pct": 0, "price_variants": [], "qty_received": row["qty"] if row["qty"] is not None else 0, "available_qty": row["qty"] if row["qty"] is not None else 0, "quantity_missing": row["quantity_missing"], "quantity_notes": row["quantity_notes"], "source_type": "warehouse_import", "reason": "Stock replaced from supplied warehouse workbooks", "archived": False, "allocations": [], "import_batch_id": batch_id, "source_provenance": row["sources"], "catalog_match": "exact" if product and row["brand"] != "Duravit" else ("duravit_new" if row["brand"] == "Duravit" else "unresolved"), "catalog_provenance": [r["provenance"] for r in extra]}
        if local_image:
            lot["image_local"] = local_image
        if alias:
            lot["catalog_match"] = "reviewed_alias"
            lot["catalog_alias_evidence"] = alias["evidence"]
        if recovered:
            lot["enrichment_source"] = recovered["source"]
        lots.append(lot)
    active = [r for r in snapshot["godown_stock"] if r.get("floor_id") == floor and not r.get("archived")]
    clean = lambda r: {k: v for k, v in r.items() if k != "_id"}
    catalog_files = sorted({r["provenance"]["file"] for r in catalog_sources})
    source_hashes = [{"file": filename, "sha256": hashlib.sha256((Path(source_root) / filename).read_bytes()).hexdigest()} for filename in catalog_files]
    totals = {brand: {"lots": sum(r["brand_name"] == brand for r in lots), "recorded_quantity": sum(r["available_qty"] for r in lots if r["brand_name"] == brand), "quantity_missing": sum(r["quantity_missing"] for r in lots if r["brand_name"] == brand)} for brand in sorted({r["brand_name"] for r in lots})}
    return {"version": 1, "batch_id": batch_id, "floor_id": floor, "actor_id": actor_id, "source_root": str(source_root), "source_files": extracted["files"], "catalog_source_files": source_hashes, "expected_stock_sha256": fingerprint(sorted([clean(r) for r in active], key=lambda r: r["id"])), "expected_stock_ids": sorted(r["id"] for r in active), "deduplication_decisions": decisions, "lots": lots, "new_brands": new_brands, "new_products": new_products, "summary": {"source_rows": len(extracted["rows"]), "lots": len(lots), "collapsed_mirrors": len(decisions), "quantity_missing": sum(r["quantity_missing"] for r in lots), "price_missing": sum(r["unit_price"] is None for r in lots), "image_missing": sum(not r["image"] and not r.get("image_local") for r in lots), "exact_catalog_matches": sum(r["catalog_match"] == "exact" for r in lots), "by_brand": totals}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--snapshot", type=Path)
    parser.add_argument("--duravit", type=Path)
    parser.add_argument("--aliases", type=Path)
    parser.add_argument("--enrichment", type=Path)
    parser.add_argument("--actor-id")
    parser.add_argument("--batch-id", default="godown-workbooks-2026-10-14")
    args = parser.parse_args()
    result = extract_workbooks(args.source_dir, args.output_dir)
    if args.snapshot:
        if not args.actor_id:
            parser.error("--snapshot requires --actor-id")
        supplements = extract_catalog_sources(args.source_dir, args.output_dir)
        (args.output_dir / "catalog_sources.json").write_text(json.dumps(supplements, indent=2))
        manifest = build_manifest(result, json.loads(args.snapshot.read_text()), supplements, json.loads(args.duravit.read_text()) if args.duravit else None, actor_id=args.actor_id, batch_id=args.batch_id, source_root=args.source_dir, aliases=json.loads(args.aliases.read_text()) if args.aliases else None, enrichment=json.loads(args.enrichment.read_text()) if args.enrichment else None)
        manifest_path = args.output_dir / "manifest.json"
        manifest_path.write_text(json.dumps(manifest, indent=2))
        manifest_path.chmod(0o600)
        print(json.dumps(manifest["summary"]))
    print(json.dumps({"files": len(result["files"]), "rows": len(result["rows"]), "known_quantity_rows": sum(row["qty"] is not None for row in result["rows"])}))


if __name__ == "__main__":
    main()
