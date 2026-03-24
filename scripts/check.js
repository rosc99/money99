// ══════════════════════════════════════════════════════
//  money99 每日市場警報腳本
//  監控：0050 / 00662 / 2330
//  警報條件：三框架共振破位、收盤破支撐、風險評分 > 60
// ══════════════════════════════════════════════════════

import fetch from 'node-fetch';

const SYMBOLS = {
  '0050':  { name: '元大台灣50',  yahoo: '0050.TW'  },
  '00662': { name: '富邦NASDAQ',  yahoo: '00662.TWO' },
  '2330':  { name: '台積電',      yahoo: '2330.TW'  },
};

const TIMEFRAMES = {
  '3M':  { range: '3mo',  days: 63  },
  '6M':  { range: '6mo',  days: 126 },
  '1Y':  { range: '1y',   days: 252 },
};

const CORS_PROXY = 'https://corsproxy.io/?url=';

// ──────────────────────────────────────────────
//  1. 抓歷史 K 線
// ──────────────────────────────────────────────
async function fetchHistory(yahooSym, rangeDays) {
  const to   = Math.floor(Date.now() / 1000);
  const from = to - rangeDays * 86400 * 1.4; // 多抓一點避免假日缺漏
  const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSym}?interval=1d&period1=${from}&period2=${to}`;

  // 直接打（Actions 伺服器不需要 CORS proxy）
  const res  = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Yahoo fetch failed: ${res.status}`);
  const json = await res.json();
  const r    = json?.chart?.result?.[0];
  if (!r) throw new Error('No chart data');

  const ts = r.timestamp || [];
  const q  = r.indicators.quote[0];
  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    if (!q.close[i]) continue;
    rows.push({
      date:   new Date(ts[i] * 1000).toISOString().slice(0, 10),
      open:   q.open[i]   || q.close[i],
      high:   q.high[i]   || q.close[i],
      low:    q.low[i]    || q.close[i],
      close:  q.close[i],
      volume: q.volume[i] || 0,
    });
  }
  return rows.slice(-rangeDays); // 只保留指定天數
}

// ──────────────────────────────────────────────
//  2. 計算 VRVP 高量節點（HVN）
// ──────────────────────────────────────────────
function calcVRVP(rows, bins = 40) {
  if (!rows.length) return [];
  const allPrices = rows.flatMap(r => [r.high, r.low]);
  const min  = Math.min(...allPrices);
  const max  = Math.max(...allPrices);
  const step = (max - min) / bins || 1;

  const profile = Array.from({ length: bins }, (_, i) => ({
    priceFrom: min + i * step,
    priceTo:   min + (i + 1) * step,
    priceMid:  min + (i + 0.5) * step,
    vol: 0,
  }));

  rows.forEach(r => {
    const lo   = r.low;
    const hi   = r.high;
    const span = hi - lo || step;
    for (let b = 0; b < bins; b++) {
      const overlap = Math.max(0,
        Math.min(hi, profile[b].priceTo) - Math.max(lo, profile[b].priceFrom)
      );
      profile[b].vol += r.volume * (overlap / span);
    }
  });

  const maxVol = Math.max(...profile.map(p => p.vol), 1);
  profile.forEach(p => { p.pct = p.vol / maxVol; });

  // 前 3 高量節點（支撐/壓力帶）
  return [...profile]
    .sort((a, b) => b.vol - a.vol)
    .slice(0, 3)
    .map(z => ({
      mid:  +z.priceMid.toFixed(2),
      high: +z.priceTo.toFixed(2),
      low:  +z.priceFrom.toFixed(2),
      pct:  z.pct,
    }));
}

// ──────────────────────────────────────────────
//  3. 計算 SMA
// ──────────────────────────────────────────────
function sma(arr, n) {
  if (arr.length < n) return null;
  return arr.slice(-n).reduce((a, b) => a + b, 0) / n;
}

// ──────────────────────────────────────────────
//  4. 分析單一標的
// ──────────────────────────────────────────────
async function analyzeSymbol(code, info) {
  console.log(`\n分析 ${code} ${info.name}...`);

  const alerts  = [];
  const details = {};
  const frameResults = {};

  // 抓三個時間框架
  for (const [tfName, tf] of Object.entries(TIMEFRAMES)) {
    try {
      const rows = await fetchHistory(info.yahoo, tf.days);
      if (rows.length < 20) { console.log(`  ${tfName}: 資料不足`); continue; }

      const lastClose = rows.at(-1).close;
      const closes    = rows.map(r => r.close);
      const ma20      = sma(closes, 20);
      const hvnZones  = calcVRVP(rows);

      // 找低於當前價的最近支撐
      const supports = hvnZones
        .filter(z => z.mid < lastClose)
        .sort((a, b) => b.mid - a.mid);
      const nearSupport = supports[0] || null;

      // 找高於當前價的最近壓力
      const resists = hvnZones
        .filter(z => z.mid > lastClose)
        .sort((a, b) => a.mid - b.mid);
      const nearResist = resists[0] || null;

      // 判斷收盤是否已破支撐（在最近 HVN 支撐帶以下）
      const brokeSupport = nearSupport
        ? lastClose < nearSupport.low
        : false;

      // 判斷是否「接近支撐」（距離 < 2%）
      const nearSupportDist = nearSupport
        ? (lastClose - nearSupport.high) / lastClose * 100
        : null;
      const approachingSupport = nearSupportDist !== null && nearSupportDist < 2 && nearSupportDist > 0;

      frameResults[tfName] = {
        lastClose,
        ma20,
        nearSupport,
        nearResist,
        brokeSupport,
        approachingSupport,
        nearSupportDist,
      };

      console.log(`  ${tfName}: 收盤 ${lastClose} | 支撐 ${nearSupport?.high ?? '—'} | 破位: ${brokeSupport}`);
    } catch (e) {
      console.log(`  ${tfName} 抓取失敗: ${e.message}`);
    }
  }

  details.frameResults = frameResults;
  details.lastClose = frameResults['3M']?.lastClose ?? null;

  // ── 警報判斷 ──

  // A. 收盤破支撐（任一框架）
  for (const [tfName, fr] of Object.entries(frameResults)) {
    if (fr.brokeSupport) {
      alerts.push({
        level: '🔴 破位',
        type:  'broke_support',
        msg:   `【${tfName}框架】收盤 ${fr.lastClose} 已跌破支撐帶 ${fr.nearSupport?.low}–${fr.nearSupport?.high}`,
      });
    }
  }

  // B. 三框架共振破位（三個框架全部都顯示收盤在支撐下方）
  const broke3 = Object.values(frameResults).filter(fr => fr.brokeSupport).length;
  if (broke3 >= 3) {
    alerts.push({
      level: '🚨 共振破位',
      type:  'triple_resonance',
      msg:   `三框架（3M/6M/1Y）全部支撐已失守，趨勢轉空訊號確立`,
    });
  } else if (broke3 === 2) {
    alerts.push({
      level: '⚠️ 二框架破位',
      type:  'double_resonance',
      msg:   `兩個時間框架支撐已失守，注意第三框架是否跟進`,
    });
  }

  // C. 接近支撐（任一框架）
  for (const [tfName, fr] of Object.entries(frameResults)) {
    if (fr.approachingSupport) {
      alerts.push({
        level: '💛 接近支撐',
        type:  'approaching',
        msg:   `【${tfName}框架】距離支撐帶僅 ${fr.nearSupportDist?.toFixed(1)}%（${fr.nearSupport?.high}–${fr.nearSupport?.mid}）`,
      });
    }
  }

  return { code, name: info.name, alerts, details };
}

// ──────────────────────────────────────────────
//  5. 風險評分（台灣加權指數）
// ──────────────────────────────────────────────
async function calcRiskScore() {
  try {
    // 抓加權指數 ^TWII 一年資料
    const rows = await fetchHistory('%5ETWII', 252);
    if (rows.length < 60) return null;

    const closes  = rows.map(r => r.close);
    const lastClose = closes.at(-1);
    const ma60    = sma(closes, 60);
    const ma240   = sma(closes, 240);

    const bias60  = ma60  ? (lastClose - ma60)  / ma60  * 100 : null;
    const bias240 = ma240 ? (lastClose - ma240) / ma240 * 100 : null;

    let score = 0;
    // 量價形態（乖離）
    if (bias240 > 25) score += 35;
    else if (bias240 > 15) score += 20;
    else if (bias240 > 8)  score += 10;

    if (bias60 > 15) score += 20;
    else if (bias60 > 8) score += 10;

    // 成交量比
    const vols   = rows.map(r => r.volume);
    const avgV20 = sma(vols, 20);
    const volR   = avgV20 ? vols.at(-1) / avgV20 : null;
    if (volR > 2)   score += 20;
    else if (volR > 1.5) score += 10;

    // 台積電乖離背離（額外加分）
    try {
      const tsmcRows = await fetchHistory('2330.TW', 252);
      const tsmcCloses = tsmcRows.map(r => r.close);
      const tsmcMa240  = sma(tsmcCloses, 240);
      const tsmcBias240 = tsmcMa240 ? (tsmcCloses.at(-1) - tsmcMa240) / tsmcMa240 * 100 : null;
      if (bias240 > 15 && tsmcBias240 !== null && tsmcBias240 < 5) score += 15; // 虛胖背離
    } catch {}

    return {
      score: Math.min(score, 100),
      twii:  lastClose,
      bias60:  bias60?.toFixed(1),
      bias240: bias240?.toFixed(1),
      volR:    volR?.toFixed(2),
    };
  } catch (e) {
    console.log('風險評分計算失敗:', e.message);
    return null;
  }
}

// ──────────────────────────────────────────────
//  6. 組合 Email HTML 內容
// ──────────────────────────────────────────────
function buildEmailHtml(results, riskData, triggerReasons) {
  const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

  const riskBlock = riskData ? `
    <div style="background:#1a1e2e;border-radius:10px;padding:14px 16px;margin-bottom:16px;border-left:3px solid ${riskData.score >= 60 ? '#dc2626' : riskData.score >= 40 ? '#f59e0b' : '#00e5a0'};">
      <div style="font-size:11px;color:#7a8099;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.1em;">台股高檔風險評分</div>
      <div style="font-size:32px;font-weight:900;color:${riskData.score >= 60 ? '#dc2626' : riskData.score >= 40 ? '#f59e0b' : '#00e5a0'};">${riskData.score}<span style="font-size:14px;color:#7a8099;">/100</span></div>
      <div style="font-size:12px;color:#7a8099;margin-top:6px;">
        加權指數 ${riskData.twii?.toLocaleString() ?? '—'} ｜
        60MA 乖離 ${riskData.bias60 ?? '—'}% ｜
        240MA 乖離 ${riskData.bias240 ?? '—'}%
      </div>
    </div>` : '';

  const symbolBlocks = results.map(r => {
    if (!r.alerts.length) return '';
    const alertRows = r.alerts.map(a => `
      <tr>
        <td style="padding:6px 0;font-size:12px;color:${a.level.includes('🔴') || a.level.includes('🚨') ? '#ff4d6d' : a.level.includes('⚠️') ? '#f59e0b' : '#fcd34d'};">
          ${a.level}
        </td>
        <td style="padding:6px 0 6px 12px;font-size:12px;color:#c4cad8;line-height:1.6;">${a.msg}</td>
      </tr>`).join('');

    const fr = r.details.frameResults;
    const frameRow = Object.entries(fr).map(([tf, d]) => `
      <td style="text-align:center;padding:6px;background:#141720;border-radius:6px;">
        <div style="font-size:10px;color:#7a8099;margin-bottom:3px;">${tf}</div>
        <div style="font-size:13px;font-weight:700;color:${d.brokeSupport ? '#ff4d6d' : d.approachingSupport ? '#f59e0b' : '#00e5a0'};">
          ${d.brokeSupport ? '破位' : d.approachingSupport ? '接近' : '安全'}
        </div>
        <div style="font-size:10px;color:#4a5068;margin-top:2px;">支撐 ${d.nearSupport?.high ?? '—'}</div>
      </td>`).join('<td style="width:6px;"></td>');

    return `
      <div style="background:#1a1e2e;border-radius:10px;padding:14px 16px;margin-bottom:12px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
          <div>
            <span style="font-size:16px;font-weight:900;color:#e8ecf5;">${r.code}</span>
            <span style="font-size:12px;color:#7a8099;margin-left:8px;">${r.name}</span>
          </div>
          <span style="font-size:18px;font-weight:700;color:#e8ecf5;">${r.details.lastClose?.toLocaleString() ?? '—'}</span>
        </div>
        <table style="width:100%;border-collapse:separate;border-spacing:0 0;margin-bottom:10px;"><tbody>${frameRow ? `<tr>${frameRow}</tr>` : ''}</tbody></table>
        <table style="width:100%;"><tbody>${alertRows}</tbody></table>
      </div>`;
  }).join('');

  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0d0f14;font-family:'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:24px 16px;">

    <!-- Header -->
    <div style="text-align:center;margin-bottom:24px;">
      <div style="font-size:11px;color:#7a8099;letter-spacing:0.2em;text-transform:uppercase;margin-bottom:6px;">money99 市場警報</div>
      <div style="font-size:22px;font-weight:900;color:#e8ecf5;">📡 今日警報通知</div>
      <div style="font-size:11px;color:#4a5068;margin-top:6px;">${now}</div>
    </div>

    <!-- 觸發原因摘要 -->
    <div style="background:#1a1e2e;border-radius:10px;padding:12px 16px;margin-bottom:16px;border:1px solid #252a3a;">
      <div style="font-size:11px;color:#f59e0b;font-weight:700;margin-bottom:8px;">⚠️ 本次警報觸發原因</div>
      ${triggerReasons.map(t => `<div style="font-size:12px;color:#c4cad8;padding:3px 0;border-bottom:1px solid #1e2437;">▸ ${t}</div>`).join('')}
    </div>

    <!-- 風險評分 -->
    ${riskBlock}

    <!-- 各標的詳情 -->
    <div style="font-size:11px;color:#7a8099;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:8px;">標的警報詳情</div>
    ${symbolBlocks || '<div style="color:#7a8099;font-size:12px;text-align:center;padding:16px;">無標的警報</div>'}

    <!-- 說明 -->
    <div style="margin-top:20px;padding:12px 16px;background:#141720;border-radius:8px;border:1px solid #1e2437;">
      <div style="font-size:11px;color:#4a5068;line-height:1.8;">
        📌 <b style="color:#7a8099;">三框架共振</b>：3M / 6M / 1Y 三個時間框架的 VRVP 支撐同時失守，為最強轉空訊號。<br>
        📌 <b style="color:#7a8099;">收盤破支撐</b>：當日收盤價跌破該框架 HVN 高量節點支撐帶下緣。<br>
        📌 <b style="color:#7a8099;">風險評分 > 60</b>：基於大盤乖離、量比等五維度的高檔風險指標。
      </div>
    </div>

    <!-- Footer -->
    <div style="text-align:center;margin-top:20px;font-size:10px;color:#2e3550;">
      由 money99 自動監控系統產生 · 僅供參考，不構成投資建議
    </div>
  </div>
</body>
</html>`;
}

// ──────────────────────────────────────────────
//  7. 發送 EmailJS（REST API）
// ──────────────────────────────────────────────
async function sendEmail(subject, htmlContent) {
  const serviceId  = process.env.EMAILJS_SERVICE_ID;
  const templateId = process.env.EMAILJS_TEMPLATE_ID;
  const publicKey  = process.env.EMAILJS_PUBLIC_KEY;
  const toEmail    = process.env.ALERT_EMAIL;

  if (!serviceId || !templateId || !publicKey || !toEmail) {
    console.log('⚠️  EmailJS 環境變數未設定，跳過發信');
    return false;
  }

  const body = {
    service_id:  serviceId,
    template_id: templateId,
    user_id:     publicKey,
    template_params: {
      to_email: toEmail,
      subject,
      message_html: htmlContent,
      date: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
    },
  };

  const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  if (res.ok) {
    console.log('✅ Email 已發送！');
    return true;
  } else {
    const txt = await res.text();
    console.log(`❌ Email 發送失敗: ${res.status} ${txt}`);
    return false;
  }
}

// ──────────────────────────────────────────────
//  8. 主流程
// ──────────────────────────────────────────────
async function main() {
  console.log('══════════════════════════════════');
  console.log(' money99 市場警報 - 開始執行');
  console.log(' 時間:', new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }));
  console.log('══════════════════════════════════');

  // 分析各標的
  const results = [];
  for (const [code, info] of Object.entries(SYMBOLS)) {
    try {
      const result = await analyzeSymbol(code, info);
      results.push(result);
    } catch (e) {
      console.log(`❌ ${code} 分析失敗:`, e.message);
    }
    await new Promise(r => setTimeout(r, 800)); // 避免 rate limit
  }

  // 計算風險評分
  console.log('\n計算台股風險評分...');
  const riskData = await calcRiskScore();
  console.log(`風險評分: ${riskData?.score ?? '計算失敗'}`);

  // 整理所有觸發原因
  const triggerReasons = [];
  for (const r of results) {
    for (const a of r.alerts) {
      triggerReasons.push(`${r.name}（${r.code}）${a.msg}`);
    }
  }
  if (riskData && riskData.score > 60) {
    triggerReasons.push(`台股風險評分 ${riskData.score}/100，超過警戒值（60分）`);
  }

  console.log(`\n觸發警報數量: ${triggerReasons.length}`);

  // 沒有任何警報 → 不發信
  if (triggerReasons.length === 0) {
    console.log('✅ 今日無警報，市場結構正常，不發送 Email。');
    return;
  }

  // 有警報 → 組 Email 並發送
  console.log('\n警報清單：');
  triggerReasons.forEach(t => console.log(' ▸', t));

  const alertCount   = triggerReasons.length;
  const hasTriple    = results.some(r => r.alerts.some(a => a.type === 'triple_resonance'));
  const hasBroke     = results.some(r => r.alerts.some(a => a.type === 'broke_support'));
  const hasHighRisk  = riskData && riskData.score > 60;

  const urgency = hasTriple ? '🚨 緊急' : hasBroke ? '🔴 警告' : '⚠️ 注意';
  const subject = `${urgency} money99 市場警報（${alertCount}項）${new Date().toLocaleDateString('zh-TW')}`;

  const html = buildEmailHtml(results, riskData, triggerReasons);
  await sendEmail(subject, html);
}

main().catch(e => {
  console.error('腳本執行錯誤:', e);
  process.exit(1);
});
