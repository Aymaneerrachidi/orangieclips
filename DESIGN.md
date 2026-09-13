# Full frontend rebuild

The user rejected the previous frontend and authorized a complete visual rebuild. They delegated the visual direction. The chosen direction is a dark media workspace with warm orange accents and large video previews.

## Design system

- Typography: locally bundled Outfit Variable for headings and clip titles; Geist Variable for controls, metadata, and forms.
- Palette: background `#101216`, surfaces `#181b20` and `#20242a`, primary text `#eeeef0`, secondary text `#a1a6af`, accent `#f6a36b`, structural lines `#30343c`.
- Navigation: full-width horizontal header replaces the fixed application sidebar. It exposes only the user's authorized destinations.
- Library: compact date rail, full-month hover browsing, recent drops, and a wide two/three-column video gallery. Every clip has a large playable preview, review status, author, original size, and direct original download. The All clips view browses the user's complete permitted archive.
- Review: a large player beside the original download and review form. Mobile stacks these vertically.
- Analytics: enlarged figures, wide interactive delivery chart, contrasting workflow summary, day inspection, and contributor table, all using real role-scoped data.
- Team: a collapsible role guide beside the member-management workspace. Role cards use native buttons with expanded state and controlled content.
- Login: oversized editorial typography, restrained warm lighting, and a dedicated sign-in surface. Account and upload forms use the same dark system.
- Motion: GSAP transitions for navigation and responsive video hover feedback. Reduced-motion settings are respected. UI content remains immediately available; no pinned marketing sections impede clip access.

## Skill application

The requested gpt-taste and frontend-design skills were read. Their visual planning, typography, spacing, varied composition, and motion guidance informed the rebuild. A seeded Python selection chose Outfit and explored cinematic composition; the functional product layout was then grounded in the user's overriding need for immediate date preview and downloading. Marketing-only AIDA sales sections and scroll-pinning are not added to the workspace.

## Verification

Playwright verifies all roles, uploads, date hovering, archive browsing, playback, downloads, reviews, analytics, exports, access management, and mobile overflow. Automated accessibility checks cover login, library, review, analytics, and team. Captures in `artifacts/` use disposable test data. Existing accounts, uploads, server permissions, and statistics were preserved.
