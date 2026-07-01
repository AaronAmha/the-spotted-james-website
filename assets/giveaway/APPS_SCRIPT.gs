/*******************************************************************************
 * THE SPOTTED JAMES — GIVEAWAY SIGN-UP  (Google Apps Script Web App backend)
 *
 * WHAT THIS DOES:
 *   When someone scans the QR code and submits the giveaway form on the
 *   website, this script writes their Name, Phone, and Email into your
 *   Google Sheet (one row per entry, with a timestamp).
 *
 * -----------------------------------------------------------------------------
 * ONE-TIME SETUP — follow these steps in order (no coding experience needed):
 * -----------------------------------------------------------------------------
 *   1. Go to https://sheets.google.com and create a NEW blank spreadsheet.
 *      Name it something like "Spotted James Giveaway Entries".
 *      Leave it completely empty — do NOT type anything in the cells (the
 *      script adds the column headers itself on the first entry).
 *
 *   2. In that spreadsheet's top menu, click:  Extensions  >  Apps Script.
 *      A new tab opens with a code editor and a file called "Code.gs".
 *
 *   3. Select ALL the existing text in that Code.gs file and delete it.
 *      Then paste in EVERYTHING from this file (this whole thing).
 *      Click the floppy-disk Save icon (or press Ctrl+S / Cmd+S).
 *
 *   4. Click the blue  Deploy  button (top-right)  >  New deployment.
 *
 *   5. Click the gear icon next to "Select type"  >  choose  Web app.
 *
 *   6. Fill in the deployment settings:
 *        - Description:      Giveaway form   (anything you want)
 *        - Execute as:       Me  (your email)
 *        - Who has access:   Anyone
 *      Then click  Deploy.
 *
 *   7. The first time, Google asks you to authorize. Click  Authorize access
 *      and pick your Google account, then  Allow. (If a "Google hasn't
 *      verified this app" screen appears, click  Advanced  >  Go to (your
 *      project) — this is YOUR OWN script, it is safe. Most of the time this
 *      screen won't appear at all for a script that only touches its own sheet.)
 *
 *   8. Google shows you a "Web app URL" that ends in  /exec .
 *      Click  Copy . It looks like:
 *        https://script.google.com/macros/s/AKfyc............/exec
 *
 *   9. Open spotted-james.html and find this line in the giveaway <script>:
 *        var SCRIPT_URL = 'PASTE_YOUR_APPS_SCRIPT_EXEC_URL_HERE';
 *      Replace the placeholder with the /exec URL you copied. Save and
 *      re-publish the site.
 *
 *  10. Test it: open the site, fill in the form, hit Submit — a new row should
 *      appear in the Sheet. (You can also open the /exec URL directly in a
 *      browser; it should show:  {"status":"ok", ...}  )
 *
 * -----------------------------------------------------------------------------
 * IMPORTANT — IF YOU EVER EDIT THIS CODE LATER:
 * -----------------------------------------------------------------------------
 *   Changes do NOT go live automatically. After editing you must redeploy the
 *   SAME deployment (so the /exec URL stays identical and you don't touch the
 *   website again):
 *      Deploy  >  Manage deployments  >  (pencil/edit icon on your web app)
 *      >  Version: New version  >  Deploy.
 *   Avoid "New deployment" for edits — that mints a NEW /exec URL you'd have to
 *   paste back into the website.
 *
 * -----------------------------------------------------------------------------
 * NOTES:
 *   - Timestamps use this Apps Script project's timezone. To match the venue's
 *     time, set it in  Project Settings (gear)  >  Time zone  (America/Denver).
 *   - The website MUST POST as application/x-www-form-urlencoded (a
 *     URLSearchParams body). That is a CORS "simple" request with no preflight;
 *     Apps Script does not handle OPTIONS, so a JSON Content-Type POST from a
 *     browser would fail the preflight and never reach this code.
 *******************************************************************************/

// The tab (sheet) name inside your spreadsheet where entries are written.
// A new spreadsheet's first tab is called "Sheet1" by default. If you rename
// your tab, change this to match — otherwise leave it as is.
var SHEET_NAME = 'Sheet1';

// The column headers, added automatically on the very first submission.
var HEADERS = ['Timestamp', 'Name', 'Phone', 'Email', 'Source', 'Page'];


/**
 * Handles the form submission POST from the website.
 * Works with either form-urlencoded data (e.parameter) or a raw JSON body
 * (e.postData.contents), so it is robust to whatever the browser sends.
 */
function doPost(e) {
  try {
    var data = parseIncoming_(e);

    // --- Honeypot: spam bots fill hidden fields. If "_gotcha" has anything
    //     in it, we pretend everything is fine but DO NOT write a row. -------
    if (data._gotcha && String(data._gotcha).trim() !== '') {
      return jsonOut_({ result: 'success' });
    }

    var name  = safeTrim_(data.name);
    var phone = safeTrim_(data.phone);
    var email = safeTrim_(data.email);

    // --- Basic validation: all three fields are required. Return an error
    //     as JSON instead of throwing, so nothing crashes. ------------------
    if (!name || !phone || !email) {
      return jsonOut_({
        result: 'error',
        message: 'Please fill in your name, phone number, and email.'
      });
    }

    var source = safeTrim_(data.source);
    var page   = safeTrim_(data.page);

    // --- Lock so two people scanning at the exact same moment can't clobber
    //     each other's row. Wait up to 30s for our turn. --------------------
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var sheet = getSheet_();
      ensureHeaders_(sheet);
      sheet.appendRow([new Date(), name, phone, email, source, page]);
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
    app: 'The Spotted James — giveaway sign-up',
    time: new Date().toISOString()
  });
}


/* ============================ helper functions ============================ */

/**
 * Pulls {name, phone, email, _gotcha, ...} out of the request no matter how the
 * browser sent it: form-urlencoded fields, a JSON body, or both.
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
 * Returns the target sheet/tab. Uses the bound spreadsheet. If a tab named
 * SHEET_NAME doesn't exist, falls back to the first tab so entries are never
 * lost due to a rename.
 */
function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.getSheets()[0]; // fall back to the first tab
  }
  return sheet;
}

/**
 * Writes the header row once. Guards on the CONTENT of A1 rather than
 * getLastRow()===0, so if the owner accidentally typed a stray note in the
 * sheet during setup we still lay down proper headers instead of silently
 * writing the first entry under a missing header.
 */
function ensureHeaders_(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    return;
  }
  var a1 = String(sheet.getRange(1, 1).getValue()).trim();
  if (a1 !== HEADERS[0]) {
    // First row isn't our header — insert one above so nothing is overwritten.
    sheet.insertRowBefore(1);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  }
}

/** Wraps an object as a JSON HTTP response. */
function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
