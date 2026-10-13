import json, datetime, os
from why import *
from context import summarize
REPO = '/Users/max/repos/game-library-experiments'
byid = {x['id']: x for x in rows}
def gid(title, status='completed'):
    m = [x for x in rows if x['title'] == title and (x['status'] == status if status else True)]
    assert len(m) >= 1, title
    return m[0]['id']
# ---- same game already graded (remake / original / same collection): blend 50/50 with his grade(s) ----
SAME = {
    'g:ps2/shadow-of-the-colossus': ['Shadow of the Colossus (2018)'],
    'g:switch-2/the-elder-scrolls-iv-oblivion-remastered': ['The Elder Scrolls IV: Oblivion'],
    'g:ps3/demons-souls': ["Demon's Souls (2020)"],
    'g:ps3/zone-of-the-enders-hd-collection': ['Zone of the Enders', 'Zone of the Enders: The 2nd Runner'],
    'g:switch/castlevania-anniversary-collection': ['Castlevania', "Castlevania II: Simon's Quest"],
    'g:arcade/gradius': ['Gradius'],
}
# ---- hand-written reasons where his reviews say something specific ----
WHY = {
 'g:switch/sea-of-stars': "The Messenger got a B, but he called its follow-up a 'must-play' on release",
 'g:ps5/star-wars-jedi-survivor': "Fallen Order got a C; he's back 'against my better judgement'",
 'g:ps2/shadow-of-the-colossus': "The 2018 remake got a D; he hoped the PS2 original is 'more charming'",
 'g:gba/metroid-zero-mission': "Metroid Fusion (A) left him 'really looking forward to' this one",
 'g:windows/torchlight-ii': "Diablo (A) sent him straight back to Torchlight II; PC RPGs avg A-",
 'g:ps5/astro-bot': "Team Asobi's last two got A+ and A; he told Sony to 'write a blank check'",
 'g:windows/age-of-empires-ii-de-return-of-rome': "AoE1's campaigns (his B) rebuilt inside AoE II (three A+ grades)",
 'g:windows/age-of-empires-ii-de-the-mountain-royals': "More AoE II, his 'pantheon' game: three A+ grades so far",
 'g:windows/age-of-empires-ii-de-chronicles-battle-for-greece': "Self-described 'sucker for ancient history' + AoE II (avg A+)",
 'g:windows/age-of-empires-ii-de-victors-and-vanquished': "He'd beaten every AoE II campaign that existed in 2021; avg A+",
 'g:switch-2/the-elder-scrolls-iv-oblivion-remastered': "He gave the 2006 Oblivion an A; crowd loves the remaster (4.6/5)",
 'g:ps4/uncharted-4-a-thiefs-end': "Loved Uncharted 1 and 2 (A's), soured on 3 (C); crowd 4.4/5",
 'g:switch-2/star-fox-2026': "Star Fox 64 got an A, and his launch-window plays avg B+",
 'g:switch-2/hades-ii': "Hades got an A, his favorite Supergiant game; crowd 4.7/5",
 'g:windows/shovel-knight-king-of-cards': "All 3 Shovel Knight campaigns got A's, though he ranked Specter last",
 'g:switch/bloodstained-curse-of-the-moon-2': "Part 1 got a B ('good, not great'); crowd is cool on this one (3.3/5)",
 'g:nes/castlevania-iii-draculas-curse': "Curse of the Moon (B) was 'almost too faithful' to this one's stiff jumps",
 'g:nes/zanac': "Its sequel Gun Nac got an A, but the crowd is cool on Zanac (3.4/5)",
 'g:ps1/r4-ridge-racer-type-4': "He knocked Ridge Racer V (B) for lacking R4's charm",
 'g:n64/mario-kart-64': "His N64-Christmas kart; Mario Kart 8 Deluxe got a B (blue shells)",
 'g:gc/star-wars-rebel-strike-rogue-squadron-iii': "Rogue Leader got an A; he says 'go back to the classics from Factor Five'",
 'g:n64/star-wars-episode-i-battle-for-naboo': "Factor Five, whose classics he champions, but crowd is cool (3.7/5)",
 'g:nes/metal-gear': "He gave the MSX original a B; this NES port's crowd is far cooler (3.6/5)",
 'g:arcade/gradius': "NES Gradius got a C: 'way too hard' to beat legit",
 'g:switch/shinobi-art-of-vengeance': "Self-declared 'huge Shinobi III fan' (an A); crowd 4.4/5",
 'g:nes/ninja-gaiden': "His go-to example of unfair 80s design ('hello Ninja Gaiden')",
 'g:ps5/ninja-gaiden-ragebound': "Crowd loves it (4.5/5); his ninja homages (Messenger, Cyber Shadow) got B's",
 'g:windows/bastion': "Hades was his favorite of their games; this is where Supergiant began",
 'g:ps1/red-dead-revolver': "Not a Redemption (his A+ x2): a 2004 linear shooter; crowd 4.1/5",
 'g:ps3/zone-of-the-enders-hd-collection': "Same two games he graded: Zone of the Enders (B), 2nd Runner (A)",
 'g:ps3/demons-souls': "He gave the PS5 remake an A; this is the 2009 original",
 'g:switch/castlevania-anniversary-collection': "He already beat CV1 and CV2 on this very collection: both C's",
 'g:ps5/ea-sports-college-football-26': "College Football 25 got a B; EA Tiburon games avg C for him",
 'g:ps5/mlb-the-show-26': "The Show 22, 24 and 25 all got B's; he wants Sony to push it further",
 'g:windows/roller-coaster-tycoon-3-complete-edition': "He called Planet Coaster (A) this game's spiritual successor",
 'g:snes/the-legend-of-zelda-a-link-to-the-past': "Zelda is 4-for-4 on A's with him; crowd-certified classic (4.7/5)",
 'g:ps2/gradius-v': "Gradius got a C, but this one's by Treasure (his avg: A)",
}
FORE = {}
for x in targets:
    f = forecast(x)
    p, note = f['p'], None
    if x['id'] in SAME:
        gs = [next(c for c in comp if c['title'] == t)['gv'] for t in SAME[x['id']]]
        p = 0.5 * p + 0.5 * float(np.mean(gs))
    g = to_grade(p, CUTS)
    pr = probs(TH, np.array([p]), evidence(x, False)[None, :])[0]
    why = WHY.get(x['id']) or auto_why(x, f)
    assert len(why) <= 90, (x['title'], why, len(why))
    FORE[x['id']] = {'grade': VG[g], 'confidence': round(float(pr[g]), 2), 'why': why, '_p': p, '_title': x['title']}
missing = set(WHY) - set(FORE); assert not missing, missing
# ---- context ----
m = [x for x in comp if x['crowdC'] is not None]
d = np.array([x['gv'] - x['crowdC'] for x in m])
vs = {'n': len(m), 'avgDelta': round(float(d.mean()), 2) + 0.0, 'harsher': int((d <= -0.5).sum()), 'kinder': int((d >= 0.5).sum()), 'same': int((abs(d) < 0.5).sum())}
def table(key, minn, field):
    out = []
    for r in summarize(key, minn):
        e = {field: r['k'], 'n': r['n'], 'avg': r['avg']}
        if field in ('genre', 'platform'): e['delta'] = r['delta'] if r['delta'] is not None else None
        out.append(e)
    return out
byGenre = table(lambda x: x['genre'], 3, 'genre')
byPlatform = table(lambda x: x['platform'], 3, 'platform')
byDeveloper = table(lambda x: x['developer'], 3, 'developer')
byDecade = sorted(table(lambda x: x['decade'], 1, 'decade'), key=lambda e: e['decade'])
DIS = [
 ('ZeroRanger', "Grindy STG tropes and a save-wiping finale: 'I never want to see or play ZeroRanger again'"),
 ('Mortal Kombat II', "Cheating AI even on VERY EASY: 'If I could give a grade lower than F, I would.'"),
 ('NBA 2K23', "Rotten with ads and pay-to-win: 'it's just way too toxic now'"),
 ('Shadow of the Colossus (2018)', "Loves the atmosphere, but the camera, horse and puzzle-boss tedium sink it. 'Tragic.'"),
 ("Crash Bandicoot 4: It's About Time", "'A little too authentic': brutal 90s platforming, a camera he can't control"),
 ("Uncharted 3: Drake's Deception", "Recycled story and kamikaze enemy AI; a letdown after he loved 1 and 2"),
 ('Mario Kart 8 Deluxe', "Blue shells: his biggest rage-game in years, Sekiro included"),
 ('Metal Gear Solid V: The Phantom Pain', "No review needed: his 6 Kojima Productions games avg A; this crowd is oddly cool"),
 ('Final Fantasy VII: Remake', "Lived up to years of anticipation: Wall Market, Cloud and Aerith, a stellar score"),
 ('Aerobiz Supersonic', "An airline tycoon sim for a management-sim fan who wishes for an airport sim"),
 ('Dynamite Headdy', "His yardstick for 'really novel ideas' on the Genesis (see his Batman & Robin review)"),
 ('Ghost of Tsushima', "'Perhaps the most beautiful game I've ever played'"),
 ('Sekiro: Shadows Die Twice', "Still his FromSoft '1A', even after Elden Ring ('1B')"),
 ('Star Soldier: Vanishing Earth', "A short, welcoming STG with an awesome soundtrack: exactly his kind of shmup"),
]
disagreements = []
for t, note in DIS:
    x = next(c for c in comp if c['title'] == t)
    assert len(note) <= 90, (t, len(note))
    disagreements.append({'id': x['id'], 'title': x['title'], 'grade': x['grade'], 'community': round(float(x['crowd']), 2), 'note': note,
                          '_delta': round(float(x['gv'] - x['crowdC']), 2)})
likes = ["gorgeous pixel art and sprite work", "a killer soundtrack", "infinite continues and fair checkpoints",
         "short games that respect his time", "new abilities that stack up", "quality-of-life fixes in remakes",
         "Nintendo-grade polish", "co-op runs with Max or Alexis", "deep management and builder sims",
         "big character moments and twists"]
dislikes = ["brutal, coin-munching difficulty", "losing every power-up on death", "scarce checkpoints",
            "clunky controls and uncontrollable cameras", "checklist open worlds and fetch quests", "recycled enemies and bosses",
            "bugs, crashes and soft locks", "microtransactions and menu bloat", "cryptic puzzles with no clear goal",
            "cheating or rubber-banding AI", "retro games 'too faithful' to old flaws", "great art bolted to a bad game"]
dist = collections.Counter(v['grade'] for v in FORE.values())
aplus = [v['_title'] for v in FORE.values() if v['grade'] == 'A+']
insights = [
 "Crowd rates his games 4.0/5 on average; he grades them a flat B",
 "Fighting games: 1.3 grades below the crowd. MK II got an F.",
 "Sims, strategy and builders: half a grade kinder than the crowd",
 "Kojima Productions: 6 games, avg A, a full grade over the crowd",
 "Nintendo: avg A-, yet half a grade under the crowd's hype",
 "PS5 games: half a grade harsher than the crowd",
 "Played at launch: avg B+. Played 20+ years late: avg B-",
 "'Clunky' in a review = never above a B (14 for 14)",
 "Mentions checkpoints? 11 of those 14 reviews end in a C",
 f"Backlog forecast: {dist['A+']} A+, {dist['A']} A, {dist['B']} B, {dist['C']} C, {dist['D']} D",
]
for s in insights: assert len(s) <= 70, (s, len(s))
method = ("Ridge regression on his 438 grades (A+=5..F=0) using shrunk series, developer, genre, era and platform-genre averages, "
          "years since release and LaunchBox crowd stars (shown raw as 'community'; for delta converted to his scale by percentile rank, "
          "so the crowd's Nth-percentile game = his Nth-percentile grade), with grade cutoffs set to his own A/B/C mix.")
out = {
 'generatedAt': datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z'),
 'method': method,
 'backtest': {'exact': round(BT_EXACT, 3), 'withinOne': round(BT_W1, 3), 'n': int(len(Y))},
 'insights': insights,
 'context': {
   'vsCommunity': vs, 'byGenre': byGenre, 'byPlatform': byPlatform, 'byDeveloper': byDeveloper, 'byDecade': byDecade,
   'disagreements': [{k: v for k, v in e.items() if not k.startswith('_')} for e in disagreements],
   'likes': likes, 'dislikes': dislikes,
 },
 'forecasts': {k: {kk: vv for kk, vv in v.items() if not kk.startswith('_')} for k, v in FORE.items()},
}
json.dump(out, open('/tmp/forecast/forecasts.json', 'w'), indent=2, ensure_ascii=False)
json.dump({'fore': FORE, 'dis': disagreements}, open('/tmp/forecast/debug.json', 'w'), indent=1, ensure_ascii=False)
print('forecasts', len(FORE), dict(sorted(dist.items())), 'A+:', aplus)
print('backtest', out['backtest'], 'vs', vs)
for e in disagreements: print(e['_delta'], e['grade'], e['community'], e['title'])
