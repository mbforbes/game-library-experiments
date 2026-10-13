from model import *
from math import erf, sqrt
def Phi(z): return 0.5 * (1 + np.vectorize(erf)(z / sqrt(2)))
def evidence(x, excl_self):
    k = x['keys']['fr']
    nfr = 0
    if k and k in tot['fr']:
        nfr = tot['fr'][k][1] - (1 if excl_self else 0)
    kd = x['keys']['dev']; nd = 0
    if kd and kd in tot['dev']: nd = tot['dev'][kd][1] - (1 if excl_self else 0)
    hc = 1.0 if x['crowdC'] is not None else 0.0
    rel = x['crowdN'] / (x['crowdN'] + 15.0) if hc else 0.0
    return np.array([min(nfr, 4) / 4.0, min(nd, 6) / 6.0, rel])
def unpack(th):
    c = np.cumsum(np.concatenate([[th[0]], np.exp(th[1:5])]))
    a = th[5]; b = th[6:9]
    return c, a, b
def probs(th, p, E):
    c, a, b = unpack(th)
    s = np.exp(E @ b)
    cdf = np.stack([Phi((cg - a * p) / s) for cg in c], axis=1)  # P(y<=g) for g=0..4
    cdf = np.hstack([np.zeros((len(p),1)), cdf, np.ones((len(p),1))])
    pr = np.clip(np.diff(cdf, axis=1), 1e-9, 1)
    return pr  # columns grades 0..5
def nll(th, p, E, y):
    pr = probs(th, p, E)
    return -np.sum(np.log(pr[np.arange(len(y)), y.astype(int)]))
def nelder_mead(f, x0, step=0.3, iters=4000, tol=1e-8):
    d = len(x0); pts = [np.array(x0, float)]
    for i in range(d):
        x = np.array(x0, float); x[i] += step; pts.append(x)
    vals = [f(x) for x in pts]
    for _ in range(iters):
        order = np.argsort(vals); pts = [pts[i] for i in order]; vals = [vals[i] for i in order]
        if abs(vals[-1] - vals[0]) < tol: break
        cen = np.mean(pts[:-1], axis=0)
        xr = cen + (cen - pts[-1]); fr_ = f(xr)
        if fr_ < vals[0]:
            xe = cen + 2 * (cen - pts[-1]); fe = f(xe)
            if fe < fr_: pts[-1], vals[-1] = xe, fe
            else: pts[-1], vals[-1] = xr, fr_
        elif fr_ < vals[-2]:
            pts[-1], vals[-1] = xr, fr_
        else:
            xc = cen + 0.5 * (pts[-1] - cen); fc = f(xc)
            if fc < vals[-1]: pts[-1], vals[-1] = xc, fc
            else:
                for i in range(1, len(pts)):
                    pts[i] = pts[0] + 0.5 * (pts[i] - pts[0]); vals[i] = f(pts[i])
    return pts[int(np.argmin(vals))]
def fit_conf(p, E, y):
    th0 = np.array([0.8, np.log(0.6), np.log(0.7), np.log(0.7), np.log(0.9), 1.0, 0, 0, 0])
    th = th0
    for _ in range(3):
        th = nelder_mead(lambda t: nll(t, p, E, y), th, step=0.2)
    return th
if __name__ == '__main__':
    p = np.load('/tmp/forecast/loo_preds.npy')
    E = np.array([evidence(x, True) for x in comp])
    th = fit_conf(p, E, Y)
    c, a, b = unpack(th)
    print('cuts', np.round(c,3), 'a', round(a,3), 'b', np.round(b,3), 'nll', nll(th, p, E, Y))
    np.save('/tmp/forecast/conf_theta.npy', th)
    qc = quantile_thresholds(p, Y); rc = [0.5,1.5,2.5,3.5,4.5]
    cuts = [0.6*q + 0.4*r for q, r in zip(qc, rc)]
    pg = np.array([to_grade(v, cuts) for v in p])
    pr = probs(th, p, E)
    conf = pr[np.arange(n), pg]
    hit = (pg == Y)
    print('mean conf', conf.mean(), 'actual exact', hit.mean())
    bins = [0, 0.3, 0.38, 0.45, 0.52, 0.6, 1]
    for lo, hi in zip(bins[:-1], bins[1:]):
        m = (conf >= lo) & (conf < hi)
        if m.sum(): print(f'conf [{lo},{hi}) n={m.sum()} meanconf={conf[m].mean():.3f} hit={hit[m].mean():.3f}')
    print('conf range', conf.min(), conf.max())
