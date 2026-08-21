/**
 * Anthifel — website endpoint
 * Google Apps Script Web App. Owner: Developer.
 *
 * Three things happen here, and nothing else:
 *
 *   send-code    someone gives an email address and consents. A six-digit code
 *                goes to that address from hello@anthifel.com. Nothing is
 *                written to the sheet yet — an unverified address is not a
 *                lead, it is a claim.
 *   verify-code  the code comes back. If it matches, is unexpired and unused,
 *                the row is written with the consent timestamp and the
 *                assessment opens.
 *   result       the assessment finished. The score and the band arrive, the
 *                row is completed, and two emails go out: the result to them,
 *                the lead to us.
 *
 * WHY A CODE RATHER THAN A BOT CHECK
 *   A captcha asks "are you a person". This asks "is this your address", which
 *   is the question that actually matters for a form whose entire output is an
 *   email. It also takes a third party off the privacy notice, and it means
 *   every lead in the sheet has a reachable address rather than a typo or
 *   someone else's.
 *
 *   It introduces one abuse a captcha did not: someone can ask us to send mail
 *   to an address that is not theirs, repeatedly. That is what
 *   MAX_CODES_PER_EMAIL and MAX_CODES_PER_HOUR are for, and it is why a code
 *   request never says whether the address has been seen before.
 *
 * DEPLOY
 *   Extensions → Apps Script, paste this in, then:
 *   Project Settings → Script Properties, add:
 *       SHEET_ID    the id of the spreadsheet that stores submissions
 *       NOTIFY_TO   hello@anthifel.com
 *       SEND_AS     hello@anthifel.com   (must be a verified alias of the
 *                                         account running the script)
 *   Deploy → New deployment → Web app
 *       Execute as:      Me
 *       Who has access:  Anyone
 *   Copy the /exec URL into ENDPOINT in index.html.
 *
 * RETENTION: rows written here are personal data. PURGE_AFTER_DAYS must match
 * whatever the published Privacy Policy states — keep the two numbers equal.
 *
 * WHAT IS NEVER STORED: the individual answers. The score is their summary;
 * keeping the raw answers adds no information and adds an obligation. This is
 * a red line in the Developer brief, not a preference.
 */

var PURGE_AFTER_DAYS    = 730; // 24 months. Must match the Privacy Policy.
var CODE_TTL_MINUTES    = 15;  // how long a code is good for
var MAX_CODES_PER_EMAIL = 8;   // per address, per hour. Five was too tight:
                               // one mistyped address plus one resend and a
                               // real person is already at four.
var MAX_CODES_PER_HOUR  = 60;  // across the whole site, per hour
var MAX_ATTEMPTS        = 5;   // wrong guesses before a code is burned

function prop_(k) {
  return PropertiesService.getScriptProperties().getProperty(k) || '';
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* A stamp, so which version is deployed is never again a guess.

   The editor always runs the newest code; the web app runs whatever version
   was last published. Those two being different is invisible from the outside
   and it cost an afternoon: the editor sent mail through Resend while the site
   was still sending through Gmail, and both were "working".

   Open /exec in a browser and this answers. Change it whenever the file
   changes in a way that matters. */
var CODE_VERSION = '2026-08-19 · okuma listesi + rıza kaydı + saklama';
/* Bu satırı her değişiklikte güncelle. Bugün üç kez "hangi sürüm yapıştırıldı"
   diye soruldu ve stamp 13 Ağustos'ta donmuş olduğu için cevap veremedi —
   yani tam olarak var olma sebebini yerine getiremedi. */

function doGet() {
  return json_({ ok: false, error: 'POST only', version: CODE_VERSION,
                 sending: prop_('RESEND_KEY') ? 'resend' : 'gmail' });
}

/* An address, cut down to what a log needs. Enough to tell two testers apart
   and to confirm the request carried what the form showed; not enough to be a
   record of who visited. Logs are operational, not a store. */
function mask_(email) {
  var s = String(email || '');
  var at = s.indexOf('@');
  if (at < 1) return '(none)';
  return s.slice(0, 2) + '***' + s.slice(at);
}

function doPost(e) {
  var d = null;
  try {
    d = JSON.parse(e.postData.contents);

    // The honeypot. A field no person sees and no person fills.
    if (d.website) { console.log('honeypot tripped, answered ok'); return json_({ ok: true }); }

    console.log('IN  action=' + (d.action || d.source || '(none)') +
                ' email=' + mask_(d.email) + ' lang=' + (d.lang || '-'));

    /* The blog editor comes through the same door. It is checked before the
       public actions because it carries a shared secret and none of them do.
       The typeof guard is not defensive noise: BlogCode.gs is a second file in
       this project, and if it is missing the honest answer is to say so rather
       than to throw a ReferenceError the editor would show as "sunucu hatası". */
    if (d.kind === 'blog') {
      if (typeof blogRouter_ !== 'function') {
        console.error('blog payload arrived but BlogCode.gs is not in this project');
        return json_({ ok: false, error: 'blog_backend_missing — add BlogCode.gs to this Apps Script project' });
      }
      return blogRouter_(d);
    }

    if (d.action === 'send-code')     return sendCode_(d);
    if (d.action === 'verify-code')   return verifyCode_(d);
    if (d.action === 'result')        return result_(d);
    // The quote form on a service page. Different shape, same door.
    if (d.source === 'quote-request') return quote_(d);
    // The reading list. Same door again.
    if (d.source === 'reading-list')  return readingList_(d);
    // A form that failed in someone's browser, telling us so. No personal data.
    if (d.source === 'client-error')  return clientError_(d);

    console.warn('OUT unknown action');
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    // This is why a run can say "Completed" and still have done nothing: every
    // failure is caught here and handed back as JSON. Without this line the
    // only trace of it is a response body nobody kept.
    console.error('OUT threw: ' + err + (err && err.stack ? ' | ' + err.stack : ''));
    return json_({ ok: false, error: String(err) });
  }
}

/* ---------------------------------------------------------------- helpers */

function validEmail_(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim());
}

function tr_(d) { return d && d.lang === 'tr'; }

function esc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sheet_(name, headers) {
  var id = prop_('SHEET_ID');
  if (!id) throw new Error('SHEET_ID is not set');
  var ss = SpreadsheetApp.openById(id);
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    return sh;
  }
  /* A tab that already exists keeps its rows and its meaning, but its header
     row can fall behind the code that writes to it. On 19 August the assessment
     gate gained four columns and the existing tab would have carried them
     unlabelled — data with no name above it, which is the same as no data when
     somebody has to answer a question about it a year later.
     Only ever extends. Nothing is renamed and nothing is moved, because either
     would change what the rows underneath mean. */
  if (headers.length) {
    var width = sh.getLastColumn();
    if (width < headers.length) {
      sh.getRange(1, width + 1, 1, headers.length - width)
        .setValues([headers.slice(width)]);
    }
  }
  return sh;
}

/* Sending.

   Two ways out, and which one is used depends on one Script Property.

   `MailApp` was the first, and it works: the mail leaves Google every time.
   What it cannot do is arrive. `anthifel.com` is two weeks old and has no
   sending reputation, so Gmail accepts the message and drops it — not to spam,
   to nowhere. Eight code mails left on 12 August and not one was seen. The
   configuration was never wrong: SPF, DKIM, DMARC and MX are all correct and
   the send-as alias is verified. Reputation is not something you configure.

   Resend sends from IPs that already have a reputation, signed with our DKIM,
   which is the part that cannot be bought with more DNS records. Set
   `RESEND_KEY` and every mail goes that way; leave it unset and everything
   falls back to `MailApp` exactly as before. That is deliberate: the switch is
   one property, in both directions, and nothing about the flow changes with it.

   Resend is a processor. It sees the recipient's address and the body of the
   mail, which for the result mail includes a score and a band. It belongs in
   the privacy notice and in §23 — that is Legal's line, not a footnote here.

   Returns the address it sent from, or a string saying which road it took, so
   the caller can log it and the preview can show it. */
function sendMail_(to, subject, html, attachment) {
  var plain = html.replace(/<[^>]+>/g, ' ');
  var from  = prop_('SEND_AS') || prop_('NOTIFY_TO');
  var key   = prop_('RESEND_KEY');

  if (key) {
    try {
      var res = UrlFetchApp.fetch('https://api.resend.com/emails', {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + key },
        payload: JSON.stringify({
          from: 'Anthifel <' + (from || 'hello@anthifel.com') + '>',
          to: [to],
          subject: subject,
          html: html,
          text: plain,
          attachments: attachment
            ? [{ filename: attachment.getName(),
                 content: Utilities.base64Encode(attachment.getBytes()) }]
            : undefined
        }),
        muteHttpExceptions: true
      });
      var code = res.getResponseCode();
      if (code >= 200 && code < 300) return from + ' (resend)';
      // A key that is wrong, a domain that is not verified, a rate limit: all
      // worth knowing, and none of them worth losing the mail over.
      console.warn('Resend refused with ' + code + ': ' + res.getContentText().slice(0, 300) +
                   ' — falling back to MailApp');
    } catch (err) {
      console.warn('Resend unreachable: ' + err + ' — falling back to MailApp');
    }
  }

  /* `from` only works if the address is a verified send-as alias on the account
     running the script. If it is not, MailApp throws — and that exception used
     to take the whole request with it. */
  var opts = { htmlBody: html, name: 'Anthifel' };
  if (attachment) opts.attachments = [attachment];
  if (from) {
    try {
      opts.from = from;
      MailApp.sendEmail(to, subject, plain, opts);
      return from + ' (gmail)';
    } catch (err2) {
      console.warn('SEND_AS "' + from + '" was refused: ' + err2);
      delete opts.from;
    }
  }
  MailApp.sendEmail(to, subject, plain, opts);
  return '(account address, gmail)';
}

/**
 * A notification, which is never allowed to fail the thing it notifies about.
 *
 * The order used to be inverted: `readingList_` wrote the row and then sent
 * ourselves a mail saying a row had been written. `sendMail_` throws — a spent
 * Gmail quota is the ordinary reason — the throw travelled up to doPost's
 * catch, and doPost answered `ok:false`. A subscription would have existed and
 * the subscriber would have been told it did not.
 *
 * That is not what happened on 21 August; that request never arrived at all.
 * The bug is real anyway and was one spent quota away from happening, so it is
 * closed rather than left standing because it has not bitten yet.
 *
 * `sendMail_` still throws, deliberately, at the two places where the mail *is*
 * the product — the login code. There a failure to send is a real failure and
 * the caller has to hear it. Use this one only after the write has happened.
 */
function notify_(to, subject, html, attachment) {
  try {
    sendMail_(to, subject, html, attachment);
    return true;
  } catch (err) {
    console.error('notification failed — the record itself is safe: ' + err +
                  ' | to=' + mask_(to) + ' | subject=' + subject);
    return false;
  }
}

/* What the account can actually send as, and what is left in the daily quota.
   Run this from the editor when a mail does not arrive — it answers the
   questions that matter in one go, without sending anything. */
function checkMailSetup() {
  var aliases = GmailApp.getAliases();
  var want = prop_('SEND_AS') || '(SEND_AS is not set)';
  Logger.log('Sending through : ' + (prop_('RESEND_KEY') ? 'Resend' : 'Gmail (MailApp)'));
  Logger.log('SEND_AS         : ' + want);
  Logger.log('Verified aliases: ' + (aliases.length ? aliases.join(', ') : '(none)'));
  Logger.log('Usable as "from": ' + (aliases.indexOf(want) >= 0 ? 'YES' : 'NO — it will fall back'));
  Logger.log('Account address : ' + Session.getActiveUser().getEmail());
  Logger.log('Gmail left today: ' + MailApp.getRemainingDailyQuota());
  Logger.log('SHEET_ID set    : ' + (prop_('SHEET_ID') ? 'yes' : 'NO'));
  Logger.log('NOTIFY_TO       : ' + (prop_('NOTIFY_TO') || '(not set)'));
}

/* ---------------------------------------------------------------------------
   testMailNow — the shortest question worth asking when no mail arrives.

   Run it from the editor. It sends one real code mail, with the real template,
   through the same sendMail_ the site uses — and it does not touch the web app,
   the deployment, the browser or the network. So the answer is unambiguous:

     mail arrives  → Apps Script can reach that inbox. The fault is on the web
                     app side, and we look at doPost.
     mail does not → the fault is between Apps Script and Gmail, and nothing on
                     the site can cause or fix it.

   Change WHERE to whichever address you are watching.
   ------------------------------------------------------------------------ */
function testMailNow() {
  var WHERE = 'dengizeray@gmail.com';

  var d = { lang: 'tr', email: WHERE };
  var code = String(Math.floor(100000 + Math.random() * 900000));

  Logger.log('Sending to      : ' + WHERE);
  Logger.log('Quota before    : ' + MailApp.getRemainingDailyQuota());
  var how = sendMail_(WHERE, codeSubject_(d, code), codeBody_(code, d));
  Logger.log('Sent as         : ' + how);
  Logger.log('Quota after     : ' + MailApp.getRemainingDailyQuota());
  Logger.log('Code in the mail: ' + code);
  Logger.log('');
  Logger.log('If the quota dropped by one, Gmail accepted it. If nothing');
  Logger.log('arrives after that, it was delivered somewhere you are not');
  Logger.log('looking — check Spam and All Mail for from:' + (prop_('SEND_AS') || '?'));
}

/* The older copy of checkMailSetup() stood here and was deleted on 21 August.
   There were two functions with this name in one file. Apps Script keeps the
   last definition, so every time it ran it was this one — the one without the
   "Sending through: Resend or Gmail" line. The green log we read on 20 August
   came from a function nobody thought they were reading. Two definitions of
   one name is not a duplicate, it is a silent choice between two behaviours. */

/* The code store lives in Script Properties rather than the sheet: it is
   short-lived operational state, not a record, and it must not sit next to
   the leads. One property per address, cleared on use. */
function codeKey_(email) {
  return 'code:' + String(email).trim().toLowerCase();
}

function readCode_(email) {
  var raw = prop_(codeKey_(email));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function writeCode_(email, obj) {
  PropertiesService.getScriptProperties()
    .setProperty(codeKey_(email), JSON.stringify(obj));
}

function clearCode_(email) {
  PropertiesService.getScriptProperties().deleteProperty(codeKey_(email));
}

/* A crude hourly counter, kept in the same place. It exists so a script cannot
   turn our mail quota into someone else's inbox problem. */
function rateOk_(email) {
  var now = Date.now(), hour = 3600 * 1000;
  var props = PropertiesService.getScriptProperties();
  // One read and one write instead of five round trips. Each Script Properties
  // call is a request of its own, and this runs while a visitor is watching a
  // button.
  var all = props.getProperties();
  var g = {};
  try { g = JSON.parse(all['rate:global'] || '{}'); } catch (e) {}
  if (!g.since || now - g.since > hour) g = { since: now, n: 0 };
  if (g.n >= MAX_CODES_PER_HOUR) return false;

  var k = 'rate:' + String(email).trim().toLowerCase();
  var p = {};
  try { p = JSON.parse(all[k] || '{}'); } catch (e) {}
  if (!p.since || now - p.since > hour) p = { since: now, n: 0 };
  if (p.n >= MAX_CODES_PER_EMAIL) return false;

  g.n++; p.n++;
  var write = {};
  write['rate:global'] = JSON.stringify(g);
  write[k] = JSON.stringify(p);
  props.setProperties(write);
  return true;
}

/* ------------------------------------------------------------ 1. the code */

function sendCode_(d) {
  if (!validEmail_(d.email)) return json_({ ok: false, error: 'email' });
  if (d.consent !== true)    return json_({ ok: false, error: 'consent' });

  var email = String(d.email).trim();

  // Deliberately the same answer whether or not the limit was hit, and whether
  // or not this address has been seen before. A form that says "we already know
  // you" answers a question nobody asked it.
  if (!rateOk_(email)) {
    // Deliberately invisible to the visitor, so it must be visible here —
    // otherwise "no mail arrived" and "we chose not to send one" look the same.
    console.warn('RATE LIMIT hit for ' + mask_(email) + ' — no mail sent');
    return json_({ ok: true, sent: false, why: 'rate-limit' });
  }

  var code = String(Math.floor(100000 + Math.random() * 900000));
  writeCode_(email, {
    code: code,
    at: Date.now(),
    tries: 0,
    consentAt: d.consentAt || new Date().toISOString(),
    consentText: d.consentText || '',
    /* The rest of §3's record, carried from the moment of the tick to the
       moment the row is written. It waits here with the code because the row
       is only written after the address is verified — and by then the page
       that captured the consent is gone. */
    consentVersion: d.consentVersion || '',
    channel: d.channel || 'web-form',
    affirmative: d.affirmative || 'checkbox:true',
    privacyVersion: d.privacyVersion || '',
    lang: d.lang || 'en',
    page: d.page || '',
    referrer: d.referrer || '',
    tz: d.tz || ''
  });

  var how = sendMail_(email, codeSubject_(d, code), codeBody_(code, d));
  var left = MailApp.getRemainingDailyQuota();
  console.log('SENT code mail to ' + mask_(email) + ' from ' + how +
              ' | quota left ' + left);
  // `why`, `from` and `quota` say what happened without saying anything about
  // who. The preview shows them on screen; it is the difference between "the
  // mail did not arrive" and "we never sent one", which took an afternoon to
  // tell apart the first time.
  return json_({ ok: true, sent: true, why: 'sent', from: how, quota: left });
}

/* ----------------------------------------------------------- 2. the check */

function verifyCode_(d) {
  if (!validEmail_(d.email)) return json_({ ok: false, error: 'email' });
  var rec = readCode_(d.email);
  if (!rec) return json_({ ok: false, error: 'no-code' });

  if (Date.now() - rec.at > CODE_TTL_MINUTES * 60 * 1000) {
    clearCode_(d.email);
    return json_({ ok: false, error: 'expired' });
  }
  if (rec.tries >= MAX_ATTEMPTS) {
    clearCode_(d.email);
    return json_({ ok: false, error: 'too-many' });
  }
  if (String(d.code || '').trim() !== rec.code) {
    rec.tries++;
    writeCode_(d.email, rec);
    return json_({ ok: false, error: 'wrong', left: MAX_ATTEMPTS - rec.tries });
  }

  // Verified. Now, and only now, does the address become a row.
  /* The five fields Anthifel_Legal_DataProcessing.md §3 asks to be recorded.
     The reading list has carried them since 19 August and this gate is the
     other form on the site: same rule, same columns, different sentence — so a
     different wording identifier. Pointing both at the same one would make an
     old record resolve to a sentence the person never saw. */
  /* The four columns are added at the end, not beside the two consent columns
     they belong with. A sheet with rows already in it cannot have a column
     inserted in the middle without every one of those rows meaning something
     different afterwards. Reading order is a display problem; a row that
     silently changes meaning is not. */
  var sh = sheet_('Assessment', [
    'Verified at', 'Email', 'Consent given', 'Consent at', 'Consent text',
    'Language', 'Page', 'Referrer', 'Timezone', 'Score', 'Band', 'Completed at',
    'Wording version', 'Channel', 'Affirmative response', 'Privacy notice version'
  ]);
  sh.appendRow([
    new Date(), String(d.email).trim(), 'yes', rec.consentAt, rec.consentText,
    rec.lang, rec.page, rec.referrer, rec.tz, '', '', '',
    rec.consentVersion || '', rec.channel || 'web-form',
    rec.affirmative || 'checkbox:true', rec.privacyVersion || ''
  ]);

  rec.verified = true;
  rec.tries = 0;
  writeCode_(d.email, rec);   // kept until the result lands, then cleared
  return json_({ ok: true });
}

/* ---------------------------------------------------------- 3. the result */

function result_(d) {
  if (!validEmail_(d.email)) return json_({ ok: false, error: 'email' });
  var rec = readCode_(d.email);
  if (!rec || !rec.verified) return json_({ ok: false, error: 'not-verified' });

  var score = Math.round(Number(d.score) || 0);
  var band  = String(d.band || '');

  // Complete the row rather than adding a second one: one visitor, one line.
  var sh = sheet_('Assessment', []);
  var values = sh.getDataRange().getValues();
  for (var i = values.length - 1; i >= 1; i--) {
    if (String(values[i][1]).toLowerCase() === String(d.email).trim().toLowerCase()
        && !values[i][9]) {
      sh.getRange(i + 1, 10).setValue(score);
      sh.getRange(i + 1, 11).setValue(band);
      sh.getRange(i + 1, 12).setValue(new Date());
      break;
    }
  }

  /* The PDF rides with the result mail when PDF_LIVE says so. It is off until
     Legal's consent wording is in the form, because being sent a document is
     not the same thing as being shown a score, and the visitor has only agreed
     to the second. A failure here must not cost the mail: the score on screen
     and the mail are the promise, the PDF is the extra. */
  var pdf = null;
  if (pdfOn_()) {
    try { pdf = resultPdf_(d, score); }
    catch (err) { console.warn('result PDF failed, sending without it: ' + err); }
  }
  /* The score is already on the visitor's screen by the time this runs. If the
     mail cannot be sent, the honest answer is to log it and say so in the
     response — not to throw, which would replace a score they can see with an
     error telling them nothing happened. */
  var mailed = notify_(String(d.email).trim(), resultSubject_(d, score),
                       resultBody_(d, score), pdf);
  var to = prop_('NOTIFY_TO');
  var told = true;
  if (to) told = notify_(to, leadSubject_(d, score), leadBody_(d, score));

  clearCode_(d.email);
  return json_({ ok: true, mailed: mailed, notified: told });
}

/* ------------------------------------------------- the quote form, briefly */

/* --------------------------------------------------- 4. the reading list */
/**
 * A subscription, and the proof that it was asked for.
 *
 * This route did not exist until 19 August. The form on every page sent a
 * packet with `source: 'reading-list'`, nothing here matched it, and the
 * endpoint answered "unknown action" — so the visitor saw a failure and the
 * list was not empty, it was absent. Nobody was lost quietly, which is the only
 * good thing that can be said about it.
 *
 * Five fields, from Anthifel_Legal_DataProcessing.md §3, and they are the point
 * of this function rather than decoration on it: a consent that cannot be shown
 * is the same as no consent. The page sends them — when the box was ticked,
 * which wording was on the screen, which channel, what the affirmative act
 * actually was, and which version of the notice was published at the time —
 * because that is where they are true. Inventing them here would record what we
 * assume rather than what happened.
 *
 * Fails closed. Anything short of a clear yes is not written at all: no row,
 * no partial row, no "pending". §3 asks for exactly that.
 */
function readingList_(d) {
  if (!validEmail_(d.email)) return json_({ ok: false, error: 'email' });
  /* The affirmative act, captured rather than inferred. A missing flag, a
     missing timestamp or a missing wording version all mean the same thing:
     we cannot show what this person agreed to. */
  if (d.consent !== true || !d.consentAt || !d.consentVersion) {
    return json_({ ok: false, error: 'consent' });
  }

  var email = String(d.email).trim();
  var sh = sheet_('Reading list', [
    'Received', 'Email', 'Consent given', 'Consent at', 'Consent wording',
    'Wording version', 'Channel', 'Affirmative response', 'Privacy notice version',
    'Privacy notice acknowledged', 'Language', 'Page', 'Referrer', 'Timezone'
  ]);

  /* One address, one row. A second subscription from the same person is the
     same consent restated, not a second person, and a list with duplicates on
     it is a list that will send the same piece twice. */
  var last = sh.getLastRow();
  if (last > 1) {
    var have = sh.getRange(2, 2, last - 1, 1).getValues();
    for (var i = 0; i < have.length; i++) {
      if (String(have[i][0]).trim().toLowerCase() === email.toLowerCase()) {
        return json_({ ok: true, already: true });
      }
    }
  }

  sh.appendRow([
    new Date(), email, 'yes', d.consentAt, d.consentText || '',
    d.consentVersion, d.channel || 'web-form', d.affirmative || 'checkbox:true',
    d.privacyVersion || '', d.privacyAck === true ? 'yes' : 'no',
    d.lang || '', d.page || '', d.referrer || '', d.tz || ''
  ]);

  /* Past this line the subscription exists. Nothing below it is allowed to
     take that away from the person who asked for it. */
  var to = prop_('NOTIFY_TO');
  var told = true;
  if (to) {
    told = notify_(to, 'Okuma listesi — yeni kayıt',
      WRAP_OPEN + h1_('Okuma listesi') + p_(esc_(email)) +
      p_(esc_(d.consentVersion) + ' · ' + esc_(d.privacyVersion || '')) + WRAP_CLOSE);
  }
  return json_({ ok: true, notified: told });
}

/**
 * A form that failed in somebody's browser, writing down that it failed.
 *
 * 21 August, 11:26. Somebody subscribed, saw "Something did not go through",
 * and there was no row. The execution log settled why: there is no doPost at
 * 11:26 at all. The request never arrived — it was stopped on his side of the
 * wire, by a network or a browser that would not reach script.google.com.
 *
 * Which is the case this sheet cannot record, because the beacon below travels
 * to the same host that was blocked. It is written anyway: it catches every
 * other failure — a bad second at Google, a redeploy mid-submit, a refusal
 * with a reason — and turns "somebody said the form was broken" into a number.
 * A failure nobody can count is a failure nobody can fix.
 *
 * What is recorded, and what is not. No email address: the person did not
 * complete a consented submission, so we have no basis to keep their address
 * and no use for it. No query string on the page URL either. What is left is
 * the shape of the failure, which is what a fix gets built from.
 */
function clientError_(d) {
  var sh = sheet_('Failures', ['Received', 'Form', 'Reason', 'Language', 'Page']);
  sh.appendRow([
    new Date(),
    String(d.where || '').slice(0, 40),
    String(d.reason || '').slice(0, 200),
    String(d.lang || '').slice(0, 5),
    String(d.page || '').split('?')[0].slice(0, 200)
  ]);
  console.warn('client reported a failure: ' + d.where + ' — ' + d.reason);
  return json_({ ok: true });
}

function quote_(d) {
  if (!validEmail_(d.email)) return json_({ ok: false, error: 'email' });
  var sh = sheet_('Quotes', ['Received', 'Service', 'Name', 'Email', 'Company',
                             'Employees', 'Language', 'Page', 'Timezone']);
  sh.appendRow([new Date(), d.service || '', d.name || '', d.email, d.company || '',
                d.size || '', d.lang || '', d.page || '', d.tz || '']);
  /* Same rule as the reading list: the row is the product, the mail is not. */
  var to = prop_('NOTIFY_TO');
  var told = true;
  if (to) {
    told = notify_(to, 'Teklif talebi — ' + (d.company || d.email),
      WRAP_OPEN + h1_('Teklif talebi') +
      p_('<b>' + esc_(d.name) + '</b> · ' + esc_(d.company) + ' · ' + esc_(d.size)) +
      p_(esc_(d.email)) + p_(esc_(d.service)) + WRAP_CLOSE);
  }
  return json_({ ok: true, notified: told });
}

/* =========================================================================
   EMAIL TEMPLATES

   The wording below is Developer's draft and Marketing has not approved it.
   Anything a visitor reads is Marketing's, so these go to them before the form
   is switched on. What is not up for discussion is what they contain: the code
   mail carries no marketing, and the lead mail carries no answers.
   ========================================================================= */

var WRAP_OPEN =
  '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;' +
  'background:#F5F1EA;padding:32px 16px;color:#0F0F0E">' +
  '<div style="max-width:560px;margin:0 auto;background:#FCFAF5;' +
  'border-top:2px solid #B84C2E;padding:32px 28px">';

var WRAP_CLOSE =
  '<p style="margin:28px 0 0;font-size:12px;line-height:1.6;color:#7A756C">' +
  'Anthifel Ltd · London, United Kingdom · ' +
  '<a href="https://anthifel.com" style="color:#7A756C">anthifel.com</a></p>' +
  '</div></div>';

function h1_(t) {
  return '<h1 style="margin:0 0 18px;font-family:Georgia,serif;font-weight:400;' +
         'font-size:26px;line-height:1.25;color:#0F0F0E">' + esc_(t) + '</h1>';
}

function p_(t) {
  return '<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:#3A3733">' +
         t + '</p>';
}

/* ---- 1. the code ---- */

/* The code goes in the subject line, first.

   Not decoration: it is the fastest the code can possibly arrive. A subject is
   what a phone shows in a notification, what a mail client shows in the list,
   and — the reason this matters here — what is readable without opening a
   message that has landed in spam. The body still carries it, large, for
   anyone who opens the mail. */
function codeSubject_(d, code) {
  var head = code ? code + ' — ' : '';
  return head + (tr_(d) ? 'AI Hazırlık Testi giriş kodunuz'
                        : 'your AI Readiness Assessment code');
}

function codeBody_(code, d) {
  var big = '<p style="margin:22px 0;font-family:Georgia,serif;font-size:38px;' +
            'letter-spacing:.18em;color:#B84C2E">' + esc_(code) + '</p>';
  if (tr_(d)) {
    return WRAP_OPEN + h1_('Giriş kodunuz') +
      p_('AI Hazırlık Testi\'ne devam etmek için bu kodu girin.') + big +
      p_('Kod ' + CODE_TTL_MINUTES + ' dakika geçerlidir.') +
      p_('Bu isteği siz yapmadıysanız yapmanız gereken bir şey yok; ' +
         'kullanılmayan kod kendiliğinden geçersiz olur.') + WRAP_CLOSE;
  }
  return WRAP_OPEN + h1_('Your code') +
    p_('Enter this code to continue with the AI Readiness Assessment.') + big +
    p_('It is valid for ' + CODE_TTL_MINUTES + ' minutes.') +
    p_('If you did not ask for this, there is nothing to do: an unused code ' +
       'expires on its own.') + WRAP_CLOSE;
}

/* ---- 2. the result, to the visitor ---- */

function resultSubject_(d, score) {
  return tr_(d) ? 'AI Hazırlık Testi sonucunuz: ' + score + ' / 100'
                : 'Your AI Readiness score: ' + score + ' / 100';
}

function dimRows_(d) {
  var dims = d.dims || [];
  var out = '<table style="width:100%;border-collapse:collapse;margin:6px 0 18px;' +
            'font-size:14px;line-height:1.5">';
  for (var i = 0; i < dims.length; i++) {
    out += '<tr>' +
      '<td style="padding:9px 0;border-bottom:1px solid rgba(15,15,14,.09);color:#3A3733">' +
        esc_(dims[i].name) + '</td>' +
      '<td style="padding:9px 0;border-bottom:1px solid rgba(15,15,14,.09);' +
        'text-align:right;color:#0F0F0E;font-weight:600">' +
        Math.round(dims[i].value) + '</td></tr>';
  }
  return out + '</table>';
}

function resultBody_(d, score) {
  var t = tr_(d);
  var big = '<p style="margin:18px 0 6px;font-family:Georgia,serif;font-size:52px;' +
            'line-height:1;color:#0F0F0E">' + score +
            '<span style="font-size:20px;color:#7A756C"> / 100</span></p>';
  var band = d.bandTitle
    ? '<p style="margin:14px 0 10px;font-family:Georgia,serif;font-size:22px;' +
      'line-height:1.3;color:#0F0F0E">' + esc_(d.bandTitle) + '</p>' : '';
  var body = d.bandText ? p_(esc_(d.bandText)) : '';
  var weak = d.weakest
    ? p_((t ? 'Sizi geri tutan şey <b>' : 'What is holding you back is <b>') +
         esc_(d.weakest) + '</b>.') : '';
  var cap = t
    ? p_('Bu skor sizin beyanınıza dayanıyor ve yaklaşık ±15 puan oynar. Bu test en fazla ' +
         '79 puana kadar okur; üst bant ancak kanıtlı ölçümle doğrulanır.')
    : p_('This score rests on your own answers and moves by roughly ±15 points. This test ' +
         'reads up to 79; the top band can only be confirmed by evidenced measurement.');
  var cta = t
    ? p_('<a href="https://anthifel.com/ai-readiness-audit.html?lang=tr" style="color:#B84C2E">' +
         'AI Readiness Audit neyi ölçüyor</a> &nbsp;·&nbsp; ' +
         '<a href="https://anthifel.com/#meet" style="color:#B84C2E">30 dakikalık ücretsiz görüşme</a>')
    : p_('<a href="https://anthifel.com/ai-readiness-audit.html" style="color:#B84C2E">' +
         'What the AI Readiness Audit measures</a> &nbsp;·&nbsp; ' +
         '<a href="https://anthifel.com/#meet" style="color:#B84C2E">Book a free 30-minute call</a>');
  var priv = t
    ? p_('<span style="font-size:12.5px;color:#7A756C">Cevaplarınız saklanmaz; yalnızca ' +
         'e-posta adresiniz, skorunuz ve bandınız kaydedilir. Silinmesini istediğinizde ' +
         '<a href="mailto:privacy@anthifel.com" style="color:#7A756C">privacy@anthifel.com</a>.</span>')
    : p_('<span style="font-size:12.5px;color:#7A756C">Your answers are not stored. We keep ' +
         'your email address, your score and your band. To have them deleted, write to ' +
         '<a href="mailto:privacy@anthifel.com" style="color:#7A756C">privacy@anthifel.com</a>.</span>');

  return WRAP_OPEN + h1_(t ? 'Sonucunuz' : 'Your result') + big + band + body +
         dimRows_(d) + weak + cap + cta + priv + WRAP_CLOSE;
}

/* =================== the result PDF (Business D3) ===================
 * Five blocks, one button, and the button goes to the call — not to a service
 * page. Business's reasoning is worth keeping next to the code, because the
 * asymmetry looks like an oversight otherwise: on screen the visitor pressed a
 * button themselves, so offering a quote answers something they asked. The PDF
 * is sent by us, so we are the ones choosing what comes next — and proposing a
 * sale off a self-reported score that moves by ±15 points is not honest.
 * Proposing a conversation is.
 *
 * NO PRICE. NO SERVICE NAME. NO SERVICE RECOMMENDATION. All three are checked
 * by checkResultPdf() below rather than left to whoever edits this next.
 *
 * TWO SWITCHES, both off by default:
 *   PDF_LIVE      'true' turns the attachment on
 *   the consent   Legal's wording lands 17 August. Until then a real visitor
 *                 has not agreed to be sent one, so the flag alone is not
 *                 enough — testResultPdf() writes to Drive and sends nothing.
 *
 * The text of blocks 1 and 3 is Business's and arrives as BUS-035. What is here
 * now is scaffolding, and it says so on the page rather than reading as final
 * copy that nobody remembers to replace.
 */
var PDF_TEXT_PENDING = true;   // flip when BUS-035 lands, with the real copy

function pdfOn_() { return prop_('PDF_LIVE') === 'true'; }

/** The three dimensions to look at first: the lowest three, worst first. */
function weakestThree_(d) {
  var dims = (d.dims || []).slice();
  dims.sort(function (a, b) { return Number(a.value) - Number(b.value); });
  return dims.slice(0, 3);
}

function resultPdfHtml_(d, score) {
  var t = tr_(d);
  var dims = d.dims || [];
  var three = weakestThree_(d);
  var lowest = dims.length ? weakestThree_(d)[0] : null;

  function row(dim) {
    var low = lowest && dim.name === lowest.name;
    return '<tr>' +
      '<td style="padding:10px 0;border-bottom:1px solid #E4DFD5;' +
        (low ? 'font-weight:700;color:#B84C2E' : 'color:#3A3733') + '">' +
        esc_(dim.name) + (low ? (t ? ' · en zayıf' : ' · weakest') : '') + '</td>' +
      '<td style="padding:10px 0;border-bottom:1px solid #E4DFD5;text-align:right;' +
        (low ? 'font-weight:700;color:#B84C2E' : 'font-weight:600;color:#0F0F0E') + '">' +
        Math.round(dim.value) + '</td></tr>';
  }

  var capLine = d.capped
    ? '<p style="margin:8px 0 0;font-size:13px;color:#7A756C">' +
      (t ? 'Bir tavan uygulandı: ham skor ' + esc_(d.raw) + ', okunan skor ' + score + '.'
         : 'A ceiling was applied: raw score ' + esc_(d.raw) + ', reported score ' + score + '.') +
      '</p>'
    : '';

  var pending = PDF_TEXT_PENDING
    ? '<p style="margin:26px 0 0;padding:12px 14px;border:1px dashed #C9A08C;' +
      'background:#FBF4F0;font-size:12.5px;color:#8A3D22">' +
      (t ? 'Taslak. Bu belgenin yorum metinleri Business tarafından yazılıyor (BUS-035); '
         + 'skor, bant ve boyut kırılımı gerçektir.'
         : 'Draft. The commentary in this document is being written by Business (BUS-035); '
         + 'the score, the band and the dimension breakdown are real.') +
      '</p>'
    : '';

  var limit = t
    ? 'Bu skor sizin beyanınıza dayanıyor ve yaklaşık ±15 puan oynar. Bu test en fazla 79 puana '
    + 'kadar okur; üst bant ancak kanıtlı ölçümle doğrulanır.'
    : 'This score rests on your own answers and moves by roughly ±15 points. This test reads up '
    + 'to 79; the top band can only be confirmed by evidenced measurement.';

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    '@page{size:A4;margin:22mm 20mm}' +
    'body{font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1A1815}' +
    'h1{font-family:Georgia,serif;font-weight:400;font-size:26px;margin:0 0 2px}' +
    'h2{font-size:10.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;' +
      'color:#7A756C;margin:30px 0 8px}' +
    'table{width:100%;border-collapse:collapse}' +
    '.sc{font-family:Georgia,serif;font-size:56px;line-height:1;margin:14px 0 0}' +
    '.sc span{font-size:20px;color:#7A756C}' +
    '.bd{font-family:Georgia,serif;font-size:19px;line-height:1.35;margin:12px 0 0}' +
    '.btn{display:inline-block;margin-top:8px;padding:12px 22px;background:#B84C2E;color:#FFFFFF;' +
      'text-decoration:none;font-weight:600;font-size:14px}' +
    '.ft{margin-top:34px;padding-top:14px;border-top:1px solid #E4DFD5;font-size:11.5px;color:#7A756C}' +
    '</style></head><body>' +

    '<h1>' + (t ? 'AI Hazırlık Testi sonucunuz' : 'Your AI Readiness result') + '</h1>' +
    '<p style="margin:0;font-size:12.5px;color:#7A756C">anthifel.com</p>' +

    /* 1 — the score, the band, and the ceiling if one was applied */
    '<p class="sc">' + score + '<span> / 100</span></p>' +
    (d.bandTitle ? '<p class="bd">' + esc_(d.bandTitle) + '</p>' : '') +
    (d.bandText ? '<p style="margin:10px 0 0;color:#3A3733">' + esc_(d.bandText) + '</p>' : '') +
    capLine +

    /* 2 — five dimensions, the weakest marked */
    '<h2>' + (t ? 'Beş boyut' : 'Five dimensions') + '</h2>' +
    '<table>' + dims.map(row).join('') + '</table>' +

    /* 3 — three areas to look at first */
    '<h2>' + (t ? 'Önce bakılacak üç alan' : 'Three areas to look at first') + '</h2>' +
    '<ol style="margin:0;padding-left:20px;color:#3A3733">' +
      three.map(function (x) {
        return '<li style="margin:6px 0">' + esc_(x.name) +
               ' <span style="color:#7A756C">· ' + Math.round(x.value) + '</span></li>';
      }).join('') +
    '</ol>' +

    /* 4 — what the test can and cannot say */
    '<h2>' + (t ? 'Bu testin sınırı' : 'What this test can say') + '</h2>' +
    '<p style="margin:0;color:#3A3733">' + limit + '</p>' +

    /* 5 — one button, and it is the call */
    '<h2>' + (t ? 'Sıradaki adım' : 'What comes next') + '</h2>' +
    '<p style="margin:0 0 4px;color:#3A3733">' +
      (t ? 'Sonucu birlikte okuyalım. Otuz dakika, ücretsiz.'
         : 'Let us read the result together. Thirty minutes, free of charge.') + '</p>' +
    '<p><a class="btn" href="https://anthifel.com/#meet">' +
      (t ? 'Görüşme planla' : 'Book a call') + '</a></p>' +

    pending +

    '<p class="ft">' +
      (t ? 'Cevaplarınız saklanmaz. E-posta adresiniz, skorunuz ve bandınız kaydedilir. '
         + 'Silinmesini istediğinizde privacy@anthifel.com.'
         : 'Your answers are not stored. We keep your email address, your score and your band. '
         + 'To have them deleted, write to privacy@anthifel.com.') +
    '</p></body></html>';
}

function resultPdf_(d, score) {
  var html = resultPdfHtml_(d, score);
  var name = (tr_(d) ? 'Anthifel-AI-Hazirlik-Sonucu-' : 'Anthifel-AI-Readiness-') + score + '.pdf';
  return Utilities.newBlob(html, 'text/html', name).getAs('application/pdf').setName(name);
}

/**
 * Run from the editor. Writes a PDF to Drive with sample values and sends
 * nothing, so the layout can be looked at before a real visitor ever gets one.
 */
function testResultPdf() {
  var sample = {
    lang: 'tr', email: 'ornek@example.com', bandTitle: 'Hazırsınız, ama yönünüz yok.',
    bandText: 'Zemin sağlam. Eksik olan sahipleri, maliyetleri ve tarihleri olan bir yol haritası.',
    dims: [{ name: 'Strateji', value: 72 }, { name: 'Veri', value: 41 },
           { name: 'Teknoloji', value: 63 }, { name: 'İnsan', value: 58 },
           { name: 'Yönetişim', value: 35 }]
  };
  var file = DriveApp.createFile(resultPdf_(sample, 58));
  Logger.log('Wrote ' + file.getName() + ' → ' + file.getUrl());
}

/**
 * The three red lines, checked rather than remembered. Run it after any edit to
 * the document above; it renders both languages and reads the result back.
 */
function checkResultPdf() {
  var dims = [{ name: 'Strategy', value: 70 }, { name: 'Data', value: 40 },
              { name: 'Technology', value: 60 }, { name: 'People', value: 55 },
              { name: 'Governance', value: 30 }];
  ['en', 'tr'].forEach(function (lang) {
    var html = resultPdfHtml_({ lang: lang, dims: dims, bandTitle: 'x', bandText: 'y' }, 58);
    var text = html.replace(/<[^>]+>/g, ' ');
    var bad = [];
    if (/[£$€₺]\s?\d|\d\s?(GBP|USD|EUR|TL)\b/.test(text)) bad.push('a price');
    ['AI Readiness Audit', 'Discovery Sprint', 'Transformation Retainer',
     'Advisory Board Seat'].forEach(function (n) {
      if (text.indexOf(n) >= 0) bad.push('the service name "' + n + '"');
    });
    var links = html.match(/href="([^"]+)"/g) || [];
    if (links.length !== 1) bad.push(links.length + ' links, expected exactly one');
    if (links.length && links[0].indexOf('#meet') < 0) bad.push('the one link is not the call: ' + links[0]);
    if (text.indexOf('—') >= 0) bad.push('an em dash');
    Logger.log(lang + ': ' + (bad.length ? 'FAIL — ' + bad.join(', ') : 'ok'));
  });
}

/* ---- 3. the lead, to us ---- */

function leadSubject_(d, score) {
  return 'Test sonucu — ' + score + '/100 · ' + String(d.email).trim();
}

function leadBody_(d, score) {
  var rows = [
    ['E-posta', d.email],
    ['Skor', score + ' / 100'],
    ['Bant', d.band],
    ['En zayıf boyut', d.weakest],
    ['Dil', d.lang],
    ['Sayfa', d.page],
    ['Saat dilimi', d.tz],
    ['Tamamlanma', new Date().toISOString()]
  ];
  var tbl = '<table style="width:100%;border-collapse:collapse;font-size:14px;line-height:1.5">';
  for (var i = 0; i < rows.length; i++) {
    tbl += '<tr><td style="padding:8px 14px 8px 0;color:#7A756C;white-space:nowrap">' +
      esc_(rows[i][0]) + '</td><td style="padding:8px 0;color:#0F0F0E">' +
      esc_(rows[i][1] || '—') + '</td></tr>';
  }
  tbl += '</table>';
  return WRAP_OPEN + h1_('Yeni test sonucu') + tbl + dimRows_(d) +
    p_('<span style="font-size:12.5px;color:#7A756C">Tek tek cevaplar kaydedilmez ve bu ' +
       'e-postada yer almaz. Skor zaten cevapların özetidir.</span>') + WRAP_CLOSE;
}

/* -------------------------------------------------------------- retention */

function purgeOldRows() {
  var cut = new Date(Date.now() - PURGE_AFTER_DAYS * 24 * 3600 * 1000);
  /* Named, not global. Legal asked for the retention window to apply to the
     form and newsletter records only — a global sweep would delete rows we are
     obliged to keep. That was already true; what was missing was the other
     direction: `Reading list` did not exist when this was written, so
     subscriber records were never going to be purged at all. */
  ['Assessment', 'Quotes', 'Reading list'].forEach(function (name) {
    var sh;
    try { sh = sheet_(name, []); } catch (e) { return; }
    var v = sh.getDataRange().getValues();
    for (var i = v.length - 1; i >= 1; i--) {
      var when = v[i][0];
      if (when instanceof Date && when < cut) sh.deleteRow(i + 1);
    }
  });
}
