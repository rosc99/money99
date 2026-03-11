Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const url = new URL(req.url);

  // ══════════════════════════════════════════
  //  路由 1: /stooq  — 歷史 K 線 proxy
  //  用法: ?s=qqq.us&days=60
  // ══════════════════════════════════════════
  if (url.pathname.endsWith("/stooq")) {
    const sym  = (url.searchParams.get("s") || "").trim().toLowerCase();
    const days = parseInt(url.searchParams.get("days") || "30");
    if (!sym) return new Response(JSON.stringify({ error: "no symbol" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    try {
      const r = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(sym)}&i=d`, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(10000),
      });
      const text = await r.text();
      if (!text || text.includes("No data") || text.includes("Exceeded"))
        return new Response(JSON.stringify({ error: "no data", sym }), { status: 404, headers: { ...cors, "Content-Type": "application/json" } });
      const lines  = text.trim().split("\n").slice(1).filter(Boolean);
      const closes = lines.slice(-Math.max(days, 2)).map(l => parseFloat(l.split(",")[4])).filter(v => !isNaN(v) && v > 0);
      if (closes.length < 2)
        return new Response(JSON.stringify({ error: "insufficient data", sym }), { status: 404, headers: { ...cors, "Content-Type": "application/json" } });
      const price      = closes[closes.length - 1];
      const prev       = closes[closes.length - 2];
      const change_pct = ((price - prev) / prev) * 100;
      return new Response(JSON.stringify({ key: sym, closes, price, change_pct, updated_at: new Date().toISOString() }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message, sym }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
    }
  }

  // ══════════════════════════════════════════
  //  路由 2: /bci  — 台灣景氣燈號 proxy
  // ══════════════════════════════════════════
  if (url.pathname.endsWith("/bci")) {
    const fallback = { signal: "綠燈", month: "114/01", score: 23 };
    try {
      const r    = await fetch("https://api.allorigins.win/get?url=" + encodeURIComponent("https://index.ndc.gov.tw/n/zh_tw"), { signal: AbortSignal.timeout(10000) });
      const d    = await r.json();
      const html = d.contents || "";
      let signal = fallback.signal;
      for (const sig of ["紅燈", "黃紅燈", "綠燈", "黃藍燈", "藍燈"]) { if (html.includes(sig)) { signal = sig; break; } }
      const m     = html.match(/(\d{3})\s*年\s*(\d{1,2})\s*月/);
      const month = m ? `${m[1]}/${m[2].padStart(2, "0")}` : fallback.month;
      const s     = html.match(/綜合判斷分數[^\d]*(\d{1,2})/);
      const score = s ? parseInt(s[1]) : fallback.score;
      return new Response(JSON.stringify({ signal, month, score, updated_at: new Date().toISOString() }), { headers: { ...cors, "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ ...fallback, updated_at: new Date().toISOString() }), { headers: { ...cors, "Content-Type": "application/json" } });
    }
  }

  // ══════════════════════════════════════════
  //  路由 3: 預設 — 台股即時報價（原有邏輯）
  // ══════════════════════════════════════════
  const ticker = (url.searchParams.get("ticker") || "").trim().toUpperCase();
  if (!ticker) return new Response(JSON.stringify({ error: "no ticker" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    const r = await fetch(`https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_${ticker}.tw&json=1&delay=0`, { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://mis.twse.com.tw/" } });
    const d = await r.json(); const item = d?.msgArray?.[0];
    if (item && item.z && item.z !== "-") return new Response(JSON.stringify({ ticker, symbol: ticker+".TW", price: parseFloat(item.z), change: parseFloat(item.y)?parseFloat(item.z)-parseFloat(item.y):0, name: item.n||ticker, src:"twse-mis" }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {}

  try {
    const r = await fetch(`https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=otc_${ticker}.tw&json=1&delay=0`, { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://mis.twse.com.tw/" } });
    const d = await r.json(); const item = d?.msgArray?.[0];
    if (item && item.z && item.z !== "-") return new Response(JSON.stringify({ ticker, symbol: ticker+".TWO", price: parseFloat(item.z), change: parseFloat(item.y)?parseFloat(item.z)-parseFloat(item.y):0, name: item.n||ticker, src:"tpex-mis" }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {}

  try {
    const r = await fetch("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL", { headers: { "User-Agent": "Mozilla/5.0" } });
    const arr = await r.json(); const item = arr.find((s) => s.Code === ticker);
    if (item?.ClosingPrice) { const price = parseFloat(item.ClosingPrice); if (price > 0) return new Response(JSON.stringify({ ticker, symbol: ticker+".TW", price, change: parseFloat(item.Change)||0, name: item.Name||ticker, src:"twse-openapi" }), { headers: { ...cors, "Content-Type": "application/json" } }); }
  } catch (e) {}

  try {
    const r = await fetch("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes?l=zh-tw", { headers: { "User-Agent": "Mozilla/5.0" } });
    const arr = await r.json(); const item = arr.find((s) => (s.SecuritiesCompanyCode||s.Code) === ticker);
    if (item) { const price = parseFloat((item.Close||item.ClosingPrice||"").replace(/,/g,"")); if (price > 0) return new Response(JSON.stringify({ ticker, symbol: ticker+".TWO", price, change: parseFloat((item.Change||"0").replace(/,/g,""))||0, name: item.CompanyName||item.Name||ticker, src:"tpex-openapi" }), { headers: { ...cors, "Content-Type": "application/json" } }); }
  } catch (e) {}

  return new Response(JSON.stringify({ error: "not found", ticker }), { status: 404, headers: { ...cors, "Content-Type": "application/json" } });
});
