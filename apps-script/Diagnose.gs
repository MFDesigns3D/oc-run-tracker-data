/**
 * Run Tracker — live feed check (test only, safe to delete later).
 * In Apps Script: pick "diagnoseFeed" in the function menu, click Run, then read the Execution log.
 */
function diagnoseFeed() {
  var d = data_();
  Logger.log('Schedule file: ' + d.from + ' to ' + d.to + ', ' + Object.keys(d.trips).length + ' trips');
  var vp = vehicles_();
  var withTrip = vp.v.filter(function (v) { return v.t; });
  Logger.log('Live feed: ' + vp.v.length + ' buses, ' + withTrip.length + ' on a trip, feed time ' +
    (vp.ts ? Utilities.formatDate(new Date(vp.ts * 1000), TZ, 'MMM d HH:mm:ss') : '?'));

  var match = 0, miss = [];
  withTrip.forEach(function (v) {
    if (d.trips[v.t] || (v.t.length > 3 && d.trips[v.t.slice(0, -3)])) match++;
    else if (miss.length < 5) miss.push(v.t + ' (route ' + v.r + ', start ' + v.st + ' ' + v.sd + ')');
  });
  Logger.log('Trip IDs found in schedule file: ' + match + ' of ' + withTrip.length);
  if (miss.length) Logger.log('Examples NOT in schedule file: ' + miss.join(' | '));
  var sample = Object.keys(d.trips).slice(0, 3);
  Logger.log('Example trip IDs in schedule file: ' + sample.join(' | '));

  var T = nowInfo_();
  ['6-9', '189-2'].forEach(function (run) {
    var sl = runSlice_(run, T.ymd);
    var keys = {};
    sl.trips.forEach(function (t) { keys[t.k] = 1; });
    var onRun = withTrip.filter(function (v) { return matchKey_(v.t, keys); });
    Logger.log(run + ': ' + sl.trips.length + ' trips today, buses on it now: ' +
      (onRun.length ? onRun.map(function (v) { return v.id; }).join(', ') : 'none'));
  });
}

/**
 * v4.1 check: does OC Transpo's trip-update feed say which bus is assigned to each trip?
 * Pick "diagnoseAssigned" in the function menu, click Run, read the Execution log.
 */
function diagnoseAssigned() {
  var j = fetchJson_(TU_URL);
  var all = 0, withBus = 0, ex = [];
  (j.Entity || []).forEach(function (e) {
    var tu = e.TripUpdate;
    if (!tu || !tu.Trip) return;
    all++;
    var v = tu.Vehicle;
    var id = v ? (v.Id || v.Label || '') : '';
    if (id) { withBus++; if (ex.length < 5) ex.push('trip ' + tu.Trip.TripId + ' -> bus ' + id); }
  });
  Logger.log('Trip updates: ' + all + ', with a bus number: ' + withBus);
  Logger.log(withBus ? 'Examples: ' + ex.join(' | ') : 'The feed does NOT include bus numbers, so layover lookups fall back to the nearby-bus guess.');
}
