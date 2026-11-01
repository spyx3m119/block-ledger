=== Block Ledger ===
Contributors:      yourname
Tags:              block-editor, gutenberg, editor, blocks, governance
Requires at least: 6.0
Tested up to:      6.7
Requires PHP:      7.4
Stable tag:        0.1.0
License:           GPLv2 or later
License URI:       https://www.gnu.org/licenses/gpl-2.0.html

Governance, usage auditing, and safe lifecycle control for the WordPress block editor.

== Description ==

Block Ledger is a **control plane over the block editor** — not another block library. It answers three questions content plugins never touch:

* **What is in my editor, and where is it used?** A usage index built from `parse_blocks()` across posts, reusable blocks, and Full Site Editing templates.
* **What am I allowed to add?** Allow/deny blocks globally or per post-type, and lock editor settings per role.
* **If I remove or update something, what breaks — and can I undo it?** Retire a block type by rendering every in-use instance to portable static HTML, with a one-click restore snapshot.

The safe-deactivation feature is the anti-lock-in core: deactivate a block plugin without leaving broken markup behind.

== Installation ==

1. From your WordPress admin, go to **Plugins > Add New**.
2. Search for **Block Ledger**, click **Install Now**, then **Activate**.
3. Open any post in the block editor; the **Block Ledger** panel opens from the "+" more menu on the top bar.

= Building from source =

Clone the repository and run `npm install && npm run build` to compile the editor assets into `build/`.

== Changelog ==

= 0.1.0 =
* Initial release: usage ledger, inserter allow/deny policy, safe block retirement with restore.
