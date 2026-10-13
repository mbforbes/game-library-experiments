import json
lib = json.load(open('/tmp/forecast/library.json'))
res = json.load(open('/Users/max/repos/game-library-experiments/art/resolved.json'))
lb = {int(k): v for k, v in json.load(open('/tmp/forecast/lb_ours.json')).items()}
GV = {'A+':5,'A':4,'B':3,'C':2,'D':1,'F':0}
rows = []
for g in lib['games']:
    r = res.get(g['artKey'])
    l = None
    if r and r.get('lb'):
        l = lb.get(r['lb']['id'])
    g2 = dict(g)
    g2['lbId'] = l['id'] if l else None
    g2['lbName'] = l['name'] if l else None
    g2['lbPlatform'] = l['platform'] if l else None
    g2['crowd'] = l['rating'] if l and l['rating'] is not None and l['count'] >= 5 else None
    g2['crowdN'] = l['count'] if l else 0
    g2['crowdRaw'] = l['rating'] if l else None
    g2['lbGenres'] = l['genres'] if l else None
    g2['lbDev'] = l['developer'] if l else None
    g2['lbYear'] = l['year'] if l else None
    g2['lbOverview'] = l.get('overview') if l else None
    g2['resYear'] = r.get('year') if r else None
    g2['gv'] = GV.get(g.get('grade')) if g.get('grade') else None
    rows.append(g2)
json.dump(rows, open('/tmp/forecast/joined.json', 'w'))
import collections
c = [x for x in rows if x['status']=='completed']
t = [x for x in rows if x['status'] in ('backlog','playing')]
print('completed', len(c), 'with lb', sum(1 for x in c if x['lbId']), 'with crowd', sum(1 for x in c if x['crowd'] is not None))
print('targets', len(t), 'with lb', sum(1 for x in t if x['lbId']), 'with crowd', sum(1 for x in t if x['crowd'] is not None))
print('no artKey in resolved:', sum(1 for x in rows if x['artKey'] not in res))

# --- crowd fallback: same game (normalized LB name) on another platform, released within 3 years ---
import re, collections
allr = json.load(open('/tmp/forecast/lb_all_rated.json'))
def nm(s): return re.sub(r'[^a-z0-9]+', ' ', (s or '').lower().replace('&', 'and')).strip()
idx = collections.defaultdict(list)
for r in allr: idx[nm(r['name'])].append(r)
EXCLUDE = {'Pikmin 1 + 2'}
nfb = 0
for x in rows:
    if x['status'] == 'wishlist' or x['crowd'] is not None or x['title'] in EXCLUDE: continue
    y = x.get('year')
    if not y: continue
    cands = idx.get(nm(x['lbName'])) or idx.get(nm(x['title'])) or []
    cands = [c for c in cands if c['count'] >= 5 and str(c.get('year') or '').isdigit() and abs(int(c['year']) - y) <= 3]
    if cands:
        best = max(cands, key=lambda c: c['count'])
        x['crowd'] = best['rating']; x['crowdN'] = best['count']; x['crowdFrom'] = f"{best['name']} ({best['platform']})"
        nfb += 1
json.dump(rows, open('/tmp/forecast/joined.json', 'w'))
print('crowd fallbacks applied:', nfb)
c = [x for x in rows if x['status']=='completed']; t = [x for x in rows if x['status'] in ('backlog','playing')]
print('completed with crowd', sum(1 for x in c if x['crowd'] is not None), 'targets with crowd', sum(1 for x in t if x['crowd'] is not None))
for x in rows:
    if x.get('crowdFrom') and x['title'] in ('Star Fox (2026)', 'Screamer', 'EA Sports Madden NFL 25', 'Prime Mover', 'MiG-29 Fulcrum'): print('CHECK', x['title'], x['crowdFrom'])
