# site/ — the Insid marketing page

The public one-pager (problem → solution → proof → under the hood → market →
scale), plus the "behind the scenes" page it links to.

| file | what |
|------|------|
| `index.html` | the page itself — self-contained, no build step |
| `logo.svg` | **the company mark. Change this file, and every mark on the page changes.** |

"Behind the scenes" used to live here as `fun-facts.html`; it now has its own
directory and its own deploy at `behind/` — see **Hosting** below.

## Changing the logo

Replace `site/logo.svg` with your own. That one file feeds:

- the ~24 floating marks scattered through the sections
- the small mark above the wordmark in the hero
- the browser-tab favicon

Two things to keep in the file so it drops straight in:

- **a `viewBox`** — any dimensions; the page scales to whatever you give it
- **`currentColor`** for the ink (`stroke="currentColor"` / `fill="currentColor"`),
  so the floating marks can still be cyan in some places and amber in others

The `color="..."` on the root `<svg>` is only the standalone fallback — what
`currentColor` resolves to when the file is rendered on its own, i.e. the
favicon. The page ignores it and supplies its own colour per sticker.

If your logo has baked-in brand colours instead of `currentColor`, it still
works — it just won't recolour per sticker.

### How it works

`index.html` defines the mark once as an SVG `<symbol id="logo-mark">`, and
every mark on the page is a `<use href="#logo-mark">`. On load, a script
fetches `logo.svg` and swaps it into that symbol, so all of them follow.

The `<symbol>` in the HTML is the built-in fallback: if `logo.svg` is missing
or won't parse, the page keeps the default arrow rather than losing its marks.
That means a broken logo file fails quietly — if a change doesn't seem to take,
check the browser console, and hard-refresh in case `logo.svg` is cached.

## Run it

Any static server — the `logo.svg` fetch needs HTTP, so opening `index.html`
straight off disk will fall back to the built-in mark.

```
cd site && python3 -m http.server 8790
```

## Hosting

Three static sites on Render, defined in `render.yaml` at the repo root. Each
has its own `rootDir`, so a push only redeploys the services whose files
actually changed.

| what | directory | URL |
|------|-----------|-----|
| marketing one-pager | `site/` | https://insid.onrender.com |
| indoor path vis | `web/` | https://insid-vis.onrender.com |
| behind the scenes | `behind/` | https://insid-behind.onrender.com |

Those URLs are referenced in three places — two `href`s in `site/index.html`
(marked by a comment near the top) and the back-link in `behind/index.html`.
If a Render service ends up with a different name, fix those.

### First-time setup (one manual pass, in the Render dashboard)

1. Render → **New → Blueprint**
2. Connect the `alexacchang/hackcmu` repo and pick `main`
3. Render reads `render.yaml` and offers all three sites — **Apply**

After that, every push to `main` deploys automatically.

### The Claude Artifact

There is also a copy of the marketing page published as an artifact:

    https://claude.ai/code/artifact/cb2b2dc6-dcd5-4046-a151-832b44e100be

It is a **separate copy** — editing this directory does not update it, and it
does not update this directory. Once Render is live, that artifact is redundant
for anything but quick previews.
