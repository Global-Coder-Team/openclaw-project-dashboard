const fs = require('fs');
const p = 'index.ts';
let s = fs.readFileSync(p, 'utf8');
const start = s.indexOf('function buildHtml()');
if (start < 0) throw new Error('start not found');
const endMarker = '</html>`;\n}';
const end = s.indexOf(endMarker, start);
if (end < 0) throw new Error('end marker not found');
const before = s.slice(0, start);
const after = s.slice(end + endMarker.length);
const repl = [
  'function buildHtml() {',
  '  const htmlPath = new URL("./ui.html", import.meta.url);',
  '  return readFileSync(htmlPath, "utf8");',
  '}',
  '',
].join('\n');
fs.writeFileSync(p, before + repl + after, 'utf8');
console.log('patched buildHtml');
