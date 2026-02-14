
console.log("TS Runner Works");
try {
    const { calculateTechScore } = require('./lib/tech-analysis');
    console.log("Imported Tech Analysis");
} catch (e) {
    console.log("Import failed:", e.message);
}
