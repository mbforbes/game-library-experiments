import sys
from common import *
from franchise import franchise
def normdev(d):
    d = (d or '').lower()
    d = re.sub(r'\b(inc|ltd|co|corporation|corp|games|studios?|entertainment|software|productions)\b\.?', '', d)
    return re.sub(r'[^a-z0-9]+', ' ', d).strip() or None
PF = {'Genesis':'sega','Master System':'sega','Game Gear':'sega','Dreamcast':'sega','Arcade':'arcade',
      'NES':'nin8','SNES':'nin16','Gameboy':'ninhh','GBA':'ninhh','DS':'ninhh','N64':'nin3d','GC':'nin3d','Wii':'nin3d','Switch':'ninmod','Switch 2':'ninmod',
      'PS1':'sony_old','PS2':'sony_old','PS3':'sony_mid','PS4':'sony_new','PS5':'sony_new','Windows':'pc','MSX':'pc','TG-16':'nec'}
def keys(x):
    return {
        'fr': franchise(x['title']),
        'dev': normdev(x['developer']),
        'gen': x['genre'] or None,
        'plat': x['platform'],
        'dec': x['decade'],
        'pg': (PF.get(x['platform'], x['platform']), x['genre']) if x['genre'] else None,
    }
for x in rows: x['keys'] = keys(x)
SHRINK = {'fr': 1.5, 'dev': 3.0, 'gen': 6.0, 'plat': 8.0, 'dec': 15.0, 'pg': 4.0}
FEATS = list(SHRINK)
Y = np.array([x['gv'] for x in comp], float)
n = len(comp)
# group totals over completed
tot = {f: collections.defaultdict(lambda: [0.0, 0]) for f in FEATS}
for x in comp:
    for f in FEATS:
        k = x['keys'][f]
        if k is not None:
            tot[f][k][0] += x['gv']; tot[f][k][1] += 1
CROWD_MU = float(np.mean([x['crowdC'] for x in comp if x['crowdC'] is not None]))
def crowd_feats(x):
    if x['crowdC'] is None: return [0.0, 0.0]
    rel = x['crowdN'] / (x['crowdN'] + 15.0)
    return [rel * (x['crowdC'] - CROWD_MU), 1.0]
def featvec(x, excl, mu, feats=FEATS, use_crowd=True):
    """excl: list of completed games (dicts) whose grades must be excluded from group stats."""
    v = []
    for f in feats:
        k = x['keys'][f]
        if k is None or k not in tot[f]: v.append(0.0); continue
        s, c = tot[f][k]
        for e in excl:
            if e['keys'][f] == k: s -= e['gv']; c -= 1
        v.append((s - c * mu) / (c + SHRINK[f]) if c > 0 else 0.0)
    if use_crowd: v += crowd_feats(x)
    return v
def fit(Xm, y, lam=1.0):
    A = np.hstack([np.ones((len(Xm),1)), Xm])
    I = np.eye(A.shape[1]); I[0,0] = 0
    return np.linalg.solve(A.T @ A + lam * I, A.T @ y)
def predict(beta, v): return beta[0] + np.dot(beta[1:], v)
def nested_loo(feats=FEATS, use_crowd=True, lam=1.0):
    preds = np.zeros(n)
    for i, xi in enumerate(comp):
        train = [x for j, x in enumerate(comp) if j != i]
        mu = (Y.sum() - Y[i]) / (n - 1)
        Xm = np.array([featvec(x, [x, xi], mu, feats, use_crowd) for x in train])
        yt = np.array([x['gv'] for x in train], float)
        b = fit(Xm, yt, lam)
        preds[i] = predict(b, featvec(xi, [xi], mu, feats, use_crowd))
    return preds
def fit_full(feats=FEATS, use_crowd=True, lam=1.0):
    mu = Y.mean()
    Xm = np.array([featvec(x, [x], mu, feats, use_crowd) for x in comp])
    return fit(Xm, Y, lam), mu
GRADES = [0,1,2,3,4,5]
def quantile_thresholds(preds, y):
    # cut predictions so that the predicted grade distribution matches actual distribution
    order = np.sort(preds)
    cnt = collections.Counter(y.astype(int))
    cuts = []; acc = 0
    for g in GRADES[:-1]:
        acc += cnt.get(g, 0)
        idx = min(max(acc, 1), len(order)-1)
        cuts.append((order[idx-1] + order[idx]) / 2 if acc > 0 else -np.inf)
    return cuts
def to_grade(p, cuts):
    g = 0
    for c in cuts:
        if p > c: g += 1
    return g
def score(preds, cuts=None):
    if cuts is None: pg = np.clip(np.round(preds), 0, 5)
    else: pg = np.array([to_grade(p, cuts) for p in preds])
    return float(np.mean(pg == Y)), float(np.mean(abs(pg - Y) <= 1)), pg
if __name__ == '__main__':
    import itertools
    base = np.full(n, 0.0)
    for i in range(n): base[i] = (Y.sum()-Y[i])/(n-1)
    print('baseline mean: exact/within', score(base))
    print('baseline always B', float(np.mean(Y==3)), float(np.mean(abs(Y-3)<=1)))
    for name, feats, uc in [('crowd only', [], True), ('all', FEATS, True), ('no crowd', FEATS, False), ('no pg', [f for f in FEATS if f!='pg'], True), ('fr+dev+gen+crowd', ['fr','dev','gen'], True)]:
        p = nested_loo(feats, uc)
        rmse = float(np.sqrt(np.mean((p - Y)**2)))
        e1, w1, _ = score(p)
        cuts = quantile_thresholds(p, Y)
        e2, w2, pg = score(p, cuts)
        print(f'{name:18s} rmse={rmse:.3f} round: exact={e1:.3f} within1={w1:.3f} | quantile: exact={e2:.3f} within1={w2:.3f} dist={sorted(collections.Counter(pg.astype(int)).items())}')
    b, mu = fit_full()
    print('beta', np.round(b, 3), ['b0'] + FEATS + ['crowd', 'hasCrowd'])
