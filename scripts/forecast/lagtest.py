import model
from model import *
def lagval(x):
    if x['status'] == 'completed':
        l = x.get('lag')
    else:
        l = (2026 - x['era']) if x.get('era') else None
    if l is None: l = 10
    return np.log1p(max(l, 0))
LAGMU = float(np.mean([lagval(x) for x in comp]))
orig = model.featvec
def featvec_lag(x, excl, mu, feats=FEATS, use_crowd=True):
    return orig(x, excl, mu, feats, use_crowd) + [lagval(x) - LAGMU]
if __name__ == '__main__':
    model.featvec = featvec_lag
    feats = ['fr','dev','gen','dec','pg']
    p = model.nested_loo(feats, True, 10.0)
    rmse = float(np.sqrt(np.mean((p - Y)**2)))
    qc = quantile_thresholds(p, Y); rc = [0.5,1.5,2.5,3.5,4.5]
    c6 = [0.6*q+0.4*r for q, r in zip(qc, rc)]
    hyb = [c6[0], c6[1], qc[2], qc[3], c6[4]]
    print('with lag rmse', rmse, 'round', score(p)[:2], 'hyb1.0', score(p, hyb)[:2])
    b, mu = model.fit_full(feats, True, 10.0); print(np.round(b, 3))
    np.save('/tmp/forecast/loo_preds_lag.npy', p)
