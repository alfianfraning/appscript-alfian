/**
 * FS Overview — ABC Official Store ONLY — auto-refreshing Financial Statement dashboard.
 *
 * FORKED from the Betadine Group fork (base file as of 2026-09-14) per Zoltraak — same reasoning
 * as every other single-brand fork in this family: the main script scans EVERY brand's files on
 * every refresh, and with 500+ files across all brands it was regularly running past its time
 * budget with a large backlog still unread (see TIME_BUDGET_MS below). This fork scopes Pass 1
 * (file discovery) down to ONLY ABC_GROUP_BRANDS' 1 real Official Store — "ABC Official Store"
 * (see refreshData()'s brandFolders loop) — every other brand's files are skipped before any
 * content is ever read. This fork also has NO Consignment tab at all — it's a single-tab
 * (Outright only) dashboard, same as every other fork in this family. It has NO Promo Fund /
 * Category-filter / other-brand-specific lump-sum revenue feature — confirmed by Zoltraak
 * 2026-09-14 that ABC Official Store has none of these; the base fork's Betadine-specific Promo
 * Fund Front/Back Margin feature has been removed entirely (see the "WAREHOUSE FEE HELPERS"
 * section below, where that feature used to live).
 *
 * *** UNRESOLVED AS OF THIS BUILD (2026-09-14) — see the "ABC OFFICIAL STORE — UNRESOLVED" comment
 * block right above WAREHOUSE_CODE_MAP below: ABC Official Store's real warehouse code and billing entity have
 * NOT been confirmed against an actual Data Claim Internal file yet. Until that's done, Pick Pack /
 * Rent Warehouse / Consumables will show $0 for ABC and the refresh's `warnings` output will carry
 * an "unrecognized warehouse code" entry — that's the visible symptom this gap hasn't been closed.
 * Do not treat this dashboard as fully verified until that TODO is resolved and a real refresh has
 * been run with no such warning for ABC. ***
 *
 * Deploy this as its OWN, SEPARATE Apps Script project/web app (own deployment URL) — do NOT
 * paste this into the same project as the main FS Overview script or any other group's fork, and
 * note the cache/access Drive file names below were all renamed (see CACHE_FILE_NAME etc.)
 * specifically so this fork can safely run against the SAME source Drive folders as the main
 * dashboard (and every other group's fork) without any of them clobbering each other's cache or
 * access-list files.
 *
 * Deployment (one-time setup):
 *   1. Go to https://script.google.com, create a new project (or Extensions > Apps Script
 *      from a Sheet — a standalone project is fine, it doesn't need to live in a Sheet).
 *   2. Paste this file in as "Code.gs".
 *   3. Add a second file: File > New > Html, name it exactly "Dashboard" (so it's Dashboard.html),
 *      and paste in the Dashboard.html content provided alongside this file.
 *   4. Run `installDailyTrigger` once from the Apps Script editor (select it in the function
 *      dropdown, click Run). The first run will ask you to authorize Drive + Sheets access —
 *      approve it. This installs a trigger that reruns `refreshData` every day at 6am.
 *   5. Run `refreshData` once manually too, so the cache exists before anyone opens the page.
 *   6. Deploy > New deployment > type "Web app". Execute as "Me", access "Anyone within SIRCLO"
 *      (or whatever your Workspace allows) — this access setting MUST stay restricted to your
 *      Workspace domain (not "Anyone"), otherwise Session.getActiveUser() below can't read a
 *      visitor's email and the access-list check has nothing to check against. Copy the
 *      resulting URL — that's your live dashboard.
 *   7. Only nada.hamida@sirclo.com (SEED_ADMIN_EMAIL below — Owner for this fork, per Nada
 *      2026-09-14; most other forks in this family keep Alfian as Owner, ABC and Mustika Ratu are
 *      the exceptions) can open it at first — that's the hardcoded Owner. Sign in as them, click
 *      the icon in the top-right corner, and invite
 *      anyone else who needs access from there (choosing Admin or User for each person).
 *
 * How it works:
 *   - `refreshData()` scans every brand subfolder under ROOT_FOLDER_ID, finds files named
 *     "YYYYMM Data Claim Internal <Brand Name>", aggregates them by (brand, month) and by
 *     Marketplace, and writes the result as a JSON file back into the same Drive folder
 *     (_fs_overview_cache.json). This is what makes "auto update" actually feasible: computing
 *     this on every page load would be slow (some of these sheets have 10k+ rows), so it's
 *     precomputed on a schedule instead, and the web app just serves the last cached result —
 *     instant load, always reflects the last refresh.
 *   - `doGet()` is the web app entry point: it loads the cached JSON and renders Dashboard.html
 *     with it injected in place of the hardcoded DATA / MP_DATA arrays the static file used.
 *   - Before any of that, `doGet()` checks the visitor's email (Session.getActiveUser()) against
 *     an access list stored as _fs_overview_access.json in the same Drive folder. Not on the
 *     list -> a plain "you don't have access" page instead of the dashboard. Everyone on the
 *     list has one of three roles: "owner" (exactly one, hardcoded, can never be removed —
 *     nada.hamida@sirclo.com), "admin" (can invite/remove people, via the icon top-right of
 *     the dashboard), or "user" (can see who has access, but can't change it). See
 *     ACCESS CONTROL section below.
 */

// ====================== CONFIG ======================

// Bump this any time you publish a NEW deployment of this web app (Code.gs and/or Dashboard.html
// changed) — any format works, a date + counter is easiest to keep unique. This powers the "The
// Dashboard has been updated, please reload this page." banner: Dashboard.html polls
// getDashboardVersion() below every couple minutes and compares it against the version it was
// loaded with, so anyone who already has the page open gets told to reload once a new deployment
// goes out — Apps Script web apps have no server-push mechanism, so without this a stale tab has
// no way to know its own JS/HTML is out of date. Per Zoltraak 2026-08-14. Forgetting to bump this
// just means the notification doesn't fire for that particular deployment — harmless, but the
// point of the feature is lost, so bump it every time.
const DASHBOARD_VERSION = '2026-10-19.abc-7'; // 2026-10-19 (abc-7): 202608+ Platform Fee Absorb total = the Summary tab's "Absorb Sirclo" total (PF tabs alone missed hand-typed lines: 244,900,080 vs 288,805,465), marketplace split from the PF tabs; 2026-10-13 (abc-6): from 202608 the "YYYYMM - Summary MP Fee" file's Absorb comes from its "PF <Marketplace>" tabs (every 'Absorb' column); // 2026-10-13: Platform Fee Absorb by SIRCLO now read from "YYYYMM - Summary MP Fee - ABC Official Store" ('Absorb Sirclo' column) instead of Platform Fee files; // 2026-09-26: Marketplace -> ORAMI (B2B) / NON-ORAMI (B2C) + DC-tab preference

// The "FS Overview" folder: https://drive.google.com/drive/folders/1Byx4jIgraJNv5S374NKOU5ErM70MR2uo
const ROOT_FOLDER_ID = '1Byx4jIgraJNv5S374NKOU5ErM70MR2uo';

// Matches e.g. "202605 Data Claim Internal Cerave Official Store" -> yyyymm="202605", brand="Cerave Official Store"
const FILE_NAME_PATTERN = /^(\d{6})\s+Data Claim Internal\s+(.+)$/i;

// Brands to skip entirely. Empty for now — Garnier Official was excluded earlier over a
// data-quality concern (leftover subtotal rows inflating totals) but that's been confirmed
// clean, so it's back in.
const EXCLUDED_BRANDS = [];

// ====================== PLATFORM FEE ABSORB BY SIRCLO — SOURCE (2026-10-13) ======================
// Per Finance (2026-10-13): the "Platform Fee Absorb by SIRCLO" line is NO LONGER summed from the
// "absorb" columns of the "YYYYMM Platform Fee <Marketplace> <Brand>" files (that path only ever saw
// TikTok/Tokopedia/Shopee/Lazada/Blibli/Zalora files, so it missed Orami entirely and could drift from
// what Finance books). It now comes from the monthly summary workbook
//     "YYYYMM - Summary MP Fee - ABC Official Store"      (e.g. "202601 - Summary MP Fee - ABC Official Store")
// tab 'Summary MP Fee', first table (header row: Marketplace | Invoice | MP Fee | ... | Absorb Sirclo | ...),
// column "Absorb Sirclo", one row per marketplace (Tokopedia, Tiktok, Lazada, Orami, Shopee, Zalora,
// Bukalapak, Akulaku, Blibli) followed by a 'Total' row. The brand/month total = the sum of the
// marketplace rows (= that file's Total row; a mismatch is reported as a warning).
// Check value: 202601 -> 112,607,410 (Tokopedia 10,413,553 + Tiktok 68,829,103 + Lazada 8,851,581
// + Orami 23,275,023 + Blibli 1,238,151).
// Marketplace rows are grouped with marketplaceCategory_ (Orami -> ORAMI (B2B), everything else ->
// NON-ORAMI (B2C)). The file has NO warehouse split, so each month's total is spread over that month's
// warehouse buckets pro-rata to sales (same convention as the Softex rebates addition) — the brand/month
// total and the marketplace split are exact, the warehouse split is an allocation.
// Where a brand/month has NO summary file the old Platform Fee-file figure is kept (a warning lists those).
// Files are looked for in the brand sub-folders under ROOT_FOLDER_ID (like every other source file) AND
// directly in ABSORB_SUMMARY_FOLDER_ID below (where the 2026 summary files currently live).
const ABSORB_SUMMARY_FILE_NAME_PATTERN = /^(\d{6})\s*-\s*Summary MP Fee\s*-\s*(.+)$/i;
const ABSORB_SUMMARY_SHEET_NAME = 'Summary MP Fee';
const ABSORB_SUMMARY_FOLDER_ID = '1OQ1Iq4gh9tJD67_ysxBgyXTJyCMtf4DT';

// From 202608 onward the SAME file name ("YYYYMM - Summary MP Fee - ABC Official Store") no longer has a
// 'Summary MP Fee' tab with an "Absorb Sirclo" column; its Platform Fee detail lives in one tab per marketplace
// ("PF Tiktok", "PF Tokopedia", "PF Lazada", "PF Blibli", "PF Orami"). For those months Platform Fee Absorb by
// SIRCLO = the sum of EVERY money column whose header contains "Absorb" (rate columns "pct_Absorb..." /
// "% Absorb..." are skipped) over the data rows of each PF tab. The header row is located by content (row 1 is
// a totals row above it); a mismatch with that totals row is reported as a warning. The marketplace comes from
// the tab name (PF Orami -> ORAMI (B2B), every other PF tab -> NON-ORAMI (B2C)).
// Check value (202608): PF Tokopedia Absorb = 14,664,515.
// Months before this one keep reading the 'Summary MP Fee' tab as above.
// REVISED 2026-10-19 (abc-7): the PF tabs alone do NOT tie to the Summary tab. 202608: PF tabs = 244,900,080 but the
// Summary tab's "Absorb Sirclo" column totals 288,805,465 (what Finance books). The 43,905,385 gap is typed by hand
// into Summary!H12 (Order Processing fee, 9,589,185) and Summary!H18 (Logistic Service Fee, 34,316,200) — it is not in
// any PF tab (it equals the Support tab's total Surplus, 43,905,385). So from 202608 the brand/month TOTAL is the Summary
// tab's own Absorb Sirclo total ("Total Claim Support + Marketplace Fee" row), and the marketplace split keeps the PF-tab
// figures per marketplace, with any remainder (Summary total - PF tabs) put on NON-ORAMI (B2C) since those two lines are
// TikTok/Tokopedia fee lines. A remainder is reported as a warning so it stays visible. If the file has no Summary tab the
// PF-tab sum is used as before.
const ABSORB_PF_TABS_FROM_MONTH = '2026-08';              // 'YYYY-MM', inclusive
const ABSORB_PF_TAB_NAME_PATTERN = /^PF\s+(.+)$/i;        // tab "PF Tokopedia" -> marketplace "Tokopedia"
const ABSORB_PF_HEADER_SCAN_ROWS = 6;                      // header row is searched within the first rows of each tab

// Name of the cache file this script writes into ROOT_FOLDER_ID.
const CACHE_FILE_NAME = '_fs_overview_abc_cache.json';

// Per-file incremental cache: remembers each source file's last-seen modified time plus the
// numeric contribution it produced, so an unchanged file never has to be re-read on the next
// refresh. Separate from CACHE_FILE_NAME (which holds the final combined DATA/MP_DATA payload).
const FILE_CACHE_NAME = '_fs_overview_abc_file_cache.json';

// Bump this whenever readFileContribution_'s OUTPUT SHAPE changes (a new field added/removed,
// existing field computed differently, etc.) — e.g. this went from 1 to 2 when warehouse (`wh`)
// breakdown was added. Pass 2 below only reuses a cached entry if its modifiedTime AND version
// both match; a version mismatch forces a fresh read even though the file itself hasn't changed.
// Without this, a file whose Drive modifiedTime hasn't changed since BEFORE some contribution-
// shape change shipped would keep reusing its old, now-incomplete cached contribution forever —
// exactly what silently happened to Natasha Skincare/Naavagreen: they hadn't been touched in
// Drive since before `wh` existed, so their cache entries had no warehouse breakdown at all and
// nothing was forcing a re-read to pick it up.
const FILE_CACHE_VERSION = 10; // bumped again 2026-09-26: readFileContribution_'s mp/wh accumulators were
// missing a chipIn: 0 initializer, so every cached file stored chipIn as null per marketplace/warehouse
// (NaN -> null in JSON). Forces one re-read so Chip In reaches the +M/+W breakdowns.
// Bumped to 9 earlier the same day (Zoltraak): readDataClaimSheet_ now PREFERS the tab
// whose name contains "DC" (e.g. "2606 DC ABC Official Store") over any other qualifying tab
// ("coretan commercial", "3. Cancel Transactions", ...) — see DATA_CLAIM_TAB_NAME_PATTERN. A file
// cached under version 8 may have been read from a different tab, so this forces one re-read.
// Previously bumped 2026-08-20: readFileContribution_'s data/mp/wh output gained
// a `promoFundFrontMargin` field (Betadine Group only — see PROMO_FUND_FM_COL_NAME), sourced from
// each Data Claim Internal file's own "PromoFund _FM" column, per Zoltraak's 2026-08-20 fix (Front
// Margin was previously — wrongly — derived from the separate Promo Fund Betadine spreadsheet
// instead). Any already-cached Betadine file was read before this field existed, so this forces
// every Data Claim Internal file (all brands, not just Betadine — this version check isn't
// brand-scoped, same as the bump below) to be re-read once.
// Previously bumped 2026-08-18: Unilever Group brands (UNILEVER_GROUP_BRANDS)
// now read the "Claim_10pct_RBP" column instead of "Claim" for `claim` (Rebates Revenue) — per
// Zoltraak 2026-08-18. Any already-cached Unilever Group file was read under the OLD column choice,
// so this forces every Data Claim Internal file (all brands, not just Unilever Group — this version
// check isn't brand-scoped) to be re-read once to guarantee no stale "Claim"-sourced figure lingers.
// Previously bumped 2026-08-17: readFileContribution_'s per-warehouse output
// gained a per-marketplace RBP breakdown (wh[warehouse].mpRbp, alongside the existing mpUniq),
// used by Dashboard.html to allocate MOGTM Distributor Fee across marketplaces — same exact-
// allocation approach as mpUniq already does for Operational & Fulfillment Cost.
// Also bumped 2026-08-16: readFileContribution_'s per-marketplace output gained a 'surplus' field
// (previously only tracked per-warehouse), and its per-warehouse output gained a nested per-
// marketplace order-count breakdown (wh[warehouse].mp), used to allocate Operational & Fulfillment
// Cost across marketplaces in refreshData's Pass 4.

// Who's allowed to open this dashboard at all, and who among them can manage that list. Stored
// as a JSON file in the same Drive folder (see ACCESS_FILE_NAME) — that file is the single
// source of truth for everyone EXCEPT the Owner below, who is hardcoded here on purpose:
// permanently role "owner", can never be removed through the app (see removeUser), and every
// load self-heals the stored list if this ever doesn't match (see ensureOwnerPresent_). There is
// exactly one Owner; Admins/Users are otherwise managed entirely through the access file.
const ACCESS_FILE_NAME = '_fs_overview_abc_access.json';
const SEED_ADMIN_EMAIL = 'nada.hamida@sirclo.com'; // Owner for this fork, per Nada 2026-09-14 — most other forks in this family keep alfian.franing@sirclo.com as Owner; ABC and Mustika Ratu are the exceptions.

// Column names this script looks for in each "Data Claim Internal" sheet (matched by header
// text, not position, so it's resilient to columns being reordered/added).
const COL = {
  customerRef: 'Customer_Reference',
  marketplace: 'Marketplace',
  qty: 'Qty_Order',
  salesAfterSubsidy: 'Price_Total_After_Subsidy',
  claim: 'Claim',
  rbpTotal: 'RBP_VAT_Total',
};

// ====================== MARKETPLACE CATEGORY (ORAMI / NON-ORAMI) ======================
// Added 2026-09-26 per Zoltraak: this fork no longer breaks sales down by individual marketplace.
// Every row is categorized into exactly TWO buckets:
//   - ORAMI_MARKETPLACE_LABEL     — rows whose "Marketplace" value is ORAMI (the B2B channel;
//                                   source data spells it "ORAMI", matched case-insensitively
//                                   as a substring so e.g. "Orami" / "ORAMI B2B" also land here)
//   - NON_ORAMI_MARKETPLACE_LABEL — EVERYTHING else (TikTok, Tokopedia, Lazada, Blibli, Shopee,
//                                   Zalora, ... — the B2C channels), INCLUDING a blank Marketplace
//                                   cell, so ORAMI + NON-ORAMI always sums to the row total.
// Applied in refreshData's Pass 3 (sales/order/claim/rbp buckets + the per-warehouse mpUniq/mpRbp
// cross-tabs) and Pass 3b (Platform Fee files, whose marketplace comes from the FILE NAME — no
// Platform Fee file pattern exists for Orami, so every fee lands in NON-ORAMI). readFileContribution_
// itself still emits the RAW marketplace names — categorizing at recombine time means the per-file
// cache never needs a rebuild just to change this grouping. Orders can't double count when merged:
// one Customer_Reference only ever carries one marketplace (verified against 202604-202608 data).
// Dashboard.html mirrors these two labels (marketplaceRank_) to pin ORAMI (B2B) as the first column
// everywhere, including the Export to Sheets output.
const ORAMI_MARKETPLACE_LABEL = 'ORAMI (B2B)';
const NON_ORAMI_MARKETPLACE_LABEL = 'NON-ORAMI (B2C)';

/** Maps a raw marketplace name (from a Data Claim row or a Platform Fee file name) to its category. */
function marketplaceCategory_(rawMarketplace) {
  return /orami/i.test(String(rawMarketplace || '')) ? ORAMI_MARKETPLACE_LABEL : NON_ORAMI_MARKETPLACE_LABEL;
}

/** Sort order for marketplace buckets: ORAMI (B2B) first, NON-ORAMI (B2C) second, then by sales. */
function compareMarketplaceBuckets_(a, b) {
  const rank = name => name === ORAMI_MARKETPLACE_LABEL ? 0 : name === NON_ORAMI_MARKETPLACE_LABEL ? 1 : 2;
  return (rank(a.marketplace) - rank(b.marketplace)) || ((b.sales || 0) - (a.sales || 0));
}

// Warehouse is read the same way as the COL columns above, but kept OUT of that object on
// purpose: COL's keys are required — a file missing any of them gets skipped entirely (see
// readFileContribution_). Warehouse is treated as optional instead, so a file that happens not
// to have it still contributes to totals as before; it just won't have a warehouse breakdown.
const WAREHOUSE_COL_NAME = 'Warehouse';

// Customer_Reference — read from Platform Fee files ONLY for the Consignment tab (added
// 2026-08-18, see readPlatformFeeContribution_'s custRefIdx). Same column-name convention as
// COL.customerRef above (both are literally 'Customer_Reference' in the source files); kept as its
// own constant here rather than reusing COL.customerRef so the Platform Fee reader — shared by both
// tabs — doesn't need to reach into the Data-Claim-specific COL map for an unrelated file type.
// Optional, same treatment as
// WAREHOUSE_COL_NAME: a file missing it just contributes 0 orders (Consignment's Number of Order)
// instead of failing — Outright ignores this field entirely (its Number of Order still comes from
// Data Claim Internal files via readFileContribution_, unchanged).
const CUSTOMER_REFERENCE_COL_NAME = 'Customer_Reference';

// "Surplus" — new dashboard row per Zoltraak 2026-08-13, shown right after Average Basket Size,
// sourced from the Data Claim Internal files' own "Surplus" column. Restricted to ONLY the 4
// Sanghiang Perkasa Group Official Stores below — every other brand always shows $0 for this line,
// regardless of whether its own file happens to have a same-named column. readFileContribution_
// only looks this column up at all when t.brand is in this list (see surplusIdx), same pattern as
// PLATFORM_FEE_OPTIONAL_KEYS: a file missing it (or not looked up for it at all) just contributes
// 0, nothing gets skipped over it.
const SANGHIANG_PERKASA_GROUP_BRANDS = [
  'Morinaga Official Shop',
  'Prenagen World Official Store',
  'Entrasol Official Store',
  'Milna Official Store',
];
const SURPLUS_COL_NAME = 'Surplus';

// "Chip In" — kolom di Data Claim Internal ABC Official Store, per Zoltraak 2026-09-16. Dibaca
// dan dijumlah langsung per baris order, sama seperti Surplus — TIDAK memengaruhi Gross Profit
// (lihat catatan di instruksi terpisah) sampai dikonfirmasi sebaliknya.
const CHIP_IN_COL_NAME = 'Chip In';

// Unilever Group's 7 real Official Stores, per Zoltraak 2026-08-18 — used by TWO independent
// features that both key off this exact same brand list:
//   1. Rebates Revenue (`claim`, the "Claim" dashboard row) reads the "Claim_10pct_RBP" column
//      instead of "Claim" for these brands only (see claimColName_ below) — e.g. "202606 Data
//      Claim Internal Vaseline" -> Claim_10pct_RBP = 1,691,855,609 for Rebates Revenue, NOT
//      whatever "Claim" itself holds. Every other brand keeps reading "Claim" as before.
//   2. Other Revenue (see loadUnileverClaimRevenue_ below) — same treatment LOreal Group already
//      gets via loadOtherRevenue_, just from a different external spreadsheet with a per-brand-tab
//      layout instead of LOreal's single-tab-per-Official-Store-row layout.
// "Unilever Food Solution" (a Drive folder that also exists) is deliberately NOT in this list —
// Zoltraak's 2026-08-18 spec named exactly these 7 Official Stores, not Food Solution.
const UNILEVER_GROUP_BRANDS = [
  'Vaseline',
  'Daily Personal Care by Unilever',
  'Rumah Bersih Unilever',
  'Unilever Professional Official Store',
  'Unilever Nutritions',
  'Unilever Hair Beauty Studio',
  'Zwitsal',
];
// See UNILEVER_GROUP_BRANDS' comment #1 above.
const UNILEVER_CLAIM_10PCT_RBP_COL_NAME = 'Claim_10pct_RBP';

// ABC Official Store's real store list — confirmed 2026-09-14, exactly 1 real Official Store.
// Used to scope Pass 1 file discovery AND Approval scope (APPROVAL_STORES_ below) — this fork's
// equivalent of PROMO_FUND_BETADINE_BRANDS in the base file, but WITHOUT that constant's extra
// (and confusing) third job of also gating the Betadine-only Promo Fund feature, since ABC has no
// such feature. No VIRTUAL_STORE_GROUPS entry for ABC either (Dashboard.html) — per Zoltraak
// 2026-09-14, since the brand name requested is identical to this one store's own name, an
// invented group label would be more confusing than useful with only 1 store to combine.
const ABC_GROUP_BRANDS = ['ABC Official Store'];

// Matches e.g. "202607 Platform Fee TikTok 3CE Indonesia" -> yyyymm="202607",
// marketplace="TikTok", brand="3CE Indonesia". TikTok, Tokopedia, Shopee, Lazada, Blibli and
// Zalora are recognized — Shopee added 2026-08-14 (see SHOPEE_FEE_COL/readPlatformFeeContribution_'s
// isShopee branch, which reads a completely different column schema for it); Lazada/Blibli/Zalora
// added 2026-08-18 (see LAZADA_FEE_COL/BLIBLI_FEE_COL/ZALORA_FEE_COL, same idea — each marketplace
// gets its own column schema since none of the export templates match each other exactly). A file
// with an "Ext" or other token between "Platform Fee" and the marketplace name (a draft/staging
// variant seen in some personal folders, not the canonical brand folders) deliberately does NOT
// match this pattern, since the marketplace name must come directly after "Platform Fee ".
const PLATFORM_FEE_FILE_NAME_PATTERN = /^(\d{6})\s+Platform Fee\s+(TikTok|Tokopedia|Shopee|Lazada|Blibli|Zalora)\s+(.+)$/i;

// Column names this script looks for in each "Platform Fee" sheet (matched by header text, same
// resilient-to-reordering approach as COL above). Keys double as the dashboard's field names for
// these figures (both at brand/month level and per warehouse bucket). Most of these are required —
// a file missing any of them is skipped entirely (see readPlatformFeeContribution_) — EXCEPT the
// ones listed in PLATFORM_FEE_OPTIONAL_KEYS below, and Warehouse (WAREHOUSE_COL_NAME), which is
// optional the same way it is for Data Claim files: a file missing it still contributes to
// brand/month totals, it just won't have a per-warehouse breakdown.
const PLATFORM_FEE_COL = {
  marketplaceFee: 'Total Marketplace Fee',
  otherMarketplaceFee: 'Total Other Marketplace Fee',
  platformCommissionFee: 'platform_commission_fee',
  orderProcessingFee: 'order_processing_fee',
  mallServiceFee: 'mall_service_fee',
  dynamicCommission: 'dynamic_commission',
  bonusCashbackServiceFee: 'bonus_cashback_service_fee',
  preOrderServiceFee: 'pre_order_service_fee',
  voucherXtraServiceFee: 'voucher_xtra_service_fee',
  shippingCost: 'shipping_cost',
  exclusiveBenefitsAccessFee: 'exclusive_benefits_access_fee',
  // "Sales of Goods (Disbursed)" — new dashboard line added 2026-08-18 per Zoltraak, shown right
  // below "Platform Fee:" for every marketplace. Source is the file's own "CBP" column, summed the
  // same generic way as every other PLATFORM_FEE_COL figure. Optional (see PLATFORM_FEE_OPTIONAL_KEYS
  // below) because not every TikTok/Tokopedia export template is confirmed to include a CBP column
  // — a file missing it just contributes 0 for this one figure (with a warning) instead of being
  // skipped entirely, same treatment as exclusiveBenefitsAccessFee.
  salesOfGoodsDisbursed: 'CBP',
};
const PLATFORM_FEE_KEYS = Object.keys(PLATFORM_FEE_COL);

// PLATFORM_FEE_KEYS entries that are NOT required to be present in a Platform Fee file's header —
// a file missing one of these still gets read normally, the missing figure just contributes 0
// (with a warning, so it's visible rather than silent). Added 2026-08-13 after investigating the
// leftover "none of its N tab(s) have the expected columns" warnings following the header-
// normalization fix: "202605 Platform Fee TikTok/Tokopedia Mustika Ratu" turned out to have every
// required column EXCEPT exclusive_benefits_access_fee, which that particular May 2026 export
// template simply doesn't include at all (not a naming mismatch — genuinely absent). Treating it
// as required meant those two otherwise-perfectly-good files were being skipped entirely over one
// missing metric.
const PLATFORM_FEE_OPTIONAL_KEYS = ['exclusiveBenefitsAccessFee', 'salesOfGoodsDisbursed'];

// Shopee's Platform Fee exports use a COMPLETELY different column schema from TikTok/Tokopedia —
// there is no platform_commission_fee / order_processing_fee / mall_service_fee / dynamic_commission
// / bonus_cashback_service_fee / pre_order_service_fee / voucher_xtra_service_fee /
// exclusive_benefits_access_fee. Instead every fee line is its own column, plus a "Total Vouchers"
// figure derived from 3 voucher columns (see SHOPEE_VOUCHER_COLS). Keys below double as the
// dashboard field names, and where a Shopee column is the same LINE as a TikTok/Tokopedia field it
// deliberately reuses that field's key: orderProcessingFee reads Shopee's "biaya proses pesanan"
// (= Order Processing Fee, same dashboard line) and shippingCost reads Shopee's "Shipping Cost"
// (= Shipping Cost, same dashboard line). marketplaceFee/otherMarketplaceFee read the same-named
// "Total Marketplace Fee"/"Total Other Marketplace Fee" columns.
// Added 2026-08-14 per Zoltraak.
const SHOPEE_FEE_COL = {
  marketplaceFee: 'Total Marketplace Fee',
  otherMarketplaceFee: 'Total Other Marketplace Fee',
  orderProcessingFee: 'biaya proses pesanan',
  shippingCost: 'Shipping Cost',
  biayaAdministrasi: 'biaya administrasi termasuk ppn 11persen',
  biayaLayanan: 'biaya layanan',
  premi: 'premi',
  biayaProgramHemat: 'biaya program hemat biaya kirim',
  biayaTransaksi: 'biaya transaksi',
  biayaKampanye: 'biaya kampanye',
  beaMasukPpnPph: 'bea masuk ppn dan pph',
  promoGratisOngkirPenjual: 'promo gratis ongkir dari penjual',
  cashbackKoinCofund: 'cashback koin cofund disponsori penjual',
  biayaLainnya: 'biaya lainnya',
  fbsFee: 'fbs fee',
  // "Sales of Goods (Disbursed)" — see PLATFORM_FEE_COL.salesOfGoodsDisbursed's comment; same
  // "CBP" column, same optional treatment, added here 2026-08-18 so it applies to Shopee too.
  salesOfGoodsDisbursed: 'CBP',
};
const SHOPEE_FEE_KEYS = Object.keys(SHOPEE_FEE_COL);

// Shopee Platform Fee columns that are NOT required to be present — a file missing one still gets
// read normally, the missing figure just contributes 0 (with a warning). Mirrors
// PLATFORM_FEE_OPTIONAL_KEYS' behavior for TikTok/Tokopedia. The REQUIRED Shopee columns are the
// core ones (Total Marketplace Fee, Total Other Marketplace Fee, biaya proses pesanan, Shipping
// Cost) plus SHOPEE_VOUCHER_COLS below (needed to derive Total Vouchers).
const SHOPEE_FEE_OPTIONAL_KEYS = [
  'biayaAdministrasi', 'biayaLayanan', 'premi', 'biayaProgramHemat', 'biayaTransaksi',
  'biayaKampanye', 'beaMasukPpnPph', 'promoGratisOngkirPenjual', 'cashbackKoinCofund',
  'biayaLainnya', 'fbsFee', 'salesOfGoodsDisbursed',
];

// The 3 Shopee voucher columns whose SUM = the dashboard's "Total Vouchers before Marketplace Fee"
// line (per Zoltraak 2026-08-14). readPlatformFeeContribution_'s Shopee branch sums these per row
// into totals.totalVouchers / wh[warehouse].totalVouchers.
//
// BUG FIX 2026-08-20: the 3rd entry below was 'voucher co-fund disponsor oleh penjual' (hyphenated
// "co-fund"), which was silently breaking every Betadine Shopee Platform Fee file ("202601"-"202606
// Platform Fee Shopee Betadine Official Store" all skipped with "none of its 1 tab(s) have the
// expected columns"). Root cause, confirmed against the real files' actual header row (fetched live
// via Drive): the real column is literally "voucher_cofund_disponsor_oleh_penjual" — "cofund" as ONE
// word, no hyphen. normalizeHeaderName_ turns a hyphen into a space (same as an underscore), so the
// old candidate normalized to "voucher co fund disponsor oleh penjual" (6 tokens, "co"/"fund" split)
// while the real header normalizes to "voucher cofund disponsor oleh penjual" (5 tokens, "cofund" as
// one token) — these never match, not even via resolveHeaderIdx_'s starts-with/contains fallback,
// since that fallback only tolerates extra surrounding text, not a different word-split of the
// candidate itself. Every required column is checked this way (findAndReadSheet_), so this single
// unresolvable column was enough to make the whole file look like it had "none of its tabs" contain
// the expected columns, even though every OTHER required column matched fine. Corrected to match the
// real file's spelling exactly.
const SHOPEE_VOUCHER_COLS = [
  'cashback koin disponsori penjual',
  'voucher disponsor oleh penjual',
  'voucher cofund disponsor oleh penjual',
];

// Lazada/Blibli/Zalora Platform Fee column schemas — added 2026-08-18 per Zoltraak, same idea as
// SHOPEE_FEE_COL: each marketplace's export template is its own fixed set of column names, so each
// gets its own COL map rather than trying to force them into PLATFORM_FEE_COL's TikTok/Tokopedia
// schema. Unlike Shopee, none of these three need special multi-column-sum logic for Total
// Vouchers — each has exactly ONE source column for it, so `totalVouchers` is just a normal key
// here (readPlatformFeeContribution_'s isShopee-specific voucher-summing loop is NOT used for
// these three). Where a column is the SAME LINE as an existing dashboard row, it deliberately
// reuses that field's key instead of adding a duplicate row — orderProcessingFee (Lazada's
// "Order_Processing_Fee" = the same "Order Processing Fee" line TikTok/Tokopedia/Shopee already
// feed) and commission (shared between Lazada's "Commission" and Zalora's "commission" — both are
// the marketplace's own commission cut, so they're shown as one "Commission" line rather than two
// near-duplicate ones; if Zalora's commission turns out to be a materially different figure from
// Lazada's, split this back into two keys). Every key here except marketplaceFee/otherMarketplaceFee
// is OPTIONAL (see *_OPTIONAL_KEYS below) — these are brand-new marketplaces without a confirmed-
// universal template yet, so a file missing one of its own breakdown columns should still be read
// (contributing 0 for just that figure, with a warning) rather than skipped entirely.
const LAZADA_FEE_COL = {
  marketplaceFee: 'Total_Marketplace_Fee',
  otherMarketplaceFee: 'Total_Other_Marketplace_Fee',
  totalVouchers: 'Total_Voucher',
  orderProcessingFee: 'Order_Processing_Fee',
  paymentFee: 'Payment_Fee',
  commission: 'Commission',
  buyerReviewIncentive: 'Buyer_Review_Incentive',
  campaignFee: 'Campaign_Fee',
  freeShippingMaxFee: 'Free_Shipping_Max_Fee',
  lazCoinsDiscount: 'LazCoins_Discount',
  lazCoinsDiscountPromotionFee: 'LazCoins_Discount_Promotion_Fee',
  lazadaFundedCommissionFromSellerVirtualCredit: 'Lazada_Funded_Commission_from_Seller_Virtual_Credit',
  promotionalChargesFlexiCombo: 'Promotional_Charges_Flexi_Combo',
  shippingFeeSubsidyBySeller: 'Shipping_Fee_Subsidy_By_Seller',
  adjustmentsItemCharge: 'Adjustments_Item_Charge',
  customerReturnDeliveryFee: 'Customer_Return_Delivery_Fee',
  lazFlashExtraEverydayBelow999Subsidy: 'LazFlash_Extra_Everyday_Below_9_99_Subsidy',
  marketingServiceReimbursementMarketingFee: 'Marketing_Service_Reimbursement_Marketing_Fee',
  priceCutDiscount: 'Price_Cut_Discount',
  product360Boost: 'Product_360_Boost',
  sellerBalanceAdjustmentsCredit: 'Seller_balance_adjustments_Credit',
  spaProgramFee: 'SPA_program_Fee',
  sponsoredProductFee: 'Sponsored_Product_Fee',
  strategicSellerProgramParticipationFee: 'Strategic_Seller_Program_Participation_Fee',
  wrongShippingFeeAdjustment: 'Wrong_Shipping_Fee_Adjustment',
  wrongStatusClaims: 'Wrong_Status_Claims',
  lostClaim: 'Lost_Claim',
  salesOfGoodsDisbursed: 'CBP',
};
const LAZADA_FEE_KEYS = Object.keys(LAZADA_FEE_COL);
const LAZADA_FEE_OPTIONAL_KEYS = LAZADA_FEE_KEYS.filter(k => k !== 'marketplaceFee' && k !== 'otherMarketplaceFee');

const BLIBLI_FEE_COL = {
  marketplaceFee: 'Total Marketplace Fee',
  otherMarketplaceFee: 'Other MP Fee',
  totalVouchers: 'Voucher',
  regularMargin: 'Regular_Margin',
  specialMargin: 'Special_Margin',
  addOnMargin: 'Add_On_Margin',
  salesOfGoodsDisbursed: 'CBP',
};
const BLIBLI_FEE_KEYS = Object.keys(BLIBLI_FEE_COL);
const BLIBLI_FEE_OPTIONAL_KEYS = BLIBLI_FEE_KEYS.filter(k => k !== 'marketplaceFee' && k !== 'otherMarketplaceFee');

const ZALORA_FEE_COL = {
  marketplaceFee: 'Total Marketplace Fee',
  // Fixed 2026-08-18 per Zoltraak: was 'Other MP Fee', which doesn't exist in any real Zalora
  // Platform Fee export — the actual header is 'Total Other Marketplace Fee'. This single wrong
  // name made findAndReadSheet_ reject every Zalora file's only real tab (its required-columns
  // scan never found a header row containing this column), so ALL 7 months of "Platform Fee
  // Zalora Rip Curl" were skipped with "none of its 2 tab(s) have the expected columns" —
  // confirmed by reading the live file's actual header row directly.
  otherMarketplaceFee: 'Total Other Marketplace Fee',
  totalVouchers: 'discount fee',
  adminFee: 'admin fee',
  commission: 'commission',
  paymentGatewayFee: 'payment gateway fee',
  dropshippingItemDeliveryFee: 'dropshipping item delivery fee',
  cancellationFeeOutOfStock: 'cancellation fee out of stock',
  cancellationFeeFailedPickup: 'cancellation fee failed pickup',
  cancellationFeeDelay: 'cancellation fee delay',
  defectivePenalty: 'defective penalty',
  cashbackFees: 'cashback fees',
  salesOfGoodsDisbursed: 'CBP',
};
const ZALORA_FEE_KEYS = Object.keys(ZALORA_FEE_COL);
const ZALORA_FEE_OPTIONAL_KEYS = ZALORA_FEE_KEYS.filter(k => k !== 'marketplaceFee' && k !== 'otherMarketplaceFee');

// "Platform Fee Absorb by SIRCLO" — shown on the dashboard as its own line inside Operational &
// Fulfillment Cost, right above Pick Pack. Broadened 2026-08-13 per Zoltraak: rather than looking
// up one fixed column name per brand off an allowlist (the old approach — removed), EVERY header
// in a Platform Fee file whose text contains "absorb" is summed together, for every brand, with no
// allowlist at all — see readPlatformFeeContribution_'s absorbColIdxs. A brand whose file has no
// such column simply contributes 0, exactly as before. This also fixes an undercount for brands
// like ABC Official Store / Unilever Food Solution, whose exports actually split this figure
// across SEVERAL differently-named columns (Absorb_by_SIRCLO_platform_commission_fee, plus
// separate _order_processing_fee / _mall_service_fee / _dynamic_commission / _shipping_cost
// columns) — the old single-column lookup only ever read the first of those, silently dropping
// the rest. Kept OUT of PLATFORM_FEE_COL/PLATFORM_FEE_KEYS on purpose, same as before: those
// assume one fixed, REQUIRED column name shared by every brand (see readPlatformFeeContribution_'s
// requiredCols) — making this field required would cause every brand's Platform Fee file OTHER
// than the ones that actually have it to fail with "missing columns" and get skipped entirely.

// Every place a brand/month's or warehouse bucket's Platform Fee totals get defaulted to 0 or
// summed generically (refreshData Pass 3/3b, DATA row output) loops PLATFORM_FEE_KEYS — this adds
// 'absorbBySirclo' to that same generic handling WITHOUT adding it to PLATFORM_FEE_KEYS itself
// (which doubles as the REQUIRED-columns list and the fixed key->column-name lookup used while
// actually reading a row — see readPlatformFeeContribution_, which sets totals.absorbBySirclo /
// wh[...].absorbBySirclo directly via absorbColIdxs instead).
const ALL_PLATFORM_FEE_KEYS = PLATFORM_FEE_KEYS.concat([
  'absorbBySirclo',
  // Shopee-only keys, added 2026-08-14 — same generic default-to-0 / sum-across-rows / output
  // treatment as every other platform fee field, so a brand/month whose Shopee file has none of
  // them still carries 0 and every aggregating loop (Pass 3/3b, DATA output, virtual groups,
  // period aggregates, grand totals) handles them uniformly. totalVouchers is filled by the
  // Shopee branch of readPlatformFeeContribution_; totalPlatformFee is derived client-side in
  // deriveMetrics as totalVouchers + marketplaceFee + otherMarketplaceFee (see the HTML).
  'totalVouchers', 'totalPlatformFee', 'biayaAdministrasi', 'biayaLayanan', 'premi',
  'biayaProgramHemat', 'biayaTransaksi', 'biayaKampanye', 'beaMasukPpnPph',
  'promoGratisOngkirPenjual', 'cashbackKoinCofund', 'biayaLainnya', 'fbsFee',
  // Lazada/Blibli/Zalora-only keys, added 2026-08-18 — same generic treatment as the Shopee-only
  // keys above (see LAZADA_FEE_COL/BLIBLI_FEE_COL/ZALORA_FEE_COL for which marketplace sources
  // each one). salesOfGoodsDisbursed is NOT listed here — it's already inside PLATFORM_FEE_KEYS
  // (added directly to PLATFORM_FEE_COL) since every marketplace, old and new, shares that one key.
  'paymentFee', 'commission',
  'buyerReviewIncentive', 'campaignFee', 'freeShippingMaxFee', 'lazCoinsDiscount',
  'lazCoinsDiscountPromotionFee', 'lazadaFundedCommissionFromSellerVirtualCredit',
  'promotionalChargesFlexiCombo', 'shippingFeeSubsidyBySeller', 'adjustmentsItemCharge',
  'customerReturnDeliveryFee', 'lazFlashExtraEverydayBelow999Subsidy',
  'marketingServiceReimbursementMarketingFee', 'priceCutDiscount', 'product360Boost',
  'sellerBalanceAdjustmentsCredit', 'spaProgramFee', 'sponsoredProductFee',
  'strategicSellerProgramParticipationFee', 'wrongShippingFeeAdjustment', 'wrongStatusClaims',
  'lostClaim',
  'regularMargin', 'specialMargin', 'addOnMargin',
  'adminFee', 'paymentGatewayFee',
  'dropshippingItemDeliveryFee', 'cancellationFeeOutOfStock', 'cancellationFeeFailedPickup',
  'cancellationFeeDelay', 'defectivePenalty', 'cashbackFees',
]);

// Separate incremental per-file cache for Platform Fee files, mirroring FILE_CACHE_NAME's
// purpose but kept as its own Drive file/version counter — these files are read by a completely
// different function (readPlatformFeeContribution_) producing a differently-shaped contribution
// (totals + per-warehouse totals for the fee keys, vs custRefCount/qty/sales/claim/rbp), so
// coupling them to the same cache/version would make each type's changes risk affecting the
// other's cache validity for no reason.
const PLATFORM_FEE_FILE_CACHE_NAME = '_fs_overview_abc_platformfee_file_cache.json';
const PLATFORM_FEE_FILE_CACHE_VERSION = 6; // bumped 2026-08-20 (Zoltraak, "tolong jangan di 0 kan"): Shopee's Shipping Cost is no longer forced to 0 — readPlatformFeeContribution_'s isShopee override was removed, so Shopee's real "Shipping Cost" column value now flows through — forces every cached Shopee file to be re-read so the old forced-0 figure cached under version 5 doesn't linger until that file's modifiedTime happens to change. Also picks up the same-day resolveHeaderIdx_ word-containment fallback fix (voucher co-fund/cofund column) for any Shopee file still cached as unreadable under version 5. Previously bumped 2026-08-18 (Zoltraak): Shopee's Shipping Cost was forced to 0 — forces every cached Shopee file to be re-read so a real value cached under version 4 doesn't linger until that file's modifiedTime happens to change. Previously bumped 2026-08-18 (same day, earlier bump): Lazada/Blibli/Zalora Platform Fee support (LAZADA_FEE_COL/BLIBLI_FEE_COL/ZALORA_FEE_COL schemas) + new salesOfGoodsDisbursed (CBP) field added to every marketplace's schema, including TikTok/Tokopedia/Shopee. Previously bumped 2026-08-14: Shopee Platform Fee support (SHOPEE_FEE_COL schema + totalVouchers), and 2026-08-13: absorbBySirclo now sums every "absorb"-containing column

/**
 * Folds filename brand variants into one canonical brand name before grouping — e.g. when a
 * month's export is too big and gets split into "<Brand> Part I" / "<Brand> Part II" (occasionally
 * "Part III" etc.) files, all parts should aggregate together as one brand, not show up as
 * separate brands. This is a general trailing "Part <roman-or-arabic-numeral>" strip, so it
 * applies to any brand this happens to (Garnier Official, Maybelline Official, Vaseline, Sweety
 * Indonesia, LOreal Paris, etc.) without needing a new hardcoded pattern each time.
 */

function normalizeBrand_(brand) {
  return String(brand).replace(/\s+Part\s+(?:[IVXLCDM]+|\d+)\s*$/i, '').trim();
}

/**
 * Normalizes a header cell's text into a comparison key that treats "Total Marketplace Fee",
 * "Total_Marketplace_Fee", and "total marketplace fee" as the same column. Different Platform Fee
 * export templates have been seen using all of these for the exact same field — e.g. investigating
 * the 24 "none of its N tab(s) have the expected columns" warnings from the 2026-08-13 refresh
 * found several brands (Mustika Ratu, Milna, Entrasol, Morinaga, Nivea, and others) export
 * "Total_Marketplace_Fee"/"Total_Other_Marketplace_Fee" with underscores, where PLATFORM_FEE_COL
 * was written against the older/more common "Total Marketplace Fee"/"Total Other Marketplace Fee"
 * template (spaces) — every OTHER required column in those same files (platform_commission_fee,
 * order_processing_fee, Warehouse, etc.) already matched fine, it was specifically these two. A
 * separate casing mismatch was also found the same way: Vaseline's actual column is "Absorb by
 * SIRCLO", not "Absorb by Sirclo" — silently worth $0 for every brand until this normalization
 * was added (now moot for Absorb by SIRCLO specifically, since 2026-08-13's broadened "any
 * header containing 'absorb'" matching makes exact-name casing irrelevant for it — but this
 * normalization still matters for every other column looked up by exact name).
 *
 * Every place a header name is used as a lookup key (building an `idx` map from a sheet's header
 * row) or compared against a candidate header row (`requiredCols`/`preferredCol` in
 * findAndReadSheet_) runs it through this first, so a mismatch in whitespace, underscores, or
 * letter case alone never causes a column — or, worse, a whole file — to be treated as missing.
 *
 * Broadened 2026-08-18 per Zoltraak ("becareful and add guardtrail to capture any punctuation,
 * capital lower case, double space, white space, symbol") when adding Lazada/Blibli/Zalora: now
 * collapses ANY run of non-alphanumeric characters (underscores, hyphens, periods, parentheses,
 * slashes, colons, double/extra whitespace, etc.) into a single space, not just underscores and
 * whitespace — so "Payment_Fee", "Payment-Fee", "Payment  Fee", and "Payment Fee!" all normalize
 * to the same "payment fee" key. The one deliberate exception is "%": it's left in place rather
 * than stripped, because absorbColIdxs (below) relies on being able to tell a rate/percentage
 * column ("% Absorb by SIRCLO") apart from a money one ("Absorb by SIRCLO") by checking for a "%"
 * in the normalized text — stripping it here would make that distinction impossible.
 */
function normalizeHeaderName_(s) {
  return String(s).trim().toLowerCase().replace(/[^a-z0-9%]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Resolves a candidate column name to its index in `idx` (a map of normalizeHeaderName_'d header
 * text -> column index), tolerant not just of punctuation/case/whitespace (normalizeHeaderName_
 * handles that) but also of a header carrying extra text around the candidate — e.g. a template
 * that exports "Commission (IDR)" or "Total Commission" for what this script otherwise expects to
 * find as plain "Commission". Added 2026-08-18 per Zoltraak's guardrail request ("you can use
 * 'contain' or 'start with' to ensure capture the numbers correctly"), used for the newly-added
 * Lazada/Blibli/Zalora column lookups (see readPlatformFeeContribution_) — existing TikTok/
 * Tokopedia/Shopee columns keep using a plain `idx[normalizeHeaderName_(...)]` lookup, unchanged,
 * to avoid perturbing already-working matching for brands that have been reading correctly.
 *
 * Tries, in order: (1) an exact normalized match, (2) a header that STARTS WITH the normalized
 * candidate, (3) a header that CONTAINS the normalized candidate, (4) a header that contains EVERY
 * significant word of the candidate as a substring, in any order (added 2026-08-20 per Zoltraak,
 * after the Shopee "voucher co-fund ..." bug — see below). If more than one header would qualify at
 * a given step, that step is treated as no match at all — this guards against silently picking the
 * wrong one of two similarly-named columns — and the next, stricter-to-looser step is tried on the
 * ORIGINAL idx keys, not the ambiguous subset. Returns undefined (same as a plain failed idx[...]
 * lookup) if nothing unambiguous is found at any step, so every existing "missing column" warning
 * path downstream keeps working unchanged. Used everywhere readPlatformFeeContribution_ resolves a
 * column name (TikTok/Tokopedia/Shopee/Lazada/Blibli/Zalora alike) — since step 1 is an exact
 * normalized match, this is a pure superset of the old plain `idx[normalizeHeaderName_(...)]` lookup
 * and changes nothing for a header that already matched exactly.
 *
 * Step 4 (word-containment fallback), why it exists: steps 2/3 only tolerate a header carrying
 * EXTRA text around the candidate — they still require the candidate's own normalized text to
 * appear verbatim as a contiguous substring. That's not enough when the header's word-SPLIT differs
 * from the candidate's — e.g. Betadine's real Shopee export has "voucher_cofund_disponsor_oleh_
 * penjual" (fused "cofund", one word), but the code's candidate was "voucher co-fund disponsor oleh
 * penjual" ("co"/"fund" split by the hyphen) — normalizeHeaderName_ turns both hyphens and
 * underscores into spaces, so the candidate normalizes to "...co fund..." (extra space) which never
 * appears as a substring of "...cofund..." (no space), and every file was skipped as a result. Step
 * 4 fixes this class of bug generically: it splits the candidate into words and requires each one to
 * appear SOMEWHERE in the header (substring, so "cofund" still satisfies both "co" and "fund"),
 * rather than requiring the exact original spacing/word-count to line up.
 *
 * This is deliberately looser, so it EXCLUDES any header that is itself a percentage/rate variant
 * of a money column — one containing a literal '%', or the standalone word "pct" (e.g. Shopee's
 * "pct_biaya_administrasi_termasuk_ppn_11persen" alongside the real money column "biaya_
 * administrasi_termasuk_ppn_11persen") — since a money-value candidate must never resolve to its
 * own percentage counterpart. Combined with the existing single-match-only ambiguity guard, a
 * candidate whose words are too generic (e.g. "Total Marketplace Fee"'s words are also all present
 * in "Total Other Marketplace Fee") simply falls through to "no match" here rather than risking a
 * wrong pick — harmless in practice, since a candidate specific enough to already resolve via step
 * 1 (as marketplaceFee does today) never even reaches step 4.
 */
function resolveHeaderIdx_(idx, candidateName) {
  const nc = normalizeHeaderName_(candidateName);
  if (nc in idx) return idx[nc];
  const keys = Object.keys(idx);
  const startsWith = keys.filter(k => k.indexOf(nc) === 0);
  if (startsWith.length === 1) return idx[startsWith[0]];
  const contains = keys.filter(k => k.indexOf(nc) !== -1);
  if (contains.length === 1) return idx[contains[0]];
  const words = nc.split(' ').filter(Boolean);
  const wordMatches = keys.filter(k => {
    if (k.indexOf('%') !== -1) return false; // rate/percentage column — never a valid money match
    if (k.split(' ').indexOf('pct') !== -1) return false; // ditto, "pct_" naming convention
    return words.every(w => k.indexOf(w) !== -1);
  });
  if (wordMatches.length === 1) return idx[wordMatches[0]];
  return undefined;
}

// ====================== SHEETS API THROTTLE / RETRY ======================

// Google's default Sheets API quota is 60 "read requests" per minute PER USER — and since this
// script always executes as the same account (deployment is "Execute as: Me"), every single call
// this script ever makes counts against that one shared budget, no matter who's viewing the
// dashboard. A normal incremental refresh only re-reads files that actually changed, so it stays
// well under that. But a FULL re-read — which happens whenever FILE_CACHE_VERSION changes, or on
// the very first run ever — makes 2-4 API calls per file (metadata get, header batchGet, one or
// more chunked value gets). With 60+ source files that's 150-250+ calls, which blows straight
// through 60/minute if fired back-to-back. That's exactly what happened on the run that bumped
// FILE_CACHE_VERSION to 2: 41 files failed with "Quota exceeded ... Read requests per minute per
// user", including Natasha Skincare and Naavagreen — the two files the version bump was meant to
// fix. They simply never got a chance to be re-read; their old, pre-warehouse cache entries were
// left in place (see Pass 2's `if (!contribution) continue;`), so this was NOT a regression of
// that fix, just it not having run yet.
//
// Two mitigations, used together everywhere this script calls Sheets.Spreadsheets.*:
//  1. sheetsThrottle_() is called after every successful API call, pacing requests to roughly
//     46/minute — comfortably under the 60/minute cap even allowing for some clock drift.
//  2. callSheetsApi_() wraps every call with automatic retry: if a call still comes back with a
//     quota error (e.g. another process is also spending the same shared quota), it waits with
//     exponential backoff (2s, 4s, 8s, 16s, 30s) and retries, up to 5 attempts, before finally
//     giving up and letting the caller log its usual warning.
function sheetsThrottle_() {
  Utilities.sleep(1300); // ~46 requests/minute, under the 60/minute quota
}

function callSheetsApi_(fn) {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = fn();
      sheetsThrottle_();
      return result;
    } catch (err) {
      const msg = String(err);
      const isQuotaErr = msg.indexOf('Quota exceeded') !== -1 ||
        msg.indexOf('RESOURCE_EXHAUSTED') !== -1 ||
        msg.indexOf('rateLimitExceeded') !== -1 ||
        // Transient Google-side service errors (e.g. HTTP 503 "The service is currently
        // unavailable", 429, backend blips) are retryable too — previously only quota errors got
        // the backoff retry, so a 503 on the Other Revenue / Warehouse Breakdown read just failed
        // on its first attempt and skipped the data for that refresh.
        msg.indexOf('The service is currently unavailable') !== -1 ||
        msg.indexOf('Backend Error') !== -1 ||
        msg.indexOf('INTERNAL') !== -1 ||
        msg.indexOf('503') !== -1 ||
        msg.indexOf('429') !== -1;
      if (!isQuotaErr || attempt === maxAttempts) throw err;
      const backoffMs = Math.min(30000, 2000 * Math.pow(2, attempt - 1));
      Utilities.sleep(backoffMs);
    }
  }
}

// ====================== SHARED-STATE LOCKING ======================
//
// Several small JSON files in Drive are read-modify-written by code paths that can genuinely run
// concurrently — pingPresence() fires every ~30s from EVERY open tab, and inviteUser_/removeUser
// can be clicked by two Admins at once. Apps Script gives no atomic read-modify-write on a Drive
// file, so without locking, two concurrent executions can both read the same "before" state, both
// compute their own "after" state, and both write it back — the second write silently overwrites
// the first one's change (a lost update), e.g. one person's presence heartbeat or one Admin's
// invite/remove disappearing because another request landed a moment later. withScriptLock_ wraps
// the critical section (load -> modify -> save) in Apps Script's LockService so concurrent
// executions queue instead of racing.
/**
 * Runs `fn` while holding the script-wide lock. If the lock can't be acquired within `timeoutMs`,
 * `fn` is simply skipped and this returns undefined — callers that can tolerate a skipped run
 * (e.g. pingPresence — the next heartbeat 30s later just tries again) treat that as a no-op;
 * callers that can't (e.g. inviteUser/removeUser) check for undefined and surface a "try again"
 * error instead of silently pretending the change succeeded.
 */
function withScriptLock_(fn, timeoutMs) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(timeoutMs || 10000);
  } catch (err) {
    return undefined; // couldn't get the lock in time — skip this run
  }
  try {
    return fn();
  } finally {
    try { lock.releaseLock(); } catch (err) { /* already released/expired — ignore */ }
  }
}

// ====================== WAREHOUSE OPERATIONAL & FULFILLMENT COST ======================
//
// A second, separate live spreadsheet — "2026 Warehouse Breakdown" — tracks the blended Rate Per
// Order SIRCLO pays per (Warehouse, Category, Entity, Month), where Category is one of Pick Pack /
// Rent Warehouse / Consumables. This section reads its "Calculation" tab into a lookup table;
// refreshData() below then multiplies each brand's per-warehouse Number of Order (the same `uniq`
// figure already computed from the FS Overview Data Claim files, broken out per warehouse) by the
// matching rate to get that brand's Operational & Fulfillment Cost.
//
// This is a genuinely separate cost-allocation layer from everything above it in this file: it
// doesn't touch FILE_CACHE_NAME/fileCache at all, and a miss here (unmapped warehouse code, or no
// rate for a given month) contributes $0 rather than failing the whole refresh — Sales/Claim/
// RBP/etc. keep working even if this sheet is temporarily unreachable or missing a row.

const WAREHOUSE_FEE_FILE_ID = '1Q29uwu66CNQYendhW2HL4U-Bp8yI10SmZI2bl-YL8BM';
const WAREHOUSE_FEE_SHEET_NAME = 'Calculation';
// The sheet has no year column — its month columns are just "January".."December" — so it's
// implicitly scoped to whatever year the file itself covers (per its name, "2026 Warehouse
// Breakdown"). When 2027 gets its own version of this file, update this (and WAREHOUSE_FEE_FILE_ID
// too, if it turns out to be a brand new file rather than new columns added to this one).
const WAREHOUSE_FEE_YEAR = '2026';

// Maps the code before " - " in a Data Claim file's Warehouse column (e.g. "Benoa" from
// "Benoa - TikTok CPD (KNS)") to the exact Warehouse name used in the Breakdown sheet. Matching is
// case-insensitive on both sides of this map — the Breakdown sheet itself has both "KLOG Benoa" and
// "KLOG BENOA" for the same physical warehouse under different categories.
//
// `null` means a code confirmed to have NO Operational & Fulfillment Cost tracked at all (e.g.
// MOGTM, per Zoltraak 2026-08-12) — contributes $0 silently, same as a code whose exact (warehouse,
// category, entity, month) combination just isn't in the sheet (e.g. most warehouses simply don't
// have all 3 categories). Contrast with a code that ISN'T a key in this map at all: that's an
// unrecognized/new one, which pushes a warning so it doesn't silently and permanently contribute $0
// forever without anyone noticing.
//
// To add a new warehouse code: add one line here. No other code changes needed.
//
// *** ABC OFFICIAL STORE — UNRESOLVED, DO NOT SHIP WITHOUT FIXING THIS ***
// Unlike every other brand in this map/BRAND_ENTITY_OVERRIDES below, ABC Official Store's real
// warehouse code and legal billing entity are NOT YET confirmed — grepping the whole base Code.gs
// this fork came from for "ABC" turns up only the unrelated "Platform Fee Absorb by SIRCLO"
// column-splitting comment (about a Platform Fee export quirk, not about warehouse/entity billing).
// Confirmed by Zoltraak 2026-09-14 that this info isn't available yet either — see
// ABC_FORK_INSTRUCTIONS.md item 11 for the full explanation.
//
// Before this fork is used for anything beyond a first test refresh:
//   1. Pull a real "Data Claim Internal ABC Official Store" file and read its Warehouse column
//      values (shaped like "<code> - ABC Official Store (<entity abbreviation>)").
//   2. If <code> (lowercased, before the first " - ") isn't already a key below, add one line
//      mapping it to the exact Warehouse name used in the "2026 Warehouse Breakdown" sheet's
//      Calculation tab (self-map if the code IS that sheet's name, like 'biteship'/'guj'/'nmr' do).
//   3. Check the "(<entity abbreviation>)" suffix — "(KNS)" = PT Koneksi Niaga Solusindo = the
//      default, no BRAND_ENTITY_OVERRIDES entry needed; "(MNS)" = PT Medika Niaga Solusindo = ADD
//      BRAND_ENTITY_OVERRIDES['ABC Official Store'] = 'PT Medika Niaga Solusindo'; below. Confirm
//      this reading with Zoltraak and date the comment, same as every other entry in this map and
//      in BRAND_ENTITY_OVERRIDES.
// Until this is done: Pick Pack / Rent Warehouse / Consumables will read $0 for ABC, and
// refreshData's warnings will show an "Unrecognized warehouse code" entry every run — that's
// expected (not silent, not a crash), and is exactly the signal that this TODO hasn't been done yet.
const WAREHOUSE_CODE_MAP = {
  'benoa': 'KLOG Benoa',
  'surabaya': 'KLOG Surabaya',
  'bks': 'BKS',
  'indo paket': 'Indo Paket',
  'smc': 'SMC',
  'storaflow': 'Storaflow',
  'tms': 'TMS',
  'lazada': 'MCL',
  'mogtm': null,
  // "JIT - Rip Curl Bali (KNS)" — Rip Curl's other warehouse code, confirmed by Zoltraak
  // 2026-08-18: bills under PT Koneksi Niaga Solusindo (the default, no BRAND_ENTITY_OVERRIDES
  // entry needed) and deliberately has no Pick Pack / Rent Warehouse / Consumables rate data —
  // same "recognized but always $0, no warning" pattern as 'mogtm' above.
  'jit': null,
  'oxygen': 'Oxygen', // Beiersdorf's warehouse (e.g. "Oxygen - Beiersdorf (KNS)") — confirmed by
  // Zoltraak 2026-08-12: bills under PT Koneksi Niaga Solusindo (the default, no
  // BRAND_ENTITY_OVERRIDES entry needed) and has Pick Pack / Rent Warehouse / Consumables rates
  // in the Warehouse Breakdown sheet like any other warehouse — not a null/no-cost case.
  // "Biteship - Mustika Ratu (KNS)" — Mustika Ratu's warehouse, bills under PT Koneksi Niaga
  // Solusindo (the default — confirmed by Zoltraak 2026-08-12, no BRAND_ENTITY_OVERRIDES entry
  // needed). NOTE: mapped to itself ("Biteship") assuming that's the exact string used in the
  // Warehouse Breakdown sheet's Warehouse column, same self-mapping convention as BKS/SMC/TMS
  // above — not independently confirmed against that sheet, so if Pick Pack/Rent Warehouse/
  // Consumables still show $0 for Mustika Ratu after a refresh, this is the first thing to check.
  'biteship': 'Biteship',
  // "GUJ - Abbott Nutritions Semarang (MNS)" — Abbott Official Store's warehouse, bills under PT
  // Medika Niaga Solusindo, NOT the default (see BRAND_ENTITY_OVERRIDES below — confirmed by
  // Zoltraak 2026-08-12). Same self-mapping caveat as 'biteship' above: "GUJ" is assumed to be the
  // exact Warehouse Breakdown sheet value, not independently confirmed.
  'guj': 'GUJ',
  // "NMR - Philips Bali (MNS)", "BSS - Philips Bandung (MNS)", "DAF - Philips Semarang (MNS)" —
  // Philips Official Store / Philips Avent Official's warehouses. Confirmed 2026-08-14 by Zoltraak:
  // these bill under PT Medika Niaga Solusindo, NOT the default (see BRAND_ENTITY_OVERRIDES below).
  // Self-mapping convention as BKS/SMC/TMS/GUJ above — the Warehouse Breakdown sheet's Calculation
  // tab uses these exact strings (NMR/BSS/DAF) in its Warehouse column, confirmed directly against
  // that sheet, so they're not just assumed like 'biteship'/'guj' were.
  'nmr': 'NMR',
  'bss': 'BSS',
  'daf': 'DAF',
};

// Which legal Entity's rate applies to a brand's orders. Every brand defaults to PT Koneksi Niaga
// Solusindo; add an entry here only for a brand confirmed to bill under a different entity.
const DEFAULT_WAREHOUSE_ENTITY = 'PT Koneksi Niaga Solusindo';
const BRAND_ENTITY_OVERRIDES = {
  // Confirmed by Zoltraak 2026-08-12 (see the "GUJ" WAREHOUSE_CODE_MAP entry above, whose "(MNS)"
  // suffix is what flagged this brand as billing under a non-default entity).
  'Abbott Official Store': 'PT Medika Niaga Solusindo',
  // Philips Official Store / Philips Avent Official — confirmed 2026-08-14 by Zoltraak: their
  // warehouses (NMR/BSS/DAF — "NMR - Philips Bali (MNS)" / "BSS - Philips Bandung (MNS)" /
  // "DAF - Philips Semarang (MNS)") bill under PT Medika Niaga Solusindo, not the default.
  'Philips Official Store': 'PT Medika Niaga Solusindo',
  'Philips Avent Official': 'PT Medika Niaga Solusindo',
  // Betadine Official Store — confirmed 2026-08-14 by Zoltraak: its warehouses (e.g. "Benoa -
  // Betadine (MNS)", "MOGTM - Betadine Solo (MNS)") bill under PT Medika Niaga Solusindo; the
  // Benoa warehouse maps to KLOG Benoa (already in WAREHOUSE_CODE_MAP as 'benoa').
  'Betadine Official Store': 'PT Medika Niaga Solusindo',
};

// The 3 Operational & Fulfillment Cost line items shown on the dashboard, and the exact Category
// text each one matches in the Breakdown sheet's Category column.
const WAREHOUSE_FEE_CATEGORY_NAME = {
  pickPack: 'Pick Pack',
  rentWarehouse: 'Rent Warehouse',
  consumables: 'Consumables',
};

const MONTH_NAME_TO_NUM = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
  // Indonesian aliases — added 2026-08-18 for loadUnileverClaimRevenue_'s source spreadsheet, whose
  // month-header rows mix English and Indonesian spellings (e.g. "Oktober"/"Desember" alongside
  // "January"/"November"). Purely additive: every OTHER reader that uses this same map (Warehouse
  // Breakdown, LOreal Other Revenue) only ever encounters English headers in its own sheet, so
  // these extra keys are simply never matched there — harmless.
  januari: '01', februari: '02', maret: '03', mei: '05', juni: '06', juli: '07', agustus: '08',
  oktober: '10', desember: '12',
};

/**
 * Reads the Warehouse Breakdown spreadsheet's Calculation tab and returns a lookup:
 *   rateMap["<warehouse lower>||<category>||<entity lower>||<MM>"] -> Rate Per Order (number)
 * or null if the sheet couldn't be read at all (its own API call failed, or the expected header
 * row isn't there) — callers treat null as "skip Operational & Fulfillment Cost this run, $0 for
 * everyone" rather than failing the whole refresh over it.
 *
 * The sheet has 3 blocks of Jan-Dec columns sharing the same 12 month-name headers (an unlabeled
 * Total Cost block, Number of Order, then Rate Per Order) — only the Rate Per Order block's values
 * are used here (it's already the pre-computed Cost ÷ Orders figure). Which block is which is
 * found dynamically by reading the row ABOVE the Warehouse/Category/Entity header row for group
 * labels, rather than hardcoding column positions — the same defensive approach
 * readDataClaimSheet_ uses for Data Claim files, since a spreadsheet someone edits by hand can
 * grow/shrink/reorder columns over time.
 */
function loadWarehouseFeeRates_(warnings) {
  let resp;
  try {
    // One generous fixed range in a single call — this sheet is small (a few dozen rows), so
    // there's no need for the chunked-fetch machinery readDataClaimSheet_ needs for 10k+ row files.
    resp = callSheetsApi_(() => Sheets.Spreadsheets.Values.get(
      WAREHOUSE_FEE_FILE_ID,
      "'" + WAREHOUSE_FEE_SHEET_NAME.replace(/'/g, "''") + "'!A1:BA300",
      { valueRenderOption: 'UNFORMATTED_VALUE' }
    ));
  } catch (err) {
    warnings.push('Could not read Warehouse Breakdown ("' + WAREHOUSE_FEE_SHEET_NAME + '" tab) — Operational & Fulfillment Cost skipped this refresh: ' + err);
    return null;
  }
  const values = resp.values || [];

  let headerRowIdx = -1, warehouseCol = -1, categoryCol = -1, entityCol = -1;
  for (let r = 0; r < values.length; r++) {
    const row = (values[r] || []).map(c => String(c).trim());
    const wCol = row.indexOf('Warehouse');
    const cCol = row.indexOf('Category');
    const eCol = row.indexOf('Entity');
    if (wCol !== -1 && cCol !== -1 && eCol !== -1) {
      headerRowIdx = r; warehouseCol = wCol; categoryCol = cCol; entityCol = eCol;
      break;
    }
  }
  if (headerRowIdx === -1) {
    warnings.push('Warehouse Breakdown — could not find a Warehouse/Category/Entity header row in "' + WAREHOUSE_FEE_SHEET_NAME + '". Operational & Fulfillment Cost skipped this refresh.');
    return null;
  }

  // The group-label row sits directly above the header row (e.g. "Rate Per Order" stamped once
  // above its 12 month columns). Sheets only returns that label in the FIRST cell of the merged
  // range, so carry the last-seen non-empty label forward while scanning left to right.
  const groupLabelRow = headerRowIdx > 0 ? (values[headerRowIdx - 1] || []).map(c => String(c).trim()) : [];
  const headerRow = (values[headerRowIdx] || []).map(c => String(c).trim());
  const rateMonthCols = {}; // 'january'..'december' -> column index
  let currentGroupLabel = '';
  for (let c = 0; c < headerRow.length; c++) {
    if (groupLabelRow[c]) currentGroupLabel = groupLabelRow[c];
    const monthKey = headerRow[c].toLowerCase();
    if (currentGroupLabel === 'Rate Per Order' && MONTH_NAME_TO_NUM[monthKey]) {
      rateMonthCols[monthKey] = c;
    }
  }
  if (Object.keys(rateMonthCols).length === 0) {
    warnings.push('Warehouse Breakdown — could not find the "Rate Per Order" column block in "' + WAREHOUSE_FEE_SHEET_NAME + '". Operational & Fulfillment Cost skipped this refresh.');
    return null;
  }

  const rateMap = {};
  for (let r = headerRowIdx + 1; r < values.length; r++) {
    const row = values[r] || [];
    const warehouse = String(row[warehouseCol] || '').trim();
    const category = String(row[categoryCol] || '').trim();
    const entity = String(row[entityCol] || '').trim();
    if (!warehouse || !category || !entity) continue; // blank/trailing row
    Object.keys(rateMonthCols).forEach(monthName => {
      const col = rateMonthCols[monthName];
      const rate = Number(row[col]);
      if (!rate) return; // blank or 0 — nothing to record, treated as "no rate" either way
      const key = warehouse.toLowerCase() + '||' + category + '||' + entity.toLowerCase() + '||' + MONTH_NAME_TO_NUM[monthName];
      rateMap[key] = rate;
    });
  }
  return rateMap;
}

// ====================== OTHER REVENUE ======================

// ====================== WAREHOUSE FEE HELPERS ======================
//
// Generic helpers used by Pick Pack / Consumables (and the Rent Warehouse fallback path) below —
// NOT Promo-Fund-specific despite living in this reference file near where the Betadine-only Promo
// Fund Front/Back Margin feature used to be (this fork has no such feature — confirmed by Zoltraak
// 2026-09-14 that ABC Official Store has no Promo-Fund-equivalent lump-sum revenue/cost source).
// Kept verbatim; do not remove.

/**
 * Maps a raw Warehouse column value from a Data Claim file (e.g. "Benoa - TikTok CPD (KNS)") to
 * the canonical warehouse name used in the Breakdown sheet (e.g. "KLOG Benoa"), via the portion
 * before " - ". Returns null for a code confirmed to have no cost data (see WAREHOUSE_CODE_MAP) OR
 * one that isn't recognized at all — the latter also pushes a warning (deduped via
 * `warnedPrefixes`, so one unrecognized code doesn't spam a warning per row it appears in).
 */
function mapWarehouseToCanonical_(rawWarehouse, warnings, warnedPrefixes) {
  const raw = String(rawWarehouse || '').trim();
  const sepIdx = raw.indexOf(' - ');
  const prefix = (sepIdx === -1 ? raw : raw.slice(0, sepIdx)).trim().toLowerCase();
  if (!prefix) return null;
  if (Object.prototype.hasOwnProperty.call(WAREHOUSE_CODE_MAP, prefix)) {
    return WAREHOUSE_CODE_MAP[prefix]; // may itself be null — see comment above
  }
  if (!warnedPrefixes[prefix]) {
    warnedPrefixes[prefix] = true;
    warnings.push('Unrecognized warehouse code "' + prefix + '" (from "' + raw + '") — add it to WAREHOUSE_CODE_MAP in Code.gs. Operational & Fulfillment Cost is $0 for it until then.');
  }
  return null;
}

/** rateMap is whatever loadWarehouseFeeRates_ returned (possibly null) — always safe to call. */
function lookupWarehouseFeeRate_(rateMap, canonicalWarehouse, categoryKey, entity, monthNum) {
  if (!rateMap || !canonicalWarehouse) return 0;
  const key = canonicalWarehouse.toLowerCase() + '||' + WAREHOUSE_FEE_CATEGORY_NAME[categoryKey] + '||' + entity.toLowerCase() + '||' + monthNum;
  return rateMap[key] || 0;
}

// ====================== RENT WAREHOUSE (CBM-based) ======================
//
// REVISED 2026-09-12 per Zoltraak: Rent Warehouse specifically (NOT Pick Pack, NOT Consumables —
// those two keep using loadWarehouseFeeRates_/WAREHOUSE_CODE_MAP above exactly as before) now
// sources its cost from a separate "CTS - Rent Warehouse Calculation" spreadsheet, keyed by
// (Brand, WHP) per month, instead of a blended Rate Per Order × Number of Order. The new sheet
// also carries a CBM Usage figure at the same (Brand, WHP, month) granularity, which the dashboard
// surfaces as its own "CBM Usage" row and divides into cost for "Rent Warehouse per CBM" — see
// Dashboard.html's ROW_DEFS.
//
// This is applied on a per (brand, warehouse, month) basis: if the new sheet can't answer for a
// specific combination — no monthly tab yet for that month, this brand isn't a row in that tab, or
// its resolved WHP has no cost column at all in the monthly sheet's cost block (e.g. "Vertikal",
// which the sheet only tracks CBM for) — that ONE combination falls back to the exact same
// loadWarehouseFeeRates_/WAREHOUSE_CODE_MAP rate × Number of Order calculation Rent Warehouse used
// before this revision (see refreshData's Pass 4 below), with a warning so the gap is visible
// rather than silently $0. Nothing here changes Pick Pack/Consumables' own behavior.
const RENT_WAREHOUSE_CBM_FILE_ID = '1jsn3GZiazrMpwG3G6KMIFGV9D93efl5vwO4XKcc3Z2E';
const RENT_WAREHOUSE_MASTER_SHEET_NAME = 'Master Data Warehouse';
// Added 2026-10-13: kolom B tab bulanan ("Standardized_Mapping Brand") = principal pemilik baris.
// Nama brand yang sama bisa muncul lagi di baris lain dengan principal / Subsidiary BERBEDA (mis.
// "Abbott Health Indonesia" / PT Medika Niaga Solusindo — terbukti terjadi di fork L'Oreal untuk
// Garnier/LOreal Paris/Maybelline/dll). Baris-baris itu BUKAN milik principal fork ini, jadi tidak
// boleh ikut dijumlahkan ke Rent Warehouse. Dibandingkan tanpa peduli huruf besar/kecil, spasi, dan
// tanda baca. Nilainya harus persis sama dengan kolom B tab bulanan / kolom "Principal" Trend Analysis.
// CATATAN: di sheet CTS, baris "ABC Official Store" berada di bawah principal "Kraft Heinz".
const RENT_WAREHOUSE_SHEET_PRINCIPAL = 'Kraft Heinz';
function normalizePrincipalKey_(v) {
  return String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
// Sheet tabs are named with plain Title-Case English month names ("June", "July", "August", ...),
// same no-year-column convention as WAREHOUSE_FEE_YEAR's own sheet. Kept as its own explicit map
// (rather than derived from MONTH_NAME_TO_NUM, which is lowercase and also carries Indonesian
// aliases that aren't real tab names in this sheet) so the exact tab-name spelling is obvious here.
const RENT_WAREHOUSE_MONTH_TAB_NAME = {
  '01': 'January', '02': 'February', '03': 'March', '04': 'April', '05': 'May', '06': 'June',
  '07': 'July', '08': 'August', '09': 'September', '10': 'October', '11': 'November', '12': 'December',
};

// The monthly sheet only ever has ONE combined "SMC" column in both its CBM Usage and Cost blocks,
// even though Master Data Warehouse resolves some warehouses to the more specific "SMC Surabaya"
// or "SMC Tangerang" — confirmed by Zoltraak 2026-09-12: there's no finer data available than the
// single "SMC" column, so both collapse to it here before any monthly-sheet lookup.
function normalizeRentWarehouseWhp_(whp) {
  const w = String(whp || '').trim();
  if (/^SMC\b/i.test(w)) return 'SMC';
  return w;
}

/**
 * Reads the "Master Data Warehouse" tab and returns a lookup:
 *   whpMap["<full raw warehouse string, lowercased>"] -> WHP identifier (e.g. "KLOG Benoa")
 * or null if it couldn't be read at all. Unlike WAREHOUSE_CODE_MAP (which maps just the CODE
 * before " - "), this maps the FULL warehouse string — confirmed necessary because the same code
 * can resolve to different WHPs depending on the rest of the string (e.g. "SMC - Motul Surabaya
 * (KNS)" -> "SMC Surabaya" vs "SMC - Prenagen Tangerang (KNS)" -> "SMC Tangerang", both collapsed
 * to "SMC" by normalizeRentWarehouseWhp_ above for the monthly sheet's own single "SMC" column).
 */
function loadRentWarehouseWhpMap_(warnings) {
  let resp;
  try {
    resp = callSheetsApi_(() => Sheets.Spreadsheets.Values.get(
      RENT_WAREHOUSE_CBM_FILE_ID,
      "'" + RENT_WAREHOUSE_MASTER_SHEET_NAME.replace(/'/g, "''") + "'!A1:B300",
      { valueRenderOption: 'UNFORMATTED_VALUE' }
    ));
  } catch (err) {
    warnings.push('Could not read "' + RENT_WAREHOUSE_MASTER_SHEET_NAME + '" — Rent Warehouse falls back to the old rate × Number of Order calculation for every brand/warehouse this refresh: ' + err);
    return null;
  }
  const values = resp.values || [];
  const map = {};
  // Row 1 is the "Warehouse"/"WHP" header — data starts at row 2 (index 1).
  for (let r = 1; r < values.length; r++) {
    const row = values[r] || [];
    const warehouse = String(row[0] || '').trim();
    const whp = String(row[1] || '').trim();
    if (!warehouse || !whp) continue;
    map[warehouse.toLowerCase()] = whp;
  }
  return map;
}

/**
 * Reads one monthly tab (e.g. "August") of the Rent Warehouse CBM sheet and returns:
 *   { brandRows: { "<brand lower>": { cbmByWhp: {whp: number}, costByWhp: {whp: number} } } }
 * or null if the tab itself can't be read (doesn't exist yet, API error) — callers treat null as
 * "fall back to the old calculation for every brand/warehouse this month", same tolerant pattern
 * as loadWarehouseFeeRates_.
 *
 * The tab's real header row is NOT at the top — rows 1-18 hold an unrelated CBM/simulation table.
 * The real header (found dynamically, not hardcoded, for the same reason readDataClaimSheet_/
 * loadWarehouseFeeRates_ do this) is the row containing "Brand" in column A. From 1 column past
 * "Subsidiary" (i.e. skipping Brand/Standardized_Mapping Brand/Subsidiary), the WHP names repeat
 * TWICE across the row: first as the CBM Usage block, then again as the Cost (Rupiah) block — the
 * two blocks are told apart by which occurrence (first vs second) of each WHP name is seen while
 * scanning left to right, not by hardcoded column letters, so this keeps working if a column is
 * ever inserted/reordered.
 */
function loadRentWarehouseCbmSheet_(monthTabName, warnings) {
  let resp;
  try {
    resp = callSheetsApi_(() => Sheets.Spreadsheets.Values.get(
      RENT_WAREHOUSE_CBM_FILE_ID,
      "'" + monthTabName.replace(/'/g, "''") + "'!A1:AZ300",
      { valueRenderOption: 'UNFORMATTED_VALUE' }
    ));
  } catch (err) {
    warnings.push('Rent Warehouse — could not read the "' + monthTabName + '" tab (not created yet?) — falling back to the old rate × Number of Order calculation for every brand/warehouse this month: ' + err);
    return null;
  }
  const values = resp.values || [];

  let headerRowIdx = -1;
  for (let r = 0; r < values.length; r++) {
    const row = values[r] || [];
    if (String(row[0] || '').trim() === 'Brand') { headerRowIdx = r; break; }
  }
  if (headerRowIdx === -1) {
    warnings.push('Rent Warehouse — could not find the "Brand" header row in the "' + monthTabName + '" tab — falling back to the old calculation for every brand/warehouse this month.');
    return null;
  }
  const headerRow = (values[headerRowIdx] || []).map(c => String(c).trim());
  const cbmColByWhp = {}, costColByWhp = {};
  const seen = {};
  // Column index 3 (0-based) is one past Brand(0)/Standardized_Mapping Brand(1)/Subsidiary(2).
  for (let c = 3; c < headerRow.length; c++) {
    const name = headerRow[c];
    if (!name || name === 'Total') continue; // "Total" appears once per block — not a WHP itself
    if (!seen[name]) {
      seen[name] = true;
      cbmColByWhp[name] = c;
    } else if (costColByWhp[name] === undefined) {
      costColByWhp[name] = c;
    }
  }
  if (Object.keys(cbmColByWhp).length === 0) {
    warnings.push('Rent Warehouse — could not find any WHP columns in the "' + monthTabName + '" tab\'s header row — falling back to the old calculation for every brand/warehouse this month.');
    return null;
  }

  const brandRows = {};
  // whpEntityTotals — added 2026-09-14 per Zoltraak's "%CBM Usage vs Total WHP" request: the TOTAL
  // CBM Usage for one (WHP, Subsidiary) combination this month, summed across EVERY brand row in
  // this tab (not just the brands this fork tracks) — column index 2 (0-based) is "Subsidiary"
  // (values like "PT Koneksi Niaga Solusindo", "PT Medika Niaga Solusindo", matching the exact
  // entity strings BRAND_ENTITY_OVERRIDES/DEFAULT_WAREHOUSE_ENTITY already use elsewhere in this
  // file). Deliberately NOT read from the sheet's own labeled "Total"/"CBM Usage - <date>" row —
  // confirmed by direct inspection (Zoltraak, 2026-09-14) that row's meaning is inconsistent across
  // months (sometimes a true combined total, sometimes silently subsidiary-scoped, sometimes stale)
  // — self-computing from every brand row's own Subsidiary column is the only reliable source. This
  // is a SHARED REFERENCE value (the SAME number for every brand using that WHP+Subsidiary this
  // month) — Dashboard.html's mergeWhpTotals_/sumWhpTotals_ comment explains why it must never be
  // summed across brands the normal way once it reaches the client.
  const whpEntityTotals = {};
  for (let r = headerRowIdx + 1; r < values.length; r++) {
    const row = values[r] || [];
    const brand = String(row[0] || '').trim();
    if (!brand) continue;
    const brandKey = brand.toLowerCase();
    const subsidiary = String(row[2] || '').trim();
    const cbmByWhp = {}, costByWhp = {};
    Object.keys(cbmColByWhp).forEach(whp => { cbmByWhp[whp] = Number(row[cbmColByWhp[whp]]) || 0; });
    Object.keys(costColByWhp).forEach(whp => { costByWhp[whp] = Number(row[costColByWhp[whp]]) || 0; });
    if (subsidiary) {
      Object.keys(cbmColByWhp).forEach(whp => {
        const key = whp + '||' + subsidiary;
        whpEntityTotals[key] = (whpEntityTotals[key] || 0) + cbmByWhp[whp];
      });
    }
    // FIX 2026-10-13: hanya baris milik principal fork ini (kolom B "Standardized_Mapping Brand" =
    // RENT_WAREHOUSE_SHEET_PRINCIPAL) yang masuk ke brandRows / Rent Warehouse. whpEntityTotals di
    // atas sengaja tetap dihitung dari SEMUA baris (itu total CBM WHP+Subsidiary, bukan per principal).
    if (RENT_WAREHOUSE_SHEET_PRINCIPAL &&
        normalizePrincipalKey_(row[1]) !== normalizePrincipalKey_(RENT_WAREHOUSE_SHEET_PRINCIPAL)) {
      continue;
    }
    // Dedup — added 2026-09-14 per Zoltraak ("to get Rent Warehouse cost please change to dedup if
    // there are more than 1 row instead of use the last row"): more than one row in this tab can
    // share the same Brand. The old behavior just did `brandRows[brandKey] = {...}` unconditionally,
    // so the LAST matching row silently overwrote (and discarded) any earlier row(s) for that same
    // brand. Now, when a brand's key already exists, its CBM Usage and Cost are SUMMED per WHP
    // instead — no duplicate row's data is dropped. Only this monthly CBM/Cost tab is deduped this
    // way; the separate "Master Data Warehouse" warehouse->WHP map (loadRentWarehouseWhpMap_ above)
    // is untouched. (whpEntityTotals above is accumulated BEFORE this dedup, straight from every raw
    // row, so a duplicate brand row's CBM still counts exactly once toward the WHP+Subsidiary total
    // — it's a real row in the sheet regardless of which brand it belongs to.)
    const existing = brandRows[brandKey];
    if (existing) {
      Object.keys(cbmByWhp).forEach(whp => { existing.cbmByWhp[whp] = (existing.cbmByWhp[whp] || 0) + cbmByWhp[whp]; });
      Object.keys(costByWhp).forEach(whp => { existing.costByWhp[whp] = (existing.costByWhp[whp] || 0) + costByWhp[whp]; });
    } else {
      brandRows[brandKey] = { cbmByWhp, costByWhp };
    }
  }
  return { brandRows, whpEntityTotals };
}

/**
 * Looks up (brand, whp) in whatever loadRentWarehouseCbmSheet_ returned. Returns {cbm, cost} or
 * null if this specific brand isn't a row in this month's tab, or this WHP has no COST column in
 * it (e.g. "Vertikal" — the sheet tracks its CBM Usage but never gave it a cost column) — either
 * case is a per-(brand,warehouse) fallback trigger, not a whole-month one.
 */
function lookupRentWarehouseCbmAndCost_(cbmSheet, brand, whp) {
  if (!cbmSheet) return null;
  const row = cbmSheet.brandRows[String(brand || '').trim().toLowerCase()];
  if (!row) return null;
  if (row.costByWhp[whp] === undefined) return null; // no cost column for this WHP this month
  return { cbm: row.cbmByWhp[whp] || 0, cost: row.costByWhp[whp] || 0 };
}

/**
 * Looks up the self-computed TOTAL CBM Usage for one (WHP, Subsidiary/Entity) combination in
 * whatever loadRentWarehouseCbmSheet_ returned — see that function's own whpEntityTotals comment
 * for why this is built from the tab's Subsidiary column rather than trusted from the sheet's own
 * "Total" row. Returns null (not 0) when there's no data for this combination this month, so
 * callers can tell "no total available" apart from "total is genuinely 0".
 */
function lookupRentWarehouseWhpTotal_(cbmSheet, whp, entity) {
  if (!cbmSheet || !cbmSheet.whpEntityTotals) return null;
  const total = cbmSheet.whpEntityTotals[whp + '||' + entity];
  return (total === undefined) ? null : total;
}

// ====================== REFRESH ======================

/**
 * Scans every brand folder under ROOT_FOLDER_ID for "YYYYMM Data Claim Internal <Brand>" files,
 * aggregates them into the same shape the dashboard's DATA / MP_DATA arrays use, and caches the
 * result as a JSON file in Drive. Returns the payload too, so callers like the client-side
 * Refresh button (via google.script.run) can act on the result directly.
 *
 * Incremental: each file's own last-modified time is compared against what was recorded the
 * previous time this ran (FILE_CACHE_NAME). A file whose timestamp hasn't changed is NOT
 * re-read — its previously-computed contribution (qty/sales/claim/rbp/unique customers) is
 * reused as-is. Only new or actually-modified files get read via the Sheets API. This is done
 * per FILE rather than per FOLDER on purpose: a Drive folder's own modifiedTime does not
 * reliably update just because a file inside it changed, so it isn't a trustworthy signal —
 * per-file timestamps are. Files that disappear from Drive (deleted/moved/renamed) are dropped
 * from the cache so they stop contributing.
 *
 * Reads changed files one at a time via the Sheets Advanced Service (Sheets.Spreadsheets.*),
 * which is faster and more reliable than both SpreadsheetApp (loads the whole object model) and
 * Google's raw CSV export URL (undocumented, returned HTTP 400 on every attempt, parallel or
 * sequential).
 */
// Apps Script kills any single execution at 6 minutes (consumer accounts) or 30 minutes
// (Google Workspace, which SIRCLO is on) — hard stop, no warning, whatever was mid-flight is
// just gone. A COLD run (empty file cache — first run ever, or right after a version bump) can
// need 150-250+ files to be freshly read, each costing several seconds once you add the
// deliberate throttle (sheetsThrottle_) on top of the 2-4 API calls it takes, which adds up to
// well over 30 minutes. TIME_BUDGET_MS below is refreshData()'s own soft deadline, checked
// before starting each NEW file read in Pass 2/2b (never mid-file) — once elapsed time crosses
// it, the loop stops early instead of letting Apps Script's hard cap cut it off. Both file
// caches (fileCache/feeFileCache) are still saved with whatever WAS completed, so that partial
// progress is never lost — it's exactly what makes the NEXT run (whether that's you clicking Run
// again, or tomorrow's 6am trigger) pick up only the files still missing a cache entry, rather
// than starting over. A few runs in a row fully warms the cache; every run after that is fast
// again since only actually-changed files need a fresh read.
const TIME_BUDGET_MS = 25 * 60 * 1000; // 25 min — leaves ~5 min headroom under the 30 min cap

function refreshData() {
  const startTime_ = Date.now();
  function overBudget_() { return Date.now() - startTime_ > TIME_BUDGET_MS; }

  // Pass 1: find every matching file first (cheap Drive metadata only, no content reads yet).
  const root = DriveApp.getFolderById(ROOT_FOLDER_ID);
  const brandFolders = root.getFolders();
  const targets = [];    // { fileId, fileName, brand, month, modifiedTime } — Data Claim Internal files
  const feeTargets = []; // { fileId, fileName, brand, month, marketplace, modifiedTime } — Platform Fee files
  const absorbTargets = []; // { fileId, fileName, brand, month, modifiedTime } — "YYYYMM - Summary MP Fee - <Brand>" files (Platform Fee Absorb by SIRCLO)
  const absorbSeenIds = {};
  function queueAbsorbSummary_(file, name) {
    const m = ABSORB_SUMMARY_FILE_NAME_PATTERN.exec(name);
    if (!m) return false;
    const brand = normalizeBrand_(m[2].trim());
    if (EXCLUDED_BRANDS.indexOf(brand) === -1 && ABC_GROUP_BRANDS.indexOf(brand) !== -1 && !absorbSeenIds[file.getId()]) {
      absorbSeenIds[file.getId()] = true;
      absorbTargets.push({
        fileId: file.getId(),
        fileName: name,
        brand: brand,
        month: m[1].slice(0, 4) + '-' + m[1].slice(4, 6),
        modifiedTime: file.getLastUpdated().toISOString(),
      });
    }
    return true;
  }

  while (brandFolders.hasNext()) {
    const folder = brandFolders.next();
    const files = folder.getFiles();
    while (files.hasNext()) {
      const file = files.next();
      const name = file.getName().trim();

      const match = FILE_NAME_PATTERN.exec(name);
      if (match) {
        const brand = normalizeBrand_(match[2].trim());
        // ABC Official Store-only fork: skip every brand except ABC_GROUP_BRANDS' 1 real Official
        // Store right here, BEFORE this file is ever queued for a content read — this is the actual
        // fix for the "500+ files unread" problem the main script has (which queues and later tries
        // to content-read every brand's files). This check only costs a cheap array scan against
        // filename metadata already in hand, no extra Drive/Sheets API calls.
        if (EXCLUDED_BRANDS.indexOf(brand) === -1 && ABC_GROUP_BRANDS.indexOf(brand) !== -1) {
          const month = match[1].slice(0, 4) + '-' + match[1].slice(4, 6);
          targets.push({
            fileId: file.getId(),
            fileName: name,
            brand: brand,
            month: month,
            modifiedTime: file.getLastUpdated().toISOString(),
          });
        }
        continue;
      }

      const feeMatch = PLATFORM_FEE_FILE_NAME_PATTERN.exec(name);
      if (feeMatch) {
        const brand = normalizeBrand_(feeMatch[3].trim());
        // Same ABC Official Store-only filter as the Data Claim Internal branch above.
        if (EXCLUDED_BRANDS.indexOf(brand) === -1 && ABC_GROUP_BRANDS.indexOf(brand) !== -1) {
          const month = feeMatch[1].slice(0, 4) + '-' + feeMatch[1].slice(4, 6);
          feeTargets.push({
            fileId: file.getId(),
            fileName: name,
            brand: brand,
            month: month,
            marketplace: feeMatch[2],
            modifiedTime: file.getLastUpdated().toISOString(),
          });
        }
        continue;
      }
      if (queueAbsorbSummary_(file, name)) continue; // "YYYYMM - Summary MP Fee - <Brand>" (Platform Fee Absorb by SIRCLO source)
      // none of the patterns matched — not a file this script cares about, skip
    }
  }

  // The summary files may also sit directly in ABSORB_SUMMARY_FOLDER_ID (not under a brand sub-folder).
  try {
    const absorbFiles = DriveApp.getFolderById(ABSORB_SUMMARY_FOLDER_ID).getFiles();
    while (absorbFiles.hasNext()) {
      const f = absorbFiles.next();
      queueAbsorbSummary_(f, f.getName().trim());
    }
  } catch (err) {
    // Not fatal — files under ROOT_FOLDER_ID's brand folders were still picked up above.
    // (warnings is declared just below, so stash the message and push it once it exists.)
    var absorbFolderError_ = String(err);
  }

  const fileCache = loadFileCache_(); // fileId -> { modifiedTime, data, mp, wh } — content ONLY, no brand/month (see note below)
  const warnings = [];
  if (typeof absorbFolderError_ !== 'undefined') warnings.push('Could not scan ABSORB_SUMMARY_FOLDER_ID for Summary MP Fee files: ' + absorbFolderError_);
  let reused = 0, reprocessed = 0;
  const seenFileIds = {};

  // Pass 2: for each target, reuse the cached CONTENT if the file hasn't changed since the last
  // successful refresh; otherwise (new file, or modifiedTime differs) read it fresh.
  //
  // Deliberately NOT caching brand/month here (even though they don't require an API read) —
  // they're always taken fresh from `targets` (computed via normalizeBrand_ above) in Pass 3
  // instead. Caching them was a bug: a file whose content hadn't changed kept reusing whatever
  // brand normalizeBrand_ produced the last time it was actually read, so fixing/extending
  // normalizeBrand_ (e.g. to fold "<Brand> Part I"/"Part II" together) silently had no effect on
  // already-cached files until they happened to get re-read. Splitting cache content (expensive,
  // needs an API call) from brand/month grouping (cheap, just re-derived from the filename every
  // run) means normalizeBrand_ changes apply to ALL files immediately on the next refresh.
  //
  // readDataClaimSheet_ also handles files where the actual data isn't on the first tab — e.g.
  // "202605 Data Claim Internal Natasha Skincare Official Store" has a "Sheet1" placeholder tab
  // (just a chat link) before the real "2605 DC Natasha Skincare" data tab. It checks every tab's
  // header row and uses whichever one actually has the columns this script needs.
  let budgetStoppedDataClaim = 0;
  for (let ti = 0; ti < targets.length; ti++) {
    const t = targets[ti];
    const cached = fileCache[t.fileId];
    const isFresh = cached && cached.modifiedTime === t.modifiedTime && cached.v === FILE_CACHE_VERSION;

    // Only the time budget's cache-miss branch actually costs API calls, so only THAT branch
    // checks the budget — an already-cached file is nearly free (no network call) and skipping
    // it here would just leave it (harmlessly) marked unseen below, forcing an unnecessary
    // re-read next run. seenFileIds is still marked either way, further down, once we know
    // whether this file is being kept in the cache at all this run.
    if (!isFresh && overBudget_()) {
      budgetStoppedDataClaim = targets.length - ti;
      break; // stop starting new reads — see TIME_BUDGET_MS comment above refreshData()
    }

    seenFileIds[t.fileId] = true;

    if (isFresh) {
      reused++;
      continue; // content already in fileCache, still valid, AND computed by the current code — nothing to do
    }

    const contribution = readFileContribution_(t, warnings);
    if (!contribution) continue; // reading/parsing failed — warning already pushed
    reprocessed++;
    fileCache[t.fileId] = {
      modifiedTime: t.modifiedTime,
      v: FILE_CACHE_VERSION,
      data: contribution.data,
      mp: contribution.mp,
      wh: contribution.wh,
    };
  }

  // Drop cache entries for files that no longer exist under any brand folder (deleted/moved) —
  // but ONLY if this pass ran to completion. When the time budget cut it off early, some targets
  // past the stopping point were never inspected this run, so "not in seenFileIds" no longer
  // reliably means "deleted from Drive" — it might just mean "not reached yet". Skipping the
  // cleanup in that case is harmless (a genuinely-deleted file's cache entry just lingers one
  // extra run, unused since Pass 3 only iterates `targets`); the alternative — deleting entries
  // for files that still exist but weren't reached — would force them to be needlessly re-read
  // next run, working against the whole point of stopping early.
  if (budgetStoppedDataClaim === 0) {
    Object.keys(fileCache).forEach(fileId => {
      if (!seenFileIds[fileId]) delete fileCache[fileId];
    });
  }

  // Pass 2b: same incremental reuse-or-reread logic as Pass 2, but for Platform Fee files (their
  // own separate cache — see PLATFORM_FEE_FILE_CACHE_NAME's comment).
  const feeFileCache = loadPlatformFeeFileCache_();
  const seenFeeFileIds = {};
  let feeReused = 0, feeReprocessed = 0;
  let budgetStoppedFee = 0;
  for (let fi = 0; fi < feeTargets.length; fi++) {
    const t = feeTargets[fi];
    const cached = feeFileCache[t.fileId];
    const isFresh = cached && cached.modifiedTime === t.modifiedTime && cached.v === PLATFORM_FEE_FILE_CACHE_VERSION;

    if (!isFresh && overBudget_()) {
      budgetStoppedFee = feeTargets.length - fi;
      break; // stop starting new reads — see TIME_BUDGET_MS comment above refreshData()
    }

    seenFeeFileIds[t.fileId] = true;

    if (isFresh) {
      feeReused++;
      continue;
    }

    const contribution = readPlatformFeeContribution_(t, warnings);
    if (!contribution) continue;
    feeReprocessed++;
    feeFileCache[t.fileId] = {
      modifiedTime: t.modifiedTime,
      v: PLATFORM_FEE_FILE_CACHE_VERSION,
      totals: contribution.totals,
      wh: contribution.wh,
    };
  }
  // Same reasoning as the Data Claim cleanup above — skip when the budget cut this pass short.
  if (budgetStoppedFee === 0) {
    Object.keys(feeFileCache).forEach(fileId => {
      if (!seenFeeFileIds[fileId]) delete feeFileCache[fileId];
    });
  }

  // Pass 3: recombine every file's (reused or freshly-read) contribution into the final totals.
  // Iterates `targets` (not fileCache's keys) specifically so brand/month always come from the
  // CURRENT normalizeBrand_ output, never from a stale cached value — see the note above.
  // Marketplace stays a separate, flat, whole-dataset breakdown (mpMap/MP_DATA) as before — the
  // dashboard's Marketplace Overview tab was removed, but this is left computed/cached in case
  // it's wanted again later; it costs nothing extra to keep computing. Warehouse is different:
  // it's nested INSIDE each brand/month row (dataMap[key].warehouses), since the dashboard shows
  // it as an expandable breakdown of that specific column, not a separate tab.
  const dataMap = {}; // "brand|month" -> { brand, month, uniq, qty, sales, claim, rbp, warehouses:{}, marketplaces:{} }
  const mpMap = {};   // marketplace -> { marketplace, uniq, qty, sales, claim, rbp }

  targets.forEach(t => {
    const entry = fileCache[t.fileId];
    if (!entry) return; // file failed to read this run (contribution was null) — already warned, skip
    const dKey = t.brand + '|' + t.month;
    if (!dataMap[dKey]) {
      dataMap[dKey] = { brand: t.brand, month: t.month, uniq: 0, qty: 0, sales: 0, claim: 0, rbp: 0, surplus: 0, chipIn: 0, promoFundFrontMargin: 0, warehouses: {}, marketplaces: {} };
    }
    const d = dataMap[dKey];
    d.uniq += entry.data.custRefCount;
    d.qty += entry.data.qty;
    d.sales += entry.data.sales;
    d.claim += entry.data.claim;
    d.rbp += entry.data.rbp;
    d.surplus += entry.data.surplus || 0;
    d.chipIn += entry.data.chipIn || 0;
    // Promo Fund FRONT Margin — NOT APPLICABLE to ABC Official Store (see readFileContribution_'s
    // promoFundFrontMarginIdx, hardcoded to 0 for this fork). Summed here purely for shape parity
    // with the base file — always adds 0 for every row.
    d.promoFundFrontMargin += entry.data.promoFundFrontMargin || 0;

    Object.keys(entry.mp || {}).forEach(rawMarketplace => {
      const c = entry.mp[rawMarketplace];
      const marketplace = marketplaceCategory_(rawMarketplace); // ORAMI (B2B) / NON-ORAMI (B2C) — see marketplaceCategory_
      if (!mpMap[marketplace]) {
        mpMap[marketplace] = { marketplace: marketplace, uniq: 0, qty: 0, sales: 0, claim: 0, rbp: 0 };
      }
      const m = mpMap[marketplace];
      m.uniq += c.custRefCount;
      m.qty += c.qty;
      m.sales += c.sales;
      m.claim += c.claim;
      m.rbp += c.rbp;
      // Per-row marketplace breakdown (mirrors the Consignment pipeline) — lets the Outright
      // tab's columns expand by marketplace via the same +M button.
      if (!d.marketplaces[marketplace]) {
        d.marketplaces[marketplace] = { marketplace: marketplace, uniq: 0, qty: 0, sales: 0, claim: 0, rbp: 0, surplus: 0, chipIn: 0, otherRevenue: 0, promoFundFrontMargin: 0 };
      }
      const dm = d.marketplaces[marketplace];
      dm.uniq += c.custRefCount;
      dm.qty += c.qty;
      dm.sales += c.sales;
      dm.claim += c.claim;
      dm.rbp += c.rbp;
      dm.surplus += c.surplus || 0;
      dm.chipIn += c.chipIn || 0;
      dm.promoFundFrontMargin += c.promoFundFrontMargin || 0;
    });

    Object.keys(entry.wh || {}).forEach(warehouse => {
      const c = entry.wh[warehouse];
      if (!d.warehouses[warehouse]) {
        d.warehouses[warehouse] = { warehouse: warehouse, uniq: 0, qty: 0, sales: 0, claim: 0, rbp: 0, surplus: 0, chipIn: 0, promoFundFrontMargin: 0, mpUniq: {}, mpRbp: {} };
      }
      const w = d.warehouses[warehouse];
      w.uniq += c.custRefCount;
      w.qty += c.qty;
      w.sales += c.sales;
      w.claim += c.claim;
      w.rbp += c.rbp;
      w.surplus += c.surplus || 0;
      w.chipIn += c.chipIn || 0;
      w.promoFundFrontMargin += c.promoFundFrontMargin || 0;
      // Order-count cross-tab carried through so Pass 4 can split THIS warehouse's Operational &
      // Fulfillment Cost across marketplaces — see readFileContribution_'s `wh[...].mpUniq`.
      Object.keys(c.mpUniq || {}).forEach(rawMarketplace => {
        const marketplace = marketplaceCategory_(rawMarketplace);
        w.mpUniq[marketplace] = (w.mpUniq[marketplace] || 0) + c.mpUniq[rawMarketplace];
      });
      // RBP cross-tab, same purpose as mpUniq above but for MOGTM Distributor Fee (rate × rbp)
      // instead of O&F cost (rate × order count) — see readFileContribution_'s `wh[...].mpRbp`.
      // Dashboard.html allocates the actual fee client-side (the MOGTM rate table lives there);
      // this just carries the raw per-(warehouse, marketplace) rbp split to it.
      Object.keys(c.mpRbp || {}).forEach(rawMarketplace => {
        const marketplace = marketplaceCategory_(rawMarketplace);
        w.mpRbp[marketplace] = (w.mpRbp[marketplace] || 0) + c.mpRbp[rawMarketplace];
      });
    });
  });

  // Every dataMap row (and its warehouse buckets) gets the Platform Fee fields defaulted to 0
  // here, BEFORE Pass 3b adds real contributions on top — so a brand/month with no matching
  // Platform Fee file still has these fields present (as 0) rather than undefined, same as
  // pickPack/rentWarehouse/consumables get defaulted in Pass 4 below.
  Object.keys(dataMap).forEach(dKey => {
    const d = dataMap[dKey];
    ALL_PLATFORM_FEE_KEYS.forEach(k => { d[k] = d[k] || 0; });
    Object.keys(d.warehouses).forEach(whName => {
      const w = d.warehouses[whName];
      ALL_PLATFORM_FEE_KEYS.forEach(k => { w[k] = w[k] || 0; });
    });
    Object.keys(d.marketplaces).forEach(mpName => {
      const dm = d.marketplaces[mpName];
      ALL_PLATFORM_FEE_KEYS.forEach(k => { dm[k] = dm[k] || 0; });
    });
  });

  // Pass 3b: recombine Platform Fee files (Marketplace Fee / Other Marketplace Fee + their
  // breakdown fields) the same way Pass 3 recombined Data Claim files — per brand/month, and per
  // warehouse bucket. A brand/month with a Platform Fee file but no Data Claim file (shouldn't
  // normally happen, but not assumed) still gets a dataMap row created for it here, exactly like
  // Pass 3 does, so its fee data isn't silently dropped.
  feeTargets.forEach(t => {
    const entry = feeFileCache[t.fileId];
    if (!entry) return; // file failed to read this run — already warned, skip
    const dKey = t.brand + '|' + t.month;
    if (!dataMap[dKey]) {
      dataMap[dKey] = { brand: t.brand, month: t.month, uniq: 0, qty: 0, sales: 0, claim: 0, rbp: 0, surplus: 0, chipIn: 0, promoFundFrontMargin: 0, warehouses: {}, marketplaces: {} };
      ALL_PLATFORM_FEE_KEYS.forEach(k => { dataMap[dKey][k] = 0; });
    }
    const d = dataMap[dKey];
    ALL_PLATFORM_FEE_KEYS.forEach(k => { d[k] += entry.totals[k] || 0; });

    Object.keys(entry.wh || {}).forEach(warehouse => {
      if (!d.warehouses[warehouse]) {
        d.warehouses[warehouse] = { warehouse: warehouse, uniq: 0, qty: 0, sales: 0, claim: 0, rbp: 0, surplus: 0, chipIn: 0, promoFundFrontMargin: 0 };
        ALL_PLATFORM_FEE_KEYS.forEach(k => { d.warehouses[warehouse][k] = 0; });
      }
      const w = d.warehouses[warehouse];
      const c = entry.wh[warehouse];
      ALL_PLATFORM_FEE_KEYS.forEach(k => { w[k] = (w[k] || 0) + (c[k] || 0); });
    });

    // Attribute this fee file's totals to the matching per-marketplace bucket on the same row
    // (t.marketplace comes from the fee file's name, e.g. TikTok/Tokopedia) — mirrors the
    // Consignment pipeline so the Outright +M marketplace expand shows real fee splits too.
    // 2026-09-26: the file-name marketplace (TikTok/Tokopedia/...) is mapped to its category first
    // — without this, "TikTok" would never match the "NON-ORAMI (B2C)" bucket and the fee would
    // silently drop out of the marketplace breakdown (total stays right, split wouldn't add up).
    const feeMarketplace = t.marketplace ? marketplaceCategory_(t.marketplace) : null;
    if (feeMarketplace && d.marketplaces[feeMarketplace]) {
      const dm = d.marketplaces[feeMarketplace];
      ALL_PLATFORM_FEE_KEYS.forEach(k => { dm[k] = (dm[k] || 0) + (entry.totals[k] || 0); });
    }
  });

  // Pass 3c (2026-10-13): Platform Fee Absorb by SIRCLO from the "YYYYMM - Summary MP Fee - <Brand>"
  // files — OVERRIDES the figure Pass 3b summed from the Platform Fee files for that brand/month.
  // See the ABSORB_SUMMARY_* constants near the top of the file for the full rationale.
  const absorbSummaryByKey = {};
  absorbTargets.forEach(t => {
    if (overBudget_()) {
      warnings.push('Time budget reached — "' + t.fileName + '" (Platform Fee Absorb by SIRCLO) not read this refresh; the Platform Fee-file figure is shown for ' + t.brand + ' ' + t.month + ' until the next run.');
      return;
    }
    const res = readAbsorbSummary_(t, warnings);
    if (!res) return;
    const dKey = t.brand + '|' + t.month;
    const prev = absorbSummaryByKey[dKey];
    if (prev) {
      warnings.push('Two Summary MP Fee files found for ' + t.brand + ' ' + t.month + ' ("' + prev.target.fileName + '" and "' + t.fileName + '") — using the more recently modified one.');
      if (prev.target.modifiedTime > t.modifiedTime) return;
    }
    absorbSummaryByKey[dKey] = res;
  });
  Object.keys(absorbSummaryByKey).forEach(dKey => {
    const s = absorbSummaryByKey[dKey];
    const t = s.target;
    if (!dataMap[dKey]) {
      dataMap[dKey] = { brand: t.brand, month: t.month, uniq: 0, qty: 0, sales: 0, claim: 0, rbp: 0, surplus: 0, chipIn: 0, promoFundFrontMargin: 0, warehouses: {}, marketplaces: {} };
      ALL_PLATFORM_FEE_KEYS.forEach(k => { dataMap[dKey][k] = 0; });
    }
    const d = dataMap[dKey];
    d.absorbBySirclo = s.total;
    // Marketplace buckets: exact split from the file (ORAMI (B2B) vs NON-ORAMI (B2C)).
    Object.keys(d.marketplaces).forEach(mpName => { d.marketplaces[mpName].absorbBySirclo = 0; });
    Object.keys(s.byCat).forEach(cat => {
      if (!s.byCat[cat]) return;
      if (!d.marketplaces[cat]) {
        d.marketplaces[cat] = { marketplace: cat, uniq: 0, qty: 0, sales: 0, claim: 0, rbp: 0, surplus: 0, chipIn: 0, otherRevenue: 0, promoFundFrontMargin: 0 };
        ALL_PLATFORM_FEE_KEYS.forEach(k => { d.marketplaces[cat][k] = 0; });
      }
      d.marketplaces[cat].absorbBySirclo = s.byCat[cat];
    });
    // Warehouse buckets: the file has no warehouse column, so allocate pro-rata to sales (fallback:
    // order count, then equal shares) so the warehouse expand still adds up to the brand/month total.
    const whNames = Object.keys(d.warehouses);
    let baseSales = 0, baseUniq = 0;
    whNames.forEach(n => { baseSales += d.warehouses[n].sales || 0; baseUniq += d.warehouses[n].uniq || 0; });
    whNames.forEach(n => {
      const w = d.warehouses[n];
      w.absorbBySirclo = baseSales > 0 ? s.total * ((w.sales || 0) / baseSales)
        : baseUniq > 0 ? s.total * ((w.uniq || 0) / baseUniq)
        : s.total / whNames.length;
    });
  });
  // Visibility: brand/months that still show a Platform Fee-file figure because no Summary MP Fee file exists.
  const absorbFallbackMonths = Object.keys(dataMap)
    .filter(k => !absorbSummaryByKey[k] && (dataMap[k].absorbBySirclo || 0) !== 0)
    .map(k => k.replace('|', ' '));
  if (absorbFallbackMonths.length) {
    warnings.push('Platform Fee Absorb by SIRCLO: no "Summary MP Fee" file found for ' + absorbFallbackMonths.join(', ') + ' — the Platform Fee-file figure is used for those.');
  }

  // Pass 4: Operational & Fulfillment Cost (Pick Pack / Rent Warehouse / Consumables). Separate
  // from the file-combination logic above on purpose — this allocates cost data across the
  // warehouse breakdown Pass 3 just finished building, using each brand's already-final
  // per-warehouse Number of Order. Computed per warehouse bucket first (so the warehouse
  // expand/collapse breakdown shows real per-warehouse cost too, not just a brand/month total),
  // then summed up into the brand/month row.
  //
  // REVISED 2026-09-12 per Zoltraak: Rent Warehouse now sources its cost (and a new CBM Usage
  // figure) from the CBM-based sheet (see the "RENT WAREHOUSE (CBM-based)" section above) instead
  // of loadWarehouseFeeRates_'s blended Rate Per Order — Pick Pack and Consumables are UNCHANGED,
  // still rate × Number of Order from that same Warehouse Breakdown sheet as before. A miss on
  // either source (unmapped code, no rate for that month, or — for Rent Warehouse specifically —
  // no matching monthly tab/brand row/WHP cost column in the new sheet) contributes $0 for
  // Pick Pack/Consumables, or falls back to the old rate × Number of Order calculation for Rent
  // Warehouse specifically, rather than erroring — see loadWarehouseFeeRates_'s and
  // loadRentWarehouseCbmSheet_'s own doc comments.
  const warehouseFeeRates = loadWarehouseFeeRates_(warnings);
  const warnedWarehousePrefixes = {};
  const rentWarehouseWhpMap = loadRentWarehouseWhpMap_(warnings); // null if Master Data Warehouse couldn't be read
  const rentWarehouseCbmSheetByTab = {}; // month tab name -> loadRentWarehouseCbmSheet_ result (or null), fetched once per tab
  function getRentWarehouseCbmSheet_(monthNum) {
    const tabName = RENT_WAREHOUSE_MONTH_TAB_NAME[monthNum];
    if (!tabName) return null;
    if (!Object.prototype.hasOwnProperty.call(rentWarehouseCbmSheetByTab, tabName)) {
      rentWarehouseCbmSheetByTab[tabName] = loadRentWarehouseCbmSheet_(tabName, warnings);
    }
    return rentWarehouseCbmSheetByTab[tabName];
  }
  const warnedRentWarehouseFallback = {}; // dedupe "used old calculation instead" warnings

  Object.keys(dataMap).forEach(dKey => {
    const d = dataMap[dKey];
    d.pickPack = 0;
    d.rentWarehouse = 0;
    d.rentWarehouseCbm = 0;
    // rentWarehouseCbmWhpTotals — added 2026-09-14 per Zoltraak's "%CBM Usage vs Total WHP" request.
    // An object keyed by "<whp>||<entity>||<month>" (never a plain summed number — see
    // loadRentWarehouseCbmSheet_'s whpEntityTotals comment and Dashboard.html's mergeWhpTotals_/
    // sumWhpTotals_ for why), populated below whenever a warehouse bucket resolves to a real WHP
    // with CBM data this month.
    d.rentWarehouseCbmWhpTotals = {};
    d.consumables = 0;
    // Defaulted here, BEFORE the year-guard below, same as `d` above — previously these were only
    // ever set inside the per-warehouse loop further down, which the year-guard skips entirely for
    // a non-WAREHOUSE_FEE_YEAR month. That left whEntry/dm's pickPack/rentWarehouse/consumables
    // simply undefined (not 0) for any month outside WAREHOUSE_FEE_YEAR — harmless today
    // (everything currently in the sheet is WAREHOUSE_FEE_YEAR), but would have shown up as soon
    // as a later year's data arrived. Also now defaults the per-marketplace buckets the same way,
    // for the new marketplace cost allocation below.
    Object.keys(d.warehouses).forEach(whName => {
      d.warehouses[whName].pickPack = 0;
      d.warehouses[whName].rentWarehouse = 0;
      d.warehouses[whName].rentWarehouseCbm = 0;
      d.warehouses[whName].rentWarehouseCbmWhpTotals = {}; // see d.rentWarehouseCbmWhpTotals above
      d.warehouses[whName].consumables = 0;
    });
    Object.keys(d.marketplaces).forEach(mpName => {
      d.marketplaces[mpName].pickPack = 0;
      d.marketplaces[mpName].rentWarehouse = 0;
      d.marketplaces[mpName].rentWarehouseCbm = 0;
      d.marketplaces[mpName].consumables = 0;
    });
    if (d.month.slice(0, 4) !== WAREHOUSE_FEE_YEAR) return; // Breakdown sheet only covers WAREHOUSE_FEE_YEAR
    const entity = BRAND_ENTITY_OVERRIDES[d.brand] || DEFAULT_WAREHOUSE_ENTITY;
    const monthNum = d.month.slice(5, 7);

    // ---- Pick Pack & Consumables: unchanged rate × Number of Order calculation ----
    Object.keys(d.warehouses).forEach(whName => {
      const whEntry = d.warehouses[whName];
      const canonical = mapWarehouseToCanonical_(whName, warnings, warnedWarehousePrefixes);
      if (!canonical) return;
      ['pickPack', 'consumables'].forEach(costKey => {
        const rate = lookupWarehouseFeeRate_(warehouseFeeRates, canonical, costKey, entity, monthNum);
        const cost = rate * whEntry.uniq;
        whEntry[costKey] = cost;
        d[costKey] += cost;
        // Split this warehouse's cost across marketplaces, per Zoltraak 2026-08-16: "follow the
        // order's location [warehouse] for the rate, and use that marketplace's own order count
        // within it" — since every order has exactly one warehouse and one marketplace, this is
        // the EXACT allocation (not an estimate): the same per-order rate this warehouse's whole
        // bucket was charged, applied to just the slice of its orders that came through each
        // marketplace (whEntry.mpUniq — see readFileContribution_/Pass 3 above).
        Object.keys(whEntry.mpUniq || {}).forEach(marketplace => {
          if (!d.marketplaces[marketplace]) return; // shouldn't normally happen — same source rows feed both
          const mpCost = rate * whEntry.mpUniq[marketplace];
          d.marketplaces[marketplace][costKey] += mpCost;
        });
      });
    });

    // ---- Rent Warehouse: CBM-based source, per-(warehouse) fallback to the old calculation ----
    const cbmSheet = getRentWarehouseCbmSheet_(monthNum); // null => every warehouse this month falls back

    // Group this brand's warehouse buckets by resolved+normalized WHP first — per Zoltraak
    // 2026-09-12 ("kalau ada lebih dari satu warehouse asli resolve ke WHP yang sama, tolong
    // prorate berdasarkan order number, tidak boleh double counting"): the new sheet only knows
    // ONE combined cost/CBM figure per (Brand, WHP, month), so if more than one of this brand's
    // real warehouse buckets resolve to that same WHP, that one figure is split across them by
    // each bucket's own share of Number of Order within the group — never assigned in full to
    // each bucket independently (which would double-count it in d.rentWarehouse's own sum below).
    const whpGroups = {}; // normalized WHP -> [whName, ...]
    Object.keys(d.warehouses).forEach(whName => {
      const rawWhp = rentWarehouseWhpMap ? rentWarehouseWhpMap[whName.toLowerCase()] : null;
      if (!rawWhp) return; // unresolved -> this bucket falls back individually below, not grouped
      const whp = normalizeRentWarehouseWhp_(rawWhp);
      if (!whpGroups[whp]) whpGroups[whp] = [];
      whpGroups[whp].push(whName);
    });

    Object.keys(d.warehouses).forEach(whName => {
      const whEntry = d.warehouses[whName];
      let assignedCost = null, assignedCbm = null; // null = not yet resolved via the new source

      const rawWhp = rentWarehouseWhpMap ? rentWarehouseWhpMap[whName.toLowerCase()] : null;
      if (cbmSheet && rawWhp) {
        const whp = normalizeRentWarehouseWhp_(rawWhp);
        const found = lookupRentWarehouseCbmAndCost_(cbmSheet, d.brand, whp);
        if (found) {
          const group = whpGroups[whp] || [whName];
          if (group.length <= 1) {
            assignedCost = found.cost;
            assignedCbm = found.cbm;
          } else {
            const sumUniq = group.reduce((s, wn) => s + (d.warehouses[wn].uniq || 0), 0);
            // Even split only in the (expected-rare) case every bucket in the group has 0 orders
            // this month — there's no order-count basis to prorate by then, but the total still
            // must not be assigned in full to more than one bucket.
            const share = sumUniq > 0 ? (whEntry.uniq || 0) / sumUniq : (1 / group.length);
            assignedCost = found.cost * share;
            assignedCbm = found.cbm * share;
          }
          // %CBM Usage denominator — added 2026-09-14 per Zoltraak. Same TOTAL regardless of how
          // many of this brand's raw warehouse buckets share this WHP (proration above only applies
          // to the numerator, assignedCbm) — recorded once per WHP+entity+month combination, keyed
          // (not summed) so Dashboard.html can merge it correctly across brands/months later. Only
          // recorded when there's an actual positive total to divide by — a 0/missing total just
          // means no %CBM Usage note shows for this bucket, same "don't clutter empty cells"
          // convention every other cellNote in this codebase already follows.
          const whpTotal = lookupRentWarehouseWhpTotal_(cbmSheet, whp, entity);
          if (whpTotal !== null && whpTotal > 0) {
            const totalKey = whp + '||' + entity + '||' + d.month;
            whEntry.rentWarehouseCbmWhpTotals[totalKey] = whpTotal;
            d.rentWarehouseCbmWhpTotals[totalKey] = whpTotal;
          }
        }
      }

      // FIX 2026-10-13: kalau tab bulan ini terbaca DAN brand ini punya baris di tab tersebut (untuk
      // principal ini), maka sheet adalah sumber kebenaran — bucket warehouse yang tidak ketemu di
      // Master Data Warehouse / WHP-nya tidak punya kolom cost di sheet diberi Rp 0 (+ warning),
      // BUKAN dihitung ulang dengan rate × Number of Order. Fallback lama hanya dipakai bila tab
      // bulan tidak ada / brand tidak ada di tab tersebut.
      if (assignedCost === null && cbmSheet && cbmSheet.brandRows[String(d.brand || '').trim().toLowerCase()]) {
        assignedCost = 0;
        assignedCbm = 0;
        const zeroKey = 'zero||' + d.brand + '||' + whName + '||' + d.month;
        if (!warnedRentWarehouseFallback[zeroKey]) {
          warnedRentWarehouseFallback[zeroKey] = true;
          warnings.push('Rent Warehouse — "' + d.brand + '" / "' + whName + '" (' + d.month + '): brand ada di tab bulan ini tapi warehouse ini tidak ter-mapping ke WHP yang punya kolom cost — Rent Warehouse diisi 0 (sheet = sumber kebenaran), tidak lagi pakai rate × Number of Order.');
        }
      }

      if (assignedCost === null) {
        // Fallback: the exact same rate × Number of Order calculation Rent Warehouse used before
        // this revision. Triggers per-warehouse whenever the new source can't answer for this
        // specific (brand, warehouse, month) — no monthly tab yet, this warehouse isn't in Master
        // Data Warehouse, this brand isn't a row in that tab, or its WHP has no cost column at all
        // (e.g. "Vertikal" — see loadRentWarehouseCbmSheet_'s own comment).
        const canonical = mapWarehouseToCanonical_(whName, warnings, warnedWarehousePrefixes);
        const rate = lookupWarehouseFeeRate_(warehouseFeeRates, canonical, 'rentWarehouse', entity, monthNum);
        assignedCost = rate * whEntry.uniq;
        assignedCbm = 0; // the old calculation has no CBM concept — Dashboard.html shows 0/blank here
        const warnKey = d.brand + '||' + whName + '||' + d.month;
        if (!warnedRentWarehouseFallback[warnKey]) {
          warnedRentWarehouseFallback[warnKey] = true;
          warnings.push('Rent Warehouse — "' + d.brand + '" / "' + whName + '" (' + d.month + ') not found in the new CBM-based sheet — used the old rate × Number of Order calculation instead.');
        }
      }

      whEntry.rentWarehouse = assignedCost;
      whEntry.rentWarehouseCbm = assignedCbm;
      d.rentWarehouse += assignedCost;
      d.rentWarehouseCbm += assignedCbm;

      // Marketplace split — same "per-order share of this warehouse's own effective rate"
      // allocation Pick Pack/Consumables use above (whEntry.mpUniq), just derived from the
      // assigned total (a direct lookup or prorated share, not a flat rate) rather than looked up
      // directly. The new sheet has no marketplace-level CBM/cost data to split by instead.
      const effRate = whEntry.uniq ? (assignedCost / whEntry.uniq) : 0;
      const effCbmRate = whEntry.uniq ? (assignedCbm / whEntry.uniq) : 0;
      Object.keys(whEntry.mpUniq || {}).forEach(marketplace => {
        if (!d.marketplaces[marketplace]) return;
        d.marketplaces[marketplace].rentWarehouse += effRate * whEntry.mpUniq[marketplace];
        d.marketplaces[marketplace].rentWarehouseCbm += effCbmRate * whEntry.mpUniq[marketplace];
      });
    });
  });

  // Pass 5: Other Revenue — not applicable to this fork's brand group (no external source for
  // it), so every row's otherRevenue simply resets to 0. Field kept (not removed) so
  // Dashboard.html's generic PLATFORM_FEE_SUM_KEYS summing / ROW_DEFS keep working unchanged.
  Object.keys(dataMap).forEach(dKey => {
    const d = dataMap[dKey];
    d.otherRevenue = 0;
    Object.keys(d.warehouses).forEach(whName => { d.warehouses[whName].otherRevenue = 0; });
    Object.keys(d.marketplaces).forEach(mpName => { d.marketplaces[mpName].otherRevenue = 0; });
  });

  // ---- Promo Fund Front/Back Margin: NOT APPLICABLE to ABC Official Store ----
  // The base (Betadine Group) fork has a Promo-Fund-specific Front/Back Margin feature here,
  // computed from a brand-specific external spreadsheet and a per-row "PromoFund _FM" column that
  // only Betadine's own Data Claim Internal files carry. ABC Official Store has no such feature
  // (confirmed by Zoltraak 2026-09-14) — this whole computation block has been removed for this
  // fork. `promoFundFrontMargin`/`promoFundBackMargin` are never populated for ABC's dataMap
  // entries, so the `|| 0` guards at the DATA row-construction step below (and the same guards in
  // Dashboard.html's Gross Profit formula) safely resolve them to a permanent $0 — no dangling
  // reference, no separate "disable this feature" flag needed.

  const DATA = Object.keys(dataMap).map(k => {
    const d = dataMap[k];
    const row = {
      brand: d.brand,
      month: d.month,
      uniq: d.uniq,
      qty: d.qty,
      sales: d.sales,
      claim: d.claim,
      rbp: d.rbp,
      surplus: d.surplus || 0,
      chipIn: d.chipIn || 0,
      otherRevenue: d.otherRevenue || 0,
      promoFundFrontMargin: d.promoFundFrontMargin || 0,
      promoFundBackMargin: d.promoFundBackMargin || 0,
      pickPack: d.pickPack,
      rentWarehouse: d.rentWarehouse,
      // BUG FIX 2026-09-12: rentWarehouseCbm was computed on `d` (and on every d.warehouses[w]/
      // d.marketplaces[mp] entry, which DO get sent through wholesale below) during Pass 4, but was
      // never copied onto this top-level `row` object — meaning every MAIN brand/month column
      // (and, downstream, Grand Total / period-aggregate columns, which are built by summing these
      // same top-level DATA rows) silently read `undefined` -> 0 for CBM Usage/Rent Warehouse per
      // CBM, even though the per-Warehouse/Marketplace breakdown columns were already correct.
      // Caught by inspecting this construction directly — the earlier test suites only exercised
      // deriveMetrics/computeGrand with hand-built row objects that already had rentWarehouseCbm
      // set, so they never caught that Code.gs's own output was missing this field.
      rentWarehouseCbm: d.rentWarehouseCbm,
      // rentWarehouseCbmWhpTotals — see its own comment above (Pass 4 reset block) and
      // loadRentWarehouseCbmSheet_'s whpEntityTotals comment. Explicitly copied here for the exact
      // same reason the 2026-09-12 bug-fix comment above documents for rentWarehouseCbm itself —
      // this is a new top-level `d` field that does NOT flow through automatically.
      rentWarehouseCbmWhpTotals: d.rentWarehouseCbmWhpTotals || {},
      consumables: d.consumables,
      warehouses: Object.keys(d.warehouses).map(w => d.warehouses[w]).sort((a, b) => b.sales - a.sales),
      marketplaces: Object.keys(d.marketplaces).map(mp => d.marketplaces[mp]).sort(compareMarketplaceBuckets_), // ORAMI (B2B) always first
    };
    ALL_PLATFORM_FEE_KEYS.forEach(pk => { row[pk] = d[pk]; });
    return row;
  }).sort((a, b) => b.sales - a.sales);
  const MP_DATA = Object.keys(mpMap).map(k => mpMap[k]).sort(compareMarketplaceBuckets_); // ORAMI (B2B) always first

  // If the time budget cut either pass short, say so — both in the Logger (so it's visible in
  // Executions) and in payload.warnings (so it surfaces in the dashboard's own warnings banner,
  // since the cached data this run produced may be missing some brand/month figures until a
  // later run finishes the backlog). Not an error — just an incomplete-this-run notice.
  if (budgetStoppedDataClaim > 0 || budgetStoppedFee > 0) {
    const parts = [];
    if (budgetStoppedDataClaim > 0) parts.push(budgetStoppedDataClaim + ' Data Claim file(s)');
    if (budgetStoppedFee > 0) parts.push(budgetStoppedFee + ' Platform Fee file(s)');
    warnings.push('Time budget reached (' + Math.round((Date.now() - startTime_) / 1000) + 's elapsed) — ' +
      parts.join(' and ') + ' not yet read this run. Their existing cached figures (if any) are kept as-is; ' +
      'run refreshData again (or wait for the next scheduled run) to pick up where this left off.');
  }
  // No Consignment tab in this fork — the cache payload only ever has DATA/MP_DATA/warnings.
  const payload = {
    generatedAt: new Date().toISOString(),
    DATA: DATA,
    MP_DATA: MP_DATA,
    warnings: warnings,
  };

  saveJsonToDriveCache_(JSON.stringify(payload));
  saveFileCache_(fileCache);
  savePlatformFeeFileCache_(feeFileCache);
  Logger.log('Refreshed: ' + DATA.length + ' brand/month rows, ' + MP_DATA.length + ' marketplaces. ' +
    reused + ' Data Claim file(s) unchanged (skipped), ' + reprocessed + ' (re)read. ' +
    feeReused + ' Platform Fee file(s) unchanged (skipped), ' + feeReprocessed + ' (re)read. ' +
    (budgetStoppedDataClaim > 0 ? budgetStoppedDataClaim + ' Data Claim file(s) not yet reached (time budget). ' : '') +
    (budgetStoppedFee > 0 ? budgetStoppedFee + ' Platform Fee file(s) not yet reached (time budget). ' : '') +
    'Warnings: ' + warnings.length);
  if (warnings.length) Logger.log(warnings.join('\n'));
  return payload;}



/**
 * Reads one target file and returns its contribution as
 *   { data: {...}, mp: { marketplace: {...} }, wh: { warehouse: {...} } }
 * or null (with a warning pushed) if it couldn't be read/parsed.
 *
 * NOTE: custRefCount is a per-file DISTINCT count of Customer_Reference values, not a full set —
 * counts are summed across files for the same brand/month when recombining. This assumes the
 * same customer reference doesn't appear in two different files for the same brand/month, which
 * matches how this data has been produced so far (confirmed brand/month values don't repeat
 * across files). If that ever changes, this would need to store the full ID set instead of just
 * a count to dedupe correctly across files.
 */
function readFileContribution_(t, warnings) {
  const values = readDataClaimSheet_(t.fileId, t.fileName, warnings);
  if (!values) return null; // readDataClaimSheet_ already pushed a warning explaining why
  if (values.length < 2) {
    warnings.push('"' + t.fileName + '" came back empty — skipped.');
    return null;
  }
  const header = values[0];
  const idx = {};
  // Normalized (see normalizeHeaderName_) so e.g. "Customer_Reference" and "Customer Reference"
  // are treated as the same column — belt-and-suspenders alongside findAndReadSheet_'s own
  // normalized required-columns check, since this idx map is built fresh here from the raw header
  // row rather than reusing anything findAndReadSheet_ already normalized internally.
  header.forEach((h, hi) => { idx[normalizeHeaderName_(h)] = hi; });

  // Rebates Revenue (`claim`) column — "Claim_10pct_RBP" for Unilever Group brands, "Claim" for
  // everyone else. See UNILEVER_GROUP_BRANDS' comment #1. Built into a COPY of COL (not a mutation
  // of the shared constant) so the `missing`-columns check below still validates the RIGHT column
  // name for this specific file's brand, and the warning message (if it's absent) names the actual
  // column this file needed, not always "Claim".
  const claimColName = UNILEVER_GROUP_BRANDS.indexOf(t.brand) !== -1
    ? UNILEVER_CLAIM_10PCT_RBP_COL_NAME
    : COL.claim;
  const requiredCols = Object.assign({}, COL, { claim: claimColName });

  const missing = Object.keys(requiredCols).filter(k => !(normalizeHeaderName_(requiredCols[k]) in idx));
  if (missing.length) {
    warnings.push('"' + t.fileName + '" is missing columns: ' + missing.map(k => requiredCols[k]).join(', ') + ' — skipped.');
    return null;
  }
  const custRefIdx = idx[normalizeHeaderName_(COL.customerRef)];
  const marketplaceIdx = idx[normalizeHeaderName_(COL.marketplace)];
  const qtyIdx = idx[normalizeHeaderName_(COL.qty)];
  const salesIdx = idx[normalizeHeaderName_(COL.salesAfterSubsidy)];
  const claimIdx = idx[normalizeHeaderName_(claimColName)];
  const rbpIdx = idx[normalizeHeaderName_(COL.rbpTotal)];
  // Optional — see WAREHOUSE_COL_NAME's comment. undefined here just means this file's rows
  // won't contribute to any warehouse breakdown, everything else still works as normal.
  const warehouseIdx = idx[normalizeHeaderName_(WAREHOUSE_COL_NAME)];
  // Surplus — see SANGHIANG_PERKASA_GROUP_BRANDS' comment. Only looked up at all for those 4
  // brands; every other brand's surplusIdx stays undefined and its rows contribute 0, the same as
  // if the column were simply absent.
  const surplusIdx = SANGHIANG_PERKASA_GROUP_BRANDS.indexOf(t.brand) !== -1
    ? idx[normalizeHeaderName_(SURPLUS_COL_NAME)]
    : undefined;
const chipInIdx = ABC_GROUP_BRANDS.indexOf(t.brand) !== -1
    ? idx[normalizeHeaderName_(CHIP_IN_COL_NAME)]
    : undefined;
  // Promo Fund FRONT Margin — NOT APPLICABLE to ABC Official Store (confirmed by Zoltraak
  // 2026-09-14: no Promo-Fund-equivalent lump-sum feature for this brand). The base (Betadine
  // Group) fork looks this column up per-row for its 2 real brands; this fork hardcodes it to 0
  // below instead (see `promoFundFrontMargin` in the row loop) rather than deleting every
  // downstream reference — the accumulators/DATA row still carry the field for shape parity with
  // the base file, they just always sum 0 for it.

  const data = { custRefs: {}, qty: 0, sales: 0, claim: 0, rbp: 0, surplus: 0, chipIn: 0, promoFundFrontMargin: 0 };
  const mp = {}; // marketplace -> { custRefs, qty, sales, claim, rbp, surplus }
  // warehouse -> { custRefs, qty, sales, claim, rbp, surplus, mp: { marketplace -> { custRefs, qty } } }
  // The nested `mp` here is a SEPARATE, smaller cross-tab (order counts only, not money) from the
  // top-level `mp` above — it exists purely so refreshData's Pass 4 can allocate a warehouse's
  // Operational & Fulfillment Cost across marketplaces using each marketplace's own order count
  // WITHIN that warehouse (since one order has exactly one warehouse and exactly one marketplace,
  // this is the exact allocation, not an estimate — see refreshData Pass 4's comment).
  const wh = {};

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const custRef = row[custRefIdx];
    // Blank Marketplace cells get a placeholder key (added 2026-09-26) instead of being left out of
    // the marketplace buckets, so marketplaceCategory_ files them under NON-ORAMI (B2C) and
    // ORAMI + NON-ORAMI always adds up to the row total.
    const marketplace = String(row[marketplaceIdx] || '').trim() || '(Blank Marketplace)';
    const warehouse = warehouseIdx !== undefined ? String(row[warehouseIdx] || '').trim() : '';
    const qty = Number(row[qtyIdx]) || 0;
    const sales = Number(row[salesIdx]) || 0;
    const claim = Number(row[claimIdx]) || 0;
    const rbp = Number(row[rbpIdx]) || 0;
    const surplus = surplusIdx !== undefined ? (Number(row[surplusIdx]) || 0) : 0;
    const chipIn = chipInIdx !== undefined ? (Number(row[chipInIdx]) || 0) : 0;
    const promoFundFrontMargin = 0; // hardcoded — see the comment above promoFundFrontMarginIdx's old lookup, removed for this fork

    if (custRef) data.custRefs[custRef] = true;
    data.qty += qty;
    data.sales += sales;
    data.claim += claim;
    data.rbp += rbp;
    data.surplus += surplus;
    data.chipIn += chipIn;
    data.promoFundFrontMargin += promoFundFrontMargin;

    if (marketplace) {
      // chipIn: 0 added 2026-09-26 — it was missing here, so `m.chipIn += chipIn` produced NaN, which
      // JSON-serializes to null in the file cache and then summed as 0 in Pass 3: Chip In never showed
      // up in the marketplace (+M) breakdown even though the store-level total was correct.
      if (!mp[marketplace]) mp[marketplace] = { custRefs: {}, qty: 0, sales: 0, claim: 0, rbp: 0, surplus: 0, chipIn: 0, promoFundFrontMargin: 0 };
      const m = mp[marketplace];
      if (custRef) m.custRefs[custRef] = true;
      m.qty += qty;
      m.sales += sales;
      m.claim += claim;
      m.rbp += rbp;
      m.surplus += surplus;
      m.chipIn += chipIn;
      m.promoFundFrontMargin += promoFundFrontMargin;
    }

    if (warehouse) {
      // chipIn: 0 added 2026-09-26 — same NaN bug as the `mp` accumulator above (warehouse +W breakdown).
      if (!wh[warehouse]) wh[warehouse] = { custRefs: {}, qty: 0, sales: 0, claim: 0, rbp: 0, surplus: 0, chipIn: 0, promoFundFrontMargin: 0, mp: {} };
      const w = wh[warehouse];
      if (custRef) w.custRefs[custRef] = true;
      w.qty += qty;
      w.sales += sales;
      w.claim += claim;
      w.rbp += rbp;
      w.surplus += surplus;
      w.chipIn += chipIn;
      w.promoFundFrontMargin += promoFundFrontMargin;
      if (marketplace) {
        // rbp added 2026-08-17 per Zoltraak: MOGTM Distributor Fee (rate × RBP, computed
        // client-side in Dashboard.html from a warehouse's rbp) was always $0 on any marketplace
        // sub-column, because a marketplace bucket has no warehouse of its own to look up a rate
        // for — this per-(warehouse, marketplace) RBP split is what lets the client compute an
        // EXACT marketplace-level MOGTM fee: for each MOGTM-prefixed warehouse, rate × this
        // marketplace's slice of THAT warehouse's rbp, summed across warehouses. custRefs/qty were
        // already here for the existing O&F cost per-marketplace allocation (see mpUniq below).
        if (!w.mp[marketplace]) w.mp[marketplace] = { custRefs: {}, qty: 0, rbp: 0 };
        const wm = w.mp[marketplace];
        if (custRef) wm.custRefs[custRef] = true;
        wm.qty += qty;
        wm.rbp += rbp;
      }
    }
  }

  const mpOut = {};
  Object.keys(mp).forEach(marketplace => {
    const m = mp[marketplace];
    mpOut[marketplace] = {
      custRefCount: Object.keys(m.custRefs).length,
      qty: m.qty, sales: m.sales, claim: m.claim, rbp: m.rbp, surplus: m.surplus, chipIn: m.chipIn,
      promoFundFrontMargin: m.promoFundFrontMargin,
    };
  });

  const whOut = {};
  Object.keys(wh).forEach(warehouse => {
    const w = wh[warehouse];
    // Order-count-only cross-tab (see `wh`'s declaration above) — just enough for Pass 4 to split
    // this warehouse's Operational & Fulfillment Cost across marketplaces.
    const mpUniq = {};
    // RBP-only cross-tab — same shape as mpUniq, but sums rbp instead of counting orders, so
    // Dashboard.html can allocate MOGTM Distributor Fee (rate × rbp) across marketplaces the same
    // exact way Code.gs already allocates O&F cost (rate × order count) across them via mpUniq.
    const mpRbp = {};
    Object.keys(w.mp).forEach(marketplace => {
      mpUniq[marketplace] = Object.keys(w.mp[marketplace].custRefs).length;
      mpRbp[marketplace] = w.mp[marketplace].rbp;
    });
    whOut[warehouse] = {
      custRefCount: Object.keys(w.custRefs).length,
      qty: w.qty, sales: w.sales, claim: w.claim, rbp: w.rbp, surplus: w.surplus, chipIn: w.chipIn,
      promoFundFrontMargin: w.promoFundFrontMargin,
      mpUniq: mpUniq,
      mpRbp: mpRbp,
    };
  });

  return {
    data: { custRefCount: Object.keys(data.custRefs).length, qty: data.qty, sales: data.sales, claim: data.claim, rbp: data.rbp, surplus: data.surplus, chipIn: data.chipIn, promoFundFrontMargin: data.promoFundFrontMargin },
    mp: mpOut,
    wh: whOut,
  };
}

/**
 * Reads Platform Fee Absorb by SIRCLO from a "YYYYMM - Summary MP Fee - <Brand>" file. Returns
 * { target, total, byCat: { <marketplace category>: number }, rows: { <raw marketplace>: number } } or null
 * (warning pushed) when nothing can be read.
 *   - months >= ABSORB_PF_TABS_FROM_MONTH (202608 onward): from the file's "PF <Marketplace>" tabs
 *     (readAbsorbFromPfTabs_); if such a file has no PF tabs but still has the old 'Summary MP Fee' tab, that tab is used.
 *   - earlier months: the 'Summary MP Fee' tab's "Absorb Sirclo" column (readAbsorbFromSummaryTab_).
 */
function readAbsorbSummary_(t, warnings) {
  if (String(t.month) >= ABSORB_PF_TABS_FROM_MONTH) return readAbsorbFromPfTabs_(t, warnings);
  return readAbsorbFromSummaryTab_(t, warnings);
}

/** 0-based column index -> A1 column letters (0 -> A, 25 -> Z, 26 -> AA). */
function absorbColLetter_(idx) {
  let n = idx + 1, out = '';
  while (n > 0) { const m = (n - 1) % 26; out = String.fromCharCode(65 + m) + out; n = Math.floor((n - 1) / 26); }
  return out;
}

/** Cell -> number: numbers as-is; text like "  16,057,528 " / "(1,200)" / "Rp 5.000" cleaned; anything else 0. */
function parseAbsorbAmount_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  if (typeof v !== 'string') return 0;
  let x = v.replace(/[\s\u00a0]/g, '').replace(/^rp\.?/i, '').replace(/,/g, '');
  if (!x || x === '-') return 0;
  let neg = false;
  if (/^\(.*\)$/.test(x)) { neg = true; x = x.slice(1, -1); }
  const n = Number(x);
  if (!isFinite(n)) return 0;
  return neg ? -n : n;
}

/**
 * 202608 onward: the "Absorb Sirclo" grand total of the file's Summary tab (tab "Summary", or "Summary MP Fee"). The layout
 * there is one row per cost line and one column per marketplace, with an "Absorb Sirclo" column; the header row holds
 * "Description" and "Absorb Sirclo". Returns the value on the "Total Claim Support + Marketplace Fee" row; when that row
 * is missing, "Total Claim Support to Principal" + "Total Claim MP Fee & Other MP Fee". null when the tab, header or
 * total row can't be found (the caller then keeps the PF-tab sum).
 */
function readAbsorbSummaryTabTotal_(t, allTabs, warnings) {
  const tab = allTabs.find(s => /^summary(\s+mp\s+fee)?$/i.test(s.title.trim()));
  if (!tab) return null;
  let resp;
  try {
    resp = callSheetsApi_(() => Sheets.Spreadsheets.Values.get(
      t.fileId,
      "'" + tab.title.replace(/'/g, "''") + "'!A1:L80",
      { valueRenderOption: 'UNFORMATTED_VALUE' }
    ));
  } catch (err) {
    warnings.push('Could not read the "' + tab.title + '" tab of "' + t.fileName + '" (Platform Fee Absorb by SIRCLO) — using the PF-tab sum: ' + err);
    return null;
  }
  const rows = (resp && resp.values) || [];
  let headerRow = -1, descCol = -1, absCol = -1;
  for (let r = 0; r < Math.min(rows.length, 20) && headerRow === -1; r++) {
    const norm = (rows[r] || []).map(c => normalizeHeaderName_(c));
    const di = norm.indexOf('description');
    const ai = norm.findIndex(h => h.indexOf('absorb') !== -1 && h.indexOf('%') === -1);
    if (di !== -1 && ai !== -1) { headerRow = r; descCol = di; absCol = ai; }
  }
  if (headerRow === -1) return null;
  let grand = null, support = null, mpFee = null;
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const label = String(row[descCol] === undefined ? '' : row[descCol]).trim().toLowerCase();
    if (!label) continue;
    const v = parseAbsorbAmount_(row[absCol]);
    if (label.indexOf('total claim support + marketplace fee') === 0) grand = v;
    else if (label.indexOf('total claim support to principal') === 0) support = v;
    else if (label.indexOf('total claim mp fee') === 0) mpFee = v;
  }
  if (grand !== null) return grand;
  if (support !== null || mpFee !== null) return (support || 0) + (mpFee || 0);
  return null;
}

/**
 * 202608 onward: Platform Fee Absorb by SIRCLO from the "PF <Marketplace>" tabs of the Summary MP Fee file.
 * Per tab: the header row is the first row (within ABSORB_PF_HEADER_SCAN_ROWS) with a TEXT cell containing
 * "absorb" (row 1 is a totals row, so numbers never match); every column whose header contains "absorb" and is
 * not a rate column ("%", "pct_") is summed down its data rows. Only those columns are fetched (one batchGet),
 * so the large PF Tiktok tab stays cheap. A tab with no Absorb column counts as 0 (warning).
 */
function readAbsorbFromPfTabs_(t, warnings) {
  const q = name => "'" + String(name).replace(/'/g, "''") + "'";
  let meta;
  try {
    meta = callSheetsApi_(() => Sheets.Spreadsheets.get(t.fileId, {
      fields: 'sheets.properties.title,sheets.properties.gridProperties.rowCount',
    }));
  } catch (err) {
    warnings.push('Could not read metadata for "' + t.fileName + '" (Platform Fee Absorb by SIRCLO): ' + err);
    return null;
  }
  const allTabs = (meta.sheets || []).map(s => ({
    title: String(s.properties.title),
    rowCount: (s.properties.gridProperties && s.properties.gridProperties.rowCount) || 0,
  }));
  const pfTabs = allTabs.filter(s => ABSORB_PF_TAB_NAME_PATTERN.test(s.title.trim()));
  if (!pfTabs.length) {
    if (allTabs.some(s => s.title.trim().toLowerCase() === ABSORB_SUMMARY_SHEET_NAME.toLowerCase())) return readAbsorbFromSummaryTab_(t, warnings);
    warnings.push('"' + t.fileName + '": no "PF <Marketplace>" tabs (and no "' + ABSORB_SUMMARY_SHEET_NAME + '" tab) found (Platform Fee Absorb by SIRCLO) — skipped.');
    return null;
  }

  let headBatch;
  try {
    headBatch = callSheetsApi_(() => Sheets.Spreadsheets.Values.batchGet(t.fileId, {
      ranges: pfTabs.map(s => q(s.title) + '!1:' + ABSORB_PF_HEADER_SCAN_ROWS),
      valueRenderOption: 'UNFORMATTED_VALUE',
    }));
  } catch (err) {
    warnings.push('Could not read the PF tab headers of "' + t.fileName + '" (Platform Fee Absorb by SIRCLO): ' + err);
    return null;
  }
  const heads = headBatch.valueRanges || [];

  const plans = []; // { tab, mp, cols: [{ idx, name, totalsCell }], range per col added below }
  pfTabs.forEach((tab, i) => {
    const rows = (heads[i] && heads[i].values) || [];
    let hr = -1, cols = [];
    for (let r = 0; r < rows.length && hr === -1; r++) {
      const found = [];
      (rows[r] || []).forEach((c, j) => {
        if (typeof c !== 'string') return;
        const nh = normalizeHeaderName_(c);
        if (nh.indexOf('absorb') !== -1 && nh.indexOf('%') === -1 && !/^pct\b/.test(nh)) found.push({ idx: j, name: c.trim() });
      });
      if (found.length) { hr = r; cols = found; }
    }
    if (hr === -1) {
      warnings.push('"' + t.fileName + '": tab "' + tab.title + '" has no column with "Absorb" in its header — counted as 0 (Platform Fee Absorb by SIRCLO).');
      return;
    }
    const totalsRow = hr > 0 ? (rows[hr - 1] || []) : null; // the row just above the header holds the tab's column totals
    cols.forEach(c => { c.totalsCell = totalsRow ? totalsRow[c.idx] : undefined; });
    plans.push({ tab: tab, mp: tab.title.trim().replace(ABSORB_PF_TAB_NAME_PATTERN, '$1').trim(), headerRow: hr, cols: cols });
  });
  if (!plans.length) {
    warnings.push('"' + t.fileName + '": none of its PF tabs has an "Absorb" column (Platform Fee Absorb by SIRCLO) — skipped.');
    return null;
  }

  const ranges = [], owners = [];
  plans.forEach(p => p.cols.forEach(c => {
    const L = absorbColLetter_(c.idx);
    const first = p.headerRow + 2; // sheet row right below the header
    const last = Math.max(first, p.tab.rowCount || 50000);
    ranges.push(q(p.tab.title) + '!' + L + first + ':' + L + last);
    owners.push({ plan: p, col: c });
  }));
  let dataBatch;
  try {
    dataBatch = callSheetsApi_(() => Sheets.Spreadsheets.Values.batchGet(t.fileId, { ranges: ranges, valueRenderOption: 'UNFORMATTED_VALUE' }));
  } catch (err) {
    warnings.push('Could not read the PF tab data of "' + t.fileName + '" (Platform Fee Absorb by SIRCLO): ' + err);
    return null;
  }
  const dvr = dataBatch.valueRanges || [];

  const byCat = {}, rawRows = {};
  let total = 0;
  owners.forEach((o, k) => {
    const vals = (dvr[k] && dvr[k].values) || [];
    let sum = 0;
    for (let r = 0; r < vals.length; r++) sum += parseAbsorbAmount_(vals[r] && vals[r][0]);
    if (o.col.totalsCell !== undefined && o.col.totalsCell !== '' && Math.abs(parseAbsorbAmount_(o.col.totalsCell) - sum) > 1) {
      warnings.push('"' + t.fileName + '": tab "' + o.plan.tab.title + '" column "' + o.col.name + '" rows sum to ' + Math.round(sum) +
        ' but its totals row says ' + Math.round(parseAbsorbAmount_(o.col.totalsCell)) + ' (Platform Fee Absorb by SIRCLO) — using the sum of the rows.');
    }
    const cat = marketplaceCategory_(o.plan.mp);
    rawRows[o.plan.mp] = (rawRows[o.plan.mp] || 0) + sum;
    byCat[cat] = (byCat[cat] || 0) + sum;
    total += sum;
  });
  // Reconcile with the Summary tab's own Absorb Sirclo total (see the 2026-10-19 note at ABSORB_PF_TABS_FROM_MONTH):
  // the tab carries hand-typed Absorb amounts (Order Processing fee / Logistic Service Fee) that no PF tab holds.
  const summaryTotal = readAbsorbSummaryTabTotal_(t, allTabs, warnings);
  if (summaryTotal !== null && Math.abs(summaryTotal - total) > 1) {
    const remainder = summaryTotal - total;
    const remCat = marketplaceCategory_('TikTok'); // those lines are TikTok/Tokopedia fees -> NON-ORAMI (B2C)
    byCat[remCat] = (byCat[remCat] || 0) + remainder;
    rawRows['Summary tab (not in PF tabs)'] = remainder;
    warnings.push('"' + t.fileName + '": PF tabs Absorb sum to ' + Math.round(total) + ' but the Summary tab\'s Absorb Sirclo total is ' + Math.round(summaryTotal) +
      ' — using the Summary total; the ' + Math.round(remainder) + ' difference (hand-typed Summary lines, not in any PF tab) is booked on ' + remCat + ' (Platform Fee Absorb by SIRCLO).');
    total = summaryTotal;
  }
  return { target: t, total: total, byCat: byCat, rows: rawRows };
}

/**
 * Months before ABSORB_PF_TABS_FROM_MONTH: reads the "Absorb Sirclo" column of the 'Summary MP Fee' tab of a
 * "YYYYMM - Summary MP Fee - <Brand>" file (see the ABSORB_SUMMARY_* constants). Returns { target, total, byCat: { <marketplace category>:
 * number }, rows: { <raw marketplace>: number } } or null (warning pushed) when the file/tab/columns
 * can't be read. The header row is located by content (a row holding both "Marketplace" and
 * "Absorb Sirclo"), not by position, and the marketplace rows are read until the first blank row or
 * the 'Total' row — the second table further down the tab (per cost stream) is deliberately ignored.
 */
function readAbsorbFromSummaryTab_(t, warnings) {
  let resp;
  try {
    resp = callSheetsApi_(() => Sheets.Spreadsheets.Values.get(
      t.fileId,
      "'" + ABSORB_SUMMARY_SHEET_NAME.replace(/'/g, "''") + "'!A1:L40",
      { valueRenderOption: 'UNFORMATTED_VALUE' }
    ));
  } catch (err) {
    warnings.push('Could not read the "' + ABSORB_SUMMARY_SHEET_NAME + '" tab of "' + t.fileName + '" (Platform Fee Absorb by SIRCLO): ' + err);
    return null;
  }
  const rows = (resp && resp.values) || [];
  let headerRow = -1, mpCol = -1, absCol = -1;
  for (let r = 0; r < Math.min(rows.length, 20) && headerRow === -1; r++) {
    const norm = (rows[r] || []).map(c => normalizeHeaderName_(c));
    const mi = norm.indexOf('marketplace');
    const ai = norm.findIndex(h => h.indexOf('absorb') !== -1 && h.indexOf('%') === -1);
    if (mi !== -1 && ai !== -1) { headerRow = r; mpCol = mi; absCol = ai; }
  }
  if (headerRow === -1) {
    warnings.push('"' + t.fileName + '": no header row with "Marketplace" and "Absorb Sirclo" found in the "' + ABSORB_SUMMARY_SHEET_NAME + '" tab — skipped.');
    return null;
  }
  const byCat = {}, rawRows = {};
  let total = 0, totalRowValue = null, collected = 0;
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const label = String(row[mpCol] === undefined ? '' : row[mpCol]).trim();
    if (!label) { if (collected > 0) break; else continue; }
    const amount = Number(row[absCol]) || 0;
    if (/^total$/i.test(label)) { totalRowValue = amount; break; }
    collected++;
    rawRows[label] = (rawRows[label] || 0) + amount;
    const cat = marketplaceCategory_(label);
    byCat[cat] = (byCat[cat] || 0) + amount;
    total += amount;
  }
  if (!collected) {
    warnings.push('"' + t.fileName + '": no marketplace rows found under the "Absorb Sirclo" header — skipped.');
    return null;
  }
  if (totalRowValue !== null && Math.abs(totalRowValue - total) > 1) {
    warnings.push('"' + t.fileName + '": marketplace rows sum to ' + Math.round(total) + ' but the Total row says ' + Math.round(totalRowValue) + ' (Platform Fee Absorb by SIRCLO) — using the sum of the marketplace rows.');
  }
  return { target: t, total: total, byCat: byCat, rows: rawRows };
}

/**
 * Reads one Platform Fee target file and returns its contribution as
 *   { totals: { <PLATFORM_FEE_KEYS>: number, absorbBySirclo: number }, wh: { warehouse: { same shape } } }
 * or null (with a warning pushed) if it couldn't be read/parsed. Warehouse and the keys listed in
 * PLATFORM_FEE_OPTIONAL_KEYS are the exceptions to "every required column must be present": a file
 * missing Warehouse still contributes to brand/month totals with no per-warehouse breakdown (same
 * as Data Claim files), and a file missing an optional fee column just contributes 0 for that one
 * figure (with a warning) instead of getting skipped entirely — see PLATFORM_FEE_OPTIONAL_KEYS'
 * comment for why this matters in practice. absorbBySirclo (Platform Fee Absorb by SIRCLO) is
 * handled separately again — see absorbColIdxs' comment: every header containing "absorb"
 * (excluding rate/percentage columns) is summed together, for every brand.
 */
function readPlatformFeeContribution_(t, warnings) {
  // Which column set applies is decided by the marketplace in the file name (t.marketplace):
  // TikTok/Tokopedia use PLATFORM_FEE_COL/PLATFORM_FEE_KEYS; Shopee uses SHOPEE_FEE_COL /
  // SHOPEE_FEE_KEYS (a completely different schema, see those definitions above) plus the 3
  // SHOPEE_VOUCHER_COLS whose sum is "Total Vouchers before Marketplace Fee". Lazada/Blibli/Zalora
  // (added 2026-08-18) each get their own schema the same way — see LAZADA_FEE_COL/BLIBLI_FEE_COL/
  // ZALORA_FEE_COL. This is the ONLY place the schema split matters — everything downstream
  // consumes the same generic fee keys.
  const marketplaceLower = String(t.marketplace || '').toLowerCase();
  const isShopee = marketplaceLower === 'shopee';
  const isLazada = marketplaceLower === 'lazada';
  const isBlibli = marketplaceLower === 'blibli';
  const isZalora = marketplaceLower === 'zalora';
  const feeCol = isShopee ? SHOPEE_FEE_COL
    : isLazada ? LAZADA_FEE_COL
    : isBlibli ? BLIBLI_FEE_COL
    : isZalora ? ZALORA_FEE_COL
    : PLATFORM_FEE_COL;
  const feeKeys = isShopee ? SHOPEE_FEE_KEYS
    : isLazada ? LAZADA_FEE_KEYS
    : isBlibli ? BLIBLI_FEE_KEYS
    : isZalora ? ZALORA_FEE_KEYS
    : PLATFORM_FEE_KEYS;
  const optionalKeys = isShopee ? SHOPEE_FEE_OPTIONAL_KEYS
    : isLazada ? LAZADA_FEE_OPTIONAL_KEYS
    : isBlibli ? BLIBLI_FEE_OPTIONAL_KEYS
    : isZalora ? ZALORA_FEE_OPTIONAL_KEYS
    : PLATFORM_FEE_OPTIONAL_KEYS;
  const requiredCols = feeKeys.filter(k => optionalKeys.indexOf(k) === -1).map(k => feeCol[k]);
  if (isShopee) SHOPEE_VOUCHER_COLS.forEach(c => requiredCols.push(c));
  const values = findAndReadSheet_(t.fileId, t.fileName, requiredCols, null, warnings);
  if (!values) return null; // findAndReadSheet_ already pushed a warning explaining why
  if (values.length < 2) {
    warnings.push('"' + t.fileName + '" came back empty — skipped.');
    return null;
  }
  const header = values[0];
  const idx = {};
  // Normalized (see normalizeHeaderName_) so e.g. "Total_Marketplace_Fee" (some brands' export
  // template) and "Total Marketplace Fee" (PLATFORM_FEE_COL's own spelling) are treated as the
  // same column, rather than this file getting skipped over what's really just a punctuation
  // difference. Belt-and-suspenders alongside findAndReadSheet_'s own normalized check, since this
  // idx map is built fresh here from the raw header row.
  header.forEach((h, hi) => { idx[normalizeHeaderName_(h)] = hi; });

  // resolveHeaderIdx_ (not a plain `in idx` check) so a required column is only reported missing if
  // it's ALSO unresolvable via the starts-with/contains fallback — see its doc comment.
  const missing = requiredCols.filter(c => resolveHeaderIdx_(idx, c) === undefined);
  if (missing.length) {
    warnings.push('"' + t.fileName + '" is missing columns: ' + missing.join(', ') + ' — skipped.');
    return null;
  }
  const warehouseIdx = resolveHeaderIdx_(idx, WAREHOUSE_COL_NAME);
  // One idx lookup per fee key, done ONCE here rather than inside the per-row loop below (which
  // runs this for every row x every key otherwise).
  const platformFeeColIdx = {};
  feeKeys.forEach(k => { platformFeeColIdx[k] = resolveHeaderIdx_(idx, feeCol[k]); });
  const voucherColIdx = isShopee
    ? SHOPEE_VOUCHER_COLS.map(c => resolveHeaderIdx_(idx, c))
    : [];
  // Customer_Reference — see CUSTOMER_REFERENCE_COL_NAME's comment. Used ONLY by the Consignment
  // tab (added 2026-08-18) to derive Number of Order (COUNT DISTINCT) directly from this same
  // file, now that Consignment sources its primary metrics from Platform Fee files instead of
  // "Sales Report" files — see refreshConsignmentData_'s Pass 3. Outright ignores this entirely
  // (its own Number of Order still comes from Data Claim Internal files, unchanged) — tracked
  // unconditionally here regardless of which tab is calling, since it's cheap and the caller
  // simply doesn't read totals.custRefCount/wh[...].custRefCount if it doesn't need them.
  const custRefIdx = resolveHeaderIdx_(idx, CUSTOMER_REFERENCE_COL_NAME);

  // Soft warnings for the optional columns (Warehouse, optionalKeys, Customer_Reference) — the
  // file is still fully usable, this is just visibility into what it's missing rather than silence.
  if (warehouseIdx === undefined) {
    warnings.push('"' + t.fileName + '" has no Warehouse column — its figures count toward brand/month totals but won\'t have a per-warehouse breakdown.');
  }
  if (custRefIdx === undefined) {
    warnings.push('"' + t.fileName + '" has no Customer_Reference column — its Number of Order (Consignment tab only) contributes 0.');
  }
  optionalKeys.forEach(k => {
    if (platformFeeColIdx[k] === undefined) {
      warnings.push('"' + t.fileName + '" is missing column "' + feeCol[k] + '" — treated as $0 for this file.');
    }
  });

  // Platform Fee Absorb by SIRCLO — see ALL_PLATFORM_FEE_KEYS' comment above for why this was
  // broadened 2026-08-13. Every header whose normalized text contains "absorb" is summed as one
  // combined figure — a brand/file with none contributes 0, no allowlist or warning needed since
  // there's no longer a single "expected" column name to be missing. The "%" exclusion below
  // skips rate/percentage columns (e.g. "% Absorb by SIRCLO") — normalizeHeaderName_ collapses
  // whitespace/underscores and lowercases everything but leaves a leading "%" character intact,
  // so this reliably tells a rate column from a money one without hardcoding every brand's exact
  // rate-column name too.
  const absorbColIdxs = Object.keys(idx)
    .filter(nh => nh.indexOf('absorb') !== -1 && nh.indexOf('%') === -1)
    .map(nh => idx[nh]);

  const totals = {};
  feeKeys.forEach(k => { totals[k] = 0; });
  totals.absorbBySirclo = 0;
  if (isShopee) totals.totalVouchers = 0;
  const wh = {}; // warehouse -> { <fee keys>: number, absorbBySirclo: number, totalVouchers? }
  // Sets (not counts) while accumulating, so a Customer_Reference repeated across rows (e.g. one
  // order spanning multiple SKU lines) is counted once — converted to plain counts (custRefCount)
  // after the loop, same pattern as readFileContribution_'s custRefs.
  const custRefSet = {};
  const whCustRefSets = {}; // warehouse -> Set-like object of distinct Customer_Reference values

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const warehouse = String(row[warehouseIdx] || '').trim();
    if (warehouse && !wh[warehouse]) {
      wh[warehouse] = { absorbBySirclo: 0 };
      feeKeys.forEach(k => { wh[warehouse][k] = 0; });
      if (isShopee) wh[warehouse].totalVouchers = 0;
    }
    feeKeys.forEach(k => {
      const v = Number(row[platformFeeColIdx[k]]) || 0;
      totals[k] += v;
      if (warehouse) wh[warehouse][k] += v;
    });
    if (isShopee) {
      let tv = 0;
      voucherColIdx.forEach(ci => { tv += Number(row[ci]) || 0; });
      totals.totalVouchers += tv;
      if (warehouse) wh[warehouse].totalVouchers += tv;
    }
    if (absorbColIdxs.length) {
      let av = 0;
      absorbColIdxs.forEach(ci => { av += Number(row[ci]) || 0; });
      totals.absorbBySirclo += av;
      if (warehouse) wh[warehouse].absorbBySirclo += av;
    }
    if (custRefIdx !== undefined) {
      const custRef = row[custRefIdx];
      if (custRef) {
        custRefSet[custRef] = true;
        if (warehouse) {
          if (!whCustRefSets[warehouse]) whCustRefSets[warehouse] = {};
          whCustRefSets[warehouse][custRef] = true;
        }
      }
    }
  }

  totals.custRefCount = Object.keys(custRefSet).length;
  Object.keys(wh).forEach(warehouse => {
    wh[warehouse].custRefCount = Object.keys(whCustRefSets[warehouse] || {}).length;
  });

  // Shopee's "Shipping Cost" column is read into the same shared `shippingCost` key as TikTok/
  // Tokopedia's (see SHOPEE_FEE_COL's comment above). Previously (2026-08-18) forced to 0 here per
  // Zoltraak; REVERTED 2026-08-20 per Zoltraak ("tolong jangan di 0 kan") — Shopee's real Shipping
  // Cost figure (from the file's own "Shipping Cost" column) now flows through unmodified, same as
  // every other Shopee fee and every other marketplace's Shipping Cost.

  return { totals: totals, wh: wh };
}

/**
 * Reads a file's values via the Sheets Advanced Service, checking every tab's header row (not
 * just the first tab) to find the one with all of `requiredCols`. Returns the matched tab's full
 * values (header row + data rows), or null with a warning pushed to `warnings` if nothing usable
 * was found. Shared by readDataClaimSheet_ and readPlatformFeeContribution_ — both need the exact
 * same defensive "don't assume tab 1, don't assume column position" handling, since a spreadsheet
 * someone edits by hand can grow/shrink/reorder columns (or tabs) over time.
 *
 * `preferredCol`, if given, breaks ties among multiple qualifying tabs (see the comment inline
 * below) — pass null if there's no such preference.
 *
 * Requires the "Google Sheets API" Advanced Service to be enabled for this project
 * (Services > + > Google Sheets API in the Apps Script editor).
 */

function findAndReadSheet_(fileId, fileName, requiredCols, preferredCol, warnings, preferredTabPattern) {
  let meta;
  try {
    meta = callSheetsApi_(() => Sheets.Spreadsheets.get(fileId, {
      fields: 'sheets.properties.title,sheets.properties.gridProperties.rowCount',
    }));
  } catch (err) {
    warnings.push('Could not read metadata for "' + fileName + '": ' + err);
    return null;
  }
  const sheetsMeta = meta.sheets || [];
  const sheetNames = sheetsMeta.map(s => s.properties.title);
  if (sheetNames.length === 0) {
    warnings.push('"' + fileName + '" has no tabs — skipped.');
    return null;
  }

  // Fetch the first 10 rows of every tab in one call — cheap — to find which tab actually has our
  // columns. Widened from a single row ('!1:1') on purpose: a spreadsheet someone edits by hand
  // sometimes gets a banner/title row (or a blank spacer row) inserted above the real header row
  // — e.g. several August 2026 Platform Fee files had exactly this, which made every tab in them
  // look like it was "missing every expected column" even though the real header row, one row
  // down, had them all. 10 rows is a generous buffer for that without meaningfully increasing the
  // response size of what's still a single cheap batchGet call.
  const HEADER_SCAN_ROWS = 10;
  let headerBatch;
  try {
    headerBatch = callSheetsApi_(() => Sheets.Spreadsheets.Values.batchGet(fileId, {
      ranges: sheetNames.map(n => "'" + n.replace(/'/g, "''") + "'!1:" + HEADER_SCAN_ROWS),
      valueRenderOption: 'UNFORMATTED_VALUE',
    }));
  } catch (err) {
    warnings.push('Could not read tab headers for "' + fileName + '": ' + err);
    return null;
  }

  // Some files (e.g. Natasha Skincare Official Store's exports) have more than one tab that
  // qualifies — a leftover/placeholder tab alongside the real data tab — and more than one can
  // legitimately contain every required column. If `preferredCol` is given, prefer a qualifying
  // tab that ALSO has it over one that doesn't, instead of blindly taking whichever qualifying
  // tab comes first. This was previously causing Natasha Skincare/Naavagreen to silently lose
  // their warehouse breakdown whenever the placeholder tab happened to satisfy the
  // required-columns check too.
  //
  // Within each tab, the first of its (up to HEADER_SCAN_ROWS) rows that has every required
  // column wins as that tab's header row — not necessarily row 1 (see the comment above).
  // headerRowIdx is 0-based within that scanned window, which lines up directly with the same
  // 0-based index into fetchSheetValuesChunked_'s result below (both start at sheet row 1), so
  // it's used as-is to slice off any banner/spacer rows before returning.
  const valueRanges = headerBatch.valueRanges || [];
  let targetSheetName = null, targetRowCount = 0, targetHeaderRowIdx = 0;
  let fallbackSheetName = null, fallbackRowCount = 0, fallbackHeaderRowIdx = 0;
  // Tab-NAME preference (added 2026-09-26, see DATA_CLAIM_TAB_NAME_PATTERN): when given, a
  // qualifying tab whose name matches `preferredTabPattern` beats every non-matching tab, no matter
  // the tab order. Among name-matching tabs the usual preferredCol rule still applies.
  let namedSheetName = null, namedRowCount = 0, namedHeaderRowIdx = 0, namedHasPreferredCol = false;
  for (let i = 0; i < valueRanges.length; i++) {
    const candidateRows = valueRanges[i].values || [];
    let headerRowIdx = -1, trimmed = null;
    for (let r = 0; r < candidateRows.length; r++) {
      // Normalized (see normalizeHeaderName_) so a candidate row still qualifies whether its
      // columns are "Total Marketplace Fee", "Total_Marketplace_Fee", or any other
      // whitespace/underscore/case/punctuation variant of the same name — and, via
      // resolveHeaderIdx_'s starts-with/contains fallback (added 2026-08-18), even a header
      // carrying extra text around the expected name (e.g. "Commission (IDR)" for "Commission").
      const rowTrimmed = (candidateRows[r] || []).map(h => normalizeHeaderName_(h));
      const rowIdx = {};
      rowTrimmed.forEach((nh, ci) => { if (!(nh in rowIdx)) rowIdx[nh] = ci; });
      if (requiredCols.every(c => resolveHeaderIdx_(rowIdx, c) !== undefined)) {
        headerRowIdx = r;
        trimmed = rowIdx;
        break;
      }
    }
    if (headerRowIdx === -1) continue; // this tab doesn't have the required columns in its first HEADER_SCAN_ROWS rows
    const gp = sheetsMeta[i].properties.gridProperties;
    const rowCount = (gp && gp.rowCount) || 0;
    if (preferredTabPattern) {
      if (preferredTabPattern.test(sheetNames[i])) {
        const hasPref = !!(preferredCol && resolveHeaderIdx_(trimmed, preferredCol) !== undefined);
        if (!namedSheetName || (hasPref && !namedHasPreferredCol)) {
          namedSheetName = sheetNames[i];
          namedRowCount = rowCount;
          namedHeaderRowIdx = headerRowIdx;
          namedHasPreferredCol = hasPref;
        }
      }
      // Keep scanning (no early break) — a name-matching tab may still come later in the file.
      // Meanwhile remember the old-rule winner (first tab with preferredCol, else first qualifying
      // tab) purely as the fallback for a file that has no name-matching tab at all.
      if (!targetSheetName && preferredCol && resolveHeaderIdx_(trimmed, preferredCol) !== undefined) {
        targetSheetName = sheetNames[i]; targetRowCount = rowCount; targetHeaderRowIdx = headerRowIdx;
      } else if (!fallbackSheetName) {
        fallbackSheetName = sheetNames[i]; fallbackRowCount = rowCount; fallbackHeaderRowIdx = headerRowIdx;
      }
      continue;
    }
    if (preferredCol && resolveHeaderIdx_(trimmed, preferredCol) !== undefined) {
      // Best case: qualifies AND has the preferred column — use it immediately, no need to keep looking.
      targetSheetName = sheetNames[i];
      targetRowCount = rowCount;
      targetHeaderRowIdx = headerRowIdx;
      break;
    }
    if (!fallbackSheetName) {
      // Qualifies but no preferred column — remember it in case nothing better turns up.
      fallbackSheetName = sheetNames[i];
      fallbackRowCount = rowCount;
      fallbackHeaderRowIdx = headerRowIdx;
    }
  }
  if (namedSheetName) {
    targetSheetName = namedSheetName;
    targetRowCount = namedRowCount;
    targetHeaderRowIdx = namedHeaderRowIdx;
  } else if (preferredTabPattern && (targetSheetName || fallbackSheetName)) {
    warnings.push('"' + fileName + '" has no tab whose name matches ' + preferredTabPattern +
      ' — used "' + (targetSheetName || fallbackSheetName) + '" instead. Please check it is the right data tab.');
  }
  if (!targetSheetName) {
    targetSheetName = fallbackSheetName;
    targetRowCount = fallbackRowCount;
    targetHeaderRowIdx = fallbackHeaderRowIdx;
  }
  if (!targetSheetName) {
    warnings.push('"' + fileName + '" — none of its ' + sheetNames.length + ' tab(s) have the expected columns in their first ' + HEADER_SCAN_ROWS + ' rows — skipped.');
    return null;
  }

  // valueRenderOption defaults to FORMATTED_VALUE, which returns numbers as their DISPLAYED
  // string — e.g. 91461 comes back as "91,461" if the cell has thousands-separator formatting.
  // Number("91,461") is NaN in JS, and "NaN || 0" silently becomes 0, which was quietly zeroing
  // out every value ≥ 1000 in the sums. UNFORMATTED_VALUE gets the real underlying number instead.
  //
  // Fetched in row-chunks rather than one Values.get() over the whole tab — large tabs (e.g.
  // Garnier Official's, which has far more rows than the others) can trip the Sheets API's
  // "413 response too large" limit if pulled in a single request. Chunking keeps every
  // individual request small; if a chunk is STILL too large it's halved and retried rather than
  // giving up on the whole file.
  const allValues = fetchSheetValuesChunked_(fileId, targetSheetName, targetRowCount, fileName, warnings);
  if (!allValues) return null;
  // Drop any banner/spacer row(s) found above the real header row, so every caller can keep
  // assuming values[0] IS the header row — same contract as before HEADER_SCAN_ROWS existed.
  return targetHeaderRowIdx > 0 ? allValues.slice(targetHeaderRowIdx) : allValues;
}

// Data Claim Internal tab-name preference — added 2026-09-26 per Zoltraak ("use sheet that has DC
// in it"). ABC's Data Claim files carry several tabs that all have the required columns — the real
// data tab (e.g. "2606 DC ABC Official Store") plus working copies like "coretan commercial" and
// "3. Cancel Transactions". Previously the FIRST qualifying tab in tab order won, which was only
// correct by luck of ordering. "DC" must appear as its own word (so "coretan commercial" etc. never
// match). If a file has no such tab, the old first-qualifying-tab rule is used and a warning is shown.
const DATA_CLAIM_TAB_NAME_PATTERN = /\bDC\b/i;

/** Data Claim Internal files: needs every COL, prefers a "DC" tab, then a tab that also has Warehouse. */
function readDataClaimSheet_(fileId, fileName, warnings) {
  const requiredCols = Object.keys(COL).map(k => COL[k]);
  return findAndReadSheet_(fileId, fileName, requiredCols, WAREHOUSE_COL_NAME, warnings, DATA_CLAIM_TAB_NAME_PATTERN);
}

/**
 * Fetches every row of one sheet tab via repeated Values.get() calls over row ranges, small
 * enough to stay under the Sheets API's response-size limit, and concatenates them into a
 * single values[][] array (header row included). Adaptively halves the chunk size and retries
 * on a "response too large" error instead of failing the whole file.
 */
function fetchSheetValuesChunked_(fileId, sheetName, rowCount, fileName, warnings) {
  const MAX_CHUNK_ROWS = 15000;
  const MIN_CHUNK_ROWS = 500;
  const safeName = "'" + sheetName.replace(/'/g, "''") + "'";
  const hardEnd = rowCount > 0 ? rowCount : 2000000; // fallback cap if rowCount metadata is missing

  let allValues = [];
  let start = 1;
  let chunkSize = MAX_CHUNK_ROWS;

  while (start <= hardEnd) {
    const end = Math.min(start + chunkSize - 1, hardEnd);
    const range = safeName + '!' + start + ':' + end;
    let resp;
    try {
      // Quota errors are already retried with backoff inside callSheetsApi_ — if one still
      // surfaces here, retries were exhausted, so it falls straight to the warning below rather
      // than shrinking the chunk (a smaller chunk means MORE requests, which only makes a quota
      // problem worse). Only a genuine "response too large" error should shrink the chunk.
      resp = callSheetsApi_(() => Sheets.Spreadsheets.Values.get(fileId, range, { valueRenderOption: 'UNFORMATTED_VALUE' }));
    } catch (err) {
      const msg = String(err);
      const isSizeErr = msg.indexOf('too large') !== -1 || msg.indexOf('exceeds the limit') !== -1 || msg.indexOf('413') !== -1;
      if (isSizeErr && chunkSize > MIN_CHUNK_ROWS) {
        chunkSize = Math.max(MIN_CHUNK_ROWS, Math.floor(chunkSize / 2));
        continue; // retry the same starting row with a smaller chunk
      }
      warnings.push('Could not read rows ' + start + '+ from "' + fileName + '" (tab "' + sheetName + '"): ' + err);
      return null;
    }
    // Defensive, per production incident 2026-08-17: Sheets.Spreadsheets.Values.get() has been
    // observed to return null itself — not an object with an empty `values` — for some requests,
    // WITHOUT throwing. Un-guarded, `resp.values` then threw "Cannot read properties of null
    // (reading 'values')" straight out of this function, crashing the ENTIRE refreshData() run and
    // discarding every file successfully (re-)read earlier in that same run, since fileCache is
    // only written to Drive once, at the very end.
    if (!resp) {
      // Retry a few times first (short pause, no backoff needed — this isn't a quota error, just
      // an apparently transient empty response) in case it's a one-off blip, rather than
      // immediately truncating the file on the very first occurrence.
      let nullRetries = 0;
      while (!resp && nullRetries < 3) {
        Utilities.sleep(1000);
        try {
          resp = callSheetsApi_(() => Sheets.Spreadsheets.Values.get(fileId, range, { valueRenderOption: 'UNFORMATTED_VALUE' }));
        } catch (err) {
          warnings.push('Could not read rows ' + start + '+ from "' + fileName + '" (tab "' + sheetName + '"): ' + err);
          return null;
        }
        nullRetries++;
      }
      if (!resp) {
        // Still null after retrying — fail JUST this file (not the whole run, unlike the crash
        // this replaces). Deliberately returns null here rather than whatever's in `allValues` so
        // far (even if that's non-empty from earlier successful chunks): findAndReadSheet_ treats
        // a null return as "couldn't read this file", so readFileContribution_ returns null too,
        // fileCache is simply NOT updated for this file (see refreshData's Pass 2 — a null
        // contribution just skips the file, leaving whatever cache entry existed before, if any,
        // untouched), and it's automatically retried on the next refreshData() run. This is
        // deliberately more conservative than caching the partial rows as if the file were fully
        // read — on a financial dashboard, silently under-counting a file's numbers forever (until
        // something else happens to force a re-read) is worse than that file just staying on
        // stale/no data for one more refresh cycle while it gets retried.
        warnings.push('"' + fileName + '" (tab "' + sheetName + '"): rows ' + start + '+ came back empty from the Sheets API ' +
          'after retrying — skipped this run rather than risk caching incomplete data as final. Will retry ' +
          'automatically next refreshData() run; if this keeps happening for the same file, it may need to ' +
          'be re-saved/re-shared in Drive.');
        return null;
      }
    }
    const chunkValues = resp.values || [];
    if (chunkValues.length === 0) break; // no more data — done, even if rowCount overestimated
    allValues = allValues.concat(chunkValues);
    if (chunkValues.length < (end - start + 1)) break; // got fewer rows than asked — reached the end
    start = end + 1;
  }
  return allValues;
}

function saveJsonToDriveCache_(json) {
  const root = DriveApp.getFolderById(ROOT_FOLDER_ID);
  const existing = root.getFilesByName(CACHE_FILE_NAME);
  if (existing.hasNext()) {
    existing.next().setContent(json);
  } else {
    root.createFile(CACHE_FILE_NAME, json, MimeType.PLAIN_TEXT);
  }
}



function loadCachedData_() {
  const root = DriveApp.getFolderById(ROOT_FOLDER_ID);
  const files = root.getFilesByName(CACHE_FILE_NAME);
  if (!files.hasNext()) return null;
  return files.next().getBlob().getDataAsString();
}

/** Loads the per-file incremental cache (fileId -> {modifiedTime, brand, month, data, mp}). */
function loadFileCache_() {
  const root = DriveApp.getFolderById(ROOT_FOLDER_ID);
  const files = root.getFilesByName(FILE_CACHE_NAME);
  if (!files.hasNext()) return {};
  try {
    return JSON.parse(files.next().getBlob().getDataAsString()) || {};
  } catch (err) {
    return {}; // corrupt/missing cache — safe to fall back to "nothing cached", just re-reads everything once
  }
}

function saveFileCache_(fileCache) {
  const root = DriveApp.getFolderById(ROOT_FOLDER_ID);
  const json = JSON.stringify(fileCache);
  const existing = root.getFilesByName(FILE_CACHE_NAME);
  if (existing.hasNext()) {
    existing.next().setContent(json);
  } else {
    root.createFile(FILE_CACHE_NAME, json, MimeType.PLAIN_TEXT);
  }
}

/** Loads the per-file incremental cache for Platform Fee files (fileId -> {modifiedTime, v, totals, wh}). */
function loadPlatformFeeFileCache_() {
  const root = DriveApp.getFolderById(ROOT_FOLDER_ID);
  const files = root.getFilesByName(PLATFORM_FEE_FILE_CACHE_NAME);
  if (!files.hasNext()) return {};
  try {
    return JSON.parse(files.next().getBlob().getDataAsString()) || {};
  } catch (err) {
    return {}; // corrupt/missing cache — safe to fall back to "nothing cached", just re-reads everything once
  }
}

function savePlatformFeeFileCache_(feeFileCache) {
  const root = DriveApp.getFolderById(ROOT_FOLDER_ID);
  const json = JSON.stringify(feeFileCache);
  const existing = root.getFilesByName(PLATFORM_FEE_FILE_CACHE_NAME);
  if (existing.hasNext()) {
    existing.next().setContent(json);
  } else {
    root.createFile(PLATFORM_FEE_FILE_CACHE_NAME, json, MimeType.PLAIN_TEXT);
  }
}

// ====================== ACCESS CONTROL ======================

/**
 * Loads the access list (array of {email, role}). SEED_ADMIN_EMAIL is hardcoded as "owner" —
 * ensureOwnerPresent_ runs on every load (not just the first) so this stays true even if the
 * file already existed from before the Owner role existed, or if the file gets edited by hand.
 * Every email is stored lowercased so lookups aren't case-sensitive.
 */
function loadAccessList_() {
  const root = DriveApp.getFolderById(ROOT_FOLDER_ID);
  const files = root.getFilesByName(ACCESS_FILE_NAME);
  let list = [];
  if (files.hasNext()) {
    try {
      const parsed = JSON.parse(files.next().getBlob().getDataAsString());
      if (Array.isArray(parsed)) list = parsed;
    } catch (err) {
      // corrupt file — fall back to an empty list, ensureOwnerPresent_ below will still seed it
    }
  }
  const fixed = ensureOwnerPresent_(list);
  if (fixed.changed) saveAccessList_(fixed.list);
  return fixed.list;
}

/**
 * Makes sure SEED_ADMIN_EMAIL is present with role "owner", adding it if missing or correcting
 * its role if it's somehow anything else. Returns { list, changed } — changed is true if the
 * list needed fixing, so the caller knows whether to persist it back to Drive.
 */
function ensureOwnerPresent_(list) {
  const ownerEmail = SEED_ADMIN_EMAIL.toLowerCase();
  let changed = false;
  const entry = findAccessEntry_(list, ownerEmail);
  if (!entry) {
    list.push({ email: ownerEmail, role: 'owner' });
    changed = true;
  } else if (entry.role !== 'owner') {
    entry.role = 'owner';
    changed = true;
  }
  return { list: list, changed: changed };
}

function saveAccessList_(list) {
  const root = DriveApp.getFolderById(ROOT_FOLDER_ID);
  const json = JSON.stringify(list);
  const existing = root.getFilesByName(ACCESS_FILE_NAME);
  if (existing.hasNext()) {
    existing.next().setContent(json);
  } else {
    root.createFile(ACCESS_FILE_NAME, json, MimeType.PLAIN_TEXT);
  }
}

/**
 * The email of whoever is loading the page right now. Only reliable when the web app's "Who has
 * access" deployment setting is restricted to a Google Workspace domain (or specific people) —
 * NOT "Anyone" (anonymous access has no identity to read, so this comes back empty and everyone
 * gets treated as not-on-the-list). For SIRCLO's Workspace domain this should work as-is.
 */
function getCurrentUserEmail_() {
  try {
    const email = Session.getActiveUser().getEmail();
    return email ? email.toLowerCase() : '';
  } catch (err) {
    return '';
  }
}

function findAccessEntry_(list, email) {
  const e = String(email || '').toLowerCase();
  for (let i = 0; i < list.length; i++) {
    if (String(list[i].email || '').toLowerCase() === e) return list[i];
  }
  return null;
}

function isValidEmail_(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

/** Owner and Admin can both invite/remove people — Owner is just Admin-plus-unremovable. */
function canManageAccess_(entry) {
  return !!entry && (entry.role === 'admin' || entry.role === 'owner');
}

/**
 * Returns the access list plus who's asking — called from the client to render the "who has
 * access" panel. Re-checks the caller is actually on the list before returning anything (so a
 * crafted direct RPC call can't be used to read the list by someone without access).
 */
function getAccessList() {
  const callerEmail = getCurrentUserEmail_();
  const list = loadAccessList_();
  if (!findAccessEntry_(list, callerEmail)) {
    throw new Error('You do not have access to this dashboard.');
  }
  return { list: list, currentEmail: callerEmail };
}

/**
 * Admin/Owner only: adds an email to the access list. `role` must be "admin" or "user" — "owner"
 * is not a grantable role (it's permanently tied to SEED_ADMIN_EMAIL, see ensureOwnerPresent_),
 * so anything else passed in quietly falls back to "user".
 */
function inviteUser(newEmail, role) {
  const callerEmail = getCurrentUserEmail_();
  const clean = String(newEmail || '').trim().toLowerCase();
  if (!isValidEmail_(clean)) {
    throw new Error('"' + newEmail + '" doesn\'t look like a valid email address.');
  }
  let errorMsg = null;
  const result = withScriptLock_(() => {
    const list = loadAccessList_();
    const caller = findAccessEntry_(list, callerEmail);
    if (!canManageAccess_(caller)) {
      errorMsg = 'Only Admins (or the Owner) can invite people.';
      return null;
    }
    if (clean === SEED_ADMIN_EMAIL.toLowerCase()) {
      errorMsg = 'That email is already the Owner.';
      return null;
    }
    if (findAccessEntry_(list, clean)) {
      errorMsg = clean + ' already has access.';
      return null;
    }
    const grantedRole = role === 'admin' ? 'admin' : 'user';
    list.push({ email: clean, role: grantedRole });
    saveAccessList_(list);
    return { list: list, currentEmail: callerEmail };
  }, 10000);
  if (errorMsg) throw new Error(errorMsg);
  if (!result) throw new Error('The access list is busy right now — please try again in a moment.');
  return result;
}

/**
 * Admin/Owner only: removes an email from the access list. The Owner (SEED_ADMIN_EMAIL) can
 * never be removed — hardcoded, checked here regardless of who's asking or what the stored role
 * says, so even a hand-edited access file can't be used to remove them through this function.
 */
function removeUser(targetEmail) {
  const callerEmail = getCurrentUserEmail_();
  const clean = String(targetEmail || '').trim().toLowerCase();
  let errorMsg = null;
  const result = withScriptLock_(() => {
    const list = loadAccessList_();
    const caller = findAccessEntry_(list, callerEmail);
    if (!canManageAccess_(caller)) {
      errorMsg = 'Only Admins (or the Owner) can remove people.';
      return null;
    }
    if (clean === SEED_ADMIN_EMAIL.toLowerCase()) {
      errorMsg = 'The Owner cannot be removed.';
      return null;
    }
    const target = findAccessEntry_(list, clean);
    if (!target) {
      errorMsg = clean + ' is not on the access list.';
      return null;
    }
    const newList = list.filter(u => String(u.email).toLowerCase() !== clean);
    saveAccessList_(newList);
    return { list: newList, currentEmail: callerEmail };
  }, 10000);
  if (errorMsg) throw new Error(errorMsg);
  if (!result) throw new Error('The access list is busy right now — please try again in a moment.');
  return result;
}

function escapeHtml_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Plain, self-contained "you don't have access" page — no separate template file needed. */
function buildAccessDeniedOutput_(currentEmail) {
  const emailLine = currentEmail
    ? '<div class="email">Signed in as: ' + escapeHtml_(currentEmail) + '</div>'
    : '<div class="email">Your Google account email could not be read — this dashboard needs to be opened while signed into a SIRCLO Workspace account.</div>';
  const html = '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Access Denied</title><style>' +
    'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;' +
    'background:#f5f6f8;color:#1a1a1a;display:flex;align-items:center;justify-content:center;' +
    'min-height:100vh;margin:0;padding:24px;}' +
    '.card{background:#fff;border:1px solid #e3e5e9;border-radius:12px;padding:32px 28px;' +
    'max-width:380px;text-align:center;box-shadow:0 4px 16px rgba(0,0,0,0.06);}' +
    'h1{font-size:18px;margin:0 0 10px;}' +
    'p{font-size:13.5px;color:#555;line-height:1.6;margin:0;}' +
    '.email{font-size:12px;color:#999;margin-top:14px;}' +
    '</style></head><body><div class="card">' +
    "<h1>You don't have access</h1>" +
    '<p>Contact an admin to be added to the Pareto - Outright - Financial Statement Overview access list.</p>' +
    emailLine +
    '</div></body></html>';
  return HtmlService.createHtmlOutput(html)
    .setTitle('Access Denied')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ====================== ONLINE PRESENCE ======================
//
// Tracks who currently has the dashboard open. Apps Script web apps have no push mechanism, so
// "online" is approximated by a heartbeat: each open tab calls pingPresence() every ~30s, which
// stamps { email: { ts, photo } } into a small JSON file in the same Drive folder. getOnlineUsers()
// returns everyone whose stamp is younger than PRESENCE_WINDOW_MS — the client polls it and
// renders their profile pictures (Google's public photo service, keyed by account email) beside
// the "Who has access" button.

const PRESENCE_FILE_NAME = '_fs_overview_presence.json';
const PRESENCE_WINDOW_MS = 90000; // 90s — a user counts as online if they pinged within this window
const PHOTO_CACHE_FILE_NAME = '_fs_overview_abc_photos.json';
const PHOTO_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // re-resolve avatars at most once per day

function loadPresenceMap_() {
  const root = DriveApp.getFolderById(ROOT_FOLDER_ID);
  const files = root.getFilesByName(PRESENCE_FILE_NAME);
  if (!files.hasNext()) return {};
  try { return JSON.parse(files.next().getBlob().getDataAsString()) || {}; }
  catch (err) { return {}; }
}

function savePresenceMap_(map) {
  const root = DriveApp.getFolderById(ROOT_FOLDER_ID);
  const json = JSON.stringify(map);
  const existing = root.getFilesByName(PRESENCE_FILE_NAME);
  if (existing.hasNext()) existing.next().setContent(json);
  else root.createFile(PRESENCE_FILE_NAME, json, MimeType.PLAIN_TEXT);
}

// Resolves a Google account email to its profile-photo URL. The browser can't load
// https://www.google.com/s2/photos/profile/<email> directly (Apps Script's default Content
// Security Policy blocks [www.google.com](https://www.google.com) images), so the s2 endpoint's 302 Location header is
// followed here and the final lh3.googleusercontent.com / ssl.gstatic.com URL — both CSP-allowed —
// is handed to the client instead. If the endpoint serves the image body directly (no redirect),
// it's base64-encoded into a data: URL. Results are cached in _fs_overview_photos.json for 24h so
// UrlFetchApp isn't hammered on every heartbeat. Returns '' when nothing resolves — the client
// then falls back to showing the person's initial.
function resolveProfilePhotoUrl_(email) {
  const key = String(email || '').toLowerCase();
  if (!key) return '';
  const root = DriveApp.getFolderById(ROOT_FOLDER_ID);
  const cacheFiles = root.getFilesByName(PHOTO_CACHE_FILE_NAME);
  let cache = {};
  try { if (cacheFiles.hasNext()) cache = JSON.parse(cacheFiles.next().getBlob().getDataAsString()) || {}; }
  catch (err) { cache = {}; }
  const hit = cache[key];
  if (hit && hit.url && (Date.now() - hit.ts) < PHOTO_CACHE_TTL_MS) return hit.url;
  let url = '';
  try {
    const resp = UrlFetchApp.fetch('https://www.google.com/s2/photos/profile/' + encodeURIComponent(key), {
      followRedirects: false,
      muteHttpExceptions: true
    });
    const loc = String(resp.getHeaders()['Location'] || resp.getHeaders()['location'] || '');
    if (loc && (loc.indexOf('googleusercontent.com') !== -1 || loc.indexOf('gstatic.com') !== -1)) {
      url = loc; // CSP-allowed hosts
    } else if (!loc) {
      // No redirect — the endpoint served the image bytes directly; base64 into a data URL.
      const blob = resp.getBlob();
      const mime = blob.getContentType() || 'image/png';
      url = 'data:' + mime + ';base64,' + Utilities.base64Encode(blob.getBytes());
    }
  } catch (err) { /* leave url empty — client falls back to the initial */ }
  // Only the final read-modify-write of the shared cache file needs the lock — the slow
  // UrlFetchApp call above deliberately happens OUTSIDE it, so one person's cold cache miss
  // doesn't block every other concurrent pingPresence() from proceeding. Re-reads the cache fresh
  // under the lock (rather than reusing `cache` from before the fetch) so a concurrent writer's
  // entry for a DIFFERENT email isn't lost.
  withScriptLock_(() => {
    const freshRoot = DriveApp.getFolderById(ROOT_FOLDER_ID);
    let freshCache = {};
    const freshFiles = freshRoot.getFilesByName(PHOTO_CACHE_FILE_NAME);
    try { if (freshFiles.hasNext()) freshCache = JSON.parse(freshFiles.next().getBlob().getDataAsString()) || {}; }
    catch (err) { freshCache = {}; }
    freshCache[key] = { url: url, ts: Date.now() };
    const json = JSON.stringify(freshCache);
    const existing = freshRoot.getFilesByName(PHOTO_CACHE_FILE_NAME);
    if (existing.hasNext()) existing.next().setContent(json);
    else freshRoot.createFile(PHOTO_CACHE_FILE_NAME, json, MimeType.PLAIN_TEXT);
  }, 8000);
  return url;
}

// Records the current viewer as online (pruning stale entries so the file never grows forever).
// Only people on the access list count, mirroring getAccessList()'s security posture.
function pingPresence() {
  const email = getCurrentUserEmail_();
  if (!email) return { ok: false };
  const list = loadAccessList_();
  if (!findAccessEntry_(list, email)) return { ok: false };
  // Resolved OUTSIDE the lock below — it's a slow network call (UrlFetchApp), and holding the
  // shared lock while it runs would serialize every OTHER viewer's heartbeat behind it. It does
  // its own locking around its own cache file — see resolveProfilePhotoUrl_.
  const photo = resolveProfilePhotoUrl_(email);
  const ok = withScriptLock_(() => {
    const now = Date.now();
    const map = loadPresenceMap_();
    Object.keys(map).forEach(k => {
      const e = map[k];
      const ts = (e && typeof e === 'object') ? e.ts : e; // tolerate legacy {email: number}
      if (now - ts > PRESENCE_WINDOW_MS) delete map[k];
    });
    // Store the avatar alongside the heartbeat so getOnlineUsers needs no extra fetches/reads.
    map[email] = { ts: now, photo: photo };
    savePresenceMap_(map);
    return true;
  }, 8000);
  return { ok: !!ok }; // lock busy (very rare) — this one heartbeat is skipped, next one in 30s retries
}

// Emails still inside the presence window, sorted Owner -> Admin -> User then alphabetically —
// the same ordering the access panel uses.
function getOnlineUsers() {
  const now = Date.now();
  const map = loadPresenceMap_();
  const list = loadAccessList_();
  const roleOf = {};
  list.forEach(u => { roleOf[String(u.email).toLowerCase()] = u.role; });
  const prio = { owner: 0, admin: 1, user: 2 };
  const out = [];
  Object.keys(map).forEach(email => {
    const e = map[email];
    const ts = (e && typeof e === 'object') ? e.ts : e;
    if (now - ts <= PRESENCE_WINDOW_MS) {
      out.push({ email: email, lastSeen: ts, photoUrl: (e && typeof e === 'object') ? e.photo : '' });
    }
  });
  out.sort((a, b) => {
    const ra = Object.prototype.hasOwnProperty.call(prio, roleOf[a.email]) ? prio[roleOf[a.email]] : 2;
    const rb = Object.prototype.hasOwnProperty.call(prio, roleOf[b.email]) ? prio[roleOf[b.email]] : 2;
    if (ra !== rb) return ra - rb;
    return a.email.localeCompare(b.email);
  });
  return out;
}
// ====================== APPROVAL ======================
//
// Added 2026-09-03 per Zoltraak's spec (agreed design, see the chat thread for the full back-and-
// forth): a sign-off workflow gathering approval from 3 Functions — Finance AR, Commercial, Finance
// Data & Reporting (FDR) — per (real Official Store x month). This fork has only 1 real store (ABC
// Official Store) and no combined-group level — per Zoltraak 2026-09-14, Approval stays scoped to
// that one store only (APPROVAL_GROUP_NAME_ = null below), same as the Mustika Ratu/Natasha forks.
//
// Storage mirrors the existing ACCESS_FILE_NAME pattern exactly (one JSON file in ROOT_FOLDER_ID,
// read-modify-write under withScriptLock_ for every mutation) rather than a new Sheet — per Zoltraak
// ("tempat penyimpanan data setuju... approval ini tidak perlu masuk dalam export spreadsheet").
//
// Two access layers, per Zoltraak's point 9: layer 1 is the EXISTING dashboard access list
// (ACCESS_FILE_NAME/loadAccessList_ above — required just to open the dashboard at all); layer 2 is
// THIS file's own `access` array — a SEPARATE grant, on top of layer 1, saying which Function
// (ar/commercial/fdr) a person plays in Approval. A person can have dashboard access but no Approval
// Function at all (they see the tab read-only, per Zoltraak's confirmed answer), or dashboard access
// AND an Approval Function. Only current FDR members can grant/revoke this layer — seeded once with
// SEED_FDR_EMAILS_ (mirrors ensureOwnerPresent_'s exact bootstrap pattern below) but fully
// self-service after that ("buat ini fleksible jika nanti saya mau tambahkan user baru"), so nothing
// here ever hardcodes "is this Alfian/Nada/Haya" — every permission check reads the CURRENT access
// array instead.

const APPROVAL_FILE_NAME = '_fs_overview_abc_approval.json';
// The 3 Functions, and their on-screen labels — every place in this file that needs to validate or
// display a Function reads this table rather than repeating the 3 strings, so adding a 4th Function
// later (hypothetically) would only ever need this one array touched.
const APPROVAL_FUNCTIONS_ = [
  { key: 'ar', label: 'Finance AR', hasNumbers: true },
  { key: 'commercial', label: 'Commercial', hasNumbers: true },
  { key: 'fdr', label: 'Finance Data & Reporting', hasNumbers: false },
];
const APPROVAL_FUNCTION_KEYS_ = APPROVAL_FUNCTIONS_.map(f => f.key);
// The 3 numeric fields Finance AR/Commercial each fill in free text (Zoltraak's point 5) — whole
// numbers only, no decimals, matching EXPORT_NUMBER_FORMAT.money's existing convention.
const APPROVAL_NUMBER_FIELDS_ = ['sales', 'cogs', 'rebates'];
// Real, individually-approvable Official Stores — reuses ABC_GROUP_BRANDS (this whole fork only
// ever has this 1 real store) rather than inventing a second "which stores does Approval cover"
// list that could drift out of sync with it.
const APPROVAL_STORES_ = ABC_GROUP_BRANDS;
// null — no combined-group sign-off level for this fork (only 1 real store, no VIRTUAL_STORE_GROUPS
// entry in Dashboard.html either — see ABC_GROUP_BRANDS' own comment). Confirmed 2026-09-14.
const APPROVAL_GROUP_NAME_ = null;
// Seed FDR members — added the first time this file is created (or the first time an existing file
// is missing one of them), exactly mirroring ensureOwnerPresent_'s bootstrap pattern above. After
// this seed, any current FDR member can add/remove others via setApprovalAccess — these 3 names are
// only ever a STARTING point, never re-consulted for permission checks.
const SEED_FDR_EMAILS_ = ['alfian.franing@sirclo.com', 'nada.hamida@sirclo.com', 'haya.azzahra@sirclo.com'];
// Always-CC'd mailbox on every anulir notification, per Zoltraak's point 6, IN ADDITION to the
// live/dynamic list of current FDR members (getFdrEmails_ below) — a fixed address, not a Function,
// so it's kept as its own constant rather than folded into `access`.
const APPROVAL_STATIC_CC_ = 'ar.commerce@sirclo.com';
// How the on-screen dashboard identifies itself in the anulir email subject (Zoltraak's point 10:
// '[Need Approval] - Dashboard "Nama Dashboard" YYYYMMDD HHMM') — matches viewTitle's own text in
// Dashboard.html exactly, so the email names the same dashboard the recipient would recognize.
const APPROVAL_DASHBOARD_LABEL_ = 'Pareto - Outright - Financial Statement Overview (ABC Official Store)';
// Log is append-only (Zoltraak's point 10) but capped so the JSON file can't grow forever — oldest
// entries are dropped once this is exceeded. 2000 is generous for 1 store x a handful of months x
// 3 Functions' worth of activity for a long time.
const APPROVAL_LOG_MAX_ENTRIES_ = 2000;
// Every function's own comment/notes thread (Zoltraak's point 4: "notes jd 1 line aja namun ketika
// ada yang comment, di notes boxnya akan kasih tau email yang komen dan time stampnya") is itself a
// small append-only list of {email, timestamp, text} — capped independently of the main Log so one
// chatty thread can't crowd out another function's own history.
const APPROVAL_NOTES_MAX_ENTRIES_ = 300;

/** Loads the whole Approval JSON file, seeding it (and the FDR bootstrap) if it doesn't exist yet. */
function loadApprovalStore_() {
  const root = DriveApp.getFolderById(ROOT_FOLDER_ID);
  const files = root.getFilesByName(APPROVAL_FILE_NAME);
  let store = { access: [], approvals: {}, log: [] };
  if (files.hasNext()) {
    try {
      const parsed = JSON.parse(files.next().getBlob().getDataAsString());
      if (parsed && typeof parsed === 'object') {
        store = {
          access: Array.isArray(parsed.access) ? parsed.access : [],
          approvals: (parsed.approvals && typeof parsed.approvals === 'object') ? parsed.approvals : {},
          log: Array.isArray(parsed.log) ? parsed.log : [],
        };
      }
    } catch (err) {
      // corrupt file — fall back to a fresh store; ensureSeedFdrPresent_ below still seeds it
    }
  }
  const seeded = ensureSeedFdrPresent_(store);
  if (seeded.changed) saveApprovalStore_(seeded.store);
  return seeded.store;
}

function saveApprovalStore_(store) {
  const root = DriveApp.getFolderById(ROOT_FOLDER_ID);
  const json = JSON.stringify(store);
  const existing = root.getFilesByName(APPROVAL_FILE_NAME);
  if (existing.hasNext()) existing.next().setContent(json);
  else root.createFile(APPROVAL_FILE_NAME, json, MimeType.PLAIN_TEXT);
}

/** Mirrors ensureOwnerPresent_ exactly — adds any of SEED_FDR_EMAILS_ missing from `access` as FDR. */
function ensureSeedFdrPresent_(store) {
  let changed = false;
  SEED_FDR_EMAILS_.forEach(email => {
    const clean = email.toLowerCase();
    const entry = findApprovalAccessEntry_(store, clean);
    if (!entry) {
      store.access.push({ email: clean, function: 'fdr', grantedBy: 'system', grantedAt: new Date().toISOString() });
      changed = true;
    } else if (entry.function !== 'fdr') {
      // Only ever ADDS the seed FDRs' own membership back if it's somehow missing — never forces
      // fdr back onto someone a real FDR has since deliberately reassigned/removed, since `changed`
      // isn't set here (this branch intentionally does nothing beyond the comment).
    }
  });
  return { store: store, changed: changed };
}

function findApprovalAccessEntry_(store, email) {
  const e = String(email || '').toLowerCase();
  for (let i = 0; i < store.access.length; i++) {
    if (String(store.access[i].email || '').toLowerCase() === e) return store.access[i];
  }
  return null;
}

/** 'ar' | 'commercial' | 'fdr' | null — null means this person has dashboard access but no Approval Function. */
function getApprovalFunctionFor_(store, email) {
  const entry = findApprovalAccessEntry_(store, email);
  return entry ? entry.function : null;
}

function isApprovalFdr_(store, email) {
  return getApprovalFunctionFor_(store, email) === 'fdr';
}

/** Live, dynamic list of every current FDR member's email — never hardcoded, per Zoltraak's point 6. */
function getFdrEmails_(store) {
  return store.access.filter(a => a.function === 'fdr').map(a => String(a.email).toLowerCase());
}

function emptyApprovalFunctionRecord_() {
  return { checked: false, checkedBy: '', checkedAt: '', sales: null, cogs: null, rebates: null, notes: [] };
}

function emptyApprovalMonthRecord_() {
  const rec = { systemSnapshot: null };
  APPROVAL_FUNCTION_KEYS_.forEach(k => { rec[k] = emptyApprovalFunctionRecord_(); });
  return rec;
}

function getOrCreateApprovalMonthRecord_(store, storeName, month) {
  if (!store.approvals[storeName]) store.approvals[storeName] = {};
  if (!store.approvals[storeName][month]) store.approvals[storeName][month] = emptyApprovalMonthRecord_();
  return store.approvals[storeName][month];
}

/** Appends one entry (timestamp added here) to the shared Log, dropping the oldest past the cap. */
function appendApprovalLog_(store, entry) {
  store.log.push(Object.assign({ timestamp: new Date().toISOString() }, entry));
  if (store.log.length > APPROVAL_LOG_MAX_ENTRIES_) {
    store.log.splice(0, store.log.length - APPROVAL_LOG_MAX_ENTRIES_);
  }
}

/**
 * Parses a Sales of Goods/COGS/Rebates entry — digits only, optionally comma-grouped (the client
 * already auto-formats to "1,234,567" on Enter/blur — see Dashboard.html's formatApprovalNumberInput_
 * — but this is validated again here since a direct RPC call could bypass the client entirely).
 * Whole numbers only, no decimals, per Zoltraak's point 2. Negative numbers ARE accepted here (this
 * only validates the CHARACTER FORMAT); the "can't checklist while any of the 3 fields is empty or
 * < 0" rule is a separate business check at checklist time (setApprovalChecklist below), not a format
 * error — matching the pop-up's own literal message, which is about digit/comma/decimal shape only.
 * Throws with the exact message Zoltraak specified for the pop-up on a genuine format error.
 */
function parseApprovalNumber_(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (s === '') return null; // an intentionally-cleared field — distinct from 0
  // Accepts "1234567", "1,234,567", or either with a leading "-" — rejects decimals, misplaced
  // commas (e.g. "1.234.567" or "12,34,567"), letters, etc.
  if (!/^-?\d{1,3}(,\d{3})*$/.test(s) && !/^-?\d+$/.test(s)) {
    throw new Error('Format is invalid, use these instead: 1,234,567 or 1234567');
  }
  const n = Number(s.replace(/,/g, ''));
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error('Format is invalid, use these instead: 1,234,567 or 1234567');
  }
  return n;
}

/** Throws unless `email` has dashboard access at all (layer 1) — used before even reading Approval data. */
function requireDashboardAccess_(email) {
  const list = loadAccessList_();
  if (!findAccessEntry_(list, email)) {
    throw new Error('You do not have access to this dashboard.');
  }
}

/** Throws unless `email` has an Approval Function (layer 2) — returns that Function's key. */
function requireApprovalFunction_(approvalStore, email) {
  const fn = getApprovalFunctionFor_(approvalStore, email);
  if (!fn) throw new Error('You do not have Approval access. Ask an FDR user to grant it.');
  return fn;
}

function requireApprovalFdr_(approvalStore, email) {
  if (!isApprovalFdr_(approvalStore, email)) {
    throw new Error('Only Finance Data & Reporting can do this.');
  }
}

function assertApprovalStoreName_(storeName) {
  if (APPROVAL_STORES_.indexOf(storeName) === -1) {
    throw new Error('"' + storeName + '" is not an Official Store this dashboard tracks Approval for.');
  }
}

function assertApprovalMonthKey_(month) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) {
    throw new Error('"' + month + '" is not a valid period (expected YYYY-MM).');
  }
}

function assertApprovalFunctionKey_(func) {
  if (APPROVAL_FUNCTION_KEYS_.indexOf(func) === -1) {
    throw new Error('"' + func + '" is not a recognized Approval Function.');
  }
}

function yyyymmddHhmm_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone() || 'Asia/Jakarta', 'yyyyMMdd HHmm');
}

/**
 * Sends the anulir notification email — Zoltraak's point 10: To = whoever most recently approved
 * this exact Function's checklist (captured by the caller BEFORE clearing checkedBy/checkedAt), Cc =
 * every CURRENT FDR member (live, per getFdrEmails_ — never hardcoded) plus APPROVAL_STATIC_CC_
 * always (Zoltraak's point 6). Skipped entirely if there's no one to notify (checklist was never
 * actually approved by anyone) or the notify target IS the person doing the anulir (no point emailing
 * yourself). Wrapped by the caller in try/catch — a Gmail quota hiccup or bad address must never
 * block the anulir action itself from completing (same "never let a side-effect fail the main
 * action" posture as applyExportRowHighlights_'s own try/catch in writeExportSheet_).
 */
function sendApprovalAnulEmail_(approvalStore, storeName, month, funcKey, notifyEmail, byEmail, reason) {
  if (!notifyEmail || notifyEmail === byEmail) return;
  const funcLabel = (APPROVAL_FUNCTIONS_.find(f => f.key === funcKey) || {}).label || funcKey;
  const cc = getFdrEmails_(approvalStore).filter(e => e !== notifyEmail);
  if (cc.indexOf(APPROVAL_STATIC_CC_) === -1) cc.push(APPROVAL_STATIC_CC_);
  const subject = '[Need Approval] - Dashboard "' + APPROVAL_DASHBOARD_LABEL_ + '" ' + yyyymmddHhmm_(new Date());
  const url = (function () { try { return ScriptApp.getService().getUrl(); } catch (err) { return ''; } })();
  const body = 'Your ' + funcLabel + ' approval for ' + storeName + ' — ' + month + ' has been revoked by ' +
    byEmail + '.\n\n' +
    'Reason:\n' + reason + '\n\n' +
    (url ? ('Open the dashboard to review and re-approve: ' + url + '\n\n') : '') +
    'This is an automated notification from ' + APPROVAL_DASHBOARD_LABEL_ + '.';
  MailApp.sendEmail({ to: notifyEmail, cc: cc.join(','), subject: subject, body: body });
}

/**
 * Main Approval-tab data loader (google.script.run RPC). Requires dashboard access (layer 1) but NOT
 * an Approval Function (layer 2) — per Zoltraak's confirmed answer, anyone with dashboard access can
 * see Approval read-only; write actions are individually gated in the mutating RPCs below. Returns
 * everything the client needs to render every store/month at once — this dataset is small (2 stores x
 * however many months x 3 Functions) so there's no pagination.
 *
 * `roles` (added 2026-09-03, Zoltraak's Log-ordering request) is an email(lowercase) -> dashboard
 * role map built from the same layer-1 access list getOnlineUsers() already exposes to every viewer
 * the same way — so this isn't a new data exposure, just reusing that existing precedent for the Log
 * tab's own Owner -> Admin -> User + alphabetical sort (Dashboard.html's Approval.renderLog_).
 */
function getApprovalPageData() {
  const email = getCurrentUserEmail_();
  requireDashboardAccess_(email);
  const store = loadApprovalStore_();
  const myFunction = getApprovalFunctionFor_(store, email);
  const approvals = {};
  APPROVAL_STORES_.forEach(s => { approvals[s] = store.approvals[s] || {}; });
  const roles = {};
  loadAccessList_().forEach(u => { roles[String(u.email).toLowerCase()] = u.role; });
  return {
    currentEmail: email,
    myFunction: myFunction,
    isFdr: myFunction === 'fdr',
    functions: APPROVAL_FUNCTIONS_,
    stores: APPROVAL_STORES_,
    groupName: APPROVAL_GROUP_NAME_,
    approvals: approvals,
    access: store.access,
    log: store.log,
    roles: roles,
  };
}

/**
 * FDR-only (google.script.run RPC): the "Access" mini-tab's own data — the FULL dashboard access
 * list (layer 1, from ACCESS_FILE_NAME — an FDR can only grant Approval access to someone who
 * already has dashboard access at all) alongside the current Approval `access` array (layer 2), so
 * the client can render one combined table with a grant-approval-access checkbox + Function dropdown
 * per dashboard user.
 */
function getApprovalAccessList() {
  const email = getCurrentUserEmail_();
  const store = loadApprovalStore_();
  requireApprovalFdr_(store, email);
  return {
    dashboardAccess: loadAccessList_(),
    approvalAccess: store.access,
    currentEmail: email,
    functions: APPROVAL_FUNCTIONS_,
  };
}

/**
 * FDR-only (google.script.run RPC): grants or revokes a dashboard user's Approval Function.
 * `granted=true` requires `func` to be one of APPROVAL_FUNCTION_KEYS_ — one person, one Function
 * (setting a new one overwrites any previous one, never adds a second). Refuses to demote/remove the
 * LAST remaining FDR member (mirrors removeUser's "the Owner cannot be removed" guard) so the tool
 * can never lock every FDR out of managing it — if that's genuinely needed, another FDR member must
 * be granted first.
 */
function setApprovalAccess(targetEmail, granted, func) {
  const callerEmail = getCurrentUserEmail_();
  const clean = String(targetEmail || '').trim().toLowerCase();
  if (!isValidEmail_(clean)) throw new Error('"' + targetEmail + '" doesn\'t look like a valid email address.');
  let errorMsg = null;
  const result = withScriptLock_(() => {
    const store = loadApprovalStore_();
    requireApprovalFdr_(store, callerEmail);
    if (!findAccessEntry_(loadAccessList_(), clean)) {
      errorMsg = clean + ' does not have dashboard access yet — grant that first.';
      return null;
    }
    const existing = findApprovalAccessEntry_(store, clean);
    const wasLastFdr = existing && existing.function === 'fdr' &&
      store.access.filter(a => a.function === 'fdr').length <= 1;
    if (wasLastFdr && (!granted || func !== 'fdr')) {
      errorMsg = clean + ' is the last remaining Finance Data & Reporting user — grant FDR to someone else first.';
      return null;
    }
    if (!granted) {
      store.access = store.access.filter(a => String(a.email).toLowerCase() !== clean);
      appendApprovalLog_(store, { email: callerEmail, action: 'access_revoked', store: '', month: '', function: '', details: 'Revoked Approval access from ' + clean });
    } else {
      assertApprovalFunctionKey_(func);
      if (existing) {
        existing.function = func;
        existing.grantedBy = callerEmail;
        existing.grantedAt = new Date().toISOString();
      } else {
        store.access.push({ email: clean, function: func, grantedBy: callerEmail, grantedAt: new Date().toISOString() });
      }
      appendApprovalLog_(store, { email: callerEmail, action: 'access_granted', store: '', month: '', function: func, details: 'Granted ' + func + ' Approval access to ' + clean });
    }
    saveApprovalStore_(store);
    return { access: store.access };
  }, 10000);
  if (errorMsg) throw new Error(errorMsg);
  if (!result) throw new Error('Approval data is busy right now — please try again in a moment.');
  return result;
}

/**
 * Saves one Sales of Goods/COGS/Rebates field (google.script.run RPC) for Finance AR or Commercial.
 * Caller must own that exact Function OR be FDR (Zoltraak's point 4: "FDR pny akses ke semua input
 * box") — but even FDR is refused once that Function's checklist is already checked: editing a
 * LOCKED number isn't offered at all, by design (see this function's own error message) — an FDR who
 * needs to change an approved number un-checks it first (with a reason — setApprovalChecklist below),
 * which is the same explicit, logged, notified path a genuine correction should go through anyway.
 */
function saveApprovalNumber(storeName, month, func, field, rawValue) {
  assertApprovalStoreName_(storeName);
  assertApprovalMonthKey_(month);
  if (func !== 'ar' && func !== 'commercial') throw new Error('Only Finance AR and Commercial have number fields.');
  if (APPROVAL_NUMBER_FIELDS_.indexOf(field) === -1) throw new Error('"' + field + '" is not one of Sales of Goods/COGS/Rebates.');
  const email = getCurrentUserEmail_();
  const parsed = parseApprovalNumber_(rawValue); // validate BEFORE the lock — no need to hold it while parsing
  let errorMsg = null;
  const result = withScriptLock_(() => {
    const store = loadApprovalStore_();
    const myFunc = requireApprovalFunction_(store, email);
    if (myFunc !== func && myFunc !== 'fdr') {
      errorMsg = 'You can only edit ' + (myFunc === 'ar' ? 'Finance AR' : myFunc === 'commercial' ? 'Commercial' : 'your own') + "'s numbers.";
      return null;
    }
    const rec = getOrCreateApprovalMonthRecord_(store, storeName, month);
    if (rec[func].checked) {
      errorMsg = 'This has already been approved — uncheck it first (Finance Data & Reporting only, with a reason) before editing the number.';
      return null;
    }
    rec[func][field] = parsed;
    appendApprovalLog_(store, { email: email, action: 'number_saved', store: storeName, month: month, function: func, details: field + ' = ' + (parsed == null ? '(cleared)' : parsed.toLocaleString('en-US')) });
    saveApprovalStore_(store);
    return { record: rec };
  }, 10000);
  if (errorMsg) throw new Error(errorMsg);
  if (!result) throw new Error('Approval data is busy right now — please try again in a moment.');
  return result;
}

/**
 * Appends one comment (google.script.run RPC) to a Function's own notes thread — Zoltraak's point 4:
 * every entry keeps its own email + timestamp, shown compactly (client renders just the latest line,
 * full thread on demand) rather than one overwritable field. Anyone with an Approval Function can
 * comment on ANY function's thread (mirrors FDR's blanket access, but Zoltraak didn't actually
 * restrict comments to "your own function or FDR" the way numbers/checklist are restricted — a
 * comment is lower-stakes and cross-function visibility is exactly the point of a shared notes
 * thread), as long as they have Approval access at all.
 */
function saveApprovalNotes(storeName, month, func, text) {
  assertApprovalStoreName_(storeName);
  assertApprovalMonthKey_(month);
  assertApprovalFunctionKey_(func);
  const clean = String(text || '').trim().slice(0, 2000);
  if (!clean) throw new Error('Comment cannot be empty.');
  const email = getCurrentUserEmail_();
  let errorMsg = null;
  const result = withScriptLock_(() => {
    const store = loadApprovalStore_();
    requireApprovalFunction_(store, email);
    const rec = getOrCreateApprovalMonthRecord_(store, storeName, month);
    rec[func].notes.push({ email: email, timestamp: new Date().toISOString(), text: clean });
    if (rec[func].notes.length > APPROVAL_NOTES_MAX_ENTRIES_) {
      rec[func].notes.splice(0, rec[func].notes.length - APPROVAL_NOTES_MAX_ENTRIES_);
    }
    appendApprovalLog_(store, { email: email, action: 'comment', store: storeName, month: month, function: func, details: clean.slice(0, 200) });
    saveApprovalStore_(store);
    return { record: rec };
  }, 10000);
  if (errorMsg) throw new Error(errorMsg);
  if (!result) throw new Error('Approval data is busy right now — please try again in a moment.');
  return result;
}

/**
 * Checks or unchecks one Function's approval (google.script.run RPC) — the core action.
 *
 * CHECKING (checked=true): caller must own that Function, or be FDR (Zoltraak's point 4 — FDR can
 * checklist on someone's behalf too, though in practice this should be rare; whoever actually clicks
 * it is who gets stamped as checkedBy/checkedAt, which is also who a future anulir email would notify
 * — see sendApprovalAnulEmail_). Finance AR/Commercial require all 3 number fields present and >= 0
 * (Zoltraak's point 2 — "kosong atau < 0" blocks the checklist). FDR requires BOTH Finance AR and
 * Commercial already checked (Zoltraak's point 3 — order between AR/Commercial themselves is free,
 * but FDR is always last). `systemValues` (the live, client-computed Sales of Goods/COGS/Rebates for
 * this store+month — Code.gs has no independent copy of deriveMetrics, it's entirely a Dashboard.html
 * concept) is captured as this month's systemSnapshot on every AR/Commercial check, refreshing the
 * baseline reportSystemDrift below compares future loads against.
 *
 * UNCHECKING (checked=false) is "anulir" — ONLY Finance Data & Reporting can do this, for ANY
 * Function including FDR's own (Zoltraak's point 4/10), and ALWAYS requires a non-empty `reason`
 * (point 5) — which is also appended to that Function's own notes thread (point 4's "namun ketika ada
 * yang comment, di notes boxnya akan kasih tau email yang komen dan time stampnya" — an anulir reason
 * IS a comment) and emailed to whoever had approved it (point 10).
 */
function setApprovalChecklist(storeName, month, func, checked, systemValues, reason) {
  assertApprovalStoreName_(storeName);
  assertApprovalMonthKey_(month);
  assertApprovalFunctionKey_(func);
  const email = getCurrentUserEmail_();
  let errorMsg = null;
  let emailArgs = null; // set inside the lock on a real anulir, sent AFTER the lock is released
  const result = withScriptLock_(() => {
    const store = loadApprovalStore_();
    const myFunc = requireApprovalFunction_(store, email);
    const rec = getOrCreateApprovalMonthRecord_(store, storeName, month);

    if (checked) {
      if (myFunc !== func && myFunc !== 'fdr') {
        errorMsg = 'You can only checklist your own Function.';
        return null;
      }
      const fdef = APPROVAL_FUNCTIONS_.find(f => f.key === func);
      if (fdef.hasNumbers) {
        const bad = APPROVAL_NUMBER_FIELDS_.some(f => rec[func][f] == null || rec[func][f] < 0);
        if (bad) {
          errorMsg = 'Fill in Sales of Goods, COGS and Rebates (0 or more) before checklisting.';
          return null;
        }
      } else {
        // func === 'fdr'
        if (!rec.ar.checked || !rec.commercial.checked) {
          errorMsg = 'Finance AR and Commercial must both approve before Finance Data & Reporting can.';
          return null;
        }
      }
      rec[func].checked = true;
      rec[func].checkedBy = email;
      rec[func].checkedAt = new Date().toISOString();
      if (fdef.hasNumbers && systemValues && typeof systemValues === 'object') {
        rec.systemSnapshot = {
          sales: Number(systemValues.sales) || 0,
          cogs: Number(systemValues.cogs) || 0,
          rebates: Number(systemValues.rebates) || 0,
          capturedAt: new Date().toISOString(),
        };
      }
      appendApprovalLog_(store, { email: email, action: 'approved', store: storeName, month: month, function: func, details: '' });
    } else {
      requireApprovalFdr_(store, email);
      const clean = String(reason || '').trim().slice(0, 2000);
      if (!clean) {
        errorMsg = 'A reason is required to un-check an approval.';
        return null;
      }
      const notifyEmail = rec[func].checkedBy;
      rec[func].checked = false;
      rec[func].checkedBy = '';
      rec[func].checkedAt = '';
      rec[func].notes.push({ email: email, timestamp: new Date().toISOString(), text: '[Revoked] ' + clean });
      if (rec[func].notes.length > APPROVAL_NOTES_MAX_ENTRIES_) {
        rec[func].notes.splice(0, rec[func].notes.length - APPROVAL_NOTES_MAX_ENTRIES_);
      }
      appendApprovalLog_(store, { email: email, action: 'revoked', store: storeName, month: month, function: func, details: clean, notifiedEmail: notifyEmail || '' });
      if (notifyEmail) emailArgs = [storeName, month, func, notifyEmail, email, clean];
    }
    saveApprovalStore_(store);
    return { record: rec };
  }, 10000);
  if (errorMsg) throw new Error(errorMsg);
  if (!result) throw new Error('Approval data is busy right now — please try again in a moment.');
  // Sent OUTSIDE the lock (a slow network call — see resolveProfilePhotoUrl_'s own comment above on
  // why holding the shared lock during a slow external call would serialize every other concurrent
  // Approval action behind it) and wrapped so a Gmail quota/address hiccup can never undo an anulir
  // that's already been saved.
  if (emailArgs) {
    try {
      const freshStore = loadApprovalStore_(); // fresh getFdrEmails_/CC list, not the pre-lock snapshot
      sendApprovalAnulEmail_(freshStore, emailArgs[0], emailArgs[1], emailArgs[2], emailArgs[3], emailArgs[4], emailArgs[5]);
    } catch (err) { /* the anulir itself already succeeded and was saved — never fail it over email */ }
  }
  return result;
}

/**
 * Called opportunistically by the client (google.script.run RPC) whenever it notices — by comparing
 * its own live, freshly-computed system Sales of Goods/COGS/Rebates against this month's stored
 * systemSnapshot — that the dashboard's numbers have moved since Finance AR/Commercial last approved
 * (Zoltraak's point 7: a daily refreshData() run can change the underlying Data Claim numbers at any
 * time). Finance AR/Commercial's own checklists stay locked exactly as they were (Zoltraak: "approval
 * tetap di locked") — only Finance Data & Reporting's checklist is cleared, forcing a re-check, and
 * only if it was actually checked (a no-op otherwise, so this is safe to call on every page load for
 * every store/month with any approval history without spamming the Log). Re-verifies the drift itself
 * server-side (never trusts the client's own comparison) before touching anything, and always
 * refreshes systemSnapshot to the given values either way so the same drift isn't reported again next
 * load. This is a SYSTEM event, not a person's anulir — no reason is collected and no email is sent,
 * only the Log entry and the red "system changed" flag the client renders from a mismatched
 * systemSnapshot.
 */
function reportSystemDrift(storeName, month, systemValues) {
  assertApprovalStoreName_(storeName);
  assertApprovalMonthKey_(month);
  const email = getCurrentUserEmail_();
  requireDashboardAccess_(email); // read-only viewers' pages can trigger this too — no Approval Function required
  const sv = {
    sales: Number(systemValues && systemValues.sales) || 0,
    cogs: Number(systemValues && systemValues.cogs) || 0,
    rebates: Number(systemValues && systemValues.rebates) || 0,
  };
  const result = withScriptLock_(() => {
    const store = loadApprovalStore_();
    const rec = getOrCreateApprovalMonthRecord_(store, storeName, month);
    const snap = rec.systemSnapshot;
    const changed = !snap || snap.sales !== sv.sales || snap.cogs !== sv.cogs || snap.rebates !== sv.rebates;
    if (!changed) return { record: rec, changed: false };
    if (rec.fdr.checked) {
      rec.fdr.checked = false;
      rec.fdr.checkedBy = '';
      rec.fdr.checkedAt = '';
      appendApprovalLog_(store, { email: '(system)', action: 'system_drift_cleared_fdr', store: storeName, month: month, function: 'fdr', details: 'Dashboard numbers changed since last approval — Finance Data & Reporting must re-check.' });
    }
    rec.systemSnapshot = Object.assign({}, sv, { capturedAt: new Date().toISOString() });
    saveApprovalStore_(store);
    return { record: rec, changed: true };
  }, 10000);
  return result || { record: getOrCreateApprovalMonthRecord_(loadApprovalStore_(), storeName, month), changed: false };
}

// ====================== WEB APP ======================

/**
 * Returns the currently-deployed DASHBOARD_VERSION string — called by the client
 * (google.script.run) on an interval to detect that a new deployment has gone out since the page
 * was loaded. See DASHBOARD_VERSION's comment above for the full picture.
 */
function getDashboardVersion() {
  return DASHBOARD_VERSION;
}

function doGet(e) {
  const accessList = loadAccessList_();
  const currentEmail = getCurrentUserEmail_();
  const entry = findAccessEntry_(accessList, currentEmail);
  if (!entry) {
    return buildAccessDeniedOutput_(currentEmail);
  }

  let json = loadCachedData_();
  if (!json) {
    // No cache yet (first run) — compute synchronously so the page still works, though this
    // will be slow the very first time. Every load after this uses the cache instead.
    refreshData();
    json = loadCachedData_();
  }
  // No Consignment tab in this fork — the cache payload only ever has DATA/MP_DATA/warnings (see
  // refreshData()'s payload construction below), so this just re-serializes it as-is. Kept as an
  // explicit JSON.parse/stringify round-trip (rather than embedding `json` directly) so a corrupt
  // cache falls back cleanly instead of embedding invalid JSON into the page.
  let payloadForPage;
  try {
    const parsed = JSON.parse(json);
    payloadForPage = JSON.stringify({
      generatedAt: parsed.generatedAt,
      DATA: parsed.DATA || [],
      MP_DATA: parsed.MP_DATA || [],
      warnings: parsed.warnings || [],
    });
  } catch (err) {
    payloadForPage = json; // corrupt cache — fall back to embedding it as-is, same as before this change
  }
  // Guard against literal "</script>" inside any brand/marketplace name breaking the page.
  const safeJson = payloadForPage.replace(/</g, '\\u003c');
  const accessJson = JSON.stringify({
    list: accessList,
    currentEmail: currentEmail,
    currentRole: entry.role,
  }).replace(/</g, '\\u003c');

  const template = HtmlService.createTemplateFromFile('Dashboard');
  template.dataJson = safeJson;
  template.accessJson = accessJson;
  template.dashboardVersionJson = JSON.stringify(DASHBOARD_VERSION);
  return template.evaluate()
    .setTitle('Pareto - Outright - Financial Statement Overview')
    // maximum-scale/minimum-scale are only a hint some older mobile browsers honor for pinch
    // zoom — desktop browsers (Chrome/Edge/Firefox Ctrl +/-) and most modern mobile browsers
    // intentionally ignore page-level zoom limits for accessibility, so this can't actually
    // enforce a hard 75–100% range. Layout has been made to hold up correctly across that
    // range instead (see Dashboard.html's resize-triggered column/width re-sync).
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=0.75')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ====================== "DOWNLOAD EXCEL" -> GOOGLE SHEETS EXPORT ======================
// Replaces the old client-side SheetJS file download (2026-08-21 per Zoltraak: "ketika kita klik
// download, dashboard akan langsung provide google spreadsheet dan adding new tab directly...
// dibagi ke beberapa sheet per warehouse, per store, per marketplace dan per period"). ALL the
// aggregation (which rows, which columns, what number goes in which cell) happens client-side in
// Dashboard_Betadine.html's buildExportPayload_()/EXPORT_DIMENSIONS — reusing the exact same
// computeGrand()/computeGrandStores()/computeGrandWarehouses()/computeGrandMarketplaces()/
// OUTRIGHT_ROW_DEFS logic that already drives the on-screen tables and Grand Total breakdowns, so
// the exported numbers are guaranteed to match what the dashboard itself shows for the same data.
// This side's only job is turning that already-computed payload into a real Google Spreadsheet.

// Fixed destination folder for every "Export to Sheets" spreadsheet — per Zoltraak 2026-08-21
// ("always put the export sheet at this folders: https://drive.google.com/drive/folders/
// 112fKB4nyEH4qzZ0XOw3moGjJGAEFP-T9"), superseding the earlier 2026-08-21 answer that had this
// reuse ROOT_FOLDER_ID (the "FS Overview" source-data folder) — kept as its OWN constant rather
// than repointing ROOT_FOLDER_ID itself, since ROOT_FOLDER_ID is still load-bearing everywhere else
// in this file for reading the source Data Claim/Platform Fee files, which stays unchanged.
const EXPORT_FOLDER_ID = '112fKB4nyEH4qzZ0XOw3moGjJGAEFP-T9';

/**
 * Creates a brand-new Google Spreadsheet directly in EXPORT_FOLDER_ID with one tab per
 * `payload.sheets[i]`, and returns its URL so the client can open it immediately.
 *
 * Filename: "<year> - FSOP - <Official Store Name> Version <N>" — exact template + versioning
 * scheme specified by Zoltraak (2026-08-21, revised same day to this " - "-separated form —
 * e.g. "2026 - FSOP - Betadine Group Version 1" for a combined/grouped export, "2026 - FSOP -
 * Betadine Store Version 1" for a standalone store). The Official Store Name segment is whatever
 * Dashboard_Betadine.html's exportStoreLabel_ sends as `payload.storeLabel` verbatim — including a
 * combined/virtual group's own name (e.g. "Betadine Group") completely unchanged, per Zoltraak's
 * explicit confirmation that the literal group name should be used rather than a "Combined" alias.
 * N is derived by scanning EXPORT_FOLDER_ID for existing files matching this year + store label
 * (nextExportVersion_ below) and taking the highest existing version plus one, rather than a
 * separately-stored counter, so it can never drift out of sync with what's actually sitting in
 * Drive (a counter in Script Properties could get out of step if a file were ever renamed or
 * deleted).
 *
 * @param {{storeLabel: string, sheets: Array<{sheetName: string, columnHeaders: string[],
 *   rowLabels: string[], rowFormats: string[], values: number[][]}>}} payload
 * @return {{url: string, fileName: string}}
 */
function createExportSpreadsheet(payload) {
  if (!payload || !payload.sheets || !payload.sheets.length) {
    throw new Error('No sheet data provided to export.');
  }
  const year = new Date().getFullYear();
  // Sheets tab/Drive filenames tolerate most punctuation, but keep this defensively simple —
  // collapse any stray newline/tab a weird store name might carry into a plain space.
  const storeLabel = String(payload.storeLabel || 'All Stores').trim().replace(/\s+/g, ' ');
  const version = nextExportVersion_(year, storeLabel);
  const fileName = year + ' - FSOP - ' + storeLabel + ' Version ' + version;

  const ss = SpreadsheetApp.create(fileName);
  const defaultSheet = ss.getSheets()[0];

  payload.sheets.forEach((sheetDef, i) => {
    const sheet = (i === 0) ? defaultSheet : ss.insertSheet();
    // Sheet tab names must be <=100 chars and unique within the file — EXPORT_DIMENSIONS' 4 names
    // ("Per Period"/"Per Official Store"/"Per Warehouse"/"Per Marketplace") already satisfy both,
    // this slice is just a defensive backstop against some future 5th dimension with a long name.
    sheet.setName(String(sheetDef.sheetName || ('Sheet' + (i + 1))).slice(0, 100));
    writeExportSheet_(sheet, sheetDef);
  });

  // SpreadsheetApp.create() always creates the file at My Drive's root first — DriveApp.moveTo is
  // what actually relocates it into EXPORT_FOLDER_ID.
  const file = DriveApp.getFileById(ss.getId());
  file.moveTo(DriveApp.getFolderById(EXPORT_FOLDER_ID));

  return { url: ss.getUrl(), fileName: fileName };
}

// Physical row layout constants — MUST stay in sync with Dashboard_Betadine.html's own
// EXPORT_HEADER_ROW/EXPORT_DATA_START_ROW (see that file's own comment for the full prefix block
// this defines: row 1 is the header, rows 2-8 are the 7 % Move./% Run Rate metric rows — mirroring
// the dashboard's own Movement Rate mini table row-for-row, REVISED 2026-08-31 to add the Current/
// Previous Quarter rows — row 9 is a blank spacer, row 10+ is every existing metric row completely
// unchanged in content, just shifted down from starting at row 8 to starting at row 10.
const EXPORT_HEADER_ROW_ = 1;
const EXPORT_DATA_START_ROW_ = 10;

/**
 * Writes one export tab: a bold header row (blank corner cell + "Item" + `columnHeaders`, at
 * EXPORT_HEADER_ROW_, month headers center-aligned), the 7 Movement Rate prefix metric rows
 * (`prefixRows` — rows EXPORT_HEADER_ROW_+1..+7, i.e. 2-8) right after it, a blank spacer row, a
 * label column (`rowLabels`, bold except for a per-store breakdown sub-row — see `rowIsBold` below)
 * starting at EXPORT_DATA_START_ROW_, and the `values` matrix — then applies `rowFormats[i]`'s
 * number format to that whole row's data range in one call per row (cheap: OUTRIGHT_ROW_DEFS is at
 * most ~30 rows, so this is ~30 setNumberFormat calls per sheet, not one per cell). Finally applies
 * this sheet's own column/row outline groups, if any (`columnGroups`/`rowGroups` — added 2026-08-26
 * per Zoltraak's Q1/Q2/H1 + per-store breakdown request, extended 2026-08-27 to also cover the
 * prefix rows' own combined group [rows 2-8 as of the 2026-08-31 Current/Previous Quarter addition]
 * — the header at row 1 is deliberately excluded from that group so it never collapses away,
 * confirmed with Zoltraak — and again 2026-08-31 for the new Rebates/Claim-Vouchers-blank-line
 * sub-row groups, see buildExportPayload_'s own comment; every other sheet passes empty arrays
 * here, a no-op).
 */
// Highest/lowest highlight colors — added 2026-08-31 per Zoltraak ("at all lines... highlight
// colour Dark Bold Blue for the highest and Dark Bold Red for the lowest ... this is to make it
// easier analyzed the pain point and achievement point"). Same hex values as
// Dashboard_Betadine.html's own .cell-highest/.cell-lowest CSS, so the exported spreadsheet reads
// identically to the on-screen dashboard.
const EXPORT_HIGHLIGHT_COLORS_ = { highest: '#0b2f7a', lowest: '#8a1414' };

/**
 * Turns one block's `highlights` array (one {highest, lowest} entry per row — each a plain array of
 * 0-based column indices, from Dashboard_Betadine.html's computeHighlightCols_) into real
 * setFontWeight('bold')/setFontColor calls on those exact cells. Bold+color is layered ON TOP of
 * whatever value/format that cell already got a few lines above in writeExportSheet_ — a live
 * formula cell keeps its formula, only its font changes — matching the dashboard's own "bold
 * colored text only, no cell background fill" convention (confirmed with Zoltraak).
 *
 * `startRow`/`dataCol` are the same 1-based anchor writeExportSheet_ already uses for that block
 * (EXPORT_DATA_START_ROW_/DATA_COL_ for the main table, prefixStartRow/DATA_COL_ for the 5 %
 * Move./% Run Rate rows) — `highlights[r]`'s column indices are 0-based offsets from `dataCol`,
 * exactly mirroring how `values[r][colIdx]` already maps onto that same cell.
 *
 * @param {Sheet} sheet
 * @param {number} startRow
 * @param {number} dataCol
 * @param {Array<{highest: number[], lowest: number[]}>} highlights
 */
function applyExportRowHighlights_(sheet, startRow, dataCol, highlights) {
  if (!highlights || !highlights.length) return;
  highlights.forEach(function (h, r) {
    if (!h) return;
    (h.highest || []).forEach(function (colIdx) {
      sheet.getRange(startRow + r, dataCol + colIdx).setFontWeight('bold').setFontColor(EXPORT_HIGHLIGHT_COLORS_.highest);
    });
    (h.lowest || []).forEach(function (colIdx) {
      sheet.getRange(startRow + r, dataCol + colIdx).setFontWeight('bold').setFontColor(EXPORT_HIGHLIGHT_COLORS_.lowest);
    });
  });
}

function writeExportSheet_(sheet, sheetDef) {
  const columnHeaders = sheetDef.columnHeaders || [];
  const prefixRows = sheetDef.prefixRows || [];
  const rowLabels = sheetDef.rowLabels || [];
  const rowFormats = sheetDef.rowFormats || [];
  const rowIsBold = sheetDef.rowIsBold || [];
  const values = sheetDef.values || [];
  const rowHighlights = sheetDef.rowHighlights || [];
  const numCols = columnHeaders.length;
  const numRows = rowLabels.length;
  if (!numCols || !numRows) return;

  // Column B is a deliberately blank, very-thin spacer column between the row-label column (A) and
  // the first real data column — added 2026-08-31 per Zoltraak ("add a blank colomn between Col A
  // and C... the blank Colomn will not included as part of expand and collapse, the width of Colomn
  // B very thin"). It never gets any values/formatting written to it, is never referenced by
  // `sheetDef.columnGroups` (Dashboard_Betadine.html's buildExportPayload_ now offsets every data
  // column number by 3, not 2, specifically so column B is skipped by every outline group), and the
  // frozen-column boundary below is widened to include it ("untuk freeze kolom sesuaikan dari kolom
  // B") — so it scrolls together with column A rather than with the data. DATA_COL_ is the Sheets
  // column NUMBER the first data column now lives at (was 2/"B", now 3/"C") — every data write below
  // is keyed off this one constant so they all move together if this layout ever changes again.
  const DATA_COL_ = 3;

  // Row 1 — the header row (per Zoltraak: "baris ke -1 adalah header bulan"). 'Item' in A1, column B
  // left blank, month headers starting at column C, center-aligned ("Header Bulan tolong rata
  // tengah").
  sheet.getRange(EXPORT_HEADER_ROW_, 1).setValue('Item').setFontWeight('bold');
  sheet.getRange(EXPORT_HEADER_ROW_, DATA_COL_, 1, numCols).setValues([columnHeaders]).setFontWeight('bold');
  sheet.getRange(EXPORT_HEADER_ROW_, DATA_COL_, 1, numCols).setHorizontalAlignment('center');

  // Rows 2-6 — the % Move./% Run Rate prefix metrics, right after the header. Plain (non-bold)
  // rows, pct-formatted, same "one setValues call for the label column, one for the values matrix"
  // shape as the main table below — cheap since there are always exactly 5 of these.
  const prefixStartRow = EXPORT_HEADER_ROW_ + 1;
  if (prefixRows.length) {
    sheet.getRange(prefixStartRow, 1, prefixRows.length, 1).setValues(prefixRows.map(r => [r.label]));
    sheet.getRange(prefixStartRow, DATA_COL_, prefixRows.length, numCols).setValues(prefixRows.map(r => r.values));
    for (let r = 0; r < prefixRows.length; r++) {
      sheet.getRange(prefixStartRow + r, DATA_COL_, 1, numCols).setNumberFormat(prefixRows[r].format || '0.00"%"');
    }
    // Never let a cosmetic highlight fail the whole export — same "wrap and ignore" reasoning
    // writeExportSheet_'s own autoResizeColumns call already uses below.
    try {
      applyExportRowHighlights_(sheet, prefixStartRow, DATA_COL_, prefixRows.map(function (r) { return r.highlights; }));
    } catch (e) { /* ignore */ }
  }
  // Row 7 is left blank by design (no cell writes needed — a fresh sheet's cells start empty).

  sheet.getRange(EXPORT_DATA_START_ROW_, 1, numRows, 1).setValues(rowLabels.map(l => [l]));
  // Bold only the "real" ROW_DEFS rows — a per-store breakdown sub-row stays plain-weight, the same
  // visual "this is a sub-row, not a headline metric" cue the dashboard's own (non-bold)
  // .metric-breakdown-label rows give. `rowIsBold` is absent/empty for every sheet other than "Per
  // Period" (Per Official Store/Warehouse/Marketplace never set it), so `!== false` keeps every one
  // of their rows bold exactly as before this feature existed.
  for (let r = 0; r < numRows; r++) {
    if (rowIsBold[r] === false) continue;
    sheet.getRange(EXPORT_DATA_START_ROW_ + r, 1).setFontWeight('bold');
  }
  sheet.getRange(EXPORT_DATA_START_ROW_, DATA_COL_, numRows, numCols).setValues(values);
  for (let r = 0; r < numRows; r++) {
    sheet.getRange(EXPORT_DATA_START_ROW_ + r, DATA_COL_, 1, numCols).setNumberFormat(rowFormats[r] || '#,##0');
  }
  // Never let a cosmetic highlight fail the whole export — same "wrap and ignore" reasoning
  // writeExportSheet_'s own autoResizeColumns call already uses below.
  try {
    applyExportRowHighlights_(sheet, EXPORT_DATA_START_ROW_, DATA_COL_, rowHighlights);
  } catch (e) { /* ignore */ }
  // Freezes everything from the top through the Sales of Goods row — REVISED 2026-08-28 per
  // Zoltraak ("freeze line at line sales of goods"). Previously this always froze just the header +
  // 5 prefix rows (rows 1-6); `sheetDef.freezeRows` (Dashboard_Betadine.html's buildExportPayload_ —
  // rowNumberByKey.sales, known once the Sales of Goods row itself is written) now says exactly how
  // far down to freeze, so scrolling further down the sheet keeps the header, the 5 prefix metrics,
  // AND Sales of Goods all pinned in view. Falls back to the old header+prefix span defensively, in
  // case some future caller doesn't set it.
  sheet.setFrozenRows(sheetDef.freezeRows || (EXPORT_HEADER_ROW_ + prefixRows.length));
  // Freeze through column B (2 columns) — REVISED 2026-08-31 per Zoltraak ("untuk freeze kolom
  // sesuaikan dari kolom B"): previously froze only column A; now the blank spacer column B freezes
  // along with it, so the first column that actually scrolls is C, the first real data column.
  sheet.setFrozenColumns(2);
  applyExportColumnGroups_(sheet, sheetDef.columnGroups || []);
  applyExportRowGroups_(sheet, sheetDef.rowGroups || []);
  // Cosmetic only — never let a column-width quirk fail the whole export. Column A and the data
  // columns (C onward) auto-resize to fit their content; column B is deliberately skipped by
  // autoResizeColumns and instead pinned to a fixed, very-thin width right after, so it can never
  // grow back out even though it's always empty (auto-resize would likely shrink it too, but this
  // makes the "very thin" requirement explicit rather than incidental).
  try {
    sheet.autoResizeColumns(1, 1);
    sheet.autoResizeColumns(DATA_COL_, numCols);
  } catch (e) { /* ignore */ }
  try { sheet.setColumnWidth(2, 21); } catch (e) { /* ignore */ }
}

/**
 * Turns one "Per Period" sheet's `columnGroups` (each {start, end, depth}, 1-based Sheets column
 * numbers — see Dashboard_Betadine.html's buildExportPeriodColumns_/buildExportPayload_) into real
 * Sheets column outline groups, collapsed by default — added 2026-08-26 per Zoltraak ("tambahkan
 * kolom Q1 Q2 dan H1... dan feature expand collapse pada spreadsheet"). Every other export sheet
 * passes an empty array here (no-op).
 *
 * `start`/`end` are always >= 3 (column C onward) — Dashboard_Betadine.html's buildExportPayload_
 * offsets every group by +3, not +2, specifically so the blank spacer column B (see
 * writeExportSheet_'s own DATA_COL_ comment) can never end up inside a collapsible group, per
 * Zoltraak's "the blank Colomn will not included as part of expand and collapse".
 *
 * Control position is set to AFTER (Sheets' own default is BEFORE) because a group's range
 * deliberately stops short of its own Quarter/Half total column (see buildExportPeriodColumns_'s
 * own comment for why) — with AFTER, the +/- toggle renders in the column immediately following the
 * collapsed range, i.e. right on the Quarter/Half's own total column, mirroring the dashboard's
 * "+M"/"-M" button sitting directly on that column.
 *
 * Groups are shifted shallowest-depth-first (a Half's group is depth 1, spanning its whole
 * [Jan..Q2] range including the already-nested Quarter groups; a Quarter's own group is depth 2 when
 * nested inside a complete Half, or depth 1 if its Half isn't complete) — matching how Sheets
 * expects nested outline groups to be built from the outside in.
 *
 * @param {Sheet} sheet
 * @param {Array<{start: number, end: number, depth: number}>} groups
 */
function applyExportColumnGroups_(sheet, groups) {
  if (!groups || !groups.length) return;
  sheet.setColumnGroupControlPosition(SpreadsheetApp.GroupControlTogglePosition.AFTER);
  const sorted = groups.slice().sort(function (a, b) { return a.depth - b.depth; });
  // SIMPLIFIED 2026-09-02 (fourth round) after Zoltraak hit the IDENTICAL "A column group does not
  // exist with index 28 and group depth 2" export crash three times in a row, unchanged across two
  // structurally different Code.gs-only fixes (a `shiftDelta` field first applied as one
  // shiftColumnGroupDepth(2) call, then as a looped shiftColumnGroupDepth(1) with a fresh Range and
  // SpreadsheetApp.flush() per iteration). The identical, unchanged error across two different fixes
  // here was the tell: the real gap was never in this loop, it was that `shiftDelta` is COMPUTED
  // and SENT by Dashboard.html's withEntityColumnBreakdown_, and only Code.gs had actually been
  // redeployed in both prior attempts — an old Dashboard.html that never sends `shiftDelta` leaves
  // `g.shiftDelta || 1` silently falling back to 1 for every group, so the needed depth-2 group was
  // never created no matter how correct this file's own shift logic was. Fixed at the source instead:
  // Dashboard.html no longer sends a `shiftDelta` field at all — a period-total column's own
  // entity-breakdown group that needs to nest N levels deep now arrives here as N ordinary,
  // depth-ordered entries (one per level), the exact same shape every other nested group already
  // used. That removes this function's only reason to know about multi-step groups, so it goes back
  // to the original one-shiftColumnGroupDepth(1)-call-per-entry form — no cross-file field for a
  // future partial redeploy to silently drop.
  sorted.forEach(function (g) {
    sheet.getRange(1, g.start, 1, g.end - g.start + 1).shiftColumnGroupDepth(1);
  });
  // getColumnGroup(index, depth) THROWS ("A column group does not exist with index N and group
  // depth D") when no group exists at that exact pair — it does not return null on a miss, so the
  // `if (group)` guard alone can never prevent that throw; it only guards a group that legitimately
  // came back falsy some other way. Wrapped in try/catch as a defensive backstop so one group that
  // fails to materialize (for any reason) collapses everything else instead of aborting the whole
  // export.
  sorted.forEach(function (g) {
    try {
      const group = sheet.getColumnGroup(g.start, g.depth);
      if (group) group.collapse();
    } catch (e) {
      // Leave this one group expanded rather than fail the entire export.
    }
  });
}

/**
 * Turns one "Per Period" sheet's `rowGroups` (each {start, end}, 1-based Sheets row numbers) into
 * real Sheets row outline groups, collapsed by default — added 2026-08-26 per Zoltraak's per-store
 * breakdown request (see Dashboard_Betadine.html's computeExportStoreBreakdown_/buildExportPayload_).
 * Every other export sheet passes an empty array here (no-op). Row groups are always exactly one
 * level deep (no nesting needed, unlike the column groups above), and use Sheets' DEFAULT control
 * position (BEFORE) — left untouched — so the +/- toggle renders on the metric row itself,
 * immediately above its own block of per-store rows, mirroring the dashboard's own "+S" button
 * sitting on that same metric row's label.
 *
 * A group can NEVER start at Row 1 with this control position — Sheets has no row above row 1 to
 * host the "before" toggle, and throws "Can't create a group for Row 1 when the +/- button is on
 * top" if asked to (hit 2026-08-27 when the prefix-metrics group briefly started at row 1, before
 * the header/metrics row order was corrected — see EXPORT_HEADER_ROW_'s own comment). Skipped
 * defensively here (rather than trusting every future caller to get the math right) and wrapped in
 * a try/catch per group, same "never let one cosmetic feature fail the whole export" reasoning as
 * writeExportSheet_'s own autoResizeColumns call — a skipped/failed group just means one less
 * collapse toggle, not a broken export.
 *
 * @param {Sheet} sheet
 * @param {Array<{start: number, end: number}>} groups
 */
function applyExportRowGroups_(sheet, groups) {
  if (!groups || !groups.length) return;
  const valid = groups.filter(function (g) { return g.start > 1 && g.end >= g.start; });
  valid.forEach(function (g) {
    try {
      sheet.getRange(g.start, 1, g.end - g.start + 1, 1).shiftRowGroupDepth(1);
    } catch (e) { /* ignore — see function comment */ }
  });
  valid.forEach(function (g) {
    try {
      const group = sheet.getRowGroup(g.start, 1);
      if (group) group.collapse();
    } catch (e) { /* ignore — see function comment */ }
  });
}

/**
 * Next sequential "Version N" for this year + Official Store label, scanned live from
 * EXPORT_FOLDER_ID rather than tracked separately — see createExportSpreadsheet's own comment for
 * why. Returns 1 if no matching file exists yet.
 */
function nextExportVersion_(year, storeLabel) {
  const prefix = year + ' - FSOP - ' + storeLabel + ' Version ';
  const files = DriveApp.getFolderById(EXPORT_FOLDER_ID).getFilesByType(MimeType.GOOGLE_SHEETS);
  let maxVersion = 0;
  while (files.hasNext()) {
    const name = files.next().getName();
    if (name.indexOf(prefix) === 0) {
      const n = parseInt(name.slice(prefix.length), 10);
      if (!isNaN(n) && n > maxVersion) maxVersion = n;
    }
  }
  return maxVersion + 1;
}

// ====================== TRIGGER SETUP ======================

/**
 * Run this once from the Apps Script editor to install the daily auto-refresh (6am).
 * Safe to re-run — it clears any existing refreshData triggers first, so you won't end up
 * with duplicates if you run it more than once.
 */function installDailyTrigger() {
  removeRefreshTriggers_();
  ScriptApp.newTrigger('refreshData')
    .timeBased()
    .everyDays(1)
    .atHour(6)
    .create();
  Logger.log('Daily refresh trigger installed: refreshData 06:00.');
}


/** Removes any existing refreshData triggers — useful if you want to change the schedule. */function removeRefreshTriggers_() {
  ScriptApp.getProjectTriggers().forEach(t => {
    const h = t.getHandlerFunction();
    if (h === 'refreshData') ScriptApp.deleteTrigger(t);
  });
}