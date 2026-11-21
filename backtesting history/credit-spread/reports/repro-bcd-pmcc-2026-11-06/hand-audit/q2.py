import json,sys
sys.path.insert(0,'.')
from replay import *
d=json.load(open(f'{SCR}/trades-full-bcd.json')); dates=d['allTradingDates']
agg={}
for k in ['oosTrades','holdoutTrades']:
    for i,t in enumerate(d[k]):
        f=t['full']
        if f['exitType']!='FORCE_CLOSE': continue
        r=bcd(f['entryDate'],dates,d['holdoutEnd'])
        if not r['exitType'].startswith('FORCE_CLOSE(missing'): continue
        md=r['exitDate']; lc=contract(md,r['longK'],r['expiry'])
        if not lc: print(k[:3],i,'long missing too'); continue
        ub = leg_fill(lc,'sell') - 0.0   # short leg (delta<0.01) bought back at 0 -> upper bound on realistic exit
        a=agg.setdefault(k[:3],[0,0,0]); a[0]+=1; a[1]+=f['pnl']; a[2]+=(ub-r['debit'])*100
        print(k[:3],i,md,'stale mark %.3f'%r['exitPrice'],'| long bid/mid/ask %.2f/%.2f/%.2f oi %s dte %s'%(lc['call_bid'],lc['call_mid'],lc['call_ask'],lc['call_oi'],lc['dte']),'| realistic exit <= %.3f'%ub,'| sim pnl %.0f vs <= %.0f'%(f['pnl'],(ub-r['debit'])*100))
for k,a in agg.items(): print(k,'n',a[0],'sim pnl %.0f  realistic upper bound %.0f  bias >= %.0f'%(a[1],a[2],a[1]-a[2]))
# trading-calendar coverage
miss=[x for x in dates if x>='2019-01-17' and not DB.execute('SELECT 1 FROM option_chains WHERE ticker="QQQ" AND trade_date=? LIMIT 1',(x,)).fetchone()]
print('candle dates 2019-01-17..end with NO chain rows:',len(miss),miss[:20])
nfl=DB.execute('SELECT COUNT(*), SUM(dte_min IS NULL AND dte_max IS NULL) FROM fetch_log WHERE ticker="QQQ" AND trade_date>="2019-01-01"').fetchone()
print('fetch_log QQQ rows since 2019 / NULL-NULL:',nfl)
