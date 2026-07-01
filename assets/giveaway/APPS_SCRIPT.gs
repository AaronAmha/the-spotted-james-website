/*******************************************************************************
 * THE SPOTTED JAMES — FORM CAPTURE  (Google Apps Script Web App backend)
 *
 * WHAT THIS DOES:
 *   Receives form submissions from the website and DUAL-WRITES each one:
 *   every submission appends ONE row to the unified master tab "Marketing (all)"
 *   AND ONE row to its own form-specific tab — both under a single lock and
 *   sharing a single server timestamp so the two rows correlate exactly.
 *
 *   THREE TABS (in this order; the first tab is the one that opens):
 *     1) "Marketing (all)" — unified master contact list. EVERY submission of
 *        every form type appends here.
 *          Columns: Timestamp | Type | Name | Phone | Email | Details | Source | Page
 *     2) "Name Night"       — BOTH Name Night forms (reminders AND suggestions).
 *          Columns: Timestamp | Kind | Name | Email | Opt-In | Message | Source | Page
 *     3) "Giveaway"         — giveaway entries.
 *          Columns: Timestamp | Name | Phone | Email | Source | Page
 *
 *   FORM TYPES the website sends (via a "formType" field):
 *     formType = "giveaway"    fields: name, phone, email
 *     formType = "reminder"    fields: name (first name), email, marketing_opt_in
 *     formType = "suggestion"  fields: suggested_name, email (opt), message (opt)
 *   If formType is ABSENT we DEFAULT to "giveaway" for back-compat with the
 *   original giveaway page, which sends no formType. A formType that is present
 *   but unknown (e.g. a typo) is REJECTED with an error rather than silently
 *   misfiled as a giveaway.
 *
 * -----------------------------------------------------------------------------
 * !!! YOU MUST REDEPLOY AFTER PASTING THIS !!!
 * -----------------------------------------------------------------------------
 *   Pasting new code does NOT go live on its own. After you Save this file:
 *      Deploy  >  Manage deployments  >  (pencil / edit icon on your web app)
 *      >  Version:  New version  >  Deploy.
 *   Using "New version" on the SAME deployment keeps the /exec URL identical, so
 *   you do NOT have to touch the website. (Avoid "New deployment" for edits —
 *   that mints a brand-new /exec URL you'd have to paste back into every page.)
 *
 *   The already-deployed exec URL stays the same:
 *   https://script.google.com/macros/s/AKfycbzYvBtiOikiBWXKettdis79KxJhCMA1edOZNbgSym8zm72qjg1moD-GQgVF3GNuA0kP/exec
 *
 * -----------------------------------------------------------------------------
 * !!! ONE-TIME MANUAL STEP: RENAME "Sheet1" -> "Giveaway" !!!
 * -----------------------------------------------------------------------------
 *   Your historical giveaway entries live in the default tab "Sheet1". Rename
 *   that tab (double-click its name at the bottom) to exactly "Giveaway". Its
 *   existing header row [Timestamp, Name, Phone, Email, Source, Page] already
 *   matches this script's Giveaway columns, so the header guard leaves it
 *   untouched and new entries keep appending below your old ones.
 *
 *   If you do NOT rename it, the script will CREATE a fresh empty "Giveaway"
 *   tab and write there instead — your old entries would then sit alone in the
 *   still-named "Sheet1" tab (nothing is lost, but they'd be split off from new
 *   ones). So renaming is strongly recommended before the first new submission.
 *
 * -----------------------------------------------------------------------------
 * NOTES:
 *   - Timestamps use this Apps Script project's timezone. To match the venue's
 *     time, set it in  Project Settings (gear)  >  Time zone  (America/Denver).
 *   - The website MUST send application/x-www-form-urlencoded (URLSearchParams,
 *     or a Blob of type application/x-www-form-urlencoded via sendBeacon, or a
 *     fetch with keepalive). Those are CORS "simple" requests with no preflight;
 *     Apps Script does not answer OPTIONS, so a JSON Content-Type POST from a
 *     browser would fail preflight and never reach this code. parseIncoming_
 *     handles both urlencoded fields and a raw JSON body regardless.
 *   - The client also sends a "ts" client-timestamp string; we IGNORE it and
 *     stamp authoritative server time with new Date() instead.
 *******************************************************************************/


/* The unified master tab: every submission appends one row here. */
var MARKETING_SHEET = 'Marketing (all)';

/* Fixed header row for the Marketing (all) master tab. */
var MARKETING_HEADERS = ['Timestamp', 'Type', 'Name', 'Phone', 'Email', 'Details', 'Source', 'Page'];

/* Header row shared by both Name Night forms (reminders + suggestions). */
var NAME_NIGHT_HEADERS = ['Timestamp', 'Kind', 'Name', 'Email', 'Opt-In', 'Message', 'Source', 'Page'];

/* Header row for the Giveaway tab (matches the pre-existing renamed Sheet1). */
var GIVEAWAY_HEADERS = ['Timestamp', 'Name', 'Phone', 'Email', 'Source', 'Page'];


/**
 * Per-form configuration. Each entry knows how to build BOTH rows for a
 * submission — its own form-specific tab row and the unified Marketing row —
 * from a single shared server timestamp `now`:
 *
 *   - ownSheet:        the form-specific tab to append to.
 *   - ownHeaders:      that tab's header row (written once, on first use).
 *   - ownRowFn(d,now): builds the own-tab row array, in ownHeaders column order.
 *   - marketingType:   the value written into the Marketing "Type" column.
 *   - marketingRowFn(d,now): builds the Marketing row, in MARKETING_HEADERS order.
 *
 * Both Name Night forms point ownSheet at the SAME "Name Night" tab and share
 * NAME_NIGHT_HEADERS; only their ownRowFn (and marketingType/marketingRowFn)
 * differ. To add another form type later, add one entry here — doPost is generic.
 */
var FORM_CONFIG = {

  // 1) GIVEAWAY. name + phone + email required.
  giveaway: {
    ownSheet: 'Giveaway',
    ownHeaders: GIVEAWAY_HEADERS,
    ownRowFn: function (d, now) {
      return [
        now,
        safeTrim_(d.name),
        safeTrim_(d.phone),
        safeTrim_(d.email),
        safeTrim_(d.source),
        safeTrim_(d.page)
      ];
    },
    marketingType: 'Giveaway',
    marketingRowFn: function (d, now) {
      // [now, "Giveaway", name, phone, email, "", source, page]
      return [
        now,
        'Giveaway',
        safeTrim_(d.name),
        safeTrim_(d.phone),
        safeTrim_(d.email),
        '',
        safeTrim_(d.source),
        safeTrim_(d.page)
      ];
    }
  },

  // 2) NAME NIGHT REMINDER. first name (name) + email required. No phone.
  //    Writes into the shared "Name Night" tab with Kind = "Reminder".
  reminder: {
    ownSheet: 'Name Night',
    ownHeaders: NAME_NIGHT_HEADERS,
    ownRowFn: function (d, now) {
      // [now, "Reminder", name, email, marketing_opt_in, "", source, page]
      return [
        now,
        'Reminder',
        safeTrim_(d.name),
        safeTrim_(d.email),
        safeTrim_(d.marketing_opt_in),
        '',
        safeTrim_(d.source),
        safeTrim_(d.page)
      ];
    },
    marketingType: 'Name Night Reminder',
    marketingRowFn: function (d, now) {
      // [now, "Name Night Reminder", name, "", email, "Opt-in: "+opt_in, source, page]
      return [
        now,
        'Name Night Reminder',
        safeTrim_(d.name),
        '',
        safeTrim_(d.email),
        'Opt-in: ' + safeTrim_(d.marketing_opt_in),
        safeTrim_(d.source),
        safeTrim_(d.page)
      ];
    }
  },

  // 3) NAME SUGGESTION. suggested_name required. email + message optional.
  //    Writes into the shared "Name Night" tab with Kind = "Suggestion".
  suggestion: {
    ownSheet: 'Name Night',
    ownHeaders: NAME_NIGHT_HEADERS,
    ownRowFn: function (d, now) {
      // [now, "Suggestion", suggested_name, email, "", message, source, page]
      return [
        now,
        'Suggestion',
        safeTrim_(d.suggested_name),
        safeTrim_(d.email),
        '',
        safeTrim_(d.message),
        safeTrim_(d.source),
        safeTrim_(d.page)
      ];
    },
    marketingType: 'Name Suggestion',
    marketingRowFn: function (d, now) {
      // [now, "Name Suggestion", suggested_name, "", email, message, source, page]
      return [
        now,
        'Name Suggestion',
        safeTrim_(d.suggested_name),
        '',
        safeTrim_(d.email),
        safeTrim_(d.message),
        safeTrim_(d.source),
        safeTrim_(d.page)
      ];
    }
  }
};

// If formType is ABSENT (empty), fall back to this so the existing giveaway
// page (which sends NO formType) still writes a correct row. A present-but-
// unknown formType is rejected in doPost rather than defaulted here.
var DEFAULT_FORM_TYPE = 'giveaway';


/**
 * Handles the form submission POST from the website.
 * Works with either form-urlencoded data (e.parameter) or a raw JSON body
 * (e.postData.contents), so it is robust to whatever the browser sends.
 *
 * DUAL-WRITE: routes by formType to build both the own-tab row and the
 * Marketing row from ONE shared server timestamp, then appends BOTH under a
 * single lock so the two rows are written atomically-ish and correlate.
 */
function doPost(e) {
  try {
    var data = parseIncoming_(e);

    // --- Honeypot: spam bots fill hidden fields. If "_gotcha" has anything
    //     in it, we pretend everything is fine but DO NOT write a row. This
    //     runs BEFORE routing and validation so bot noise never trips an error.
    if (data._gotcha && String(data._gotcha).trim() !== '') {
      return jsonOut_({ result: 'success' });
    }

    // --- Route by formType. ABSENT => default to "giveaway" so the existing
    //     giveaway page (no formType) keeps working unchanged. PRESENT-BUT-
    //     UNKNOWN (e.g. a typo) => reject, rather than silently misfiling a
    //     malformed reminder/suggestion into the giveaway tab. -----------------
    var formType = safeTrim_(data.formType).toLowerCase();
    if (formType === '') {
      formType = DEFAULT_FORM_TYPE;
    } else if (!FORM_CONFIG.hasOwnProperty(formType)) {
      return jsonOut_({ result: 'error', message: 'Unknown form type.' });
    }
    var config = FORM_CONFIG[formType];

    // --- Per-type validation. Return an error as JSON (never throw) so the
    //     browser always gets clean JSON back. --------------------------------
    var validationError = validate_(formType, data);
    if (validationError) {
      return jsonOut_({ result: 'error', message: validationError });
    }

    // --- ONE authoritative server timestamp, shared by BOTH rows so the
    //     own-tab entry and the Marketing entry for this submission match. We
    //     intentionally ignore the client-sent "ts" string. --------------------
    var now = new Date();
    var ownRow = config.ownRowFn(data, now);
    var marketingRow = config.marketingRowFn(data, now);

    // --- Lock so two people submitting at the exact same moment can't clobber
    //     each other's rows. Wait up to 30s. Both appends happen inside ONE
    //     lock so a submission's two rows are never interleaved with another's.
    //     (Acquired AFTER the cheap honeypot + validation rejects.) -----------
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      // Own form-specific tab.
      var ownSheet = getSheet_(config.ownSheet);
      ensureHeaders_(ownSheet, config.ownHeaders);
      ownSheet.appendRow(ownRow);

      // Unified master tab — EVERY submission also lands here.
      var marketingSheet = getSheet_(MARKETING_SHEET);
      ensureHeaders_(marketingSheet, MARKETING_HEADERS);
      marketingSheet.appendRow(marketingRow);
    } finally {
      lock.releaseLock();
    }

    return jsonOut_({ result: 'success' });

  } catch (err) {
    // Never throw back to the browser — always return clean JSON.
    return jsonOut_({ result: 'error', message: String(err) });
  }
}


/**
 * Simple health check. Opening the /exec URL in a browser hits this and
 * returns a small JSON blob so you can confirm the deployment is live.
 */
function doGet(e) {
  return jsonOut_({
    status: 'ok',
    app: 'The Spotted James — form capture',
    time: new Date().toISOString()
  });
}


/* ============================ helper functions ============================ */

/**
 * Returns an error message string if the submission is missing required fields
 * for its form type, or '' (falsy) if it's valid.
 *   giveaway   -> name, phone, email
 *   reminder   -> name (first name), email
 *   suggestion -> suggested_name
 */
function validate_(formType, d) {
  if (formType === 'reminder') {
    if (!safeTrim_(d.name) || !safeTrim_(d.email)) {
      return 'Please enter your first name and email.';
    }
    return '';
  }

  if (formType === 'suggestion') {
    if (!safeTrim_(d.suggested_name)) {
      return 'Please enter a name suggestion.';
    }
    return '';
  }

  // Default / giveaway: all three fields required (unchanged from before).
  if (!safeTrim_(d.name) || !safeTrim_(d.phone) || !safeTrim_(d.email)) {
    return 'Please fill in your name, phone number, and email.';
  }
  return '';
}

/**
 * Pulls the submitted fields out of the request no matter how the browser sent
 * them: form-urlencoded fields, a JSON body, or both.
 */
function parseIncoming_(e) {
  var out = {};

  // 1) Form-urlencoded fields land in e.parameter (the reliable, no-preflight
  //    "simple request" path used by the website). Copy them first.
  if (e && e.parameter) {
    for (var k in e.parameter) {
      out[k] = e.parameter[k];
    }
  }

  // 2) If a raw body was posted, try to read it. We sniff for JSON with
  //    looksLikeJson_ rather than trusting e.postData.type: a no-cors browser
  //    POST is forced to text/plain, so type won't say application/json even
  //    when the body IS json. If it parses as an object, merge those keys in.
  if (e && e.postData && e.postData.contents) {
    var raw = e.postData.contents;
    var type = (e.postData.type || '').toLowerCase();

    if (type.indexOf('application/json') !== -1 || looksLikeJson_(raw)) {
      try {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          for (var j in parsed) {
            out[j] = parsed[j];
          }
        }
      } catch (ignore) {
        // Not valid JSON after all — stick with e.parameter values.
      }
    }
  }

  return out;
}

/** Quick check so we only attempt JSON.parse on things that look like JSON. */
function looksLikeJson_(s) {
  if (!s) return false;
  var t = String(s).trim();
  return (t.charAt(0) === '{' || t.charAt(0) === '[');
}

/** Trim a value safely, treating null/undefined as an empty string. */
function safeTrim_(v) {
  return (v === null || v === undefined) ? '' : String(v).trim();
}

/**
 * STRICT get-or-create by tab name: return the tab if it exists, otherwise
 * create it. There is deliberately NO first-tab fallback anymore.
 *
 * Why no fallback: after this restructure the FIRST tab is "Marketing (all)".
 * The old script fell back to the first tab when a named tab was missing (to
 * avoid orphaning giveaway data). If we kept that, a missing "Giveaway" tab
 * would cause 6-column giveaway rows to be appended into the 8-column Marketing
 * master — corrupting its schema and column alignment. So every tab is now
 * resolved strictly by name; a missing one is created empty (its header is then
 * written by ensureHeaders_), never substituted with some other tab.
 */
function getSheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

/**
 * Writes the given header row once for a tab. Guards on the FULL header row
 * (not just A1) because several tabs share 'Timestamp' as column 1 — an
 * A1-only check would pass on a tab holding the wrong header set and silently
 * append rows under mismatched columns. Each tab keeps its OWN headers.
 *
 * Idempotent: if the tab already has an exactly-matching header row (e.g. the
 * pre-existing "Giveaway" tab the owner renamed from "Sheet1", whose header
 * already matches GIVEAWAY_HEADERS), it is left completely untouched — no
 * duplicate header is inserted and existing rows are not reordered.
 */
function ensureHeaders_(sheet, headers) {
  if (sheet.getLastRow() === 0) {
    // Empty tab (freshly created) — lay down the header via setValues.
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    return;
  }
  var existing = sheet.getRange(1, 1, 1, headers.length).getValues()[0]
    .map(function (v) { return String(v).trim(); });
  var ok = headers.every(function (h, i) { return existing[i] === h; });
  if (!ok) {
    // First row isn't our full header — insert one above so nothing is lost.
    sheet.insertRowBefore(1);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
}

/** Wraps an object as a JSON HTTP response. */
function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
