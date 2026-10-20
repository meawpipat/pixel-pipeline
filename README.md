# Pixel Pipeline

Turns AI-generated character concepts into **64×64, 4-grey pixel sprites** for small 1-bit E-Ink screens, and exports them for firmware and apps.

- A browser **converter** finds the AI image's pseudo-pixel grid, keys the background, maps the greys to 4 tones and places every frame of an animation in a fixed stage box on a common baseline.
- A **Clean Editor** with a timeline for hand cleanup, a **Validator**, and an **exporter** (C header, raw `.bin`, 4-grey PNG).
- Everything is reproducible: raw frames are rebuilt byte-for-byte from the archived source and the stored parameters.
- The **device preview** and the exported C renderer `pp_draw` draw the same thing: the sprite scaled first, then dithered at screen pixels.

The tool works on a **project**: a folder of your own holding `pixelpipe.config.json` and `art/`. The tool never stores project data.

## Install
```bash
git clone <this repo> pixel-pipeline
cd pixel-pipeline
npm install        # dev dependencies are required: esbuild builds the page
npm test
```
`pixelpipe` below means `node <path-to>/pixel-pipeline/src/cli/index.js` (or `npm link` to get a `pixelpipe` command).

The Chromium tests run when Chromium/Chrome is found, e.g. `PP_CHROMIUM="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm test`. `PP_SLOW=1 npm test` adds a 70-case grid sweep; `PIXELPIPE_SAMPLE_IMAGE=<file>` checks grid detection on a real AI image of yours.

## Create a project
```bash
pixelpipe init my-pets          # pixelpipe.config.json (no species yet), art/{source,raw,clean,export}/, .gitignore files
cd my-pets
pixelpipe species-add blob --stage 1
pixelpipe serve                 # opens the workbench on http://127.0.0.1:4870
```
**Which project?** Every command uses, in this order: `--root DIR`, the environment variable `PIXELPIPE_ROOT`, or the nearest folder upward from the current folder that contains `pixelpipe.config.json` (like git finds `.git`). So inside your project folder you never need `--root`. Commands that write print the project when it came from `PIXELPIPE_ROOT`.

**Project layout**
| Path | What |
|------|------|
| `pixelpipe.config.json` | Every constant: palette, stage boxes and baseline, species per stage, animation budget, dither tiles, processing ratios |
| `art/source/<species>/` | Archived AI images (metadata-free PNG, never modified) |
| `art/raw/<species>/` | Generated frames + sidecars + one batch file per group — rebuilt from source, never edited |
| `art/clean/<species>/` | Hand-cleaned frames (Clean Editor or any editor) |
| `art/export/<species>/` | Output for firmware and apps |
| `art/_removed/`, `art/clean/*/.trash/` | Removed or replaced work (local only, never deleted by the tool) |

Groups are named `<species>_s<stage>[-fat]` and frames `<group>_<anim>_<NN>.png`.

## The workbench (`pixelpipe serve`)
- **Drop an AI image:** it is archived into `art/source/`.
- **Pick Species / Form / Animation, tune the grid, tones and frames, then Add to group:** the line next to the button says which group it writes. The unit is added, rebuilt, promoted to clean and opened in the **Clean Editor**.
- **Clean Editor:** pencil `B`, eraser `E`, fill `G`, pick `I`, colours `1–5`, arrows shift a frame (Shift: the whole animation), `⌘Z` / `⌘⇧Z`, onion skin, timeline (duplicate, add blank, delete, move, copy to another animation). **Save** (`⌘S`) writes the whole group; replaced or deleted frames go to `.trash/`.
- **Group panel:** Preview, Edit clean, Promote, Retranslate, Validate, Export, units list (**Edit unit** / **Remove**), **Remove group…**.
- **Species list:** **+ New species…**, **✎ Rename species…** (renames every file and reference, no pixel changes, re-exports), **− Remove species…** (species without groups). After adding or renaming, record the display name in your project's own species list and update firmware symbols.
- **Messages panel** at the bottom collapses; it keeps a fail/warn count.

The server listens on 127.0.0.1 only and requires a per-run token. `pixelpipe page` writes an offline copy of the page with your project's config (`pixel-tool.html`, preview and fragment download only).

## CLI
```bash
pixelpipe archive <image> <species>                 # store a metadata-free PNG in art/source/
pixelpipe add <fragment.json> [--yes]               # merge a unit exported from an offline page, then rebuild
pixelpipe rebuild <group> [--out DIR] [--check]     # regenerate art/raw/ (--check compares)
pixelpipe promote <group> [--anim A | --force <raw> --yes | --adopt <clean> | --accept-raw <clean>]
pixelpipe retranslate <group> [--yes]               # shift clean frames after the group's placement changed
pixelpipe normalize <file.png…> [--yes]             # canonical palette after an external editor
pixelpipe validate <group> [--raw]
pixelpipe export <group> [--formats h,bin,png]
pixelpipe clean-save <group> <payload.json> | clean-restore <group>
pixelpipe species-add <id> --stage N | species-rename <old> <new> | species-remove <id>
pixelpipe unit-remove <group> <unit> [--edited keep|trash] | group-remove <group>
pixelpipe ci                                        # rebuild --check every group; exit 1 on any mismatch
pixelpipe serve [--port N] [--no-open] | page [--out FILE] | init [DIR]
```
Commands that change existing files ask for `--yes` (the workbench shows the same confirmation). Interrupted multi-file commands leave a marker and finish exactly when run again.

## Export format
See [`docs/format.md`](docs/format.md): 2-bit pixel plane + 1-bit mask + reference point per frame, the `.bin` layout, the C header and the `pp_draw` renderer.

## Notes
- Code comments cite `FR-nn` / `§n` / `Dnn`: these point to the authors' internal design spec, which is not part of this repository.
- License: MIT (see `LICENSE`). Dependencies: fflate (MIT), jpeg-js (BSD-3-Clause), esbuild (MIT, dev), playwright-core (Apache-2.0, dev).
