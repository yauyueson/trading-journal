// api/earnings.js
// 获取股票财报日期 - 使用 Nasdaq API

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { symbol, debug } = req.query;

  if (!symbol) {
    return res.status(400).json({ error: 'Missing symbol parameter' });
  }

  const upperSymbol = symbol.toUpperCase();

  try {
    // Nasdaq stock info API
    const url = `https://api.nasdaq.com/api/quote/${upperSymbol}/info?assetclass=stocks`;
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    
    if (!response.ok) {
      return res.status(200).json({
        success: true,
        symbol: upperSymbol,
        hasUpcomingEarnings: false,
        earningsDate: null,
        daysUntilEarnings: null,
        debug: { error: 'Nasdaq API failed', status: response.status }
      });
    }

    const data = await response.json();
    
    // Debug mode: 返回原始数据
    if (debug === 'true') {
      return res.status(200).json({
        success: true,
        symbol: upperSymbol,
        notifications: data?.data?.notifications
      });
    }
    
    // 检查 notifications 字段中的 Earnings Date
    // 格式: "Earnings Date : Feb 5, 2026"
    const notifications = data?.data?.notifications || [];
    
    for (const notif of notifications) {
      const eventTypes = notif?.eventTypes || [];
      for (const event of eventTypes) {
        // 检查是否是财报事件
        if (event.eventName === 'Earnings Date' || event.id === 'upcoming_events') {
          const message = event.message || '';
          
          // 解析 "Earnings Date : Feb 5, 2026" 格式
          const match = message.match(/Earnings Date\s*:\s*(.+)/i);
          if (match) {
            const dateStr = match[1].trim();
            const parsedDate = new Date(dateStr);
            
            if (!isNaN(parsedDate.getTime())) {
              const today = new Date();
              today.setHours(0, 0, 0, 0);
              const diffDays = Math.ceil((parsedDate - today) / (1000 * 60 * 60 * 24));
              
              return res.status(200).json({
                success: true,
                symbol: upperSymbol,
                hasUpcomingEarnings: diffDays >= 0 && diffDays <= 30,
                earningsDate: parsedDate.toISOString().split('T')[0],
                daysUntilEarnings: diffDays,
                rawDate: dateStr,
                source: 'nasdaq'
              });
            }
          }
        }
      }
    }

    // 没找到财报日期
    return res.status(200).json({
      success: true,
      symbol: upperSymbol,
      hasUpcomingEarnings: false,
      earningsDate: null,
      daysUntilEarnings: null
    });

  } catch (error) {
    return res.status(200).json({
      success: true,
      symbol: upperSymbol,
      hasUpcomingEarnings: false,
      earningsDate: null,
      daysUntilEarnings: null,
      debug: { error: error.message }
    });
  }
}
