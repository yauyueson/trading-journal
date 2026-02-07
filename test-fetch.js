
const ticker = 'AMD';
const url = `https://cdn.cboe.com/api/global/delayed_quotes/options/${ticker}.json`;

fetch(url, {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
})
    .then(res => {
        console.log('Status:', res.status);
        return res.json();
    })
    .then(data => {
        console.log('Success - price:', data.data?.current_price);
    })
    .catch(err => {
        console.error('Fetch Error:', err.message);
    });
