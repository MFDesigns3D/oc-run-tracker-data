/**
 * OC Transpo Run Tracker - server side (Google Apps Script)   v4.0
 *
 * Finds which bus is on a run (e.g. 189-2), where it is, how late it is,
 * when it should reach your relief point, and where any bus number is.
 * v3: cancelled-trip warnings, hours log per pay period, schedule-based hours planning.
 *
 * Setup (one time):
 *   1. Project Settings (gear icon) -> Script Properties -> add OC_KEY = your OC Transpo primary key
 *   2. Upload octranspo_runs.json to your Google Drive (any folder)
 *   3. Deploy -> New deployment -> Web app (Execute as: Me, Who has access: Only myself)
 * Each new booking: replace octranspo_runs.json in Drive with the new one.
 *
 * v3.2 automatic schedule updates (optional):
 *   Script Properties -> add DATA_URL = the raw GitHub link to octranspo_runs.json.
 *   The app then reads the schedule from GitHub (rebuilt automatically when OC Transpo changes it)
 *   and only falls back to the Drive file if GitHub can't be reached.
 *
 * v3.3 detour alerts: reads OC Transpo's public alerts RSS feed (their live API has no alerts yet),
 *   shows alerts for the routes on your runs, and remembers which ones you paused.
 *   Run testAlerts() from the editor to see every alert and the routes it was matched to.
 */

var TZ = 'America/Toronto';
var VP_URL = 'https://nextrip-public-api.azure-api.net/octranspo/gtfs-rt-vp/beta/v1/VehiclePositions?format=json';
var TU_URL = 'https://nextrip-public-api.azure-api.net/octranspo/gtfs-rt-tp/beta/v1/TripUpdates?format=json';
var DATA_FILE = 'octranspo_runs.json';
var SERVICE_DAY_START_HOUR = 4; // before 4 am still counts as the previous service day
var REPORT_EARLY_SEC = 300;     // be at the relief point 5 min before the relief time
var NOW_OVERRIDE = null;        // testing only

/* ---------------- v4.0 web API (page hosted on GitHub Pages) ----------------
 * The page now lives at PAGE_URL (GitHub Pages) and talks to this script with fetch().
 * Every request must carry APP_KEY (Script Property). Without the right key nothing is returned.
 * This script no longer serves the page itself, so there is no Apps Script banner.
 *
 * Setup (one time, after pasting this file):
 *   Script Properties -> add APP_KEY  = a long random password (the page asks for it once)
 *   Script Properties -> add PAGE_URL = https://mfdesigns3d.github.io/oc-run-tracker-data/  (optional)
 *   Deploy -> Manage deployments -> edit -> Who has access: Anyone -> Deploy (same /exec URL)
 */
var API_FUNCS = {
  getRuns: getRuns, getBuses: getBuses, getStops: getStops,
  getSettings: getSettings, saveSettings: saveSettings,
  getLog: getLog, saveLog: saveLog, planDays: planDays,
  getAlerts: getAlerts, saveDetourPauses: saveDetourPauses,
  ping: function () { return { ok: true, version: '4.0' }; }
};

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.fn) return api_(p.fn, p.k, p.a ? JSON.parse(p.a) : []);
  var page = PropertiesService.getScriptProperties().getProperty('PAGE_URL') ||
    'https://mfdesigns3d.github.io/oc-run-tracker-data/';
  return HtmlService.createHtmlOutput(
    '<p style="font:16px sans-serif">Run Tracker has moved: <a target="_top" href="' + page + '">' + page + '</a></p>')
    .setTitle('Run Tracker');
}

function doPost(e) {
  var b;
  try { b = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'Bad request' }); }
  return api_(b.fn, b.k, b.a || []);
}

function api_(fn, key, args) {
  var want = PropertiesService.getScriptProperties().getProperty('APP_KEY');
  if (!want) return json_({ ok: false, error: 'APP_KEY is not set in Script Properties', code: 'nokey' });
  if (String(key || '') !== want) return json_({ ok: false, error: 'Wrong app key', code: 'badkey' });
  if (!Object.prototype.hasOwnProperty.call(API_FUNCS, fn)) return json_({ ok: false, error: 'Unknown function' });
  try {
    return json_({ ok: true, result: API_FUNCS[fn].apply(null, args || []) });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/** Run once from the editor: makes a random APP_KEY (if none) and logs it so you can copy it. */
function makeAppKey() {
  var sp = PropertiesService.getScriptProperties();
  var k = sp.getProperty('APP_KEY');
  if (!k) {
    k = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
    sp.setProperty('APP_KEY', k);
  }
  Logger.log('APP_KEY = ' + k);
}

/* ---------------- time helpers ---------------- */

/** Epoch seconds of "noon minus 12 h" for a service date (the GTFS definition of a service day's 00:00). */
function dayZero_(ymd) {
  var noon = Utilities.parseDate(ymd + ' 12:00', TZ, 'yyyyMMdd HH:mm');
  return Math.floor(noon.getTime() / 1000) - 43200;
}

function nowInfo_() {
  var now = NOW_OVERRIDE || new Date();
  var p = Utilities.formatDate(now, TZ, 'yyyyMMdd|HH').split('|');
  var nowSec = Math.floor(now.getTime() / 1000);
  var ymd = p[0];
  if (+p[1] < SERVICE_DAY_START_HOUR) ymd = Utilities.formatDate(new Date(now.getTime() - 86400000), TZ, 'yyyyMMdd');
  return { nowSec: nowSec, ymd: ymd, mid: dayZero_(ymd) };
}

function hhmm_(sec) {
  sec = ((sec % 86400) + 86400) % 86400;
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
}

function hhmmss_(sec) {
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}

function parseHHMM_(t) {
  if (!t) return null;
  var m = String(t).trim().match(/^(\d{1,2})[:h.]?(\d{2})$/);
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60;
}

function cleanYmd_(s) {
  if (!s) return null;
  s = String(s).replace(/-/g, '');
  return /^\d{8}$/.test(s) ? s : null;
}

/** GTFS-rt trip ScheduleRelationship: 3 = CANCELED, 7 = DELETED. */
function isCancelled_(rel) {
  return rel === 3 || rel === 7 || rel === 'CANCELED' || rel === 'DELETED';
}

/* ---------------- run number handling ---------------- */

function pad_(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }

/** "189-2", "189 2", "189/2", "189002" -> candidate schedule run ids */
function runCandidates_(input) {
  var s = String(input || '').trim().toUpperCase().replace(/\s+/g, ' ');
  var m;
  if ((m = s.match(/^(\d{3})(\d{3})$/))) {
    return [parseInt(m[1], 10) + '-' + pad_(parseInt(m[2], 10), 2)];
  }
  if ((m = s.match(/^(\d+)\s*[-\/ ]\s*(\d+)$/))) {
    var r = parseInt(m[1], 10), n = parseInt(m[2], 10);
    return [r + '-' + pad_(n, 2), r + '-' + pad_(n, 3), r + '-' + n];
  }
  return [s];
}

/* ---------------- schedule data (from Drive) ---------------- */

var DATA_MEMO_ = null;

function dataFile_() {
  var it = DriveApp.getFilesByName(DATA_FILE);
  if (!it.hasNext()) throw new Error('Schedule file "' + DATA_FILE + '" not found in your Google Drive.');
  var newest = null;
  while (it.hasNext()) {
    var f = it.next();
    if (f.isTrashed && f.isTrashed()) continue;
    if (!newest || f.getLastUpdated() > newest.getLastUpdated()) newest = f;
  }
  if (!newest) throw new Error('Schedule file "' + DATA_FILE + '" not found in your Google Drive.');
  return newest;
}

/** Raw GitHub link to octranspo_runs.json (Script Property DATA_URL), or '' to use Drive only. */
function dataUrl_() {
  var u = PropertiesService.getScriptProperties().getProperty('DATA_URL');
  return u ? u.trim() : '';
}

/** Build id of the GitHub copy (from version.txt next to it), or null if it can't be reached. */
function remoteBuild_() {
  var u = dataUrl_();
  if (!u) return null;
  try {
    var r = UrlFetchApp.fetch(u.replace(/[^\/?#]+([?#].*)?$/, 'version.txt') + '?t=' + Date.now(), { muteHttpExceptions: true });
    var b = r.getResponseCode() === 200 ? r.getContentText().trim() : '';
    return /^[0-9a-f]{6,40}$/.test(b) ? b : null;
  } catch (e) { return null; }
}

function dataStamp_() {
  var cache = CacheService.getScriptCache();
  var st = cache.get('dataStamp');
  if (st) return st;
  var b = remoteBuild_();
  if (b) {
    st = 'gh@' + b;
    cache.put('dataStamp', st, 600);
    return st;
  }
  var f = dataFile_();
  st = f.getId() + '@' + f.getLastUpdated().getTime();
  cache.put('dataStamp', st, 600);
  return st;
}

function data_() {
  if (!DATA_MEMO_) {
    var stamp = dataStamp_(), d = null;
    if (stamp.indexOf('gh@') === 0) {
      // A new link per build, so GitHub never hands back an old cached copy.
      try {
        var r = UrlFetchApp.fetch(dataUrl_() + '?b=' + stamp.slice(3), { muteHttpExceptions: true });
        if (r.getResponseCode() === 200) d = JSON.parse(r.getContentText('UTF-8'));
      } catch (e) { d = null; }
      if (d && d.build !== stamp.slice(3)) d = null;
      if (!d) CacheService.getScriptCache().remove('dataStamp');   // try GitHub again next time
    }
    if (!d) d = JSON.parse(dataFile_().getBlob().getDataAsString());
    if (d.fmt !== 2) throw new Error('Old schedule file in Drive. Replace octranspo_runs.json with the new one.');
    DATA_MEMO_ = d;
  }
  return DATA_MEMO_;
}

/** Service indexes running on a date, from the data file. */
function servicesOn_(d, ymd) {
  var on = {};
  d.services.forEach(function (dates, i) { if (dates.indexOf(ymd) >= 0) on[i] = 1; });
  return on;
}

/** All trips of one run on one service date, sorted by start time. Cached 6 h. */
function runSlice_(input, ymd) {
  var cache = CacheService.getScriptCache();
  var stamp = dataStamp_();
  var cands = runCandidates_(input);
  for (var c = 0; c < cands.length; c++) {
    var hit = cache.get('blk|' + stamp + '|' + cands[c] + '|' + ymd);
    if (hit) return JSON.parse(hit);
  }
  var d = data_();
  var info = { feedFrom: d.from, feedTo: d.to, version: d.v };
  if (ymd < d.from || ymd > d.to) return { run: null, trips: [], info: info, outOfRange: true };
  var on = servicesOn_(d, ymd);
  var byBlock = {};
  for (var c2 = 0; c2 < cands.length; c2++) byBlock[cands[c2]] = [];
  for (var k in d.trips) {
    var t = d.trips[k];
    if (!byBlock[t[0]]) continue;
    for (var s = 0; s < t[3].length; s++) if (on[t[3][s]]) { byBlock[t[0]].push([k, t]); break; }
  }
  for (var c3 = 0; c3 < cands.length; c3++) {
    var list = byBlock[cands[c3]];
    if (!list.length) continue;
    list.sort(function (a, b) { return a[1][4] - b[1][4]; });
    var trips = list.map(function (e) {
      var t = e[1];
      return {
        k: e[0], r: t[1], h: t[2], t0: t[4],
        s: t[5].map(function (i) { return d.stopIds[i]; }),
        n: t[5].map(function (i) { return d.stopNames[i]; }),
        o: t[6]
      };
    });
    var slice = { run: cands[c3], trips: trips, info: info };
    try { cache.put('blk|' + stamp + '|' + cands[c3] + '|' + ymd, JSON.stringify(slice), 21600); } catch (e) {}
    return slice;
  }
  return { run: null, trips: [], info: info, tried: cands };
}

/** Which run a live trip id belongs to (cached 6 h per trip). */
function runOfTrip_(tripId) {
  if (!tripId) return null;
  var cache = CacheService.getScriptCache();
  var stamp = dataStamp_();
  var ck = 'tb|' + stamp + '|' + tripId;
  var hit = cache.get(ck);
  if (hit !== null) return hit || null;
  var d = data_();
  var t = d.trips[tripId] || (tripId.length > 3 ? d.trips[tripId.slice(0, -3)] : null);
  var run = t ? t[0] : '';
  try { cache.put(ck, run, 21600); } catch (e) {}
  return run || null;
}

/* ---------------- live feeds ---------------- */

function apiKey_() {
  var k = PropertiesService.getScriptProperties().getProperty('OC_KEY');
  if (!k) throw new Error('API key missing. Add OC_KEY in Project Settings -> Script Properties.');
  return k.trim();
}

function fetchJson_(url) {
  var res = UrlFetchApp.fetch(url, {
    headers: { 'Ocp-Apim-Subscription-Key': apiKey_() },
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code === 401) throw new Error('OC Transpo rejected the API key (401). Check OC_KEY.');
  if (code !== 200) throw new Error('OC Transpo feed error ' + code);
  return JSON.parse(res.getContentText());
}

/** Compact vehicle list, cached 15 s. */
function vehicles_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('vp');
  if (hit) return JSON.parse(hit);
  var j = fetchJson_(VP_URL);
  var out = { ts: j.Header && j.Header.Timestamp, v: [] };
  (j.Entity || []).forEach(function (e) {
    var v = e.Vehicle;
    if (!v || !v.Vehicle || !v.Position) return;
    var tr = v.Trip;
    out.v.push({
      id: v.Vehicle.Id,
      t: tr && tr.HasTripId ? tr.TripId : '',
      r: tr && tr.HasRouteId ? tr.RouteId : '',
      st: tr && tr.HasStartTime ? tr.StartTime : '',
      sd: tr && tr.HasStartDate ? tr.StartDate : '',
      la: v.Position.Latitude, lo: v.Position.Longitude,
      b: v.Position.HasBearing ? v.Position.Bearing : null,
      sp: v.Position.HasSpeed ? v.Position.Speed : null,
      ts: v.Timestamp
    });
  });
  try { cache.put('vp', JSON.stringify(out), 15); } catch (e) {}
  return out;
}

/** Predicted stop times for the given trip keys only. */
function tripUpdates_(keySet) {
  var j = fetchJson_(TU_URL);
  var out = {};
  (j.Entity || []).forEach(function (e) {
    var tu = e.TripUpdate;
    if (!tu || !tu.Trip || !tu.Trip.HasTripId) return;
    var k = matchKey_(tu.Trip.TripId, keySet);
    if (!k) return;
    var arr = [];
    (tu.StopTimeUpdate || []).forEach(function (u) {
      var ev = (u.Arrival && u.Arrival.HasTime) ? u.Arrival : (u.Departure && u.Departure.HasTime ? u.Departure : null);
      if (ev && u.HasStopId) arr.push([u.StopId, ev.Time, u.ScheduleRelationship]);
    });
    out[k] = { sd: tu.Trip.StartDate, rel: tu.Trip.ScheduleRelationship, u: arr };
  });
  return out;
}

function matchKey_(tripId, keySet) {
  if (!tripId) return null;
  if (keySet[tripId]) return tripId;
  if (tripId.length > 3) {
    var b = tripId.slice(0, -3);
    if (keySet[b]) return b;
  }
  return null;
}

/* ---------------- API used by the page ---------------- */

/**
 * runs: [{run:'189-2', relief:'17:15'}, ...]
 * ymd (optional, 'yyyyMMdd' or 'yyyy-MM-dd'): service date. Live data only for today.
 */
function getRuns(runs, ymd) {
  var T = nowInfo_();
  var day = cleanYmd_(ymd) || T.ymd;
  var live = day === T.ymd;
  var D = { nowSec: T.nowSec, ymd: day, mid: dayZero_(day), live: live };
  var out = { now: T.nowSec, serviceDate: T.ymd, date: day, live: live, results: [] };

  var slices = runs.map(function (q) {
    try { return runSlice_(q.run, day); } catch (e) { return { err: String(e.message || e) }; }
  });

  var vp = null, feedErr = null, tu = {};
  if (live) {
    try { vp = vehicles_(); } catch (e) { feedErr = String(e.message || e); }
    // One trip-updates download covers every run on screen, only when useful.
    var keySet = {}, needTU = false;
    slices.forEach(function (sl) {
      if (!sl.trips || !sl.trips.length) return;
      var first = D.mid + sl.trips[0].t0;
      var lastT = sl.trips[sl.trips.length - 1];
      var last = D.mid + lastT.t0 + lastT.o[lastT.o.length - 1];
      if (D.nowSec > first - 2 * 3600 && D.nowSec < last + 1800) {
        needTU = true;
        sl.trips.forEach(function (t) { keySet[t.k] = 1; });
      }
    });
    if (needTU && vp) {
      try { tu = tripUpdates_(keySet); } catch (e) { feedErr = String(e.message || e); }
    }
  }
  runs.forEach(function (q, i) {
    out.results.push(buildResult_(q, slices[i], vp, tu, D, feedErr));
  });
  return out;
}

/** Look up bus numbers: where they are, and what run they're on (if any). */
function getBuses(ids) {
  var T = nowInfo_();
  var out = { now: T.nowSec, serviceDate: T.ymd, results: [] };
  var vp;
  try { vp = vehicles_(); } catch (e) {
    ids.forEach(function (id) { out.results.push({ id: String(id), error: String(e.message || e) }); });
    return out;
  }
  ids.forEach(function (raw) {
    var id = String(raw).trim().replace(/^#/, '');
    var v = null;
    for (var i = 0; i < vp.v.length; i++) if (String(vp.v[i].id) === id) { v = vp.v[i]; break; }
    var r = { id: id };
    if (!v) { r.found = false; out.results.push(r); return; }
    r.found = true;
    r.bus = { id: v.id, lat: v.la, lon: v.lo, bearing: v.b, speed: v.sp, age: v.ts ? Math.max(0, T.nowSec - v.ts) : null };
    var run = null;
    try { run = v.t ? runOfTrip_(v.t) : null; } catch (e) { r.dataErr = String(e.message || e); }
    if (run) {
      r.run = run;
      try {
        var rr = getRuns([{ run: run }], T.ymd).results[0];
        // Only trust it if the run's tracker also sees this same bus.
        r.runResult = rr;
        if (!rr.bus || String(rr.bus.id) !== id) r.mismatch = true;
      } catch (e2) { r.dataErr = String(e2.message || e2); }
    }
    r.inService = !!(r.runResult && r.runResult.status === 'on_trip' && !r.mismatch);
    out.results.push(r);
  });
  return out;
}

/** Stop list for the map and "nearest stop". The page keeps a copy until the schedule changes. */
function getStops(haveStamp) {
  var stamp = dataStamp_();
  if (haveStamp === stamp) return { stamp: stamp, same: true };
  var d = data_();
  return { stamp: stamp, ids: d.stopIds, names: d.stopNames, lat: d.stopLat, lon: d.stopLon };
}

/** Your saved work (booking, weekly, holidays, pay rates). Stored in your Google account so phone and laptop match. */
function getSettings() {
  var s = PropertiesService.getUserProperties().getProperty('settings');
  return s ? JSON.parse(s) : null;
}

function saveSettings(obj) {
  var s = JSON.stringify(obj);
  if (s.length > 8500) throw new Error('Too many saved runs to store.');
  PropertiesService.getUserProperties().setProperty('settings', s);
  return true;
}

/* ---------------- hours log (one record per 2-week pay period) ---------------- */

/** periodStart: 'yyyy-MM-dd' (the Sunday that starts Week 1). */
function getLog(periodStart) {
  var s = PropertiesService.getUserProperties().getProperty('log_' + periodStart);
  return s ? JSON.parse(s) : null;
}

function saveLog(periodStart, obj) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(periodStart))) throw new Error('Bad pay period date.');
  var s = JSON.stringify(obj);
  if (s.length > 9000) throw new Error('This pay period has too much saved text. Shorten some notes.');
  PropertiesService.getUserProperties().setProperty('log_' + periodStart, s);
  return true;
}

/**
 * Planned hours from the schedule.
 * days: [{date:'2026-10-22', pieces:[{run:'6-9', relief:'10:10', finish:'14:20'}]}]
 * For each piece: start = relief - 5 min (or the run's first trip if no relief),
 * finish = typed finish (or the run's last trip end), routes driven in between.
 */
function planDays(days) {
  var d = data_();
  var want = {};
  days.forEach(function (day) {
    (day.pieces || []).forEach(function (p) { runCandidates_(p.run).forEach(function (c) { want[c] = 1; }); });
  });
  var byRun = {};
  for (var k in d.trips) {
    var t = d.trips[k];
    if (want[t[0]]) (byRun[t[0]] = byRun[t[0]] || []).push(t);
  }
  var svc = {};
  return days.map(function (day) {
    var ymd = cleanYmd_(day.date);
    if (!svc[ymd]) svc[ymd] = (ymd && ymd >= d.from && ymd <= d.to) ? servicesOn_(d, ymd) : {};
    var on = svc[ymd];
    return {
      date: day.date,
      pieces: (day.pieces || []).map(function (p) {
        var cands = runCandidates_(p.run), trips = [];
        for (var c = 0; c < cands.length && !trips.length; c++) {
          trips = (byRun[cands[c]] || []).filter(function (t) {
            for (var s = 0; s < t[3].length; s++) if (on[t[3][s]]) return true;
            return false;
          });
        }
        trips.sort(function (a, b) { return a[4] - b[4]; });
        return planPiece_(p, trips);
      })
    };
  });
}

function planPiece_(p, trips) {
  var out = { run: p.run, routes: [] };
  var rSec = parseHHMM_(p.relief), fSec = parseHHMM_(p.finish);
  var late = SERVICE_DAY_START_HOUR * 3600;
  if (rSec !== null && rSec < late) rSec += 86400;  // after midnight, same service day
  if (fSec !== null && fSec < late) fSec += 86400;
  if (!trips.length) {
    out.noSchedule = true;
    if (rSec !== null) out.start = hhmm_(rSec - REPORT_EARLY_SEC);
    if (fSec !== null) out.finish = hhmm_(fSec);
    return out;
  }
  var startSec = rSec !== null ? rSec - REPORT_EARLY_SEC : trips[0][4];
  var last = trips[trips.length - 1];
  var endSec = fSec !== null ? fSec : last[4] + last[6][last[6].length - 1];
  trips.forEach(function (t) {
    var a = t[4], b = t[4] + t[6][t[6].length - 1];
    if (b > startSec + REPORT_EARLY_SEC && a < endSec && out.routes.indexOf(t[1]) < 0) out.routes.push(t[1]);
  });
  out.start = hhmm_(startSec);
  out.finish = hhmm_(endSec);
  out.finishFromSchedule = fSec === null;
  return out;
}

/* ---------------- detour alerts (OC Transpo alerts RSS) ---------------- */

var ALERTS_URL = 'https://www.octranspo.com/en/feeds/updates-en/';
var ALERTS_CACHE_SEC = 600;      // check OC Transpo at most every 10 min
var ALERT_TEXT_MAX = 1500;       // characters of detail text kept per alert

function decodeEntities_(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(+n); })
    .replace(/&#x([0-9a-f]+);/gi, function (m, n) { return String.fromCharCode(parseInt(n, 16)); })
    .replace(/&nbsp;/g, ' ').replace(/&rsquo;|&lsquo;/g, "'").replace(/&rdquo;|&ldquo;/g, '"')
    .replace(/&ndash;/g, '\u2013').replace(/&mdash;/g, '\u2014').replace(/&eacute;/g, '\u00e9').replace(/&egrave;/g, '\u00e8')
    .replace(/&agrave;/g, '\u00e0').replace(/&ccedil;/g, '\u00e7').replace(/&ocirc;/g, '\u00f4').replace(/&hellip;/g, '\u2026')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Raw contents of the first <name> tag in an RSS item (CDATA unwrapped, entities decoded if not CDATA). */
function rssTag_(blk, name) {
  var m = blk.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i'));
  return m ? rssVal_(m[1]) : '';
}
function rssTags_(blk, name) {
  var re = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'gi'), m, out = [];
  while ((m = re.exec(blk))) out.push(rssVal_(m[1]));
  return out;
}
function rssVal_(s) {
  s = String(s).trim();
  if (/<!\[CDATA\[/.test(s)) return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
  return decodeEntities_(s).trim();
}

/** HTML -> readable plain text with line breaks. */
function htmlToText_(h) {
  return decodeEntities_(String(h || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n\u2022 ')
    .replace(/<\/(p|div|h\d|li|ul|ol|tr|table)>/gi, '\n')
    .replace(/<(p|div|h\d)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .split('\n').map(function (l) { return l.replace(/[ \t\u00a0]+/g, ' ').trim(); })
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function normRoute_(r) { return String(r == null ? '' : r).trim().toUpperCase().replace(/^0+(?=\d)/, ''); }

/** Route numbers an alert mentions: categories, "Route(s) 7, 10 and 48", and detour lines like "161 Terry Fox:". */
function alertRoutes_(title, text, cats) {
  var set = {}, m;
  function addList(s) { (String(s).match(/\d{1,3}(?!\d)/g) || []).forEach(function (n) { set[normRoute_(n)] = 1; }); }
  cats.forEach(function (c) {
    if (/^\s*\d{1,3}\s*$/.test(c)) set[normRoute_(c)] = 1;
    else if ((m = c.match(/^\s*(?:Routes?|Lines?|Circuits?|Lignes?)\s*:?\s*([\d,\s&et]+)/i))) addList(m[1]);
  });
  var re = /\b(?:Routes?|Lines?)\s*:?\s*((?:\d{1,3}(?!\d)\s*(?:,|and|&|\/)?\s*)+)/gi;
  [title, text].forEach(function (s) { re.lastIndex = 0; while ((m = re.exec(s))) addList(m[1]); });
  var re2 = /(?:^|\n)\s*(\d{1,3})\s+[A-Za-z\u00c0-\u00ff'\u2019.\-][A-Za-z\u00c0-\u00ff'\u2019.\- ]{1,40}:/g;   // "161 Terry Fox: From Teron..."
  while ((m = re2.exec(text))) set[normRoute_(m[1])] = 1;
  return Object.keys(set).sort(function (a, b) { return (parseInt(a, 10) - parseInt(b, 10)) || (a < b ? -1 : 1); });
}

/** Every alert in the RSS feed, parsed. */
function parseAlerts_(xml) {
  var items = [], re = /<item[\s>][\s\S]*?<\/item>/gi, m;
  while ((m = re.exec(xml))) {
    var blk = m[0];
    var title = htmlToText_(rssTag_(blk, 'title')).replace(/\s+/g, ' ');
    var link = rssTag_(blk, 'link'), guid = rssTag_(blk, 'guid'), pub = rssTag_(blk, 'pubDate');
    var html = rssTag_(blk, 'content:encoded') || rssTag_(blk, 'description');
    var text = htmlToText_(html);
    var routes = alertRoutes_(title, text, rssTags_(blk, 'category'));
    var date = pub ? Date.parse(pub) : NaN;
    var dig = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, title + '|' + pub + '|' + text, Utilities.Charset.UTF_8);
    var h = dig.slice(0, 5).map(function (b) { return ((b + 256) % 256 + 256).toString(16).slice(1); }).join('');
    if (text.length > ALERT_TEXT_MAX) text = text.slice(0, ALERT_TEXT_MAX).replace(/\s+\S*$/, '') + ' \u2026';
    items.push({
      id: (guid || link || title).slice(0, 200),
      title: title, link: /^https?:\/\//i.test(link) ? link : '',
      date: isNaN(date) ? null : date, pub: pub,
      routes: routes, text: text, h: h,
      detour: /detour|d\u00e9viation|reroute/i.test(title)
    });
  }
  return items;
}

/** The parsed alerts feed, cached 10 min. */
function alerts_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('alerts3');
  if (hit) return JSON.parse(hit);
  var res = UrlFetchApp.fetch(ALERTS_URL, {
    muteHttpExceptions: true, followRedirects: true,
    headers: { 'Accept': 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5' }
  });
  var code = res.getResponseCode(), body = res.getContentText('UTF-8');
  if (code !== 200) throw new Error('OC Transpo alerts feed answered ' + code);
  if (!/<rss|<channel|<feed/i.test(body)) throw new Error('OC Transpo alerts feed sent a web page instead of alerts (it may be blocking Google).');
  var out = { ts: Date.now(), items: parseAlerts_(body) };
  var s = JSON.stringify(out);
  if (s.length > 95000) {   // cache limit 100 KB: shorten detail text
    out.items.forEach(function (it) { if (it.text.length > 400) it.text = it.text.slice(0, 400) + ' \u2026'; });
    s = JSON.stringify(out);
  }
  try { cache.put('alerts3', s, ALERTS_CACHE_SEC); } catch (e) {}
  return out;
}

function pauses_() {
  var s = PropertiesService.getUserProperties().getProperty('detourPause');
  try { return s ? JSON.parse(s) : {}; } catch (e) { return {}; }
}

/** Paused alerts: {alertId: {t: 'yyyy-MM-dd' (paused through that day) or 'x' (until it changes), h: version}}. */
function saveDetourPauses(obj) {
  var s = JSON.stringify(obj || {});
  if (s.length > 8500) throw new Error('Too many paused alerts to store. Unpause some.');
  PropertiesService.getUserProperties().setProperty('detourPause', s);
  return true;
}

/**
 * Alerts that mention any of these routes. routes: ['6', '189'].
 * Also returns your paused list (alerts OC Transpo has removed are dropped from it).
 */
function getAlerts(routes) {
  var want = {};
  (routes || []).forEach(function (r) { want[normRoute_(r)] = 1; });
  var out = { items: [] }, a;
  try { a = alerts_(); } catch (e) { out.error = String(e.message || e); out.pauses = pauses_(); return out; }
  out.checked = a.ts;
  a.items.forEach(function (it) {
    if (it.routes.some(function (r) { return want[r]; })) out.items.push(it);
  });
  out.items.sort(function (x, y) { return (y.detour - x.detour) || ((y.date || 0) - (x.date || 0)); });
  var p = pauses_(), live = {}, changed = false;
  if (a.items.length) {
    a.items.forEach(function (it) { live[it.id] = 1; });
    for (var k in p) if (!live[k]) { delete p[k]; changed = true; }
    if (changed) try { saveDetourPauses(p); } catch (e) {}
  }
  out.pauses = p;
  return out;
}

/** Run from the editor: lists every alert in OC Transpo's feed and the routes it was matched to. */
function testAlerts() {
  CacheService.getScriptCache().remove('alerts3');
  var a = alerts_();
  Logger.log('Alerts feed OK: ' + a.items.length + ' alerts (' + a.items.filter(function (i) { return i.detour; }).length + ' detours)');
  a.items.forEach(function (it) {
    Logger.log((it.detour ? '[DETOUR] ' : '[notice] ') + it.title + '\n    routes: ' + (it.routes.join(', ') || 'none found') +
      ' | posted ' + (it.pub || '?') + ' | ' + it.text.length + ' chars of detail');
  });
}

/* ---------------- building one run's answer ---------------- */

function buildResult_(q, sl, vp, tu, D, feedErr) {
  var res = { input: q.run, reliefInput: q.relief || '', date: D.ymd, live: D.live };
  if (sl.err) { res.error = sl.err; return res; }
  if (!sl.trips.length) {
    var f = sl.info.feedFrom, t2 = sl.info.feedTo;
    res.error = sl.outOfRange
      ? 'The loaded schedule only covers ' + f + ' to ' + t2 + '. Load the new booking\'s schedule to look up that date.'
      : 'No run "' + q.run + '" scheduled on that day.';
    if (!sl.outOfRange) res.noRun = true;
    return res;
  }
  res.run = sl.run;
  res.feed = sl.info;
  res.feedErr = feedErr || null;
  var trips = sl.trips;
  var keySet = {};
  trips.forEach(function (t) { keySet[t.k] = 1; });

  // Schedule summary
  res.trips = trips.map(function (t, i) {
    var endSec = t.t0 + t.o[t.o.length - 1];
    return {
      i: i, route: t.r, head: t.h,
      start: hhmm_(t.t0), end: hhmm_(endSec),
      from: t.n[0], to: t.n[t.n.length - 1],
      fromId: t.s[0], toId: t.s[t.s.length - 1],
      startEpoch: D.mid + t.t0, endEpoch: D.mid + endSec
    };
  });

  // --- relief point (works for any date) ---
  var rSec = parseHHMM_(q.relief);
  var hit = null;
  if (rSec !== null) {
    // Closest timepoint to the relief time (exact match wins; on a tie, the later trip).
    var bestD = 601;
    trips.forEach(function (tt, ti) {
      tt.o.forEach(function (o, si) {
        var sec = tt.t0 + o, dd = Math.abs(sec - rSec);
        if (dd < bestD || (dd === bestD && hit && ti > hit.ti)) {
          bestD = dd; hit = { ti: ti, si: si, sec: sec, approx: dd > 60 };
        }
      });
    });
    if (hit) {
      var rt = trips[hit.ti];
      res.relief = {
        name: rt.n[hit.si], stopId: rt.s[hit.si], sched: hhmm_(hit.sec), schedEpoch: D.mid + hit.sec,
        trip: hit.ti, route: rt.r, head: rt.h, approx: !!hit.approx
      };
    } else {
      res.reliefNote = 'No timepoint on this run near ' + q.relief + '.';
    }
  }

  if (!D.live) { res.status = 'schedule'; return res; }

  // --- cancelled trips on this run (from OC Transpo trip updates) ---
  res.cancelled = [];
  trips.forEach(function (tt, i) {
    var x = tu[tt.k];
    if (x && isCancelled_(x.rel)) {
      res.trips[i].cx = true;
      if (res.trips[i].endEpoch > D.nowSec) res.cancelled.push(i);
    }
  });

  // --- find the bus ---
  var bus = null, busTrip = -1;
  if (vp) {
    var best = null;
    vp.v.forEach(function (v) {
      if (!v.t) return;
      if (v.sd && v.sd !== D.ymd) return;
      var k = matchKey_(v.t, keySet);
      var idx = -1;
      // Exact trip match only. (Matching on route + start time grabbed buses from other runs.)
      if (k) {
        for (var i = 0; i < trips.length; i++) if (trips[i].k === k) { idx = i; break; }
      }
      if (idx < 0) return;
      if (!best || idx > best.idx || (idx === best.idx && v.ts > best.v.ts)) best = { v: v, idx: idx };
    });
    var cache = CacheService.getScriptCache();
    var lastKey = 'last|' + sl.run + '|' + D.ymd;
    if (best) {
      bus = best.v; busTrip = best.idx;
      try { cache.put(lastKey, JSON.stringify({ id: bus.id, idx: busTrip }), 21600); } catch (e) {}
    } else {
      var last = cache.get(lastKey);
      if (last) {
        last = JSON.parse(last);
        for (var m = 0; m < vp.v.length; m++) {
          var cand = vp.v[m];
          if (cand.id !== last.id) continue;
          if (cand.t && !matchKey_(cand.t, keySet)) break; // now on someone else's trip
          bus = cand; res.lastTrip = last.idx;
          break;
        }
      }
    }
  }

  if (bus) {
    res.bus = {
      id: bus.id, lat: bus.la, lon: bus.lo, bearing: bus.b, speed: bus.sp,
      age: bus.ts ? Math.max(0, D.nowSec - bus.ts) : null,
      onTrip: busTrip >= 0
    };
  }
  res.curTrip = busTrip;

  // --- delay + next timepoint on the current trip ---
  if (busTrip >= 0 && tu[trips[busTrip].k]) {
    var t = trips[busTrip], u = tu[trips[busTrip].k].u;
    var schedByStop = {};
    for (var a = 0; a < t.s.length; a++) {
      if (!(t.s[a] in schedByStop)) schedByStop[t.s[a]] = { sec: D.mid + t.t0 + t.o[a], name: t.n[a], id: t.s[a] };
    }
    for (var b = 0; b < u.length; b++) {
      var sc = schedByStop[u[b][0]];
      if (!sc) continue;
      if (u[b][1] < D.nowSec - 30) continue;
      res.delay = u[b][1] - sc.sec;
      res.next = { name: sc.name, stopId: sc.id, sched: hhmm_(sc.sec - D.mid), pred: hhmm_(u[b][1] - D.mid), predEpoch: u[b][1] };
      break;
    }
    res.curStops = t.s; // timepoints of the current trip, for the map
  }

  // --- live prediction for the relief ---
  if (res.relief) {
    var rtu = tu[trips[res.relief.trip].k];
    if (rtu) {
      for (var z = 0; z < rtu.u.length; z++) {
        if (rtu.u[z][0] === res.relief.stopId) {
          res.relief.pred = hhmm_(rtu.u[z][1] - D.mid);
          res.relief.predEpoch = rtu.u[z][1];
          break;
        }
      }
      if (isCancelled_(rtu.rel)) res.relief.cancelled = true;
    }
  }

  // A bus keeps reporting its last trip for a while after finishing it.
  if (bus && busTrip >= 0 && !res.next && D.nowSec > res.trips[busTrip].endEpoch + 120) {
    res.lastTrip = busTrip;
    busTrip = -1;
    res.curTrip = -1;
    res.bus.onTrip = false;
    delete res.curStops;
  }

  // --- plain-language status ---
  var firstStart = res.trips[0].startEpoch;
  var lastEnd = res.trips[res.trips.length - 1].endEpoch;
  if (bus && busTrip >= 0) res.status = 'on_trip';
  else if (bus) res.status = 'between_trips';
  else if (D.nowSec < firstStart - 900) res.status = 'not_out';
  else if (D.nowSec > lastEnd) res.status = 'done';
  else {
    // Scheduled gap between two trips? (the feed doesn't tie a bus to a run during layover)
    var prev = null, nxt = null;
    for (var g = 0; g < res.trips.length; g++) {
      if (res.trips[g].endEpoch <= D.nowSec) prev = res.trips[g];
      else if (res.trips[g].startEpoch > D.nowSec) { nxt = res.trips[g]; break; }
      else break; // a trip should be running now
    }
    if (prev && nxt && res.trips.indexOf(nxt) === res.trips.indexOf(prev) + 1) {
      res.status = 'layover';
      res.layover = { from: prev.to, until: nxt.start, nextRoute: nxt.route, nextFrom: nxt.from, nextTrip: nxt.i };
      // Look where the next trip starts; only look where the last one ended for the first 10 minutes.
      var guess = layoverGuess_(nxt.fromId, vp, D.nowSec) ||
        (D.nowSec - prev.endEpoch < 600 ? layoverGuess_(prev.toId, vp, D.nowSec) : null);
      if (guess) {
        res.likely = { id: guess.v.id, m: guess.m };
        res.bus = { id: guess.v.id, lat: guess.v.la, lon: guess.v.lo, bearing: guess.v.b, speed: guess.v.sp,
          age: guess.v.ts ? Math.max(0, D.nowSec - guess.v.ts) : null, onTrip: false, likely: true };
      }
    } else {
      res.status = 'no_gps';
    }
  }
  return res;
}

/** Closest out-of-service bus within 400 m of a stop. */
function layoverGuess_(stopId, vp, nowSec) {
  if (!vp) return null;
  var d;
  try { d = data_(); } catch (e) { return null; }
  var i = d.stopIds.indexOf(stopId);
  if (i < 0) return null;
  var pts = [[d.stopLat[i], d.stopLon[i]]];
  var best = null;
  vp.v.forEach(function (v) {
    if (v.t) return;                                  // already on someone's trip
    if (v.ts && nowSec - v.ts > 600) return;          // stale GPS
    pts.forEach(function (p) {
      var kx = Math.cos(p[0] * Math.PI / 180);
      var dy = (v.la - p[0]) * 111320, dx = (v.lo - p[1]) * 111320 * kx;
      var m = Math.sqrt(dx * dx + dy * dy);
      if (m <= 400 && (!best || m < best.m)) best = { v: v, m: Math.round(m) };
    });
  });
  return best;
}

/** Run once from the editor to check setup. Look at the Execution log. */
function testSetup() {
  Logger.log('Key present: ' + !!PropertiesService.getScriptProperties().getProperty('OC_KEY'));
  Logger.log('GitHub schedule: ' + (dataUrl_() ? (remoteBuild_() ? 'OK, build ' + remoteBuild_() : 'NOT reachable (check DATA_URL)') : 'not set up (using Drive)'));
  try {
    var f = dataFile_();
    Logger.log('Drive backup file: ' + f.getName() + ' (' + Math.round(f.getSize() / 1024) + ' KB)');
  } catch (e) { Logger.log('Drive backup file: none'); }
  var d = data_();
  Logger.log('Schedule in use: ' + (d.build ? 'build ' + d.build : 'Drive file'));
  Logger.log('Schedule valid ' + d.from + ' to ' + d.to + ', ' + Object.keys(d.trips).length + ' trips (format ' + d.fmt + ')');
  var vp = vehicles_();
  Logger.log('Live feed OK: ' + vp.v.length + ' buses reporting');
  var r = getRuns([{ run: '6-9', relief: '10:10' }, { run: '189-2', relief: '17:15' }]);
  r.results.forEach(function (x) {
    Logger.log(x.input + ': ' + (x.error || (x.status + (x.bus ? ' bus ' + x.bus.id : '') +
      (x.relief ? ', relief ' + x.relief.sched + ' at ' + x.relief.name : '') +
      (x.cancelled && x.cancelled.length ? ', ' + x.cancelled.length + ' cancelled trip(s)' : ''))));
  });
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var plan = planDays([{ date: today, pieces: [{ run: '6-9', relief: '10:10' }, { run: '189-2', relief: '17:15' }] }]);
  plan[0].pieces.forEach(function (p) {
    Logger.log('Hours plan ' + p.run + ': ' + (p.start || '?') + ' to ' + (p.finish || '?') +
      (p.finishFromSchedule ? ' (end of run)' : '') + ', routes ' + p.routes.join(', ') + (p.noSchedule ? ' (not in schedule today)' : ''));
  });
  try {
    var al = getAlerts(['6', '189']);
    Logger.log(al.error ? 'Detour alerts: FAILED (' + al.error + ')'
      : 'Detour alerts OK: ' + al.items.length + ' for routes 6/189' + al.items.map(function (i) { return '\n    ' + i.title; }).join(''));
  } catch (e) { Logger.log('Detour alerts: FAILED (' + (e.message || e) + ')'); }
  var any = vp.v.filter(function (v) { return v.t; })[0];
  if (any) {
    var b = getBuses([any.id]).results[0];
    Logger.log('Bus lookup test: bus ' + b.id + ' -> run ' + (b.run || 'none') + (b.inService ? ' (in service)' : ''));
  }
}
