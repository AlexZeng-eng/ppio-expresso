#!/usr/bin/env node

/**
 * PPIO 产业政策信息流 — Step 3: Synthesize
 * Takes curated items and generates the daily PPIO Signal Speed-Read.
 *
 * Uses DeepSeek V4 Pro. Falls back to rule-based template if API unavailable.
 *
 * Input:  data/curated-items.json + pipeline/config.json
 * Output: data/daily-synthesis.json
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CONFIG_PATH = resolve(ROOT, 'pipeline', 'config.json');
const IN_PATH = resolve(ROOT, 'data', 'curated-items.json');
const OUT_PATH = resolve(ROOT, 'data', 'daily-synthesis.json');
// Keep legacy path in sync for backwards compat with any external readers
const LEGACY_PATH = resolve(ROOT, 'data', 'weekly-synthesis.json');

const DEEPSEEK_API_KEY = process.env.PPIO_DEEPSEEK_API_KEY || '';
const DEEPSEEK_BASE_URL = process.env.PPIO_DEEPSEEK_BASE_URL || 'https://apiproxy.paigod.work/v1';
const DEEPSEEK_MODEL = process.env.PPIO_DEEPSEEK_MODEL || 'deepseek/deepseek-v4-pro';
const BACKUP_MODELS = (process.env.PPIO_BACKUP_MODELS || 'deepseek/deepseek-chat,claude-sonnet-4-6,claude-opus-4-8')
  .split(',').map(s => s.trim()).filter(Boolean);

function loadJSON(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

async function callLLM(messages, opts = {}) {
  if (!DEEPSEEK_API_KEY) throw new Error('PPIO_DEEPSEEK_API_KEY not set');
  const models = [DEEPSEEK_MODEL, ...BACKUP_MODELS];
  let lastError;
  const tried = [];

  for (const model of models) {
    try {
      const resp = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify({ model, messages, max_tokens: opts.maxTokens || 4096, temperature: opts.temperature || 0.5 })
      });
      if (!resp.ok) {
        console.warn(`    ⚠ ${model}: HTTP ${resp.status} — 尝试下一个模型`);
        tried.push(`${model}(HTTP${resp.status})`);
        continue;
      }
      const data = await resp.json();
      console.log(`    ✓ 模型: ${model}`);
      return data.choices[0].message.content;
    } catch (err) {
      console.warn(`    ⚠ ${model}: ${err.message.slice(0,60)} — 尝试下一个模型`);
      tried.push(`${model}(${err.message.slice(0,30)})`);
      lastError = err;
    }
  }
  throw lastError || new Error(`所有模型不可用: ${tried.join(', ')}`);
}

// Load previous day's ppio_index score for delta calculation
function loadPrevScore() {
  try {
    if (existsSync(OUT_PATH)) {
      const prev = loadJSON(OUT_PATH);
      return prev.ppio_index?.score ?? null;
    }
  } catch { /* ok */ }
  return null;
}

function buildSynthesisPrompt(config, curated, prevScore) {
  const attend = curated.items.filter(i => i.lane === 'attend');
  const silent = curated.items.filter(i => i.lane === 'silent');
  const today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });

  const itemSummary = attend.map((i, idx) =>
    `${idx + 1}. [${i.category}] ${i.title}\n   信号: ${(i.signals||[]).join(' ')} | ${(i.summary_cn||'').slice(0, 100)}`
  ).join('\n');

  const silentSummary = silent.map((i, idx) =>
    `${idx + 1}. [${i.category}] ${i.title.slice(0, 60)}`
  ).join('\n');

  const compass = config.charter.compass_questions;

  return `你是 PPIO 产业政策信息流 日报主编。PPIO 是一家边缘云分布式算力平台公司，正在准备香港 IPO。今天是 ${today}。

请根据以下今日精选新闻，撰写 PPIO 日报信号速读。

## PPIO 关注焦点
- C1: ${compass.c1.question} — ${compass.c1.detail}
- C2: ${compass.c2.question} — ${compass.c2.detail}
- C3: ${compass.c3.question} — ${compass.c3.detail}

## 今日深度处理新闻 (lane:attend, ${attend.length}条)
${itemSummary || '（今日无深度处理新闻）'}

## 今日感知新闻 (lane:silent, ${silent.length}条)
${silentSummary || '（无）'}

${prevScore !== null ? `## 昨日 PPIO 指数：${prevScore}` : ''}

## 输出格式（严格 JSON）
{
  "mainline": "今日主线：一句话概括今日最重要的一到两个信号",
  "signal_summary": {
    "🏛️": 0, "📜": 0, "⚔️": 0, "💰": 0, "🌏": 0, "🔬": 0
  },
  "speed_read": {
    "positive": ["利好信号1", "利好信号2"],
    "risk": ["风险信号1", "风险信号2"]
  },
  "wind_indicators": {
    "policy_heat": 3,
    "competitor_heat": 2,
    "capital_heat": 1,
    "overseas_heat": 2,
    "overall_sentiment": "升温",
    "summary": "一句话说明今日整体风向"
  },
  "competitor_updates": ["需要更新的竞品档案条目"],
  "item_axes": [
    {
      "id": "1",
      "title": "标题前20字",
      "policy_axis": 0.6,
      "competition_axis": 0.3,
      "impact_score": 4,
      "axis_reason": "一句话说明打分逻辑"
    }
  ],
  "ppio_index": {
    "score": 62,
    "delta": 5,
    "components": {
      "policy_tailwind": 35,
      "competitive_pressure": -18,
      "capital_sentiment": 12,
      "regulatory_risk": -8,
      "overseas_headwind": -5
    },
    "interpretation": "一句话解读今日指数变化"
  },
  "policy_momentum": [
    {
      "thread": "算力立法",
      "last_signal": "司法部征求意见",
      "this_signal": "国常会讨论",
      "level_delta": "升级",
      "interpretation": "从部委层面升至国务院讨论，推进节奏明显加快，立法落地概率上升"
    }
  ],
  "expected_but_absent": ["预期本周应出现但未见的信号，如无则填空数组"]
}

重要规则：
- mainline ≤ 80 字，点出今日对 PPIO 最重要的变化
- speed_read 每类至少 1 条，最多 3 条；今日无新闻则填"今日无重大信号"
- 如有习近平/李强/国常会涉及AI/算力的内容，必须在 positive 单独列出，注明"高层信号"
- wind_indicators 各 heat 值为 1-5 整数（1=冷淡 3=活跃 5=高热）
- overall_sentiment 从以下选一个：升温 / 活跃 / 平稳 / 降温 / 观望
- item_axes：仅对 lane:attend 新闻打坐标，按上面编号顺序
  - policy_axis: -1.0（收紧）→ +1.0（宽松/利好）
  - competition_axis: -1.0（低竞争）→ +1.0（高竞争威胁）
  - impact_score: 1-5 整数
- ppio_index.score: 0-100（50=中性，>50=有利）
- ppio_index.delta: 与昨日相比变化（昨日分数 ${prevScore ?? '未知'}，无历史则填0）
- components 各项绝对值之和 ≈ 100
- policy_momentum: 追踪今日新闻中政策信号的纵向演进，每条主线一个对象
  - thread: 政策主线名称（如"算力立法"、"算力补贴"、"VIE备案"）
  - last_signal: 上一阶段信号（可从标题/摘要推断，或填"未知"）
  - this_signal: 今日信号级别（如"国常会讨论"、"部委印发"、"地方跟进"）
  - level_delta: 信号变化方向 — 升级 / 持平 / 降温 / 首现
  - interpretation: ≤30字，说明这条演进对PPIO意味着什么
  - 今日无明确政策演进信号则返回空数组 []
- expected_but_absent: 预期本周应出现但今日未见的信号（如"人工智能法草案征求意见稿"）；无则返回 []
- 直接返回 JSON，不要 markdown 代码块`;
}

function buildFallback(curated) {
  const attend = curated.items.filter(i => i.lane === 'attend');
  const signalCounts = { '🏛️': 0, '📜': 0, '⚔️': 0, '💰': 0, '🌏': 0, '🔬': 0 };
  curated.items.forEach(item => {
    (item.signals || []).forEach(s => {
      if (Object.prototype.hasOwnProperty.call(signalCounts, s)) signalCounts[s]++;
    });
  });

  return {
    mainline: '今日政策与竞争信号持续跟踪中，详情见各条目分析。',
    signal_summary: signalCounts,
    speed_read: {
      positive: attend
        .filter(i => i.ppio_signal?.positive && !i.ppio_signal.positive.includes('待 AI'))
        .map(i => i.ppio_signal.positive).slice(0, 3),
      risk: attend
        .filter(i => i.ppio_signal?.risk && !i.ppio_signal.risk.includes('待 AI'))
        .map(i => i.ppio_signal.risk).slice(0, 3)
    },
    wind_indicators: {
      policy_heat: signalCounts['🏛️'] >= 2 ? 4 : signalCounts['🏛️'] >= 1 ? 3 : 2,
      competitor_heat: signalCounts['⚔️'] >= 2 ? 4 : signalCounts['⚔️'] >= 1 ? 3 : 2,
      capital_heat: signalCounts['💰'] >= 1 ? 3 : 2,
      overseas_heat: signalCounts['🌏'] >= 1 ? 3 : 2,
      overall_sentiment: '平稳',
      summary: '规则估算，AI合成不可用时的占位数据。'
    },
    competitor_updates: [],
    item_axes: attend.map((item, idx) => {
      const t = item.title + ' ' + (item.summary_cn || '');
      const isPolicy = /国常会|国务院|发改委|工信部|习近平|政治局/.test(t);
      const isCompetitor = /竞品|融资|无问芯穹|字节|阿里云|CDN|运营商/.test(t);
      const isRegulatory = /监管|立法|备案|合规|出口管制|VIE/.test(t);
      return {
        id: String(idx + 1),
        title: item.title.slice(0, 20),
        policy_axis: isPolicy ? 0.6 : isRegulatory ? -0.5 : 0.0,
        competition_axis: isCompetitor ? 0.7 : 0.1,
        impact_score: isPolicy ? 4 : isCompetitor ? 3 : 2,
        axis_reason: '规则估算'
      };
    }),
    ppio_index: {
      score: 55,
      delta: 0,
      components: {
        policy_tailwind: signalCounts['🏛️'] * 8,
        competitive_pressure: -(signalCounts['⚔️'] * 6),
        capital_sentiment: signalCounts['💰'] * 5,
        regulatory_risk: -(signalCounts['📜'] * 5),
        overseas_headwind: -(signalCounts['🌏'] * 4)
      },
      interpretation: '规则估算，仅供参考'
    },
    policy_momentum: [],
    expected_but_absent: [],
    _generated_by: 'template'
  };
}

async function main() {
  console.log('━━━ PPIO 产业政策信息流: Step 3 — Synthesize ━━━');

  const config = loadJSON(CONFIG_PATH);
  const curated = loadJSON(IN_PATH);
  const prevScore = loadPrevScore();

  console.log(`  Input: ${curated.total_curated} items (${curated.attend_count} attend)`);

  let synthesis;

  if (DEEPSEEK_API_KEY) {
    try {
      console.log('  Using AI for daily synthesis...');
      const prompt = buildSynthesisPrompt(config, curated, prevScore);
      const result = await callLLM([
        { role: 'user', content: prompt }
      ], { maxTokens: 4096, temperature: 0.4 });

      const cleaned = result.replace(/```json\s*|```\s*/g, '').trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON object found in response');
      synthesis = JSON.parse(jsonMatch[0]);
      synthesis._generated_by = 'deepseek-v4-pro';
      console.log('  ✓ AI synthesis complete');
    } catch (err) {
      console.warn(`  ⚠ DeepSeek API error (${err.message}), using template`);
    }
  }

  if (!synthesis) synthesis = buildFallback(curated);

  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const output = {
    generated_at: new Date().toISOString(),
    date: today,
    date_label: today,
    ...synthesis
  };

  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
  // Keep legacy file in sync
  writeFileSync(LEGACY_PATH, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`  ✓ Wrote daily synthesis → ${OUT_PATH}`);
  console.log(`  Mainline: ${synthesis.mainline.slice(0, 60)}...`);
}

main().catch(err => { console.error(err); process.exit(1); });
