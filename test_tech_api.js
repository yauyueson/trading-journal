
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import handler from './api/batch-refresh-tech.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env
try {
    const envPath = path.resolve(__dirname, '.env');
    if (fs.existsSync(envPath)) {
        const envConfig = fs.readFileSync(envPath, 'utf8');
        envConfig.split('\n').forEach(line => {
            const [key, value] = line.split('=');
            if (key && value) {
                process.env[key.trim()] = value.trim();
            }
        });
        console.log("Loaded .env");
    } else {
        console.warn(".env file not found");
    }
} catch (e) {
    console.error("Error loading .env", e);
}

// Mock Request and Response
const req = {
    method: 'POST',
    body: {
        scope: 'active',
        limit: 1, // Test only 1 position
        dryRun: true
    }
};

const res = {
    setHeader: () => { },
    status: (code) => {
        console.log(`Response Status: ${code}`);
        return res;
    },
    json: (data) => {
        console.log("Response JSON:", JSON.stringify(data, null, 2));
        // Write to file for inspection
        fs.writeFileSync('test_tech_api_output.json', JSON.stringify(data, null, 2));
        return res;
    },
    end: () => { }
};

// Run Handler
console.log("Running Batch Tech Score Handler (Dry Run)...");
handler(req, res).then(() => {
    console.log("Handler finished.");
}).catch(err => {
    console.error("Handler error:", err);
});
