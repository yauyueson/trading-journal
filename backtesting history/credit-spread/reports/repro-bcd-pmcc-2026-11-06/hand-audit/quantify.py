import json, sys
sys.path.insert(0,'.')
from replay import *
cand={c['date']:c['close'] for c in json.load(open('/Users/yuchenqiu/03_Projects/trading-journal/scripts/autoresearch/data-cache.json'))['tickers']['QQQ']['candles']}
def spot(d):
    r=DB.execute('SELECT stock_price FROM option_chains WHERE ticker="QQQ" AND trade_date=? LIMIT 1',(d,)).fetchone()
    return r[0] if r else None
def last_spot_on_or_before(d, dates):
    for x in reversed([y for y in dates if y<=d]):
        s=spot(x)
        if s: return x,s
out={}
# ---- candle vs chain
for strat in ['bcd','pmcc']:
    d=json.load(open(f'{SCR}/trades-full-{strat}.json'))
    diffs=[]
    for t in d['oosTrades']+d['holdoutTrades']:
        f=t['full']
        cs=spot(f['entryDate']); cc=cand.get(f['entryDate'])
        diffs.append((f['entryDate'], f['entryStockPrice'], cs, cc, f['entryStockPrice']==cs))
    eq=sum(x[4] for x in diffs)
    print(strat,'entryStockPrice==chain stock_price:',eq,'/',len(diffs))
    for x in diffs[:3]+diffs[-3:]: print('  ',x, 'candle/chain-1 = %.4f'%(x[3]/x[2]-1))
# ---- BCD missing-chain force closes
d=json.load(open(f'{SCR}/trades-full-bcd.json')); dates=d['allTradingDates']
print('\nBCD missing-chain FORCE_CLOSE classification')
tot_sim=0; tot_alt=0
for k in ['oosTrades','holdoutTrades']:
    for i,t in enumerate(d[k]):
        f=t['full']
        if f['exitType']!='FORCE_CLOSE': continue
        r=bcd(f['entryDate'],dates,d['holdoutEnd'])
        if not r['exitType'].startswith('FORCE_CLOSE(missing'): print(k[:3],i,r['exitType']); continue
        md=r['missing'][-1]
        S_exit=spot(md)
        # which leg missing on exit day & why
        lc=contract(md,r['longK'],r['expiry']); sc=contract(md,r['shortK'],r['expiry'])
        lastd,lastv=r['mtm'][-1]
        lastL=contract(lastd,r['longK'],r['expiry'])
        ed,S_exp=last_spot_on_or_before(r['expiry'],dates)
        w=r['shortK']-r['longK']
        intr_exit=min(w,max(0,S_exit-r['longK']))
        intr_exp=min(w,max(0,S_exp-r['longK'])) if r['expiry']<=d['holdoutEnd'] else None
        alt=intr_exp if intr_exp is not None else intr_exit
        tot_sim+=f['pnl']; tot_alt+=(alt-r['debit'])*100
        print(k[:3],i,f['entryDate'],'exit',md,'K',r['longK'],r['shortK'],'exp',r['expiry'],
              'missing L/S on exit day:',lc is None,sc is None,'| last mark',lastd,round(lastv,3),'longDelta@last %.4f'%lastL['delta'],
              '| spot exit %.2f'%S_exit,'intrinsic@exit %.2f'%intr_exit,'| spot@expiry(%s) %.2f'%(ed,S_exp),'intrinsic@expiry',None if intr_exp is None else round(intr_exp,2),
              '| sim pnl %.0f  hold-to-expiry pnl %.0f'%(f['pnl'],(alt-r['debit'])*100))
print('BCD missing-chain FC total sim pnl %.0f vs hold-to-expiry-intrinsic %.0f'%(tot_sim,tot_alt))
# ---- PMCC vanished shorts
d=json.load(open(f'{SCR}/trades-full-pmcc.json')); dates=d['allTradingDates']
print('\nPMCC short cycles settled at 0 because contract row missing at long exit')
agg={'oos':[0,0],'hol':[0,0]}
for k in ['oosTrades','holdoutTrades']:
    for i,t in enumerate(d[k]):
        f=t['full']
        r=pmcc(f['entryDate'],dates,d['holdoutEnd'])
        adj=0
        for c in r['cycles']:
            if c.get('missing_at_close'):
                lastm=c['mtm'][-1] if c['mtm'] else None
                if c['expiry']<=c['exitDate']:
                    ed,Se=last_spot_on_or_before(c['expiry'],dates)
                    true_cost=max(0,Se-c['strike'])
                    note='expired %s spot %.2f'%(ed,Se)
                else:
                    Se=spot(c['exitDate']); true_cost=max(0,Se-c['strike']); note='alive at long exit, spot %.2f (intrinsic lower bound)'%Se
                adj-=100*true_cost
                print(k[:3],i,'short K',c['strike'],'exp',c['expiry'],'entered',c['entryDate'],'credit %.3f'%c['credit'],'last row',lastm[0] if lastm else None,'mid %.2f'%(lastm[1] if lastm else 0),
                      '| ',note,'| true settle cost %.2f -> pnl impact %+.0f'%(true_cost,-100*true_cost),
                      '| uncovered days after expiry:', len([x for x in dates if c['expiry']<x<=c['exitDate']]))
        agg[k[:3]][0]+=f['pnl']; agg[k[:3]][1]+=f['pnl']+adj
for k,v in agg.items(): print(k,'sim total pnl %.0f  corrected (settle at intrinsic, no re-roll credit) %.0f  delta %.0f'%(v[0],v[1],v[1]-v[0]))
