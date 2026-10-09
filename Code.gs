/**
 * SCM Daily Report Processing Script
 *
 * Flow:
 * 1. User selects which daily report source file to process (from the source folder)
 * 2. Extract Raw Data from the file (SKU, Warehouse Name, WH Partner, CBM Avail, plus Official Store /
 *    Principal / Product as supporting info), tracking the TRUE original CBM Avail total (the CBM Avail
 *    column). Rows whose CBM Avail is 0 are left out of the pivot (they contribute nothing to any total),
 *    which keeps the output small and fast.
 * 3. Load Master Mapping data (composite key Official Store + Warehouse Name + WH Partner ->
 *    Standardized fields, plus a Warehouse Name + WH Partner lookup used as a fallback)
 * 4. Build the "SKU Mapping Brand" sheet: pivot of SKU x Warehouse Name x WH Partner
 *    (value = CBM Avail). Each pivot row gets an Official Store through a FALLBACK CHAIN:
 *      a) SKU Database ("Database SKU Mapping Brand" file), WAREHOUSE-AWARE: a SKU listed for the row's
 *         Warehouse Name wins over warehouse-less rows, which win over rows for other warehouses.
 *         When the database names exactly ONE store it DECIDES, even if the Master does not know that
 *         store for the warehouse: steps b and c can no longer replace it. If a SKU is listed under
 *         several stores, the Master (and the daily file's Official Store) are used to pick the right one.
 *      b) Warehouse (Master): the Warehouse Name + WH Partner maps to ONE standardized result in the Master
 *         Mapping, so the SKU does not matter (only when the database did not decide)
 *      c) Source Official Store (AC): the value in the daily file, only if it exists in the Master Mapping
 *         for that warehouse (only when the database did not decide)
 *      d) Reconciliation Mapping (tab in the Master Data file): Source Official Store (AC) + kind of
 *         remark (Unmapped / Store name not found in Master / Multiple Mapping) -> a Standardized_Brand;
 *         the Master row of that brand at THIS warehouse gives the Official Store. If the brand has no
 *         Master row for the warehouse (or is absent from Master) the reason is added to Remarks
 *      e) The SKU database store that the Master does not know: it STAYS the Official Store (the database is
 *         authoritative). For Finance Data it gets a separate "Master key" (Reconciliation Mapping) and/or a
 *         Brand / Mapping Brand from the "Store Alias" tab of the Master Data file (Remarks explain which)
 *      f) Unmapped (Remarks = "Unmapped")
 *    A "Mapping Source" column records which step produced each result.
 *    Reconciliation control: Original CBM Avail total vs this sheet's CBM Avail total
 * 5. Build the "Unmapped SKU" worklist sheet: unmapped SKUs sorted by CBM (largest first),
 *    plus the unmapped CBM per warehouse, so the SKU database can be completed. Then the "DB Audit" sheet:
 *    every SKU that exists in the SKU database is compared with its final Official Store; differences are
 *    listed (largest CBM first) together with the database store names the Master / Store Alias do not know.
 * 6. Generate the "Raw Data SCM" sheet from the SKU Mapping Brand result (Official Store from
 *    the mapping above), deduplicated on Official Store + Warehouse Name + WH Partner
 *    (SUMIFS-equivalent). Reconciliation control: Original CBM Avail total vs Raw Data SCM total
 * 7. Generate the "Finance Data" sheet (only after Raw Data SCM is complete), with its own
 *    reconciliation control comparing its total back to Raw Data SCM. Each field is mapped
 *    independently. Composite key found -> the Master values. Otherwise per field:
 *      Brand / Mapping Brand: Store Alias tab -> Master key store (Reconciliation) -> warehouse -> Unmapped
 *      WHP / Subsidiary     : Master key store (Reconciliation) -> warehouse -> Unmapped
 *    ("warehouse" = the value shared by every Master row of that Warehouse Name + WH Partner). WHP always
 *    comes from the Master, never from the SKU database.
 * 8. Generate the "Breakdown" sheet (only after Finance Data is complete): a pivot of
 *    Finance Data by Brand + Mapping Brand + Subsidiary x WH Partner (columns generated
 *    dynamically from whichever WH Partner values actually appear in Finance Data, ordered by
 *    CONFIG.BREAKDOWN_WHP_ORDER, including "unmapped" as its own column only when Standardized_WHP
 *    is actually unmapped in the data), with a Grand Total row and its own reconciliation control
 *    comparing back to Finance Data
 *
 * 9. Menu "Re-run Raw Data SCM & Finance Data (after Unmapped SKU fill-in)": after the column
 *    "Official_Store (to fill in)" of the "Unmapped SKU" sheet has been filled in manually, re-applies
 *    those stores to SKU Mapping Brand and rebuilds Raw Data SCM, Finance Data and Breakdown (manual fill-ins win; rows without one
 *    are tried against the Reconciliation Mapping, so re-running also picks up newly added Master rows)
 *    (rerunFromUnmappedSkuFill), with the CBM reconciliation controls re-checked.
 *
 * 10. Menu "Re-run Raw Data SCM & Finance Data (after DB Audit correction)" (rerunFromDbAuditFill): the "DB Audit" sheet has a
 *    column H "CORRECT STORE (to fill in and re run)" next to each listed row. Type the correct Official Store or
 *    Standardized_Brand there and run the menu. Per typed name (resolveCorrectedStore):
 *      - a Master store for that Warehouse Name + WH Partner      -> used as is
 *      - a Store Alias name                                       -> used as is
 *      - a Master Standardized_Brand (or one matching by name)    -> the brand's single Master store of that warehouse
 *        when its Finance fields really give that brand, otherwise the typed name stays the Official Store and Finance
 *        Data takes Brand / Mapping Brand from the Master brand (WHP / Subsidiary from the warehouse)
 *      - anything else                                            -> stays Unmapped and is listed in the completion alert
 *    The row's Mapping Source becomes "Manual (DB Audit)". Typed values are copied into the rebuilt DB Audit sheet, so
 *    they survive further re-runs. Both re-run menus also give a database store that the Master does not know its
 *    Brand BY NAME (CONFIG.AUTO_BRAND_NAME_MATCH), but only where the warehouse holds several brands in the Master
 *    (Finance Data would otherwise stay Unmapped); every name matched this way is listed in the completion alert.
 *
 * Output file name = <source file name> + " - Mapping Output"
 * e.g. "202607 CBM Daily - 31072026" -> "202607 CBM Daily - 31072026 - Mapping Output"
 *
 * Optimized for 120K+ rows with batch processing & in-memory lookups
 */


// Configuration
const CONFIG = {
  FOLDER_ID: '1w2mNAmB6hhOAxMxk_XepnvvbWmqF0FBP',
  MASTER_MAPPING_SHEET_ID: '1fsTOaCZP1phz9v7baFApbBrrfDKj6_0U3qfrYqSy3ck',
  MASTER_MAPPING_SHEET_NAME: 'Master Data - Mapping Brands, WHP, and Subsidiary',

  // "Reconciliation Mapping" tab inside the same Master Data file. Header row:
  // "Source Official Store (AC)", "Remarks", "Mapping". Mapping holds a Standardized_Brand (Master column F)
  // value. Key = the daily file's own Official Store (AC) + the kind of Remarks the row had
  // (Unmapped / Store name not found in Master / Multiple Mapping).
  RECONCILIATION_SHEET_NAME: 'Reconciliation Mapping',
  RECON_HEADER_AC: 'Source Official Store (AC)',
  RECON_HEADER_REMARKS: 'Remarks',
  RECON_HEADER_MAPPING: 'Mapping',

  // External SKU -> Official Store lookup database ("Database SKU Mapping Brand").
  // Header row: Official_Store, Warehouse, Marketplace, SKU
  // The lookup key is SKU (normalized: trimmed + upper-cased). The Warehouse column is used to pick the
  // store that applies to the pivot row's warehouse (blank Warehouse = valid for every warehouse).
  // The Marketplace column is not used (the daily stock file has no marketplace).
  SKU_DB_SHEET_ID: '1xPDrAeoDumdnB3AGHZDeB9X1ART_FeKYWx3_knuZXYs',
  SKU_DB_SHEET_NAME: 'SKU Listing',
  SKU_DB_COL_OFFICIAL_STORE: 0,      // A - Official_Store
  SKU_DB_COL_WAREHOUSE: 1,           // B - Warehouse (blank = applies to every warehouse)
  SKU_DB_COL_SKU: 3,                 // D - SKU

  // "Store Alias" tab inside the Master Data file (optional). One row per Official Store name used by the SKU
  // database that the Master does not know: Official_Store (DB) -> Standardized_Brand / Standardized_Mapping Brand.
  // Brand and Mapping Brand are store-level facts; WHP and Subsidiary stay warehouse-level (from the Master).
  STORE_ALIAS_SHEET_NAME: 'Store Alias',
  ALIAS_HEADER_STORE: 'Official_Store (DB)',
  ALIAS_HEADER_BRAND: 'Standardized_Brand',
  ALIAS_HEADER_MAPPING_BRAND: 'Standardized_Mapping Brand',

  SKU_MAPPING_SHEET_NAME: 'SKU Mapping Brand',
  UNMAPPED_SKU_SHEET_NAME: 'Unmapped SKU',
  DB_AUDIT_SHEET_NAME: 'DB Audit',
  DB_AUDIT_MAX_ROWS: 5000,           // max mismatch rows listed in the DB Audit sheet
  // Column H of the DB Audit list is filled in by hand with the correct store; the "re-run after DB Audit correction"
  // menu reads it. Located by header text first (so inserting columns later does not break it), column H as fallback.
  DB_AUDIT_HEADER_ROW: 9,
  DB_AUDIT_CORRECT_HEADER: 'CORRECT STORE (to fill in and re run)',
  DB_AUDIT_CORRECT_COL: 8,           // H (1-based)
  // At every re-run, a database store that the Master does not know and that no Store Alias / Reconciliation Mapping
  // resolves gets its Standardized_Brand from the Master by NAME (e.g. "Maybelline Official" -> brand "Maybelline",
  // looked up first among the brands of the same warehouse). false = only the Store Alias tab / Reconciliation Mapping.
  AUTO_BRAND_NAME_MATCH: true,
  RAW_DATA_SHEET_NAME: 'Raw Data SCM',
  FINANCE_DATA_SHEET_NAME: 'Finance Data',
  BREAKDOWN_SHEET_NAME: 'Breakdown',

  // Expected tab name inside the source daily report file. If not found, the script
  // falls back to the first sheet in the file (with a warning in the logs).
  SOURCE_SHEET_NAME: 'Raw_SCM_Data',

  // Appended to the source file's name to build the output spreadsheet name
  OUTPUT_FILE_SUFFIX: ' - Mapping Output',

  // Only files whose name contains this text are offered in the source file picker
  SOURCE_FILE_NAME_FILTER: 'CBM Daily',

  // Header names of the raw data columns. The columns are located BY HEADER NAME in row 1 of the
  // source tab (trimmed, case-insensitive, first match wins) instead of by fixed column letters,
  // because the column positions differ between monthly files (e.g. the 202606 file has one column
  // fewer than 202609, which silently shifted Official Store / Warehouse Name / WH Partner / CBM Avail).
  HEADER_PRINCIPAL: 'Principal',           // supporting info for the Unmapped SKU worklist
  HEADER_SKU: 'SKU',                       // main mapping key
  HEADER_PRODUCT: 'Product',               // supporting info for the Unmapped SKU worklist
  HEADER_OFFICIAL_STORE: 'Official Store', // fallback only (step c of the mapping chain)
  HEADER_WAREHOUSE_NAME: 'Warehouse Name',
  HEADER_WH_PARTNER: 'WH Partner',
  HEADER_CBM_AVAIL: 'CBM Avail',

  // Column indices for the Master Mapping sheet (0-based).
  // Composite key = MASTER_COL_OFFICIAL_STORE + MASTER_COL_WAREHOUSE_NAME + MASTER_COL_WH_PARTNER
  // Mapped outputs come from MASTER_COL_STD_BRAND / _STD_MAPPING_BRAND / _STD_WHP / _STD_SUBSIDIARY.
  // Verified directly against the live Master Mapping sheet header row:
  // "Official Store, FixCategory, Warehouse Name, WH Partner, Type 2, Standardized_Brand,
  //  Standardized_Mapping Brand, Standardized_WHP, Standardized_Subsidiary"
  MASTER_COL_OFFICIAL_STORE: 0,      // A
  MASTER_COL_WAREHOUSE_NAME: 2,      // C
  MASTER_COL_WH_PARTNER: 3,          // D
  MASTER_COL_STD_BRAND: 5,           // F - Standardized_Brand
  MASTER_COL_STD_MAPPING_BRAND: 6,   // G - Standardized_Mapping Brand
  MASTER_COL_STD_WHP: 7,             // H - Standardized_WHP
  MASTER_COL_STD_SUBSIDIARY: 8,      // I - Standardized_Subsidiary

  // Used in place of a blank SKU / Warehouse Name / WH Partner so that rows
  // with an incomplete key are still grouped and their CBM Avail is never lost
  BLANK_PLACEHOLDER: '(blank)',

  // Official Store value / Remarks text for SKUs that cannot be mapped
  UNMAPPED_LABEL: 'Unmapped',

  // Labels written to the "Mapping Source" column of the SKU Mapping Brand sheet
  SOURCE_SKU_DB: 'SKU Database',
  SOURCE_SKU_DB_MASTER: 'SKU Database + Master',
  SOURCE_SKU_DB_NO_MASTER: 'SKU Database (not in Master)',
  SOURCE_WAREHOUSE: 'Warehouse (Master)',
  SOURCE_OFFICIAL_STORE: 'Source Official Store (AC)',
  SOURCE_RECONCILIATION: 'Reconciliation Mapping',
  SOURCE_MANUAL: 'Manual (Unmapped SKU sheet)',
  SOURCE_MANUAL_AUDIT: 'Manual (DB Audit)',
  SOURCE_UNMAPPED: 'Unmapped',

  // Column order of the WH Partner columns in the "Breakdown" sheet (per "Urutan Kolom.xlsx").
  // Matching is case/spacing-insensitive. Partners that appear in the data but are not listed here
  // (e.g. "Unmapped") are placed after these, alphabetically, just before the Total column.
  // Listed partners with no CBM in a run get no column (columns stay data-driven).
  BREAKDOWN_WHP_ORDER: ['KLOG Surabaya', 'KLOG Benoa', 'Oxygen', 'Storaflow', 'Biteship', 'IPP', 'BSS', 'DAF', 'BKS', 'GUJ', 'KLI', 'NMR', 'SMC', 'CAS', 'Vertikal', 'MCL', 'TMS'],

  // Max number of store names listed in the Remarks of a SKU that maps to several stores
  MULTIPLE_MAPPING_MAX_STORES_SHOWN: 5,

  // Number of warehouses listed in the "unmapped CBM per warehouse" table of the Unmapped SKU sheet
  UNMAPPED_WAREHOUSE_TOP_N: 30,

  // Tolerance (in CBM units) below which a variance is still reported as a MATCH,
  // to absorb harmless floating-point rounding noise from summing large row counts
  RECONCILIATION_TOLERANCE: 0.01
};


/**
 * Main execution function
 * User triggers this from Apps Script UI
 */
function processScmDailyReport() {
  const startedAt = Date.now();
  const logElapsed = label => console.log(`[timing] ${label}: ${((Date.now() - startedAt) / 1000).toFixed(1)}s elapsed`);

  try {
    console.log('=== SCM Daily Report Processing Started ===');

    // Step 1: Let the user choose which daily report file to process
    const reportFile = selectDailyReportFile();
    if (!reportFile) {
      console.log('No source file selected. Processing cancelled.');
      return;
    }

    console.log(`Processing file: ${reportFile.getName()}`);

    // Step 2: Extract raw data from the selected file, along with the TRUE original
    // CBM Avail total (sum of every value in the CBM Avail column). Zero-CBM rows are left out of rawData.
    const extraction = extractRawDataFromFile(reportFile);
    const rawData = extraction.rawData;
    const originalTotalCbm = extraction.originalTotalCbm;
    console.log(`Raw data extracted: ${rawData.length} rows with CBM <> 0 (${extraction.zeroCbmRowsSkipped} zero-CBM rows left out). Original CBM Avail total: ${originalTotalCbm}`);
    logElapsed('after extraction');

    // Step 3: Load Master Mapping data (needed by the SKU mapping fallback chain AND by Finance Data)
    const masterMapping = loadMasterMappingData();
    console.log(`Master mapping loaded`);
    logElapsed('after Master Mapping load');

    // Step 4: Pivot by SKU x Warehouse Name x WH Partner (SUMIFS-equivalent on CBM Avail),
    // then map every SKU to an Official Store using the fallback chain
    const skuPivot = buildSkuPivot(rawData);
    logElapsed('after SKU pivot');
    const skuLookup = loadSkuMappingDatabase();
    logElapsed('after SKU database load');
    const reconLookup = loadReconciliationMapping();
    logElapsed('after Reconciliation Mapping load');
    const storeAlias = loadStoreAlias();
    logElapsed('after Store Alias load');
    const skuMappedData = mapSkuToOfficialStore(skuPivot, skuLookup, masterMapping, reconLookup, storeAlias);
    const skuMappingTotal = sumCbmAvail(skuMappedData);
    console.log(`SKU pivot built: ${skuMappedData.length} rows. SKU Mapping Brand total: ${skuMappingTotal}`);

    // Step 5: Create output spreadsheet named "<source file name> - Mapping Output"
    const outputFileName = `${reportFile.getName()}${CONFIG.OUTPUT_FILE_SUFFIX}`;
    const outputSpreadsheet = createOutputSpreadsheet(outputFileName);
    console.log(`Output spreadsheet created: ${outputSpreadsheet.getUrl()}`);

    // Step 6: Generate "SKU Mapping Brand" sheet FIRST, with its reconciliation control
    // (Original Raw Data CBM Avail Total vs SKU Mapping Brand Column D Total) and mapping-source summary
    const skuMappingResult = createSkuMappingSheet(outputSpreadsheet, skuMappedData, originalTotalCbm, skuMappingTotal);
    console.log(`SKU Mapping Brand sheet created with ${skuMappedData.length} rows (${skuMappingResult.unmappedRows} unmapped)`);
    logElapsed('after SKU Mapping Brand sheet');

    // Step 6b: "Unmapped SKU" worklist (unmapped SKUs by CBM, plus unmapped CBM per warehouse)
    createUnmappedSkuSheet(outputSpreadsheet, skuMappedData);
    logElapsed('after Unmapped SKU sheet');

    // Step 6c: "DB Audit": every SKU that exists in the SKU database vs its final Official Store
    const dbAudit = createDbAuditSheet(outputSpreadsheet, skuMappedData, skuLookup, storeAlias);
    console.log(`DB Audit: ${dbAudit.summary.inDbRows} rows in database, ${dbAudit.summary.mismatchRows} differ from the database`);
    logElapsed('after DB Audit sheet');

    // Step 7: Generate "Raw Data SCM" sheet, only after SKU Mapping Brand is confirmed complete.
    // Official Store comes from the SKU mapping; rows are deduplicated on
    // Official Store + Warehouse Name + WH Partner, summing CBM Avail.
    if (!outputSpreadsheet.getSheetByName(CONFIG.SKU_MAPPING_SHEET_NAME)) {
      throw new Error(`"${CONFIG.SKU_MAPPING_SHEET_NAME}" sheet was not created successfully; aborting before generating Raw Data SCM.`);
    }
    const dedupData = deduplicateAndSumData(skuMappedData);
    const rawDataSCMTotal = sumCbmAvail(dedupData);
    console.log(`Deduplicated to ${dedupData.length} unique combinations. Raw Data SCM total: ${rawDataSCMTotal}`);
    const rawDataReconciliation = createRawDataSheet(outputSpreadsheet, dedupData, originalTotalCbm, rawDataSCMTotal);
    console.log(`Raw Data SCM sheet created with ${dedupData.length} rows`);
    logElapsed('after Raw Data SCM sheet');

    // Step 8: Generate "Finance Data" sheet, only after Raw Data SCM is confirmed complete.
    // Uses the composite-key Master Mapping lookup, fed from the corrected Raw Data SCM records.
    // Each field is mapped independently: composite key found -> Master values; otherwise each field
    // falls back to the warehouse (when the warehouse's Master rows agree), else "Unmapped" for that
    // specific field only (entire row is not marked as unmapped).
    if (!outputSpreadsheet.getSheetByName(CONFIG.RAW_DATA_SHEET_NAME)) {
      throw new Error(`"${CONFIG.RAW_DATA_SHEET_NAME}" sheet was not created successfully; aborting before generating Finance Data.`);
    }
    const financeData = standardizeDataForFinance(dedupData, masterMapping, storeAlias);
    const financeTotal = sumCbmAvail(financeData);
    const financeReconciliation = createFinanceDataSheet(outputSpreadsheet, financeData, rawDataSCMTotal, financeTotal);
    console.log(`Finance Data sheet created with ${financeData.length} rows`);
    logElapsed('after Finance Data sheet');

    // Step 9: Generate "Breakdown" sheet, only after Finance Data is confirmed complete.
    // Applies the same field-level independent mapping logic. Only includes "unmapped" WHP column
    // when Standardized_WHP field in Finance Data is actually unmapped.
    if (!outputSpreadsheet.getSheetByName(CONFIG.FINANCE_DATA_SHEET_NAME)) {
      throw new Error(`"${CONFIG.FINANCE_DATA_SHEET_NAME}" sheet was not created successfully; aborting before generating Breakdown.`);
    }
    const breakdownResult = createBreakdownSheet(outputSpreadsheet, financeData, financeTotal);
    console.log(`Breakdown sheet created with ${breakdownResult.rowCount} rows`);
    logElapsed('after Breakdown sheet');

    // Remove the temporary placeholder sheet created with the spreadsheet, now that all
    // real sheets exist
    const tempSheet = outputSpreadsheet.getSheetByName('_Temp');
    if (tempSheet) {
      outputSpreadsheet.deleteSheet(tempSheet);
    }

    // Consolidated reconciliation summary across every layer
    const reconciliationSummary =
      `Original Raw Data -> SKU Mapping Brand: ${skuMappingResult.reconciliation.status} (variance ${skuMappingResult.reconciliation.variance})\n` +
      `Original Raw Data -> Raw Data SCM: ${rawDataReconciliation.status} (variance ${rawDataReconciliation.variance})\n` +
      `Raw Data SCM -> Finance Data: ${financeReconciliation.status} (variance ${financeReconciliation.variance})\n` +
      `Finance Data -> Breakdown: ${breakdownResult.reconciliation.status} (variance ${breakdownResult.reconciliation.variance})`;

    const sourceSummaryLines = skuMappingResult.sourceSummary
      .map(s => `${s.label}: ${s.rows} rows, CBM ${s.cbm.toFixed(2)}`)
      .join('\n');

    const auditLines = describeDbAudit(dbAudit.summary);

    showAlert('Success', `Processing completed successfully!\n\nSource file: ${reportFile.getName()}\nOutput file: ${outputFileName}\nOutput URL: ${outputSpreadsheet.getUrl()}\n\nCBM Reconciliation:\n${reconciliationSummary}\n\nMapping Source:\n${sourceSummaryLines}\n\nSKU Database check (sheet "${CONFIG.DB_AUDIT_SHEET_NAME}"):\n${auditLines}`);
    console.log('=== SCM Daily Report Processing Completed ===');
    console.log(reconciliationSummary);
    console.log(sourceSummaryLines);
    console.log(auditLines);

  } catch (error) {
    console.error(`Error: ${error.message}\n${error.stack}`);
    showAlert('Error', `Processing failed: ${error.message}`);
  }
}


/**
 * Let the user choose which daily report source file to process.
 * Lists all matching files in the source folder (most recently modified first) and
 * prompts the user to pick one by number, instead of silently picking the latest file.
 *
 * Returns the selected DriveApp File, or null if the user cancelled / made no valid selection.
 */
function selectDailyReportFile() {
  return selectFileFromFolder(false);
}


/**
 * Shared file picker. outputFiles = false lists the SOURCE daily report files (names containing
 * CONFIG.SOURCE_FILE_NAME_FILTER, excluding "Mapping Output" files); outputFiles = true lists the
 * generated "Mapping Output" files (used by the re-run menu). Returns a DriveApp File or null.
 */
function selectFileFromFolder(outputFiles) {
  const ui = SpreadsheetApp.getUi();
  const folder = DriveApp.getFolderById(CONFIG.FOLDER_ID);
  const files = folder.getFilesByType(MimeType.GOOGLE_SHEETS);

  const fileList = [];
  while (files.hasNext()) {
    const file = files.next();
    const name = file.getName();
    const isOutput = name.includes(CONFIG.OUTPUT_FILE_SUFFIX);
    if (outputFiles ? isOutput : (name.includes(CONFIG.SOURCE_FILE_NAME_FILTER) && !isOutput)) {
      fileList.push(file);
    }
  }

  if (fileList.length === 0) {
    const what = outputFiles ? `"${CONFIG.OUTPUT_FILE_SUFFIX.trim()}"` : `"${CONFIG.SOURCE_FILE_NAME_FILTER}"`;
    ui.alert('No Files Found', `No files containing ${what} were found in the source folder.`, ui.ButtonSet.OK);
    return null;
  }

  // Sort by last modified date, most recent first (for display convenience only —
  // the user still explicitly picks which one to process)
  fileList.sort((a, b) => b.getLastUpdated() - a.getLastUpdated());

  const listLines = fileList.map((file, idx) => {
    const modified = Utilities.formatDate(file.getLastUpdated(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
    return `${idx + 1}. ${file.getName()}   (modified: ${modified})`;
  });

  const promptMessage = `Enter the number of the ${outputFiles ? 'output file to re-run' : 'source file to process'}:\n\n${listLines.join('\n')}`;
  const response = ui.prompt(outputFiles ? 'Select Output File' : 'Select Source File', promptMessage, ui.ButtonSet.OK_CANCEL);

  if (response.getSelectedButton() !== ui.Button.OK) {
    return null; // user cancelled
  }

  const selection = parseInt(response.getResponseText().trim(), 10);
  if (isNaN(selection) || selection < 1 || selection > fileList.length) {
    ui.alert('Invalid Selection', `Please enter a number between 1 and ${fileList.length}.`, ui.ButtonSet.OK);
    return null;
  }

  return fileList[selection - 1];
}


/**
 * Normalize a SKU value for matching and grouping: trimmed and upper-cased, so that stray
 * spaces or letter-case differences do not cause a SKU to be reported as Unmapped.
 */
function normalizeSku(value) {
  return String(value === null || value === undefined ? '' : value).replace(INVISIBLE_CHARS, '').trim().toUpperCase();
}


// Zero-width characters (zero-width space / joiners, word joiner, BOM) that survive trim() and silently break matching
const INVISIBLE_CHARS = /[\u200B-\u200D\u2060\uFEFF]/g;


/**
 * Normalize a text value for key matching: collapse repeated whitespace, trim and lower-case.
 * Used for Official Store / Warehouse Name / WH Partner keys so that "First Step" vs "First step",
 * or a stray double space, still match the Master Mapping.
 */
function normKey(value) {
  return String(value === null || value === undefined ? '' : value).replace(INVISIBLE_CHARS, '').replace(/\s+/g, ' ').trim().toLowerCase();
}


/**
 * Composite key Official Store | Warehouse Name | WH Partner (normalized; blanks become the
 * BLANK_PLACEHOLDER). Used by the Master Mapping lookup, the SKU mapping chain and the
 * Raw Data SCM de-duplication, so all of them agree on what "the same combination" means.
 */
function compositeKey(officialStore, warehouseName, whPartner) {
  return [
    normKey(officialStore) || CONFIG.BLANK_PLACEHOLDER,
    normKey(warehouseName) || CONFIG.BLANK_PLACEHOLDER,
    normKey(whPartner) || CONFIG.BLANK_PLACEHOLDER
  ].join('|');
}


/**
 * Key Warehouse Name | WH Partner (normalized), used by the warehouse-level fallback.
 */
function warehouseKey(warehouseName, whPartner) {
  return [
    normKey(warehouseName) || CONFIG.BLANK_PLACEHOLDER,
    normKey(whPartner) || CONFIG.BLANK_PLACEHOLDER
  ].join('|');
}


/**
 * Extract raw data from Google Sheet using batch processing
 * Optimized for 120K+ rows by reading in chunks instead of all at once
 *
 * Returns { rawData, originalTotalCbm, zeroCbmRowsSkipped }:
 *  - rawData: array of { sku, warehouseName, whPartner, cbmAvail, sourceOfficialStore, principal, product }
 *    for every row whose CBM Avail is not 0. A row missing SKU, Warehouse Name, and/or WH Partner
 *    is still included, with CONFIG.BLANK_PLACEHOLDER substituted for whichever field(s) are
 *    blank, so its CBM Avail is never lost. SKU is normalized (trim + upper-case).
 *  - originalTotalCbm: the TRUE sum of the CBM Avail column across every row read — the authoritative
 *    "original raw data" total for reconciliation.
 *  - zeroCbmRowsSkipped: rows with CBM Avail = 0, which are left out because they add nothing
 *    to any total (this also covers genuinely empty padding rows).
 */
function extractRawDataFromFile(file) {
  // Use openById for better Google Sheets compatibility
  const spreadsheet = SpreadsheetApp.openById(file.getId());

  // Prefer the expected "Raw_SCM_Data" tab; fall back to the first sheet if not found
  let sheet = spreadsheet.getSheetByName(CONFIG.SOURCE_SHEET_NAME);
  if (!sheet) {
    console.warn(`Sheet "${CONFIG.SOURCE_SHEET_NAME}" not found in "${file.getName()}"; falling back to the first sheet.`);
    sheet = spreadsheet.getSheets()[0];
  }

  // Get total row count
  const lastRow = sheet.getLastRow();
  console.log(`Total rows in sheet: ${lastRow}`);

  if (lastRow <= 1) {
    throw new Error('Sheet has no data (only headers)');
  }

  // Locate the required columns by header name (see CONFIG.HEADER_*)
  const headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const findColumn = headerName => {
    const target = normKey(headerName);
    const idx = headerRow.findIndex(h => normKey(h) === target);
    if (idx === -1) {
      throw new Error(`Column "${headerName}" was not found in the header row of "${sheet.getName()}" (${file.getName()}).`);
    }
    return idx;
  };
  const cols = {
    principal: findColumn(CONFIG.HEADER_PRINCIPAL),
    sku: findColumn(CONFIG.HEADER_SKU),
    product: findColumn(CONFIG.HEADER_PRODUCT),
    officialStore: findColumn(CONFIG.HEADER_OFFICIAL_STORE),
    warehouseName: findColumn(CONFIG.HEADER_WAREHOUSE_NAME),
    whPartner: findColumn(CONFIG.HEADER_WH_PARTNER),
    cbmAvail: findColumn(CONFIG.HEADER_CBM_AVAIL)
  };
  const colLetter = idx => {
    let n = idx + 1, s = '';
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  };
  console.log('Source columns detected by header: ' + Object.keys(cols).map(k => `${k}=${colLetter(cols[k])}`).join(', '));

  const rawData = [];
  let originalTotalCbm = 0;
  let zeroCbmRowsSkipped = 0;
  const batchSize = 30000; // Read 30K rows at a time (only a few narrow columns per batch, so this is cheap)
  const startRow = 2; // Skip header row (row 1)

  // Process in batches
  for (let currentRow = startRow; currentRow <= lastRow; currentRow += batchSize) {
    const endRow = Math.min(currentRow + batchSize - 1, lastRow);
    const rowCount = endRow - currentRow + 1;

    console.log(`Reading rows ${currentRow} to ${endRow} (${rowCount} rows)...`);

    try {
      // Read ONLY the required columns (one narrow range each) instead of columns A-BM.
      const readColumn = colIndex => sheet.getRange(currentRow, colIndex + 1, rowCount, 1).getValues();
      const principalValues = readColumn(cols.principal);
      const skuValues = readColumn(cols.sku);
      const productValues = readColumn(cols.product);
      const storeValues = readColumn(cols.officialStore);
      const whNameValues = readColumn(cols.warehouseName);
      const whPartnerValues = readColumn(cols.whPartner);
      const cbmValues = readColumn(cols.cbmAvail);

      // Process this batch
      for (let i = 0; i < rowCount; i++) {
        const cbmAvail = parseFloat(cbmValues[i][0]) || 0;

        // Accumulate the TRUE original total regardless of anything else
        originalTotalCbm += cbmAvail;

        // Zero-CBM rows contribute nothing to any total; leave them out of the pivot
        if (cbmAvail === 0) {
          zeroCbmRowsSkipped++;
          continue;
        }

        const sku = normalizeSku(skuValues[i][0]);
        const warehouseName = String(whNameValues[i][0] || '').trim();
        const whPartner = String(whPartnerValues[i][0] || '').trim();

        rawData.push({
          sku: sku || CONFIG.BLANK_PLACEHOLDER,
          warehouseName: warehouseName || CONFIG.BLANK_PLACEHOLDER,
          whPartner: whPartner || CONFIG.BLANK_PLACEHOLDER,
          cbmAvail: cbmAvail,
          sourceOfficialStore: String(storeValues[i][0] || '').trim(),
          principal: String(principalValues[i][0] || '').trim(),
          product: String(productValues[i][0] || '').trim()
        });
      }

      console.log(`  ✓ Batch processed. Records kept so far: ${rawData.length}`);

    } catch (error) {
      console.error(`Error reading rows ${currentRow}-${endRow}: ${error.message}`);
      throw error;
    }
  }

  console.log(`Raw data extraction complete: ${rawData.length} records kept, ${zeroCbmRowsSkipped} zero-CBM rows left out. Original CBM Avail total: ${originalTotalCbm}`);
  return { rawData, originalTotalCbm, zeroCbmRowsSkipped };
}


/**
 * Pivot the extracted raw data by SKU + Warehouse Name + WH Partner (SUMIFS-equivalent),
 * summing CBM Avail. Warehouse Name and WH Partner are kept in the pivot so the later
 * Raw Data SCM / Finance Data / Breakdown steps still have the full key they need.
 * The first non-blank Official Store (AC), Principal and Product seen for a pivot row are
 * carried along (used by the fallback chain and by the Unmapped SKU worklist).
 * The total CBM Avail is unchanged by this step.
 */
function buildSkuPivot(rawData) {
  const pivotMap = new Map();

  for (const row of rawData) {
    const key = `${row.sku}|${row.warehouseName}|${row.whPartner}`;
    const existing = pivotMap.get(key);

    if (existing) {
      existing.cbmAvail += row.cbmAvail;
      if (!existing.sourceOfficialStore && row.sourceOfficialStore) existing.sourceOfficialStore = row.sourceOfficialStore;
      if (!existing.principal && row.principal) existing.principal = row.principal;
      if (!existing.product && row.product) existing.product = row.product;
    } else {
      pivotMap.set(key, {
        sku: row.sku,
        warehouseName: row.warehouseName,
        whPartner: row.whPartner,
        cbmAvail: row.cbmAvail,
        sourceOfficialStore: row.sourceOfficialStore,
        principal: row.principal,
        product: row.product
      });
    }
  }

  // Sort by SKU | Warehouse | Partner using a precomputed key and a plain string comparison.
  // (localeCompare on 100K+ rows is very slow in Apps Script.)
  const keyed = [];
  pivotMap.forEach((row, key) => keyed.push([key, row]));
  keyed.sort((a, b) => (a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0)));

  return keyed.map(pair => pair[1]);
}


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
    const scopes = [entry.generic].concat(entry.byWarehouse ? Array.from(entry.byWarehouse.values()) : []);
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
 *   byWarehouse: Map(normalized Warehouse -> stores listed for that warehouse), or null when the SKU has no
 *                warehouse-specific rows
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
      entry = { stores: [], generic: [], byWarehouse: null }; // byWarehouse is created only when needed (140K+ SKUs)
      lookup.set(sku, entry);
    }

    addDistinct(entry.stores, store);
    if (warehouse) {
      if (!entry.byWarehouse) entry.byWarehouse = new Map();
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
  const specific = entry.byWarehouse ? entry.byWarehouse.get(normKey(warehouseName)) : null;
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
 *     Official Store of that brand at this Warehouse Name + WH Partner. Only for rows the database did not decide.
 *  e) The database decided on a store the Master does not know (evaluated right after a): the database store
 *     STAYS the Official Store. For Finance Data the row gets a separate "Master key" store (found through the
 *     Reconciliation Mapping) and/or Brand + Mapping Brand from the Store Alias tab; Remarks say which.
 *  f) Unmapped.
 *
 * Each result row also carries masterStore ('' unless e) found a Master key) and financeResolved (false only
 * for e) rows that neither the Store Alias nor the Reconciliation Mapping could resolve for Finance Data).
 * cbmAvail is passed through untouched, so the total never changes.
 */
function mapSkuToOfficialStore(skuPivot, skuLookup, masterMapping, reconLookup, storeAlias) {
  const masterHasKey = (store, warehouseName, whPartner) =>
    Object.prototype.hasOwnProperty.call(masterMapping.compositeLookup, compositeKey(store, warehouseName, whPartner));

  const withMapping = (row, officialStore, remarks, mappingSource) =>
    Object.assign({}, row, { officialStore: officialStore, remarks: remarks, mappingSource: mappingSource, masterStore: '', financeResolved: true });

  const reconFailures = new Map(); // reason -> { rows, cbm }, for the log
  const noteReconFailure = (reason, cbm) => {
    const stat = reconFailures.get(reason) || { rows: 0, cbm: 0 };
    stat.rows++;
    stat.cbm += cbm;
    reconFailures.set(reason, stat);
  };

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

    // e) The database decided on a store the Master does not know: it stays the Official Store (no later step may
    //    replace it). Finance Data resolves it separately (Store Alias / Master key via the Reconciliation Mapping).
    if (dbStoreNotInMaster) {
      const fin = resolveFinanceKey(dbStoreNotInMaster, row.sourceOfficialStore, row.warehouseName, row.whPartner, masterMapping, reconLookup, storeAlias);
      if (fin.reason) noteReconFailure(fin.reason, row.cbmAvail);
      return Object.assign(
        withMapping(row, dbStoreNotInMaster, describeNotInMaster(fin), CONFIG.SOURCE_SKU_DB_NO_MASTER),
        { masterStore: fin.masterStore, financeResolved: fin.resolved }
      );
    }

    // d) Reconciliation Mapping (the database did not decide): Source Official Store (AC) + kind of remark ->
    //    Standardized_Brand, then the Master row of that brand at THIS warehouse gives the Official Store
    const remarkKind = multipleMappingRemark ? 'multiple' : 'unmapped';
    const recon = resolveViaReconciliation(row.sourceOfficialStore, row.warehouseName, row.whPartner, remarkKind, masterMapping, reconLookup);
    let reconReason = '';
    if (recon && recon.store) {
      return withMapping(row, recon.store, '', CONFIG.SOURCE_RECONCILIATION);
    }
    if (recon && recon.reason) {
      reconReason = recon.reason;
      noteReconFailure(reconReason, row.cbmAvail);
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
 * For a SKU database store that the Master does not know for this warehouse: how can Finance Data still map it?
 *  - hasAlias    : the Store Alias tab has this store (gives Brand + Mapping Brand)
 *  - masterStore : a Master Official Store found through the Reconciliation Mapping (AC + 'notmaster' -> brand ->
 *                  Master store of that brand at this warehouse); '' when none
 *  - reason      : why the Reconciliation Mapping could not give a Master store (for Remarks / logs)
 *  - resolved    : hasAlias || masterStore
 */
function resolveFinanceKey(officialStore, sourceOfficialStore, warehouseName, whPartner, masterMapping, reconLookup, storeAlias) {
  const aliasEntry = storeAlias ? storeAlias.get(normKey(officialStore)) : null;
  const hasAlias = !!(aliasEntry && (aliasEntry.standardizedBrand || aliasEntry.standardizedMappingBrand));
  const recon = resolveViaReconciliation(sourceOfficialStore, warehouseName, whPartner, 'notmaster', masterMapping, reconLookup);
  const masterStore = recon && recon.store ? recon.store : '';
  return {
    hasAlias: hasAlias,
    masterStore: masterStore,
    reason: recon && recon.reason ? recon.reason : '',
    resolved: hasAlias || !!masterStore
  };
}


/**
 * Remarks text of a SKU database store that is not in the Master (see resolveFinanceKey).
 */
function describeNotInMaster(fin, prefix) {
  const base = prefix || 'Store name not found in Master for this warehouse';
  const parts = [];
  if (fin.masterStore) parts.push(`Master key: ${fin.masterStore}`);
  if (fin.hasAlias) parts.push('Brand via Store Alias');
  if (parts.length > 0) return `${base} (${parts.join('; ')})`;
  return fin.reason ? `${base} - ${fin.reason}` : base;
}


/**
 * Kind of remark a still-open row has, used with the Source Official Store (AC) as the key of the
 * Reconciliation Mapping tab: 'multiple' (SKU listed under several stores), 'notmaster' (database
 * store name not in the Master for this warehouse) or 'unmapped' (everything else).
 */
function remarkKindOf(mappingSource, remarks) {
  if (mappingSource === CONFIG.SOURCE_SKU_DB_NO_MASTER) return 'notmaster';
  const r = normKey(remarks);
  if (r.indexOf('multiple mapping') !== -1) return 'multiple';
  if (r.indexOf('not found in master') !== -1) return 'notmaster';
  return 'unmapped';
}


/**
 * Load the "Reconciliation Mapping" tab of the Master Data file.
 * Returns { byKey: Map("<ac>|<kind>" -> mapping), byAc: Map("<ac>" -> Map of mappings) }.
 * A missing tab only produces a warning (the step is then skipped).
 */
function loadReconciliationMapping() {
  const lookup = { byKey: new Map(), byAc: new Map() };

  const sheet = SpreadsheetApp.openById(CONFIG.MASTER_MAPPING_SHEET_ID).getSheetByName(CONFIG.RECONCILIATION_SHEET_NAME);
  if (!sheet) {
    console.warn(`Tab "${CONFIG.RECONCILIATION_SHEET_NAME}" not found in the Master Data file; the Reconciliation Mapping step is skipped.`);
    return lookup;
  }

  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) {
    console.warn(`Tab "${CONFIG.RECONCILIATION_SHEET_NAME}" has no data rows.`);
    return lookup;
  }

  const header = values[0].map(normKey);
  const colIndex = (name, fallback) => {
    const i = header.indexOf(normKey(name));
    return i === -1 ? fallback : i;
  };
  const cAc = colIndex(CONFIG.RECON_HEADER_AC, 0);
  const cRemarks = colIndex(CONFIG.RECON_HEADER_REMARKS, 1);
  const cMapping = colIndex(CONFIG.RECON_HEADER_MAPPING, 2);

  const conflicts = [];
  for (let i = 1; i < values.length; i++) {
    const ac = normKey(values[i][cAc]);
    const mapping = String(values[i][cMapping] || '').trim();
    if (!ac || !mapping) continue;

    const kind = remarkKindOf('', values[i][cRemarks]);
    const key = `${ac}|${kind}`;
    const existing = lookup.byKey.get(key);
    if (existing === undefined) {
      lookup.byKey.set(key, mapping);
    } else if (normKey(existing) !== normKey(mapping)) {
      conflicts.push(`${values[i][cAc]} (${kind}): "${existing}" vs "${mapping}" (first one kept)`);
    }

    if (!lookup.byAc.has(ac)) lookup.byAc.set(ac, new Map());
    lookup.byAc.get(ac).set(normKey(mapping), mapping);
  }

  console.log(`Reconciliation Mapping loaded: ${lookup.byKey.size} AC + remark combinations`);
  if (conflicts.length > 0) {
    console.warn(`Reconciliation Mapping has conflicting rows:\n${conflicts.join('\n')}`);
  }
  return lookup;
}


/**
 * Resolve an Official Store for a still-open row through the Reconciliation Mapping.
 *
 *  1. Mapping (a Standardized_Brand) = lookup of Source Official Store (AC) + remark kind; if that exact
 *     combination is missing, the AC's mapping is used when the AC has only one distinct mapping.
 *  2. The Master rows whose Standardized_Brand = Mapping AND whose Warehouse Name + WH Partner = this row's
 *     give the Official Store. Exactly one store -> use it (so Finance Data finds the key). Several stores ->
 *     the one equal to the AC, otherwise unresolved.
 *
 * Returns { store } when resolved, { reason } when a mapping exists but the Master cannot confirm it,
 * or null when there is nothing to look up (no AC, or no mapping for it).
 */
function resolveViaReconciliation(sourceOfficialStore, warehouseName, whPartner, remarkKind, masterMapping, reconLookup) {
  if (!reconLookup) return null;
  const ac = normKey(sourceOfficialStore);
  if (!ac) return null;

  let mapping = reconLookup.byKey.get(`${ac}|${remarkKind}`);
  if (mapping === undefined) {
    const all = reconLookup.byAc.get(ac);
    if (all && all.size === 1) mapping = Array.from(all.values())[0];
  }
  if (mapping === undefined) return null;

  const stores = masterMapping.brandLookup.get(`${normKey(mapping)}|${warehouseKey(warehouseName, whPartner)}`);
  if (stores && stores.length === 1) return { store: stores[0] };
  if (stores && stores.length > 1) {
    const own = stores.find(s => normKey(s) === ac);
    if (own) return { store: own };
    return { reason: `Reconciliation Mapping: brand "${mapping}" has several stores for this warehouse (${stores.slice(0, 3).join(' | ')})` };
  }
  if (masterMapping.brandNames.has(normKey(mapping))) {
    return { reason: `Reconciliation Mapping: brand "${mapping}" has no Master row for this warehouse` };
  }
  return { reason: `Reconciliation Mapping: brand "${mapping}" is absent from Master` };
}


// Words ignored when a store name is compared with a Standardized_Brand ("Maybelline Official" ~ "Maybelline").
const BRAND_NAME_STOPWORDS = ['official', 'store', 'shop', 'flagship', 'indonesia', 'the'];


/**
 * Comparable word list of a store / brand name: lower-case, apostrophes removed ("L'Oreal" = "LOreal"),
 * punctuation turned into spaces, stop words dropped.
 */
function brandTokens(value) {
  return normKey(value).replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .filter(t => t && BRAND_NAME_STOPWORDS.indexOf(t) === -1);
}


/**
 * Find the Master Standardized_Brand a store NAME refers to (without looking at the Master's Official Store column):
 *   3 = same words ("Garnier Official" ~ "Garnier"), 2 = the brand's words are all in the name ("Garnier Men Official"
 *   ~ "Garnier Men", the longest brand wins), 1 = the name's words are all in the brand ("LOreal Haircare" ~
 *   "LOreal Paris Haircare").
 * The brands present in the row's own warehouse are tried first; only if none matches, every brand of the Master.
 * Returns the brandInfo entry { brand, mappingBrands }, or null when nothing matches or the best match is ambiguous.
 */
function matchBrandByName(name, wKey, masterMapping) {
  const nameTokens = brandTokens(name);
  if (nameTokens.length === 0 || !masterMapping.brandInfo) return null;

  const pick = brandKeys => {
    let best = null; // { score, size, keys: Set }
    for (const key of brandKeys) {
      const info = masterMapping.brandInfo.get(key);
      if (!info) continue;
      const bt = brandTokens(info.brand);
      if (bt.length === 0) continue;
      const inName = bt.every(t => nameTokens.indexOf(t) !== -1);
      const nameInBrand = nameTokens.every(t => bt.indexOf(t) !== -1);
      let score = 0;
      if (inName && nameInBrand) score = 3;
      else if (inName) score = 2;
      else if (nameInBrand) score = 1;
      if (score === 0) continue;
      const size = bt.length;
      if (!best || score > best.score || (score === best.score && score === 2 && size > best.size)) {
        best = { score: score, size: size, keys: new Set([key]) };
      } else if (score === best.score && (score !== 2 || size === best.size)) {
        best.keys.add(key);
      }
    }
    if (!best || best.keys.size !== 1) return null;
    return masterMapping.brandInfo.get(Array.from(best.keys)[0]);
  };

  const inWarehouse = masterMapping.warehouseBrands ? masterMapping.warehouseBrands.get(wKey) : null;
  return (inWarehouse ? pick(inWarehouse) : null) || pick(masterMapping.brandInfo.keys());
}


/**
 * What a store name typed into the "CORRECT STORE" column of DB Audit (or a database store the Master does not
 * know) means for the Raw Data SCM row and for Finance Data. First match wins:
 *   1. the Master has this store for the row's Warehouse Name + WH Partner             -> used as is
 *   2. the Store Alias tab has it                                                      -> used as is (Brand via Store Alias)
 *   3. it equals a Master Standardized_Brand (or, by name, matches one: matchBrandByName):
 *        - the brand has exactly ONE Master store at this warehouse and that store's Finance fields really give this
 *          brand -> that Master store becomes the Official Store (unless keepStore: the store name is not replaced)
 *        - otherwise the typed name stays the Official Store and gets a store alias {Brand, Mapping Brand} derived
 *          from the Master, plus a Master "key" store of the warehouse for WHP / Subsidiary
 *   4. nothing matches                                                                 -> unresolved (Finance stays Unmapped)
 * Returns { officialStore, masterStore, alias, resolved, remarks, how }; alias is a store-alias entry to add to the
 * working Store Alias map (or null).
 */
function resolveCorrectedStore(typed, warehouseName, whPartner, masterMapping, storeAlias, keepStore) {
  const name = String(typed || '').trim();
  const result = (extra) => Object.assign({ officialStore: name, masterStore: '', alias: null, resolved: true, remarks: '', how: '' }, extra);

  if (Object.prototype.hasOwnProperty.call(masterMapping.compositeLookup, compositeKey(name, warehouseName, whPartner))) {
    return result({ how: 'master' });
  }
  const aliasEntry = storeAlias ? storeAlias.get(normKey(name)) : null;
  if (aliasEntry && (aliasEntry.standardizedBrand || aliasEntry.standardizedMappingBrand)) {
    return result({ how: 'alias', remarks: 'Brand via Store Alias' });
  }

  const wKey = warehouseKey(warehouseName, whPartner);
  let info = masterMapping.brandInfo ? masterMapping.brandInfo.get(normKey(name)) : null;
  let how = 'brand';
  if (!info) {
    info = matchBrandByName(name, wKey, masterMapping);
    how = 'name';
  }
  if (!info) {
    return result({ resolved: false, how: 'none', remarks: `"${name}" is not a Master store, Standardized_Brand or Store Alias name` });
  }

  const stores = masterMapping.brandLookup.get(`${normKey(info.brand)}|${wKey}`) || [];
  if (how === 'brand' && stores.length === 1 && !keepStore) {
    const fields = masterMapping.compositeLookup[compositeKey(stores[0], warehouseName, whPartner)];
    if (fields && normKey(fields.standardizedBrand) === normKey(info.brand)) {
      return result({ officialStore: stores[0], how: 'brand-store', remarks: `Corrected via DB Audit: brand "${info.brand}" -> Master store "${stores[0]}"` });
    }
  }
  const mappingBrands = Array.from(info.mappingBrands.values());
  return result({
    masterStore: stores.length > 0 ? stores[0] : '',
    alias: { store: name, standardizedBrand: info.brand, standardizedMappingBrand: mappingBrands.length === 1 ? mappingBrands[0] : '' },
    how: how === 'name' ? 'name' : 'brand',
    remarks: how === 'name' ? `Brand matched by name: ${info.brand}` : `Brand via Master brand: ${info.brand}`
  });
}


/**
 * Load the optional "Store Alias" tab of the Master Data file (see buildStoreAlias).
 * A missing tab only produces a warning (Brand / Mapping Brand then come from the other fallbacks).
 */
function loadStoreAlias() {
  const sheet = SpreadsheetApp.openById(CONFIG.MASTER_MAPPING_SHEET_ID).getSheetByName(CONFIG.STORE_ALIAS_SHEET_NAME);
  if (!sheet) {
    console.warn(`Tab "${CONFIG.STORE_ALIAS_SHEET_NAME}" not found in the Master Data file; no Store Alias is used.`);
    return new Map();
  }
  const alias = buildStoreAlias(sheet.getDataRange().getValues());
  console.log(`Store Alias loaded: ${alias.size} store names`);
  return alias;
}


/**
 * Build the Store Alias map from the tab values (header row included):
 * normalized Official_Store (DB) -> { store, standardizedBrand, standardizedMappingBrand }.
 * Columns are located by header name (CONFIG.ALIAS_HEADER_*), falling back to columns A, B, C.
 * Rows with a blank store, or with both Brand and Mapping Brand blank, are ignored.
 */
function buildStoreAlias(values) {
  const alias = new Map();
  if (!values || values.length <= 1) return alias;

  const header = values[0].map(normKey);
  const colIndex = (name, fallback) => {
    const i = header.indexOf(normKey(name));
    return i === -1 ? fallback : i;
  };
  const cStore = colIndex(CONFIG.ALIAS_HEADER_STORE, 0);
  const cBrand = colIndex(CONFIG.ALIAS_HEADER_BRAND, 1);
  const cMappingBrand = colIndex(CONFIG.ALIAS_HEADER_MAPPING_BRAND, 2);

  for (let i = 1; i < values.length; i++) {
    const store = String(values[i][cStore] || '').trim();
    const brand = String(values[i][cBrand] || '').trim();
    const mappingBrand = String(values[i][cMappingBrand] || '').trim();
    if (!store || (!brand && !mappingBrand)) continue;
    alias.set(normKey(store), { store: store, standardizedBrand: brand, standardizedMappingBrand: mappingBrand });
  }
  return alias;
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
 * brandInfo / warehouseBrands : Standardized_Brand -> its Mapping Brand(s), and the brands present per warehouse
 *                   (used to resolve a corrected / unknown store name to a Standardized_Brand, see resolveCorrectedStore).
 */
function buildMasterMapping(values) {
  const FIELDS = ['standardizedBrand', 'standardizedMappingBrand', 'standardizedWHP', 'standardizedSubsidiary'];

  const mapping = {
    compositeLookup: {},
    warehouseLookup: new Map(),
    brandLookup: new Map(),
    brandNames: new Set(),
    brandInfo: new Map(),        // normKey(brand) -> { brand, mappingBrands: Map(normKey -> value) }
    warehouseBrands: new Map()   // warehouseKey -> Set of normKey(brand) present in that warehouse
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

      let info = mapping.brandInfo.get(normKey(raw.standardizedBrand));
      if (!info) {
        info = { brand: raw.standardizedBrand, mappingBrands: new Map() };
        mapping.brandInfo.set(normKey(raw.standardizedBrand), info);
      }
      if (raw.standardizedMappingBrand) info.mappingBrands.set(normKey(raw.standardizedMappingBrand), raw.standardizedMappingBrand);
      if (!mapping.warehouseBrands.has(wKey)) mapping.warehouseBrands.set(wKey, new Set());
      mapping.warehouseBrands.get(wKey).add(normKey(raw.standardizedBrand));
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
 * Deduplicate and sum CBM Avail for same combinations (SUMIFS-equivalent).
 * Input rows come from the SKU Mapping Brand step (they carry the mapped officialStore).
 * Key: Official Store | Warehouse Name | WH Partner (normalized: case/spacing-insensitive)
 * Duplicate combinations are collapsed into a single row whose CBM Avail is the SUM
 * of all matching rows (not a count of rows). Many SKUs of the same Official Store in the
 * same Warehouse / WH Partner therefore collapse into one Raw Data SCM row.
 */
function deduplicateAndSumData(mappedData) {
  const dedupMap = new Map();

  for (const row of mappedData) {
    const key = compositeKey(row.officialStore, row.warehouseName, row.whPartner);
    const existing = dedupMap.get(key);

    if (existing) {
      existing.cbmAvail += row.cbmAvail;
      // masterStore (Finance Data lookup key of a SKU database store the Master does not know): keep the first one
      if (!existing.masterStore && row.masterStore) existing.masterStore = row.masterStore;
    } else {
      dedupMap.set(key, {
        officialStore: row.officialStore,
        warehouseName: row.warehouseName,
        whPartner: row.whPartner,
        cbmAvail: row.cbmAvail,
        masterStore: row.masterStore || ''
      });
    }
  }

  // Convert back to array
  return Array.from(dedupMap.values());
}


/**
 * Sum the cbmAvail field across an array of row objects.
 */
function sumCbmAvail(dataArray) {
  let total = 0;
  for (const row of dataArray) {
    total += row.cbmAvail;
  }
  return total;
}


/**
 * Compute variance and MATCH/MISMATCH status between two CBM totals, using
 * CONFIG.RECONCILIATION_TOLERANCE to absorb harmless floating-point rounding noise.
 */
function evaluateReconciliation(totalA, totalB) {
  const variance = totalB - totalA;
  const isMatch = Math.abs(variance) <= CONFIG.RECONCILIATION_TOLERANCE;
  return {
    variance: variance,
    status: isMatch ? '✅ MATCH' : '❌ MISMATCH'
  };
}


/**
 * Write a small CBM Reconciliation Control block into `sheet`, anchored at
 * (anchorRow, anchorCol) and spanning 5 rows x 2 columns:
 *   [CBM Reconciliation Control]
 *   [<labelA> Total]  [totalA]
 *   [<labelB> Total]  [totalB]
 *   [Variance]        [variance]
 *   [Status]          [MATCH/MISMATCH]
 *
 * Returns the { variance, status } result so callers can build a cross-sheet summary.
 */
function writeReconciliationControl(sheet, anchorRow, anchorCol, labelA, totalA, labelB, totalB) {
  const result = evaluateReconciliation(totalA, totalB);

  const rows = [
    ['CBM Reconciliation Control', ''],
    [`${labelA} Total`, totalA],
    [`${labelB} Total`, totalB],
    ['Variance', result.variance],
    ['Status', result.status]
  ];

  sheet.getRange(anchorRow, anchorCol, rows.length, 2).setValues(rows);

  const titleRange = sheet.getRange(anchorRow, anchorCol, 1, 2);
  titleRange.setFontWeight('bold');
  titleRange.setBackground('#FFC000');

  sheet.getRange(anchorRow + 4, anchorCol, 1, 2).setFontWeight('bold');
  sheet.getRange(anchorRow + 1, anchorCol + 1, 3, 1).setNumberFormat('#,##0.00');
  sheet.autoResizeColumns(anchorCol, 2);

  console.log(`Reconciliation [${sheet.getName()}]: ${labelA}=${totalA} vs ${labelB}=${totalB} -> variance=${result.variance}, status=${result.status}`);

  return result;
}


/**
 * Standardize data for Finance sheet using the composite-key Master Mapping lookup.
 *
 * FIELD-LEVEL INDEPENDENT MAPPING:
 *   - composite key (Official Store + Warehouse Name + WH Partner) found -> the four Master values as they are
 *   - composite key NOT found (the SKU database store is not in the Master for that warehouse) -> per field,
 *     the first of these that has a value (the others are tried in order):
 *       Standardized Brand / Mapping Brand : Store Alias tab -> Master key store (row.masterStore, found through
 *                                            the Reconciliation Mapping) -> warehouse -> 'Unmapped'
 *       Standardized_WHP / Subsidiary      : Master key store -> warehouse -> 'Unmapped'
 *     "warehouse" = the value shared by every Master row of that Warehouse Name + WH Partner (null when the rows
 *     disagree). WHP and Subsidiary always come from the Master; the SKU database and the daily file's WH
 *     Partner are never used for them.
 * cbmAvail is a 1:1 pass-through, so totals never change.
 */
function standardizeDataForFinance(dedupData, masterMapping, storeAlias) {
  const financeData = [];
  const notFound = [];
  const stats = { aliasRows: 0, masterKeyRows: 0, warehouseRows: 0, fallbackCbm: 0 };

  const lookup = (store, warehouseName, whPartner) => {
    const key = compositeKey(store, warehouseName, whPartner);
    return Object.prototype.hasOwnProperty.call(masterMapping.compositeLookup, key) ? masterMapping.compositeLookup[key] : null;
  };
  const known = value => !!value && value !== CONFIG.UNMAPPED_LABEL;
  const firstKnown = candidates => {
    for (const c of candidates) {
      if (known(c)) return c;
    }
    return CONFIG.UNMAPPED_LABEL;
  };

  for (const row of dedupData) {
    const match = lookup(row.officialStore, row.warehouseName, row.whPartner);

    let out;
    if (match) {
      out = {
        standardizedBrand: match.standardizedBrand,
        standardizedWHP: match.standardizedWHP,
        standardizedSubsidiary: match.standardizedSubsidiary,
        standardizedMappingBrand: match.standardizedMappingBrand
      };
    } else {
      notFound.push(row);
      const viaMaster = row.masterStore ? lookup(row.masterStore, row.warehouseName, row.whPartner) : null;
      const aliasEntry = storeAlias ? storeAlias.get(normKey(row.officialStore)) : null;
      const wEntry = masterMapping.warehouseLookup.get(warehouseKey(row.warehouseName, row.whPartner));
      const viaWarehouse = name => (wEntry && wEntry.uniformFields ? wEntry.uniformFields[name] : null);

      out = {
        standardizedBrand: firstKnown([aliasEntry && aliasEntry.standardizedBrand, viaMaster && viaMaster.standardizedBrand, viaWarehouse('standardizedBrand')]),
        standardizedWHP: firstKnown([viaMaster && viaMaster.standardizedWHP, viaWarehouse('standardizedWHP')]),
        standardizedSubsidiary: firstKnown([viaMaster && viaMaster.standardizedSubsidiary, viaWarehouse('standardizedSubsidiary')]),
        standardizedMappingBrand: firstKnown([aliasEntry && aliasEntry.standardizedMappingBrand, viaMaster && viaMaster.standardizedMappingBrand, viaWarehouse('standardizedMappingBrand')])
      };

      const anyField = Object.keys(out).some(k => out[k] !== CONFIG.UNMAPPED_LABEL);
      if (anyField) {
        stats.fallbackCbm += row.cbmAvail;
        if (aliasEntry) stats.aliasRows++;
        else if (viaMaster) stats.masterKeyRows++;
        else stats.warehouseRows++;
      }
    }

    out.cbmAvail = row.cbmAvail;
    financeData.push(out);
  }

  // Diagnostic: Official Store | Warehouse Name | WH Partner combinations NOT found in the Master
  // Mapping (largest CBM first), so naming differences are easy to spot in the logs
  if (notFound.length > 0) {
    notFound.sort((a, b) => b.cbmAvail - a.cbmAvail);
    const sample = notFound.slice(0, 15).map(r => `${r.officialStore} | ${r.warehouseName} | ${r.whPartner} -> ${r.cbmAvail.toFixed(2)}`);
    console.warn(`${notFound.length} of ${dedupData.length} Raw Data SCM combinations were not found in the Master Mapping; fields filled by Store Alias: ${stats.aliasRows}, by Master key: ${stats.masterKeyRows}, by warehouse only: ${stats.warehouseRows} (CBM ${stats.fallbackCbm.toFixed(2)}). Top by CBM:\n${sample.join('\n')}`);
  } else {
    console.log('Every Raw Data SCM combination was found in the Master Mapping.');
  }

  return financeData;
}


/**
 * Create output spreadsheet in the same folder.
 * `outputName` should already include the " - Mapping Output" suffix.
 */
function createOutputSpreadsheet(outputName) {
  const folder = DriveApp.getFolderById(CONFIG.FOLDER_ID);
  const spreadsheet = SpreadsheetApp.create(outputName);
  const file = DriveApp.getFileById(spreadsheet.getId());


  // Move to folder
  file.moveTo(folder);


  // Rename default sheet instead of deleting (Google Sheets requires at least one sheet).
  // It is removed once all real sheets have been created (see processScmDailyReport).
  const defaultSheet = spreadsheet.getSheets()[0];
  if (defaultSheet) {
    defaultSheet.setName('_Temp');
  }


  return spreadsheet;
}


/**
 * Create the SKU Mapping Brand sheet (generated first).
 *
 * Columns: SKU | Warehouse Name | WH Partner | CBM Avail | Official Store | Remarks | Mapping Source | Master Key Store
 * Rows are the SKU x Warehouse Name x WH Partner pivot (zero-CBM rows are not included), with the
 * Official Store coming from the fallback chain. Remarks = "Unmapped" (or
 * "Unmapped - Multiple Mapping (...)") only for rows that could not be mapped; "Mapping Source"
 * says which step of the chain produced each Official Store.
 *
 * Right of the table (column I):
 *   - CBM Reconciliation Control at I1 (Original Raw Data CBM Avail Total vs this sheet's Column D Total)
 *   - Mapping Source Summary at I8 (rows, CBM and % of total per mapping source)
 *
 * Returns { reconciliation, unmappedRows, unmappedCbm, sourceSummary }.
 */
function createSkuMappingSheet(spreadsheet, data, originalTotalCbm, skuMappingTotal) {
  const sheet = spreadsheet.insertSheet(CONFIG.SKU_MAPPING_SHEET_NAME);

  // Master Key Store (column H): Master Official Store that Finance Data looks up for a SKU database store the
  // Master does not know (blank otherwise). Persisted so the re-run menu keeps it.
  const headers = ['SKU', 'Warehouse Name', 'WH Partner', 'CBM Avail', 'Official Store', 'Remarks', 'Mapping Source', 'Master Key Store'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  // Write data in batches (performance optimization for large datasets)
  const batchSize = 5000;
  for (let i = 0; i < data.length; i += batchSize) {
    const batch = data.slice(i, Math.min(i + batchSize, data.length));
    const rows = batch.map(row => [
      row.sku,
      row.warehouseName,
      row.whPartner,
      row.cbmAvail,
      row.officialStore,
      row.remarks,
      row.mappingSource,
      row.masterStore || ''
    ]);

    sheet.getRange(2 + i, 1, rows.length, headers.length).setValues(rows);
  }

  // Format header
  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#ED7D31');
  headerRange.setFontColor('#FFFFFF');

  sheet.getRange(2, 4, Math.max(data.length, 1), 1).setNumberFormat('#,##0.00');
  sheet.setFrozenRows(1);

  // Fixed column widths: autoResizeColumns over tens of thousands of rows is very slow
  sheet.setColumnWidth(1, 140); // SKU
  sheet.setColumnWidth(2, 220); // Warehouse Name
  sheet.setColumnWidth(3, 120); // WH Partner
  sheet.setColumnWidth(4, 100); // CBM Avail
  sheet.setColumnWidth(5, 200); // Official Store
  sheet.setColumnWidth(6, 260); // Remarks
  sheet.setColumnWidth(7, 190); // Mapping Source
  sheet.setColumnWidth(8, 180); // Master Key Store

  // Highlight unmapped Remarks with a conditional-format rule (instant, no per-cell writes)
  const remarksRange = sheet.getRange(2, 6, Math.max(data.length, 1), 1);
  const highlightRule = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=LEN($F2)>0')
    .setBackground('#FCE4D6')
    .setRanges([remarksRange])
    .build();
  sheet.setConditionalFormatRules([highlightRule]);

  // Rows / CBM per mapping source
  const sourceSummary = buildSourceSummary(data);
  const unmappedSummary = sourceSummary.find(s => s.label === CONFIG.SOURCE_UNMAPPED);

  // CBM Reconciliation Control at I1
  const reconciliation = writeReconciliationControl(sheet, 1, 9, 'Original Raw Data (CBM Avail)', originalTotalCbm, 'SKU Mapping Brand (Column D)', skuMappingTotal);

  // Mapping Source Summary at I8
  writeMappingSourceSummary(sheet, sourceSummary, data.length, skuMappingTotal);

  return {
    reconciliation,
    unmappedRows: unmappedSummary.rows,
    unmappedCbm: unmappedSummary.cbm,
    sourceSummary
  };
}


/**
 * Create the "Unmapped SKU" worklist sheet (generated right after SKU Mapping Brand).
 *
 * Left table: every SKU row that stayed Unmapped, sorted by CBM Avail (largest first), with the
 * Product, Principal and the daily file's own Official Store (AC) to help decide the right store,
 * plus an empty "Official_Store (to fill in)" column to complete the SKU database.
 * Right table (column K): the Warehouse Name / WH Partner combinations holding the most unmapped
 * CBM, to show where the gap sits.
 */
function createUnmappedSkuSheet(spreadsheet, skuMappedData) {
  const sheet = spreadsheet.insertSheet(CONFIG.UNMAPPED_SKU_SHEET_NAME);

  // "Unmapped" rows, plus "SKU Database (not in Master)" rows that neither the Store Alias nor the Reconciliation
  // Mapping could resolve for Finance Data (resolved ones keep their database Official Store and need no action)
  const unmapped = skuMappedData
    .filter(row => row.mappingSource === CONFIG.SOURCE_UNMAPPED ||
      (row.mappingSource === CONFIG.SOURCE_SKU_DB_NO_MASTER && row.financeResolved === false))
    .sort((a, b) => b.cbmAvail - a.cbmAvail);

  const headers = ['SKU', 'Product', 'Principal', 'Warehouse Name', 'WH Partner', 'CBM Avail', 'Source Official Store (AC)', 'Remarks', 'Official_Store (to fill in)'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  if (unmapped.length > 0) {
    const batchSize = 5000;
    for (let i = 0; i < unmapped.length; i += batchSize) {
      const batch = unmapped.slice(i, Math.min(i + batchSize, unmapped.length));
      const rows = batch.map(row => [
        row.sku,
        row.product,
        row.principal,
        row.warehouseName,
        row.whPartner,
        row.cbmAvail,
        row.sourceOfficialStore,
        row.remarks,
        ''
      ]);
      sheet.getRange(2 + i, 1, rows.length, headers.length).setValues(rows);
    }
    sheet.getRange(2, 6, unmapped.length, 1).setNumberFormat('#,##0.0000');
  } else {
    sheet.getRange(2, 1).setValue('No unmapped SKU - every SKU was mapped.');
  }

  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#C00000');
  headerRange.setFontColor('#FFFFFF');
  sheet.setFrozenRows(1);

  const widths = [140, 280, 130, 220, 110, 100, 190, 260, 200];
  widths.forEach((w, idx) => sheet.setColumnWidth(idx + 1, w));

  // Unmapped CBM per warehouse (top N), right of the worklist (column K, J is a spacer)
  const byWarehouse = new Map();
  for (const row of unmapped) {
    const key = `${row.warehouseName}|${row.whPartner}`;
    const entry = byWarehouse.get(key) || { warehouseName: row.warehouseName, whPartner: row.whPartner, rows: 0, cbm: 0 };
    entry.rows++;
    entry.cbm += row.cbmAvail;
    byWarehouse.set(key, entry);
  }
  const warehouseRows = Array.from(byWarehouse.values())
    .sort((a, b) => b.cbm - a.cbm)
    .slice(0, CONFIG.UNMAPPED_WAREHOUSE_TOP_N)
    .map(e => [e.warehouseName, e.whPartner, e.rows, e.cbm]);

  const whHeaders = ['Warehouse Name (top unmapped CBM)', 'WH Partner', 'Unmapped SKU rows', 'Unmapped CBM Avail'];
  sheet.getRange(1, 11, 1, whHeaders.length).setValues([whHeaders]);
  if (warehouseRows.length > 0) {
    sheet.getRange(2, 11, warehouseRows.length, whHeaders.length).setValues(warehouseRows);
    sheet.getRange(2, 13, warehouseRows.length, 1).setNumberFormat('#,##0');
    sheet.getRange(2, 14, warehouseRows.length, 1).setNumberFormat('#,##0.00');
  }
  const whHeaderRange = sheet.getRange(1, 11, 1, whHeaders.length);
  whHeaderRange.setFontWeight('bold');
  whHeaderRange.setBackground('#FFC000');
  [260, 110, 130, 140].forEach((w, idx) => sheet.setColumnWidth(11 + idx, w));

  console.log(`Unmapped SKU sheet created with ${unmapped.length} rows`);
  return { rowCount: unmapped.length };
}


/**
 * Compare every pivot row whose SKU exists in the SKU database with its final Official Store.
 *
 * A row "matches" when its Official Store is one of the database's stores that apply to the row's warehouse
 * (see pickSkuDbStores). Everything else is listed as a mismatch with the reason. Also collects the database
 * store names the Master did not know ("SKU Database (not in Master)" rows) so they can be added to the
 * Store Alias tab / Master.
 *
 * Returns { summary, mismatches (largest CBM first), missingStores (largest CBM first) }.
 */
function buildDbAudit(rows, skuLookup, storeAlias) {
  const summary = {
    inDbRows: 0, inDbCbm: 0, matchRows: 0, matchCbm: 0, mismatchRows: 0, mismatchCbm: 0,
    notInDbRows: 0, notInDbCbm: 0, financeOpenRows: 0, financeOpenCbm: 0
  };
  const mismatches = [];
  const missing = new Map(); // normalized database store -> aggregate

  const reasonFor = (row, picked) => {
    if (row.mappingSource === CONFIG.SOURCE_MANUAL) return 'Manual override (Unmapped SKU sheet)';
    if (row.mappingSource === CONFIG.SOURCE_MANUAL_AUDIT) return 'Manual correction (DB Audit column H)';
    if (picked.stores.length > 1) return 'Database lists several stores for this SKU / warehouse and none could be chosen';
    return `Official Store came from "${row.mappingSource}" instead of the database store`;
  };

  for (const row of rows) {
    const entry = row.sku === CONFIG.BLANK_PLACEHOLDER ? null : skuLookup.get(row.sku);
    if (!entry) {
      summary.notInDbRows++;
      summary.notInDbCbm += row.cbmAvail;
      continue;
    }

    const picked = pickSkuDbStores(entry, row.warehouseName);
    summary.inDbRows++;
    summary.inDbCbm += row.cbmAvail;

    const finalStore = normKey(row.officialStore);
    if (picked.stores.some(store => normKey(store) === finalStore)) {
      summary.matchRows++;
      summary.matchCbm += row.cbmAvail;
    } else {
      summary.mismatchRows++;
      summary.mismatchCbm += row.cbmAvail;
      mismatches.push({
        sku: row.sku,
        product: row.product || '',
        warehouseName: row.warehouseName,
        whPartner: row.whPartner,
        cbmAvail: row.cbmAvail,
        dbStores: picked.stores.join(' | '),
        officialStore: row.officialStore,
        mappingSource: row.mappingSource,
        reason: reasonFor(row, picked)
      });
    }

    if (row.mappingSource === CONFIG.SOURCE_SKU_DB_NO_MASTER) {
      const key = normKey(row.officialStore);
      const agg = missing.get(key) || {
        store: row.officialStore, rows: 0, cbm: 0, resolvedRows: 0,
        inAlias: !!(storeAlias && storeAlias.get(key)), exampleWarehouse: row.warehouseName
      };
      agg.rows++;
      agg.cbm += row.cbmAvail;
      if (row.financeResolved !== false) {
        agg.resolvedRows++;
      } else {
        summary.financeOpenRows++;
        summary.financeOpenCbm += row.cbmAvail;
      }
      missing.set(key, agg);
    }
  }

  mismatches.sort((a, b) => b.cbmAvail - a.cbmAvail);
  const missingStores = Array.from(missing.values()).sort((a, b) => b.cbm - a.cbm);
  return { summary, mismatches, missingStores };
}


/**
 * Key of a DB Audit / Unmapped SKU fill-in: SKU (normalized) | Warehouse Name | WH Partner.
 */
function auditFillKey(sku, warehouseName, whPartner) {
  return `${normalizeSku(sku)}|${String(warehouseName).trim()}|${String(whPartner).trim()}`;
}


/**
 * Text lines for the completion alert / log.
 */
function describeDbAudit(summary) {
  const fmt = n => n.toFixed(2);
  return `SKU found in database: ${summary.inDbRows} rows, CBM ${fmt(summary.inDbCbm)}\n` +
    `  Official Store = database: ${summary.matchRows} rows, CBM ${fmt(summary.matchCbm)}\n` +
    `  Official Store differs from database: ${summary.mismatchRows} rows, CBM ${fmt(summary.mismatchCbm)}\n` +
    `SKU not in database: ${summary.notInDbRows} rows, CBM ${fmt(summary.notInDbCbm)}\n` +
    `Database store not resolvable for Finance Data: ${summary.financeOpenRows} rows, CBM ${fmt(summary.financeOpenCbm)}`;
}


/**
 * Create the "DB Audit" sheet (generated right after "Unmapped SKU").
 *
 * Left: summary (A1:C6) and the list of rows whose Official Store differs from the database (from row 9,
 * largest CBM first, at most CONFIG.DB_AUDIT_MAX_ROWS rows). Column H ("CORRECT STORE (to fill in and re run)") is
 * filled in by hand with the correct store (a Master Official Store or Standardized_Brand name) and applied by the
 * menu "Re-run ... (after DB Audit correction)". `corrections` (Map "SKU|Warehouse|Partner" -> typed store, as read
 * from the previous DB Audit sheet) is written back into column H so a rebuild never loses what was typed.
 * Right (column L; K is a spacer): the database store names the Master does not know, with CBM, whether the Store
 * Alias tab has them and how many rows Finance Data could resolve; these are the names to add to the Store Alias tab / Master.
 *
 * Returns { summary, mismatchCount, missingStores }.
 */
function createDbAuditSheet(spreadsheet, rows, skuLookup, storeAlias, corrections) {
  const audit = buildDbAudit(rows, skuLookup, storeAlias);
  const sm = audit.summary;
  const sheet = spreadsheet.insertSheet(CONFIG.DB_AUDIT_SHEET_NAME);

  const summaryRows = [
    ['SKU Database Audit', 'Rows', 'CBM Avail'],
    ['SKU found in database', sm.inDbRows, sm.inDbCbm],
    ['   Official Store = database', sm.matchRows, sm.matchCbm],
    ['   Official Store differs from database (listed below)', sm.mismatchRows, sm.mismatchCbm],
    ['SKU not in database', sm.notInDbRows, sm.notInDbCbm],
    ['Database store not resolvable for Finance Data (right table)', sm.financeOpenRows, sm.financeOpenCbm]
  ];
  sheet.getRange(1, 1, summaryRows.length, 3).setValues(summaryRows);
  const summaryHeader = sheet.getRange(1, 1, 1, 3);
  summaryHeader.setFontWeight('bold');
  summaryHeader.setBackground('#FFC000');
  sheet.getRange(2, 2, summaryRows.length - 1, 1).setNumberFormat('#,##0');
  sheet.getRange(2, 3, summaryRows.length - 1, 1).setNumberFormat('#,##0.00');

  const headers = ['SKU', 'Product', 'Warehouse Name', 'WH Partner', 'CBM Avail', 'Database Store(s)', 'Final Official Store', CONFIG.DB_AUDIT_CORRECT_HEADER, 'Mapping Source', 'Reason'];
  const headerRow = CONFIG.DB_AUDIT_HEADER_ROW;
  const firstRow = headerRow + 1;
  const correctCol = CONFIG.DB_AUDIT_CORRECT_COL;
  sheet.getRange(headerRow, 1, 1, headers.length).setValues([headers]);
  const headerRange = sheet.getRange(headerRow, 1, 1, headers.length);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#7F6000');
  headerRange.setFontColor('#FFFFFF');
  const correctHeader = sheet.getRange(headerRow, correctCol);
  correctHeader.setBackground('#00B050');
  sheet.getRange(7, 1).setValue(`Fill column H (${CONFIG.DB_AUDIT_CORRECT_HEADER.split(' (')[0]}) with the correct Official Store or Standardized_Brand, then run the menu "SCM Reports > Re-run Raw Data SCM & Finance Data (after DB Audit correction)".`);
  const savedCorrections = corrections || new Map();

  const listed = audit.mismatches.slice(0, CONFIG.DB_AUDIT_MAX_ROWS);
  if (listed.length > 0) {
    const batchSize = 5000;
    for (let i = 0; i < listed.length; i += batchSize) {
      const batch = listed.slice(i, Math.min(i + batchSize, listed.length));
      const values = batch.map(m => [m.sku, m.product, m.warehouseName, m.whPartner, m.cbmAvail, m.dbStores, m.officialStore,
        savedCorrections.get(auditFillKey(m.sku, m.warehouseName, m.whPartner)) || '', m.mappingSource, m.reason]);
      sheet.getRange(firstRow + i, 1, values.length, headers.length).setValues(values);
    }
    sheet.getRange(firstRow, 5, listed.length, 1).setNumberFormat('#,##0.0000');
    sheet.getRange(firstRow, correctCol, listed.length, 1).setBackground('#E2EFDA'); // input column
  } else {
    sheet.getRange(firstRow, 1).setValue('Every SKU found in the database has the database Official Store.');
  }
  if (audit.mismatches.length > listed.length) {
    sheet.getRange(8, 1).setValue(`Only the ${listed.length} largest of ${audit.mismatches.length} differing rows are listed.`);
  }
  sheet.setFrozenRows(headerRow);

  const widths = [330, 260, 220, 110, 100, 260, 220, 260, 200, 380];
  widths.forEach((w, idx) => sheet.setColumnWidth(idx + 1, w));

  // Database store names the Master does not know (right table, column L; K is a spacer)
  const missingHeaders = ['Database store (not in Master)', 'Rows', 'CBM Avail', 'Rows resolved for Finance', 'In Store Alias?', 'Example Warehouse'];
  sheet.getRange(1, 12, 1, missingHeaders.length).setValues([missingHeaders]);
  const missingHeaderRange = sheet.getRange(1, 12, 1, missingHeaders.length);
  missingHeaderRange.setFontWeight('bold');
  missingHeaderRange.setBackground('#FFC000');
  if (audit.missingStores.length > 0) {
    const missingRows = audit.missingStores.map(m => [m.store, m.rows, m.cbm, m.resolvedRows, m.inAlias ? 'Yes' : 'No', m.exampleWarehouse]);
    sheet.getRange(2, 12, missingRows.length, missingHeaders.length).setValues(missingRows);
    sheet.getRange(2, 13, missingRows.length, 1).setNumberFormat('#,##0');
    sheet.getRange(2, 14, missingRows.length, 1).setNumberFormat('#,##0.00');
    sheet.getRange(2, 15, missingRows.length, 1).setNumberFormat('#,##0');
  }
  [260, 70, 100, 150, 110, 240].forEach((w, idx) => sheet.setColumnWidth(12 + idx, w));

  console.log(`DB Audit sheet created: ${audit.mismatches.length} differing rows, ${audit.missingStores.length} database stores not in Master`);
  return { summary: sm, mismatchCount: audit.mismatches.length, missingStores: audit.missingStores };
}


/**
 * Create Raw Data SCM sheet (generated after SKU Mapping Brand), plus its
 * CBM Reconciliation Control at E1 (Original Raw Data CBM Avail Total vs this sheet's Column D Total).
 * Official Store here is the value mapped by the SKU Mapping Brand fallback chain.
 */
function createRawDataSheet(spreadsheet, data, originalTotalCbm, rawDataSCMTotal) {
  const sheet = spreadsheet.insertSheet(CONFIG.RAW_DATA_SHEET_NAME);

  // Add headers
  const headers = ['Official Store', 'Warehouse Name', 'WH Partner', 'CBM Avail'];
  sheet.appendRow(headers);

  // Add data in batches (performance optimization for large datasets)
  const batchSize = 1000;
  for (let i = 0; i < data.length; i += batchSize) {
    const batch = data.slice(i, Math.min(i + batchSize, data.length));
    const rows = batch.map(row => [
      row.officialStore,
      row.warehouseName,
      row.whPartner,
      row.cbmAvail
    ]);

    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
  }

  // Format header
  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#4472C4');
  headerRange.setFontColor('#FFFFFF');

  sheet.getRange(2, 4, Math.max(data.length, 1), 1).setNumberFormat('#,##0.00');

  // Adjust column widths
  sheet.autoResizeColumns(1, headers.length);

  // CBM Reconciliation Control at E1
  return writeReconciliationControl(sheet, 1, 5, 'Original Raw Data (CBM Avail)', originalTotalCbm, 'Raw Data SCM (Column D)', rawDataSCMTotal);
}


/**
 * Create Finance Data sheet (generated after Raw Data SCM, per required sheet order),
 * plus its CBM Reconciliation Control at G1 (Raw Data SCM Total vs this sheet's Column E Total).
 *
 * FIELD-LEVEL MAPPING: Each field (Standardized Brand, Standardized_WHP, Standardized_Subsidiary,
 * Standardized_Mapping Brand) is mapped independently. If a field can be mapped, it shows the
 * mapped value; only show 'Unmapped' for the specific field that cannot be mapped. A row is NOT
 * marked as entirely unmapped just because one field is unmapped.
 */
function createFinanceDataSheet(spreadsheet, data, rawDataSCMTotal, financeTotal) {
  const sheet = spreadsheet.insertSheet(CONFIG.FINANCE_DATA_SHEET_NAME);

  // Add headers
  const headers = [
    'Standardized Brand',
    'Standardized_WHP',
    'Standardized_Subsidiary',
    'Standardized_Mapping Brand',
    'CBM Avail'
  ];
  sheet.appendRow(headers);

  // Add data in batches (performance optimization for large datasets)
  // Each field is mapped independently and displayed as-is
  const batchSize = 1000;
  for (let i = 0; i < data.length; i += batchSize) {
    const batch = data.slice(i, Math.min(i + batchSize, data.length));
    const rows = batch.map(row => [
      row.standardizedBrand,      // Show mapped value or 'Unmapped' for this field specifically
      row.standardizedWHP,        // Show mapped value or 'Unmapped' for this field specifically
      row.standardizedSubsidiary, // Show mapped value or 'Unmapped' for this field specifically
      row.standardizedMappingBrand, // Show mapped value or 'Unmapped' for this field specifically
      row.cbmAvail
    ]);

    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
  }

  // Format header
  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#70AD47');
  headerRange.setFontColor('#FFFFFF');

  sheet.getRange(2, 5, Math.max(data.length, 1), 1).setNumberFormat('#,##0.00');

  // Adjust column widths
  sheet.autoResizeColumns(1, headers.length);

  // CBM Reconciliation Control at G1 (F left blank as a spacer column)
  return writeReconciliationControl(sheet, 1, 7, 'Raw Data SCM (Column D)', rawDataSCMTotal, 'Finance Data (Column E)', financeTotal);
}


/**
 * Create the Breakdown sheet (generated after Finance Data, per required sheet order).
 *
 * Pivots Finance Data into rows = unique Standardized Brand + Standardized_Mapping Brand +
 * Subsidiary combinations, columns = WH Partner. The WH Partner columns are generated
 * dynamically from whatever distinct standardized_whp values actually occur in `financeData`
 * for this run, ordered by CONFIG.BREAKDOWN_WHP_ORDER (others alphabetically after them).
 *
 * UNMAPPED WHP HANDLING: The "Unmapped" WH Partner column is included ONLY when there are
 * actual rows in Finance Data where Standardized_WHP is "Unmapped". This ensures that
 * unmapped values appear naturally in the pivot alongside mapped partners. A partner with
 * no shipments that day gets no column; conversely, if all rows have mapped WHP values,
 * there will be no "Unmapped" column.
 *
 * Per the provided template, headers sit on row 2; row 1 is used for this sheet's CBM
 * Reconciliation Control (Finance Data Total vs Breakdown Grand Total).
 * Total is always the last column, followed by a Grand Total row. Nothing here is hardcoded
 * from a prior run — the row set, column set, column totals, and grand total are all rebuilt
 * from `financeData` every time.
 */
function createBreakdownSheet(spreadsheet, financeData, financeTotal) {
  const sheet = spreadsheet.insertSheet(CONFIG.BREAKDOWN_SHEET_NAME);

  // Build the pivot map: key -> { brand, mappingBrand, subsidiary, whpTotals: {}, rowTotal }
  const pivotMap = {};
  const seenWhp = {};

  for (const row of financeData) {
    const key = `${row.standardizedBrand}|${row.standardizedMappingBrand}|${row.standardizedSubsidiary}`;

    if (!pivotMap[key]) {
      pivotMap[key] = {
        brand: row.standardizedBrand,
        mappingBrand: row.standardizedMappingBrand,
        subsidiary: row.standardizedSubsidiary,
        whpTotals: {},
        rowTotal: 0
      };
    }

    const entry = pivotMap[key];
    // Only include WHP values that actually appear in the data
    // If a row has Standardized_WHP = 'Unmapped', it will naturally appear here as a column
    // if any rows have that value; otherwise, no 'Unmapped' column is created
    entry.whpTotals[row.standardizedWHP] = (entry.whpTotals[row.standardizedWHP] || 0) + row.cbmAvail;
    entry.rowTotal += row.cbmAvail;

    seenWhp[row.standardizedWHP] = true;
  }

  // WH Partner columns are entirely dynamic: only values that actually appear in
  // financeData. If Standardized_WHP = 'Unmapped' exists in the data, 'Unmapped' will naturally
  // appear as a column; if no rows have unmapped WHP, there's no 'Unmapped' column (satisfying
  // the requirement: "only pull unmapped values when Standardized_WHP is Unmapped").
  // Order: CONFIG.BREAKDOWN_WHP_ORDER first, then any other partner alphabetically.
  const orderIndex = new Map();
  CONFIG.BREAKDOWN_WHP_ORDER.forEach((name, idx) => orderIndex.set(normKey(name), idx));
  const whpColumns = Object.keys(seenWhp).sort((a, b) => {
    const ia = orderIndex.has(normKey(a)) ? orderIndex.get(normKey(a)) : Infinity;
    const ib = orderIndex.has(normKey(b)) ? orderIndex.get(normKey(b)) : Infinity;
    if (ia !== ib) return ia < ib ? -1 : 1;
    return a.localeCompare(b);
  });

  const pivotRows = Object.values(pivotMap).sort((a, b) => {
    const keyA = `${a.brand}|${a.mappingBrand}|${a.subsidiary}`;
    const keyB = `${b.brand}|${b.mappingBrand}|${b.subsidiary}`;
    return keyA.localeCompare(keyB);
  });

  const headerRow = ['Standardized Brand', 'Standardized_Mapping Brand', 'Subsidiary'].concat(whpColumns, ['Total']);

  // Headers on row 2, per the provided template
  sheet.getRange(2, 1, 1, headerRow.length).setValues([headerRow]);

  // Data rows starting row 3
  const dataRows = pivotRows.map(entry => {
    const whpValues = whpColumns.map(name => entry.whpTotals[name] || 0);
    return [entry.brand, entry.mappingBrand, entry.subsidiary].concat(whpValues, [entry.rowTotal]);
  });

  if (dataRows.length > 0) {
    sheet.getRange(3, 1, dataRows.length, headerRow.length).setValues(dataRows);
  }

  // Grand Total row: sum each WH Partner column and the Total column
  const colSums = whpColumns.map((name, idx) => {
    let sum = 0;
    dataRows.forEach(r => { sum += r[3 + idx]; });
    return sum;
  });

  let grandTotal = 0;
  dataRows.forEach(r => { grandTotal += r[r.length - 1]; });

  const grandTotalRow = ['Grand Total', '', ''].concat(colSums, [grandTotal]);
  const grandTotalRowIndex = 3 + dataRows.length;
  sheet.getRange(grandTotalRowIndex, 1, 1, headerRow.length).setValues([grandTotalRow]);

  // Formatting
  const headerRange = sheet.getRange(2, 1, 1, headerRow.length);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#7030A0');
  headerRange.setFontColor('#FFFFFF');

  const grandTotalRange = sheet.getRange(grandTotalRowIndex, 1, 1, headerRow.length);
  grandTotalRange.setFontWeight('bold');
  grandTotalRange.setBackground('#D9D9D9');

  sheet.getRange(3, 4, dataRows.length + 1, whpColumns.length + 1).setNumberFormat('#,##0.00');
  sheet.autoResizeColumns(1, headerRow.length);

  // CBM Reconciliation Control at row 1, one column after the table (Finance Data Total vs Breakdown Grand Total)
  const controlAnchorCol = headerRow.length + 2;
  const reconciliation = writeReconciliationControl(sheet, 1, controlAnchorCol, 'Finance Data (Column E)', financeTotal, 'Breakdown (Grand Total)', grandTotal);

  return { rowCount: dataRows.length, grandTotal, reconciliation };
}


/**
 * Helper function to show alerts in Apps Script UI
 */
function showAlert(title, message) {
  SpreadsheetApp.getUi().alert(`${title}\n\n${message}`);
}


/**
 * Rows / CBM per mapping source, in a fixed label order (every label is present, even with 0 rows).
 */
function buildSourceSummary(data) {
  const sourceLabels = [
    CONFIG.SOURCE_SKU_DB,
    CONFIG.SOURCE_SKU_DB_MASTER,
    CONFIG.SOURCE_SKU_DB_NO_MASTER,
    CONFIG.SOURCE_WAREHOUSE,
    CONFIG.SOURCE_OFFICIAL_STORE,
    CONFIG.SOURCE_RECONCILIATION,
    CONFIG.SOURCE_MANUAL,
    CONFIG.SOURCE_MANUAL_AUDIT,
    CONFIG.SOURCE_UNMAPPED
  ];
  const sourceSummary = sourceLabels.map(label => ({ label: label, rows: 0, cbm: 0 }));
  const sourceIndex = {};
  sourceLabels.forEach((label, idx) => { sourceIndex[label] = idx; });

  for (const row of data) {
    const s = sourceSummary[sourceIndex[row.mappingSource]];
    if (!s) continue;
    s.rows++;
    s.cbm += row.cbmAvail;
  }
  return sourceSummary;
}


/**
 * Write the "Mapping Source Summary" block at I8 of the SKU Mapping Brand sheet
 * (rows, CBM and % of total per mapping source). Any previous block is cleared first.
 */
function writeMappingSourceSummary(sheet, sourceSummary, rowCount, skuMappingTotal) {
  sheet.getRange(8, 9, 20, 4).clearContent();

  const summaryRows = [['Mapping Source Summary', '', '', ''], ['Mapping Source', 'Rows', 'CBM Avail', '% of Total CBM']];
  sourceSummary.forEach(s => {
    summaryRows.push([s.label, s.rows, s.cbm, skuMappingTotal !== 0 ? s.cbm / skuMappingTotal : 0]);
  });
  summaryRows.push([
    'Total',
    rowCount,
    skuMappingTotal,
    skuMappingTotal !== 0 ? 1 : 0
  ]);
  sheet.getRange(8, 9, summaryRows.length, 4).setValues(summaryRows);

  const summaryTitle = sheet.getRange(8, 9, 1, 4);
  summaryTitle.setFontWeight('bold');
  summaryTitle.setBackground('#FFC000');
  sheet.getRange(9, 9, 1, 4).setFontWeight('bold');
  sheet.getRange(10, 10, sourceSummary.length + 1, 1).setNumberFormat('#,##0');
  sheet.getRange(10, 11, sourceSummary.length + 1, 1).setNumberFormat('#,##0.00');
  sheet.getRange(10, 12, sourceSummary.length + 1, 1).setNumberFormat('0.00%');
  sheet.getRange(8 + summaryRows.length - 1, 9, 1, 4).setFontWeight('bold');

  sheet.setColumnWidth(9, 260);
  sheet.setColumnWidth(10, 110);
  sheet.setColumnWidth(11, 110);
  sheet.setColumnWidth(12, 110);
}


/**
 * Where the "CORRECT STORE ..." column is in the DB Audit sheet values: { headerIdx, col } (0-based) or null when the
 * sheet has no such column (an output made before it existed). Found by header text in the first rows.
 */
function findDbAuditCorrectColumn(values) {
  if (!values) return null;
  const scan = Math.min(values.length, 40);
  for (let i = 0; i < scan; i++) {
    for (let j = 0; j < values[i].length; j++) {
      if (normKey(values[i][j]).indexOf('correct store') === 0) return { headerIdx: i, col: j };
    }
  }
  return null;
}


/**
 * The corrections typed into column H of the DB Audit sheet: Map "SKU|Warehouse Name|WH Partner" -> typed store.
 * `values` = the sheet's data range (row 1 = sheet row 1). The header row is found by the text of the correction
 * column ("CORRECT STORE ..."), so inserting columns does not break it; SKU / Warehouse Name / WH Partner are taken
 * from the same header row (fallback columns A, C, D). A blank cell is no correction (a value equal to the current
 * Official Store is kept, so a rebuilt sheet still shows it; the re-run simply finds nothing to change for it).
 */
function parseDbAuditCorrections(values) {
  const out = new Map();
  const located = findDbAuditCorrectColumn(values);
  if (!located) return out;
  const headerIdx = located.headerIdx, correctCol = located.col;

  const header = values[headerIdx].map(normKey);
  const col = (name, fallback) => { const i = header.indexOf(normKey(name)); return i === -1 ? fallback : i; };
  const cSku = col('SKU', 0);
  const cWarehouse = col('Warehouse Name', 2);
  const cPartner = col('WH Partner', 3);

  for (let i = headerIdx + 1; i < values.length; i++) {
    const r = values[i];
    const sku = String(r[cSku] || '').trim();
    const typed = String(r[correctCol] || '').trim();
    if (!sku || !typed) continue;
    out.set(auditFillKey(sku, r[cWarehouse], r[cPartner]), typed);
  }
  return out;
}


/**
 * RE-RUN after the "Official_Store (to fill in)" column (column I) of the "Unmapped SKU" sheet has
 * been filled in manually.
 *
 * What it does, on an existing "... - Mapping Output" file chosen by the user:
 *  1. Reads every row of "SKU Mapping Brand" (the saved SKU x Warehouse x WH Partner pivot).
 *  2. Reads the filled-in Official Stores from "Unmapped SKU" (matched on SKU + Warehouse Name +
 *     WH Partner) and applies them to the rows that were still Unmapped / not in Master
 *     (Mapping Source = "Manual (Unmapped SKU sheet)").
 *  3. Updates Official Store / Remarks / Mapping Source (columns E:G) and the Mapping Source Summary
 *     of "SKU Mapping Brand", so that sheet stays consistent.
 *  4. Deletes and rebuilds "Raw Data SCM", "Finance Data" and "Breakdown" (Breakdown is built from
 *     Finance Data, so it must follow), each with its CBM reconciliation control.
 *
 * "SKU Database (not in Master)" rows keep their database Official Store; the re-run only refreshes how Finance
 * Data resolves them (Store Alias tab / Master key store via the Reconciliation Mapping, saved in column H).
 * "DB Audit" is rebuilt too. The CBM total never changes: the original total is read back from the SKU Mapping Brand control,
 * and every layer is reconciled against it again. Filled-in store names that the Master Mapping does
 * not know for that warehouse are still applied (so Raw Data SCM shows them) but are reported, because
 * Finance Data can only show them as Unmapped until the name matches the Master.
 */
function rerunFromUnmappedSkuFill() {
  rerunMapping(false);
}


/**
 * Menu: re-run Raw Data SCM / Finance Data / Breakdown after the correct stores were typed into column H
 * ("CORRECT STORE (to fill in and re run)") of the DB Audit sheet. Same re-run as above, plus the DB Audit corrections.
 */
function rerunFromDbAuditFill() {
  rerunMapping(true);
}


/**
 * Shared re-run. useDbAudit = also apply the corrections typed into the DB Audit sheet (column H).
 * The Unmapped SKU fill-ins, the Reconciliation Mapping, the Store Alias tab and the name-based Brand fallback
 * (CONFIG.AUTO_BRAND_NAME_MATCH) are applied in both modes.
 */
function rerunMapping(useDbAudit) {
  const startedAt = Date.now();
  const logElapsed = label => console.log(`[timing] ${label}: ${((Date.now() - startedAt) / 1000).toFixed(1)}s elapsed`);
  const ui = SpreadsheetApp.getUi();

  try {
    console.log('=== Re-run Raw Data SCM / Finance Data Started ===');

    const outputFile = selectFileFromFolder(true);
    if (!outputFile) {
      console.log('No output file selected. Re-run cancelled.');
      return;
    }
    const spreadsheet = SpreadsheetApp.openById(outputFile.getId());

    const skuSheet = spreadsheet.getSheetByName(CONFIG.SKU_MAPPING_SHEET_NAME);
    const unmappedSheet = spreadsheet.getSheetByName(CONFIG.UNMAPPED_SKU_SHEET_NAME);
    if (!skuSheet || !unmappedSheet) {
      throw new Error(`The selected file must contain the sheets "${CONFIG.SKU_MAPPING_SHEET_NAME}" and "${CONFIG.UNMAPPED_SKU_SHEET_NAME}".`);
    }

    // 1) Read the saved SKU Mapping Brand pivot (columns A:H; H = Master Key Store, empty in older outputs)
    const skuLastRow = skuSheet.getLastRow();
    if (skuLastRow <= 1) {
      throw new Error(`"${CONFIG.SKU_MAPPING_SHEET_NAME}" has no data rows.`);
    }
    const skuValues = skuSheet.getRange(2, 1, skuLastRow - 1, 8).getValues();
    const skuData = skuValues
      .filter(r => String(r[0]).trim() !== '')
      .map(r => ({
        sku: String(r[0]).trim(),
        warehouseName: String(r[1]).trim(),
        whPartner: String(r[2]).trim(),
        cbmAvail: parseFloat(r[3]) || 0,
        officialStore: String(r[4]).trim(),
        remarks: String(r[5]).trim(),
        mappingSource: String(r[6]).trim(),
        masterStore: String(r[7] || '').trim()
      }));

    // Original total, read back from the reconciliation control (J2); falls back to the sheet total
    const mappingTotalBefore = sumCbmAvail(skuData);
    const controlValue = skuSheet.getRange(2, 10).getValue();
    const originalTotalCbm = (typeof controlValue === 'number' && isFinite(controlValue)) ? controlValue : mappingTotalBefore;

    // 2) Read the manual fill-ins from "Unmapped SKU"
    const fillKey = (sku, wh, partner) => `${normalizeSku(sku)}|${String(wh).trim()}|${String(partner).trim()}`;
    const fills = new Map();
    const acByKey = new Map(); // fillKey -> Source Official Store (AC), needed for the Reconciliation Mapping
    const unmappedLastRow = unmappedSheet.getLastRow();
    if (unmappedLastRow > 1) {
      const uValues = unmappedSheet.getRange(2, 1, unmappedLastRow - 1, 9).getValues();
      for (const r of uValues) {
        const sku = String(r[0] || '').trim();
        if (!sku) continue;
        const key = fillKey(sku, r[3], r[4]);
        const ac = String(r[6] || '').trim();
        if (ac && !acByKey.has(key)) acByKey.set(key, ac);
        const store = String(r[8] || '').trim();
        if (store) fills.set(key, store);
      }
    }
    console.log(`Manual fill-ins found in "${CONFIG.UNMAPPED_SKU_SHEET_NAME}": ${fills.size}`);

    // 2b) DB Audit column H: the correct stores typed by hand. Read in both modes so the rebuilt DB Audit sheet keeps
    //     them; only applied to the pivot rows when useDbAudit.
    const auditSheet = spreadsheet.getSheetByName(CONFIG.DB_AUDIT_SHEET_NAME);
    if (useDbAudit && !auditSheet) {
      throw new Error(`The selected file has no "${CONFIG.DB_AUDIT_SHEET_NAME}" sheet. Process the daily report again, or use the other re-run menu.`);
    }
    const auditValues = auditSheet ? auditSheet.getDataRange().getValues() : null;
    if (useDbAudit && !findDbAuditCorrectColumn(auditValues)) {
      throw new Error(`The "${CONFIG.DB_AUDIT_SHEET_NAME}" sheet of this file has no "${CONFIG.DB_AUDIT_CORRECT_HEADER}" column (the file was made before it existed). Process the daily report again to get it.`);
    }
    const auditEntries = auditValues ? parseDbAuditCorrections(auditValues) : new Map();
    console.log(`Corrections typed in "${CONFIG.DB_AUDIT_SHEET_NAME}" column H: ${auditEntries.size} (${useDbAudit ? 'applied in this run' : 'kept, not applied in this run'})`);

    // 3) Apply the fill-ins (manual wins). For the rows still open:
    //    - "SKU Database (not in Master)": the database store STAYS the Official Store; only its Finance Data
    //      resolution (Store Alias / Master key via the Reconciliation Mapping) is refreshed
    //    - "Unmapped": try the Reconciliation Mapping, which may give the row an Official Store
    const masterMapping = loadMasterMappingData();
    logElapsed('after Master Mapping load');
    const reconLookup = loadReconciliationMapping();
    logElapsed('after Reconciliation Mapping load');
    const storeAlias = loadStoreAlias();
    logElapsed('after Store Alias load');
    // Store Alias tab + the aliases derived from the Master for corrected / name-matched stores (never written back)
    const aliasWork = new Map(storeAlias);
    const addDerivedAlias = alias => { if (alias && !aliasWork.has(normKey(alias.store))) aliasWork.set(normKey(alias.store), alias); };
    const REASON_PREFIX = ' - Reconciliation Mapping';
    const isOpenSource = src => src === CONFIG.SOURCE_UNMAPPED || src === CONFIG.SOURCE_SKU_DB_NO_MASTER;
    const masterKnows = (store, row) => !!store &&
      Object.prototype.hasOwnProperty.call(masterMapping.compositeLookup, compositeKey(store, row.warehouseName, row.whPartner));
    let reconRows = 0, reconCbm = 0;
    let dbResolvedRows = 0, dbResolvedCbm = 0; // database stores that became resolvable for Finance Data in this run
    const reconFailures = new Map(); // reason -> { rows, cbm }

    let auditRows = 0, auditCbm = 0;                  // DB Audit column H corrections applied
    const auditUnresolved = new Map();                // "typed | warehouse | partner" -> cbm (Finance stays Unmapped)
    const matchedAuditKeys = new Set();
    const nameMatched = new Map();                    // "store -> brand" -> { rows, cbm } (database stores matched to a brand by name)
    let appliedRows = 0, appliedCbm = 0, notInMasterRows = 0, notInMasterCbm = 0;
    const notInMasterNames = new Map(); // "store | warehouse | partner" -> cbm
    const matchedKeys = new Set();

    const updated = skuData.map(row => {
      const unchanged = Object.assign({}, row, { masterStore: '', financeResolved: true });
      const key = fillKey(row.sku, row.warehouseName, row.whPartner);

      // DB Audit correction (column H): applies to any row, whatever its mapping source
      if (useDbAudit && auditEntries.has(key)) {
        matchedAuditKeys.add(key);
        const typed = auditEntries.get(key);
        if (normKey(typed) !== normKey(row.officialStore)) {
          const r = resolveCorrectedStore(typed, row.warehouseName, row.whPartner, masterMapping, storeAlias, false);
          auditRows++;
          auditCbm += row.cbmAvail;
          if (!r.resolved) {
            const k = `${typed} | ${row.warehouseName} | ${row.whPartner}`;
            auditUnresolved.set(k, (auditUnresolved.get(k) || 0) + row.cbmAvail);
          }
          addDerivedAlias(r.alias);
          if (r.how === 'name') {
            const nk = `${typed} -> ${r.alias.standardizedBrand} (typed in DB Audit)`;
            const stat = nameMatched.get(nk) || { rows: 0, cbm: 0 };
            stat.rows++;
            stat.cbm += row.cbmAvail;
            nameMatched.set(nk, stat);
          }
          return Object.assign({}, row, { officialStore: r.officialStore, remarks: r.remarks, mappingSource: CONFIG.SOURCE_MANUAL_AUDIT, masterStore: r.masterStore, financeResolved: r.resolved });
        }
      }

      // A row corrected in an earlier run: rebuild its Finance resolution (alias / Master key are not stored in the sheet)
      if (row.mappingSource === CONFIG.SOURCE_MANUAL_AUDIT) {
        const r = resolveCorrectedStore(row.officialStore, row.warehouseName, row.whPartner, masterMapping, storeAlias, true);
        addDerivedAlias(r.alias);
        return Object.assign({}, row, { masterStore: r.masterStore || row.masterStore || '', financeResolved: r.resolved });
      }

      if (!isOpenSource(row.mappingSource)) return unchanged;
      const store = fills.get(key);
      const ac = acByKey.get(key);

      if (!store) {
        const cleanRemarks = row.remarks.indexOf(REASON_PREFIX) !== -1 ? row.remarks.substring(0, row.remarks.indexOf(REASON_PREFIX)) : row.remarks;

        if (row.mappingSource === CONFIG.SOURCE_SKU_DB_NO_MASTER) {
          const fin = resolveFinanceKey(row.officialStore, ac, row.warehouseName, row.whPartner, masterMapping, reconLookup, storeAlias);
          const keptKey = masterKnows(row.masterStore, row) ? row.masterStore : ''; // key found by an earlier run
          let masterStore = fin.masterStore || keptKey;
          let resolved = fin.hasAlias || !!masterStore;
          let nameRemark = '';
          // Only where the warehouse itself cannot give the Brand (it holds several brands in the Master, so Finance Data
          // would stay Unmapped): a single-brand warehouse already resolves through its uniform Master fields
          const wEntry = masterMapping.warehouseLookup.get(warehouseKey(row.warehouseName, row.whPartner));
          const brandNeedsHelp = !(wEntry && wEntry.uniformFields && wEntry.uniformFields.standardizedBrand);
          if (!resolved && CONFIG.AUTO_BRAND_NAME_MATCH && brandNeedsHelp) {
            // neither Store Alias nor Reconciliation Mapping knows this store: take the Brand from the Master by name
            const auto = resolveCorrectedStore(row.officialStore, row.warehouseName, row.whPartner, masterMapping, storeAlias, true);
            if (auto.resolved && auto.alias) {
              addDerivedAlias(auto.alias);
              masterStore = auto.masterStore;
              resolved = true;
              nameRemark = auto.remarks;
              const nk = `${row.officialStore} -> ${auto.alias.standardizedBrand}`;
              const stat = nameMatched.get(nk) || { rows: 0, cbm: 0 };
              stat.rows++;
              stat.cbm += row.cbmAvail;
              nameMatched.set(nk, stat);
            }
          }
          const wasResolved = !!keptKey || /Brand via Store Alias|Brand matched by name|Brand via Master brand/.test(row.remarks);
          if (resolved && !wasResolved) {
            dbResolvedRows++;
            dbResolvedCbm += row.cbmAvail;
          }
          if (!resolved && fin.reason) {
            const stat = reconFailures.get(fin.reason) || { rows: 0, cbm: 0 };
            stat.rows++;
            stat.cbm += row.cbmAvail;
            reconFailures.set(fin.reason, stat);
          }
          return Object.assign({}, row, {
            remarks: describeNotInMaster({ hasAlias: fin.hasAlias, masterStore: masterStore, reason: resolved ? '' : fin.reason }) + (nameRemark ? ` (${nameRemark})` : ''),
            masterStore: masterStore,
            financeResolved: resolved
          });
        }

        // No manual fill, not a database row: try the Reconciliation Mapping (AC + remark kind -> Standardized_Brand -> Master store)
        const kind = remarkKindOf(row.mappingSource, cleanRemarks);
        const recon = resolveViaReconciliation(ac, row.warehouseName, row.whPartner, kind, masterMapping, reconLookup);
        if (recon && recon.store) {
          reconRows++;
          reconCbm += row.cbmAvail;
          return Object.assign({}, row, { officialStore: recon.store, remarks: '', mappingSource: CONFIG.SOURCE_RECONCILIATION, masterStore: '', financeResolved: true });
        }
        if (recon && recon.reason) {
          const stat = reconFailures.get(recon.reason) || { rows: 0, cbm: 0 };
          stat.rows++;
          stat.cbm += row.cbmAvail;
          reconFailures.set(recon.reason, stat);
          return Object.assign({}, row, { remarks: `${cleanRemarks}${cleanRemarks ? ' - ' : ''}${recon.reason}`, masterStore: '', financeResolved: false });
        }
        return Object.assign({}, row, { masterStore: '', financeResolved: false });
      }

      matchedKeys.add(key);
      appliedRows++;
      appliedCbm += row.cbmAvail;

      let remarks = '';
      let masterStore = '';
      if (!masterKnows(store, row)) {
        // The manual store is not in the Master for this warehouse: Store Alias / Master key may still resolve it
        const fin = resolveFinanceKey(store, ac, row.warehouseName, row.whPartner, masterMapping, reconLookup, storeAlias);
        masterStore = fin.masterStore;
        if (fin.resolved) {
          remarks = describeNotInMaster(fin, 'Manual store name not found in Master for this warehouse');
        } else {
          notInMasterRows++;
          notInMasterCbm += row.cbmAvail;
          remarks = 'Manual store name not found in Master for this warehouse';
          const k = `${store} | ${row.warehouseName} | ${row.whPartner}`;
          notInMasterNames.set(k, (notInMasterNames.get(k) || 0) + row.cbmAvail);
        }
      }
      return Object.assign({}, row, { officialStore: store, remarks: remarks, mappingSource: CONFIG.SOURCE_MANUAL, masterStore: masterStore, financeResolved: true });
    });

    const skippedFills = fills.size - matchedKeys.size; // fill-ins that matched no open pivot row
    const skippedAudit = useDbAudit ? auditEntries.size - matchedAuditKeys.size : 0; // DB Audit corrections that matched no pivot row
    const stillOpenRows = updated.filter(r => r.mappingSource === CONFIG.SOURCE_UNMAPPED ||
      (r.mappingSource === CONFIG.SOURCE_SKU_DB_NO_MASTER && r.financeResolved === false)).length;
    console.log(`Applied ${auditRows} DB Audit corrections (CBM ${auditCbm.toFixed(2)}, ${skippedAudit} matched no row); ${nameMatched.size} database store names matched to a Brand by name; applied ${appliedRows} manual rows (CBM ${appliedCbm.toFixed(2)}); ${reconRows} via Reconciliation Mapping (CBM ${reconCbm.toFixed(2)}); ${dbResolvedRows} database stores newly resolved for Finance Data (CBM ${dbResolvedCbm.toFixed(2)}); ${notInMasterRows} not in Master; ${skippedFills} fill-ins matched no open row; ${stillOpenRows} rows still open`);

    if (appliedRows === 0 && reconRows === 0 && dbResolvedRows === 0 && auditRows === 0) {
      const auditHint = useDbAudit
        ? `Nothing was typed in column H ("${CONFIG.DB_AUDIT_CORRECT_HEADER}") of "${CONFIG.DB_AUDIT_SHEET_NAME}" that differs from the current Official Store, and `
        : '';
      ui.alert('Nothing to re-run', `${auditHint}No manual Official Store in "${CONFIG.UNMAPPED_SKU_SHEET_NAME}" (column "Official_Store (to fill in)") and neither the Reconciliation Mapping nor the "${CONFIG.STORE_ALIAS_SHEET_NAME}" tab resolved any open row. Fill the column in or complete the "${CONFIG.RECONCILIATION_SHEET_NAME}" / "${CONFIG.STORE_ALIAS_SHEET_NAME}" / Master tabs first, then run this menu again.`, ui.ButtonSet.OK);
      return;
    }

    const confirm = ui.alert(
      'Re-run Raw Data SCM, Finance Data & Breakdown',
      `File: ${outputFile.getName()}\n\n` +
      (useDbAudit ? `DB Audit corrections found: ${auditEntries.size}; applied to ${auditRows} pivot rows (CBM ${auditCbm.toFixed(2)}); matching no row: ${skippedAudit}\n` : '') +
      `Manual Official Stores found: ${fills.size}\n` +
      `Pivot rows updated from manual fill-in: ${appliedRows} (CBM ${appliedCbm.toFixed(2)})\n` +
      `Pivot rows updated from Reconciliation Mapping: ${reconRows} (CBM ${reconCbm.toFixed(2)})\n` +
      `Database stores newly resolved for Finance Data (Store Alias / Master key): ${dbResolvedRows} (CBM ${dbResolvedCbm.toFixed(2)})\n` +
      `Fill-ins not matching any open row: ${skippedFills}\n` +
      `Store names not found in Master for their warehouse: ${notInMasterRows} rows\n` +
      `Rows that stay unmapped after this run: ${stillOpenRows}\n\n` +
      `The sheets "${CONFIG.DB_AUDIT_SHEET_NAME}", "${CONFIG.RAW_DATA_SHEET_NAME}", "${CONFIG.FINANCE_DATA_SHEET_NAME}" and "${CONFIG.BREAKDOWN_SHEET_NAME}" will be deleted and rebuilt. Continue?`,
      ui.ButtonSet.YES_NO
    );
    if (confirm !== ui.Button.YES) {
      console.log('Re-run cancelled by the user.');
      return;
    }

    // 4) Update SKU Mapping Brand (columns E:H + Mapping Source Summary) so it stays consistent
    const mappingTotal = sumCbmAvail(updated);
    skuSheet.getRange(1, 8).setValue('Master Key Store'); // also for outputs made before this column existed
    skuSheet.getRange(1, 8).setFontWeight('bold').setBackground('#ED7D31').setFontColor('#FFFFFF');
    skuSheet.setColumnWidth(8, 180);
    skuSheet.getRange(2, 5, updated.length, 4).setValues(updated.map(r => [r.officialStore, r.remarks, r.mappingSource, r.masterStore || '']));
    const skuReconciliation = writeReconciliationControl(skuSheet, 1, 9, 'Original Raw Data (CBM Avail)', originalTotalCbm, 'SKU Mapping Brand (Column D)', mappingTotal);
    writeMappingSourceSummary(skuSheet, buildSourceSummary(updated), updated.length, mappingTotal);
    logElapsed('after SKU Mapping Brand update');

    // 5) Rebuild DB Audit -> Raw Data SCM -> Finance Data -> Breakdown (delete old ones first)
    [CONFIG.BREAKDOWN_SHEET_NAME, CONFIG.FINANCE_DATA_SHEET_NAME, CONFIG.RAW_DATA_SHEET_NAME, CONFIG.DB_AUDIT_SHEET_NAME].forEach(name => {
      const old = spreadsheet.getSheetByName(name);
      if (old) spreadsheet.deleteSheet(old);
    });

    const skuLookup = loadSkuMappingDatabase();
    logElapsed('after SKU database load');
    const dbAudit = createDbAuditSheet(spreadsheet, updated, skuLookup, storeAlias, auditEntries);
    logElapsed('after DB Audit sheet');

    const dedupData = deduplicateAndSumData(updated);
    const rawDataSCMTotal = sumCbmAvail(dedupData);
    const rawDataReconciliation = createRawDataSheet(spreadsheet, dedupData, originalTotalCbm, rawDataSCMTotal);
    logElapsed('after Raw Data SCM sheet');

    const financeData = standardizeDataForFinance(dedupData, masterMapping, aliasWork);
    const financeTotal = sumCbmAvail(financeData);
    const financeReconciliation = createFinanceDataSheet(spreadsheet, financeData, rawDataSCMTotal, financeTotal);
    logElapsed('after Finance Data sheet');

    const breakdownResult = createBreakdownSheet(spreadsheet, financeData, financeTotal);
    logElapsed('after Breakdown sheet');

    const finalUnmapped = financeData.filter(r =>
      r.standardizedBrand === CONFIG.UNMAPPED_LABEL || r.standardizedWHP === CONFIG.UNMAPPED_LABEL ||
      r.standardizedSubsidiary === CONFIG.UNMAPPED_LABEL || r.standardizedMappingBrand === CONFIG.UNMAPPED_LABEL);
    const finalUnmappedCbm = sumCbmAvail(finalUnmapped);

    const reconciliationSummary =
      `Original Raw Data -> SKU Mapping Brand: ${skuReconciliation.status} (variance ${skuReconciliation.variance})\n` +
      `Original Raw Data -> Raw Data SCM: ${rawDataReconciliation.status} (variance ${rawDataReconciliation.variance})\n` +
      `Raw Data SCM -> Finance Data: ${financeReconciliation.status} (variance ${financeReconciliation.variance})\n` +
      `Finance Data -> Breakdown: ${breakdownResult.reconciliation.status} (variance ${breakdownResult.reconciliation.variance})`;

    let notInMasterLines = '';
    if (auditUnresolved.size > 0) {
      const topAudit = Array.from(auditUnresolved.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(e => `${e[0]} -> ${e[1].toFixed(2)}`);
      notInMasterLines += `\n\nDB Audit corrections whose store name is NOT a Master store, Standardized_Brand or Store Alias name (Finance Data stays Unmapped for them; correct the name in column H and re-run). Top by CBM:\n${topAudit.join('\n')}`;
      console.warn(`DB Audit corrections not resolvable:\n${topAudit.join('\n')}`);
    }
    if (nameMatched.size > 0) {
      const topName = Array.from(nameMatched.entries()).sort((a, b) => b[1].cbm - a[1].cbm).slice(0, 15)
        .map(e => `${e[0]}: ${e[1].rows} rows, CBM ${e[1].cbm.toFixed(2)}`);
      notInMasterLines += `\n\nDatabase stores whose Brand was taken from the Master BY NAME (please check; add them to the "${CONFIG.STORE_ALIAS_SHEET_NAME}" tab to make it permanent). Top by CBM:\n${topName.join('\n')}`;
      console.log(`Brand matched by name:\n${topName.join('\n')}`);
    }
    if (finalUnmapped.length > 0) {
      const left = [];
      dedupData.forEach((d, i) => {
        const f = financeData[i];
        if (f.standardizedBrand === CONFIG.UNMAPPED_LABEL || f.standardizedWHP === CONFIG.UNMAPPED_LABEL ||
            f.standardizedSubsidiary === CONFIG.UNMAPPED_LABEL || f.standardizedMappingBrand === CONFIG.UNMAPPED_LABEL) {
          left.push([`${d.officialStore} | ${d.warehouseName} | ${d.whPartner}`, d.cbmAvail]);
        }
      });
      const topLeft = left.sort((a, b) => b[1] - a[1]).slice(0, 10).map(e => `${e[0]} -> ${e[1].toFixed(2)}`);
      notInMasterLines += `\n\nStill Unmapped in Finance Data (Official Store | Warehouse | Partner). Top by CBM:\n${topLeft.join('\n')}`;
      console.warn(`Still Unmapped in Finance Data:\n${topLeft.join('\n')}`);
    }
    if (notInMasterNames.size > 0) {
      const top = Array.from(notInMasterNames.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(e => `${e[0]} -> ${e[1].toFixed(2)}`);
      notInMasterLines = `\n\nManual store names NOT found in Master for that warehouse (Finance Data stays Unmapped for them; fix the name in "${CONFIG.UNMAPPED_SKU_SHEET_NAME}" and re-run). Top by CBM:\n${top.join('\n')}`;
      console.warn(`Manual store names not found in Master:\n${top.join('\n')}`);
    }

    if (reconFailures.size > 0) {
      const topFail = Array.from(reconFailures.entries()).sort((a, b) => b[1].cbm - a[1].cbm).slice(0, 10)
        .map(e => `${e[0]} -> ${e[1].rows} rows, CBM ${e[1].cbm.toFixed(2)}`);
      notInMasterLines += `\n\nReconciliation Mapping could not be completed (add the brand / warehouse row to Master). Top by CBM:\n${topFail.join('\n')}`;
      console.warn(`Reconciliation Mapping unresolved:\n${topFail.join('\n')}`);
    }

    showAlert('Re-run completed',
      `Output file: ${outputFile.getName()}\nURL: ${spreadsheet.getUrl()}\n\n` +
      (useDbAudit ? `DB Audit corrections applied: ${auditRows} rows (CBM ${auditCbm.toFixed(2)}); not matching any row: ${skippedAudit}\n` : '') +
      `Manual mapping applied: ${appliedRows} rows (CBM ${appliedCbm.toFixed(2)})\n` +
      `Reconciliation Mapping applied: ${reconRows} rows (CBM ${reconCbm.toFixed(2)})\n` +
      `Database stores newly resolved for Finance Data: ${dbResolvedRows} (CBM ${dbResolvedCbm.toFixed(2)})\n` +
      `Rows still open in SKU Mapping Brand: ${stillOpenRows}\n` +
      `Finance Data rows with any "Unmapped" field: ${finalUnmapped.length} (CBM ${finalUnmappedCbm.toFixed(2)})\n\n` +
      `CBM Reconciliation:\n${reconciliationSummary}\n\n` +
      `SKU Database check (sheet "${CONFIG.DB_AUDIT_SHEET_NAME}"):\n${describeDbAudit(dbAudit.summary)}${notInMasterLines}`);
    console.log('=== Re-run Raw Data SCM / Finance Data Completed ===');
    console.log(reconciliationSummary);

  } catch (error) {
    console.error(`Error: ${error.message}\n${error.stack}`);
    showAlert('Error', `Re-run failed: ${error.message}`);
  }
}


/**
 * Create menu in Apps Script UI
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('SCM Reports')
    .addItem('Process Daily Report', 'processScmDailyReport')
    .addItem('Re-run Raw Data SCM & Finance Data (after Unmapped SKU fill-in)', 'rerunFromUnmappedSkuFill')
    .addItem('Re-run Raw Data SCM & Finance Data (after DB Audit correction)', 'rerunFromDbAuditFill')
    .addToUi();
}
