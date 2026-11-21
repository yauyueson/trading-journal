import json,sys
sys.path.insert(0,'.')
from replay import *
cand={c['date']:c['close'] for c in json.load(open('/Users/yuchenqiu/03_Projects/trading-journal/scripts/autoresearch/data-cache.json'))['tickers']['QQQ']['candles']}
def q(r): return 'bid %.2f / ORATSmid %.4f / ask %.2f (quote-mid %.3f) oi %s dte %s δ %.3f S %.2f'%(n(r['call_bid']),n(r['call_mid']),n(r['call_ask']),(n(r['call_bid'])+n(r['call_ask']))/2,r['call_oi'],r['dte'],n(r['delta']),r['stock_price'])
def expiry_menu(date,dte_range):
    rs=[r for r in chain(date) if dte_range[0]<=r['dte']<=dte_range[1]]
    m={}
    for r in rs: m[r['expir_date']]=m.get(r['expir_date'],0)+n(r['call_oi'])
    return ', '.join('%s:%d'%(e,o) for e,o in m.items())
D={s:json.load(open(f'{SCR}/trades-full-{s}.json')) for s in ['bcd','pmcc']}
print('## BCD detail')
for k,i in [('oosTrades',0),('oosTrades',20),('holdoutTrades',0),('holdoutTrades',2),('holdoutTrades',5),('holdoutTrades',24)]:
    d=D['bcd']; f=d[k][i]['full']; r=bcd(f['entryDate'],d['allTradingDates'],d['holdoutEnd'])
    print(f"\n### BCD {k[:3]}#{i}  {f['entryDate']} -> {f['exitDate']}  sim exitType {f['exitType']}  (replay: {r['exitType']})")
    print('- expiry menu (call OI sum, DTE 30-60):', expiry_menu(f['entryDate'],(30,60)), '→ chosen', r['expiry'])
    print('- long  K=%s: %s'%(r['longK'],q(r['L'])))
    print('- short K=%s: %s'%(r['shortK'],q(r['S'])))
    print('- fills: long buy %.4f, short sell %.4f → debit %.4f (sim %.4f) Δ=%.2e; width %.2f, maxProfit %.4f, PT level spreadMid ≥ %.4f'%(r['lf'],r['sf'],r['debit'],f['entryPrice'],r['debit']-f['entryPrice'],r['shortK']-r['longK'],r['maxProfit'],r['debit']+0.5*r['maxProfit']))
    mt=r['mtm']
    if mt:
        pre=[x for x in mt if x[0]<r['exitDate']]
        print('- max spreadMid before exit day:', (max(pre,key=lambda x:x[1]) if pre else None), '| exit-day/last mark:', mt[-1])
    if 'exit_rows' in r:
        lc,sc=r['exit_rows']; print('- exit long : %s'%q(lc)); print('- exit short: %s'%q(sc))
        print('- exit fills: long sell %.4f, short buy %.4f → %.4f (sim %.4f)'%(leg_fill(lc,'sell'),leg_fill(sc,'buy'),r['exitPrice'],f['exitPrice']))
    else:
        print('- exit value (no fill, last mid):', r['exitPrice'], 'missing days', r.get('missing'))
    print('- pnl recomputed %.4f vs sim %.4f; candle close on entry %.3f vs chain S %.2f'%(r['pnl'],f['pnl'],cand[f['entryDate']],f['entryStockPrice']))
print('\n## PMCC detail')
for k,i in [('oosTrades',16),('holdoutTrades',0),('holdoutTrades',1),('holdoutTrades',2),('holdoutTrades',10)]:
    d=D['pmcc']; f=d[k][i]['full']; r=pmcc(f['entryDate'],d['allTradingDates'],d['holdoutEnd'])
    print(f"\n### PMCC {k[:3]}#{i}  {f['entryDate']} -> {f['exitDate']}  sim exitType {f['exitType']} (replay {r['exitType']})")
    print('- LEAP expiry menu (DTE 240-300):', expiry_menu(f['entryDate'],(240,300)))
    print('- long  K=%s exp %s: %s'%(r['longK'],r['lexp'],q(r['L'])))
    print('- long buy fill %.4f (sim %.4f)'%(r['lp'],f['diagonalLegs']['longCall']['entryPrice']))
    lm=r['lmtm']; pre=[x for x in lm if x[0]<r['exitDate']]
    if pre:
        mx=max(pre,key=lambda x:x[1]); mn=min(pre,key=lambda x:x[1])
        print('- long ret range before exit day: max %+.3f (%s), min %+.3f (%s); PT +0.60 / SL -0.35'%((mx[1]-r['lp'])/r['lp'],mx[0],(mn[1]-r['lp'])/r['lp'],mn[0]))
    if lm: print('- long exit-day mark %s ret %+.4f; exit row bid %.2f ask %.2f oi %s dte %s → sell fill %.4f (sim %.4f)'%(lm[-1],(lm[-1][1]-r['lp'])/r['lp'],n(r['lbid']),n(r['lask']),r['loi'],r['ldte'],r['lexit'],f['diagonalLegs']['longCall']['exitPrice']))
    else: print('- no monitoring days; long exit uses entry row bid/ask with mark = entry fill: sell fill %.4f'%r['lexit'])
    for j,(c,s) in enumerate(zip(r['cycles'],f['diagonalLegs']['shortCallCycles'])):
        er=r['S'] if j==0 else None
        print('  - cycle %d K=%s exp %s %s→%s credit %.4f (sim %.4f) cost %.4f (sim %.4f) %s (sim %s)'%(j,c['strike'],c['expiry'],c['entryDate'],c['exitDate'],c['credit'],s['entryCredit'],c['cost'],s['exitCost'],c['reason'],s['exitReason']))
        if c.get('exit_row'): print('      exit row: %s'%q(c['exit_row']))
        if c['reason']=='PIN_ROLL':
            xr=c['exit_row']; print('      pin check: dte %d, |S/K-1| raw = %.4f; with candle close %.2f → %.4f'%(xr['dte'],abs(xr['stock_price']/c['strike']-1),cand[c['exitDate']],abs(cand[c['exitDate']]/c['strike']-1)))
        if c.get('missing_at_close'): print('      !! contract row missing on settle date → cost 0; last mtm', c['mtm'][-1][:2] if c['mtm'] else None)
    print('- pnl: long %.2f + shorts %.2f = %.4f (sim %.4f)'%(r['lpnl'],r['spnl'],r['pnl'],f['pnl']))
# ---- candle-vs-raw counterfactual for pin-roll trigger across ALL PMCC cycles
print('\n## Pin-roll trigger: raw chain S vs dividend-adjusted candle close (all PMCC cycles, all monitored days with dte<=2)')
diff=0; tot=0
for k in ['oosTrades','holdoutTrades']:
    for i,t in enumerate(D['pmcc'][k]):
        f=t['full']; r=pmcc(f['entryDate'],D['pmcc']['allTradingDates'],D['pmcc']['holdoutEnd'])
        for c in r['cycles']:
            for (dd,sm,S,dte) in c['mtm']:
                if dte<=2 and dd<c['expiry']:
                    tot+=1
                    a=abs(S/c['strike']-1)<=0.02; b=abs(cand[dd]/c['strike']-1)<=0.02
                    if a!=b: diff+=1; print('  differs',k[:3],i,dd,'K',c['strike'],'raw S %.2f'%S,'candle %.2f'%cand[dd],'raw-trigger',a,'candle-trigger',b)
print('  day-checks with dte<=2:',tot,'| would differ under candle close:',diff)
