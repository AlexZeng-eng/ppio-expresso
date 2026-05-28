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
  "competitor_updates": ["需要更新的竞品档案条目"]
}

重要规则：
- mainline ≤ 80 字，点出本周对 PPIO 最重要的变化
- 每个信号至少 1 条，最多 3 条
- 如有习近平/李强/国常会涉及AI/算力的内容，必须在 positive 或 risk 中单独列出，注明"高层信号"
- wind_indicators 各 heat 值为 1-5 整数（1=冷淡 3=活跃 5=高热）
- overall_sentiment 从以下选一个：升温 / 活跃 / 平稳 / 降温 / 观望
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
      ], { maxTokens: 2048, temperature: 0.5 });

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

