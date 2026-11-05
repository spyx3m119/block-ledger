<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Builds and serves a "ledger" of which blocks are used where.
 *
 * This is the observability layer: a usage index rebuilt from parse_blocks()
 * across posts, reusable blocks (wp_block), and FSE templates.
 */
final class Block_Ledger_Audit {
	const TABLE   = 'block_ledger_usage';
	const SCHEDULE = 'block_ledger_reindex';

	private static $instance = null;

	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	private function __construct() {
		add_action( self::SCHEDULE, array( $this, 'reindex' ) );
		add_action( 'rest_api_init', array( $this, 'register_routes' ) );
	}

	/**
	 * Create the usage index table.
	 */
	public function install() {
		global $wpdb;

		$table      = $wpdb->prefix . self::TABLE;
		$charset    = $wpdb->get_charset_collate();
		$sql        = "CREATE TABLE {$table} (
			id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
			post_id bigint(20) unsigned NOT NULL DEFAULT 0,
			surface varchar(32) NOT NULL DEFAULT 'content',
			block_name varchar(191) NOT NULL,
			content_hash varchar(64) NOT NULL,
			updated datetime NOT NULL,
			PRIMARY KEY (id),
			KEY block_name (block_name),
			KEY post_id (post_id)
		) {$charset};";

		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		dbDelta( $sql );

		if ( ! wp_next_scheduled( self::SCHEDULE ) ) {
			wp_schedule_event( time(), 'twicedaily', self::SCHEDULE );
		}
	}

	/**
	 * Scan all content surfaces and rebuild the usage index.
	 */
	public function reindex() {
		global $wpdb;

		$table   = $wpdb->prefix . self::TABLE;
		$wpdb->query( "TRUNCATE TABLE {$table}" ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared,WordPress.DB.DirectDatabaseQuery.DirectQuery

		$now     = current_time( 'mysql', true );
		$surfaces = $this->collect_surfaces();

		foreach ( $surfaces as $surface ) {
			$blocks = parse_blocks( $surface['content'] );
			$this->walk( $blocks, $surface['post_id'], $surface['surface'], $now );
		}

		update_option( 'block_ledger_indexed', true );
		update_option( 'block_ledger_last_indexed', time() );
	}

	/**
	 * Recursively record every block node.
	 */
	private function walk( array $blocks, $post_id, $surface, $now ) {
		global $wpdb;
		$table = $wpdb->prefix . self::TABLE;

		foreach ( $blocks as $block ) {
			if ( empty( $block['blockName'] ) ) {
				continue; // Null node: plain text between blocks.
			}

			$wpdb->insert( // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
				$table,
				array(
					'post_id'      => (int) $post_id,
					'surface'      => $surface,
					'block_name'   => $block['blockName'],
					'content_hash' => hash( 'sha256', (string) $block['innerHTML'] ),
					'updated'      => $now,
				),
				array( '%d', '%s', '%s', '%s', '%s' )
			);

			if ( ! empty( $block['innerBlocks'] ) ) {
				$this->walk( $block['innerBlocks'], $post_id, $surface, $now );
			}
		}
	}

	/**
	 * Gather posts, reusable blocks, and FSE templates.
	 *
	 * NOTE: numberposts => -1 is fine for small/medium sites. For very large
	 * sites, swap this for an ID-range cursor or a per-post-save incremental
	 * update. This is the first thing to optimize before a public release.
	 */
	private function collect_surfaces() {
		$out = array();

		$post_types = get_post_types( array( 'show_in_rest' => true ), 'names' );
		$post_types[] = 'wp_block';
		$post_types[] = 'wp_template';
		$post_types[] = 'wp_template_part';
		$post_types   = array_values( array_unique( $post_types ) );

		foreach ( $post_types as $pt ) {
			$posts = get_posts(
				array(
					'post_type'      => $pt,
					'post_status'    => array( 'publish', 'draft', 'pending', 'private', 'future' ),
					'numberposts'    => -1,
					'suppress_filters' => true,
				)
			);

			foreach ( (array) $posts as $post ) {
				$surface = ( 'wp_template' === $pt || 'wp_template_part' === $pt ) ? 'template' : 'content';
				$out[]   = array(
					'post_id' => $post->ID,
					'surface' => $surface,
					'content' => $post->post_content,
				);
			}
		}

		return $out;
	}

	/**
	 * block_name => array( uses, items ).
	 */
	public function usage_map() {
		global $wpdb;
		$table = $wpdb->prefix . self::TABLE;

		$rows = $wpdb->get_results( // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching,WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			"SELECT block_name, COUNT(*) AS uses, COUNT(DISTINCT post_id) AS items FROM {$table} GROUP BY block_name ORDER BY uses DESC",
			ARRAY_A
		);

		$map = array();
		foreach ( (array) $rows as $row ) {
			$map[ $row['block_name'] ] = array(
				'uses'  => (int) $row['uses'],
				'items' => (int) $row['items'],
			);
		}

		return $map;
	}

	/**
	 * Is this block used anywhere?
	 */
	public function is_used( $block_name ) {
		global $wpdb;
		$table = $wpdb->prefix . self::TABLE;

		$count = (int) $wpdb->get_var( // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching,WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			$wpdb->prepare( "SELECT COUNT(*) FROM {$table} WHERE block_name = %s", $block_name )
		); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared

		return $count > 0;
	}

	public function register_routes() {
		register_rest_route( BLOCK_LEDGER_REST_NS, '/usage', array(
			'methods'             => 'GET',
			'callback'            => function () {
				return rest_ensure_response( array(
					'map'   => $this->usage_map(),
					'ready' => (bool) get_option( 'block_ledger_indexed', false ),
					'last_indexed' => get_option( 'block_ledger_last_indexed', null ),
				) );
			},
			'permission_callback' => function () {
				return current_user_can( 'edit_posts' );
			},
		) );

		register_rest_route( BLOCK_LEDGER_REST_NS, '/reindex', array(
			'methods'             => 'POST',
			'callback'            => function () {
				$this->reindex();
				return rest_ensure_response( array( 'ok' => true ) );
			},
			'permission_callback' => function () {
				return current_user_can( 'manage_options' );
			},
		) );
	}
}
