"""One disposable parsing process. It has no database or storage imports."""
from __future__ import annotations

import json
from pathlib import Path
import sys


def extract_document(brand: str, filename: str, data: bytes) -> dict:
    from .resource_limits import ImportResourceLimitError, MAX_ROWS, validate_source
    from .adapters import get_adapter
    from .certifier import validate
    from .base import MISSING

    validate_source(data, filename)
    rows, extraction = get_adapter(brand).extract(data, filename)
    if len(rows) > MAX_ROWS:
        raise ImportResourceLimitError("Supplier row limit exceeded")
    validated_rows, cert = validate(rows)
    for row in validated_rows:
        if row.image_quality in {"poor", "missing"} and not any("image requires review" in issue.lower() for issue in row.issues):
            row.issues.append(f"Image requires review ({row.image_quality})")
        if (row.status == "pending" and row.confidence >= 0.85 and row.sku != MISSING
                and row.mrp != MISSING and row.category != MISSING
                and row.image_quality in {"excellent", "good", "acceptable"}):
            row.status = "accepted"
    return {"extraction": extraction.__dict__, "certification": cert.to_public(), "rows": [row.to_public() for row in validated_rows]}


def main() -> int:
    # Apply process ceilings before importing native document decoders. The
    # parent additionally enforces a wall deadline and kills the whole group.
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_CPU, (180, 180))
        resource.setrlimit(resource.RLIMIT_FSIZE, (256 * 1024 * 1024, 256 * 1024 * 1024))
        if sys.platform.startswith("linux"):
            resource.setrlimit(resource.RLIMIT_AS, (1536 * 1024 * 1024, 1536 * 1024 * 1024))
    except (ImportError, ValueError, OSError):
        # Windows/macOS retain the explicit input/expansion/output budgets
        # and killable wall deadline when a resource API is unavailable.
        pass
    from .resource_limits import ImportResourceLimitError, MAX_RESULT_BYTES

    source, result_path, brand, filename = sys.argv[1:]
    try:
        data = Path(source).read_bytes()
        result = extract_document(brand, filename, data)
        encoded = json.dumps(result).encode("utf-8")
        if len(encoded) > MAX_RESULT_BYTES:
            raise ImportResourceLimitError("Supplier extraction result limit exceeded")
        Path(result_path).write_bytes(encoded)
        return 0
    except ImportResourceLimitError as exc:
        Path(result_path).write_text(json.dumps({"error": str(exc)}), encoding="utf-8")
        return 2
    except Exception:
        Path(result_path).write_text(json.dumps({"error": "Supplier document could not be parsed"}), encoding="utf-8")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
