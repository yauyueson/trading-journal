import json, sys
sys.path.insert(0, '.')
from replay import *
S=SCR
res={}
for strat in ['bcd','pmcc']:
    d=json.load(open(f'{S}/trades-full-{strat}.json'))
    dates=d['allTradingDates']; maxd=d['holdoutEnd']
    rows=[]
    for k in ['oosTrades','holdoutTrades']:
        for i,t in enumerate(d[k]):
            f=t['full']
            if strat=='bcd':
                r=bcd(f['entryDate'],dates,maxd)
                ok = r and abs(r['debit']-f['entryPrice'])<1e-6 and abs(r['exitPrice']-f['exitPrice'])<1e-6 and abs(r['pnl']-f['pnl'])<1e-4 and r['exitDate']==f['exitDate'] and r['longK']==f['strike'] and r['shortK']==f['longStrike'] and r['expiry']==f['expiry']
                print(strat,k[:3],i,f['entryDate'],f['exitType'],'->',r and r['exitType'], 'OK' if ok else 'MISMATCH', round(f['pnl'],2), r and round(r['pnl'],2), r and r.get('missing'))
            else:
                r=pmcc(f['entryDate'],dates,maxd)
                sc=f['diagonalLegs']['shortCallCycles']
                okc = r and len(sc)==len(r['cycles']) and all(abs(a['entryCredit']-b['credit'])<1e-6 and abs(a['exitCost']-b['cost'])<1e-6 and a['exitDate']==b['exitDate'] and a['strike']==b['strike'] and a['exitReason']==b['reason'] for a,b in zip(sc,r['cycles']))
                ok = r and okc and abs(r['pnl']-f['pnl'])<1e-4 and r['exitDate']==f['exitDate'] and r['exitType']==f['exitType'] and abs(r['lp']-f['diagonalLegs']['longCall']['entryPrice'])<1e-6
                print(strat,k[:3],i,f['entryDate'],f['exitType'],'->',r and r['exitType'],'OK' if ok else 'MISMATCH', round(f['pnl'],2), r and round(r['pnl'],2))
