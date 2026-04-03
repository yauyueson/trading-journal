# Trading Journal — UI/UX Design System

> Fey-inspired dark trading dashboard aesthetic. Built with React 18 + Tailwind CSS + Framer Motion.
> Last updated: 2026-04-02.

---

## Design Philosophy

**"Content dictates width, not the viewport."**

This is a data-dense trading tool. Every design decision serves information density without sacrificing clarity. The aesthetic draws from [Fey](https://fey.com) — described as "the most beautiful web app" — adapted for options trading workflows.

### Core Principles

1. **Gray body, white emphasis** — body text is muted gray; white is reserved for headings and key data
2. **Minimal cards** — content sits on the page background; cards only for interactive/elevated elements
3. **Razor-thin borders** — 0.5px, not 1px; barely there, never heavy
4. **Multi-column density** — sidebars for controls, main area for data; nothing runs full-width
5. **Snappy interactions** — 0.1s hover, no card lift; subtle bg/border shift only
6. **Ambient depth** — radial gradient background, floating blur orbs, noise texture

---

## Color Palette

### Background

| Token | Value | Usage |
|-------|-------|-------|
| `bg-primary` | `#000000` | Login, loading screens |
| Body base | `#0A0A0E` | App background (slight blue tint, not pure black) |
| `bg-secondary` | `#0D0D0D` | Legacy fallback |
| `bg-tertiary` | `#1A1A1A` | Input panels, sidebar cards |
| `bg-elevated` | `#242424` | Highest solid elevation |

### Text

| Token | Value | Usage |
|-------|-------|-------|
| `text-primary` | `#E6E6E6` | Headings, emphasis, key data — NOT body text |
| `text-secondary` | `#868F97` | **Default body text** (Fey gray) |
| `text-tertiary` | `#6B6B6B` | Labels, timestamps, metadata |
| True white | `#FFFFFF` | h1-h6 headings, stat values, input text |

**Rule:** Body defaults to `text-secondary` (#868F97). Only headings (`h1`-`h6`), stat values, and input text use white. This creates the visual hierarchy — white draws the eye to what matters.

### Accents

| Token | Hex | Usage |
|-------|-----|-------|
| `accent-green` | `#4EBE96` | Profit, bull signals, primary CTA, active states |
| `accent-red` | `#FF6B6B` | Loss, bear signals, danger |
| `accent-blue` | `#479FFA` | Info, links, progress bars |
| `accent-yellow` | `#FFD60A` | Warnings, time-based exits |
| `accent-coral` | `#FFA16C` | Risk indicators, warm highlights |

**Dim variants:** Every accent has a `Dim` token at 12% opacity for badge/pill backgrounds:

| Token | Value | Usage |
|-------|-------|-------|
| `accent-greenDim` | `#4EBE9620` | Win badges, bull backgrounds |
| `accent-redDim` | `#FF6B6B20` | Loss badges, bear backgrounds |
| `accent-yellowDim` | `#FFD60A20` | Warning badges |
| `accent-blueDim` | `#479FFA20` | Info badges |
| `accent-coralDim` | `#FFA16C20` | Risk indicator backgrounds |

### Chart Colors

| Context | Color |
|---------|-------|
| Equity curve / P&L positive | `#4EBE96` |
| P&L negative | `#FF6B6B` |
| Gradient fill | Same color, opacity 0.2 → 0 |
| Grid lines | `rgba(255,255,255,0.04)` |
| Axis text | `#666` at 11px |

---

## Typography

| Property | Value |
|----------|-------|
| Font family (body) | DM Sans, system-ui, sans-serif |
| Font family (data) | DM Mono, monospace |
| Base line-height | 1.4 |
| Font smoothing | antialiased + grayscale |
| Numeric rendering | `font-variant-numeric: tabular-nums` (globally) |
| Feature settings | `'ss01' on, 'ss02' on` |

### Scale

| Class | Size | Weight | Usage |
|-------|------|--------|-------|
| `.hero-number` | `clamp(1.75rem, 6vw, 3.375rem)` | 700 | Portfolio value, P&L |
| `h1` / `.page-header` | 18-20px | 600 | Page titles |
| Body | 14-16px | 400 | Default content |
| `.metric-label` | 11px | 400 | Uppercase tracking labels |
| Stat label | 9-10px | 600 | `uppercase tracking-[0.15em]` |
| Fine print | 10px | 400 | Timestamps, notes |

### Gradient Text

```css
.text-gradient-primary { background: linear-gradient(135deg, #FFFFFF, #868F97); }
.text-gradient-green { background: linear-gradient(135deg, #6EEDB4, #4EBE96); }
```

Used sparingly — header logo, positive P&L hero number.

---

## Surfaces & Cards

### Philosophy

**Cards are the exception, not the rule.** Most content sits directly on the page background with subtle line dividers (`border-b border-white/[0.04]`). Cards are reserved for:
- Interactive containers (position cards, spread recommendations)
- Elevated panels (modals, sidebars)
- Grouped inputs (settings panels)

### Card Hierarchy

| Class | Background | Blur | Border | Usage |
|-------|-----------|------|--------|-------|
| `.card` | `rgba(200,200,220, 0.05)` | `blur(20px) saturate(1.2)` | `0.5px rgba(255,255,255,0.1)` | Default surface |
| `.card-glass` | `rgba(200,200,220, 0.06)` | `blur(24px) saturate(1.3)` | `0.5px rgba(255,255,255,0.1)` | Dashboard hero, signal tables |
| `.card-elevated` | `rgba(200,200,220, 0.07)` | `blur(24px) saturate(1.3)` | `0.5px rgba(255,255,255,0.12)` | Raised panels |
| `.card-glass-elevated` | `rgba(200,200,220, 0.08)` | `blur(32px) saturate(1.4)` | `0.5px rgba(255,255,255,0.14)` | Modals |

### Signature Inset Highlight (Fey)

Every card has a directional inset shadow creating a "lit from top-left" effect:

```css
box-shadow:
    inset 0.5px 0.5px 0.5px rgba(255, 255, 255, 0.2),   /* top-left highlight */
    inset 0.5px -0.5px 0.5px rgba(255, 255, 255, 0.04),  /* bottom-left subtle */
    0px 6px 4px rgba(0, 0, 0, 0.04),                      /* soft close shadow */
    0px 16px 8px rgba(0, 0, 0, 0.07),                     /* medium shadow */
    0px 30px 16px rgba(0, 0, 0, 0.12);                    /* distant shadow */
```

### Semantic Card Variants

Each semantic card uses 0.5px `rgba()` borders (not hex) with a matching inset highlight — same pattern as glass cards:

| Class | Tint Color | Border | Inset Highlight | Context |
|-------|-----------|--------|-----------------|---------|
| `.card-danger` | `rgba(255,107,107, 0.06)` | `0.5px rgba(255,107,107, 0.19)` | `rgba(255,107,107, 0.1)` | Losing positions |
| `.card-warning` | `rgba(255,214,10, 0.06)` | `0.5px rgba(255,214,10, 0.15)` | `rgba(255,214,10, 0.08)` | Warnings |
| `.card-success` | `rgba(78,190,150, 0.06)` | `0.5px rgba(78,190,150, 0.15)` | `rgba(78,190,150, 0.08)` | Winning positions |
| `.card-earnings` | `rgba(168,85,247, 0.06)` | `0.5px rgba(168,85,247, 0.25)` | `rgba(168,85,247, 0.1)` + glow | Earnings proximity |
| `.card-earnings-soon` | `rgba(59,130,246, 0.06)` | `0.5px rgba(59,130,246, 0.19)` | `rgba(59,130,246, 0.08)` | Upcoming earnings |

---

## Borders & Dividers

| Element | Value | Usage |
|---------|-------|-------|
| Card border | `0.5px solid rgba(255,255,255,0.1)` | Card edges |
| Section divider | `border-b border-white/[0.06]` | Between major sections |
| Row divider | `border-b border-white/[0.04]` | Between list items |
| Input border | `0.5px solid rgba(255,255,255,0.1)` | Form inputs |
| **Never use** | `1px` borders, solid hex borders | Too heavy |

---

## Background & Depth

### Radial Gradient (body::before)

Four overlapping radial gradients on `#0A0A0E` base:

```css
radial-gradient(ellipse 90% 60% at 50% -15%, rgba(78, 190, 150, 0.22), transparent 55%),  /* green top */
radial-gradient(ellipse 70% 50% at 85% 55%, rgba(71, 159, 250, 0.12), transparent 50%),   /* blue right */
radial-gradient(ellipse 60% 55% at 15% 75%, rgba(168, 85, 247, 0.08), transparent 50%),   /* purple left */
radial-gradient(ellipse 50% 40% at 50% 100%, rgba(255, 161, 108, 0.06), transparent 50%)  /* coral bottom */
```

### Noise Texture (body::after)

SVG fractal noise at 3% opacity, `z-index: 10`, `pointer-events: none`. Adds film grain texture.

### Ambient Glow Orbs (.ambient-glow)

Two animated `::before`/`::after` pseudo-elements with `blur(80px)`:
- Green orb (top-left): `rgba(78, 190, 150, 0.05)`, 12s float animation
- Blue orb (right): `rgba(71, 159, 250, 0.04)`, 15s float animation (reverse)

Sized with `min(500px, 80vw)` to prevent mobile overflow.

---

## Layout

### Content Width

All pages constrained to `max-w-7xl` (80rem = 1280px) via AppLayout.

### Two-Column Pattern

Every data page uses a sidebar + main layout at `lg:` breakpoint (1024px):

| Page | Sidebar | Main | Ratio |
|------|---------|------|-------|
| Dashboard | Signals, capital | P&L chart, positions | 5/12 : 7/12 |
| Spread Builder | Ticker, settings, DTE, direction | Results, recommendations | 1/3 : 2/3 |
| Portfolio | Filters, settings | Position cards | 1/4 : 3/4 |
| History | P&L stats, filters | Trade list | 1/3 : 2/3 |
| Stats | Vertical tabs, filters | Charts, breakdowns | w-48 : flex-1 |
| Signals | Bull column | Bear column | 1/2 : 1/2 |

Sidebar is `lg:sticky lg:top-20 lg:self-start` — stays visible while scrolling main content.

Mobile (`< lg`): single column, sidebar content stacks above main.

### Spacing

| Context | Value |
|---------|-------|
| Page top padding | `pt-4` mobile, `pt-10` desktop |
| Section gap | `gap-6` to `gap-8` |
| Card padding | `p-4` to `p-6` |
| Column gap | `gap-6 lg:gap-8` |
| Bottom nav clearance | `calc(5.5rem + env(safe-area-inset-bottom))` |

---

## Interactions

### Hover (Desktop Only)

| Element | Behavior | Speed |
|---------|----------|-------|
| Cards | `background` brightens to `rgba(200,200,220, 0.08)`, `border-color` to `rgba(255,255,255,0.14)` | `0.15s ease` |
| Buttons | Background shift only | `0.1s ease` |
| Inputs | `border-color` brightens to `rgba(255,255,255,0.16)` | `0.15s ease` |
| List rows | `bg-white/[0.02]` | CSS transition |
| **Never** | `translate-y` lift on hover | — |

### Active Press (All Devices)

All buttons and action items scale down on press for tactile feedback:

```css
.btn-primary:active,
.btn-secondary:active,
.btn-danger:active,
.action-btn:active {
    transform: scale(0.97);
}
```

This is distinct from hover — press feedback is allowed, hover lift is not.

### Touch (Mobile)

| Property | Value |
|----------|-------|
| Touch targets | Minimum 44x44px (`min-h-[44px]`) |
| Filter pills | Minimum 44px height (WCAG 2.5.5) |
| Tap highlight | Disabled (`-webkit-tap-highlight-color: transparent`) |
| Touch feedback | `.touch-feedback` = `active:opacity-80` |
| Bottom nav items | `min-w-[64px] min-h-[56px]` |
| Cursor | All buttons/pills use `cursor-pointer` explicitly |

---

## Animation

### Framer Motion (Page Transitions)

| Variant | Duration | Easing | Usage |
|---------|----------|--------|-------|
| `fadeUp` | 0.4s | `[0.25, 0.46, 0.45, 0.94]` (Fey ease-out) | Section entrance |
| `stagger` | 0.05s per child | — | Page load sequence |
| `staggerItem` | 0.35s | Fey ease-out | Individual items |
| `scaleIn` | 0.3s | Fey ease-out | Badges, modals |
| `slideRight` | 0.4s | Fey ease-out | Sidebar panels |

### CSS Animations

| Class | Duration | Usage |
|-------|----------|-------|
| `.fade-in` | 0.3s ease-out | Generic entrance |
| `.pulse-glow` | 2s infinite | Active signal dots |
| `.stagger-fade-in > *` | 0.4s, 50ms delay per child (up to 12 children) | Page section reveal |
| `.wipe-reveal` | 0.8s | Gradient text reveal for headings |
| `orbFloat` | 12-15s infinite | Background glow orbs |

### Reduced Motion

All animations respect `prefers-reduced-motion: reduce` — disabled via CSS `animation: none !important` and Framer Motion's built-in detection.

---

## Buttons

| Class | Background | Text | Hover | Usage |
|-------|-----------|------|-------|-------|
| `.btn-primary` | `accent-green` solid | Black | `#5ED4A6` | Primary CTA |
| `.btn-secondary` | `rgba(255,255,255,0.05)` | `#E6E6E6` | `rgba(255,255,255,0.08)` | Secondary actions (glass style) |
| `.btn-danger` | `accent-redDim` | `accent-red` | `rgba(255,107,107,0.12)` | Destructive actions |

All buttons: `0.5px` border, `0.1s ease` transition, `min-h-[44px]`, `cursor-pointer`, `disabled:cursor-not-allowed disabled:opacity-50`, `active:scale(0.97)`.

---

## Badges & Pills

| Class | Background | Text |
|-------|-----------|------|
| `.badge-green` | `#4EBE9620` | `#4EBE96` |
| `.badge-red` | `#FF6B6B20` | `#FF6B6B` |
| `.badge-blue` | `accent-blue/20` | `accent-blue` |
| `.badge-yellow` | `accent-yellow/20` | `accent-yellow` |
| `.badge-gray` | `white/10` | `text-secondary` |
| `.filter-pill` | `rgba(255,255,255,0.03)` | `text-tertiary` |
| `.filter-pill-active` | `rgba(255,255,255,0.08)` | White |

---

## Mobile (iPhone)

### Safe Areas

```css
#root { padding-top: env(safe-area-inset-top); }
.pb-safe { padding-bottom: calc(5.5rem + env(safe-area-inset-bottom)); }
.pb-safe-nav { padding-bottom: calc(4px + env(safe-area-inset-bottom)); }
```

### Header

- Mobile: `bg-[#0A0A0E]/90 backdrop-blur-md` (solid, matches body, blurs on scroll)
- Desktop: `bg-black/40 backdrop-blur-2xl` (glass, shows gradient)
- Border: `border-white/[0.08]` (visible but subtle)

### Bottom Navigation

- Fixed, `z-50`, `bg-[#0A0A0E]/95 backdrop-blur-xl`
- 8 tabs, horizontally scrollable, active tab has green dot with `pulse-glow`
- Icons only on mobile (22px), text labels hidden

### iOS-Specific

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#0A0A0E">
```

**Autofill styling:** iOS Safari autofill is overridden to prevent bright yellow/white flash:
```css
input:-webkit-autofill {
    -webkit-box-shadow: 0 0 0 1000px #0A0A0E inset !important;
    -webkit-text-fill-color: #FFFFFF !important;
}
```

---

## Z-Index Scale

| Layer | Z-Index | Elements |
|-------|---------|----------|
| Background gradient | -1 | `body::before` |
| Noise texture | 10 | `body::after` |
| Content | auto | Page content |
| Header | 50 | Sticky header |
| Bottom nav | 50 | Mobile tab bar |
| Modals | 100 | SpreadPickerModal, RollModal |

---

## Accessibility

### WCAG 2.1 AA Compliance

| Requirement | Implementation |
|-------------|---------------|
| Color contrast | `text-tertiary` (#6B6B6B) on `#0A0A0E` = 4.7:1 (passes AA) |
| Focus indicators | `ring-2 ring-accent-green ring-offset-2 ring-offset-bg-primary` on `:focus-visible` |
| Touch targets | All interactive elements `min-h-[44px]` (WCAG 2.5.5) |
| Reduced motion | `@media (prefers-reduced-motion: reduce)` disables all animations |
| Modal semantics | `role="dialog" aria-modal="true" aria-label="..."` on all modals |
| Icon buttons | `aria-label` on every button with only an icon child |
| Tab navigation | `aria-current="page"` on active tab, `aria-label` on nav |
| Color-scheme | `<meta name="color-scheme" content="dark">` for native dark controls |

### Rules

- Color must never be the sole indicator — always pair with text, icons, or shape
- All `<button>` elements with only icons must have `aria-label`
- Modals must have `role="dialog"`, `aria-modal="true"`, and a descriptive `aria-label`
- Form inputs must have associated `<label>` elements

---

## Design Tokens (Tailwind Config)

All colors, shadows, and spacing should use Tailwind config tokens — never hardcode hex values in components.

### Color Token Mapping

| Hardcoded Hex | Use Instead |
|---------------|-------------|
| `#222`, `#2C2C2E`, `#252528` | `bg-bg-tertiary` |
| `#111`, `#0D0D0D` | `bg-bg-secondary` |
| `#000` | `bg-bg-primary` |
| `#333`, `#3A3A3C`, `#444` | `border-white/[0.1]` or `border-white/[0.14]` |
| `#888`, `#999`, `#A3A3A3`, `#8E8E93` | `text-text-secondary` |
| `#555`, `#666` | `text-text-tertiary` |
| `#E0E0E0`, `#E6E6E6` | `text-text-primary` |

### Extended Tokens

```js
// tailwind.config.js
borderWidth: { '0.5': '0.5px' },  // Tailwind utility for 0.5px borders
boxShadow: {
  'glow-green': '...',  'glow-red': '...',
  'glow-blue': '...',   'glow-yellow': '...',
  'glow-coral': '...',  // All accent colors have glow variants
},
```

---

## Anti-Patterns (Don't Do This)

| Don't | Do Instead |
|-------|-----------|
| `1px` borders | `0.5px` borders |
| `#FFFFFF` body text | `#868F97` body, `#FFFFFF` headings only |
| Full-width content on desktop | Two-column layout with sidebar |
| Card for every section | Direct-on-page with subtle dividers |
| `translate-y` card lift on hover | Background/border opacity shift |
| `0.3s+` hover transitions | `0.1s ease` (snappy) |
| `background-attachment: fixed` | `body::before` pseudo-element |
| Solid hex border colors | `rgba()` with low opacity |
| Hardcoded hex in components | Use Tailwind design tokens (see table above) |
| Emojis as icons | Lucide React SVG icons |
| `z-index: 9999` | Use the defined z-index scale |
| Missing `cursor-pointer` on buttons | All interactive elements get `cursor-pointer` |
| Missing `aria-label` on icon buttons | Every icon-only button needs `aria-label` |
| Default cursor on clickable cards | Add `cursor-pointer` when `onClick` exists |

---

## Reference

- **Inspiration:** [Fey](https://fey.com) by Narrow Labs (acquired by Wealthsimple)
- **Stack:** React 18 + Vite 5 + Tailwind CSS + Framer Motion + Recharts
- **Fonts:** [DM Sans](https://fonts.google.com/specimen/DM+Sans) + [DM Mono](https://fonts.google.com/specimen/DM+Mono)
- **Icons:** [Lucide React](https://lucide.dev)
