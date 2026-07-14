# HTML Blocks

Render live HTML, CSS and JavaScript directly inside your Obsidian notes. Write an `html-block` code fence and it renders in place — no need to create separate `.html` files.

Each block renders inside its own [Shadow DOM](https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_shadow_DOM), so its styles are fully isolated from your theme and from other blocks. You can drop in self-contained widgets, diagrams, styled cards, small interactive demos, and they render exactly as written.

## Usage

Write a fenced code block with the `html-block` language tag:

````markdown
```html-block
<div style="padding: 16px; border-radius: 8px; background: #f0f4ff;">
  <h3>Hello from HTML Blocks</h3>
  <p>This renders as real HTML, isolated in its own Shadow DOM.</p>
</div>
```
````

### CSS

Styles inside a block only affect that block. Use `:root` or `:host` to target the block container:

````markdown
```html-block
<style>
  :host { font-family: system-ui; }
  .badge { background: #10b981; color: white; padding: 4px 10px; border-radius: 99px; }
</style>
<span class="badge">Isolated styling</span>
```
````

### JavaScript

Inline `<script>` runs in an isolated scope. `document.getElementById(...)`, `querySelector(...)` and friends resolve against the current block, so simple scripts work as you'd expect:

````markdown
```html-block
<button id="btn">Clicked 0 times</button>
<script>
  let n = 0;
  const btn = document.getElementById('btn');
  btn.addEventListener('click', () => { btn.textContent = `Clicked ${++n} times`; });
</script>
```
````

Each block gets its own scope, so top-level variables in one block never collide with another.

### Rendering an external file

You can keep HTML in a separate file and embed it:

```markdown
![[my-widget.html]]
```

## Inspect mode

Run the **Toggle Inspect Mode** command (bindable to a hotkey). While active, hovering over a rendered element scrolls the source to the matching line, and clicking selects it — handy for finding which line produced which element. Press `Esc` to exit.

## Security model

This plugin executes the HTML, CSS and JavaScript **you** write in your own notes. That is the whole point of it — much like Dataview JS or Templater.

To keep that as safe as possible:

- **Only inline `<script>` is executed.** External scripts (`<script src="https://...">`) are **not** fetched or run. The plugin never downloads or executes remote code.
- Each block runs in an isolated Shadow DOM and its own function scope.

Only put HTML/JS you trust into your notes, the same way you would with any code you run.

## Installation

### From Community Plugins (once approved)

Settings → Community plugins → Browse → search **HTML Blocks** → Install → Enable.

### Manual

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/JWCzju/html-blocks/releases).
2. Copy them into `<your-vault>/.obsidian/plugins/html-blocks/`.
3. Reload Obsidian and enable the plugin in Settings → Community plugins.

## Support

If this plugin is useful to you, you can support development via [GitHub Sponsors](https://github.com/sponsors/JWCzju). Completely optional.

## License

[MIT](LICENSE) © Yinno
