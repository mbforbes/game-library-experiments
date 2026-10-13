# Variant: group encodings computed on residuals from a crowd-only baseline (so groups capture
# Cooper-vs-crowd tendencies, not just quality), then ridge on [crowd, encodings].
from model import *
def crowd_base_fit(train):
    X = np.array([crowd_feats(x) for x in train]); y = np.array([x['gv'] for x in train], float)
    return fit(X, y, 1.0)
def resid_tot(train, beta0):
    t = {f: collections.defaultdict(lambda: [0.0, 0]) for f in FEATS}
    for x in train:
        r = x['gv'] - predict(beta0, crowd_feats(x))
        x['_r'] = r
        for f in FEATS:
            k = x['keys'][f]
            if k is not None: t[f][k][0] += r; t[f][k][1] += 1
    return t
def rfeat(x, t, excl_self, feats):
    v = []
    for f in feats:
        k = x['keys'][f]
        if k is None or k not in t[f]: v.append(0.0); continue
        s, c = t[f][k]
        if excl_self and t[f] is not None:
            s -= x['_r']; c -= 1
        v.append(s / (c + SHRINK[f]) if c > 0 else 0.0)
    return v + crowd_feats(x)
def nested_loo2(feats, lam=10.0):
    preds = np.zeros(n)
    for i, xi in enumerate(comp):
        train = [x for j, x in enumerate(comp) if j != i]
        b0 = crowd_base_fit(train)
        t = resid_tot(train, b0)
        Xm = np.array([rfeat(x, t, True, feats) for x in train]); yt = np.array([x['gv'] for x in train], float)
        b = fit(Xm, yt, lam)
        preds[i] = predict(b, rfeat(xi, t, False, feats))
    return preds
if __name__ == '__main__':
    for feats in [FEATS, ['fr','dev','gen','dec'], ['fr','gen','dec'], ['fr','dev','gen','plat','dec']]:
        for lam in [3, 10]:
            p = nested_loo2(feats, lam)
            rmse = float(np.sqrt(np.mean((p - Y)**2)))
            e1, w1, pg1 = score(p); cuts = quantile_thresholds(p, Y); e2, w2, _ = score(p, cuts)
            print(feats, lam, f'rmse={rmse:.3f} round {e1:.3f}/{w1:.3f} quant {e2:.3f}/{w2:.3f}', dict(sorted(collections.Counter(pg1.astype(int)).items())))
