"""Isolated file extraction for the catalogue management worker."""
import json
import os
from pathlib import Path
import sys


def main(directory: Path) -> None:
    if sys.platform.startswith("linux"):
        import resource

        os.nice(10)
        resource.setrlimit(resource.RLIMIT_AS, (384 * 1024 * 1024,) * 2)
        resource.setrlimit(resource.RLIMIT_CPU, (180, 180))
        resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024 * 1024,) * 2)
    from .self_service_files import read_catalogue

    settings = json.loads((directory / "input.json").read_text())
    source = directory / settings.pop("source")
    result_path = directory / "result.json"
    try:
        result = read_catalogue(source, **settings)
        images = {}
        for digest, image in result.images.items():
            (directory / digest).write_bytes(image.data)
            images[digest] = {
                "mime": image.mime, "width": image.width, "height": image.height, "quality": image.quality,
            }
        with result_path.open("w") as output:
            json.dump({"rows": result.rows, "images": images, "warnings": result.warnings}, output)
    except (ValueError, OSError, MemoryError) as exc:
        message = str(exc) if isinstance(exc, ValueError) else "The file exceeds the processing budget or could not be read."
        result_path.write_text(json.dumps({"error": message}))


if __name__ == "__main__":
    main(Path(sys.argv[1]))
