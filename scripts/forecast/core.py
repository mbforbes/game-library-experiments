from model import *
from conf import evidence, probs, unpack
MFEATS = ['fr','dev','gen','dec','pg']
LAM = 10.0
ALPHA = 0.6
beta, MU = fit_full(MFEATS, True, LAM)
loo = np.load('/tmp/forecast/loo_preds.npy')
th = np.load('/tmp/forecast/conf_theta.npy')
qc = quantile_thresholds(loo, Y); rc = [0.5,1.5,2.5,3.5,4.5]
CUTS = [ALPHA*q + (1-ALPHA)*r for q, r in zip(qc, rc)]
loo_pg = np.array([to_grade(v, CUTS) for v in loo])
BT_EXACT = float(np.mean(loo_pg == Y)); BT_W1 = float(np.mean(abs(loo_pg - Y) <= 1))
# training mean of each raw contribution, to center contributions
Xtr = np.array([featvec(x, [x], MU, MFEATS, True) for x in comp])
CONTRIB_MEAN = (Xtr * beta[1:]).mean(axis=0)
def forecast(x):
    v = np.array(featvec(x, [], MU, MFEATS, True))
    p = float(predict(beta, v))
    g = to_grade(p, CUTS)
    E = evidence(x, False)[None, :]
    pr = probs(th, np.array([p]), E)[0]
    contrib = v * beta[1:] - CONTRIB_MEAN
    names = MFEATS + ['crowd', 'hasCrowd']
    cd = dict(zip(names, contrib))
    cd['crowd'] = cd['crowd'] + cd.pop('hasCrowd')
    return dict(p=p, g=g, conf=float(pr[g]), probs=pr, contrib=cd)
if __name__ == '__main__':
    print('beta', np.round(beta,3), 'MU', MU, 'CUTS', np.round(CUTS,3), 'backtest', BT_EXACT, BT_W1)
    res = []
    for x in targets:
        f = forecast(x); res.append((x, f))
    print('target dist', sorted(collections.Counter(VG[f['g']] for _, f in res).items()))
    print('conf mean', np.mean([f['conf'] for _, f in res]), 'min', min(f['conf'] for _, f in res), 'max', max(f['conf'] for _, f in res))
    res.sort(key=lambda r: -r[1]['p'])
    for x, f in res[:25] + [None] + res[-25:]:
        if x is None: print('...'); continue
        print(f"{VG[f['g']]:2s} {f['p']:.2f} {f['conf']:.2f} {x['title'][:40]:40s} {x['platform']:8s} {x['genre'][:14]:14s} {x['keys']['fr']} crowd={x['crowd'] and round(x['crowd'],2)} " + ' '.join(f'{k}={v:+.2f}' for k, v in f['contrib'].items() if abs(v) > 0.05))
