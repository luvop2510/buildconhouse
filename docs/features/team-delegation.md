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
Furniture RMB Export access also covers the sender configuration check and
delivery receipt status used by that page, scoped to Furniture; View alone
does not authorize those export controls.

Turning a floor off removes every page permission for that floor. Turning it on
again starts with all pages off. An account with no enabled pages can sign in
and manage its own password, sessions, and MFA, but cannot open business pages.
Owners retain full access. Staff permissions are enforced by the API as well as
navigation and action controls; changing permissions revokes existing sessions.

The page catalog comes from the backend and includes supported floors and
actions. An incomplete or invalid catalog blocks saving until a valid response
is available. Kitchen and Furniture walk-in and quotation follow-up notebooks
have separate permissions, even though they share backend routes.

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
