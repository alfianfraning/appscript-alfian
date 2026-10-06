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
 *      e) The SKU database store that the Master does not know (kept visible, Remarks explain it)
 *      f) Unmapped (Remarks = "Unmapped")
 *    A "Mapping Source" column records which step produced each result.
 *    Reconciliation control: Original CBM Avail total vs this sheet's CBM Avail total
 * 5. Build the "Unmapped SKU" worklist sheet: unmapped SKUs sorted by CBM (largest first),
 *    plus the unmapped CBM per warehouse, so the SKU database can be completed.
 * 6. Generate the "Raw Data SCM" sheet from the SKU Mapping Brand result (Official Store from
 *    the mapping above), deduplicated on Official Store + Warehouse Name + WH Partner
 *    (SUMIFS-equivalent). Reconciliation control: Original CBM Avail total vs Raw Data SCM total
 * 7. Generate the "Finance Data" sheet (only after Raw Data SCM is complete), with its own
 *    reconciliation control comparing its total back to Raw Data SCM. Each field is mapped
 *    independently: if the composite key is found the Master values are used; if not, each field falls
 *    back to the warehouse (when every Master row of that warehouse agrees on the field), otherwise
 *    "Unmapped" for that specific field only (do not mark the entire row as unmapped).
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

  SKU_MAPPING_SHEET_NAME: 'SKU Mapping Brand',
  UNMAPPED_SKU_SHEET_NAME: 'Unmapped SKU',
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
    const skuMappedData = mapSkuToOfficialStore(skuPivot, skuLookup, masterMapping, reconLookup);
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
    const financeData = standardizeDataForFinance(dedupData, masterMapping);
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

    showAlert('Success', `Processing completed successfully!\n\nSource file: ${reportFile.getName()}\nOutput file: ${outputFileName}\nOutput URL: ${outputSpreadsheet.getUrl()}\n\nCBM Reconciliation:\n${reconciliationSummary}\n\nMapping Source:\n${sourceSummaryLines}`);
    console.log('=== SCM Daily Report Processing Completed ===');
    console.log(reconciliationSummary);
    console.log(sourceSummaryLines);

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
  return String(value === null || value === undefined ? '' : value).trim().toUpperCase();
}


/**
 * Normalize a text value for key matching: collapse repeated whitespace, trim and lower-case.
 * Used for Official Store / Warehouse Name / WH Partner keys so that "First Step" vs "First step",
 * or a stray double space, still match the Master Mapping.
 */
function normKey(value) {
  return String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim().toLowerCase();
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
    } else {
      dedupMap.set(key, {
        officialStore: row.officialStore,
        warehouseName: row.warehouseName,
        whPartner: row.whPartner,
        cbmAvail: row.cbmAvail
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
 * Columns: SKU | Warehouse Name | WH Partner | CBM Avail | Official Store | Remarks | Mapping Source
 * Rows are the SKU x Warehouse Name x WH Partner pivot (zero-CBM rows are not included), with the
 * Official Store coming from the fallback chain. Remarks = "Unmapped" (or
 * "Unmapped - Multiple Mapping (...)") only for rows that could not be mapped; "Mapping Source"
 * says which step of the chain produced each Official Store.
 *
 * Right of the table (column I, one spacer column H):
 *   - CBM Reconciliation Control at I1 (Original Raw Data CBM Avail Total vs this sheet's Column D Total)
 *   - Mapping Source Summary at I8 (rows, CBM and % of total per mapping source)
 *
 * Returns { reconciliation, unmappedRows, unmappedCbm, sourceSummary }.
 */
function createSkuMappingSheet(spreadsheet, data, originalTotalCbm, skuMappingTotal) {
  const sheet = spreadsheet.insertSheet(CONFIG.SKU_MAPPING_SHEET_NAME);

  const headers = ['SKU', 'Warehouse Name', 'WH Partner', 'CBM Avail', 'Official Store', 'Remarks', 'Mapping Source'];
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
      row.mappingSource
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

  // CBM Reconciliation Control at I1 (H left blank as a spacer column)
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

  // Both "Unmapped" rows and "SKU Database (not in Master)" rows end up as "Unmapped" in Finance Data,
  // so both belong on the worklist (the Remarks column tells them apart)
  const unmapped = skuMappedData
    .filter(row => row.mappingSource === CONFIG.SOURCE_UNMAPPED || row.mappingSource === CONFIG.SOURCE_SKU_DB_NO_MASTER)
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
 * The CBM total never changes: the original total is read back from the SKU Mapping Brand control,
 * and every layer is reconciled against it again. Filled-in store names that the Master Mapping does
 * not know for that warehouse are still applied (so Raw Data SCM shows them) but are reported, because
 * Finance Data can only show them as Unmapped until the name matches the Master.
 */
function rerunFromUnmappedSkuFill() {
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

    // 1) Read the saved SKU Mapping Brand pivot (columns A:G)
    const skuLastRow = skuSheet.getLastRow();
    if (skuLastRow <= 1) {
      throw new Error(`"${CONFIG.SKU_MAPPING_SHEET_NAME}" has no data rows.`);
    }
    const skuValues = skuSheet.getRange(2, 1, skuLastRow - 1, 7).getValues();
    const skuData = skuValues
      .filter(r => String(r[0]).trim() !== '')
      .map(r => ({
        sku: String(r[0]).trim(),
        warehouseName: String(r[1]).trim(),
        whPartner: String(r[2]).trim(),
        cbmAvail: parseFloat(r[3]) || 0,
        officialStore: String(r[4]).trim(),
        remarks: String(r[5]).trim(),
        mappingSource: String(r[6]).trim()
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

    // 3) Apply the fill-ins (manual wins), then the Reconciliation Mapping for the rows still open
    const masterMapping = loadMasterMappingData();
    logElapsed('after Master Mapping load');
    const reconLookup = loadReconciliationMapping();
    logElapsed('after Reconciliation Mapping load');
    const REASON_PREFIX = ' - Reconciliation Mapping';
    const isOpenSource = src => src === CONFIG.SOURCE_UNMAPPED || src === CONFIG.SOURCE_SKU_DB_NO_MASTER;
    let reconRows = 0, reconCbm = 0;
    const reconFailures = new Map(); // reason -> { rows, cbm }

    let appliedRows = 0, appliedCbm = 0, notInMasterRows = 0, notInMasterCbm = 0;
    const notInMasterNames = new Map(); // "store | warehouse | partner" -> cbm
    const matchedKeys = new Set();

    const updated = skuData.map(row => {
      if (!isOpenSource(row.mappingSource)) return row;
      const key = fillKey(row.sku, row.warehouseName, row.whPartner);
      const store = fills.get(key);
      if (!store) {
        // No manual fill: try the Reconciliation Mapping (AC + remark kind -> Standardized_Brand -> Master store)
        const cleanRemarks = row.remarks.indexOf(REASON_PREFIX) !== -1 ? row.remarks.substring(0, row.remarks.indexOf(REASON_PREFIX)) : row.remarks;
        const kind = remarkKindOf(row.mappingSource, cleanRemarks);
        const recon = resolveViaReconciliation(acByKey.get(key), row.warehouseName, row.whPartner, kind, masterMapping, reconLookup);
        if (recon && recon.store) {
          reconRows++;
          reconCbm += row.cbmAvail;
          return Object.assign({}, row, { officialStore: recon.store, remarks: '', mappingSource: CONFIG.SOURCE_RECONCILIATION });
        }
        if (recon && recon.reason) {
          const stat = reconFailures.get(recon.reason) || { rows: 0, cbm: 0 };
          stat.rows++;
          stat.cbm += row.cbmAvail;
          reconFailures.set(recon.reason, stat);
          return Object.assign({}, row, { remarks: `${cleanRemarks}${cleanRemarks ? ' - ' : ''}${recon.reason}` });
        }
        return row;
      }

      matchedKeys.add(key);
      appliedRows++;
      appliedCbm += row.cbmAvail;

      const inMaster = Object.prototype.hasOwnProperty.call(masterMapping.compositeLookup, compositeKey(store, row.warehouseName, row.whPartner));
      let remarks = '';
      if (!inMaster) {
        notInMasterRows++;
        notInMasterCbm += row.cbmAvail;
        remarks = 'Manual store name not found in Master for this warehouse';
        const k = `${store} | ${row.warehouseName} | ${row.whPartner}`;
        notInMasterNames.set(k, (notInMasterNames.get(k) || 0) + row.cbmAvail);
      }
      return Object.assign({}, row, { officialStore: store, remarks: remarks, mappingSource: CONFIG.SOURCE_MANUAL });
    });

    const skippedFills = fills.size - matchedKeys.size; // fill-ins that matched no open pivot row
    const stillOpenRows = updated.filter(r => isOpenSource(r.mappingSource)).length;
    console.log(`Applied ${appliedRows} manual rows (CBM ${appliedCbm.toFixed(2)}); ${reconRows} via Reconciliation Mapping (CBM ${reconCbm.toFixed(2)}); ${notInMasterRows} not in Master; ${skippedFills} fill-ins matched no open row; ${stillOpenRows} rows still open`);

    if (appliedRows === 0 && reconRows === 0) {
      ui.alert('Nothing to re-run', `No manual Official Store in "${CONFIG.UNMAPPED_SKU_SHEET_NAME}" (column "Official_Store (to fill in)") and the Reconciliation Mapping resolved no open row. Fill the column in or complete the "${CONFIG.RECONCILIATION_SHEET_NAME}" / Master tabs first, then run this menu again.`, ui.ButtonSet.OK);
      return;
    }

    const confirm = ui.alert(
      'Re-run Raw Data SCM, Finance Data & Breakdown',
      `File: ${outputFile.getName()}\n\n` +
      `Manual Official Stores found: ${fills.size}\n` +
      `Pivot rows updated from manual fill-in: ${appliedRows} (CBM ${appliedCbm.toFixed(2)})\n` +
      `Pivot rows updated from Reconciliation Mapping: ${reconRows} (CBM ${reconCbm.toFixed(2)})\n` +
      `Fill-ins not matching any open row: ${skippedFills}\n` +
      `Store names not found in Master for their warehouse: ${notInMasterRows} rows\n` +
      `Rows that stay unmapped after this run: ${stillOpenRows}\n\n` +
      `The sheets "${CONFIG.RAW_DATA_SHEET_NAME}", "${CONFIG.FINANCE_DATA_SHEET_NAME}" and "${CONFIG.BREAKDOWN_SHEET_NAME}" will be deleted and rebuilt. Continue?`,
      ui.ButtonSet.YES_NO
    );
    if (confirm !== ui.Button.YES) {
      console.log('Re-run cancelled by the user.');
      return;
    }

    // 4) Update SKU Mapping Brand (columns E:G + Mapping Source Summary) so it stays consistent
    const mappingTotal = sumCbmAvail(updated);
    skuSheet.getRange(2, 5, updated.length, 3).setValues(updated.map(r => [r.officialStore, r.remarks, r.mappingSource]));
    const skuReconciliation = writeReconciliationControl(skuSheet, 1, 9, 'Original Raw Data (CBM Avail)', originalTotalCbm, 'SKU Mapping Brand (Column D)', mappingTotal);
    writeMappingSourceSummary(skuSheet, buildSourceSummary(updated), updated.length, mappingTotal);
    logElapsed('after SKU Mapping Brand update');

    // 5) Rebuild Raw Data SCM -> Finance Data -> Breakdown (delete old ones first)
    [CONFIG.BREAKDOWN_SHEET_NAME, CONFIG.FINANCE_DATA_SHEET_NAME, CONFIG.RAW_DATA_SHEET_NAME].forEach(name => {
      const old = spreadsheet.getSheetByName(name);
      if (old) spreadsheet.deleteSheet(old);
    });

    const dedupData = deduplicateAndSumData(updated);
    const rawDataSCMTotal = sumCbmAvail(dedupData);
    const rawDataReconciliation = createRawDataSheet(spreadsheet, dedupData, originalTotalCbm, rawDataSCMTotal);
    logElapsed('after Raw Data SCM sheet');

    const financeData = standardizeDataForFinance(dedupData, masterMapping);
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
      `Manual mapping applied: ${appliedRows} rows (CBM ${appliedCbm.toFixed(2)})\n` +
      `Reconciliation Mapping applied: ${reconRows} rows (CBM ${reconCbm.toFixed(2)})\n` +
      `Rows still open in SKU Mapping Brand: ${stillOpenRows}\n` +
      `Finance Data rows with any "Unmapped" field: ${finalUnmapped.length} (CBM ${finalUnmappedCbm.toFixed(2)})\n\n` +
      `CBM Reconciliation:\n${reconciliationSummary}${notInMasterLines}`);
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
    .addToUi();
}
