import './mobile.css';

// Pointer capture keeps each finger assigned to its original control, even
// outside that control. The canvas is the look surface; it never fires the rod.
export class MobileControls {

	constructor( app, ui ) {

		this.app = app;
		this.ui = ui;
		this.input = app.input;
		this.started = false;
		this.pointers = new Map();
		this.buttons = {};
		this.running = false;
		this.blocked = true;
		this.ac = new AbortController();
		const root = this.root = document.createElement( 'div' );
		root.className = 'tw-mobile';
		root.innerHTML = `<div class="tw-mobile-play" hidden>
			<div class="tw-mobile-tools tw-interactive" aria-label="Game actions"></div>
			<div class="tw-mobile-move tw-interactive">
				<div class="tw-mobile-pad" role="group" aria-label="Movement pad: drag to walk or steer">
					<span class="tw-mobile-pad-label">MOVE</span><span class="tw-mobile-stick"></span>
				</div>
			</div>
			<div class="tw-mobile-actions tw-interactive" aria-label="Movement and fishing"></div>
			<div class="tw-mobile-hint">Swipe the view to look</div>
		</div><div class="tw-mobile-resume tw-interactive" hidden></div>`;
		ui.root.append( root );
		this.play = root.querySelector( '.tw-mobile-play' );
		this.resume = root.querySelector( '.tw-mobile-resume' );
		this.pad = root.querySelector( '.tw-mobile-pad' );
		this.stick = root.querySelector( '.tw-mobile-stick' );
		this.hint = root.querySelector( '.tw-mobile-hint' );
		const tools = root.querySelector( '.tw-mobile-tools' );
		const actions = root.querySelector( '.tw-mobile-actions' );
		this.keyButton( tools, 'rod', 'Rod', 'KeyR' );
		this.keyButton( tools, 'cooler', 'Cooler', 'KeyI' );
		this.keyButton( tools, 'camera', 'Camera', 'KeyV' );
		this.keyButton( tools, 'light', 'Light', 'KeyL' );
		this.clickButton( tools, 'menu', 'Settings', () => ui.togglePanel( true ) );
		this.clickButton( tools, 'help', 'Help', () => ui.toggleHelp( true ) );
		this.clickButton( root.querySelector( '.tw-mobile-move' ), 'run', 'Run', () => {

			this.running = ! this.running;
			this.input.setVirtualKey( 'ShiftLeft', this.running );
			this.buttons.run.setAttribute( 'aria-pressed', String( this.running ) );

		} );
		this.buttons.run.setAttribute( 'aria-pressed', 'false' );
		this.keyButton( actions, 'interact', 'Interact', 'KeyE' );
		this.keyButton( actions, 'jump', 'Jump', 'Space' );
		this.keyButton( actions, 'dive', 'Dive', 'KeyC' );
		this.holdButton( actions, 'retrieve', 'Retrieve', down => this.input.setVirtualButton( 2, down ) );
		this.holdButton( actions, 'cast', 'Cast', down => this.input.setVirtualButton( 0, down ) );
		this.buttons.cast.classList.add( 'is-primary' );
		this.clickButton( this.resume, 'resume', 'Continue', () => {

			if ( ui._photo ) ui.setPhotoMode( false );
			else if ( app.game.hud?.catchOpen ) app.game.endLanding();

		}, true );

		// Prevent compatibility mouse/click events reaching gameplay listeners.
		for ( const type of [ 'mousedown', 'mouseup', 'click', 'contextmenu' ] ) {

			this.listen( root, type, e => { e.stopPropagation(); if ( type === 'contextmenu' ) e.preventDefault(); } );

		}
		this.gesture( this.pad, 'move', e => this.move( e ), e => this.move( e ), () => this.stopMove() );
		this.oldTouchAction = this.input.dom.style.touchAction;
		this.input.dom.style.touchAction = 'none';
		this.gesture( this.input.dom, 'look', e => { this.lookPoint = [ e.clientX, e.clientY ]; }, e => {

			this.input.look.x += e.clientX - this.lookPoint[ 0 ];
			this.input.look.y += e.clientY - this.lookPoint[ 1 ];
			this.lookPoint = [ e.clientX, e.clientY ];

		} );
		this.listen( window, 'blur', () => this.reset() );
		this.listen( window, 'resize', () => this.reset() );
		this.listen( document, 'visibilitychange', () => { if ( document.hidden ) this.reset(); } );

	}

	listen( el, type, fn ) {

		el.addEventListener( type, fn, { signal: this.ac.signal } );

	}

	button( parent, id, label ) {

		const b = document.createElement( 'button' );
		b.type = 'button';
		b.className = 'tw-mobile-button';
		b.textContent = label;
		b.dataset.action = id;
		parent.append( b );
		this.buttons[ id ] = b;
		return b;

	}

	clickButton( parent, id, label, fn, allowBlocked = false ) {

		const b = this.button( parent, id, label );
		this.listen( b, 'click', () => {

			if ( ! allowBlocked && this.isBlocked() ) return;
			fn();
			b.blur();
			this.update();

		} );

	}

	keyButton( parent, id, label, code ) {

		this.holdButton( parent, id, label, down => this.input.setVirtualKey( code, down ) );

	}

	holdButton( parent, id, label, fn ) {

		const b = this.button( parent, id, label );
		this.gesture( b, id, () => { b.classList.add( 'is-held' ); fn( true ); }, null,
			() => { b.classList.remove( 'is-held' ); fn( false ); } );

	}

	gesture( el, name, start, move, end = () => {} ) {

		this.listen( el, 'pointerdown', e => {

			if ( e.button !== 0 || el.disabled || this.isBlocked() ||
				[ ...this.pointers.values() ].some( p => p.name === name ) ) return;
			e.preventDefault();
			el.setPointerCapture( e.pointerId );
			this.pointers.set( e.pointerId, { name, el, end } );
			start( e );

		} );
		this.listen( el, 'pointermove', e => {

			if ( this.pointers.get( e.pointerId )?.el !== el ) return;
			if ( this.isBlocked() ) { this.reset(); return; }
			move?.( e );

		} );
		const finish = e => {

			if ( this.pointers.get( e.pointerId )?.el !== el ) return;
			if ( e.type !== 'pointerup' ) { this.reset(); return; }
			this.pointers.delete( e.pointerId );
			end();
			if ( el.hasPointerCapture( e.pointerId ) ) el.releasePointerCapture( e.pointerId );

		};
		for ( const type of [ 'pointerup', 'pointercancel', 'lostpointercapture' ] ) this.listen( el, type, finish );

	}

	move( e ) {

		const r = this.pad.getBoundingClientRect();
		const radius = r.width * 0.34;
		let x = ( e.clientX - r.left - r.width / 2 ) / radius;
		let y = ( e.clientY - r.top - r.height / 2 ) / radius;
		const length = Math.max( 1, Math.hypot( x, y ) );
		x /= length; y /= length;
		this.stick.style.transform = `translate(${ x * radius }px, ${ y * radius }px)`;
		for ( const [ key, down ] of [ [ 'KeyA', x < -0.28 ], [ 'KeyD', x > 0.28 ], [ 'KeyW', y < -0.28 ], [ 'KeyS', y > 0.28 ] ] ) {

			this.input.setVirtualKey( key, down );

		}

	}

	stopMove() {

		for ( const key of [ 'KeyW', 'KeyA', 'KeyS', 'KeyD' ] ) this.input.setVirtualKey( key, false );
		this.stick.style.transform = '';

	}

	isBlocked() {

		const ui = this.ui, game = this.app.game, hud = game.hud;
		return ! this.started || document.hidden || ui._start || ui._help || ui._photo || ui.panelOpen ||
			game.guide?.open || hud?.invOpen || hud?.standOpen || hud?.catchOpen;

	}

	reset() {

		const pointers = [ ...this.pointers ];
		this.pointers.clear();
		for ( const [ id, p ] of pointers ) {

			p.end();
			if ( p.el.hasPointerCapture( id ) ) p.el.releasePointerCapture( id );

		}
		this.stopMove();
		this.running = false;
		this.buttons.run.setAttribute( 'aria-pressed', 'false' );
		this.input.resetVirtual();
		this.input.look.x = this.input.look.y = 0;
		// Losing a gesture or opening a menu cancels a windup; it isn't a cast.
		if ( this.app.game.rod.state === 'windup' ) this.app.game.cancelLine( true );

	}

	update() {

		const blocked = !! this.isBlocked(), game = this.app.game, rod = game.rod;
		if ( blocked && ! this.blocked ) this.reset();
		this.blocked = blocked;
		this.play.hidden = blocked;
		this.resume.hidden = ! this.started || ! ( this.ui._photo || game.hud?.catchOpen );
		this.buttons.resume.textContent = this.ui._photo ? 'Exit photo mode' : 'Continue';
		if ( blocked ) return;
		const mode = this.app.player.mode, swim = mode === 'swim' || this.app.freeCam;
		this.buttons.jump.textContent = swim ? 'Up' : 'Jump';
		this.buttons.jump.hidden = mode === 'boat';
		this.buttons.dive.hidden = ! swim;
		this.buttons.camera.hidden = mode !== 'boat';
		this.buttons.run.textContent = mode === 'boat' ? 'Boost' : 'Run';
		this.buttons.rod.disabled = ! game.canFish || !! game.fight;
		this.buttons.rod.setAttribute( 'aria-pressed', String( rod.equipped ) );
		this.buttons.cast.disabled = ! game.canFish || ! rod.equipped || ! [ 'idle', 'windup', 'floating', 'fighting' ].includes( rod.state );
		this.buttons.cast.textContent = rod.state === 'windup' ? 'Release' : rod.state === 'floating' ? 'Strike' : game.fight ? 'Reel' : 'Cast';
		this.buttons.retrieve.hidden = ! [ 'flying', 'floating', 'retrieving' ].includes( rod.state );
		let hint = 'Swipe the view to look';
		if ( rod.equipped ) {

			if ( rod.state === 'idle' ) hint = 'Hold Cast, then release';
			else if ( rod.state === 'windup' ) hint = 'Release to cast · hold longer to cast farther';
			else if ( rod.state === 'floating' ) hint = game.bite?.phase === 'take' ? 'Tap Strike now!'
				: game.bite?.phase === 'nibble' ? 'Nibbling · wait until the bobber goes under' : 'Waiting for a bite · Retrieve brings the line back';
			else if ( game.fight ) hint = 'Hold Reel · let go when tension turns red';

		}
		this.hint.textContent = this.app.player.prompt?.key === 'E'
			? this.app.player.prompt.text.replace( /\s*·\s*V\s+camera/, ' · Camera to change view' ) : hint;

	}

	dispose() {

		this.reset();
		this.ac.abort();
		this.input.dom.style.touchAction = this.oldTouchAction;
		this.root.remove();

	}

}
