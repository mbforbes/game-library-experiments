from model import *
for feats in [['fr','dev','gen','dec','pg'], ['fr','dev','gen','plat','dec','pg'], ['fr','dev','gen','plat','pg']]:
    b, mu = fit_full(feats, True, 10.0)
    print(feats, np.round(b,3))
feats = ['fr','dev','gen','dec','pg']
p = nested_loo(feats, True, 10.0)
np.save('/tmp/forecast/loo_preds.npy', p)
qc = quantile_thresholds(p, Y); rc = [0.5,1.5,2.5,3.5,4.5]
print('quantile cuts', np.round(qc,3))
for a in [0, 0.25, 0.5, 0.6, 0.75, 1.0]:
    cuts = [a*q + (1-a)*r for q, r in zip(qc, rc)]
    e, w, pg = score(p, cuts)
    print(a, round(e,3), round(w,3), dict(sorted(collections.Counter(pg.astype(int)).items())))
print('actual', dict(sorted(collections.Counter(Y.astype(int)).items())))
