import json, re, math, collections
import numpy as np
GV = {'A+':5,'A':4,'B':3,'C':2,'D':1,'F':0}
VG = {v:k for k,v in GV.items()}
rows = json.load(open('/tmp/forecast/joined.json'))
for x in rows:
    y = x.get('year')
    ly = int(x['lbYear']) if x.get('lbYear') and str(x['lbYear']).isdigit() else None
    era = y
    if ly and y and ly < y and y - ly <= 40: era = ly
    if not y and ly: era = ly
    x['era'] = era
    x['decade'] = f"{era//10*10}s" if era else None
    if x['status']=='completed' and x.get('completedOn') and era:
        x['lag'] = int(x['completedOn'][:4]) - era
comp = [x for x in rows if x['status']=='completed' and x.get('gv') is not None]
targets = [x for x in rows if x['status'] in ('backlog','playing')]
# --- community -> Cooper's curve (percentile mapping) ---
ref = sorted(x['crowd'] for x in comp if x['crowd'] is not None)
ref_arr = np.array(ref)
gcounts = collections.Counter(x['gv'] for x in comp if x['crowd'] is not None)
N = sum(gcounts.values())
cdf_edges = []  # (grade, lo, hi) in percentile space
acc = 0.0
for g in range(0,6):
    p = gcounts.get(g,0)/N
    cdf_edges.append((g, acc, acc+p)); acc += p
def pct(r):
    lo = np.searchsorted(ref_arr, r, side='left'); hi = np.searchsorted(ref_arr, r, side='right')
    return (lo + hi) / 2 / len(ref_arr)
def on_curve(r):
    if r is None: return None
    p = min(max(pct(r), 1e-9), 1-1e-9)
    for g, lo, hi in cdf_edges:
        if hi > lo and lo <= p < hi:
            return g - 0.5 + (p - lo)/(hi - lo)
    return 5.0
for x in rows:
    x['crowdC'] = on_curve(x['crowd']) if x['crowd'] is not None else None
def gstr(v):
    # continuous value -> letter-ish with +/- for display
    return VG[int(round(min(max(v,0),5)))]
