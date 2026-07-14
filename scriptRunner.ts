/*
 * scriptRunner.ts — FULL build (local / self-use).
 *
 * This module executes the inline <script> tags a user writes inside an
 * html-block, scoped to that block's Shadow DOM. Executing user-authored
 * inline code is the whole point of the full build (like Dataview JS or
 * Templater). Only inline code the user wrote in their own note runs here —
 * no remote code is ever fetched or executed.
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ IMPORTANT — this file is the ONLY difference between the two builds.  │
 * │   • main branch (this file):  runs scripts via `new Function`.        │
 * │   • store branch:             a no-op stub with the same signature.   │
 * │ The Obsidian community store forbids dynamic code execution, so the   │
 * │ store build ships the stub. See PUBLISHING.md for the full rationale  │
 * │ and the one-command release flow.                                     │
 * └─────────────────────────────────────────────────────────────────────┘
 */

/**
 * Build a `document` proxy for a block. Element-lookup methods resolve against
 * the block's shadowRoot; everything else falls through to the real document.
 * This lets inline scripts that use bare `document.getElementById(...)` find
 * nodes that actually live inside the shadow tree.
 */
function makeDocumentProxy(shadow: ShadowRoot): Document {
    const realDoc = document;
    // Methods that should look *inside* the shadow tree instead of the page.
    const scoped: Record<string, (...args: any[]) => any> = {
        getElementById: (id: string) =>
            shadow.getElementById
                ? shadow.getElementById(id)
                : shadow.querySelector(`#${(window as any).CSS?.escape ? CSS.escape(id) : id}`),
        querySelector: (sel: string) => shadow.querySelector(sel),
        querySelectorAll: (sel: string) => shadow.querySelectorAll(sel),
        getElementsByClassName: (cls: string) =>
            shadow.querySelectorAll('.' + cls.split(/\s+/).filter(Boolean).join('.')),
        getElementsByTagName: (tag: string) => shadow.querySelectorAll(tag),
    };

    return new Proxy(realDoc, {
        get(target, prop: string | symbol) {
            if (typeof prop === 'string' && prop in scoped) {
                return scoped[prop];
            }
            const value = (target as any)[prop];
            // Bind functions to the real document so `this` stays valid
            // (createElement, addEventListener, head/body access, etc.).
            return typeof value === 'function' ? value.bind(target) : value;
        },
        set(target, prop: string | symbol, value) {
            (target as any)[prop] = value;
            return true;
        },
    }) as unknown as Document;
}

/**
 * Execute every inline <script> in the shadow tree. Scripts run in an isolated
 * Function scope with a scoped `document` proxy, so element lookups resolve
 * against this block's shadowRoot. Each block gets its own scope, so top-level
 * vars never collide between blocks.
 *
 * Only inline scripts are executed. External scripts (`<script src="...">`) are
 * intentionally NOT fetched or run: loading and executing remote code would be
 * a security risk and is disallowed.
 */
export function runShadowScripts(shadow: ShadowRoot): void {
    const docProxy = makeDocumentProxy(shadow);
    const scripts = Array.from(shadow.querySelectorAll('script'));

    for (const old of scripts) {
        // Skip external scripts — remote code is never fetched or executed.
        if (old.hasAttribute('src')) {
            old.remove();
            continue;
        }
        const code = old.textContent;
        old.remove();
        if (!code) continue;

        try {
            // `document` → proxy, `shadowRoot`/`rootNode` → the shadow tree.
            // Each block gets its own Function scope, so top-level vars are
            // isolated between blocks (no global-namespace collisions).
            const fn = new Function(
                'document', 'shadowRoot', 'rootNode',
                `"use strict";\n${code}`
            );
            fn.call(window, docProxy, shadow, shadow);
        } catch (e) {
            console.error('[html-blocks] script execution error:', e);
        }
    }
}
