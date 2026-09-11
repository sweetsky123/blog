#!/usr/bin/env node
/**
 * themes/butterfly/plugins.yml 依赖检测与更新脚本
 *
 * 用法:
 *   node plugins-update.js check            输出 JSON 数组：所有落后于 npm latest 的包
 *   node plugins-update.js apply <name> <version>
 *                                           将 plugins.yml 中 name 包的所有 version 改为指定版本
 */
const fs = require('fs');
const path = require('path');

const PLUGINS_FILE = path.join(__dirname, '..', '..', 'themes', 'butterfly', 'plugins.yml');
const REGISTRY = process.env.NPM_REGISTRY || 'https://registry.npmjs.org';
const JSDELIVR = process.env.JSDELIVR || 'https://cdn.jsdelivr.net/npm';
// 每个包最多尝试的候选版本数（latest 不通过时由高到低回退）
const MAX_CANDIDATES = Number(process.env.MAX_CANDIDATES || 5);
// 并发探测文件存在性的上限
const CONCURRENCY = Number(process.env.CHECK_CONCURRENCY || 8);

function parse(content) {
  const plugins = [];
  let current = null;
  for (const line of content.split(/\r?\n/)) {
    const keyMatch = line.match(/^([A-Za-z0-9_]+):\s*$/);
    const propMatch = line.match(/^ {2}([A-Za-z0-9_]+):\s*(.*)$/);
    if (keyMatch) {
      current = { key: keyMatch[1] };
      plugins.push(current);
    } else if (propMatch && current) {
      current[propMatch[1]] = propMatch[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return plugins.filter((p) => p.name && p.version);
}

function compareVersions(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function parseRepoUrl(url) {
  if (!url) return null;
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.#]+)/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

// 与主题 scripts/events/cdn.js 的 minFile() 一致：
// custom_format 使用 ${min_file}，非 .min 结尾的 js/css 会自动加 .min
function toMinFile(file) {
  return file.replace(/(?<!\.min)\.(js|css)$/g, '.min.$1');
}

function isPrerelease(version) {
  return /[-+]/.test(version);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// 查询 npm 元数据（一次拿全：dist-tags、版本列表、repository）
async function fetchPackageMeta(name) {
  const url = `${REGISTRY}/${name.replace('/', '%2f')}`;
  const res = await fetchWithTimeout(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`查询 ${name} 失败: HTTP ${res.status}`);
  const data = await res.json();
  if (!data['dist-tags'] || !data['dist-tags'].latest) {
    throw new Error(`查询 ${name} 失败: 响应中没有 dist-tags.latest`);
  }
  const repo = data.repository && parseRepoUrl(data.repository.url);
  return { latest: data['dist-tags'].latest, repo, data };
}

// 验证包的某版本下，给定产物文件是否真实存在（通过 jsDelivr 探测 npm tarball 内容）
// 注意：jsDelivr 的 scoped 包名必须用原始斜杠（@scope/name），编码成 %2f 会返回 400
async function fileExists(name, version, file) {
  const url = `${JSDELIVR}/${name}@${version}/${toMinFile(file)}`;
  try {
    const res = await fetchWithTimeout(url, { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}

// 找出该包所有条目文件都存在的最新版本：
// 优先 latest，失败则从稳定版本中由高到低回退（最多尝试 maxCandidates 个）
async function resolveTargetVersion(name, files, currentVersion, data) {
  const latest = data['dist-tags'].latest;
  const candidates = [latest, ...Object.keys(data.versions)
    .filter((v) => v !== latest && !isPrerelease(v) && data.versions[v])
    .sort(compareVersions)
    .reverse()];
  const seen = new Set();
  let tried = 0;
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (++tried > MAX_CANDIDATES) break;
    if (compareVersions(candidate, currentVersion) <= 0) break;
    const ok = await every(files, (file) => fileExists(name, candidate, file));
    if (ok) return candidate;
    console.error(`[skip] ${name}@${candidate}: 产物文件验证未通过`);
  }
  return null;
}

// 有并发上限地全部通过才返回 true
async function every(items, test) {
  const results = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      results[i] = await test(items[i]);
    }
  });
  await Promise.all(workers);
  return results.every(Boolean);
}

async function check() {
  const plugins = parse(fs.readFileSync(PLUGINS_FILE, 'utf8'));
  const byName = new Map();
  for (const p of plugins) {
    if (!byName.has(p.name)) byName.set(p.name, { versions: new Set(), keys: [], files: [] });
    const group = byName.get(p.name);
    group.versions.add(p.version);
    group.keys.push(p.key);
    group.files.push(p.file);
  }

  const outdated = [];
  for (const [name, group] of byName) {
    const current = [...group.versions].sort(compareVersions)[0];
    let repo;
    let target;
    try {
      const meta = await fetchPackageMeta(name);
      repo = meta.repo;
      // npm latest 不比当前版本新时无需探测文件，静默跳过
      if (compareVersions(meta.latest, current) <= 0) continue;
      target = await resolveTargetVersion(name, group.files, current, meta.data);
    } catch (err) {
      console.error(err.message);
      continue;
    }
    if (!target) {
      console.error(`[skip] ${name}: 所有候选版本的产物文件均不可用`);
      continue;
    }
    if (compareVersions(current, target) < 0) {
      outdated.push({ name, current, latest: target, keys: group.keys, ...(repo && { repo }) });
    }
  }
  console.log(JSON.stringify(outdated, null, 2));
}

function apply(name, version) {
  const content = fs.readFileSync(PLUGINS_FILE, 'utf8');
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  let current = null;
  let changed = 0;
  const next = lines.map((line) => {
    const keyMatch = line.match(/^([A-Za-z0-9_]+):\s*$/);
    if (keyMatch) {
      current = keyMatch[1];
      return line;
    }
    const propMatch = line.match(/^( {2}name: )(.*)$/);
    if (propMatch) {
      const value = propMatch[2].trim().replace(/^['"]|['"]$/g, '');
      current = value;
      return line;
    }
    const versionMatch = line.match(/^( {2}version: )(.*)$/);
    if (versionMatch && current === name) {
      const old = versionMatch[2].trim();
      if (old !== version) {
        changed++;
        return `${versionMatch[1]}${version}`;
      }
    }
    return line;
  });
  fs.writeFileSync(PLUGINS_FILE, next.join(eol));
  console.log(`已更新 ${name}: ${changed} 处 -> ${version}`);
}

(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'check') {
    await check();
  } else if (cmd === 'apply') {
    if (args.length !== 2) {
      console.error('用法: node plugins-update.js apply <name> <version>');
      process.exit(1);
    }
    apply(args[0], args[1]);
  } else {
    console.error('未知命令，可用: check | apply <name> <version>');
    process.exit(1);
  }
})();
