from final_model import *
import hashlib
PLAT = {'Windows':'PC','Gameboy':'Game Boy','GC':'GameCube','Master System':'Master System','Game Gear':'Game Gear','TG-16':'TG-16','Switch 2':'Switch 2'}
FAM = {'sega':'Sega','arcade':'Arcade','nin8':'NES','nin16':'SNES','ninhh':'Nintendo handheld','nin3d':'N64/GC/Wii','ninmod':'Switch',
       'sony_old':'PS1/PS2','sony_mid':'PS3','sony_new':'PS4/PS5','pc':'PC','nec':'TG-16'}
GPL = {'Action/Adventure':'action-adventures','RPG':'RPGs','Shooter':'shooters','Platformer':'platformers','Strategy':'strategy games',
       'Action Platformer':'action platformers','Racing':'racers','Run & Gun':'run & guns','Sports':'sports games','FPS':'FPSes',
       'Flight Sim':'flight sims','Brawler':'brawlers','Simulation':'sims','Puzzle':'puzzlers','Fighting':'fighting games',
       'Puzzle Platformer':'puzzle platformers','Stealth':'stealth games','Open World':'open-world games','Compilation':'compilations',
       'City Builder':'city builders','Point & Click':'point & clicks','Survival':'survival games','Music/Rhythm':'rhythm games',
       'Survival Horror':'survival horror games','Extraction Shooter':'extraction shooters','Idle':'idle games'}
FRN = {'Souls':'Souls games','Team Ico':'Team Ico games','Supergiant':'Supergiant games','Strike series':'the Strike series',
       'Planet/RCT':'theme-park sims','SimCity':'city sims','Hellfire/Toaplan':'Toaplan shooters','Mario':'Mario platformers',
       'GTA':'GTA','IL-2':'IL-2','MS Flight Sim':'MS Flight Sim','Star Wars':'Star Wars games','Aleste':'Aleste/Compile shmups',
       'Gradius':'Gradius','Final Fantasy':'Final Fantasy','Zelda':'Zelda','Pokemon':'Pokemon','Astro Bot':'Astro Bot'}
def letter(v):
    for lo, L in [(4.5,'A+'),(3.83,'A'),(3.5,'A-'),(3.17,'B+'),(2.83,'B'),(2.5,'B-'),(2.17,'C+'),(1.83,'C'),(1.5,'C-'),(1.17,'D+'),(0.83,'D'),(0.5,'D-')]:
        if v >= lo: return L
    return 'F'
def an(g): return 'an' if g[0] in 'AF' else 'a'
def votes(c): return '1,000+' if c >= 1000 else f'{c}'
ABBR = {'Microsoft Flight Simulator (2020)': 'MSFS 2020', 'Flight Simulator X: Deluxe Edition': 'FSX',
        'Shadow of the Colossus (2018)': 'the 2018 remake', 'Nier: Automata [Game of the Yorha Edition]': 'Nier: Automata',
        'Total War: SHOGUN 2 - Fall of the Samurai': 'Fall of the Samurai', 'Total War: SHOGUN 2 - Rise of the Samurai': 'Rise of the Samurai'}
def short_title(t, maxlen=26, target=''):
    if t == 'Shadow of the Colossus (2018)' and target != 'Shadow of the Colossus': return 'SotC (2018)'
    if t in ABBR: return ABBR[t]
    t = re.sub(r'\s*\[.*?\]', '', t).strip()
    if len(t) <= maxlen: return t
    if ':' in t:
        head, tail = t.split(':', 1)[0].strip(), t.split(':', 1)[1].strip()
        import unicodedata
        na = lambda z: unicodedata.normalize('NFKD', z).encode('ascii', 'ignore').decode().lower()
        if (na(target).startswith(na(head)) or len(head.split()) == 1) and 4 <= len(tail) <= maxlen: return tail
        if len(head) <= maxlen: return head
        if 4 <= len(tail) <= maxlen: return tail
    t2 = re.sub(r'\s*\(.*?\)', '', t).strip()
    if len(t2) <= maxlen: return t2
    return t[:maxlen-1].rstrip() + '...'
def groups():
    g = {'fr': collections.defaultdict(list), 'dev': collections.defaultdict(list), 'pg': collections.defaultdict(list), 'gen': collections.defaultdict(list)}
    for x in comp:
        for f in g:
            k = x['keys'][f]
            if k is not None: g[f][k].append(x)
    return g
G = groups()
RETRO_AVG = float(np.mean([x['gv'] for x in comp if x.get('lag') is not None and x['lag'] >= 20]))
RETRO_N = sum(1 for x in comp if x.get('lag') is not None and x['lag'] >= 20)
LAUNCH = [x for x in comp if x.get('lag') is not None and x['lag'] <= 1]
LAUNCH_AVG = float(np.mean([x['gv'] for x in LAUNCH]))
LATE_AVG = float(np.mean([x['gv'] for x in comp if x.get('lag') is not None and 5 <= x['lag'] < 20]))
DEVNAME = {}
for x in comp: DEVNAME.setdefault(x['keys']['dev'], x['developer'])
def pick(h, opts): return opts[int(hashlib.md5(h.encode()).hexdigest(), 16) % len(opts)]
def stories(x, f):
    out = []
    k = x['keys']
    # franchise
    if k['fr'] and G['fr'].get(k['fr']):
        ms = G['fr'][k['fr']]; n = len(ms); avg = float(np.mean([m['gv'] for m in ms]))
        out.append(('fr', (avg - MU) * n / (n + 1.5), dict(ms=ms, n=n, avg=avg, name=FRN.get(k['fr'], k['fr']))))
    if k['dev'] and len(G['dev'].get(k['dev'], [])) >= 3:
        ms = G['dev'][k['dev']]; n = len(ms); avg = float(np.mean([m['gv'] for m in ms]))
        out.append(('dev', 0.8 * (avg - MU) * n / (n + 3), dict(n=n, avg=avg, name=DEVNAME[k['dev']])))
    if k['pg'] and len(G['pg'].get(k['pg'], [])) >= 4:
        ms = G['pg'][k['pg']]; n = len(ms); avg = float(np.mean([m['gv'] for m in ms]))
        out.append(('pg', 0.7 * (avg - MU) * n / (n + 4), dict(n=n, avg=avg, fam=FAM.get(k['pg'][0], k['pg'][0]), gpl=GPL.get(k['pg'][1], k['pg'][1].lower()))))
    if k['gen'] and len(G['gen'].get(k['gen'], [])) >= 5:
        ms = G['gen'][k['gen']]; n = len(ms); avg = float(np.mean([m['gv'] for m in ms]))
        out.append(('gen', 0.6 * (avg - MU) * n / (n + 6), dict(n=n, avg=avg, gpl=GPL.get(k['gen'], k['gen'].lower()))))
    if x['crowd'] is not None:
        out.append(('crowd', f['contrib']['crowd'], dict(s=x['crowd'], c=x['crowdN'])))
    if x.get('era'):
        lag = 2026 - x['era']
        out.append(('era', f['contrib']['era'], dict(lag=lag, dec=x['decade'])))
    return out
def phrase(kind, d, x, sign, h):
    if kind == 'fr':
        ms, n, L, name = d['ms'], d['n'], letter(d['avg']), d['name']
        if n == 1:
            m = ms[0]; t = short_title(m['title'], 26, x['title'])
            if m['title'] == x['title']: t = f"the {PLAT.get(m['platform'], m['platform'])} version"
            return pick(h, [f"He gave {t} {an(m['grade'])} {m['grade']}", f"{t} got {an(m['grade'])} {m['grade']} from him"])
        if n == 2:
            a, b = sorted(ms, key=lambda m: -m['gv'])
            if a['grade'] == b['grade']:
                return f"{short_title(a['title'],24,x['title'])} and {short_title(b['title'],24,x['title'])} both got {a['grade']}"
            return f"{short_title(a['title'],24,x['title'])} got {a['grade']}, {short_title(b['title'],24,x['title'])} got {b['grade']}"
        if sign > 0:
            return pick(h, [f"{name} track record: {n} beaten, avg {L}", f"He's {n} deep in {name}, avg {L}", f"{name} regular: {n} beaten, avg {L}"])
        return pick(h, [f"Rough history with {name}: {n} beaten, avg {L}", f"{name} track record: {n} beaten, avg {L}"])
    if kind == 'dev':
        return pick(h, [f"{d['name']}: {d['n']} of theirs beaten, avg {d['avg'] and letter(d['avg'])}", f"{d['name']} track record: {d['n']} beaten, avg {letter(d['avg'])}"])
    if kind == 'pg':
        return f"{d['fam']} {d['gpl']}: {d['n']} beaten, avg {letter(d['avg'])}"
    if kind == 'gen':
        g = d['gpl']
        return pick(h, [f"{g[0].upper() + g[1:]}: {d['n']} beaten, avg {letter(d['avg'])}", f"His {g} average: {letter(d['avg'])} over {d['n']}"])
    if kind == 'crowd':
        s, c = d['s'], d['c']
        if sign > 0:
            if s >= 4.5 and c >= 100: return f"Crowd-certified classic ({s:.1f}/5, {votes(c)} votes)"
            if c < 15: return f"Small but adoring crowd: {s:.1f}/5 from {c} votes"
            return f"Crowd favorite: {s:.1f}/5 from {votes(c)} votes"
        if s < 3.0: return f"Crowd pans it: {s:.1f}/5 from {votes(c)} votes"
        return pick(h, [f"Crowd is lukewarm: {s:.1f}/5 ({votes(c)} votes)", f"Crowd shrugs: {s:.1f}/5 from {votes(c)} votes"])
    if kind == 'era':
        if sign < 0 and d['lag'] >= 20:
            return pick(h + 'e', [f"{d['lag']} years old: his 20+ yr-late plays avg {letter(RETRO_AVG)}", f"Retro tax: his 20+ yr-late plays avg {letter(RETRO_AVG)}"])
        if sign < 0:
            return pick(h + 'e', [f"{d['lag']} yrs late: his late plays avg {letter(LATE_AVG)} vs {letter(LAUNCH_AVG)} at launch",
                                  f"Playing it {d['lag']} yrs late: late plays avg {letter(LATE_AVG)}, launch plays {letter(LAUNCH_AVG)}"])
        return f"Fresh release: his launch-window plays avg {letter(LAUNCH_AVG)}"
    return ''
def crowd_tag(x):
    return f"crowd {x['crowd']:.1f}/5" if x['crowd'] is not None else None
GENERIC = {'Crowd','His','He','He\'s','Rough','Fresh','Small','Few','No','Retro','Playing','Sims','Platformers','Racers','Brawlers','Shooters','Puzzlers',
           'Strategy','Sports','Action-adventures','Flight','Stealth','Fighting','Open-world','Survival','Compilations','City','Point',
           'Rhythm','Action','Run','Puzzle','Extraction','Idle'}
def clause(kind, d, x, sign, h):
    p = phrase(kind, d, x, sign, h)
    w = p.split(' ', 1)[0].rstrip(':,')
    return p[0].lower() + p[1:] if w in GENERIC else p
def auto_why(x, f):
    w = _auto_why(x, f)
    return w[0].upper() + w[1:]
def _auto_why(x, f):
    h = x['id']
    st = stories(x, f)
    dirn = f['p'] - MU
    st_sorted = sorted(st, key=lambda s: -abs(s[1]))
    if abs(dirn) >= 0.12:
        same = [s for s in st_sorted if np.sign(s[1]) == np.sign(dirn) and abs(s[1]) >= 0.05]
        opp = [s for s in st_sorted if np.sign(s[1]) == -np.sign(dirn) and abs(s[1]) >= 0.15]
        if same:
            kind, sc, d = same[0]
            main = phrase(kind, d, x, np.sign(sc), h)
            cands = []
            if opp:
                k2, s2, d2 = opp[0]
                cands.append(f"{main}, but {clause(k2, d2, x, np.sign(s2), h)}")
            if kind == 'crowd':
                nxt = [s for s in same[1:] if s[0] in ('fr', 'dev', 'pg', 'gen')]
                if nxt:
                    k2, s2, d2 = nxt[0]
                    cands.append(main + '; ' + clause(k2, d2, x, np.sign(s2), h))
            elif x['crowd'] is not None:
                cands.append(f"{main}; {crowd_tag(x)}")
            for c in cands:
                if len(c) <= 90: return c
            return main
    pos = [s for s in st_sorted if s[1] > 0.05]; neg = [s for s in st_sorted if s[1] < -0.05]
    if pos and neg:
        a = phrase(pos[0][0], pos[0][2], x, 1, h)
        b = clause(neg[0][0], neg[0][2], x, -1, h)
        cand = f"{a}, but {b}"
        if len(cand) <= 90: return cand
        return a if abs(pos[0][1]) >= abs(neg[0][1]) else b
    if st_sorted and abs(st_sorted[0][1]) >= 0.05:
        s0 = st_sorted[0]; return phrase(s0[0], s0[2], x, np.sign(s0[1]), h)
    if x['crowd'] is not None:
        return f"Few clues beyond a {x['crowd']:.1f}/5 crowd score: right down the middle"
    return "No series, studio or crowd history to go on: the safe middle"
if __name__ == '__main__':
    out = []
    for x in targets:
        f = forecast(x); w = auto_why(x, f)
        out.append((f['p'], VG[f['g']], round(f['conf'],2), x['title'], x['platform'], w, len(w)))
    out.sort(key=lambda r: -r[0])
    for r in out: print(f"{r[1]:2s} {r[2]:.2f} {r[3][:36]:36s} {r[4][:7]:7s} | {r[5]} [{r[6]}]")
    print('max len', max(r[6] for r in out))
