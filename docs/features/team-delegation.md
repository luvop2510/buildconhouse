# Team delegation

Owners manage access in **Settings → Team**. Add a person or edit an existing
member, give their role a descriptive name, and enable the floors they need.
Account access offers Owner or Delegated staff. Legacy Admin, Manager, Sales,
Purchases, Accounts and Warehouse choices are no longer provisioning options;
delegated staff use a compatibility worker value internally, with their named
role and explicit allocation governing access.
Each enabled floor reveals its supported pages. Enable any combination of pages
and choose the actions on each page: View, Create, Edit, Delete, or Export, where
supported. View is included when a page is enabled. The editor explains each
action and saves the complete allocation together.
The previous Roles & permissions and Personal access links now open Team;
Settings shows only the unified Team entry for people and permissions.

Sanitary Quotation access includes read-only product, brand/category/family,
catalog search and customer lookups needed inside the builder. It does not
enable Catalog or Customers navigation, imports, exports, or record changes.
Creating or editing quotations can save the product's concealed-part default
through its dedicated endpoint; general product edits still require Catalog
Edit access. Choosing multiple pages and actions saves one allocation.
Furniture RNB Export access also covers the sender configuration check and
delivery receipt status used by that page, scoped to Furniture; View alone
does not authorize those export controls.

Turning a floor off removes every page permission for that floor. Turning it on
again starts with all pages off. An account with no enabled pages can sign in
and manage its own sessions and MFA, but cannot open business pages.
Owners retain full access. Staff permissions are enforced by the API as well as
navigation and action controls; changing permissions revokes existing sessions.

## Owner-managed credentials

Only owners can create, edit, delete or allocate access to staff accounts. The
owner enters an initial password and optional unique username for each member.
Staff passwords are permanent: they do not expire after onboarding and members
cannot change them. Legacy staff temporary-password flags no longer force a
password-change screen, including the JK PATEL owner account. Customer portal
invites retain their separate temporary-password policy.

In Team, open the intended member and use **Set member password** to choose a
password, or **Generate password** to show a generated credential once. Each
change applies only to that account and signs it out on every device. Owners
change their own password in Settings using their current password. Deleting a
member removes them from Team and disables all sessions; historical business
records retain their account identity. Deleted usernames and emails stay
reserved so a new account cannot silently inherit the deleted identity.
Active owner accounts cannot be deleted, disabled or demoted through Team;
this prevents simultaneous owner changes from leaving the system without an
owner. Concurrent changes to the target account return a conflict and require
reloading it before continuing.

Furniture screens, PDFs and default WhatsApp messages display **RNB**. Existing
`RMB` currency codes and `_rmb` fields remain the storage/API contract, preserving
previously saved quotations and exact decimal calculations.

The page catalog comes from the backend and includes supported floors and
actions. An incomplete or invalid catalog blocks saving until a valid response
is available. **Walk-ins** opens the regular intake, items and customer journey
on every enabled floor. Kitchen and Furniture open this same register by
default. Department filters include only floors with Walk-ins View access;
creation and workflow actions respect the separate Create/Edit allocations.
The salesperson picker includes delegated staff with Walk-ins Create or Edit
on the selected department, without giving them Team or Follow-ups access.
Kitchen and Furniture legacy lead notebooks remain distinctly named, with
separate permissions for historical notebook and quotation follow-up records.

## Account reset operation

Migration `0030` adds a unique index for explicitly assigned, normalized staff
usernames. It does not remove accounts. The separate operational command
`python -m scripts.reset_team_data` previews the fixed `team-reset-20261010`
request. Applying requires a verified private database snapshot, all API and
worker instances in maintenance, the matching database name and previewed user
count, and `FORGE_OWNER_RESET_PASSWORD` supplied privately through the environment.

The reset transaction deletes staff accounts, page grants, sessions, account
activity, saved views, usage history, and permission overrides; disables and
scrubs customer portal credentials; and creates the single full-access owner
with display name and username **JK PATEL**. Customer business documents,
catalog, stock, and financial/workflow history remain intact. A durable receipt
makes repeating the same operation a no-op, preserving subsequently created
accounts and password changes. This operation never runs during application
startup or migrations.
