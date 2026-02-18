---
paths:
  - "docs/**/*.html"
  - "docs/css/**"
  - "docs/js/**"
---

# Accessibility Rules (WCAG AA)

## Requirements

- Color contrast ratio >= 4.5:1 for all text
- All interactive elements must have `:focus-visible` styles
- ARIA labels on icon-only buttons and non-semantic elements
- Keyboard navigation works (Tab, Enter, Escape, Arrow keys)
- No information conveyed by color alone
- `prefers-reduced-motion` respected for animations
- Images must have meaningful alt text

## Testing

Check contrast with browser DevTools or https://webaim.org/resources/contrastchecker/
Tab through the page to verify focus order makes sense.
