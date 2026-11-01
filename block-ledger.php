<?php
/**
 * Plugin Name:       Block Ledger
 * Plugin URI:        https://github.com/spyx3m119/block-ledger
 * Description:       Block Ledger indexes every block in your WordPress content, shows usage counts, lets you hide blocks from the inserter, and safely retires blocks to static HTML with one-click restore. It is governance and observability for your content — no content blocks added.
 * Version:           0.1.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            Vlad Parole
 * Author URI:        https://github.com/spyx3m119
 * License:           GPLv2 or later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       block-ledger
 * Domain Path:       /languages
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'BLOCK_LEDGER_VERSION', '0.1.0' );
define( 'BLOCK_LEDGER_FILE', __FILE__ );
define( 'BLOCK_LEDGER_DIR', plugin_dir_path( __FILE__ ) );
define( 'BLOCK_LEDGER_URL', plugin_dir_url( __FILE__ ) );
define( 'BLOCK_LEDGER_REST_NS', 'block-ledger/v1' );

/**
 * Load the plugin pieces after all plugins are available so the filters below
 * can attach to a fully registered editor.
 */
function block_ledger_load() {
	require_once BLOCK_LEDGER_DIR . 'includes/class-block-ledger-audit.php';
	require_once BLOCK_LEDGER_DIR . 'includes/class-block-ledger-policy.php';
	require_once BLOCK_LEDGER_DIR . 'includes/class-block-ledger-safeswap.php';

	Block_Ledger_Audit::instance();
	Block_Ledger_Policy::instance();
	Block_Ledger_SafeSwap::instance();
}
add_action( 'plugins_loaded', 'block_ledger_load' );

/**
 * Activation: create the usage index table.
 */
function block_ledger_activate() {
	require_once BLOCK_LEDGER_DIR . 'includes/class-block-ledger-audit.php';
	Block_Ledger_Audit::instance()->install();
	flush_rewrite_rules();
}
register_activation_hook( __FILE__, 'block_ledger_activate' );

/**
 * Deactivation: clear scheduled events.
 */
function block_ledger_deactivate() {
	wp_clear_scheduled_hook( 'block_ledger_reindex' );
}
register_deactivation_hook( __FILE__, 'block_ledger_deactivate' );

/**
 * Enqueue the editor control-plane assets.
 */
function block_ledger_enqueue_editor() {
	$asset_file   = BLOCK_LEDGER_DIR . 'build/index.asset.php';
	$asset        = file_exists( $asset_file )
		? require $asset_file
		: array( 'dependencies' => array( 'wp-plugins', 'wp-edit-post', 'wp-components', 'wp-element', 'wp-blocks', 'wp-i18n', 'wp-data', 'wp-api-fetch', 'wp-hooks' ), 'version' => BLOCK_LEDGER_VERSION );

	// Do NOT add wp-dom-ready — it may not be registered on all WP installs
	// and can prevent the entire script from loading. Use setTimeout polling instead.

	wp_enqueue_script(
		'block-ledger-editor',
		BLOCK_LEDGER_URL . 'build/index.js',
		$asset['dependencies'],
		$asset['version'],
		true
	);

	// Ensure window.wp exists before our bundle runs.
	wp_add_inline_script(
		'block-ledger-editor',
		'window.wp = window.wp || { plugins: { registerPlugin: function() {} }, editPost: {}, element: { createRoot: function(el){ return { render: function(){} }; } }, components: {}, i18n: {}, apiFetch: function() {}, hooks: {}, data: { select: function(){} } };',
		'before'
	);

	wp_set_script_translations( 'block-ledger-editor', 'block-ledger' );

	wp_localize_script(
		'block-ledger-editor',
		'blockLedgerData',
		array(
			'restRoot'    => rest_url( BLOCK_LEDGER_REST_NS ),
			'restNonce'   => wp_create_nonce( 'wp_rest' ),
			'canManage'   => current_user_can( 'manage_options' ),
			'i18nRetire'  => __( 'Retire block', 'block-ledger' ),
			'i18nRestore' => __( 'Restore', 'block-ledger' ),
		)
	);
}
add_action( 'enqueue_block_editor_assets', 'block_ledger_enqueue_editor' );

// DEBUG: visible marker
add_action( 'admin_head', function() {
	echo '<!-- Block Ledger admin_head marker -->';
}, 1 );
