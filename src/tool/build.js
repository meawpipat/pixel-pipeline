// Build the single self-contained offline HTML tool (NFR-01): dist/pixel-tool.html
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
// `--config FILE --out FILE`: build from another config into another file (pixelpipe page, tests).
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
// FR-29: the tool's own page is built from the example config and marked as the example page (`--example`).
const example = process.argv.includes('--example');
const cfg = JSON.parse(fs.readFileSync(arg('--config') || path.join(root, 'config/example.config.json'), 'utf8'));
const res = await build({ entryPoints: [path.join(here, 'app.js')], bundle: true, format: 'iife', write: false, minify: true, target: ['es2020'], legalComments: 'inline' });
const js = res.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const tpl = fs.readFileSync(path.join(here, 'template.html'), 'utf8');
const html = tpl.replace('/*__CONFIG__*/', () => JSON.stringify(cfg).replace(/</g, '\\u003c')).replace('/*__EXAMPLE__*/false', () => (example ? 'true' : 'false')).replace('/*__APP__*/', () => js);
// NFR-01: no dynamic imports, and no request to any absolute URL (only relative /api/ calls to the local server).
if (/import\(/.test(js)) throw new Error('dynamic import found — NFR-01');
if (/fetch\(\s*["'`]\s*(https?:)?\/\//.test(js) || /new\s+WebSocket|EventSource\(/.test(js)) throw new Error('absolute-URL request found — NFR-01 allows only the local server');
const out = arg('--out') || path.join(root, 'dist/pixel-tool.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`wrote ${path.relative(process.cwd(), out)} (${(html.length / 1024).toFixed(0)} KB, config ${cfg.config_version})`);
