"""Build octranspo_runs.json (format 2) for the Run Tracker from an OC Transpo GTFS folder.
Usage: python build_runs.py <gtfs_folder> <out.json>
Also writes version.txt next to out.json (the build id the app checks for changes).
Exits with an error, writing nothing, if the result looks broken.

Format read by Code.gs:
  fmt 2, v, from, to                        feed version + service date range (yyyyMMdd)
  services: [[yyyyMMdd, ...], ...]          dates each service index runs
  trips: {key: [block, route, headsign, [serviceIdx...], t0, [stopIdx...], [offsetSec...]]}
         key = trip_id minus its 3-digit service suffix when every service copy is identical,
         otherwise the full trip_id (Code.gs tries the full id first, then the base).
         Stops = timepoints only (plus first/last), offsets in seconds from t0.
  stopIds, stopNames, stopLat, stopLon      every stop in the feed
"""
import csv, json, sys, os, datetime, collections, hashlib

src, out = sys.argv[1], sys.argv[2]
rd = lambda f: csv.DictReader(open(os.path.join(src, f), encoding='utf-8-sig'))

def secs(t):
    h, m, s = t.split(':')
    return int(h) * 3600 + int(m) * 60 + int(s)

# ---- services -> dates
dates = collections.defaultdict(set)
days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
for c in rd('calendar.txt'):
    d = datetime.datetime.strptime(c['start_date'], '%Y%m%d').date()
    e = datetime.datetime.strptime(c['end_date'], '%Y%m%d').date()
    while d <= e:
        if c[days[d.weekday()]] == '1':
            dates[c['service_id']].add(d.strftime('%Y%m%d'))
        d += datetime.timedelta(days=1)
if os.path.exists(os.path.join(src, 'calendar_dates.txt')):
    for c in rd('calendar_dates.txt'):
        if c['exception_type'] == '1': dates[c['service_id']].add(c['date'])
        else: dates[c['service_id']].discard(c['date'])

feed = next(rd('feed_info.txt'), {}) if os.path.exists(os.path.join(src, 'feed_info.txt')) else {}
routes = {r['route_id']: (r['route_short_name'] or r['route_id']) for r in rd('routes.txt')}

# ---- stops
stops = list(rd('stops.txt'))
stopIdx = {s['stop_id']: i for i, s in enumerate(stops)}

# ---- stop times: timepoints + first/last
st = collections.defaultdict(list)
for r in rd('stop_times.txt'):
    st[r['trip_id']].append((int(r['stop_sequence']), r['stop_id'], r['departure_time'] or r['arrival_time'], r.get('timepoint', '1')))

trips = list(rd('trips.txt'))
svcList = sorted({t['service_id'] for t in trips if dates.get(t['service_id'])}, key=lambda s: (len(s), s))
svcIndex = {s: i for i, s in enumerate(svcList)}

def pattern(t):
    rows = sorted(st[t['trip_id']])
    if not rows: return None
    keep = [r for i, r in enumerate(rows) if i == 0 or i == len(rows) - 1 or r[3] in ('1', '')]
    t0 = secs(keep[0][2])
    return (t['block_id'], routes.get(t['route_id'], t['route_id']), t['trip_headsign'], t0,
            tuple(stopIdx[r[1]] for r in keep), tuple(secs(r[2]) - t0 for r in keep))

# group service copies of the same base trip
fam = collections.defaultdict(list)
for t in trips:
    if t['service_id'] not in svcIndex or not t['block_id']: continue
    tid = t['trip_id']
    base = tid[:-3] if len(tid) > 3 else tid
    p = pattern(t)
    if p: fam[base].append((tid, svcIndex[t['service_id']], p))

allIds = {t['trip_id'] for t in trips}
out_trips = {}
split = 0
for base, items in fam.items():
    bysig = collections.defaultdict(list)
    for tid, si, p in items: bysig[p].append((tid, si))
    sigs = sorted(bysig.items(), key=lambda kv: -len(kv[1]))
    clash = base in allIds          # the short key is someone else's real trip id: use full ids only
    for n, (p, lst) in enumerate(sigs):
        if n == 0 and not clash:
            out_trips[base] = [p[0], p[1], p[2], sorted({si for _, si in lst}), p[3], list(p[4]), list(p[5])]
        else:
            split += 1
            for tid, si in lst:
                out_trips[tid] = [p[0], p[1], p[2], [si], p[3], list(p[4]), list(p[5])]

alld = sorted(set().union(*[dates[s] for s in svcList]))
data = {
    'fmt': 2, 'v': feed.get('feed_version', ''), 'from': alld[0], 'to': alld[-1],
    'services': [sorted(dates[s]) for s in svcList],
    'trips': out_trips,
    'stopIds': [s['stop_id'] for s in stops],
    'stopNames': [s['stop_name'] for s in stops],
    'stopLat': [round(float(s['stop_lat'] or 0), 6) for s in stops],
    'stopLon': [round(float(s['stop_lon'] or 0), 6) for s in stops],
}
# ---- sanity checks: never replace a good file with a broken one
problems = []
if len(out_trips) < 5000: problems.append('only %d trips' % len(out_trips))
if len(stops) < 1000: problems.append('only %d stops' % len(stops))
if not data['services']: problems.append('no service dates')
blocks = {e[0] for e in out_trips.values()}
if len(blocks) < 300: problems.append('only %d runs' % len(blocks))
if problems:
    sys.exit('Build looks wrong, not saved: ' + '; '.join(problems))

body = json.dumps(data, ensure_ascii=False, separators=(',', ':'), sort_keys=False)
build = hashlib.sha256(body.encode('utf-8')).hexdigest()[:12]
data['build'] = build
with open(out, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
with open(os.path.join(os.path.dirname(os.path.abspath(out)), 'version.txt'), 'w') as f:
    f.write(build + '\n')
print('feed', data['v'], data['from'], '->', data['to'], '| build', build, '| services', len(svcList),
      '| trips', len(out_trips), '| variant splits', split, '| stops', len(stops),
      '| size', round(os.path.getsize(out) / 1024), 'KB')
