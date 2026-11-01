<?php
/**
 * Runs only when the plugin is deleted from the Plugins screen.
 *
 * Removes all plugin data so uninstalling leaves no lock-in behind — the whole
 * point of the plugin.
 */
if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

global $wpdb;

delete_option( 'block_ledger_policy' );
delete_option( 'block_ledger_snapshot' );
delete_option( 'block_ledger_indexed' );

$table = $wpdb->prefix . 'block_ledger_usage';
$wpdb->query( "DROP TABLE IF EXISTS {$table}" ); // phpcs:ignore

wp_clear_scheduled_hook( 'block_ledger_reindex' );
