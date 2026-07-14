#!/usr/bin/env node
/*
 * release-store.mjs — one-command "publish to the community store".
 *
 * WHAT IT DOES
 *   Generates the store-safe build (no dynamic code execution) from the full
 *   `main` branch and publishes it, then returns you to `main`. You develop and
 *   live on `main` (full JS build); this script owns the `store` branch entirely
 *   — never hand-edit `store`.
 *
 * WHY THIS EXISTS
 *   The Obsidian community store forbids eval / new Function. The full build
 *   uses `new Function` to run inline <script> in html-blocks, which the store
 *   rejects. The ONLY difference between the two builds is scriptRunner.ts:
 *     • main branch:  scriptRunner.ts       → runs scripts (new Function)
 *     • store branch: scriptRunner.store.ts → copied over scriptRunner.ts (no-op)
 *   The store's automated review reads the manifest AND source at the HEAD of
 *   the repo's DEFAULT branch, which is `store`. So `store` must be free of any
 *   dynamic execution in both source and built main.js. This script guarantees
 *   that by physically overwriting scriptRunner.ts with the stub before building.
 *
 * USAGE
 *   npm run release:store -- <version>     e.g.  npm run release:store -- 1.0.1
 *   (If <version> is omitted, the current manifest.json version is reused.)
 *
 * SAFE TO RE-RUN. Aborts if the working tree is dirty. Always ends on `main`.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import process from 'node:process';

const run = (cmd, opts = {}) =>
    execSync(cmd, { stdio: 'pipe', encoding: 'utf8', ...opts }).trim();
const runLoud = (cmd) => execSync(cmd, { stdio: 'inherit' });
const die = (msg) => { console.error(`\n❌ ${msg}\n`); process.exit(1); };

// ── 0. Preconditions ────────────────────────────────────────────────────────
const startBranch = run('git rev-parse --abbrev-ref HEAD');
if (startBranch !== 'main') {
    die(`You must be on 'main' to release (currently on '${startBranch}'). ` +
        `main is the full/source build; run this from there.`);
}
if (run('git status --porcelain')) {
    die('Working tree is dirty. Commit or stash your changes first.');
}
if (!fs.existsSync('scriptRunner.store.ts')) {
    die('scriptRunner.store.ts is missing — cannot build the store-safe variant.');
}

const argVersion = process.argv[2];
const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const version = argVersion || manifest.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
    die(`Version must be x.y.z (got '${version}').`);
}

console.log(`\n▶ Releasing store build v${version} from 'main' → 'store' branch\n`);

// Restore to main no matter what happens.
function backToMain() {
    try {
        run('git checkout --force main');
        console.log(`\n✅ Back on 'main'. Your full build is intact.`);
    } catch (e) {
        console.error(`\n⚠️  Could not return to main automatically: ${e.message}`);
        console.error(`   Run: git checkout main`);
    }
}

try {
    // ── 1. Sync/create the store branch from main ────────────────────────────
    const storeExists = run('git branch --list store');
    if (storeExists) {
        run('git checkout store');
        // Bring in everything from main, then we re-apply the store overrides.
        // -X theirs keeps main's content on any conflict; scriptRunner.ts is
        // overwritten right after anyway.
        run('git merge --no-edit -X theirs main');
    } else {
        run('git checkout -b store main');
        console.log(`Created 'store' branch from 'main'.`);
    }

    // ── 2. Apply the store overrides ─────────────────────────────────────────
    // Physically replace the JS-executing module with the no-op stub, so neither
    // the source nor the built main.js contains new Function.
    fs.copyFileSync('scriptRunner.store.ts', 'scriptRunner.ts');

    // Sync manifest/versions to the requested version.
    manifest.version = version;
    fs.writeFileSync('manifest.json', JSON.stringify(manifest, null, '\t') + '\n');
    const versions = JSON.parse(fs.readFileSync('versions.json', 'utf8'));
    versions[version] = manifest.minAppVersion;
    fs.writeFileSync('versions.json', JSON.stringify(versions, null, 4) + '\n');

    // ── 3. Build the store artifact ──────────────────────────────────────────
    console.log('\n▶ Building store artifact…');
    runLoud('npm run build');

    // Hard guarantee: the built main.js must not contain dynamic execution.
    const built = fs.readFileSync('main.js', 'utf8');
    if (/new Function|\beval\s*\(/.test(built)) {
        die('SAFETY CHECK FAILED: built main.js still contains new Function/eval. ' +
            'Store build aborted — nothing was pushed.');
    }
    console.log('✓ Safety check passed: no dynamic execution in store main.js.');

    // ── 4. Commit + push store branch ────────────────────────────────────────
    run('git add -A');
    const hasChanges = run('git status --porcelain');
    if (hasChanges) {
        run(`git commit -m "Store build v${version} (no dynamic execution)"`);
    }
    console.log('\n▶ Pushing store branch…');
    runLoud('git push -u origin store');

    // ── 5. GitHub release (tag = version, no leading v) ──────────────────────
    console.log('\n▶ Creating GitHub release…');
    const assets = ['main.js', 'manifest.json', 'styles.css'].filter(f => fs.existsSync(f));
    // Delete an existing release/tag for this version if re-running.
    try { run(`gh release delete ${version} --yes --cleanup-tag`); } catch { /* none */ }
    runLoud(
        `gh release create ${version} ${assets.join(' ')} ` +
        `--target store --title "${version}" ` +
        `--notes "Store build v${version}. HTML + CSS rendering with Shadow DOM isolation. ` +
        `(The community-store build does not execute inline <script>; the full build on the main branch does.)"`
    );

    console.log(`\n✅ Store release v${version} published from the 'store' branch.`);
    console.log(`   Reminder: the GitHub default branch must be 'store' for the`);
    console.log(`   directory to scan the store-safe source. See PUBLISHING.md.`);
} catch (e) {
    console.error(`\n❌ Release failed: ${e.message}`);
    backToMain();
    process.exit(1);
}

// ── 6. Always return to main ─────────────────────────────────────────────────
backToMain();
