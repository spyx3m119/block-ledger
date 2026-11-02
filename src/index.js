import { registerPlugin } from '@wordpress/plugins';
import { PluginSidebar, PluginSidebarMoreMenuItem } from '@wordpress/edit-post';
import { PanelBody, Button, Spinner, Notice, SelectControl, ToggleControl } from '@wordpress/components';
import { createElement as el, useState, useEffect, useCallback } from '@wordpress/element';
import { __, _n, sprintf } from '@wordpress/i18n';
import apiFetch from '@wordpress/api-fetch';
import { addFilter } from '@wordpress/hooks';
import { select } from '@wordpress/data';

console.log( 'Block Ledger script loaded' );
const _blDiv = document.createElement( 'div' );
_blDiv.id = 'bl-loaded-marker';
_blDiv.style.display = 'none';
document.body.appendChild( _blDiv );

const DATA = window.blockLedgerData || {};
const REST_ROOT = DATA.restRoot || '';
const REST_NONCE = DATA.restNonce || '';
const CAN_MANAGE = DATA.canManage === true;

function api( path, options = {} ) {
	return apiFetch( {
		url: REST_ROOT + path,
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
	const editor = select( 'core/editor' );
	const denied = ( editor && editor.getSettings()?.__ledgerDenied ) || [];
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
/**
 * Same UI as BlockLedgerSidebar, but without PluginSidebar wrappers so it can
 * render into a standalone floating div outside the editor sidebar context.
 */
function BlockLedgerFloatingContent() {
	const [ map, setMap ] = useState( null );
	const [ busy, setBusy ] = useState( false );
	const [ notice, setNotice ] = useState( null );
	const [ denied, setDenied ] = useState( [] );
	const [ confirmRetire, setConfirmRetire ] = useState( null );
	const [ postTypes, setPostTypes ] = useState( [] );
	const [ blockTypes, setBlockTypes ] = useState( [] );
	const [ selectedPt, setSelectedPt ] = useState( '' );
	const [ ptManaged, setPtManaged ] = useState( {} );
	const [ ptAllowed, setPtAllowed ] = useState( {} );
	const [ ptSaved, setPtSaved ] = useState( '{}' );
	const [ ptSaving, setPtSaving ] = useState( false );
	const [ locks, setLocks ] = useState( {} );
	const [ lastIndexed, setLastIndexed ] = useState( null );
	const [ apiError, setApiError ] = useState( null );

	useEffect( () => {
		api( '/usage' )
			.then( ( res ) => {
				setMap( res.map || {} );
				setLastIndexed( res.last_indexed || null );
				setApiError( null );
			} )
			.catch( ( e ) => {
				setMap( {} );
				setApiError( e?.message || __( 'Failed to load usage data.', 'block-ledger' ) );
			} );
		api( '/policy' )
			.then( ( res ) => {
				setApiError( null );
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
			setLocks( res.locks || {} );
		} ).catch( () => {} );
		apiFetch( { path: '/wp/v2/types' } )
			.then( ( types ) => {
				const list = Object.values( types )
					.filter( ( t ) => t && t.slug && t.show_in_rest !== false )
					.map( ( t ) => ( { slug: t.slug, label: t.label || t.slug } ) )
					.sort( ( a, b ) => String( a.label ).localeCompare( String( b.label ) ) );
				setPostTypes( list );
				if ( list.length ) setSelectedPt( list[ 0 ].slug );
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
		[ denied ]
	);

	const toggleLock = useCallback(
		( key ) => {
			setLocks( ( prev ) => ( { ...prev, [ key ]: ! prev[ key ] } ) );
		},
		[]
	);

	const saveLocks = useCallback(
		() => {
			setBusy( true );
			api( '/policy', { method: 'POST', data: { locks } } )
				.then( () => setNotice( { status: 'success', text: __( 'Editor settings locked.', 'block-ledger' ) } ) )
				.catch( () => setNotice( { status: 'warning', text: __( 'Lock update failed.', 'block-ledger' ) } ) )
				.finally( () => setBusy( false ) );
		},
		[ locks ]
	);

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
		[ refresh ]
	);

	const doRestore = useCallback( () => {
		setBusy( true );
		api( '/restore', { method: 'POST' } )
			.then( () => setNotice( { status: 'success', text: __( 'Restored the last snapshot.', 'block-ledger' ) } ) )
			.catch( ( e ) => setNotice( { status: 'warning', text: e?.message || __( 'Restore failed.', 'block-ledger' ) } ) )
			.finally( () => { setBusy( false ); refresh(); } );
	}, [ refresh ] );

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

	return (
		<>
			<PanelBody initialOpen={ true } title={ __( 'Block usage', 'block-ledger' ) }>
				{ notice && <Notice status={ notice.status } isDismissible={ false }>{ notice.text }</Notice> }
				{ apiError && <Notice status="warning" isDismissible={ false }>{ apiError }</Notice> }
				<div style={ { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' } }>
					{ lastIndexed && (
						<span style={ { fontSize: '12px', color: '#666' } }>
							{ sprintf(
								/* translators: %s: date/time */
								__( 'Last indexed: %s', 'block-ledger' ),
								new Date( lastIndexed * 1000 ).toLocaleString()
							) }
						</span>
					) }
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
				<PanelBody initialOpen={ true } title={ __( 'Editor settings locks', 'block-ledger' ) }>
					<p style={ { fontSize: '12px', color: 'var(--muted-foreground, #666)', margin: '0 0 8px' } }>
						{ __( 'Disable editor toggles for all users:', 'block-ledger' ) }
					</p>
					<ToggleControl
						label={ __( 'Disable code editor', 'block-ledger' ) }
						__nextHasNoMargin
						checked={ !! locks.codeEditingEnabled }
						onChange={ () => toggleLock( 'codeEditingEnabled' ) }
					/>
					<ToggleControl
						label={ __( 'Disable media upload', 'block-ledger' ) }
						__nextHasNoMargin
						checked={ !! locks.canUploadFiles }
						onChange={ () => toggleLock( 'canUploadFiles' ) }
					/>
					<ToggleControl
						label={ __( 'Disable RTL support', 'block-ledger' ) }
						__nextHasNoMargin
						checked={ !! locks.isRTL }
						onChange={ () => toggleLock( 'isRTL' ) }
					/>
					<ToggleControl
						label={ __( 'Disable fixed width', 'block-ledger' ) }
						__nextHasNoMargin
						checked={ !! locks.hasFixedWidth }
						onChange={ () => toggleLock( 'hasFixedWidth' ) }
					/>
					<Button variant="primary" isBusy={ busy } onClick={ saveLocks } style={ { marginTop: 8 } }>
						{ __( 'Save locks', 'block-ledger' ) }
					</Button>
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
		</>
	);
}

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
	const [ locks, setLocks ] = useState( {} );
	const [ lastIndexed, setLastIndexed ] = useState( null );
	const [ apiError, setApiError ] = useState( null );

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
				{ apiError && <Notice status="warning" isDismissible={ false }>{ apiError }</Notice> }
				<div style={ { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' } }>
					{ lastIndexed && (
						<span style={ { fontSize: '12px', color: '#666' } }>
							{ sprintf(
								/* translators: %s: date/time */
								__( 'Last indexed: %s', 'block-ledger' ),
								new Date( lastIndexed * 1000 ).toLocaleString()
							) }
						</span>
					) }
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
				<PanelBody initialOpen={ true } title={ __( 'Editor settings locks', 'block-ledger' ) }>
					<p style={ { fontSize: '12px', color: 'var(--muted-foreground, #666)', margin: '0 0 8px' } }>
						{ __( 'Disable editor toggles for all users:', 'block-ledger' ) }
					</p>
					<ToggleControl
						label={ __( 'Disable code editor', 'block-ledger' ) }
						__nextHasNoMargin
						checked={ !! locks.codeEditingEnabled }
						onChange={ () => toggleLock( 'codeEditingEnabled' ) }
					/>
					<ToggleControl
						label={ __( 'Disable media upload', 'block-ledger' ) }
						__nextHasNoMargin
						checked={ !! locks.canUploadFiles }
						onChange={ () => toggleLock( 'canUploadFiles' ) }
					/>
					<ToggleControl
						label={ __( 'Disable RTL support', 'block-ledger' ) }
						__nextHasNoMargin
						checked={ !! locks.isRTL }
						onChange={ () => toggleLock( 'isRTL' ) }
					/>
					<ToggleControl
						label={ __( 'Disable fixed width', 'block-ledger' ) }
						__nextHasNoMargin
						checked={ !! locks.hasFixedWidth }
						onChange={ () => toggleLock( 'hasFixedWidth' ) }
					/>
					<Button variant="primary" isBusy={ busy } onClick={ saveLocks } style={ { marginTop: 8 } }>
						{ __( 'Save locks', 'block-ledger' ) }
					</Button>
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



function registerBlockLedgerPlugin() {
	const wp = window.wp;
	if ( ! wp || ! wp.plugins || ! wp.data ) {
		console.log( 'Block Ledger: wp not ready yet' );
		setTimeout( registerBlockLedgerPlugin, 100 );
		return;
	}
	try {
		const editor = wp.data.select( 'core/editor' );
		if ( ! editor ) {
			console.log( 'Block Ledger: core/editor store not ready' );
			setTimeout( registerBlockLedgerPlugin, 100 );
			return;
		}
		wp.plugins.registerPlugin( 'block-ledger/control', {
			render: BlockLedgerSidebar,
			icon: 'shield',
		} );
		console.log( 'Block Ledger: registered successfully' );
	} catch ( e ) {
		console.log( 'Block Ledger: registration error', e.message );
		setTimeout( registerBlockLedgerPlugin, 100 );
	}
}

// On the standalone admin page we render into a plain div, so skip
// wp.plugins registration entirely. In the editor, register the sidebar.
const isAdminPage = !! document.getElementById( 'block-ledger-admin-root' );
if ( ! isAdminPage ) {
	registerBlockLedgerPlugin();
}

// Mount the panel: standalone admin page or editor sidebar fallback.
function mountBlockLedgerPanel() {
	const adminRootEl = document.getElementById( 'block-ledger-admin-root' );
	if ( adminRootEl ) {
		// Standalone admin page: wp.element may not exist, so wire up React
		// from the globally loaded WordPress scripts and render directly.
		if ( ! window.wp ) window.wp = {};
		if ( ! window.wp.element ) {
			window.wp.element = {
				createElement: window.React.createElement,
				createRoot: window.ReactDOM.createRoot,
			};
		}
		const container = document.createElement( 'div' );
		adminRootEl.appendChild( container );
		const root = window.wp.element.createRoot( container );
		root.render( window.wp.element.createElement( BlockLedgerFloatingContent ) );
		console.log( 'Block Ledger: mounted on admin page' );
		return;
	}
	// Editor context: keep the existing sidebar/floating fallback behavior.
	const sidebar = document.querySelector( '.edit-post-sidebar, #editor-sidebar, .interface-interface-skeleton__sidebar' );
	const container = document.createElement( 'div' );
	container.id = 'block-ledger-panel';
	container.style.cssText = 'padding:16px;border-bottom:1px solid #ddd;background:#fff;';
	if ( sidebar ) {
		sidebar.insertBefore( container, sidebar.firstChild );
		console.log( 'Block Ledger: panel injected into sidebar' );
	} else {
		container.style.cssText = 'position:fixed;top:80px;right:20px;width:320px;max-height:calc(100vh - 100px);overflow-y:auto;background:#fff;border:1px solid #ddd;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,0.15);z-index:99999;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Oxygen-Sans,Ubuntu,Cantarell,"Helvetica Neue",sans-serif;font-size:13px;';
		document.body.appendChild( container );
		console.log( 'Block Ledger: floating panel rendered' );
	}
	const root = window.wp.element.createRoot( container );
	root.render( window.wp.element.createElement( BlockLedgerFloatingContent ) );
}
setTimeout( mountBlockLedgerPanel, 800 );
