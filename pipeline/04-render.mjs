#!/usr/bin/env node

/**
 * PPIO Expresso — Step 4: Render
 * Generates static index.html from curated items + weekly synthesis.
 *
 * Input:  data/curated-items.json + data/weekly-synthesis.json
 * Output: index.html (overwrites the feed page)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CURATED_PATH = resolve(ROOT, 'data', 'curated-items.json');
const SYNTH_PATH = resolve(ROOT, 'data', 'weekly-synthesis.json');
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
  <span class="brand">PPIO Expresso</span>
  <span class="header-meta">
    最后更新: <time datetime="${week}">${week}</time>
  </span>
  <nav class="header-nav" aria-label="导航">
    <a href="manage.html">管理</a>
    <a href="archive.html">周报存档 →</a>
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
  const enBadge = isEnglish ? '<span class="label-pill" style="background:#e8f0fe;color:#1a56db;border-color:#c3d4f7">EN</span> ' : '';
  return `<li class="feed-row" data-deep="${item.is_deep_read ? 'true' : 'false'}" data-tags="${esc(item.category || '')}">
        <span class="row-rank">${rank}.</span>
        <div class="row-body">
          <h2 class="row-title">
            ${enBadge}<a href="${esc(item.url || '#')}" target="_blank" rel="noopener">${esc(item.title)}</a>
            <span class="row-domain">(${esc(item.source)})</span>
          </h2>
          <div class="row-meta">
            <span>${esc(item.source)}</span> <span class="row-sep">·</span>
            <time>${esc(item.published || '')}</time> <span class="row-sep">·</span>
            <span class="label-pill">${esc(item.category)}</span>
            ${renderSignalChips(item.signals)}
          </div>
          <p class="row-excerpt">${esc(item.summary_cn || item.body_snippet || '')}</p>
          ${renderPPIOSignal(item.ppio_signal)}
        </div>
      </li>`;
}

function renderSpeedRead(synthesis) {
  if (!synthesis || !synthesis.speed_read) return '';

  const sr = synthesis.speed_read;
  return `<section class="ppio-speed-read">
    <h2 class="speed-read-title">PPIO 信号速读</h2>
    <p class="speed-read-mainline"><strong>本周主线：</strong>${esc(synthesis.mainline || '')}</p>
    <div class="speed-read-grid">
      <div class="speed-card signal-positive">
        <h4>🟢 利好信号</h4>
        <ul>${(sr.positive || []).map(s => `<li>${esc(s)}</li>`).join('')}</ul>
      </div>
      <div class="speed-card signal-risk">
        <h4>🔴 风险信号</h4>
        <ul>${(sr.risk || []).map(s => `<li>${esc(s)}</li>`).join('')}</ul>
      </div>
    </div>
  </section>`;
}

function renderHTML(curated, synthesis) {
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
<title>PPIO Expresso — ${week}</title>
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
</style>
</head>
<body class="feed-page">
${renderHeader(week)}
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

  ${renderSpeedRead(synthesis)}

  ${renderWordCloud(keywords)}

  <div class="feed-end">
    <a href="archive.html">浏览往期周报 →</a>
  </div>
</main>

<script>
  (function() {
    const tabs = document.querySelectorAll('.feed-tabs .tab');
    const rows = document.querySelectorAll('.feed-row');
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
</script>
</body>
</html>`;
}

// ---- main ------------------------------------------------------------------

async function main() {
  console.log('━━━ PPIO Expresso: Step 4 — Render ━━━');

  const curated = loadJSON(CURATED_PATH);
  let synthesis = { mainline: '', speed_read: null, signal_summary: {} };
  try {
    synthesis = loadJSON(SYNTH_PATH);
  } catch {
    console.warn('  ⚠ No synthesis file found, rendering without speed-read section');
  }

  const html = renderHTML(curated, synthesis);
  writeFileSync(OUT_PATH, html, 'utf-8');
  console.log(`  ✓ Rendered index.html (${(html.length / 1024).toFixed(1)} KB) → ${OUT_PATH}`);
  console.log(`    ${curated.attend_count} attend items, ${curated.silent_count} silent items`);

  // Update archive data + render archive.html
  const archive = updateArchive(curated, synthesis);
  const archiveHtml = renderArchiveHTML(archive);
  const ARCHIVE_HTML_PATH = resolve(ROOT, 'archive.html');
  writeFileSync(ARCHIVE_HTML_PATH, archiveHtml, 'utf-8');
  console.log(`  ✓ Rendered archive.html → ${ARCHIVE_HTML_PATH}`);
}

function updateArchive(curated, synthesis) {
  const ARCHIVE_PATH = resolve(ROOT, 'data', 'archive.json');
  const RAW_PATH = resolve(ROOT, 'data', 'raw-items.json');
  let archive = { updated_at: '', weeks: [] };
  try {
    archive = JSON.parse(readFileSync(ARCHIVE_PATH, 'utf-8'));
  } catch { /* first run */ }

  // Try to get date range from raw items
  let dateRange = { from: '', to: '' };
  try {
    const raw = JSON.parse(readFileSync(RAW_PATH, 'utf-8'));
    dateRange = raw.date_range || dateRange;
  } catch { /* ok */ }

  const entry = {
    week: curated.week,
    date_range: dateRange,
    mainline: synthesis.mainline || '',
    signal_summary: synthesis.signal_summary || {},
    item_count: {
      total: curated.total_curated,
      attend: curated.attend_count,
      silent: curated.silent_count
    },
    competitor_updates: synthesis.competitor_updates || []
  };

  const idx = archive.weeks.findIndex(w => w.week === entry.week);
  if (idx >= 0) archive.weeks[idx] = entry;
  else archive.weeks.unshift(entry);

  if (archive.weeks.length > 52) archive.weeks = archive.weeks.slice(0, 52);

  archive.updated_at = new Date().toISOString();
  writeFileSync(ARCHIVE_PATH, JSON.stringify(archive, null, 2), 'utf-8');
  console.log(`  ✓ Updated archive → ${ARCHIVE_PATH} (${archive.weeks.length} weeks)`);
  return archive;
}

function renderArchiveHTML(archive) {
  const weeks = archive.weeks || [];
  const rows = weeks.map(w => {
    const signals = Object.entries(w.signal_summary || {})
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k}×${v}`)
      .join(' ');
    const counts = w.item_count || {};
    return `<tr>
      <td><a href="index.html">${esc(w.week)}</a></td>
      <td>${esc(w.date_range?.from || '')} – ${esc(w.date_range?.to || '')}</td>
      <td class="archive-mainline">${esc(w.mainline || '')}</td>
      <td>${esc(signals)}</td>
      <td>${counts.attend || 0} / ${counts.total || 0}</td>
    </tr>`;
  }).join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PPIO Expresso — 周报存档</title>
<link rel="stylesheet" href="reader.css">
<style>
  .archive-table { width: 100%; border-collapse: collapse; font-family: var(--sans); font-size: 0.84rem; margin-top: 1.4rem; }
  .archive-table th { font-family: var(--mono); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-mute); border-bottom: 2px solid var(--ink); padding: 0.4rem 0.6rem; text-align: left; }
  .archive-table td { padding: 0.55rem 0.6rem; border-bottom: 1px solid var(--rule-soft); vertical-align: top; color: var(--ink-soft); }
  .archive-table tr:hover td { background: var(--bg-soft); }
  .archive-table a { color: var(--ink); font-weight: 600; text-decoration: none; }
  .archive-table a:hover { text-decoration: underline; }
  .archive-mainline { max-width: 420px; line-height: 1.45; }
  .archive-empty { padding: 3rem; text-align: center; color: var(--ink-mute); font-family: var(--mono); font-size: 0.82rem; }
</style>
</head>
<body class="archive-page">
<header class="page-header">
  <span class="brand">PPIO Expresso</span>
  <span class="header-meta">周报存档</span>
  <nav class="header-nav">
    <a href="index.html">← 本周</a>
  </nav>
</header>
<main style="max-width:900px;margin:0 auto;padding:1.4rem 1.4rem 4rem">
  <h1 style="font-family:var(--mono);font-size:0.9rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--ink);margin:0 0 0.3rem">周报存档</h1>
  <p style="font-family:var(--sans);font-size:0.82rem;color:var(--ink-mute);margin:0 0 1.4rem">共 ${weeks.length} 期 · 最近更新 ${esc(archive.updated_at?.slice(0,10) || '')}</p>
  ${weeks.length === 0
    ? `<div class="archive-empty">暂无存档</div>`
    : `<table class="archive-table">
    <thead><tr>
      <th>周次</th><th>日期范围</th><th>本周主线</th><th>信号</th><th>深度/总计</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`}
</main>
</body>
</html>`;
}

main().catch(err => { console.error(err); process.exit(1); });

