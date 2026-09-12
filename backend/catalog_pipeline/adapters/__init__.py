"""Adapter registry — pick the right adapter for a brand."""
from .grohe import GroheAdapter
from .geberit import GeberitAdapter
from .vitra import VitraAdapter
from .hansgrohe import HansgroheAdapter
from .oyster import OysterAdapter
from .qutone import QutoneAdapter
from .dimore import DimoreAdapter
from .nexion import NexionAdapter
from .modulo import ModuloAdapter
from .donato import DonatoAdapter
from .renite import ReniteAdapter
from .tile_per_piece import KenzoAdapter, MilagroAdapter
from .tile_catalog_2026 import BoffoAdapter, PandaAdapter

REGISTRY = {
    "grohe": GroheAdapter,
    "geberit": GeberitAdapter,
    "vitra": VitraAdapter,
    # Hansgrohe (with AXOR merged as an internal collection).
    "hansgrohe": HansgroheAdapter,
    # AXOR routed to Hansgrohe adapter — same file format, brand folded.
    "axor": HansgroheAdapter,
    "oyster": OysterAdapter,
    "qutone": QutoneAdapter,
    "dimore": DimoreAdapter,
    "nexion": NexionAdapter,
    "modulo": ModuloAdapter,
    "donato": DonatoAdapter,
    "renite": ReniteAdapter,
    "milagro": MilagroAdapter,
    "kenzo": KenzoAdapter,
    "panda": PandaAdapter,
    "boffo": BoffoAdapter,
}


def get_adapter(brand: str):
    key = (brand or "").strip().lower()
    if key not in REGISTRY:
        raise ValueError(f"No adapter for brand '{brand}'. Available: {sorted(REGISTRY)}")
    return REGISTRY[key]()
