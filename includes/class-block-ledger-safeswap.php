<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * The anti-lock-in core.
 *
 * Retire a block type without breaking content: render each in-use instance to
 * static HTML and snapshot the original markup for one-click restore.
 *
 * Nested blocks are re-serialized from their innerContent, so container
 * wrapper markup is preserved. Still validate on a staging copy first: any
 * block whose saved output diverges from render_block() will shift slightly.
 */
final class Block_Ledger_SafeSwap {
	const OPTION_SNAPSHOT = 'block_ledger_snapshot';

	private static $instance = null;

	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	private function __construct() {
		add_action( 'rest_api_init', array( $this, 'register_routes' ) );
	}

	/**
	 * Convert every use of $block_name to static HTML.
	 *
	 * @return array( changed, items, note )
	 */
	public function retire_block( $block_name ) {
		global $wpdb;

		$audit = Block_Ledger_Audit::instance();
		$map   = $audit->usage_map();

		if ( empty( $map[ $block_name ] ) ) {
			return array( 'changed' => 0, 'items' => 0, 'note' => 'not-used' );
		}

		$table = $wpdb->prefix . Block_Ledger_Audit::TABLE;
		$ids   = $wpdb->get_col( // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching,WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			$wpdb->prepare( "SELECT DISTINCT post_id FROM {$table} WHERE block_name = %s AND post_id > 0", $block_name ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);

		$snapshot = (array) get_option( self::OPTION_SNAPSHOT, array() );
		$changed  = 0;
		$items    = 0;

		foreach ( $ids as $post_id ) {
			$items++;
			$post = get_post( $post_id );
			if ( ! $post ) {
				continue;
			}

			$original = $post->post_content;
			$new      = $this->staticize( $original, $block_name );

			if ( $new === $original ) {
				continue;
			}

			// Bound the snapshot so a big retire can't bloat the options table.
			$snapshot[ $post_id ] = array(
				'content'     => $original,
				'block_name'  => $block_name,
				'snapshotted' => time(),
			);
			if ( count( $snapshot ) > 100 ) {
				$snapshot = array_slice( $snapshot, -100, null, true );
			}

			wp_update_post(
				array(
					'ID'           => $post_id,
					'post_content' => $new,
				),
				true
			);
			$changed++;
		}

		update_option( self::OPTION_SNAPSHOT, $snapshot );
		$audit->reindex();

		return array( 'changed' => $changed, 'items' => $items );
	}

	/**
	 * Restore every post captured by the last retire_block() snapshot.
	 *
	 * @return array( restored )
	 */
	public function restore() {
		$snapshot = (array) get_option( self::OPTION_SNAPSHOT, array() );
		$restored = 0;

		foreach ( $snapshot as $post_id => $data ) {
			if ( isset( $data['content'] ) ) {
				wp_update_post(
					array(
						'ID'           => $post_id,
						'post_content' => $data['content'],
					),
					true
				);
				$restored++;
			}
		}

		delete_option( self::OPTION_SNAPSHOT );
		Block_Ledger_Audit::instance()->reindex();

		return array( 'restored' => $restored );
	}

	/**
	 * Replace every instance of $block_name in $content with rendered HTML.
	 */
	private function staticize( $content, $block_name ) {
		$changed = false;
		$html    = $this->render_nodes( parse_blocks( $content ), $block_name, $changed );

		return $changed ? $html : $content;
	}

	/**
	 * Render a list of sibling nodes to HTML.
	 */
	private function render_nodes( array $blocks, $block_name, &$changed ) {
		$html = '';
		foreach ( $blocks as $block ) {
			$html .= $this->render_node( $block, $block_name, $changed );
		}

		return $html;
	}

	/**
	 * Render a single node.
	 *
	 * Target blocks become static HTML (render_block output, comment markers
	 * stripped). Kept blocks are re-wrapped with normalized comment markers;
	 * their body is rebuilt from innerContent, filling each child slot with the
	 * recursively-rendered innerBlock so nested targets are still staticized and
	 * the kept block's own wrapper markup is preserved.
	 *
	 * WP 7.x strips a parent's child markup out of innerHTML (leaving an empty
	 * wrapper) and represents child slots as NULL in innerContent, so we walk
	 * innerContent + innerBlocks rather than innerHTML. Older WP keeps the child
	 * block inline in innerContent, which the array branch handles.
	 */
	private function render_node( $block, $block_name, &$changed ) {
		if ( empty( $block['blockName'] ) ) {
			return (string) ( $block['innerHTML'] ?? '' ); // Null node (text between blocks).
		}

		if ( $block['blockName'] === $block_name ) {
			$changed = true;
			return render_block( $block );
		}

		$body = '';
		$slot = 0;
		$inner = $block['innerContent'] ?? null;
		if ( is_array( $inner ) ) {
			foreach ( $inner as $piece ) {
				if ( null === $piece ) {
					$body .= $this->render_node( $block['innerBlocks'][ $slot++ ] ?? array(), $block_name, $changed );
				} elseif ( is_array( $piece ) ) {
					$body .= $this->render_node( $piece, $block_name, $changed );
				} else {
					$body .= (string) $piece; // Wrapper divs, whitespace, literal markup.
				}
			}
		} else {
			$body = (string) ( $block['innerHTML'] ?? '' );
		}

		$name  = $this->comment_name( $block['blockName'] );
		$open  = '<!-- wp:' . $name . $this->attrs_json( (array) ( $block['attrs'] ?? array() ) ) . ' -->';
		$close = '<!-- /wp:' . $name . ' -->';

		return $open . $body . $close;
	}

	/**
	 * Comment marker name for a block: core blocks drop the "core/" prefix
	 * (wp:group), third-party blocks keep their namespace (wp:kadence/rowlayout).
	 */
	private function comment_name( $block_name ) {
		if ( false === strpos( $block_name, '/' ) ) {
			return $block_name;
		}

		list( $ns, $name ) = explode( '/', $block_name, 2 );

		return 'core' === $ns ? $name : $block_name;
	}

	private function attrs_json( array $attrs ) {
		if ( empty( $attrs ) ) {
			return '';
		}
		return ' ' . wp_json_encode( $attrs, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
	}

	public function register_routes() {
		register_rest_route( BLOCK_LEDGER_REST_NS, '/retire', array(
			'methods'             => 'POST',
			'args'                => array(
				'block' => array(
					'type'              => 'string',
					'required'          => true,
					'sanitize_callback' => 'sanitize_text_field',
				),
			),
			'callback'            => function ( $request ) {
				$name = $request->get_param( 'block' );
				if ( ! is_string( $name ) || '' === trim( $name ) ) {
					return new WP_Error( 'bad_block', __( 'Missing block name.', 'block-ledger' ), array( 'status' => 400 ) );
				}
				// Normalize a bare name to its core/ namespace; keep namespaced
				// names (e.g. kadence/rowlayout) as-is.
				if ( false === strpos( $name, '/' ) ) {
					$name = 'core/' . $name;
				}
				return rest_ensure_response( $this->retire_block( $name ) );
			},
			'permission_callback' => function () {
				return current_user_can( 'manage_options' );
			},
		) );

		register_rest_route( BLOCK_LEDGER_REST_NS, '/restore', array(
			'methods'             => 'POST',
			'callback'            => function () {
				return rest_ensure_response( $this->restore() );
			},
			'permission_callback' => function () {
				return current_user_can( 'manage_options' );
			},
		) );
	}
}
