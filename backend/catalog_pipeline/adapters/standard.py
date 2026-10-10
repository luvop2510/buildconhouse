"""Deterministic company CSV/XLSX import; no model calls or token cost.

One row per SKU. Required headers: sku, name, category, mrp. Optional
headers match ProductRow (dealer_price, description, finish, size, etc.).
Missing media deliberately preserves the previous catalog image.
"""
from __future__ import annotations
import base64
import csv
import io
from pathlib import Path
from ..base import BrandAdapter, ExtractionReport, ProductRow, MISSING
from ..resource_limits import MAX_ROWS, ImportResourceLimitError


class StandardAdapter(BrandAdapter):
    supported_extensions = (".csv", ".xlsx")

    def __init__(self, brand: str):
        self.brand = brand

    def extract(self, data: bytes, filename: str):
        images = {}
        if Path(filename).suffix.lower() == ".csv":
            records = csv.reader(io.StringIO(data.decode("utf-8-sig")))
        else:
            import openpyxl
            workbook = openpyxl.load_workbook(io.BytesIO(data), data_only=True)
            sheet = workbook.active
            records = sheet.iter_rows(values_only=True)
            for image in sheet._images:
                row_index = image.anchor._from.row
                raw = image._data()
                images.setdefault(row_index, []).append(f"data:image/{image.format};base64,{base64.b64encode(raw).decode('ascii')}")
        headers = [str(value or "").strip().lower().replace(" ", "_") for value in next(records, [])]
        if not {"sku", "name", "category", "mrp"}.issubset(headers):
            raise ValueError("Company file requires sku, name, category and mrp columns")
        rows = []
        allowed = {"sku", "name", "category", "subcategory", "series", "family_key", "variant", "finish", "finish_code", "colour", "material", "dimensions", "size", "description", "warranty", "collection"}
        for index, values in enumerate(records, 1):
            if not any(value is not None and str(value).strip() for value in values):
                continue
            if len(rows) >= MAX_ROWS:
                raise ImportResourceLimitError("Supplier row limit exceeded; split the file")
            record = dict(zip(headers, values))
            fields = {key: str(record[key]).strip() for key in allowed if record.get(key) is not None and str(record[key]).strip()}
            row = ProductRow(brand=self.brand, **fields)
            row.mrp = self.to_number(record.get("mrp"))
            row.dealer_price = self.to_number(record.get("dealer_price"))
            row.images = images.get(index, [])
            row.image_quality = "acceptable" if row.images else "missing"
            # Require review of missing images without manufacturing media.
            rows.append(row)
        report = ExtractionReport(brand=self.brand, filename=filename, source_type="csv" if filename.lower().endswith(".csv") else "excel", raw_rows=len(rows), parsed_rows=len(rows), images_found=sum(len(row.images) for row in rows), images_mapped=sum(len(row.images) for row in rows), warnings=["Standard company import: deterministic extraction, no AI tokens. Required headers: sku, name, category, mrp; dealer_price is optional."])
        return rows, report
