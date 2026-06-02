#!/usr/bin/env node

/**
 * PPIO 产业政策信息流 — Step 3: Synthesize
 * Takes curated items and generates the weekly PPIO Signal Speed-Read.
 * Produces the two-signal analysis (利好/风险).
 *
 * Uses DeepSeek V4 Pro. Falls back to template if API unavailable.
 *
 * Input:  data/curated-items.json + pipeline/config.json
 * Output: data/weekly-synthesis.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CONFIG_PATH = resolve(ROOT, 'pipeline', 'config.json');
const IN_PATH = resolve(ROOT, 'data', 'curated-items.json');
const OUT_PATH = resolve(ROOT, 'data', 'weekly-synthesis.json');

const DEEPSEEK_API_KEY = process.env.PPIO_DEEPSEEK_API_KEY || '';
const DEEPSEEK_BASE_URL = process.env.PPIO_DEEPSEEK_BASE_URL || 'https://apiproxy.paigod.work/v1';
const DEEPSEEK_MODEL = process.env.PPIO_DEEPSEEK_MODEL || 'deepseek/deepseek-v4-pro';

function loadJSON(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

async function callDeepSeek(messages, opts = {}) {
  const resp = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages,
      max_tokens: opts.maxTokens || 2048,
      temperature: opts.temperature || 0.5
    })
  });
  if (!resp.ok) throw new Error(`DeepSeek API error ${resp.status}`);
  const data = await resp.json();
  return data.choices[0].message.content;
}

function buildSynthesisPrompt(config, curated) {
  const attend = curated.items.filter(i => i.lane === 'attend');
  const silent = curated.items.filter(i => i.lane === 'silent');

  const itemSummary = attend.map((i, idx) =>
    `${idx + 1}. [${i.category}] ${i.title}\n   信号: ${(i.signals||[]).join(' ')} | ${(i.summary_cn||'').slice(0, 80)}`
  ).join('\n');

  const silentSummary = silent.map((i, idx) =>
    `${idx + 1}. [${i.category}] ${i.title.slice(0, 60)}`
  ).join('\n');

  const compass = config.charter.compass_questions;
  const signals = config.charter.signal_tags;

  return `你是 PPIO 产业政策信息流 周报主编。PPIO 是一家边缘云分布式算力平台公司，正在准备香港 IPO。

请根据以下本周精选新闻，撰写 PPIO 信号速读。

## PPIO 关注焦点
- C1: ${compass.c1.question} — ${compass.c1.detail}
- C2: ${compass.c2.question} — ${compass.c2.detail}
- C3: ${compass.c3.question} — ${compass.c3.detail}

## 本周深度处理新闻 (lane:attend, ${attend.length}条)
${itemSummary}

## 本周感知新闻 (lane:silent, ${silent.length}条)
${silentSummary || '（无）'}

## 输出格式（严格 JSON）
{
  "mainline": "本周主线：一句话概括本周最重要的一到两个信号",
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
    "summary": "一句话说明本周整体风向"
  },
  "competitor_updates": ["需要更新的竞品档案条目"],
  "item_axes": [
    {
      "id": "raw-001",
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
    "interpretation": "一句话解读本周指数变化"
  }
}

重要规则：
- mainline ≤ 80 字，点出本周对 PPIO 最重要的变化
- 每个信号至少 1 条，最多 3 条
- 如有习近平/李强/国常会涉及AI/算力的内容，必须在 positive 或 risk 中单独列出，注明"高层信号"
- wind_indicators 各 heat 值为 1-5 整数（1=冷淡 3=活跃 5=高热）
- overall_sentiment 从以下选一个：升温 / 活跃 / 平稳 / 降温 / 观望
- item_axes：对每条 lane:attend 新闻打坐标分
  - policy_axis: -1.0（政策/监管收紧）→ +1.0（政策宽松/利好）
  - competition_axis: -1.0（低竞争压力）→ +1.0（高竞争威胁）
  - impact_score: 1-5 整数，对 PPIO 的重要程度
  - id 必须与输入的新闻编号对应（1→"1", 2→"2"等，按上面列表顺序）
- ppio_index：PPIO战略环境综合指数
  - score: 0-100 整数（50=中性，>50=有利，<50=不利）
  - delta: 与上周相比的变化（正=改善，负=恶化，首次输出填0）
  - components 各项为该因子对总分的贡献值（正负均可，绝对值之和≈100）
  - interpretation ≤ 40 字
- 直接返回 JSON，不要 markdown 代码块`;
}

async function main() {
  console.log('━━━ PPIO 产业政策信息流: Step 3 — Synthesize ━━━');

  const config = loadJSON(CONFIG_PATH);
  const curated = loadJSON(IN_PATH);

  console.log(`  Input: ${curated.total_curated} items (${curated.attend_count} attend)`);

  let synthesis;

  if (DEEPSEEK_API_KEY) {
    try {
      console.log('  Using DeepSeek V4 Pro for weekly synthesis...');
      const prompt = buildSynthesisPrompt(config, curated);
      const result = await callDeepSeek([
        { role: 'user', content: prompt }
      ], { maxTokens: 4096, temperature: 0.5 });

      const cleaned = result.replace(/```json\s*|```\s*/g, '').trim();
      // Extract JSON object even if there's trailing garbage
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON object found in response');
      synthesis = JSON.parse(jsonMatch[0]);
      synthesis._generated_by = 'deepseek-v4-pro';
      console.log('  ✓ AI synthesis complete');
    } catch (err) {
      console.warn(`  ⚠ DeepSeek API error (${err.message}), using template`);
    }
  }

  // Fallback template
  if (!synthesis) {
    const attend = curated.items.filter(i => i.lane === 'attend');
    const signalCounts = { '🏛️': 0, '📜': 0, '⚔️': 0, '💰': 0, '🌏': 0, '🔬': 0 };
    curated.items.forEach(item => {
      (item.signals || []).forEach(s => {
        if (signalCounts.hasOwnProperty(s)) signalCounts[s]++;
      });
    });

    synthesis = {
      mainline: '本周算力网国家战略+智能体产业化双政策落地，为PPIO提供IPO叙事支撑；无问芯穹融资与AI立法加速构成竞争与合规双重压力。',
      signal_summary: signalCounts,
      speed_read: {
        positive: [
          '国常会算力网+基础研究座谈会→"适度超前部署"为PPIO产能扩张叙事提供国家级背书',
          '三部门智能体实施意见→Sandbox产品直接受益',
          '美国AI管制升级→自主可控算力叙事强化'
        ],
        risk: [
          '无问芯穹7亿融资+「企业级智能体服务平台」定位→与Sandbox正面重叠',
          'AI综合性立法进入预备审议→VIE备案不确定性叠加',
          '美国AI安全审查机制→若管制扩至云服务，海外事业部跨境算力服务可能受波及'
        ]
      },
      wind_indicators: {
        policy_heat: 3,
        competitor_heat: 2,
        capital_heat: 2,
        overseas_heat: 2,
        overall_sentiment: '平稳',
        summary: '政策面保持活跃，竞品与资本动态平稳，海外监管持续关注中。'
      },
      competitor_updates: [
        '无问芯穹：更新融资信息(7亿元/45亿估值)、新定位(企业级智能体服务平台)、竞品重叠分析'
      ],
      item_axes: curated.items.filter(i => i.lane === 'attend').map((item, idx) => {
        // Rule-based axis estimation for fallback
        const t = item.title + ' ' + (item.summary_cn || '');
        const isPolicy = /国常会|国务院|发改委|工信部|习近平|政治局/.test(t);
        const isCompetitor = /竞品|融资|无问芯穹|字节|阿里云|CDN|运营商/.test(t);
        const isRegulatory = /监管|立法|备案|合规|出口管制|VIE/.test(t);
        const policy_axis = isPolicy ? 0.6 : isRegulatory ? -0.5 : 0.0;
        const competition_axis = isCompetitor ? 0.7 : 0.1;
        return {
          id: String(idx + 1),
          title: item.title.slice(0, 40),
          policy_axis,
          competition_axis,
          impact_score: isPolicy ? 4 : isCompetitor ? 3 : 2,
          axis_reason: '（规则估算，仅供参考）'
        };
      }),
      ppio_index: {
        score: 58,
        delta: 0,
        components: {
          policy_tailwind: 25,
          competitive_pressure: -15,
          capital_sentiment: 10,
          regulatory_risk: -8,
          overseas_headwind: -5
        },
        interpretation: '政策利好与竞争压力并存，整体环境中性偏正'
      },
      _generated_by: 'template'
    };
  }

  const output = {
    generated_at: new Date().toISOString(),
    week: curated.week,
    ...synthesis
  };

  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`  ✓ Wrote weekly synthesis → ${OUT_PATH}`);
  console.log(`  Mainline: ${synthesis.mainline.slice(0, 60)}...`);
}

main().catch(err => { console.error(err); process.exit(1); });

