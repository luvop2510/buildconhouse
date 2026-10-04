"""Idempotent demo data seeding for Forge.

Runs on startup only if the DB is empty. Creates:
- Staff users (all 8 roles)
- Sample brands, categories, products (sanitaryware / bath fittings)
- Sample customers (with portal credentials)
- Sample quotations with realistic totals
- Sample follow-ups and notifications
"""
from datetime import datetime, timedelta, timezone

from auth import hash_password
from db import db
from settings import settings
from models import (
    Brand, Category, CustomerInDB, Notification,
    Product, Quotation, QuotationLineItem, UserInDB,
)

DEMO_STAFF = [
    ("owner@forge.app", "Aarav Kapoor", "owner"),
    ("admin@forge.app", "Ishani Rao", "admin"),
    ("manager@forge.app", "Rohit Verma", "manager"),
    ("sales@forge.app", "Priya Nair", "sales"),
    ("purchase@forge.app", "Kabir Shah", "purchase"),
    ("warehouse@forge.app", "Meera Iyer", "warehouse"),
    ("accounts@forge.app", "Anaya Menon", "accounts"),
    ("worker@forge.app", "Devansh Patel", "worker"),
]

# No hardcoded demo password ships in source anymore — settings.py fails fast
# at startup if demo seeding is enabled without an explicit FORGE_DEMO_PASSWORD.

BRANDS = [
    ("Hansgrohe", "Germany"),
    ("Grohe",     "Germany"),
    ("Vitra",     "Turkey"),
    ("Geberit",   "Switzerland"),
]

CATEGORIES = [
    ("Faucets", "faucets"),
    ("Basins", "basins"),
    ("Water Closets", "water-closets"),
    ("Showers", "showers"),
    ("Bathtubs", "bathtubs"),
    ("Accessories", "accessories"),
    ("Flush Plates", "flush-plates"),
]

# Demo product catalog for the 4 supplier brands we distribute.
# NOTE: No product imagery is seeded — the real product images ship with the
# supplier catalog imports (see backend/catalog_pipeline). The frontend renders
# a graceful "no image" placeholder for these demo products; once the 2026
# supplier PDFs / XLSX are imported the placeholders are automatically replaced.
PRODUCT_SEEDS = [
    # ---- Hansgrohe ----
    ("Talis E Single Lever Basin Mixer", "Faucets", "Hansgrohe", "Chrome", 24800, 18500),
    ("Metris Single Lever Kitchen Mixer", "Faucets", "Hansgrohe", "Chrome", 32500, 24800),
    ("Croma Select S Overhead 280", "Showers", "Hansgrohe", "Chrome", 28500, 21500),
    ("Raindance Select E Hand Shower", "Showers", "Hansgrohe", "Chrome", 18500, 13800),
    # ---- Grohe ----
    ("Grohe Essence Kitchen Mixer", "Faucets", "Grohe", "Chrome", 28900, 21500),
    ("Grohe Grandera Basin Mixer", "Faucets", "Grohe", "Warm Sunset", 42500, 32800),
    ("Grohe Rainshower SmartActive 310", "Showers", "Grohe", "Chrome", 32500, 24800),
    ("Grohe Eurosmart CE Concealed", "Faucets", "Grohe", "Chrome", 16500, 12500),
    # ---- Vitra ----
    ("Vitra S20 Wall-Hung WC", "Water Closets", "Vitra", "White", 32000, 24500),
    ("Vitra Sento Rimless WC", "Water Closets", "Vitra", "White", 48500, 37500),
    ("Vitra Nest Countertop Basin", "Basins", "Vitra", "White", 22800, 17500),
    ("Vitra Options Vanity Basin", "Basins", "Vitra", "White", 18500, 14200),
    # ---- Geberit ----
    ("Geberit AquaClean Mera Comfort Shower Toilet", "Water Closets", "Geberit", "White", 385000, 298000),
    ("Geberit Sigma70 Flush Plate", "Flush Plates", "Geberit", "Brushed Steel", 42500, 32500),
    ("Geberit Duofix In-Wall Cistern", "Accessories", "Geberit", "Grey", 28500, 21800),
    ("Geberit Monolith Plus WC Module", "Water Closets", "Geberit", "Umber Glass", 158000, 122000),
]

# Curated sanitaryware imagery (Unsplash / Pexels). All royalty-free.
PRODUCT_SEEDS_LEGACY_REMOVED = True  # replaced by the 5-brand PRODUCT_SEEDS above

DEMO_CUSTOMERS = [
    ("Rajesh Malhotra", "Malhotra Interiors", "customer@forge.app", "+91 98200 12345", "vip", "Mumbai"),
    ("Ananya Reddy", "Studio Reddy", "ananya@studioreddy.in", "+91 98450 22222", "trade", "Bengaluru"),
    ("Vikram Shah", "Shah Residence", "vikram@shahfamily.in", "+91 99870 33333", "retail", "Ahmedabad"),
    ("Kavya Menon", "Menon Architects", "kavya@menonarch.com", "+91 98470 44444", "trade", "Kochi"),
]


async def _empty(collection: str) -> bool:
    return (await db[collection].count_documents({})) == 0


async def resync_catalog_if_needed():
    """Idempotently reconcile brands+categories+products to the current seed constants.
    Runs every startup. Only takes action when the current set differs from the target.
    Safe to run repeatedly. Quotations are unaffected (they store denormalized snapshots
    of name/sku/image/price on each line, so historical quotes keep rendering).

    DATA-SAFETY GUARD: never touch the catalog if it contains ANY real (non-demo)
    product. Real imports (backend/catalog_pipeline) never tag rows "demo" — only
    PRODUCT_SEEDS below does. Without this guard, a real catalog import with a
    different brand set would cause this function to WIPE the entire
    products/brands/categories collections and replace them with demo data on the
    very next backend restart. This must never happen again.

    SECOND GUARD (2026-07): this used to run unconditionally on every startup,
    regardless of `FORGE_ALLOW_DEMO_SEED` — meaning demo catalog data could
    reappear in a "production" deployment any time the products collection was
    momentarily empty. Now gated behind the same flag as `seed_if_empty`."""
    if not settings.allow_demo_seed:
        return
    real_products = await db.products.count_documents({"tags": {"$ne": "demo"}})
    if real_products > 0:
        return

    desired = {name for name, _ in BRANDS}
    existing_docs = await db.brands.find({}, {"_id": 0, "name": 1}).to_list(200)
    existing = {d["name"] for d in existing_docs}
    if existing == desired:
        # nothing to do
        return

    # Full reset of catalog data — brands / products / product_usage / categories.
    await db.brands.delete_many({})
    await db.products.delete_many({})
    await db.product_usage.delete_many({})
    await db.categories.delete_many({})

    brand_by_name: dict[str, Brand] = {}
    for name, country in BRANDS:
        b = Brand(name=name, slug=name.lower().replace(" ", "-"), country=country, floor_id="first-floor")
        brand_by_name[name] = b
        await db.brands.insert_one(b.dict())

    cat_by_name: dict[str, Category] = {}
    for name, slug in CATEGORIES:
        c = Category(name=name, slug=slug, floor_id="first-floor")
        cat_by_name[name] = c
        await db.categories.insert_one(c.dict())

    for i, (name, cat, brand, finish, mrp, price) in enumerate(PRODUCT_SEEDS, start=1):
        p = Product(
            name=name,
            sku=f"{brand[:3].upper()}-{cat_by_name[cat].slug[:3].upper()}-{i:03d}",
            brand_id=brand_by_name[brand].id,
            category_id=cat_by_name[cat].id,
            description=f"{name} · {finish} finish · by {brand}. Ships in 5–7 business days.",
            finish=finish,
            material="Solid Brass" if cat == "Faucets" else "Ceramic",
            dimensions="—",
            warranty="10 years" if brand == "Geberit" else "5 years",
            mrp=float(mrp),
            price=float(price),
            stock=25 + (i % 40),
            # Demo products carry no image — the ProductImage component renders a
            # branded fallback. Real supplier imports (via catalog_pipeline) will
            # replace these entries with the actual product images by SKU.
            images=[],
            tags=[cat.lower(), brand.lower(), finish.lower(), "demo"],
            floor_id="first-floor",
        )
        await db.products.insert_one(p.dict())


async def seed_if_empty():
    """DATA-SAFETY GUARD: only ever seed demo data into a genuinely fresh/empty
    database. Checks BOTH users and products — if either already has data
    (e.g. a real catalog was restored but users hasn't been touched yet, or
    vice versa), skip entirely. Per explicit requirement: products > 0 => skip;
    database empty => seed."""
    if not settings.allow_demo_seed:
        return
    if not await _empty("users"):
        return
    if not await _empty("products"):
        return

    now = datetime.now(timezone.utc)

    # ---- Users ----
    users: dict[str, UserInDB] = {}
    for email, name, role in DEMO_STAFF:
        u = UserInDB(
            email=email, full_name=name, role=role,  # type: ignore[arg-type]
            password_hash=hash_password(settings.demo_password),
        )
        users[role] = u
        await db.users.insert_one(u.dict())

    # ---- Brands & Categories ----
    brand_by_name: dict[str, Brand] = {}
    for name, country in BRANDS:
        b = Brand(name=name, slug=name.lower().replace(" ", "-"), country=country, floor_id="first-floor")
        brand_by_name[name] = b
        await db.brands.insert_one(b.dict())

    cat_by_name: dict[str, Category] = {}
    for name, slug in CATEGORIES:
        c = Category(name=name, slug=slug, floor_id="first-floor")
        cat_by_name[name] = c
        await db.categories.insert_one(c.dict())

    # ---- Products ----
    products: list[Product] = []
    for i, (name, cat, brand, finish, mrp, price) in enumerate(PRODUCT_SEEDS, start=1):
        p = Product(
            name=name,
            sku=f"{brand[:3].upper()}-{cat_by_name[cat].slug[:3].upper()}-{i:03d}",
            brand_id=brand_by_name[brand].id,
            category_id=cat_by_name[cat].id,
            description=f"{name} · {finish} finish · by {brand}. Ships in 5–7 business days.",
            finish=finish,
            material="Solid Brass" if cat == "Faucets" else "Ceramic",
            dimensions="—",
            warranty="10 years" if brand == "Geberit" else "5 years",
            mrp=float(mrp),
            price=float(price),
            stock=25 + (i % 40),
            images=[],
            tags=[cat.lower(), brand.lower(), finish.lower(), "demo"],
            floor_id="first-floor",
        )
        products.append(p)
        await db.products.insert_one(p.dict())

    # ---- Customers ----
    customer_ids: list[str] = []
    for name, company, email, phone, tier, city in DEMO_CUSTOMERS:
        c = CustomerInDB(
            name=name, company=company, email=email.lower(), phone=phone,
            tier=tier, city=city,  # type: ignore[arg-type]
            password_hash=hash_password(settings.demo_password),
            floor_id="first-floor",
        )
        await db.customers.insert_one(c.dict())
        customer_ids.append(c.id)

    # ---- Quotations ----
    sales_user = users["sales"]
    # Ensure a healthy mix of confirmed orders for the Payments module.
    statuses = ["ordered", "sent", "won", "pending_approval", "ordered", "won", "ordered", "sent"]
    ordered_quotations: list[dict] = []
    for idx, cust_id in enumerate(customer_ids * 2):
        cust = await db.customers.find_one({"id": cust_id}, {"_id": 0})
        picked = products[(idx * 3) % len(products): (idx * 3) % len(products) + 4]
        items = [
            QuotationLineItem(
                product_id=p.id, sku=p.sku, name=p.name, image=p.images[0] if p.images else None,
                room=["Master Bath", "Powder Room", "Guest Bath", "Kitchen"][k % 4],
                qty=1 + (k % 3), unit_price=p.price,
                discount_pct=[0, 5, 10, 12][k % 4],
            )
            for k, p in enumerate(picked)
        ]
        subtotal = sum(i.qty * i.unit_price for i in items)
        disc = sum(i.qty * i.unit_price * i.discount_pct / 100 for i in items)
        status = statuses[idx % len(statuses)]
        # Deliberate variety so the Follow-ups Sales Command Center has real
        # signal on first load — some already expired, one expiring tomorrow,
        # one expiring today, the rest comfortably valid.
        valid_until_offsets = [30, -3, 1, 15, 0, 20, -6, 5]
        q = Quotation(
            number=f"FQ-2026-{idx + 1:04d}",
            customer_id=cust_id,
            customer_name=cust.get("company") or cust["name"],
            status=status,  # type: ignore[arg-type]
            items=items,
            rooms=list({i.room for i in items if i.room}),
            subtotal=round(subtotal, 2),
            discount_total=round(disc, 2),
            grand_total=round(subtotal - disc, 2),
            notes="Prices are valid for 30 days. Delivery in 2–3 weeks after confirmation.",
            valid_until=(now + timedelta(days=valid_until_offsets[idx % len(valid_until_offsets)])).isoformat(),
            created_by=sales_user.id,
            created_by_name=sales_user.full_name,
            floor_id="first-floor",
        )
        # nudge timestamps so dashboard sees "this month"
        q_dict = q.dict()
        q_dict["created_at"] = (now - timedelta(days=idx)).isoformat()
        q_dict["updated_at"] = (now - timedelta(days=idx)).isoformat()
        await db.quotations.insert_one(q_dict)
        if status in ("ordered", "won"):
            ordered_quotations.append(q_dict)

    # ---- Sample payments — mix of partial + fully paid + due orders ----
    # Every third ordered/won quotation gets a partial payment, every fifth gets fully paid.
    from models import Payment
    for i, q_dict in enumerate(ordered_quotations):
        grand = float(q_dict.get("grand_total") or 0)
        if grand <= 0:
            continue
        if i % 5 == 0:
            # Full payment
            paid_at = (now - timedelta(days=i, hours=3)).isoformat()
            p = Payment(
                quotation_id=q_dict["id"], quotation_number=q_dict.get("number"),
                customer_id=q_dict["customer_id"], customer_name=q_dict.get("customer_name"),
                amount=round(grand, 2), mode="bank", status="completed",
                reference=f"UTR{1000 + i}", note="Full & final",
                paid_at=paid_at, recorded_by=users["accounts"].id, recorded_by_name=users["accounts"].full_name,
                floor_id="first-floor",
            )
            await db.payments.insert_one(p.dict())
        elif i % 3 == 0:
            # 50% partial
            paid_at = (now - timedelta(days=i, hours=2)).isoformat()
            p = Payment(
                quotation_id=q_dict["id"], quotation_number=q_dict.get("number"),
                customer_id=q_dict["customer_id"], customer_name=q_dict.get("customer_name"),
                amount=round(grand * 0.5, 2), mode="upi", status="completed",
                reference=f"UPI-{2000 + i}", note="Advance received",
                paid_at=paid_at, recorded_by=users["accounts"].id, recorded_by_name=users["accounts"].full_name,
                floor_id="first-floor",
            )
            await db.payments.insert_one(p.dict())
        # else: remains fully due

    # ---- Follow-ups ----
    # No static seed rows — the Sales Command Center's reconciliation engine
    # (services/followup_engine.reconcile_followups) derives every card live
    # from the quotations/payments/purchase-orders/customers created above,
    # the moment the workspace first loads (and on every manual refresh).

    # ---- Suppliers (one dealership per brand) ----
    from models import Supplier
    supplier_contacts = {
        "Hansgrohe": ("Hansgrohe India Pvt. Ltd.", "Rakesh Gupta", "orders@hansgrohe.in", "+91 22 2683 4400", "Mumbai"),
        "Grohe": ("LIXIL India — Grohe Division", "Priya Menon", "trade@grohe.in", "+91 124 428 0000", "Gurugram"),
        "Vitra": ("Eczacıbaşı Vitra India", "Karthik Rao", "orders@vitra.in", "+91 80 4055 8000", "Bengaluru"),
        "Geberit": ("Geberit Plumbing Technology India", "Anjali Deshpande", "sales@geberit.in", "+91 22 6739 5900", "Mumbai"),
    }
    for name, brand in brand_by_name.items():
        entry = supplier_contacts.get(name, (f"{name} Distributor", "—", None, None, "—"))
        sup = Supplier(
            name=entry[0],
            brand_id=brand.id,
            brand_name=name,
            contact_person=entry[1],
            email=entry[2],
            phone=entry[3],
            city=entry[4],
            payment_terms="30 days credit",
            active=True,
            floor_id="first-floor",
        )
        await db.suppliers.insert_one(sup.dict())

    # ---- Notifications for the sales user ----
    for i in range(5):
        n = Notification(
            user_id=sales_user.id,
            kind=["info", "success", "warning", "info", "success"][i],  # type: ignore[arg-type]
            title=["New quotation approved", "Payment received", "Follow-up due", "Stock low", "Customer replied"][i],
            body="—",
        )
        await db.notifications.insert_one(n.dict())
