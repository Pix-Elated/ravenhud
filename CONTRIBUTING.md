# Contributing to RavenHUD Website

Thank you for your interest in contributing to the RavenHUD website!

## Getting Started

1. Clone the repository
2. Run `./scripts/setup-hooks.sh` to install git hooks

## Development

This is a static website. To preview changes locally, you can use any local server:

```bash
# Python 3
cd docs && python -m http.server 8000

# Node.js (if you have npx)
npx serve docs

# Or just open docs/index.html in your browser
```

## Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/) with **recommended human-readable bodies** for user-facing changes.

Note: This repo uses **warning mode** - commits without bodies are allowed but you'll see a reminder.

### Format

```
type: short description

Human-readable explanation of what changed and why it matters to visitors.
This body is RECOMMENDED for feat, fix, and perf commits (50+ characters).

Co-Authored-By: Your Name <email@example.com>
```

### Commit Types

| Type | Description | Body Recommended |
|------|-------------|------------------|
| `feat` | New feature | **YES** |
| `fix` | Bug fix | **YES** |
| `perf` | Performance improvement | **YES** |
| `chore` | Maintenance | Optional |
| `docs` | Documentation changes | Optional |
| `style` | Formatting, whitespace | Optional |

### Example: Good Commit

```
feat: add animated demo GIFs to feature cards

Visitors can now see the app in action before downloading. Each feature
card on the homepage shows a looping preview of that feature.
```

### Example: Acceptable (But Could Be Better)

```
feat: add download counter
```
*Works, but would be better with a body explaining why visitors care*

### Why Bodies Matter

Commit messages feed into:
- Release notes
- Discord update announcements
- Changelog

When you write "Visitors can now...", you're directly writing for the people who use the website.

## Git Hooks

The repository uses a git hook to encourage good commit messages:

- **commit-msg**: Validates Conventional Commits format (warning mode - doesn't block)

Run `./scripts/setup-hooks.sh` to install hooks after cloning.

## Deployment

Changes to `docs/` folder automatically deploy via GitHub Pages when pushed to `master`.

## Questions?

Open an issue or reach out on Discord.
