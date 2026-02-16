
import { spawn } from 'child_process';
import fs from 'fs';

const log = fs.createWriteStream('wrapper_output.txt');

console.log("Starting wrapper...");
const child = spawn('node', ['debug_fetch_only.js'], { shell: true });

child.stdout.on('data', (data) => {
    console.log(`STDOUT: ${data}`);
    log.write(data);
});

child.stderr.on('data', (data) => {
    console.log(`STDERR: ${data}`);
    log.write(data);
});

child.on('close', (code) => {
    console.log(`Exited with code ${code}`);
    log.write(`\nExited with code ${code}`);
    log.end();
});
