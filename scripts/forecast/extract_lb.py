import json, sys
import xml.etree.ElementTree as ET
resolved = json.load(open('/Users/max/repos/game-library-experiments/art/resolved.json'))
want = {v['lb']['id'] for v in resolved.values() if v.get('lb')}
out = {}
allidx = []
for ev, el in ET.iterparse('/Users/max/repos/game-library-experiments/.cache/art/launchbox/Metadata.xml', events=('end',)):
    if el.tag == 'Game':
        try:
            did = int(el.findtext('DatabaseID') or -1)
        except ValueError:
            did = -1
        cr = el.findtext('CommunityRating'); cc = el.findtext('CommunityRatingCount')
        rec = {'id': did, 'name': el.findtext('Name'), 'platform': el.findtext('Platform'),
               'rating': float(cr) if cr else None, 'count': int(cc) if cc else 0,
               'genres': el.findtext('Genres'), 'developer': el.findtext('Developer'),
               'publisher': el.findtext('Publisher'), 'year': (el.findtext('ReleaseDate') or el.findtext('ReleaseYear') or '')[:4],
               'series': el.findtext('Series')}
        if did in want:
            rec['overview'] = (el.findtext('Overview') or '')[:600]
            out[did] = rec
        if rec['rating'] is not None and rec['count'] >= 5:
            allidx.append({k: rec[k] for k in ('id','name','platform','rating','count','year')})
        el.clear()
    elif el.tag in ('PlatformAlternateName','Emulator','EmulatorPlatform','GameAlternateName','GameImage','File'):
        el.clear()
json.dump(out, open('/tmp/forecast/lb_ours.json','w'))
json.dump(allidx, open('/tmp/forecast/lb_all_rated.json','w'))
print(len(want), len(out), len(allidx))
