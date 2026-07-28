/**
 * 2026 Spending Report updater.
 *
 * The report's existing `Order - ...` tabs are the hard order allowlist.
 * `Orders!C1:C106` narrows that allowlist to the current operational orders.
 * The script never creates an order tab and never publishes a non-2026 row.
 */

const UPDATE_CONFIG_ = Object.freeze({
  reportId: '1EjaH69wwJEMF52gn1HEEY4skM4GRoOmdyyHStVhmHPs',
  controlId: '1R9HiIeOqUDket5gLWuxHYiLFfKIm55Hl_A7ra7HdEoc',
  controlRange: 'Orders!C1:C106',
  registryId: '19mxRU09_AJiahr-oA3K9nD87G6xjqq7_npVR_6ZvaGw',
  registryRange: 'Order Sheets!A2:B100',
  priceAnchorId: '1HLRRND0gGFSx3slNGXKtwrGanmc27lgVi9Sko5u5Q_s',
  priceAnchorTab: 'Price Anchor',
  reportYear: 2026,
  stagingTab: '__2026 Refresh Staging',
  stateProperty: 'REPORT_2026_REFRESH_STATE',
  continuationHandler: 'continueRefresh2026Report',
  sourceBatchSize: 2,
  orderTabBatchSize: 5,
  excludedOrders: ['LiveSportsOdds'],
  cleanHeaders: [
    'Order', 'Source Tab', 'Source Row', 'Invoice Date', 'Month',
    'Link Builder', 'Website', 'Niche', 'DR', 'Traffic', 'Price (EUR)',
    'ECB Rate Date', 'ECB Rate (currency per EUR)', 'Country/Lang',
    'Target URL', 'Anchor', 'Content URL', 'Live URL', 'Invoice',
    'Invoice Status', 'Link Code', 'Derived Reporting Month',
    'Included in Reporting Period', 'Data Quality Issue',
    'PressWhizz Price (EUR)', 'Saving (EUR)',
  ],
  comparisonHeaders: [
    'Order', 'Source Tab', 'Source Row', 'Website', 'Anchor Text',
    'Paid Price (EUR)', 'Live URL', 'Portal Match',
    'Normal Anchor Price (EUR)', 'Grey Anchor Price (EUR)',
    'PressWhizz Price (EUR)', 'PressWhizz Price (EUR) - Paid Price (EUR)',
    'Match Status', 'Price Anchor Row', 'Price Anchor Country',
    'Price Anchor Language', 'Price Anchor Niche', 'Accepts Grey Niche?',
    'Also Accepting',
  ],
  fixedSources: [
    ['MCG', '1tYVA1l7_uBAB1khQON3Fptsv91hVaZ34sb3OmkthFig'],
    ['LT PBNs', '1sVjdJHYKCfLPn9iT-pmkRz4XTPgc-EGIWhisMFmgDLM'],
    ['CGEE', '15kiPmDayHcQTZl7CfsrMxffq5QJ2A2e8ATXjADxwB-8'],
    ['LiveSportsOdds', '1F7ltH1wRrVSOuSnYEAf8gW-gmJ5vuIfGlhgzLy7QfiU'],
    ['EMDs', '1AmYB4XcoZP9qhU0aNzSE5MMCYtGfin-CwrPjEq-Ase0'],
    ['DIR', '1-XQuocVs-MhmIc-QhndOVjEOI5wmvxE0R5s3ql7_r4k'],
    ['Filip Serbian Domains', '1PDLuJwJ5Ew4CRRKZsgI6Rg3E84mtE6OlOaPLVwuD854'],
    ['AAMS', '12CukxhfOLtnCxUO_xvkM-r9YFJrnUYQ6cudbIVY7-vw'],
    ['Tier 2s', '1MI3SuOvWpjdcaNEd6GA-acl12iBVZG7I92AFKQ-TYkg'],
    ['DG', '10N2eBAXK2MRhxpiucRc6MbVcoQv9wIKGzd3NMBLkINY'],
    ['LT EMDs', '1TbBCzj0T5_GuZRi6arYGCOj5BQR64bS0MPE0rf-WXng'],
    ['ZG', '1MOR14UjanmNjGTbOyyE0kKoexFgXmSF1nl5OoYc4WBw'],
    ['KPRS', '1ADcRPUye3tU1sRGBqqbIBo_lEU5Dqnz9b1KDVekjlBo'],
  ],
  colors: {
    ink: '#17212b',
    teal: '#007f7b',
    blue: '#2f6fed',
    white: '#ffffff',
    paleTeal: '#e5f5f3',
    paleRed: '#fdeaea',
  },
});

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Update 2026 Report')
    .addItem('Update now from Orders column C', 'refresh2026SpendingReport')
    .addItem('Resume current update', 'continueRefresh2026Report')
    .addItem('Cancel current update', 'cancelRefresh2026Report')
    .addItem('Install / repair update button', 'installRefreshButton')
    .addToUi();
}

/** Cancels a queued refresh without changing any published report data. */
function cancelRefresh2026Report() {
  const report = SpreadsheetApp.openById(UPDATE_CONFIG_.reportId);
  clearRefreshState_();
  clearContinuationTriggers_();
  removeStagingSheet_(report);
  report.toast('The queued report update was cancelled.', '2026 Report', 6);
}

/** Small diagnostic used by maintainers and the Apps Script execution API. */
function getReportRefreshStatus() {
  const state = readRefreshState_();
  return state ? JSON.stringify(state) : 'idle';
}

/** Public function assigned to the Dashboard update button. */
function refresh2026SpendingReport() {
  const existingState = readRefreshState_();
  if (existingState) {
    SpreadsheetApp.openById(UPDATE_CONFIG_.reportId)
      .toast('Resuming the update already in progress…', '2026 Report', 6);
    continueRefresh2026Report();
    return;
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    SpreadsheetApp.openById(UPDATE_CONFIG_.reportId)
      .toast('An update is already running.', '2026 Report', 5);
    return;
  }
  const report = SpreadsheetApp.openById(UPDATE_CONFIG_.reportId);
  try {
    report.toast('Reading the existing report orders and Orders column C…', '2026 Report', 10);
    const throughDate = reportThroughDate_();
    const existing = readExistingReportState_(report);
    const activeOrderTabs = activeOrderTabs_(existing.orderTabs);
    const selections = selectExistingOrderSources_(report, activeOrderTabs);
    if (selections.length !== activeOrderTabs.size) {
      const selected = new Set(selections.map((item) => item.key));
      const skipped = [...activeOrderTabs.keys()].filter((key) => !selected.has(key));
      throw new Error(
        'The update was stopped because existing report orders are missing from Orders!C1:C106 or the source registry: ' +
        skipped.map((key) => activeOrderTabs.get(key).order).join(', '),
      );
    }

    resetStagingSheet_(report);
    SpreadsheetApp.flush();
    writeRefreshState_({
      phase: 'sources',
      nextOrder: 0,
      throughDate: isoDate_(throughDate),
      startedAt: new Date().toISOString(),
      selections,
    });
    report.toast(
      'Update started for the ' + selections.length + ' existing report orders. It will continue in safe batches.',
      '2026 Report',
      10,
    );
  } catch (error) {
    report.toast('Update failed. The report was not intentionally expanded with new orders.', '2026 Report', 10);
    throw error;
  } finally {
    lock.releaseLock();
  }
  continueRefresh2026Report();
}

/** Resumable continuation used by both the button and short-lived time triggers. */
function continueRefresh2026Report() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  const report = SpreadsheetApp.openById(UPDATE_CONFIG_.reportId);
  try {
    clearContinuationTriggers_();
    const state = readRefreshState_();
    if (!state) {
      report.toast('No report update is waiting to resume.', '2026 Report', 5);
      return;
    }
    const throughDate = parseIsoDate_(state.throughDate);
    if (!throughDate) throw new Error('The saved refresh date is invalid.');
    const existing = readExistingReportState_(report);
    validateSavedSelections_(state.selections, activeOrderTabs_(existing.orderTabs));

    if (state.phase === 'sources') {
      runSourceBatch_(report, state, existing, throughDate);
    } else if (state.phase === 'core') {
      runCoreWrite_(report, state, existing, throughDate);
    } else if (state.phase === 'orders') {
      runOrderTabBatch_(report, state, existing, throughDate);
    } else if (state.phase === 'final') {
      finishRefresh_(report, state, existing, throughDate);
    } else {
      throw new Error('Unknown refresh phase: ' + state.phase);
    }
  } catch (error) {
    report.toast('Update paused: ' + error.message + ' Click the update button to retry.', '2026 Report', 12);
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function runSourceBatch_(report, state, existing, throughDate) {
  const start = Number(state.nextOrder || 0);
  const remaining = state.selections.length - start;
  const batchSize = remaining <= 2 ? 1 : UPDATE_CONFIG_.sourceBatchSize;
  const end = Math.min(start + batchSize, state.selections.length);
  const batch = state.selections.slice(start, end);
  report.toast(
    'Reading orders ' + (start + 1) + '-' + end + ' of ' + state.selections.length + '…',
    '2026 Report',
    10,
  );
  removeStagedOrders_(report, batch.map((selection) => selection.key));
  const records = [];
  batch.forEach((selection) => {
    try {
      records.push(...collectReportRows_([selection], existing, throughDate));
    } catch (error) {
      if (!isDocumentPermissionError_(error)) throw error;
      selection.authoritativeMonths = [];
      selection.authoritativeCohorts = [];
      selection.sourceIssues = [];
      state.skippedOrders = state.skippedOrders || [];
      if (!state.skippedOrders.includes(selection.order)) state.skippedOrders.push(selection.order);
    }
  });
  appendStagedRecords_(report, records);
  state.nextOrder = end;
  if (end >= state.selections.length) {
    state.phase = 'core';
    state.nextOrder = 0;
  }
  writeRefreshState_(state);
  scheduleContinuation_();
}

function isDocumentPermissionError_(error) {
  return /permission|access the requested document/i.test(String(error && error.message || error || ''));
}

function runCoreWrite_(report, state, existing, throughDate) {
  report.toast('Merging current order data and replacing authoritative month tabs…', '2026 Report', 12);
  const incomingRecords = readStagedRecords_(report);
  const activeOrderTabs = activeOrderTabs_(existing.orderTabs);
  const activeExistingRecords = existing.existingRecords.filter((record) =>
    activeOrderTabs.has(record.orderKey),
  );
  validateSourceScans_(state.selections);
  validateAuthoritativeCohorts_(state.selections, incomingRecords);
  const authoritativeMonths = authoritativeMonthKeys_(state.selections);
  const preservedHistoryCount = activeExistingRecords.filter((record) =>
    !authoritativeMonths.has(orderMonthKey_(record.orderKey, record.monthKey)),
  ).length;
  const records = mergeRecordsPreservingHistory_(
    activeExistingRecords,
    incomingRecords,
    authoritativeMonths,
  );
  if (records.length < preservedHistoryCount) {
    throw new Error('The update would remove history outside authoritative month tabs, so it was stopped.');
  }
  const priceAnchors = readPriceAnchors_(report);
  attachPriceComparisons_(records, priceAnchors);
  replaceStagedRecords_(report, records);
  const model = buildModel_(records, state.selections, throughDate);
  validateModel_(model, state.selections, activeOrderTabs);
  writeCleanData_(requireSheet_(report, 'Clean Data'), model.records);
  writeComparison_(requireSheet_(report, 'Site Price Comparison'), model.records);
  writeMonthly_(requireSheet_(report, 'Monthly Spending'), model);
  writeOrderSummary_(requireSheet_(report, 'Order Summary'), model, activeOrderTabs);
  state.phase = 'orders';
  state.nextOrder = 0;
  state.records = model.records.length;
  writeRefreshState_(state);
  SpreadsheetApp.flush();
  scheduleContinuation_();
}

function runOrderTabBatch_(report, state, existing, throughDate) {
  const records = readStagedRecords_(report);
  const model = buildModel_(records, state.selections, throughDate);
  const activeOrderTabs = activeOrderTabs_(existing.orderTabs);
  validateModel_(model, state.selections, activeOrderTabs);
  const start = Number(state.nextOrder || 0);
  const end = Math.min(start + UPDATE_CONFIG_.orderTabBatchSize, model.orders.length);
  report.toast(
    'Updating existing order tabs ' + (start + 1) + '-' + end + ' of ' + model.orders.length + '…',
    '2026 Report',
    10,
  );
  model.orders.slice(start, end).forEach((order) => {
    writeOrderTab_(activeOrderTabs.get(order.key).sheet, order, model);
  });
  state.nextOrder = end;
  if (end >= model.orders.length) {
    state.phase = 'final';
    state.nextOrder = 0;
  }
  writeRefreshState_(state);
  SpreadsheetApp.flush();
  scheduleContinuation_();
}

function finishRefresh_(report, state, existing, throughDate) {
  const records = readStagedRecords_(report);
  const model = buildModel_(records, state.selections, throughDate);
  const activeOrderTabs = activeOrderTabs_(existing.orderTabs);
  validateModel_(model, state.selections, activeOrderTabs);
  writeDashboard_(requireSheet_(report, 'Dashboard'), model);
  writeDataIssues_(requireSheet_(report, 'Data Issues'));
  hideExcludedOrderTabs_(existing.orderTabs);
  installRefreshButton();
  SpreadsheetApp.flush();
  verifyWrittenReport_(report, model, activeOrderTabs);
  removeStagingSheet_(report);
  clearRefreshState_();
  clearContinuationTriggers_();
  report.toast(
    'Updated ' + model.records.length + ' records through ' + formatLongDate_(throughDate) + '.',
    '2026 Report',
    10,
  );
}

function validateSavedSelections_(selections, orderTabs) {
  if (!Array.isArray(selections) || selections.length !== orderTabs.size) {
    throw new Error('The saved update no longer matches the existing report order tabs.');
  }
  const saved = new Set(selections.map((selection) => normalizeOrder_(selection.order)));
  const missing = [...orderTabs.keys()].filter((key) => !saved.has(key));
  if (missing.length > 0) {
    throw new Error('The existing report order set changed during the update: ' + missing.join(', '));
  }
}

function resetStagingSheet_(report) {
  let sheet = report.getSheetByName(UPDATE_CONFIG_.stagingTab);
  if (!sheet) sheet = report.insertSheet(UPDATE_CONFIG_.stagingTab);
  ensureSheetSize_(sheet, 2, UPDATE_CONFIG_.cleanHeaders.length);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, UPDATE_CONFIG_.cleanHeaders.length)
    .setValues([UPDATE_CONFIG_.cleanHeaders]);
  sheet.getRange(1, 2, sheet.getMaxRows(), 1).setNumberFormat('@');
  sheet.getRange(1, 5, sheet.getMaxRows(), 1).setNumberFormat('@');
  if (!sheet.isSheetHidden()) sheet.hideSheet();
}

function appendStagedRecords_(report, records) {
  if (records.length === 0) return;
  const sheet = requireSheet_(report, UPDATE_CONFIG_.stagingTab);
  const startRow = Math.max(sheet.getLastRow() + 1, 2);
  ensureSheetSize_(sheet, startRow + records.length - 1, UPDATE_CONFIG_.cleanHeaders.length);
  sheet.getRange(startRow, 2, records.length, 1).setNumberFormat('@');
  sheet.getRange(startRow, 5, records.length, 1).setNumberFormat('@');
  sheet.getRange(startRow, 1, records.length, UPDATE_CONFIG_.cleanHeaders.length)
    .setValues(records.map(cleanDataRow_));
}

function replaceStagedRecords_(report, records) {
  const sheet = requireSheet_(report, UPDATE_CONFIG_.stagingTab);
  const width = UPDATE_CONFIG_.cleanHeaders.length;
  ensureSheetSize_(sheet, records.length + 1, width);
  sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), width).clearContent();
  if (records.length > 0) {
    sheet.getRange(2, 2, records.length, 1).setNumberFormat('@');
    sheet.getRange(2, 5, records.length, 1).setNumberFormat('@');
    sheet.getRange(2, 1, records.length, width).setValues(records.map(cleanDataRow_));
  }
}

function removeStagedOrders_(report, orderKeys) {
  if (orderKeys.length === 0) return;
  const sheet = requireSheet_(report, UPDATE_CONFIG_.stagingTab);
  if (sheet.getLastRow() < 2) return;
  const width = UPDATE_CONFIG_.cleanHeaders.length;
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues();
  const remove = new Set(orderKeys);
  const kept = rows.filter((row) => !remove.has(normalizeOrder_(row[0])));
  sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), width).clearContent();
  if (kept.length > 0) sheet.getRange(2, 1, kept.length, width).setValues(kept);
}

function readStagedRecords_(report) {
  const sheet = requireSheet_(report, UPDATE_CONFIG_.stagingTab);
  if (sheet.getLastRow() < 2) return [];
  const width = UPDATE_CONFIG_.cleanHeaders.length;
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues();
  const display = sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getDisplayValues();
  return values.map((row, index) => stagedRowToRecord_(row, display[index]));
}

function stagedRowToRecord_(row, shown) {
  const invoiceDate = row[3] instanceof Date
    ? dateOnly_(row[3])
    : parseDateCell_(shown[3], row[3], null, row[1]);
  if (!invoiceDate || invoiceDate.getFullYear() !== UPDATE_CONFIG_.reportYear) {
    throw new Error('A staged row has an invalid or non-2026 invoice date.');
  }
  const pressWhizz = numberOrNull_(row[24]);
  const saving = numberOrNull_(row[25]);
  return {
    order: String(row[0] || ''),
    orderKey: normalizeOrder_(row[0]),
    sourceTab: String(row[1] || ''),
    sourceRow: Number(row[2]),
    invoiceDate,
    monthKey: reportingMonthKey_(row[4], shown[4], invoiceDate),
    linkBuilder: row[5],
    website: row[6],
    niche: row[7],
    dr: row[8],
    traffic: row[9],
    priceEur: Number(row[10]),
    ecbRateDate: row[11] instanceof Date ? dateOnly_(row[11]) : '',
    ecbRate: numberOrNull_(row[12]),
    country: row[13],
    targetUrl: row[14],
    anchor: row[15],
    contentUrl: row[16],
    liveUrl: row[17],
    invoice: row[18],
    invoiceStatus: row[19],
    linkCode: row[20],
    pressWhizzPrice: pressWhizz,
    saving,
    comparison: null,
  };
}

function writeStagedComparisons_(report, records) {
  if (records.length === 0) return;
  const sheet = requireSheet_(report, UPDATE_CONFIG_.stagingTab);
  sheet.getRange(2, 25, records.length, 2).setValues(records.map((record) => [
    record.pressWhizzPrice === null ? '' : record.pressWhizzPrice,
    record.saving === null ? '' : record.saving,
  ]));
}

function removeStagingSheet_(report) {
  const sheet = report.getSheetByName(UPDATE_CONFIG_.stagingTab);
  if (sheet) report.deleteSheet(sheet);
}

function readRefreshState_() {
  const raw = PropertiesService.getScriptProperties().getProperty(UPDATE_CONFIG_.stateProperty);
  return raw ? JSON.parse(raw) : null;
}

function writeRefreshState_(state) {
  PropertiesService.getScriptProperties()
    .setProperty(UPDATE_CONFIG_.stateProperty, JSON.stringify(state));
}

function clearRefreshState_() {
  PropertiesService.getScriptProperties().deleteProperty(UPDATE_CONFIG_.stateProperty);
}

function clearContinuationTriggers_() {
  ScriptApp.getProjectTriggers().forEach((trigger) => {
    if (trigger.getHandlerFunction() === UPDATE_CONFIG_.continuationHandler) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function scheduleContinuation_() {
  clearContinuationTriggers_();
  ScriptApp.newTrigger(UPDATE_CONFIG_.continuationHandler)
    .timeBased()
    .after(30000)
    .create();
}

/** Installs the visible Dashboard button once and keeps its script assignment repaired. */
function installRefreshButton() {
  const report = SpreadsheetApp.openById(UPDATE_CONFIG_.reportId);
  const dashboard = requireSheet_(report, 'Dashboard');
  const title = 'Update 2026 report from Orders column C';
  let image = report.getImages().find((candidate) => candidate.getAltTextTitle() === title);
  if (!image) {
    const png = Utilities.newBlob(
      Utilities.base64Decode(UPDATE_BUTTON_PNG_BASE64_),
      'image/png',
      'update-2026-report.png',
    );
    image = dashboard.insertImage(png, 4, 6, 8, 2)
      .setWidth(250)
      .setHeight(50)
      .setAltTextTitle(title)
      .setAltTextDescription('Click to refresh only the existing report orders from Orders column C.');
  }
  image.assignScript('refresh2026SpendingReport');
  SpreadsheetApp.flush();
}

function readExistingReportState_(report) {
  const orderTabs = new Map();
  report.getSheets().forEach((sheet) => {
    const match = /^Order\s+-\s+(.+)$/i.exec(sheet.getName());
    if (!match) return;
    const order = String(match[1] || '').trim();
    orderTabs.set(normalizeOrder_(order), { order, sheet });
  });
  if (orderTabs.size === 0) throw new Error('No existing Order - … tabs were found in the report.');

  const clean = requireSheet_(report, 'Clean Data');
  const existingBySource = new Map();
  const existingRecords = [];
  if (clean.getLastRow() >= 2) {
    const rowCount = clean.getLastRow() - 1;
    const values = clean.getRange(2, 1, rowCount, UPDATE_CONFIG_.cleanHeaders.length).getValues();
    const display = clean.getRange(2, 1, rowCount, UPDATE_CONFIG_.cleanHeaders.length).getDisplayValues();
    values.forEach((row, index) => {
      existingRecords.push(stagedRowToRecord_(row, display[index]));
      const key = sourceKey_(row[0], row[1], row[2]);
      if (!key) return;
      existingBySource.set(key, {
        invoiceDate: parseDateCell_(display[index][3], row[3], null, ''),
        priceEur: numberOrNull_(row[10]),
        rateDate: parseDateCell_(display[index][11], row[11], null, ''),
        rate: numberOrNull_(row[12]),
      });
    });
  }
  return { orderTabs, existingBySource, existingRecords };
}

function mergeRecordsPreservingHistory_(existingRecords, incomingRecords, authoritativeMonths) {
  const merged = existingRecords.filter((record) =>
    !authoritativeMonths.has(orderMonthKey_(record.orderKey, record.monthKey)),
  );
  const identityIndex = new Map();
  const used = new Set();

  merged.forEach((record, index) => {
    recordIdentityKeys_(record).forEach((key) => {
      const indexes = identityIndex.get(key) || [];
      indexes.push(index);
      identityIndex.set(key, indexes);
    });
  });

  incomingRecords.forEach((record) => {
    let match = -1;
    const keys = recordIdentityKeys_(record);
    for (let keyIndex = 0; keyIndex < keys.length && match < 0; keyIndex += 1) {
      const indexes = identityIndex.get(keys[keyIndex]) || [];
      for (let index = 0; index < indexes.length; index += 1) {
        if (!used.has(indexes[index])) {
          match = indexes[index];
          break;
        }
      }
    }
    if (match >= 0) {
      used.add(match);
      merged[match] = record;
    } else {
      merged.push(record);
    }
  });

  disambiguateHistoricalSourceIdentities_(merged, new Set(incomingRecords));

  return merged.sort((a, b) =>
    a.order.localeCompare(b.order) ||
    a.invoiceDate.getTime() - b.invoiceDate.getTime() ||
    a.sourceTab.localeCompare(b.sourceTab) ||
    a.sourceRow - b.sourceRow,
  );
}

function disambiguateHistoricalSourceIdentities_(records, incomingRecords) {
  const groups = new Map();
  records.forEach((record) => {
    const key = sourceKey_(record.order, record.sourceTab, record.sourceRow);
    const group = groups.get(key) || [];
    group.push(record);
    groups.set(key, group);
  });

  const occupied = new Set(groups.keys());
  groups.forEach((group) => {
    if (group.length < 2) return;
    const keep = group.find((record) => incomingRecords.has(record)) || group[0];
    let suffix = 1;
    group.forEach((record) => {
      if (record === keep) return;
      const originalTab = String(record.sourceTab || '').replace(/ \[historical(?: \d+)?\]$/, '');
      let candidate = originalTab + ' [historical]';
      let candidateKey = sourceKey_(record.order, candidate, record.sourceRow);
      while (occupied.has(candidateKey)) {
        suffix += 1;
        candidate = originalTab + ' [historical ' + suffix + ']';
        candidateKey = sourceKey_(record.order, candidate, record.sourceRow);
      }
      record.sourceTab = candidate;
      occupied.add(candidateKey);
    });
  });
}

function recordIdentityKeys_(record) {
  const keys = [];
  const invoice = normalizeUrlIdentity_(record.invoice);
  const live = normalizeUrlIdentity_(record.liveUrl);
  const domain = normalizeDomain_(record.website);
  if (invoice) keys.push('invoice|' + record.orderKey + '|' + invoice);
  if (live) keys.push('live|' + record.orderKey + '|' + live);
  if (domain && record.invoiceDate && Number.isFinite(record.priceEur)) {
    keys.push(
      'row|' + record.orderKey + '|' + domain + '|' +
      isoDate_(record.invoiceDate) + '|' + roundMoney_(record.priceEur).toFixed(2),
    );
  }
  const source = sourceKey_(record.order, record.sourceTab, record.sourceRow);
  if (source) keys.push('source|' + source);
  return keys;
}

function normalizeUrlIdentity_(value) {
  const text = String(value || '').trim();
  if (!/^https?:\/\//i.test(text)) return '';
  let match = /drive\.google\.com\/file\/d\/([^/?#]+)/i.exec(text);
  if (match) return 'drive:' + match[1];
  match = /docs\.google\.com\/(?:document|spreadsheets)\/d\/([^/?#]+)/i.exec(text);
  if (match) return 'google:' + match[1];
  match = /paypal\.com\/invoice\/p\/#([^/?#]+)/i.exec(text);
  if (match) return 'paypal:' + match[1].toLowerCase();
  return text.toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/?(?:\?usp=(?:sharing|drivesdk))$/, '')
    .replace(/\/+$/, '');
}

function selectExistingOrderSources_(report, existingOrderTabs) {
  const controlSheet = SpreadsheetApp.openById(UPDATE_CONFIG_.controlId);
  const controlValues = controlSheet.getRange(UPDATE_CONFIG_.controlRange).getDisplayValues();
  const control = new Set(controlValues.flat().map(normalizeOrder_).filter(Boolean));

  const sources = new Map();
  UPDATE_CONFIG_.fixedSources.forEach(([name, id]) => sources.set(normalizeOrder_(name), id));
  const registry = SpreadsheetApp.openById(UPDATE_CONFIG_.registryId)
    .getRange(UPDATE_CONFIG_.registryRange)
    .getDisplayValues();
  registry.forEach((row) => {
    const key = normalizeOrder_(row[0]);
    const id = String(row[1] || '').trim();
    if (key && /^[\w-]{20,}$/.test(id)) sources.set(key, id);
  });

  const selections = [];
  existingOrderTabs.forEach(({ order }, key) => {
    if (isExcludedOrderKey_(key)) return;
    if (!control.has(key)) return;
    const sourceId = sources.get(key);
    if (!sourceId) return;
    selections.push({ key, order, sourceId });
  });
  return selections.sort((a, b) => a.order.localeCompare(b.order));
}

function collectReportRows_(selections, existing, throughDate) {
  const records = [];
  selections.forEach((selection) => {
    const sourceBook = SpreadsheetApp.openById(selection.sourceId);
    const sourceSheets = sourceBook.getSheets();
    const explicitMonths = new Set(sourceSheets.map((sheet) => explicitMonthKey_(sheet.getName())).filter(Boolean));
    const authoritativeCohorts = new Map();
    const explicitDoneRows = new Map();
    selection.authoritativeMonths = [];
    selection.authoritativeCohorts = [];
    selection.sourceIssues = [];
    const throughMonth = monthKey_(throughDate);
    sourceSheets.forEach((sheet) => {
      if (isGeneratedSourceTab_(sheet.getName()) || sheet.getLastRow() < 2) return;
      const tabMonth = explicitMonthKey_(sheet.getName());
      if (tabMonth && tabMonth > throughMonth) return;
      const width = Math.min(Math.max(sheet.getLastColumn(), 21), 40);
      const scanRows = Math.min(sheet.getLastRow(), 50);
      const scan = sheet.getRange(1, 1, scanRows, width).getDisplayValues();
      const headerOffset = findStandardHeaderOffset_(scan);
      if (headerOffset < 0) {
        if (tabMonth) {
          const doneCount = sheet.getRange(1, 1, sheet.getLastRow(), 1)
            .getDisplayValues()
            .filter((row) => String(row[0] || '').trim() === 'Done').length;
          explicitDoneRows.set(tabMonth, (explicitDoneRows.get(tabMonth) || 0) + doneCount);
          if (doneCount > 0) {
            selection.sourceIssues.push(
              selection.order + ' ' + sheet.getName() +
              ' contains ' + doneCount + ' Done rows but its standard headers were not recognized.',
            );
          }
        }
        return;
      }
      const recordsBeforeTab = records.length;
      const header = scan[headerOffset].map((value) => String(value || '').trim());
      const index = headerIndex_(header);
      const startRow = headerOffset + 2;
      const rowCount = sheet.getLastRow() - startRow + 1;
      if (rowCount < 1) return;
      // Every editable order workbook uses one operator-facing convention. A
      // protected source may still be read and reported even if its display
      // format cannot be changed by the current user.
      try {
        const invoiceDateRange = sheet.getRange(startRow, 13, rowCount, 1);
        const needsCanonicalDateFormat = invoiceDateRange.getNumberFormats()
          .some((row) => row[0] !== 'dd/MM/yyyy');
        if (needsCanonicalDateFormat) invoiceDateRange.setNumberFormat('dd/MM/yyyy');
      } catch (error) {
        selection.dateFormatSkippedTabs = selection.dateFormatSkippedTabs || [];
        selection.dateFormatSkippedTabs.push(sheet.getName());
      }
      const values = sheet.getRange(startRow, 1, rowCount, width).getValues();
      const display = sheet.getRange(startRow, 1, rowCount, width).getDisplayValues();
      if (tabMonth) {
        const doneCount = display.filter((row) => String(row[0] || '').trim() === 'Done').length;
        explicitDoneRows.set(tabMonth, (explicitDoneRows.get(tabMonth) || 0) + doneCount);
      }

      values.forEach((row, offset) => {
        const shown = display[offset];
        if (String(shown[0] || '').trim() !== 'Done') return;
        if (shown.every((cell) => String(cell || '').trim() === '')) return;
        const sourceRow = startRow + offset;
        const sourceKey = sourceKey_(selection.order, sheet.getName(), sourceRow);
        const old = existing.existingBySource.get(sourceKey) || null;
        if (/(karolis|karlois)/i.test(String(shown[13] || ''))) return;
        const invoiceDate = parseDateCell_(shown[12], row[12], old && old.invoiceDate, sheet.getName());
        if (!invoiceDate || invoiceDate.getFullYear() !== UPDATE_CONFIG_.reportYear) return;
        if (!tabMonth && dateOnly_(invoiceDate).getTime() > throughDate.getTime()) return;
        const invoiceMonth = monthKey_(invoiceDate);
        if (!tabMonth && explicitMonths.has(invoiceMonth)) return;
        const reportingMonth = tabMonth || invoiceMonth;

        const price = priceToEur_(shown[6], row[6], invoiceDate, old);
        if (price.amount === null) return;
        records.push({
          order: selection.order,
          orderKey: selection.key,
          sourceTab: sheet.getName(),
          sourceRow,
          invoiceDate,
          monthKey: reportingMonth,
          linkBuilder: sourceValue_(row, shown, 1),
          website: sourceValue_(row, shown, 2),
          niche: sourceValue_(row, shown, 3),
          dr: numericOrText_(row[4], shown[4]),
          traffic: numericOrText_(row[5], shown[5]),
          priceEur: price.amount,
          ecbRateDate: price.rateDate,
          ecbRate: price.rate,
          country: sourceValue_(row, shown, 7),
          targetUrl: sourceValue_(row, shown, 8),
          anchor: sourceValue_(row, shown, 9),
          contentUrl: sourceValue_(row, shown, 10),
          liveUrl: sourceValue_(row, shown, 11),
          invoice: sourceValue_(row, shown, 13),
          invoiceStatus: sourceValue_(row, shown, 14),
          linkCode: findHeaderValue_(index, row, shown, ['Link Code', 'LinkCode']),
          pressWhizzPrice: null,
          saving: null,
          comparison: null,
        });
      });
      if (tabMonth && records.length > recordsBeforeTab) {
        const added = records.slice(recordsBeforeTab);
        const cohort = authoritativeCohorts.get(tabMonth) || {
          monthKey: tabMonth,
          rowCount: 0,
          totalSpend: 0,
        };
        cohort.rowCount += added.length;
        cohort.totalSpend = roundMoney_(added.reduce(
          (sum, record) => addMoney_(sum, record.priceEur),
          cohort.totalSpend,
        ));
        authoritativeCohorts.set(tabMonth, cohort);
      }
    });
    [...explicitMonths]
      .filter((monthKey) => monthKey <= throughMonth)
      .forEach((monthKey) => {
        const cohort = authoritativeCohorts.get(monthKey);
        if (cohort && cohort.rowCount > 0) return;
        const existingCount = existing.existingRecords.filter((record) =>
          record.orderKey === selection.key && record.monthKey === monthKey,
        ).length;
        const sourceDoneCount = explicitDoneRows.get(monthKey) || 0;
        if (existingCount > 0) {
          selection.sourceIssues.push(
            selection.order + ' ' + monthKey +
            ' yielded zero eligible source rows (source Done rows: ' + sourceDoneCount +
            ', existing report rows: ' + existingCount + ').',
          );
        }
      });
    selection.authoritativeCohorts = [...authoritativeCohorts.values()]
      .filter((cohort) => cohort.rowCount > 0)
      .sort((a, b) => a.monthKey.localeCompare(b.monthKey));
    selection.authoritativeMonths = selection.authoritativeCohorts.map((cohort) => cohort.monthKey);
  });
  return records.sort((a, b) =>
    a.order.localeCompare(b.order) ||
    a.sourceTab.localeCompare(b.sourceTab) ||
    a.sourceRow - b.sourceRow,
  );
}

function validateSourceScans_(selections) {
  const issues = [];
  selections.forEach((selection) => {
    (selection.sourceIssues || []).forEach((issue) => issues.push(issue));
  });
  if (issues.length > 0) {
    throw new Error(
      'The update was stopped because an explicit month scan could remove valid history: ' +
      issues.slice(0, 5).join(' | ') +
      (issues.length > 5 ? ' | +' + (issues.length - 5) + ' more' : ''),
    );
  }
}

function validateAuthoritativeCohorts_(selections, incomingRecords) {
  const actual = new Map();
  incomingRecords.forEach((record) => {
    const key = orderMonthKey_(record.orderKey, record.monthKey);
    const cohort = actual.get(key) || { rowCount: 0, totalSpend: 0 };
    cohort.rowCount += 1;
    cohort.totalSpend = addMoney_(cohort.totalSpend, record.priceEur);
    actual.set(key, cohort);
  });

  selections.forEach((selection) => {
    const expectedByMonth = new Map(
      (selection.authoritativeCohorts || []).map((cohort) => [cohort.monthKey, cohort]),
    );
    (selection.authoritativeMonths || []).forEach((monthKey) => {
      const expected = expectedByMonth.get(monthKey);
      if (!expected || expected.rowCount < 1) {
        throw new Error(selection.order + ' ' + monthKey + ' has an empty authoritative replacement cohort.');
      }
      const key = orderMonthKey_(selection.key || selection.order, monthKey);
      const observed = actual.get(key) || { rowCount: 0, totalSpend: 0 };
      if (observed.rowCount !== expected.rowCount) {
        throw new Error(
          selection.order + ' ' + monthKey + ' staged ' + observed.rowCount +
          ' rows but the source scan collected ' + expected.rowCount + '.',
        );
      }
      assertMoneyEqual_(
        selection.order + ' ' + monthKey + ' staged spend',
        roundMoney_(observed.totalSpend),
        roundMoney_(expected.totalSpend),
      );
    });
  });
}

function readPriceAnchors_(report) {
  try {
    const book = SpreadsheetApp.openById(UPDATE_CONFIG_.priceAnchorId);
    return priceAnchorsFromSourceSheet_(requireSheet_(book, UPDATE_CONFIG_.priceAnchorTab));
  } catch (error) {
    const cached = readCachedPriceAnchors_(report);
    if (cached.size === 0) throw error;
    report.toast(
      'Price Anchor is not accessible. Reusing the report\'s last verified price comparisons.',
      '2026 Report',
      10,
    );
    return cached;
  }
}

function priceAnchorsFromSourceSheet_(sheet) {
  const rowCount = Math.max(0, sheet.getLastRow() - 1);
  const matches = new Map();
  if (rowCount === 0) return matches;
  const rows = sheet.getRange(2, 1, rowCount, 8).getDisplayValues();
  rows.forEach((row, index) => {
    const domain = normalizeDomain_(row[0]);
    if (!domain || matches.has(domain)) return;
    const normal = parseMoney_(row[6]);
    const grey = parseMoney_(row[7]);
    matches.set(domain, {
      portal: row[0],
      country: row[1],
      language: row[2],
      niche: row[3],
      acceptsGrey: row[4],
      alsoAccepting: row[5],
      normal,
      grey,
      row: index + 2,
    });
  });
  return matches;
}

function readCachedPriceAnchors_(report) {
  const sheet = requireSheet_(report, 'Site Price Comparison');
  const rowCount = Math.max(0, sheet.getLastRow() - 1);
  const matches = new Map();
  if (rowCount === 0) return matches;
  const rows = sheet.getRange(2, 1, rowCount, UPDATE_CONFIG_.comparisonHeaders.length).getDisplayValues();
  rows.forEach((row) => {
    if (String(row[12] || '').trim() !== 'Matched') return;
    const domain = normalizeDomain_(row[3]);
    if (!domain || matches.has(domain)) return;
    matches.set(domain, {
      portal: row[7] || row[3],
      normal: parseMoney_(row[8]),
      grey: parseMoney_(row[9]),
      row: row[13],
      country: row[14],
      language: row[15],
      niche: row[16],
      acceptsGrey: row[17],
      alsoAccepting: row[18],
    });
  });
  return matches;
}

function attachPriceComparisons_(records, priceAnchors) {
  records.forEach((record) => {
    const match = priceAnchors.get(normalizeDomain_(record.website));
    if (!match) {
      record.comparison = {
        portal: '', normal: null, grey: null, pressWhizz: null, saving: null,
        status: 'Not found', row: '', country: '', language: '', niche: '',
        acceptsGrey: '', alsoAccepting: '',
      };
      return;
    }
    const base = match.grey !== null ? match.grey : match.normal;
    const pressWhizz = base === null ? null : roundMoney_(base * 1.5);
    const saving = pressWhizz === null ? null : roundMoney_(pressWhizz - record.priceEur);
    record.pressWhizzPrice = pressWhizz;
    record.saving = saving;
    record.comparison = {
      portal: match.portal,
      normal: match.normal,
      grey: match.grey,
      pressWhizz,
      saving,
      status: 'Matched',
      row: match.row,
      country: match.country,
      language: match.language,
      niche: match.niche,
      acceptsGrey: match.acceptsGrey,
      alsoAccepting: match.alsoAccepting,
    };
  });
}

function buildModel_(records, selections, throughDate) {
  const months = reportMonths_(throughDate);
  const monthSpend = emptyMonthMap_(months);
  const monthSaving = emptyMonthMap_(months);
  const orderMap = new Map();
  selections.forEach((selection) => orderMap.set(selection.key, {
    key: selection.key,
    order: selection.order,
    records: [],
    monthSpend: emptyMonthMap_(months),
    monthSaving: emptyMonthMap_(months),
    totalSpend: 0,
    totalSaving: 0,
  }));
  let totalSpend = 0;
  let totalSaving = 0;
  records.forEach((record) => {
    const order = orderMap.get(record.orderKey);
    if (!order) throw new Error('Unexpected order escaped the existing-order allowlist: ' + record.order);
    order.records.push(record);
    order.monthSpend[record.monthKey] = addMoney_(order.monthSpend[record.monthKey], record.priceEur);
    monthSpend[record.monthKey] = addMoney_(monthSpend[record.monthKey], record.priceEur);
    order.totalSpend = addMoney_(order.totalSpend, record.priceEur);
    totalSpend = addMoney_(totalSpend, record.priceEur);
    if (record.saving !== null) {
      order.monthSaving[record.monthKey] = addMoney_(order.monthSaving[record.monthKey], record.saving);
      monthSaving[record.monthKey] = addMoney_(monthSaving[record.monthKey], record.saving);
      order.totalSaving = addMoney_(order.totalSaving, record.saving);
      totalSaving = addMoney_(totalSaving, record.saving);
    }
  });
  const orders = [...orderMap.values()].sort((a, b) =>
    b.totalSpend - a.totalSpend || a.order.localeCompare(b.order),
  );
  return {
    throughDate,
    months,
    records,
    orders,
    monthSpend,
    monthSaving,
    totalSpend: roundMoney_(totalSpend),
    totalSaving: roundMoney_(totalSaving),
  };
}

function validateModel_(model, selections, existingOrderTabs) {
  if (model.orders.length !== existingOrderTabs.size || selections.length !== existingOrderTabs.size) {
    throw new Error('Order allowlist mismatch. No report write was started.');
  }
  const existingKeys = new Set(existingOrderTabs.keys());
  model.records.forEach((record) => {
    if (!existingKeys.has(record.orderKey)) throw new Error('A new order was detected: ' + record.order);
    if (record.invoiceDate.getFullYear() !== UPDATE_CONFIG_.reportYear) {
      throw new Error('A non-2026 record was detected: ' + record.order + ' ' + record.sourceTab + ' row ' + record.sourceRow);
    }
    if (!/^2026-(0[1-9]|1[0-2])$/.test(record.monthKey) || record.monthKey > monthKey_(model.throughDate)) {
      throw new Error('An invalid reporting month was detected: ' + record.order + ' ' + record.sourceTab + ' row ' + record.sourceRow);
    }
  });
  const spendByMonth = roundMoney_(Object.values(model.monthSpend).reduce(addMoney_, 0));
  const spendByOrder = roundMoney_(model.orders.reduce((sum, order) => addMoney_(sum, order.totalSpend), 0));
  const savingByMonth = roundMoney_(Object.values(model.monthSaving).reduce(addMoney_, 0));
  const savingByOrder = roundMoney_(model.orders.reduce((sum, order) => addMoney_(sum, order.totalSaving), 0));
  assertMoneyEqual_('Monthly spend', spendByMonth, model.totalSpend);
  assertMoneyEqual_('Order spend', spendByOrder, model.totalSpend);
  assertMoneyEqual_('Monthly saving', savingByMonth, model.totalSaving);
  assertMoneyEqual_('Order saving', savingByOrder, model.totalSaving);
}

function writeReport_(report, model, orderTabs) {
  writeCleanData_(requireSheet_(report, 'Clean Data'), model.records);
  writeComparison_(requireSheet_(report, 'Site Price Comparison'), model.records);
  writeMonthly_(requireSheet_(report, 'Monthly Spending'), model);
  writeOrderSummary_(requireSheet_(report, 'Order Summary'), model, orderTabs);
  model.orders.forEach((order) => writeOrderTab_(orderTabs.get(order.key).sheet, order, model));
  writeDashboard_(requireSheet_(report, 'Dashboard'), model);
  writeDataIssues_(requireSheet_(report, 'Data Issues'));
}

function writeCleanData_(sheet, records) {
  ensureSheetSize_(sheet, records.length + 1, UPDATE_CONFIG_.cleanHeaders.length);
  removeFilter_(sheet);
  clearBody_(sheet, 2, UPDATE_CONFIG_.cleanHeaders.length);
  sheet.getRange(1, 1, 1, UPDATE_CONFIG_.cleanHeaders.length).setValues([UPDATE_CONFIG_.cleanHeaders]);
  if (records.length > 0) {
    const rows = records.map(cleanDataRow_);
    sheet.getRange(2, 2, rows.length, 1).setNumberFormat('@');
    sheet.getRange(2, 5, rows.length, 1).setNumberFormat('@');
    sheet.getRange(2, 1, rows.length, UPDATE_CONFIG_.cleanHeaders.length).setValues(rows);
    sheet.getRange(2, 4, rows.length, 1).setNumberFormat('dd/MM/yyyy');
    sheet.getRange(2, 11, rows.length, 1).setNumberFormat('€#,##0.00');
    sheet.getRange(2, 12, rows.length, 1).setNumberFormat('dd/MM/yyyy');
    sheet.getRange(2, 13, rows.length, 1).setNumberFormat('0.000000');
    sheet.getRange(2, 22, rows.length, 1).setNumberFormat('mmm yyyy');
    sheet.getRange(2, 25, rows.length, 2).setNumberFormat('€#,##0.00');
    sheet.getRange(1, 1, rows.length + 1, UPDATE_CONFIG_.cleanHeaders.length).createFilter();
    refreshBanding_(sheet, 2, rows.length, UPDATE_CONFIG_.cleanHeaders.length);
    const issueColumn = columnLetter_(24);
    sheet.setConditionalFormatRules([
      SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied('=REGEXMATCH($' + issueColumn + '2,"Invoice Date")')
        .setBackground(UPDATE_CONFIG_.colors.paleRed)
        .setRanges([sheet.getRange(2, 4, rows.length, 1)])
        .build(),
    ]);
  }
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(1);
}

function writeComparison_(sheet, records) {
  const sorted = [...records].sort((a, b) =>
    numberForSort_(b.saving) - numberForSort_(a.saving) ||
    a.order.localeCompare(b.order) || a.sourceRow - b.sourceRow,
  );
  ensureSheetSize_(sheet, sorted.length + 1, UPDATE_CONFIG_.comparisonHeaders.length);
  removeFilter_(sheet);
  clearBody_(sheet, 2, UPDATE_CONFIG_.comparisonHeaders.length);
  sheet.getRange(1, 1, 1, UPDATE_CONFIG_.comparisonHeaders.length).setValues([UPDATE_CONFIG_.comparisonHeaders]);
  if (sorted.length > 0) {
    const rows = sorted.map(comparisonRow_);
    sheet.getRange(2, 1, rows.length, UPDATE_CONFIG_.comparisonHeaders.length).setValues(rows);
    sheet.getRange(2, 6, rows.length, 1).setNumberFormat('€#,##0.00');
    sheet.getRange(2, 9, rows.length, 4).setNumberFormat('€#,##0.00');
    sheet.getRange(1, 1, rows.length + 1, UPDATE_CONFIG_.comparisonHeaders.length).createFilter();
    refreshBanding_(sheet, 2, rows.length, UPDATE_CONFIG_.comparisonHeaders.length);
    sheet.setConditionalFormatRules([
      SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied('=$M2="Not found"')
        .setBackground(UPDATE_CONFIG_.colors.paleRed)
        .setRanges([sheet.getRange(2, 1, rows.length, UPDATE_CONFIG_.comparisonHeaders.length)])
        .build(),
    ]);
  }
  sheet.setFrozenRows(1);
}

function writeMonthly_(sheet, model) {
  const rows = [['Month', 'Spend (EUR)', 'Saving (EUR)']]
    .concat(model.months.map((month) => [month.date, model.monthSpend[month.key], model.monthSaving[month.key]]))
    .concat([['Total', model.totalSpend, model.totalSaving]]);
  ensureSheetSize_(sheet, rows.length, 3);
  clearBody_(sheet, 1, 3);
  sheet.getRange(1, 1, rows.length, 3).setValues(rows);
  styleHeader_(sheet.getRange(1, 1, 1, 3));
  styleTotal_(sheet.getRange(rows.length, 1, 1, 3));
  sheet.getRange(2, 1, model.months.length, 1).setNumberFormat('mmm yyyy');
  sheet.getRange(2, 2, rows.length - 1, 2).setNumberFormat('€#,##0.00');
  sheet.setFrozenRows(1);
  sheet.getCharts().forEach((chart) => sheet.removeChart(chart));
  sheet.insertChart(sheet.newChart()
    .setChartType(Charts.ChartType.COLUMN)
    .addRange(sheet.getRange(1, 1, model.months.length + 1, 3))
    .setPosition(2, 5, 0, 0)
    .setOption('title', 'Monthly Spend and Saving (EUR)')
    .setOption('colors', [UPDATE_CONFIG_.colors.teal, UPDATE_CONFIG_.colors.blue])
    .setOption('height', 360)
    .setOption('width', 700)
    .build());
}

function writeOrderSummary_(sheet, model, orderTabs) {
  const monthHeaders = model.months.map((month) => month.header + ' Spend (EUR)');
  const headers = ['Order'].concat(monthHeaders, [
    'Total Spend through ' + formatLongDate_(model.throughDate),
    'Link to Order tab',
    'Total Saving (EUR)',
  ]);
  const rows = model.orders.map((order) => [
    literal_(order.order),
    ...model.months.map((month) => order.monthSpend[month.key]),
    order.totalSpend,
    '=HYPERLINK("#gid=' + orderTabs.get(order.key).sheet.getSheetId() + '","Open")',
    order.totalSaving,
  ]);
  const total = ['Total']
    .concat(model.months.map((month) => model.monthSpend[month.key]))
    .concat([model.totalSpend, '', model.totalSaving]);
  ensureSheetSize_(sheet, rows.length + 2, headers.length);
  removeFilter_(sheet);
  clearBody_(sheet, 1, Math.max(sheet.getLastColumn(), headers.length));
  sheet.getRange(1, 1, rows.length + 2, headers.length).setValues([headers].concat(rows, [total]));
  styleHeader_(sheet.getRange(1, 1, 1, headers.length));
  styleTotal_(sheet.getRange(rows.length + 2, 1, 1, headers.length));
  sheet.getRange(2, 2, rows.length + 1, model.months.length + 1).setNumberFormat('€#,##0.00');
  sheet.getRange(2, headers.length, rows.length + 1, 1).setNumberFormat('€#,##0.00');
  sheet.getRange(1, 1, rows.length + 1, headers.length).createFilter();
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(1);
  if (rows.length > 0) {
    sheet.setConditionalFormatRules([
      SpreadsheetApp.newConditionalFormatRule()
        .setGradientMinpoint('#ffffff')
        .setGradientMidpointWithValue('#e5f5f3', SpreadsheetApp.InterpolationType.PERCENTILE, '50')
        .setGradientMaxpoint(UPDATE_CONFIG_.colors.teal)
        .setRanges([sheet.getRange(2, 2, rows.length, model.months.length)])
        .build(),
    ]);
  }
}

function writeOrderTab_(sheet, order, model) {
  const detailStart = 18;
  const rows = order.records.map(cleanDataRow_);
  ensureSheetSize_(sheet, detailStart + Math.max(1, rows.length), UPDATE_CONFIG_.cleanHeaders.length);
  removeFilter_(sheet);
  if (sheet.getMaxRows() > detailStart) {
    sheet.getRange(detailStart + 1, 1, sheet.getMaxRows() - detailStart, UPDATE_CONFIG_.cleanHeaders.length).clearContent();
  }
  sheet.getRange('A3:B4').setValues([
    ['Total Spend (EUR) through ' + formatLongDate_(model.throughDate), order.totalSpend],
    ['Total Saving (EUR)', order.totalSaving],
  ]);
  sheet.getRange('B3:B4').setNumberFormat('€#,##0.00');
  const monthly = [['Month', 'Spend (EUR)', 'Saving (EUR)']]
    .concat(model.months.map((month) => [month.date, order.monthSpend[month.key], order.monthSaving[month.key]]))
    .concat([['Total', order.totalSpend, order.totalSaving]]);
  sheet.getRange(7, 1, Math.max(sheet.getLastRow() - 6, monthly.length), 3).clearContent();
  sheet.getRange(7, 1, monthly.length, 3).setValues(monthly);
  styleHeader_(sheet.getRange(7, 1, 1, 3));
  styleTotal_(sheet.getRange(7 + monthly.length - 1, 1, 1, 3));
  sheet.getRange(8, 1, model.months.length, 1).setNumberFormat('mmm yyyy');
  sheet.getRange(8, 2, monthly.length - 1, 2).setNumberFormat('€#,##0.00');
  sheet.getRange(detailStart, 1, 1, UPDATE_CONFIG_.cleanHeaders.length).setValues([UPDATE_CONFIG_.cleanHeaders]);
  styleHeader_(sheet.getRange(detailStart, 1, 1, UPDATE_CONFIG_.cleanHeaders.length));
  if (rows.length > 0) {
    sheet.getRange(detailStart + 1, 1, rows.length, UPDATE_CONFIG_.cleanHeaders.length).setValues(rows);
    sheet.getRange(detailStart + 1, 4, rows.length, 1).setNumberFormat('dd/MM/yyyy');
    sheet.getRange(detailStart + 1, 11, rows.length, 1).setNumberFormat('€#,##0.00');
    sheet.getRange(detailStart + 1, 12, rows.length, 1).setNumberFormat('dd/MM/yyyy');
    sheet.getRange(detailStart + 1, 13, rows.length, 1).setNumberFormat('0.000000');
    sheet.getRange(detailStart + 1, 22, rows.length, 1).setNumberFormat('mmm yyyy');
    sheet.getRange(detailStart + 1, 25, rows.length, 2).setNumberFormat('€#,##0.00');
    sheet.getRange(detailStart, 1, rows.length + 1, UPDATE_CONFIG_.cleanHeaders.length).createFilter();
    refreshBanding_(sheet, detailStart + 1, rows.length, UPDATE_CONFIG_.cleanHeaders.length);
  }
  sheet.setFrozenRows(detailStart);
  sheet.getCharts().forEach((chart) => sheet.removeChart(chart));
  sheet.insertChart(sheet.newChart()
    .setChartType(Charts.ChartType.COLUMN)
    .addRange(sheet.getRange(7, 1, model.months.length + 1, 3))
    .setNumHeaders(1)
    .setPosition(3, 4, 0, 0)
    .setOption('title', order.order + ' Monthly Spend and Saving (EUR)')
    .setOption('colors', [UPDATE_CONFIG_.colors.blue, UPDATE_CONFIG_.colors.teal])
    .setOption('height', 300)
    .setOption('width', 680)
    .build());
}

function writeDashboard_(sheet, model) {
  const period = '1 January 2026 - ' + formatLongDate_(model.throughDate);
  sheet.getRange('A3:B8').setValues([
    ['Reporting period', period],
    ['Overall Spend (EUR)', model.totalSpend],
    ['Orders', model.orders.length],
    ['Cleaned records', model.records.length],
    ['Refresh timestamp', new Date()],
    ['Overall Saving (EUR)', model.totalSaving],
  ]);
  sheet.getRange('B4').setNumberFormat('€#,##0.00');
  sheet.getRange('B7').setNumberFormat('dd-mmm-yyyy hh:mm');
  sheet.getRange('B8').setNumberFormat('€#,##0.00');

  sheet.getRange(10, 1, Math.max(sheet.getMaxRows() - 9, 1), 18).clearContent();
  const monthly = [['Month', 'Spend (EUR)', 'Saving (EUR)']]
    .concat(model.months.map((month) => [month.date, model.monthSpend[month.key], model.monthSaving[month.key]]));
  sheet.getRange(10, 1, monthly.length, 3).setValues(monthly);
  styleHeader_(sheet.getRange(10, 1, 1, 3));
  sheet.getRange(11, 1, model.months.length, 1).setNumberFormat('mmm yyyy');
  sheet.getRange(11, 2, model.months.length, 2).setNumberFormat('€#,##0.00');

  const orderRows = [['Order', 'Spend (EUR)', 'Saving (EUR)']]
    .concat(model.orders.map((order) => [literal_(order.order), order.totalSpend, order.totalSaving]));
  sheet.getRange(10, 4, orderRows.length, 3).setValues(orderRows);
  styleHeader_(sheet.getRange(10, 4, 1, 3));
  sheet.getRange(11, 5, model.orders.length, 2).setNumberFormat('€#,##0.00');

  const topOrders = model.orders.slice(0, 10);
  const matrix = [['Month'].concat(topOrders.map((order) => literal_(order.order)))]
    .concat(model.months.map((month) => [
      month.date,
      ...topOrders.map((order) => order.monthSpend[month.key]),
    ]));
  sheet.getRange(10, 8, matrix.length, matrix[0].length).setValues(matrix);
  styleHeader_(sheet.getRange(10, 8, 1, matrix[0].length));
  sheet.getRange(11, 8, model.months.length, 1).setNumberFormat('mmm yyyy');
  if (topOrders.length > 0) sheet.getRange(11, 9, model.months.length, topOrders.length).setNumberFormat('€#,##0.00');

  sheet.getCharts().forEach((chart) => sheet.removeChart(chart));
  sheet.insertChart(sheet.newChart()
    .setChartType(Charts.ChartType.COLUMN)
    .addRange(sheet.getRange(10, 1, monthly.length, 3))
    .setPosition(2, 6, 0, 0)
    .setOption('title', 'Monthly Spend and Saving (EUR)')
    .setOption('colors', [UPDATE_CONFIG_.colors.teal, UPDATE_CONFIG_.colors.blue])
    .setOption('height', 280)
    .setOption('width', 560)
    .build());
  sheet.insertChart(sheet.newChart()
    .setChartType(Charts.ChartType.BAR)
    .addRange(sheet.getRange(10, 4, orderRows.length, 3))
    .setPosition(20, 1, 0, 0)
    .setOption('title', 'Spend and Saving (EUR) by Order')
    .setOption('colors', [UPDATE_CONFIG_.colors.blue, UPDATE_CONFIG_.colors.teal])
    .setOption('height', Math.max(420, model.orders.length * 18))
    .setOption('width', 760)
    .build());
  if (topOrders.length > 0) {
    sheet.insertChart(sheet.newChart()
      .setChartType(Charts.ChartType.COLUMN)
      .addRange(sheet.getRange(10, 8, matrix.length, matrix[0].length))
      .setNumHeaders(1)
      .setPosition(20, 9, 0, 0)
      .setOption('title', 'Monthly Spend by Top Orders')
      .setOption('isStacked', true)
      .setOption('legend', { position: 'bottom', textStyle: { fontSize: 10 } })
      .setOption('height', 500)
      .setOption('width', 900)
      .build());
  }
}

function writeDataIssues_(sheet) {
  const headers = [
    'Source Sheet', 'Source Data Row', 'Order', 'Source Tab', 'Source Row',
    'Invoice Date', 'Price (EUR)', 'Issue Description',
  ];
  clearBody_(sheet, 1, headers.length);
  sheet.getRange(1, 1, 2, headers.length).setValues([
    headers,
    ['', '', '', '', '', '', '', 'No blocking data issues found during the latest refresh.'],
  ]);
  styleHeader_(sheet.getRange(1, 1, 1, headers.length));
  sheet.setFrozenRows(1);
}

function verifyWrittenReport_(report, model, orderTabs) {
  const dashboard = requireSheet_(report, 'Dashboard');
  const clean = requireSheet_(report, 'Clean Data');
  const monthly = requireSheet_(report, 'Monthly Spending');
  const summary = requireSheet_(report, 'Order Summary');
  if (Number(dashboard.getRange('B5').getValue()) !== orderTabs.size) {
    throw new Error('Written dashboard order count does not match the existing report order tabs.');
  }
  if (Number(dashboard.getRange('B6').getValue()) !== model.records.length) {
    throw new Error('Written dashboard record count does not match the refreshed model.');
  }
  if (clean.getLastRow() - 1 !== model.records.length) {
    throw new Error('Written Clean Data row count does not match the refreshed model.');
  }
  const cleanYears = clean.getLastRow() < 2
    ? []
    : clean.getRange(2, 4, clean.getLastRow() - 1, 1).getValues().flat().map((value) => value instanceof Date ? value.getFullYear() : null);
  if (cleanYears.some((year) => year !== UPDATE_CONFIG_.reportYear)) {
    throw new Error('A non-2026 date was written to Clean Data.');
  }
  const monthlyTotalRow = model.months.length + 2;
  assertMoneyEqual_('Written monthly spend', Number(monthly.getRange(monthlyTotalRow, 2).getValue()), model.totalSpend);
  assertMoneyEqual_('Written monthly saving', Number(monthly.getRange(monthlyTotalRow, 3).getValue()), model.totalSaving);
  const summaryTotalRow = model.orders.length + 2;
  const summarySpendColumn = model.months.length + 2;
  const summarySavingColumn = model.months.length + 4;
  assertMoneyEqual_('Written order-summary spend', Number(summary.getRange(summaryTotalRow, summarySpendColumn).getValue()), model.totalSpend);
  assertMoneyEqual_('Written order-summary saving', Number(summary.getRange(summaryTotalRow, summarySavingColumn).getValue()), model.totalSaving);
}

function cleanDataRow_(record) {
  return [
    literal_(record.order), literal_(record.sourceTab), String(record.sourceRow), record.invoiceDate,
    record.monthKey, literal_(record.linkBuilder), literal_(record.website), literal_(record.niche),
    record.dr, record.traffic, record.priceEur, record.ecbRateDate || '', record.ecbRate === null ? '' : record.ecbRate,
    literal_(record.country), literal_(record.targetUrl), literal_(record.anchor), literal_(record.contentUrl),
    literal_(record.liveUrl), literal_(record.invoice), literal_(record.invoiceStatus), literal_(record.linkCode),
    monthDate_(record.monthKey), true, '',
    record.pressWhizzPrice === null ? '' : record.pressWhizzPrice,
    record.saving === null ? '' : record.saving,
  ];
}

function comparisonRow_(record) {
  const match = record.comparison;
  return [
    literal_(record.order), literal_(record.sourceTab), String(record.sourceRow), literal_(record.website),
    literal_(record.anchor), record.priceEur, literal_(record.liveUrl), literal_(match.portal),
    match.normal === null ? '' : match.normal, match.grey === null ? '' : match.grey,
    match.pressWhizz === null ? '' : match.pressWhizz, match.saving === null ? '' : match.saving,
    match.status, match.row, literal_(match.country), literal_(match.language), literal_(match.niche),
    literal_(match.acceptsGrey), literal_(match.alsoAccepting),
  ];
}

function priceToEur_(displayValue, rawValue, invoiceDate, old) {
  const display = String(displayValue || '').trim();
  const nativeAmount = numberOrNull_(rawValue) !== null ? numberOrNull_(rawValue) : parseMoney_(display);
  if (nativeAmount === null) return { amount: null, rateDate: '', rate: null };
  const currency = detectCurrency_(display);
  if (currency === 'EUR') return { amount: roundMoney_(nativeAmount), rateDate: invoiceDate, rate: 1 };
  if (old && old.priceEur !== null && old.rate !== null && old.rateDate) {
    return { amount: old.priceEur, rateDate: old.rateDate, rate: old.rate };
  }
  const rate = ecbRate_(currency, invoiceDate);
  return {
    amount: roundMoney_(nativeAmount / rate.rate),
    rateDate: rate.date,
    rate: rate.rate,
  };
}

function ecbRate_(currency, invoiceDate) {
  const properties = PropertiesService.getScriptProperties();
  const key = 'FX_' + currency + '_' + isoDate_(invoiceDate);
  const cached = properties.getProperty(key);
  if (cached) {
    const parsed = JSON.parse(cached);
    return { date: parseIsoDate_(parsed.date), rate: Number(parsed.rate) };
  }
  const url = 'https://api.frankfurter.app/' + isoDate_(invoiceDate) + '?from=EUR&to=' + encodeURIComponent(currency);
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) {
    throw new Error('Could not fetch the EUR/' + currency + ' rate for ' + isoDate_(invoiceDate) + '.');
  }
  const payload = JSON.parse(response.getContentText());
  const rate = Number(payload.rates && payload.rates[currency]);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('Invalid EUR/' + currency + ' rate response.');
  const result = { date: parseIsoDate_(payload.date), rate };
  properties.setProperty(key, JSON.stringify({ date: payload.date, rate }));
  return result;
}

function parseDateCell_(displayValue, rawValue, existingDate, sourceTab) {
  const text = String(displayValue || '').trim();
  if (text === '') return null;
  if (/^(january|february|march|april|may|june|july|august|september|october|november|december)$/i.test(text)) return null;
  if (rawValue instanceof Date && !Number.isNaN(rawValue.getTime())) {
    const rawDate = dateOnly_(rawValue);
    const hintedMonth = monthHint_(sourceTab);
    const rawMonth = rawDate.getMonth() + 1;
    if (hintedMonth && rawMonth !== hintedMonth && rawDate.getDate() === hintedMonth) {
      const swapped = validDate_(rawDate.getFullYear(), hintedMonth, rawMonth);
      if (swapped) return swapped;
    }
    return rawDate;
  }

  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
  if (match) return validDate_(Number(match[1]), Number(match[2]), Number(match[3]));

  match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(text);
  if (match) {
    const first = Number(match[1]);
    const second = Number(match[2]);
    let year = Number(match[3]);
    if (year < 100) year += 2000;
    if (first > 12) return validDate_(year, second, first);
    if (second > 12) return validDate_(year, first, second);
    if (existingDate && existingDate.getFullYear() === year) return dateOnly_(existingDate);
    const hinted = monthHint_(sourceTab);
    if (hinted === first) return validDate_(year, first, second);
    if (hinted === second) return validDate_(year, second, first);
    return validDate_(year, second, first);
  }

  match = /^(\d{1,2})[-\s]([A-Za-z]{3,9})[-,\s]+(\d{4})$/.exec(text);
  if (match) {
    const month = monthNameNumber_(match[2]);
    return month === null ? null : validDate_(Number(match[3]), month, Number(match[1]));
  }
  match = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/.exec(text);
  if (match) {
    const month = monthNameNumber_(match[1]);
    return month === null ? null : validDate_(Number(match[3]), month, Number(match[2]));
  }
  return null;
}

function findStandardHeaderOffset_(rows) {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index].map((value) => String(value || '').trim().toLowerCase());
    if (
      row[1] === 'lb' && row[2] === 'website' && row[6] === 'price' && row[11] === 'live url' &&
      row[12] === 'invoice date' && row[13] === 'invoice' && row[14] === 'invoice status'
    ) return index;
  }
  return -1;
}

function findHeaderValue_(index, values, display, names) {
  for (const name of names) {
    const column = index.get(name.toLowerCase());
    if (column !== undefined) return sourceValue_(values, display, column);
  }
  return '';
}

function headerIndex_(headers) {
  const result = new Map();
  headers.forEach((header, index) => result.set(String(header || '').trim().toLowerCase(), index));
  return result;
}

function isGeneratedSourceTab_(name) {
  return /^Audit Log$/i.test(name) || /^Monthly\s+-\s+\d{4}-\d{2}$/i.test(name) || /^_/.test(name);
}

function sourceValue_(values, display, index) {
  const value = values[index];
  if (value instanceof Date) return dateOnly_(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return literal_(String(display[index] || value || '').trim());
}

function numericOrText_(rawValue, displayValue) {
  const numeric = numberOrNull_(rawValue);
  return numeric === null ? literal_(String(displayValue || '').trim()) : numeric;
}

function normalizeOrder_(value) {
  return String(value || '')
    .trim()
    .replace(/^test\s+/i, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function isExcludedOrderKey_(value) {
  const key = normalizeOrder_(value);
  return UPDATE_CONFIG_.excludedOrders.some((order) => normalizeOrder_(order) === key);
}

function activeOrderTabs_(orderTabs) {
  return new Map([...orderTabs].filter(([key]) => !isExcludedOrderKey_(key)));
}

function hideExcludedOrderTabs_(orderTabs) {
  orderTabs.forEach(({ sheet }, key) => {
    if (isExcludedOrderKey_(key) && !sheet.isSheetHidden()) sheet.hideSheet();
  });
}

function normalizeDomain_(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^www\./, '')
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
}

function sourceKey_(order, sourceTab, sourceRow) {
  const orderKey = normalizeOrder_(order);
  const tab = String(sourceTab || '').trim().toLowerCase();
  const row = String(sourceRow || '').trim();
  return orderKey && tab && row ? orderKey + '\u0000' + tab + '\u0000' + row : '';
}

function reportThroughDate_() {
  const now = new Date();
  const start = new Date(UPDATE_CONFIG_.reportYear, 0, 1);
  const end = new Date(UPDATE_CONFIG_.reportYear, 11, 31);
  const today = dateOnly_(now);
  if (today.getTime() < start.getTime()) return start;
  if (today.getTime() > end.getTime()) return end;
  return today;
}

function reportMonths_(throughDate) {
  const months = [];
  for (let month = 0; month <= throughDate.getMonth(); month += 1) {
    const date = new Date(UPDATE_CONFIG_.reportYear, month, 1);
    const full = Utilities.formatDate(date, 'Africa/Cairo', 'MMMM yyyy');
    const header = month === throughDate.getMonth() && throughDate.getDate() < daysInMonth_(throughDate)
      ? Utilities.formatDate(date, 'Africa/Cairo', 'MMMM') + ' 1-' + throughDate.getDate() + ', ' + UPDATE_CONFIG_.reportYear
      : full;
    months.push({ key: monthKey_(date), date, header });
  }
  return months;
}

function emptyMonthMap_(months) {
  return Object.fromEntries(months.map((month) => [month.key, 0]));
}

function monthKey_(date) {
  return Utilities.formatDate(date, 'Africa/Cairo', 'yyyy-MM');
}

function explicitMonthKey_(sourceTab) {
  const text = String(sourceTab || '').trim().toLowerCase().replace(/[_.-]+/g, ' ').replace(/\s+/g, ' ');
  let match = /^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+2026)?$/.exec(text);
  if (match) {
    const month = monthNameNumber_(match[1]);
    return month === null ? null : '2026-' + String(month).padStart(2, '0');
  }
  match = /^2026\s+(0?[1-9]|1[0-2])$/.exec(text);
  return match ? '2026-' + String(Number(match[1])).padStart(2, '0') : null;
}

function reportingMonthKey_(rawValue, displayValue, invoiceDate) {
  if (rawValue instanceof Date && !Number.isNaN(rawValue.getTime())) return monthKey_(rawValue);
  const text = String(displayValue || rawValue || '').trim();
  let match = /^(2026)-(0[1-9]|1[0-2])$/.exec(text);
  if (match) return match[1] + '-' + match[2];
  const explicit = explicitMonthKey_(text);
  return explicit || monthKey_(invoiceDate);
}

function monthDate_(monthKey) {
  const match = /^(2026)-(0[1-9]|1[0-2])$/.exec(String(monthKey || ''));
  if (!match) throw new Error('Invalid reporting month: ' + monthKey);
  return new Date(Number(match[1]), Number(match[2]) - 1, 1);
}

function orderMonthKey_(orderKey, monthKey) {
  return normalizeOrder_(orderKey) + '\u0000' + String(monthKey || '');
}

function authoritativeMonthKeys_(selections) {
  const keys = new Set();
  selections.forEach((selection) => {
    (selection.authoritativeMonths || []).forEach((monthKey) => {
      keys.add(orderMonthKey_(selection.key || selection.order, monthKey));
    });
  });
  return keys;
}

function monthHint_(sourceTab) {
  const text = String(sourceTab || '').toLowerCase();
  for (let month = 1; month <= 12; month += 1) {
    const longName = Utilities.formatDate(new Date(2026, month - 1, 1), 'Africa/Cairo', 'MMMM').toLowerCase();
    const shortName = longName.slice(0, 3);
    if (text.includes(longName) || new RegExp('\\b' + shortName + '\\b').test(text)) return month;
  }
  return null;
}

function monthNameNumber_(name) {
  const normalized = String(name || '').toLowerCase().slice(0, 3);
  const names = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const index = names.indexOf(normalized);
  return index < 0 ? null : index + 1;
}

function validDate_(year, month, day) {
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

function parseIsoDate_(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  return match ? validDate_(Number(match[1]), Number(match[2]), Number(match[3])) : null;
}

function dateOnly_(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function isoDate_(date) {
  return Utilities.formatDate(date, 'Africa/Cairo', 'yyyy-MM-dd');
}

function formatLongDate_(date) {
  return Utilities.formatDate(date, 'Africa/Cairo', 'd MMMM yyyy');
}

function daysInMonth_(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

function detectCurrency_(value) {
  const text = String(value || '').toUpperCase();
  const code = /\b([A-Z]{3})\b/.exec(text);
  if (code && code[1] !== 'EUR') return code[1];
  if (text.includes('USD') || text.includes('$')) return 'USD';
  if (text.includes('GBP') || text.includes('£')) return 'GBP';
  if (text.includes('JPY') || text.includes('¥')) return 'JPY';
  return 'EUR';
}

function parseMoney_(value) {
  const text = String(value === null || value === undefined ? '' : value).trim();
  if (!text) return null;
  const negative = /^\(.*\)$/.test(text) || /^-/.test(text);
  const cleaned = text.replace(/[^0-9.,-]/g, '');
  if (!cleaned) return null;
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized;
  if (lastComma > lastDot) {
    const decimals = cleaned.length - lastComma - 1;
    normalized = decimals === 2
      ? cleaned.replace(/\./g, '').replace(',', '.')
      : cleaned.replace(/,/g, '');
  } else {
    normalized = cleaned.replace(/,/g, '');
  }
  const number = Number.parseFloat(normalized.replace(/[()]/g, ''));
  if (!Number.isFinite(number)) return null;
  return negative ? -Math.abs(number) : number;
}

function numberOrNull_(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return parseMoney_(value);
}

function numberForSort_(value) {
  return value === null || !Number.isFinite(value) ? -Number.MAX_VALUE : value;
}

function addMoney_(a, b) {
  return roundMoney_(Number(a || 0) + Number(b || 0));
}

function roundMoney_(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function assertMoneyEqual_(label, actual, expected) {
  if (Math.abs(roundMoney_(actual) - roundMoney_(expected)) > 0.005) {
    throw new Error(label + ' mismatch: ' + actual + ' != ' + expected);
  }
}

function literal_(value) {
  return typeof value === 'string' && value.startsWith('=') ? "'" + value : value;
}

function requireSheet_(book, name) {
  const sheet = book.getSheetByName(name);
  if (!sheet) throw new Error('Missing required sheet: ' + name);
  return sheet;
}

function ensureSheetSize_(sheet, rows, columns) {
  if (sheet.getMaxRows() < rows) sheet.insertRowsAfter(sheet.getMaxRows(), rows - sheet.getMaxRows());
  if (sheet.getMaxColumns() < columns) sheet.insertColumnsAfter(sheet.getMaxColumns(), columns - sheet.getMaxColumns());
}

function clearBody_(sheet, startRow, columns) {
  const rowCount = sheet.getMaxRows() - startRow + 1;
  if (rowCount > 0) sheet.getRange(startRow, 1, rowCount, columns).clearContent();
}

function removeFilter_(sheet) {
  const filter = sheet.getFilter();
  if (filter) filter.remove();
}

function refreshBanding_(sheet, startRow, rowCount, columnCount) {
  sheet.getBandings().forEach((banding) => banding.remove());
  if (rowCount > 0) {
    sheet.getRange(startRow, 1, rowCount, columnCount)
      .applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, false, false);
  }
}

function styleHeader_(range) {
  range.setBackground(UPDATE_CONFIG_.colors.ink)
    .setFontColor(UPDATE_CONFIG_.colors.white)
    .setFontWeight('bold')
    .setVerticalAlignment('middle')
    .setWrap(true);
}

function styleTotal_(range) {
  range.setBackground(UPDATE_CONFIG_.colors.paleTeal)
    .setFontColor(UPDATE_CONFIG_.colors.ink)
    .setFontWeight('bold');
}

function columnLetter_(column) {
  let value = column;
  let result = '';
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

// 500 × 100 navy button: circular refresh arrow + “UPDATE FROM ORDERS”.
const UPDATE_BUTTON_PNG_BASE64_ = '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';
