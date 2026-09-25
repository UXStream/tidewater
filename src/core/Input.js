import { isMobile } from './Platform.js';

// Physical and virtual input stay independent so touch can coexist with a keyboard.
export class Input {

	constructor( dom ) {

		this.dom = dom;
		this.mobile = isMobile();
		this.keys = new Set();
		this.pressed = new Set();
		this.virtualKeys = new Set();
		this.virtualPressed = new Set();
		this.virtualButtons = new Set();
		this.virtualClicks = new Set();
		this.look = { x: 0, y: 0 };
		this.wheel = 0;
		this.mouseDown = false;
		this.rightDown = false;
		this.locked = false;
		this.enabled = true;

		window.addEventListener( 'keydown', ( e ) => {

			if ( e.target && ( e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA' ) ) return;
			if ( ! this.keys.has( e.code ) ) this.pressed.add( e.code );
			this.keys.add( e.code );
			if ( [ 'Space', 'ArrowUp', 'ArrowDown', 'Tab' ].includes( e.code ) ) e.preventDefault();

		} );
		window.addEventListener( 'keyup', ( e ) => this.keys.delete( e.code ) );
		const reset = () => {

			this.keys.clear();
			this.pressed.clear();
			this.mouseDown = this.rightDown = false;
			this.resetVirtual();
			this.look.x = this.look.y = this.wheel = 0;

		};
		window.addEventListener( 'blur', reset );
		document.addEventListener( 'visibilitychange', () => { if ( document.hidden ) reset(); } );

		dom.addEventListener( 'mousedown', ( e ) => {

			if ( this.mobile ) return; // Mobile view uses pointer gestures; a swipe must never cast.
			if ( e.button === 0 ) this.mouseDown = true;
			if ( e.button === 2 ) this.rightDown = true;

		} );
		window.addEventListener( 'mouseup', ( e ) => {

			if ( e.button === 0 ) this.mouseDown = false;
			if ( e.button === 2 ) this.rightDown = false;

		} );
		dom.addEventListener( 'contextmenu', ( e ) => e.preventDefault() );
		window.addEventListener( 'mousemove', ( e ) => {

			if ( this.locked || this.mouseDown || this.rightDown ) {

				this.look.x += e.movementX;
				this.look.y += e.movementY;

			}

		} );
		dom.addEventListener( 'wheel', ( e ) => {

			this.wheel += Math.sign( e.deltaY );
			e.preventDefault();

		}, { passive: false } );

		document.addEventListener( 'pointerlockchange', () => {

			this.locked = document.pointerLockElement === dom;

		} );

	}

	requestLock() {

		if ( ! this.mobile && ! this.locked ) this.dom.requestPointerLock?.()?.catch?.( () => {} );

	}

	down( code ) {

		return this.enabled && ( this.keys.has( code ) || this.virtualKeys.has( code ) );

	}

	// True once per physical or virtual key press.
	hit( code ) {

		return this.enabled && ( this.pressed.has( code ) || this.virtualPressed.has( code ) );

	}

	setVirtualKey( code, down ) {

		if ( down ) {

			if ( ! this.virtualKeys.has( code ) ) this.virtualPressed.add( code );
			this.virtualKeys.add( code );

		} else this.virtualKeys.delete( code );

	}

	setVirtualButton( button, down ) {

		if ( down ) {

			this.virtualButtons.add( button );
			this.virtualClicks.add( button ); // Preserve taps shorter than a frame.

		} else this.virtualButtons.delete( button );

	}

	buttonDown( button ) {

		return this.enabled && ( ( button === 0 ? this.mouseDown : this.rightDown ) ||
			this.virtualButtons.has( button ) || this.virtualClicks.has( button ) );

	}

	resetVirtual() {

		this.virtualKeys.clear();
		this.virtualPressed.clear();
		this.virtualButtons.clear();
		this.virtualClicks.clear();

	}

	consumeLook() {

		const l = { x: this.look.x, y: this.look.y };
		this.look.x = 0;
		this.look.y = 0;
		return l;

	}

	consumeWheel() {

		const w = this.wheel;
		this.wheel = 0;
		return w;

	}

	endFrame() {

		this.pressed.clear();
		this.virtualPressed.clear();
		this.virtualClicks.clear();

	}

}
