import './core/BenchSeed.js';
import { App } from './App.js';
import { UI } from './ui/UI.js';
import { AppUI } from './ui/AppUI.js';

// ?bench runs in background tabs too (automation): rAF does not fire in a hidden page
if ( /[?&]bench\b/.test( location.search ) ) {

	const raf = window.requestAnimationFrame.bind( window ), caf = window.cancelAnimationFrame.bind( window );
	window.requestAnimationFrame = ( cb ) => document.visibilityState === 'hidden' ? setTimeout( () => cb( performance.now() ), 16 ) : raf( cb );
	window.cancelAnimationFrame = ( id ) => ( clearTimeout( id ), caf( id ) );

}

const ui = new UI();
const app = new App();
window.__ui = ui;

app.init( ( p, text, until ) => ui.setLoading( p, text, until ) ).then( async () => {

	app.ui = new AppUI( app, ui );
	ui.setLoading( 1, 'Ready' );
	await ui.hideLoader();
	// frame-time benchmark and reference shots (see core/Bench.js): it drives the frames itself
	if ( app.qs.has( 'bench' ) ) window.__bench = new ( await import( './core/Bench.js' ) ).Bench( app );
	else app.start();
	ui.showStartOverlay( () => {

		app.input.requestLock();
		if ( app.audio ) app.audio.resume();

	} );

} ).catch( ( e ) => {

	console.error( e );
	ui.setLoadingError( 'Something went wrong: ' + e.message );

} );
