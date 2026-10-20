#!/usr/bin/env node
// pixelpipe — CLI of the pixel pipeline (AI concept → 64x64 4-grey sprites for 1-bit E-Ink).
import path from 'node:path';
import { resolveRoot } from './store.js';
import * as M2 from './commands.js';

const USAGE = `pixelpipe <command> [options]

Project: --root DIR, else $PIXELPIPE_ROOT, else the nearest folder upward from here holding pixelpipe.config.json.

  init [DIR]                            create a project (config with no species, art/ folders, .gitignore)
  page [--out FILE]                     build an offline page with this project's config (default: pixel-tool.html)

  archive <image> <species_id>          §3.3  store a metadata-free PNG in art/source/
  add <fragment.json> [--yes]           FR-11 merge a unit from the browser tool, then rebuild
  rebuild <batch_id> [--out DIR] [--check]
                                        FR-12 regenerate art/raw/ (or DIR); --check compares with committed raw
  promote <batch_id> [--anim A] | --force <raw> [--to <clean>] --yes | --adopt <clean> | --accept-raw <clean>
  retranslate <batch_id> [--yes]
  normalize <file.png…> [--yes]         FR-15 clean-asset maintenance
  validate <batch_id> [--raw]           FR-14
  export <batch_id> [--formats h,bin,png]
                                        §6   write art/export/
  clean-save <batch_id> <payload.json> [--yes]
                                        FR-17 write the complete final state of a group's clean frames
  clean-restore <batch_id> [--yes]      FR-17 Restore previous state after an interrupted clean-save
  species-add <id> --stage N            FR-18 add a species id to the config
  unit-remove <batch_id> <unit_id> [--edited keep|trash] [--yes]
                                        FR-19 take a unit out of a group (later units of the anim move down)
  group-remove <batch_id> [--yes]       FR-20 move a whole group to art/_removed/
  species-rename <old> <new> [--yes]    FR-26 rename a species everywhere (no pixel changes; re-exports)
  species-remove <id> [--yes]           FR-21 remove a species that has no groups (leftovers → art/_removed/)
  ci                                    FR-12 rebuild --check every group into a temp dir; exit 1 on any mismatch
  serve [--port N] [--no-open]          FR-16 local workbench on 127.0.0.1 (the browser tool with write access)
`;

const KNOWN = ['archive', 'add', 'rebuild', 'ci', 'serve', 'species-add', 'species-rename', 'unit-remove', 'group-remove', 'species-remove', 'clean-save', 'clean-restore', 'promote', 'retranslate', 'normalize', 'validate', 'export', 'page'];

function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      const valued = ['root', 'out', 'anim', 'force', 'formats', 'anchor', 'to', 'adopt', 'accept-raw', 'port', 'stage', 'edited'];
      if (valued.includes(k)) {
        if (next === undefined || next.startsWith('--')) throw new Error(`--${k} needs a value`);
        opt[k] = next; i++;
      } else opt[k] = true;
    } else pos.push(a);
  }
  return { pos, opt };
}

export async function main(argv) {
  const { pos, opt } = parseArgs(argv);
  const [cmd, ...args] = pos;
  const print = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));
  if (!cmd || cmd === 'help') { console.log(USAGE); return 0; }
  if (cmd === 'init') {
    if (opt.root) throw new Error(`use \`pixelpipe init ${opt.root}\` instead of --root`);
    const { cmdInit } = await import('./init.js');
    const r = cmdInit(args[0] || process.cwd());
    for (const w of r.warnings) console.error('warning: ' + w);
    print(r); return 0;
  }
  if (!KNOWN.includes(cmd)) { console.log(USAGE); return 2; }
  // FR-27: resolve the project (refuses before anything is read or written)
  const { root, source } = resolveRoot({ rootOpt: opt.root || null });
  if (source === 'env' && !['validate', 'rebuild'].includes(cmd)) console.error(`project ${root} (from PIXELPIPE_ROOT)`);
  // FR-26: while a species rename is pending, every writing command refuses (central check)
  if (!['species-rename', 'validate', 'serve'].includes(cmd)) {
    const { assertNoRename } = await import('./rename.js');
    assertNoRename(root);
  }
  switch (cmd) {
    case 'archive': print(M2.cmdArchive(root, args[0], args[1])); return 0;
    case 'add': print(M2.cmdAdd(root, args[0], { yes: !!opt.yes })); return 0;
    case 'rebuild': {
      const r = M2.cmdRebuild(root, args[0], { out: opt.out || null, check: !!opt.check });
      print(r);
      return r.mismatches && r.mismatches.length ? 1 : 0;
    }
    case 'ci': {
      const fs = await import('node:fs');
      const os = await import('node:os');
      const rawRoot = path.join(root, 'art', 'raw');
      const batches = fs.existsSync(rawRoot) ? fs.readdirSync(rawRoot).filter((sp) => fs.statSync(path.join(rawRoot, sp)).isDirectory()).flatMap((sp) => fs.readdirSync(path.join(rawRoot, sp)).filter((f) => f.endsWith('.batch.json')).map((f) => f.replace(/\.batch\.json$/, ''))) : [];
      let bad = 0;
      for (const id of batches) {
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-ci-'));
        try {
          const r = M2.cmdRebuild(root, id, { out, check: true });
          if (r.mismatches.length) { bad++; console.log(`FAIL ${id}\n  ${r.mismatches.join('\n  ')}`); } else console.log(`ok   ${id} (${r.files.length} frames)`);
        } catch (e) { bad++; console.log(`FAIL ${id}: ${e.message}`); }
        finally { fs.rmSync(out, { recursive: true, force: true }); }
      }
      console.log(`${batches.length} group(s), ${bad} failing`);
      return bad ? 1 : 0;
    }
    case 'serve': {
      const { startServer, openBrowser } = await import('../server/serve.js');
      const srv = await startServer({ root, port: opt.port ? Number(opt.port) : 4870 });
      console.log(`Pixel Pipeline workbench: ${srv.url}  (project ${root} · config ${(await import('./store.js')).configPath(root)})\nPress Ctrl+C to stop.`);
      if (!opt['no-open']) openBrowser(srv.url);
      await new Promise(() => {}); // run until interrupted
      return 0;
    }
    case 'species-add': {
      const { cmdSpeciesAdd } = await import('./species.js');
      print(cmdSpeciesAdd(root, args[0], opt.stage)); return 0;
    }
    case 'species-rename': {
      const { cmdSpeciesRename } = await import('./rename.js');
      print(cmdSpeciesRename(root, args[0], args[1], { yes: !!opt.yes })); return 0;
    }
    case 'unit-remove': case 'group-remove': case 'species-remove': {
      const R = await import('./remove.js');
      if (cmd === 'unit-remove') print(R.cmdUnitRemove(root, args[0], args[1], { edited: opt.edited || 'keep', yes: !!opt.yes }));
      else if (cmd === 'group-remove') print(R.cmdGroupRemove(root, args[0], { yes: !!opt.yes }));
      else print(R.cmdSpeciesRemove(root, args[0], { yes: !!opt.yes }));
      return 0;
    }
    case 'clean-save': case 'clean-restore': {
      const C = await import('./cleansave.js');
      const fs = await import('node:fs');
      try {
        if (cmd === 'clean-save') { const r = C.cmdCleanSave(root, args[0], JSON.parse(fs.readFileSync(args[1], 'utf8')), { yes: !!opt.yes }); print(r); return r.validator && !r.validator.ok ? 1 : 0; }
        print(C.cmdCleanRestore(root, args[0], { yes: !!opt.yes })); return 0;
      } catch (e) { if (e.code === 'CONFLICT') { console.error('error: ' + e.message); return 4; } throw e; }
    }
    case 'promote': case 'retranslate': case 'normalize': case 'validate': case 'export': {
      const M3 = await import('./commands3.js');
      return M3.run(cmd, root, args, opt, print);
    }
    case 'page': {
      const { cmdPage } = await import('./init.js');
      print(cmdPage(root, { out: opt.out || null })); return 0;
    }
    default: console.log(USAGE); return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('index.js')) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error('error: ' + e.message);
    process.exit(e.code === 'CONFIRM' ? 3 : 1);
  });
}
