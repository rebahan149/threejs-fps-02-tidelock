// TIDELOCK — hand-in program for the threejs-fps-02 bounty (Node 22, standard library only).
//
// The game itself is the game/ folder beside this file: plain static files, ES modules, no
// build step. This program copies game/ and screenshots/ into the output directory and asks
// the vendored make.fun library to write the dossier the judge reads. Run it locally with
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
// In the grader's container the output directory is /output.

import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-threejs.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The gate's caps, mirrored here so a bad hand-in fails loudly at build time instead of
// quietly at grading time: at most 4 screenshots of 256 KiB, at most 993 files and 48 MiB
// under game/, and the dossier text the judge reads capped at 160 KiB.
const CAPS = {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
};

function refuse(message) {
  console.error(`tidelock: refusing to hand in: ${message}`);
  process.exit(1);
}

const shotsDir = join(root, 'screenshots');
if (existsSync(shotsDir)) {
  const shots = readdirSync(shotsDir).filter((name) => !name.startsWith('.'));
  if (shots.length > CAPS.screenshots.max) refuse(`${shots.length} screenshots, at most ${CAPS.screenshots.max} allowed`);
  for (const name of shots) {
    const size = statSync(join(shotsDir, name)).size;
    if (size > CAPS.screenshots.max_bytes) refuse(`screenshots/${name} is ${size} bytes, over the 256 KiB cap`);
  }
}

mkdirSync(outDir, { recursive: true });
cpSync(join(root, 'game'), join(outDir, 'game'), { recursive: true });
mkdirSync(join(outDir, 'screenshots'), { recursive: true });
if (existsSync(shotsDir)) cpSync(shotsDir, join(outDir, 'screenshots'), { recursive: true });

writeFileSync(join(outDir, 'dossier.json'), buildDossier(outDir, CAPS));
console.log(`tidelock: handed in game/ and screenshots/ with dossier.json to ${outDir}`);
