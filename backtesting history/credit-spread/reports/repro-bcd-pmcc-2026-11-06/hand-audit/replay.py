"""Independent Python replay of worker.ts makeDebitSpreadEvaluator / makeDiagonalEvaluator
against the raw (read-only) ORATS chain cache. Read-only on all inputs."""
import json, sqlite3, sys, math, datetime

SCR = '/private/tmp/claude-501/-Users-yuchenqiu-03-Projects-trading-journal--claude-worktrees-dazzling-lumiere-1aecfe/6f3b52ab-b425-422e-b309-ea7dcc0149a7/scratchpad'
DB = sqlite3.connect(f'file:{SCR}/data-clone/option-chains.sqlite?mode=ro&immutable=1', uri=True)
DB.row_factory = sqlite3.Row
COLS = None

SLIP = dict(baseImpactBps=2, oiHalfLife=500, maxOiFactor=6, dteAccelDays=7, dteAccelMultiplier=3.0)

def n(x):  # JS null -> 0 coercion in arithmetic
    return 0 if x is None else x

_chain_cache = {}
def chain(date):
    if date not in _chain_cache:
        _chain_cache[date] = [dict(r) for r in DB.execute(
            'SELECT * FROM option_chains WHERE ticker=? AND trade_date=? ORDER BY expir_date, strike', ('QQQ', date))]
    return _chain_cache[date]

def contract(date, strike, expiry):
    r = DB.execute('SELECT * FROM option_chains WHERE ticker=? AND trade_date=? AND expir_date=? AND strike BETWEEN ? AND ? LIMIT 1',
                   ('QQQ', date, expiry, strike - 0.01, strike + 0.01)).fetchone()
    return dict(r) if r else None

def has_fetch_log(date):
    return DB.execute('SELECT 1 FROM fetch_log WHERE ticker=? AND trade_date=?', ('QQQ', date)).fetchone() is not None

def find_strike_by_delta(rows, target, dte_range):
    filt = [r for r in rows if dte_range[0] <= r['dte'] <= dte_range[1]]
    if not filt:
        return None
    by = {}
    for r in filt:
        by.setdefault(r['expir_date'], []).append(r)
    best_exp, best_oi = None, -1
    for e, rs in by.items():
        oi = sum(n(r['call_oi']) for r in rs)
        if oi > best_oi:
            best_oi, best_exp = oi, e
    best, bd = None, math.inf
    for r in by[best_exp]:
        dist = abs(abs(n(r['delta'])) - abs(target))
        if dist < bd:
            bd, best = dist, r
    return best

def slip(spread, oi, dte, mid):
    half = max(0, spread) / 2
    base = abs(mid) * SLIP['baseImpactBps'] / 10000
    oif = min(1 + SLIP['oiHalfLife'] / max(oi, 1), SLIP['maxOiFactor'])
    dtef = 1
    if dte < SLIP['dteAccelDays']:
        dtef = 1 + (SLIP['dteAccelDays'] - dte) / SLIP['dteAccelDays'] * (SLIP['dteAccelMultiplier'] - 1)
    return half + base * oif * dtef

def fill(mid, bid, ask, side, oi, dte):
    mid, bid, ask, oi = n(mid), n(bid), n(ask), n(oi)
    spread = max(0, ask - bid)
    imp = slip(spread, oi, dte, mid)
    if side == 'sell':
        return max(0, bid - (imp - spread / 2))
    return ask + (imp - spread / 2)

def leg_fill(r, side):
    return fill(r['call_mid'], r['call_bid'], r['call_ask'], side, r['call_oi'], r['dte'])

# ---------------- BCD ----------------
def bcd(signal_date, all_dates, max_date, cfg=dict(dte=(30, 60), ld=0.50, sd=0.20, pt=0.50, maxhold=45, minexit=7, miss=3)):
    ch = chain(signal_date)
    if not ch:
        return None
    L = find_strike_by_delta(ch, cfg['ld'], cfg['dte'])
    S = find_strike_by_delta(ch, cfg['sd'], cfg['dte'])
    if not L or not S:
        return None
    if S['expir_date'] != L['expir_date']:
        S = find_strike_by_delta(ch, cfg['sd'], (L['dte'], L['dte']))
        if not S or S['expir_date'] != L['expir_date']:
            return None
    if L['strike'] >= S['strike']:
        return None
    lf, sf = leg_fill(L, 'buy'), leg_fill(S, 'sell')
    debit = lf - sf
    if debit <= 0:
        return None
    width = S['strike'] - L['strike']
    maxp = width - debit
    exp = L['expir_date']
    end = exp if exp < max_date else max_date
    i0 = all_dates.index(signal_date)
    mons = [d for d in all_dates[i0 + 1:] if d <= end]
    out = dict(entry=signal_date, longK=L['strike'], shortK=S['strike'], expiry=exp, entryDTE=L['dte'],
               L=L, S=S, lf=lf, sf=sf, debit=debit, maxProfit=maxp, mtm=[], first_pt=None)
    ex_val, ex_type, ex_date, ex_dte, ex_spot = debit, 'EXPIRATION', end, 0, L['stock_price']
    miss = 0
    e0 = datetime.date.fromisoformat(signal_date)
    stopped = False
    for d in mons:
        held = (datetime.date.fromisoformat(d) - e0).days
        lc, sc = contract(d, L['strike'], exp), contract(d, S['strike'], exp)
        if not lc or not sc:
            miss += 1
            out.setdefault('missing', []).append(d)
            if miss >= cfg['miss']:
                ex_val = out['mtm'][-1][1] if out['mtm'] else debit
                ex_date, ex_type, stopped = d, 'FORCE_CLOSE(missing-chain)', True
                break
            continue
        miss = 0
        sm = n(lc['call_mid']) - n(sc['call_mid'])
        out['mtm'].append((d, sm))
        ex_spot, ex_dte = lc['stock_price'], lc['dte']
        trig = None
        if maxp > 0 and (sm - debit) >= cfg['pt'] * maxp:
            trig = 'PROFIT_TARGET'
        elif lc['dte'] <= cfg['minexit']:
            trig = 'TIME_STOP'
        elif held >= cfg['maxhold']:
            trig = 'FORCE_CLOSE(maxhold)'
        if trig:
            ex_val = leg_fill(lc, 'sell') - leg_fill(sc, 'buy')
            out['exit_rows'] = (lc, sc)
            ex_date, ex_type, stopped = d, trig, True
            break
    if not stopped:
        if end >= exp:
            ex_type = 'EXPIRATION'
        else:
            ex_val = out['mtm'][-1][1] if out['mtm'] else debit
            ex_type = 'FORCE_CLOSE(window-end)'
    out.update(exitDate=ex_date, exitType=ex_type, exitPrice=ex_val, exitDTE=ex_dte, exitSpot=ex_spot,
               pnl=(ex_val - debit) * 100)
    return out

# ---------------- PMCC ----------------
def pmcc(signal_date, all_dates, max_date, cfg=dict(ldr=(0.70, 0.80), ldte=(240, 300), sdr=(0.20, 0.30), sdte=(30, 45),
                                                   lpt=0.60, lsl=0.35, lts=90, spt=0.50, roll=0.02)):
    ch = chain(signal_date)
    if not ch:
        return None
    lmd = sum(cfg['ldr']) / 2
    smd = sum(cfg['sdr']) / 2
    L = find_strike_by_delta(ch, lmd, cfg['ldte'])
    if not L:
        return None
    S = find_strike_by_delta(ch, smd, cfg['sdte'])
    if not S or S['strike'] <= L['strike']:
        return None
    lp, sc0 = leg_fill(L, 'buy'), leg_fill(S, 'sell')
    lexp, lk = L['expir_date'], L['strike']
    cycles = []
    cur = dict(strike=S['strike'], expiry=S['expir_date'], entryDate=signal_date, entryDTE=S['dte'], credit=sc0, mtm=[])
    cap = lexp if lexp < max_date else max_date
    i0 = all_dates.index(signal_date)
    mons = [d for d in all_dates[i0 + 1:] if d <= cap]
    lreason, ldate, lprem = 'TIME_STOP', cap, lp
    lbid, lask, loi, ldte = L['call_bid'], L['call_ask'], L['call_oi'], 0
    stop = False
    lmtm = []
    for d in mons:
        if stop:
            break
        lc = contract(d, lk, lexp)
        if lc:
            lm = n(lc['call_mid'])
            lmtm.append((d, lm))
            lprem, lbid, lask, loi, ldte = lm, lc['call_bid'], lc['call_ask'], lc['call_oi'], lc['dte']
            ret = (lm - lp) / lp
            if ret >= cfg['lpt']:
                lreason, ldate, stop = 'PROFIT_TARGET', d, True
            elif ret <= -cfg['lsl']:
                lreason, ldate, stop = 'STOP_LOSS', d, True
            elif lc['dte'] <= cfg['lts']:
                lreason, ldate, stop = 'TIME_STOP', d, True
        if cur:
            sc = contract(d, cur['strike'], cur['expiry'])
            if sc:
                sm = n(sc['call_mid'])
                cur['mtm'].append((d, sm, sc['stock_price'], sc['dte']))
                act = 'hold'
                if d >= cur['expiry']:
                    act = 'close_expired'
                else:
                    mny = abs(sc['stock_price'] / cur['strike'] - 1)
                    if sc['dte'] <= 2 and mny <= cfg['roll']:
                        act = 'close_pin'
                    elif (cur['credit'] - sm) / cur['credit'] >= cfg['spt']:
                        act = 'close_pt'
                if act != 'hold':
                    if act == 'close_expired':
                        asg = sc['stock_price'] >= cur['strike']
                        cost = max(0, sc['stock_price'] - cur['strike']) if asg else 0
                        reason = 'ASSIGNED' if asg else 'EXPIRATION'
                    else:
                        cost = leg_fill(sc, 'buy')
                        reason = 'PROFIT_TARGET' if act == 'close_pt' else 'PIN_ROLL'
                    cycles.append(dict(strike=cur['strike'], expiry=cur['expiry'], entryDate=cur['entryDate'], exitDate=d,
                                       credit=cur['credit'], cost=cost, reason=reason, exitDTE=sc['dte'], mtm=cur['mtm'],
                                       exit_row=sc))
                    cur = None
                    if not stop:
                        nch = [r for r in chain(d) if cfg['sdte'][0] <= r['dte'] <= cfg['sdte'][1]] if has_fetch_log(d) else []
                        nm = find_strike_by_delta(nch, smd, cfg['sdte'])
                        if nm and nm['strike'] > lk:
                            nc = leg_fill(nm, 'sell')
                            if nc > 0:
                                cur = dict(strike=nm['strike'], expiry=nm['expir_date'], entryDate=d, entryDTE=nm['dte'],
                                           credit=nc, mtm=[], entry_row=nm)
    if cur:
        cc = contract(ldate, cur['strike'], cur['expiry'])
        cost = leg_fill(cc, 'buy') if cc else 0
        cycles.append(dict(strike=cur['strike'], expiry=cur['expiry'], entryDate=cur['entryDate'], exitDate=ldate,
                           credit=cur['credit'], cost=cost, reason='FORCE_CLOSE', exitDTE=cc['dte'] if cc else 0,
                           mtm=cur['mtm'], exit_row=cc, missing_at_close=cc is None))
    lexit = fill(lprem, lbid, lask, 'sell', loi, ldte)
    lpnl = 100 * (lexit - lp)
    spnl = sum(100 * (c['credit'] - c['cost']) for c in cycles)
    return dict(entry=signal_date, L=L, S=S, lp=lp, sc0=sc0, longK=lk, lexp=lexp, exitDate=ldate, exitType=lreason,
                lexit=lexit, lexit_mark=lprem, lbid=lbid, lask=lask, loi=loi, ldte=ldte, cycles=cycles,
                pnl=lpnl + spnl, lpnl=lpnl, spnl=spnl, lmtm=lmtm)
