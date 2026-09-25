import csv
import io

import openpyxl
import pytest

from services.export import rows_to_csv, rows_to_xlsx


@pytest.mark.parametrize("name", ['=HYPERLINK("https://example.com","Open")', "+SUM(1,1)", "-1+1", "@SUM(1,1)", "\t=1+1", "  =1+1", "\r\n=1+1"])
def test_spreadsheet_exports_treat_untrusted_names_as_text(name):
    rows = [{"name": name, "amount": -125.5}]
    columns = [("name", "Customer"), ("amount", "Revenue")]
    csv_rows = list(csv.reader(io.StringIO(rows_to_csv(rows, columns).decode("utf-8-sig"))))
    assert csv_rows[1] == ["'" + name, "-125.5"]
    workbook = openpyxl.load_workbook(io.BytesIO(rows_to_xlsx(rows, columns)))
    cell = workbook.active["A2"]
    assert cell.data_type == "s"
    # openpyxl versions differ on CRLF normalization; the formula guard stays.
    assert cell.value.replace("\r\n", "\n") == "'" + name.replace("\r\n", "\n")
    assert workbook.active["B2"].value == -125.5
