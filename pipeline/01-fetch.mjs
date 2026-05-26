#!/usr/bin/env node

/**
 * PPIO Expresso — Step 1: Fetch
 * Aggregates news from RSS feeds + Google News search.
 *
 * Sources (ordered by priority):
 *   1. 36kr RSS — for competitor/capital/tech news
 *   2. Google News RSS — for targeted keyword searches across all categories
 *
 * Falls back to mock dataset if live fetch returns < 3 items.
 *
 * Input:  pipeline/config.json (sources section + charter)
 * Output: data/raw-items.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CONFIG_PATH = resolve(ROOT, 'pipeline', 'config.json');
const OUT_PATH = resolve(ROOT, 'data', 'raw-items.json');

const FETCH_TIMEOUT = 15_000; // 15s per request

// ---- helpers ---------------------------------------------------------------

function loadConfig() {
  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  return JSON.parse(raw);
}

function todayStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function weekAgoStr() {
  const d = new Date(Date.now() - 7 * 86400_000);
  return d.toISOString().slice(0, 10);
}

function weekNumber() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const diff = now - start;
  return Math.ceil((diff / 86400_000 + start.getDay() + 1) / 7);
}

// ---- minimal RSS parser ----------------------------------------------------
// RSS 2.0 is simple enough that we can parse it without a library.
// Extracts <item> blocks and their child elements.

function parseRSS(xml) {
  const items = [];
  // Match <item>...</item> blocks (non-greedy won't work, use manual split)
  const blocks = xml.split(/<item[^>]*>/i).slice(1);
  for (const block of blocks) {
    const end = block.indexOf('</item>');
    if (end === -1) continue;
    const itemXML = block.slice(0, end);

    const get = (tag) => {
      const re = new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 'is');
      const m = itemXML.match(re);
      if (!m) return '';
      return m[1].replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1').replace(/<[^>]+>/g, '').trim();
    };

    const title = get('title');
    const link = get('link');
    const pubDate = get('pubDate');
    const description = get('description');
    const source = get('source');

    if (!title || !link) continue;

    items.push({ title, link, pubDate, description, source });
  }
  return items;
}

function parsePubDate(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function isWithinWeek(dateStr) {
  if (!dateStr) return true; // keep if no date
  const weekAgo = new Date(Date.now() - 7 * 86400_000);
  return new Date(dateStr) >= weekAgo;
}

function stripHTML(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

// ---- fetchers ---------------------------------------------------------------

async function fetchWithTimeout(url, ms = FETCH_TIMEOUT) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const resp = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'PPIO-Expresso/1.0' } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url, retries = 2, delayMs = 2000) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetchWithTimeout(url);
    } catch (err) {
      if (i === retries) throw err;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

/**
 * Fetch and parse a standard RSS feed.
 */
async function fetchRSS(url, defaultSource) {
  try {
    const xml = await fetchWithRetry(url);
    const items = parseRSS(xml);
    console.log(`    RSS ${url.slice(0, 50)}... → ${items.length} items`);
    return items.map(item => ({
      title: item.title,
      url: item.link,
      source: item.source || defaultSource,
      published: parsePubDate(item.pubDate) || todayStr(),
      body_snippet: stripHTML(item.description).slice(0, 200)
    }));
  } catch (err) {
    console.warn(`    ⚠ RSS fetch failed (${url.slice(0, 50)}...): ${err.message}`);
    return [];
  }
}

/**
 * Search Google News RSS for a query.
 * Returns up to 20 items per query.
 */
async function searchGoogleNews(query, category) {
  const encoded = encodeURIComponent(query);
  const url = `https://news.google.com/rss/search?q=${encoded}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
  try {
    const xml = await fetchWithRetry(url);
    const items = parseRSS(xml);
    console.log(`    Search "${query.slice(0, 40)}" → ${items.length} items`);
    return items.slice(0, 20).map(item => ({
      title: item.title,
      url: item.link,
      source: item.source || 'Google News',
      category,
      published: parsePubDate(item.pubDate) || todayStr(),
      body_snippet: stripHTML(item.description).slice(0, 200)
    }));
  } catch (err) {
    console.warn(`    ⚠ Search failed ("${query.slice(0, 40)}"): ${err.message}`);
    return [];
  }
}

// ---- PPIO relevance scoring -------------------------------------------------

/**
 * Score an item's relevance to PPIO's business (0-100).
 * - High (80-100): Directly about PPIO, computing infra, AI regulation, key competitors
 * - Medium (50-79): AI industry news, capital events, overseas AI policy
 * - Low (0-49): Generic tech, unrelated industries, market commentary
 */
const PPIO_KEYWORDS = {
  critical: [
    // Direct PPIO business
    /算力/, /边缘计算/, /边缘云/, /分布式推理/, /分布式算力/, /智能体平台/,
    /推理优化/, /模型调度/, /GPU.*算力/, /算力.*调度/, /算力.*网络/,
    /PPIO/, /无问芯穹/, /Sandbox/,
    // Key policy — broader matching
    /国家算力网/, /算力基础设施/, /算力.*超前部署/,
    /人工智能法/, /AI.*立法/, /AI.*安全审查/,
    /智能体产业/, /AI智能体.*政策/, /AI智能体.*规范/, /AI智能体.*发展/,
    /三部门.*AI/, /三部门.*智能体/, /国办.*人工智能/, /国务院.*AI/,
    // 高层调研/部署
    /丁薛祥/, /李强.*AI/, /李强.*算力/, /政治局.*人工智能/, /政治局.*算力/,
    /六张网/, /算力网.*建设/, /一体化算力网/,
    // OPC / 个人AI创业
    /OPC/, /一人公司.*AI/, /个人.*AI.*创业/, /AI.*个人创业/,
    // 大厂发布/IPO
    /超聚变.*IPO/, /超聚变.*上市/, /算力.*IPO/, /算力.*上市/,
    /阿里云.*峰会/, /百度.*AI.*大会/, /华为.*算力/, /腾讯.*算力/,
  ],
  high: [
    /AI.*基础设施/, /AI.*Infra/, /智算中心/, /数据中心.*算力/,
    /国务院.*算力/, /工信部.*AI/, /发改委.*AI/, /网信办.*AI/,
    /模型.*推理/, /大模型.*部署/, /大模型.*服务/,
    /AI.*监管/, /人工智能.*监管/, /出口管制.*AI/, /AI.*出口管制/,
    /芯片.*AI/, /AI.*芯片/, /H100/, /A100/, /H200/, /B200/,
    /边缘.*AI/, /AI.*边缘/,
    /Token.*经济/, /Token.*Native/, /AI.*Native/,
    /AI智能体/, /智能体.*AI/,
    // 大厂动态
    /阿里云.*AI/, /百度.*智能体/, /快手.*AI/, /字节.*AI/, /腾讯.*AI/,
    /中国电信.*AI/, /中国移动.*AI/, /运营商.*算力/,
    // 中外科技摩擦
    /英伟达.*中国/, /中国.*英伟达/, /芯片.*禁令/, /出口管制.*芯片/,
    /闻泰/, /安世半导体/, /反外国制裁/,
    // 伦理/治理
    /AI.*伦理/, /AI.*内容标注/, /生成式AI.*标注/, /短视频.*AI标签/,
  ],
  medium: [
    /AI.*融资/, /融资.*AI/, /人工智能.*融资/, /AI.*IPO/,
    /大模型/, /LLM/, /Agent.*平台/, /AI.*Agent/,
    /美国.*AI/, /EU.*AI/, /欧盟.*AI/, /AI.*Act/,
    /云服务/, /云计算.*AI/,
    /AI.*社交/, /AI.*治理/, /虚拟伴侣/,
    /CSRC/, /VIE/, /备案.*境外上市/,
    /人工智能.*立法/, /人工智能.*治理/, /AI.*监管/,
    /算力.*网络/, /算力.*投资/,
  ],
  negative: [
    // Clearly unrelated — penalize
    /白酒/, /泡泡玛特/, /航空发动机/, /铁路.*投资/, /燃油附加费/,
    /A股.*指数/, /沪深.*成交/, /创业板.*涨/, /股指/, /期货/, /黄金.*价格/,
    /房地产/, /养猪/, /猪肉/, /农产品/, /钢铁/, /煤炭/, /水泥/,
    /服装/, /化妆品/, /医美/, /牙科/, /眼科/,
    /篮球/, /足球/, /电竞/, /游戏.*收入/,
  ]
};

function scorePPIORelevance(item) {
  const text = (item.title + ' ' + (item.body_snippet || '')).toLowerCase();
  let score = 15; // base score (lowered — needs keyword match to rise)
  let matched = false;

  for (const re of PPIO_KEYWORDS.critical) {
    if (re.test(text)) { score += 40; matched = true; break; }
  }
  for (const re of PPIO_KEYWORDS.high) {
    if (re.test(text)) { score += 20; matched = true; }
  }
  for (const re of PPIO_KEYWORDS.medium) {
    if (re.test(text)) { score += 8; matched = true; }
  }
  for (const re of PPIO_KEYWORDS.negative) {
    if (re.test(text)) { score = -50; break; } // hard reject
  }

  // Only give source/recency bonuses if item matched at least one PPIO keyword
  if (matched) {
    if (/新华社|中国政府网|工信部|发改委|证监会|网信办|广电总局/.test(item.source || '')) score += 30;
    if (/Reuters|南华早报|SCMP/.test(item.source || '')) score += 15;
    if (/财新|新华报业|澎湃|thepaper|央视|人民日报/.test(item.source || '')) score += 20;
    if (/VentureBeat|MIT Tech Review|TechCrunch|The Verge/.test(item.source || '')) score += 12;
    if (/36氪/.test(item.source || '')) score += 5;

    if (item.published === todayStr()) score += 10;
    else if (item.published >= weekAgoStrPlus(2)) score += 5;
  }

  return score;
}

function weekAgoStrPlus(days) {
  const d = new Date(Date.now() - days * 86400_000);
  return d.toISOString().slice(0, 10);
}

// ---- dedup & filter ---------------------------------------------------------

function normalizeURL(url) {
  // Strip tracking params and normalize
  return url.replace(/[?&]utm_[^&]+/gi, '').replace(/[?&]oc=\d+$/i, '').trim();
}

function dedupByURL(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = normalizeURL(item.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupByTitle(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = item.title.replace(/\s+/g, '').slice(0, 25);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Content-based dedup: group items that share the same core entity + event.
 * E.g., all "无问芯穹...融资" stories → keep only best one.
 */
function dedupByEntity(items) {
  const groups = new Map();

  for (const item of items) {
    // Extract core entity + event signature
    const sig = entitySignature(item.title);
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(item);
  }

  // Keep only the highest-scored (or first) item from each group
  const kept = [];
  let dupCount = 0;
  for (const [sig, group] of groups) {
    group.sort((a, b) => (b._score || 0) - (a._score || 0));
    kept.push(group[0]);
    dupCount += group.length - 1;
  }

  return { items: kept, dupCount };
}

function entitySignature(title) {
  const t = title.replace(/\s+/g, '');
  // Ordered by specificity: more specific entities first
  const entities = ['无问芯穹', 'PPIO', 'Sandbox',
    'DeepSeek', '深度求索', '月之暗面', 'Minimax', '零一万物', '百川智能',
    'OpenAI', 'Google', 'Microsoft', 'Meta',
    '商汤', '科大讯飞', '智谱', '百度', '阿里', '腾讯', '字节跳动', '华为',
    '三部门', '美国参议院', '欧盟',
    '国务院', '工信部', '发改委', '证监会', '网信办', '广电总局'];
  const first = entities.find(e => t.includes(e));
  return first || t.slice(0, 40);
}

// ---- query builder ----------------------------------------------------------

function buildSearchQueries(config) {
  const queries = [];
  // Week-specific keywords
  const week = `${String(weekNumber()).padStart(2, '0')}`;

  // 政策
  queries.push({ q: '丁薛祥 算力网 调研 部署', category: '政策' });
  queries.push({ q: '政治局 人工智能 算力 部署 2026', category: '政策' });
  queries.push({ q: '六张网 算力网 基础设施 建设', category: '政策' });
  queries.push({ q: '国务院 算力 基础设施 AI 政策', category: '政策' });
  queries.push({ q: '国常会 人工智能 数字经济 部署', category: '政策' });
  queries.push({ q: '中央 新质生产力 算力 数据要素', category: '政策' });

  // 政策 — OPC / 个人AI创业
  queries.push({ q: 'OPC 个人公司 人工智能 创业 政策', category: '政策' });
  queries.push({ q: '一人公司 AI 创业 算力 补贴', category: '政策' });
  queries.push({ q: '个人 AI 创业 政府 支持 补贴', category: '政策' });

  queries.push({ q: '工信部 人工智能 智能体 实施意见', category: '政策' });
  queries.push({ q: '工信部 算力 中小企业 数字化 补贴', category: '政策' });
  queries.push({ q: '工信部 AI 伦理 审查 治理', category: '政策' });
  queries.push({ q: '国家发改委 算力网 东数西算 部署', category: '政策' });
  queries.push({ q: '发改委 数据中心 绿色算力 能耗', category: '政策' });
  queries.push({ q: '发改委 数字基础设施 投资 规划', category: '政策' });
  queries.push({ q: '科技部 人工智能 大模型 研发 支持', category: '政策' });
  queries.push({ q: '网信办 生成式AI 算法备案 内容标注', category: '政策' });
  queries.push({ q: '网信办 数据安全 跨境 合规', category: '政策' });
  queries.push({ q: '国家人工智能产业投资基金 算力 布局', category: '政策' });
  queries.push({ q: '财政部 数字经济 专项资金 补贴', category: '政策' });

  // 监管
  queries.push({ q: 'AI 人工智能 立法 安全审查 备案', category: '监管' });
  queries.push({ q: '证监会 境外上市 备案 VIE', category: '监管' });
  queries.push({ q: '人工智能法 草案 立法进展', category: '监管' });

  // 竞品
  queries.push({ q: '无问芯穹 融资 产品', category: '竞品' });
  queries.push({ q: 'AI基础设施 AI Infra 融资 2026', category: '竞品' });
  queries.push({ q: '硅基流动 智谱 火山引擎 算力 融资', category: '竞品' });

  // 资本
  queries.push({ q: 'AI 人工智能 融资 IPO 估值', category: '资本' });
  queries.push({ q: '超聚变 IPO 算力 上市', category: '资本' });
  queries.push({ q: '香港 科技股 IPO 上市 算力', category: '资本' });

  // 技术
  queries.push({ q: '阿里云 百度 华为 AI 发布 峰会 2026', category: '技术' });
  queries.push({ q: '中国电信 中国移动 算力 Token AI', category: '技术' });
  queries.push({ q: '算力调度 推理优化 Agent 技术突破', category: '技术' });
  queries.push({ q: 'AI 大模型 边缘计算 分布式推理', category: '技术' });

  // 海外
  queries.push({ q: '英伟达 H200 中国 出口 芯片', category: '海外' });
  queries.push({ q: 'US AI regulation export control China', category: '海外' });
  queries.push({ q: 'EU AI Act enforcement 2026', category: '海外' });
  queries.push({ q: '中国 美国 AI 出口管制 芯片 供应链', category: '海外' });
  queries.push({ q: '中俄 AI 合作 治理 标准', category: '海外' });

  return queries;
}

// ---- category assignment ----------------------------------------------------

function guessCategory(item) {
  if (item.category) return item.category;
  const t = item.title + ' ' + (item.body_snippet || '');
  if (/国务院|发改委|工信部|网信办|部委|政策|行动计划|指导意见|算力网/.test(t)) return '政策';
  if (/融资|IPO|估值|亿元|万美元|红杉|经纬|IDG|高瓴|腾讯投资/.test(t)) return '资本';
  if (/无问芯穹|竞品|竞争/.test(t)) return '竞品';
  if (/立法|安全审查|备案|合规|监管|CSRC|牌照/.test(t)) return '监管';
  if (/美国|EU|欧盟|参议院|出口管制|chip|export control/.test(t)) return '海外';
  if (/模型|训练|推理|Agent|架构|参数|token|LLM|GPU|算力/.test(t)) return '技术';
  return '技术';
}

// ---- mock fallback -----------------------------------------------------------

function getMockItems() {
  return [
    {
      id: "raw-001", title: "国常会审议通过《国家算力网建设行动计划》，2027年建成全国一体化算力网络",
      url: "http://www.gov.cn/", source: "新华社/中国政府网", category: "政策",
      published: "2026-05-09",
      body_snippet: "国务院常务会议审议通过《国家算力网建设行动计划》，提出到2027年建成覆盖全国、高通量、低时延的一体化算力网络，明确'适度超前部署算力基础设施'。"
    },
    {
      id: "raw-002", title: "三部门联合印发《促进AI智能体产业发展的实施意见》",
      url: "https://www.miit.gov.cn/", source: "工信部/网信办/发改委", category: "政策",
      published: "2026-05-08",
      body_snippet: "工信部、网信办、发改委联合印发实施意见，提出到2027年培育100个以上具有行业影响力的AI智能体产品，支持企业建设智能体服务平台。"
    },
    {
      id: "raw-003", title: "国务院2026年度立法计划：《人工智能法（草案）》列入预备审议",
      url: "http://www.gov.cn/", source: "中国政府网", category: "监管",
      published: "2026-05-07",
      body_snippet: "国务院办公厅发布2026年度立法工作计划，《人工智能法（草案）》列入预备审议项目，标志着中国AI综合性立法进入实质推进阶段。"
    },
    {
      id: "raw-004", title: "国务院加强基础研究座谈会：算力基础设施适度超前部署",
      url: "http://www.news.cn/", source: "新华社", category: "政策",
      published: "2026-05-06",
      body_snippet: "国务院召开加强基础研究工作座谈会，明确'算力基础设施适度超前部署'，将算力列为与交通、能源并列的国家基础设施。鼓励社会资本参与算力基础设施建设。"
    },
    {
      id: "raw-005", title: "无问芯穹完成7亿元新一轮融资，定位「企业级智能体服务平台」",
      url: "https://36kr.com/", source: "36氪", category: "竞品",
      published: "2026-05-08",
      body_snippet: "无问芯穹宣布完成7亿元新一轮融资，投后估值约45亿元，由红杉中国领投。公司定位从'AI Infra'升级为'企业级智能体服务平台'，与PPIO Sandbox产品定位正面重叠。"
    },
    {
      id: "raw-006", title: "广电总局、网信办联合发文规范AI虚拟伴侣等社交产品",
      url: "http://www.news.cn/", source: "新华社/广电总局", category: "治理",
      published: "2026-05-07",
      body_snippet: "广电总局联合网信办发文，要求AI虚拟伴侣类产品必须进行安全评估并取得相关资质，强调未成年人保护与内容安全。"
    },
    {
      id: "raw-007", title: "美国参议院推进AI安全审查机制，拟扩大对华AI技术出口管制",
      url: "https://www.reuters.com/", source: "Reuters", category: "海外",
      published: "2026-05-08",
      body_snippet: "美国参议院商务委员会推进《AI安全审查法案》，拟要求美国公司在向中国等'关注国家'出口AI技术时接受更严格的安全审查。"
    }
  ];
}

// ---- main ------------------------------------------------------------------

async function main() {
  console.log('━━━ PPIO Expresso: Step 1 — Fetch ━━━');
  console.log(`  Date range: ${weekAgoStr()} → ${todayStr()}`);

  const config = loadConfig();
  const queries = buildSearchQueries(config);

  let allItems = [];

  // ── Phase 1: RSS feeds ──────────────────────────────────────────────
  console.log('\n  📡 RSS feeds...');
  const rssFeeds = [
    { url: 'https://36kr.com/feed', source: '36氪' },
    { url: 'https://venturebeat.com/category/ai/feed/', source: 'VentureBeat AI' },
    { url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', source: 'The Verge AI' },
    { url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed', source: 'MIT Tech Review AI' },
    { url: 'https://techcrunch.com/feed/', source: 'TechCrunch' },
  ];

  const rssResults = await Promise.all(rssFeeds.map(f => fetchRSS(f.url, f.source)));
  for (const items of rssResults) allItems.push(...items);

  // ── Phase 2: Google News search ─────────────────────────────────────
  console.log('\n  🔍 Google News searches...');

  // Run searches with controlled concurrency (3 at a time)
  const CONCURRENCY = 3;
  for (let i = 0; i < queries.length; i += CONCURRENCY) {
    const batch = queries.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(q => searchGoogleNews(q.q, q.category)));
    for (const items of results) allItems.push(...items);
  }

  // ── Phase 3: Filter, score & trim ──────────────────────────────────
  console.log(`\n  📊 Raw total: ${allItems.length} items`);

  // Filter by date (within 7 days)
  allItems = allItems.filter(item => isWithinWeek(item.published));
  console.log(`  Within 7 days: ${allItems.length} items`);

  // Score PPIO relevance
  allItems.forEach(item => { item._score = scorePPIORelevance(item); });

  // Remove negative-scored items
  const rejected = allItems.filter(i => i._score < 0);
  allItems = allItems.filter(i => i._score >= 0);
  if (rejected.length) console.log(`  Rejected (irrelevant): ${rejected.length} items`);

  // Deduplicate: entity first (group same story from different sources), then URL, then title
  const entityResult = dedupByEntity(allItems);
  allItems = entityResult.items;
  const entityDups = entityResult.dupCount;
  allItems = dedupByURL(allItems);
  allItems = dedupByTitle(allItems);
  console.log(`  After dedup: ${allItems.length} items (${entityDups} entity-group duplicates merged)`);

  // Sort by score (desc) then date (desc)
  allItems.sort((a, b) => b._score - a._score || b.published.localeCompare(a.published));

  // Trim: hard cap at 10, quality floor at score >= 25, but ensure at least 7 items
  const MIN_SCORE = 25;
  const MAX_RAW = 10;
  const MIN_ITEMS = 7;
  const lowQuality = allItems.filter(i => i._score < MIN_SCORE);
  allItems = allItems.filter(i => i._score >= MIN_SCORE);
  if (lowQuality.length) console.log(`  Below quality threshold (score<${MIN_SCORE}): ${lowQuality.length} items`);
  // If too few quality items, backfill from the best of the rest (score >= 20 only)
  if (allItems.length < MIN_ITEMS && lowQuality.length > 0) {
    const candidates = lowQuality.filter(i => i._score >= 20).sort((a, b) => b._score - a._score);
    const needed = MIN_ITEMS - allItems.length;
    if (candidates.length > 0) {
      console.log(`  Backfilling ${Math.min(needed, candidates.length)} items to reach minimum ${MIN_ITEMS}`);
      allItems.push(...candidates.slice(0, needed));
    }
  }
  if (allItems.length > MAX_RAW) {
    console.log(`  Trimming to top ${MAX_RAW} by PPIO relevance`);
    allItems = allItems.slice(0, MAX_RAW);
  }
  allItems.sort((a, b) => b._score - a._score || b.published.localeCompare(a.published));
  console.log(`  Final: ${allItems.length} items`);

  // Guess category for items without one
  allItems.forEach(item => { item.category = guessCategory(item); });

  // ── Phase 4: Fallback ───────────────────────────────────────────────
  let usedMock = false;
  if (allItems.length < 3) {
    console.warn(`  ⚠ Only ${allItems.length} items from live fetch, using mock fallback`);
    allItems = getMockItems();
    usedMock = true;
  }

  // Assign sequential IDs and strip internal fields
  allItems = allItems.map((item, i) => {
    const { _score, _dup_of, ...clean } = item;
    return { id: `raw-${String(i + 1).padStart(3, '0')}`, ...clean };
  });

  const output = {
    generated_at: new Date().toISOString(),
    week: `2026-W${String(weekNumber()).padStart(2, '0')}`,
    date_range: { from: weekAgoStr(), to: todayStr() },
    fetch_method: usedMock ? 'mock-fallback' : 'live',
    item_count: allItems.length,
    items: allItems
  };

  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`\n  ✓ Wrote ${allItems.length} raw items → ${OUT_PATH}`);
  console.log(`  Fetch method: ${output.fetch_method}`);
}

main().catch(err => { console.error(err); process.exit(1); });
