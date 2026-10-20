// Tests run against the tool's neutral example config (NFR-08), never a project's pixelpipe.config.json.
// PP_CONFIG (test hook, FR-27) points at a per-process temp copy, so no test can modify the example itself.
// Import this first in every test file; tests that need their own writable copy override PP_CONFIG after it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const FIXTURE_CONFIG = path.join(path.dirname(fileURLToPath(import.meta.url)), '../config/example.config.json');
const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ppcfg-')), 'pixelpipe.config.json');
fs.copyFileSync(FIXTURE_CONFIG, copy);
process.env.PP_CONFIG = copy; // unconditional: an ambient PP_CONFIG never leaks into tests
