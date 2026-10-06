/**
 * REVISION - SKU Database wins (warehouse-aware) + field-level warehouse fallback in Finance Data
 *
 * Replace these functions in Code.gs by name (everything else stays as it is):
 *   - skuDbWarehouseCol (new)     : tiny helper, no CONFIG edit needed
 *   - loadSkuMappingDatabase      : now a thin loader around buildSkuLookup()
 *   - buildSkuLookup (new)        : pure builder, keeps the Warehouse column of the database
 *   - pickSkuDbStores (new)       : picks the stores that apply to the pivot row's warehouse
 *   - mapSkuToOfficialStore       : the SKU database now decides when it is unambiguous
 *   - loadMasterMappingData       : now a thin loader around buildMasterMapping()
 *   - buildMasterMapping (new)    : pure builder, also records per-warehouse uniform field values
 *   - standardizeDataForFinance   : per-field fallback to the warehouse when the composite key is missing
 *
 * Why (example SKU LRB7T34 -> "LOreal Paris Haircare"):
 *   Before, the SKU database store was only trusted when the Master knew it for that warehouse. When it did not
 *   (the Master has no "LOreal Paris Haircare" store), the warehouse-uniform step (b) or the daily file's own
 *   Official Store (c) ran first and replaced the database answer with another store (e.g. "L'Oreal Paris").
 *   Also the database's Warehouse column was ignored, so a SKU listed under different stores per warehouse
 *   could not be told apart.
 */

// No CONFIG change is needed: the database's Warehouse column (B) is read through skuDbWarehouseCol() below.
// (If you ever want another column, add SKU_DB_COL_WAREHOUSE to CONFIG and it takes precedence.)


/**
 * Column index (0-based) of the Warehouse column in the SKU database sheet. Defaults to 1 (column B).
 */
function skuDbWarehouseCol() {
  return CONFIG.SKU_DB_COL_WAREHOUSE === undefined ? 1 : CONFIG.SKU_DB_COL_WAREHOUSE;
}


/**
 * Load the external "Database SKU Mapping Brand" file into an in-memory Map (see buildSkuLookup).
 */
function loadSkuMappingDatabase() {
  let dbSpreadsheet;
  try {
    dbSpreadsheet = SpreadsheetApp.openById(CONFIG.SKU_DB_SHEET_ID);
  } catch (error) {
    throw new Error(`Cannot open the SKU Mapping Brand database (${CONFIG.SKU_DB_SHEET_ID}). Make sure the account running this script has at least view access to it. Details: ${error.message}`);
  }

  const sheet = dbSpreadsheet.getSheetByName(CONFIG.SKU_DB_SHEET_NAME);
  if (!sheet) {
    throw new Error(`Sheet "${CONFIG.SKU_DB_SHEET_NAME}" not found in the SKU Mapping Brand database`);
  }

  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    throw new Error('SKU Mapping Brand database has no data (only headers)');
  }

  const numCols = Math.max(CONFIG.SKU_DB_COL_OFFICIAL_STORE, skuDbWarehouseCol(), CONFIG.SKU_DB_COL_SKU) + 1;
  const values = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();
  console.log(`SKU Mapping Brand database has ${values.length} data rows`);

  const built = buildSkuLookup(values);
  const lookup = built.lookup;

  // Log SKUs that stay ambiguous inside one scope (same warehouse, or the warehouse-less rows)
  let conflictCount = 0;
  const conflictSamples = [];
  lookup.forEach((entry, sku) => {
    const scopes = [entry.generic].concat(Array.from(entry.byWarehouse.values()));
    if (scopes.some(list => list.length > 1)) {
      conflictCount++;
      if (conflictSamples.length < 20) conflictSamples.push(`${sku} -> ${entry.stores.join(' | ')}`);
    }
  });

  console.log(`SKU database loaded: ${lookup.size} unique SKUs, ${built.skippedRows} rows skipped (blank SKU or Official Store)`);
  if (conflictCount > 0) {
    console.warn(`${conflictCount} SKU(s) are listed under more than one Official Store within the same warehouse scope. First ${conflictSamples.length}:\n${conflictSamples.join('\n')}`);
  } else {
    console.log('No SKU is listed under more than one Official Store within the same warehouse scope.');
  }

  return lookup;
}


/**
 * Build the SKU lookup from the database rows (array of arrays, header excluded).
 *
 * Key   = normalized SKU (trim + upper-case)
 * Value = {
 *   stores:      every distinct Official Store the SKU is listed under (any warehouse),
 *   generic:     stores of the rows whose Warehouse is blank (valid for every warehouse),
 *   byWarehouse: Map(normalized Warehouse -> stores listed for that warehouse)
 * }
 */
function buildSkuLookup(values) {
  const addDistinct = (list, store) => {
    if (list.findIndex(s => normKey(s) === normKey(store)) === -1) list.push(store);
  };

  const lookup = new Map();
  let skippedRows = 0;

  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const store = String(row[CONFIG.SKU_DB_COL_OFFICIAL_STORE] || '').trim();
    const sku = normalizeSku(row[CONFIG.SKU_DB_COL_SKU]);
    const warehouse = normKey(row[skuDbWarehouseCol()]);

    if (!sku || !store) {
      skippedRows++;
      continue;
    }

    let entry = lookup.get(sku);
    if (!entry) {
      entry = { stores: [], generic: [], byWarehouse: new Map() };
      lookup.set(sku, entry);
    }

    addDistinct(entry.stores, store);
    if (warehouse) {
      let list = entry.byWarehouse.get(warehouse);
      if (!list) {
        list = [];
        entry.byWarehouse.set(warehouse, list);
      }
      addDistinct(list, store);
    } else {
      addDistinct(entry.generic, store);
    }
  }

  return { lookup, skippedRows };
}


/**
 * The stores of a SKU database entry that apply to a pivot row's warehouse, most specific first:
 *  1) rows listed for exactly this Warehouse Name,
 *  2) rows with a blank Warehouse (valid everywhere),
 *  3) every store of the SKU (the SKU is only listed for other warehouses; SKU-level fallback).
 */
function pickSkuDbStores(entry, warehouseName) {
  const specific = entry.byWarehouse.get(normKey(warehouseName));
  if (specific && specific.length > 0) return { stores: specific, scope: 'warehouse' };
  if (entry.generic.length > 0) return { stores: entry.generic, scope: 'sku' };
  return { stores: entry.stores, scope: 'other-warehouse' };
}


/**
 * Attach an Official Store (plus remarks and mapping source) to every SKU pivot row. First step that
 * produces a result wins:
 *
 *  a) SKU Database, warehouse-aware (see pickSkuDbStores). The database DECIDES when it names exactly one
 *     store for this row, even if the Master does not know that store for the warehouse: steps b and c are
 *     then skipped, so a lower-priority source can no longer overwrite the database answer.
 *       - one store, known in Master for this Warehouse Name + WH Partner -> that store ("SKU Database")
 *       - one store, NOT known in Master                                  -> keep it, tried against step d,
 *                                                                           else "SKU Database (not in Master)"
 *       - several stores: those known in Master; exactly one -> it; several -> the one equal to the
 *         daily file's Official Store (AC); otherwise still ambiguous ("Multiple Mapping"): b and c are skipped
 *         so they cannot pick a store outside the database's list. None known in Master -> continue with b, c, d
 *  b) Warehouse (Master): only when the database did not decide. Every Master row of the warehouse gives the
 *     same standardized result, so the SKU is irrelevant.
 *  c) Source Official Store (AC): only when the database did not decide, and only if the Master knows it.
 *  d) Reconciliation Mapping: Source Official Store (AC) + kind of remark -> Standardized_Brand -> the Master
 *     Official Store of that brand at this Warehouse Name + WH Partner.
 *  e) The database store that is not in Master (kept visible so the naming gap can be fixed).
 *  f) Unmapped.
 *
 * cbmAvail is passed through untouched, so the total never changes.
 */
function mapSkuToOfficialStore(skuPivot, skuLookup, masterMapping, reconLookup) {
  const masterHasKey = (store, warehouseName, whPartner) =>
    Object.prototype.hasOwnProperty.call(masterMapping.compositeLookup, compositeKey(store, warehouseName, whPartner));

  const withMapping = (row, officialStore, remarks, mappingSource) =>
    Object.assign({}, row, { officialStore: officialStore, remarks: remarks, mappingSource: mappingSource });

  const reconFailures = new Map(); // reason -> { rows, cbm }, for the log

  const mapped = skuPivot.map(row => {
    let multipleMappingRemark = '';
    let dbStoreNotInMaster = ''; // set when the database decided on a store the Master does not know
    let dbBlocksFallback = false; // true when the database answer must not be replaced by steps b / c

    // a) SKU Database (warehouse-aware)
    const entry = row.sku === CONFIG.BLANK_PLACEHOLDER ? null : skuLookup.get(row.sku);
    if (entry) {
      const picked = pickSkuDbStores(entry, row.warehouseName);
      const candidates = picked.stores.filter(store => masterHasKey(store, row.warehouseName, row.whPartner));

      if (picked.stores.length === 1) {
        if (candidates.length === 1) {
          return withMapping(row, picked.stores[0], '', CONFIG.SOURCE_SKU_DB);
        }
        dbStoreNotInMaster = picked.stores[0]; // the database decided; b and c must not override it
        dbBlocksFallback = true;
      } else if (candidates.length === 1) {
        return withMapping(row, candidates[0], '', CONFIG.SOURCE_SKU_DB_MASTER);
      } else {
        const own = normKey(row.sourceOfficialStore)
          ? candidates.find(store => normKey(store) === normKey(row.sourceOfficialStore))
          : null;
        if (own) {
          return withMapping(row, own, '', CONFIG.SOURCE_SKU_DB_MASTER);
        }
        // Several of the database's stores are known in Master and none equals the AC: ambiguous. Do not let
        // b / c pick a store outside the database's list; it stays Unmapped (Multiple Mapping) for the worklist.
        if (candidates.length > 1) dbBlocksFallback = true;
        const shown = picked.stores.slice(0, CONFIG.MULTIPLE_MAPPING_MAX_STORES_SHOWN).join(' | ');
        const more = picked.stores.length > CONFIG.MULTIPLE_MAPPING_MAX_STORES_SHOWN
          ? ` +${picked.stores.length - CONFIG.MULTIPLE_MAPPING_MAX_STORES_SHOWN} more`
          : '';
        multipleMappingRemark = `Unmapped - Multiple Mapping (${shown}${more})`;
      }
    }

    if (!dbBlocksFallback) {
      // b) Warehouse (Master): the warehouse alone decides the standardized result
      const warehouseEntry = masterMapping.warehouseLookup.get(warehouseKey(row.warehouseName, row.whPartner));
      if (warehouseEntry && warehouseEntry.uniform) {
        return withMapping(row, warehouseEntry.representativeStore, '', CONFIG.SOURCE_WAREHOUSE);
      }

      // c) Source Official Store (AC), only if the Master Mapping knows it for this warehouse
      if (row.sourceOfficialStore && masterHasKey(row.sourceOfficialStore, row.warehouseName, row.whPartner)) {
        return withMapping(row, row.sourceOfficialStore, '', CONFIG.SOURCE_OFFICIAL_STORE);
      }
    }

    // d) Reconciliation Mapping: Source Official Store (AC) + kind of remark -> Standardized_Brand,
    //    then the Master row of that brand at THIS warehouse gives the Official Store
    const remarkKind = dbStoreNotInMaster ? 'notmaster' : (multipleMappingRemark ? 'multiple' : 'unmapped');
    const recon = resolveViaReconciliation(row.sourceOfficialStore, row.warehouseName, row.whPartner, remarkKind, masterMapping, reconLookup);
    let reconReason = '';
    if (recon && recon.store) {
      return withMapping(row, recon.store, '', CONFIG.SOURCE_RECONCILIATION);
    }
    if (recon && recon.reason) {
      reconReason = recon.reason;
      const stat = reconFailures.get(reconReason) || { rows: 0, cbm: 0 };
      stat.rows++;
      stat.cbm += row.cbmAvail;
      reconFailures.set(reconReason, stat);
    }

    // e) The SKU database store name, even though the Master does not list it for this warehouse
    //    (kept visible so the naming difference can be fixed; Finance Data falls back to the warehouse per field)
    if (dbStoreNotInMaster) {
      const base = 'Store name not found in Master for this warehouse';
      return withMapping(row, dbStoreNotInMaster, reconReason ? `${base} - ${reconReason}` : base, CONFIG.SOURCE_SKU_DB_NO_MASTER);
    }

    // f) Unmapped
    const unmappedBase = multipleMappingRemark || 'Unmapped';
    return withMapping(row, CONFIG.UNMAPPED_LABEL, reconReason ? `${unmappedBase} - ${reconReason}` : unmappedBase, CONFIG.SOURCE_UNMAPPED);
  });

  if (reconFailures.size > 0) {
    const top = Array.from(reconFailures.entries()).sort((a, b) => b[1].cbm - a[1].cbm).slice(0, 15)
      .map(e => `${e[0]} -> ${e[1].rows} rows, CBM ${e[1].cbm.toFixed(2)}`);
    console.warn(`Reconciliation Mapping found a brand but could not resolve a Master row for these cases (top by CBM):\n${top.join('\n')}`);
  }

  return mapped;
}


/**
 * Load Master Mapping data into memory (see buildMasterMapping).
 */
function loadMasterMappingData() {
  const masterSheet = SpreadsheetApp.openById(CONFIG.MASTER_MAPPING_SHEET_ID);
  const sheet = masterSheet.getSheetByName(CONFIG.MASTER_MAPPING_SHEET_NAME);

  if (!sheet) {
    throw new Error(`Sheet "${CONFIG.MASTER_MAPPING_SHEET_NAME}" not found in Master Mapping file`);
  }

  const values = sheet.getDataRange().getValues();
  console.log(`Master Mapping sheet has ${values.length} rows`);
  console.log(`First row (headers): ${values[0].join(' | ')}`);

  const mapping = buildMasterMapping(values);

  let uniformCount = 0;
  mapping.warehouseLookup.forEach(w => { if (w.uniform) uniformCount++; });
  console.log(`Loaded ${Object.keys(mapping.compositeLookup).length} composite-key mappings; ${mapping.warehouseLookup.size} warehouses, ${uniformCount} resolvable by warehouse alone`);

  return mapping;
}


/**
 * Build the Master Mapping structures from the sheet values (header row included).
 *
 * compositeLookup : compositeKey(Official Store, Warehouse Name, WH Partner) -> the four standardized fields
 *                   (a blank field is stored as 'Unmapped')
 * warehouseLookup : warehouseKey(Warehouse Name, WH Partner) ->
 *                   { stores, representativeStore, uniform, uniformFields }
 *                   uniform       = every Master row of the warehouse has the same four standardized values
 *                   uniformFields = per standardized field, the single value shared by every Master row of the
 *                                   warehouse (null when the rows disagree). Used by Finance Data when the
 *                                   composite key is missing, so e.g. WHP and Subsidiary (warehouse-level
 *                                   facts) are still filled even if the Official Store is not in the Master.
 * brandLookup / brandNames : used by the Reconciliation Mapping step.
 */
function buildMasterMapping(values) {
  const FIELDS = ['standardizedBrand', 'standardizedMappingBrand', 'standardizedWHP', 'standardizedSubsidiary'];

  const mapping = {
    compositeLookup: {},
    warehouseLookup: new Map(),
    brandLookup: new Map(),
    brandNames: new Set()
  };
  const warehouseTuples = new Map();  // warehouseKey -> Set of standardized tuples seen
  const warehouseFields = new Map();  // warehouseKey -> { field -> Map(normKey -> value) } (non-blank values only)

  for (let i = 1; i < values.length; i++) {
    const row = values[i];

    const officialStore = String(row[CONFIG.MASTER_COL_OFFICIAL_STORE] || '').trim();
    const warehouseName = String(row[CONFIG.MASTER_COL_WAREHOUSE_NAME] || '').trim();
    const whPartner = String(row[CONFIG.MASTER_COL_WH_PARTNER] || '').trim();

    // Skip genuinely blank master rows
    if (!officialStore && !warehouseName && !whPartner) {
      continue;
    }

    const raw = {
      standardizedBrand: String(row[CONFIG.MASTER_COL_STD_BRAND] || '').trim(),
      standardizedMappingBrand: String(row[CONFIG.MASTER_COL_STD_MAPPING_BRAND] || '').trim(),
      standardizedWHP: String(row[CONFIG.MASTER_COL_STD_WHP] || '').trim(),
      standardizedSubsidiary: String(row[CONFIG.MASTER_COL_STD_SUBSIDIARY] || '').trim()
    };

    // Each field independently: blank in the master -> 'Unmapped'
    const mapped = {};
    FIELDS.forEach(f => { mapped[f] = raw[f] || 'Unmapped'; });

    mapping.compositeLookup[compositeKey(officialStore, warehouseName, whPartner)] = mapped;

    // Warehouse-level view of the same master row
    const wKey = warehouseKey(warehouseName, whPartner);
    const tuple = FIELDS.map(f => normKey(mapped[f])).join('|');

    let wEntry = mapping.warehouseLookup.get(wKey);
    if (!wEntry) {
      wEntry = { stores: [], representativeStore: officialStore || CONFIG.BLANK_PLACEHOLDER, uniform: true, uniformFields: {} };
      mapping.warehouseLookup.set(wKey, wEntry);
      warehouseTuples.set(wKey, new Set());
      const fieldMaps = {};
      FIELDS.forEach(f => { fieldMaps[f] = new Map(); });
      warehouseFields.set(wKey, fieldMaps);
    }
    if (officialStore && wEntry.stores.findIndex(s => normKey(s) === normKey(officialStore)) === -1) {
      wEntry.stores.push(officialStore);
    }
    warehouseTuples.get(wKey).add(tuple);
    FIELDS.forEach(f => {
      if (raw[f]) warehouseFields.get(wKey)[f].set(normKey(raw[f]), raw[f]);
    });

    // Brand-level view of the same master row (used by the Reconciliation Mapping step)
    if (raw.standardizedBrand) {
      mapping.brandNames.add(normKey(raw.standardizedBrand));
      const bKey = `${normKey(raw.standardizedBrand)}|${wKey}`;
      const bStores = mapping.brandLookup.get(bKey) || [];
      if (officialStore && bStores.findIndex(s => normKey(s) === normKey(officialStore)) === -1) bStores.push(officialStore);
      mapping.brandLookup.set(bKey, bStores);
    }
  }

  mapping.warehouseLookup.forEach((wEntry, wKey) => {
    wEntry.uniform = warehouseTuples.get(wKey).size === 1;
    FIELDS.forEach(f => {
      const distinct = warehouseFields.get(wKey)[f];
      wEntry.uniformFields[f] = distinct.size === 1 ? Array.from(distinct.values())[0] : null;
    });
  });

  return mapping;
}


/**
 * Standardize data for the Finance sheet using the composite-key Master Mapping lookup.
 *
 * FIELD-LEVEL INDEPENDENT MAPPING:
 *   - composite key (Official Store + Warehouse Name + WH Partner) found -> the four Master values as they are
 *   - composite key NOT found (e.g. the SKU database store is not in the Master for that warehouse) -> each
 *     field falls back to the warehouse: if every Master row of that Warehouse Name + WH Partner agrees on the
 *     field (WHP and Subsidiary usually do), that value is used; otherwise that field alone is 'Unmapped'.
 * cbmAvail is a 1:1 pass-through, so totals never change.
 */
function standardizeDataForFinance(dedupData, masterMapping) {
  const financeData = [];
  const notFound = [];
  let fallbackRows = 0;
  let fallbackCbm = 0;

  for (const row of dedupData) {
    const key = compositeKey(row.officialStore, row.warehouseName, row.whPartner);
    const match = Object.prototype.hasOwnProperty.call(masterMapping.compositeLookup, key)
      ? masterMapping.compositeLookup[key]
      : null;

    let wEntry = null;
    if (!match) {
      notFound.push(row);
      wEntry = masterMapping.warehouseLookup.get(warehouseKey(row.warehouseName, row.whPartner)) || null;
    }

    const field = name => {
      if (match) return match[name];
      const viaWarehouse = wEntry && wEntry.uniformFields ? wEntry.uniformFields[name] : null;
      return viaWarehouse || CONFIG.UNMAPPED_LABEL;
    };

    const out = {
      standardizedBrand: field('standardizedBrand'),
      standardizedWHP: field('standardizedWHP'),
      standardizedSubsidiary: field('standardizedSubsidiary'),
      standardizedMappingBrand: field('standardizedMappingBrand'),
      cbmAvail: row.cbmAvail
    };

    if (!match && (out.standardizedWHP !== CONFIG.UNMAPPED_LABEL || out.standardizedSubsidiary !== CONFIG.UNMAPPED_LABEL ||
        out.standardizedMappingBrand !== CONFIG.UNMAPPED_LABEL || out.standardizedBrand !== CONFIG.UNMAPPED_LABEL)) {
      fallbackRows++;
      fallbackCbm += row.cbmAvail;
    }

    financeData.push(out);
  }

  // Diagnostic: Official Store | Warehouse Name | WH Partner combinations NOT found in the Master
  // Mapping (largest CBM first), so naming differences are easy to spot in the logs
  if (notFound.length > 0) {
    notFound.sort((a, b) => b.cbmAvail - a.cbmAvail);
    const sample = notFound.slice(0, 15).map(r => `${r.officialStore} | ${r.warehouseName} | ${r.whPartner} -> ${r.cbmAvail.toFixed(2)}`);
    console.warn(`${notFound.length} of ${dedupData.length} Raw Data SCM combinations were not found in the Master Mapping (${fallbackRows} of them got at least one field from the warehouse, CBM ${fallbackCbm.toFixed(2)}). Top by CBM:\n${sample.join('\n')}`);
  } else {
    console.log('Every Raw Data SCM combination was found in the Master Mapping.');
  }

  return financeData;
}
