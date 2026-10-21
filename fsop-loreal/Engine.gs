/**
 * Engine.gs — FSOP calculation + export-layout engine (LOreal Group fork), server-side, NO dashboard UI.
 *
 * What this is: the part of Dashboard.html's <script> that Export-to-Sheets actually needs — deriveMetrics(),
 * computeVirtualRows(), the ROW_DEFS / fee-key tables, the grand-total / entity-breakdown math, EXPORT_FORMULA_ROWS,
 * buildExportPayload_() and friends — copied VERBATIM (same code, same comments; only the browser-only parts were left
 * out: rendering, filters/popovers, access panel, approval UI, tooltips, scroll sync, Refresh button).
 * It was generated mechanically from Dashboard.html by following the call graph from buildExportPayload_ /
 * getExportRows_ / exportStoreLabel_ plus the 5 statements that run at page load (derive metrics, fold in the virtual
 * group rows, sort) — and checked against the old "run Dashboard.html with a fake DOM" route for identical output.
 *
 * Why it is one big function: everything lives inside createFsopEngine_(payload) so each export gets its own private
 * copy of DATA / state (no leftovers between runs) and none of the engine's ~80 helper names can clash with names in
 * Code.gs / Export.gs.
 *
 * AFTER THIS FILE EXISTS: Dashboard.html is only a parked UI. Any change to the numbers, rows, formulas, columns or
 * groups of the export is made HERE (and in VIRTUAL_STORE_GROUPS below for a new combined group), not in Dashboard.html.
 * Needs nothing from Code.gs except the cache payload ({generatedAt, DATA, MP_DATA, warnings}) that refreshData() writes.
 *
 * @param {{generatedAt: string, DATA: Object[], MP_DATA: Object[], warnings: string[]}} payload  the refreshData() cache
 * @return {Object} DATA, state, STORES, MONTHS, VIRTUAL_STORE_GROUPS plus the export functions: buildExportPayload_, getExportRows_, exportStoreLabel_, buildExportBatches_, buildExportTree_
 */
function createFsopEngine_(payload) {
// Generic "YYYY-MM" -> month name formatter (works for any year/month, so newly-refreshed
// months don't need this list maintained by hand).
const MONTH_FULL_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function monthLabel(m) {
  const parts = String(m).split("-");
  if (parts.length === 2) {
    const idx = parseInt(parts[1], 10) - 1;
    if (idx >= 0 && idx < 12) return MONTH_FULL_NAMES[idx];
    // Synthetic Quarter/Half aggregate columns (see buildPeriodTree/buildDisplayRows) use
    // "YYYY-Q1".."YYYY-Q4" / "YYYY-H1"/"YYYY-H2" as their `month` key — shown plain ("Q1"/"H1",
    // no year), matching how a real month column shows just "July" with no year either.
    if (/^[QH][1-4]$/.test(parts[1])) return parts[1];
  }
  return m;
}

// Injected by Code.gs (doGet) from the cached refresh — see refreshData() / loadCachedData().
// dataJson is a raw JSON object literal (not a quoted string), so this just becomes a normal JS object.
const FS_PAYLOAD = payload;
// Single-tab fork (2026-08-18) — no Consignment tab, so there's just one dataset. Kept as
// OUTRIGHT_DATA/OUTRIGHT_MP_DATA plus a DATA/MP_DATA alias (rather than inlining FS_PAYLOAD.DATA
// everywhere) so the rest of the engine below — which reads the DATA/MP_DATA globals at render
// time — needs no further changes.
const OUTRIGHT_DATA = FS_PAYLOAD.DATA;
const OUTRIGHT_MP_DATA = FS_PAYLOAD.MP_DATA;
let DATA = OUTRIGHT_DATA;
let MP_DATA = OUTRIGHT_MP_DATA;

// MOGTM Distributor Fee: 2.5% of a row's COGS (rbp), charged only when that brand/month actually
// has orders through a warehouse under the MOGTM code (e.g. "MOGTM - Morinaga Bandung (KNS)").
// Prefix extraction mirrors Code.gs's mapWarehouseToCanonical_ (split on " - ", trim, lowercase) so
// this stays consistent with the same warehouse-code convention used server-side.
// Marketplace Fee / Other Marketplace Fee (+ their breakdown fields) — raw sums computed
// server-side in Code.gs (readPlatformFeeContribution_/refreshData Pass 3b), same treatment as
// pickPack/rentWarehouse/consumables: present on every DATA row and every warehouse sub-row,
// defaulted to 0 by Code.gs even where no Platform Fee file exists for that brand/month. Kept as
// one shared list (rather than each summing site hardcoding all 11 field names separately) so
// adding/removing a breakdown field later only needs to change it here.
let PLATFORM_FEE_SUM_KEYS = [
  'marketplaceFee', 'otherMarketplaceFee', 'platformCommissionFee', 'orderProcessingFee',
  'mallServiceFee', 'dynamicCommission', 'bonusCashbackServiceFee', 'preOrderServiceFee',
  'voucherXtraServiceFee', 'shippingCost', 'exclusiveBenefitsAccessFee',
  // Platform Fee Absorb by SIRCLO — see Code.gs's absorbColIdxs (every "absorb"-containing Platform
  // Fee column, summed together, for every brand); a brand/warehouse bucket whose file has none
  // just carries 0 for it, same as any other PLATFORM_FEE_SUM_KEYS field a given brand's file
  // doesn't happen to have.
  'absorbBySirclo',
  // Shopee Platform Fee fields, added 2026-08-14 (see Code.gs SHOPEE_FEE_COL/SHOPEE_VOUCHER_COLS).
  // totalVouchers is summed server-side from the 3 voucher columns; totalPlatformFee is derived
  // client-side in deriveMetrics/computeGrand (NOT summed here — it's the sum of totalVouchers +
  // marketplaceFee + otherMarketplaceFee, all of which ARE in this list), so listing it here would
  // double-count it in the generic summing loops below.
  'totalVouchers', 'biayaAdministrasi', 'biayaLayanan', 'premi', 'biayaProgramHemat',
  'biayaTransaksi', 'biayaKampanye', 'beaMasukPpnPph', 'promoGratisOngkirPenjual',
  'cashbackKoinCofund', 'biayaLainnya', 'fbsFee',
  // Lazada/Blibli/Zalora Platform Fee fields + "Sales of Goods (Disbursed)" (CBP, shared by every
  // marketplace), added 2026-08-18 — see Code.gs's LAZADA_FEE_COL/BLIBLI_FEE_COL/ZALORA_FEE_COL
  // and PLATFORM_FEE_COL.salesOfGoodsDisbursed. Same generic sum-across-rows/warehouses/virtual-
  // groups/period-aggregates treatment as everything else in this list; commission is shared
  // between Lazada's "Commission" and Zalora's "commission" columns (one dashboard line, not two —
  // see LAZADA_FEE_COL's comment in Code.gs), orderProcessingFee/totalVouchers are already in this
  // list above so Lazada's own Order_Processing_Fee/Total_Voucher columns need no new entry here.
  'salesOfGoodsDisbursed',
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
  // Other Revenue (LOreal Group's 14 real Official Stores only, see Code.gs's LOREAL_GROUP_BRANDS)
  // and Surplus (Sanghiang Perkasa Group's 4 real Official Stores only, see Code.gs's
  // SANGHIANG_PERKASA_GROUP_BRANDS) — added 2026-08-13. Despite the "PLATFORM_FEE" name, this
  // array has always really meant "every extra field beyond the base 5 (uniq/qty/sales/claim/rbp)
  // that needs the exact same generic sum-across-rows/warehouses/virtual-groups/period-aggregates
  // treatment" (see every call site below) — reusing it here for these two is simpler and less
  // error-prone than adding a second near-identical array and a second copy of every summing loop.
  'otherRevenue', 'surplus',
  // Promo Fund Front Margin / Back Margin — added 2026-08-18 per Zoltraak, Outright tab only.
  // ONLY ever nonzero for the Betadine Group (Betadine Official Store, Betadine Store) — see
  // Code.gs's PROMO_FUND_BETADINE_BRANDS/loadPromoFundBetadine_. Source: "2026 Promo Fund Betadine
  // Official Store" Google Sheet, front margin = "Sell In B2C" section (Benoa warehouse in the
  // sheet's own layout), back margin = "Sell Out MOGTM" section (MOGTM - Betadine Solo (MNS)
  // warehouse) — read per warehouse/month, then spread across d.warehouses/d.marketplaces by each
  // bucket's own Sales of Goods share (same allocation method as Other Revenue above). Both are
  // deductions from Gross Profit (see deriveMetrics/computeGrand's r.gp/g.gp formulas below) — NOT
  // just informational lines like Other Revenue/Surplus, per Zoltraak: "This lines will impact to
  // gross profit calculation as deduction and impact to % gross profit as deduction as well."
  'promoFundFrontMargin', 'promoFundBackMargin',
  // Chip In — added 2026-08-28 per Zoltraak, placed directly below Surplus (see that ROW_DEFS
  // entry's own comment). No data source exists for this yet ("let it 0 at this current
  // situation") — a plain informational placeholder line, same starting shape Other Revenue and
  // Surplus each had before a real source was wired up for them. NOT wired into the Gross Profit
  // formula (unlike Surplus/Promo Fund) since Zoltraak didn't ask for that — purely a reserved row
  // that reads $0 everywhere until a real source is specified.
  'chipIn',
];

const MOGTM_FEE_RATE = 0.025;
// Per-warehouse MOGTM fee rate overrides, per Zoltraak 2026-08-14: "MOGTM Distributor Fee 5% for
// MOGTM - Betadine Solo (MNS)" — that specific warehouse bills at a rate of its own COGS instead of
// the default 2.5%. Keyed by the full Warehouse-column text (the same string that appears in the
// Data Claim files and in WAREHOUSE_CODE_MAP), so the override survives regardless of brand/month.
// REVISED 2026-08-21 per Zoltraak ("revisi MOGTM Dist fee nya jadi 8,5% apply untuk semua category
// warehouse, marketplace dan store, period"): rate changed from 5% to 8.5%. No other code needed to
// change for this to apply everywhere — warehouseMogtmFee/effectiveMogtmRate (below) are the single
// source every warehouse/marketplace/store column and every period (month, quarter, half, Grand
// Total) already reads this override through, so the new 8.5% flows into all of them uniformly.
const MOGTM_FEE_RATE_BY_WAREHOUSE = {
  'MOGTM - Betadine Solo (MNS)': 0.085,
  // Confirmed by Zoltraak 2026-08-18: Natasha Skincare Official Store's MOGTM Distributor Fee is
  // 2% of COGS (rbp), not the MOGTM_FEE_RATE default (2.5%). Warehouse string confirmed against
  // the live cached data (_fs_overview_cache.json → DATA → "Natasha Skincare Official Store" →
  // warehouses[].warehouse).
  'MOGTM - Natasha Solo (KNS)': 0.02,
};
function warehousePrefix(raw) {
  const s = String(raw || '').trim();
  const i = s.indexOf(' - ');
  return (i === -1 ? s : s.slice(0, i)).trim().toLowerCase();
}

// Effective MOGTM fee rate for a warehouse entry — its per-warehouse override if one exists, else
// the global default. Returns the rate (not the fee), so the caller can use it for both the fee
// amount and the "%" cell annotation.
function warehouseMogtmRate(w) {
  return MOGTM_FEE_RATE_BY_WAREHOUSE[w && w.warehouse] || MOGTM_FEE_RATE;
}

// MOGTM fee of ONE warehouse bucket's own COGS (rbp) — but only if that specific bucket is under
// the MOGTM code (rate may be warehouse-specific, see MOGTM_FEE_RATE_BY_WAREHOUSE). Applies to any
// object shaped like a warehouse entry ({ warehouse, rbp, ... }), whether that's a real
// per-brand/month warehouse sub-row or a Grand-Total-by-warehouse entry.
function warehouseMogtmFee(w) {
  return warehousePrefix(w.warehouse) === 'mogtm' ? w.rbp * warehouseMogtmRate(w) : 0;
}

// The "%" cell-note annotation under MOGTM Distributor Fee (see ROW_DEFS' mogtmFee entry) needs a
// single blended rate for a row, but warehouseMogtmRate(r) only works on an actual warehouse sub-
// row (it reads r.warehouse, which a top-level/aggregate row doesn't have — that always fell back
// silently to MOGTM_FEE_RATE, showing "2.5%" even on a Betadine-only column whose real fee (see
// r.mogtmFee above) already correctly blended in the Betadine override). This derives the rate
// actually implied by the row's own numbers instead: total MOGTM fee / total MOGTM-bucket COGS, so
// a column that's 100% Betadine shows 8.5%, a mixed column shows whatever blended rate its mogtmFee/rbp mix
// actually works out to, and a plain warehouse sub-row still gets its own exact rate as before.
// Extended 2026-08-17 for marketplace/Official-Store sub-rows, which have neither .warehouses nor
// .warehouse of their own — deriveMetrics now stamps a `_mogtmRbp` companion figure (the slice of
// MOGTM-warehouse rbp actually attributable to that specific marketplace/store) alongside mogtmFee
// wherever it computes either one; this just divides the two back out into a rate.
function effectiveMogtmRate(r) {
  if (!r) return MOGTM_FEE_RATE;
  if (r.warehouses) {
    const mogtmRbp = r.warehouses.reduce((sum, w) => sum + (warehousePrefix(w.warehouse) === 'mogtm' ? (w.rbp || 0) : 0), 0);
    return mogtmRbp > 0 ? (r.mogtmFee / mogtmRbp) : MOGTM_FEE_RATE;
  }
  if (r.warehouse) return warehouseMogtmRate(r); // plain warehouse sub-row — exact, as before
  return r._mogtmRbp > 0 ? (r.mogtmFee / r._mogtmRbp) : MOGTM_FEE_RATE; // marketplace/store sub-row
}

// Formats a rate (e.g. 0.05) as a percent string for the cell-note — "5%" when it lands on a clean
// tenth, "2.5%" etc. otherwise. Rounds to 1 decimal place to absorb harmless floating-point noise
// from the division in effectiveMogtmRate (e.g. 0.024999999999999998 -> "2.5%", not "2.4999...%").
function fmtMogtmRatePct(rate) {
  const pct = rate * 100;
  const rounded = Math.round(pct * 10) / 10;
  return (Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)) + '%';
}

// "%" cell-note for a money row (see ROW_DEFS' cellNote usages below) — per Zoltraak 2026-08-20,
// same mini-info-under-the-value treatment MOGTM Distributor Fee already gets above, just a plain
// "% contribution to Sales of Goods" share instead of a derived rate: value ÷ that SAME row's Sales
// of Goods × 100. Works identically at EVERY column/breakdown level (the main brand/month column, a
// warehouse/Official Store/marketplace sub-column, Grand Total, and Grand's own warehouse
// breakdown) with no special-casing needed — unlike effectiveMogtmRate above, `data.sales` and
// every money field this can be called with are already consistently summed at every one of those
// levels via the generic PLATFORM_FEE_SUM_KEYS rollup (see computeGrand/computeGrandWarehouses/
// computeGrandMarketplaces/computeGrandStores and computeVirtualRows/computePeriodAggregateRows,
// which all loop it the same way), so a plain division is exact everywhere, not just on a real
// warehouse row. Returns null (no note shown) when this cell's own value is 0 or Sales of Goods is
// 0 — same "don't clutter empty cells" convention mogtmFee's own cellNote uses.
//
// Originally written just for Promo Fund Front/Back Margin (hence the old promoFundPctOfSalesNote_
// name); generalized 2026-08-26 per Zoltraak ("feature % contribution with grey colors... apply to
// line: Surplus, rebates, other revenue, COGS, Platform Fee Absorb by SIRCLO, Pick Pack, Rent
// Warehouse, Consumables and Total Operational and Fulfillment Cost as well") and renamed to reflect
// that it's now used by every money row that wants this annotation, not just Promo Fund. `useAbs`
// (new) takes the note's own magnitude before dividing — needed only for Platform Fee Absorb by
// SIRCLO, whose raw field is stored negative (see its ROW_DEFS `abs: true`) while every other row
// this is applied to is already a plain positive figure.
// `.pctOfSalesKey`/`.pctOfSalesUseAbs` tagged onto the returned function 2026-08-26 per Zoltraak's
// export request ("please show the % of sales of goods contribution at tab sheet Per Period, per
// period per warehouse and per period per marketplace as well") — buildExportPayload_ introspects
// these two properties to know, generically, which ROW_DEFS rows get this exact "% of Sales of
// Goods" treatment (vs. e.g. mogtmFee's own differently-shaped cellNote) and how to recompute the
// same percentage as a real exported spreadsheet row, without hardcoding a separate row-key list
// in two places that could drift apart. Purely additive — the function's own on-screen behavior
// (returning a formatted "%"-suffixed string, or null) is unchanged.
function pctOfSalesNote_(key, useAbs) {
  const fn = function (data) {
    if (!data || !data[key]) return null;
    const sales = data.sales || 0;
    if (!sales) return null;
    const v = useAbs ? Math.abs(data[key]) : data[key];
    return fmtPct((v / sales) * 100);
  };
  fn.pctOfSalesKey = key;
  fn.pctOfSalesUseAbs = !!useAbs;
  return fn;
}

// rentWarehouseCbmWhpTotals — added 2026-09-14 per Zoltraak's "%CBM Usage vs Total WHP" request
// (see RATE_ROW_DEFS' CBM Usage row and rentWarehouseCbmPctNote_ below). Code.gs sets this on every
// row shape (real DATA row, warehouse sub-row) as an object keyed by "<whp>||<entity>||<month>" —
// see loadRentWarehouseCbmSheet_'s own comment in Code.gs for why. It is a SHARED REFERENCE value:
// the SAME number for every brand/bucket that shares one WHP+Subsidiary+month, fundamentally
// different from every other raw field in this file (pickPack, rentWarehouse, rentWarehouseCbm,
// ...), which are genuinely per-brand-additive. If this were summed the normal way whenever rows
// are combined (Grand Total, Virtual Group, Grand's own Warehouse/Store breakdown, Quarter/Half
// aggregate — see computeGrand/computeGrandWarehouses/computeGrandStores/computeVirtualRows/
// computePeriodAggregateRows), the same total would be counted once per brand/bucket that touches
// it — e.g. 2 brands sharing one WHP would silently double it, making every %CBM Usage note built
// on top of it too LOW by however many brands/buckets shared that WHP. Confirmed with Zoltraak
// 2026-09-14 (a worked numeric example: 2 brands at the same WHP, naive summing turns a true 1.77%
// combined figure into a wrong 0.89%) — the fix is to merge these objects by KEY (mergeWhpTotals_,
// last-value-wins — always safe, since the same key always carries the identical number) rather
// than adding the values, then sum the DISTINCT totals that come out the other end
// (sumWhpTotals_). This also transparently gives the "blended version" Zoltraak asked for when one
// brand's Rent Warehouse spans multiple WHPs in the same month (Coba tampilkan versi gabungan
// juga) — different WHPs are different keys, so their totals legitimately add together — and
// correctly handles combining the SAME WHP across different months (different key, different real
// total, legitimately additive too). Every aggregation site below merges this field the SAME way;
// that uniform treatment is what lets rentWarehouseCbmPctNote_ just call sumWhpTotals_(data.
// rentWarehouseCbmWhpTotals) and get a correct number at EVERY level, with no level-specific logic
// of its own.
function mergeWhpTotals_(acc, src) {
  if (!src) return;
  Object.keys(src).forEach(k => { acc[k] = src[k]; });
}
function sumWhpTotals_(obj) {
  if (!obj) return 0;
  return Object.keys(obj).reduce((s, k) => s + (obj[k] || 0), 0);
}

// Rate panel "Rent Warehouse" row's basis remark — added 2026-09-14 per Zoltraak: a small grey line
// under the number (same cosmetic treatment as pctOfSalesNote_ above — reuses the same .cell-note
// style) noting whether THIS column's figure reflects published CBM Usage data or fell back to
// Number of Order (some months, e.g. January-May 2026, have no CBM Usage published yet in the "CTS
// - Rent Warehouse Calculation" sheet — see Code.gs's loadRentWarehouseCbmSheet_ — so their
// rentWarehouseCbm is 0 even though r.rentWarehousePerCbm above is now unconditionally cost ÷
// Number of Order for every month). Hidden (null) on anything that isn't a single real calendar
// month — Grand Total, a Half/Quarter/Grand-period aggregate column, and any Warehouse/Store/
// Marketplace breakdown of one of those — per Zoltraak's confirmed answer ("Sembunyikan remark di
// kolom blended"). `ctx.month` (passed by rateBodyHtml) carries the SAME value isRealMonthKey
// already validates elsewhere in this file: a real "YYYY-MM" for a single real month (including a
// Virtual/Combined store's own single-month column — combining BRANDS, not months, is fine here,
// this field isn't a shared-reference value), and something else (a period-slot key like "2026-H1",
// or absent entirely for Grand Total/Grand's own breakdown) for anything blended.
function rentWarehouseBasisNote_(data, ctx) {
  if (!data || !ctx || !isRealMonthKey(ctx.month)) return null;
  if (!data.uniq) return null; // nothing to attribute a basis to
  // "By " prefix + italic — added 2026-09-14 per Zoltraak's follow-up wording/style tweak. The
  // <i> tag works because rateBodyHtml interpolates this string straight into the .cell-note div's
  // innerHTML (same as every other cellNote in this file) rather than escaping it.
  return data.rentWarehouseCbm ? '<i>By CBM Usage</i>' : '<i>By Number of Order</i>';
}

// Rate panel "CBM Usage" row's %-of-WHP-total remark — added 2026-09-14 per Zoltraak: this column's
// own CBM Usage as a % of the TOTAL CBM Usage recorded for the same WHP+Subsidiary(+month) — e.g.
// "Maybelline Official" July CBM Usage 54.8 ÷ KLOG Benoa/PT Koneksi Niaga Solusindo's own July
// total 4785.8 = 1.15%. Unlike rentWarehouseBasisNote_ above, this is deliberately NOT restricted
// to single real-month columns — see rentWarehouseCbmWhpTotals' own comment just above: because
// EVERY aggregation site in this file merges that field by key (never sums it), this division stays
// mathematically correct at every level (single brand/month, its own Warehouse breakdown, a Virtual
// Group combining several brands, Grand Total, a Half/Quarter aggregate) — restricting it here would
// throw away a correct number for no reason. Returns null (no note) wherever there's no CBM Usage on
// this cell, or no total to divide by (e.g. a bucket that fell back to the old rate × Number of
// Order calculation, which has no CBM/total concept at all) — same "don't clutter empty cells"
// convention every other cellNote in this file already follows.
function rentWarehouseCbmPctNote_(data) {
  if (!data || !data.rentWarehouseCbm) return null;
  const total = sumWhpTotals_(data.rentWarehouseCbmWhpTotals);
  if (!total) return null;
  return fmtPct((data.rentWarehouseCbm / total) * 100);
}

// derive computed metrics (shared helper)
function deriveMetrics(r, isConsignment) {
  r.aov = r.uniq ? r.sales / r.uniq : 0;
  r.abs = r.qty ? r.sales / r.qty : 0;
  // Other Revenue / Surplus — real figures as of 2026-08-13 (Other Revenue was a permanent-0
  // placeholder before; Surplus is brand new), both raw sums coming from Code.gs (Other Revenue)
  // or already summed by whichever caller built this row (Surplus, and Other Revenue again for
  // virtual/period-aggregate/Grand rows — see PLATFORM_FEE_SUM_KEYS' comment). `|| 0` here is
  // purely a safety default for row shapes that never carry either field at all (MP_DATA rows,
  // Grand-Total-by-warehouse/store entries before their own summing loop has run) — it does NOT
  // overwrite an already-summed value the way the old unconditional `= 0` placeholder did.
  r.otherRevenue = r.otherRevenue || 0;
  r.surplus = r.surplus || 0;
  // Chip In — added 2026-08-28 per Zoltraak, same safety-default treatment as Other
  // Revenue/Surplus above (no real source yet, so this is always 0 today; `|| 0` keeps that a
  // no-op once a real source is wired up, exactly like the other placeholder-turned-real fields
  // before it).
  r.chipIn = r.chipIn || 0;
  // Promo Fund Front/Back Margin — same safety-default treatment as Other Revenue/Surplus above
  // (added 2026-08-18); `|| 0` again does not overwrite an already-summed value.
  r.promoFundFrontMargin = r.promoFundFrontMargin || 0;
  r.promoFundBackMargin = r.promoFundBackMargin || 0;
  // MOGTM Distributor Fee applies to the portion of COGS sitting specifically in a MOGTM-code
  // warehouse bucket — NOT 2.5% of the brand/month's whole COGS. A top-level DATA row (which has
  // its own .warehouses array) sums the fee from just its MOGTM-named bucket(s), so a brand using
  // both MOGTM and, say, Benoa only pays the fee on the MOGTM slice. A warehouse sub-row (one
  // entry INSIDE r.warehouses, which doesn't have a nested .warehouses of its own) computes its
  // own fee directly from its own name/rbp — this is what makes expanding a column show the real
  // fee sitting on its MOGTM sub-column specifically, and a plain 0 on every other (TMS, Benoa,
  // etc.) sub-column, instead of 0 across the board.
  //
  // Marketplace sub-rows (r.marketplaces[i]) used to always show $0 here — a marketplace bucket
  // has no warehouse of its own, so the old code (which only ever branched on r.warehouses vs a
  // single r.warehouse) fell through to warehouseMogtmFee(r), which reads r.warehouse (undefined
  // for a marketplace bucket) and returns 0 unconditionally. Fixed 2026-08-17 per Zoltraak: this
  // branch (only reached when r.warehouses IS present — i.e. we're looking at a row that has a
  // full warehouse breakdown to work from, same as before) now ALSO reaches into that same
  // r.warehouses array's per-marketplace RBP cross-tab (w.mpRbp — see Code.gs's
  // readFileContribution_) to compute each MOGTM-code warehouse's contribution to EACH
  // marketplace's fee, and stamps the result directly onto r.marketplaces[i].mogtmFee /
  // r.marketplaces[i]._mogtmRbp (the latter feeds effectiveMogtmRate's "%" annotation). This is
  // the ONLY place r.warehouses and r.marketplaces are simultaneously available with a real
  // mpRbp cross-tab, so every aggregation function that builds a combined/period/Grand row must
  // call deriveMetrics on that combined row BEFORE calling deriveMetrics on its own .marketplaces
  // sub-rows (see computeVirtualRows/computePeriodAggregateRows' ordering) — otherwise this branch
  // never runs and the fallback below (r.mogtmFee === undefined) would incorrectly zero it out.
  if (r.warehouses) {
    r.mogtmFee = r.warehouses.reduce((sum, w) => sum + warehouseMogtmFee(w), 0);
    r._mogtmRbp = r.warehouses.reduce((sum, w) => sum + (warehousePrefix(w.warehouse) === 'mogtm' ? (w.rbp || 0) : 0), 0);
    if (r.marketplaces) {
      const mpFee = {}, mpRbp = {};
      r.warehouses.forEach(w => {
        if (warehousePrefix(w.warehouse) !== 'mogtm') return;
        const rate = warehouseMogtmRate(w);
        Object.keys(w.mpRbp || {}).forEach(mpName => {
          mpFee[mpName] = (mpFee[mpName] || 0) + rate * w.mpRbp[mpName];
          mpRbp[mpName] = (mpRbp[mpName] || 0) + w.mpRbp[mpName];
        });
      });
      r.marketplaces.forEach(mp => {
        mp.mogtmFee = mpFee[mp.marketplace] || 0;
        mp._mogtmRbp = mpRbp[mp.marketplace] || 0;
      });
    }
  } else if (r.mogtmFee === undefined) {
    // No warehouse breakdown on this object at all (a plain warehouse sub-row — has r.warehouse
    // but no nested r.warehouses — falls here and computes its own fee directly), AND nothing
    // upstream already computed/summed a value for it (see the r.warehouses branch above, and the
    // explicit mogtmFee += summing every aggregation function now does when building a
    // marketplace/Official-Store bucket from real underlying rows that already went through THAT
    // branch — computeVirtualRows, computePeriodAggregateRows, computeGrandMarketplaces,
    // computeGrandStores). Falling back to 0 here (via warehouseMogtmFee reading an undefined
    // r.warehouse) would silently wipe out an already-correct summed value, so this branch is
    // skipped whenever r.mogtmFee is already a number (even 0) rather than undefined.
    r.mogtmFee = warehouseMogtmFee(r);
  }
  // MOGTM Distributor Fee is never charged on Consignment — a tab-wide rule (see Code.gs's doGet()
  // comment "MOGTM Distributor Fee: always 0 (unchanged)" and this file's own CONSIGNMENT_LEGEND
  // override "'0 — MOGTM Distributor Fee is never charged on Consignment'"), NOT something that
  // depends on which warehouse a store's inventory happens to sit in. Bug fixed 2026-08-18 per
  // Zoltraak ("Rip Curl" on Consignment showing a non-zero MOGTM Distributor Fee): the two branches
  // above compute mogtmFee purely from the warehouse breakdown, which Consignment rows also carry
  // (reused as-is for Operational & Fulfillment Cost / Platform Fee) — so any Consignment brand
  // whose warehouse happens to be MOGTM-coded (Rip Curl included) was incorrectly picking up a fee
  // here. `isConsignment` is passed explicitly by every call site rather than read from `state`
  // here, because deriveMetrics runs at module-load time (see the DATA.forEach/CONSIGNMENT_DATA.
  // forEach priming calls near the top of this script), before `state` exists yet.
  if (isConsignment) {
    r.mogtmFee = 0;
    r._mogtmRbp = 0;
    if (r.marketplaces) {
      r.marketplaces.forEach(mp => { mp.mogtmFee = 0; mp._mogtmRbp = 0; });
    }
  }
  // Promo Fund Front Margin / Back Margin — added 2026-08-18 per Zoltraak, deducted from Gross
  // Profit (Betadine Group only; every other brand carries 0/undefined here, so `|| 0` makes this
  // a no-op for them). See PLATFORM_FEE_SUM_KEYS' comment above for the sourcing/allocation detail.
  // Surplus — REVISED 2026-08-26 per Zoltraak ("sebagai pengurang seperti promo fund"): now
  // deducted from Gross Profit the same way, on top of moving its row below Other Revenue in
  // ROW_DEFS (see that entry's own comment). Only nonzero for Sanghiang Perkasa Group, so `|| 0`
  // makes this a no-op for every other brand, same as the Promo Fund terms.
  // Other Revenue — SECOND REVISION 2026-08-26 per Zoltraak: now ADDED into Gross Profit / %
  // Gross Profit (previously just an informational line, per the entry's own original comment —
  // "Not wired into the Gross Profit formula"). Only nonzero for LOreal Group, so `|| 0` is a
  // no-op for every other brand. Term order below (and in every formula string that describes
  // this calculation — ROW_DEFS' gp/pctGp `formula` text, OUTRIGHT_LEGEND idx 11/12, the Sheets
  // export formula in EXPORT_FORMULA_ROWS.gp) now matches Zoltraak's specified row order (Sales
  // of Goods, Rebates, Other Revenue, COGS, Surplus, MOGTM Distributor Fee, Promo Fund Front
  // Margin, Promo Fund Back Margin) — purely a readability convention, since addition/subtraction
  // order never changes the numeric result.
  r.gp = r.sales + r.claim + (r.otherRevenue || 0) - r.rbp - (r.surplus || 0) - r.mogtmFee - (r.promoFundFrontMargin || 0) - (r.promoFundBackMargin || 0);
  r.pctGp = (r.sales + r.claim) ? (r.gp / (r.sales + r.claim)) * 100 : 0;
  // Gross Profit per Order — added 2026-09-12 per Zoltraak: Gross Profit ÷ Number of Order, same
  // "|| 0 on zero denominator" convention as aov/pctGp above. A RATIO (like pctGp), not a summable
  // money amount — see computeOrderRatioTotals's own comment for why its Total/Half/Quarter and
  // Group/Total hover tooltips sum numerator and denominator separately rather than summing this
  // field directly (METRIC_BREAKDOWN_RATIO_ROW_KEYS below suppresses its breakdown rows' "% to
  // Group/Total" note for the same reason).
  r.gpPerOrder = r.uniq ? r.gp / r.uniq : 0;
  r.pctDisc = (r.sales + r.claim) ? (r.claim / (r.sales + r.claim)) * 100 : 0;
  // Total Operational and Fulfillment Cost — Pick Pack + Rent Warehouse + Consumables (raw
  // per-order costs), PLUS Platform Fee Absorb by SIRCLO taken as a magnitude — per Zoltraak
  // 2026-08-12, folded into this total now. Math.abs() because absorbBySirclo is stored signed
  // (negative), same as every other Platform Fee-sourced field (see its abs:true ROW_DEFS entry),
  // while pickPack/rentWarehouse/consumables are already positive computed costs. Deriving this
  // here (rather than in Code.gs) means it automatically applies to warehouse sub-rows, virtual
  // "combined" rows, and Grand-Total-by-warehouse entries too, the same way every other
  // client-side-derived field does — no extra plumbing needed per row shape.
  r.totalOpCost = (r.pickPack || 0) + (r.rentWarehouse || 0) + (r.consumables || 0) + Math.abs(r.absorbBySirclo || 0);
  // Rent Warehouse (Rate panel row; internal field name rentWarehousePerCbm kept as-is — only the
  // DISPLAYED tag changed, see RATE_ROW_DEFS) — REVERTED 2026-09-14 per Zoltraak ("agar align...
  // ubah logicnya menjadi = Rent Warehouse/Number Of Order"): back to a plain, UNCONDITIONAL Rent
  // Warehouse cost ÷ Number of Order for every column, real-month or not — no more CBM-based
  // branching. This row's own cellNote (rentWarehouseBasisNote_, see RATE_ROW_DEFS) now carries the
  // "Number of Order" vs "CBM Usage" distinction as an informational remark instead — it doesn't
  // change which formula is used, it just tells the reader whether CBM Usage data existed for this
  // WHP/month (Jan-May vs July-August, per Zoltraak's example). Was (2026-09-12..09-14, briefly):
  // `r.rentWarehouseCbm ? r.rentWarehouse / r.rentWarehouseCbm : (r.uniq ? r.rentWarehouse / r.uniq : 0)`.
  r.rentWarehousePerCbm = r.uniq ? r.rentWarehouse / r.uniq : 0;
  // Total Platform Fee (Shopee) = Total Vouchers + Total Marketplace Fee + Total Other Marketplace
  // Fee (per Zoltraak 2026-08-14). Deriving it here (rather than in Code.gs) means it automatically
  // applies to warehouse sub-rows, virtual "combined" rows, and Grand-Total-by-warehouse entries
  // too, the same way totalOpCost/contributionMargin do. All three operands are summed generically
  // via PLATFORM_FEE_SUM_KEYS, so this formula is correct on every row shape.
  r.totalPlatformFee = (r.totalVouchers || 0) + (r.marketplaceFee || 0) + (r.otherMarketplaceFee || 0);
  // Contribution Margin: Gross Profit minus Total Operational and Fulfillment Cost. % Contribution
  // Margin follows the same "as a % of (Sales of Goods + Rebates)" treatment % Gross Profit above
  // already uses. Both shown right after Total Operational and Fulfillment Cost — see ROW_DEFS.
  r.contributionMargin = r.gp - r.totalOpCost;
  r.pctContributionMargin = (r.sales + r.claim) ? (r.contributionMargin / (r.sales + r.claim)) * 100 : 0;
  // Contribution Margin per Order — added 2026-09-12 per Zoltraak, same shape/rationale as
  // gpPerOrder above (Contribution Margin ÷ Number of Order, a ratio not a summable amount).
  r.cmPerOrder = r.uniq ? r.contributionMargin / r.uniq : 0;
}
// Each row's warehouse breakdown (r.warehouses, from Code.gs) has the same shape (uniq/qty/sales/
// claim/rbp) as a top-level DATA row, so the same deriveMetrics() helper applies to each of them
// too — that's what lets fmtVal()/ROW_DEFS render a warehouse sub-column exactly like a normal one.
// deriveMetrics() runs on each row AND every nested breakdown it carries (warehouses) so an
// expanded sub-column renders its derived metrics (AOV, ABS, GP, %GP, ...) correctly. MP_DATA rows
// are flat (no nested breakdowns). `false` here — no Consignment tab in this fork, so isConsignment
// is always false (see deriveMetrics' own comment on why it's an explicit param, not read from
// `state`: `state` doesn't exist yet this early in module load).
DATA.forEach(r => { deriveMetrics(r, false); (r.warehouses || []).forEach(w => deriveMetrics(w, false)); });
MP_DATA.forEach(r => deriveMetrics(r, false));

// "Virtual" combined Official Stores — selectable in the Official Store filter exactly like a
// real store, but not present in the source data at all: each one is computed client-side by
// summing its listed member stores' numbers for every month they have data. Store names are
// the exact strings that show up in DATA (which follows the Drive filename, not necessarily the
// user's preferred spelling) — e.g. the actual export is titled "...AYU Beauty House" (all-caps
// AYU), and "Kiehl's Flagship Store" has shown up both with and without the apostrophe, so both
// variants are listed the same way PRINCIPAL_GROUPS below already does for real ones.
//
// A group's members can be real store names OR other virtual group names — e.g. "LOreal Group"
// is built from LOreal CPD/LDB/LLD/PPD (themselves combined stores), and "Unilever Group" mixes
// three combined stores (Unilever BW/PC/HC) with one real one (Unilever Nutritions). Per Zoltraak
// 2026-08-13. computeVirtualRows below handles this nesting by processing groups in dependency
// order (see topoSortVirtualGroups) so a group's virtual-group members are already computed and
// available to sum by the time that group itself is processed.
const OUTRIGHT_VIRTUAL_STORE_GROUPS = {
  "LOreal CPD": ["Maybelline Official", "Garnier Official", "Garnier Men Official", "LOreal Paris", "LOreal Paris Haircare", "3CE Indonesia", "AYU Beauty House"],
  "LOreal LDB": ["La Roche-Posay", "La Roche-Posay Official Store", "Cerave Official Store", "Cerave Official Shop"],
  "LOreal LLD": ["YSL Official Shop", "Kiehl's Flagship Store", "Kiehls Flagship Store", "Shu Uemura"],
  "LOreal PPD": ["Kerastase Indonesia", "Matrix Haircare Official Shop"],
  "LOreal Group": ["LOreal CPD", "LOreal LDB", "LOreal LLD", "LOreal PPD"],
};
// No Consignment tab in this fork — VIRTUAL_STORE_GROUPS is just OUTRIGHT_VIRTUAL_STORE_GROUPS,
// no second set to switch between.
let VIRTUAL_STORE_GROUPS = OUTRIGHT_VIRTUAL_STORE_GROUPS;
// Dependency (topological) sort of VIRTUAL_STORE_GROUPS's keys: a group that appears as another
// group's member always ends up earlier in this list than that other group (e.g. "LOreal CPD"
// before "LOreal Group"). Real store names inside a members list have no entry in
// VIRTUAL_STORE_GROUPS, so there's nothing to order them against — they're simply skipped.
// computeVirtualRows relies on this order to compute nested groups correctly in one pass.
function topoSortVirtualGroups(groups) {
  const order = [];
  const mark = {}; // undefined = unvisited, 'visiting' = in progress (cycle guard), 'done' = finished
  function visit(name) {
    if (mark[name] === 'done') return;
    if (mark[name] === 'visiting') {
      throw new Error('VIRTUAL_STORE_GROUPS has a circular dependency involving "' + name + '"');
    }
    if (!groups[name]) return; // a real store name, not a group — nothing to order
    mark[name] = 'visiting';
    groups[name].forEach(visit);
    mark[name] = 'done';
    order.push(name);
  }
  Object.keys(groups).forEach(visit);
  return order;
}
let VIRTUAL_STORE_NAMES = topoSortVirtualGroups(VIRTUAL_STORE_GROUPS);
// Builds one combined row per (virtual group, month) by summing that month's member stores' rows
// — real stores directly, or (for a group nested inside another, e.g. "LOreal Group") an
// already-computed virtual row from an earlier group in this same pass, since VIRTUAL_STORE_NAMES
// is dependency-sorted so every group is only ever processed after everything it depends on. Also
// sums warehouse breakdowns (so the warehouse expand/collapse feature keeps working on a combined
// column, nested or not) and keeps each direct member's own row for the Official Store expand
// feature. A group/month combo with no member data that month is simply skipped (no phantom zero
// column). deriveMetrics runs on each produced row (and its warehouse sub-rows) immediately here,
// both so it renders correctly on its own AND so a higher-level group summing it next has fully-
// formed input (a proper warehouses array, not the intermediate object map) to work with.
function computeVirtualRows(realRows) {
  const out = [];
  const pool = realRows.slice(); // grows as each group's rows are added, so later (nested) groups can sum them
  VIRTUAL_STORE_NAMES.forEach(group => {
    const members = VIRTUAL_STORE_GROUPS[group];
    const byMonth = {};
    pool.forEach(r => {
      if (members.indexOf(r.brand) === -1) return;
      if (!byMonth[r.month]) {
        byMonth[r.month] = { brand: group, month: r.month, uniq: 0, qty: 0, sales: 0, claim: 0, rbp: 0, pickPack: 0, rentWarehouse: 0, rentWarehouseCbm: 0, rentWarehouseCbmWhpTotals: {}, consumables: 0, isVirtual: true, warehouses: {}, marketplaces: {}, memberStores: [] };
        PLATFORM_FEE_SUM_KEYS.forEach(k => { byMonth[r.month][k] = 0; });
      }
      const d = byMonth[r.month];
      d.uniq += r.uniq; d.qty += r.qty; d.sales += r.sales; d.claim += r.claim; d.rbp += r.rbp;
      d.pickPack += r.pickPack || 0; d.rentWarehouse += r.rentWarehouse || 0; d.rentWarehouseCbm += (r.rentWarehouseCbm || 0); d.consumables += r.consumables || 0;
      mergeWhpTotals_(d.rentWarehouseCbmWhpTotals, r.rentWarehouseCbmWhpTotals); // see this field's own comment near pctOfSalesNote_
      PLATFORM_FEE_SUM_KEYS.forEach(k => { d[k] += r[k] || 0; });
      // The direct member row itself — a real store's row, or (for a nested group) an already-
      // computed virtual row from an earlier group in this pass — kept as-is so "expand by
      // Official Store" on this combined column can show each direct member's own figures without
      // re-aggregating. Not used for anything that sums across the group (that's d.uniq/d.sales/
      // etc above) — purely for the store-expand sub-columns. See buildColumnList's 'store' mode.
      d.memberStores.push(r);
      (r.warehouses || []).forEach(w => {
        const name = w.warehouse || '(No Warehouse)';
        if (!d.warehouses[name]) {
          d.warehouses[name] = { warehouse: name, uniq: 0, qty: 0, sales: 0, claim: 0, rbp: 0, pickPack: 0, rentWarehouse: 0, rentWarehouseCbm: 0, rentWarehouseCbmWhpTotals: {}, consumables: 0, mpRbp: {} };
          PLATFORM_FEE_SUM_KEYS.forEach(k => { d.warehouses[name][k] = 0; });
        }
        const wd = d.warehouses[name];
        wd.uniq += w.uniq; wd.qty += w.qty; wd.sales += w.sales; wd.claim += w.claim; wd.rbp += w.rbp;
        wd.pickPack += w.pickPack || 0; wd.rentWarehouse += w.rentWarehouse || 0; wd.rentWarehouseCbm += (w.rentWarehouseCbm || 0); wd.consumables += w.consumables || 0;
        mergeWhpTotals_(wd.rentWarehouseCbmWhpTotals, w.rentWarehouseCbmWhpTotals); // see this field's own comment near pctOfSalesNote_
        // MOGTM Distributor Fee's per-marketplace RBP cross-tab (see Code.gs's
        // readFileContribution_ `wh[...].mpRbp` and deriveMetrics' r.warehouses branch above) —
        // merged in here so a Combined column's own deriveMetrics(d) call, just below, has a
        // complete cross-tab to compute d.marketplaces[i].mogtmFee from.
        Object.keys(w.mpRbp || {}).forEach(mpName => { wd.mpRbp[mpName] = (wd.mpRbp[mpName] || 0) + w.mpRbp[mpName]; });
        PLATFORM_FEE_SUM_KEYS.forEach(k => { wd[k] += w[k] || 0; });
      });
      // Marketplace breakdown, aggregated the same way as warehouses — so a Combined column (and
      // its Quarter/Half aggregate) can also expand by marketplace via +M. mogtmFee/_mogtmRbp are
      // deliberately NOT summed here (unlike pickPack etc.) — deriveMetrics(d) below computes them
      // straight from d.warehouses' mpRbp cross-tab instead, since it runs BEFORE this array is
      // handed to d.marketplaces.forEach(deriveMetrics) and would otherwise get overwritten anyway.
      (r.marketplaces || []).forEach(mp => {
        const name = mp.marketplace || '(No Marketplace)';
        if (!d.marketplaces[name]) {
          d.marketplaces[name] = { marketplace: name, uniq: 0, qty: 0, sales: 0, claim: 0, rbp: 0, pickPack: 0, rentWarehouse: 0, rentWarehouseCbm: 0, consumables: 0 };
          PLATFORM_FEE_SUM_KEYS.forEach(k => { d.marketplaces[name][k] = 0; });
        }
        const md = d.marketplaces[name];
        md.uniq += mp.uniq; md.qty += mp.qty; md.sales += mp.sales; md.claim += mp.claim; md.rbp += mp.rbp;
        md.pickPack += mp.pickPack || 0; md.rentWarehouse += mp.rentWarehouse || 0; md.rentWarehouseCbm += (mp.rentWarehouseCbm || 0); md.consumables += mp.consumables || 0;
        PLATFORM_FEE_SUM_KEYS.forEach(k => { md[k] += mp[k] || 0; });
      });
    });
    Object.keys(byMonth).forEach(month => {
      const d = byMonth[month];
      d.warehouses = Object.keys(d.warehouses).map(k => d.warehouses[k]).sort((a, b) => b.sales - a.sales);
      d.marketplaces = Object.keys(d.marketplaces).map(k => d.marketplaces[k]).sort((a, b) => b.sales - a.sales);
      // Biggest to smallest by Sales of Goods, same as the warehouse breakdown above — per
      // Zoltraak 2026-08-14, expanded warehouse/store columns should always read this way.
      d.memberStores.sort((a, b) => b.sales - a.sales);
      // computeVirtualRows is only ever called on Outright data (Consignment has no virtual/
      // combined store groups — see its call sites) — pass false explicitly rather than reading
      // state.activeView, since one of those call sites runs at module-load time before `state`
      // exists (see the DATA/CONSIGNMENT_DATA priming block near the top of this script).
      deriveMetrics(d, false);
      d.warehouses.forEach(w => deriveMetrics(w, false));
      d.marketplaces.forEach(mp => deriveMetrics(mp, false));
      out.push(d);
      pool.push(d); // available for any later (higher-level) group in this same pass to sum
    });
  });
  return out;
}
// Compute + fold the virtual rows into DATA now, before sort/STORES below — so they're treated
// exactly like any other row from here on. Only real rows are in DATA at this point (nothing
// virtual has been added yet), which is exactly what computeVirtualRows needs. deriveMetrics has
// already run on each virtual row inside computeVirtualRows itself (see above), so nothing
// further is needed here besides adding them to DATA.
(function appendVirtualRows() {
  computeVirtualRows(DATA).forEach(r => DATA.push(r));
})();

// Table columns are ordered oldest month -> newest month, left to right (Grand Total is always
// appended last regardless — see financeHeadHtml/financeBodyHtml). "month" is stored as "YYYY-MM",
// so a plain string comparison already sorts chronologically. Within the same month, bigger
// brands (by Sales of Goods) still come first, same as before.
DATA.sort((a, b) => {
  if (a.month !== b.month) return a.month < b.month ? -1 : 1;
  return b.sales - a.sales;
});
MP_DATA.sort((a, b) => b.sales - a.sales);

// Real stores first, alphabetically — then virtual "combined" ones, also alphabetically, grouped
// at the end. Keeps the Official Store filter list's ordering predictable and easy to scan (see
// renderFilterList's divider before the first virtual entry) instead of following whatever order
// DATA.sort() (by month/sales) happened to produce.
let STORES = [...new Set(DATA.filter(r => !r.isVirtual).map(r => r.brand))]
  .sort((a, b) => a.localeCompare(b))
  .concat(VIRTUAL_STORE_NAMES.filter(name => DATA.some(r => r.brand === name)).sort((a, b) => a.localeCompare(b)));
// Newest period first in the Period filter popover — "month" is "YYYY-MM", so a plain descending
// string sort is already chronological. This only controls the POPOVER's list order; the table's
// own column order (oldest -> newest, left to right) is driven separately by DATA.sort() above.
let MONTHS = [...new Set(DATA.map(r => r.month))].sort((a, b) => b.localeCompare(a));

// tag: grey-highlighted short label shown in place of the raw column name (no parentheses)
// formula: optional grey-highlighted formula annotation shown as a second line (kept with parentheses)
// label: bold label used instead of "tag" for rows 8-10 (kept as-is, formula still added)
// group: ties a row to one of ROW_GROUP_DEFS below — a row with no `group` is always shown; one
// with a `group` is only shown while that group is toggled visible (see state.rowGroups /
// renderTable's filtering). Rows with no group (Number of Order, AOV, Sales of Goods, Gross
// Profit, % Gross Profit) always stay on screen regardless of grouping state.
// groupToggle: attaches an inline +/- button (see groupToggleBtnHtml) to THIS row's label that
// shows/hides the ROW_GROUP_DEFS group named here — replaces the old separate toolbar popover
// (per Zoltraak 2026-08-13: "convert into expand and collapse tools right on the left of the
// lines"). Placed on the row immediately preceding/heading each group, one per group: Number of
// Order (g1), Sales of Goods (g2), % Gross Profit (g3), and the Operational and Fulfillment Cost
// header (g4).
const OUTRIGHT_ROW_DEFS = [
  // cellTitle — hover tooltip added 2026-08-18 ("Add hover tooltip: % breakdown for Number of
  // Order cells"): reads currentUniqTooltipTotals, a module-level var renderTable(rows) recomputes
  // (via computeUniqTotals) at the top of every render — see uniqTooltipText's own comment for why
  // this needs whole-dataset context that a single row's own fields can't provide. CONSIGNMENT_ROW_
  // DEFS' derivation below spreads this row's other properties through unchanged, so it's inherited
  // there too.
  { key: "uniq",    idx: 1,  tag: "Number of Order",         formula: null,                                              fmt: "int",   section: "", groupToggle: "g1",
    cellTitle: (data, ctx) => uniqTooltipText(data, ctx) },
  { key: "aov",     idx: 2,  tag: "Average Order Value",     formula: "(Sales of Goods / Number of Order)",              fmt: "money", section: "" },
  { key: "qty",     idx: 3,  tag: "Quantity",                formula: null,                                              fmt: "int",   section: "", group: "g1" },
  { key: "abs",     idx: 4,  tag: "Average Basket Size",     formula: "(Sales of Goods / Quantity)",                     fmt: "money", section: "", group: "g1" },
  { key: "sales",   idx: 6,  tag: "Price_Total_After_Subsidy", formula: null,                                            fmt: "money", section: "sales", groupToggle: "g2" },
  // cellNote added 2026-08-26 per Zoltraak's "% contribution" request (see pctOfSalesNote_'s own
  // comment) — Rebates' grey "% contribution to Sales of Goods" line under the number.
  // formula REVISED 2026-08-31 per Zoltraak: grey "(RRP - CBP)" annotation added under the label —
  // purely informational (matches every other tag's own grey formula-line style, e.g. aov/abs
  // above), NOT wired into the actual Gross Profit calculation, which still reads claim's own raw
  // sourced value exactly as before.
  // groupToggle: "g5" (added 2026-08-31) MOVED OFF this row 2026-08-31 (third round) per Zoltraak
  // ("revised the button expand collapse from line rebates, to line Claim based on Sell Out") — see
  // the new "claimBasedOnSellOut" divider row directly below, which now anchors g5 instead. Rebates
  // itself stays a plain member of g2 (Rebates/COGS/MOGTM), same as before g5 ever existed.
  { key: "claim",   idx: 7,  tag: "Claim",                   formula: "(RRP - CBP)",                                     fmt: "money", section: "", group: "g2",
    cellNote: pctOfSalesNote_('claim') },
  // New blank divider row added 2026-08-31 (third round) per Zoltraak ("add blank line after
  // Rebates, name it: Claim based on Sell Out" + "revised the button expand collapse from line
  // rebates, to line Claim based on Sell Out"): sits directly below Rebates, above Claim 10% COGS,
  // and now carries the g5 toggle that used to live on the Rebates row itself (see that row's own
  // comment just above) — expanding/collapsing it still reveals exactly the same 3 rows (Claim 10%
  // COGS / Additional Budget Promo / Claim Vouchers), only the toggle's home row moved. Same
  // isHeader/exportBlankRow blank-divider mechanism as "Claim based on Sell in" below (see that
  // row's own comment for the full mechanism explanation) — reasoned interpretation: "Claim based on
  // Sell Out" (10% COGS/Additional Budget Promo/Vouchers) vs "Claim based on Sell in" (STTI/
  // Visibility/Service Fee/Incentives/Price Clawback) groups the two existing claim-detail sections
  // by financial claim type; worth confirming with Zoltraak if this pairing isn't what was meant.
  { isHeader: true, exportBlankRow: true, key: "claimBasedOnSellOut", idx: 7.05, label: "Claim based on Sell Out", section: "", group: "g2", groupToggle: "g5" },
  // 3 placeholder rows added 2026-08-31 per Zoltraak, directly below Rebates — "the numbers let it
  // 0 right now" (no data source wired up yet, same starting treatment Chip In/Other Revenue
  // originally got): each key is brand new and never set anywhere else in DATA/MP_DATA/computeGrand/
  // computeVirtualRows/computePeriodAggregateRows/computeGrandWarehouses/Marketplaces/Stores, so
  // every row shape (real month, warehouse/store/marketplace sub-row, Half/Quarter aggregate, Grand
  // Total, Grand Total's own expand-by-dimension columns) reads it as `undefined`, and fmtVal/
  // fmtMoney's own `Number(v) || 0` already turns that into a plain "0" everywhere automatically —
  // no extra summing/init plumbing needed anywhere else for these to show 0 correctly right now.
  // `group` REVISED to a 2-entry array the same day, per Zoltraak's Rebates expand/collapse request
  // above — these 3 rows now live behind BOTH the existing g2 (Rebates/COGS section) toggle AND the
  // new g5 (Rebates' own dedicated) toggle; see the `visibleDefs`/`rowGroupsVisible_` filter's own
  // comment for how a row can require more than one group to be visible at once.
  { key: "claim10PctCogs",       idx: 7.1, tag: "Claim 10% COGS",         formula: null, fmt: "money", section: "", group: ["g2", "g5"] },
  { key: "additionalBudgetPromo", idx: 7.2, tag: "Additional Budget Promo", formula: null, fmt: "money", section: "", group: ["g2", "g5"] },
  { key: "claimVouchers",        idx: 7.3, tag: "Claim Vouchers",         formula: null, fmt: "money", section: "", group: ["g2", "g5"] },
  // Blank divider row added 2026-08-31 per Zoltraak ("add new blank line after claim vouchers, and
  // ... let the blank line ... have its own button expand collapse as well"): reuses the SAME
  // isHeader mechanism the "Operational and Fulfillment Cost:" divider row uses (blank data cells,
  // just a label + optional inline group-toggle button — see financeBodyHtml's own isHeader
  // branch). `label` REVISED 2026-08-31 (third round) from "" to "Claim based on Sell in" per
  // Zoltraak ("blank line after line Claim Vouchers, name it: Claim based on Sell in") — still the
  // SAME divider row (unchanged key/idx/group/groupToggle:"g6"), just no longer literally blank.
  // `exportBlankRow: true` (read only by buildExportPayload_, NOT by the dashboard's own isHeader
  // rendering) is what gets this ONE header-style row included in the Excel export too — every
  // OTHER isHeader row in this array is still silently skipped there, unchanged; see
  // buildExportPayload_'s own comment on `dataRowDefs`'s filter for why. `key` is only needed for
  // that same Excel-side special case (dataRowDefs still requires def.key) — never read for
  // anything dashboard-side, since isHeader rows never reach financeBodyHtml's value-cell code path;
  // kept as "blankAfterClaimVouchers" (not renamed) since nothing about its identity changed, only
  // its display label.
  { isHeader: true, exportBlankRow: true, key: "blankAfterClaimVouchers", idx: 7.35, label: "Claim based on Sell in", section: "", group: "g2", groupToggle: "g6" },
  // 6 more placeholder rows added 2026-08-31 per Zoltraak, directly below the new blank line —
  // "let the numbers 0 for now", same treatment as claim10PctCogs/additionalBudgetPromo/
  // claimVouchers above. Nested the same way: behind BOTH g2 (the whole Rebates/COGS section) and
  // g6 (this blank line's own dedicated toggle).
  { key: "claimSTTI",                 idx: 7.36, tag: "Claim STTI",                                     formula: null, fmt: "money", section: "", group: ["g2", "g6"] },
  { key: "claimVisibility",           idx: 7.37, tag: "Claim Visibility",                                formula: null, fmt: "money", section: "", group: ["g2", "g6"] },
  { key: "claimServiceFee",           idx: 7.38, tag: "Claim Service Fee 1.50%",                         formula: null, fmt: "money", section: "", group: ["g2", "g6"] },
  { key: "claimMonthlyIncentives",    idx: 7.39, tag: "Claim Monthly Incentives 1.50%-2.20%",            formula: null, fmt: "money", section: "", group: ["g2", "g6"] },
  // g6's last member — was claimQuarterlyIncentives/priceClawbackDropPrice (2 rows), NARROWED
  // 2026-09-01 per Zoltraak ("please move line Price Claw back due to Drop Price as part of other
  // revenue") — Price Claw back due to Drop Price moved out of this group entirely, see its new
  // position directly below Other Revenue further down. g6End's own Excel anchor (buildExportPayload_)
  // moved from priceClawbackDropPrice to this row to match.
  { key: "claimQuarterlyIncentives",  idx: 7.40, tag: "Claim Quarterly Incentives 1.00%-2.20%",          formula: null, fmt: "money", section: "", group: ["g2", "g6"] },
  // Other Revenue — real figure as of 2026-08-13 (previously a permanent $0 placeholder), sourced
  // server-side in Code.gs (loadOtherRevenue_/refreshData Pass 5) from a spreadsheet in the
  // "Report Fee" Drive folder, per brand and month. ONLY ever nonzero for LOreal Group's 14 real
  // Official Stores — see LOREAL_GROUP_BRANDS in Code.gs; every other brand/month always reads $0
  // here, same as Surplus above. Not wired into the Gross Profit formula below (per Zoltraak: kept
  // as its own informational line between Rebates and COGS, same reserved position it already
  // had as a placeholder) — deriveMetrics/computeGrand just carry through whatever Code.gs sent,
  // same treatment as sales/claim/rbp.
  // cellNote added 2026-08-26 per Zoltraak's "% contribution" request (see pctOfSalesNote_'s own
  // comment) — Other Revenue's grey "% contribution to Sales of Goods" line under the number.
  { key: "otherRevenue", idx: 8, tag: "Other Revenue",       formula: null,                                              fmt: "money", section: "", group: "g2",
    cellNote: pctOfSalesNote_('otherRevenue') },
  // Price Claw back due to Drop Price — MOVED 2026-09-01 per Zoltraak ("please move line Price Claw
  // back due to Drop Price as part of other revenue, update both dashboard and excel") from its old
  // position as the last member of the g6 (Claim based on Sell in) detail group, up to directly
  // below Other Revenue instead. No longer carries `group: ["g2","g6"]` — it's no longer part of
  // that nested claim-detail block at all, just a plain g2 member now (still collapses with the rest
  // of the Rebates/COGS section, same as Other Revenue itself, just no longer behind g6's own
  // dedicated toggle). Still the same never-set-anywhere $0 placeholder it always was — `formula`
  // stays null, same treatment as every other row here.
  { key: "priceClawbackDropPrice", idx: 8.02, tag: "Price Claw back due to Drop Price", formula: null, fmt: "money", section: "", group: "g2" },
  // COGS (rbp) — MOVED 2026-08-26 per Zoltraak's specified row order (Sales of Goods, Rebates,
  // Other Revenue, COGS, Surplus, MOGTM Distributor Fee, Promo Fund Front Margin, Promo Fund Back
  // Margin) from its old position after Promo Fund Back Margin up to here, directly below Other
  // Revenue. idx renumbered to 8.05 (was 9) to match its new position — see the following rows'
  // idx values (8.1/8.15/8.2/8.25), all renumbered the same way; nothing outside this file's own
  // `def.idx > 4` table1/table2 split reads these specific idx numbers (the separately-maintained
  // OUTRIGHT_LEGEND array is reordered/renumbered to match, but independently), so renumbering
  // them is safe.
  // cellNote added 2026-08-26 per Zoltraak's "% contribution" request (see pctOfSalesNote_'s own
  // comment) — COGS's grey "% contribution to Sales of Goods" line under the number.
  { key: "rbp",     idx: 8.05, tag: "RBP_VAT_Total",           formula: null,                                              fmt: "money", section: "", group: "g2",
    cellNote: pctOfSalesNote_('rbp') },
  // Surplus — moved 2026-08-26 per Zoltraak ("move surplus line below line other revenue") from
  // its old position right after Average Basket Size down to below Other Revenue, then MOVED AGAIN
  // the same day, below COGS, per Zoltraak's specified row order (see the COGS entry's own comment
  // just above). Raw field computed server-side in Code.gs from the Data Claim Internal files' own
  // "Surplus" column (readFileContribution_/refreshData Pass 3) — not a client-side formula, so
  // `formula` stays null, same as sales/claim/rbp elsewhere in this list. ONLY ever nonzero for
  // Sanghiang Perkasa Group's 4 real Official Stores (Morinaga Official Shop, Prenagen World
  // Official Store, Entrasol Official Store, Milna Official Store) — see
  // SANGHIANG_PERKASA_GROUP_BRANDS in Code.gs; every other brand/month always reads $0 here. Still
  // ungrouped (no `group`) exactly as before the move — always visible regardless of the "g2"
  // (Sales of Goods) collapsible section's state, same as Sales of Goods/Gross Profit themselves.
  // Feeds into Gross Profit / % Gross Profit as a DEDUCTION, the same treatment as Promo Fund
  // Front/Back Margin below — see deriveMetrics/computeGrand's r.gp/g.gp formulas and the gp/pctGp
  // ROW_DEFS entries' own `formula` text below. cellNote adds the same small grey "% contribution
  // to Sales of Goods" annotation Promo Fund Front/Back Margin already show.
  // formula REVISED 2026-08-31 per Zoltraak: grey "(CBP - RRP) — as written in Agreement"
  // annotation added under the label, same purely-informational treatment as Rebates' own "(RRP -
  // CBP)" formula-line just above — not wired into the actual Gross Profit calculation.
  // groupToggle: "g7" added 2026-08-31 (third round) per Zoltraak ("add button expand collapse as
  // well at surplus that consist of Promo Fund Front Margin and Promo Fund Back Margin") — Dashboard
  // only (not requested for Excel), same as g8/g9/g10 below.
  { key: "surplus", idx: 8.1, tag: "Surplus",                formula: "(CBP - RRP) — as written in Agreement",           fmt: "money", section: "", groupToggle: "g7",
    cellNote: pctOfSalesNote_('surplus') },
  // Promo Fund Front Margin / Back Margin — new rows per Zoltraak 2026-08-18, placed directly below
  // Other Revenue; MOVED 2026-08-26 to below MOGTM Distributor Fee; MOVED AGAIN 2026-08-31 per
  // Zoltraak ("Promo fund front margin and promo fund back margin below line surplus") to directly
  // below Surplus, ahead of Chip In and MOGTM Distributor Fee — idx renumbered to 8.11/8.12 (was
  // 8.2/8.25) to match, same renumbering convention the COGS entry's own comment above established;
  // Chip In/MOGTM Distributor Fee below are renumbered the same way to stay in visual order. Raw
  // fields computed server-side in Code.gs (loadPromoFundBetadine_/refreshData Pass 6) from the
  // "2026 Promo Fund Betadine Official Store" Google Sheet — not a client-side formula, so `formula`
  // stays null, same as Other Revenue/Surplus above. ONLY ever nonzero for the Betadine Group
  // (Betadine Official Store, Betadine Store) — see PROMO_FUND_BETADINE_BRANDS in Code.gs; every
  // other brand/month always reads $0 here. These two feed into Gross Profit/% Gross Profit as a
  // deduction — see deriveMetrics/computeGrand's r.gp/g.gp formulas (addition/subtraction order
  // there is commutative and doesn't depend on this array's own row order).
  // `group` REVISED 2026-08-31 (third round) to a 2-entry array, per the new g7 toggle added to
  // Surplus above (dashboard-only) — these two now live behind BOTH the existing g2 (Rebates/COGS
  // section) toggle AND the new g7 (Surplus's own dedicated) toggle, same nesting pattern as
  // claim10PctCogs/etc. under g2+g5.
  { key: "promoFundFrontMargin", idx: 8.11, tag: "Promo Fund Front Margin", formula: null, fmt: "money", section: "", group: ["g2", "g7"],
    cellNote: pctOfSalesNote_('promoFundFrontMargin') },
  { key: "promoFundBackMargin",  idx: 8.12, tag: "Promo Fund Back Margin",  formula: null, fmt: "money", section: "", group: ["g2", "g7"],
    cellNote: pctOfSalesNote_('promoFundBackMargin') },
  // Chip In — added 2026-08-28 per Zoltraak, directly below Surplus (then Promo Fund Front/Back
  // Margin inserted ahead of it 2026-08-31 — see those entries' own comment; idx renumbered to
  // 8.13, was 8.12). No data source configured yet ("let it 0 at this current situation" — see
  // PLATFORM_FEE_SUM_KEYS/deriveMetrics' own comments), so `formula` stays null the same way every
  // other server-sourced-but-currently-empty row does. Deliberately NOT wired into the Gross
  // Profit/% Gross Profit formulas below (unlike Surplus) — kept as a plain informational line
  // until told otherwise, same starting treatment Other Revenue originally got. cellNote mirrors
  // Surplus's own "% contribution to Sales of Goods" annotation for visual consistency (harmless —
  // always blank today since the value is 0).
  // groupToggle: "g8" added 2026-08-31 (third round) per Zoltraak ("add button expand collapse as
  // well at Chip In that consist of Price Claw back due to Increased Price and Defisit due to
  // Incorrect Price") — Dashboard only, same as g7 above.
  { key: "chipIn", idx: 8.13, tag: "Chip In",                 formula: null,                                              fmt: "money", section: "", groupToggle: "g8",
    cellNote: pctOfSalesNote_('chipIn') },
  // 2 placeholder rows added 2026-08-31 per Zoltraak, directly below Chip In — "let the numbers 0
  // for now", same no-data-source-yet treatment as Chip In itself and the new Rebates-area
  // placeholder rows above. `group: "g8"` ADDED 2026-08-31 (third round) — now behind Chip In's own
  // new toggle above (dashboard-only; no `group` string was in play here before, so unlike
  // promoFundFrontMargin/BackMargin above there's no g2-style outer group to preserve alongside it).
  // Second row's key RENAMED defisitIncorrectPrice -> deficitIncorrectPrice and tag "Defisit" ->
  // "Deficit" 2026-08-31 (third round) per Zoltraak ("revised writtings Defisit into Deficit") —
  // see the matching OUTRIGHT_LEGEND entry, renamed the same way; nothing else in DATA/computeGrand/
  // etc. ever references the old key (same never-set-anywhere placeholder pattern as its neighbors),
  // so the rename is safe.
  { key: "priceClawbackIncreasedPrice", idx: 8.14, tag: "Price Claw back due to Increased Price", formula: null, fmt: "money", section: "", group: "g8" },
  { key: "deficitIncorrectPrice",       idx: 8.15, tag: "Deficit due to Incorrect Price",          formula: null, fmt: "money", section: "", group: "g8" },
  // MOGTM Distributor Fee — MOVED 2026-08-26 per Zoltraak's specified row order (see the COGS
  // entry's own comment above) from its old position after Promo Fund Back Margin up to here,
  // directly below Surplus; MOVED again in EFFECT 2026-08-31 (Promo Fund Front/Back Margin, Chip
  // In, and the 2 new Price Claw back/Defisit rows above all inserted ahead of it now — idx
  // renumbered to 8.16, was 8.15). 2.5% of ONLY the slice of COGS sitting in a MOGTM-code warehouse
  // bucket, EXCEPT MOGTM - Betadine Solo (MNS) which bills at 8.5% (see MOGTM_FEE_RATE_BY_WAREHOUSE,
  // deriveMetrics/warehouseMogtmFee) — a brand/month column shows the sum of that across its
  // warehouse buckets, 0 if none of them are MOGTM. Expanding the column shows the real fee on the
  // MOGTM sub-column specifically and a plain 0 on every other one (TMS, Benoa, etc.). cellNote
  // adds the small grey "%" annotation directly under the number, only where the fee is actually
  // >0 for that specific cell — via effectiveMogtmRate(data), NOT warehouseMogtmRate(data): the
  // latter reads data.warehouse, which only exists on a single warehouse sub-row, so on every
  // aggregate/top-level column (brand/month, Grand Total, period rollup, ...) it silently fell back
  // to the global 2.5% default even when the real dollar figure above it already correctly blended
  // in Betadine's 8.5% — e.g. a Betadine-only column showed "$X" next to "2.5%" when the true
  // implied rate was 8.5%. effectiveMogtmRate derives the rate the row's own numbers actually imply
  // instead.
  { key: "mogtmFee", idx: 8.16, tag: "MOGTM Distributor Fee", formula: null, fmt: "money", section: "", group: "g2",
    cellNote: (data) => (data && data.mogtmFee > 0 ? fmtMogtmRatePct(effectiveMogtmRate(data)) : null) },
  // formula text REVISED 2026-08-26 (second revision) per Zoltraak: Other Revenue is now ADDED,
  // and every term's order in this string matched the row order at the time (Sales of Goods,
  // Rebates, Other Revenue, COGS, Surplus, MOGTM Distributor Fee, Promo Fund Front Margin, Promo
  // Fund Back Margin) — see deriveMetrics/computeGrand's r.gp/g.gp formulas for the actual
  // calculation (addition/subtraction order there doesn't affect the result, only this display
  // text's readability). REVISED AGAIN 2026-08-31 ("revised grey writings at gross profit") to
  // match the row order AFTER Promo Fund Front/Back Margin moved above MOGTM Distributor Fee (see
  // those entries' own comment) — same terms, just Promo Fund Front/Back Margin now listed before
  // MOGTM Distributor Fee instead of after it.
  { key: "gp",      idx: 11,  label: "Gross Profit",          formula: "(Sales of Goods + Rebates + Other Revenue - COGS - Surplus - Promo Fund Front Margin - Promo Fund Back Margin - MOGTM Distributor Fee)", fmt: "money", section: "gp",
    cellTitle: (data, ctx) => gpTooltipText(data, ctx) },
  // formula text SIMPLIFIED 2026-08-31 per Zoltraak ("the grey color writings at % gross profit
  // revised to : Gross Profit / (Sales of Goods + Rebates)") — was the full expanded Gross Profit
  // sum divided by (Sales of Goods + Rebates); now just references the Gross Profit row by name,
  // since that row already spells out its own full formula immediately above. Purely a display-text
  // change — pctGp's actual VALUE (deriveMetrics/computeGrand's r.pctGp/g.pctGp) is unaffected.
  { key: "pctGp",   idx: 12, label: "% Gross Profit",        formula: "Gross Profit / (Sales of Goods + Rebates)", fmt: "pct", section: "", groupToggle: "g3",
    cellTitle: (data, ctx) => pctGpTooltipText(data, ctx) },
  // Gross Profit per Order — added 2026-09-12 per Zoltraak, placed immediately after % Gross
  // Profit. Same visual treatment (label/section "gp") as the Gross Profit row itself, per
  // Zoltraak's spec — but it's a RATIO for breakdown purposes (see METRIC_BREAKDOWN_RATIO_ROW_KEYS
  // below), same as % Gross Profit, since summing per-warehouse/marketplace GP-per-Order values
  // isn't mathematically meaningful the way summing Gross Profit itself is.
  { key: "gpPerOrder", idx: 12.5, label: "Gross Profit per Order", formula: "Gross Profit / Number of Order", fmt: "money", section: "gp",
    cellTitle: (data, ctx) => gpPerOrderTooltipText(data, ctx) },
  { key: "pctDisc", idx: 13, label: "% Discount",            formula: "(Rebates) / (Sales of Goods + Rebates)",          fmt: "pct",   section: "", group: "g3" },
  // Operational & Fulfillment Cost: a label-only divider row (isHeader, no key/value) followed by
  // 4 real data rows + a Total. pickPack/rentWarehouse/consumables are raw fields computed
  // server-side in Code.gs (rate from the Warehouse Breakdown sheet × that brand/warehouse's
  // Number of Order) — not a client-side formula, unlike aov/abs/gp/pctGp/pctDisc above, so
  // `formula` stays null here the same way sales/claim/rbp/qty/uniq do. Informational only,
  // separate from MOGTM Distributor Fee — does not affect Gross Profit or % Gross Profit above
  // (per Zoltraak: default assumption pending confirmation otherwise). This header + PICK PACK/
  // RENT WAREHOUSE/CONSUMABLES ONLY form group "g4" (narrowed 2026-08-13 per Zoltraak: "expand
  // collapse only capture line pick pack, rent warehouse and consumables" — Platform Fee Absorb
  // by SIRCLO and Total Operational and Fulfillment Cost below deliberately no longer carry
  // `group: "g4"`, so toggling g4 no longer hides either of them).
  { isHeader: true, idx: 14, label: "Operational and Fulfillment Cost:", section: "", groupToggle: "g4" },
  // Platform Fee Absorb by SIRCLO — raw sum from every Platform Fee file column whose header
  // contains "absorb" (broadened 2026-08-13, see Code.gs's absorbColIdxs), computed server-side
  // same as pickPack/rentWarehouse/consumables below it — not a client-side formula, so `formula`
  // stays null. abs: true because, like every other field sourced from these Platform Fee files
  // (see MARKETPLACE_FEE_ROW_DEFS below), the source stores it as a negative deduction; the
  // dashboard shows it as a positive cost figure instead. Placed above Pick Pack per Zoltraak's
  // spec, and folded into Total Operational and Fulfillment Cost below as a magnitude (see
  // deriveMetrics/computeGrand). No longer part of group "g4" — see the isHeader row's comment
  // above — so it stays visible even while Pick Pack/Rent Warehouse/Consumables are collapsed.
  // cellNote added 2026-08-26 per Zoltraak's "% contribution" request (see pctOfSalesNote_'s own
  // comment) alongside this row's existing cellTitle hover tooltip — both render independently
  // (cellNote as the grey line under the number, cellTitle as the title= hover). useAbs:true here
  // since this row's raw field is stored negative (see `abs: true` above) — without it the note
  // would show a negative percentage while the cell itself shows a positive cost figure.
  // groupToggle: "g9" added 2026-08-31 (third round) per Zoltraak ("add expand collapase tools at
  // line platform fee absorb by SIRCLO that contains of line 'Marketplace Fee (Based on Sell in)'")
  // — Both Dashboard AND Excel this time (unlike g7/g8 above), see the new marketplaceFeeSellIn row
  // directly below and its own Excel-side native row-group tracking in buildExportPayload_.
  { key: "absorbBySirclo", idx: 15, tag: "Platform Fee Absorb by SIRCLO", formula: null, fmt: "money", section: "", abs: true, groupToggle: "g9",
    cellTitle: (data, ctx) => costGroupTooltipText('Platform Fee Absorb by SIRCLO', 'absorbBySirclo')(data, ctx),
    cellNote: pctOfSalesNote_('absorbBySirclo', true) },
  // New $0 placeholder row added 2026-08-31 (third round) per Zoltraak ("after line Platform Fee
  // Absorb by SIRCLO, name it 'Marketplace Fee (Based on Sell in)' ... let them 0 right now"): same
  // never-set-anywhere-in-DATA placeholder pattern as chipIn/priceClawbackIncreasedPrice/etc. (reads
  // as `undefined`, fmtVal's `Number(v)||0` auto-displays "0"). Behind the new g9 toggle on
  // absorbBySirclo above — Both Dashboard and Excel (see that row's own comment).
  { key: "marketplaceFeeSellIn", idx: 15.5, tag: "Marketplace Fee (Based on Sell in)", formula: null, fmt: "money", section: "", group: "g9" },
  { key: "pickPack",      idx: 16, tag: "Pick Pack",        formula: null, fmt: "money", section: "", group: "g4",
    cellTitle: (data, ctx) => costGroupTooltipText('Pick Pack', 'pickPack')(data, ctx),
    cellNote: pctOfSalesNote_('pickPack') },
  // REVISED 2026-09-14 per Zoltraak: reordered this section so Consumables (+ its own Warehouse Fee
  // Sell In sub-row) come right after Pick Pack, with Rent Warehouse moved to the very LAST row of
  // this section (right before Total Operational and Fulfillment Cost below) — was previously
  // Pick Pack / Rent Warehouse / Consumables. The standalone "CBM Usage" row that used to sit here
  // (added 2026-09-12, idx 17.3) is REMOVED entirely from this section per the same revision — it
  // no longer needs a main-table row of its own now that both it and Rent Warehouse per CBM live
  // together in the Rate of Operational and Fulfillment Cost panel below (see RATE_ROW_DEFS), in
  // that new order. The underlying `rentWarehouseCbm` raw field is untouched (Code.gs still
  // computes it, deriveMetrics/computeGrand still sum it at every breakdown level) — only this
  // VISIBLE main-table row and its export twin are gone; see buildExportPayload_'s Rate panel block
  // for how CBM Usage's export now sources itself directly instead of cross-referencing this row.
  { key: "consumables",   idx: 17, tag: "Consumables",      formula: null, fmt: "money", section: "", group: "g4", groupToggle: "g10",
    cellTitle: (data, ctx) => costGroupTooltipText('Consumables', 'consumables')(data, ctx),
    cellNote: pctOfSalesNote_('consumables') },
  // New $0 placeholder row added 2026-08-31 (third round) per Zoltraak ("after line Consumables,
  // name it 'Warehouse Fee (Based on Sell In)' ... let them 0 right now"): same placeholder pattern
  // as marketplaceFeeSellIn above. `group` carries BOTH g4 (Consumables' own row lives in g4, and
  // this new row should collapse right along with it when g4 itself is toggled, same as
  // claim10PctCogs's g2+g5 double-nesting) AND the new g10 (Consumables' own dedicated toggle).
  // idx moved to 17.5 (was 18.5) 2026-09-14 to stay grouped right under Consumables' new idx 17.
  { key: "warehouseFeeSellIn", idx: 17.5, tag: "Warehouse Fee (Based on Sell In)", formula: null, fmt: "money", section: "", group: ["g4", "g10"] },
  // Rent Warehouse — moved to the bottom of this section 2026-09-14 per Zoltraak (was idx 17, right
  // after Pick Pack). idx reassigned to 18 (Consumables' old idx) — no functional change to how its
  // own value is computed (see Code.gs's Pass 4 Rent Warehouse section), only its position/idx.
  { key: "rentWarehouse", idx: 18, tag: "Rent Warehouse",   formula: null, fmt: "money", section: "", group: "g4",
    cellTitle: (data, ctx) => costGroupTooltipText('Rent Warehouse', 'rentWarehouse')(data, ctx),
    cellNote: pctOfSalesNote_('rentWarehouse') },
  // No longer part of group "g4" (see the isHeader row's comment above) — always visible. `bold`
  // per Zoltraak 2026-08-13 ("give bold at line Total Operational and Fulfillment Cost") — see
  // financeBodyHtml's row-bold class, a plain font-weight bump with no background-color change
  // (unlike `section: "gp"`, which also tints the row — this row intentionally keeps its normal
  // background, just bolded). totalOpCost's own raw field (deriveMetrics/computeGrand) already
  // folds in Math.abs(absorbBySirclo), so no useAbs is needed for its cellNote.
  { key: "totalOpCost",   idx: 19, tag: "Total Operational and Fulfillment Cost", formula: "(Pick Pack + Rent Warehouse + Consumables + Platform Fee Absorb by SIRCLO)", fmt: "money", section: "", bold: true,
    cellTitle: (data, ctx) => costGroupTooltipText('Total Operational and Fulfillment Cost', 'totalOpCost')(data, ctx),
    cellNote: pctOfSalesNote_('totalOpCost') },
  // Contribution Margin / % Contribution Margin — deliberately left OUT of group "g4" (unlike
  // Pick Pack/Rent Warehouse/Consumables above) even though they sit right after Total Operational
  // and Fulfillment Cost positionally: they're bottom-line profitability metrics in the same vein
  // as Gross Profit / % Gross Profit above (which are similarly ungrouped, always visible), not
  // Operational & Fulfillment Cost detail — collapsing that section's own breakdown (g4) shouldn't
  // also hide the headline number it feeds into. section: "gp" reuses Gross Profit's highlighted
  // styling for the same reason.
  { key: "contributionMargin", idx: 20, label: "Contribution Margin", formula: "(Gross Profit - Total Operational and Fulfillment Cost)", fmt: "money", section: "gp",
    cellTitle: (data, ctx) => cmTooltipText(data, ctx) },
  { key: "pctContributionMargin", idx: 21, label: "% Contribution Margin", formula: "(Contribution Margin) / (Sales of Goods + Rebates)", fmt: "pct", section: "",
    cellTitle: (data, ctx) => pctCmTooltipText(data, ctx) },
  // Contribution Margin per Order — added 2026-09-12 per Zoltraak, same treatment as
  // gpPerOrder above (section "gp" styling, RATIO for breakdown-note purposes).
  { key: "cmPerOrder", idx: 21.5, label: "Contribution Margin per Order", formula: "Contribution Margin / Number of Order", fmt: "money", section: "gp",
    cellTitle: (data, ctx) => cmPerOrderTooltipText(data, ctx) },
];

// Active-view row definitions — the engine's `ROW_DEFS` global is repointed by applyView() to
// either the Outright set (above) or the Consignment set (below); both tabs share the same table
// framework/logic, only the data source and a few display formulas differ.
let ROW_DEFS = OUTRIGHT_ROW_DEFS;

// The collapsible row groups (see ROW_DEFS' `group` key) — each toggled independently via its own
// +/- button (renderRowGroupToggles/toggleRowGroup). All default to visible (true), matching the
// table's full row set before this feature existed — nothing is hidden until the user hides it.
// `short` is the button's own label (kept compact so several buttons fit comfortably in the
// toolbar); `label` is the fuller description used in the button's title tooltip.
let ROW_GROUP_DEFS = [
  { key: "g1", label: "Quantity & Average Basket Size", short: "Quantity & ABS" },
  { key: "g2", label: "Rebates, COGS & MOGTM Distributor Fee", short: "Rebates & COGS" },
  { key: "g3", label: "% Discount", short: "% Discount" },
  // Narrowed 2026-08-13 per Zoltraak — Platform Fee Absorb by SIRCLO and Total Operational and
  // Fulfillment Cost are no longer part of this group (see their ROW_DEFS entries' comments), so
  // this only ever hides/shows Pick Pack, Rent Warehouse, and Consumables now.
  { key: "g4", label: "Pick Pack, Rent Warehouse & Consumables", short: "Op. & Fulfillment Cost" },
  // g5/g6 added 2026-08-31 per Zoltraak — two NESTED collapse groups living inside g2 (Rebates'
  // own row and the new blank-line divider right after Claim Vouchers both keep their `group: "g2"`
  // membership — see their ROW_DEFS entries — so collapsing g2 still hides these sub-rows along
  // with everything else in that section; g5/g6 just add a second, independent layer of collapse
  // ON TOP of that for their own 3/6 sub-rows specifically). See `group`'s own comment above
  // OUTRIGHT_ROW_DEFS for how a row now lists MORE than one group.
  { key: "g5", label: "Claim 10% COGS, Additional Budget Promo & Claim Vouchers", short: "Rebates detail" },
  { key: "g6", label: "Claim STTI, Claim Visibility & other Rebates deductions", short: "More Rebates detail" },
  // g7/g8 added 2026-08-31 (third round) per Zoltraak — Dashboard only (no Excel-side native
  // row-group tracking added for these two, unlike g9/g10 below), same nested-inside-g2-or-standalone
  // pattern as g5/g6: g7 lives inside g2 (Promo Fund Front/Back Margin keep `group: ["g2","g7"]`),
  // g8 is standalone (Chip In/its 2 sub-rows carry no g2 membership, same as before g8 existed).
  { key: "g7", label: "Promo Fund Front Margin & Promo Fund Back Margin", short: "Promo Fund detail" },
  { key: "g8", label: "Price Claw back due to Increased Price & Deficit due to Incorrect Price", short: "Chip In detail" },
  // g9/g10 added 2026-08-31 (third round) per Zoltraak — Both Dashboard AND Excel this time (see
  // marketplaceFeeSellIn/warehouseFeeSellIn's own ROW_DEFS comments and buildExportPayload_'s new
  // g9Row/g10Row native Sheets row-group tracking). g9 is standalone (Marketplace Fee (Based on Sell
  // in) carries only `group: "g9"`); g10 lives inside g4 (Warehouse Fee (Based on Sell In) carries
  // `group: ["g4","g10"]`, same nesting as g5/g7 inside g2).
  { key: "g9", label: "Marketplace Fee (Based on Sell in)", short: "Marketplace Fee detail" },
  { key: "g10", label: "Warehouse Fee (Based on Sell In)", short: "Warehouse Fee detail" },
];

// Table 3 (the standalone "Rate of Operational and Fulfillment Cost" panel above Formula Index) —
// same 3 categories as the cost rows above, but showing the RATE PER ORDER rather than
// rate × orders. There's no server-side "rate" field to read directly per column though: Code.gs
// only stores each warehouse bucket's already-multiplied cost (pickPack/rentWarehouse/consumables)
// plus its own order count (uniq) — see readFileContribution_/refreshData in Code.gs. Dividing
// cost back by orders (see rateOf() below) recovers the exact rate that was applied for a single
// warehouse column, and for a MAIN (non-expanded) column spanning several warehouses, or for
// Grand Total, it naturally becomes the weighted-average blended rate across whatever's summed
// into that cell — the same math the "Rate Per Order" column in the Warehouse Breakdown sheet
// itself uses (Total Cost ÷ Number of Order), just computed client-side from what's already here.
// Rent Warehouse's own rate row REASSESSED 2026-09-12 per Zoltraak ("untuk rent warehouse ini tidak
// relevan menggunakan jumlah order, jadi nantinya akan menggunakan basis CBM Usage ... untuk setiap
// bulannya"): the old "Rent Warehouse" row here (Cost ÷ Number of Order, via rateOf/def.key like
// Pick Pack/Consumables still do) is REPLACED by two rows — "CBM Usage" (the raw quantity, not a
// rate) placed directly before "Rent Warehouse per CBM" (Cost ÷ CBM Usage) per Zoltraak's explicit
// placement instruction. Pick Pack and Consumables are untouched — the correction only applies to
// Rent Warehouse.
// `valueFn`/`fmt` (new, optional per-row overrides — see rateBodyHtml) let these two rows escape
// the table's default "rateOf(data, key) formatted as money" behavior without touching how Pick
// Pack/Consumables render (they set neither, so they still go through rateOf + 'money' exactly as
// before). Both read the already-derived r.rentWarehouseCbm/r.rentWarehousePerCbm fields
// (deriveMetrics/computeGrand and every Grand-Total/warehouse/marketplace/period aggregate builder
// — see their own comments) rather than recomputing here, so this is guaranteed to match whatever
// those functions produce at every column/breakdown level for free.
// Reordered 2026-09-14 per Zoltraak: Pick Pack, Consumables, Rent Warehouse per CBM, CBM Usage
// (was Pick Pack, CBM Usage, Rent Warehouse per CBM, Consumables). CBM Usage's main-table row
// (previously idx 17.3 in OUTRIGHT_ROW_DEFS) was removed the same day — it now lives only here.
// `rentWarehousePerCbm`'s own tag renamed from "Rent Warehouse per CBM" to plain "Rent Warehouse"
// the same day (later revision, also 2026-09-14) — the internal `key`/field name is unchanged
// (still `rentWarehousePerCbm` everywhere: deriveMetrics/computeGrand/export code), this only
// changes what's DISPLAYED. REVISED AGAIN 2026-09-14 per Zoltraak ("agar align... ubah logicnya
// menjadi = Rent Warehouse/Number Of Order"): r.rentWarehousePerCbm is now UNCONDITIONALLY Cost ÷
// Number of Order again (see deriveMetrics' own comment) — the CBM-vs-uniq distinction moved out of
// the FORMULA and into this row's own cellNote instead (rentWarehouseBasisNote_, below), a small
// grey informational remark ("Number of Order" / "CBM Usage") under the number. CBM Usage's own row
// also gained a cellNote the same day (rentWarehouseCbmPctNote_) — this brand/warehouse's own CBM
// Usage as a % of the total CBM Usage recorded for that WHP+Subsidiary — see that function's own
// extensive comment (and rentWarehouseCbmWhpTotals' comment above it) for why this is safe to show
// at every level, including Grand Total/Virtual Group, despite combining more than one brand.
let RATE_ROW_DEFS = [
  { isHeader: true, label: "Rate of Operational and Fulfillment Cost:" },
  { key: "pickPack",      tag: "Pick Pack" },
  { key: "consumables",   tag: "Consumables" },
  { key: "rentWarehousePerCbm", tag: "Rent Warehouse", valueFn: (data) => (data && data.rentWarehousePerCbm) || 0,
    cellNote: rentWarehouseBasisNote_ },
  { key: "rentWarehouseCbm", tag: "CBM Usage", valueFn: (data) => (data && data.rentWarehouseCbm) || 0, fmt: "decimal",
    cellNote: rentWarehouseCbmPctNote_ },
];

// The rows that get a per-row Warehouse/Store/Marketplace breakdown toggle — see
// state.metricRowBreakdown's own comment. Sales of Goods first (per Zoltraak 2026-08-26), then the
// 5 rows added the same day in his follow-up message, then Number of Order/Quantity added
// 2026-08-27 ("tambahkan detail per warehouse, store dan marketplace serta % Cont. to SoG untuk
// Number of Order, Quantity"). Every one of these keys already has a fully deriveMetrics'd value on
// every row shape (a main column, a warehouse/marketplace/member-store sub-object, and every
// computeGrand*/rows entity list below) — money rows (sales/gp/totalOpCost/contributionMargin),
// plain count rows (uniq/qty), and ratio rows (pctGp/pctContributionMargin) are treated identically
// by computeMetricBreakdownRows_ AND by buildExportPayload_'s "% Cont. to SoG" logic (which
// classifies everything except the 2 METRIC_BREAKDOWN_RATIO_ROW_KEYS entries as "money-type"), since
// all three groups are just plain numeric fields on those same objects.
// gpPerOrder/cmPerOrder added 2026-09-12 per Zoltraak: same breakdown-by-Warehouse/Marketplace
// treatment as Gross Profit/Contribution Margin (expand buttons, hover tooltips, Sheet export),
// but see METRIC_BREAKDOWN_RATIO_ROW_KEYS just below — they're RATIOS (Gross Profit/Contribution
// Margin ÷ Number of Order), not summable money amounts, so they're listed there too.
// aov/abs ADDED 2026-10-20 per Zoltraak (export only): Average Order Value / Average Basket Size get a per-store / per-warehouse /
// per-marketplace breakdown under them in the Sheets export — see EXPORT_NO_ENTITY_PCT_ROW_KEYS and LIVE_FORMULA_BREAKDOWN_KEYS.
const METRIC_BREAKDOWN_ROW_KEYS = ['uniq', 'qty', 'sales', 'gp', 'pctGp', 'gpPerOrder', 'totalOpCost', 'contributionMargin', 'pctContributionMargin', 'cmPerOrder', 'aov', 'abs'];

const state = {
  // Every store — real and virtual "combined" alike — starts UNSELECTED, so opening the
  // dashboard shows nothing until someone actively picks at least one Official Store (see the
  // empty-state message in renderTable()). This also means a virtual group and its real members
  // never start double-counted, without needing a special case for virtual ones specifically.
  // Period still defaults to fully selected, so picking a store immediately shows all its data
  // rather than needing two separate selections just to see anything.
  store: Object.fromEntries(STORES.map(s => [s, false])),
  month: Object.fromEntries(MONTHS.map(m => [m, true])),
  draft: { store: {}, month: {} },
  search: { store: "", month: "" },
  activeView: "outright",
  // Tracks which store/month columns are currently expanded to show their per-warehouse
  // breakdown, keyed by "<brand>||<month>" (see columnKey()). Missing/false = collapsed.
  expandedColumns: {},
  // Grand Total's OWN warehouse/store breakdown toggle — same false/'wh'/'store' mode shape as a
  // single entry of expandedColumns above, but just one value (there's only one Grand Total
  // column) and independent of every other column's expand state. Per Zoltraak 2026-08-14: before
  // this, Grand Total's warehouse breakdown just auto-appeared any time ANY column was expanded by
  // warehouse, with no way to show/hide it on its own — see toggleGrandExpand/computeGrandStores.
  grandExpand: false,
  // Tracks which row groups (see ROW_GROUP_DEFS) are currently visible — true = shown, matching
  // the full row set every table had before this feature existed. Toggled via the "Rows" popover.
  rowGroups: Object.fromEntries(ROW_GROUP_DEFS.map(g => [g.key, true])),
  // Period column hierarchy (see buildPeriodSequence): every Half defaults to COLLAPSED (shown as
  // one "H1"/"H2" column, per Zoltraak's spec) — periodExpand tracks which Half slots (keyed by
  // their own slot key, e.g. "2026-H1", shared across every brand/warehouse column currently
  // showing that half — see togglePeriodExpand) have been expanded to show their 2 Quarters
  // instead. Missing/false = collapsed (just the Half column).
  periodExpand: {},
  // Independent global on/off (see toggleExpandAllMonths): when true, every Half/Quarter period
  // column — regardless of its own periodExpand state above — decomposes all the way down to its
  // individual month columns instead. Defaults to off, matching "overview H1 in single column" as
  // the starting view.
  expandMonths: false,
  // Per-row breakdown toggles — added 2026-08-26 per Zoltraak: "at line Sales of Goods, I can show
  // hide the sales of goods by row as well for the detail from each official store... it also
  // apply to all table designed by warehouse, store, marketplace, period." Extended the SAME day,
  // per Zoltraak's follow-up, to 5 more rows ("apply this show hide & % grey %contribution to line
  // Gross Profit, % Gross Profit, Total Operational and Fulfillment Cost, Contribution Margin and
  // % Contribution Margin as well") and the Period dimension was dropped again ("please remove show
  // hide Period at line sales of goods") — see METRIC_BREAKDOWN_ROW_KEYS below for the final row
  // list. Distinct from every OTHER expand mechanism above (expandedColumns/grandExpand/
  // periodExpand/expandMonths), which all add extra COLUMNS — this instead adds extra ROWS directly
  // under whichever of these 6 rows it's attached to, one shared toggle per (row, dimension) pair
  // applying to every currently visible column at once (same "global toggle" shape as
  // expandMonths), so the rest of the table never gets wider. Keyed by ROW_DEFS key, each value
  // {wh, store, mp} — see toggleMetricRowBreakdown/metricBreakdownToggleBtnHtml_/
  // computeMetricBreakdownRows_/metricBreakdownRowsHtml_. All default to off/collapsed.
  metricRowBreakdown: Object.fromEntries(METRIC_BREAKDOWN_ROW_KEYS.map(k => [k, { wh: false, store: false, mp: false }])),
};

// Number(undefined)/Number(null) are NaN, and Math.round(NaN).toLocaleString() renders the literal
// string "NaN" — which is exactly what showed up for pickPack/rentWarehouse/consumables the first
// time the dashboard rendered a cached payload from BEFORE those fields existed (a row from an old
// cache simply doesn't have them at all, so c.data[def.key] comes back undefined). Falling back to
// 0 here means any row missing a field displays a plain 0 instead of "NaN" — whether that's because
// the payload just genuinely predates a field, or any other future case of a value not being set.
function fmtInt(n) { return Math.round(Number(n) || 0).toLocaleString('en-US'); }
function fmtMoney(n) { return Math.round(Number(n) || 0).toLocaleString('en-US'); }
function fmtPct(n) { const v = Number(n); return (Number.isFinite(v) ? v : 0).toFixed(2) + '%'; }
// fmtDecimal: added 2026-09 for "CBM Usage" (Rent Warehouse CBM-based revision) — CBM values are
// fractional (e.g. 116.87), unlike fmtInt/fmtMoney which both round via Math.round and would
// silently truncate meaningful precision. Two decimal places, thousands-separated, no currency
// styling (matches how the source sheet itself displays CBM).
function fmtDecimal(n) {
  const v = Number(n);
  return (Number.isFinite(v) ? v : 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function computeGrand(rows) {
  // _mogtmRbp: 0 + the summing line below fixes a bug (per Zoltraak 2026-08-18) where the Grand
  // Total column's MOGTM Distributor Fee "%" cell-note always showed the hardcoded default rate
  // (2.5%) instead of the real blended rate (e.g. 2% for a Natasha-only/Natasha-heavy Grand Total)
  // — effectiveMogtmRate(g) needs g._mogtmRbp to compute the real blended rate the same way it
  // already does for marketplace/store sub-rows; without it, `g` had neither .warehouses,
  // .warehouse, nor ._mogtmRbp, so effectiveMogtmRate fell through to its MOGTM_FEE_RATE default
  // every time. Mirrors computeGrandMarketplaces/computeGrandStores, which already did this right.
  const g = { sales: 0, rbp: 0, claim: 0, qty: 0, uniq: 0, pickPack: 0, rentWarehouse: 0, rentWarehouseCbm: 0, rentWarehouseCbmWhpTotals: {}, consumables: 0, mogtmFee: 0, _mogtmRbp: 0 };
  PLATFORM_FEE_SUM_KEYS.forEach(k => { g[k] = 0; });
  rows.forEach(r => {
    g.sales += r.sales; g.rbp += r.rbp; g.claim += r.claim; g.qty += r.qty; g.uniq += r.uniq;
    g.pickPack += r.pickPack || 0; g.rentWarehouse += r.rentWarehouse || 0; g.rentWarehouseCbm += (r.rentWarehouseCbm || 0); g.consumables += r.consumables || 0;
    // rentWarehouseCbmWhpTotals — merged by KEY (never summed) — see this field's own extensive
    // comment near pctOfSalesNote_/mergeWhpTotals_ for why.
    mergeWhpTotals_(g.rentWarehouseCbmWhpTotals, r.rentWarehouseCbmWhpTotals);
    g.mogtmFee += r.mogtmFee || 0; g._mogtmRbp += r._mogtmRbp || 0;
    PLATFORM_FEE_SUM_KEYS.forEach(k => { g[k] += r[k] || 0; });
  });
  g.aov = g.uniq ? g.sales / g.uniq : 0;
  g.abs = g.qty ? g.sales / g.qty : 0;
  // Promo Fund Front/Back Margin deduction — mirrors deriveMetrics' r.gp above; g.promoFundFront
  // Margin/g.promoFundBackMargin are already summed via the generic PLATFORM_FEE_SUM_KEYS loop
  // above (both keys are registered there), so only this formula needs the explicit subtraction.
  // g.surplus is summed the same generic way (also registered in PLATFORM_FEE_SUM_KEYS) — REVISED
  // 2026-08-26 per Zoltraak ("sebagai pengurang seperti promo fund") to deduct here too, mirroring
  // deriveMetrics' r.gp. g.otherRevenue (also PLATFORM_FEE_SUM_KEYS) is ADDED per Zoltraak's same-
  // day second revision — see deriveMetrics' matching comment for the term-order rationale.
  g.gp = g.sales + g.claim + (g.otherRevenue || 0) - g.rbp - (g.surplus || 0) - g.mogtmFee - (g.promoFundFrontMargin || 0) - (g.promoFundBackMargin || 0);
  g.pctGp = (g.sales + g.claim) ? (g.gp / (g.sales + g.claim)) * 100 : 0;
  // Gross Profit per Order — mirrors deriveMetrics' r.gpPerOrder (see that comment for rationale).
  g.gpPerOrder = g.uniq ? g.gp / g.uniq : 0;
  g.pctDisc = (g.sales + g.claim) ? (g.claim / (g.sales + g.claim)) * 100 : 0;
  // Same treatment as deriveMetrics' totalOpCost/contributionMargin/pctContributionMargin — kept
  // as its own explicit computation here (rather than routed through deriveMetrics) since Grand
  // Total's `g` object is accumulated field-by-field above, not shaped like a normal DATA row.
  g.totalOpCost = g.pickPack + g.rentWarehouse + g.consumables + Math.abs(g.absorbBySirclo || 0);
  // Rent Warehouse (Rate panel row) — mirrors deriveMetrics' r.rentWarehousePerCbm above: REVERTED
  // 2026-09-14 back to unconditional Cost ÷ Number of Order (see that comment for why).
  g.rentWarehousePerCbm = g.uniq ? g.rentWarehouse / g.uniq : 0;
  // Total Platform Fee (Shopee) — same derived sum as deriveMetrics, done explicitly here since
  // Grand Total's `g` object is accumulated field-by-field (see the comment above).
  g.totalPlatformFee = (g.totalVouchers || 0) + (g.marketplaceFee || 0) + (g.otherMarketplaceFee || 0);
  g.contributionMargin = g.gp - g.totalOpCost;
  g.pctContributionMargin = (g.sales + g.claim) ? (g.contributionMargin / (g.sales + g.claim)) * 100 : 0;
  // Contribution Margin per Order — mirrors deriveMetrics' r.cmPerOrder.
  g.cmPerOrder = g.uniq ? g.contributionMargin / g.uniq : 0;
  return g;
}

// Table 2 shows the human-readable names for these three metrics instead of the raw Data Claim
// column names — table 1 and the Marketplace Overview table still show the raw names (matches
// the Legend section's naming, just applied to the label itself here instead of a footnote).
const TABLE2_LABEL_OVERRIDES = {
  sales: 'Sales of Goods',
  claim: 'Rebates',
  rbp: 'COGS',
};

// Aggregates every visible row's warehouse breakdown into one Grand-Total-by-warehouse list —
// e.g. if both April and May have a "Storaflow (KNS)" slice, this sums them into a single
// "Storaflow (KNS)" grand entry, same way the main Grand Total sums every row's overall totals.
// Only computed/shown while Grand Total's own toggle (state.grandExpand) is set to 'wh' — see
// toggleGrandExpand and renderTable.
// `nameFn` (optional) maps a raw warehouse name onto the bucket it is summed into — used by the export's
// "Per Period per Warehouse" sheet (computeGrandWarehouseGroups below); every other caller passes nothing and gets
// one bucket per raw warehouse name exactly as before.
function computeGrandWarehouses(rows, nameFn) {
  const map = {};
  rows.forEach(r => {
    (r.warehouses || []).forEach(w => {
      const name = (nameFn ? nameFn(w.warehouse) : w.warehouse) || '(No Warehouse)';
      if (!map[name]) {
        // otherRevenue/surplus/promoFundFrontMargin/promoFundBackMargin added 2026-08-27 per
        // Zoltraak's per-category breakdown request for Rebates/Other Revenue/COGS/Surplus/MOGTM
        // Distributor Fee/Promo Fund Front/Back Margin — these 4 fields DO exist per-warehouse
        // server-side (see Code.gs's readFileContribution_/loadPromoFundBetadine_ writing onto
        // d.warehouses[...]) but were never summed onto this aggregate entity before, so any
        // breakdown or deriveMetrics-derived figure (Gross Profit, Contribution Margin) reading them
        // off a warehouse aggregate silently treated them as 0 — this fixes that gap, not just for
        // the new export rows but for the dashboard's own existing Warehouse breakdown of Gross
        // Profit/Contribution Margin too (previously understated whichever warehouse actually had
        // nonzero Other Revenue/Surplus/Promo Fund).
        map[name] = { warehouse: name, uniq: 0, qty: 0, sales: 0, claim: 0, rbp: 0, pickPack: 0, rentWarehouse: 0, rentWarehouseCbm: 0, rentWarehouseCbmWhpTotals: {}, consumables: 0, otherRevenue: 0, surplus: 0, promoFundFrontMargin: 0, promoFundBackMargin: 0 };
        PLATFORM_FEE_SUM_KEYS.forEach(k => { map[name][k] = 0; });
      }
      const m = map[name];
      m.uniq += w.uniq; m.qty += w.qty; m.sales += w.sales; m.claim += w.claim; m.rbp += w.rbp;
      m.pickPack += w.pickPack || 0; m.rentWarehouse += w.rentWarehouse || 0; m.rentWarehouseCbm += (w.rentWarehouseCbm || 0); m.consumables += w.consumables || 0;
      mergeWhpTotals_(m.rentWarehouseCbmWhpTotals, w.rentWarehouseCbmWhpTotals); // see this field's own comment near pctOfSalesNote_

      PLATFORM_FEE_SUM_KEYS.forEach(k => { m[k] += w[k] || 0; });
      if (nameFn) {
        // A grouped bucket (e.g. "MOGTM") has no single warehouse name to look a rate up by, so its MOGTM Distributor Fee
        // is summed from each underlying warehouse's own fee (their own per-warehouse rates) instead of being derived from
        // the bucket's name — deriveMetrics leaves an already-numeric mogtmFee alone.
        m.mogtmFee = (m.mogtmFee || 0) + warehouseMogtmFee(w);
        m._mogtmRbp = (m._mogtmRbp || 0) + (warehousePrefix(w.warehouse) === 'mogtm' ? (w.rbp || 0) : 0);
      }
    });
  });
  const list = Object.keys(map).map(k => map[k]);
  // These flat map entries have no .warehouses of their own and no mogtmFee pre-summed onto them
  // (unlike computeGrandMarketplaces/computeGrandStores below), so deriveMetrics computes each
  // one's fee straight from its own warehouse name/rbp — needs the isConsignment override too, same
  // as everywhere else, so a MOGTM-coded warehouse doesn't show a fee on the Consignment tab.
  list.forEach(r => deriveMetrics(r, state.activeView === 'consignment'));
  list.sort((a, b) => b.sales - a.sales);
  return list;
}


// Warehouse grouping for the export's "Per Period per Warehouse" sheet — ADDED 2026-10-20 per Zoltraak: warehouses are
// grouped by the START of their name (case-insensitive): Benoa... -> "KLOG Benoa", Surabaya... -> "KLOG Surabaya",
// TMS... -> "TMS", BKS... -> "BKS", MOGTM... -> "MOGTM", Lazada... -> "Lazada", Kintetsu... -> "Kintetsu" (the last two added
// 2026-10-21 per Zoltraak). Any other warehouse keeps its own name. Everything else about
// the sheet (columns, rows, formulas) is unchanged — the buckets just hold the summed figures of every warehouse in them.
const EXPORT_WAREHOUSE_GROUPS = [
  { prefix: 'benoa', label: 'KLOG Benoa' },
  { prefix: 'surabaya', label: 'KLOG Surabaya' },
  { prefix: 'tms', label: 'TMS' },
  { prefix: 'bks', label: 'BKS' },
  { prefix: 'mogtm', label: 'MOGTM' },
  { prefix: 'lazada', label: 'Lazada' },
  { prefix: 'kintetsu', label: 'Kintetsu' },
];
function exportWarehouseGroupName_(raw) {
  const s = String(raw || '').trim();
  const lower = s.toLowerCase();
  for (let i = 0; i < EXPORT_WAREHOUSE_GROUPS.length; i++) {
    if (lower.indexOf(EXPORT_WAREHOUSE_GROUPS[i].prefix) === 0) return EXPORT_WAREHOUSE_GROUPS[i].label;
  }
  return s;
}
function computeGrandWarehouseGroups(rows) {
  return computeGrandWarehouses(rows, exportWarehouseGroupName_);
}

// Grand Total broken down by MARKETPLACE — only meaningful on the Consignment tab (that's the only
// place rows carry a `.marketplaces` breakdown). Same shape/aggregation as
// computeGrandWarehouses, just reading r.marketplaces instead of r.warehouses, so every metric row
// (including Platform Fee + O&F cost) renders correctly on the grand-total marketplace columns.
function computeGrandMarketplaces(rows) {
  const map = {};
  rows.forEach(r => {
    (r.marketplaces || []).forEach(m => {
      const name = m.marketplace || '(No Marketplace)';
      if (!map[name]) {
        // mogtmFee/_mogtmRbp summed explicitly below (like pickPack) rather than derived — see
        // computeGrandMarketplaces' matching note in deriveMetrics' comment; this flat map entry
        // has no .warehouses of its own to compute MOGTM fee from directly.
        // otherRevenue/surplus/promoFundFrontMargin/promoFundBackMargin added 2026-08-27 per
        // Zoltraak's per-category breakdown request — see computeGrandWarehouses' matching comment
        // for why (these exist per-marketplace server-side but were never summed onto this
        // aggregate entity before).
        map[name] = { marketplace: name, uniq: 0, qty: 0, sales: 0, claim: 0, rbp: 0, pickPack: 0, rentWarehouse: 0, rentWarehouseCbm: 0, consumables: 0, mogtmFee: 0, _mogtmRbp: 0, otherRevenue: 0, surplus: 0, promoFundFrontMargin: 0, promoFundBackMargin: 0 };
        PLATFORM_FEE_SUM_KEYS.forEach(k => { map[name][k] = 0; });
      }
      const m2 = map[name];
      m2.uniq += m.uniq; m2.qty += m.qty; m2.sales += m.sales; m2.claim += m.claim; m2.rbp += m.rbp;
      m2.pickPack += m.pickPack || 0; m2.rentWarehouse += m.rentWarehouse || 0; m2.rentWarehouseCbm += (m.rentWarehouseCbm || 0); m2.consumables += m.consumables || 0;
      m2.mogtmFee += m.mogtmFee || 0; m2._mogtmRbp += m._mogtmRbp || 0;


      PLATFORM_FEE_SUM_KEYS.forEach(k => { m2[k] += m[k] || 0; });
    });
  });
  const list = Object.keys(map).map(k => map[k]);
  // mogtmFee/_mogtmRbp are already pre-summed above from each source row's own (already-correctly-
  // zeroed-on-Consignment) figures, so this is belt-and-suspenders rather than load-bearing — kept
  // for consistency with every other deriveMetrics call site in this file.
  list.forEach(r => deriveMetrics(r, state.activeView === 'consignment'));
  list.sort((a, b) => b.sales - a.sales);
  return list;
}

// Recursively decomposes a row down to the real (non-virtual) Official Store rows behind it — a
// plain real row is just itself; a Combined/virtual row's memberStores are walked one level at a
// time, which naturally handles nested groups too (e.g. "LOreal Group"'s memberStores are
// themselves virtual — LOreal CPD, LOreal LDB, ... — each recursed into in turn until real leaves
// come out the other end). Used by computeGrandStores below so Grand Total's store breakdown
// always shows real Official Stores, never an intermediate combined group, regardless of how
// deeply nested the currently-visible rows happen to be.
function flattenToRealStores(r, out) {
  out = out || [];
  if (r.isVirtual && r.memberStores && r.memberStores.length) {
    r.memberStores.forEach(m => flattenToRealStores(m, out));
  } else {
    out.push(r);
  }
  return out;
}

// Non-recursive counterpart to flattenToRealStores above — expands a Combined/virtual row to just
// its own DIRECT members (one level), without descending into any further-nested virtual layer.
// Added 2026-09-16 per Zoltraak, scoped to the EXPORT sheets only (see computeExportGrandStores_
// just below): for a group-of-groups selection like "LOreal Group" (whose own memberStores are
// themselves virtual — LOreal CPD/LDB/LLD/PPD), the export's "Per Period per Store" sheet should
// break down by DIVISION (those 4 direct members), not recurse all the way down to the ~14
// individual real stores those divisions are themselves made of — unlike the on-screen Grand
// Total's own +S toggle (computeGrandStores(rows), unchanged, still uses the fully-recursive
// flattenToRealStores). A real row, or a virtual row whose own direct members are already real
// stores (e.g. selecting a single sub-group like "LOreal CPD" alone, or a brand with a flat
// one-level group), is unaffected — one level down from a real-stores-only group IS the real
// stores, identical to what flattenToRealStores would already return.
function flattenToDirectMembers_(r, out) {
  out = out || [];
  if (r.isVirtual && r.memberStores && r.memberStores.length) {
    r.memberStores.forEach(m => out.push(m));
  } else {
    out.push(r);
  }
  return out;
}

// Aggregates every visible row's real Official Store identity into one Grand-Total-by-store list —
// mirrors computeGrandWarehouses one level down: a Combined/virtual row (LOreal CPD, Unilever
// Group, ...) contributes its real member stores' own figures (via flattenToRealStores above,
// summed across however many of the visible rows/months touch that store), a real row just
// contributes itself. Only computed/shown while Grand Total's own toggle (state.grandExpand) is
// set to 'store' — see toggleGrandExpand and renderTable.
// `flattenFn` — added 2026-09-16, defaults to flattenToRealStores so every existing on-screen call
// site (computeGrandStores(rows), one argument) is completely unaffected — lets the export path
// (see computeExportGrandStores_ below) reuse this exact same aggregation logic with the shallower
// flattenToDirectMembers_ instead, without duplicating the whole function.
function computeGrandStores(rows, flattenFn) {
  flattenFn = flattenFn || flattenToRealStores;
  const map = {};
  rows.forEach(r => {
    flattenFn(r).forEach(s => {
      const name = s.brand;
      if (!map[name]) {
        // mogtmFee/_mogtmRbp summed explicitly below (like pickPack) — `s` here is a real
        // per-brand/month row when flattenFn is flattenToRealStores (its whole point), or a
        // one-level-down entity (real OR still-virtual, e.g. a division row) when flattenFn is
        // flattenToDirectMembers_ — either way deriveMetrics has already run on it (see
        // computeVirtualRows for the virtual case), so it already has a correct
        // s.mogtmFee/s._mogtmRbp from its own .warehouses (see deriveMetrics); this flat map entry
        // itself has no .warehouses to derive from directly.
        // otherRevenue/surplus/promoFundFrontMargin/promoFundBackMargin added 2026-08-27 per
        // Zoltraak's per-category breakdown request — see computeGrandWarehouses' matching comment
        // for why (these exist per-brand/month directly on `s` but were never summed onto this
        // aggregate entity before).
        map[name] = { brand: name, uniq: 0, qty: 0, sales: 0, claim: 0, rbp: 0, pickPack: 0, rentWarehouse: 0, rentWarehouseCbm: 0, rentWarehouseCbmWhpTotals: {}, consumables: 0, mogtmFee: 0, _mogtmRbp: 0, otherRevenue: 0, surplus: 0, promoFundFrontMargin: 0, promoFundBackMargin: 0 };
        PLATFORM_FEE_SUM_KEYS.forEach(k => { map[name][k] = 0; });
      }
      const m = map[name];
      m.uniq += s.uniq; m.qty += s.qty; m.sales += s.sales; m.claim += s.claim; m.rbp += s.rbp;
      m.pickPack += s.pickPack || 0; m.rentWarehouse += s.rentWarehouse || 0; m.rentWarehouseCbm += (s.rentWarehouseCbm || 0); m.consumables += s.consumables || 0;
      mergeWhpTotals_(m.rentWarehouseCbmWhpTotals, s.rentWarehouseCbmWhpTotals); // see this field's own comment near pctOfSalesNote_
      m.mogtmFee += s.mogtmFee || 0; m._mogtmRbp += s._mogtmRbp || 0;


      PLATFORM_FEE_SUM_KEYS.forEach(k => { m[k] += s[k] || 0; });
    });
  });
  const list = Object.keys(map).map(k => map[k]);
  // mogtmFee/_mogtmRbp are already pre-summed above from each source row's own (already-correctly-
  // zeroed-on-Consignment) figures, so this is belt-and-suspenders rather than load-bearing — kept
  // for consistency with every other deriveMetrics call site in this file.
  list.forEach(r => deriveMetrics(r, state.activeView === 'consignment'));
  list.sort((a, b) => b.sales - a.sales);
  return list;
}

// Export-only aggregator — see flattenToDirectMembers_'s own comment above for why the export's
// "Per Period per Store" sheet needs a shallower (one-level) breakdown than the on-screen Grand
// Total's own +S toggle. Used ONLY by the export code path (computeExportStoreBreakdown_ and the
// "Per Period per Store" EXPORT_DIMENSIONS entry) — every on-screen call site keeps calling
// computeGrandStores(rows) directly with no second argument, which still defaults to the full
// flattenToRealStores recursion, so this is invisible anywhere except the exported Google Sheet.
// Added 2026-09-16 per Zoltraak ("output export to sheets ketika memilih LOreal Group tolong
// tampilkan breakdown per level group saja tidak perlu sampai level individual store").
function computeExportGrandStores_(rows) {
  return computeGrandStores(rows, flattenToDirectMembers_);
}

/* ---------------- Period rollup: Quarter/Half aggregate columns ---------------- */
//
// Zoltraak's spec: the table's columns always run Jan, Feb, Mar, Q1 (Jan+Feb+Mar total), Apr, May,
// Jun, Q2, H1 (Q1+Q2 total), Jul, Aug, Sep, Q3, Oct, Nov, Dec, Q4, H2 — for whichever months are
// actually selected/visible — BUT a Quarter/Half aggregate only ever appears when ALL of its
// constituent months are present: an in-progress quarter (e.g. Q3 2026 with only July read in so
// far) shows just its lone available month(s) instead of a misleading partial "Q3 2026" total. The
// exact same completeness rule also decides what the Period filter popover's tree offers to click
// (see buildPeriodTree, reused by both).
//
// These aggregate rows are built fresh on every renderTable() call, purely for display (feeding
// buildColumnList) — they're never written into the global DATA array, so nothing about the
// underlying dataset, Grand Total, or any other filter is affected by their existence.

// Builds the Period tree from whichever real "YYYY-MM" month keys are currently available —
// returned newest-year-first (what the popover wants). Each year's node list is a mix of: a
// complete half ({type:'half'} wrapping its 2 quarters, each wrapping its 3 months), a complete
// standalone quarter (half incomplete but that quarter complete), or bare standalone months
// (even that quarter incomplete) — whichever level is actually complete for that stretch of the
// year. buildPeriodSequence below walks this same structure oldest-year-first and flattened, for
// the table's actual column order.
function buildPeriodTree(months) {
  const byYear = {};
  months.forEach(m => {
    const parts = String(m).split('-');
    if (parts.length !== 2) return;
    const mo = Number(parts[1]);
    if (!(mo >= 1 && mo <= 12)) return;
    (byYear[parts[0]] = byYear[parts[0]] || new Set()).add(mo);
  });
  const years = Object.keys(byYear).sort((a, b) => b.localeCompare(a));
  const monthKey = (y, mo) => y + '-' + String(mo).padStart(2, '0');
  return years.map(year => {
    const present = byYear[year];
    const monthNode = mo => ({ type: 'month', key: monthKey(year, mo), months: [monthKey(year, mo)] });
    const qMonthNums = q => [3 * (q - 1) + 1, 3 * (q - 1) + 2, 3 * (q - 1) + 3];
    // Always returns an array (never a bare node) so callers can always spread it: a complete
    // quarter collapses to one wrapper node; an incomplete one floats its present month(s) up
    // individually instead.
    const quarterNodes = q => {
      const nums = qMonthNums(q);
      const presentNums = nums.filter(mo => present.has(mo));
      if (presentNums.length === 0) return [];
      if (presentNums.length < nums.length) return presentNums.map(monthNode);
      return [{ type: 'quarter', key: year + '-Q' + q, months: nums.map(mo => monthKey(year, mo)), children: nums.map(monthNode) }];
    };
    const halfNodes = (qa, qb, half) => {
      const isWrappedQuarter = arr => arr.length === 1 && arr[0].type === 'quarter';
      if (isWrappedQuarter(qa) && isWrappedQuarter(qb)) {
        return [{ type: 'half', key: year + '-H' + half, months: [...qa[0].months, ...qb[0].months], children: [qa[0], qb[0]] }];
      }
      return [...qa, ...qb];
    };
    const nodes = [...halfNodes(quarterNodes(1), quarterNodes(2), 1), ...halfNodes(quarterNodes(3), quarterNodes(4), 2)];
    return { year, nodes };
  }).filter(y => y.nodes.length > 0);
}

// True only for a genuine real-month column key ("YYYY-MM", e.g. "2026-07") — false for Grand
// Total (no .month at all), a Half/Quarter aggregate column's own key ("YYYY-H1"/"YYYY-Q3"), or
// anything else malformed. Used to gate the Number of Order hover tooltip (uniqTooltipText below)
// to real month cells only — a Half/Quarter aggregate column IS the period itself, so "% to Half"
// there would always trivially read 100%, and Grand Total isn't tied to one brand at all.
function isRealMonthKey(m) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m));
}

// month "YYYY-MM" -> its Quarter key ("YYYY-Q1".."YYYY-Q4"), or null if `m` isn't a real month key.
function monthToQuarterKey(m) {
  const mm = /^(\d{4})-(\d{2})$/.exec(String(m));
  if (!mm) return null;
  const mo = Number(mm[2]);
  if (!(mo >= 1 && mo <= 12)) return null;
  return mm[1] + '-Q' + Math.ceil(mo / 3);
}

// month "YYYY-MM" -> its Half key ("YYYY-H1"/"YYYY-H2"), or null if `m` isn't a real month key.
function monthToHalfKey(m) {
  const mm = /^(\d{4})-(\d{2})$/.exec(String(m));
  if (!mm) return null;
  const mo = Number(mm[2]);
  if (!(mo >= 1 && mo <= 12)) return null;
  return mm[1] + '-H' + (mo <= 6 ? 1 : 2);
}

// Per Zoltraak 2026-08-18 ("Add hover tooltip: % breakdown for Number of Order cells"), generalized
// 2026-08-19 to Gross Profit/Contribution Margin too ("hover Gross Profit serupa Number of Order"):
// a real month column's cell shows, on hover, its fraction + % of that SAME brand's Total (every
// currently-visible month), its Half, and its Quarter — e.g. for Number of Order:
//   Number of Order Contribution:
//   2,038/15,293 (13.32% to Total)
//   2,038/13,255 (15.38% to Total H1)
//   2,038/6,981 (29.19% to Total Q3)
// `totals` is whatever computeMetricTotals(rows, key) produced for the current renderTable() call.
// Returns null for anything that isn't a real brand+month cell (Grand Total, a warehouse/store/
// marketplace sub-column — those get groupContributionTooltip instead, see uniqTooltipText/
// gpTooltipText/cmTooltipText below — or a Half/Quarter aggregate column) — financeBodyHtml only
// adds a title= attribute when this returns truthy, same as cellNote.
function metricTooltipText(label, key, data, totals, fmt) {
  if (!data || !totals || !data.brand || !isRealMonthKey(data.month)) return null;
  const fmtFn = fmt === 'int' ? fmtInt : fmtMoney;
  const val = data[key] || 0;
  const total = totals.totalByBrand[data.brand] || 0;
  const hKey = monthToHalfKey(data.month);
  const qKey = monthToQuarterKey(data.month);
  const half = hKey ? (totals.halfByBrand[data.brand + '||' + hKey] || 0) : 0;
  const quarter = qKey ? (totals.quarterByBrand[data.brand + '||' + qKey] || 0) : 0;
  const pct = (num, den) => (den > 0 ? (num / den * 100).toFixed(2) : '0.00');
  const lines = [`${label} Contribution:`];
  lines.push(`${fmtFn(val)}/${fmtFn(total)} (${pct(val, total)}% to Total)`);
  if (hKey) lines.push(`${fmtFn(val)}/${fmtFn(half)} (${pct(val, half)}% to Total ${hKey.split('-')[1]})`);
  if (qKey) lines.push(`${fmtFn(val)}/${fmtFn(quarter)} (${pct(val, quarter)}% to Total ${qKey.split('-')[1]})`);
  return lines.join('\n');
}

// Ratio-metric counterpart of metricTooltipText, for % Gross Profit / % Contribution Margin — shows
// this month's own %, alongside the SAME brand's real blended % for its Half/Quarter/Total-so-far
// (each computed as sum(numerator)/sum(denominator) over that scope via computeRatioTotals, NOT an
// average of monthly percentages, which would be a different — and wrong — number).
function ratioTooltipText(label, valueKey, ratioTotals, data) {
  if (!data || !ratioTotals || !data.brand || !isRealMonthKey(data.month)) return null;
  const ratio = (num, den) => (den ? (num / den * 100) : 0);
  const hKey = monthToHalfKey(data.month);
  const qKey = monthToQuarterKey(data.month);
  const totalR = ratio(ratioTotals.numByBrand[data.brand] || 0, ratioTotals.denByBrand[data.brand] || 0);
  const lines = [`${label}:`];
  lines.push(`This Month: ${fmtPct(data[valueKey] || 0)}`);
  if (hKey) lines.push(`Total ${hKey.split('-')[1]}: ${fmtPct(ratio(ratioTotals.numHalf[data.brand + '||' + hKey] || 0, ratioTotals.denHalf[data.brand + '||' + hKey] || 0))}`);
  if (qKey) lines.push(`Total ${qKey.split('-')[1]}: ${fmtPct(ratio(ratioTotals.numQuarter[data.brand + '||' + qKey] || 0, ratioTotals.denQuarter[data.brand + '||' + qKey] || 0))}`);
  lines.push(`Total: ${fmtPct(totalR)}`);
  return lines.join('\n');
}

// Per Zoltraak 2026-08-19: hovering a STORE/WAREHOUSE/MARKETPLACE sub-column (whatever period
// granularity it's currently showing — month, quarter, half, or the whole visible range, i.e. both
// "level expand dan level collapse") shows this cell's value as a fraction of TWO things, on 2
// lines:
//   1. its immediate parent ("Group") at that SAME column/period — e.g. a member Official Store's
//      own Combined row (LOreal LDB -> LOreal Group Combined), or a warehouse/marketplace's own
//      brand/store total (Benoa -> LOreal CPD) — via ctx.parentData, resolved from
//      currentParentDataByKey (see renderTable/financeBodyHtml).
//   2. the overall Grand Total (`grand`, the table's rightmost column — sum of every currently
//      visible store across every currently visible month), regardless of which brand/period this
//      cell itself belongs to.
// Both lines use Math.abs (matching how `def.abs` rows like Platform Fee Absorb by SIRCLO already
// display their own magnitude, per financeBodyHtml) so a stored-as-negative deduction still reads
// as a sane, positive contribution %.
function groupContributionTooltip(label, key, data, parentData, grand, fmt) {
  if (!data || !parentData) return null;
  // 'decimal' branch added 2026-09-12 for CBM Usage (see costGroupTooltipText below) — purely
  // additive, 'int'/undefined-defaults-to-money behavior for every existing caller is unchanged.
  const fmtFn = fmt === 'int' ? fmtInt : fmt === 'decimal' ? fmtDecimal : fmtMoney;
  const val = Math.abs(data[key] || 0);
  const groupVal = Math.abs(parentData[key] || 0);
  const pct = (num, den) => (den > 0 ? (num / den * 100).toFixed(2) : '0.00');
  const lines = [`${label} Contribution:`];
  lines.push(`${fmtFn(val)} / ${fmtFn(groupVal)} (${pct(val, groupVal)}% to Group)`);
  if (grand) {
    const totalVal = Math.abs(grand[key] || 0);
    lines.push(`${fmtFn(val)} / ${fmtFn(totalVal)} (${pct(val, totalVal)}% to Total)`);
  }
  return lines.join('\n');
}

// Ratio-metric counterpart of groupContributionTooltip, for % Gross Profit / % Contribution Margin
// at store/warehouse/marketplace level — a percentage can't be expressed as a "contribution
// fraction" of another percentage the way a money/count value can, so this instead compares this
// cell's own % directly against its Group's % and the overall Total's %.
function groupRatioTooltip(label, key, data, parentData, grand) {
  if (!data || !parentData) return null;
  const lines = [`${label}:`];
  lines.push(`This: ${fmtPct(data[key] || 0)}`);
  lines.push(`Group: ${fmtPct(parentData[key] || 0)}`);
  if (grand) lines.push(`Total: ${fmtPct(grand[key] || 0)}`);
  return lines.join('\n');
}

// Order-ratio counterpart of ratioTooltipText — identical shape, except the value is a MONEY figure
// (Gross Profit per Order / Contribution Margin per Order), not a percentage, so this uses fmtMoney
// instead of ratioTooltipText's hardcoded fmtPct rather than adding an fmt branch to that existing,
// already-working function.
function orderRatioTooltipText(label, valueKey, ratioTotals, data) {
  if (!data || !ratioTotals || !data.brand || !isRealMonthKey(data.month)) return null;
  const ratio = (num, den) => (den ? (num / den) : 0);
  const hKey = monthToHalfKey(data.month);
  const qKey = monthToQuarterKey(data.month);
  const totalR = ratio(ratioTotals.numByBrand[data.brand] || 0, ratioTotals.denByBrand[data.brand] || 0);
  const lines = [`${label}:`];
  lines.push(`This Month: ${fmtMoney(data[valueKey] || 0)}`);
  if (hKey) lines.push(`Total ${hKey.split('-')[1]}: ${fmtMoney(ratio(ratioTotals.numHalf[data.brand + '||' + hKey] || 0, ratioTotals.denHalf[data.brand + '||' + hKey] || 0))}`);
  if (qKey) lines.push(`Total ${qKey.split('-')[1]}: ${fmtMoney(ratio(ratioTotals.numQuarter[data.brand + '||' + qKey] || 0, ratioTotals.denQuarter[data.brand + '||' + qKey] || 0))}`);
  lines.push(`Total: ${fmtMoney(totalR)}`);
  return lines.join('\n');
}

// Order-ratio counterpart of groupRatioTooltip — same Group/Total comparison shape, money-formatted
// instead of groupRatioTooltip's hardcoded fmtPct.
function groupOrderRatioTooltip(label, key, data, parentData, grand) {
  if (!data || !parentData) return null;
  const lines = [`${label}:`];
  lines.push(`This: ${fmtMoney(data[key] || 0)}`);
  lines.push(`Group: ${fmtMoney(parentData[key] || 0)}`);
  if (grand) lines.push(`Total: ${fmtMoney(grand[key] || 0)}`);
  return lines.join('\n');
}

// Dispatches to the month-level (real-month main column) Total/Half/Quarter tooltip or the
// store/warehouse/marketplace-level Group/Total dual-line tooltip, depending on what kind of
// column `ctx` says this cell belongs to (see financeBodyHtml, which builds ctx from `c.type`/
// c.parentKey via currentParentDataByKey). ctx is undefined/omitted for the Grand Total's own
// column and its own warehouse/store/marketplace breakdown (grandWh) — main-column month tooltip
// is attempted there too, but metricTooltipText's own `!data.brand` gate already returns null for
// Grand Total (it has no single brand), so no tooltip renders there, same as before this feature.
function uniqTooltipText(data, ctx) {
  if (!data) return null;
  ctx = ctx || {};
  if (ctx.colType === 'wh' || ctx.colType === 'store' || ctx.colType === 'mp') {
    return groupContributionTooltip('Number of Order', 'uniq', data, ctx.parentData, ctx.grand, 'int');
  }
  return metricTooltipText('Number of Order', 'uniq', data, currentUniqTooltipTotals, 'int');
}

function gpTooltipText(data, ctx) {
  if (!data) return null;
  ctx = ctx || {};
  if (ctx.colType === 'wh' || ctx.colType === 'store' || ctx.colType === 'mp') {
    return groupContributionTooltip('Gross Profit', 'gp', data, ctx.parentData, ctx.grand, 'money');
  }
  return metricTooltipText('Gross Profit', 'gp', data, currentGpTooltipTotals, 'money');
}

function pctGpTooltipText(data, ctx) {
  if (!data) return null;
  ctx = ctx || {};
  if (ctx.colType === 'wh' || ctx.colType === 'store' || ctx.colType === 'mp') {
    return groupRatioTooltip('% Gross Profit', 'pctGp', data, ctx.parentData, ctx.grand);
  }
  return ratioTooltipText('% Gross Profit', 'pctGp', currentPctGpTooltipTotals, data);
}

function cmTooltipText(data, ctx) {
  if (!data) return null;
  ctx = ctx || {};
  if (ctx.colType === 'wh' || ctx.colType === 'store' || ctx.colType === 'mp') {
    return groupContributionTooltip('Contribution Margin', 'contributionMargin', data, ctx.parentData, ctx.grand, 'money');
  }
  return metricTooltipText('Contribution Margin', 'contributionMargin', data, currentCmTooltipTotals, 'money');
}

function pctCmTooltipText(data, ctx) {
  if (!data) return null;
  ctx = ctx || {};
  if (ctx.colType === 'wh' || ctx.colType === 'store' || ctx.colType === 'mp') {
    return groupRatioTooltip('% Contribution Margin', 'pctContributionMargin', data, ctx.parentData, ctx.grand);
  }
  return ratioTooltipText('% Contribution Margin', 'pctContributionMargin', currentPctCmTooltipTotals, data);
}

// Added 2026-09-12 per Zoltraak — Gross Profit per Order's own hover tooltip, same
// dispatch-by-column-type shape as pctGpTooltipText, but via the money-formatted order-ratio
// helpers (orderRatioTooltipText/groupOrderRatioTooltip) since this is a money-per-order figure,
// not a percentage.
function gpPerOrderTooltipText(data, ctx) {
  if (!data) return null;
  ctx = ctx || {};
  if (ctx.colType === 'wh' || ctx.colType === 'store' || ctx.colType === 'mp') {
    return groupOrderRatioTooltip('Gross Profit per Order', 'gpPerOrder', data, ctx.parentData, ctx.grand);
  }
  return orderRatioTooltipText('Gross Profit per Order', 'gpPerOrder', currentGpPerOrderTooltipTotals, data);
}

// Contribution Margin per Order's own hover tooltip — same shape as gpPerOrderTooltipText above.
function cmPerOrderTooltipText(data, ctx) {
  if (!data) return null;
  ctx = ctx || {};
  if (ctx.colType === 'wh' || ctx.colType === 'store' || ctx.colType === 'mp') {
    return groupOrderRatioTooltip('Contribution Margin per Order', 'cmPerOrder', data, ctx.parentData, ctx.grand);
  }
  return orderRatioTooltipText('Contribution Margin per Order', 'cmPerOrder', currentCmPerOrderTooltipTotals, data);
}

// Pick Pack / Rent Warehouse / Consumables / Total Operational and Fulfillment Cost / Platform Fee
// Absorb by SIRCLO — store/warehouse/marketplace level ONLY, per Zoltraak 2026-08-19 ("serupa
// dengan pick pack, rent warehouse, consumables, total operational and fulfillment cost and
// platform fee"). No month-level "to Total across time" tooltip was requested for these (unlike
// Number of Order/Gross Profit/Contribution Margin above) — they're operational cost detail lines,
// not headline profitability metrics, so this returns null outside the wh/store/mp sub-column
// case, same as today (no regression at month/Grand level).
// `fmt` param (new, optional, defaults to 'money') added 2026-09-12 for CBM Usage — every existing
// call site (Pick Pack/Rent Warehouse/Consumables/Total Operational and Fulfillment Cost/Platform
// Fee Absorb by SIRCLO) omits it and keeps getting 'money', unchanged.
function costGroupTooltipText(label, key, fmt) {
  return function (data, ctx) {
    if (!data) return null;
    ctx = ctx || {};
    if (ctx.colType === 'wh' || ctx.colType === 'store' || ctx.colType === 'mp') {
      return groupContributionTooltip(label, key, data, ctx.parentData, ctx.grand, fmt || 'money');
    }
    return null;
  };
}

// Backing store for the "Number of Order" row's hover tooltip (see uniqTooltipText and the "uniq"
// row's def.cellTitle in OUTRIGHT_ROW_DEFS) — recomputed at the top of every renderTable(rows) call
// from that call's own `rows`, so it always reflects whichever Official Store/Period filters are
// currently applied. null until the first render.
let currentUniqTooltipTotals = null;
// Same backing-store pattern as currentUniqTooltipTotals above, added 2026-08-19 for Gross Profit/
// % Gross Profit/Contribution Margin/% Contribution Margin's own month-level hover tooltips (see
// gpTooltipText/pctGpTooltipText/cmTooltipText/pctCmTooltipText) — all recomputed every render.
let currentGpTooltipTotals = null;
let currentCmTooltipTotals = null;
let currentPctGpTooltipTotals = null;
let currentPctCmTooltipTotals = null;
// Added 2026-09-12 for Gross Profit per Order / Contribution Margin per Order's own hover
// tooltips (see gpPerOrderTooltipText/cmPerOrderTooltipText) — backed by computeOrderRatioTotals
// (Number of Order denominator), not computeRatioTotals (Sales of Goods + Rebates denominator).
let currentGpPerOrderTooltipTotals = null;
let currentCmPerOrderTooltipTotals = null;

// quarter key "YYYY-Q#" -> the previous quarter's key (handles year rollover: 2026-Q1 -> 2025-Q4).
function previousQuarterKey(q) {
  const mm = /^(\d{4})-Q([1-4])$/.exec(String(q));
  if (!mm) return null;
  let y = Number(mm[1]), qn = Number(mm[2]) - 1;
  if (qn < 1) { qn = 4; y -= 1; }
  return y + '-Q' + qn;
}

// half key "YYYY-H#" -> the previous half's key (handles year rollover: 2026-H1 -> 2025-H2) — added
// 2026-08-27 per Zoltraak's "% Run Rate SoG to Prev. Semester" export row (see buildExportPayload_'s
// prefix-rows section), the semester/half equivalent of previousQuarterKey above.
function previousHalfKey(h) {
  const mm = /^(\d{4})-H([12])$/.exec(String(h));
  if (!mm) return null;
  let y = Number(mm[1]), hn = Number(mm[2]) - 1;
  if (hn < 1) { hn = 2; y -= 1; }
  return y + '-H' + hn;
}

// Maps a ROW_DEFS entry's `fmt` ("money" | "int" | "pct") to the Google Sheets number-format string
// Code.gs's writeExportSheet_ applies per row (see createExportSpreadsheet in Code.gs). `pct` fields
// (pctGp, pctDisc, pctContributionMargin, ...) are already stored pre-multiplied by 100 (e.g. 45.20
// meaning "45.20%" — see fmtPct/computeGrand's own g.pctGp = (...) * 100), so the Sheets format uses
// a literal quoted "%" suffix (0.00"%") rather than Sheets' own "0.00%" percentage format, which would
// instead MULTIPLY the stored value by 100 again (45.20 -> "4520.00%") since Sheets' native percent
// format expects a 0-1 fraction, not an already-scaled number.
// 'decimal' added 2026-09-12 for CBM Usage (fractional, e.g. 116.87 — #,##0 would round it away).
const EXPORT_NUMBER_FORMAT = { money: '#,##0', int: '#,##0', pct: '0.00"%"', decimal: '#,##0.00' };

// "Per Period" column label — a plain real month key ("2026-06") is unambiguous but not very
// readable in a delivered spreadsheet, so this renders it the same way the on-screen table's own
// month columns do (monthLabel -> month name only) plus the year, since an export can in principle
// span more than one calendar year while a single on-screen month column never needs to disambiguate
// that (monthLabel alone is fine there because the row/column context already narrows it down).
function periodColumnLabel_(m) {
  const parts = String(m).split('-');
  return parts.length === 2 ? (monthLabel(m) + ' ' + parts[0]) : String(m);
}

// The 4 export sheets requested by Zoltraak ("dibagi ke beberapa sheeet per warehouse, per store,
// dan per marketplace dan per period") — each entry's getColumns(rows) turns the currently-filtered
// `rows` (real per-Official-Store/month rows, i.e. getVisibleRows()'s own output) into an ordered
// list of `{ label, data }` columns, where `data` is an object carrying the same metric fields
// ROW_DEFS' `key`s read from (sales, gp, pickPack, ...) — deliberately reusing the dashboard's own
// existing aggregation functions unchanged (computeGrand/computeGrandStores/computeGrandWarehouses/
// computeGrandMarketplaces) so every exported number is guaranteed to reconcile with what the Grand
// Total row already shows on screen for that same breakdown.
// Walks buildPeriodTree(months) (the SAME completeness-aware Half/Quarter/Month tree the on-screen
// Period filter popover and column-expand buttons already use) into the "Per Period" sheet's full
// column list PLUS the Google Sheets column-group ranges needed to collapse Quarter/Half rollups
// down to just their own total column — added 2026-08-26 per Zoltraak ("tambahkan kolom Q1 Q2 dan
// H1... dan feature expand collapse pada spreadsheet"). Unlike the dashboard's own buildPeriodSequence
// (STATE-driven — only the currently-expanded quarter/half's months are included at all), a
// spreadsheet export has no interactive state, so this always includes EVERY level at once (every
// real month AND its complete Quarter AND that Quarter's complete Half) and lets Sheets' native
// outline/grouping controls do the expand/collapse instead — Code.gs's applyExportColumnGroups_
// turns each `columnGroups` entry into one shiftColumnGroupDepth() call, collapsed by default so a
// freshly opened export looks exactly as tidy as the dashboard's own default (collapsed) view.
//
// A group's range DELIBERATELY excludes the parent Quarter/Half's own total column — e.g. Q1's
// group spans only [January, February, March], NOT [January, February, March, Q1] — because
// Code.gs sets the column-group control position to AFTER (see applyExportColumnGroups_), meaning
// the +/- toggle renders in the column immediately following the collapsed range. Since Q1's own
// total column sits immediately after its 3 months, collapsing that group hides only the 3 months
// and leaves Q1 itself (hosting the toggle) fully visible — mirroring the dashboard's own "+M"/"-M"
// button sitting directly on the Quarter's own column. A Half's group then wraps its ENTIRE
// [Jan..Q2] span (including the already-nested Quarter groups and their own total columns) at one
// shallower depth, so collapsing H1 hides everything down to just the H1 column itself, regardless
// of whether the inner Quarter groups are separately expanded — exactly how expanding a dashboard
// Half reveals its Quarters, which independently still default to collapsed.
function buildExportPeriodColumns_(months) {
  // buildPeriodTree sorts years NEWEST-first (built for the Period filter popover) — reversed here
  // for the export's conventional oldest-to-newest column order (matches the pre-existing plain
  // `months.sort()` order this replaces).
  const tree = buildPeriodTree(months).slice().reverse();
  const columns = [];
  // {startIdx, endIdx, depth} — 0-based indices into `columns` above; buildExportPayload_ converts
  // these to real 1-based Sheets column numbers (+2, since column A is the row-label column) right
  // before sending the payload to Code.gs.
  const columnGroups = [];
  function periodTotalLabel(node) {
    const parts = String(node.key).split('-'); // "2026-Q1" -> ["2026","Q1"], "2026-H1" -> ["2026","H1"]
    return parts[1] + ' ' + parts[0]; // "Q1 2026" / "H1 2026"
  }
  function walk(node, depth) {
    if (node.type === 'month') {
      columns.push({ label: periodColumnLabel_(node.key), months: node.months });
      return;
    }
    const startIdx = columns.length;
    node.children.forEach(child => walk(child, depth + 1));
    columnGroups.push({ startIdx: startIdx, endIdx: columns.length - 1, depth: depth });
    columns.push({ label: periodTotalLabel(node), months: node.months });
  }
  tree.forEach(y => y.nodes.forEach(node => walk(node, 1)));
  // Grand Total — added 2026-08-26 per Zoltraak ("tolong tambahkan kolom grand total"), this
  // export's own rightmost column, aggregating the ENTIRE exported period regardless of which
  // Quarter/Half rollups exist above — mirrors the on-screen dashboard's own convention that
  // "Grand Total is always the table's rightmost column" (see financeHeadHtml's grand-col). Pushed
  // AFTER every columnGroups entry above is already finalized, so its index never falls inside any
  // Quarter/Half outline group and it always stays visible even when every rollup is collapsed.
  columns.push({ label: 'Grand Total', months: months.slice() });
  return { columns: columns, columnGroups: columnGroups };
}

// Per-store breakdown for the "Per Period" sheet's per-row expand/collapse feature — per Zoltraak
// 2026-08-26: "tolong tambahkan breakdown per store untuk setiap line yang ditambahkan feature per
// store... karena feature expand per warehouse dan per marketplace di buat masing-masing tab sheet
// terpisah" (Per Official Store/Warehouse/Marketplace already ARE their own dedicated sheets, so
// only Per Period — which has no entity breakdown at all today — needs this added). Mirrors the
// dashboard's own computeMetricBreakdownRows_(rowKey, 'store', ...): one row per real Official
// Store touched by ANY of `rows`, sorted by that store's own total contribution to `rowKey` (biggest
// first, matching Zoltraak's original "1st row based on the bigger contribution" rule), with one
// value per `periodColumns` entry (real month OR Quarter/Half rollup — `col.months` from
// buildExportPeriodColumns_ says which real month(s) that column covers). `null` (not 0) wherever a
// store had no data at all in that column's month(s) — buildExportPayload_ writes that as a plain 0
// in the sheet (spreadsheets don't have the dashboard's "—" dash convention), so this really just
// mirrors the dashboard helper's own contract as closely as possible for anyone reading both side by
// side.
// GENERALIZED 2026-08-26 per Zoltraak's follow-up request for the same per-row breakdown feature
// on "Per Period per Warehouse"/"Per Period per Marketplace" (previously this only ever handled
// Official Store, hardcoded to computeGrandStores/`.brand`) — `aggregatorFn` is whichever of
// computeGrandStores/computeGrandWarehouses/computeGrandMarketplaces matches this sheet's own
// dimension, and `labelField` is that aggregator's own name field ('brand'/'warehouse'/
// 'marketplace'). Behavior is otherwise unchanged from the original store-only version: one row
// per real entity touched by ANY of `rows`, sorted by that entity's own total contribution to
// `rowKey` (biggest first), one value per `periodColumns` entry — `null` (not 0) wherever an
// entity had no data at all in that column's month(s). Since `periodColumns` now always ends with
// buildExportPeriodColumns_'s own appended "Grand Total" column (months = the full exported
// period), that column's value naturally equals the same entity's `overall` total computed above —
// no extra special-casing needed for it here.
function computeExportEntityBreakdown_(rowKey, rows, periodColumns, aggregatorFn, labelField) {
  // Sort ALWAYS by 'sales' (Sales of Goods), never by the row's OWN `rowKey` — added 2026-08-27 per
  // Zoltraak ("urutan breakdown masing-masing tab sheet untuk line sales of goods, gross profit dan
  // line lain yang serupa ... tolong urutkan sesuai SoG dengan value terbesar, agar masing-masing
  // line menampilkan urutan store atau marketplace atau warehouse dengan konsisten dari terbesar ke
  // terkecil"). Before this fix, each breakdown row picked its OWN metric's biggest-first order
  // (e.g. Gross Profit's own breakdown sorted by gp, Number of Order's by uniq, ...), so the same
  // entity could land in a different row position on every metric within the same sheet — every
  // aggregatorFn (computeGrandStores/Warehouses/Marketplaces) already returns its own list
  // pre-sorted by sales descending, so this used to silently UNDO that consistency by re-sorting on
  // whatever `rowKey` this particular call happened to be for.
  const overall = aggregatorFn(rows).slice().sort((a, b) => (b.sales || 0) - (a.sales || 0));
  const perColumnEntities = periodColumns.map(c => aggregatorFn(rows.filter(r => c.months.includes(r.month))));
  return overall.map(e => ({
    label: e[labelField],
    values: perColumnEntities.map(list => {
      const item = list.find(x => x[labelField] === e[labelField]);
      return item ? item[rowKey] : null;
    }),
  }));
}

// Kept as a thin named wrapper (rather than inlined at each EXPORT_DIMENSIONS call site) since it's
// referenced directly by name in this session's existing export_period_store_test.js regression
// test. UPDATED 2026-09-16 per Zoltraak: now uses computeExportGrandStores_ (one-level-only
// flatten, see its own comment) instead of calling computeGrandStores directly, so a nested
// group-of-groups selection like "LOreal Group" breaks down by its own direct divisions
// (LOreal CPD/LDB/LLD/PPD) rather than recursing all the way to individual real stores — the
// output SHAPE (one {label, values} entry per entity) is unchanged, only which entities show up
// for a nested-group export differs, so the existing regression test's structural assertions still
// hold; only a test that hardcodes real-store names for a nested-group fixture would need updating.
function computeExportStoreBreakdown_(rowKey, rows, periodColumns) {
  return computeExportEntityBreakdown_(rowKey, rows, periodColumns, computeExportGrandStores_, 'brand');
}

// Per-period entity COLUMN breakdown — added 2026-08-28 per Zoltraak: "since we have 3 spreadsheet
// belong its own category (store, warehouse, marketplace), please add column breakdown following its
// tab sheet... January 2026, Betadine Official Store, Betadine Store, February 2026, ...". Mirrors
// the dashboard's own +S/+W/+M column-expand feature (which only ever exists on-screen, never in the
// export, until now): inserts real per-entity sub-columns directly after EVERY period column in
// `built.columns` (real month, Quarter/Half rollup, AND Grand Total), each carrying that entity's own
// already-derived metric object as `.data` (so every downstream ROW_DEFS row picks it up for free via
// the existing `c.data[def.key]` read — no separate per-row wiring needed). Collapsed by default via
// Sheets' own column outline groups (Code.gs's applyExportColumnGroups_), same mechanism the existing
// Quarter/Half rollup groups already use, just one level deeper.
//
// `gateFn(rows)` decides whether this dimension gets column breakdown AT ALL for this export:
//   - Official Store (see the "Per Period per Store" EXPORT_DIMENSIONS entry below): gated on
//     `computeGrandStores(rows).length > 1` — the SAME "more than one real store selected, or a
//     combined/Group checkbox" gate the sheet's existing ROW-breakdown feature already uses, per
//     Zoltraak: "this will only apply if we select more than 1 store or select store combination."
//   - Warehouse/Marketplace (buildPerPeriodEntitySheet_ below): gate is always true — per Zoltraak,
//     "we dont have to see how many store selected, it can works as well when we select 1 store
//     only, since 1 store able to have more than warehouse or more than marketplace."
// Independently of that sheet-level gate, each individual period column only actually gets entity
// sub-columns if THAT column's own entity list has more than one entry (e.g. a month where only one
// warehouse had any activity gets no sub-columns for that specific month) — showing a "breakdown" of
// exactly one identical sub-column would just be a redundant duplicate of the main column.
//
// Returns `origToNewIdx`: built.columns[i] (the ORIGINAL, pre-breakdown column list) now lives at
// columns[origToNewIdx[i]] in the returned, longer list — buildExportPayload_ uses this to remap the
// EXISTING row-breakdown feature's own per-column value arrays (built against the original, shorter
// column list) onto the new column count without recomputing them.
//
// Column-group depth: Code.gs's applyExportColumnGroups_ retrieves each group back via
// `sheet.getColumnGroup(start, depth)` to collapse it, and Sheets' own outline model tracks a
// SEPARATE nested group object per actual nesting level — so `depth` here isn't just a sort key, it
// MUST equal the REAL number of groups (from the combined period + entity list) that end up covering
// a given range once every shallower group has already been applied. A leaf month has period-depth 0
// (no rollup at all), 1 (inside a "floating" quarter whose own half is incomplete), or 2 (inside a
// quarter that's nested inside a complete half — covered by both groups); a Quarter/Half's own TOTAL
// column has period-depth 1 only when a wider complete Half covers it too, else 0; Grand Total always
// has period-depth 0. `periodDepthAt_` below counts exactly that (how many of `built.columnGroups`'
// existing ranges include this original column index) — entity sub-columns then always sit ONE level
// deeper than whatever period-rollup depth already applies to their own parent column.
function periodDepthAt_(origIdx, periodGroups) {
  let d = 0;
  (periodGroups || []).forEach(g => { if (origIdx >= g.startIdx && origIdx <= g.endIdx) d += 1; });
  return d;
}
function withEntityColumnBreakdown_(built, rows, aggregatorFn, labelField, gateFn) {
  const identity = built.columns.map((_, i) => i);
  if (!gateFn(rows)) {
    return { columns: built.columns, columnGroups: built.columnGroups, origToNewIdx: identity };
  }
  // Computed once per original column (not once per original column PER downstream use) — reused
  // below both when deciding whether to add sub-columns and when remapping the existing Quarter/Half
  // groups' own end boundaries.
  const entityLists = built.columns.map(c => aggregatorFn(rows.filter(r => c.months.includes(r.month))));
  const columns = [];
  const origToNewIdx = [];
  const entityColumnGroups = [];
  // ownGroupDepthByTotalColIdx: for a column that is itself a period's OWN total column (e.g. the
  // "Q1 2026" column, sitting one slot past that period's own group range — see
  // buildExportPeriodColumns_'s own comment on why a period's group deliberately stops short of its
  // own total column, so the +/- toggle lands ON that total column), maps that column's original
  // index to the group.depth of the period group it's the total of. Used just below.
  const ownGroupDepthByTotalColIdx = {};
  (built.columnGroups || []).forEach(g => { ownGroupDepthByTotalColIdx[g.endIdx + 1] = g.depth; });
  built.columns.forEach((c, origIdx) => {
    const newStart = columns.length;
    columns.push(c);
    origToNewIdx.push(newStart);
    const entities = entityLists[origIdx];
    // A period column with exactly ONE entity gets no entity sub-columns (see the length check just below). Remember which
    // entity that was, so the per-entity formulas that walk several period columns (entityCellIdx_ in buildExportPayload_:
    // quarter/half roll-up sums, % Move, % Run Rate) can use that period column's own figure for that entity instead of
    // treating the period as "entity absent" — which silently dropped e.g. April and May from a "KLOG Benoa" Q2 total.
    if (entities.length === 1) c.soleEntityLabel = entities[0][labelField];
    if (entities.length > 1) {
      entities.forEach(e => columns.push({ label: e[labelField], months: c.months, data: e, isEntityBreakdown: true }));
      // FIXED 2026-08-31 (third round) per Zoltraak ("please readjust the grouping area at colomn
      // Q2 2026 section, it is also taking detail of Q1 2026 along with the group, please exclude
      // that colomn from group Q2 2026 and let those colomns has their own grouping ungrouping
      // button"). Root cause (found via a full manual column-by-column depth re-trace): when
      // `origIdx` is itself a period's OWN TOTAL column (e.g. "Q1 2026"), `periodDepthAt_(origIdx,
      // built.columnGroups)` only counts ANCESTOR groups — it can never see that Q1's own group
      // range deliberately stops one column SHORT of the Q1 total column itself (see
      // buildExportPeriodColumns_'s own comment), so this total column's own entity-breakdown group
      // used to be computed at `ancestorDepth + 1`, systematically UNDERCOUNTING by exactly 1
      // relative to where Q1's own group actually sits. That made Q1-total's-own-entity-breakdown
      // group land at the SAME numeric depth as the immediately-following sibling period's whole
      // group (e.g. Q2 2026's own group) — two column-adjacent groups at equal depth with no
      // shallower separating column between them, which Google Sheets silently merges into ONE
      // outline group, so collapsing "Q2 2026" also swept up Q1's leftover entity columns.
      //
      // REWORKED 2026-09-02 after Zoltraak hit a live export crash ("A column group does not exist
      // with index 28 and group depth 2") through TWO rounds of attempted fixes on the Code.gs side
      // (a `shiftDelta` field telling applyExportColumnGroups_ to call shiftColumnGroupDepth(1)
      // multiple times for one group entry — first as one call with delta 2, then as a loop with a
      // fresh Range + flush() each iteration). Both attempts left Code.gs depending on THIS file
      // sending a new `shiftDelta` field it never used to send — a real risk for exactly this kind
      // of bug, since Code.gs and Dashboard.html are two separate files pasted into the Apps Script
      // project independently, and a partial redeploy (only one of the two actually updated) would
      // silently reproduce the identical original crash no matter how correct the OTHER file's fix
      // was. Removed that cross-file coupling entirely: instead of one group entry that needs
      // special multi-step handling, a period-total column's own entity breakdown that must nest
      // MORE than one level below its ancestors now pushes ONE ORDINARY entry PER depth level it
      // needs to pass through (ancestorDepth+1, ancestorDepth+2, ... up to its real depth) — the
      // exact same shape every other already-working nested group in this array uses (e.g. a real
      // month's own entity breakdown nested under its Quarter nested under its Half is already 3
      // separate entries here, each one plain `depth`, no special field). Code.gs's
      // applyExportColumnGroups_ is reverted to its original simple form (one plain
      // shiftColumnGroupDepth(1) per entry, sorted by depth ascending) — it no longer needs to know
      // anything about this case at all, which is what removes the cross-file dependency.
      const ancestorDepth = periodDepthAt_(origIdx, built.columnGroups);
      const ownGroupDepth = ownGroupDepthByTotalColIdx[origIdx];
      const depth = (ownGroupDepth !== undefined ? ownGroupDepth : ancestorDepth) + 1;
      for (let d = ancestorDepth + 1; d <= depth; d++) {
        entityColumnGroups.push({ startIdx: newStart + 1, endIdx: columns.length - 1, depth: d });
      }
    }
  });
  // Existing Quarter/Half column groups use 0-based indices into the OLD, un-extended `built.columns`
  // — remapped onto the new, longer `columns` array here. A group's `endIdx` must extend through the
  // END of whatever entity sub-columns got added after the LAST original column in its range (not
  // just that column's own new position), so collapsing e.g. Q1 still hides its months' own entity
  // breakdowns too, not just the bare month columns.
  const remappedPeriodGroups = (built.columnGroups || []).map(g => {
    const endEntities = entityLists[g.endIdx];
    const newEnd = origToNewIdx[g.endIdx] + (endEntities.length > 1 ? endEntities.length : 0);
    return { startIdx: origToNewIdx[g.startIdx], endIdx: newEnd, depth: g.depth };
  });
  return { columns: columns, columnGroups: remappedPeriodGroups.concat(entityColumnGroups), origToNewIdx: origToNewIdx };
}

// Builds one "Per Period per <dimension>" sheet definition: period columns (real months + Q1/Q2/
// H1 rollups + a trailing Grand Total column, via buildExportPeriodColumns_) with per-<dimension>
// breakdown rows under each METRIC_BREAKDOWN_ROW_KEYS row — the same shape "Per Period" (Official
// Store) already has, generalized 2026-08-26 per Zoltraak's follow-up ("tab sheet per period per
// marketplace masih belum dibuat... Format per Warehouse tolong samakan seperti format per period
// per store dan format per period per marketplace"). `aggregatorFn`/`labelField` select the
// dimension (computeGrandWarehouses/'warehouse', computeGrandMarketplaces/'marketplace') the same
// way computeExportEntityBreakdown_ does. If `aggregatorFn(rows)` is completely empty — e.g.
// Marketplace on an Outright-tab-only brand, which never carries a `.marketplaces` breakdown at
// all — this returns zero columns so buildExportPayload_ drops the sheet entirely, exactly
// mirroring the plain "Per Marketplace" sheet's own existing empty-dimension suppression below;
// unlike that gate, having exactly ONE entity still produces a sheet (period totals, just with no
// breakdown rows — rowBreakdown itself stays gated on length > 1, same reasoning as the Official
// Store version).
function buildPerPeriodEntitySheet_(rows, aggregatorFn, labelField) {
  if (!aggregatorFn(rows).length) return { columns: [], columnGroups: [], rowBreakdown: null, showPctOfSales: false };
  const months = Array.from(new Set(rows.map(r => r.month).filter(isRealMonthKey))).sort();
  const built = buildExportPeriodColumns_(months);
  const columns = built.columns.map(c => ({ label: c.label, months: c.months, data: computeGrand(rows.filter(r => c.months.includes(r.month))) }));
  const rowBreakdown = aggregatorFn(rows).length > 1
    ? (rowKey) => computeExportEntityBreakdown_(rowKey, rows, columns, aggregatorFn, labelField)
    : null;
  // Per-period entity COLUMN breakdown — added 2026-08-28 per Zoltraak, point 6: unlike the Store
  // sheet below, there's NO "more than one selected" gate at the sheet level here (a single store can
  // still span more than one warehouse/marketplace) — `() => true` always attempts it, and the only
  // real gate is per-column, inside withEntityColumnBreakdown_ itself (skips a period column entirely
  // when it has <= 1 entity that period).
  const withBreakdown = withEntityColumnBreakdown_(
    { columns: columns, columnGroups: built.columnGroups },
    rows, aggregatorFn, labelField,
    () => true
  );
  // showPctOfSales: true — see buildExportPayload_'s own comment on the "% of Sales of Goods" row;
  // both "Per Period per Warehouse" and "Per Period per Marketplace" go through this same builder.
  return {
    columns: withBreakdown.columns,
    columnGroups: withBreakdown.columnGroups,
    rowBreakdown: rowBreakdown,
    origToNewIdx: withBreakdown.origToNewIdx,
    showPctOfSales: true,
  };
}

// The 3 export sheets — REVISED 2026-08-26 per Zoltraak: originally 4 flat aggregate sheets (one
// per dimension); the Official Store/Warehouse/Marketplace dimensions each additionally got a
// "Per Period per <dimension>" sheet (period columns + that dimension's own row breakdown, see
// buildPerPeriodEntitySheet_ above) alongside their original flat aggregate sheet — "jd kita punya
// 2 sheet warehouse" (and, by the same logic, 2 marketplace sheets) was the deliberate result at
// the time, not a duplicate left in by mistake. REVISED AGAIN 2026-08-27 per Zoltraak ("now we can
// take out tab sheet per official store, per warehouse, per marketplace") — with the 3 "Per Period
// per <dimension>" sheets now covering period columns + Grand Total + full entity breakdown (and,
// as of the same date, per-category value rows for Rebates/Other Revenue/COGS/Surplus/MOGTM
// Distributor Fee/Promo Fund Front/Back Margin too — see EXPORT_VALUE_ONLY_BREAKDOWN_KEYS), the 3
// original flat sheets (Per Official Store/Per Warehouse/Per Marketplace) no longer add anything
// the 3 "Per Period per <dimension>" sheets don't already show, so they're removed here entirely —
// their own getColumns()/computeGrandStores()/computeGrandWarehouses()/computeGrandMarketplaces()
// call sites stay (still used BY the 3 remaining sheets' own row-breakdown machinery), only the
// EXPORT_DIMENSIONS entries that turned them into their OWN standalone sheets are gone.
const EXPORT_DIMENSIONS = [
  {
    // Renamed 2026-08-27 per Zoltraak ("tolong rename sheet per period menjadi Per Period Per
    // Store") — matches the "Per Period per Warehouse"/"Per Period per Marketplace" naming
    // convention below; no other code references this literal string (only comments), so this is
    // a safe rename.
    sheetName: 'Per Period per Store',
    // Not one of the generic computeGrand* helpers (there's no "computeGrandPeriods") — built
    // in-line instead: computeGrand() re-run against just each column's own month(s), mirroring
    // exactly how Grand Total itself is computed for the whole filtered set, just scoped down.
    // columnGroups/rowBreakdown (both added 2026-08-26) are this sheet's own extras — every other
    // dimension below leaves them at the default empty/null (see buildExportPayload_).
    getColumns: (rows) => {
      const months = Array.from(new Set(rows.map(r => r.month).filter(isRealMonthKey))).sort();
      const built = buildExportPeriodColumns_(months);
      const columns = built.columns.map(c => ({ label: c.label, months: c.months, data: computeGrand(rows.filter(r => c.months.includes(r.month))) }));
      // Only meaningful when the exported selection actually contains more than one real Official
      // Store (a combined/Group checkbox) — a lone standalone store's own breakdown would just be
      // one redundant row repeating the parent metric row's own figures, same gate the dashboard's
      // officialStoreBreakdownAvailable_() gives the +S button.
      // Uses computeExportGrandStores_ (not computeGrandStores directly) as of 2026-09-16 — see its
      // own comment: a nested group-of-groups selection like "LOreal Group" now breaks down by its
      // own direct divisions (LOreal CPD/LDB/LLD/PPD) here, not all the way to individual real
      // stores. The on-screen +S toggle is untouched (still calls computeGrandStores(rows) alone).
      const rowBreakdown = computeExportGrandStores_(rows).length > 1
        ? (rowKey) => computeExportStoreBreakdown_(rowKey, rows, columns)
        : null;
      // Per-period entity COLUMN breakdown — added 2026-08-28 per Zoltraak: "This will only apply if
      // we select more than 1 store or select store combination" — the exact same gate as
      // rowBreakdown's own just above.
      const withBreakdown = withEntityColumnBreakdown_(
        { columns: columns, columnGroups: built.columnGroups },
        rows, computeExportGrandStores_, 'brand',
        (r) => computeExportGrandStores_(r).length > 1
      );
      // showPctOfSales: true — see buildExportPayload_'s own comment on the "% of Sales of Goods"
      // row, added 2026-08-26 per Zoltraak, scoped to just this sheet + its 2 "Per Period per
      // <dimension>" siblings below (not the plain Per Official Store/Warehouse/Marketplace sheets).
      return {
        columns: withBreakdown.columns,
        columnGroups: withBreakdown.columnGroups,
        rowBreakdown: rowBreakdown,
        origToNewIdx: withBreakdown.origToNewIdx,
        showPctOfSales: true,
      };
    },
  },
  {
    sheetName: 'Per Period per Warehouse',
    getColumns: (rows) => buildPerPeriodEntitySheet_(rows, computeGrandWarehouseGroups, 'warehouse'),
  },
  {
    sheetName: 'Per Period per Marketplace',
    getColumns: (rows) => buildPerPeriodEntitySheet_(rows, computeGrandMarketplaces, 'marketplace'),
  },
];

// Derives the export filename's "Official Store Name" segment (see Code.gs's createExportSpreadsheet
// / nextExportVersion_ for the full "<year> - FSOP - <storeLabel> Version <N>" template) from
// whichever Official Store(s) are actually present in the exported rows — used LITERALLY, whatever
// the checked checkbox's own name is: a single real store names itself directly ("Betadine Store"),
// and a combined/virtual group row's own internal name is used unchanged too ("Betadine Group" —
// per Zoltraak 2026-08-21, explicitly confirmed NOT to be relabeled to any "Combined" alias, reversing
// an earlier same-day version of this function that did rename it). Per Zoltraak: "the spreadsheet
// generated based on official store selected. can be combined official store or stand alone official
// store" — i.e. this only ever needs to handle exactly one selected brand at a time (a real store OR
// the one combined/group row for it, never several at once, since checking a virtual group's
// checkbox and any of its real members' checkboxes are already mutually exclusive — see toggle()'s
// own comment). Multiple simultaneously-selected brands is kept as a graceful fallback rather than a
// hard error, joining each one's own name with " & ".
function exportStoreLabel_(rows) {
  const brands = Array.from(new Set(rows.map(r => r.brand))).sort();
  if (brands.length === 0) return 'All Stores';
  return brands.join(' & ');
}

// The Google Sheets export ALWAYS covers the store's entire available period, independent of the
// sidebar's own Period filter — per Zoltraak 2026-08-21: "the spreadsheet generated always full
// period, not based on filter period." getVisibleRows() (used by every on-screen table) filters by
// BOTH state.store AND state.month; this only filters by state.store, so unchecking months in the
// Period filter (which only ever affects what's visible ON SCREEN) has no effect on what gets
// exported. DATA already contains one row per real brand/month PLUS the precomputed combined/virtual
// group rows (see computeVirtualRows(DATA).forEach(r => DATA.push(r)) near this file's top) — so
// checking a single Official Store or a single combined "... Group" checkbox in the sidebar is all
// that's needed to select what this exports; no separate "which months" decision applies here.
function getExportRows_() {
  return DATA.filter(r => state.store[r.brand]);
}

// Converts a 1-based column NUMBER (3 -> the first data column, since column 1/"A" is always the
// row-label column and column 2/"B" is a deliberately blank, very-thin spacer column — see
// writeExportSheet_'s DATA_COL_ in Code.gs, added 2026-08-31 per Zoltraak's blank-column request)
// into its Sheets column LETTER ("C", "D", ..., "Z", "AA", ...) — needed to build A1-notation cell
// references for EXPORT_FORMULA_ROWS below.
function columnLetter_(n) {
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Live Google Sheets FORMULAS for specific rows — per Zoltraak 2026-08-21: "bisa aktifkan formula
// setiap sheet untuk line Average Order Value, Average Basket Size, Gross Profit, % Gross Profit,
// Total Operational and Fulfillment Cost, Contribution Margin, % Contribution Margin?" Every other
// row in the export stays a plain computed NUMBER (as before); these 7 keys instead get a real
// formula string referencing their OWN sibling rows in the SAME column of the SAME sheet — so the
// spreadsheet recalculates them live (e.g. editing a raw Sales of Goods cell by hand immediately
// updates Gross Profit / % Gross Profit / Contribution Margin below it), the same relationship
// OUTRIGHT_ROW_DEFS' own `formula` field already documents for the on-screen tooltip, just made
// literally computable here instead of just descriptive text.
//
// Each generator receives (col, rowOf) — `col` is this cell's own column LETTER, `rowOf` is a
// {key: sheetRowNumber} map (see buildExportPayload_) — and returns either an "="-prefixed formula
// string or `null` if a dependency row isn't present in the current ROW_DEFS set (defensive: this
// dashboard only ever uses OUTRIGHT_ROW_DEFS, where every key below always exists, but a null
// fallback means buildExportPayload_ can safely leave the plain computed number in place instead of
// ever writing a broken formula referencing a nonexistent row).
//
// IFERROR(...,0) matches this file's own JS division-by-zero convention exactly (e.g. deriveMetrics'
// `r.pctGp = (r.sales + r.claim) ? (...) : 0` — a zero denominator reads as 0, not an error/blank).
const EXPORT_FORMULA_ROWS = {
  aov: (col, rowOf) => (rowOf.sales && rowOf.uniq) ? `=IFERROR(${col}${rowOf.sales}/${col}${rowOf.uniq},0)` : null,
  // Average Basket Size = Quantity / Number of Order (changed from Sales of Goods / Quantity; Excel export only).
  abs: (col, rowOf) => (rowOf.qty && rowOf.uniq) ? `=IFERROR(${col}${rowOf.qty}/${col}${rowOf.uniq},0)` : null,
  // Mirrors deriveMetrics'/computeGrand's own gp formula exactly (Promo Fund Front/Back Margin
  // subtracted per Zoltraak's 2026-08-20 revision, Surplus subtracted per the 2026-08-26 revision
  // ("sebagai pengurang seperti promo fund"), Other Revenue ADDED per Zoltraak's same-day second
  // revision — see this file's OUTRIGHT_ROW_DEFS `gp` entry). Term order matches the row order
  // Zoltraak specified (Sales of Goods, Rebates, Other Revenue, COGS, Surplus, MOGTM Distributor
  // Fee, Promo Fund Front Margin, Promo Fund Back Margin).
  gp: (col, rowOf) => (rowOf.sales && rowOf.claim && rowOf.otherRevenue && rowOf.rbp && rowOf.surplus && rowOf.mogtmFee && rowOf.promoFundFrontMargin && rowOf.promoFundBackMargin)
    ? `=${col}${rowOf.sales}+${col}${rowOf.claim}+${col}${rowOf.otherRevenue}-${col}${rowOf.rbp}-${col}${rowOf.surplus}-${col}${rowOf.mogtmFee}-${col}${rowOf.promoFundFrontMargin}-${col}${rowOf.promoFundBackMargin}`
    : null,
  pctGp: (col, rowOf) => (rowOf.gp && rowOf.sales && rowOf.claim)
    ? `=IFERROR(${col}${rowOf.gp}/(${col}${rowOf.sales}+${col}${rowOf.claim})*100,0)`
    : null,
  // Gross Profit per Order — added 2026-09-12 per Zoltraak: Gross Profit ÷ Number of Order, both
  // already live formula/plain-number cells in this same sheet's own Gross Profit / Number of
  // Order rows, so this just references them the same way aov/pctGp above reference theirs.
  gpPerOrder: (col, rowOf) => (rowOf.gp && rowOf.uniq)
    ? `=IFERROR(${col}${rowOf.gp}/${col}${rowOf.uniq},0)`
    : null,
  // "% Discount" — added 2026-08-27 per Zoltraak ("line % Discount activated the formula"): was
  // previously exported as a plain computed number (no entry here at all) even though every other
  // row that CAN be a live formula already is one. Mirrors deriveMetrics'/computeGrand's own
  // r.pctDisc = (r.sales + r.claim) ? (r.claim / (r.sales + r.claim)) * 100 : 0 — same "Rebates /
  // (Sales of Goods + Rebates)" shape as ROW_DEFS' own `pctDisc` formula text.
  pctDisc: (col, rowOf) => (rowOf.claim && rowOf.sales)
    ? `=IFERROR(${col}${rowOf.claim}/(${col}${rowOf.sales}+${col}${rowOf.claim})*100,0)`
    : null,
  // absorbBySirclo's own exported cell is already the positive magnitude (def.abs converts it before
  // this generator ever runs — see buildExportPayload_), so no extra ABS() is needed here to match
  // deriveMetrics' `Math.abs(r.absorbBySirclo || 0)`.
  totalOpCost: (col, rowOf) => (rowOf.pickPack && rowOf.rentWarehouse && rowOf.consumables && rowOf.absorbBySirclo)
    ? `=${col}${rowOf.pickPack}+${col}${rowOf.rentWarehouse}+${col}${rowOf.consumables}+${col}${rowOf.absorbBySirclo}`
    : null,
  contributionMargin: (col, rowOf) => (rowOf.gp && rowOf.totalOpCost) ? `=${col}${rowOf.gp}-${col}${rowOf.totalOpCost}` : null,
  pctContributionMargin: (col, rowOf) => (rowOf.contributionMargin && rowOf.sales && rowOf.claim)
    ? `=IFERROR(${col}${rowOf.contributionMargin}/(${col}${rowOf.sales}+${col}${rowOf.claim})*100,0)`
    : null,
  // Contribution Margin per Order — added 2026-09-12 per Zoltraak, same shape as gpPerOrder above.
  cmPerOrder: (col, rowOf) => (rowOf.contributionMargin && rowOf.uniq)
    ? `=IFERROR(${col}${rowOf.contributionMargin}/${col}${rowOf.uniq},0)`
    : null,
};

// Live formula for the per-entity BREAKDOWN rows (not just the main metric row) of Gross Profit,
// % Gross Profit, Gross Profit per Order, Contribution Margin, % Contribution Margin, and
// Contribution Margin per Order — added 2026-09-23 per Zoltraak, ported from the Unilever Group
// fork (google-sheets-dashboard skill). Total Operational and Fulfillment Cost is deliberately
// NOT included here (stays a plain number in its own breakdown rows) — it's only a DEPENDENCY that
// Contribution Margin's own live formula below references. See buildExportPayload_'s new post-pass
// (right after the existing EXPORT_FORMULA_ROWS post-pass) for how this is used: each of these 6
// keys' per-entity breakdown rows gets EXPORT_FORMULA_ROWS[key] re-run with an entity-scoped
// `rowOf` (component row numbers belonging to THAT SAME entity, not the combined metric row).
// aov/abs ADDED 2026-10-20: each entity's Average Order Value = that entity's Sales of Goods / Number of Order, Average Basket Size = that
// entity's Quantity / Number of Order (EXPORT_FORMULA_ROWS.aov/abs re-run on that entity's own rows).
const LIVE_FORMULA_BREAKDOWN_KEYS = ['aov', 'abs', 'gp', 'pctGp', 'gpPerOrder', 'contributionMargin', 'pctContributionMargin', 'cmPerOrder'];

// ROW_DEFS keys that want the export's plain "% Cont. to SoG" row even though their OWN cellNote
// isn't a pctOfSalesNote_-tagged function — see buildExportPayload_'s own `plainPctSource` comment.
// Currently just MOGTM Distributor Fee, added 2026-08-27 per Zoltraak ("tambahkan % Cont. to SoG
// pada line MOGTM Distribution Fee juga") — its own on-screen cellNote (effectiveMogtmRate-based,
// a derived RATE, not a share of Sales of Goods) is a completely different, unrelated feature and
// stays untouched; this array only extends which rows the EXPORT additionally covers.
const EXPORT_PLAIN_PCT_CONT_EXTRA_KEYS = ['mogtmFee'];

// "% Cont." base for Total Operational and Fulfillment Cost and its components — REVISED 2026-10-14
// per Zoltraak: the "% Cont." rows under these lines no longer divide by Sales of Goods alone, they
// divide by SoG + Rebates + the DETAIL rows of "Claim based on Sell Out" (Claim 10% COGS, Additional
// Budget Promo, Claim Vouchers) and "Claim based on Sell in" (Claim STTI, Visibility, Service Fee,
// Monthly Incentives, Quarterly Incentives) + Other Revenue. (The two label-only divider rows
// "Claim based on Sell Out"/"Claim based on Sell in" themselves hold no values, so they are NOT part
// of the base — their detail rows are.)
// EXPORT_PCT_OF_BASE_ROW_KEYS = which ROW_DEFS rows get the wider base (Platform Fee Absorb by
// SIRCLO, Pick Pack, Consumables, Rent Warehouse, Total Operational and Fulfillment Cost — every other
// "% Cont." row, e.g. Rebates/COGS/Surplus/MOGTM, is unchanged and still divides by Sales of Goods).
// EXPORT_PCT_BASE_KEYS = the ROW_DEFS keys whose sheet rows are summed into that base. The formula is
// built from rowNumberByKey (the sheet's own row numbers, resolved per sheet), never from hardcoded
// row numbers, so it stays correct on every sheet/breakdown layout. Written as SUM(...) rather than
// "a+b+c" so a blank or text cell is simply ignored instead of raising #VALUE!.
// EXPORT_PCT_BASE_LABEL = the row label shown for these "% Cont." rows (the leading spaces/"%" shape
// is the same as every other "% Cont." row; only the wording after it changes).
// To change which rows make up the base, edit EXPORT_PCT_BASE_KEYS only — nothing else needs touching.
const EXPORT_PCT_OF_BASE_ROW_KEYS = ['absorbBySirclo', 'pickPack', 'consumables', 'rentWarehouse', 'totalOpCost'];
const EXPORT_PCT_BASE_KEYS = [
  'sales', 'claim',
  'claim10PctCogs', 'additionalBudgetPromo', 'claimVouchers',
  'claimSTTI', 'claimVisibility', 'claimServiceFee', 'claimMonthlyIncentives', 'claimQuarterlyIncentives',
  'otherRevenue',
];
const EXPORT_PCT_BASE_LABEL = '% Cont. to Total Revenue';
// Rows that KEEP their original "% Cont. to SoG" row and get the Total Revenue row as an EXTRA row
// directly beneath it (both rows share one collapse group). Currently just Platform Fee Absorb by
// SIRCLO. Every other row in EXPORT_PCT_OF_BASE_ROW_KEYS has its single "% Cont." row switched to the
// Total Revenue base (label + denominator) instead.
const EXPORT_PCT_ALSO_SOG_ROW_KEYS = ['absorbBySirclo'];
// ADDED 2026-10-20 per Zoltraak: a new live-formula line directly under "Total Operational and Fulfillment Cost" —
// that row divided by the SAME Total Revenue base as every other "% Cont. to Total Revenue" row (EXPORT_PCT_BASE_KEYS),
// column by column. Written on the export sheets named here — first only the Warehouse sheet, extended 2026-10-20 per
// Zoltraak to all three sheets; remove a sheet name from the list to switch it off there.
const TOTAL_OPCOST_PCT_SHEETS = ['Per Period per Store', 'Per Period per Warehouse', 'Per Period per Marketplace'];
const TOTAL_OPCOST_PCT_LABEL = '% Cont. Total Operational and Fulfillment Cost to Total Revenue';
// ADDED 2026-10-20 per Zoltraak ("hapus baris 167-171"): rows that keep their per-entity VALUE rows but lose the blank
// spacer + per-entity "% Cont. to SoG <entity>" block beneath them — a per-order money figure divided by Sales of Goods is
// not a meaningful percentage (same reasoning as % Gross Profit / % Contribution Margin, which never had that block).
// Currently only Contribution Margin per Order; add 'gpPerOrder' here to drop the identical block under Gross Profit per Order.
// aov/abs added 2026-10-20 (their per-entity rows are live ratios, no "% Cont." block).
const EXPORT_NO_ENTITY_PCT_ROW_KEYS = ['cmPerOrder', 'aov', 'abs'];

// ROW_DEFS keys that get a per-entity VALUE-ONLY breakdown (Warehouse/Store/Marketplace, matching
// whichever dimension the current sheet is — same as Sales of Goods/Gross Profit etc. already get)
// but DELIBERATELY WITHOUT any "% Cont. to SoG" per-entity percentage rows — added 2026-08-27 per
// Zoltraak ("pada bagian line rebates, other revenue, cogs, surplus, MOGTM Distribution Fee, Promo
// Fund Front Margin, Promo Fund Back Margin tolong tambahkan informasi per category juga seperti
// per store, per warehouse, per marketplace ... tapi tidak perlu tampilkan % Cont. to SoG ya. hanya
// value saja"). Every one of these 7 rows already shows its own PLAIN single "% Cont. to SoG" row
// (via its pctOfSalesNote_ tag, or EXPORT_PLAIN_PCT_CONT_EXTRA_KEYS for mogtmFee) — that stays
// completely unchanged; this list only ADDS the per-entity value rows above it, same shape as (a1)
// below for the money-type breakdown rows, just without the (a2) percentage block.
const EXPORT_VALUE_ONLY_BREAKDOWN_KEYS = ['claim', 'otherRevenue', 'rbp', 'surplus', 'mogtmFee', 'promoFundFrontMargin', 'promoFundBackMargin'];

// Builds the full { sheets: [...] } payload Code.gs's createExportSpreadsheet(payload) expects —
// one entry per EXPORT_DIMENSIONS sheet that actually has at least one column of data (Per
// Marketplace is dropped entirely on the Outright tab rather than shipping a header-only sheet — see
// EXPORT_DIMENSIONS' own comment). `def.abs` mirrors financeBodyHtml's own value-extraction
// convention used everywhere else in this file (see e.g. computeGrand's callers) — the source
// Platform Fee columns store these as negative deductions; the dashboard (and now the export) shows
// them as a positive cost figure instead. After the plain-number matrix is built, a second pass (per
// EXPORT_FORMULA_ROWS above) overwrites specific METRIC rows' own cells with live formula strings
// instead (never a breakdown sub-row's cells — those always stay plain numbers, same as the
// dashboard's own store-breakdown rows) — Apps Script's Range.setValues (see writeExportSheet_ in
// Code.gs) treats any string starting with "=" as a real formula, exactly as if it had been typed
// into the cell by hand.
//
// REVISED 2026-08-26 per Zoltraak: row/column layout is no longer identical across all 4 sheets (it
// used to be — one row per ROW_DEFS entry, one column per dim.getColumns() entry, nothing else) —
// "Per Period" alone can now also carry extra per-store breakdown ROWS under each of the 6
// METRIC_BREAKDOWN_ROW_KEYS rows (dim.rowBreakdown) and extra Quarter/Half rollup COLUMN groups
// (dim.columnGroups), so rowLabels/rowFormats/values/rowNumberByKey are all computed freshly INSIDE
// the per-sheet loop now instead of once up front (it can no longer be shared across sheets whose
// row layouts now differ).
// Fixed prefix block prepended to every export sheet — added 2026-08-27 per Zoltraak: "tambahkan 7
// line baris baru paling atas". CORRECTED same day per Zoltraak's own follow-up ("baris ke 6 itu
// bukan header. baris ke 6 adalah % Run Rate SoG to Prev Quarter") — the header sits FIRST (row 1),
// matching his own "baris ke -1 adalah header bulan" line. REVISED 2026-08-31 to carry the SAME 7
// Movement Rate rows the dashboard's own mini table shows (MINI_MOVE_RUNRATE_ROWS) — was previously
// missing the Current/Previous Quarter rows — per Zoltraak: "the line at movement rate only updated
// in dashboard, please apply at excel level as well". Physical Sheets row layout (see
// writeExportSheet_ in Code.gs, which must stay in sync with these two constants):
//   Row 1: the header row (blank corner + "Item" + real period column headers, centered — per
//          Zoltraak's "baris ke -1 adalah header bulan" and "Header Bulan tolong rata tengah").
//          Deliberately EXCLUDED from the collapse group below (confirmed with Zoltraak: the header
//          must always stay visible, never collapsed away).
//   Row 2: % Move. NoD                          } one combined expand/collapse group, rows 2-8 —
//   Row 3: % Move. AoV                          } mirrors the dashboard's Movement Rate mini table
//   Row 4: % Move. SoG                          } row-for-row (MINI_MOVE_RUNRATE_ROWS) — Zoltraak's
//   Row 5: % Run Rate SoG to Current Quarter    } original "expand collapse dari baris ke 1-6" gave
//   Row 6: % Run Rate SoG to Previous Quarter   } the metrics group before these last 2 rows
//   Row 7: % Run Rate SoG QoQ                    } existed; the group now simply spans however many
//   Row 8: % Run Rate SoG to Prev. Semester     } prefix rows there are (prefixRows.length, below).
//   Row 9: blank spacer (per "Baris ke -7 Kosong", shifted down the same way every row below it is).
//   Row 10+: every existing metric row, completely unchanged in content — just shifted down from
//          starting at row 8 to starting at row 10 (1 header + 7 metrics + 1 blank = 9 rows above).
// EXPORT_HEADER_ROW/EXPORT_DATA_START_ROW are the two numbers Code.gs's writeExportSheet_ needs to
// match exactly; there's no shared-constant mechanism across the two files, so they're hardcoded
// there too (with a comment pointing back here) — change both together if this layout ever moves.
const EXPORT_HEADER_ROW = 1;
const EXPORT_DATA_START_ROW = 10;

function buildExportPayload_(rows, opts) {
  // `!def.isHeader || def.exportBlankRow` — added 2026-08-31 alongside the new blank divider row
  // right after Claim Vouchers (OUTRIGHT_ROW_DEFS' blankAfterClaimVouchers entry): every OTHER
  // isHeader row (section dividers like "Operational and Fulfillment Cost:") is still silently
  // skipped from the export exactly as before — only a row explicitly opted in via
  // `exportBlankRow: true` reaches this pass, where it's special-cased to a genuinely blank sheet
  // row (see the `def.exportBlankRow` branch inside both passes below) rather than going through
  // the normal value/breakdown/pct machinery every other dataRowDefs entry uses.
  const dataRowDefs = ROW_DEFS.filter(def => (!def.isHeader || def.exportBlankRow) && def.key);

  const sheets = EXPORT_DIMENSIONS.map(dim => {
    const built = dim.getColumns(rows);
    const columns = built.columns;
    if (!columns.length) return null;
    const columnHeaders = columns.map(c => c.label);
    // Maps each index into `built.rowBreakdown`'s OWN (pre-entity-breakdown) period-column list onto
    // its new index in `columns` above — see withEntityColumnBreakdown_'s own comment. Identity
    // mapping (a no-op) for a dimension that never adds entity sub-columns at all.
    const origToNewIdx = built.origToNewIdx || columns.map((_, i) => i);

    const rowLabels = [];
    const rowFormats = [];
    const rowIsBold = []; // false for a breakdown sub-row — see writeExportSheet_'s own bolding.
    const values = [];
    // Highest/lowest highlight — added 2026-08-31 per Zoltraak ("at all lines... highlight colour
    // Dark Bold Blue for the highest and Dark Bold Red for the lowest"). One {highest, lowest} entry
    // (each a 0-based column-index array into `columns`) per entry in `values`/`rowLabels` — see
    // computeHighlightCols_ below for how each entry is built.
    const rowHighlights = [];
    const rowNumberByKey = {}; // this SHEET's own row number for each ROW_DEFS key — see the
                                // function comment above on why this is no longer shared globally.
    const rowGroups = []; // {start, end} 1-based Sheets row numbers, one per breakdown block.
    // Per-entity breakdown row-start tracking — added 2026-09-23 per Zoltraak (google-sheets-
    // dashboard skill, ported from Unilever Group): remembers, for EVERY breakdown-eligible
    // def.key (not just the 6 LIVE_FORMULA_BREAKDOWN_KEYS — GP/CM's own dependencies like
    // sales/claim10PctCogs/etc need their entity row-starts too), the FIRST sheet row of that
    // key's per-entity breakdown block, plus how many entities that block has. This fork only ever
    // populates storeEntityRowStartByKey/storeEntityCount (no separate Group-level breakdown block
    // here — see the (a1) capture below); groupEntityRowStartByKey/groupEntityCount stay empty/0
    // and the post-pass below simply skips them.
    let groupEntityRowStartByKey = {};
    let storeEntityRowStartByKey = {};
    let groupEntityCount = 0;
    let storeEntityCount = 0;
    let sheetRow = EXPORT_DATA_START_ROW; // rows 1-7 are the fixed prefix block — see its own comment above.
    // g5/g6 native Sheets collapse groups — added 2026-08-31 per Zoltraak ("please add button expand
    // collapse at line rebates... both dashboard and excel" / "let the blank line after line claim
    // vouchers have its own button expand collapse as well both dashboard and excel"). Unlike g1-g4
    // (dashboard-only show/hide toggles never mirrored into the export), these two are explicitly
    // requested in Excel too, so we track their sheet-row spans as the main dataRowDefs pass below
    // writes claim10PctCogs..claimVouchers (g5) and claimSTTI..claimQuarterlyIncentives (g6 — end
    // anchor moved 2026-09-01 when priceClawbackDropPrice left this group, see g6End's own comment
    // below), then push native row-outline groups for them the same way the breakdown/pct/rate
    // blocks already do.
    let g5Start = null, g5End = null, g6Start = null, g6End = null;
    // g9/g10 native Sheets collapse groups — added 2026-08-31 (third round) per Zoltraak ("add
    // expand collapase tools at line platform fee absorb by SIRCLO that contains of line
    // 'Marketplace Fee (Based on Sell in)'" / "add expand collapase tools at line Consumables that
    // contains of line 'Warehouse Fee (Based on Sell In)'"), Both Dashboard and Excel this time
    // (unlike g7/g8, which stayed Dashboard-only). Each is a single-row span (one new placeholder
    // row per toggle, unlike g5/g6's 3/6-row spans), same single-row group pattern the MOGTM "%
    // Cont. MOGTM to COGS" row already uses (mogtmCogsRow below).
    let g9Row = null, g10Row = null;

    // Pre-pass — added 2026-08-27 per Zoltraak's Number of Order/Quantity request. The "% Cont. to
    // SoG" formulas below need Sales of Goods' own sheet row number (`salesRow`), and the comment
    // this replaced assumed Sales of Goods always appears EARLIER in ROW_DEFS than every row that
    // references it — true back when only sales/gp/totalOpCost/contributionMargin (all AFTER Sales
    // of Goods, idx 6) were breakdown-eligible. That broke the moment Number of Order (key 'uniq',
    // idx 1) and Quantity (key 'qty', idx 3) became breakdown-eligible too — both sit BEFORE Sales
    // of Goods in ROW_DEFS, so `rowNumberByKey.sales` was still undefined when their own block was
    // being built, silently skipping their entire "% Cont. to SoG" treatment (no blank spacer, no
    // pct rows at all — verified via export_pct_cont_v3_test.js).
    //
    // Fix: replay the EXACT same row-count logic the main pass below uses (value rows + blank
    // spacer + entity pct rows, or a single plain pct row) in a dry run first, writing nothing to
    // rowLabels/rowFormats/rowIsBold/values/rowGroups — just to learn every key's final sheet row
    // number ahead of time. Spreadsheet formulas can reference a row before it's been written (the
    // cell exists in the final sheet either way), so this is purely about knowing the RIGHT row
    // number to reference, not about write order.
    let preSheetRow = EXPORT_DATA_START_ROW;
    dataRowDefs.forEach(def => {
      rowNumberByKey[def.key] = preSheetRow;
      preSheetRow += 1;
      if (def.key === 'totalOpCost' && TOTAL_OPCOST_PCT_SHEETS.includes(dim.sheetName)) preSheetRow += 1; // the new "% ... to Total Revenue" line right under it
      const isBreakdownEligibleRow = METRIC_BREAKDOWN_ROW_KEYS.includes(def.key) || EXPORT_VALUE_ONLY_BREAKDOWN_KEYS.includes(def.key);
      const isRatioBreakdownRow = def.key === 'pctGp' || def.key === 'pctContributionMargin' || EXPORT_NO_ENTITY_PCT_ROW_KEYS.includes(def.key);
      const isValueOnlyBreakdownRow = EXPORT_VALUE_ONLY_BREAKDOWN_KEYS.includes(def.key);
      const breakdownEntries = (built.rowBreakdown && isBreakdownEligibleRow) ? built.rowBreakdown(def.key) : null;
      const hasRealBreakdown = !!(breakdownEntries && breakdownEntries.length);
      const plainPctSource = (def.cellNote && def.cellNote.pctOfSalesKey)
        ? true
        : EXPORT_PLAIN_PCT_CONT_EXTRA_KEYS.includes(def.key);
      if (hasRealBreakdown) {
        preSheetRow += breakdownEntries.length; // (a1) value rows — every breakdown-eligible row
        // (a2) blank spacer + per-entity "% Cont. to SoG/CM/GP" rows — skipped for the 2 ratio rows
        // (unchanged) AND for the new value-only-breakdown rows (Rebates, Other Revenue, COGS,
        // Surplus, MOGTM Distributor Fee, Promo Fund Front/Back Margin — per Zoltraak, value only).
        if (built.showPctOfSales && !isRatioBreakdownRow && !isValueOnlyBreakdownRow) {
          preSheetRow += 1; // blank spacer row
          preSheetRow += breakdownEntries.length; // per-entity pct rows
        }
      }
      // The plain single "% Cont. to SoG" row is skipped ONLY when this row already got the
      // entity-level pct block above (a2) — a value-only-breakdown row keeps ITS OWN plain row even
      // though it also gets breakdown value rows (a1), since (a2) never runs for it.
      const skipPlainRow = hasRealBreakdown && !isValueOnlyBreakdownRow;
      if (!skipPlainRow && built.showPctOfSales && plainPctSource) {
        preSheetRow += 1; // (b) plain "% Cont. to SoG" row
        if (EXPORT_PCT_OF_BASE_ROW_KEYS.includes(def.key) && EXPORT_PCT_ALSO_SOG_ROW_KEYS.includes(def.key)) preSheetRow += 1; // extra "% Cont. to Total Revenue" row
      }
      // (c) "% Cont. MOGTM to COGS" — added 2026-08-27 per Zoltraak, one extra row under MOGTM
      // Distributor Fee only (see the main pass' matching comment below for the full formula).
      if (built.showPctOfSales && def.key === 'mogtmFee') {
        preSheetRow += 1;
      }
    });

    // Prefix rows 2-6 (% Move. NoD/AoV/SoG, % Run Rate SoG to Prev. Semester/Quarter), written right
    // after the row-1 header — added 2026-08-27 per Zoltraak, see EXPORT_HEADER_ROW's own comment
    // above for the full row layout. Built here (rowNumberByKey.uniq/aov/sales are already known
    // after the pre-pass above) rather than inline with the main pass below, since these 5 rows sit
    // ABOVE the main data table entirely and don't participate in that pass' per-ROW_DEFS iteration
    // at all.
    //
    // "Previous column" for % Move is the previous REAL MONTH's own column — NOT simply "the column
    // to the left", since a Quarter/Half total column can sit between two real months (e.g. ...Mar,
    // Q1 2026, Apr... — Apr's column-to-the-left is "Q1 2026", not Mar). Built from `columns`
    // itself: any column whose `.months` is exactly one real month IS that month's column.
    // `!c.isEntityBreakdown` guard added 2026-08-28, alongside withEntityColumnBreakdown_: an entity
    // sub-column (e.g. a store's own "July 2026" sub-column) copies its parent's `.months` verbatim,
    // so without this guard several columns would collide on the SAME real-month key here and this
    // map would end up pointing at whichever entity sub-column happened to be processed last, instead
    // of the actual period column — corrupting every % Move formula's "previous month" lookup.
    const realMonthColIdx = {}; // "YYYY-MM" -> index into `columns`
    columns.forEach((c, idx) => {
      if (!c.isEntityBreakdown && c.months && c.months.length === 1 && isRealMonthKey(c.months[0])) realMonthColIdx[c.months[0]] = idx;
    });
    const sortedRealMonths = Object.keys(realMonthColIdx).sort();
    // Quarter/Half TOTAL columns are looked up by their own formatted label ("Q1 2026"/"H1 2026" —
    // see buildExportPeriodColumns_'s periodTotalLabel) rather than by index, since (unlike real
    // months) there's no guarantee every quarter/half in the export even HAS its own total column
    // (an incomplete quarter never gets one — see buildExportPeriodColumns_/buildPeriodTree).
    const periodColIdxByLabel = {};
    columns.forEach((c, idx) => { periodColIdxByLabel[c.label] = idx; });
    function keyToLabel_(key) { // "2026-Q1" -> "Q1 2026", "2025-H2" -> "H2 2025"
      const parts = String(key).split('-');
      return parts[1] + ' ' + parts[0];
    }
    const colLetters = columns.map((c, idx) => columnLetter_(idx + 3));
    // Column-type detectors used by the prefix rows below. A real month column carries exactly one
    // real month in `.months`; a Quarter/Half TOTAL column is identified by its own formatted label
    // ("Q1 2026"/"H1 2026" — see buildExportPeriodColumns_'s periodTotalLabel), which is simpler and
    // more robust than trying to infer it from `.months.length` (Grand Total's own `.months` can
    // coincidentally also span exactly one quarter/half's worth of months). Every detector excludes
    // `isEntityBreakdown` columns (added 2026-08-28) — % Move/% Run Rate are period-level metrics,
    // not per-entity ones, so every entity sub-column just stays blank for these 5 rows regardless of
    // what period its parent column happens to be.
    function isRealMonthCol_(c) { return !c.isEntityBreakdown && !!(c.months && c.months.length === 1 && isRealMonthKey(c.months[0])); }
    function isQuarterCol_(c) { return !c.isEntityBreakdown && /^Q[1-4] \d{4}$/.test(c.label); }
    function isHalfCol_(c) { return !c.isEntityBreakdown && /^H[12] \d{4}$/.test(c.label); }
    // Entity sub-column -> its own immediate parent period column (real month/Quarter/Half/Grand
    // Total) — walks backward to the nearest non-entity column, since withEntityColumnBreakdown_
    // always inserts a period column's entity children directly after it (a no-op — returns idx
    // itself — when `idx` isn't an entity column at all). `entityChildrenByParent` is the reverse
    // lookup (parent idx -> {entity label: entity col idx}), built once here and reused below by
    // moveFormulaGeneric_/moveValueRaw_ to find "this same entity's own column in the previous
    // period" — added 2026-08-31 per Zoltraak's Quarter/Store/Marketplace/Warehouse extension of %
    // Move. NoD/AoV (see moveFormulaGeneric_'s own comment).
    function parentColIdx_(idx) {
      let p = idx;
      while (p >= 0 && columns[p].isEntityBreakdown) p--;
      return p;
    }
    const entityChildrenByParent = {};
    columns.forEach((c, idx) => {
      if (!c.isEntityBreakdown) return;
      const p = parentColIdx_(idx);
      if (!entityChildrenByParent[p]) entityChildrenByParent[p] = {};
      entityChildrenByParent[p][c.label] = idx;
    });
    // The PREVIOUS period's own parent-column index for a given (non-entity) period column — same
    // month/quarter/half lookup moveFormula_/runRateFormula_ already use, generalized so
    // moveFormulaGeneric_/moveValueRaw_ below can call it for any of the 3 granularities. -1 when
    // there's no earlier comparable column (first period in this export, or Grand Total/an
    // unrecognized column type).
    function prevParentIdx_(parentIdx) {
      const c = columns[parentIdx];
      if (!c) return -1;
      if (isRealMonthCol_(c)) {
        const mi = sortedRealMonths.indexOf(c.months[0]);
        if (mi <= 0) return -1;
        const prevMonth = sortedRealMonths[mi - 1];
        return realMonthColIdx[prevMonth] !== undefined ? realMonthColIdx[prevMonth] : -1;
      }
      if (isQuarterCol_(c)) {
        const prevLabel = keyToLabel_(previousQuarterKey(monthToQuarterKey(c.months[0])));
        return periodColIdxByLabel[prevLabel] !== undefined ? periodColIdxByLabel[prevLabel] : -1;
      }
      if (isHalfCol_(c)) {
        const prevLabel = keyToLabel_(previousHalfKey(monthToHalfKey(c.months[0])));
        return periodColIdxByLabel[prevLabel] !== undefined ? periodColIdxByLabel[prevLabel] : -1;
      }
      return -1; // Grand Total or anything else has no "previous period" of its own.
    }
    // "% Cont." base helpers — added 2026-10-14 per Zoltraak, see EXPORT_PCT_OF_BASE_ROW_KEYS' own
    // comment. pctBaseExpr_ returns the live-formula denominator for one column (e.g. "SUM(C14,C15,
    // C18,C19,C20,C22,C23,C24,C25,C26,C27)" — row numbers come from this sheet's own rowNumberByKey,
    // fully populated by the pre-pass above, so a row that sits later in ROW_DEFS than the one
    // referencing it is fine). pctBaseRaw_ is its plain-number twin, used only to decide
    // highest/lowest highlighting (a placeholder claim-detail row with no data yet simply reads 0).
    function pctBaseExpr_(colLetter) {
      const refs = EXPORT_PCT_BASE_KEYS.filter(k => rowNumberByKey[k]).map(k => colLetter + rowNumberByKey[k]);
      return refs.length ? 'SUM(' + refs.join(',') + ')' : null;
    }
    function pctBaseRaw_(c) {
      return EXPORT_PCT_BASE_KEYS.reduce((s, k) => s + ((c && c.data && c.data[k]) || 0), 0);
    }
    // Highest/lowest highlight helpers — added 2026-08-31 per Zoltraak ("at all lines... highlight
    // colour Dark Bold Blue for the highest and Dark Bold Red for the lowest"), mirroring the
    // dashboard's own rowHighlightSets_/highlightCls_ pair (see that pair's own comment): bold
    // colored TEXT only (no cell fill), compared across this row's own real data columns only —
    // Grand Total and Grand Total's own Store/Warehouse/Marketplace expand-by-dimension columns are
    // excluded, exactly like the on-screen table already excludes them. A live Sheets FORMULA cell
    // (Average Order Value, % Gross Profit, every "% Cont. to SoG" row, the 5 prefix metric rows,
    // ...) can't be read back synchronously here to know what Sheets will eventually compute — every
    // caller below instead scores rows using the SAME underlying numbers deriveMetrics/computeGrand
    // already computed in JS (c.data.aov, c.data.pctGp, ...), which is exactly what each formula
    // evaluates to. This only decides which cells get the extra bold+color formatting; the formula
    // string written into the cell itself is never touched.
    function isGrandTotalCol_(idx) {
      const c = columns[idx];
      if (!c) return false;
      if (!c.isEntityBreakdown) return c.label === 'Grand Total';
      const p = columns[parentColIdx_(idx)];
      return !!(p && p.label === 'Grand Total');
    }
    // Which comparison POOL one column belongs to — REVISED 2026-08-31 (second revision) per
    // Zoltraak ("do not apply the colour blue and red at colomn level in quarter and semester,
    // because it could lead to misleading... Quarter would have its own blue and red... its month
    // would have its own blue and red... its warehouse, store and marketplace per quarter or
    // semester or month would have their own") — mirrors the dashboard's own highlightPoolKey_
    // exactly: a plain (non-breakdown) column pools with every other plain column of the SAME
    // granularity only (every real month together, every Quarter together, every Half together,
    // never mixed); an entity (Warehouse/Store/Marketplace) breakdown column pools ONLY with the
    // other breakdown columns under that SAME specific parent period — keyed by that parent's own
    // column index, so April's own breakdown never mixes with May's.
    //
    // REVISED 2026-09-02 per Zoltraak ("Sales of Goods Betadine Group May 2026 should be highlighted
    // blue and April 2026 highlighted red... in dashboard correct, in spreadsheet incorrect"). Root
    // cause: the export's own `columnGranularity_` (below) pooled EVERY real month column in the
    // WHOLE export together as one flat 'month' bucket, so a row's highest/lowest was scored across
    // every month in the export period at once (e.g. all of Jan-Jun), not within one quarter — while
    // the dashboard's own highlightPoolKey_ (see that function's own 2026-08-31 revision, from
    // Zoltraak's exact worked example: "Betadine combined at Quarter 2, line sales of goods, the blue
    // highlight should belongs to May... red belongs to April, thats at monthly section") pools a
    // real month ONLY against the other real months of that SAME calendar quarter. Since the export
    // always shows every month side by side (never one quarter expanded at a time like the dashboard),
    // that quarter-scoping was silently dropped for the export's own flat 'month' bucket — this is
    // what made the two disagree. Fixed by scoping a real month column's pool key to its own calendar
    // quarter (`monthToQuarterKey`), exactly mirroring the dashboard's per-quarter pooling; Quarter and
    // Half columns are unaffected (they already pool globally, matching the dashboard's own
    // highlightPoolKey_ for those granularities too).
    function highlightPoolKeyExport_(idx) {
      const c = columns[idx];
      if (!c.isEntityBreakdown) return columnGranularity_(idx);
      return 'entity@' + parentColIdx_(idx);
    }
    // 'month@<quarterKey>' | 'quarter' | 'half' | 'grand' for a column, following its own type when
    // it's a plain period column, or its parent's when it's an entity breakdown column (an entity
    // column's own `.months`/`.label` just copy the parent's, so isRealMonthCol_/isQuarterCol_/
    // isHalfCol_ can't read it directly). A real month is keyed by its own calendar quarter (see
    // highlightPoolKeyExport_'s 2026-09-02 comment above) so April/May/June pool separately from
    // January/February/March even though every month in the export is a plain 'month' granularity.
    function columnGranularity_(idx) {
      const c = columns[idx];
      if (isGrandTotalCol_(idx)) return 'grand';
      const ref = c.isEntityBreakdown ? columns[parentColIdx_(idx)] : c;
      if (isRealMonthCol_(ref)) return 'month@' + monthToQuarterKey(ref.months[0]);
      if (isQuarterCol_(ref)) return 'quarter';
      if (isHalfCol_(ref)) return 'half';
      return 'grand';
    }
    // valuesByColIdx: array parallel to `columns` — a plain number per real column, or null/undefined
    // to skip that column entirely (no data that period, or a Quarter/Half/Grand Total column a
    // month-only row doesn't apply to).
    function computeHighlightCols_(valuesByColIdx) {
      const pools = {};
      columns.forEach((c, idx) => {
        if (isGrandTotalCol_(idx)) return;
        const key = highlightPoolKeyExport_(idx);
        (pools[key] || (pools[key] = [])).push(idx);
      });
      const highest = [], lowest = [];
      Object.values(pools).forEach(poolIdxs => {
        if (poolIdxs.length < 2) return;
        let max = -Infinity, min = Infinity;
        poolIdxs.forEach(idx => {
          const v = valuesByColIdx[idx];
          if (v == null || !Number.isFinite(v)) return;
          if (v > max) max = v;
          if (v < min) min = v;
        });
        if (!Number.isFinite(max) || !Number.isFinite(min) || max === min) return;
        poolIdxs.forEach(idx => {
          const v = valuesByColIdx[idx];
          if (v == null || !Number.isFinite(v)) return;
          if (v === max) highest.push(idx);
          if (v === min) lowest.push(idx);
        });
      });
      return { highest: highest, lowest: lowest };
    }
    // One formula-builder per prefix row: `curIdx` is this row's own applicable column index into
    // `columns`; returns a plain 0 (not blank) for the very first real month/quarter/half in this
    // export (per Zoltraak: "jika kolom tersebut merupakan bulan pertama ... 0%") since there's no
    // earlier period to compare against.
    function moveFormula_(curIdx, metricRow) {
      const month = columns[curIdx].months[0];
      const monthsIdx = sortedRealMonths.indexOf(month);
      if (monthsIdx <= 0) return 0; // first real month in this export, or not found
      const prevMonth = sortedRealMonths[monthsIdx - 1];
      const prevIdx = realMonthColIdx[prevMonth];
      const curCol = colLetters[curIdx], prevCol = colLetters[prevIdx];
      return `=IFERROR((${curCol}${metricRow}-${prevCol}${metricRow})/${prevCol}${metricRow}*100,0)`;
    }
    // Period/entity-aware version of moveFormula_ above — added 2026-08-31 per Zoltraak ("% Move.
    // NoD and % Move. AoV, the col in Quarter [column] logic should be activated by period Quarter,
    // by Store, Marketplace and Warehouse"): extends % Move. NoD/AoV (NOT % Move. SoG, which keeps
    // moveFormula_'s original month-only behavior — the 2 Run Rate rows already cover Sales of
    // Goods' own period-over-period comparison) to also compute on Quarter/Half TOTAL columns and on
    // every column's own Store/Warehouse/Marketplace entity sub-columns, comparing each column
    // against the SAME entity's own column in the immediately preceding period of the SAME
    // granularity (month vs month, quarter vs quarter, half vs half) — mirrors this file's
    // dashboard-side periodMoveMiniValue_/brandMetricForMonths_ pair (see that pair's own comment),
    // just expressed as a live Sheets formula instead of a precomputed JS number. Returns a plain 0
    // (not a formula) when there's no comparable previous period at all, OR when this specific
    // entity had no data in that previous period — same "no earlier data -> 0%" convention
    // moveFormula_ and runRateFormula_ already use.
    // Column index holding `entityLabel`'s own figure for the (non-entity) period column `pIdx`: that entity's sub-column
    // when the period has one; the period column itself when this entity was the period's ONLY entity (no sub-columns were
    // added — see soleEntityLabel in withEntityColumnBreakdown_); -1 when the entity is absent that period.
    function entityCellIdx_(pIdx, entityLabel) {
      if (entityLabel === null) return pIdx;
      const children = entityChildrenByParent[pIdx];
      const eIdx = children ? children[entityLabel] : undefined;
      if (eIdx !== undefined) return eIdx;
      return columns[pIdx] && columns[pIdx].soleEntityLabel === entityLabel ? pIdx : -1;
    }
    function moveFormulaGeneric_(curIdx, metricRow) {
      const parentIdx = parentColIdx_(curIdx);
      const prevParentIdx = prevParentIdx_(parentIdx);
      if (prevParentIdx < 0) return 0;
      let prevIdx;
      if (columns[curIdx].isEntityBreakdown) {
        prevIdx = entityCellIdx_(prevParentIdx, columns[curIdx].label);
        if (prevIdx < 0) return 0;
      } else {
        prevIdx = prevParentIdx;
      }
      const curCol = colLetters[curIdx], prevCol = colLetters[prevIdx];
      return `=IFERROR((${curCol}${metricRow}-${prevCol}${metricRow})/${prevCol}${metricRow}*100,0)`;
    }
    // Plain-number twin of moveFormulaGeneric_ above, used ONLY to decide highest/lowest highlighting
    // for the % Move. NoD/AoV prefix rows (see computeHighlightCols_'s own comment on why a live
    // formula cell can't be read back synchronously here) — same lookup, but reads `metricKey`
    // straight off each column's own already-derived `.data` (deriveMetrics/computeGrand already
    // compute c.data.uniq/c.data.aov identically to what the Sheets formula above evaluates to)
    // instead of building a cell-reference string.
    function moveValueRaw_(curIdx, metricKey) {
      const parentIdx = parentColIdx_(curIdx);
      const prevParentIdx = prevParentIdx_(parentIdx);
      if (prevParentIdx < 0) return null;
      const curVal = (columns[curIdx].data && columns[curIdx].data[metricKey]) || 0;
      let prevVal;
      if (columns[curIdx].isEntityBreakdown) {
        const prevIdx = entityCellIdx_(prevParentIdx, columns[curIdx].label);
        if (prevIdx < 0) return 0;
        prevVal = (columns[prevIdx].data && columns[prevIdx].data[metricKey]) || 0;
      } else {
        prevVal = (columns[prevParentIdx].data && columns[prevParentIdx].data[metricKey]) || 0;
      }
      if (!prevVal) return 0;
      return ((curVal - prevVal) / prevVal) * 100;
    }
    // % Run Rate SoG to Prev. Semester/Quarter — REVISED 2026-08-28 per Zoltraak, two fixes together:
    //   (1) This now lands ON the Quarter/Half's own TOTAL column ("at column Quarter Section" — see
    //       the prefixMetricRows `kind`/prefixRows gating below), comparing that quarter/half's own
    //       Sales of Goods total to the PREVIOUS quarter/half's own total column. Before this fix it
    //       sat on every real MONTH column instead (repeating the same quarter-level number across
    //       all of that quarter's months) and was blank on the Quarter/Half column itself — backwards
    //       from what was wanted.
    //   (2) The formula itself is now a %-CHANGE ((cur-prev)/prev*100 — same shape moveFormula_
    //       already uses), not a plain ratio (cur/prev*100). Per Zoltraak's own worked example for Q2
    //       2026: ((11,157,315,634 / 10,653,475,565) * 100%) − 100% — algebraically identical to
    //       (cur−prev)/prev×100, NOT the old cur/prev×100 (which would show ~104.7% instead of ~4.7%).
    // Still returns a plain 0 (not blank) for the very first quarter/half in this export (e.g. Q1 of
    // a fresh calendar year) since there's no previous-period column to compare against — same
    // "first period -> 0%" convention moveFormula_ uses.
    function runRateFormula_(curIdx, periodKeyFn, previousPeriodKeyFn) {
      const month = columns[curIdx].months[0];
      const periodKey = periodKeyFn(month);
      const prevPeriodKey = previousPeriodKeyFn(periodKey);
      const prevLabel = keyToLabel_(prevPeriodKey);
      const prevIdx = periodColIdxByLabel[prevLabel];
      if (prevIdx === undefined) return 0; // previous quarter/half has no total column in this export
      const curCol = colLetters[curIdx], prevCol = colLetters[prevIdx];
      const salesRow = rowNumberByKey.sales;
      return `=IFERROR((${curCol}${salesRow}-${prevCol}${salesRow})/${prevCol}${salesRow}*100,0)`;
    }
    // Plain-number twin of runRateFormula_ above — same "SoG total this period vs SoG total last
    // period" comparison, used only to decide the 2 Run Rate prefix rows' own highest/lowest
    // highlighting (see computeHighlightCols_'s own comment).
    function runRateValueRaw_(curIdx, periodKeyFn, previousPeriodKeyFn) {
      const month = columns[curIdx].months[0];
      const prevLabel = keyToLabel_(previousPeriodKeyFn(periodKeyFn(month)));
      const prevIdx = periodColIdxByLabel[prevLabel];
      if (prevIdx === undefined) return null;
      const curVal = (columns[curIdx].data && columns[curIdx].data.sales) || 0;
      const prevVal = (columns[prevIdx].data && columns[prevIdx].data.sales) || 0;
      if (!prevVal) return 0;
      return ((curVal - prevVal) / prevVal) * 100;
    }
    // % Move. NoD/AoV now apply to real month columns AND Quarter/Half TOTAL columns AND every one of
    // those columns' own Store/Warehouse/Marketplace entity sub-columns (see moveFormulaGeneric_'s
    // own comment) — 'move-aware' kind, distinct from % Move. SoG's unchanged month-only 'month' kind.
    function appliesToMoveAware_(c, idx) {
      if (isRealMonthCol_(c) || isQuarterCol_(c) || isHalfCol_(c)) return true;
      if (c.isEntityBreakdown) {
        const p = columns[parentColIdx_(idx)];
        return !!(p && (isRealMonthCol_(p) || isQuarterCol_(p) || isHalfCol_(p)));
      }
      return false;
    }
    // % Run Rate SoG to Current/Previous Quarter apply only to real MONTH columns (like % Move) AND
    // their own entity sub-columns — never a Quarter/Half rollup column itself.
    function appliesToMonthEntityAware_(c, idx) {
      if (isRealMonthCol_(c)) return true;
      if (c.isEntityBreakdown) {
        const p = columns[parentColIdx_(idx)];
        return !!(p && isRealMonthCol_(p));
      }
      return false;
    }
    // Every real-month PARENT column index (non-entity) whose month falls in quarter `quarterKey` —
    // used by runRateCurrentQuarterFormula_/runRatePreviousQuarterFormula_ below to sum a whole
    // quarter's worth of real-month cells via plain cell references (a Sheets column-range SUM would
    // incorrectly sweep up any entity sub-columns sitting between those months too).
    function realMonthColIdxsInQuarter_(quarterKey) {
      return sortedRealMonths.filter(m => monthToQuarterKey(m) === quarterKey).map(m => realMonthColIdx[m]);
    }
    // Builds a "cellA+cellB+cellC" addition expression summing `metricRow` across every column in
    // `parentIdxs` (real-month parent columns) — or, when `entityLabel` is given, that SAME entity's
    // own sub-column under each parent month instead (skipping any month where that entity had no
    // data at all that month, same "missing = contributes 0" convention used throughout this file).
    // Returns the literal string '0' if nothing to sum (never an empty expression).
    function sumCellsExpr_(parentIdxs, metricRow, entityLabel) {
      const parts = [];
      parentIdxs.forEach(pIdx => {
        const cellIdx = entityCellIdx_(pIdx, entityLabel);
        if (cellIdx < 0) return;
        parts.push(colLetters[cellIdx] + metricRow);
      });
      return parts.length ? parts.join('+') : '0';
    }
    // % Run Rate SoG to Current Quarter — ADDED to the Excel export 2026-08-31 per Zoltraak ("the
    // line at movement rate only updated in dashboard, please apply at excel level as well"),
    // mirroring the dashboard's own runRateCurrentQuarterMiniValue_ exactly: this month's own Sales
    // of Goods divided by this SAME quarter's own full Sales of Goods total (every real month
    // belonging to it that exists in this export — see quarterToDateMonths_'s own dashboard-side
    // comment for why "full quarter" naturally still reduces to "quarter-to-date" for an in-progress
    // quarter, since a month that hasn't happened yet simply has no column to sum here either).
    // Applies to every real MONTH column (not the quarter's own rollup column) and its own entity
    // sub-columns, same as runRateCurrentQuarterMiniValue_'s c.type gate.
    function runRateCurrentQuarterFormula_(curIdx) {
      const c = columns[curIdx];
      const parentMonth = columns[parentColIdx_(curIdx)].months[0];
      const monthIdxs = realMonthColIdxsInQuarter_(monthToQuarterKey(parentMonth));
      const entityLabel = c.isEntityBreakdown ? c.label : null;
      const denomExpr = sumCellsExpr_(monthIdxs, rowNumberByKey.sales, entityLabel);
      const curCell = colLetters[curIdx] + rowNumberByKey.sales;
      return `=IFERROR(${curCell}/(${denomExpr})*100,0)`;
    }
    // Plain-number twin of runRateCurrentQuarterFormula_ above, used only for this row's own
    // highest/lowest highlighting (see computeHighlightCols_'s own comment).
    function runRateCurrentQuarterValueRaw_(curIdx) {
      const c = columns[curIdx];
      const parentMonth = columns[parentColIdx_(curIdx)].months[0];
      const monthIdxs = realMonthColIdxsInQuarter_(monthToQuarterKey(parentMonth));
      const entityLabel = c.isEntityBreakdown ? c.label : null;
      let qtdSales = 0;
      monthIdxs.forEach(pIdx => {
        const cellIdx = entityCellIdx_(pIdx, entityLabel);
        if (cellIdx < 0) return;
        const dataCol = columns[cellIdx];
        qtdSales += (dataCol.data && dataCol.data.sales) || 0;
      });
      const curVal = (c.data && c.data.sales) || 0;
      if (!qtdSales) return 0;
      return (curVal / qtdSales) * 100;
    }
    // % Run Rate SoG to Previous Quarter — ADDED to the Excel export 2026-08-31, mirroring the
    // dashboard's own runRatePreviousQuarterMiniValue_: this month's own Sales of Goods divided by
    // the PREVIOUS quarter's own FULL Sales of Goods total (regardless of where this month sits
    // within its own quarter). Blank (not a formula at all) whenever the previous quarter has no
    // real-month column anywhere in this export — same "not applied for the export's very first
    // quarter" rule the dashboard uses (Q1 2026 has no Q4 2025 to divide by); once a formula IS
    // written it still falls back to IFERROR(...,0) for the rarer case where this SPECIFIC entity
    // simply had no data in that (otherwise-present) previous quarter.
    function runRatePreviousQuarterApplies_(curIdx) {
      const parentMonth = columns[parentColIdx_(curIdx)].months[0];
      return realMonthColIdxsInQuarter_(previousQuarterKey(monthToQuarterKey(parentMonth))).length > 0;
    }
    function runRatePreviousQuarterFormula_(curIdx) {
      const c = columns[curIdx];
      const parentMonth = columns[parentColIdx_(curIdx)].months[0];
      const monthIdxs = realMonthColIdxsInQuarter_(previousQuarterKey(monthToQuarterKey(parentMonth)));
      const entityLabel = c.isEntityBreakdown ? c.label : null;
      const denomExpr = sumCellsExpr_(monthIdxs, rowNumberByKey.sales, entityLabel);
      const curCell = colLetters[curIdx] + rowNumberByKey.sales;
      return `=IFERROR(${curCell}/(${denomExpr})*100,0)`;
    }
    // Plain-number twin of runRatePreviousQuarterFormula_ above, used only for highlighting.
    function runRatePreviousQuarterValueRaw_(curIdx) {
      const c = columns[curIdx];
      const parentMonth = columns[parentColIdx_(curIdx)].months[0];
      const monthIdxs = realMonthColIdxsInQuarter_(previousQuarterKey(monthToQuarterKey(parentMonth)));
      const entityLabel = c.isEntityBreakdown ? c.label : null;
      let prevSales = 0;
      monthIdxs.forEach(pIdx => {
        const cellIdx = entityCellIdx_(pIdx, entityLabel);
        if (cellIdx < 0) return;
        const dataCol = columns[cellIdx];
        prevSales += (dataCol.data && dataCol.data.sales) || 0;
      });
      const curVal = (c.data && c.data.sales) || 0;
      if (!prevSales) return 0;
      return (curVal / prevSales) * 100;
    }
    // The 7 Movement Rate prefix rows — REVISED 2026-08-31 to match the dashboard's own
    // MINI_MOVE_RUNRATE_ROWS exactly (label, order, and formula per row): the export previously only
    // carried an older 5-row version (missing the Current/Previous Quarter rows, and mislabeling the
    // QoQ row) — see this edit's own comment on EXPORT_DATA_START_ROW for the resulting row-count
    // shift.
    const prefixMetricRows = [
      { label: '% Move. NoD', kind: 'move-aware', fn: (idx) => moveFormulaGeneric_(idx, rowNumberByKey.uniq), rawFn: (idx) => moveValueRaw_(idx, 'uniq') },
      { label: '% Move. AoV', kind: 'move-aware', fn: (idx) => moveFormulaGeneric_(idx, rowNumberByKey.aov), rawFn: (idx) => moveValueRaw_(idx, 'aov') },
      { label: '% Move. SoG', kind: 'month', fn: (idx) => moveFormula_(idx, rowNumberByKey.sales), rawFn: (idx) => moveValueRaw_(idx, 'sales') },
      { label: '% Run Rate SoG to Current Quarter', kind: 'month-entity-aware', fn: (idx) => runRateCurrentQuarterFormula_(idx), rawFn: (idx) => runRateCurrentQuarterValueRaw_(idx) },
      { label: '% Run Rate SoG to Previous Quarter', kind: 'runrate-prev-q', fn: (idx) => runRatePreviousQuarterFormula_(idx), rawFn: (idx) => runRatePreviousQuarterValueRaw_(idx) },
      // Label RENAMED 2026-09-01 per Zoltraak ("rename line % Run Rate QoQ to % Run Rate SoG QoQ,
      // update both dashboard and excel") — same formula (runRateFormula_), matches
      // MINI_MOVE_RUNRATE_ROWS' own rename above.
      { label: '% Run Rate SoG QoQ', kind: 'quarter', fn: (idx) => runRateFormula_(idx, monthToQuarterKey, previousQuarterKey), rawFn: (idx) => runRateValueRaw_(idx, monthToQuarterKey, previousQuarterKey) },
      { label: '% Run Rate SoG to Prev. Semester', kind: 'half', fn: (idx) => runRateFormula_(idx, monthToHalfKey, previousHalfKey), rawFn: (idx) => runRateValueRaw_(idx, monthToHalfKey, previousHalfKey) },
    ];
    const prefixRows = prefixMetricRows.map(row => {
      // % Move. SoG applies only to real month columns (month-over-month, unchanged); % Run Rate SoG QoQ/
      // Semester apply only to that same granularity's own rollup TOTAL column (quarter-over-quarter/
      // half-over-half); % Move. NoD/AoV ('move-aware') additionally cover Quarter/Half columns and
      // their entity sub-columns; % Run Rate SoG to Current Quarter ('month-entity-aware') and to
      // Previous Quarter ('runrate-prev-q', which ALSO requires the previous quarter to actually have
      // a column in this export) apply to real month columns and their entity sub-columns — blank
      // everywhere else, including Grand Total in every case.
      const applies = (c, idx) => row.kind === 'month' ? isRealMonthCol_(c)
        : row.kind === 'quarter' ? isQuarterCol_(c)
        : row.kind === 'half' ? isHalfCol_(c)
        : row.kind === 'month-entity-aware' ? appliesToMonthEntityAware_(c, idx)
        : row.kind === 'runrate-prev-q' ? (appliesToMonthEntityAware_(c, idx) && runRatePreviousQuarterApplies_(idx))
        : appliesToMoveAware_(c, idx);
      const rawByCol = new Array(columns.length).fill(null);
      columns.forEach((c, idx) => { if (applies(c, idx)) rawByCol[idx] = row.rawFn(idx); });
      return {
        label: row.label,
        format: EXPORT_NUMBER_FORMAT.pct,
        values: columns.map((c, idx) => applies(c, idx) ? row.fn(idx) : ''),
        highlights: computeHighlightCols_(rawByCol),
      };
    });

    dataRowDefs.forEach(def => {
      // Blank divider row — added 2026-08-31 per Zoltraak ("add new blank line after claim
      // vouchers"). Normally isHeader rows are excluded entirely from the export (see
      // dataRowDefs' own filter comment), but this one opts back in via exportBlankRow so it can
      // anchor the g6 collapse button in Excel too ("let the blank line after line claim vouchers
      // have its own button expand collapse as well both dashboard and excel") — write a row with
      // no VALUES/highlight (breakdown/pct/mogtm/formula logic all assume a real metric key, none
      // of which apply here) but WITH a label. `rowLabels.push(def.label || '')` FIXED 2026-08-31
      // (third round) — was hardcoded to '' (genuinely blank), which was correct back when this
      // row's own `label` was always "" too, but silently would have dropped the row's name from
      // the export entirely once Zoltraak named this row ("name it: Claim based on Sell in") and
      // added a second one ("Claim based on Sell Out") — both need their label to actually show in
      // the Excel sheet, not just on the dashboard.
      if (def.exportBlankRow) {
        rowLabels.push(def.label || '');
        rowFormats.push('#,##0');
        rowIsBold.push(false);
        values.push(columns.map(() => ''));
        rowHighlights.push({ highest: [], lowest: [] });
        rowNumberByKey[def.key] = sheetRow;
        sheetRow += 1;
        return;
      }

      // Row label must match what the dashboard itself displays for this metric — per Zoltraak
      // 2026-08-26 ("nama linenya tolong sesuainya yang ditampilkan di dashboard, contoh sales of
      // goods, jangan price total after subsidy"). def.tag alone is the RAW Data Claim column name
      // for a handful of rows (sales/claim/rbp) — TABLE2_LABEL_OVERRIDES is the exact same lookup
      // the dashboard's own "Table 2" (financeBodyHtml) already uses to show "Sales of Goods"/
      // "Rebates"/"COGS" instead of "Price_Total_After_Subsidy"/"Claim"/"RBP_VAT_Total" — checked
      // first here so the export always matches. Every other row's def.label/def.tag already reads
      // as a human-readable dashboard name (e.g. "Gross Profit", "Pick Pack"), so this is a no-op
      // for them.
      rowLabels.push(TABLE2_LABEL_OVERRIDES[def.key] || def.label || def.tag || def.key);
      // Average Basket Size is now Quantity / Number of Order (a small ratio), so it needs 2 decimals.
      rowFormats.push(def.key === 'abs' ? EXPORT_NUMBER_FORMAT.decimal : (EXPORT_NUMBER_FORMAT[def.fmt] || '#,##0'));
      rowIsBold.push(true);
      // Highlight is scored against these plain numbers BEFORE the EXPORT_FORMULA_ROWS pass below
      // may overwrite specific cells with a live formula string — see computeHighlightCols_'s own
      // comment on why that's still correct (deriveMetrics/computeGrand already compute the exact
      // same number that formula would evaluate to).
      const mainRowRaw = columns.map(c => {
        // Average Basket Size plain twin (for highlight) must match the new formula: Qty / Number of Order.
        if (def.key === 'abs') {
          const q = (c.data && c.data.qty) || 0, u = (c.data && c.data.uniq) || 0;
          return u ? q / u : 0;
        }
        const v = (c.data && c.data[def.key]) || 0;
        return def.abs ? Math.abs(v) : v;
      });
      values.push(mainRowRaw);
      rowHighlights.push(computeHighlightCols_(mainRowRaw));
      rowNumberByKey[def.key] = sheetRow;
      // g5/g6 span tracking — see this variables' own declaration comment above. Recorded here
      // (rather than after the breakdown/pct blocks below) since g5/g6's own rows (claim/rebates
      // detail, and the 6 new claim-detail placeholder rows) are all EXPORT_VALUE_ONLY_BREAKDOWN_
      // ineligible plain rows with no breakdown/pct sub-rows of their own, so their span is exactly
      // this one main row.
      if (def.key === 'claim10PctCogs') g5Start = sheetRow;
      if (def.key === 'claimVouchers') g5End = sheetRow;
      if (def.key === 'claimSTTI') g6Start = sheetRow;
      // g6End anchor MOVED 2026-09-01 per Zoltraak — priceClawbackDropPrice is no longer g6's last
      // member (see OUTRIGHT_ROW_DEFS' own comment on its move to directly below Other Revenue);
      // claimQuarterlyIncentives is now g6's actual last remaining row.
      if (def.key === 'claimQuarterlyIncentives') g6End = sheetRow;
      // g9/g10 span tracking — see those variables' own declaration comment above.
      if (def.key === 'marketplaceFeeSellIn') g9Row = sheetRow;
      if (def.key === 'warehouseFeeSellIn') g10Row = sheetRow;
      sheetRow += 1;

      // "% Cont. to SoG" ("% Contribution to Sales of Goods") — added 2026-08-26 per Zoltraak,
      // RENAMED + REPOSITIONED 2026-08-27 (was "% of Sales of Goods"), further revised the same day
      // (own row now ALSO collapsible; MOGTM Distributor Fee added; a blank spacer row now
      // separates the two collapse groups when both exist). Always the same underlying share
      // pctOfSalesNote_ already shows as a small grey note under a row's own number on the
      // dashboard (Rebates, Other Revenue, COGS, Surplus, Promo Fund Front/Back Margin, Platform
      // Fee Absorb by SIRCLO, Pick Pack, Rent Warehouse, Consumables, Total Operational and
      // Fulfillment Cost) plus MOGTM Distributor Fee (see EXPORT_PLAIN_PCT_CONT_EXTRA_KEYS — its
      // own on-screen cellNote is the UNRELATED effectiveMogtmRate note and is untouched) — but now
      // ALSO extended to Sales of Goods' own entity breakdown (which never had a pctOfSalesNote_
      // cellNote before) and to every OTHER money-type entity-breakdown row (Gross Profit,
      // Contribution Margin, and now Number of Order/Quantity — see METRIC_BREAKDOWN_ROW_KEYS),
      // since Zoltraak's own example put it under the Sales of Goods store breakdown specifically.
      // `built.showPctOfSales` still gates this to only the 3 "Per Period per <dimension>" sheets.
      //
      // Two distinct shapes, decided by whether this row ACTUALLY has entity breakdown data this
      // export run (not just whether it's structurally one of METRIC_BREAKDOWN_ROW_KEYS — a
      // single-store export has no real breakdown, and should fall back to the plain row below):
      //
      //   (a) Entity breakdown rows exist below this metric (Sales of Goods, Gross Profit, Total
      //       Operational and Fulfillment Cost, Contribution Margin, Number of Order, Quantity —
      //       NOT the two ratio rows % Gross Profit/% Contribution Margin, same money-vs-ratio
      //       suppression the dashboard's own breakdown "grandNote" already applies): per
      //       Zoltraak's own example —
      //         Sales of Goods
      //            Betadine Official Store
      //            Betadine Store
      //                                          <- blank spacer row, own toggle
      //            % Cont. to SoG Betadine Official Store
      //            % Cont. to SoG Betadine Store
      //       — ALL the plain breakdown value rows first, THEN a single blank spacer row (own
      //       row — never part of either collapse group — so the two groups' own toggle controls
      //       land on clearly separate rows instead of butting up against each other: "tolong
      //       tambahkan 1 line kosong... tujuannya agar tools expand collapsenya bisa dipisah"),
      //       THEN one "% Cont. to SoG <entity>" row per entity (same order), in its OWN separate
      //       expand/collapse row group ("buat expand collapse tools juga").
      //   (b) No real entity breakdown for this row (either it's a "simple" row that was never
      //       breakdown-eligible, e.g. Rebates/COGS, or it structurally IS breakdown-eligible —
      //       Total Operational and Fulfillment Cost — but this specific export has nothing to
      //       break down, e.g. a single standalone store): ONE plain "% Cont. to SoG" row directly
      //       under the metric — ALSO wrapped in its own single-row collapse group now ("untuk line
      //       % Cont. to SoG tolong tetap tambahkan expand collapse untuk 1 baris tunggal tersebut
      //       ... agar tampilan barisnya tidak terlalu banyak"), collapsed by default same as
      //       every other group here.
      //
      // Both shapes use a LIVE formula (IFERROR(...,0)*100), never a plain number — even the
      // per-entity ones, referencing that SAME entity's own just-pushed breakdown row and the
      // Sales of Goods row in the same column. Sales of Goods (key 'sales') does NOT always appear
      // earlier in ROW_DEFS than every row that needs it — Number of Order/Quantity (keys
      // 'uniq'/'qty') sit before it — so `rowNumberByKey['sales']` is guaranteed populated here
      // only because of the pre-pass above, which computes every key's row number up front.
      const isBreakdownEligibleRow = METRIC_BREAKDOWN_ROW_KEYS.includes(def.key) || EXPORT_VALUE_ONLY_BREAKDOWN_KEYS.includes(def.key);
      const isRatioBreakdownRow = def.key === 'pctGp' || def.key === 'pctContributionMargin' || EXPORT_NO_ENTITY_PCT_ROW_KEYS.includes(def.key);
      // Value-only-breakdown rows (Rebates, Other Revenue, COGS, Surplus, MOGTM Distributor Fee,
      // Promo Fund Front/Back Margin — added 2026-08-27 per Zoltraak) — see
      // EXPORT_VALUE_ONLY_BREAKDOWN_KEYS' own comment for why these get breakdown VALUE rows (a1)
      // but never the per-entity "% Cont. to ..." rows (a2).
      const isValueOnlyBreakdownRow = EXPORT_VALUE_ONLY_BREAKDOWN_KEYS.includes(def.key);
      const breakdownEntries = (built.rowBreakdown && isBreakdownEligibleRow) ? built.rowBreakdown(def.key) : null;
      const hasRealBreakdown = !!(breakdownEntries && breakdownEntries.length);
      const salesRow = rowNumberByKey.sales;
      // "% Cont. to SoG" vs "% Cont. to GP" vs "% Cont. to CM" vs "% Cont. to NoD" vs "% Cont. to
      // Qty" — REVISED 2026-08-27 per Zoltraak: Gross Profit and Contribution Margin's own
      // per-entity breakdown percentage no longer divides by Sales of Goods (which would
      // double-count Rebates/COGS/etc. already folded into GP/CM) — it divides by THAT SAME ROW's
      // own total instead (e.g. a store's Contribution Margin share of the COMBINED Contribution
      // Margin across every store in this column), per his own example: "Betadine Official Store
      // 315,188,023 / (315,188,023 + 11,702,128) * 100%" — the denominator is the sum of every
      // entity's own Contribution Margin figure for that column, i.e. the metric row's own value
      // (rowNumberByKey[def.key], already known at this point in the loop).
      // FURTHER REVISED same day, per Zoltraak's follow-up ("breakdown line numbers of order dan
      // Quantity adalah % Cont. to NoD ... dan % Cont. to Qty ... saat ini masih % Cont. to SoG
      // tolong direvisi") — Number of Order (key 'uniq') and Quantity (key 'qty') get the exact
      // same "own row total" denominator treatment as GP/CM (each divided by the combined
      // Number of Order / Quantity across every entity in that column, NOT Sales of Goods), with
      // their own abbreviated labels. Every OTHER money-type breakdown row (Sales of Goods itself,
      // Total Operational and Fulfillment Cost) is UNCHANGED — still "% Cont. to SoG", still
      // divided by Sales of Goods.
      const pctContLabel = def.key === 'contributionMargin' ? '% Cont. to CM'
        : def.key === 'gp' ? '% Cont. to GP'
        : def.key === 'uniq' ? '% Cont. to NoD'
        : def.key === 'qty' ? '% Cont. to Qty'
        : '% Cont. to SoG';
      const pctContDenominatorRow = (def.key === 'contributionMargin' || def.key === 'gp' || def.key === 'uniq' || def.key === 'qty')
        ? rowNumberByKey[def.key] : salesRow;
      // REVISED 2026-10-14 per Zoltraak: Total Operational and Fulfillment Cost + its components
      // (see EXPORT_PCT_OF_BASE_ROW_KEYS) divide by SoG + Rebates + Other Revenue + the Claim detail
      // rows (see EXPORT_PCT_BASE_KEYS) instead of Sales of Goods alone, and carry the label
      // EXPORT_PCT_BASE_LABEL — applies to both the plain "% Cont." row (b)
      // and, for Total Operational and Fulfillment Cost, the per-entity "% Cont." rows (a2) below.
      const usePctBase = EXPORT_PCT_OF_BASE_ROW_KEYS.includes(def.key);
      // Rows that want the plain "% Cont. to SoG" treatment even though their OWN cellNote isn't a
      // pctOfSalesNote_-tagged function (i.e. they show some OTHER kind of note on-screen, or none
      // at all) — currently just MOGTM Distributor Fee, added 2026-08-27 per Zoltraak ("tambahkan
      // % Cont. to SoG pada line MOGTM Distribution Fee juga"); mogtmFee's own on-screen cellNote
      // (effectiveMogtmRate-based) is a completely different, unrelated feature and stays untouched
      // — this only affects which rows the EXPORT additionally covers. The plain row is ALWAYS "%
      // Cont. to SoG" (never renamed to GP/CM — gp/contributionMargin never reach this path anyway,
      // since neither carries a pctOfSalesNote_ tag nor sits in EXPORT_PLAIN_PCT_CONT_EXTRA_KEYS).
      const plainPctSource = (def.cellNote && def.cellNote.pctOfSalesKey)
        ? { noteKey: def.cellNote.pctOfSalesKey, useAbs: def.cellNote.pctOfSalesUseAbs }
        : (EXPORT_PLAIN_PCT_CONT_EXTRA_KEYS.includes(def.key) ? { noteKey: def.key, useAbs: false } : null);

      // New line directly under Total Operational and Fulfillment Cost (see TOTAL_OPCOST_PCT_SHEETS): live formula =
      // this column's Total Operational and Fulfillment Cost / this column's Total Revenue base. Written above the
      // entity value rows, outside any collapse group, so it is always visible.
      if (def.key === 'totalOpCost' && TOTAL_OPCOST_PCT_SHEETS.includes(dim.sheetName)) {
        const opCostRow = rowNumberByKey.totalOpCost;
        rowLabels.push('   ' + TOTAL_OPCOST_PCT_LABEL);
        rowFormats.push(EXPORT_NUMBER_FORMAT.pct);
        rowIsBold.push(false);
        const opCostPctRaw = columns.map(c => {
          const base = pctBaseRaw_(c);
          return base ? (((c.data && c.data.totalOpCost) || 0) / base) * 100 : 0;
        });
        values.push(columns.map((c, colIdx) => {
          const colLetter = columnLetter_(colIdx + 3);
          const baseExpr = pctBaseExpr_(colLetter);
          return baseExpr ? `=IFERROR(${colLetter}${opCostRow}/${baseExpr}*100,0)` : opCostPctRaw[colIdx];
        }));
        rowHighlights.push(computeHighlightCols_(opCostPctRaw));
        sheetRow += 1;
      }

      if (hasRealBreakdown) {
        // (a1) Plain breakdown VALUE rows first — unchanged from before this revision, and now also
        // covers the new value-only-breakdown rows. Sorted biggest-contribution-first (already done
        // by computeExportEntityBreakdown_/computeExportStoreBreakdown_). Plain numbers only — never
        // a live formula, matching the dashboard's own breakdown rows (also always plain values).
        const valueGroupStart = sheetRow;
        breakdownEntries.forEach(entry => {
          rowLabels.push('   ' + entry.label); // indented — a plain "this is a sub-row" cue.
          rowFormats.push(def.key === 'abs' ? EXPORT_NUMBER_FORMAT.decimal : (EXPORT_NUMBER_FORMAT[def.fmt] || '#,##0')); // Average Basket Size keeps its 2 decimals
          rowIsBold.push(false);
          // entry.values was built against `built.rowBreakdown`'s OWN (pre-entity-column-breakdown)
          // period-column list — remap each value onto its new position via origToNewIdx (see that
          // variable's own comment), 0 everywhere else, including every entity sub-column position:
          // this ROW-breakdown feature is already at its own finest per-entity granularity (one
          // entity per ROW here), so it doesn't further decompose by column-entity too.
          const remapped = new Array(columns.length).fill(0);
          // Separate from `remapped` above — highlight comparison keeps a genuine "no data that
          // period" as null (excluded from the row's own highest/lowest), rather than the 0 the
          // written cell shows (spreadsheets have no dashboard-style "—" dash convention).
          const highlightArr = new Array(columns.length).fill(null);
          entry.values.forEach((v, i) => {
            const newIdx = origToNewIdx[i];
            remapped[newIdx] = v === null ? 0 : v;
            if (v !== null) highlightArr[newIdx] = v;
          });
          // Diagonal fill — added 2026-09-23 per Zoltraak's porting instructions (entity-column
          // breakdown: metric row + breakdown row sama-sama terisi): the entity-breakdown COLUMN
          // belonging to the SAME entity as THIS breakdown row is filled with that entity's own
          // real value (not 0) — read directly from columns[idx].data[def.key], not through
          // entry.values/origToNewIdx, because entity-breakdown columns have no index in
          // entry.values (which only contains the original period columns, before the per-entity
          // column split).
          columns.forEach((c, idx) => {
            if (c.isEntityBreakdown && c.label === entry.label) {
              const v2 = (c.data && c.data[def.key]) || 0;
              remapped[idx] = v2;
              highlightArr[idx] = v2;
            }
          });
          values.push(remapped);
          rowHighlights.push(computeHighlightCols_(highlightArr));
          sheetRow += 1;
        });
        rowGroups.push({ start: valueGroupStart, end: sheetRow - 1 });
        // Capture this key's per-entity breakdown row-start — see storeEntityRowStartByKey's own
        // declaration comment above. Unconditional (every breakdown-eligible key, not just the 6
        // LIVE_FORMULA_BREAKDOWN_KEYS), since GP/CM's live formulas need their dependency keys'
        // (sales/claim10PctCogs/etc) own entity row-starts too.
        storeEntityRowStartByKey[def.key] = valueGroupStart;
        storeEntityCount = breakdownEntries.length;

        // (a2) One "% Cont. to SoG/GP/CM <entity>" row per entity, in the SAME order, right after a
        // blank spacer row — skipped for the two ratio rows (a store's own % Gross Profit or %
        // Contribution Margin divided by a dollar figure isn't a meaningful number) AND for the new
        // value-only-breakdown rows (per Zoltraak: "tidak perlu tampilkan % Cont. to SoG ... hanya
        // value saja").
        if (built.showPctOfSales && !isRatioBreakdownRow && !isValueOnlyBreakdownRow && pctContDenominatorRow) {
          // Blank spacer row — deliberately OUTSIDE both row groups (never added to rowGroups), so
          // it always stays visible and visually/functionally separates the two collapse toggles.
          rowLabels.push('');
          rowFormats.push(EXPORT_NUMBER_FORMAT[def.fmt] || '#,##0');
          rowIsBold.push(false);
          values.push(columns.map(() => ''));
          rowHighlights.push({ highest: [], lowest: [] });
          sheetRow += 1;

          const pctGroupStart = sheetRow;
          breakdownEntries.forEach((entry, idx) => {
            const ownRow = valueGroupStart + idx; // this SAME entity's own value row, just pushed above
            rowLabels.push('   ' + (usePctBase ? EXPORT_PCT_BASE_LABEL : pctContLabel) + ' ' + entry.label);
            rowFormats.push(EXPORT_NUMBER_FORMAT.pct);
            rowIsBold.push(false);
            values.push(columns.map((c, colIdx) => {
              const colLetter = columnLetter_(colIdx + 3);
              const denomExpr = (usePctBase && pctBaseExpr_(colLetter)) || `${colLetter}${pctContDenominatorRow}`;
              return `=IFERROR(${colLetter}${ownRow}/${denomExpr}*100,0)`;
            }));
            // Plain-number twin for highlight purposes only — this entity's own raw value (from
            // `entry.values`, pre-remap) divided by the SAME denominator the live formula above
            // references (either that column's Sales of Goods total, or this metric row's own
            // combined total across every entity — see pctContDenominatorRow's own comment).
            const pctHighlightArr = new Array(columns.length).fill(null);
            entry.values.forEach((v, i) => {
              if (v === null) return;
              const newIdx = origToNewIdx[i];
              const denomCol = columns[newIdx];
              const denom = usePctBase
                ? pctBaseRaw_(denomCol)
                : (pctContDenominatorRow === salesRow
                  ? ((denomCol.data && denomCol.data.sales) || 0)
                  : ((denomCol.data && denomCol.data[def.key]) || 0));
              pctHighlightArr[newIdx] = denom ? (v / denom) * 100 : 0;
            });
            rowHighlights.push(computeHighlightCols_(pctHighlightArr));
            sheetRow += 1;
          });
          rowGroups.push({ start: pctGroupStart, end: sheetRow - 1 });
        }
      }

      // The plain single "% Cont. to SoG" row — skipped ONLY when this row already got the
      // entity-level pct block (a2) above; a value-only-breakdown row keeps its OWN plain row even
      // though it also got breakdown value rows (a1), since (a2) never runs for it.
      const skipPlainRow = hasRealBreakdown && !isValueOnlyBreakdownRow;
      if (!skipPlainRow && built.showPctOfSales && plainPctSource) {
        // (b) No real entity-level pct block for this row — the plain single-row treatment, wrapped
        // in its own single-row collapse group (collapsed by default, same as every other group
        // here). Always "% Cont. to SoG" divided by Sales of Goods, regardless of isValueOnlyBreakdownRow.
        const noteKey = plainPctSource.noteKey;
        const useAbs = plainPctSource.useAbs;
        const ownRow = rowNumberByKey[def.key];
        const plainRowStart = sheetRow;
        // Platform Fee Absorb by SIRCLO (EXPORT_PCT_ALSO_SOG_ROW_KEYS) keeps its "% Cont. to SoG" row and
        // gets a second "% Cont. to Total Revenue" row directly beneath it; every other row has just one
        // row, on the Total Revenue base when usePctBase (see EXPORT_PCT_OF_BASE_ROW_KEYS) else on SoG.
        const alsoSogRow = usePctBase && EXPORT_PCT_ALSO_SOG_ROW_KEYS.includes(def.key);
        const pctRowVariants = alsoSogRow ? [false, true] : [usePctBase];
        pctRowVariants.forEach(useBaseForRow => {
          rowLabels.push('   ' + (useBaseForRow ? EXPORT_PCT_BASE_LABEL : '% Cont. to SoG'));
          rowFormats.push(EXPORT_NUMBER_FORMAT.pct);
          rowIsBold.push(false);
          // Plain-number version computed regardless of which branch below actually gets written to
          // the cell — used only to decide this row's own highest/lowest highlighting.
          const plainPctRaw = columns.map(c => {
            const salesVal = useBaseForRow ? pctBaseRaw_(c) : ((c.data && c.data.sales) || 0);
            if (!salesVal) return 0;
            const raw = (c.data && c.data[noteKey]) || 0;
            return ((useAbs ? Math.abs(raw) : raw) / salesVal) * 100;
          });
          if (salesRow) {
            values.push(columns.map((c, colIdx) => {
              const colLetter = columnLetter_(colIdx + 3);
              const cellRef = useAbs ? `ABS(${colLetter}${ownRow})` : `${colLetter}${ownRow}`;
              const denomExpr = (useBaseForRow && pctBaseExpr_(colLetter)) || `${colLetter}${salesRow}`;
              return `=IFERROR(${cellRef}/${denomExpr}*100,0)`;
            }));
          } else {
            // Defensive fallback (should never trigger on OUTRIGHT_ROW_DEFS, where Sales of Goods
            // always exists) — a plain computed number instead of a formula referencing a row that
            // doesn't exist in this sheet.
            values.push(plainPctRaw);
          }
          rowHighlights.push(computeHighlightCols_(plainPctRaw));
          sheetRow += 1;
        
        });
        rowGroups.push({ start: plainRowStart, end: sheetRow - 1 });
      }

      // (c) "% Cont. MOGTM to COGS" — added 2026-08-27 per Zoltraak: "line % Cont. to SOG pada
      // MOGTM Distributor Fee --> tambahkan 1 line lagi % Cont. MOGTM to COGS ... formulanya MOGTM
      // Distributor Fee khusus location yang ada naming 'MOGTM' dibagi COGS yang ada naming
      // 'MOGTM'" — example: June 2026, MOGTM - Betadine Solo (MNS) MOGTM Distributor Fee 48,800,464
      // / COGS (rbp) 574,123,107 = 8.5%. This is EXACTLY what effectiveMogtmRate(r) already computes
      // for the mogtmFee cellNote shown on the dashboard (mogtmFee — which deriveMetrics/computeGrand
      // already only ever sum from MOGTM-prefixed warehouses — divided by the matching MOGTM-only
      // COGS sum, c.data._mogtmRbp/warehouse-specific rbp depending on shape — see
      // effectiveMogtmRate's own comment for the 3 shapes it handles), reused here as a per-column
      // PLAIN NUMBER: there is no "MOGTM-only COGS" row materialized anywhere in this sheet to
      // reference with a live formula, same defensive-fallback reasoning the plain "% Cont. to SoG"
      // branch above already uses when no clean row reference exists. A DIFFERENT ratio from that
      // existing plain "% Cont. to SoG" row (which divides by TOTAL Sales of Goods, not MOGTM-only
      // COGS) — this is an ADDITIONAL row, not a replacement, own single-row collapse group.
      //
      // FIXED 2026-08-27 per Zoltraak's follow-up ("jika memang tidak ada value nya maka jangan
      // ditulis 2,5% tapi ditulis 0%"): effectiveMogtmRate(c.data) falls back to the GLOBAL DEFAULT
      // rate (MOGTM_FEE_RATE, 2.5%) whenever a column has no MOGTM-coded warehouse data at all (its
      // own comment: "a top-level/aggregate row... always fell back silently to MOGTM_FEE_RATE" —
      // that fallback exists so a genuine MOGTM column with rounding-edge-case zero COGS doesn't
      // divide-by-zero into garbage, NOT to invent a fee rate for a column that has no MOGTM presence
      // whatsoever). This row called it unconditionally, so a column with zero MOGTM Distributor Fee
      // (mogtmFee === 0) showed a misleading 2.5% instead of 0%. The dashboard's own on-screen
      // cellNote for this same metric already guards this exact case (`data.mogtmFee > 0 ? ... :
      // null`, see the mogtmFee ROW_DEFS entry above) — mirrored here: only call effectiveMogtmRate
      // when this column actually has a nonzero MOGTM fee, else write a plain 0.
      if (built.showPctOfSales && def.key === 'mogtmFee') {
        const mogtmCogsRow = sheetRow;
        rowLabels.push('   % Cont. MOGTM to COGS');
        rowFormats.push(EXPORT_NUMBER_FORMAT.pct);
        rowIsBold.push(false);
        const mogtmRow = columns.map(c => (c.data && c.data.mogtmFee > 0) ? effectiveMogtmRate(c.data) * 100 : 0);
        values.push(mogtmRow);
        rowHighlights.push(computeHighlightCols_(mogtmRow));
        sheetRow += 1;
        rowGroups.push({ start: mogtmCogsRow, end: mogtmCogsRow });
      }
    });

    // g5 (Rebates detail: Claim 10% COGS/Additional Budget Promo/Claim Vouchers) and g6 (the new
    // blank-line's detail: Claim STTI...Claim Quarterly Incentives — narrowed 2026-09-01 when Price
    // Claw back due to Drop Price moved out, see g6End's own comment above) native collapse groups —
    // pushed only if every anchor key above was actually found in this sheet's dataRowDefs (always
    // true in practice, since these are fixed ROW_DEFS entries, but guarded the same defensive way
    // EXPORT_FORMULA_ROWS lookups are elsewhere in this function).
    if (g5Start != null && g5End != null) rowGroups.push({ start: g5Start, end: g5End });
    if (g6Start != null && g6End != null) rowGroups.push({ start: g6Start, end: g6End });
    // g9/g10 — see those variables' own declaration comment above.
    if (g9Row != null) rowGroups.push({ start: g9Row, end: g9Row });
    if (g10Row != null) rowGroups.push({ start: g10Row, end: g10Row });
    // Master group spanning Number of Order through Average Basket Size — added 2026-09-01 per
    // Zoltraak ("at excel, give a master grouping rows from row Number of Order until Row Average
    // Basket Size"). Mirrors the dashboard's own g1 (uniq/qty/abs, though aov itself stays outside
    // g1 there — see OUTRIGHT_ROW_DEFS' own comment), but this is a NEW, Excel-only native row
    // group spanning all 4 rows CONTIGUOUSLY (Number of Order, Average Order Value, Quantity,
    // Average Basket Size all sit consecutively at the very top of every sheet — see OUTRIGHT_
    // ROW_DEFS' idx 1-4), independent of g1's own dashboard-only show/hide behavior.
    if (rowNumberByKey.uniq != null && rowNumberByKey.abs != null) {
      // The master group now also covers Average Basket Size's own per-entity rows when it has them.
      const absLastRow = storeEntityRowStartByKey.abs != null ? storeEntityRowStartByKey.abs + storeEntityCount - 1 : rowNumberByKey.abs;
      rowGroups.push({ start: rowNumberByKey.uniq, end: Math.max(rowNumberByKey.abs, absLastRow) });
    }

    dataRowDefs.forEach(def => {
      const makeFormula = EXPORT_FORMULA_ROWS[def.key];
      if (!makeFormula) return;
      const rowIdx = rowNumberByKey[def.key] - EXPORT_DATA_START_ROW; // back to a 0-based index into `values`
      columnHeaders.forEach((_, colIdx) => {
        // colIdx 0 is Sheets column C (colIdx + 3 = 3) — column A/1 is the row-label column and
        // column B/2 is the blank spacer column (see writeExportSheet_'s DATA_COL_ in Code.gs).
        const colLetter = columnLetter_(colIdx + 3);
        const formula = makeFormula(colLetter, rowNumberByKey);
        if (formula) values[rowIdx][colIdx] = formula;
      });
    });

    // Live formula for the per-entity BREAKDOWN rows of Gross Profit/%GP/GP per Order/Contribution
    // Margin/%CM/CM per Order — added 2026-09-23 per Zoltraak, ported from the Unilever Group fork
    // (google-sheets-dashboard skill). Mirrors the EXPORT_FORMULA_ROWS post-pass just above, but
    // runs once per breakdown ENTITY (not once for the combined metric row), with an entity-scoped
    // `entityRowOf` map so e.g. a Gross Profit breakdown row for "LOreal CPD" references CPD's OWN
    // Sales of Goods/Rebates/COGS/etc breakdown rows, not the combined Grand-Total-of-entities
    // metric row. Deliberately does NOT touch rowHighlights — highlight stays computed from the
    // plain numbers already written by the (a1) diagonal-fill pass above, exactly like the main
    // EXPORT_FORMULA_ROWS pass never touches rowHighlights either.
    [
      { startByKey: groupEntityRowStartByKey, count: groupEntityCount },
      { startByKey: storeEntityRowStartByKey, count: storeEntityCount },
    ].forEach(({ startByKey, count }) => {
      if (!count) return;
      LIVE_FORMULA_BREAKDOWN_KEYS.forEach(key => {
        const rowStart = startByKey[key];
        const makeFormula = EXPORT_FORMULA_ROWS[key];
        if (rowStart == null || !makeFormula) return;
        for (let idx = 0; idx < count; idx++) {
          const rowIdx = (rowStart + idx) - EXPORT_DATA_START_ROW; // 0-based index into `values`
          const entityRowOf = {};
          Object.keys(startByKey).forEach(k => { entityRowOf[k] = startByKey[k] + idx; });
          columnHeaders.forEach((_, colIdx) => {
            const colLetter = columnLetter_(colIdx + 3);
            const formula = makeFormula(colLetter, entityRowOf);
            if (formula) values[rowIdx][colIdx] = formula;
          });
        }
      });
    });

    // Pick Pack / Rent Warehouse / Consumables — "please activate the formula" per Zoltraak
    // 2026-08-31 (third round). Unlike EXPORT_FORMULA_ROWS above, these 3 rows have no OTHER row to
    // derive from (they're raw server-sourced costs, same as sales/claim/rbp — there's nothing
    // upstream to reference for a real-month cell), so instead every Quarter/Half/Grand Total ROLLUP
    // CELL in these 3 rows becomes a live cross-COLUMN SUM of its own real-month cells (e.g. Q1
    // 2026's Pick Pack cell becomes "=<Jan's cell>+<Feb's cell>+<Mar's cell>"), while every real-month
    // cell stays exactly what it always was — the plain server-sourced input number, since that IS
    // the base data being summed. Reuses sumCellsExpr_ (built above for the Run Rate rows) with
    // `entityLabel` set for an entity-breakdown rollup column (e.g. one store's own "Q1 2026"
    // sub-column), so that column's formula sums only THAT entity's own real-month cells, not every
    // entity's combined total — mirrors the SAME distinction sumCellsExpr_'s own callers above
    // already make for parentIdxs/entityLabel.
    // rentWarehouseCbm was added here 2026-09-12 (it had a main-table row of its own then), but that
    // row was removed 2026-09-14 per Zoltraak's reorder — CBM Usage now lives only in the Rate of
    // Operational and Fulfillment Cost panel below, which gives it the same "own row, own live
    // cross-column SUM formula" treatment directly in that panel's own block (see rateRowNumberByKey
    // there), so it no longer belongs in this dataRowDefs-scoped list.
    const EXPORT_PERIOD_SUM_ROW_KEYS = ['pickPack', 'rentWarehouse', 'consumables'];
    EXPORT_PERIOD_SUM_ROW_KEYS.forEach(key => {
      const rowNum = rowNumberByKey[key];
      if (!rowNum) return;
      const rowIdx = rowNum - EXPORT_DATA_START_ROW;
      columns.forEach((c, colIdx) => {
        if (!c.months || c.months.length < 2) return; // a real-month cell — stays a plain input number
        const realMonthIdxs = c.months.map(m => realMonthColIdx[m]).filter(i => i !== undefined);
        if (!realMonthIdxs.length) return; // defensive — nothing to sum, leave the plain number in place
        const entityLabel = c.isEntityBreakdown ? c.label : null;
        values[rowIdx][colIdx] = `=${sumCellsExpr_(realMonthIdxs, rowNum, entityLabel)}`;
      });
    });

    // Rate of Operational and Fulfillment Cost — added 2026-08-28 per Zoltraak ("please include
    // this table Rate of Operational and Fulfillment Cost: in our google spreadsheet per each tab
    // sheet as well"). Mirrors the dashboard's own standalone table 3 (rateBodyHtml/RATE_ROW_DEFS):
    // each of the 3 cost rows (Pick Pack/Rent Warehouse/Consumables) already got its own row above
    // in the main dataRowDefs pass (rowNumberByKey.pickPack/rentWarehouse/consumables), so this
    // writes a LIVE per-column formula dividing each by Number of Order's own row
    // (rowNumberByKey.uniq) — the exact same math rateOf(data, key) = data[key] / data.uniq already
    // uses on-screen — rather than a plain computed number, consistent with every other derived row
    // this function writes (% Cont. to SoG, % Move, % Run Rate, ...). Own header divider row (not
    // part of any collapse group, same convention the prefix-rows block above uses for its own row
    // 1) followed by the 3 rate rows in one combined expand/collapse group.
    {
      // Blank spacer row — added 2026-09-01 per Zoltraak ("give blank line in excel above line Rate
      // of Operational and Fulfillment Cost:"): a purely visual separator between the main metrics
      // table above and this standalone Rate panel, same blank-row shape every other divider in this
      // function uses (empty label, empty values, no highlight). Carries no rowGroups entry of its
      // own and sits OUTSIDE rateGroupStart/sheetRow-1 below — the expand/collapse toggle stays
      // anchored starting at the header row itself right below this line, unaffected by the new gap
      // above it ("the expand collapse tools still starting at line Rate of Operational and
      // Fulfillment Cost:").
      rowLabels.push('');
      rowFormats.push('#,##0');
      rowIsBold.push(false);
      values.push(columns.map(() => ''));
      rowHighlights.push({ highest: [], lowest: [] });
      sheetRow += 1;

      rowLabels.push('Rate of Operational and Fulfillment Cost:');
      rowFormats.push('#,##0');
      rowIsBold.push(true);
      values.push(columns.map(() => ''));
      rowHighlights.push({ highest: [], lowest: [] });
      sheetRow += 1;

      const uniqRow = rowNumberByKey.uniq;
      const rateGroupStart = sheetRow;
      // rateRowNumberByKey: this Rate panel's OWN row number for each RATE_ROW_DEFS key — mirrors
      // the main dataRowDefs pass's rowNumberByKey pre-computation (see its own comment above), but
      // scoped to just these 4 rows. Needed because CBM Usage's main-table row was removed 2026-09-14
      // per Zoltraak's reorder (it used to live in dataRowDefs/rowNumberByKey as `rentWarehouseCbm`,
      // and this panel's own CBM Usage / Rent Warehouse per CBM rows used to cross-reference THAT
      // row) — CBM Usage now only exists here, so both this panel's own CBM Usage row and its Rent
      // Warehouse per CBM row (which divides by CBM Usage) must reference this new map instead.
      // Precomputed up front (each row below consumes exactly one sheetRow, in RATE_ROW_DEFS order)
      // so Rent Warehouse per CBM — written BEFORE CBM Usage in the new Pick Pack/Consumables/Rent
      // Warehouse per CBM/CBM Usage order — already knows CBM Usage's row number when it needs it.
      const rateRowNumberByKey = {};
      let rateRowCursor = rateGroupStart;
      RATE_ROW_DEFS.filter(def => !def.isHeader).forEach(def => {
        rateRowNumberByKey[def.key] = rateRowCursor;
        rateRowCursor += 1;
      });
      // CBM Usage / Rent Warehouse per CBM (added 2026-09-12 per Zoltraak's Rent Warehouse CBM
      // reassessment) don't fit the "cost ÷ Number of Order" shape every other row here still uses
      // (Pick Pack/Consumables, untouched) — see RATE_ROW_DEFS' own comment — so they get their own
      // branches below instead of forcing them through the generic costRow/uniqRow formula.
      RATE_ROW_DEFS.filter(def => !def.isHeader).forEach(def => {
        rowLabels.push(def.tag);
        rowFormats.push(EXPORT_NUMBER_FORMAT[def.fmt || 'money']);
        rowIsBold.push(false);
        if (def.key === 'rentWarehouseCbm') {
          // Own row now (its main-table row was removed 2026-09-14) — plain server-sourced number on
          // real-month columns, live cross-column SUM formula on Half/Quarter/Grand-Total columns,
          // exactly the same treatment EXPORT_PERIOD_SUM_ROW_KEYS gives Pick Pack/Rent
          // Warehouse/Consumables above (reuses the same sumCellsExpr_ helper).
          const ownRow = rateRowNumberByKey.rentWarehouseCbm;
          const rawTwin = columns.map(c => (c.data && c.data.rentWarehouseCbm) || 0);
          values.push(columns.map((c, colIdx) => {
            if (!c.months || c.months.length < 2) return rawTwin[colIdx]; // real-month column -> plain input number
            const realMonthIdxs = c.months.map(m => realMonthColIdx[m]).filter(i => i !== undefined);
            if (!realMonthIdxs.length || !ownRow) return rawTwin[colIdx]; // defensive — nothing to sum
            const entityLabel = c.isEntityBreakdown ? c.label : null;
            return `=${sumCellsExpr_(realMonthIdxs, ownRow, entityLabel)}`;
          }));
          rowHighlights.push(computeHighlightCols_(rawTwin));
        } else if (def.key === 'rentWarehousePerCbm') {
          // REVERTED 2026-09-14 per Zoltraak ("agar align... ubah logicnya menjadi = Rent
          // Warehouse/Number Of Order"): back to the unconditional Cost ÷ Number of Order formula —
          // no more CBM-based branching. The CBM-vs-uniq distinction is now purely an on-screen
          // informational remark (rentWarehouseBasisNote_ in Dashboard.html), not reflected in the
          // export sheet's own formula. Was:
          // `=IFERROR(IF(${cbmCell}=0,${costCell}/${uniqCell},${costCell}/${cbmCell}),0)`.
          const costRow = rowNumberByKey.rentWarehouse;
          const rawTwin = columns.map(c => (c.data && c.data.rentWarehousePerCbm) || 0);
          values.push(columns.map((c, colIdx) => {
            if (!costRow || !uniqRow) return 0;
            const colLetter = columnLetter_(colIdx + 3);
            const costCell = `${colLetter}${costRow}`;
            const uniqCell = `${colLetter}${uniqRow}`;
            return `=IFERROR(${costCell}/${uniqCell},0)`;
          }));
          rowHighlights.push(computeHighlightCols_(rawTwin));
        } else {
          const costRow = rowNumberByKey[def.key];
          // Plain-number twin (same rateOf(data,key) = data[key]/data.uniq math the live formula
          // below encodes) — used only for this row's own highest/lowest highlighting.
          const rateRaw = columns.map(c => {
            const uniqVal = (c.data && c.data.uniq) || 0;
            const costVal = (c.data && c.data[def.key]) || 0;
            return uniqVal ? costVal / uniqVal : 0;
          });
          values.push(columns.map((c, colIdx) => {
            // Defensive fallback (should never trigger on OUTRIGHT_ROW_DEFS, where Number of Order
            // and Pick Pack/Consumables always exist) — same "no row to reference -> plain 0" guard
            // the "% Cont. to SoG" plain-row fallback above uses.
            if (!costRow || !uniqRow) return 0;
            const colLetter = columnLetter_(colIdx + 3);
            return `=IFERROR(${colLetter}${costRow}/${colLetter}${uniqRow},0)`;
          }));
          rowHighlights.push(computeHighlightCols_(rateRaw));
        }
        sheetRow += 1;
      });
      rowGroups.push({ start: rateGroupStart, end: sheetRow - 1 });
    }

    // built.columnGroups uses 0-based indices into `columns`; Code.gs wants real 1-based Sheets
    // column numbers (+3, not +2 — column A is the row-label column and column B is the blank,
    // very-thin spacer column added 2026-08-31 per Zoltraak, which must never fall inside a group —
    // see writeExportSheet_'s DATA_COL_ comment in Code.gs).
    const columnGroups = (built.columnGroups || []).map(g => ({ start: g.startIdx + 3, end: g.endIdx + 3, depth: g.depth }));

    // The 5 prefix metric rows (rows 2-6, right after the row-1 header) get ONE combined
    // expand/collapse group — per Zoltraak's "Berikan tools expand collapse dari baris ke 1-6",
    // read together with his correction that row 1 is the header (excluded from the group, always
    // visible — confirmed with Zoltraak) and rows 2-6 are the 5 metrics themselves. Pushed onto the
    // SAME rowGroups array as every other block so Code.gs's applyExportRowGroups_ needs no
    // special-casing.
    rowGroups.push({ start: EXPORT_HEADER_ROW + 1, end: EXPORT_HEADER_ROW + prefixRows.length });

    return {
      sheetName: dim.sheetName,
      columnHeaders: columnHeaders,
      prefixRows: prefixRows, // rows 2-6 (written right after the row-1 header) — see EXPORT_HEADER_ROW's own comment for the full layout.
      rowLabels: rowLabels,
      rowFormats: rowFormats,
      rowIsBold: rowIsBold,
      values: values,
      rowHighlights: rowHighlights, // {highest, lowest} per row — see computeHighlightCols_'s own comment.
      columnGroups: columnGroups,
      rowGroups: rowGroups,
      // Freeze everything from the top through the Sales of Goods row — added 2026-08-28 per
      // Zoltraak ("freeze line at line sales of goods"), replacing the old fixed "header + 5 prefix
      // rows only" freeze. rowNumberByKey.sales is already known here (set in the main dataRowDefs
      // pass above, right when Sales of Goods' own row is written) — Code.gs's writeExportSheet_
      // just calls sheet.setFrozenRows(this number) instead of its old hardcoded computation.
      freezeRows: rowNumberByKey.sales,
    };
  }).filter(Boolean);

  // ====================== SELECTED SHEETS (virtual group exports) ======================
  // REVISED 2026-10-12 per Zoltraak ("di export excel tidak langsung ditarik semua sheet sub division
  // ketika memilih LOreal Group, tapi munculkan selection option di popup setelah klik run (sampai
  // level single official store)"), then again the same day ("tetap ada pilihan untuk export LOreal
  // group tersendiri" + "ketika memilih store atau divisi, tarikan LOreal group tidak ikut"): which
  // sheets come out is now driven ONLY by `opts`, built from the export-selection popup
  // (openExportSelectModal_ -> confirmExportSelect_, and BrandPicker.html for the FSOP runner):
  //   - opts.includeGroup (default true): whether the exported group's OWN trio of sheets is included.
  //     The popup ticks it by default and un-ticks it when a division/store is ticked.
  //   - opts.subEntities: node names (divisions and/or real stores, at any depth under the group)
  //     that also get their own sheets.
  //   - opts.dimensions ({summary, warehouse, marketplace}, each default true): ONE global toggle set
  //     applied to every included node's sheets, the group's own trio included.
  // No opts at all (a direct export of a lone store, exportFsopFromSettings, ...) = the group's own
  // 3 sheets exactly as before — sub-division sheets are never pulled automatically any more.
  //
  // Each selected node reuses buildExportPayload_ ITSELF, recursively, on `DATA.filter(r => r.brand
  // === nodeName)` (DATA holds precomputed rows for virtual nodes too) — no sheet-building logic is
  // duplicated. The recursive call passes NO opts, so it can never fan out further by itself.
  //
  // Sheet naming: <name> (summary), <name> - Warehouse, <name> - Marketplace. The extra sheets are
  // inserted right after the group's own "Per Period per Store" sheet (or first, if that one is
  // switched off), ahead of the group's own Warehouse/Marketplace sheets, in the order of
  // opts.subEntities (the popup passes tree order).
  const optsGiven = !!opts && typeof opts === 'object';
  const subEntities = (optsGiven && Array.isArray(opts.subEntities)) ? opts.subEntities : [];
  const includeGroup = !optsGiven || opts.includeGroup !== false;
  const dims = Object.assign({ summary: true, warehouse: true, marketplace: true }, (optsGiven && opts.dimensions) || {});
  const wantedByName = {
    'Per Period per Store': dims.summary,
    'Per Period per Warehouse': dims.warehouse,
    'Per Period per Marketplace': dims.marketplace,
  };
  const finalSheets = sheets.filter(s => includeGroup && (!optsGiven || wantedByName[s.sheetName]));
  if (subEntities.length) {
    const storeSheetIdx = finalSheets.findIndex(s => s.sheetName === 'Per Period per Store');
    const insertAt = storeSheetIdx >= 0 ? storeSheetIdx + 1 : 0;
    const usedNames = new Set(finalSheets.map(s => s.sheetName));
    const extraSheets = [];
    subEntities.forEach(entityName => {
      const entityRows = DATA.filter(r => r.brand === entityName);
      if (!entityRows.length) return; // no data in the current dataset — skip silently.
      const entityPayload = buildExportPayload_(entityRows);
      entityPayload.sheets.forEach(sheet => {
        if (!wantedByName[sheet.sheetName]) return;
        if (sheet.sheetName === 'Per Period per Store') sheet.sheetName = entityName;
        else if (sheet.sheetName === 'Per Period per Warehouse') sheet.sheetName = entityName + ' - Warehouse';
        else if (sheet.sheetName === 'Per Period per Marketplace') sheet.sheetName = entityName + ' - Marketplace';
        if (usedNames.has(sheet.sheetName)) return; // never emit two tabs with the same name.
        usedNames.add(sheet.sheetName);
        extraSheets.push(sheet);
      });
    });
    finalSheets.splice(insertAt, 0, ...extraSheets);
  }

  return { sheets: finalSheets };
}

// Builds the Group -> Division -> Store tree for a virtual group, keeping only nodes that actually
// have rows in DATA (so spelling variants like "Kiehl's"/"Kiehls" show only the one that has data).
function buildExportTree_(groupName) {
  const present = new Set(DATA.map(r => r.brand));
  const build = (name, seen) => {
    const node = { name: name, children: [] };
    const members = VIRTUAL_STORE_GROUPS[name];
    if (!members || seen.has(name)) return node;
    const nextSeen = new Set(seen); nextSeen.add(name);
    members.forEach(m => { if (present.has(m)) node.children.push(build(m, nextSeen)); });
    return node;
  };
  return build(groupName, new Set());
}

// File label for a "new spreadsheet" export (division/store picks that are NOT the group itself):
// up to 3 names joined with " & ", otherwise the first 2 + "N lainnya". The timestamp that keeps every
// such file unique is appended server-side (createExportSpreadsheet, payload.fileMode === 'new').
function exportCustomLabel_(names) {
  const list = (names || []).filter(Boolean);
  if (list.length <= 3) return list.join(' & ');
  return list.slice(0, 2).join(' & ') + ' + ' + (list.length - 2) + ' lainnya';
}

// Turns a popup selection into the list of spreadsheets to create. REVISED 2026-10-12 (third round, per
// Zoltraak): the group's own tabs (opts.includeGroup) go to the group's OWN file, "<year> - FSOP -
// <group>", which is overwritten on every run (fileMode 'overwrite' = createExportSpreadsheet's normal
// one-file-per-year-and-label behavior); division/store picks (opts.subEntities) are NEVER written into
// that file — they always create a brand-new spreadsheet (fileMode 'new') holding one tab trio per pick.
// Ticking both therefore yields two spreadsheets. No opts = the single legacy batch (rows as selected,
// exportStoreLabel_ as label, overwrite mode), identical to before the popup existed.
// Each batch is {payload, label}; payload.storeLabel/fileMode are what createExportSpreadsheet reads.
function buildExportBatches_(rows, opts) {
  if (!opts || typeof opts !== 'object') {
    const payload = buildExportPayload_(rows);
    payload.storeLabel = exportStoreLabel_(rows);
    payload.fileMode = 'overwrite';
    return [{ payload: payload, label: payload.storeLabel }];
  }
  const dimensions = opts.dimensions || {};
  const names = Array.isArray(opts.subEntities) ? opts.subEntities : [];
  const batches = [];
  if (opts.includeGroup !== false) {
    const payload = buildExportPayload_(rows, { includeGroup: true, subEntities: [], dimensions: dimensions });
    payload.storeLabel = exportStoreLabel_(rows);
    payload.fileMode = 'overwrite';
    batches.push({ payload: payload, label: payload.storeLabel });
  }
  if (names.length) {
    // rows = [] on purpose: the group's own sheets are not wanted in this file, and an empty row set
    // makes those (heavy) sheets come back empty instead of being computed and thrown away.
    const payload = buildExportPayload_([], { includeGroup: false, subEntities: names, dimensions: dimensions });
    payload.storeLabel = exportCustomLabel_(names);
    payload.fileMode = 'new';
    batches.push({ payload: payload, label: payload.storeLabel });
  }
  return batches;
}


  return {
    DATA, state, STORES, MONTHS, VIRTUAL_STORE_GROUPS,
    buildExportPayload_, getExportRows_, exportStoreLabel_, buildExportBatches_, buildExportTree_,
  };
}