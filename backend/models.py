"""Pydantic models for Forge. Every persisted doc uses a UUID id string."""
from __future__ import annotations
from datetime import datetime, timezone
from typing import Any, Literal, Optional
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator
from services.password_policy import MIN_PASSWORD_LENGTH, validate_new_password
from services.staff_contacts import optional_email, read_staff_email, read_staff_phone, validate_staff_phone


Role = Literal[
    "owner", "admin", "manager", "sales",
    "purchase", "warehouse", "accounts", "worker",
]

AccessProfile = Literal[
    "ground_tile_quotations_followups", "ground_payments_dispatches",
    "sanitary_quotations_followups", "sanitary_purchases",
]

QuotationStatus = Literal[
    "draft", "pending_approval", "approved", "rejected", "sent", "won", "lost", "expired",
    "ordered",  # order placed — POs generated
]

# Architects and interior designers who refer business. Kept close to the
# customer model because a customer's referrer is the attribution source.
ReferrerType = Literal["architect", "interior_designer"]

# Purchase Order lifecycle. Ordering matters — the frontend Kanban / status
# selectors reflect this canonical sequence.
PurchaseStatus = Literal[
    "draft",              # PO generated, not yet reviewed
    "awaiting_review",    # sent for internal approval
    "ordered",            # sent to supplier
    "awaiting_supplier",  # supplier acknowledged, awaiting production/ship
    "partial_received",   # some line items received
    "fully_received",     # all line items received
    "packed",             # goods packed for customer dispatch
    "ready_for_dispatch", # awaiting final dispatch to customer
    "cancelled",
]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class TimestampedModel(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    created_at: str = Field(default_factory=now_iso)
    updated_at: str = Field(default_factory=now_iso)


# ---------- Users (staff) ----------
class UserBase(BaseModel):
    email: Optional[EmailStr] = None
    login_id: Optional[str] = None
    team_role: Optional[str] = Field(default=None, max_length=120)
    full_name: str
    role: Role
    phone: Optional[str] = None
    mobile: Optional[str] = None
    active: bool = True
    avatar_url: Optional[str] = None
    floor_ids: list[str] = Field(default_factory=list)
    # An optional profile only narrows the normal role's access.
    access_profile: Optional[AccessProfile] = None
    custom_access: bool = False

    _email_normalization = field_validator("email", mode="before")(optional_email)
    _legacy_contacts = field_validator("phone", "mobile", mode="before")(read_staff_phone)


class UserCreate(UserBase):
    password: str = Field(min_length=MIN_PASSWORD_LENGTH, max_length=72)

    _password_policy = field_validator("password")(validate_new_password)


class UserPublic(UserBase, TimestampedModel):
    _email_normalization = field_validator("email", mode="before")(read_staff_email)
    mfa_enabled: bool = False
    mfa_version: int = 0
    # Compatibility fields for older clients. Staff passwords are permanently
    # owner-managed; authenticated staff responses normalize these to false/null.
    must_change_password: bool = False
    temp_password_expires_at: Optional[str] = None
    # Request-scoped selection; never persisted to the users collection.
    active_floor_id: Optional[str] = None
    # Request-scoped too: the id of the user_sessions row the calling token
    # belongs to. Needed so a minted download token can stay bound to the
    # same revocable session (see services/download_tokens.py).
    session_id: Optional[str] = None


class UserInDB(UserPublic):
    password_hash: str


class LoginPayload(BaseModel):
    # Keep the existing JSON key for backwards-compatible email/username login.
    email: str = Field(min_length=1, max_length=254)
    password: str
    mfa_code: Optional[str] = Field(default=None, max_length=6)
    recovery_code: Optional[str] = Field(default=None, max_length=40)


class MFAProofPayload(BaseModel):
    current_password: str = Field(min_length=1, max_length=1024)
    mfa_code: Optional[str] = Field(default=None, max_length=6)
    recovery_code: Optional[str] = Field(default=None, max_length=40)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserPublic


# ---------- Customers ----------
class CustomerBase(BaseModel):
    name: str
    company: Optional[str] = None
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    property_name: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    pincode: Optional[str] = None
    gstin: Optional[str] = None
    tier: Literal["retail", "trade", "vip"] = "retail"
    notes: Optional[str] = None
    avatar_url: Optional[str] = None
    # Customer Portal login gate — a customer can only sign into the portal
    # when this is true, regardless of whether a password_hash exists.
    portal_enabled: bool = False
    # floor_id deliberately NOT on this base — CustomerCreate (the POST
    # /customers request body) inherits CustomerBase, and the live frontend
    # never sends floor_id in that payload (customer_routes.create_customer
    # always overwrites it server-side via floor_for_write(user) before
    # persisting). Making it required here would 422 every "Add Customer"
    # request. It is required instead on CustomerPublic below — the
    # persisted/response shape — so every STORED customer document is still
    # guaranteed a real floor_id; only the request contract is unaffected.
    # ---- Reserved CRM fields (Walk-ins module, 2026-07-30) ----
    # Cheap to add now, all optional/defaulted so every existing Customer
    # document reads back identically — no migration. Not yet exposed in
    # any UI beyond Walk-ins; reserved so future channels (SMS, branch
    # transfers, lead scoring, segmentation) don't need a schema change.
    alternate_phone: Optional[str] = None
    preferred_contact_method: Optional[Literal["call", "whatsapp", "email", "sms"]] = None
    preferred_contact_time: Optional[str] = None
    assigned_branch: Optional[str] = None
    tags: list[str] = []
    lead_temperature: Optional[Literal["cold", "warm", "hot"]] = None
    # The customer's single source of referral attribution.  Quotes copy this
    # into their immutable snapshot so reporting remains historically stable.
    referrer_id: Optional[str] = None
    referrer_name: Optional[str] = None
    referrer_type: Optional[ReferrerType] = None


class CustomerCreate(CustomerBase):
    password: Optional[str] = Field(default=None, min_length=MIN_PASSWORD_LENGTH, max_length=72)  # for portal login

    @field_validator("password")
    @classmethod
    def validate_password_policy(cls, value):
        return validate_new_password(value) if value is not None else value


class CustomerUpdatePayload(BaseModel):
    """Customers > Edit Customer. All fields optional — only supplied keys
    are patched (see customer_routes.update_customer)."""
    name: Optional[str] = None
    company: Optional[str] = None
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    property_name: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    pincode: Optional[str] = None
    gstin: Optional[str] = None
    tier: Optional[Literal["retail", "trade", "vip"]] = None
    notes: Optional[str] = None
    portal_enabled: Optional[bool] = None
    alternate_phone: Optional[str] = None
    preferred_contact_method: Optional[Literal["call", "whatsapp", "email", "sms"]] = None
    preferred_contact_time: Optional[str] = None
    assigned_branch: Optional[str] = None
    tags: Optional[list[str]] = None
    lead_temperature: Optional[Literal["cold", "warm", "hot"]] = None
    referrer_id: Optional[str] = None
    referrer_name: Optional[str] = None
    referrer_type: Optional[ReferrerType] = None


class CustomerPublic(CustomerBase, TimestampedModel):
    # Computed on demand; never use persisted metadata to decide fulfillment.
    purchase_completion_status: Optional[Literal["active", "completed"]] = None
    # Required here (not on CustomerBase — see the comment there) so every
    # persisted/returned customer document is guaranteed a real floor_id.
    floor_id: str
    # References to temporary product loans; they do not affect receivables.
    lent_stock_transfer_ids: list[str] = []
    borrowed_stock_transfer_ids: list[str] = []
    # Set when Send Invite / Reset Password issues a temporary password — the
    # customer must set their own password on first portal login.
    must_change_password: bool = False
    temp_password_expires_at: Optional[str] = None


class CustomerInDB(CustomerPublic):
    password_hash: Optional[str] = None


class CustomerLoginPayload(BaseModel):
    email: EmailStr
    password: str


class CustomerTokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    customer: CustomerPublic


class ChangePasswordPayload(BaseModel):
    current_password: str = Field(..., max_length=72)
    new_password: str = Field(..., min_length=MIN_PASSWORD_LENGTH, max_length=72)

    @field_validator("new_password")
    @classmethod
    def validate_password_policy(cls, value):
        return validate_new_password(value) if value is not None else value


# ---------- Team management (Settings) ----------
class TeamAccessGrantPayload(BaseModel):
    resource: str
    floor_id: str
    actions: list[Literal["view", "create", "update", "delete", "export"]] = Field(min_length=1)


class TeamCreatePayload(BaseModel):
    login_id: Optional[str] = Field(default=None, max_length=120)
    team_role: Optional[str] = Field(default=None, max_length=120)
    custom_access: bool = False
    access_grants: Optional[list[TeamAccessGrantPayload]] = None
    email: Optional[EmailStr] = None
    full_name: str
    role: Role
    phone: Optional[str] = None
    mobile: Optional[str] = None
    password: str = Field(..., min_length=MIN_PASSWORD_LENGTH, max_length=72)
    floor_ids: list[str] = Field(default_factory=list)
    access_profile: Optional[AccessProfile] = None

    _email_normalization = field_validator("email", mode="before")(optional_email)
    _contact_validation = field_validator("phone", "mobile", mode="before")(validate_staff_phone)

    @field_validator("password")
    @classmethod
    def validate_password_policy(cls, value):
        return validate_new_password(value) if value is not None else value


class TeamUpdatePayload(BaseModel):
    login_id: Optional[str] = Field(default=None, max_length=120)
    team_role: Optional[str] = Field(default=None, max_length=120)
    custom_access: Optional[bool] = None
    access_grants: Optional[list[TeamAccessGrantPayload]] = None
    full_name: Optional[str] = None
    email: Optional[EmailStr] = None
    role: Optional[Role] = None
    phone: Optional[str] = None
    mobile: Optional[str] = None
    active: Optional[bool] = None
    floor_ids: Optional[list[str]] = None
    access_profile: Optional[AccessProfile] = None

    _email_normalization = field_validator("email", mode="before")(optional_email)
    _contact_validation = field_validator("phone", "mobile", mode="before")(validate_staff_phone)


class TeamPasswordResetPayload(BaseModel):
    new_password: str = Field(min_length=MIN_PASSWORD_LENGTH, max_length=72)

    _password_policy = field_validator("new_password")(validate_new_password)


class FloorPublic(TimestampedModel):
    name: str
    slug: str
    active: bool = True


class FloorCreatePayload(BaseModel):
    name: str = Field(..., min_length=2, max_length=80)
    slug: Optional[str] = None
    active: bool = True


# ---------- Settings: Company profile (Settings > Company) ----------
# Persisted in db.settings with key="company" — same generic key/value
# settings-store pattern already used by purchases_tracker.py's TrackerSettings.
# Every field has a sensible default matching what was previously hardcoded
# across the frontend (theme/tokens.ts `brand`) and pdf_generator.py, so
# reading this before it has ever been saved behaves exactly like today.
class CompanySettings(BaseModel):
    name: str = "BuildCon House"
    tagline: str = "One Destination. Infinite Possibilities."
    phone: str = "+91 99099 06652"
    email: EmailStr | str = "buildconhouse10@gmail.com"
    address: Optional[str] = None
    gstin: Optional[str] = None
    logo_base64: Optional[str] = None  # data: URL, shown in-app + used on PDFs once set
    updated_at: Optional[str] = None
    updated_by: Optional[str] = None
    updated_by_name: Optional[str] = None


# ---------- Settings: PDF branding (Settings > PDF) ----------
# Persisted in db.settings with key="pdf". Governs ONLY the branding chrome
# of the quotation PDF (footer text, terms paragraph, signature line,
# watermark on/off) — never the item table, discount math, or page layout.
# Defaults match the previously-hardcoded pdf_generator.py output exactly.
class PDFSettings(BaseModel):
    footer_company_name: str = "Buildcon House"
    footer_phone: str = "+91 99099 06652"
    footer_email: str = "buildconhouse10@gmail.com"
    footer_tagline: str = "One Destination. Infinite Possibilities."
    terms_text: Optional[str] = None
    signature_name: Optional[str] = None
    signature_title: Optional[str] = None
    show_watermark: bool = True
    updated_at: Optional[str] = None
    updated_by: Optional[str] = None
    updated_by_name: Optional[str] = None


class UserSession(BaseModel):
    """One device/browser login — lets a user see & revoke their active
    sessions ('remember trusted devices' / 'logout from all devices')."""
    id: str = Field(default_factory=lambda: str(uuid4()))
    user_type: Literal["staff", "customer"]
    user_id: str
    login_method: Literal["password", "google"] = "password"
    device_label: Optional[str] = None
    user_agent: Optional[str] = None
    ip: Optional[str] = None
    created_at: str = Field(default_factory=now_iso)
    last_seen_at: str = Field(default_factory=now_iso)
    revoked: bool = False


class SessionInfo(BaseModel):
    id: str
    device_label: Optional[str] = None
    login_method: str
    created_at: str
    last_seen_at: str
    current: bool = False


# ---------- Catalog ----------
class Brand(TimestampedModel):
    name: str
    slug: str
    logo_url: Optional[str] = None
    country: Optional[str] = None
    floor_id: str
    catalog_source: Optional[str] = None
    catalog_order: Optional[int] = None
    catalog_authoritative: bool = False


class Category(TimestampedModel):
    name: str
    slug: str
    parent_id: Optional[str] = None
    icon: Optional[str] = None
    floor_id: str
    brand_id: Optional[str] = None
    catalog_source: Optional[str] = None
    catalog_order: Optional[int] = None


class BrandCreate(BaseModel):
    name: str
    slug: str
    logo_url: Optional[str] = None
    country: Optional[str] = None


class CategoryCreate(BaseModel):
    name: str
    slug: str
    parent_id: Optional[str] = None
    icon: Optional[str] = None


class ProductVariant(BaseModel):
    sku: str
    name: Optional[str] = None
    finish: Optional[str] = None
    finish_code: Optional[str] = None
    size: Optional[str] = None
    colour: Optional[str] = None
    color: Optional[str] = None
    variant_label: Optional[str] = None
    mrp: float
    price: float
    stock: int = 0
    dimensions: Optional[str] = None
    material: Optional[str] = None
    warranty: Optional[str] = None
    specs: dict = {}
    description: Optional[str] = None
    # Populated dynamically at read-time (media_service.hydrate_variants_batch)
    # from family-sibling products — NOT persisted on the stored embedded
    # field. Lets every variant chip show its own real photo + link back to
    # the sibling product it represents.
    id: Optional[str] = None
    image: Optional[str] = None
    listing_id: Optional[str] = None
    price_unknown: Optional[bool] = None
    concealed_part: Optional["ConcealedPart"] = None


class ConcealedPart(BaseModel):
    """The optional rough-in/concealed item automatically added with a SKU.

    ``sku`` also supports legacy importer associations. New selections are
    verified against an active product on the same floor before saving. The
    remaining fields expose current catalog values for future quotation lines;
    saved quotations retain their own independent commercial snapshots.
    """
    sku: str = Field(min_length=1, max_length=160)
    product_id: Optional[str] = None
    name: Optional[str] = None
    description: Optional[str] = None
    unit_price: Optional[float] = Field(default=None, ge=0)
    mrp: Optional[float] = Field(default=None, ge=0)
    image: Optional[str] = None
    qty: float = Field(default=1, gt=0)


class CatalogEntry(BaseModel):
    """An exact supplier workbook placement of a canonical, sellable SKU."""
    entry_id: str
    source_catalog: str
    sheet_name: str
    sheet_order: int = Field(ge=0)
    row_number: int = Field(ge=1)
    source_order: int = Field(ge=0)
    serial_number: str | int | float | None = None
    category_id: str
    category_name: str
    subcategory: Optional[str] = None
    name: Optional[str] = None
    description: Optional[str] = None
    mrp: Optional[float] = Field(default=None, ge=0)
    price_status: Literal["known", "unspecified"] = "unspecified"
    source_sku: Optional[str] = None
    article_raw: Any = None
    source_cells: dict = Field(default_factory=dict)
    price_candidates: list = Field(default_factory=list)
    price_raw: Any = None
    discontinued_source: bool = False
    source_status_note: Optional[str] = None


class Product(TimestampedModel):
    floor_id: str
    name: str
    sku: str
    brand_id: str
    category_id: str
    subcategory: Optional[str] = None      # e.g. "Wall Hung WC", "Console Basin"
    series: Optional[str] = None            # e.g. "Metropole", "Sento", "Zentrum"
    collection: Optional[str] = None        # e.g. "AXOR" (premium line under Hansgrohe brand)
    family_key: Optional[str] = None        # variants that share this key are the same family
    family_name: Optional[str] = None       # human-readable family label
    variant_label: Optional[str] = None     # e.g. "Matt Black", "Chrome"
    finish_code: Optional[str] = None       # supplier finish code (e.g. "483" for Vitra Matt Black)
    colour: Optional[str] = None
    description: Optional[str] = None
    finish: Optional[str] = None            # e.g. "Chrome", "Matt Black", "Brushed Brass"
    size: Optional[str] = None              # e.g. "600x600mm" — tile nominal size
    material: Optional[str] = None
    dimensions: Optional[str] = None
    dimension_image_urls: list[str] = []
    seat_cover_image_urls: list[str] = []
    warranty: Optional[str] = None
    mrp: float = Field(ge=0)
    price: float = Field(ge=0)              # trade price
    stock: int = 0
    # DEPRECATED (kept for read-back compatibility) — new media lives in
    # `product_media` collection referenced via ProductMedia.
    images: list[str] = []
    image_meta: list[dict] = []             # per-image {width,height,quality,source_format}
    image_quality: Optional[str] = None     # aggregate: excellent|good|acceptable|poor|missing
    # A trimset marked this way cannot be installed on its own.  Keep the
    # supplier's required in-wall/concealed article number as structured data
    # instead of hiding it in a description or a free-form tag.
    must_buy_concealed: bool = False
    concealed_sku: Optional[str] = None
    concealed_skus: list[str] = []          # plural when a trimset needs more than one rough-in
    # The editable, quotation-ready default. Legacy SKU fields remain for
    # import compatibility and are backfilled into this field by migration.
    concealed_part: Optional[ConcealedPart] = None
    # NEW media architecture (Iteration 2A). These fields are populated from
    # the `product_media` collection at query-time so business code stays
    # decoupled from storage. Never write directly to these fields.
    media_summary: Optional[dict] = None    # {"supplier": n, "manufacturer": n, "internal": n, "best_quality": "..."}
    hero_image_url: Optional[str] = None    # canonical public URL of the primary image
    gallery: list[dict] = []                # [{url, role, source_type, width, height, quality}]
    specs: dict = {}                        # freeform key/value spec extras
    tags: list[str] = []
    variants: list[ProductVariant] = []
    # Curated relationships (populated in Phase 2C but modelled now)
    related_ids: list[str] = []             # manual "you might also like"
    compatible_ids: list[str] = []          # curated compatible parts
    accessory_ids: list[str] = []           # curated accessories
    downloads: list[dict] = []              # [{title, type, url, size_bytes}] — kept for Downloads tab
    is_custom: bool = False                 # created inline from the builder (custom product flow)
    active: bool = True
    catalog_source: Optional[str] = None
    catalog_entries: list[CatalogEntry] = Field(default_factory=list)
    catalog_search_text: Optional[str] = None
    price_status: Optional[Literal["known", "existing", "unspecified"]] = None


class ProductCreate(BaseModel):
    name: str
    sku: str
    brand_id: str
    category_id: str
    subcategory: Optional[str] = None
    series: Optional[str] = None
    collection: Optional[str] = None
    # A SKU remains its own product record (price, stock, and media are SKU
    # specific), but these fields place it in the family-first catalog card
    # used by staff to switch colour/finish without seeing duplicate cards.
    family_key: Optional[str] = None
    family_name: Optional[str] = None
    description: Optional[str] = None
    variant_label: Optional[str] = None
    finish: Optional[str] = None
    finish_code: Optional[str] = None
    colour: Optional[str] = None
    size: Optional[str] = None
    material: Optional[str] = None
    dimensions: Optional[str] = None
    warranty: Optional[str] = None
    mrp: float
    price: float
    stock: int = 0
    images: list[str] = []
    tags: list[str] = []
    must_buy_concealed: bool = False
    concealed_sku: Optional[str] = None
    concealed_skus: list[str] = []
    concealed_part: Optional[ConcealedPart] = None
    is_custom: bool = False


class ProductPatch(BaseModel):
    """Partial edit of an existing catalog product — the "single source of
    truth" editor (Catalog / Quotation Builder / Purchases all write through
    this one shape). Every field is optional; only fields actually present in
    the request body are applied (exclude_unset), so callers never
    accidentally blank out a field they didn't mean to touch."""
    name: Optional[str] = None
    sku: Optional[str] = None
    brand_id: Optional[str] = None
    category_id: Optional[str] = None
    subcategory: Optional[str] = None
    series: Optional[str] = None
    family_key: Optional[str] = None
    family_name: Optional[str] = None
    variant_label: Optional[str] = None
    finish: Optional[str] = None
    size: Optional[str] = None
    colour: Optional[str] = None
    description: Optional[str] = None
    dimensions: Optional[str] = None
    dimension_image_urls: Optional[list[str]] = None
    seat_cover_image_urls: Optional[list[str]] = None
    mrp: Optional[float] = None
    price: Optional[float] = None
    specs: Optional[dict] = None
    must_buy_concealed: Optional[bool] = None
    concealed_sku: Optional[str] = None
    concealed_skus: Optional[list[str]] = None
    concealed_part: Optional[ConcealedPart] = None


class SizeVariantResolution(BaseModel):
    """Read-model contract for changing a catalog style's nominal size.

    ``product`` is intentionally a complete hydrated product dictionary rather
    than a partial price patch: callers must replace their selected SKU with
    this row so its price and all SKU-specific attributes stay in sync.
    """
    source_product_id: str
    requested_size: Optional[str] = None
    resolved_product_id: str
    available_sizes: list[str] = []
    size_count: int = 0
    size_switchable: bool = False
    product: dict[str, Any]


# ---------- Quotations ----------
class QuotationLineItem(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    product_id: str
    sku: str
    name: str
    image: Optional[str] = None
    finish: Optional[str] = None
    colour: Optional[str] = None
    category_id: Optional[str] = None      # denormalized for category-level discounts
    room: Optional[str] = None
    area: Optional[str] = None          # presentation grouping within the room
    qty: float = Field(default=1, gt=0)
    unit_price: float = Field(default=0, ge=0)  # final selling price per unit ("offer rate")
    mrp: Optional[float] = Field(default=None, ge=0)  # catalog MRP at the time this line was added; None → PDF falls back to unit_price
    catalog_price: Optional[float] = Field(default=None, ge=0)
    catalog_mrp: Optional[float] = Field(default=None, ge=0)
    catalog_version: Optional[int] = Field(default=None, ge=0)
    # Post-discount total for this line, resolved through services/pricing.py's
    # cascade and denormalized at write time. Analytics sums THIS field, so
    # product/brand/category revenue reconciles to grand_total by construction
    # instead of re-deriving discounts per report and drifting.
    # No ge=0: room/category discount configs are unbounded, so an
    # out-of-range discount can produce a negative net. Rejecting it here
    # would make an already-persisted item un-reparseable — the invalid input
    # is the discount config, not this derived value.
    net_amount: Optional[float] = None
    # BACKEND_AUDIT_2026-07-17.md Medium #36: unbounded before this — a
    # negative discount_pct silently acts as a MARKUP (net price goes up),
    # and anything over 100 makes net go negative (the business pays the
    # customer). Neither is ever a valid quotation state.
    discount_pct: Optional[float] = Field(default=None, ge=0, le=100)  # None → inherit from category/project
    notes: Optional[str] = None
    description: Optional[str] = None      # inline override of product description
    dimension: Optional[str] = Field(default=None, max_length=240)
    exclude_dimension: bool = False
    # A catalog item that was inserted automatically with a parent line, for
    # example the seat cover selected with a VitrA WC.  These links are saved
    # in the quotation snapshot so quantity, delete, duplicate and room-move
    # actions remain coherent after a draft is reopened.
    included_for_line_id: Optional[str] = None
    included_qty_per_parent: Optional[float] = Field(default=None, gt=0)
    sort_order: int = 0
    # Tiles document fields (Ground Floor → Tiles Selection / Quotation).
    # On tiles docs `room` doubles as the free-text AREA cell, `unit_price` is
    # the derived rate per box and `qty` the quantity — so existing totals math holds.
    size: Optional[str] = None             # e.g. "1200X1800"
    rate_sqft: Optional[float] = Field(default=None, ge=0)
    rate_box: Optional[float] = Field(default=None, ge=0)
    pcs_per_box: Optional[str] = None      # catalog metadata retained in the PCS/BOX column for every tile line
    box_sqft: Optional[float] = Field(default=None, ge=0)  # sqft covered by one box — effective per-sqft price x box_sqft derives unit_price (rate/box)
    offer_rate: Optional[float] = Field(default=None, ge=0)  # final selling price per SQ.FT; defaults to rate_sqft and drives totals
    quantity_unit: Literal["Box", "Pieces"] = "Box"
    # When a line is fulfilled from returned/declined material in BuildCon's
    # godown, retain immutable provenance on the quotation itself.  This is
    # deliberately a snapshot (not a join) so PDFs and historic quotations
    # remain explainable after the source stock is exhausted.
    godown_stock_id: Optional[str] = None
    godown_allocation_id: Optional[str] = None
    godown_source_customer_name: Optional[str] = None
    godown_source_purchased_at: Optional[str] = None
    godown_transferred_at: Optional[str] = None
    godown_allocated_at: Optional[str] = None

    @field_validator("quantity_unit", mode="before")
    @classmethod
    def normalize_quantity_unit(cls, value: object) -> object:
        """Store the two supported display units in their canonical form.

        The Tiles UI writes ``Box`` and ``Pieces``.  Normalizing historic and
        API-client spellings here means an existing ``piece`` quotation can be
        loaded, enriched, and printed instead of failing before PDF creation.
        Unknown values remain invalid under the Literal contract.
        """
        normalized = str(value or "Box").strip().lower()
        if normalized in {"piece", "pieces", "pc", "pcs"}:
            return "Pieces"
        if normalized in {"box", "boxes"}:
            return "Box"
        return value

    @property
    def net(self) -> float:
        """Line total after discount — final price the customer pays for this line."""
        gross = self.qty * self.unit_price
        disc_pct = self.discount_pct or 0
        disc = gross * disc_pct / 100
        return round(gross - disc, 2)

    @property
    def total(self) -> float:
        """Alias for net — Forge uses final prices only, no tax layered on top."""
        return self.net


class QuotationRevision(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    revision_no: int
    created_at: str = Field(default_factory=now_iso)
    created_by: str
    reason: Optional[str] = None
    snapshot: dict


class RoomDiscountCfg(BaseModel):
    """Room-level discount — either a flat % off every line in the room, or a
    fixed rupee amount off the room's subtotal (allocated proportionally
    across the room's lines). Sits between product-level overrides and
    category/project discounts in the precedence chain:
        Product override > Room discount > Category discount > Project discount
    """
    type: Literal["percent", "amount"] = "percent"
    value: float = 0


# ---------- Referrers (Sales Data > Referred By) ----------
# Architects and interior designers who send business our way. Deliberately
# minimal — just enough to attribute revenue to a specific person. Existing
# free-text Quotation.reference_source ("Walk-in", "Instagram", etc.) is
# untouched; these fields are only used when a quotation's referrer_type is
# architect/interior_designer. See
# docs/superpowers/specs/2026-07-27-sales-data-dashboard-design.md.
class Referrer(TimestampedModel):
    name: str
    type: ReferrerType
    floor_id: str
    normalized_name: str
    active: bool = True
    phone: Optional[str] = None
    company: Optional[str] = None
    created_by: str


class ReferrerCreate(BaseModel):
    name: str
    type: ReferrerType
    phone: Optional[str] = None
    company: Optional[str] = None


class Quotation(TimestampedModel):
    purchase_completion_status: Optional[Literal["active", "completed"]] = None
    floor_id: str
    number: str                          # human-readable e.g. FQ-2026-0001
    customer_id: str
    customer_name: str
    # Which document builder owns this record. "standard" = the classic
    # sanitaryware quotation builder; the tiles types are the Ground Floor →
    # Tiles Selection / Quotation pages (their PDFs replicate the official
    # printed formats and use the tiles fields below).
    doc_type: Literal["standard", "tiles_selection", "tiles_quotation"] = "standard"
    attended_by: Optional[str] = None
    prepared_by: Optional[str] = None
    # Required for tiles_quotation documents; optional for standard and
    # tiles_selection records so the shared quotation model remains compatible.
    address_snapshot: Optional[str] = None    # tiles quotation ADDRESS line
    doc_date: Optional[str] = None            # printed date (selection/quotation dt); None → created_at
    doc_number: Optional[str] = None          # editable printed number; None → `number`
    # V4 header fields — captured on the builder header so the sales rep never
    # leaves the workspace. All optional and safely backward-compatible.
    project_name: Optional[str] = None
    phone_snapshot: Optional[str] = None      # frozen at quote time (customer.phone can change)
    reference_source: Optional[str] = None    # "Walk-in", "Reference", "Instagram", "Architect", etc.
    referrer_type: Optional[ReferrerType] = None   # set only when reference_source-style
    referrer_id: Optional[str] = None               # tracking is via a structured Referrer
    referrer_name: Optional[str] = None              # denormalized at write time — see Referrer
    status: QuotationStatus = "draft"
    # Stamped once, when status first becomes "ordered", and never rewritten.
    # EVERY revenue calculation dates by this field. updated_at cannot be used:
    # it is re-stamped on every edit, so editing an old order would move its
    # revenue into the current period.
    ordered_at: Optional[str] = None
    items: list[QuotationLineItem] = []
    rooms: list[str] = []                # ordered list of room labels
    collapsed_rooms: list[str] = []      # ui state — persisted so it survives reloads
    project_discount_pct: float = Field(default=0, ge=0, le=100)  # applied on top of item net (after item discount)
    category_discounts: dict[str, float] = {}  # {category_id: discount_pct}
    room_discounts: dict[str, RoomDiscountCfg] = {}  # {room_name: {type, value}}
    # Full UI state blob — active_room, scroll positions, expanded panels,
    # last-opened filter, favourite chips. Written on silent autosave so
    # reopening the quotation puts the salesperson EXACTLY where they left off.
    ui_state: dict = {}
    subtotal: float = 0
    discount_total: float = 0            # total of all discounts (item + cat + project)
    grand_total: float = 0
    # Ground Floor Tiles only. Kept on the quotation aggregate so it is
    # persisted, recalculated, rendered in the PDF, and survives reloads.
    transportation_fee: float = Field(default=0, ge=0)
    # Cached sum of the immutable additional-cost history below. Kept separate
    # from grand_total so the original printed quotation remains intact.
    payment_extra_amount: float = Field(default=0, ge=0)
    # [{id, name, amount, note, created_at, recorded_by, recorded_by_name}].
    # Entries are append-only audit records; never rewrite an existing cost.
    payment_extra_history: list[dict] = Field(default_factory=list)
    notes: Optional[str] = None
    valid_until: Optional[str] = None
    created_by: str                      # user id
    created_by_name: str
    approved_by: Optional[str] = None
    revisions: list[QuotationRevision] = []
    # Set only when this order was auto-generated by the Purchases "Transfer to
    # another customer" workflow — lets Payments/Timeline explain WHY an order
    # exists even though no one manually built a quotation for it.
    source: Optional[Literal["transfer"]] = None
    source_purchase_order_id: Optional[str] = None
    source_item_id: Optional[str] = None


class QuotationCreate(BaseModel):
    customer_id: str
    items: list[QuotationLineItem] = []
    rooms: list[str] = []
    notes: Optional[str] = None
    valid_until: Optional[str] = None
    project_name: Optional[str] = None
    phone_snapshot: Optional[str] = None
    reference_source: Optional[str] = None
    referrer_type: Optional[ReferrerType] = None
    referrer_id: Optional[str] = None
    project_discount_pct: float = 0
    category_discounts: dict[str, float] = {}
    room_discounts: dict[str, RoomDiscountCfg] = {}
    doc_type: Literal["standard", "tiles_selection", "tiles_quotation"] = "standard"
    attended_by: Optional[str] = None
    prepared_by: Optional[str] = None
    address_snapshot: Optional[str] = None
    doc_date: Optional[str] = None
    doc_number: Optional[str] = None
    transportation_fee: float = Field(default=0, ge=0)


class QuotationUpdate(BaseModel):
    customer_id: Optional[str] = None    # change the customer on an existing quotation
    items: Optional[list[QuotationLineItem]] = None
    rooms: Optional[list[str]] = None
    collapsed_rooms: Optional[list[str]] = None
    notes: Optional[str] = None
    valid_until: Optional[str] = None
    status: Optional[QuotationStatus] = None
    project_name: Optional[str] = None
    phone_snapshot: Optional[str] = None
    reference_source: Optional[str] = None
    referrer_type: Optional[ReferrerType] = None
    referrer_id: Optional[str] = None
    ui_state: Optional[dict] = None
    project_discount_pct: Optional[float] = None
    category_discounts: Optional[dict[str, float]] = None
    room_discounts: Optional[dict[str, RoomDiscountCfg]] = None
    attended_by: Optional[str] = None
    prepared_by: Optional[str] = None
    address_snapshot: Optional[str] = None
    doc_date: Optional[str] = None
    doc_number: Optional[str] = None
    transportation_fee: Optional[float] = Field(default=None, ge=0)
    reason: Optional[str] = None         # for revision log
    silent: bool = False                 # if true, skip revision snapshot (autosave)


# ---------- Ops modules (scaffold) ----------
class Supplier(TimestampedModel):
    """A dealership/supplier we buy from — normally one per brand but not strict."""
    floor_id: str
    name: str
    brand_id: Optional[str] = None
    brand_name: Optional[str] = None
    contact_person: Optional[str] = None
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    gstin: Optional[str] = None
    payment_terms: Optional[str] = None   # e.g. "30 days credit"
    notes: Optional[str] = None
    active: bool = True


class SupplierCreate(BaseModel):
    name: str
    brand_id: Optional[str] = None
    contact_person: Optional[str] = None
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    gstin: Optional[str] = None
    payment_terms: Optional[str] = None
    notes: Optional[str] = None


PURCHASE_STAGES = (
    "po_final", "order_in_company", "company_billing", "in_box", "dispatched",
)
# Legacy literals remain readable in immutable historical stage events.
PurchaseStage = Literal[
    "po_final",
    "order_in_company",
    "company_billing",
    "in_box",
    "dispatched",
    "in_transit",
    "delivered",
]


class PurchaseStageEvent(BaseModel):
    """Immutable log of a stage transition on a PurchaseOrderItem."""
    id: str = Field(default_factory=lambda: str(uuid4()))
    at: str = Field(default_factory=now_iso)
    from_stage: Optional[PurchaseStage] = None
    to_stage: PurchaseStage
    by_user_id: str
    by_user_name: str
    note: Optional[str] = None
    action: Literal["move", "transfer_in", "transfer_out", "create", "split_in", "split_out"] = "move"
    ref_item_id: Optional[str] = None   # opposite side of a transfer/split
    ref_po_id: Optional[str] = None
    qty: Optional[float] = None          # units affected — set for split events


class PurchaseCancellationEvent(BaseModel):
    """Immutable record of an explicit tracked-item cancellation."""
    id: str = Field(default_factory=lambda: str(uuid4()))
    at: str = Field(default_factory=now_iso)
    by_user_id: str
    by_user_name: str
    reason: Optional[str] = None


class PurchaseOrderItem(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    product_id: str
    sku: str
    name: str
    image: Optional[str] = None
    finish: Optional[str] = None
    category_id: Optional[str] = None
    room: Optional[str] = None
    qty: float = 1
    qty_received: float = 0
    dispatched_at: Optional[str] = None
    delivered_at: Optional[str] = None
    legacy_stage: Optional[str] = None
    # Quantity moved out of a sanitary purchase line into reusable godown
    # stock. Kept distinct from tile-only `boxes_godown` below.
    godown_transferred_qty: float = Field(default=0, ge=0)
    # Immutable audit trail for returned/declined sanitary material. This is
    # separate from a tile's boxes_godown logistics counter below.
    godown_transfer_history: list[dict] = []
    # Temporary GoDown loans satisfy demand without changing ordered qty.
    godown_borrowed_qty: float = Field(default=0, ge=0)
    # Set when the line itself is fulfilled from reusable sanitary godown
    # stock. These fields make the customer/Purchases indication self-contained.
    godown_stock_id: Optional[str] = None
    godown_allocation_id: Optional[str] = None
    godown_source_customer_name: Optional[str] = None
    godown_source_purchased_at: Optional[str] = None
    godown_transferred_at: Optional[str] = None
    godown_allocated_at: Optional[str] = None
    godown_transfer_mrp: Optional[float] = None
    godown_transfer_unit_price: Optional[float] = None
    godown_transfer_discount_pct: Optional[float] = None
    godown_transfer_net_unit_price: Optional[float] = None
    godown_customer_transfer_id: Optional[str] = None
    unit_cost: float = 0                  # final cost per unit paid to supplier
    notes: Optional[str] = None
    quotation_line_id: Optional[str] = None
    sort_order: int = 0

    # ---- Material-tracking fields (per-line lifecycle) ----
    stage: PurchaseStage = "po_final"
    # Denormalized so the tracker table doesn't need a join for every row.
    customer_id: Optional[str] = None
    customer_name: Optional[str] = None
    brand_id: Optional[str] = None
    brand_name: Optional[str] = None
    # Timestamps for the "Last Move / Dispatched By" column and Blocked SLA.
    last_moved_at: Optional[str] = None
    last_moved_by: Optional[str] = None
    last_moved_by_name: Optional[str] = None
    # Immutable stage history — append-only.
    stage_history: list[PurchaseStageEvent] = []
    # Cancellation is deliberately item-level: a cancelled line stays on its
    # PO for audit/history, but is excluded from active tracker views.
    cancelled: bool = False
    cancelled_at: Optional[str] = None
    cancelled_by: Optional[str] = None
    cancelled_by_name: Optional[str] = None
    cancellation_reason: Optional[str] = None
    cancellation_history: list[PurchaseCancellationEvent] = []
    # Transfer bookkeeping
    transferred_from_item_id: Optional[str] = None   # set on the destination item
    transferred_from_po_id: Optional[str] = None
    transferred_from_customer_id: Optional[str] = None
    # Customer-to-customer stock loan bookkeeping. The source line retains its
    # ordered quantity; these fields record the temporary allocation and the
    # recipient's obligation to return it when its own PO arrives.
    loaned_qty: float = Field(default=0, ge=0)
    customer_loan_history: list[dict] = []
    loan_replenishment_reserved_qty: float = Field(default=0, ge=0)
    loan_replenishment_promised_qty: float = Field(default=0, ge=0)
    loan_replenishment_returned_qty: float = Field(default=0, ge=0)
    loan_replenishment_for_customer_name: Optional[str] = None
    loan_replenishment_status: Optional[str] = None
    loan_transfer_id: Optional[str] = None
    borrowed_from_customer_id: Optional[str] = None
    borrowed_from_customer_name: Optional[str] = None
    borrowed_at: Optional[str] = None
    borrowing_note: Optional[str] = None
    return_due_on_replenishment: bool = False
    loan_return_status: Optional[str] = None
    loan_return_due: bool = False
    # Split bookkeeping (partial-quantity stage move — e.g. "3 of 20")
    split_from_item_id: Optional[str] = None          # set on the new (moved) piece
    split_into_item_id: Optional[str] = None           # set on the remainder, if any

    # ---- Tile Orders logistics fields (Ground Floor → Tiles) ----
    # Denormalized from the Product/QuotationLineItem at order-placement
    # time by domain_outbox.py::_handle_order_placed — see Task 5.
    series: Optional[str] = None
    size: Optional[str] = None
    pieces_per_box: Optional[str] = None   # free text, printed as-is — mirrors ChalanLineItem.unit convention
    quantity_unit: Literal["Box", "Pieces"] = "Box"
    # Box-counter invariant: qty == boxes_ready + boxes_godown + boxes_dispatched + boxes_pending
    # UI vocabulary (Tile Orders workflow redesign, 2026-08): boxes_ready is
    # shown to staff as "Released" (Brand/Supplier released this many boxes
    # to BuildCon), boxes_godown is BuildCon's own warehouse stock (moved
    # there out of boxes_ready, never chalan'd), boxes_dispatched is shown
    # as "Delivered" (left BuildCon for the customer via a Dispatch+Chalan,
    # sourced from either boxes_ready or boxes_godown), boxes_pending is
    # shown as "Remaining" (not yet released by the brand). Field names kept
    # as-is (internal/model layer) — only UI labels changed, per design.
    boxes_ready: float = 0
    boxes_godown: float = 0
    boxes_dispatched: float = 0
    boxes_pending: float = 0
    # First time any quantity from this line entered BuildCon's Godown.
    # Partial/repeated moves must not reset this arrival date.
    godown_arrived_at: Optional[str] = None
    current_location: str = "Pending"   # TileLocation — Pending|Ready|Dispatched|Godown|Delivered
    overall_status: str = "Pending"     # TileOverallStatus — furthest-progress ladder


class PurchaseStatusEvent(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    at: str = Field(default_factory=now_iso)
    from_status: Optional[str] = None
    to_status: str
    by_user_id: str
    by_user_name: str
    note: Optional[str] = None


class PurchaseAttachment(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    at: str = Field(default_factory=now_iso)
    by_user_id: str
    by_user_name: str
    filename: str
    mime: str = "application/octet-stream"
    # BACKEND_AUDIT_2026-07-17.md High #17: base64 used to be embedded
    # directly on this document (no cap on attachment count/aggregate size,
    # trending toward MongoDB's 16MB document limit). New attachments upload
    # to the private Supabase bucket and store only `storage_key`; a signed
    # URL is minted on demand via GET /{po_id}/attachments/{id}/url.
    # `data_url` stays Optional so PO documents written before this change
    # keep rendering — it is never populated for new attachments.
    data_url: Optional[str] = None
    storage_key: Optional[str] = None
    size_bytes: int = 0
    note: Optional[str] = None


class ChalanLineItem(BaseModel):
    """One product line within a single material-release batch — a subset
    (or all) of a PurchaseOrderItem's quantity."""
    po_item_id: str          # references PurchaseOrderItem.id this batch covers
    name: str
    brand_name: Optional[str] = None
    size: Optional[str] = None
    finish: Optional[str] = None
    qty: float
    unit: str = "Box"        # "Box" | "PCS" — free text, printed as-is
    rate: Optional[float] = None


ChalanStage = Literal["released", "at_godown", "dispatched"]


class Chalan(BaseModel):
    """A Delivery Release Receipt — proof that this batch of material was
    released from the supplier's factory. Embedded on PurchaseOrder.chalans
    (not a separate collection) so there is exactly one order document and
    nothing to keep in sync between views."""
    id: str = Field(default_factory=lambda: str(uuid4()))
    number: str                              # "CH-1052"
    created_at: str = Field(default_factory=now_iso)
    created_by: str
    created_by_name: str
    items: list[ChalanLineItem] = []
    reference_number: Optional[str] = None
    receiver_name: Optional[str] = None
    sender_name: Optional[str] = None        # "Supplier Representative"
    transport: Optional[str] = None
    remarks: Optional[str] = None
    stage: ChalanStage = "released"
    godown_received_at: Optional[str] = None
    godown_received_by: Optional[str] = None
    godown_received_by_name: Optional[str] = None
    dispatched_at: Optional[str] = None
    dispatched_by: Optional[str] = None
    dispatched_by_name: Optional[str] = None
    dispatch_note: Optional[str] = None


class PurchaseOrder(TimestampedModel):
    floor_id: str
    number: str                            # human — e.g. FPO-2026-0001
    quotation_id: Optional[str] = None
    quotation_number: Optional[str] = None
    customer_id: str
    customer_name: str
    project_id: Optional[str] = None       # future: multi-project customers
    project_name: Optional[str] = None
    brand_id: Optional[str] = None
    brand_name: Optional[str] = None
    supplier_id: Optional[str] = None
    supplier_name: Optional[str] = None
    status: PurchaseStatus = "draft"
    items: list[PurchaseOrderItem] = []
    status_history: list[PurchaseStatusEvent] = []
    attachments: list[PurchaseAttachment] = []
    internal_notes: Optional[str] = None
    expected_delivery_at: Optional[str] = None
    delivered_at: Optional[str] = None
    subtotal: float = 0
    grand_total: float = 0
    created_by: str
    created_by_name: str
    assigned_to: Optional[str] = None
    assigned_to_name: Optional[str] = None
    chalans: list[Chalan] = []

    # ---- Tile Orders logistics fields (Ground Floor → Tiles) ----
    customer_order_id: Optional[str] = None
    ready_boxes: float = 0
    pending_boxes: float = 0
    dispatched_boxes: float = 0
    latest_ready_date: Optional[str] = None
    latest_dispatch_date: Optional[str] = None
    overall_status: str = "Pending"
    completion_percentage: float = 0
    last_supplier_activity_at: Optional[str] = None


class PurchaseOrderUpdate(BaseModel):
    supplier_id: Optional[str] = None
    supplier_name: Optional[str] = None
    internal_notes: Optional[str] = None
    expected_delivery_at: Optional[str] = None
    assigned_to: Optional[str] = None
    items: Optional[list[PurchaseOrderItem]] = None


# ---------- Shortage / Reorder tracking (Workflow Integrity Sprint) ----------
# Purely additive collection — created the moment a transfer leaves a
# customer's originally-committed quantity under-allocated. Never blocks a
# transfer; purchasing sees it as a recommendation, not an error.
ShortageStatus = Literal["awaiting_reorder", "reordered", "resolved", "dismissed"]


class PurchaseShortage(TimestampedModel):
    customer_id: str
    customer_name: str
    quotation_id: Optional[str] = None
    quotation_number: Optional[str] = None
    quotation_line_id: Optional[str] = None
    product_id: str
    sku: str
    name: str
    image: Optional[str] = None
    committed_qty: float = 0        # what the customer originally ordered on this line
    allocated_qty: float = 0        # what's still allocated to them right now
    shortage_qty: float = 0         # committed - allocated (> 0 while open)
    status: ShortageStatus = "awaiting_reorder"
    reason: str = ""
    transferred_to_customer_id: Optional[str] = None
    transferred_to_customer_name: Optional[str] = None
    resolved_po_id: Optional[str] = None
    resolved_po_number: Optional[str] = None
    resolved_at: Optional[str] = None
    resolved_by: Optional[str] = None
    resolved_by_name: Optional[str] = None


class PurchaseStatusPayload(BaseModel):
    to_status: PurchaseStatus
    note: Optional[str] = None


class PurchaseReceivePayload(BaseModel):
    """Mark quantities received (per line). Backend infers status transition."""
    receipts: dict[str, float]             # {item_id: qty_received}
    note: Optional[str] = None


class PurchaseAttachmentCreate(BaseModel):
    filename: str = Field(min_length=1, max_length=160)
    mime: str = "application/octet-stream"
    data_url: str = Field(min_length=16, max_length=15 * 1024 * 1024)
    note: Optional[str] = None


# ---------- Activity Log (audit trail) ----------
ActivityEntity = Literal["quotation", "purchase", "customer", "project", "payment", "followup", "user", "product", "tile_customer_order", "walkin"]


class ActivityEvent(TimestampedModel):
    """Immutable audit entry. Timelines are read models over this collection."""
    event_type: str                        # e.g. quotation.created, purchase.status_changed
    entity_type: ActivityEntity
    entity_id: str
    actor_id: Optional[str] = None
    actor_name: Optional[str] = None
    # De-normalised references so timelines resolve without extra joins.
    customer_id: Optional[str] = None
    quotation_id: Optional[str] = None
    purchase_id: Optional[str] = None
    payload: dict = {}
    # Human-readable summary rendered by the frontend as-is when present.
    summary: Optional[str] = None
    # Business unit this event belongs to. Optional only because events
    # predating floor stamping exist; `services/activity_log.timeline_for`
    # filters strictly on it, so an unstamped event is invisible to every
    # floor-scoped reader rather than leaking into the wrong one.
    floor_id: Optional[str] = None


class Payment(TimestampedModel):
    floor_id: str
    idempotency_key: Optional[str] = None
    quotation_id: Optional[str] = None
    quotation_number: Optional[str] = None
    customer_id: str
    customer_name: Optional[str] = None
    amount: float = Field(gt=0)
    # ``adjustment`` is an accounts-receivable debit, not money received.
    # It deliberately has its own mode/status so every collection aggregate
    # that selects ``completed`` payments continues to represent cash only.
    mode: Literal["cash", "upi", "bank", "card", "cheque", "adjustment"] = "upi"
    status: Literal["pending", "completed", "failed", "adjustment"] = "completed"
    reference: Optional[str] = None            # cheque no. / UTR / short note
    note: Optional[str] = None                 # freeform note (optional)
    # A positive ledger credit can settle an order without money changing
    # hands, for example when material is returned to reusable godown stock.
    # It remains a Payment row so balances and the immutable payment history
    # use one reconciliation ledger, while the type keeps it distinguishable
    # from an actual customer collection.
    entry_type: Literal["payment", "godown_stock_credit", "additional_cost"] = "payment"
    godown_stock_id: Optional[str] = None
    # Links the immutable ledger debit to its append-only quotation audit
    # record.  This makes retries/support investigations unambiguous without
    # changing the original quotation price.
    additional_cost_id: Optional[str] = None
    cost_name: Optional[str] = None
    paid_at: Optional[str] = None              # ISO date of receipt (defaults to created_at)
    recorded_by: Optional[str] = None          # user id
    recorded_by_name: Optional[str] = None


class PaymentCreate(BaseModel):
    quotation_id: str
    amount: float = Field(gt=0)
    mode: Literal["cash", "upi", "bank", "card", "cheque"] = "cash"
    reference: Optional[str] = None
    note: Optional[str] = None
    paid_at: Optional[str] = None
    idempotency_key: Optional[str] = None


class PaymentOrderExtraUpdate(BaseModel):
    """One immutable additional cost added to an order's collection total.

    Costs are receivables rather than payments, so they remain attached to
    the quotation.  Each request creates a new history entry; it never edits
    a prior cost.
    """
    amount: float = Field(gt=0)
    name: str = Field(..., min_length=1, max_length=120)
    note: Optional[str] = Field(default=None, max_length=500)
    idempotency_key: Optional[str] = Field(default=None, max_length=200)


# ---------- Follow-ups (Sales Command Center) ----------
FollowupRuleType = Literal[
    "quotation_new", "quotation_inactive", "quotation_followup", "quotation_expiring",
    "quotation_expired", "payment_overdue", "payment_partial", "purchase_dispatched",
    "purchase_delivered", "customer_inactive", "shortage_reorder", "manual",
    "selection_waiting", "quotation_tiles_waiting", "walk_in_new", "order_confirmed_ops",
]
FollowupCategory = Literal[
    "quotation", "payment", "purchase", "dispatch", "delivery",
    "complaint", "general", "sales", "support", "selection", "walk_in", "operations",
]
FollowupChannel = Literal["call", "whatsapp", "email", "visit"]
FollowupPriorityLevel = Literal["critical", "high", "medium", "low"]
FollowupStatus = Literal["open", "snoozed", "done", "dismissed"]
# Call outcomes are deliberately distinct from the follow-up's workflow
# status: a lost lead is closed, while a pending lead creates a dated next
# follow-up so it cannot disappear from the queue.
FollowupOutcome = Literal[
    "interested", "call_back", "no_answer", "rejected", "converted",
    "won", "lost", "pending",
]
NotebookStatus = Literal["new", "pending", "won", "lost"]
NotebookField = Literal[
    "customer_name", "customer_phone", "address", "kitchen_type",
    "referred_by", "architect_interior_designer", "status", "notes",
    "quotation_price", "estimated_value", "quotation_date",
]


class Followup(TimestampedModel):
    """A single actionable card in the Follow-ups workspace. Automated rows are
    produced (and kept in sync / auto-resolved) by services/followup_engine.py —
    never created ad-hoc elsewhere. Manual rows (is_automated=False) are created
    by staff via the '+ New Follow-up' action or a logged call outcome."""
    floor_id: str
    source_key: Optional[str] = None        # dedupe key for automated rules, e.g. "payment_overdue:<qid>"
    walkin_id: Optional[str] = None
    origin: Optional[str] = None
    rule_type: FollowupRuleType = "manual"
    category: FollowupCategory = "general"
    customer_id: str
    customer_name: str
    customer_phone: Optional[str] = None
    customer_tier: Literal["retail", "trade", "vip"] = "retail"
    quotation_id: Optional[str] = None
    quotation_number: Optional[str] = None
    purchase_id: Optional[str] = None
    purchase_number: Optional[str] = None
    project_name: Optional[str] = None
    value: float = 0                        # quotation value / outstanding amount — powers scoring + Today's Mission
    reason: str = ""                        # one-line headline shown on the card
    reason_factors: list[str] = []          # explainability bullets behind the priority score
    next_action: str = ""                   # deterministic recommendation, e.g. "Call customer"
    next_action_reason: str = ""            # WHY — shown under the action
    suggested_channel: FollowupChannel = "call"
    priority_score: int = 0                 # 0-100, deterministic (see services/followup_engine.py)
    priority_level: FollowupPriorityLevel = "medium"
    manual_priority_override: Optional[FollowupPriorityLevel] = None
    due_at: str
    status: FollowupStatus = "open"
    snoozed_until: Optional[str] = None
    is_automated: bool = True
    auto_resolved: bool = False
    resolution_note: Optional[str] = None
    assigned_to: Optional[str] = None
    assigned_to_name: Optional[str] = None
    last_contacted_at: Optional[str] = None
    contact_attempts: int = 0
    tags: list[str] = []
    completed_at: Optional[str] = None
    completed_outcome: Optional[FollowupOutcome] = None
    notes: Optional[str] = None
    # Kitchen/Furniture notebook fields. These live on the shared followups
    # document so the notebook reuses existing identity, activity, and floor
    # isolation services instead of creating a second domain model.
    notebook_key: Optional[str] = None
    is_converted: bool = False
    address: Optional[str] = None
    kitchen_type: Optional[Literal["GI", "SS"]] = None
    referred_by: Optional[str] = None
    # Structured partner attribution. ``architect_interior_designer`` remains
    # as a legacy display value for older notebook rows, but new assignments
    # must point to the shared referrer directory so they survive into sales
    # data and can be attributed on quotations.
    referrer_id: Optional[str] = None
    referrer_name: Optional[str] = None
    referrer_type: Optional[ReferrerType] = None
    architect_interior_designer: Optional[str] = None
    notebook_status: NotebookStatus = "new"
    quotation_price: Optional[float] = None
    estimated_value: Optional[float] = None
    quotation_date: Optional[str] = None
    converted_at: Optional[str] = None
    lost_reason: Optional[str] = None


class FollowupCreate(BaseModel):
    customer_id: str
    quotation_id: Optional[str] = None
    purchase_id: Optional[str] = None
    category: FollowupCategory = "general"
    channel: FollowupChannel = "call"
    reason: str
    notes: Optional[str] = None
    due_at: Optional[str] = None
    assigned_to: Optional[str] = None
    priority_level: Optional[FollowupPriorityLevel] = None


class FollowupUpdate(BaseModel):
    notes: Optional[str] = None
    due_at: Optional[str] = None
    assigned_to: Optional[str] = None
    manual_priority_override: Optional[FollowupPriorityLevel] = None
    reason: Optional[str] = None
    status: Optional[Literal["open", "dismissed"]] = None


class FollowupSnoozePayload(BaseModel):
    notes: Optional[str] = None
    minutes: Optional[int] = None
    until: Optional[str] = None
    preset: Optional[Literal["15m", "1h", "tomorrow", "next_week", "custom"]] = None


class FollowupCompletePayload(BaseModel):
    notes: Optional[str] = None
    channel: Optional[FollowupChannel] = None


class FollowupCallOutcomePayload(BaseModel):
    outcome: FollowupOutcome
    notes: Optional[str] = None
    # Required by the route for a pending customer.  Keeping it optional here
    # lets the API return a clear, outcome-specific validation error.
    next_followup_at: Optional[datetime] = None


class FollowupContactPayload(BaseModel):
    channel: FollowupChannel
    notes: Optional[str] = None


class NotebookFollowupCreatePayload(BaseModel):
    customer_name: str
    customer_phone: str
    address: Optional[str] = None
    # Kitchen rows choose GI or SS. Furniture rows deliberately do not carry
    # that kitchen-specific attribute.
    kitchen_type: Optional[str] = None
    referred_by: Optional[str] = None
    referrer_id: Optional[str] = None
    architect_interior_designer: Optional[str] = None
    notes: Optional[str] = None

    model_config = ConfigDict(extra="forbid")


class NotebookCellPatchPayload(BaseModel):
    field: NotebookField
    value: Any = None
    updated_at: str
    notes: Optional[str] = None

    model_config = ConfigDict(extra="forbid")


class NotebookConversionPayload(BaseModel):
    # A quotation conversion is complete only when its quoted price is known.
    # Other follow-up fields remain unchanged.
    quotation_price: float
    updated_at: str
    notes: Optional[str] = None

    model_config = ConfigDict(extra="forbid")


class NotebookOutcomePayload(BaseModel):
    outcome: Literal["won", "lost"]
    notes: Optional[str] = None
    # A lost lead is a business decision, not a cosmetic status. Require the
    # reason atomically with the transition so it cannot be bypassed by an
    # inline status edit.
    lost_reason: Optional[str] = None
    updated_at: str

    model_config = ConfigDict(extra="forbid")


class NotebookReferrerPayload(BaseModel):
    # Empty string intentionally clears the assignment; non-empty values are
    # resolved server-side against the floor-scoped referrer directory.
    referrer_id: Optional[str] = None
    updated_at: str
    notes: Optional[str] = None

    model_config = ConfigDict(extra="forbid")


class FollowupSavedView(TimestampedModel):
    """A persisted filter configuration for the Follow-ups workspace."""
    user_id: str
    name: str
    filters: dict = {}          # {kpiFilter, priorityFilter, categoryFilter, tierFilter, ownerFilter, q}


class FollowupSavedViewCreate(BaseModel):
    name: str
    filters: dict = {}


# ---------- Automation Rules (Follow-ups V3 — Tile Orders workspaces) ----------
# Configurable reminder cadences, DB-backed instead of hardcoded — see
# services/automation_rules.py. `category` is a plain string (not a Literal)
# on purpose: future departments (Sanitary, Paints, Hardware…) plug in their
# own category keys without a model change.
class AutomationRule(TimestampedModel):
    category: str                      # "selection" | "quotation_tiles" | ... (extensible)
    label: str
    reminder_offsets_days: list[int] = []   # escalation day-thresholds, e.g. [2, 4, 7, 10]
    is_active: bool = True
    updated_by: Optional[str] = None
    updated_by_name: Optional[str] = None


class AutomationRuleUpdate(BaseModel):
    reminder_offsets_days: Optional[list[int]] = None
    is_active: Optional[bool] = None


class Notification(TimestampedModel):
    user_id: str
    kind: Literal["info", "success", "warning", "error"] = "info"
    title: str
    body: Optional[str] = None
    read: bool = False
    link: Optional[str] = None
    # Business unit the triggering event belongs to. Same containment rule
    # as ActivityEvent.floor_id: unstamped rows are hidden from floor-scoped
    # listings rather than shown on every floor.
    floor_id: Optional[str] = None


# ---------- Catalog Import Pipeline ----------
class CatalogImportJob(TimestampedModel):
    filename: str
    source_type: Literal["excel", "pdf", "csv"]
    # Immutable source retained in forge-private. Review rows hold only
    # lightweight image-blob references, never the original file or base64.
    source_bucket: Optional[str] = None
    source_storage_key: Optional[str] = None
    source_sha256: Optional[str] = None
    source_size_bytes: int = 0
    status: Literal["extracted", "normalized", "classified", "validated", "reviewed", "imported", "failed"] = "extracted"
    supplier_name: Optional[str] = None
    total_rows: int = 0
    accepted_rows: int = 0
    rejected_rows: int = 0
    rows: list[dict] = []
    error: Optional[str] = None
    created_by: str
    floor_id: str



# ---------- Product Media (Iteration 2A) ----------
MediaSourceType = Literal["supplier", "manufacturer", "internal"]
MediaRole = Literal["hero", "gallery", "line-drawing", "lifestyle", "swatch", "spec-sheet", "cad", "dimension", "seat-cover"]
MediaQuality = Literal["excellent", "good", "acceptable", "poor", "missing"]


class ProductMedia(TimestampedModel):
    """Media asset attached to a product (variant) or a whole family.

    Binaries live in Supabase Storage (via MediaStorage); this document holds
    ONLY metadata + a stable reference (`bucket`, `storage_key`, `public_url`).
    Business code MUST NOT deal with the storage layer directly.
    """
    product_id: Optional[str] = None        # attach to specific variant (SKU-level)
    family_key: Optional[str] = None        # attach to the whole family (shared across variants)
    brand_id: Optional[str] = None
    floor_id: str
    source_type: MediaSourceType = "supplier"
    role: MediaRole = "gallery"
    bucket: str                              # "forge-products" | "forge-private"
    storage_key: str                         # object key inside the bucket
    public_url: Optional[str] = None         # for public bucket; None for private
    width: Optional[int] = None
    height: Optional[int] = None
    quality: MediaQuality = "acceptable"
    sha1: str                                # for dedupe + cache-busting
    mime: str = "image/png"
    size_bytes: int = 0
    is_primary: bool = False                 # hero image for this product/family
    sort_order: int = 100
    uploaded_by: Optional[str] = None        # user id
    notes: Optional[str] = None


class ProductMediaCreate(BaseModel):
    product_id: Optional[str] = None
    family_key: Optional[str] = None
    brand_id: Optional[str] = None
    source_type: MediaSourceType = "manufacturer"
    role: MediaRole = "gallery"
    is_primary: bool = False
    sort_order: int = 100
    notes: Optional[str] = None
    # file is uploaded via multipart, not JSON


class AnalyticsTargets(BaseModel):
    """Owner-declared targets the Business Health Score measures against.

    monthly_revenue_target and target_conversion_pct deliberately default to
    None: without a declared target there is no honest way to score revenue
    or conversion, so those components are excluded and the score reports how
    many signals it used. Never default them to an invented benchmark.
    """
    monthly_revenue_target: Optional[float] = Field(default=None, ge=0)
    target_conversion_pct: Optional[float] = Field(default=None, ge=0, le=100)
    target_collection_pct: float = Field(default=90, ge=0, le=100)
    payment_terms_days: int = Field(default=30, ge=0)
