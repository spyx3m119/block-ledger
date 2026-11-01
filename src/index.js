import { registerPlugin } from '@wordpress/plugins';
import { PluginSidebar, PluginSidebarMoreMenuItem } from '@wordpress/edit-post';
import { useState, useEffect, useCallback } from '@wordpress/element';
import { PanelBody, Button, Spinner, Notice, SelectControl, ToggleControl } from '@wordpress/components';
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
 * one-click "hide from inserter", per-post-type insertion policy, and — for
 * admins — a safe retire (convert every use to static HTML) with one-click
 * restore, plus a manual reindex.
 */
function BlockLedgerSidebar() {
	const [ map, setMap ] = useState( null );
	const [ busy, setBusy ] = useState( false );
	const [ notice, setNotice ] = useState( null ); // { status, text }
	const [ denied, setDenied ] = useState( [] );
	const [ confirmRetire, setConfirmRetire ] = useState( null );

	// Per-post-type policy.
	const [ postTypes, setPostTypes ] = useState( [] );
	const [ blockTypes, setBlockTypes ] = useState( [] );
	const [ selectedPt, setSelectedPt ] = useState( '' );
	const [ ptManaged, setPtManaged ] = useState( {} ); // { pt: bool } — has an explicit allowlist
	const [ ptAllowed, setPtAllowed ] = useState( {} ); // { pt: [blockName] }
	const [ ptSaved, setPtSaved ] = useState( '{}' );   // last-persisted map, for a dirty check
	const [ ptSaving, setPtSaving ] = useState( false );

	useEffect( () => {
		api( '/usage' )
			.then( ( res ) => setMap( res.map || {} ) )
			.catch( () => setMap( {} ) );
		api( '/policy' )
			.then( ( res ) => {
				setDenied( res.denied || [] );
				const pt = res.post_types || {};
				const managed = {};
				const allowed = {};
				Object.keys( pt ).forEach( ( k ) => {
					managed[ k ] = true;
					allowed[ k ] = pt[ k ];
				} );
				setPtManaged( managed );
				setPtAllowed( allowed );
				setPtSaved( JSON.stringify( pt ) );
			} )
			.catch( () => {} );
		// Public endpoint: which post types the editor can target.
		apiFetch( { path: '/wp/v2/types' } )
			.then( ( types ) => {
				const list = Object.values( types )
					.filter( ( t ) => t && t.slug && t.show_in_rest !== false )
					.map( ( t ) => ( { slug: t.slug, label: t.label || t.slug } ) )
					.sort( ( a, b ) => String( a.label ).localeCompare( String( b.label ) ) );
				setPostTypes( list );
				if ( list.length ) {
					setSelectedPt( list[ 0 ].slug );
				}
			} )
			.catch( () => {} );
	}, [] );

	useEffect( () => {
		const blocksStore = select( 'core/blocks' );
		if ( blocksStore && blocksStore.getBlockTypes ) {
			setBlockTypes( blocksStore.getBlockTypes() );
		}
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

	// --- per-post-type policy helpers ---------------------------------------
	const buildPtMap = () => {
		const m = {};
		Object.keys( ptManaged ).forEach( ( pt ) => {
			if ( ptManaged[ pt ] ) {
				m[ pt ] = ptAllowed[ pt ] || [];
			}
		} );
		return m;
	};
	const dirty = JSON.stringify( buildPtMap() ) !== ptSaved;
	const managedNow = !! ptManaged[ selectedPt ];

	const toggleManaged = () => {
		if ( managedNow ) {
			setPtManaged( ( prev ) => { const n = { ...prev }; delete n[ selectedPt ]; return n; } );
			setPtAllowed( ( prev ) => { const n = { ...prev }; delete n[ selectedPt ]; return n; } );
		} else {
			const all = blockTypes.map( ( b ) => b.name );
			setPtManaged( ( prev ) => ( { ...prev, [ selectedPt ]: true } ) );
			setPtAllowed( ( prev ) => ( { ...prev, [ selectedPt ]: all } ) );
		}
	};

	const togglePtBlock = ( name ) => {
		setPtAllowed( ( prev ) => {
			const cur = prev[ selectedPt ] || [];
			const next = cur.includes( name ) ? cur.filter( ( n ) => n !== name ) : [ ...cur, name ];
			return { ...prev, [ selectedPt ]: next };
		} );
	};

	const savePtPolicy = () => {
		setPtSaving( true );
		const payload = buildPtMap();
		api( '/policy', { method: 'POST', data: { post_types: payload } } )
			.then( () => {
				setPtSaved( JSON.stringify( payload ) );
				setNotice( { status: 'success', text: __( 'Post-type policy saved.', 'block-ledger' ) } );
			} )
			.catch( ( e ) => setNotice( { status: 'warning', text: e?.message || __( 'Save failed.', 'block-ledger' ) } ) )
			.finally( () => { setPtSaving( false ); } );
	};

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

			{ CAN_MANAGE && postTypes.length > 0 && (
				<PanelBody initialOpen={ false } title={ __( 'Per-post-type policy', 'block-ledger' ) }>
					<p style={ { fontSize: '12px', color: 'var(--muted-foreground, #666)', margin: 0 } }>
						{ __(
							'Override which blocks the inserter offers for a specific content type. When set, it wins over the global hide/allow policy.',
							'block-ledger'
						) }
					</p>
					<SelectControl
						label={ __( 'Content type', 'block-ledger' ) }
						value={ selectedPt }
						options={ postTypes.map( ( pt ) => ( { label: pt.label, value: pt.slug } ) ) }
						onChange={ setSelectedPt }
					/>
					{ selectedPt && (
						<>
							<p style={ { fontSize: '12px', color: 'var(--muted-foreground, #666)' } }>
								{ managedNow
									? __( 'Custom block list active for this type.', 'block-ledger' )
									: __( 'This type follows the global policy.', 'block-ledger' ) }
							</p>
							{ ! managedNow ? (
								<Button variant="secondary" onClick={ toggleManaged }>
									{ __( 'Use a custom block list', 'block-ledger' ) }
								</Button>
							) : (
								<>
									<div style={ { maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border-color, #ddd)', padding: 4 } }>
										{ blockTypes.length === 0 && (
											<p style={ { fontSize: '12px', color: 'var(--muted-foreground, #666)' } }>{ __( 'Loading blocks…', 'block-ledger' ) }</p>
										) }
										{ blockTypes.map( ( b ) => (
											<ToggleControl
												key={ b.name }
												label={ b.title || b.name }
												__nextHasNoMargin
												checked={ ( ptAllowed[ selectedPt ] || [] ).includes( b.name ) }
												onChange={ () => togglePtBlock( b.name ) }
											/>
										) ) }
									</div>
									<div style={ { display: 'flex', gap: 8, marginTop: 8 } }>
										<Button variant="primary" isBusy={ ptSaving } disabled={ ! dirty } onClick={ savePtPolicy }>
											{ __( 'Save', 'block-ledger' ) }
										</Button>
										<Button variant="secondary" onClick={ toggleManaged }>
											{ __( 'Revert to global', 'block-ledger' ) }
										</Button>
									</div>
								</>
							) }
						</>
					) }
				</PanelBody>
			) }

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
