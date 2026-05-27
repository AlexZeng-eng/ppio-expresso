#!/usr/bin/env node
/**
 * PPIO Expresso — Management Server
 * Serves manage.html and provides API to read/write search keywords.
 * Usage: node manage-server.mjs
 */

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3456;
const FETCH_PATH = resolve(__dirname, 'pipeline', '01-fetch.mjs');
const CONFIG_PATH = resolve(__dirname, 'pipeline', 'config.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

// ---- keyword extraction from 01-fetch.mjs ----------------------------------

function parseKeywords() {
  const src = readFileSync(FETCH_PATH, 'utf-8');

  // Extract buildSearchQueries function body
  const fnMatch = src.match(/function buildSearchQueries[\s\S]*?^}/m);
  if (!fnMatch) return [];

  const body = fnMatch[0];
  const queries = [];
  const re = /queries\.push\(\{\s*q:\s*'([^']+)',\s*category:\s*'([^']+)'\s*\}\)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    queries.push({ q: m[1], category: m[2] });
  }
  return queries;
}

function saveKeywords(queries) {
  let src = readFileSync(FETCH_PATH, 'utf-8');

  // Build new function body
  const byCategory = {};
  for (const q of queries) {
    if (!byCategory[q.category]) byCategory[q.category] = [];
    byCategory[q.category].push(q);
  }

  const lines = [];
  for (const [cat, qs] of Object.entries(byCategory)) {
    lines.push(`  // ${cat}`);
    for (const q of qs) {
      lines.push(`  queries.push({ q: '${q.q}', category: '${q.category}' });`);
    }
    lines.push('');
  }

  const newBody = `function buildSearchQueries(config) {\n  const queries = [];\n  // Week-specific keywords\n  const week = \`\${String(weekNumber()).padStart(2, '0')}\`;\n\n${lines.join('\n')}\n  return queries;\n}`;

  // Replace old function
  src = src.replace(/function buildSearchQueries[\s\S]*?^}/m, newBody);
  writeFileSync(FETCH_PATH, src, 'utf-8');
}

// ---- HTTP server -----------------------------------------------------------

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function serveFile(res, filePath) {
  if (!existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
  const ext = extname(filePath);
  const mime = MIME[ext] || 'text/plain';
  res.writeHead(200, { 'Content-Type': mime });
  res.end(readFileSync(filePath));
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end(); return;
  }

  // API routes
  if (path === '/api/keywords' && req.method === 'GET') {
    json(res, { keywords: parseKeywords() });
    return;
  }

  if (path === '/api/keywords' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { keywords } = JSON.parse(body);
        saveKeywords(keywords);
        json(res, { ok: true, count: keywords.length });
      } catch (e) {
        json(res, { ok: false, error: e.message }, 400);
      }
    });
    return;
  }

  if (path === '/api/config' && req.method === 'GET') {
    json(res, JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')));
    return;
  }

  // Static files
  if (path === '/' || path === '/manage.html') {
    serveFile(res, resolve(__dirname, 'manage.html')); return;
  }
  if (path === '/reader.css') {
    serveFile(res, resolve(__dirname, 'reader.css')); return;
  }
  if (path.startsWith('/assets/')) {
    serveFile(res, resolve(__dirname, path.slice(1))); return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  PPIO Expresso — Management Server`);
  console.log(`  http://localhost:${PORT}/manage.html\n`);
  console.log('  Ctrl+C to stop\n');
});
