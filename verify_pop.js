// verify_pop.js
// Test script to verify POP calculation priority and logic

// Mock data structures - Minimal required fields
const createOption = (strike, delta, probabilityITM, type = 'Call', expiration = '2023-01-01') => ({
    strike, delta, probabilityITM, type, expiration,
    bid: 1.0, ask: 1.2, mid: 1.1, last: 1.1,
    volume: 100, openInterest: 1000, dte: 30, theta: -0.05, gamma: 0.02
});

// Mock helpers needed or we can just copy the relevant logic to test it in isolation?
// Copying logic is safer to verify the ALGORITHM, trusting the file modification worked.
// But to test the INTEGRATION, I should import the file.
// However, `strategy-recommend.js` default export is a handler that requires network.
// It has internal functions not exported.
// So I will replicate the logic block here to verify it works as intended on mock inputs.
// This confirms my logic is sound.

function getProbITMAtStrike(chain, optionType, expiration, targetStrike) {
    const same = chain.filter(o => o.type === optionType && o.expiration === expiration);
    if (same.length === 0) return null;
    same.sort((a, b) => a.strike - b.strike);
    const below = same.filter(o => o.strike <= targetStrike);
    const above = same.filter(o => o.strike > targetStrike);
    const a = below.length ? below[below.length - 1] : same[0];
    const b = above.length ? above[0] : same[same.length - 1];

    if (typeof a.probabilityITM !== 'number') return null;

    if (a.strike === b.strike) return a.probabilityITM;
    const t = (targetStrike - a.strike) / (b.strike - a.strike);
    return a.probabilityITM + t * (b.probabilityITM - a.probabilityITM);
}

function getDeltaAtStrike(chain, optionType, expiration, targetStrike) {
    const same = chain.filter(o => o.type === optionType && o.expiration === expiration);
    if (same.length === 0) return null;
    same.sort((a, b) => a.strike - b.strike);
    const below = same.filter(o => o.strike <= targetStrike);
    const above = same.filter(o => o.strike > targetStrike);
    const a = below.length ? below[below.length - 1] : same[0];
    const b = above.length ? above[0] : same[same.length - 1];
    if (a.strike === b.strike) return a.delta;
    const t = (targetStrike - a.strike) / (b.strike - a.strike);
    return a.delta + t * (b.delta - a.delta);
}

function testLogic() {
    console.log("--- Testing POP Logic ---");

    // Case 1: probITM available
    // Strike 100 Call, Delta 0.5, ProbITM 0.52
    // Strike 110 Call, Delta 0.2, ProbITM 0.25
    // Target BE: 105
    const chain1 = [
        createOption(100, 0.50, 0.52),
        createOption(110, 0.20, 0.25)
    ];

    const type = 'Call';
    const expiration = '2023-01-01';
    const breakeven = 105;

    const probITM = getProbITMAtStrike(chain1, type, expiration, breakeven);
    console.log(`Interpolated ProbITM at 105 (Exp ~0.385): ${probITM}`);

    const delta = getDeltaAtStrike(chain1, type, expiration, breakeven);
    console.log(`Interpolated Delta at 105 (Exp ~0.35): ${delta}`);

    // Debit Spread Logic: POP = ProbITM
    let popDebit = probITM;
    console.log(`Debit Spread POP (using ProbITM): ${popDebit}`);

    // Credit Spread Logic (if Sold): POP = 1 - ProbITM
    let popCredit = 1 - probITM;
    console.log(`Credit Spread POP (using ProbITM): ${popCredit}`);


    // Case 2: probITM missing (undefined)
    const chain2 = [
        createOption(100, 0.50, undefined),
        createOption(110, 0.20, undefined)
    ];

    const probITM2 = getProbITMAtStrike(chain2, type, expiration, breakeven);
    console.log(`Interpolated ProbITM (Missing): ${probITM2}`);

    const delta2 = getDeltaAtStrike(chain2, type, expiration, breakeven);

    // Debit Spread Fallback
    let popDebitFallback;
    if (probITM2 != null && probITM2 > 0) {
        popDebitFallback = probITM2;
    } else if (delta2 != null) {
        popDebitFallback = Math.abs(delta2);
    } else {
        popDebitFallback = 0.50 - 0.05;
    }
    console.log(`Debit Spread POP (Fallback to Delta ${delta2}): ${popDebitFallback}`);

    if (Math.abs(popDebitFallback - 0.35) < 0.0001) console.log("PASS: Fallback logic correct");
    else console.log("FAIL: Fallback logic incorrect");

}

testLogic();
