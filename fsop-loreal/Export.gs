/**
 * FSOP direct export — builds the "Export to Sheets" payload on the server, without the dashboard UI, and writes the spreadsheet.
 *
 * Input : the dashboard cache ({ DATA: [...brand x month rows...], MP_DATA, ... }) and the name of a store or a
 *         virtual group ("LOreal Group", "LOreal CPD", "Maybelline Official", ...).
 * Output: { storeLabel, sheets: [ { sheetName, columnHeaders, prefixRows, rowLabels, rowFormats, rowIsBold,
 *           values, rowHighlights, columnGroups, rowGroups, freezeRows } ] } — exactly the shape Code.gs's
 *         createExportSpreadsheet(payload) / writeExportSheet_ already consume.
 *
 * The payload builder (everything above the "Apps Script side" banner) is pure JavaScript and was verified in Node against
 * the reference export "2026 - FSOP - LOreal Group Version 13".
 */

// ----------------------------------------------------------------------------------------------------------
// Configuration
// ----------------------------------------------------------------------------------------------------------

// Same definition as OUTRIGHT_VIRTUAL_STORE_GROUPS in Dashboard.html. A group's members are real store names or
// other group names.
const FSOP_VIRTUAL_GROUPS = {
  'LOreal CPD': ['Maybelline Official', 'Garnier Official', 'Garnier Men Official', 'LOreal Paris', 'LOreal Paris Haircare', '3CE Indonesia', 'AYU Beauty House'],
  'LOreal LDB': ['La Roche-Posay', 'La Roche-Posay Official Store', 'Cerave Official Store', 'Cerave Official Shop'],
  'LOreal LLD': ['YSL Official Shop', "Kiehl's Flagship Store", 'Kiehls Flagship Store', 'Shu Uemura'],
  'LOreal PPD': ['Kerastase Indonesia', 'Matrix Haircare Official Shop'],
  'LOreal Group': ['LOreal CPD', 'LOreal LDB', 'LOreal LLD', 'LOreal PPD']
};

const FSOP_MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const FSOP_MOGTM_RATE = 0.025;
const FSOP_MOGTM_RATE_BY_WAREHOUSE = { 'MOGTM - Betadine Solo (MNS)': 0.05, 'MOGTM - Natasha Solo (KNS)': 0.02 };
const FSOP_PCT_FORMAT = '0.00"%"';
const FSOP_NUM_FORMAT = '#,##0';
const FSOP_CBM_FORMAT = '#,##0.00';

// Fields summed over rows / warehouse entries / marketplace entries.
const FSOP_SUM_KEYS = ['uniq', 'qty', 'sales', 'claim', 'rbp', 'surplus', 'otherRevenue', 'pickPack', 'consumables', 'rentWarehouse', 'rentWarehouseCbm', 'absorbBySirclo'];

// Sheet layout (must match Code.gs's EXPORT_HEADER_ROW_ / EXPORT_DATA_START_ROW_ / DATA_COL_).
const FSOP_DATA_START_ROW = 10;
const FSOP_DATA_COL = 3;
const FSOP_PREFIX_LABELS = [
  '% Move. NoD', '% Move. AoV', '% Move. SoG', '% Run Rate SoG to Current Quarter',
  '% Run Rate SoG to Previous Quarter', '% Run Rate SoG QoQ', '% Run Rate SoG to Prev. Semester'
];

// ----------------------------------------------------------------------------------------------------------
// Small helpers
// ----------------------------------------------------------------------------------------------------------

function fsopColLetter_(n) {
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function fsopNum_(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

function fsopMonthLabel_(m) {
  const p = String(m).split('-');
  return FSOP_MONTH_NAMES[parseInt(p[1], 10) - 1] + ' ' + p[0];
}

function fsopWarehousePrefix_(raw) {
  const s = String(raw || '').trim();
  const i = s.indexOf(' - ');
  return (i === -1 ? s : s.slice(0, i)).trim().toLowerCase();
}

function fsopMogtmOfWarehouse_(w) {
  if (fsopWarehousePrefix_(w.warehouse) !== 'mogtm') return 0;
  return fsopNum_(w.rbp) * (FSOP_MOGTM_RATE_BY_WAREHOUSE[w.warehouse] || FSOP_MOGTM_RATE);
}

// ----------------------------------------------------------------------------------------------------------
// Selection and data aggregation
// ----------------------------------------------------------------------------------------------------------

// Real (non-group) store names behind a store/group name.
function fsopLeaves_(name, groups, out) {
  out = out || [];
  const members = groups[name];
  if (members) members.forEach(m => fsopLeaves_(m, groups, out));
  else out.push(name);
  return out;
}

function fsopZero_() {
  const o = {};
  FSOP_SUM_KEYS.forEach(k => { o[k] = 0; });
  o.mogtmFee = 0;
  return o;
}

function fsopAdd_(acc, src) {
  FSOP_SUM_KEYS.forEach(k => { acc[k] += fsopNum_(src[k]); });
  acc.mogtmFee += fsopNum_(src.mogtmFee);
  return acc;
}

// A brand/month DATA row, a warehouse entry or a marketplace entry -> plain metrics object.
function fsopMetrics_(src, mogtmFee) {
  const o = fsopZero_();
  FSOP_SUM_KEYS.forEach(k => { o[k] = fsopNum_(src[k]); });
  o.mogtmFee = mogtmFee;
  return o;
}

// MOGTM fee of a brand/month row = sum over its MOGTM-coded warehouses (same rule as deriveMetrics).
function fsopRowMogtm_(row) {
  return (row.warehouses || []).reduce((s, w) => s + fsopMogtmOfWarehouse_(w), 0);
}

// Per-marketplace MOGTM fee of a brand/month row, from the warehouses' marketplace RBP cross-tab.
function fsopRowMarketplaceMogtm_(row) {
  const fee = {};
  (row.warehouses || []).forEach(w => {
    if (fsopWarehousePrefix_(w.warehouse) !== 'mogtm') return;
    const rate = FSOP_MOGTM_RATE_BY_WAREHOUSE[w.warehouse] || FSOP_MOGTM_RATE;
    Object.keys(w.mpRbp || {}).forEach(mp => { fee[mp] = (fee[mp] || 0) + rate * fsopNum_(w.mpRbp[mp]); });
  });
  return fee;
}

/**
 * Everything the three tabs need, aggregated per month:
 *   months            sorted real months that have data for the selection
 *   total[m]          metrics of the whole selection in month m
 *   store/warehouse/marketplace: { names: [...ordered by Grand Total sales desc], byMonth: { m: { name: metrics } } }
 */
function fsopCollect_(cache, selection, groups) {
  groups = groups || FSOP_VIRTUAL_GROUPS;
  const leafSet = new Set(fsopLeaves_(selection, groups));
  const rows = (cache.DATA || []).filter(r => !r.isVirtual && leafSet.has(r.brand));
  const months = Array.from(new Set(rows.map(r => r.month))).sort();

  const rowsByKey = {};
  rows.forEach(r => { (rowsByKey[r.brand + '|' + r.month] = rowsByKey[r.brand + '|' + r.month] || []).push(r); });

  // Metrics of one store / group in one month, summed bottom-up exactly like the dashboard's virtual rows (a group is
  // the sum of its members, each of which is the sum of its own members / rows) so floating point results are identical.
  //   { present, m: metrics, w: { warehouse: metrics }, mp: { marketplace: metrics } }
  const memo = {};
  const node = (name, month) => {
    const key = name + '|' + month;
    if (memo[key]) return memo[key];
    const acc = { present: false, m: fsopZero_(), w: {}, mp: {} };
    const addInto = (map, k, src) => { if (!map[k]) map[k] = fsopZero_(); fsopAdd_(map[k], src); };
    if (groups[name]) {
      groups[name].forEach(mem => {
        const d = node(mem, month);
        if (!d.present) return;
        acc.present = true;
        fsopAdd_(acc.m, d.m);
        Object.keys(d.w).forEach(k => addInto(acc.w, k, d.w[k]));
        Object.keys(d.mp).forEach(k => addInto(acc.mp, k, d.mp[k]));
      });
    } else {
      (rowsByKey[key] || []).forEach(r => {
        acc.present = true;
        fsopAdd_(acc.m, fsopMetrics_(r, fsopRowMogtm_(r)));
        (r.warehouses || []).forEach(w => addInto(acc.w, w.warehouse || '(No Warehouse)', fsopMetrics_(w, fsopMogtmOfWarehouse_(w))));
        const mpFee = fsopRowMarketplaceMogtm_(r);
        (r.marketplaces || []).forEach(mp => addInto(acc.mp, mp.marketplace || '(No Marketplace)', fsopMetrics_(mp, mpFee[mp.marketplace || '(No Marketplace)'] || 0)));
      });
    }
    memo[key] = acc;
    return acc;
  };

  const total = {};
  const store = { names: [], byMonth: {} };
  const warehouse = { names: [], byMonth: {} };
  const marketplace = { names: [], byMonth: {} };
  const members = groups[selection] ? groups[selection] : null;
  months.forEach(m => {
    const sel = node(selection, m);
    total[m] = sel.m;                 // the selection's own (virtual) row
    marketplace.byMonth[m] = sel.mp;  // marketplace breakdown of the virtual row
    store.byMonth[m] = {};
    warehouse.byMonth[m] = {};
  });

  // Store tab: each direct member of the selection, summed flat over its own real stores in cache order
  if (members) {
    const memberLeaves = {};
    members.forEach(mem => { memberLeaves[mem] = new Set(fsopLeaves_(mem, groups)); });
    members.forEach(mem => {
      rows.forEach(r => {
        if (!memberLeaves[mem].has(r.brand)) return;
        const bucket = store.byMonth[r.month];
        if (!bucket[mem]) bucket[mem] = fsopZero_();
        fsopAdd_(bucket[mem], fsopMetrics_(r, fsopRowMogtm_(r)));
      });
    });
  }

  // Warehouse tab: every warehouse entry of every real store row, summed flat in cache order
  rows.forEach(r => {
    (r.warehouses || []).forEach(w => {
      const name = w.warehouse || '(No Warehouse)';
      const b = warehouse.byMonth[r.month];
      if (!b[name]) b[name] = fsopZero_();
      fsopAdd_(b[name], fsopMetrics_(w, fsopMogtmOfWarehouse_(w)));
    });
  });

  [store, warehouse, marketplace].forEach(dim => {
    const gt = {};
    months.forEach(m => Object.keys(dim.byMonth[m] || {}).forEach(n => { gt[n] = (gt[n] || 0) + dim.byMonth[m][n].sales; }));
    dim.names = Object.keys(gt).sort((a, b) => (gt[b] - gt[a]) || (a < b ? -1 : 1));
  });

  return { selection, months, total, store, warehouse, marketplace };
}

// ----------------------------------------------------------------------------------------------------------
// Periods and columns
// ----------------------------------------------------------------------------------------------------------

function fsopQuarterKey_(m) { const p = m.split('-'); return p[0] + '-Q' + Math.ceil(parseInt(p[1], 10) / 3); }
function fsopHalfKey_(m) { const p = m.split('-'); return p[0] + '-H' + (parseInt(p[1], 10) <= 6 ? 1 : 2); }

/**
 * Chronological column sequence: every month, a Quarter column right after the last month of each COMPLETE
 * quarter, a Half column right after the Quarter that completes a COMPLETE half, and Grand Total last.
 * Each entry: { type, key, label, months: [...real months it covers] }.
 */
function fsopPeriods_(months) {
  const monthSet = new Set(months);
  const monthsOfQuarter = q => { const p = q.split('-Q'); const n = parseInt(p[1], 10); return [0, 1, 2].map(i => p[0] + '-' + String(3 * (n - 1) + i + 1).padStart(2, '0')); };
  const quarterComplete = q => monthsOfQuarter(q).every(x => monthSet.has(x));
  const halfQuarters = h => { const p = h.split('-H'); return p[1] === '1' ? [p[0] + '-Q1', p[0] + '-Q2'] : [p[0] + '-Q3', p[0] + '-Q4']; };
  const out = [];
  months.forEach(m => {
    out.push({ type: 'month', key: m, label: fsopMonthLabel_(m), months: [m] });
    const q = fsopQuarterKey_(m);
    const qm = monthsOfQuarter(q);
    if (m === qm[2] && quarterComplete(q)) {
      out.push({ type: 'quarter', key: q, label: 'Q' + q.split('-Q')[1] + ' ' + q.split('-Q')[0], months: qm });
      const h = fsopHalfKey_(m);
      const hq = halfQuarters(h);
      if (q === hq[1] && hq.every(quarterComplete)) {
        out.push({ type: 'half', key: h, label: 'H' + h.split('-H')[1] + ' ' + h.split('-H')[0], months: hq.reduce((a, x) => a.concat(monthsOfQuarter(x)), []) });
      }
    }
  });
  out.push({ type: 'grand', key: 'GT', label: 'Grand Total', months: months.slice() });
  return out;
}

// Metrics of one entity (or of the whole selection when `name` is null) over a period's months.
function fsopPeriodMetrics_(dim, ctx, period, name) {
  const acc = fsopZero_();
  let present = false;
  period.months.forEach(m => {
    const src = name === null ? ctx.total[m] : (dim.byMonth[m] || {})[name];
    if (src) { present = true; fsopAdd_(acc, src); }
  });
  return { metrics: acc, present };
}

/**
 * Column model of one tab. Columns start at sheet column 3 (C). Each period contributes one total column
 * followed by the columns of the entities that have data in that period (largest Sales of Goods first).
 */
function fsopBuildColumns_(ctx, dim) {
  const periods = fsopPeriods_(ctx.months);
  const cols = [];
  periods.forEach((p, pi) => {
    const col = { n: FSOP_DATA_COL + cols.length, kind: 'period', period: p, pi, entity: null, label: p.label, data: fsopPeriodMetrics_(dim, ctx, p, null).metrics };
    cols.push(col);
    const ents = [];
    dim.names.forEach(name => {
      const r = fsopPeriodMetrics_(dim, ctx, p, name);
      if (r.present) ents.push({ name, metrics: r.metrics });
    });
    ents.sort((a, b) => (b.metrics.sales - a.metrics.sales) || (dim.names.indexOf(a.name) - dim.names.indexOf(b.name)));
    ents.forEach(e => {
      cols.push({ n: FSOP_DATA_COL + cols.length, kind: 'entity', period: p, pi, entity: e.name, label: e.name, data: e.metrics });
    });
  });
  return { periods, cols };
}

// ----------------------------------------------------------------------------------------------------------
// Row template (identical for the three tabs; only the number of entity rows changes)
// ----------------------------------------------------------------------------------------------------------

/**
 * Ordered row definitions starting at sheet row FSOP_DATA_START_ROW. `E` is the entity list in Grand Total order
 * (one sub-row per entity under each breakdown metric).
 *   kind: 'data' (value of the column), 'entityData' (value of entity #ei, diagonal-filled in entity columns),
 *         'zero' (constant 0), 'formula' (live formula), 'sumMonths' (month = value, Quarter/Half/Grand = sum of
 *         the month cells), 'opCostEntity', 'mogtmToCogs', 'blank', 'empty'
 *   ol  : outline (row group) level
 */
function fsopTemplate_(E) {
  const rows = [];
  const R = {};
  const add = def => {
    def.row = FSOP_DATA_START_ROW + rows.length;
    if (def.id) R[def.id] = def.row;
    rows.push(def);
    return def;
  };
  const NUM = FSOP_NUM_FORMAT, PCT = FSOP_PCT_FORMAT;
  const blank = ol => add({ label: '', bold: false, fmt: NUM, ol, kind: 'blank' });
  const main = (id, label, kind, extra, ol) => add(Object.assign({ id, label, bold: true, fmt: NUM, ol, kind }, extra || {}));
  const entRows = (id, field, ol, kind) => E.forEach((n, i) => add({ id: id + '.' + i, label: '   ' + n, bold: false, fmt: NUM, ol, kind: kind || 'entityData', field, ei: i }));
  const fEnt = (id, labelFn, ol, f, fmt) => E.forEach((n, i) => add({ id: id + '.' + i, label: '   ' + labelFn(n), bold: false, fmt: fmt || NUM, ol, kind: 'formula', f: (c, Rr) => f(c, Rr, i) }));
  const pctOfSales = (id, label, srcId, ol, abs) => add({ id, label, bold: false, fmt: PCT, ol, kind: 'formula', f: (c, Rr) => `=IFERROR(${abs ? 'ABS(' : ''}${c}${Rr[srcId]}${abs ? ')' : ''}/${c}${Rr.sales}*100,0)` });
  const zero = (id, label, ol) => main(id, label, 'zero', {}, ol);

  // --- Number of Order / Average Order Value / Quantity / Average Basket Size (rows 10-31)
  main('uniq', 'Number of Order', 'data', { field: 'uniq' }, 1);
  entRows('uniq', 'uniq', 2);
  blank(1);
  fEnt('pctNoD', n => '% Cont. to NoD ' + n, 2, (c, Rr, i) => `=IFERROR(${c}${Rr['uniq.' + i]}/${c}${Rr.uniq}*100,0)`, PCT);
  main('aov', 'Average Order Value', 'formula', { f: (c, Rr) => `=IFERROR(${c}${Rr.sales}/${c}${Rr.uniq},0)` }, 1);
  main('qty', 'Quantity', 'data', { field: 'qty' }, 1);
  entRows('qty', 'qty', 2);
  blank(1);
  fEnt('pctQty', n => '% Cont. to Qty ' + n, 2, (c, Rr, i) => `=IFERROR(${c}${Rr['qty.' + i]}/${c}${Rr.qty}*100,0)`, PCT);
  main('abs', 'Average Basket Size', 'formula', { f: (c, Rr) => `=IFERROR(${c}${Rr.sales}/${c}${Rr.qty},0)` }, 1);

  // --- Sales of Goods
  main('sales', 'Sales of Goods', 'data', { field: 'sales' }, 0);
  entRows('sales', 'sales', 1);
  blank(0);
  fEnt('pctSoG', n => '% Cont. to SoG ' + n, 1, (c, Rr, i) => `=IFERROR(${c}${Rr['sales.' + i]}/${c}${Rr.sales}*100,0)`, PCT);

  // --- Rebates and the claim lines
  main('claim', 'Rebates', 'data', { field: 'claim' }, 0);
  entRows('claim', 'claim', 1);
  pctOfSales('pctClaim', '   % Cont. to SoG', 'claim', 1);
  add({ label: 'Claim based on Sell Out', bold: false, fmt: NUM, ol: 0, kind: 'empty' });
  ['Claim 10% COGS', 'Additional Budget Promo', 'Claim Vouchers'].forEach(l => zero(null, l, 1));
  add({ label: 'Claim based on Sell in', bold: false, fmt: NUM, ol: 0, kind: 'empty' });
  ['Claim STTI', 'Claim Visibility', 'Claim Service Fee 1.50%', 'Claim Monthly Incentives 1.50%-2.20%', 'Claim Quarterly Incentives 1.00%-2.20%'].forEach(l => zero(null, l, 1));

  // --- Other Revenue / COGS / Surplus / Promo Fund / Chip In / MOGTM
  main('otherRevenue', 'Other Revenue', 'data', { field: 'otherRevenue' }, 0);
  entRows('otherRevenue', 'otherRevenue', 1);
  pctOfSales('pctOR', '   % Cont. to SoG', 'otherRevenue', 1);
  zero(null, 'Price Claw back due to Drop Price', 0);
  main('rbp', 'COGS', 'data', { field: 'rbp' }, 0);
  entRows('rbp', 'rbp', 1);
  pctOfSales('pctRbp', '   % Cont. to SoG', 'rbp', 1);
  main('surplus', 'Surplus', 'data', { field: 'surplus' }, 0);
  entRows('surplus', 'surplus', 1);
  pctOfSales('pctSurplus', '   % Cont. to SoG', 'surplus', 1);
  zero('pff', 'Promo Fund Front Margin', 0);
  entRows('pff', null, 1, 'zero');
  pctOfSales('pctPff', '   % Cont. to SoG', 'pff', 1);
  zero('pfb', 'Promo Fund Back Margin', 0);
  entRows('pfb', null, 1, 'zero');
  pctOfSales('pctPfb', '   % Cont. to SoG', 'pfb', 1);
  zero('chipIn', 'Chip In', 0);
  pctOfSales('pctChipIn', '   % Cont. to SoG', 'chipIn', 1);
  zero(null, 'Price Claw back due to Increased Price', 0);
  zero(null, 'Deficit due to Incorrect Price', 0);
  main('mogtm', 'MOGTM Distributor Fee', 'data', { field: 'mogtmFee' }, 0);
  entRows('mogtm', 'mogtmFee', 1);
  pctOfSales('pctMogtm', '   % Cont. to SoG', 'mogtm', 1);
  add({ label: '   % Cont. MOGTM to COGS', bold: false, fmt: PCT, ol: 1, kind: 'mogtmToCogs' });

  // --- Gross Profit block
  const gpF = (c, Rr, s) => `=${c}${Rr['sales' + s]}+${c}${Rr['claim' + s]}+${c}${Rr['otherRevenue' + s]}-${c}${Rr['rbp' + s]}-${c}${Rr['surplus' + s]}-${c}${Rr['mogtm' + s]}-${c}${Rr['pff' + s]}-${c}${Rr['pfb' + s]}`;
  main('gp', 'Gross Profit', 'formula', { f: (c, Rr) => gpF(c, Rr, '') }, 0);
  fEnt('gp', n => n, 1, (c, Rr, i) => gpF(c, Rr, '.' + i));
  blank(0);
  fEnt('pctGpC', n => '% Cont. to GP ' + n, 1, (c, Rr, i) => `=IFERROR(${c}${Rr['gp.' + i]}/${c}${Rr.gp}*100,0)`, PCT);
  main('pctGp', '% Gross Profit', 'formula', { fmt: PCT, f: (c, Rr) => `=IFERROR(${c}${Rr.gp}/(${c}${Rr.sales}+${c}${Rr.claim})*100,0)` }, 0);
  fEnt('pctGp', n => n, 1, (c, Rr, i) => `=IFERROR(${c}${Rr['gp.' + i]}/(${c}${Rr['sales.' + i]}+${c}${Rr['claim.' + i]})*100,0)`, PCT);
  main('gpo', 'Gross Profit per Order', 'formula', { f: (c, Rr) => `=IFERROR(${c}${Rr.gp}/${c}${Rr.uniq},0)` }, 0);
  fEnt('gpo', n => n, 1, (c, Rr, i) => `=IFERROR(${c}${Rr['gp.' + i]}/${c}${Rr['uniq.' + i]},0)`);
  blank(0);
  fEnt('pctGpo', n => '% Cont. to SoG ' + n, 1, (c, Rr, i) => `=IFERROR(${c}${Rr['gpo.' + i]}/${c}${Rr.sales}*100,0)`, PCT);
  main('pctDisc', '% Discount', 'formula', { fmt: PCT, f: (c, Rr) => `=IFERROR(${c}${Rr.claim}/(${c}${Rr.sales}+${c}${Rr.claim})*100,0)` }, 0);

  // --- Operational and fulfillment cost
  main('absorb', 'Platform Fee Absorb by SIRCLO', 'data', { field: 'absorbBySirclo', abs: true }, 0);
  pctOfSales('pctAbsorb', '   % Cont. to SoG', 'absorb', 1, true);
  zero(null, 'Marketplace Fee (Based on Sell in)', 1);
  main('pp', 'Pick Pack', 'sumMonths', { field: 'pickPack' }, 0);
  pctOfSales('pctPp', '   % Cont. to SoG', 'pp', 1);
  main('cons', 'Consumables', 'sumMonths', { field: 'consumables' }, 0);
  pctOfSales('pctCons', '   % Cont. to SoG', 'cons', 1);
  zero(null, 'Warehouse Fee (Based on Sell In)', 1);
  main('rent', 'Rent Warehouse', 'sumMonths', { field: 'rentWarehouse' }, 0);
  pctOfSales('pctRent', '   % Cont. to SoG', 'rent', 1);
  main('op', 'Total Operational and Fulfillment Cost', 'formula', { f: (c, Rr) => `=${c}${Rr.pp}+${c}${Rr.rent}+${c}${Rr.cons}+${c}${Rr.absorb}` }, 0);
  entRows('op', null, 1, 'opCostEntity');
  blank(0);
  fEnt('pctOp', n => '% Cont. to SoG ' + n, 1, (c, Rr, i) => `=IFERROR(${c}${Rr['op.' + i]}/${c}${Rr.sales}*100,0)`, PCT);

  // --- Contribution Margin block
  main('cm', 'Contribution Margin', 'formula', { f: (c, Rr) => `=${c}${Rr.gp}-${c}${Rr.op}` }, 0);
  fEnt('cm', n => n, 1, (c, Rr, i) => `=${c}${Rr['gp.' + i]}-${c}${Rr['op.' + i]}`);
  blank(0);
  fEnt('pctCmC', n => '% Cont. to CM ' + n, 1, (c, Rr, i) => `=IFERROR(${c}${Rr['cm.' + i]}/${c}${Rr.cm}*100,0)`, PCT);
  main('pctCm', '% Contribution Margin', 'formula', { fmt: PCT, f: (c, Rr) => `=IFERROR(${c}${Rr.cm}/(${c}${Rr.sales}+${c}${Rr.claim})*100,0)` }, 0);
  fEnt('pctCm', n => n, 1, (c, Rr, i) => `=IFERROR(${c}${Rr['cm.' + i]}/(${c}${Rr['sales.' + i]}+${c}${Rr['claim.' + i]})*100,0)`, PCT);
  main('cmo', 'Contribution Margin per Order', 'formula', { f: (c, Rr) => `=IFERROR(${c}${Rr.cm}/${c}${Rr.uniq},0)` }, 0);
  fEnt('cmo', n => n, 1, (c, Rr, i) => `=IFERROR(${c}${Rr['cm.' + i]}/${c}${Rr['uniq.' + i]},0)`);
  blank(0);
  fEnt('pctCmo', n => '% Cont. to SoG ' + n, 1, (c, Rr, i) => `=IFERROR(${c}${Rr['cmo.' + i]}/${c}${Rr.sales}*100,0)`, PCT);

  // --- Rate of Operational and Fulfillment Cost
  blank(0);
  add({ label: 'Rate of Operational and Fulfillment Cost:', bold: true, fmt: NUM, ol: 0, kind: 'empty' });
  add({ label: 'Pick Pack', bold: false, fmt: NUM, ol: 1, kind: 'formula', f: (c, Rr) => `=IFERROR(${c}${Rr.pp}/${c}${Rr.uniq},0)` });
  add({ label: 'Consumables', bold: false, fmt: NUM, ol: 1, kind: 'formula', f: (c, Rr) => `=IFERROR(${c}${Rr.cons}/${c}${Rr.uniq},0)` });
  add({ label: 'Rent Warehouse', bold: false, fmt: NUM, ol: 1, kind: 'formula', f: (c, Rr) => `=IFERROR(${c}${Rr.rent}/${c}${Rr.uniq},0)` });
  add({ id: 'cbm', label: 'CBM Usage', bold: false, fmt: FSOP_CBM_FORMAT, ol: 1, kind: 'sumMonths', field: 'rentWarehouseCbm' });

  return { rows, R };
}

// ----------------------------------------------------------------------------------------------------------
// Formula evaluator (just enough for the formulas this module writes: + - * / ( ) IFERROR ABS and A1 refs)
// ----------------------------------------------------------------------------------------------------------

function fsopColNumber_(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n;
}

function fsopEvaluator_(grid) {
  const cache = {};
  const evalCell = (r, c) => {
    const key = r + ',' + c;
    if (key in cache) return cache[key];
    const cell = grid[key];
    let v = 0;
    if (cell !== undefined && cell !== '' && cell !== null) {
      if (typeof cell === 'number') v = cell;
      else if (typeof cell === 'string' && cell.charAt(0) === '=') v = evalFormula(cell.slice(1));
    }
    cache[key] = v;
    return v;
  };
  const evalFormula = src => {
    let pos = 0;
    const peek = () => src.charAt(pos);
    const err = () => { const e = new Error('#DIV/0!'); e.fsopError = true; return e; };
    const expr = () => {
      let v = term();
      while (peek() === '+' || peek() === '-') { const op = src.charAt(pos++); const t = term(); v = op === '+' ? v + t : v - t; }
      return v;
    };
    const term = () => {
      let v = factor();
      while (peek() === '*' || peek() === '/') {
        const op = src.charAt(pos++); const f = factor();
        if (op === '*') v = v * f; else { if (f === 0) throw err(); v = v / f; }
      }
      return v;
    };
    const factor = () => {
      const ch = peek();
      if (ch === '-') { pos++; return -factor(); }
      if (ch === '(') { pos++; const v = expr(); pos++; return v; }
      const rest = src.slice(pos);
      let m = /^[0-9]+(\.[0-9]+)?/.exec(rest);
      if (m) { pos += m[0].length; return parseFloat(m[0]); }
      m = /^(IFERROR|ABS)\(/.exec(rest);
      if (m) {
        pos += m[0].length;
        if (m[1] === 'ABS') { const v = expr(); pos++; return Math.abs(v); }
        let v;
        const start = pos;
        try { v = expr(); } catch (e) { if (!e.fsopError) throw e; v = null; }
        // skip to the comma that ends the first argument (it is always the top-level one here)
        let depth = 0;
        pos = start;
        while (pos < src.length && !(src.charAt(pos) === ',' && depth === 0)) { if (src.charAt(pos) === '(') depth++; if (src.charAt(pos) === ')') depth--; pos++; }
        pos++; // the comma
        const fallback = expr();
        pos++; // closing )
        return v === null ? fallback : v;
      }
      m = /^([A-Z]+)([0-9]+)/.exec(rest);
      if (m) { pos += m[0].length; return evalCell(parseInt(m[2], 10), fsopColNumber_(m[1])); }
      throw new Error('Cannot parse formula: ' + src + ' at ' + pos);
    };
    const v = expr();
    if (!isFinite(v)) throw err();
    return v;
  };
  return evalCell;
}

// ----------------------------------------------------------------------------------------------------------
// One tab
// ----------------------------------------------------------------------------------------------------------

function fsopBuildTab_(ctx, dim, sheetName) {
  const { periods, cols } = fsopBuildColumns_(ctx, dim);
  const E = dim.names;
  const tpl = fsopTemplate_(E);
  const R = tpl.R;
  const L = n => fsopColLetter_(n);
  const grid = {};
  const put = (r, c, v) => { grid[r + ',' + c] = v; };

  // per period, per entity (in E order) metrics — used by the entity sub-rows
  const entByPeriod = periods.map(p => E.map(n => fsopPeriodMetrics_(dim, ctx, p, n).metrics));
  const colOf = {};
  cols.forEach(c => { colOf[c.pi + '|' + (c.entity === null ? '' : c.entity)] = c; });
  const monthPi = {};
  periods.forEach((p, pi) => { if (p.type === 'month') monthPi[p.key] = pi; });
  const opCostOf = m => m.pickPack + m.rentWarehouse + m.consumables + Math.abs(m.absorbBySirclo);

  // ---- header + labels
  cols.forEach(c => put(1, c.n, c.label));
  put(1, 1, 'Item');

  // ---- data rows
  tpl.rows.forEach(def => {
    put(def.row, 1, def.label);
    cols.forEach(c => {
      let v = '';
      const letter = L(c.n);
      switch (def.kind) {
        case 'blank': case 'empty': v = ''; break;
        case 'zero': v = 0; break;
        case 'data': { const x = fsopNum_(c.data[def.field]); v = def.abs ? Math.abs(x) : x; break; }
        case 'entityData': case 'opCostEntity': {
          const em = entByPeriod[c.pi][def.ei];
          const val = def.kind === 'opCostEntity' ? opCostOf(em) : em[def.field];
          v = (c.kind === 'period' || c.entity === E[def.ei]) ? val : 0;
          break;
        }
        case 'mogtmToCogs': v = c.data.rbp ? (c.data.mogtmFee / c.data.rbp) * 100 : 0; break;
        case 'formula': v = def.f(letter, R); break;
        case 'sumMonths': {
          if (c.period.type === 'month') { v = fsopNum_(c.data[def.field]); break; }
          const refs = c.period.months.map(m => colOf[monthPi[m] + '|' + (c.entity === null ? '' : c.entity)]).filter(Boolean).map(cc => L(cc.n) + def.row);
          v = refs.length ? '=' + refs.join('+') : 0;
          break;
        }
        default: v = '';
      }
      put(def.row, c.n, v);
    });
  });

  // ---- movement / run-rate rows (sheet rows 2-8)
  const periodsOfType = t => periods.map((p, pi) => ({ p, pi })).filter(x => x.p.type === t);
  const prevOfType = (pi, t) => { const list = periodsOfType(t); const i = list.findIndex(x => x.pi === pi); return i > 0 ? list[i - 1].pi : null; };
  const calQuarter = m => { const p = m.split('-'); return { y: parseInt(p[0], 10), q: Math.ceil(parseInt(p[1], 10) / 3) }; };
  const monthsOfCalQuarter = (y, q) => ctxMonths.filter(m => { const cq = calQuarter(m); return cq.y === y && cq.q === q; });
  const ctxMonths = ctx.months;
  const refRow = (rowId, c, pi2) => { const cc = colOf[pi2 + '|' + (c.entity === null ? '' : c.entity)]; return cc ? L(cc.n) + R[rowId] : null; };
  const moveFormula = (rowId, c, prevPi) => {
    const a = L(c.n) + R[rowId];
    const b = refRow(rowId, c, prevPi);
    return b ? `=IFERROR((${a}-${b})/${b}*100,0)` : 0;
  };
  const prefix = [[], [], [], [], [], [], []]; // 7 rows x columns
  cols.forEach(c => {
    const p = c.period;
    const main = c.kind === 'period';
    const cell = [ '', '', '', '', '', '', '' ];
    if (p.type === 'month') {
      const prevPi = prevOfType(c.pi, 'month');
      const mvRows = main ? [['uniq', 0], ['aov', 1], ['sales', 2]] : [['uniq', 0], ['aov', 1]];
      mvRows.forEach(([id, idx]) => { cell[idx] = prevPi === null ? 0 : moveFormula(id, c, prevPi); });
      const cq = calQuarter(p.key);
      const curMonths = monthsOfCalQuarter(cq.y, cq.q);
      const sumRef = months => months.map(m => refRow('sales', c, monthPi[m])).filter(Boolean);
      const cur = sumRef(curMonths);
      cell[3] = `=IFERROR(${L(c.n)}${R.sales}/(${cur.join('+')})*100,0)`;
      const pq = cq.q === 1 ? { y: cq.y - 1, q: 4 } : { y: cq.y, q: cq.q - 1 };
      const prevMonths = monthsOfCalQuarter(pq.y, pq.q);
      if (prevMonths.length) {
        const prv = sumRef(prevMonths);
        cell[4] = `=IFERROR(${L(c.n)}${R.sales}/(${prv.length ? prv.join('+') : '0'})*100,0)`;
      }
    } else if (p.type === 'quarter' || p.type === 'half') {
      const prevPi = prevOfType(c.pi, p.type);
      [['uniq', 0], ['aov', 1]].forEach(([id, idx]) => { cell[idx] = prevPi === null ? 0 : moveFormula(id, c, prevPi); });
      if (main) {
        const idx = p.type === 'quarter' ? 5 : 6;
        cell[idx] = prevPi === null ? 0 : moveFormula('sales', c, prevPi);
      }
    }
    cell.forEach((v, i) => { prefix[i][c.n] = v; put(2 + i, c.n, v); });
  });
  for (let i = 0; i < 7; i++) put(2 + i, 1, FSOP_PREFIX_LABELS[i]);

  return { sheetName, periods, cols, tpl, grid, E, colOf, monthPi };
}

// ----------------------------------------------------------------------------------------------------------
// Highest / lowest highlights
// ----------------------------------------------------------------------------------------------------------

/**
 * Columns that are compared with each other in one row: the month columns of one calendar quarter, the Quarter
 * columns of one half, the Half columns of one year, and — separately — the entity columns of one period
 * (never the Grand Total period). Entity columns of a breakdown sub-row are not compared at all (they hold one
 * diagonal value). The highest value is highlighted `highest`, the lowest `lowest`; ties highlight every tied
 * column; a group with fewer than two numeric cells, or all-equal cells, highlights nothing.
 */
function fsopHighlightGroups_(tab) {
  const groups = { main: {}, sub: {} };
  const add = (bucket, key, n) => { (bucket[key] = bucket[key] || []).push(n); };
  tab.cols.forEach(c => {
    const p = c.period;
    let key = null;
    if (c.kind === 'entity') key = p.type === 'grand' ? null : 'e|' + c.pi;
    else if (p.type === 'month') { const q = p.key.split('-'); key = 'm|' + q[0] + '|' + Math.ceil(parseInt(q[1], 10) / 3); }
    else if (p.type === 'quarter') { const q = p.key.split('-Q'); key = 'q|' + q[0] + '|' + (parseInt(q[1], 10) <= 2 ? 1 : 2); }
    else if (p.type === 'half') key = 'h|' + p.key.split('-H')[0];
    if (key === null) return;
    add(groups.main, key, c.n);
    if (c.kind !== 'entity') add(groups.sub, key, c.n);
  });
  return groups;
}

function fsopComputeHighlights_(tab) {
  const ev = fsopEvaluator_(tab.grid);
  const groups = fsopHighlightGroups_(tab);
  const firstOfType = {};
  const seenType = {};
  tab.periods.forEach((p, pi) => { if (!seenType[p.type]) { seenType[p.type] = true; firstOfType[pi] = true; } });
  const rowOut = (r, isSub, isPrefix, entity) => {
    const out = { highest: [], lowest: [] };
    const buckets = isSub ? groups.sub : groups.main;
    Object.keys(buckets).forEach(key => {
      const items = [];
      buckets[key].forEach(n => {
        if (entity && !tab.colOf[tab.cols[n - FSOP_DATA_COL].pi + '|' + entity]) return; // entity has no data in that period
        const raw = tab.grid[r + ',' + n];
        if (typeof raw !== 'number' && !(typeof raw === 'string' && raw.charAt(0) === '=')) return;
        if (isPrefix && typeof raw === 'number' && firstOfType[tab.cols[n - FSOP_DATA_COL].pi]) return; // "no previous period" placeholder (an entity that is merely absent last period counts as 0)
        let v;
        try { v = typeof raw === 'number' ? raw : ev(r, n); } catch (e) { v = 0; } // IFERROR already maps errors to 0
        if (isFinite(v)) items.push({ n, v });
      });
      if (items.length < 2) return;
      const mx = Math.max.apply(null, items.map(x => x.v));
      const mn = Math.min.apply(null, items.map(x => x.v));
      if (mx === mn) return;
      items.forEach(x => {
        if (x.v === mx) out.highest.push(x.n - FSOP_DATA_COL);
        if (x.v === mn) out.lowest.push(x.n - FSOP_DATA_COL);
      });
    });
    return out;
  };
  // a breakdown sub-row is one entity's row: "   <entity>" or "   % Cont. to <metric> <entity>"
  const isSubRow = def => tab.E.some(n => def.label === '   ' + n || (def.label.indexOf('   % Cont.') === 0 && def.label.slice(-(n.length + 1)) === ' ' + n));
  const subEntity = def => tab.E.filter(n => def.label === '   ' + n || (def.label.indexOf('   % Cont.') === 0 && def.label.slice(-(n.length + 1)) === ' ' + n))[0] || null;
  const prefix = [];
  for (let r = 2; r <= 8; r++) prefix.push(rowOut(r, false, true, null));
  const data = tab.tpl.rows.map(def => rowOut(def.row, isSubRow(def), false, subEntity(def)));
  return { prefix, data };
}

// ----------------------------------------------------------------------------------------------------------
// Outline groups
// ----------------------------------------------------------------------------------------------------------

/** Row groups ({start, end}, 1-based sheet rows): the prefix rows 2-8 plus every run of template rows with outline level >= L. */
function fsopRowGroups_(tab) {
  const groups = [{ start: 2, end: FSOP_DATA_START_ROW - 2, level: 1 }];
  const maxLevel = tab.tpl.rows.reduce((m, d) => Math.max(m, d.ol || 0), 0);
  for (let L = 1; L <= maxLevel; L++) {
    let start = null;
    tab.tpl.rows.forEach((d, i) => {
      const inside = (d.ol || 0) >= L;
      if (inside && start === null) start = d.row;
      if (start !== null && (!inside || i === tab.tpl.rows.length - 1)) {
        groups.push({ start, end: inside ? d.row : tab.tpl.rows[i - 1].row, level: L });
        start = null;
      }
    });
  }
  return groups.sort((a, b) => a.level - b.level || a.start - b.start).map(g => ({ start: g.start, end: g.end }));
}

/**
 * Column groups ({start, end, depth}, 1-based sheet columns, depth-ordered). Every group is collapsed on export.
 *   - a complete Half: all columns from its first month through the last entity column of its second Quarter
 *   - a complete Quarter: all columns from its first month through the last entity column of its third month
 *   - the entity columns of every period except those of Quarter / Half columns get ONE group; Quarter and Half
 *     entity columns get TWO stacked groups of the same range (their total column is one level shallower)
 */
function fsopColumnGroups_(tab) {
  const { periods, cols } = tab;
  const firstCol = pi => cols.find(c => c.pi === pi).n;
  const lastCol = pi => cols.filter(c => c.pi === pi).pop().n;
  const periodIdx = (type, key) => periods.findIndex(p => p.type === type && p.key === key);
  const halfOfQuarter = q => periods.find(p => p.type === 'half' && p.months.indexOf(periods[periodIdx('quarter', q)].months[0]) >= 0);
  const groups = [];
  const rangeDepthOfMonths = months => {
    // number of enclosing range groups (Half, Quarter) a column of these months sits in
    return months;
  };
  // range groups
  const rangeOf = pi => {
    const p = periods[pi];
    if (p.type !== 'quarter' && p.type !== 'half') return null;
    const firstMonthPi = periods.findIndex(x => x.type === 'month' && x.key === p.months[0]);
    return { start: firstCol(firstMonthPi), end: firstCol(pi) - 1 };
  };
  const depthIn = pi => { // enclosing range groups of period `pi`'s own total column
    const p = periods[pi];
    let d = 0;
    periods.forEach((q, qi) => {
      if (qi === pi || (q.type !== 'quarter' && q.type !== 'half')) return;
      const r = rangeOf(qi);
      if (r && firstCol(pi) >= r.start && firstCol(pi) <= r.end) d++;
    });
    return d;
  };
  periods.forEach((p, pi) => {
    const r = rangeOf(pi);
    if (r) groups.push({ start: r.start, end: r.end, depth: depthIn(pi) + 1 });
  });
  periods.forEach((p, pi) => {
    const ents = cols.filter(c => c.pi === pi && c.kind === 'entity');
    if (!ents.length) return;
    const base = depthIn(pi);
    const stacks = (p.type === 'quarter' || p.type === 'half') ? 2 : 1;
    for (let k = 1; k <= stacks; k++) groups.push({ start: ents[0].n, end: ents[ents.length - 1].n, depth: base + k });
  });
  return groups.sort((a, b) => a.depth - b.depth || a.start - b.start);
}

// ----------------------------------------------------------------------------------------------------------
// Payload (the exact shape createExportSpreadsheet / writeExportSheet_ already consume)
// ----------------------------------------------------------------------------------------------------------

const FSOP_TABS = [
  { sheetName: 'Per Period per Store', dim: 'store' },
  { sheetName: 'Per Period per Warehouse', dim: 'warehouse' },
  { sheetName: 'Per Period per Marketplace', dim: 'marketplace' }
];

function fsopSheetDef_(ctx, dim, sheetName) {
  const tab = fsopBuildTab_(ctx, dim, sheetName);
  const hl = fsopComputeHighlights_(tab);
  const nCols = tab.cols.length;
  const rowOf = r => { const out = []; for (let i = 0; i < nCols; i++) { const v = tab.grid[r + ',' + (FSOP_DATA_COL + i)]; out.push(v === undefined ? '' : v); } return out; };
  return {
    sheetName,
    columnHeaders: tab.cols.map(c => c.label),
    prefixRows: FSOP_PREFIX_LABELS.map((label, i) => ({ label, values: rowOf(2 + i), format: FSOP_PCT_FORMAT, highlights: hl.prefix[i] })),
    rowLabels: tab.tpl.rows.map(d => d.label),
    rowFormats: tab.tpl.rows.map(d => d.fmt),
    rowIsBold: tab.tpl.rows.map(d => d.bold !== false),
    values: tab.tpl.rows.map(d => rowOf(d.row)),
    rowHighlights: hl.data,
    columnGroups: fsopColumnGroups_(tab),
    rowGroups: fsopRowGroups_(tab),
    freezeRows: tab.tpl.R.sales
  };
}

/**
 * Whole export payload for one dashboard selection (a store or a virtual group).
 * The Store tab only exists when the selection is a group (it breaks the selection down into its direct members).
 */
function fsopBuildPayload_(cache, selection, groups) {
  const ctx = fsopCollect_(cache, selection, groups);
  if (!ctx.months.length) throw new Error('No data found for "' + selection + '".');
  const sheets = [];
  FSOP_TABS.forEach(t => {
    const dim = ctx[t.dim];
    if (!dim.names.length) return;
    sheets.push(fsopSheetDef_(ctx, dim, t.sheetName));
  });
  return { storeLabel: selection, sheets };
}

// ==========================================================================================================
// Apps Script side: sheet writer, spreadsheet creation, entry points and trigger
// Depends on Code.gs: refreshData(), loadCachedData_(), EXPORT_FOLDER_ID, nextExportVersion_(),
// applyExportColumnGroups_(), applyExportRowGroups_().
// ==========================================================================================================

// Script Property holding the selections to export (comma / newline separated store or group names).
const FSOP_SELECTIONS_PROPERTY = 'FSOP_SELECTIONS';
const FSOP_DEFAULT_SELECTIONS = ['LOreal Group'];
const FSOP_HIGHLIGHT_COLORS = { highest: '#0b2f7a', lowest: '#8a1414' };
const FSOP_RANGELIST_CHUNK = 400;

/**
 * Same sheet as Code.gs's writeExportSheet_ (identical cells, formats, bold/colour, freeze, outline groups), but written
 * with a handful of batched calls instead of one call per highlighted cell / formatted row, so a whole export takes
 * seconds rather than minutes. Highlights (several thousand cells) go through RangeList.
 */
function fsopWriteSheet_(sheet, def) {
  const headers = def.columnHeaders || [];
  const prefixRows = def.prefixRows || [];
  const labels = def.rowLabels || [];
  const nCols = headers.length;
  const nRows = labels.length;
  if (!nCols || !nRows) return;

  // header row
  sheet.getRange(1, 1).setValue('Item').setFontWeight('bold');
  sheet.getRange(1, FSOP_DATA_COL, 1, nCols).setValues([headers]).setFontWeight('bold').setHorizontalAlignment('center');

  // % Move. / % Run Rate rows (2-8)
  if (prefixRows.length) {
    sheet.getRange(2, 1, prefixRows.length, 1).setValues(prefixRows.map(r => [r.label]));
    sheet.getRange(2, FSOP_DATA_COL, prefixRows.length, nCols).setValues(prefixRows.map(r => r.values));
    sheet.getRange(2, FSOP_DATA_COL, prefixRows.length, nCols).setNumberFormat(prefixRows[0].format || FSOP_PCT_FORMAT);
  }

  // main block
  sheet.getRange(FSOP_DATA_START_ROW, 1, nRows, 1).setValues(labels.map(l => [l]));
  sheet.getRange(FSOP_DATA_START_ROW, FSOP_DATA_COL, nRows, nCols).setValues(def.values);

  // number formats: one call per run of rows sharing a format
  const formats = def.rowFormats || [];
  for (let i = 0; i < nRows;) {
    const fmt = formats[i] || FSOP_NUM_FORMAT;
    let j = i;
    while (j + 1 < nRows && (formats[j + 1] || FSOP_NUM_FORMAT) === fmt) j++;
    sheet.getRange(FSOP_DATA_START_ROW + i, FSOP_DATA_COL, j - i + 1, nCols).setNumberFormat(fmt);
    i = j + 1;
  }

  // bold labels (every row except a per-entity breakdown sub-row)
  const bold = [];
  (def.rowIsBold || []).forEach((b, i) => { if (b !== false) bold.push('A' + (FSOP_DATA_START_ROW + i)); });
  fsopApplyRangeList_(sheet, bold, r => r.setFontWeight('bold'));

  // highest / lowest highlights (bold + font colour only, formulas and formats stay untouched)
  const hi = [], lo = [];
  const collect = (startRow, highlights) => (highlights || []).forEach((h, i) => {
    if (!h) return;
    (h.highest || []).forEach(c => hi.push(fsopColLetter_(FSOP_DATA_COL + c) + (startRow + i)));
    (h.lowest || []).forEach(c => lo.push(fsopColLetter_(FSOP_DATA_COL + c) + (startRow + i)));
  });
  collect(2, prefixRows.map(r => r.highlights));
  collect(FSOP_DATA_START_ROW, def.rowHighlights);
  try {
    fsopApplyRangeList_(sheet, hi, r => r.setFontWeight('bold').setFontColor(FSOP_HIGHLIGHT_COLORS.highest));
    fsopApplyRangeList_(sheet, lo, r => r.setFontWeight('bold').setFontColor(FSOP_HIGHLIGHT_COLORS.lowest));
  } catch (e) { /* cosmetic only */ }

  sheet.setFrozenRows(def.freezeRows || 8);
  sheet.setFrozenColumns(2);
  applyExportColumnGroups_(sheet, def.columnGroups || []);
  applyExportRowGroups_(sheet, def.rowGroups || []);
  try {
    sheet.autoResizeColumns(1, 1);
    sheet.autoResizeColumns(FSOP_DATA_COL, nCols);
  } catch (e) { /* cosmetic only */ }
  try { sheet.setColumnWidth(2, 21); } catch (e) { /* cosmetic only */ }
}

function fsopApplyRangeList_(sheet, a1List, apply) {
  for (let i = 0; i < a1List.length; i += FSOP_RANGELIST_CHUNK) {
    apply(sheet.getRangeList(a1List.slice(i, i + FSOP_RANGELIST_CHUNK)));
  }
}

/** Creates the "<year> - FSOP - <label> Version N" spreadsheet in EXPORT_FOLDER_ID (same naming as createExportSpreadsheet). */
function fsopCreateSpreadsheet_(payload) {
  const year = new Date().getFullYear();
  const label = String(payload.storeLabel || 'All Stores').trim().replace(/\s+/g, ' ');
  const fileName = year + ' - FSOP - ' + label + ' Version ' + nextExportVersion_(year, label);
  const ss = SpreadsheetApp.create(fileName);
  const first = ss.getSheets()[0];
  payload.sheets.forEach((def, i) => {
    const sheet = i === 0 ? first : ss.insertSheet();
    sheet.setName(String(def.sheetName).slice(0, 100));
    fsopWriteSheet_(sheet, def);
  });
  SpreadsheetApp.flush();
  DriveApp.getFileById(ss.getId()).moveTo(DriveApp.getFolderById(EXPORT_FOLDER_ID));
  return { url: ss.getUrl(), fileName };
}

/**
 * Exports one store / group straight from the data (no dashboard UI).
 * @param {string} selection  a store ("Maybelline Official") or a group ("LOreal Group", "LOreal CPD", ...)
 * @param {{refresh?: boolean, cache?: Object}} opts  refresh (default true) runs refreshData() first; `cache` reuses a payload
 * @return {{url: string, fileName: string}}
 */
function exportFsop(selection, opts) {
  opts = opts || {};
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) throw new Error('Another export / refresh is still running — try again in a few minutes.');
  try {
    let cache = opts.cache || null;
    if (!cache && opts.refresh !== false) cache = refreshData();
    if (!cache) { const json = loadCachedData_(); cache = json ? JSON.parse(json) : null; }
    if (!cache || !cache.DATA || !cache.DATA.length) throw new Error('No dashboard data available — run refreshData() first.');
    return fsopExportFromCache_(cache, selection);
  } finally {
    lock.releaseLock();
  }
}

function fsopExportFromCache_(cache, selection) {
  selection = String(selection || '').trim();
  const known = Object.keys(FSOP_VIRTUAL_GROUPS).concat(Array.from(new Set((cache.DATA || []).filter(r => !r.isVirtual).map(r => r.brand))));
  if (known.indexOf(selection) === -1) throw new Error('Unknown store / group "' + selection + '". Valid: ' + known.join(', '));
  const result = fsopCreateSpreadsheet_(fsopBuildPayload_(cache, selection));
  Logger.log('FSOP export "%s" → %s (%s)', selection, result.fileName, result.url);
  return result;
}

/** Selections to export, from Script Property FSOP_SELECTIONS (comma / newline separated), default ["LOreal Group"]. */
function fsopGetSelections_() {
  const raw = PropertiesService.getScriptProperties().getProperty(FSOP_SELECTIONS_PROPERTY);
  const list = String(raw || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
  return list.length ? list : FSOP_DEFAULT_SELECTIONS.slice();
}

/**
 * Entry point for the editor's Run button and for the daily trigger: refreshData() once, then one spreadsheet per
 * configured selection (all built from that same fresh payload — no second read of the source files).
 */
function exportFsopFromSettings() {
  const selections = fsopGetSelections_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) throw new Error('Another export / refresh is still running — try again in a few minutes.');
  try {
    const cache = refreshData();
    if (!cache || !cache.DATA || !cache.DATA.length) throw new Error('refreshData() returned no data.');
    const out = selections.map(sel => fsopExportFromCache_(cache, sel));
    Logger.log('FSOP export finished: ' + out.map(o => o.url).join(' , '));
    return out;
  } finally {
    lock.releaseLock();
  }
}

/** One-click variants for the editor's function dropdown. */
function exportFsopLOrealGroup() { return exportFsop('LOreal Group'); }

/**
 * Run once: daily 06:00 trigger that runs exportFsopFromSettings (refresh + export in a single run). It REPLACES the
 * existing refreshData trigger, because exportFsopFromSettings already calls refreshData() first — keeping both would
 * read all the source files twice a day.
 */
function installFsopDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    const h = t.getHandlerFunction();
    if (h === 'refreshData' || h === 'exportFsopFromSettings') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('exportFsopFromSettings').timeBased().everyDays(1).atHour(6).create();
  Logger.log('Daily trigger installed: exportFsopFromSettings 06:00 (refreshData + FSOP export).');
}

/** Removes the FSOP trigger and puts the plain refreshData trigger back. */
function removeFsopDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'exportFsopFromSettings') ScriptApp.deleteTrigger(t); });
  installDailyTrigger();
}
