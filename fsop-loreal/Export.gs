/**
 * FSOP direct export - builds the Google Sheets export WITHOUT the dashboard UI, by running the dashboard's OWN export code.
 *
 * Instead of re-implementing the export layout, this file loads the script of Dashboard.html (HtmlService raw source) into
 * the server with a stubbed DOM, feeds it the data from refreshData(), selects a store / group exactly like ticking its
 * checkbox in the sidebar, and calls the dashboard's own getExportRows_() + buildExportPayload_() + exportStoreLabel_().
 * The resulting payload goes to Code.gs's createExportSpreadsheet(payload) unchanged. So whatever the dashboard's
 * "Export to Sheets" button would produce for that selection is what this produces - rows, formulas, columns, highlights,
 * groups, file name, version number and folder all keep following Dashboard.html and Code.gs.
 *
 * Depends on (all already in the project): Dashboard.html, refreshData(), loadCachedData_(), createExportSpreadsheet(),
 * installDailyTrigger().
 *
 * Coupling to Dashboard.html (fails loudly with a clear message if it ever changes):
 *   - the data script is the <script> block that contains "const FS_PAYLOAD = <?!= dataJson ?>"
 *   - it ends right before the line starting "function render() {" (everything after that is UI start-up)
 *   - it must define DATA, state, getExportRows_, buildExportPayload_, exportStoreLabel_
 */

// Script Property holding the selections to export (comma / newline separated store or group names).
const FSOP_SELECTIONS_PROPERTY = 'FSOP_SELECTIONS';
const FSOP_DEFAULT_SELECTIONS = ['LOreal Group'];

/** Raw source of Dashboard.html (scriptlets NOT evaluated). */
function fsopDashboardSource_() {
  try {
    return HtmlService.createTemplateFromFile('Dashboard').getRawContent();
  } catch (e) {
    return HtmlService.createHtmlOutputFromFile('Dashboard').getContent();
  }
}

/** Loads the dashboard's data/export script with the given cache payload; returns its engine (DATA, state, ...). */
function fsopLoadEngine_(cache) {
  const lines = fsopDashboardSource_().split('\n');
  const dataLine = lines.findIndex(l => l.indexOf('const FS_PAYLOAD') === 0);
  if (dataLine < 0) throw new Error('Dashboard.html changed: "const FS_PAYLOAD" not found - Export.gs needs an update.');
  let start = dataLine;
  while (start > 0 && lines[start].trim() !== '<script>') start--;
  const end = lines.findIndex((l, i) => i > dataLine && l.indexOf('function render() {') === 0);
  if (end < 0) throw new Error('Dashboard.html changed: "function render() {" not found - Export.gs needs an update.');

  const payloadJson = JSON.stringify({ generatedAt: cache.generatedAt, DATA: cache.DATA || [], MP_DATA: cache.MP_DATA || [], warnings: cache.warnings || [] });
  const accessJson = JSON.stringify({ list: [], currentEmail: '', currentRole: 'owner' });
  const code = lines.slice(start + 1, end).join('\n')
    .replace('<?!= dataJson ?>', () => payloadJson)
    .replace('<?!= accessJson ?>', () => accessJson)
    .replace('<?!= dashboardVersionJson ?>', () => '"fsop-export"');

  // Minimal browser stubs: every DOM call returns a harmless, callable placeholder.
  const stubEl = () => {
    const p = new Proxy(function () {}, {
      get: (t, k) => (k === Symbol.toPrimitive ? () => '' : (k === 'length' ? 0 : p)),
      apply: () => p, set: () => true, construct: () => p,
    });
    return p;
  };
  const dom = stubEl();
  const noop = () => {};
  const known = {
    document: { getElementById: () => dom, querySelector: () => dom, querySelectorAll: () => [], createElement: () => dom, addEventListener: noop, body: dom, documentElement: dom },
    window: { addEventListener: noop, innerWidth: 1600, getComputedStyle: () => dom, open: noop, scrollTo: noop },
    localStorage: { getItem: () => null, setItem: noop }, sessionStorage: { getItem: () => null, setItem: noop },
    navigator: { userAgent: 'apps-script' }, location: { href: '' }, google: undefined,
    setInterval: () => 0, setTimeout: () => 0, clearTimeout: noop, clearInterval: noop,
    requestAnimationFrame: () => 0, cancelAnimationFrame: noop,
    ResizeObserver: function () { return { observe: noop, disconnect: noop }; },
    MutationObserver: function () { return { observe: noop, disconnect: noop }; },
    XLSX: {}, alert: noop, confirm: () => true, getComputedStyle: () => dom, Event: function () {}, CustomEvent: function () {},
  };
  const scope = new Proxy({}, { has: (t, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(known, k), get: (t, k) => known[k], set: () => true });
  const names = ['DATA', 'state', 'getExportRows_', 'buildExportPayload_', 'exportStoreLabel_'];
  const body = 'with (scope) {\n' + code + '\n;return { ' +
    names.map(n => 'get ' + n + '() { return typeof ' + n + " === 'undefined' ? undefined : " + n + '; }').join(',\n') + ' };\n}';
  let engine;
  try {
    engine = new Function('scope', body)(scope);
  } catch (e) {
    throw new Error('Could not load the Dashboard.html script on the server: ' + e.message);
  }
  names.forEach(n => { if (engine[n] === undefined) throw new Error('Dashboard.html changed: "' + n + '" is no longer defined - Export.gs needs an update.'); });
  return engine;
}

/** The dashboard's own export payload for one store / group (same as ticking its checkbox and pressing Export to Sheets). */
function fsopBuildPayload_(engine, selection) {
  selection = String(selection || '').trim();
  const known = Array.from(new Set(engine.DATA.map(r => r.brand)));
  if (known.indexOf(selection) === -1) throw new Error('Unknown store / group "' + selection + '". Valid: ' + known.join(', '));
  Object.keys(engine.state.store).forEach(k => { delete engine.state.store[k]; });
  engine.state.store[selection] = true;
  const rows = engine.getExportRows_();
  if (!rows.length) throw new Error('No data found for "' + selection + '".');
  const payload = engine.buildExportPayload_(rows);
  if (!payload.sheets || !payload.sheets.length) throw new Error('The dashboard produced no export sheets for "' + selection + '".');
  payload.storeLabel = engine.exportStoreLabel_(rows);
  return payload;
}

function fsopExportFromCache_(engineOrCache, selection) {
  const engine = engineOrCache.buildExportPayload_ ? engineOrCache : fsopLoadEngine_(engineOrCache);
  const result = createExportSpreadsheet(fsopBuildPayload_(engine, selection));
  Logger.log('FSOP export "%s" -> %s (%s)', selection, result.fileName, result.url);
  return result;
}

/**
 * Exports one store / group straight from the data (no dashboard UI).
 * @param {string} selection  a store ("Maybelline Official") or a group ("LOreal Group", "LOreal CPD", ...), as named in the sidebar
 * @param {{refresh?: boolean, cache?: Object}} opts  refresh (default true) runs refreshData() first; `cache` reuses a payload
 * @return {{url: string, fileName: string}}
 */
function exportFsop(selection, opts) {
  opts = opts || {};
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) throw new Error('Another export / refresh is still running - try again in a few minutes.');
  try {
    let cache = opts.cache || null;
    if (!cache && opts.refresh !== false) cache = refreshData();
    if (!cache) { const json = loadCachedData_(); cache = json ? JSON.parse(json) : null; }
    if (!cache || !cache.DATA || !cache.DATA.length) throw new Error('No dashboard data available - run refreshData() first.');
    return fsopExportFromCache_(cache, selection);
  } finally {
    lock.releaseLock();
  }
}

/** Selections to export, from Script Property FSOP_SELECTIONS (comma / newline separated), default ["LOreal Group"]. */
function fsopGetSelections_() {
  const raw = PropertiesService.getScriptProperties().getProperty(FSOP_SELECTIONS_PROPERTY);
  const list = String(raw || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
  return list.length ? list : FSOP_DEFAULT_SELECTIONS.slice();
}

/**
 * Entry point for the editor's Run button and for the daily trigger: refreshData() once, then one spreadsheet per
 * configured selection (all built from that same fresh payload - no second read of the source files).
 */
function exportFsopFromSettings() {
  const selections = fsopGetSelections_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) throw new Error('Another export / refresh is still running - try again in a few minutes.');
  try {
    const cache = refreshData();
    if (!cache || !cache.DATA || !cache.DATA.length) throw new Error('refreshData() returned no data.');
    const engine = fsopLoadEngine_(cache);
    const out = selections.map(sel => fsopExportFromCache_(engine, sel));
    Logger.log('FSOP export finished: ' + out.map(o => o.url).join(' , '));
    return out;
  } finally {
    lock.releaseLock();
  }
}

/** One-click variant for the editor's function dropdown. */
function exportFsopLOrealGroup() { return exportFsop('LOreal Group'); }

/**
 * Run once: daily 06:00 trigger that runs exportFsopFromSettings (refresh + export in a single run). It REPLACES the
 * existing refreshData trigger, because exportFsopFromSettings already calls refreshData() first - keeping both would
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
