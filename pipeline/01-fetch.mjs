#!/usr/bin/env node

/**
 * PPIO 产业政策信息流 — Step 1: Fetch
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

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
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
  // Use Beijing time (UTC+8) to avoid date boundary issues
  const d = new Date(Date.now() + 8 * 3600_000);
  return d.toISOString().slice(0, 10);
}

function weekAgoStr() {
  const d = new Date(Date.now() + 8 * 3600_000 - 7 * 86400_000);
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
    const pubDate = get('pubDate');
    const source = get('source');

    // Extract link — Google News uses <link> as plain text between tags (no href attr)
    let link = get('link');
    // Fallback: try <link href="..."> or <feedburner:origLink>
    if (!link || link.startsWith('//') || !link.startsWith('http')) {
      const hrefMatch = itemXML.match(/<link[^>]+href=["']([^"']+)["']/i);
      const origLink = itemXML.match(/<(?:feedburner:origLink|origLink)[^>]*>(.*?)<\//is);
      link = hrefMatch?.[1] || origLink?.[1] || link;
    }

    // Extract description text — decode HTML entities first, then strip tags
    let description = '';
    let descFirstHref = '';
    const descMatch = itemXML.match(/<description[^>]*>(.*?)<\/description>/is);
    if (descMatch) {
      let raw = descMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1');
      // Decode HTML entities (Google News encodes the whole description)
      raw = raw
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'");
      // Extract text content: source names after </a> tags
      // Google News format: <a href="...">标题</a>&nbsp;<font color="...">来源</font>
      const sourceNames = [...raw.matchAll(/<font[^>]*>([^<]+)<\/font>/gi)].map(m => m[1]).join(' · ');
      const linkTexts = [...raw.matchAll(/<a[^>]*>([^<]+)<\/a>/gi)].map(m => m[1]);
      description = linkTexts.slice(0, 3).join(' / ') + (sourceNames ? '  ' + sourceNames : '');
      description = description.replace(/\s+/g, ' ').trim();
    }

    if (!title || !link) continue;
    items.push({ title, link, pubDate, description, descFirstHref: '', source });
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
 * Scrape a Shanghai government page listing (ul/li article links).
 * Parses title, url, date from the standard gov list format.
 */
async function scrapeGovList(url, source) {
  try {
    const html = await fetchWithRetry(url);
    const items = [];
    // Match list items: <a href="...">title</a> ... date
    const linkRe = /<a[^>]+href="([^"]+)"[^>]*>\s*(?:<[^>]+>)*\s*([^<]{4,}?)\s*(?:<\/[^>]+>)*\s*<\/a>/gi;
    const dateRe = /(\d{4}-\d{2}-\d{2})/;
    let m;
    while ((m = linkRe.exec(html)) !== null) {
      let href = m[1].trim();
      const title = m[2].replace(/<[^>]+>/g, '').trim();
      if (!title || title.length < 5) continue;
      if (!/[一-鿿]/.test(title)) continue; // must have Chinese
      // Resolve relative URLs
      if (href.startsWith('/')) href = new URL(href, url).href;
      else if (!href.startsWith('http')) continue;
      // Extract date from surrounding context
      const ctx = html.slice(Math.max(0, m.index - 50), m.index + m[0].length + 50);
      const dateMatch = ctx.match(dateRe);
      const published = dateMatch ? dateMatch[1] : todayStr();
      items.push({ title, url: href, source, published, body_snippet: '' });
    }
    // Deduplicate by title
    const seen = new Set();
    const unique = items.filter(i => { if (seen.has(i.title)) return false; seen.add(i.title); return true; });
    console.log(`    Gov ${url.slice(0, 50)}... → ${unique.length} items`);
    return unique;
  } catch (err) {
    console.warn(`    ⚠ Gov scrape failed (${url.slice(0, 50)}...): ${err.message}`);
    return [];
  }
}


/**
 * Scrape multiple pages using a single CloakBrowser instance.
 */
async function scrapeWithCloak(pages) {
  try {
    const { launch } = await import('cloakbrowser');
    const launchOpts = { headless: true };
    if (process.env.CHROME_PATH) launchOpts.executablePath = process.env.CHROME_PATH;
    const browser = await launch(launchOpts);
    const results = await Promise.all(pages.map(async ({ url, source, category }) => {
      try {
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
        const items = await page.evaluate(({ src, cat }) => {
          const results = [];
          const seen = new Set();
          document.querySelectorAll('a').forEach(a => {
            const title = a.innerText.trim();
            const href = a.href;
            if (!title || title.length < 8 || title.length > 100) return;
            if (!/[一-鿿]/.test(title)) return;
            if (!href || !href.startsWith('http')) return;
            if (seen.has(title)) return;
            seen.add(title);
            results.push({ title, url: href, source: src, category: cat,
              published: new Date().toISOString().slice(0, 10), body_snippet: title });
          });
          return results.slice(0, 15);
        }, { src: source, cat: category });
        await page.close();
        console.log(`    Cloak ${url.slice(0, 40)}... → ${items.length} items`);
        return items;
      } catch (err) {
        console.warn(`    ⚠ Cloak failed (${url.slice(0, 40)}...): ${err.message.slice(0, 60)}`);
        return [];
      }
    }));
    await browser.close();
    return results.flat();
  } catch (err) {
    console.warn(`    ⚠ CloakBrowser launch failed: ${err.message.slice(0, 60)}`);
    return [];
  }
}

async function searchGoogleNews(query, category, boost = 0) {
  const encoded = encodeURIComponent(query);
  const url = `https://news.google.com/rss/search?q=${encoded}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
  try {
    const xml = await fetchWithRetry(url);
    const items = parseRSS(xml);
    console.log(`    Search "${query.slice(0, 40)}" → ${items.length} items`);
    return items.slice(0, 20).map(item => {
      // Google News RSS links are redirect URLs — acceptable, browser follows them
      let realUrl = item.link;

      // Normalize aggregator sources
      let source = item.source || 'Google News';
      if (/toutiao\.com|baijia\.baidu|mp\.weixin/.test(realUrl || '')) {
        const descMatch = (item.description || '').match(/来源[：:]\s*([^\s<，,。]{2,15})/);
        source = descMatch ? descMatch[1] : (item.source || '今日头条');
      }

      return {
        title: item.title,
        url: realUrl,
        source,
        category,
        published: parsePubDate(item.pubDate) || todayStr(),
        body_snippet: (item.description || '').slice(0, 200),
        _query_boost: boost
      };
    });
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
    /硅基流动/, /七牛云/, /七牛.*AI/, /优刻得/, /UCloud.*AI/,
    /Baseten/, /Fireworks.*AI/, /Lightning.*AI/, /Parasail/,
    // Key policy — broader matching
    /国家算力网/, /算力基础设施/, /算力.*超前部署/,
    /人工智能法/, /AI.*立法/, /AI.*安全审查/,
    /智能体产业/, /AI智能体.*政策/, /AI智能体.*规范/, /AI智能体.*发展/,
    /三部门.*AI/, /三部门.*智能体/, /国办.*人工智能/, /国务院.*AI/,
    // 上海市级政府
    /上海市经信委/, /上海市数据局/, /上海市发改委/, /上海市委金融办/,
    /浦东新区.*AI/, /浦东新区.*算力/, /浦东.*科经委/, /浦东.*数据局/,
    /张江科学城.*AI/, /张江.*算力/, /张江.*人工智能/,
    // 高层调研/部署
    /丁薛祥/, /李强.*AI/, /李强.*算力/, /李强.*数字经济/, /李强.*人工智能/,
    /习近平.*人工智能/, /习近平.*算力/, /习近平.*数字经济/, /习近平.*科技/,
    /习近平.*未来产业/, /习近平.*具身智能/, /习近平.*新质生产力/,
    /政治局.*集体学习.*人工智能/, /政治局.*集体学习.*未来产业/, /政治局.*集体学习.*算力/,
    /政治局.*人工智能/, /政治局.*算力/, /政治局常委.*AI/, /政治局常委.*算力/,
    /国务院常务会议.*AI/, /国务院常务会议.*算力/, /国务院常务会议.*人工智能/,
    /国常会.*人工智能/, /国常会.*算力/, /国常会.*数字经济/,
    /总理.*算力/, /总理.*人工智能/, /总理.*AI/,
    /六张网/, /算力网.*建设/, /一体化算力网/,
    // OPC / 个人AI创业
    /OPC/, /一人公司.*AI/, /个人.*AI.*创业/, /AI.*个人创业/,
    // 大厂发布/IPO
    /超聚变.*IPO/, /超聚变.*上市/, /算力.*IPO/, /算力.*上市/,
    /阿里云.*峰会/, /百度.*AI.*大会/, /华为.*算力/, /腾讯.*算力/,
    // 大厂AI资本支出 — 竞品生态压力
    /字节跳动.*AI.*基础设施/, /字节跳动.*算力/, /字节.*2000亿/, /字节.*AI.*投入/,
    /阿里云.*千问云/, /阿里云.*全栈.*Agent/, /阿里云.*Agent.*升级/,
    /腾讯.*AI.*基础设施/, /百度.*AI.*基础设施/,
    // 国产芯片认证 — 自主可控叙事
    /安全可靠测评.*芯片/, /国产.*AI.*芯片.*测评/, /AI.*训练推理芯片.*测评/,
    /国产芯片.*市场份额/, /海思半导体.*AI/,
    // 海外重大AI政策/资本事件中文报道
    /特朗普.*AI.*行政令/, /特朗普.*人工智能.*命令/, /美国.*AI.*行政令/,
    /Anthropic.*IPO/, /Anthropic.*上市/, /Anthropic.*SEC/, /Anthropic.*招股/,
    /Vera.*Rubin.*量产/, /英伟达.*Vera.*Rubin/, /黄仁勋.*Vera/,
    /AI中转站.*合规/, /AI中转站.*备案/, /AI中转站.*监管/,
    /生成式AI.*增值电信/, /大模型.*增值电信.*备案/, /AI.*数据出境.*评估/,
    /对外投资.*规定/, /国令.*对外投资/, /跨境数据.*监管/, /技术出口.*管制.*对外投资/,
    /VIE.*对外投资/, /境外上市.*对外投资/, /国令第837号/,
    // 部委署名文章 — 高规格政策信号
    /工信部.*部长.*人民日报/, /工信部.*部长.*署名/, /部长.*未来产业/, /李乐成.*未来产业/,
    /司法部.*AI.*立法/, /司法部.*人工智能.*立法/, /人工智能健康发展综合性立法/,
    // 工信部信息通信实施意见 — 边缘算力直接利好
    /工信部.*信息通信.*实施意见/, /AI.*信息通信.*实施意见/, /城域算力.*时延/,
    /1毫秒.*时延圈/, /通感算智一体化/, /边缘推理.*5G/, /网络智能体.*业务/,
    // 竞品产品发布
    /Token工厂/, /硅基流动.*运营商/, /无问芯穹.*一体机/, /无问芯穹.*Mizar/,
    /优刻得.*全球.*节点/, /UCloud.*可用区/,
    // 欧盟云主权/技术主权
    /欧盟.*云.*法案/, /云与人工智能发展法案/, /技术主权.*一揽子/, /欧盟.*云主权/,
    /EU.*Cloud.*AI.*Act/i, /技术主权.*芯片法案/,
    // BIS中资子公司指引
    /中资.*海外.*子公司.*芯片/, /BIS.*中资.*许可/, /海外子公司.*出口许可/,
    // 模型层出口管制 — 中美技术摩擦新战场
    /模型.*出口管制/, /模型.*暂停.*外国/, /Anthropic.*出口/, /Mythos.*暂停/,
    /AI模型.*外国.*访问/, /模型访问.*限制/, /出口管制.*模型/,
    // 模型发布 — 开源/能力跃迁影响推理需求
    /智谱.*开源/, /GLM.*5/, /GLM.*Coding/, /智谱.*发布/,
    /DeepSeek.*发布/, /DeepSeek.*开源/, /通义千问.*开源/, /Qwen.*开源/,
    /大模型.*开源.*MIT/, /模型.*开源.*协议/,
    // 公司正参与的政策 — MAAS/AI中能站/算力补贴白名单/AI安全专项整治
    /MAAS.*平台.*政策/, /工信部.*MAAS/, /AI.*中能站/, /人工智能.*中能站/,
    /算力补贴.*白名单/, /白名单.*算力/, /算力.*补贴.*门槛/, /自建集群.*算力/,
    /人工智能.*安全.*专项整治/, /AI.*安全.*专项整治/, /安全.*专项整治.*人工智能/,
    /信通院.*智能体.*标准/, /智能体.*运行能力.*标准/, /智能体.*能力要求.*信通院/,
    // 高端GPU供应链波动 — 只追供给信号，不追价格
    /B300.*供货/, /B300.*紧缺/, /B300.*交期/, /B300.*产能/,
    /GB300.*供应/, /英伟达.*供货.*紧张/, /GPU.*缺货/, /GPU.*供应链.*波动/,
    /算力.*供给.*紧张/, /高端算力.*短缺/, /算力.*供需/,
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
    // 大厂AI资本支出（高层级）
    /字节跳动.*AI/, /字节.*算力/, /字节.*基础设施/,
    /阿里云.*峰会/, /阿里云.*发布/, /阿里云.*模型/,
    // 国内头部AI大模型融资 — 资本环境直接信号
    /月之暗面.*融资/, /Moonshot.*融资/, /月之暗面.*估值/,
    /DeepSeek.*融资/, /DeepSeek.*大基金/, /大基金.*DeepSeek/, /深度求索.*融资/,
    /AI.*融资/, /融资.*AI/, /人工智能.*融资/,
    // 国常会未来产业
    /国常会.*未来产业/, /国务院常务.*未来产业/, /李强.*未来产业/,
    // 求是党刊 — 最高规格政策信号
    /求是.*习近平/, /习近平.*求是/, /求是.*未来产业/, /求是.*人工智能/,
    /阴和俊.*求是/, /求是.*科技部/, /求是.*部长/, /阴和俊.*未来产业/,
    /求是.*阴和俊/, /科技部.*部长.*求是/,
    // 全球AI基础设施投资
    /软银.*数据中心/, /软银.*AI.*投资/, /微软.*AI.*数据中心/,
    /谷歌.*AI.*基础设施/, /亚马逊.*AI.*数据中心/, /Meta.*AI.*基础设施/,
    // 中外科技摩擦
    /英伟达.*中国/, /中国.*英伟达/, /芯片.*禁令/, /出口管制.*芯片/,
    /闻泰/, /安世半导体/, /反外国制裁/,
    // 国产芯片
    /国产.*AI.*芯片/, /AI.*芯片.*国产/, /自主可控.*芯片/, /国产芯片.*份额/,
    // 伦理/治理
    /AI.*伦理/, /AI.*内容标注/, /生成式AI.*标注/, /短视频.*AI标签/,
  ],
  medium: [
    /AI.*IPO/,
    /大模型/, /LLM/, /Agent.*平台/, /AI.*Agent/,
    /美国.*AI/, /EU.*AI/, /欧盟.*AI/, /AI.*Act/,
    /云服务/, /云计算.*AI/,
    /AI.*社交/, /AI.*治理/, /虚拟伴侣/,
    /CSRC/, /VIE/, /备案.*境外上市/,
    /港交所.*IPO/, /港股.*上市.*审核/, /境外上市.*新规/, /招股书.*审核/,
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
    // 股票/财经分析 — GR视角不需要
    /A股.*算力/, /算力.*涨停/, /算力.*概念股/, /算力.*ETF/, /算力.*基金/,
    /涨停相迎/, /价值重估/, /机构前瞻/, /投资机会/, /买入评级/,
    /绿电ETF/, /基本面关联/, /股价/, /市值/, /PE估值/, /市盈率/,
    /炒股/, /散户/, /主力资金/, /龙虎榜/, /板块轮动/,
    // 无关行业
    /MLCC/, /被动元件/, /新材料/, /汽车.*销量/, /手机.*销量/,
    /小米.*手机/, /华为.*手机/, /苹果.*手机/, /vivo/, /OPPO/,
    /人车家/, /智能家居/, /扫地机/, /电视.*销量/,
  ],
  // English keyword tiers for overseas RSS sources
  en_critical: [
    /nvidia.*china/i, /china.*nvidia/i, /chip.*export.*china/i, /china.*chip.*ban/i,
    /ai.*infrastructure.*china/i, /china.*ai.*regulation/i, /ai.*compute.*china/i,
    /edge.*computing.*ai/i, /distributed.*inference/i, /ai.*cloud.*china/i,
    /h200.*china/i, /h100.*china/i, /export.*control.*ai/i,
    /baseten/i, /fireworks.*ai/i, /lightning.*ai.*inference/i, /parasail.*ai/i,
    /anthropic.*ipo/i, /anthropic.*s-1/i, /anthropic.*sec/i,
    /trump.*ai.*executive/i, /trump.*ai.*order/i, /white.*house.*ai.*order/i,
    /nvidia.*vera.*rubin/i, /nvidia.*blackwell/i,
    /eu.*cloud.*ai.*act/i, /cloud.*ai.*development.*act/i, /eu.*tech.*sovereignty/i,
    /bis.*china.*subsidiary/i, /china.*subsidiary.*chip.*license/i, /bis.*export.*guidance.*china/i,
  ],
  en_high: [
    /ai.*regulation/i, /ai.*legislation/i, /ai.*safety.*act/i, /eu.*ai.*act/i,
    /openai.*funding/i, /anthropic.*funding/i, /ai.*startup.*funding/i,
    /ai.*ipo/i, /ai.*valuation/i, /llm.*infrastructure/i,
    /nvidia.*regulation/i, /semiconductor.*china/i, /chip.*ban/i,
    /ai.*data.*center/i, /cloud.*computing.*ai/i, /ai.*inference/i,
    /trump.*ai/i, /us.*ai.*policy/i, /china.*ai.*competition/i,
    /moonshot.*ai.*funding/i, /deepseek.*funding/i, /deepseek.*valuation/i,
  ],
  en_medium: [
    /artificial.*intelligence.*funding/i, /machine.*learning.*startup/i,
    /ai.*agent/i, /large.*language.*model/i, /foundation.*model/i,
    /venture.*capital.*ai/i, /ai.*investment/i,
    /china.*tech/i, /chinese.*ai/i, /beijing.*ai/i,
  ]
};

function scorePPIORelevance(item) {
  const text = (item.title + ' ' + (item.body_snippet || '')).toLowerCase();
  const isEnglish = /[a-z]{4,}/.test(item.title) && !/[一-鿿]/.test(item.title);
  let score = 15;
  let matched = false;

  if (isEnglish) {
    // English scoring channel
    for (const re of PPIO_KEYWORDS.en_critical) {
      if (re.test(text)) { score += 40; matched = true; break; }
    }
    for (const re of PPIO_KEYWORDS.en_high) {
      if (re.test(text)) { score += 20; matched = true; }
    }
    for (const re of PPIO_KEYWORDS.en_medium) {
      if (re.test(text)) { score += 8; matched = true; }
    }
  } else {
    // Chinese scoring channel
    for (const re of PPIO_KEYWORDS.critical) {
      if (re.test(text)) { score += 40; matched = true; break; }
    }
    for (const re of PPIO_KEYWORDS.high) {
      if (re.test(text)) { score += 20; matched = true; }
    }
    for (const re of PPIO_KEYWORDS.medium) {
      if (re.test(text)) { score += 8; matched = true; }
    }
  }

  for (const re of PPIO_KEYWORDS.negative) {
    if (re.test(text)) { score = -50; break; }
  }

  // Shanghai gov sources: boost if content is AI/computing related
  const isShanghaigov = /上海市经信委|上海经信委|上海市数据局|上海市发改委|上海市委金融办|浦东新区|张江科学城/.test(item.source || '');
  if (isShanghaigov && score > -50) {
    const isAIRelated = /人工智能|算力|大模型|智能体|数字经济|数据要素|AI|科技|创新|产业/.test(text);
    if (isAIRelated) {
      matched = true;
      score = Math.max(score, 35);
    }
  }

  // Only give source/recency bonuses if item matched at least one PPIO keyword
  if (matched) {
    // Hard reject non-English/non-Chinese sources (e.g. German, French)
    const title = item.title || '';
    if (/[a-z]{4,}/.test(title) && !/[一-鿿]/.test(title)) {
      const hasGermanFrench = /\b(von|der|die|das|und|für|mit|des|dem|ein|eine|ist|sind|wird|werden|les|des|une|pour|dans|avec|sur)\b/i.test(title);
      if (hasGermanFrench) return -50;
    }
    if (/新华社|中国政府网|工信部|发改委|证监会|网信办|广电总局|国家数据局|司法部/.test(item.source || '')) score += 35;
    if (/人民日报|央视|新华网|中国新闻网|科技日报|经济日报/.test(item.source || '')) score += 25;
    if (/上海市经信委|上海经信委|上海市数据局|上海市发改委|上海市委金融办/.test(item.source || '')) score += 35;
    if (/浦东新区|张江科学城|张江/.test(item.source || '')) score += 30;
    if (/财新|澎湃|thepaper|南华早报|SCMP|Reuters|Financial Times|FT\.com|联合早报|zaobao/.test(item.source || '')) score += 20;
    if (/21财经|21世纪经济|21jingji|第一财经|经济观察/.test(item.source || '')) score += 15;
    if (/虎嗅|36氪|量子位|机器之心|aibase/.test(item.source || '')) score += 10;
    if (/VentureBeat|MIT Tech Review|TechCrunch|The Verge|Politico|Axios/.test(item.source || '')) score += 12;
    // 降权：股票/财经分析媒体（但命中critical关键词时豁免）
    const isCriticalHit = PPIO_KEYWORDS.critical.some(re => re.test(text));
    if (/同花顺|东方财富|财富号|雪球|股吧|证券时报|证券日报|中国证券报/.test(item.source || '')) score -= 20;
    if (/新浪财经|搜狐财经|网易财经|腾讯财经/.test(item.source || '') && !isCriticalHit) score -= 10;

    if (item.published === todayStr()) score += 10;
    else if (item.published >= weekAgoStrPlus(2)) score += 5;

    // 降权：早报/晚报/日报汇编（容易混入旧日期内容）
    if (/【早报】|【晚报】|【日报】|早知道|每日速递/.test(title)) score -= 15;
  }

  // Query-level boost: items from high-signal queries get a floor raise
  if (item._query_boost && score > -50) {
    score += item._query_boost;
  }

  return score;
}

function weekAgoStrPlus(days) {
  const d = new Date(Date.now() + 8 * 3600_000 - days * 86400_000);
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

  // Topic-level dedup: same policy/event → same bucket regardless of source
  const topics = [
    ['六张网', '六张网'],
    ['算力网', '算力网建设'],
    ['超聚变|算力.*IPO|算力.*创业板|算力.*上市|算力.*独角兽.*IPO', '超聚变IPO'],
    ['Token.*套餐|算力套餐|运营商.*Token|Token.*运营商|卖Token', '运营商Token套餐'],
    ['无问芯穹', '无问芯穹'],
    ['硅基流动', '硅基流动'],
    ['七牛云|七牛.*AI', '七牛云'],
    ['优刻得|UCloud.*AI', '优刻得'],
    ['Baseten', 'Baseten'],
    ['Fireworks.*AI', 'Fireworks AI'],
    ['Lightning.*AI', 'Lightning AI'],
    ['Parasail', 'Parasail'],
    ['丁薛祥.*算力|算力.*丁薛祥|政治局.*算力|中央政治局.*算力', '高层调研算力'],
    ['国常会.*人工智能|国务院常务.*AI|国务院常务.*算力', '国常会AI部署'],
    ['习近平.*未来产业|政治局.*集体学习.*未来产业|政治局.*集体学习.*人工智能', '习近平未来产业讲话'],
    ['李强.*人工智能|李强.*算力|李强.*数字经济|总理.*算力', '总理AI调研'],
    ['政治局.*人工智能|政治局.*算力|政治局.*数字经济', '政治局AI部署'],
    ['人工智能法|AI.*立法|立法.*AI|人工智能.*综合性立法|司法部.*人工智能.*立法|人工智能健康发展综合性立法', 'AI立法'],
    ['AI中转站.*合规|AI中转站.*备案|生成式AI.*增值电信.*备案|大模型.*中转.*监管', 'AI中转站合规'],
    ['字节跳动.*AI.*基础设施|字节跳动.*算力.*投入|字节.*2000亿|字节.*AI.*投入', '字节AI基础设施'],
    ['阿里云.*千问云|阿里云.*全栈.*Agent|千问云.*发布|阿里云.*峰会.*Agent', '阿里云千问云'],
    ['软银.*法国.*数据中心|软银.*750亿|SoftBank.*France.*AI', '软银法国AI投资'],
    ['安全可靠测评.*芯片|国产.*AI.*芯片.*测评|AI训练推理芯片.*测评', '国产芯片测评'],
    ['工信部.*部长.*人民日报|李乐成.*未来产业|工信部.*未来产业.*署名', '工信部未来产业'],
    ['H200.*中国|中国.*H200|英伟达.*中国.*芯片', '英伟达H200中国'],
    ['出口管制.*芯片|芯片.*出口管制', '芯片出口管制'],
    ['国家人工智能产业投资基金|AI.*产业.*基金', 'AI产业基金'],
    ['VIE.*审核|VIE.*备案|境外上市.*备案|境外上市.*新规', 'VIE境外上市'],
    ['港交所.*IPO|港股.*上市.*审核|香港.*IPO.*科技', '港股IPO监管'],
  ];

  for (const [pattern, bucket] of topics) {
    if (new RegExp(pattern).test(t)) return bucket;
  }

  // Entity-level dedup
  const entities = ['无问芯穹', '硅基流动', '七牛云', '优刻得', 'UCloud',
    'Baseten', 'Fireworks', 'Lightning AI', 'Parasail',
    'PPIO', 'Sandbox',
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
  // 政策 — 高层调研与国常会
  queries.push({ q: '国务院常务会议 人工智能 算力 数字经济 2026', category: '政策' });
  queries.push({ q: '国常会 AI 算力 部署 决策 2026', category: '政策' });
  queries.push({ q: '习近平 人工智能 算力 调研 部署 2026', category: '政策' });
  queries.push({ q: '习近平 未来产业 具身智能 量子 讲话 2026', category: '政策', boost: 40 });
  queries.push({ q: '政治局集体学习 未来产业 人工智能 2026', category: '政策', boost: 35 });
  queries.push({ q: '李强 人工智能 算力 数字经济 调研 2026', category: '政策' });
  queries.push({ q: '总理 算力 AI 基础设施 部署 2026', category: '政策' });
  queries.push({ q: '政治局常委 人工智能 算力 调研 2026', category: '政策' });
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
  queries.push({ q: '工信部 人工智能 信息通信 实施意见 2026', category: '政策', boost: 30 });
  queries.push({ q: '工信部 城域算力 时延 边缘推理 2026', category: '政策', boost: 25 });
  queries.push({ q: '国家发改委 算力网 东数西算 部署', category: '政策' });
  queries.push({ q: '发改委 数据中心 绿色算力 能耗', category: '政策' });
  queries.push({ q: '发改委 数字基础设施 投资 规划', category: '政策' });
  queries.push({ q: '科技部 人工智能 大模型 研发 支持', category: '政策' });
  queries.push({ q: '网信办 生成式AI 算法备案 内容标注', category: '政策' });
  queries.push({ q: '网信办 数据安全 跨境 合规', category: '政策' });
  queries.push({ q: '国家人工智能产业投资基金 算力 布局', category: '政策' });
  queries.push({ q: '财政部 数字经济 专项资金 补贴', category: '政策' });

  // 政策 — 上海市级政府
  queries.push({ q: '上海市政府 人工智能 算力 政策 2026', category: '政策' });
  queries.push({ q: '上海市经信委 AI 算力 大模型 部署', category: '政策' });
  queries.push({ q: '上海市数据局 数据要素 算力 政策', category: '政策' });
  queries.push({ q: '上海市发改委 算力 数字经济 规划', category: '政策' });
  queries.push({ q: '上海市委金融办 科技金融 AI 算力', category: '政策' });
  queries.push({ q: '上海 十五五 服务业 智算云 AI 2026', category: '政策', boost: 20 });
  queries.push({ q: '上海 科学智能 百团百项 算力 语料 2026', category: '政策', boost: 20 });
  queries.push({ q: '浦东新区 人工智能 算力 政策 产业', category: '政策' });
  queries.push({ q: '浦东新区科经委 AI 大模型 算力 支持', category: '政策' });
  queries.push({ q: '浦东新区数据局 数据要素 算力 开放', category: '政策' });
  queries.push({ q: '浦东 AI 文创 阅文 算力 出海 2026', category: '政策', boost: 15 });
  queries.push({ q: '张江科学城 人工智能 算力 产业 2026', category: '政策' });

  // 监管
  queries.push({ q: 'AI 人工智能 立法 安全审查 备案', category: '监管' });
  queries.push({ q: '人工智能法 草案 立法进展', category: '监管' });
  queries.push({ q: '司法部 人工智能 综合性立法 2026', category: '监管', boost: 20 });
  // AI中转站/算力服务合规 — 与PPIO算力服务边界直接相关
  queries.push({ q: 'AI中转站 合规 备案 数据出境 监管 2026', category: '监管', boost: 20 });
  queries.push({ q: '生成式AI 增值电信业务 备案 合规 2026', category: '监管', boost: 15 });
  queries.push({ q: 'AI API 数据出境 安全评估 合规 云服务', category: '监管', boost: 15 });
  // 公司正参与制定的政策 — MAAS平台/AI中能站
  queries.push({ q: '工信部 MAAS 平台 人工智能 模型 服务 2026', category: '监管', boost: 25 });
  queries.push({ q: 'AI 中能站 人工智能 算力 政策 2026', category: '监管', boost: 20 });
  // 上海市算力补贴白名单 — 公司非成员，正建议改政策
  queries.push({ q: '上海 算力补贴 白名单 集群 门槛 2026', category: '监管', boost: 25 });
  queries.push({ q: '算力补贴 自建集群 3000P 6000P 政策 2026', category: '监管', boost: 20 });
  // 7月人工智能安全专项整治
  queries.push({ q: '人工智能 安全 专项整治 2026 网信办', category: '监管', boost: 25 });
  queries.push({ q: 'AI 安全 专项治理 网络安全 整治 2026', category: '监管', boost: 20 });
  // Modelhub/海外公转站监管
  queries.push({ q: 'AI 中转站 海外模型 监管 网安 2026', category: '监管', boost: 20 });
  queries.push({ q: '海外大模型 公转站 合规 信安局 网安局 2026', category: '监管', boost: 20 });
  // 信通院智能体标准
  queries.push({ q: '信通院 智能体 运行能力 标准 评估 2026', category: '监管', boost: 20 });
  queries.push({ q: '智能体 能力要求 标准 制定 信通院 排名', category: '监管', boost: 15 });
  // 对外投资/VIE/跨境数据 — IPO合规直接相关
  queries.push({ q: '国务院 对外投资 规定 国令 2026', category: '监管', boost: 30 });
  queries.push({ q: '对外投资规定 跨境数据 技术出口管制', category: '监管', boost: 25 });
  queries.push({ q: 'VIE 对外投资 境外上市 合规 2026', category: '监管', boost: 20 });

  // IPO / 港股上市 / VIE — 公司敏感议题
  queries.push({ q: '港交所 科技公司 IPO 上市 审核 2026', category: '监管' });
  queries.push({ q: 'VIE 架构 审核 备案 证监会 境外上市', category: '监管' });
  queries.push({ q: '中国企业 香港 IPO 上市 监管 合规', category: '监管' });
  queries.push({ q: '境外上市 备案 新规 证监会 进展', category: '监管' });
  queries.push({ q: '科技公司 港股 上市 招股书 审核', category: '监管' });
  queries.push({ q: 'IPO早知道 港股 科技 上市 2026', category: '监管' });

  // 竞品 — 国内
  queries.push({ q: '无问芯穹 融资 产品 动态', category: '竞品' });
  queries.push({ q: '无问芯穹 一体机 推理 产品发布 2026', category: '竞品', boost: 20 });
  queries.push({ q: '硅基流动 推理 融资 产品', category: '竞品' });
  queries.push({ q: '硅基流动 Token工厂 运营商 合作 2026', category: '竞品', boost: 20 });
  queries.push({ q: 'Token工厂 算力 推理 运营商 2026', category: '竞品', boost: 15 });
  queries.push({ q: '七牛云 AI 算力 产品', category: '竞品' });
  queries.push({ q: '优刻得 UCloud AI 算力 融资', category: '竞品' });
  queries.push({ q: '优刻得 UCloud 全球化 海外节点 2026', category: '竞品', boost: 15 });
  queries.push({ q: 'AI基础设施 AI Infra 融资 2026', category: '竞品' });
  // 大厂AI资本支出 — 竞品生态压力
  queries.push({ q: '字节跳动 AI 基础设施 投入 2026', category: '竞品', boost: 20 });
  queries.push({ q: '字节跳动 算力 芯片 自研 2026', category: '竞品', boost: 15 });
  queries.push({ q: '阿里云 千问云 Agent 峰会 发布 2026', category: '竞品', boost: 20 });
  queries.push({ q: '阿里云 百度 腾讯 AI 基础设施 投入 2026', category: '竞品', boost: 15 });
  // 模型发布 — 开源/能力跃迁影响推理需求格局
  queries.push({ q: '智谱 开源 模型发布 GLM 2026', category: '技术', boost: 20 });
  queries.push({ q: 'DeepSeek 模型 发布 开源 2026', category: '技术', boost: 20 });
  queries.push({ q: '通义千问 模型 开源 发布 2026', category: '技术', boost: 20 });
  queries.push({ q: '大模型 开源 MIT 协议 发布 2026', category: '技术', boost: 15 });
  queries.push({ q: 'Anthropic 出口管制 模型 暂停 外国 访问 2026', category: '海外', boost: 30 });
  queries.push({ q: 'AI模型 出口管制 美国限制 外国公民 2026', category: '海外', boost: 25 });

  // 竞品 — 海外
  queries.push({ q: 'Baseten AI inference startup funding', category: '竞品' });
  queries.push({ q: 'Fireworks AI inference funding product', category: '竞品' });
  queries.push({ q: 'Lightning AI startup funding 2026', category: '竞品' });
  queries.push({ q: 'Parasail AI inference cloud funding', category: '竞品' });

  // 资本 — 只保留 IPO/上市监管相关，去掉股票分析
  queries.push({ q: '香港 科技股 IPO 上市 监管 备案', category: '资本' });
  queries.push({ q: '证监会 境外上市 备案 VIE 合规', category: '监管' });

  // 技术
  queries.push({ q: '阿里云 百度 华为 AI 发布 峰会 2026', category: '技术' });
  // 国产芯片认证 — 自主可控叙事
  queries.push({ q: '安全可靠测评 AI 训练推理芯片 国产 2026', category: '技术', boost: 20 });
  queries.push({ q: '国产AI芯片 市场份额 测评 2026', category: '技术', boost: 15 });
  // 高端GPU供应链波动（不搜实时价格，只追供给紧张/交期/产能信号）
  queries.push({ q: 'B300 GB300 供应 交期 产能 紧张 2026', category: '技术', boost: 20 });
  queries.push({ q: '英伟达 高端GPU 供货 紧缺 缺货 2026', category: '技术', boost: 15 });
  queries.push({ q: 'AI算力 GPU 供应链 波动 紧缺 涨价 2026', category: '技术', boost: 15 });
  queries.push({ q: '算力 周报 供需 行情 总结 2026', category: '技术', boost: 15 });
  queries.push({ q: 'GPU 算力 市场周报 供给 需求 2026', category: '技术', boost: 15 });
  queries.push({ q: 'site:news.aibase.com AI 算力 大模型 2026', category: '技术' });
  queries.push({ q: '中国电信 中国移动 算力 Token AI', category: '技术' });
  queries.push({ q: '算力调度 推理优化 Agent 技术突破', category: '技术' });
  queries.push({ q: 'AI 大模型 边缘计算 分布式推理', category: '技术' });
  // 中文媒体补充（替代失效RSS）
  queries.push({ q: 'site:huxiu.com AI 算力 大模型 2026', category: '技术' });
  queries.push({ q: 'site:latepost.com AI 算力 科技 2026', category: '技术' });
  queries.push({ q: 'site:jiqizhixin.com AI 算力 大模型 2026', category: '技术' });
  queries.push({ q: '机器之心 AI 算力 大模型 2026', category: '技术' });
  queries.push({ q: '晚点LatePost AI 科技 融资 2026', category: '竞品' });
  queries.push({ q: '虎嗅 AI 算力 大模型 政策 2026', category: '政策' });
  // Anthropic / DeepSeek 官方动态
  queries.push({ q: 'site:anthropic.com AI safety model 2026', category: '海外' });
  queries.push({ q: 'DeepSeek 大模型 发布 融资 2026', category: '竞品' });
  // 求是党刊 — 最高规格政策信号
  queries.push({ q: '求是 习近平 人工智能 未来产业 算力', category: '政策', boost: 30 });
  queries.push({ q: '求是 部长 人工智能 科技 2026', category: '政策', boost: 25 });
  // 头部AI融资
  queries.push({ q: '月之暗面 融资 估值 2026', category: '资本', boost: 20 });
  queries.push({ q: 'DeepSeek 大基金 融资 估值 2026', category: '资本', boost: 20 });
  queries.push({ q: 'Moonshot AI funding valuation 2026', category: '资本', boost: 15 });
  // 海外AI政策重大事件
  queries.push({ q: 'Trump AI executive order 2026', category: '海外', boost: 20 });
  queries.push({ q: 'Anthropic IPO SEC filing S-1 2026', category: '海外', boost: 20 });
  queries.push({ q: 'Nvidia Vera Rubin production 2026', category: '海外', boost: 15 });
  // 国常会未来产业
  queries.push({ q: '国务院常务会议 未来产业 2026', category: '政策', boost: 30 });
  queries.push({ q: '李强 未来产业 国常会 2026', category: '政策', boost: 25 });

  // 海外
  queries.push({ q: '英伟达 H200 中国 出口 芯片', category: '海外' });
  // 全球AI基础设施投资 — 市场叙事背景
  queries.push({ q: '软银 AI 数据中心 投资 2026', category: '海外', boost: 15 });
  queries.push({ q: 'SoftBank AI data center investment 2026', category: '海外', boost: 15 });
  queries.push({ q: 'Microsoft Google Meta AI infrastructure investment 2026', category: '海外', boost: 10 });
  queries.push({ q: 'global AI data center capacity investment 2026', category: '海外', boost: 10 });
  queries.push({ q: 'US AI regulation export control China', category: '海外' });
  queries.push({ q: 'BIS export control advanced computing China 2026', category: '海外' });
  queries.push({ q: 'BIS guidance AI chip license requirement China 2026', category: '海外' });
  queries.push({ q: 'AI Diffusion Rule export control semiconductor China', category: '海外' });
  queries.push({ q: 'Commerce Department BIS China AI chip ban 2026', category: '海外' });
  // 美国政策媒体
  queries.push({ q: 'site:bis.gov export control China AI semiconductor 2026', category: '海外' });
  queries.push({ q: 'site:politico.com China AI chip export control 2026', category: '海外' });
  queries.push({ q: 'site:axios.com China AI semiconductor regulation 2026', category: '海外' });
  queries.push({ q: 'site:thehill.com China AI technology export control 2026', category: '海外' });
  queries.push({ q: 'White House AI policy China semiconductor 2026', category: '海外' });
  queries.push({ q: 'Congress AI regulation China technology bill 2026', category: '海外' });
  queries.push({ q: 'EU AI Act enforcement 2026', category: '海外' });
  queries.push({ q: 'EU Cloud AI Development Act 云主权 技术主权 2026', category: '海外', boost: 25 });
  queries.push({ q: '欧盟 云与人工智能发展法案 技术主权 数据中心 2026', category: '海外', boost: 25 });
  queries.push({ q: 'BIS China subsidiary AI chip export license 2026', category: '海外', boost: 25 });
  queries.push({ q: '中资 海外子公司 英伟达 芯片 出口许可 2026', category: '海外', boost: 25 });
  queries.push({ q: '中国 美国 AI 出口管制 芯片 供应链', category: '海外' });
  queries.push({ q: '中俄 AI 合作 治理 标准', category: '海外' });

  // 海外媒体 — FT / Reuters / 联合早报
  queries.push({ q: 'site:ft.com China AI chip regulation 2026', category: '海外' });
  queries.push({ q: 'site:ft.com China technology IPO Hong Kong 2026', category: '海外' });
  queries.push({ q: 'site:reuters.com China AI semiconductor export control', category: '海外' });
  queries.push({ q: 'site:reuters.com China technology regulation 2026', category: '海外' });
  queries.push({ q: '联合早报 中国 人工智能 芯片 监管', category: '海外' });
  queries.push({ q: '联合早报 中国 科技 IPO 上市 2026', category: '海外' });
  queries.push({ q: 'site:zaobao.com.sg 人工智能 算力 中国', category: '海外' });

  return queries;
}

// ---- category assignment ----------------------------------------------------

function guessCategory(item) {
  if (item.category) return item.category;
  const t = item.title + ' ' + (item.body_snippet || '');
  // 监管优先于政策 — 对外投资/VIE/跨境数据/立法
  if (/对外投资.*规定|国令.*对外投资|跨境数据.*监管|技术出口.*管制|VIE.*对外投资/.test(t)) return '监管';
  if (/立法|安全审查|备案|合规|监管|CSRC|牌照|司法部.*AI/.test(t)) return '监管';
  if (/国务院|发改委|工信部|网信办|部委|政策|行动计划|指导意见|算力网/.test(t)) return '政策';
  if (/融资|IPO|估值|亿元|万美元|红杉|经纬|IDG|高瓴|腾讯投资/.test(t)) return '资本';
  if (/无问芯穹|硅基流动|七牛云|优刻得|UCloud|Baseten|Fireworks|Lightning.*AI|Parasail|竞品|竞争/.test(t)) return '竞品';
  if (/字节跳动.*AI|阿里云.*峰会|阿里云.*千问|字节.*算力|字节.*基础设施/.test(t)) return '竞品';
  if (/软银.*数据中心|SoftBank.*AI|美国|EU|欧盟|参议院|出口管制|chip|export control/.test(t)) return '海外';
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
  console.log('━━━ PPIO 产业政策信息流: Step 1 — Fetch ━━━');
  console.log(`  Date range: ${weekAgoStr()} → ${todayStr()}`);

  const config = loadConfig();
  const queries = buildSearchQueries(config);

  let allItems = [];

  // ── Phase 1: RSS feeds ──────────────────────────────────────────────
  console.log('\n  📡 RSS feeds...');
  const rssFeeds = [
    // 中文社区（有效）
    { url: 'https://36kr.com/feed', source: '36氪' },
    { url: 'https://www.qbitai.com/feed', source: '量子位' },
    // 产业商业化（英文，有效）
    { url: 'https://techcrunch.com/feed/', source: 'TechCrunch' },
    { url: 'https://venturebeat.com/category/ai/feed/', source: 'VentureBeat AI' },
    // 算力/芯片/数据中心（有效）
    { url: 'https://blogs.nvidia.com/feed/', source: 'NVIDIA Blog' },
    { url: 'https://www.thenextplatform.com/feed/', source: 'The Next Platform' },
    { url: 'https://semiengineering.com/feed/', source: 'Semiconductor Engineering' },
    { url: 'https://www.servethehome.com/feed/', source: 'ServeTheHome' },
    // 一手官方（有效）
    { url: 'https://openai.com/news/rss.xml', source: 'OpenAI News' },
    // 研究媒体（有效）
    { url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed', source: 'MIT Tech Review AI' },
    // 中文科技媒体
    { url: 'https://www.ithome.com/rss/', source: 'IT之家' },
  ];

  const rssResults = await Promise.all(rssFeeds.map(f => fetchRSS(f.url, f.source)));
  for (const items of rssResults) allItems.push(...items);

  // ── Phase 1b: Government pages ────────────────────────────
  console.log('\n  🏛️ Gov pages...');
  const govPages = [
    { url: 'https://sheitc.sh.gov.cn/zxgkxx/index.html', source: '上海市经信委' },
    { url: 'https://sheitc.sh.gov.cn/zcfg/index.html', source: '上海市经信委-政策法规' },
    { url: 'https://fgw.sh.gov.cn/index.html', source: '上海市发改委' },
    { url: 'https://www.miit.gov.cn/jgsj/rj司/gzdt/index.html', source: '工信部-软件司' },
    { url: 'https://www.miit.gov.cn/xwfb/index.html', source: '工信部-新闻' },
    { url: 'https://www.shanghai.gov.cn/nw4411/index.html', source: '上海市政府-动态' },
    { url: 'http://www.pdnews.cn/category/keji', source: '浦东新区-科技' },
  ];
  const govResults = await Promise.all(govPages.map(g => scrapeGovList(g.url, g.source)));
  for (const items of govResults) allItems.push(...items);

  // ── Phase 1c: CloakBrowser — anti-bot media sites ──────────────────
  console.log('\n  🕵️ CloakBrowser media pages...');
  const cloakItems = await scrapeWithCloak([
    { url: 'https://www.huxiu.com/channel/103.html', source: '虎嗅', category: '技术' },
    { url: 'https://www.latepost.com/', source: '晚点LatePost', category: '竞品' },
    { url: 'https://www.bis.gov/news-updates', source: 'BIS美国商务部', category: '海外' },
  ]);
  allItems.push(...cloakItems);

  // ── Phase 2: Google News search ─────────────────────────────────────
  console.log('\n  🔍 Google News searches...');

  // Run searches with controlled concurrency (3 at a time)
  const CONCURRENCY = 3;
  for (let i = 0; i < queries.length; i += CONCURRENCY) {
    const batch = queries.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(q => searchGoogleNews(q.q, q.category, q.boost || 0)));
    for (const items of results) allItems.push(...items);
  }

  // ── Phase 3: Filter, score & trim ──────────────────────────────────
  console.log(`\n  📊 Raw total: ${allItems.length} items`);

  // Filter by date (within 7 days)
  allItems = allItems.filter(item => isWithinWeek(item.published));
  console.log(`  Within 7 days: ${allItems.length} items`);

  // Filter out items whose title contains a date older than 7 days
  // e.g. 【早报】2026-02-12 or titles with explicit old dates
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const staleByTitle = allItems.filter(item => {
    const m = item.title.match(/20\d{2}[-\/年](\d{1,2})[-\/月](\d{1,2})/);
    if (!m) return false;
    const titleDate = new Date(item.title.match(/20\d{2}/)[0], parseInt(m[1]) - 1, parseInt(m[2]));
    return titleDate < sevenDaysAgo;
  });
  if (staleByTitle.length) {
    console.log(`  Filtered stale-title items: ${staleByTitle.length} (e.g. ${staleByTitle[0].title.slice(0,40)})`);
    allItems = allItems.filter(item => !staleByTitle.includes(item));
  }

  // Score PPIO relevance first
  allItems.forEach(item => { item._score = scorePPIORelevance(item); });

  // Remove negative-scored items
  const rejected = allItems.filter(i => i._score < 0);
  allItems = allItems.filter(i => i._score >= 0);
  if (rejected.length) console.log(`  Rejected (irrelevant): ${rejected.length} items`);

  // Sort by score before dedup so we keep the best item per topic
  allItems.sort((a, b) => b._score - a._score || b.published.localeCompare(a.published));

  // Deduplicate: topic/entity first (keep highest-scored), then URL, then title
  const entityResult = dedupByEntity(allItems);
  allItems = entityResult.items;
  const entityDups = entityResult.dupCount;
  allItems = dedupByURL(allItems);
  allItems = dedupByTitle(allItems);
  console.log(`  After dedup: ${allItems.length} items (${entityDups} topic/entity duplicates merged)`);

  // Sort by score (desc) then date (desc)
  allItems.sort((a, b) => b._score - a._score || b.published.localeCompare(a.published));

  // ── Cross-day dedup: filter out items already published in recent curated output ──
  const CURATED_PATH = resolve(ROOT, 'data', 'curated-items.json');
  const SEEN_PATH = resolve(ROOT, 'data', 'seen-titles.json');

  // Load previously seen titles (rolling 3-day window)
  let seenTitles = new Set();
  if (existsSync(SEEN_PATH)) {
    try {
      const seenData = JSON.parse(readFileSync(SEEN_PATH, 'utf-8'));
      // Keep only entries from last 2 days
      const cutoff = new Date(Date.now() + 8*3600_000 - 2*86400_000).toISOString().slice(0,10);
      const recent = (seenData.entries || []).filter(e => e.date >= cutoff);
      seenTitles = new Set(recent.map(e => e.key));
    } catch { /* ok */ }
  }

  if (seenTitles.size > 0) {
    const before = allItems.length;
    allItems = allItems.filter(i => {
      const key = i.title.replace(/[\s\-—·]+/g,'').slice(0, 25);
      return !seenTitles.has(key);
    });
    const removed = before - allItems.length;
    if (removed > 0) console.log(`  Cross-day dedup: removed ${removed} items seen in last 3 days`);
  }

  // Trim: hard cap at 15, quality floor at score >= 22, but ensure at least 10 items
  const MIN_SCORE = 22;
  const MAX_RAW = 15;
  const MIN_ITEMS = 10;
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
    // Reserve up to 2 slots for English items that hit en_critical keywords
    const enItems = allItems.filter(i => {
      if (!/[a-z]{4,}/.test(i.title) || /[一-鿿]/.test(i.title)) return false;
      const text = (i.title + ' ' + (i.body_snippet||'')).toLowerCase();
      return PPIO_KEYWORDS.en_critical.some(re => re.test(text));
    });
    const cnItems = allItems.filter(i => /[一-鿿]/.test(i.title));
    const enSlots = Math.min(3, enItems.length);
    const cnSlots = MAX_RAW - enSlots;
    allItems = [...cnItems.slice(0, cnSlots), ...enItems.slice(0, enSlots)];
    allItems.sort((a, b) => b._score - a._score || b.published.localeCompare(a.published));
    if (enSlots > 0) console.log(`  Reserved ${enSlots} slot(s) for English overseas items`);
  }
  allItems.sort((a, b) => b._score - a._score || b.published.localeCompare(a.published));
  console.log(`  Final: ${allItems.length} items`);

  // Guess category for items without one
  allItems.forEach(item => { item.category = guessCategory(item); });

  // ── Phase 4: Fallback ───────────────────────────────────────────────
  let usedMock = false;
  if (allItems.length < 3) {
    // Before falling back to mock, check if existing file has recent live data
    // If existing data is from today or yesterday and was live, preserve it
    if (existsSync(OUT_PATH)) {
      try {
        const existing = JSON.parse(readFileSync(OUT_PATH, 'utf-8'));
        const existingDate = (existing.generated_at || '').slice(0, 10);
        const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        if (existing.fetch_method === 'live' && existingDate >= yesterday) {
          console.warn(`  ⚠ Only ${allItems.length} items from live fetch (network issue?)`);
          console.warn(`  ✓ Preserving existing live data from ${existingDate} — skipping overwrite`);
          return;
        }
      } catch {}
    }
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

  // Update seen-titles rolling cache (3-day window)
  if (!usedMock) {
    const today = todayStr();
    let seenData = { entries: [] };
    if (existsSync(SEEN_PATH)) {
      try { seenData = JSON.parse(readFileSync(SEEN_PATH, 'utf-8')); } catch { /* ok */ }
    }
    // Remove entries older than 3 days
    const cutoff = new Date(Date.now() + 8*3600_000 - 3*86400_000).toISOString().slice(0,10);
    seenData.entries = (seenData.entries || []).filter(e => e.date >= cutoff);
    // Add today's items
    for (const item of allItems) {
      const key = item.title.replace(/[\s\-—·]+/g,'').slice(0, 25);
      if (!seenData.entries.find(e => e.key === key)) {
        seenData.entries.push({ key, date: today });
      }
    }
    writeFileSync(SEEN_PATH, JSON.stringify(seenData, null, 2), 'utf-8');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
