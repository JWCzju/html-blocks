# Publishing HTML Blocks — read this before releasing to the community store

This plugin ships in **two builds from one source**. If you (or an AI assistant)
are about to "publish to the store" or "release a new version", read this first.

## TL;DR

- **You develop and use the `main` branch** — the *full* build. It runs inline
  `<script>` inside html-blocks (via `new Function`). This is what you install
  locally and use day to day.
- **The `store` branch is generated, never hand-edited** — the *store* build.
  It has JavaScript execution removed, because the Obsidian community store
  forbids dynamic code execution.
- **To release to the store, run one command from `main`:**
  ```bash
  npm run release:store -- <version>      # e.g. 1.0.1
  ```
  It builds the store-safe variant on the `store` branch, pushes it, creates the
  GitHub release, and **returns you to `main`**. You never leave `main` yourself.

## Why two builds?

The community store's automated review **rejects `eval` / `new Function`** and
does not allow suppressing that rule. Executing user-authored inline `<script>`
is a core feature of the *full* build (like Dataview JS / Templater), so the
full build can never pass store review.

Rather than cripple the plugin or maintain two copies, the entire difference
between the builds is isolated to a single file:

| File | Purpose |
| --- | --- |
| `scriptRunner.ts` | **Full build.** Runs inline `<script>` via `new Function`. |
| `scriptRunner.store.ts` | **Store build.** No-op stub — strips `<script>`, never executes. |

`main.ts` imports `runShadowScripts` from `./scriptRunner`. The release script
copies `scriptRunner.store.ts` over `scriptRunner.ts` on the `store` branch, so
the store build's source *and* compiled `main.js` contain no dynamic execution
at all. It's not hidden — it's genuinely absent.

## One-time GitHub setup (already done, but verify)

The directory scans the **default branch**. It must be **`store`**, not `main`,
so review sees the store-safe source:

```bash
gh repo edit JWCzju/html-blocks --default-branch store
```

`main` stays the development branch. Its `new Function` never faces the store
because the store only ever looks at `store`.

## The release flow, in full

`npm run release:store -- <version>` does all of this, then leaves you on `main`:

1. Verifies you're on `main` with a clean working tree.
2. Checks out `store` (creating it from `main` if needed) and merges `main` in.
3. Overwrites `scriptRunner.ts` with the `scriptRunner.store.ts` stub.
4. Sets `manifest.json` / `versions.json` to `<version>`.
5. Builds, then **hard-fails if `main.js` still contains `new Function`/`eval`**.
6. Commits + pushes the `store` branch.
7. Creates the GitHub release (tag = `<version>`, no `v` prefix) targeting `store`.
8. Checks back out to `main`.

## Developing normally

Just work on `main`. Build for local use with `npm run build` (outputs `main.js`
and syncs to your vault). You get the full JS-executing build locally. Only when
you want to push an update to the community store do you run `release:store`.

## First store submission

The GitHub side is automated by the script. The one manual step is the initial
directory submission at <https://community.obsidian.md> → Plugins → New plugin
(enter the repo URL, agree to the developer policy, submit). After that, new
versions go out via `release:store` and are picked up automatically.
