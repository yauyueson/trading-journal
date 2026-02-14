const fs = require('fs');
try {
    fs.writeFileSync('test_simple_cjs.txt', 'Hello Node CJS');
    console.log("Wrote to file");
} catch (e) {
    console.error(e);
}
