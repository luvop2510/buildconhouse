"""Non-sensitive build identity for matching deployed API and web releases."""
import os
import re


def source_revision():
    # Render supplies this for the actual deploy. Never echo arbitrary env
    # values into a public health response, including local placeholder data.
    value = os.environ.get("RENDER_GIT_COMMIT", "")
    return value.lower() if re.fullmatch(r"[a-fA-F0-9]{40}", value) else None
