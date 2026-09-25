// UA detection also supports Electron/browser emulation without a touch screen.
export function isMobile( nav = globalThis.navigator ) {

	return !! nav && ( nav.userAgentData?.mobile === true ||
		/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test( nav.userAgent || '' ) ||
		( /Macintosh/.test( nav.userAgent || '' ) && nav.maxTouchPoints > 1 ) );

}
