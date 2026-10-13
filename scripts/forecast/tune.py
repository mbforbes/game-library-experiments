from model import *
import model
def run(name, feats, uc=True, lam=1.0):
    p = nested_loo(feats, uc, lam)
    rmse = float(np.sqrt(np.mean((p - Y)**2)))
    e1, w1, pg1 = score(p)
    cuts = quantile_thresholds(p, Y)
    e2, w2, pg2 = score(p, cuts)
    d1 = dict(sorted(collections.Counter(pg1.astype(int)).items()))
    print(f'{name:28s} lam={lam:<4} rmse={rmse:.3f} round: {e1:.3f}/{w1:.3f} {d1} | quant: {e2:.3f}/{w2:.3f}')
    return p
for lam in [1, 10, 30]:
    run('all', FEATS, True, lam)
run('fr gen dec', ['fr','gen','dec'], True, 10)
run('fr dev gen plat', ['fr','dev','gen','plat'], True, 10)
run('fr dev gen dec', ['fr','dev','gen','dec'], True, 10)
run('fr gen dec pg', ['fr','gen','dec','pg'], True, 10)
run('fr dev gen dec pg', ['fr','dev','gen','dec','pg'], True, 10)
