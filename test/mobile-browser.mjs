// Run against `npm run dev` with Playwright installed (or set PLAYWRIGHT_MODULE).
// Optional: BROWSER_PATH, TEST_URL. This exercises real multi-touch via Chromium CDP.
import assert from 'node:assert/strict';
const { chromium } = await import( process.env.PLAYWRIGHT_MODULE || 'playwright' );
const browser = await chromium.launch( { headless: true, executablePath: process.env.BROWSER_PATH || undefined } );
const url = process.env.TEST_URL || 'http://127.0.0.1:5189/test/mobile-controls.html';
const errors = [];
try {
	const context = await browser.newContext( {
		viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
		userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
	} );
	const page = await context.newPage();
	page.on( 'pageerror', e => errors.push( e.message ) );
	await page.goto( url );
	await page.waitForFunction( () => window.fixture );
	assert.equal( await page.locator( '.tw-mobile-play' ).isVisible(), false );
	await page.getByRole( 'button', { name: 'Tap to explore', exact: true } ).tap();
	await page.locator( '.tw-mobile-pad' ).waitFor( { state: 'visible' } );
	assert.equal( await page.evaluate( () => document.pointerLockElement ), null );
	const cdp = await context.newCDPSession( page );
	const touch = ( type, touchPoints ) => cdp.send( 'Input.dispatchTouchEvent', { type, touchPoints } );
	const rect = async selector => {
		const b = await page.locator( selector ).boundingBox();
		return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
	};
	const pad = await rect( '.tw-mobile-pad' );
	const walk = { id: 1, x: pad.x, y: pad.y - 42 };
	const look = { id: 2, x: 220, y: 370 };
	await touch( 'touchStart', [ walk ] );
	await touch( 'touchStart', [ walk, look ] );
	await touch( 'touchMove', [ walk, { ...look, x: 245, y: 380 } ] );
	let result = await page.evaluate( () => ( { walk: fixture.input.down( 'KeyW' ), look: fixture.input.consumeLook(), cast: fixture.input.buttonDown( 0 ) } ) );
	assert.equal( result.walk, true );
	assert.ok( result.look.x > 20 && result.look.y > 5 );
	assert.equal( result.cast, false, 'looking does not cast' );
	await touch( 'touchEnd', [] );
	assert.equal( await page.evaluate( () => fixture.input.down( 'KeyW' ) ), false );
	await page.evaluate( () => fixture.input.endFrame() );

	const cast = { id: 3, ...await rect( '[data-action="cast"]' ) };
	await touch( 'touchStart', [ cast ] );
	assert.equal( await page.evaluate( () => fixture.input.buttonDown( 0 ) ), true );
	await page.evaluate( () => { fixture.input.endFrame(); fixture.game.rod.state = 'windup'; } );
	await touch( 'touchMove', [ { ...cast, x: 210, y: 500 } ] );
	await touch( 'touchEnd', [] );
	assert.equal( await page.evaluate( () => fixture.input.buttonDown( 0 ) ), false, 'release outside the button ends the hold' );

	await touch( 'touchStart', [ cast ] );
	await page.evaluate( () => { fixture.game.rod.state = 'windup'; fixture.input.endFrame(); } );
	await touch( 'touchCancel', [] );
	assert.deepEqual( await page.evaluate( () => [ fixture.input.buttonDown( 0 ), fixture.game.rod.state ] ), [ false, 'idle' ], 'cancel must not cast' );
	await touch( 'touchStart', [ walk ] );
	await page.evaluate( () => { fixture.ui.toggleHelp( true ); fixture.tick(); } );
	assert.equal( await page.evaluate( () => fixture.input.down( 'KeyW' ) ), false );
	assert.equal( await page.locator( '.tw-mobile-play' ).isVisible(), false );
	await touch( 'touchEnd', [] );
	await page.locator( '.tw-help-close' ).tap();
	await page.locator( '.tw-mobile-pad' ).waitFor( { state: 'visible' } );

	await page.locator( '[data-action="cooler"]' ).tap();
	assert.equal( await page.evaluate( () => fixture.input.hit( 'KeyI' ) ), true );
	await page.evaluate( () => { fixture.game.hud.toggleInventory( true ); fixture.tick(); } );
	assert.equal( await page.locator( '.tw-mobile-play' ).isVisible(), false );
	await page.locator( '.gm-panel.is-open [data-close]' ).tap();
	await page.locator( '.tw-mobile-pad' ).waitFor( { state: 'visible' } );
	await page.locator( '[data-action="run"]' ).tap();
	assert.equal( await page.evaluate( () => fixture.input.down( 'ShiftLeft' ) ), true );
	await page.evaluate( () => window.dispatchEvent( new Event( 'blur' ) ) );
	assert.equal( await page.evaluate( () => fixture.input.down( 'ShiftLeft' ) ), false );

	await page.evaluate( () => { fixture.app.player.mode = 'swim'; fixture.tick(); } );
	await page.getByRole( 'button', { name: 'Up', exact: true } ).tap();
	assert.equal( await page.evaluate( () => fixture.input.hit( 'Space' ) ), true );
	await page.getByRole( 'button', { name: 'Dive', exact: true } ).tap();
	assert.equal( await page.evaluate( () => fixture.input.hit( 'KeyC' ) ), true );
	await page.evaluate( () => { fixture.app.player.mode = 'boat'; fixture.tick(); } );
	await page.getByRole( 'button', { name: 'Camera', exact: true } ).tap();
	assert.equal( await page.evaluate( () => fixture.input.hit( 'KeyV' ) ), true );
	await page.evaluate( () => { fixture.app.player.mode = 'walk'; fixture.tick(); } );

	// Check every control's target stays on screen and does not overlap another.
	for ( const viewport of [ { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 320, height: 568 }, { width: 568, height: 320 } ] ) {
		for ( const mode of [ 'walk', 'boat', 'swim' ] ) {
			await page.evaluate( mode => {
				fixture.app.player.mode = mode;
				fixture.game.rod.state = mode === 'walk' ? 'floating' : 'stowed';
				fixture.ui.setBoatGauges( { visible: mode === 'boat', speedKnots: 12 } );
				fixture.ui.setDepth( { visible: mode === 'swim', meters: 8 } );
				fixture.game.hud.update( { fuel: mode === 'boat' ? { litres: 23, tank: 40 } : null, sonar: mode === 'boat' ? { depth: 12, fish: 0.5 } : null } );
				fixture.tick();
			}, mode );
			await page.setViewportSize( viewport );
			await page.waitForTimeout( 80 );
			const boxes = await page.locator( '.tw-mobile-button:visible, .tw-mobile-pad:visible, .gm-map, .gm-purse, .tw-stats, .tw-boat.is-on, .tw-depth.is-on' ).evaluateAll( els => els.map( e => {
				const r = e.getBoundingClientRect(); return { control: e.classList.contains( 'tw-mobile-button' ) || e.classList.contains( 'tw-mobile-pad' ), label: e.className, x: r.x, y: r.y, w: r.width, h: r.height };
			} ) );
			for ( const [ i, r ] of boxes.entries() ) {
				assert.ok( r.x >= 0 && r.y >= 0 && r.x + r.w <= viewport.width && r.y + r.h <= viewport.height, JSON.stringify( r ) );
				if ( r.control ) assert.ok( r.w >= 44 && r.h >= 44 );
				for ( const other of boxes.slice( i + 1 ) ) assert.ok( r.x + r.w <= other.x || other.x + other.w <= r.x || r.y + r.h <= other.y || other.y + other.h <= r.y, `${ viewport.width } ${ mode }: ${ JSON.stringify( r ) } overlaps ${ JSON.stringify( other ) }` );
			}
			await page.screenshot( { path: `/tmp/tidewater-mobile-${ viewport.width }-${ mode }.png` } );
		}	}
	await page.evaluate( () => { fixture.game.guide.show( 1 ); fixture.tick(); } );
	assert.equal( await page.locator( '.tw-mobile-play' ).isVisible(), false );
	assert.ok( !( await page.locator( '.gm-guide-body' ).innerText() ).includes( 'LMB' ) );
	await page.locator( '.gm-guide-skip' ).tap();
	await page.evaluate( () => { fixture.ui.setPhotoMode( true ); fixture.tick(); } );
	await page.getByRole( 'button', { name: 'Exit photo mode', exact: true } ).tap();
	assert.equal( await page.evaluate( () => fixture.ui._photo ), false );
	await page.evaluate( () => { fixture.game.hud.catchOpen = true; fixture.tick(); } );
	await page.getByRole( 'button', { name: 'Continue', exact: true } ).tap();
	assert.equal( await page.evaluate( () => fixture.game.hud.catchOpen ), false );
	await page.locator( '[data-action="menu"]' ).tap();
	assert.equal( await page.evaluate( () => fixture.ui.panelOpen ), true );
	assert.equal( await page.locator( '.tw-mobile-play' ).isVisible(), false );
	assert.deepEqual( errors, [] );
	await context.close();
	const desktop = await browser.newPage( { viewport: { width: 390, height: 844 } } );
	await desktop.goto( url );
	await desktop.waitForFunction( () => window.fixture );
	assert.equal( await desktop.locator( '.tw-mobile' ).count(), 0, 'small desktop windows retain desktop controls' );
	assert.equal( await desktop.getByRole( 'button', { name: 'Click to explore' } ).isVisible(), true );
	const emulated = await browser.newPage( { userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36' } );
	await emulated.goto( url );
	await emulated.waitForFunction( () => window.fixture );
	await emulated.getByRole( 'button', { name: 'Tap to explore' } ).click();
	await emulated.locator( '[data-action="jump"]' ).click();
	assert.equal( await emulated.evaluate( () => fixture.input.hit( 'Space' ) ), true, 'mobile UA alone enables controls with a mouse' );
	console.log( 'Mobile browser checks passed: multi-touch, fishing hold/cancel, menus, modes, blur, layouts, desktop UA' );
} finally { await browser.close(); }
