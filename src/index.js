import { registerPlugin } from '@wordpress/plugins';
import { PluginSidebar, PluginSidebarMoreMenuItem } from '@wordpress/edit-post';
import { useState, useEffect, useCallback } from '@wordpress/element';
import { PanelBody, Button, Spinner, Notice } from '@wordpress/components';
import { __, sprintf } from '@wordpress/i18n';
import apiFetch from '@wordpress/api-fetch';
import { addFilter } from '@wordpress/hooks';
import { select } from '@wordpress/data';

const DATA = window.blockLedgerData || {};
const REST_ROOT = DATA.restRoot || '';
const REST_NONCE = DATA.restNonce || '';
const CAN_MANAGE = DATA.canManage === true;

function api( path, options = {} ) {
	return apiFetch( {
		path: REST_ROOT + path,
		...options,
		headers: { ...( options.headers || {} ), 'X-WP-Nonce': REST_NONCE },
	} );
}

/**
 * Defense-in-depth: hide policy-denied blocks from the client inserter too.
 * The server-side `allowed_block_types_all` filter is the real enforcement;
 * this keeps the inserter UI honest between page loads.
 */
addFilter( 'blocks.useBlockFilters', 'block-ledger/hide-denied', ( blocks ) => {
	const denied = select( 'core/editor' ).getSettings()?.__ledgerDenied || [];
	if ( ! denied.length ) {
		return blocks;
	}
	return blocks.filter( ( block ) => ! denied.includes( block.name ) );
} );

/**
 * Control-plane sidebar: show every block in use, how many items use it, offer
 * one-click "hide from inserter", and — for admins — a safe retire (convert
 * every use to static HTML) with one-click restore, plus a manual reindex.
 */
function BlockLedgerSidebar() {
	const [ map, setMap ] = useState( null );
	const [ busy, setBusy ] = useState( false );
	const [ notice, setNotice ] = useState( null ); // { status, text }
	const [ denied, setDenied ] = useState( [] );
	const [ confirmRetire, setConfirmRetire ] = useState( null );

	useEffect( () => {
		api( '/usage' )
			.then( ( res ) => setMap( res.map || {} ) )
			.catch( () => setMap( {} ) );
		api( '/policy' )
			.then( ( res ) => setDenied( res.denied || [] ) )
			.catch( () => {} );
	}, [] );

	const refresh = useCallback( () => {
		return api( '/usage' ).then( ( res ) => setMap( res.map || {} ) );
	}, [] );

	const reindex = useCallback( () => {
		setBusy( true );
		api( '/reindex', { method: 'POST' } )
			.then( refresh )
			.then( () => setNotice( { status: 'success', text: __( 'Ledger reindexed.', 'block-ledger' ) } ) )
			.catch( () => setNotice( { status: 'warning', text: __( 'Reindex failed.', 'block-ledger' ) } ) )
			.finally( () => setBusy( false ) );
	}, [ refresh ] );

	const toggleDeny = useCallback(
		( name ) => {
			const next = denied.includes( name )
				? denied.filter( ( n ) => n !== name )
				: [ ...denied, name ];
			api( '/policy', { method: 'POST', data: { denied: next } } )
				.then( ( res ) => setDenied( res.denied || [] ) )
				.then( () => setNotice( { status: 'success', text: __( 'Inserter policy updated.', 'block-ledger' ) } ) )
				.catch( () => setNotice( { status: 'warning', text: __( 'Policy update failed.', 'block-ledger' ) } ) );
		},
		[ denied ] )

	const doRetire = useCallback(
		( name ) => {
			setBusy( true );
			api( '/retire', { method: 'POST', data: { block: name } } )
				.then( () => {
					setConfirmRetire( null );
					setNotice( {
						status: 'success',
						text: sprintf(
							/* translators: %s: block name */
							__( 'Retired %s to static HTML. Use Restore to undo.', 'block-ledger' ),
							name
						),
					} );
				} )
				.catch( ( e ) => setNotice( { status: 'warning', text: e?.message || __( 'Retire failed.', 'block-ledger' ) } ) )
				.finally( () => { setBusy( false ); refresh(); } );
		},
		[ refresh ] )

	const doRestore = useCallback( () => {
		setBusy( true );
		api( '/restore', { method: 'POST' } )
			.then( () => setNotice( { status: 'success', text: __( 'Restored the last snapshot.', 'block-ledger' ) } ) )
			.catch( ( e ) => setNotice( { status: 'warning', text: e?.message || __( 'Restore failed.', 'block-ledger' ) } ) )
			.finally( () => { setBusy( false ); refresh(); } );
	}, [ refresh ] )

	const listItems = ( map ? Object.entries( map ) : [] )
		.sort( ( a, b ) => b[ 1 ].uses - a[ 1 ].uses )
		.map( ( [ name, stats ] ) => {
			const confirming = confirmRetire === name;
			return (
				<li
					key={ name }
					style={ { display: 'flex', justifyContent: 'space-between', gap: 8, padding: '4px 0', borderBottom: '1px solid var(--border-color, #ddd)', alignItems: 'center' } }
				>
					<span title={ name } style={ { fontFamily: 'monospace', fontSize: '12px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }>{ name }</span>
					<span style={ { display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 } }>
						<span style={ { fontSize: '12px' } }>{ stats.items }×</span>
						<Button
							isSmall
							variant={ denied.includes( name ) ? 'primary' : 'link' }
							onClick={ () => toggleDeny( name ) }
						>
							{ denied.includes( name ) ? __( 'hidden', 'block-ledger' ) : __( 'hide', 'block-ledger' ) }
						</Button>
						{ CAN_MANAGE && ! confirming && (
							<Button isSmall variant="danger" onClick={ () => setConfirmRetire( name ) }>
								{ __( 'retire', 'block-ledger' ) }
							</Button>
						) }
						{ CAN_MANAGE && confirming && (
							<>
								<Button isSmall variant="primary" onClick={ () => doRetire( name ) } isBusy={ busy }>
									{ __( 'yes', 'block-ledger' ) }
								</Button>
								<Button isSmall variant="link" onClick={ () => setConfirmRetire( null ) }>
									{ __( 'no', 'block-ledger' ) }
								</Button>
							</>
						) }
					</span>
				</li>
			);
		} );

	const sidebar = (
		<PluginSidebar name="block-ledger/control" title={ __( 'Block Ledger', 'block-ledger' ) } icon="shield">
			<PanelBody initialOpen={ true } title={ __( 'Block usage', 'block-ledger' ) }>
				{ notice && <Notice status={ notice.status } isDismissible={ false }>{ notice.text }</Notice> }
				<div style={ { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' } }>
					<Button variant="secondary" isBusy={ busy } onClick={ reindex }>
						{ __( 'Reindex', 'block-ledger' ) }
					</Button>
					{ CAN_MANAGE && (
						<Button variant="secondary" isBusy={ busy } onClick={ doRestore }>
							{ __( 'Restore', 'block-ledger' ) }
						</Button>
					) }
					<span style={ { fontSize: '12px' } }>{ map ? `${ Object.keys( map ).length } blocks in use` : '' }</span>
				</div>
				{ map === null && <Spinner /> }
				{ map && Object.keys( map ).length === 0 && (
					<p style={ { fontSize: '12px', color: 'var(--muted-foreground, #666)' } }>
						{ __( 'No blocks indexed yet. Click Reindex.', 'block-ledger' ) }
					</p>
				) }
				<ul style={ { listStyle: 'none', margin: 0, padding: 0, maxHeight: '44vh', overflowY: 'auto' } }>
					{ listItems }
				</ul>
			</PanelBody>
			{ CAN_MANAGE && (
				<PanelBody initialOpen={ false } title={ __( 'Safe remove', 'block-ledger' ) }>
					<p style={ { fontSize: '12px', color: 'var(--muted-foreground, #666)', margin: 0 } }>
						{ __(
							'Retire converts every use of a block into plain static HTML so the block can be removed without breaking content. The original is snapshotted, so Restore brings it back. Validate on a staging copy first.',
							'block-ledger'
						) }
					</p>
				</PanelBody>
			) }
		</PluginSidebar>
	);

	return (
		<>
			<PluginSidebarMoreMenuItem target="block-ledger/control">
				{ __( 'Block Ledger', 'block-ledger' ) }
			</PluginSidebarMoreMenuItem>
			{ sidebar }
		</>
	);
}

registerPlugin( 'block-ledger/control', {
	render: BlockLedgerSidebar,
	icon: 'shield',
} );
