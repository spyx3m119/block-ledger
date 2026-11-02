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

$bl_table = $wpdb->prefix . 'block_ledger_usage';
// phpcs:ignore WordPress.DB.DirectDatabaseQuery.NoCaching,WordPress.DB.DirectDatabaseQuery.SchemaChange,PluginCheck.Security.DirectDB.UnescapedDBParameter,WordPress.DB.PreparedSQL.InterpolatedNotPrepared,WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedVariableFound
$wpdb->query( "DROP TABLE IF EXISTS {$bl_table}" );

wp_clear_scheduled_hook( 'block_ledger_reindex' );
