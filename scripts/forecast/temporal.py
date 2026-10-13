# Temporal backtest: fit on games completed before a cutoff year, test on later completions.
import model
from model import *
from lagtest import featvec_lag
def run(cut_year, use_lag):
    fv = featvec_lag if use_lag else model.featvec.__wrapped__ if hasattr(model.featvec,'__wrapped__') else orig
    train = [x for x in comp if int(x['completedOn'][:4]) < cut_year]
    test = [x for x in comp if int(x['completedOn'][:4]) >= cut_year]
    # group totals from train only
    saved = {f: dict(model.tot[f]) for f in FEATS}
    for f in FEATS:
        model.tot[f] = collections.defaultdict(lambda: [0.0, 0])
        for x in train:
            k = x['keys'][f]
            if k is not None: model.tot[f][k][0] += x['gv']; model.tot[f][k][1] += 1
    mu = np.mean([x['gv'] for x in train])
    feats = ['fr','dev','gen','dec','pg']
    Xm = np.array([fv(x, [x], mu, feats, True) for x in train]); yt = np.array([x['gv'] for x in train], float)
    b = fit(Xm, yt, 10.0)
    p = np.array([predict(b, fv(x, [], mu, feats, True)) for x in test]); yy = np.array([x['gv'] for x in test], float)
    for f in FEATS:
        model.tot[f] = collections.defaultdict(lambda: [0.0, 0], saved[f])
    return p, yy
orig = model.featvec
for cy in [2021, 2023, 2024]:
    for ul in [False, True]:
        p, yy = run(cy, ul)
        print(cy, 'lag' if ul else 'nolag', 'n', len(yy), 'rmse', round(float(np.sqrt(np.mean((p-yy)**2))),3), 'bias', round(float(np.mean(p-yy)),3), 'mean pred', round(float(p.mean()),2), 'actual', round(float(yy.mean()),2))
