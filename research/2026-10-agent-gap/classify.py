import re,collections,sys
rows=[l.rstrip('\n').split('\t') for l in open(sys.argv[1])]
T=re.compile(r'skip lovable|skip gpt|Use tech stack',re.I)
rules=[
 ('revert',r'^revert|reverted|restore'),
 ('security',r'secur|vulnerab|ssl|definer'),
 ('performance',r'render-blocking|contentful|cache lifetime|performance|slow'),
 ('code_error',r'syntax|type ?error|typescript|\bts\b|import|undefined|is not defined|reference|runtime|build error|compil|blank screen|white screen|crash|module|null|not a function|jsx|parsing|duplicate (declar|import)|console error|error boundary|\berrors?\b'),
 ('backend_data',r'supabase|sql|migration|rls|polic|database|\bdb\b|constraint|edge function|auth|login|sign ?up|signup|password|session|token|api key|paystack|stripe|payment|callback|fetch|csp|cors|backend|webhook|storage|upload'),
 ('layout_visual',r'align|overlap|position|height|width|spacing|padding|margin|layout|display|mobile|responsive|scroll|flicker|color|colour|theme|dark|light mode|style|font|z-index|overflow|visib|animation|size|center|header|footer|card|hero|icon|image|logo|ui\b'),
 ('behavior',r'subscription|checkout|calculat|xp\b|level|reward|access|isolation|registration|sign out|collision|onboarding|stuck|slug|duplicate|typo|text|name|not (showing|working|reflect|updat|sav|load|display)|disappear|button|click|navigation|redirect|route|routing|link|flow|state|filter|search|sort|count|limit|playback|audio|player|chat|message|order|notification|form|validation|modal|dialog'),
]
def kind(s):
    s2=s.lower()
    for k,p in rules:
        if re.search(p,s2): return k
    return 'other'
edits=[r for r in rows if not T.search(r[3])]
fix=lambda s: re.search(r'\bfix|resolve|repair|correct|debug|broken|issue|bug|error',s,re.I) or re.search(r'^revert|reverted',s,re.I)
c=collections.Counter(); per=collections.defaultdict(collections.Counter)
ex=collections.defaultdict(list)
for r in edits:
    if fix(r[3]):
        k=kind(r[3]); c[k]+=1; per[r[0]][k]+=1; ex[k].append(r)
n=len(edits); nf=sum(c.values())
print('agent edits',n,'repair edits',nf, f'{100*nf/n:.1f}%')
for k,v in c.most_common(): print(f'  {k:14} {v:4} {100*v/n:5.1f} per 100 edits; projects with any: {sum(1 for p in per if per[p][k])}')
import json; json.dump({k:v for k,v in ex.items()},open(sys.argv[2],'w'))
for p in sorted(per,key=lambda p:-sum(per[p].values()))[:10]:
    m=sum(1 for r in edits if r[0]==p); print(' ',p[:34].ljust(34),m,dict(per[p]))
