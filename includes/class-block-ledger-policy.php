<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Policy layer: allow/deny blocks (globally or per post-type) and lock editor
 * settings. Enforced server-side via allowed_block_types_all, mirrored to the
 * client via a settings flag for inserter UX.
 */
final class Block_Ledger_Policy {
	const OPTION_POLICY = 'block_ledger_policy';

	private static $instance = null;

	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	private function __construct() {
		add_filter( 'allowed_block_types_all', array( $this, 'filter_allowed_blocks' ), 10, 2 );
		add_filter( 'block_editor_settings_all', array( $this, 'lock_settings' ), 10, 2 );
		add_action( 'rest_api_init', array( $this, 'register_routes' ) );
	}

	public function get_policy() {
		$stored = (array) get_option( self::OPTION_POLICY, array() );

		return array(
			'allowed'    => isset( $stored['allowed'] ) ? (array) $stored['allowed'] : array(),
			'denied'     => isset( $stored['denied'] ) ? (array) $stored['denied'] : array(),
			'post_types' => isset( $stored['post_types'] ) ? (array) $stored['post_types'] : array(),
			'locks'      => isset( $stored['locks'] ) ? (array) $stored['locks'] : array(),
		);
	}

	/**
	 * Validate a block-type identifier for storage.
	 *
	 * Block names carry a namespace slash (core/paragraph, kadence/rowlayout)
	 * that sanitize_key() would strip, so we validate the shape instead: a bare
	 * name is assumed to live in the core namespace, and anything that is not a
	 * well-formed `namespace/name` identifier is dropped.
	 */
	private function sanitize_block_name( $name ) {
		$name = strtolower( trim( (string) $name ) );
		if ( '' === $name || false !== strpos( $name, ' ' ) ) {
			return '';
		}
		if ( false === strpos( $name, '/' ) ) {
			$name = 'core/' . $name;
		}
		if ( ! preg_match( '#^[a-z0-9_\-]+/[a-z0-9_\-]+$#', $name ) ) {
			return '';
		}
		return $name;
	}

	/**
	 * Restrict which blocks the inserter offers.
	 *
	 * Precedence: per-post-type allowlist > denied list (all minus denied) >
	 * global allowlist > no restriction.
	 */
	public function filter_allowed_blocks( $allowed, $context ) {
		$policy    = $this->get_policy();
		$post_type = ( $context && ! empty( $context->post ) ) ? get_post_type( $context->post ) : false;

		if ( $post_type && isset( $policy['post_types'][ $post_type ] ) ) {
			return $policy['post_types'][ $post_type ];
		}

		if ( ! empty( $policy['denied'] ) ) {
			$registry = WP_Block_Type_Registry::get_instance();
			$all      = array_keys( $registry->get_all_registered() );

			return array_values( array_diff( $all, $policy['denied'] ) );
		}

		if ( ! empty( $policy['allowed'] ) ) {
			return $policy['allowed'];
		}

		return $allowed;
	}

	/**
	 * Lock editor settings and expose the denied list to the client.
	 */
	public function lock_settings( $settings, $context ) {
		$policy = $this->get_policy();

		$allowed_locks = array( 'codeEditingEnabled', 'canUploadFiles', 'isRTL', 'hasFixedWidth' );
		foreach ( (array) $policy['locks'] as $key => $value ) {
			if ( in_array( $key, $allowed_locks, true ) ) {
				$settings[ $key ] = $value;
			}
		}

		$settings['__ledgerDenied'] = (array) $policy['denied'];

		return $settings;
	}

	public function register_routes() {
		register_rest_route( BLOCK_LEDGER_REST_NS, '/policy', array(
			array(
				'methods'             => 'GET',
				'callback'            => array( $this, 'get_policy_rest' ),
				'permission_callback' => function () {
					return current_user_can( 'edit_posts' );
				},
			),
			array(
				'methods'             => 'POST',
				'callback'            => array( $this, 'update_policy_rest' ),
				'permission_callback' => function () {
					return current_user_can( 'manage_options' );
				},
			),
		) );
	}

	public function get_policy_rest() {
		return rest_ensure_response( $this->get_policy() );
	}

	public function update_policy_rest( $request ) {
		$body    = $request->get_json_params();
		$current = $this->get_policy();

		if ( isset( $body['denied'] ) ) {
			$current['denied'] = array_values( array_filter( array_map( array( $this, 'sanitize_block_name' ), (array) $body['denied'] ) ) );
		}
		if ( isset( $body['allowed'] ) ) {
			$current['allowed'] = array_values( array_filter( array_map( array( $this, 'sanitize_block_name' ), (array) $body['allowed'] ) ) );
		}
		if ( isset( $body['locks'] ) ) {
			$allowed_locks = array( 'codeEditingEnabled', 'canUploadFiles', 'isRTL', 'hasFixedWidth' );
			foreach ( (array) $body['locks'] as $k => $v ) {
				if ( in_array( $k, $allowed_locks, true ) ) {
					$current[ 'locks' ][ $k ] = (bool) $v;
				}
			}
		}

		if ( isset( $body['post_types'] ) && is_array( $body['post_types'] ) ) {
			$post_types = array();
			foreach ( (array) $body['post_types'] as $pt => $blocks ) {
				$pt = sanitize_key( (string) $pt );
				if ( '' === $pt ) {
					continue;
				}
				// A populated list becomes the exact set of blocks offered in
				// that post type's inserter; an empty one clears it (falls back
				// to the global policy).
				$post_types[ $pt ] = array_values( array_filter( array_map( array( $this, 'sanitize_block_name' ), (array) $blocks ) ) );
			}
			$current[ 'post_types' ] = $post_types;
		}

		update_option( self::OPTION_POLICY, $current );

		return rest_ensure_response( $this->get_policy() );
	}
}
