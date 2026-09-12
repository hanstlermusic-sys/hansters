'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_CHARS = 120000;
const MAX_FILE_CHARS = 30000;
const SKIP_DIRS = new Set([
  '.git', '.venv', 'venv', 'node_modules', 'dist', 'dist-electron',
  'build', 'coverage', '__pycache__', '.pytest_cache', '.cache'
]);

function normalizeRelative(root, file) {
  return path.relative(root, file).replace(/\\/g, '/');
}

function priority(relativePath) {
  const name = relativePath.toLowerCase();
  if (name === 'agents.md') return 0;
  if (name === 'readme.md') return 1;
  if (name === 'docs/readme.md') return 2;
  if (name.startsWith('docs/')) return 3;
  if (name.endsWith('/readme.md')) return 4;
  return 5;
}

function collectMarkdownFiles(root) {
  const files = [];
  function walk(dir, depth) {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full, depth + 1);
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        files.push(full);
      }
    }
  }
  walk(root, 0);
  return files.sort((a, b) => {
    const relA = normalizeRelative(root, a);
    const relB = normalizeRelative(root, b);
    return priority(relA) - priority(relB) || relA.localeCompare(relB);
  });
}

function buildDocumentationContext(root, options) {
  const maxChars = Math.max(1000, Number(options && options.maxChars) || DEFAULT_MAX_CHARS);
  const files = collectMarkdownFiles(root);
  if (!files.length) return '';

  const names = files.map((file) => normalizeRelative(root, file));
  const sections = [
    'Índice de documentación disponible:\n' + names.map((name) => '- ' + name).join('\n')
  ];
  let used = sections[0].length;
  const omitted = [];

  for (const file of files) {
    const relative = normalizeRelative(root, file);
    let content;
    try {
      content = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
    } catch (_) {
      omitted.push(relative);
      continue;
    }
    if (!content) continue;

    const remaining = maxChars - used;
    const header = '\n\n--- ' + relative + ' ---\n';
    if (remaining <= header.length + 200) {
      omitted.push(relative);
      continue;
    }
    const allowed = Math.min(MAX_FILE_CHARS, remaining - header.length);
    const excerpt = content.slice(0, allowed);
    sections.push(header + excerpt + (excerpt.length < content.length ? '\n[Documento truncado]' : ''));
    used += header.length + excerpt.length;
    if (excerpt.length < content.length) omitted.push(relative);
  }

  if (omitted.length) {
    sections.push('\n\nDocumentos no incluidos completos por el límite de contexto; usa read_file antes de trabajar en su tema:\n' +
      Array.from(new Set(omitted)).map((name) => '- ' + name).join('\n'));
  }
  return sections.join('');
}

module.exports = {
  buildDocumentationContext,
  collectMarkdownFiles,
  DEFAULT_MAX_CHARS
};
