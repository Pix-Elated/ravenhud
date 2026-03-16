# RavenHUD Website

> Static site. No build tools, no npm, pure HTML/CSS/JS.
> Changes to `docs/` auto-deploy to GitHub Pages on push to `master`.

## Pre-Flight Checklist

```bash
git fetch origin && git branch --show-current && git status
```

No typecheck needed -- this is vanilla HTML/CSS/JS.

---

## Hard Rules

- **NEVER** commit to `master` directly for features -- create a branch and PR
- **NEVER** break accessibility (WCAG AA contrast, keyboard nav, ARIA labels)
- **NEVER** add CDN-loaded scripts -- vendored libraries in `docs/js/lib/` are OK when justified (e.g. Leaflet for the interactive map)
- **NEVER** hardcode version numbers -- the site fetches from GitHub API dynamically

---

## Architecture

```
docs/                    # GitHub Pages root (auto-deploys)
├── index.html           # Single-page site
├── css/style.css        # All styles (CSS custom properties)
├── js/
│   ├── main.js          # Core functionality (release fetch, lightbox, etc.)
│   ├── i18n.js          # 13-language translation system
│   └── lib/             # Vendored libraries (Leaflet, etc.)
├── assets/              # Images, GIFs, videos
├── demo/                # Interactive demo page
├── worldmap/            # Interactive community world map
└── auth/discord/        # OAuth2 callback
```

- **No build process** -- edit files directly, they deploy as-is
- **No npm/node** -- zero dependencies
- **i18n** -- translations in `js/i18n.js`, keys referenced in HTML via data attributes

---

## Design System

CSS custom properties in `docs/css/style.css`:

```css
--bg-primary: #1a1614      --text-primary: #e8dcc8
--accent-primary: #c9a959  --success: #7cb342
```

Use existing variables -- never hardcode colors. Warm fantasy theme (gold/brown, not purple).

---

## Git Workflow

```
feature-branch -> PR -> master -> auto-deploy (GitHub Pages)
```

Single branch model. All work targets `master`.
Commit format: `<type>: <description>` (no scope required for this repo).
Body **recommended** for feat/fix. Warning mode -- not enforced.

Setup hooks: `./scripts/setup-hooks.sh`

---

## CI/CD

| Workflow | Trigger | Action |
|----------|---------|--------|
| `deploy-pages.yml` | Push to master (docs/**) | Deploy to GitHub Pages |
| `discord-announce.yml` | Release published | Post to Discord webhook |
| `upload-asset.yml` | Manual dispatch | Upload build artifact to release |

---

## Local Preview

```bash
# Python
python -m http.server 8000 --directory docs

# Or Node (if available)
npx serve docs
```

Open `http://localhost:8000` in browser.

---

## When Uncertain

1. Check existing patterns in `docs/js/main.js`
2. Verify accessibility -- contrast, keyboard nav, ARIA
3. Test i18n -- does the new text have translation keys?
4. Preview locally before pushing
