#!/usr/bin/env node

/**
 * PPIO 产业政策信息流 — Step 4: Render
 * Generates static index.html from curated items + weekly synthesis.
 *
 * Input:  data/curated-items.json + data/daily-synthesis.json
 * Output: index.html (overwrites the feed page)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CURATED_PATH = resolve(ROOT, 'data', 'curated-items.json');
const SYNTH_PATH = resolve(ROOT, 'data', 'daily-synthesis.json');
const OUT_PATH = resolve(ROOT, 'index.html');

// ---- helpers ---------------------------------------------------------------

function loadJSON(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---- word frequency analysis -----------------------------------------------

const STOPWORDS = new Set([
  '的','了','在','是','和','与','及','等','对','为','将','于','以','从','到','中',
  '有','被','由','其','该','这','那','也','都','但','而','或','如','则','并','已',
  '可','能','会','要','应','需','据','称','表示','指出','强调','认为','显示',
  '相关','方面','进行','推进','建设','发展','工作','问题','情况','通过','实现',
  '加强','提升','支持','促进','加快','完善','推动','开展','落实','深化',
  '一','二','三','四','五','六','七','八','九','十','万','亿','年','月','日',
  '上','下','内','外','前','后','新','大','小','多','少','高','低',
  '统筹','动态','重大','战略','意义','融合','潜力','助力','阐述','解读',
  '用好','各类','政府','资金','工具','政策','金融','新型','内容','进一步',
  '基础设施','实体经济','数字经济','网络投资','投资潜力',
  'AI', 'ai', '2026', '2025',
]);

function extractKeywords(items) {
  const freq = {};

  const EN_WHITELIST = new Set([
    'IPO', 'GPU', 'LLM', 'API', 'VIE', 'OPC', 'Token', 'Nvidia',
    'OpenAI', 'Anthropic', 'DeepSeek', 'ChatGPT', 'Claude', 'Gemini',
  ]);

  // Key noun phrases to extract — match these first before generic splitting
  const KEY_PHRASES = [
    '六张网', '算力网', '一体化算力网', '算力基础设施', '算力套餐',
    '无问芯穹', '超聚变', '边缘计算', '边缘云', '分布式算力',
    '大模型', '智能体', '人工智能', '生成式AI', '算力调度',
    '国常会', '发改委', '工信部', '网信办', '科技部',
    '出口管制', '芯片禁令', '英伟达', '安全审查',
    '香港IPO', '创业板', '境外上市', '产业基金',
    '电信运营商', '算力普惠', '数字经济', '新质生产力',
    '丁薛祥', '人工智能法', 'H200', 'H100',
  ];

  for (const item of items) {
    const text = (item.title || '') + ' ' + (item.summary_cn || '');

    // First pass: extract key phrases
    for (const phrase of KEY_PHRASES) {
      if (text.includes(phrase)) {
        freq[phrase] = (freq[phrase] || 0) + 1;
      }
    }

    // Second pass: split by punctuation and spaces, keep 2-6 char segments
    const segments = text.split(/[\s，。！？、：；""''【】《》\(\)（）\-—·\/\\]+/);
    for (const seg of segments) {
      const w = seg.trim();
      if (w.length < 2 || w.length > 6) continue;
      if (STOPWORDS.has(w)) continue;
      if (/^\d+$/.test(w)) continue;
      if (!/[一-鿿]/.test(w)) continue; // must contain Chinese
      // Skip if already counted as a key phrase
      if (KEY_PHRASES.includes(w)) continue;
      freq[w] = (freq[w] || 0) + 1;
    }

    // English whitelist
    for (const w of EN_WHITELIST) {
      if (text.includes(w)) freq[w] = (freq[w] || 0) + 1;
    }
  }

  return Object.entries(freq)
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([word, count]) => ({ word, count }));
}

function renderWordCloud(keywords) {
  if (!keywords || keywords.length === 0) return '';

  const max = keywords[0].count;
  const min = keywords[keywords.length - 1].count;

  const words = keywords.map(({ word, count }) => {
    // Font size: 0.75rem (low freq) to 2rem (high freq)
    const ratio = max === min ? 0.5 : (count - min) / (max - min);
    const size = (0.75 + ratio * 1.25).toFixed(2);
    const opacity = (0.5 + ratio * 0.5).toFixed(2);
    return `<span class="wc-word" style="font-size:${size}rem;opacity:${opacity}" title="${esc(word)}: ${count}次">${esc(word)}</span>`;
  }).join('\n    ');

  return `<section class="word-cloud-section">
  <h2 class="speed-read-title">本周高频词</h2>
  <div class="word-cloud">
    ${words}
  </div>
</section>`;
}



function renderHeader(week) {
  return `<header class="page-header">
  <span class="brand">PPIO 产业政策信息流</span>
  <span class="header-meta">
    最后更新: <time datetime="${week}">${week}</time>
  </span>
  <nav class="header-nav" aria-label="导航">
    <a href="manage.html">管理</a>
    <a href="archive.html">日报存档 →</a>
  </nav>
</header>`;
}

function renderTabs(curated) {
  const categories = ['政策', '竞品', '监管', '资本', '海外', '技术', '治理'];
  const counts = {};
  categories.forEach(c => {
    counts[c] = curated.items.filter(i => i.category === c).length;
  });
  const total = curated.items.length;

  const tabs = categories.map(c =>
    `<button class="tab" data-tab="${c}" role="tab" aria-selected="false">
      ${c} <span class="tab-count">${counts[c] || 0}</span>
    </button>`
  ).join('\n          ');

  return `<nav class="feed-tabs" role="tablist">
          <button class="tab is-active" data-tab="all" role="tab" aria-selected="true">
            全部 <span class="tab-count">${total}</span>
          </button>
          ${tabs}
        </nav>`;
}

function renderSignalChips(signals) {
  if (!signals || !signals.length) return '';
  const tips = {
    '🏛️': '中央/部委级别的政策文件与部署',
    '📜': 'AI立法、安全审查、合规动向',
    '⚔️': '竞争对手的融资、产品、战略变化',
    '💰': '行业融资事件、估值变化、IPO动态',
    '🌏': '美国/欧盟AI监管与政策动向',
    '🔬': '模型能力跃迁、基础设施突破'
  };
  return `<span class="signal-chips">${signals.map(s =>
    `<span class="signal-chip" data-tip="${esc(tips[s] || '')}" aria-label="${esc(tips[s] || '')}">${esc(s)}</span>`
  ).join('')}</span>`;
}

function renderPPIOSignal(ppio) {
  if (!ppio) return '';
  const fields = [
    { key: 'positive', label: '🟢 利好信号' },
    { key: 'risk', label: '🔴 风险信号' }
  ];
  const body = fields
    .filter(f => ppio[f.key])
    .map(f => `<p><strong>${f.label}：</strong>${esc(ppio[f.key])}</p>`)
    .join('\n            ');

  if (!body) return '';
  return `<details class="ppio-signal">
            <summary>PPIO 信号</summary>
            ${body}
          </details>`;
}

function renderFeedItem(item, idx) {
  const rank = String(idx + 1);
  const isEnglish = /[a-z]{4,}/.test(item.title) && !/[一-鿿]/.test(item.title);
  const enBadge = isEnglish ? '<span class="card-badge card-badge--en">EN</span>' : '';
  const catColor = {
    '政策': '#e8f4fd', '竞品': '#fdf3e8', '监管': '#fdf0f0',
    '资本': '#f0fdf4', '海外': '#f3f0fd', '技术': '#f0f8fd', '治理': '#fdf8f0'
  };
  const catBg = catColor[item.category] || '#f5f5f5';
  return `<li class="feed-card" data-deep="${item.is_deep_read ? 'true' : 'false'}" data-tags="${esc(item.category || '')}">
        <div class="card-header">
          <span class="card-source">${esc(item.source)}</span>
          <span class="card-sep">·</span>
          <time class="card-date">${esc(item.published || '')}</time>
          <span class="card-sep">·</span>
          <span class="card-cat" style="background:${catBg}">${esc(item.category)}</span>
          ${enBadge}
          ${renderSignalChips(item.signals)}
          <span class="card-rank">#${rank}</span>
        </div>
        <h2 class="card-title">
          <a href="${esc(item.url || '#')}" target="_blank" rel="noopener">${esc(item.title)}</a>
        </h2>
        <p class="card-excerpt">${esc(item.summary_cn || item.body_snippet || '')}</p>
        ${renderPPIOSignal(item.ppio_signal)}
      </li>`;
}

function renderWindIndicators(synthesis) {
  if (!synthesis || !synthesis.wind_indicators) return '';
  const w = synthesis.wind_indicators;

  const sentimentColor = {
    '升温': '#e8f7ee', '活跃': '#e8f0fe', '平稳': '#f5f5f5',
    '降温': '#fdf3f0', '观望': '#fdfaf0'
  };
  const sentimentText = {
    '升温': '#2d7a4f', '活跃': '#1a56db', '平稳': '#555',
    '降温': '#8f3b27', '观望': '#8f7020'
  };
  const bg = sentimentColor[w.overall_sentiment] || '#f5f5f5';
  const fg = sentimentText[w.overall_sentiment] || '#333';

  function heatBar(val) {
    const v = Math.max(1, Math.min(5, val || 1));
    return Array.from({length: 5}, (_, i) =>
      `<span class="heat-dot ${i < v ? 'heat-on' : 'heat-off'}"></span>`
    ).join('');
  }

  const indicators = [
    { label: '政策热度', val: w.policy_heat },
    { label: '竞品动态', val: w.competitor_heat },
    { label: '资本活跃', val: w.capital_heat },
    { label: '海外监管', val: w.overseas_heat },
  ];

  return `<section class="wind-section">
  <div class="wind-header">
    <h2 class="speed-read-title">本周风向</h2>
    <span class="wind-sentiment" style="background:${bg};color:${fg}">${esc(w.overall_sentiment)}</span>
  </div>
  <p class="wind-summary">${esc(w.summary || '')}</p>
  <div class="wind-grid">
    ${indicators.map(ind => `<div class="wind-item">
      <span class="wind-label">${esc(ind.label)}</span>
      <span class="wind-bar">${heatBar(ind.val)}</span>
    </div>`).join('\n    ')}
  </div>
</section>`;
}

function renderSpeedRead(synthesis) {
  if (!synthesis || !synthesis.speed_read) return '';

  const sr = synthesis.speed_read;
  return `<section class="ppio-speed-read">
    <h2 class="speed-read-title">PPIO 信号速读</h2>
    <p class="speed-read-mainline"><strong>今日主线：</strong>${esc(synthesis.mainline || '')}</p>
    <div class="speed-read-grid">
      <div class="speed-card signal-positive">
        <h4>🟢 利好信号</h4>
        <ul>${(sr.positive || []).filter(s => s && !s.includes('待 AI')).map(s => `<li>${esc(s)}</li>`).join('') || '<li class="muted">今日无重大利好信号</li>'}</ul>
      </div>
      <div class="speed-card signal-risk">
        <h4>🔴 风险信号</h4>
        <ul>${(sr.risk || []).filter(s => s && !s.includes('待 AI')).map(s => `<li>${esc(s)}</li>`).join('') || '<li class="muted">今日无重大风险信号</li>'}</ul>
      </div>
    </div>
  </section>`;
}

function renderAnalysisPanel(synthesis, curated, archive) {
  const idx = synthesis.ppio_index || {};
  const score = idx.score ?? '—';
  const delta = idx.delta ?? 0;
  const deltaStr = delta > 0 ? `+${delta}` : String(delta);
  const deltaColor = delta > 0 ? '#16a34a' : delta < 0 ? '#dc2626' : '#6b7280';
  const interp = idx.interpretation || '';

  const sentimentColor = {
    '升温':'#2d7a4f','活跃':'#1a56db','平稳':'#555','降温':'#8f3b27','观望':'#8f7020'
  };
  const w = synthesis.wind_indicators || {};
  const sentiment = w.overall_sentiment || '—';
  const sentFg = sentimentColor[sentiment] || '#555';

  // Archive data for trend + history tabs
  const days = (archive?.days || []).slice(0, 90);
  const trend30 = days.slice(0, 30).reverse();
  const trendDates = JSON.stringify(trend30.map(d => d.date.slice(5)));
  const trendAttend = JSON.stringify(trend30.map(d => d.item_count?.attend || 0));
  const trendIndex = JSON.stringify(trend30.map(d => d.ppio_index?.score ?? null));
  const trendPolicy = JSON.stringify(trend30.map(d => d.wind_indicators?.policy_heat || 0));
  const trendCompete = JSON.stringify(trend30.map(d => d.wind_indicators?.competitor_heat || 0));

  // History table rows
  const historyRows = days.map(d => {
    const signals = Object.entries(d.signal_summary || {})
      .filter(([, v]) => v > 0).map(([k, v]) => `${k}×${v}`).join(' ');
    const counts = d.item_count || {};
    const idxScore = d.ppio_index?.score;
    const idxDelta = d.ppio_index?.delta;
    const deltaHtml = idxDelta != null
      ? (idxDelta > 0 ? `<span style="color:#16a34a;font-size:0.75rem">+${idxDelta}</span>`
      : idxDelta < 0 ? `<span style="color:#dc2626;font-size:0.75rem">${idxDelta}</span>` : '') : '';
    const sent = d.wind_indicators?.overall_sentiment || '';
    const sentC = sentimentColor[sent] || '#888';
    return `<tr>
      <td><a href="reports/${esc(d.date)}.html" target="_blank">${esc(d.date)}</a></td>
      <td class="hist-mainline">${esc(d.mainline || '')}</td>
      <td style="white-space:nowrap">${esc(signals)}</td>
      <td>${counts.attend || 0}/${counts.total || 0}</td>
      <td>${idxScore != null ? `${idxScore}${deltaHtml}` : '—'}</td>
      <td><span style="color:${sentC};font-weight:600;font-size:0.78rem">${esc(sent)}</span></td>
    </tr>`;
  }).join('\n');

  return `<main class="feed analysis-panel">

  <!-- 分析子 tab -->
  <nav class="analysis-tabs" role="tablist">
    <button class="atab is-active" data-atab="today" role="tab">今日分析</button>
    <button class="atab" data-atab="trend" role="tab">30天趋势</button>
    <button class="atab" data-atab="history" role="tab">历史存档</button>
  </nav>

  <!-- 今日分析 -->
  <div class="atab-panel" id="atab-today">
    <div class="analysis-summary">
      <div class="ppio-index-card">
        <div class="ppio-index-label">PPIO 战略环境指数</div>
        <div class="ppio-index-score">${score}<span class="ppio-index-delta" style="color:${deltaColor}">${deltaStr}</span></div>
        <div class="ppio-index-interp">${esc(interp)}</div>
      </div>
      <div class="ppio-index-card">
        <div class="ppio-index-label">今日整体风向</div>
        <div class="ppio-index-score" style="color:${sentFg}">${esc(sentiment)}</div>
        <div class="ppio-index-interp">${esc(w.summary || '')}</div>
      </div>
    </div>
    <section class="analysis-section">
      <h2 class="analysis-title">机会-威胁象限图</h2>
      <p class="analysis-desc">点大小 = 重要程度 · 颜色 = 新闻类别 · 悬停查看详情</p>
      <div class="chart-wrap chart-wrap--quadrant">
        <div class="quadrant-bg">
          <span class="ql ql-tl">⚠ 险境</span>
          <span class="ql ql-tr">🔴 红海</span>
          <span class="ql ql-bl">🌱 机遇</span>
          <span class="ql ql-br">🟢 蓝海</span>
        </div>
        <canvas id="chart-quadrant"></canvas>
      </div>
      <div class="chart-legend" id="quadrant-legend"></div>
    </section>
    <section class="analysis-section">
      <h2 class="analysis-title">PPIO 指数成分分解</h2>
      <p class="analysis-desc">各因子对今日综合指数的贡献（绿=正向，红=负向）</p>
      <div class="chart-wrap chart-wrap--bar"><canvas id="chart-index"></canvas></div>
    </section>
    <section class="analysis-section">
      <h2 class="analysis-title">今日 Attend 信号分布</h2>
      <p class="analysis-desc">深度处理条目按类别分布</p>
      <div class="chart-wrap chart-wrap--donut"><canvas id="chart-signals"></canvas></div>
    </section>
  </div>

  <!-- 30天趋势 -->
  <div class="atab-panel" id="atab-trend" style="display:none">
    ${trend30.length < 2 ? '<p style="color:var(--ink-mute);font-family:var(--sans);font-size:0.84rem;padding:2rem 0">数据积累中，至少需要2天历史数据</p>' : `
    <div class="trend-grid">
      <div class="trend-card">
        <p class="trend-card-title">PPIO 战略环境指数</p>
        <div style="height:160px"><canvas id="chart-trend-index"></canvas></div>
      </div>
      <div class="trend-card">
        <p class="trend-card-title">每日 Attend 条数</p>
        <div style="height:160px"><canvas id="chart-trend-attend"></canvas></div>
      </div>
      <div class="trend-card">
        <p class="trend-card-title">政策热度</p>
        <div style="height:160px"><canvas id="chart-trend-policy"></canvas></div>
      </div>
      <div class="trend-card">
        <p class="trend-card-title">竞争热度</p>
        <div style="height:160px"><canvas id="chart-trend-compete"></canvas></div>
      </div>
    </div>
    <script id="trend-data" type="application/json">${JSON.stringify({
      dates: trend30.map(d => d.date.slice(5)),
      attend: trend30.map(d => d.item_count?.attend || 0),
      index: trend30.map(d => d.ppio_index?.score ?? null),
      policy: trend30.map(d => d.wind_indicators?.policy_heat || 0),
      compete: trend30.map(d => d.wind_indicators?.competitor_heat || 0)
    })}</script>`}
  </div>

  <!-- 历史存档 -->
  <div class="atab-panel" id="atab-history" style="display:none">
    <p style="font-family:var(--sans);font-size:0.82rem;color:var(--ink-mute);margin:0 0 1rem">共 ${days.length} 天记录</p>
    ${days.length === 0
      ? '<p style="color:var(--ink-mute);font-family:var(--mono);font-size:0.82rem">暂无存档</p>'
      : `<div style="overflow-x:auto">
      <table class="hist-table">
        <thead><tr>
          <th>日期</th><th>当日主线</th><th>信号</th><th>深度/总</th><th>指数</th><th>风向</th>
        </tr></thead>
        <tbody>${historyRows}</tbody>
      </table></div>`}
  </div>
</main>`;
}

function renderHTML(curated, synthesis, archive) {
  const week = curated.week || '';
  const items = curated.items || [];
  const attend = items.filter(i => i.lane === 'attend');
  const silent = items.filter(i => i.lane === 'silent');
  const keywords = extractKeywords(items);

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PPIO 产业政策信息流 — ${week}</title>
<link rel="stylesheet" href="reader.css">
<style>
  .ppio-signal {
    margin-top: 0.45rem;
    font-family: var(--sans);
    font-size: 0.82rem;
    line-height: 1.55;
    color: var(--ink-soft);
    background: var(--bg-soft);
    border-left: 3px solid var(--rule);
    padding: 0.45rem 0.7rem;
    border-radius: 0 3px 3px 0;
  }
  .ppio-signal summary {
    font-family: var(--mono);
    font-size: 0.72rem;
    color: var(--ink-mute);
    cursor: pointer;
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }
  .ppio-signal summary:hover { color: var(--ink-soft); }
  .ppio-signal p { margin: 0.25rem 0 0; }

  .ppio-speed-read {
    margin-top: 2.8rem;
    padding-top: 1.4rem;
    border-top: 2px solid var(--ink);
  }
  .speed-read-title {
    font-family: var(--mono);
    font-size: 0.82rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink);
    margin: 0 0 0.8rem;
  }
  .speed-read-mainline {
    font-family: var(--serif);
    font-size: 1rem;
    line-height: 1.55;
    color: var(--ink);
    margin: 0 0 1.2rem;
    padding: 0.7rem 0.9rem;
    background: var(--bg-soft);
    border-radius: 3px;
  }
  .speed-read-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.8rem;
  }
  @media (max-width: 640px) {
    .speed-read-grid { grid-template-columns: 1fr; }
  }
  .speed-card {
    padding: 0.8rem 0.9rem;
    border-radius: 3px;
    font-family: var(--sans);
    font-size: 0.84rem;
    line-height: 1.55;
  }
  .speed-card h4 {
    font-family: var(--mono);
    font-size: 0.72rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    margin: 0 0 0.5rem;
  }
  .speed-card ul { margin: 0; padding-left: 1.1rem; }
  .speed-card li { margin-bottom: 0.28rem; color: var(--ink-soft); }
  .speed-card li:last-child { margin-bottom: 0; }
  .signal-positive { background: #f0f7f0; border: 1px solid #c8e0c8; }
  .signal-positive h4 { color: #3d6b3d; }
  .signal-risk { background: #fdf3f0; border: 1px solid #f0d0c8; }
  .signal-risk h4 { color: #8f3b27; }
  .speed-card ul li.muted { color: #999; font-style: italic; list-style: none; }
  .signal-watch { background: #fdfaf0; border: 1px solid #e8dcc0; }
  .signal-watch h4 { color: #8f7020; }
  .signal-action { background: #f0f4fa; border: 1px solid #c8d4e8; }
  .signal-action h4 { color: #2a5080; }
  .word-cloud-section {
    margin-top: 2.4rem;
    padding-top: 1.4rem;
    border-top: 1px solid var(--rule-soft);
  }
  .word-cloud {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 0.8rem;
    align-items: baseline;
    padding: 0.8rem 0;
    line-height: 1.8;
  }
  .wc-word {
    font-family: var(--sans);
    color: var(--ink);
    cursor: default;
    transition: opacity 0.15s;
    white-space: nowrap;
  }
  .wc-word:hover { opacity: 1 !important; color: var(--accent, #2a5080); }

  /* ── Wind indicators ── */
  .wind-section {
    margin-top: 2.4rem;
    padding: 1.1rem 1.2rem;
    background: var(--bg-soft);
    border: 1px solid var(--rule-soft);
    border-radius: 6px;
  }
  .wind-header { display: flex; align-items: center; gap: 0.7rem; margin-bottom: 0.4rem; }
  .wind-header .speed-read-title { margin: 0; }
  .wind-sentiment {
    font-family: var(--mono);
    font-size: 0.72rem;
    font-weight: 700;
    padding: 0.15rem 0.55rem;
    border-radius: 3px;
    letter-spacing: 0.04em;
  }
  .wind-summary {
    font-family: var(--sans);
    font-size: 0.84rem;
    color: var(--ink-soft);
    margin: 0 0 0.9rem;
    line-height: 1.5;
  }
  .wind-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.6rem;
  }
  @media (max-width: 640px) { .wind-grid { grid-template-columns: repeat(2, 1fr); } }
  .wind-item {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    background: #fff;
    border: 1px solid var(--rule-soft);
    border-radius: 4px;
    padding: 0.55rem 0.7rem;
  }
  .wind-label { font-family: var(--mono); font-size: 0.68rem; color: var(--ink-mute); letter-spacing: 0.03em; }
  .wind-bar { display: flex; gap: 3px; align-items: center; }
  .heat-dot { width: 8px; height: 8px; border-radius: 50%; }
  .heat-on { background: #2a7a4f; }
  .heat-off { background: #dde; }

  /* ── Feed cards ── */
  .feed-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.9rem; }
  .feed-card {
    background: #fff;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    padding: 0.9rem 1.1rem 0.85rem;
    transition: box-shadow 0.15s, border-color 0.15s;
  }
  .feed-card:hover { border-color: #b8c8dc; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
  .feed-card.is-tab-hidden { display: none; }
  .card-header {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.3rem 0.4rem;
    margin-bottom: 0.45rem;
    font-family: var(--mono);
    font-size: 0.72rem;
    color: var(--ink-mute);
  }
  .card-source { font-weight: 600; color: var(--ink-soft); }
  .card-sep { color: var(--rule); }
  .card-date { color: var(--ink-mute); }
  .card-cat {
    padding: 0.1rem 0.45rem;
    border-radius: 3px;
    font-size: 0.68rem;
    font-weight: 600;
    color: var(--ink-soft);
    border: 1px solid rgba(0,0,0,0.07);
  }
  .card-badge--en {
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
    font-size: 0.68rem;
    font-weight: 700;
    background: #e8f0fe;
    color: #1a56db;
    border: 1px solid #c3d4f7;
  }
  .card-rank { margin-left: auto; color: var(--rule); font-size: 0.68rem; }
  .card-title {
    font-family: var(--serif);
    font-size: 1rem;
    font-weight: 700;
    line-height: 1.45;
    margin: 0 0 0.5rem;
    color: var(--ink);
  }
  .card-title a { color: inherit; text-decoration: none; }
  .card-title a:hover { text-decoration: underline; color: var(--accent, #2a5080); }
  .card-excerpt {
    font-family: var(--sans);
    font-size: 0.86rem;
    line-height: 1.6;
    color: var(--ink-soft);
    margin: 0;
  }

  /* ── Analysis sub-tabs ── */
  .analysis-tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--rule-soft);
    margin-bottom: 1.4rem;
  }
  .atab {
    font-family: var(--mono);
    font-size: 0.78rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    padding: 0.45rem 1rem;
    border: none;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    background: none;
    color: var(--ink-mute);
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }
  .atab:hover { color: var(--ink); }
  .atab.is-active { color: var(--accent, #2a5080); border-bottom-color: var(--accent, #2a5080); }

  /* ── History table ── */
  .hist-table { width: 100%; border-collapse: collapse; font-family: var(--sans); font-size: 0.82rem; }
  .hist-table th { font-family: var(--mono); font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-mute); border-bottom: 2px solid var(--ink); padding: 0.35rem 0.5rem; text-align: left; }
  .hist-table td { padding: 0.45rem 0.5rem; border-bottom: 1px solid var(--rule-soft); vertical-align: top; color: var(--ink-soft); }
  .hist-table tr:hover td { background: var(--bg-soft); }
  .hist-table a { color: var(--ink); font-weight: 600; text-decoration: none; }
  .hist-table a:hover { text-decoration: underline; }
  .hist-mainline { max-width: 320px; line-height: 1.4; font-size: 0.8rem; }

  /* ── Trend grid ── */
  .trend-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top: 0.5rem; }
  @media (max-width: 600px) { .trend-grid { grid-template-columns: 1fr; } }
  .trend-card { background: var(--bg-soft); border: 1px solid var(--rule-soft); border-radius: 6px; padding: 0.9rem 1rem; }
  .trend-card-title { font-family: var(--mono); font-size: 0.68rem; color: var(--ink-mute); letter-spacing: 0.04em; text-transform: uppercase; margin: 0 0 0.6rem; }
  .view-tabs {
    display: flex;
    gap: 0;
    border-bottom: 2px solid var(--rule-soft);
    max-width: 860px;
    margin: 0 auto;
    padding: 0 1.5rem;
  }
  .view-tab {
    font-family: var(--mono);
    font-size: 0.82rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    padding: 0.55rem 1.2rem;
    border: none;
    border-bottom: 2px solid transparent;
    margin-bottom: -2px;
    background: none;
    color: var(--ink-mute);
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }
  .view-tab:hover { color: var(--ink); }
  .view-tab.is-active { color: var(--accent, #2a5080); border-bottom-color: var(--accent, #2a5080); }

  /* ── Analysis panel ── */
  .analysis-panel { max-width: 860px; margin: 0 auto; padding: 1.5rem; }
  .analysis-summary {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
    margin-bottom: 2rem;
  }
  @media (max-width: 560px) { .analysis-summary { grid-template-columns: 1fr; } }
  .ppio-index-card {
    background: var(--bg-soft);
    border: 1px solid var(--rule-soft);
    border-radius: 8px;
    padding: 1.1rem 1.3rem;
  }
  .ppio-index-label {
    font-family: var(--mono);
    font-size: 0.7rem;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--ink-mute);
    margin-bottom: 0.4rem;
  }
  .ppio-index-score {
    font-family: var(--serif);
    font-size: 2.4rem;
    font-weight: 700;
    color: var(--ink);
    line-height: 1.1;
    margin-bottom: 0.35rem;
  }
  .ppio-index-delta {
    font-size: 1rem;
    font-weight: 600;
    margin-left: 0.4rem;
  }
  .ppio-index-interp {
    font-family: var(--sans);
    font-size: 0.82rem;
    color: var(--ink-soft);
    line-height: 1.5;
  }
  .analysis-section {
    margin-bottom: 2.4rem;
    padding-bottom: 2rem;
    border-bottom: 1px solid var(--rule-soft);
  }
  .analysis-section:last-child { border-bottom: none; }
  .analysis-title {
    font-family: var(--mono);
    font-size: 0.78rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink-mute);
    margin: 0 0 0.3rem;
  }
  .analysis-desc {
    font-family: var(--sans);
    font-size: 0.8rem;
    color: var(--ink-mute);
    margin: 0 0 1rem;
  }
  .chart-wrap { position: relative; }
  .chart-wrap--quadrant { max-width: 540px; margin: 0 auto; }
  .chart-wrap--bar { max-width: 560px; }
  .chart-wrap--donut { max-width: 380px; margin: 0 auto; }
  .quadrant-bg {
    position: absolute;
    inset: 32px 8px 32px 48px;
    pointer-events: none;
    z-index: 0;
  }
  .quadrant-bg .ql {
    position: absolute;
    font-family: var(--mono);
    font-size: 0.65rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    padding: 0.18rem 0.45rem;
    border-radius: 3px;
    opacity: 0.55;
  }
  .ql-tl { top: 4px; left: 4px; background: #fef3c7; color: #92400e; }
  .ql-tr { top: 4px; right: 4px; background: #fee2e2; color: #991b1b; }
  .ql-bl { bottom: 4px; left: 4px; background: #d1fae5; color: #065f46; }
  .ql-br { bottom: 4px; right: 4px; background: #dcfce7; color: #166534; }
  .chart-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem 0.9rem;
    margin-top: 0.8rem;
    font-family: var(--sans);
    font-size: 0.75rem;
    color: var(--ink-soft);
  }
  .legend-item { display: flex; align-items: center; gap: 0.3rem; }
  .legend-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
</style>
</head>
<body class="feed-page">
${renderHeader(week)}

<!-- 顶层视图切换：今日 / 分析 -->
<nav class="view-tabs" role="tablist" aria-label="视图切换">
  <button class="view-tab is-active" data-view="feed" role="tab" aria-selected="true">今日</button>
  <button class="view-tab" data-view="analysis" role="tab" aria-selected="false">分析</button>
</nav>

<!-- 今日视图 -->
<div id="view-feed" class="view-panel">
${renderTabs(curated)}
<main class="feed">
  <section class="feed-section">
    <h2 class="date-section" title="${week}">${week}</h2>
    <ol class="feed-list">
      ${attend.map((item, i) => renderFeedItem(item, i)).join('\n      ')}
    </ol>
  </section>

  ${silent.length > 0 ? `
  <section class="feed-section">
    <h2 class="date-section" title="简报">简报 (lane:silent)</h2>
    <ol class="feed-list">
      ${silent.map((item, i) => renderFeedItem(item, attend.length + i)).join('\n      ')}
    </ol>
  </section>` : ''}

  ${renderWindIndicators(synthesis)}
  ${renderSpeedRead(synthesis)}
  ${renderWordCloud(keywords)}

  <div class="feed-end">
    <a href="archive.html">浏览往期日报 →</a>
  </div>
</main>
</div>

<!-- 分析视图 -->
<div id="view-analysis" class="view-panel" style="display:none">
  ${renderAnalysisPanel(synthesis, curated, archive)}
</div>

<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<script>
  // ── View tabs (本周 / 分析) ──
  (function() {
    const viewTabs = document.querySelectorAll('.view-tab');
    const viewPanels = document.querySelectorAll('.view-panel');
    viewTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        viewTabs.forEach(t => { t.classList.remove('is-active'); t.setAttribute('aria-selected','false'); });
        tab.classList.add('is-active'); tab.setAttribute('aria-selected','true');
        const v = tab.dataset.view;
        viewPanels.forEach(p => { p.style.display = p.id === 'view-' + v ? '' : 'none'; });
        if (v === 'analysis') { initAnalysisTab('today'); }
      });
    });
  })();

  // ── Analysis sub-tabs ──
  (function() {
    const atabs = document.querySelectorAll('.atab');
    atabs.forEach(tab => {
      tab.addEventListener('click', () => {
        atabs.forEach(t => t.classList.remove('is-active'));
        tab.classList.add('is-active');
        const id = tab.dataset.atab;
        document.querySelectorAll('.atab-panel').forEach(p => {
          p.style.display = p.id === 'atab-' + id ? '' : 'none';
        });
        initAnalysisTab(id);
      });
    });
  })();

  // ── Feed category tabs ──
  (function() {
    const tabs = document.querySelectorAll('.feed-tabs .tab');
    const rows = document.querySelectorAll('.feed-card');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => { t.classList.remove('is-active'); t.setAttribute('aria-selected', 'false'); });
        tab.classList.add('is-active');
        tab.setAttribute('aria-selected', 'true');
        const tag = tab.dataset.tab;
        rows.forEach(row => {
          if (tag === 'all') row.classList.remove('is-tab-hidden');
          else row.classList.toggle('is-tab-hidden', !(row.dataset.tags || '').split(/\\s+/).includes(tag));
        });
      });
    });
  })();

  // ── Analysis charts ──
  const chartsInited = {};
  function initAnalysisTab(tab) {
    if (chartsInited[tab]) return;
    chartsInited[tab] = true;

    const SYNTHESIS = ${JSON.stringify(synthesis)};
    const ITEMS = ${JSON.stringify(curated.items || [])};

    if (tab === 'today') {
      initCharts(SYNTHESIS, ITEMS);
    } else if (tab === 'trend') {
      initTrendCharts();
    }
  }

  function initTrendCharts() {
    const el = document.getElementById('trend-data');
    if (!el) return;
    const d = JSON.parse(el.textContent);
    const baseOpts = () => ({
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 }, maxTicksLimit: 8 } },
        y: { grid: { color: '#f0f0f0' }, ticks: { font: { size: 11 } } }
      }
    });
    if (document.getElementById('chart-trend-index')) {
      new Chart(document.getElementById('chart-trend-index'), {
        type: 'line',
        data: { labels: d.dates, datasets: [{ data: d.index, borderColor: '#2563eb', backgroundColor: '#2563eb22', fill: true, tension: 0.3, pointRadius: 3 }] },
        options: { ...baseOpts(), scales: { x:{grid:{display:false},ticks:{font:{size:10},maxTicksLimit:8}}, y:{min:0,max:100,grid:{color:'#f0f0f0'},ticks:{font:{size:11}}} } }
      });
    }
    if (document.getElementById('chart-trend-attend')) {
      new Chart(document.getElementById('chart-trend-attend'), {
        type: 'bar',
        data: { labels: d.dates, datasets: [{ data: d.attend, backgroundColor: '#2563ebcc', borderRadius: 3 }] },
        options: baseOpts()
      });
    }
    if (document.getElementById('chart-trend-policy')) {
      new Chart(document.getElementById('chart-trend-policy'), {
        type: 'line',
        data: { labels: d.dates, datasets: [{ data: d.policy, borderColor: '#16a34a', backgroundColor: '#16a34a22', fill: true, tension: 0.3, pointRadius: 3 }] },
        options: { ...baseOpts(), scales: { x:{grid:{display:false},ticks:{font:{size:10},maxTicksLimit:8}}, y:{min:0,max:6,grid:{color:'#f0f0f0'},ticks:{font:{size:11},stepSize:1}} } }
      });
    }
    if (document.getElementById('chart-trend-compete')) {
      new Chart(document.getElementById('chart-trend-compete'), {
        type: 'line',
        data: { labels: d.dates, datasets: [{ data: d.compete, borderColor: '#d97706', backgroundColor: '#d9770622', fill: true, tension: 0.3, pointRadius: 3 }] },
        options: { ...baseOpts(), scales: { x:{grid:{display:false},ticks:{font:{size:10},maxTicksLimit:8}}, y:{min:0,max:6,grid:{color:'#f0f0f0'},ticks:{font:{size:11},stepSize:1}} } }
      });
    }
  }

  function initCharts(SYNTHESIS, ITEMS) {

    // 1. 象限图 — 机会-威胁矩阵
    (function() {
      const axes = (SYNTHESIS.item_axes || []);
      const catColor = {
        '政策':'#2563eb','竞品':'#d97706','监管':'#dc2626',
        '资本':'#16a34a','海外':'#7c3aed','技术':'#0891b2','治理':'#92400e'
      };
      const datasets = axes.map(a => {
        const item = ITEMS.find(i => i.id && (i.id.endsWith('-' + a.id) || i.id === a.id)) || {};
        const cat = item.category || '技术';
        return {
          label: (a.title || '').slice(0, 20),
          data: [{ x: a.policy_axis || 0, y: a.competition_axis || 0 }],
          backgroundColor: (catColor[cat] || '#6b7280') + 'cc',
          borderColor: catColor[cat] || '#6b7280',
          pointRadius: Math.max(6, (a.impact_score || 3) * 4),
          pointHoverRadius: Math.max(8, (a.impact_score || 3) * 4 + 2),
        };
      });
      new Chart(document.getElementById('chart-quadrant'), {
        type: 'scatter',
        data: { datasets },
        options: {
          responsive: true, maintainAspectRatio: true,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: ctx => {
                  const a = axes[ctx.datasetIndex];
                  return [
                    (a.title || '').slice(0, 35),
                    a.axis_reason || ''
                  ];
                }
              }
            }
          },
          scales: {
            x: {
              min: -1.2, max: 1.2,
              border: { display: false },
              grid: {
                color: ctx => ctx.tick.value === 0 ? '#374151' : '#e5e7eb',
                lineWidth: ctx => ctx.tick.value === 0 ? 2.5 : 1,
              },
              ticks: {
                stepSize: 0.5,
                font: { size: 10 },
                color: ctx => ctx.tick.value === 0 ? '#374151' : '#9ca3af',
                callback: v => {
                  if (v === -1) return '← 收紧';
                  if (v === 1) return '宽松 →';
                  if (v === 0) return '中性';
                  return '';
                }
              },
              title: {
                display: true,
                text: '政策/监管环境',
                font: { size: 11, weight: '600' },
                color: '#4b5563'
              }
            },
            y: {
              min: -1.2, max: 1.2,
              border: { display: false },
              grid: {
                color: ctx => ctx.tick.value === 0 ? '#374151' : '#e5e7eb',
                lineWidth: ctx => ctx.tick.value === 0 ? 2.5 : 1,
              },
              ticks: {
                stepSize: 0.5,
                font: { size: 10 },
                color: ctx => ctx.tick.value === 0 ? '#374151' : '#9ca3af',
                callback: v => {
                  if (v === -1) return '低竞争';
                  if (v === 1) return '高竞争';
                  if (v === 0) return '中性';
                  return '';
                }
              },
              title: {
                display: true,
                text: '竞争烈度',
                font: { size: 11, weight: '600' },
                color: '#4b5563'
              }
            }
          }
        }
      });

      // Build legend below chart
      const legend = document.getElementById('quadrant-legend');
      if (legend) {
        legend.innerHTML = axes.map(a => {
          const item = ITEMS.find(i => i.id && (i.id.endsWith('-' + a.id) || i.id === a.id)) || {};
          const cat = item.category || '技术';
          const color = catColor[cat] || '#6b7280';
          return '<span class="legend-item">'
            + '<span class="legend-dot" style="background:' + color + '"></span>'
            + (a.title || '').slice(0, 24)
            + '</span>';
        }).join('');
      }
    })();

    // 2. PPIO指数 — 成分柱状图
    (function() {
      const idx = SYNTHESIS.ppio_index || {};
      const comp = idx.components || {};
      const labels = ['政策顺风', '竞争压力', '资本情绪', '监管风险', '海外逆风'];
      const keys = ['policy_tailwind','competitive_pressure','capital_sentiment','regulatory_risk','overseas_headwind'];
      const values = keys.map(k => comp[k] || 0);
      const colors = values.map(v => v >= 0 ? '#16a34acc' : '#dc2626cc');
      new Chart(document.getElementById('chart-index'), {
        type: 'bar',
        data: {
          labels,
          datasets: [{ label: 'PPIO指数成分', data: values, backgroundColor: colors, borderRadius: 4 }]
        },
        options: {
          responsive: true, maintainAspectRatio: true,
          plugins: { legend: { display: false } },
          scales: {
            y: { grid: { color: '#e5e7eb' }, ticks: { stepSize: 10 } },
            x: { grid: { display: false } }
          }
        }
      });
    })();

    // 3. 信号分布 — 类别条数
    (function() {
      const cats = ['政策','竞品','监管','资本','海外','技术','治理'];
      const catColor = {
        '政策':'#2563eb','竞品':'#d97706','监管':'#dc2626',
        '资本':'#16a34a','海外':'#7c3aed','技术':'#0891b2','治理':'#92400e'
      };
      const counts = cats.map(c => ITEMS.filter(i => i.category === c && i.lane === 'attend').length);
      new Chart(document.getElementById('chart-signals'), {
        type: 'doughnut',
        data: {
          labels: cats,
          datasets: [{ data: counts, backgroundColor: cats.map(c => catColor[c] + 'cc'), borderWidth: 1 }]
        },
        options: {
          responsive: true, maintainAspectRatio: true,
          plugins: { legend: { position: 'right', labels: { font: { size: 11 } } } }
        }
      });
    })();
  }
</script>
</body>
</html>`;
}

// ---- main ------------------------------------------------------------------

async function main() {
  console.log('━━━ PPIO 产业政策信息流: Step 4 — Render ━━━');

  const curated = loadJSON(CURATED_PATH);
  let synthesis = { mainline: '', speed_read: null, signal_summary: {} };
  try {
    synthesis = loadJSON(SYNTH_PATH);
  } catch {
    console.warn('  ⚠ No synthesis file found, rendering without speed-read section');
  }

  // Update archive first so it's available for renderHTML
  const archive = updateArchive(curated, synthesis);

  const html = renderHTML(curated, synthesis, archive);
  writeFileSync(OUT_PATH, html, 'utf-8');
  console.log(`  ✓ Rendered index.html (${(html.length / 1024).toFixed(1)} KB) → ${OUT_PATH}`);
  console.log(`    ${curated.attend_count} attend items, ${curated.silent_count} silent items`);

  // Save daily report to reports/YYYY-MM-DD.html
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const REPORTS_DIR = resolve(ROOT, 'reports');
  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR);
  const dailyPath = resolve(REPORTS_DIR, `${today}.html`);
  writeFileSync(dailyPath, html, 'utf-8');
  console.log(`  ✓ Saved daily report → reports/${today}.html`);

  // Render archive.html (standalone page still available for external links)
  const archiveHtml = renderArchiveHTML(archive);
  const ARCHIVE_HTML_PATH = resolve(ROOT, 'archive.html');
  writeFileSync(ARCHIVE_HTML_PATH, archiveHtml, 'utf-8');
  console.log(`  ✓ Rendered archive.html → ${ARCHIVE_HTML_PATH}`);
}

function updateArchive(curated, synthesis) {
  const ARCHIVE_PATH = resolve(ROOT, 'data', 'archive.json');
  const RAW_PATH = resolve(ROOT, 'data', 'raw-items.json');
  let archive = { updated_at: '', days: [] };
  try {
    const existing = JSON.parse(readFileSync(ARCHIVE_PATH, 'utf-8'));
    // Migrate from old weeks-based format
    if (existing.weeks && !existing.days) {
      archive.days = existing.weeks.map(w => ({
        date: w.date || w.week,
        mainline: w.mainline || '',
        signal_summary: w.signal_summary || {},
        item_count: w.item_count || {},
        ppio_index: null,
        competitor_updates: w.competitor_updates || []
      }));
    } else {
      archive = existing;
    }
  } catch { /* first run */ }

  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

  const entry = {
    date: today,
    mainline: synthesis.mainline || '',
    signal_summary: synthesis.signal_summary || {},
    wind_indicators: synthesis.wind_indicators || {},
    ppio_index: synthesis.ppio_index || null,
    item_count: {
      total: curated.total_curated,
      attend: curated.attend_count,
      silent: curated.silent_count
    },
    competitor_updates: synthesis.competitor_updates || []
  };

  const idx = (archive.days || []).findIndex(d => d.date === today);
  if (idx >= 0) archive.days[idx] = entry;
  else {
    archive.days = archive.days || [];
    archive.days.unshift(entry);
  }

  // Keep 90 days of history
  archive.days = archive.days
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 90);

  archive.updated_at = new Date().toISOString();
  writeFileSync(ARCHIVE_PATH, JSON.stringify(archive, null, 2), 'utf-8');
  console.log(`  ✓ Updated archive → ${ARCHIVE_PATH} (${archive.days.length} days)`);
  return archive;
}

function renderArchiveHTML(archive) {
  const days = (archive.days || []).slice(0, 90);
  // 30-day window for trend charts
  const trend30 = days.slice(0, 30).reverse();

  const trendDates = JSON.stringify(trend30.map(d => d.date.slice(5)));
  const trendAttend = JSON.stringify(trend30.map(d => d.item_count?.attend || 0));
  const trendIndex = JSON.stringify(trend30.map(d => d.ppio_index?.score ?? null));
  const trendPolicy = JSON.stringify(trend30.map(d => d.wind_indicators?.policy_heat || 0));
  const trendCompete = JSON.stringify(trend30.map(d => d.wind_indicators?.competitor_heat || 0));

  const rows = days.map(d => {
    const signals = Object.entries(d.signal_summary || {})
      .filter(([, v]) => v > 0).map(([k, v]) => `${k}×${v}`).join(' ');
    const counts = d.item_count || {};
    const idxScore = d.ppio_index?.score;
    const idxDelta = d.ppio_index?.delta;
    const deltaStr = idxDelta != null ? (idxDelta > 0 ? `<span style="color:#16a34a">+${idxDelta}</span>` : idxDelta < 0 ? `<span style="color:#dc2626">${idxDelta}</span>` : '') : '';
    const sentiment = d.wind_indicators?.overall_sentiment || '';
    const sentColor = {'升温':'#2d7a4f','活跃':'#1a56db','平稳':'#888','降温':'#8f3b27','观望':'#8f7020'}[sentiment] || '#888';
    return `<tr>
      <td><a href="reports/${esc(d.date)}.html">${esc(d.date)}</a></td>
      <td class="archive-mainline">${esc(d.mainline || '')}</td>
      <td>${esc(signals)}</td>
      <td>${counts.attend || 0} / ${counts.total || 0}</td>
      <td>${idxScore != null ? `${idxScore}${deltaStr}` : '—'}</td>
      <td><span style="color:${sentColor};font-weight:600">${esc(sentiment)}</span></td>
    </tr>`;
  }).join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PPIO 产业政策信息流 — 日报存档</title>
<link rel="stylesheet" href="reader.css">
<style>
  .archive-table { width: 100%; border-collapse: collapse; font-family: var(--sans); font-size: 0.84rem; margin-top: 1rem; }
  .archive-table th { font-family: var(--mono); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-mute); border-bottom: 2px solid var(--ink); padding: 0.4rem 0.6rem; text-align: left; }
  .archive-table td { padding: 0.5rem 0.6rem; border-bottom: 1px solid var(--rule-soft); vertical-align: top; color: var(--ink-soft); }
  .archive-table tr:hover td { background: var(--bg-soft); }
  .archive-table a { color: var(--ink); font-weight: 600; text-decoration: none; }
  .archive-table a:hover { text-decoration: underline; }
  .archive-mainline { max-width: 340px; line-height: 1.4; font-size: 0.82rem; }
  .archive-empty { padding: 3rem; text-align: center; color: var(--ink-mute); font-family: var(--mono); font-size: 0.82rem; }
  .trend-section { margin: 1.5rem 0; }
  .trend-title { font-family: var(--mono); font-size: 0.72rem; letter-spacing: 0.05em; text-transform: uppercase; color: var(--ink-mute); margin: 0 0 0.5rem; }
  .trend-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.2rem; }
  @media (max-width: 600px) { .trend-grid { grid-template-columns: 1fr; } }
  .trend-card { background: var(--bg-soft); border: 1px solid var(--rule-soft); border-radius: 6px; padding: 0.9rem 1rem; }
  .trend-card-title { font-family: var(--mono); font-size: 0.68rem; color: var(--ink-mute); letter-spacing: 0.04em; text-transform: uppercase; margin: 0 0 0.6rem; }
  .chart-wrap-sm { max-height: 180px; }
</style>
</head>
<body class="archive-page">
<header class="page-header">
  <span class="brand">PPIO 产业政策信息流</span>
  <span class="header-meta">日报存档</span>
  <nav class="header-nav"><a href="index.html">← 今日</a></nav>
</header>
<main style="max-width:960px;margin:0 auto;padding:1.4rem 1.4rem 4rem">
  <h1 style="font-family:var(--mono);font-size:0.9rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--ink);margin:0 0 0.2rem">日报存档</h1>
  <p style="font-family:var(--sans);font-size:0.82rem;color:var(--ink-mute);margin:0 0 1.4rem">共 ${days.length} 天 · 最近更新 ${esc(archive.updated_at?.slice(0,10) || '')}</p>

  <!-- 30天趋势图 -->
  ${trend30.length >= 2 ? `
  <section class="trend-section">
    <p class="trend-title">近30天趋势</p>
    <div class="trend-grid">
      <div class="trend-card">
        <p class="trend-card-title">PPIO 战略环境指数</p>
        <div class="chart-wrap-sm"><canvas id="chart-trend-index"></canvas></div>
      </div>
      <div class="trend-card">
        <p class="trend-card-title">每日 Attend 条数</p>
        <div class="chart-wrap-sm"><canvas id="chart-trend-attend"></canvas></div>
      </div>
      <div class="trend-card">
        <p class="trend-card-title">政策热度</p>
        <div class="chart-wrap-sm"><canvas id="chart-trend-policy"></canvas></div>
      </div>
      <div class="trend-card">
        <p class="trend-card-title">竞争热度</p>
        <div class="chart-wrap-sm"><canvas id="chart-trend-compete"></canvas></div>
      </div>
    </div>
  </section>` : ''}

  <!-- 日报列表 -->
  ${days.length === 0
    ? `<div class="archive-empty">暂无存档</div>`
    : `<table class="archive-table">
    <thead><tr>
      <th>日期</th><th>当日主线</th><th>信号</th><th>深度/总计</th><th>指数</th><th>风向</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`}
</main>

<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<script>
(function() {
  const dates = ${trendDates};
  const attend = ${trendAttend};
  const index = ${trendIndex};
  const policy = ${trendPolicy};
  const compete = ${trendCompete};

  const baseOpts = (label, color) => ({
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { display: false }, ticks: { font: { size: 10 }, maxTicksLimit: 8 } },
      y: { grid: { color: '#f0f0f0' }, ticks: { font: { size: 11 } } }
    }
  });

  // PPIO 指数趋势
  if (document.getElementById('chart-trend-index')) {
    new Chart(document.getElementById('chart-trend-index'), {
      type: 'line',
      data: { labels: dates, datasets: [{ data: index, borderColor: '#2563eb', backgroundColor: '#2563eb22', fill: true, tension: 0.3, pointRadius: 3 }] },
      options: { ...baseOpts(), scales: { x: { grid:{display:false}, ticks:{font:{size:9},maxTicksLimit:8} }, y: { min:0, max:100, grid:{color:'#f0f0f0'}, ticks:{font:{size:9}} } } }
    });
  }

  // Attend 条数趋势
  if (document.getElementById('chart-trend-attend')) {
    new Chart(document.getElementById('chart-trend-attend'), {
      type: 'bar',
      data: { labels: dates, datasets: [{ data: attend, backgroundColor: '#2563ebcc', borderRadius: 3 }] },
      options: baseOpts()
    });
  }

  // 政策热度
  if (document.getElementById('chart-trend-policy')) {
    new Chart(document.getElementById('chart-trend-policy'), {
      type: 'line',
      data: { labels: dates, datasets: [{ data: policy, borderColor: '#16a34a', backgroundColor: '#16a34a22', fill: true, tension: 0.3, pointRadius: 3 }] },
      options: { ...baseOpts(), scales: { x:{grid:{display:false},ticks:{font:{size:10},maxTicksLimit:8}}, y:{min:0,max:6,grid:{color:'#f0f0f0'},ticks:{font:{size:11},stepSize:1}} } }
    });
  }

  // 竞争热度
  if (document.getElementById('chart-trend-compete')) {
    new Chart(document.getElementById('chart-trend-compete'), {
      type: 'line',
      data: { labels: dates, datasets: [{ data: compete, borderColor: '#d97706', backgroundColor: '#d9770622', fill: true, tension: 0.3, pointRadius: 3 }] },
      options: { ...baseOpts(), scales: { x:{grid:{display:false},ticks:{font:{size:10},maxTicksLimit:8}}, y:{min:0,max:6,grid:{color:'#f0f0f0'},ticks:{font:{size:11},stepSize:1}} } }
    });
  }
})();
</script>
</body>
</html>`;
}

main().catch(err => { console.error(err); process.exit(1); });

