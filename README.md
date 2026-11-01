# Block Ledger

**A control plane for the WordPress block editor — not another block library.**

Block *usage auditing*, *insertion governance*, and *safe lifecycle* for Gutenberg, in one lightweight plugin. Block Ledger sits **over** the editor: it adds no content blocks of its own. It answers three questions merchants actually care about — *what blocks am I using and where*, *which blocks may my editors insert*, and *can I remove a block without breaking my content*.

> The last one is the point. WordPress stores post content as `<!-- wp:block -->…</div>` HTML comments with **no registry**. When a block plugin updates, deactivates, or disappears, that content silently breaks. Block Ledger is the anti-lock-in answer: **retire** any block to portable static HTML, with a one-click **restore**.

## What it does, in plain language

Block Ledger sits inside the WordPress block editor and gives you three things:

- **Visibility** — see every block type your site uses, and how many times, in one list.
- **Governance** — stop editors from inserting blocks you don't want, without deleting existing content.
- **Safe removal** — convert a block to plain HTML so you can remove the block plugin without breaking pages, with one-click undo.

It adds **no content blocks** of its own. It is a control panel, not a block library.

---

## Why

The block-*library* category is a saturated red ocean (Spectra, Kadence Blocks, Extendify, CoBlocks, Otter, GenerateBlocks — ~90 tracked collections, ~480 "gutenberg"-tagged plugins). Nobody owns the **governance and observability** layer:

- **Data lock-in fear** — "if I uninstall that block plugin, will my pages survive?" Merchants hear "data lock-in" in every SaaS and assume WP is worse. It doesn't have to be.
- **Support silence** — "which plugin added this block?" with no audit trail.
- **Governance** — stopping editors from inserting blocks the theme can't style.

Block Ledger builds the under-served control plane.

---

## Features

### 1. Observability — usage audit
On activation it builds a usage index (`wp_block_ledger_usage`) by parsing **every** content surface with `parse_blocks()`: posts, pages, custom post types, reusable blocks (`core/block`), and FSE templates (`wp_template`, `wp_template_part`). The editor sidebar shows each block in use, how many items use it, sorted by frequency. Re-scans twice daily, or on demand with a **Reindex** button.

### 2. Governance — insertion policy
A server-side `allowed_block_types_all` filter gates what the inserter offers — **deny-list or allowlist**, global or **scoped per post type** (a custom inserter per content type, which wins over the global policy). Block names are validated to the `namespace/name` shape (a bare name is treated as `core/…`); anything else is dropped. Editor settings can be locked per role (`codeEditingEnabled`, `canUploadFiles`, `isRTL`, `hasFixedWidth`). A client-side `blocks.useBlockFilters` filter keeps the inserter UI honest between loads (defense-in-depth; the server filter is the real enforcement).

### 3. Safe lifecycle — retire & restore (the differentiator)
**Retire** a block type without breaking content:

1. Find every post using it.
2. Re-render each instance to **static HTML** via `render_block()`, stripping the `<!-- wp:… -->` markers so the markup survives the block's removal.
3. **Snapshot** the original before touching anything.

**Restore** brings the last snapshot back, losslessly, one click. This is the anti-lock-in core: it lets you uninstall a block plugin cleanly.

> Fidelity note: `render_block()` output can differ slightly from saved markup (e.g. added layout classes). Restore is the guaranteed safety net — always validate on a staging copy before retiring blocks inside whitespace-sensitive containers.

---

## Requirements

- WordPress 6.0+
- PHP 7.4+

---

## Install

**From a release zip** (recommended for a live site): download the plugin zip, then **Plugins → Add New → Upload Plugin**, install, activate. Activation creates the usage table and schedules the re-scan.

**From source:**

```bash
npm install      # install dev tooling (@wordpress/scripts)
npm run build    # compile src/ -> build/
```

Copy the `block-ledger` folder into `wp-content/plugins/` (or zip it and upload as above). The `build/` directory is required at runtime.

---

## Usage

Open any post/page in the block editor. The **Block Ledger** panel opens in the editor sidebar:

- **Reindex** — rescan all content now.
- **Block list** — each block with its use count (`12×`, `4 items`).
- **hide / hidden** — toggle the block out of (or back into) the inserter for your role.

### What "hide" does

When you click **hide** next to a block name, Block Ledger adds that block to a deny list. The server then removes it from the inserter for everyone, and the client-side filter removes it from the UI between page loads. Existing content is **not** touched — the block stays in posts that already use it. Clicking **hidden** reverses the deny and makes the block available again.

**How to test it:**

1. Open any post in the block editor.
2. In the Block Ledger panel, click **hide** next to a block you can see in the inserter (for example `core/quote`).
3. Click the **+ (Inserter)** button and search for that block — it should no longer appear.
4. Return to the Block Ledger panel and click **hidden** next to the same block.
5. Reopen the inserter — the block should be available again.
- **Per-post-type policy** *(admins only)* — choose which blocks each content type's inserter offers; overrides the global hide/allow for that type.
- **Retire** *(admins only)* — per-block, with a confirm step: convert every use to static HTML.
- **Restore** *(admins only)* — undo the last retire batch.

---

## REST API

Namespace `block-ledger/v1` (all under `wp-json/block-ledger/v1`):

| Method | Endpoint        | Capability      | Purpose                                  |
| ------ | --------------- | --------------- | ---------------------------------------- |
| `GET`  | `/usage`        | `read`          | `{ map: { 'core/image': { uses, items } } }` |
| `POST` | `/reindex`      | `manage_options`| Rebuild the usage index.                 |
| `GET`  | `/policy`       | `edit_posts`    | `{ denied, allowed, post_types, locks }`  |
| `POST` | `/policy`       | `manage_options`| Set `{ denied, allowed, post_types, locks }`. |
| `POST` | `/retire`       | `manage_options`| `{ block: 'core/quote' }` → static-ize every use. |
| `POST` | `/restore`      | `manage_options`| Restore the last snapshot.                |

---

## Development

```bash
npm run build     # compile the editor extension
npm run lint      # eslint
```

**Headless tests.** The riskiest code (parse_blocks audit, render_block static-ization, snapshot/restore round-trip, the policy filter) is covered by a headless smoke test against a real WordPress:

```bash
# requires a running WP + DB; see the test harness under the repo
wp eval-file test/ smoke-test.php
```

Lint every PHP file:

```bash
find . -name '*.php' -not -path './node_modules/*' -exec php -l {} \;
```

### Architecture

```
block-ledger.php              bootstrap, enqueue, activation/deactivation, REST ns
includes/
  class-block-ledger-audit.php    usage index (parse_blocks walk) + /usage, /reindex
  class-block-ledger-policy.php   allowed_block_types_all + editor locks + /policy
  class-block-ledger-safeswap.php retire/restore (render_block static-ization) + /retire, /restore
src/
  index.js                      registerPlugin sidebar + useBlockFilters hide-denied
```

---

## Roadmap

- **Reusable-block management** (governance/audit across the `core/block` reusable library).
- **Pro tier** (separate plugin / external purchase — never an in-code paywall, per the GPL): block-style libraries, theme.json enforcement, scheduled safe-migrations, bulk edit-undo.

The Pro tier is shipped as a **separate plugin or external checkout**, never as `if ( ! $paid ) return;` inside this GPL code.

---

## License

GPLv2 or later. See [LICENSE](LICENSE).
