from common import *
def summarize(key, minn=3, sortby='n'):
    groups = collections.defaultdict(list)
    for x in comp:
        k = key(x)
        if k: groups[k].append(x)
    out = []
    for k, xs in groups.items():
        if len(xs) < minn: continue
        m = [x for x in xs if x['crowdC'] is not None]
        d = np.mean([x['gv']-x['crowdC'] for x in m]) if len(m) >= 2 else None
        raw = np.mean([x['gv']-x['crowd'] for x in m]) if len(m) >= 2 else None
        out.append(dict(k=k, n=len(xs), avg=round(float(np.mean([x['gv'] for x in xs])),2), delta=None if d is None else round(float(d),2), nC=len(m), raw=None if raw is None else round(float(raw),2)))
    out.sort(key=lambda r: -r['n'])
    return out
if __name__ == '__main__':
    m=[x for x in comp if x['crowdC'] is not None]
    d=np.array([x['gv']-x['crowdC'] for x in m])
    print('vs', len(m), d.mean(), (d<=-0.5).sum(), (d>=0.5).sum(), (abs(d)<0.5).sum())
    for name, key in [('genre', lambda x:x['genre']), ('platform', lambda x:x['platform']), ('dev', lambda x:x['developer']), ('decade', lambda x:x['decade']),
                      ('lag', lambda x: None if x.get('lag') is None else ('0 same yr' if x['lag']<=0 else '1-2y' if x['lag']<=2 else '3-9y' if x['lag']<=9 else '10-19y' if x['lag']<=19 else '20+y'))]:
        print('==', name)
        for r in summarize(key, 3 if name!='decade' else 1): print(r)
