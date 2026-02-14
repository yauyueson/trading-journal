import fs from 'fs';
try {
    fs.writeFileSync('test_simple.txt', 'Hello Node');
    console.log("Wrote to file");
} catch (e) {
    console.error(e);
}
