# Block Ledger — Product Requirements (v0.1)

**Status:** MVP scaffold
**One-liner:** A control plane over the WordPress block editor — governance, usage auditing, and safe lifecycle control. Not a block library.

## Problem
The block editor is a black box: 200+ blocks in an unsorted inserter, no idea what's used where, and removing/updating a block plugin can silently break existing posts (content is stored as HTML comments with no registry). Existing "disable blocks" plugins are raw toggles with no usage safety, and no one addresses de-lock-in.

## Product — four modules
1. **Observability / Audit** — usage index (`block → where used`) across posts, reusable blocks, FSE templates. *(MVP)*
2. **Governance / Policy** — allow/deny blocks globally or per post-type; lock editor settings per role. *(MVP)*
3. **Safe lifecycle (differentiator)** — retire a block by rendering in-use instances to static HTML + one-click restore snapshot. *(MVP)*
4. **Ergonomics / UX** — clean/sortable inserter, spotlight, block-tree navigator. *(Post-MVP)*

## MVP scope (this scaffold)
- Usage index table + `parse_blocks()` reindex (manual REST trigger + scheduled).
- Sidebar showing every block in use with item counts + "hide from inserter".
- Server-side `allowed_block_types_all` enforcement (deny-list = all minus denied).
- Safe retirement of a block → static HTML, with restore.

## Differentiation
| | Block Manager (4K) | Disable Unused (200) | **Block Ledger** |
|---|---|---|---|
| Usage-aware safety | No | Primitive | **Yes, transactional** |
| Safe de-lock-in | No | No | **Yes** |
| Per post-type/role policy | No | No | **Yes** |
| Ergonomics | No | No | Post-MVP |

## Monetization
Freemium on wordpress.org (no artificial gates in GPL code — Pro is a separate plugin / external flow). Pro tier: role/post-type policies UI, full-surface audit report, migration toolkit (extract from Elementor/Kadence lock-in). Primary customer: agencies running many client sites who fear breakage.

## Roadmap
- **P0 (MVP):** audit + policy + safe-retire. *(done as scaffold)*
- **P1:** ergonomics — clean inserter search/sort, spotlight/focus mode, block tree.
- **P2:** de-lock-in migration wizard (import → convert → verify → deactivate).
- **P3:** design-token enforcement via `blockEditor.useSetting.before` (watch core issue #76509 `register_design_token`).

## Risks
- Core may ship native block management / `register_design_token()` — build on, not against.
- `editor.*` internals shift per Gutenberg release → needs a WP-version CI matrix.
- `numberposts => -1` scan doesn't scale to huge sites; cursor-based reindex is P1 perf work.
- Nested static-ization normalizes whitespace — validate on staging first.

## Success metrics
- Activation → reindex completes < 5s on a 1,000-post site.
- "Retire block" round-trips losslessly on a staging copy (verified diff = 0 unintended changes).
- Free tier reaches 1K+ active installs as the distribution wedge.
