#!/usr/bin/env node

/**
 * PPIO 产业政策信息流 — Step 2: Curate
 * Runs each raw news item through the PPIO signal detection system.
 * Routes items into lane:attend or lane:silent. lane:skip items are dropped.
 *
 * Uses DeepSeek V4 Pro (OpenAI-compatible API) to classify items.
 * Falls back to rule-based classification if API is unavailable.
 *
 * Input:  data/raw-items.json + pipeline/config.json
 * Output: data/curated-items.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CONFIG_PATH = resolve(ROOT, 'pipeline', 'config.json');
const IN_PATH = resolve(ROOT, 'data', 'raw-items.json');
const OUT_PATH = resolve(ROOT, 'data', 'curated-items.json');

// ---- DeepSeek API config ---------------------------------------------------

const DEEPSEEK_API_KEY = process.env.PPIO_DEEPSEEK_API_KEY || '';
const DEEPSEEK_BASE_URL = process.env.PPIO_DEEPSEEK_BASE_URL || 'https://apiproxy.paigod.work/v1';
// Model name in the proxy: claude-deepseek/deepseek-v4-pro
const DEEPSEEK_MODEL = process.env.PPIO_DEEPSEEK_MODEL || 'deepseek/deepseek-v4-pro';

// ---- helpers ---------------------------------------------------------------

function loadJSON(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

async function callDeepSeek(messages, { maxTokens = 1024, temperature = 0.3 } = {}) {
  if (!DEEPSEEK_API_KEY) {
    throw new Error('PPIO_DEEPSEEK_API_KEY not set');
  }
  const resp = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages,
      max_tokens: maxTokens,
      temperature
    })
  });
  if (!resp.ok) {
    throw new Error(`DeepSeek API error ${resp.status}: ${await resp.text()}`);
  }
  const data = await resp.json();
  return data.choices[0].message.content;
}

// ---- signal detection prompts ----------------------------------------------

function buildSystemPrompt(config) {
  const charter = config.charter;
  const signals = charter.signal_tags;
  const compass = charter.compass_questions;
  const routing = charter.routing;

  const signalList = Object.entries(signals)
    .map(([id, s]) => `${s.emoji} ${s.label}: ${s.trigger}`)
    .join('\n');

  const compassList = Object.entries(compass)
    .map(([id, c]) => `${id}: ${c.question}`)
    .join('\n');

  return `你是 PPIO 产业政策信息流 信息策展人。PPIO 是一家边缘云分布式算力平台公司，正在准备香港 IPO。

你的任务是：阅读下面每条新闻，判断它是否触发 PPIO 信号标签，并路由到正确的处理车道。

## PPIO 关注焦点 (Compass Questions)
${compassList}

## 信号标签体系
${signalList}

## 三车道路由规则
- lane:attend = 触发 🏛️📜⚔️ 任一 → 深度处理（完整摘要 + PPIO信号速读）
- lane:silent = 触发 💰🌏🔬 任一但未触发 attend 信号 → 感知处理（一句话摘要）
- lane:skip = 无信号触发 → 不入库

例外：
- 国常会/中央/部委级政策全部 lane:attend
- 习近平/李强/政治局常委调研或讲话涉及AI/算力，全部 lane:attend，is_deep_read:true
- 无问芯穹及 AI Infra 主要竞品全部 lane:attend
- 纯小额融资（<1亿元）降级为 lane:silent

## 深度阅读判定
- 深度阅读：政策原文、竞品深度分析、行业研究报告、海外监管原文、技术架构深度
- 快讯：纯融资事件、产品发布、人事变动

## 输出格式（JSON，严格遵循）
对每条新闻返回：
{
  "id": "raw-xxx",
  "lane": "attend" | "silent" | "skip",
  "signals": ["🏛️"],           // 触发的信号 emoji 列表
  "category": "政策",           // 内容分类，必须从以下枚举中选一个：政策|竞品|监管|资本|海外|技术|治理
  "is_deep_read": true,        // 是否深度阅读
  "compass_triggered": ["c1"], // 触发的 Compass Question
  "summary_cn": "...",         // lane:attend 250-300字，分两段：①事件本身 ②对PPIO的具体影响（结合边缘云/分布式算力/港股IPO背景）；lane:silent ≤80字
  "ppio_signal": {             // 仅 lane:attend
    "positive": "...",
    "risk": "..."
  }
}

重要：ppio_signal 仅在 lane:attend 时填写。lane:silent 时 ppio_signal 为 null。
注意：如果内容是早报/晚报/日报汇编形式（标题含【早报】【晚报】等），或正文明显是旧日期内容的转发，直接 lane:skip。`;
}

function buildItemPrompt(item) {
  const isEnglish = /[a-z]{4,}/.test(item.title) && !/[一-鿿]/.test(item.title);
  const langNote = isEnglish ? '\n注意：这是英文内容，summary_cn 必须用中文撰写，不要直译标题，要提炼核心信息。' : '';
  return `请分析以下新闻：${langNote}
---
标题: ${item.title}
来源: ${item.source}
分类(初始): ${item.category}
发布时间: ${item.published}
内容: ${item.body_snippet}
---
返回 JSON（不要 markdown 代码块，直接返回 JSON 对象）。`;
}

// ---- category normalization ------------------------------------------------

const VALID_CATEGORIES = ['政策', '竞品', '监管', '资本', '海外', '技术', '治理'];

function normalizeCategory(cat) {
  if (!cat) return '政策';
  if (VALID_CATEGORIES.includes(cat)) return cat;
  // Fuzzy map common AI variants
  if (/竞品|竞争|对手|competitor/i.test(cat)) return '竞品';
  if (/监管|合规|审查|备案|牌照/i.test(cat)) return '监管';
  if (/资本|融资|IPO|上市|估值/i.test(cat)) return '资本';
  if (/海外|国际|美国|欧盟|overseas/i.test(cat)) return '海外';
  if (/技术|算力|模型|推理|架构/i.test(cat)) return '技术';
  if (/治理|伦理|安全|governance/i.test(cat)) return '治理';
  if (/政策|政府|部委|国务院|发改委|工信部/i.test(cat)) return '政策';
  return '政策'; // default
}

// ---- rule-based fallback ---------------------------------------------------

function ruleBasedClassify(item, config) {
  const title = item.title + ' ' + (item.body_snippet || '');
  const category = item.category || '';
  const signals = [];
  const compasses = [];

  // Keyword-based signal detection
  const rules = [
    { regex: /国常会|国务院|中央|部委|立法|指导意见|行动计划/, signal: '🏛️', compass: 'c1' },
    { regex: /AI.*法|安全审查|牌照|CSRC|VIE|备案|合规/, signal: '📜', compass: 'c1' },
    { regex: /无问芯穹|融资.*亿|红杉|投后估值|智能体.*平台/, signal: '⚔️', compass: 'c2' },
    { regex: /融资|IPO|SPAC|估值|上市/, signal: '💰', compass: 'c2' },
    { regex: /美国.*AI|参议院|欧盟.*AI|EU.*Act|出口管制/, signal: '🌏', compass: 'c3' },
    { regex: /算力|推理|Agent.*harness|模型.*突破|架构.*创新/, signal: '🔬', compass: 'c3' },
  ];

  for (const rule of rules) {
    if (rule.regex.test(title) && !signals.includes(rule.signal)) {
      signals.push(rule.signal);
    }
    if (!compasses.includes(rule.compass)) {
      compasses.push(rule.compass);
    }
  }

  // Routing
  const attendTriggers = config.charter.routing.attend_signals;
  const silentTriggers = config.charter.routing.silent_signals;
  const isAttend = signals.some(s => attendTriggers.includes(s));
  const isSilent = signals.some(s => silentTriggers.includes(s));

  let lane = 'skip';
  if (isAttend) lane = 'attend';
  else if (isSilent) lane = 'silent';

  // Exceptions
  if (/国常会|国务院常务会议|国务院.*AI|国务院.*算力/.test(title)) lane = 'attend';
  if (/习近平.*人工智能|习近平.*算力|习近平.*数字经济/.test(title)) lane = 'attend';
  if (/李强.*人工智能|李强.*算力|总理.*算力/.test(title)) lane = 'attend';
  if (/政治局.*人工智能|政治局.*算力|政治局常委.*AI/.test(title)) lane = 'attend';
  if (/无问芯穹|AI.*Infra/.test(title)) lane = 'attend';

  const isDeep = /政策原文|国务院|国常会|立法|招股书|深度分析|研究报告/.test(title);

  return {
    lane,
    signals: signals.length ? signals : ['—'],
    category: normalizeCategory(category),
    is_deep_read: isDeep,
    compass_triggered: compasses.length ? compasses : ['c1'],
    summary_cn: lane === 'attend'
      ? title.replace(/^.+?[：:]/,'').slice(0, 300)
      : title.slice(0, 80),
    ppio_signal: lane === 'attend' ? {
      positive: '（待 AI 填写）',
      risk: '（待 AI 填写）'
    } : null,
    _classified_by: 'rule'
  };
}

// ---- main ------------------------------------------------------------------

async function main() {
  console.log('━━━ PPIO 产业政策信息流: Step 2 — Curate ━━━');

  const config = loadJSON(CONFIG_PATH);
  const raw = loadJSON(IN_PATH);
  const items = raw.items || [];

  console.log(`  Input: ${items.length} raw items`);

  // Try DeepSeek API first, fall back to rule-based
  let useAI = false;
  if (DEEPSEEK_API_KEY) {
    try {
      console.log('  Using DeepSeek V4 Pro for signal classification...');

      // Batch items in groups of 5 to keep prompts manageable
      const curated = [];
      const batchSize = 5;

      for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        const batchPrompt = batch.map(item => buildItemPrompt(item)).join('\n---\n');
        const systemPrompt = buildSystemPrompt(config);

        const result = await callDeepSeek([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `请分析以下 ${batch.length} 条新闻，对每条返回一个 JSON 对象（放在数组中）：\n\n${batchPrompt}\n\n返回 JSON 数组，不要 markdown 代码块。` }
        ], { maxTokens: 4096, temperature: 0.3 });

        // Parse the AI response — it should be a JSON array
        let parsed;
        try {
          // Strip potential markdown fences
          const cleaned = result.replace(/```json\s*|```\s*/g, '').trim();
          parsed = JSON.parse(cleaned);
        } catch {
          console.warn(`  ⚠ Failed to parse AI response for batch ${i}, falling back to rules`);
          parsed = batch.map(item => ruleBasedClassify(item, config));
        }

        // Merge with original item data, normalize category
        const enriched = batch.map((item, idx) => {
          const cls = parsed[idx] || ruleBasedClassify(item, config);
          return { ...item, ...cls, category: normalizeCategory(cls.category) };
        });

        curated.push(...enriched);
        console.log(`    Batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(items.length/batchSize)} complete`);
      }

      useAI = true;
      console.log(`  ✓ AI-classified ${curated.length} items`);

      // Filter out lane:skip items
      const filtered = curated.filter(item => item.lane !== 'skip');
      console.log(`  After filtering: ${filtered.length} items (${filtered.filter(i => i.lane === 'attend').length} attend, ${filtered.filter(i => i.lane === 'silent').length} silent)`);

      const output = {
        generated_at: new Date().toISOString(),
        week: raw.week,
        classifier: 'deepseek-v4-pro',
        total_raw: items.length,
        total_curated: filtered.length,
        attend_count: filtered.filter(i => i.lane === 'attend').length,
        silent_count: filtered.filter(i => i.lane === 'silent').length,
        items: filtered
      };

      writeFileSync(OUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
      console.log(`  ✓ Wrote → ${OUT_PATH}`);
      return;
    } catch (err) {
      console.warn(`  ⚠ DeepSeek API unavailable (${err.message}), using rule-based fallback`);
    }
  } else {
    console.log('  No API key set, using rule-based classification');
  }

  // Rule-based fallback
  const curated = items
    .map(item => ({ ...item, ...ruleBasedClassify(item, config) }))
    .filter(item => item.lane !== 'skip');

  const output = {
    generated_at: new Date().toISOString(),
    week: raw.week,
    classifier: 'rule-based',
    total_raw: items.length,
    total_curated: curated.length,
    attend_count: curated.filter(i => i.lane === 'attend').length,
    silent_count: curated.filter(i => i.lane === 'silent').length,
    items: curated
  };

  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`  ✓ Wrote ${curated.length} curated items → ${OUT_PATH}`);
  console.log(`    attend: ${output.attend_count}, silent: ${output.silent_count}`);
}

main().catch(err => { console.error(err); process.exit(1); });

