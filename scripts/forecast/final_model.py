# Final model: ridge on shrunk target encodings (franchise, developer, genre, decade, platform-family x genre)
# + crowd rating (on Cooper's curve, reliability-weighted) + years-since-release when played.
import model
from model import *
from lagtest import featvec_lag, lagval
from conf import evidence, probs, unpack, fit_conf
model.featvec = featvec_lag
featvec = featvec_lag
MFEATS = ['fr','dev','gen','dec','pg']
LAM = 10.0
import os
if os.path.exists('/tmp/forecast/loo_final.npy'):
    loo = np.load('/tmp/forecast/loo_final.npy')
else:
    loo = model.nested_loo(MFEATS, True, LAM); np.save('/tmp/forecast/loo_final.npy', loo)
beta, MU = model.fit_full(MFEATS, True, LAM)
qc = quantile_thresholds(loo, Y); rc = [0.5,1.5,2.5,3.5,4.5]
c6 = [0.6*q + 0.4*r for q, r in zip(qc, rc)]
c8 = [0.8*q + 0.2*r for q, r in zip(qc, rc)]
CUTS = [c6[0], c6[1], c8[2], c8[3], c6[4]]   # C|B, B|A near his grade-mix quantiles; D and A+ only on strong evidence
loo_pg = np.array([to_grade(v, CUTS) for v in loo])
BT_EXACT = float(np.mean(loo_pg == Y)); BT_W1 = float(np.mean(abs(loo_pg - Y) <= 1))
E_loo = np.array([evidence(x, True) for x in comp])
if os.path.exists('/tmp/forecast/conf_final.npy'):
    TH = np.load('/tmp/forecast/conf_final.npy')
else:
    TH = fit_conf(loo, E_loo, Y); np.save('/tmp/forecast/conf_final.npy', TH)
Xtr = np.array([featvec(x, [x], MU, MFEATS, True) for x in comp])
CONTRIB_MEAN = (Xtr * beta[1:]).mean(axis=0)
NAMES = MFEATS + ['crowd', 'hasCrowd', 'lag']
def forecast(x):
    v = np.array(featvec(x, [], MU, MFEATS, True))
    p = float(predict(beta, v))
    g = to_grade(p, CUTS)
    pr = probs(TH, np.array([p]), evidence(x, False)[None, :])[0]
    c = dict(zip(NAMES, v * beta[1:] - CONTRIB_MEAN))
    c['crowd'] += c.pop('hasCrowd')
    c['era'] = c.pop('dec') + c.pop('lag')
    return dict(p=p, g=g, conf=float(pr[g]), probs=pr, contrib=c)
if __name__ == '__main__':
    print('beta', dict(zip(['b0'] + NAMES, np.round(beta, 3))))
    print('CUTS', np.round(CUTS, 3), 'backtest exact', round(BT_EXACT, 4), 'within1', round(BT_W1, 4))
    pr = probs(TH, loo, E_loo); conf = pr[np.arange(n), loo_pg]; hit = loo_pg == Y
    print('LOO mean conf', conf.mean(), 'hit', hit.mean())
    for lo, hi in [(0, .35), (.35, .42), (.42, .48), (.48, .55), (.55, 1)]:
        m = (conf >= lo) & (conf < hi)
        if m.sum(): print(f'  conf[{lo},{hi}) n={m.sum()} mean={conf[m].mean():.3f} hit={hit[m].mean():.3f}')
    print('backtest dist', sorted(collections.Counter(VG[g] for g in loo_pg).items()))
    F = [(x, forecast(x)) for x in targets]
    print('targets dist', sorted(collections.Counter(VG[f['g']] for _, f in F).items()), 'conf mean', np.mean([f['conf'] for _, f in F]))
