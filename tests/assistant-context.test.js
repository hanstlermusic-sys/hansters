'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildDocumentationContext,
  collectMarkdownFiles
} = require('../assistant-context');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hanstlers-assistant-context-'));

try {
  fs.mkdirSync(path.join(root, 'docs', 'guides'), { recursive: true });
  fs.mkdirSync(path.join(root, 'component'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'ignored'), { recursive: true });
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'REGLA PRINCIPAL');
  fs.writeFileSync(path.join(root, 'README.md'), 'DESCRIPCION GENERAL');
  fs.writeFileSync(path.join(root, 'docs', 'README.md'), 'INDICE DOCS');
  fs.writeFileSync(path.join(root, 'docs', 'guides', 'uso.md'), 'GUIA DE USO ' + 'detalle '.repeat(300));
  fs.writeFileSync(path.join(root, 'component', 'README.md'), 'DOC COMPONENTE');
  fs.writeFileSync(path.join(root, 'node_modules', 'ignored', 'README.md'), 'NO INCLUIR');

  const names = collectMarkdownFiles(root).map((file) => path.relative(root, file).replace(/\\/g, '/'));
  assert.deepStrictEqual(names, [
    'AGENTS.md',
    'README.md',
    'docs/README.md',
    'docs/guides/uso.md',
    'component/README.md'
  ]);

  const context = buildDocumentationContext(root);
  assert(context.indexOf('REGLA PRINCIPAL') !== -1);
  assert(context.indexOf('DESCRIPCION GENERAL') !== -1);
  assert(context.indexOf('INDICE DOCS') !== -1);
  assert(context.indexOf('GUIA DE USO') !== -1);
  assert(context.indexOf('DOC COMPONENTE') !== -1);
  assert(context.indexOf('NO INCLUIR') === -1);
  assert(context.indexOf('--- AGENTS.md ---') < context.indexOf('--- README.md ---'));

  const limited = buildDocumentationContext(root, { maxChars: 1100 });
  assert(limited.indexOf('Documentos no incluidos completos') !== -1);
  assert(limited.indexOf('docs/guides/uso.md') !== -1);

  console.log('assistant-context: OK');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
