import { registerPlugin } from '@wordpress/plugins';
import { PluginSidebar, PluginSidebarMoreMenuItem } from '@wordpress/edit-post';
import { PanelBody, Button, Spinner, Notice, SelectControl, ToggleControl } from '@wordpress/components';
import { createElement as el, useState, useEffect, useCallback, Fragment } from '@wordpress/element';
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
const CAN_MANAGE = DATA.canManage === true || DATA.canManage === '1';
const IS_ADMIN_PAGE = DATA.isAdminPage === true || DATA.isAdminPage === '1';

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
function BlockTreeNavigator() {
	const [ tree, setTree ] = useState( null );
	useEffect( () => {
		const update = () => {
			try {
				const editor = select( 'core/block-editor' );
				if ( editor && editor.getBlocks ) {
					setTree( editor.getBlocks() );
				}
			} catch ( e ) {}
		};
		update();
		const interval = setInterval( update, 2000 );
		return () => clearInterval( interval );
	}, [] );

	const selectBlock = ( clientId ) => {
		try {
			const dispatch = window.wp.data.dispatch( 'core/block-editor' );
			if ( dispatch && dispatch.selectBlock ) dispatch.selectBlock( clientId );
		} catch ( e ) {}
	};

	const renderTree = ( blocks, depth = 0 ) => {
		if ( ! blocks || ! blocks.length ) return null;
		return blocks.map( ( b ) => el( 'div', { key: b.clientId, style: { paddingLeft: depth * 12 + 'px', fontSize: '11px', fontFamily: 'monospace', lineHeight: '1.6' }, onMouseEnter: () => selectBlock( b.clientId ), onMouseLeave: () => {} },
			el( 'span', { style: { color: '#333', cursor: 'pointer' } }, b.name || 'unknown' ),
			renderTree( b.innerBlocks, depth + 1 )
		) );
	};

	if ( ! tree ) return el( 'p', { style: { fontSize: '12px', color: '#666' } }, __( 'No blocks yet.', 'block-ledger' ) );
	return el( 'div', { style: { maxHeight: '200px', overflowY: 'auto' } }, renderTree( tree ) );
}

function BlockLedgerFloatingContent() {
	console.log( 'Block Ledger: FloatingContent rendering, IS_ADMIN_PAGE=', IS_ADMIN_PAGE );
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
	const [ searchQuery, setSearchQuery ] = useState( '' );
	const [ collapsedGroups, setCollapsedGroups ] = useState( {} );
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

	const filteredEntries = ( map ? Object.entries( map ) : [] )
		.filter( ( [ name ] ) => ! searchQuery || name.toLowerCase().includes( searchQuery.toLowerCase() ) )
		.sort( ( a, b ) => b[ 1 ].uses - a[ 1 ].uses );

	// Group by namespace
	const groups = {};
	filteredEntries.forEach( ( [ name, stats ] ) => {
		const ns = name.split( '/' )[ 0 ] || 'other';
		if ( ! groups[ ns ] ) groups[ ns ] = [];
		groups[ ns ].push( [ name, stats ] );
	} );

	const toggleGroup = ( ns ) => setCollapsedGroups( ( prev ) => ( { ...prev, [ ns ]: ! prev[ ns ] } ) );

	const groupedBlocks = el( 'div', { style: { maxHeight: '44vh', overflowY: 'auto' } },
		Object.keys( groups ).sort().map( ( ns ) => el( 'div', { key: ns, style: { marginBottom: 4 } },
			el( 'div', { onClick: () => toggleGroup( ns ), style: { cursor: 'pointer', fontWeight: 600, fontSize: '12px', padding: '4px 0', borderBottom: '1px solid #eee', display: 'flex', justifyContent: 'space-between' } },
				el( 'span', null, ( collapsedGroups[ ns ] ? '▸ ' : '▾ ' ) + ns + ' (' + groups[ ns ].length + ')' )
			),
			! collapsedGroups[ ns ] && el( 'ul', { style: { listStyle: 'none', margin: 0, padding: '0 0 0 8px' } },
				groups[ ns ].map( ( [ name, stats ] ) => {
					const confirming = confirmRetire === name;
					return el( 'li', { key: name, style: { display: 'flex', justifyContent: 'space-between', gap: 8, padding: '4px 0', borderBottom: '1px solid var(--border-color, #ddd)', alignItems: 'center' } },
						el( 'span', { title: name, style: { fontFamily: 'monospace', fontSize: '12px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, name ),
						el( 'span', { style: { display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 } },
							el( 'span', { style: { fontSize: '12px' } }, stats.items + '×' ),
							el( Button, { isSmall: true, variant: denied.includes( name ) ? 'primary' : 'link', onClick: () => toggleDeny( name ) }, denied.includes( name ) ? __( 'hidden', 'block-ledger' ) : __( 'hide', 'block-ledger' ) ),
							CAN_MANAGE && ! confirming && el( Button, { isSmall: true, variant: 'danger', onClick: () => setConfirmRetire( name ) }, __( 'retire', 'block-ledger' ) ),
							CAN_MANAGE && confirming && el( 'span', null,
								el( Button, { isSmall: true, variant: 'primary', onClick: () => doRetire( name ), isBusy: busy }, __( 'yes', 'block-ledger' ) ),
								el( Button, { isSmall: true, variant: 'link', onClick: () => setConfirmRetire( null ) }, __( 'no', 'block-ledger' ) )
							)
						)
					);
				} )
			)
			)
		) );

	return (
		IS_ADMIN_PAGE ? (
			<>

			<PanelBody initialOpen={ true } title={ __( 'Block usage', 'block-ledger' ) }>
				{ notice && <Notice status={ notice.status } isDismissible={ false }>{ notice.text }</Notice> }
				{ apiError && <Notice status="warning" isDismissible={ false }>{ apiError }</Notice> }
				{ CAN_MANAGE && (
					<p style={ { fontSize: '11px', color: 'var(--muted-foreground, #666)', margin: '0 0 8px', padding: '6px 8px', background: 'var(--card, #f9f9f9)', borderRadius: 3, borderLeft: '3px solid #e6a23c' } }>
						{ __(
							'Retire converts every use of a block into plain static HTML so the block can be removed without breaking content. The original is snapshotted, so Restore brings it back. Validate on a staging copy first.',
							'block-ledger'
						) }
					</p>
				) }
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
				<input
					type="text"
					placeholder={ __( 'Search blocks…', 'block-ledger' ) }
					value={ searchQuery }
					onChange={ ( e ) => setSearchQuery( e.target.value ) }
					style={ { width: '100%', marginBottom: 8, padding: '4px 8px', fontSize: '12px', border: '1px solid #ddd', borderRadius: 3 } }
				/>
				{ groupedBlocks }
			</PanelBody>

			{ IS_ADMIN_PAGE && CAN_MANAGE && postTypes.length > 0 && (
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


			{ ! IS_ADMIN_PAGE && (
				<>
					<PanelBody initialOpen={ false } title={ __( 'Block tree', 'block-ledger' ) }>
				<BlockTreeNavigator />
			</PanelBody>

			</>
		) }

			{ IS_ADMIN_PAGE && (
				<PanelBody initialOpen={ false } title={ __( 'Pro features', 'block-ledger' ) }>
				<ul style={ { listStyle: 'none', margin: 0, padding: 0, fontSize: '12px' } }>
					<li style={ { padding: '6px 0', borderBottom: '1px solid #eee' } }>
						<strong>{ __( 'De-lock-in migration wizard', 'block-ledger' ) }</strong>
						<span style={ { marginLeft: 6, fontSize: '10px', background: '#7c3aed', color: '#fff', padding: '1px 5px', borderRadius: 3 } }>PRO</span>
						<p style={ { margin: '2px 0 0', color: '#666' } }>{ __( 'Import from Elementor/Kadence, convert, verify, deactivate.', 'block-ledger' ) }</p>
					</li>
					<li style={ { padding: '6px 0', borderBottom: '1px solid #eee' } }>
						<strong>{ __( 'Full-surface audit report', 'block-ledger' ) }</strong>
						<span style={ { marginLeft: 6, fontSize: '10px', background: '#7c3aed', color: '#fff', padding: '1px 5px', borderRadius: 3 } }>PRO</span>
						<p style={ { margin: '2px 0 0', color: '#666' } }>{ __( 'Exportable CSV/PDF of every block usage across all surfaces.', 'block-ledger' ) }</p>
					</li>
					<li style={ { padding: '6px 0' } }>
						<strong>{ __( 'Role-based policies', 'block-ledger' ) }</strong>
						<span style={ { marginLeft: 6, fontSize: '10px', background: '#7c3aed', color: '#fff', padding: '1px 5px', borderRadius: 3 } }>PRO</span>
						<p style={ { margin: '2px 0 0', color: '#666' } }>{ __( 'Per-role insertion policies and editor setting locks.', 'block-ledger' ) }</p>
					</li>
				</ul>
			</PanelBody>
			) }
		
			</>
		) : (
			<PanelBody initialOpen={ false } title={ __( 'Block Ledger', 'block-ledger' ) }>

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
				<input
					type="text"
					placeholder={ __( 'Search blocks…', 'block-ledger' ) }
					value={ searchQuery }
					onChange={ ( e ) => setSearchQuery( e.target.value ) }
					style={ { width: '100%', marginBottom: 8, padding: '4px 8px', fontSize: '12px', border: '1px solid #ddd', borderRadius: 3 } }
				/>
				{ groupedBlocks }
			</PanelBody>

			{ IS_ADMIN_PAGE && CAN_MANAGE && postTypes.length > 0 && (
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

			{ ! IS_ADMIN_PAGE && (
				<>
					<PanelBody initialOpen={ false } title={ __( 'Block tree', 'block-ledger' ) }>
				<BlockTreeNavigator />
			</PanelBody>

			</>
		) }

			{ IS_ADMIN_PAGE && (
				<PanelBody initialOpen={ false } title={ __( 'Pro features', 'block-ledger' ) }>
				<ul style={ { listStyle: 'none', margin: 0, padding: 0, fontSize: '12px' } }>
					<li style={ { padding: '6px 0', borderBottom: '1px solid #eee' } }>
						<strong>{ __( 'De-lock-in migration wizard', 'block-ledger' ) }</strong>
						<span style={ { marginLeft: 6, fontSize: '10px', background: '#7c3aed', color: '#fff', padding: '1px 5px', borderRadius: 3 } }>PRO</span>
						<p style={ { margin: '2px 0 0', color: '#666' } }>{ __( 'Import from Elementor/Kadence, convert, verify, deactivate.', 'block-ledger' ) }</p>
					</li>
					<li style={ { padding: '6px 0', borderBottom: '1px solid #eee' } }>
						<strong>{ __( 'Full-surface audit report', 'block-ledger' ) }</strong>
						<span style={ { marginLeft: 6, fontSize: '10px', background: '#7c3aed', color: '#fff', padding: '1px 5px', borderRadius: 3 } }>PRO</span>
						<p style={ { margin: '2px 0 0', color: '#666' } }>{ __( 'Exportable CSV/PDF of every block usage across all surfaces.', 'block-ledger' ) }</p>
					</li>
					<li style={ { padding: '6px 0' } }>
						<strong>{ __( 'Role-based policies', 'block-ledger' ) }</strong>
						<span style={ { marginLeft: 6, fontSize: '10px', background: '#7c3aed', color: '#fff', padding: '1px 5px', borderRadius: 3 } }>PRO</span>
						<p style={ { margin: '2px 0 0', color: '#666' } }>{ __( 'Per-role insertion policies and editor setting locks.', 'block-ledger' ) }</p>
					</li>
				</ul>
			</PanelBody>
			) }
		
			</PanelBody>
		)
	);
}

function BlockLedgerSidebar() {
	return [
		el( PluginSidebarMoreMenuItem, { target: 'block-ledger/control', icon: 'shield' }, __( 'Block Ledger', 'block-ledger' ) ),
		el( PluginSidebar, { name: 'block-ledger/control', title: __( 'Block Ledger', 'block-ledger' ), icon: 'shield' },
			el( BlockLedgerFloatingContent )
		)
	];
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
// PluginSidebar disabled - using sidebar injection.
// const isAdminPage = !! document.getElementById( 'block-ledger-admin-root' );
// if ( ! isAdminPage ) {
// 	registerBlockLedgerPlugin();
// }

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
	// Editor context: inject into sidebar (React preserves insertBefore firstChild).
	const sidebar = document.querySelector( '.edit-post-sidebar, #editor-sidebar, .interface-interface-skeleton__sidebar' );
	const container = document.createElement( 'div' );
	container.id = 'block-ledger-panel';
	container.style.cssText = 'padding:12px;border-top:1px solid #ddd;background:#fff;';
	if ( sidebar ) {
		sidebar.insertBefore( container, sidebar.firstChild );
		console.log( 'Block Ledger: panel injected into sidebar' );
	} else {
		container.style.cssText = 'position:fixed;top:60px;right:20px;width:340px;max-height:calc(100vh - 80px);overflow-y:auto;background:#fff;border:1px solid #ddd;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,0.15);z-index:99999;font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,Oxygen-Sans,Ubuntu,Cantarell,\"Helvetica Neue\",sans-serif;font-size:13px;padding:12px;';
		document.body.appendChild( container );
		console.log( 'Block Ledger: floating panel rendered (fallback)' );
	}
	const root = window.wp.element.createRoot( container );
	root.render( window.wp.element.createElement( BlockLedgerFloatingContent ) );
}
setTimeout( mountBlockLedgerPanel, 800 );
