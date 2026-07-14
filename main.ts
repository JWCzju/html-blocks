import { Plugin, MarkdownPostProcessorContext, TFile, WorkspaceLeaf } from 'obsidian';

export default class HtmlCardPlugin extends Plugin {
    private observer: MutationObserver | null = null;
    private processedEmbeds = new WeakSet<Element>();
    private embedCounter = 0;
    private embedGuards: MutationObserver[] = [];

    // Inspect mode state
    private inspectMode = false;
    private inspectLeaf: WorkspaceLeaf | null = null;
    private inspectStyleEl: HTMLStyleElement | null = null;

    async onload() {
        // 0. Inject global CSS: show selection highlight in unfocused editors (for inspect mode)
        this.inspectStyleEl = document.createElement('style');
        this.inspectStyleEl.id = 'html-card-inspect-style';
        this.inspectStyleEl.textContent = `
            .cm-editor:not(.cm-focused) .cm-selectionBackground {
                background-color: rgba(37, 99, 235, 0.25) !important;
            }
        `;
        document.head.appendChild(this.inspectStyleEl);

        // 1. Code block processors:
        //    ```html-block  → rendered (primary, documented syntax)
        //    ```html card   → rendered (legacy shorthand, kept for backward compat)
        //    ```html-card   → rendered (legacy, kept for backward compat)
        //    ```html        → NOT rendered (pass through as syntax-highlighted code block)
        this.registerMarkdownCodeBlockProcessor("html-block", (source, el, ctx) => {
            this.processHtmlCard(source, el, ctx);
        });
        this.registerMarkdownCodeBlockProcessor("html", (source, el, ctx) => {
            // Check if the fence line contains "card" metadata (legacy shorthand)
            const sectionInfo = ctx.getSectionInfo(el);
            if (sectionInfo) {
                const fenceLine = sectionInfo.text.split('\n')[sectionInfo.lineStart];
                if (fenceLine && /```html\s+card/i.test(fenceLine)) {
                    this.processHtmlCard(source, el, ctx);
                    return;
                }
            }
            // Not a card → render as normal code block with Prism syntax highlighting
            const pre = el.createEl('pre');
            const code = pre.createEl('code', { cls: 'language-html' });
            code.textContent = source;
            // Trigger Obsidian's built-in Prism.js for syntax coloring
            const Prism = (window as any).Prism;
            if (Prism?.highlightElement) {
                Prism.highlightElement(code);
            }
        });
        this.registerMarkdownCodeBlockProcessor("html-card", (source, el, ctx) => {
            this.processHtmlCard(source, el, ctx);
        });

        // 2. MutationObserver: intercept ![[file.html]] iframe embeds → Shadow DOM
        this.embedCounter = 0;
        this.observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                mutation.addedNodes.forEach(node => {
                    if (!(node instanceof HTMLElement)) return;
                    const embeds = node.matches?.('.internal-embed')
                        ? [node]
                        : Array.from(node.querySelectorAll?.('.internal-embed') || []);
                    for (const embed of embeds) {
                        if (this.processedEmbeds.has(embed)) continue;
                        const src = embed.getAttribute('src') || '';
                        if (/\.html?$/i.test(src)) {
                            this.processedEmbeds.add(embed);
                            const id = ++this.embedCounter;
                            this.replaceHtmlEmbed(embed as HTMLElement, src, id);
                        }
                    }
                });
            }
        });
        this.observer.observe(document.body, { childList: true, subtree: true });

        // 3. Toggle Inspect Mode command (bind to hotkey in settings)
        this.addCommand({
            id: 'toggle-inspect-mode',
            name: 'Toggle Inspect Mode',
            callback: () => this.setInspectMode(!this.inspectMode),
        });

        // 4. ESC to exit inspect mode
        this.escHandler = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && this.inspectMode) {
                this.setInspectMode(false);
            }
        };
        document.addEventListener('keydown', this.escHandler);
    }

    private escHandler: ((e: KeyboardEvent) => void) | null = null;

    // ========================
    // Inspect Mode
    // ========================

    private setInspectMode(on: boolean) {
        this.inspectMode = on;

        document.querySelectorAll('.html-card-container').forEach(c => {
            if (on) {
                c.classList.add('html-card-inspecting');
            } else {
                c.classList.remove('html-card-inspecting');
                c.shadowRoot?.querySelectorAll('.hc-hover').forEach(el =>
                    el.classList.remove('hc-hover')
                );
            }
        });

        // Pre-warm: open source leaf immediately so hover doesn't lag
        if (on) {
            const firstCard = document.querySelector('.html-card-container') as HTMLElement;
            if (firstCard?.dataset?.sourceFile) {
                this.ensureSourceLeaf(firstCard.dataset.sourceFile);
            }
        }
    }

    // ========================
    // Embed replacement (![[file.html]])
    // ========================

    private async replaceHtmlEmbed(embedEl: HTMLElement, src: string, id: number) {
        const linkPath = src || embedEl.getAttribute('alt') || '';
        const file = this.app.vault.getAbstractFileByPath(linkPath)
            || this.app.metadataCache.getFirstLinkpathDest(linkPath, '');

        if (!(file instanceof TFile)) return;

        await new Promise(r => setTimeout(r, 150));

        embedEl.empty();
        embedEl.style.display = 'block';
        embedEl.style.height = 'auto';
        embedEl.style.maxHeight = 'none';
        embedEl.style.overflow = 'visible';

        try {
            const content = await this.app.vault.read(file);
            const container = embedEl.createDiv({ cls: 'html-card-container' });

            let sourceFilePath = file.path;
            let lineOffset = 0;

            if (file.extension === 'md') {
                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    if (/^```html(?:-block|[- ]card)/.test(lines[i].trim())) {
                        lineOffset = i + 1;
                        break;
                    }
                }
                const match = content.match(/```html(?:-block|[- ]card)\s*\n([\s\S]*?)```/);
                if (match) {
                    this.renderHtmlContent(match[1], container, sourceFilePath, lineOffset);
                }
            } else {
                this.renderHtmlContent(content, container, sourceFilePath, 0);
            }

            // Guard against Obsidian re-inserting iframe
            const guard = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    m.addedNodes.forEach(node => {
                        if (node instanceof HTMLElement && !node.classList.contains('html-card-container')) {
                            node.remove();
                        }
                    });
                }
            });
            guard.observe(embedEl, { childList: true });
            this.embedGuards.push(guard);
        } catch (e) {
            console.error(`[html-card] embed #${id}: render failed`, e);
        }
    }

    // ========================
    // Code block processor
    // ========================

    async processHtmlCard(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
        el.empty();
        const container = el.createDiv({ cls: 'html-card-container' });

        try {
            let sourceFilePath = ctx.sourcePath;
            let lineOffset = 0;

            const wikiLinkMatch = source.trim().match(/^\[\[(.+?)\]\]$/);
            if (wikiLinkMatch) {
                const linkText = wikiLinkMatch[1];
                const sourceFile = this.app.metadataCache.getFirstLinkpathDest(linkText, ctx.sourcePath);
                if (sourceFile && sourceFile instanceof TFile) {
                    const fileContent = await this.app.vault.read(sourceFile);
                    sourceFilePath = sourceFile.path;

                    if (sourceFile.extension === 'md') {
                        const lines = fileContent.split('\n');
                        for (let i = 0; i < lines.length; i++) {
                            if (/^```html(?:-block|[- ]card)/.test(lines[i].trim())) {
                                lineOffset = i + 1;
                                break;
                            }
                        }
                        const match = fileContent.match(/```html[- ]card\s*\n([\s\S]*?)```/);
                        source = match ? match[1] : fileContent;
                    } else {
                        source = fileContent;
                    }
                } else {
                    throw new Error(`File not found: [[${linkText}]]`);
                }
            } else {
                const sectionInfo = ctx.getSectionInfo(el);
                if (sectionInfo) {
                    lineOffset = sectionInfo.lineStart + 1;
                }
            }

            this.renderHtmlContent(source, container, sourceFilePath, lineOffset);
        } catch (error) {
            container.empty();
            const d = container.createDiv();
            Object.assign(d.style, {
                display: 'block', color: 'red',
                border: '1px solid red', padding: '10px', fontFamily: 'sans-serif'
            });
            d.innerText = "Error: " + String(error);
        }
    }

    // ========================
    // Core renderer
    // ========================

    private renderHtmlContent(source: string, hostEl: HTMLElement, sourceFilePath?: string, lineOffset?: number) {
        const shadow = hostEl.attachShadow({ mode: 'open' });

        if (sourceFilePath) hostEl.dataset.sourceFile = sourceFilePath;
        if (lineOffset !== undefined) hostEl.dataset.lineOffset = String(lineOffset);

        // 1. Reset + inspect styles
        const style = document.createElement('style');
        style.textContent = `
            :host {
                display: block; width: 100%; background-color: white; color: black;
                font-family: Times, serif; font-size: 16px; line-height: normal;
                margin: 0; padding: 0;
                border: 1px solid var(--background-modifier-border, #e0e0e0);
                border-radius: 6px;
                text-decoration: none; text-align: left;
                vertical-align: baseline; letter-spacing: normal; word-spacing: normal;
                text-transform: none; text-indent: 0;
            }
            html, body { display: block; margin: 8px; padding: 0; width: auto; height: auto; }
            head, meta, title, link, script { display: none; }
            div { display: block; } span { display: inline; }
            p { display: block; margin: 1em 0; }
            strong, b { font-weight: bold; } em, i { font-style: italic; }
            a { color: -webkit-link; text-decoration: underline; cursor: pointer; }
            h1 { display: block; font-size: 2em; margin: 0.67em 0; font-weight: bold; }
            h2 { display: block; font-size: 1.5em; margin: 0.83em 0; font-weight: bold; }
            h3 { display: block; font-size: 1.17em; margin: 1em 0; font-weight: bold; }
            h4 { display: block; font-size: 1em; margin: 1.33em 0; font-weight: bold; }
            h5 { display: block; font-size: 0.83em; margin: 1.67em 0; font-weight: bold; }
            h6 { display: block; font-size: 0.67em; margin: 2.33em 0; font-weight: bold; }
            ul, menu, dir { display: block; list-style-type: disc; margin-block-start: 1em; margin-block-end: 1em; padding-inline-start: 40px; }
            ol { display: block; list-style-type: decimal; margin-block-start: 1em; margin-block-end: 1em; padding-inline-start: 40px; }
            li { display: list-item; }
            table { display: table; border-collapse: separate; border-spacing: 2px; }
            tr { display: table-row; } td, th { display: table-cell; padding: 1px; }
            thead { display: table-header-group; } tbody { display: table-row-group; }
            img { display: inline; max-width: 100%; }
            * { box-sizing: content-box; }

            /* Inspect: hover = outline + tinted background */
            :host(.html-card-inspecting) [data-source-line] {
                cursor: crosshair !important;
            }
            :host(.html-card-inspecting) [data-source-line].hc-hover {
                outline: 2px solid rgba(231, 76, 60, 0.7) !important;
                outline-offset: 1px;
                background: rgba(231, 76, 60, 0.06) !important;
            }
        `;
        shadow.appendChild(style);

        // 2. Inject data-source-line (skip style/script blocks)
        const lines = source.split('\n');
        let inBlock = false;
        const taggedLines = lines.map((line, i) => {
            const trimmed = line.trim();
            if (/<(style|script)[\s>]/i.test(trimmed)) inBlock = true;
            if (/<\/(style|script)>/i.test(trimmed)) { inBlock = false; return line; }
            if (inBlock) return line;
            return line.replace(
                /(<(?!\/|!|style|script)[a-zA-Z][^\s/>]*)([\s>])/i,
                `$1 data-source-line="${i + 1}"$2`
            );
        });

        // 3. :root → :host
        const processedSource = taggedLines.join('\n').replace(
            /(<style[^>]*>)([\s\S]*?)(<\/style>)/gi,
            (_, open, css, close) => open + css.replace(/:root\b/g, ':host') + close
        );

        // 4. Inject
        const template = document.createElement('template');
        template.innerHTML = processedSource;
        shadow.appendChild(template.content.cloneNode(true));

        // 5. Execute scripts inside a per-card scope.
        //    Scripts run with a `document` proxy whose element-lookup methods
        //    (getElementById / querySelector / ...) resolve against THIS card's
        //    shadowRoot, so inline code like `document.getElementById('x')` finds
        //    nodes that live in the shadow tree. Everything else falls through to
        //    the real document. Each card executes in its own Function scope, so
        //    top-level vars in one card never collide with another card.
        this.executeScripts(shadow);

        // 6. Inspect mode: hover → scroll source, click → persist
        //    Skip for .html files (can't open as editable source in Obsidian)
        const sourceFile = sourceFilePath || '';
        if (sourceFile.endsWith('.html') || sourceFile.endsWith('.htm')) return;

        let hoverDebounce: ReturnType<typeof setTimeout> | null = null;

        shadow.addEventListener('mouseover', (e: Event) => {
            if (!this.inspectMode) return;
            const target = (e.target as HTMLElement).closest?.('[data-source-line]') as HTMLElement;
            if (!target) return;

            shadow.querySelectorAll('.hc-hover').forEach(el => el.classList.remove('hc-hover'));
            target.classList.add('hc-hover');

            if (hoverDebounce) clearTimeout(hoverDebounce);
            hoverDebounce = setTimeout(() => {
                const sourceLine = parseInt(target.dataset.sourceLine || '0');
                const filePath = hostEl.dataset.sourceFile || '';
                const offset = parseInt(hostEl.dataset.lineOffset || '0');
                this.scrollSourceToLine(filePath, offset + sourceLine - 1);
            }, 80);
        });

        shadow.addEventListener('mouseleave', () => {
            shadow.querySelectorAll('.hc-hover').forEach(el => el.classList.remove('hc-hover'));
            if (hoverDebounce) clearTimeout(hoverDebounce);
        });

        // Click: use hostEl handler with composedPath() to reach shadow DOM targets.
        // Also block on embed parent to prevent Obsidian "open file" behavior.
        const embedParent = hostEl.closest?.('.internal-embed');

        const handleInspectClick = (e: MouseEvent) => {
            if (!this.inspectMode) return;
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            // composedPath() gives us the original target chain INSIDE the shadow DOM
            const path = e.composedPath() as HTMLElement[];
            let lineEl: HTMLElement | null = null;
            for (const el of path) {
                if (el.dataset?.sourceLine) {
                    lineEl = el;
                    break;
                }
                if (el === hostEl) break;
            }
            if (!lineEl) return;

            const sourceLine = parseInt(lineEl.dataset.sourceLine || '0');
            const filePath = hostEl.dataset.sourceFile || '';
            const offset = parseInt(hostEl.dataset.lineOffset || '0');
            const absLine = offset + sourceLine - 1;

            this.selectSourceLine(filePath, absLine);
            // Auto-exit inspect mode after click
            this.setInspectMode(false);
        };

        hostEl.addEventListener('click', handleInspectClick, true);
        if (embedParent) {
            embedParent.addEventListener('click', handleInspectClick, true);
        }
    }

    // ========================
    // Script execution (per-card sandbox)
    // ========================

    /**
     * Build a `document` proxy for a card. Element-lookup methods resolve against
     * the card's shadowRoot; everything else falls through to the real document.
     * This lets inline scripts that use bare `document.getElementById(...)` find
     * nodes that actually live inside the shadow tree.
     */
    private makeDocumentProxy(shadow: ShadowRoot): Document {
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
     * against this card's shadowRoot. Each card gets its own scope, so top-level
     * vars never collide between cards.
     *
     * Only inline scripts (the code the user wrote in the note) are executed.
     * External scripts (`<script src="...">`) are intentionally NOT fetched or run:
     * loading and executing remote code would be a security risk and is disallowed.
     */
    private executeScripts(shadow: ShadowRoot) {
        const docProxy = this.makeDocumentProxy(shadow);
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
                // Each card gets its own Function scope, so top-level vars are
                // isolated between cards (no global-namespace collisions).
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

    // ========================
    // Source navigation (right sidebar)
    // ========================

    /** Wait for editor to be available on a leaf */
    private waitForEditor(leaf: WorkspaceLeaf, timeout = 1000): Promise<any> {
        return new Promise((resolve) => {
            const check = () => {
                const editor = (leaf.view as any)?.editor;
                if (editor) return resolve(editor);
                if (timeout <= 0) return resolve(null);
                timeout -= 50;
                setTimeout(check, 50);
            };
            check();
        });
    }

    /** Scroll source to line and highlight it (hover behavior) */
    private async scrollSourceToLine(filePath: string, line: number) {
        const leaf = await this.ensureSourceLeaf(filePath);
        if (!leaf) return;
        const editor = await this.waitForEditor(leaf);
        if (editor) {
            editor.scrollIntoView(
                { from: { line: Math.max(0, line - 5), ch: 0 }, to: { line: line + 5, ch: 0 } },
                true
            );
            // Select the full line for visual highlight
            const lineLen = editor.getLine(line)?.length || 0;
            editor.setSelection({ line, ch: 0 }, { line, ch: lineLen });
        }
    }

    /** Select (highlight) a specific line in source (click behavior) */
    private async selectSourceLine(filePath: string, line: number) {
        const leaf = await this.ensureSourceLeaf(filePath);
        if (!leaf) return;
        // Focus the leaf so editor operations work
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
        const editor = await this.waitForEditor(leaf);
        if (editor) {
            const lineLen = editor.getLine(line)?.length || 0;
            editor.setCursor({ line, ch: 0 });
            editor.scrollIntoView(
                { from: { line: Math.max(0, line - 5), ch: 0 }, to: { line: line + 5, ch: 0 } },
                true
            );
            editor.setSelection({ line, ch: 0 }, { line, ch: lineLen });
            editor.focus();
        }
    }

    /** Ensure the source file is open in right sidebar, in editing mode. Reuse leaf. */
    private async ensureSourceLeaf(filePath: string): Promise<WorkspaceLeaf | null> {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) return null;

        // Validate existing inspect leaf
        if (this.inspectLeaf) {
            // Check if leaf still exists in workspace
            let found = false;
            this.app.workspace.iterateAllLeaves(l => {
                if (l === this.inspectLeaf) found = true;
            });
            if (!found) this.inspectLeaf = null;
        }

        // Create in right sidebar if no leaf
        if (!this.inspectLeaf) {
            this.inspectLeaf = this.app.workspace.getRightLeaf(false);
            if (!this.inspectLeaf) return null;
        }

        // Open file if different
        const currentFile = (this.inspectLeaf.view as any)?.file;
        if (!currentFile || currentFile.path !== filePath) {
            await this.inspectLeaf.openFile(file, { state: { mode: 'source', source: true } });
            // Wait for view to initialize
            await new Promise(r => setTimeout(r, 200));
        }

        // Ensure right sidebar is expanded
        const rightSplit = (this.app.workspace as any).rightSplit;
        if (rightSplit?.collapsed) {
            rightSplit.toggle();
        }

        // Reveal (activate) the tab in the sidebar
        this.app.workspace.revealLeaf(this.inspectLeaf);

        // Ensure editing/source mode (not preview)
        const view = this.inspectLeaf.view as any;
        const state = view?.getState?.();
        if (state && (state.mode !== 'source' || !state.source)) {
            state.mode = 'source';
            state.source = true;
            await view.setState(state, { history: false });
            await new Promise(r => setTimeout(r, 200));
        }

        return this.inspectLeaf;
    }

    onunload() {
        this.observer?.disconnect();
        this.observer = null;
        this.embedGuards.forEach(g => g.disconnect());
        this.embedGuards = [];
        this.inspectMode = false;
        if (this.escHandler) {
            document.removeEventListener('keydown', this.escHandler);
        }
        this.inspectStyleEl?.remove();
    }
}
