/*
 * scriptRunner.store.ts — STORE build (Obsidian community directory).
 *
 * The community store forbids dynamic code execution (eval / new Function), so
 * the store build ships this no-op stub INSTEAD of scriptRunner.ts. It has the
 * exact same public signature — runShadowScripts(shadow) — but never executes
 * any <script>. Inline scripts are simply stripped so they don't render as
 * visible text; HTML + CSS rendering and Shadow DOM isolation are unaffected.
 *
 * This file is swapped in for scriptRunner.ts by scripts/release-store.mjs at
 * release time. Do NOT edit it to add execution back. See PUBLISHING.md.
 */

/**
 * Store build: remove <script> tags (so their source doesn't show up as text)
 * but never execute them. HTML/CSS blocks render exactly as in the full build;
 * only the JavaScript-running capability is absent.
 */
export function runShadowScripts(shadow: ShadowRoot): void {
    for (const el of Array.from(shadow.querySelectorAll('script'))) {
        el.remove();
    }
}
