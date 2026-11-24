# Buildcon House catalogue management

The app’s catalogue tools and the repository’s six `.agents/skills/buildcon-*` skills use the same authorized catalogue import API. Catalogue edits are database operations. They take effect without a code build or deployment.

## Run a job

Run `python3 scripts/buildcon_catalogue.py --help` at the repository root. Supply an existing authorized staff bearer token through `BUILDCON_API_TOKEN`. The default origin is `https://buildconhouse.in`. Use `--url` before the subcommand only for a trusted Buildcon House environment.

| Department | CLI floor | Stored ID |
|---|---|---|
| Ground Floor and Tiles | `tiles` | `ground-floor` |
| Sanitary and Bathroom | `sanitary` | `first-floor` |
| Kitchen | `kitchen` | `second-floor` |
| Furniture | `furniture` | `third-floor` |

`import` prints a concise preview with the job ID. Add `--apply` when the user requests applying the clean rows, or apply an existing preview with `job --floor <floor> <id> --apply`. Use the same file, floor, brand, operation, and options after an interrupted upload to reuse the job. Use `job --floor <floor> <id>` to check work already submitted and `--resume` for a recoverable job. A new UUID with `--key` creates a separate import of the same source when that is intentional. An authorized rollback uses `job --floor <floor> <id> --rollback` and reports conflicts with later edits.

Append `--errors /path/to/new-file.xlsx` to save row-level errors. Preserve the source worksheet and row numbers when reporting corrections. Re-upload corrected records through a new preview. Inspect representative records in the same floor and brand after the final status. Historical document prices remain preserved.

## Prepare sources

- Use the app’s Products or Price Updates workbook, UTF-8 CSV with equivalent headers, or a PDF supported by a verified supplier parser. Select just the relevant tab with `--sheet`.
- Preserve article numbers as text. The matcher uses the selected floor and brand plus the exact SKU. Conflicting product identities require review.
- Use `--printed-pages` for a requested printed range and `--physical-pages` for confirmed one-based file page indexes. When printed labels are ambiguous, confirm the physical page mapping against the source before proceeding. A scanned or unfamiliar PDF may require verified OCR or structured extraction to a workbook.
- For new Tiles products, include size and the price unit. Include pieces per box for box or square-foot pricing and coverage per box for square-foot pricing. Other departments use the ordinary product fields.
- Anchor an embedded Excel image in its exact product row. Use the image and dimension diagram columns for distinct roles. PDF image support depends on the verified supplier layout. Report missing or conflicting images. Keep source photographs and variants intact.
- For price-only work, map the supplier Article No. and MRP columns. An exported Current MRP protects against an intervening price edit. Empty New MRP leaves a row unchanged. Select a product sync when the user asks to change other fields as well.

## Employee access

Open Settings → Catalogue Management and choose a department. In Team & Roles, the Owner can grant each action for an individual department. Grant View Catalogue Management to enable browsing and catalogue exports, and View Import History to give staff access to earlier jobs. Rollback preserves later edits and retains the IDs of items added by the original import. Those items are made inactive so earlier documents keep their references.

Uploads accept up to 80 MiB and use resumable parts. The workbook preview runs outside the request and flags rejected rows before confirmation. An application restart resumes the active job from committed row results. If an upload expires, start a new preview with the original workbook.

The existing Kitchen design PDF and Furniture RNB ledger are separate quotation workflows. The catalogue is available for both floors under Settings.
