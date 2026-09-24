import * as THREE from '../engine/index.js';
import { UI } from './UI.js';
import { G } from '../core/Globals.js';
import { GroundBounce } from '../materials/GroundBounce.js';
import { ContactShadows } from '../materials/ContactShadows.js';

// Binds the Tidewater UI (panel + HUD) to the running app.
const SEA = {
	Calm: { wind: 3.5, fetch: 40, chop: 0.75, swell: 0.28, surf: 0.18, period: 11, whitecaps: 0.2 },
	Breezy: { wind: 7, fetch: 120, chop: 0.9, swell: 0.48, surf: 0.34, period: 9, whitecaps: 0.5 },
	Choppy: { wind: 12, fetch: 300, chop: 1.05, swell: 0.68, surf: 0.56, period: 8.5, whitecaps: 0.75 },
	Storm: { wind: 20, fetch: 900, chop: 1.2, swell: 1.0, surf: 0.9, period: 12, whitecaps: 1 },
};

export class AppUI {

	constructor( app, ui = new UI() ) {

		this.app = app;
		this.ui = ui;
		const fft = app.fft;
		const shore = app.shore;

		// ---- plain values the controls bind to; onChange pushes them into the simulation
		const s = this.s = {
			wind: fft.local.windSpeed,
			windDir: fft.local.windDirection,
			fetch: fft.local.fetch,
			chop: fft.choppiness.value,
			swell: fft.swell.scale,
			whitecaps: 0.5,
			clarity: 1,
			surf: shore.amplitude.value,
			period: shore.period.value,
			gamma: shore.gamma.value,
			curl: shore.curl.value,
			caustics: app.caustics ? app.caustics.strength.value : 1,
			time: app.settings.timeOfDay,
			advance: app.settings.timeSpeed !== 0,
			timeSpeed: app.settings.timeSpeed || 0.05,
			clouds: app.clouds ? app.clouds.coverage.value : 0.45,
			cirrus: app.clouds && app.clouds.cirrus ? app.clouds.cirrus.value : 0.5,
			exposure: 0,
			fov: app.camera.fov,
			camMode: 'third',
			ao: app.post.params.aoStrength.value,
			bloom: app.post.params.bloom.value,
			flare: app.post.flare ? app.post.flare.strength.value : 1,
			vignette: app.post.params.vignette.value,
			saturation: app.post.params.saturation.value,
			contrast: app.post.params.contrast.value,
			grain: app.post.params.grain.value,
			renderScale: app.settings.renderScale,
			shadows: true,
		};

		const spectrum = () => {

			fft.local.windSpeed = s.wind;
			fft.local.windDirection = s.windDir;
			fft.local.fetch = s.fetch;
			fft.swell.scale = s.swell;
			fft.updateSpectrumUniforms();
			const a = THREE.MathUtils.degToRad( s.windDir );
			G.windDir.value.set( Math.cos( a ), Math.sin( a ) );
			G.windSpeed.value = s.wind;

		};

		const whitecaps = () => {

			// more whitecaps: foam starts at less compression (and more of it in fresh wind), lasts longer.
			// Only crests near breaking (strong compression) foam: a laxer threshold paints every crest line
			// with a white streak, which real open water at these wind speeds doesn't have.
			fft.foamBias.value = 0.5 + 0.16 * s.whitecaps + 0.01 * THREE.MathUtils.clamp( s.wind - 7, - 5, 12 );
			fft.foamDecay.value = 0.6 - 0.35 * s.whitecaps;

		};

		const clarity = () => {

			// scale absorption/scattering around the tropical defaults
			const k = 1 / Math.max( 0.2, s.clarity );
			G.waterAbsorption.value.set( 0.42, 0.075, 0.035 ).multiplyScalar( 0.6 + 0.4 * k );
			G.waterScattering.value.set( 0.012, 0.018, 0.024 ).multiplyScalar( k * k );

		};

		// ---------------------------------------------------------------- Ocean
		const ocean = ui.addTab( 'ocean', 'Ocean', 'ocean' );
		const sea = ocean.addFolder( 'Sea state', { icon: 'wind' } );
		sea.addPresets( {
			label: 'Conditions', active: 'Breezy',
			presets: Object.keys( SEA ).map( ( k ) => ( {
				label: k, icon: k.toLowerCase(),
				apply: () => {

					const p = SEA[ k ];
					Object.assign( s, p );
					spectrum();
					whitecaps();
					fft.choppiness.value = s.chop;
					shore.amplitude.value = s.surf;
					shore.period.value = s.period;

				},
			} ) ),
		} );
		sea.addSlider( { label: 'Wind speed', object: s, key: 'wind', min: 0.5, max: 30, step: 0.1, unit: 'm/s', tooltip: 'Wind 10 m above the sea. Drives the local wind waves, whitecaps and spray.', onChange: () => {

			spectrum();
			whitecaps();

		} } );
		sea.addSlider( { label: 'Wind direction', object: s, key: 'windDir', min: 0, max: 360, step: 1, unit: '°', onChange: spectrum } );
		sea.addSlider( { label: 'Fetch', object: s, key: 'fetch', min: 5, max: 2000, log: true, unit: 'km', tooltip: 'Distance the wind has blown over open water: longer fetch, longer and higher waves.', onChange: spectrum } );
		sea.addSlider( { label: 'Choppiness', object: s, key: 'chop', min: 0, max: 1.6, step: 0.01, tooltip: 'Horizontal displacement: sharp crests, wide troughs.', onChange: ( v ) => { fft.choppiness.value = v; } } );
		sea.addSlider( { label: 'Ocean swell', object: s, key: 'swell', min: 0, max: 2, step: 0.01, onChange: spectrum } );
		sea.addSlider( { label: 'Whitecaps', object: s, key: 'whitecaps', min: 0, max: 1, step: 0.01, onChange: whitecaps } );
		const water = ocean.addFolder( 'Water', { icon: 'droplet' } );
		water.addSlider( { label: 'Clarity', object: s, key: 'clarity', min: 0.3, max: 2, step: 0.01, tooltip: 'Lower = more suspended sediment and plankton (greener, murkier).', onChange: clarity } );

		// ---------------------------------------------------------------- Shore
		const shoreTab = ui.addTab( 'shore', 'Shore', 'shore' );
		const surf = shoreTab.addFolder( 'Surf', { icon: 'wave' } );
		surf.addSlider( { label: 'Wave height', object: s, key: 'surf', min: 0, max: 1.4, step: 0.01, unit: 'm', format: ( v ) => `${ ( v * 2 ).toFixed( 2 ) } m`, onChange: ( v ) => { shore.amplitude.value = v; } } );
		surf.addSlider( { label: 'Wave period', object: s, key: 'period', min: 5, max: 16, step: 0.1, unit: 's', onChange: ( v ) => { shore.period.value = v; } } );
		surf.addSlider( { label: 'Breaking depth ratio', object: s, key: 'gamma', min: 0.5, max: 1.1, step: 0.01, tooltip: 'Waves break when height exceeds this fraction of the depth.', onChange: ( v ) => { shore.gamma.value = v; } } );
		surf.addSlider( { label: 'Curl', object: s, key: 'curl', min: 0, max: 1.5, step: 0.01, onChange: ( v ) => { shore.curl.value = v; } } );
		if ( app.breakers ) {

			s.spray = app.breakers.params.spray.value;
			s.lip = app.breakers.params.sheet.value;
			surf.addSlider( { label: 'Spray', object: s, key: 'spray', min: 0, max: 2, step: 0.01, tooltip: 'Droplets and mist thrown off breaking crests.', onChange: ( v ) => { app.breakers.params.spray.value = v; } } );
			surf.addSlider( { label: 'Lip sheet', object: s, key: 'lip', min: 0, max: 1.5, step: 0.01, tooltip: 'The thin sheet of water thrown forward by plunging breakers.', onChange: ( v ) => { app.breakers.params.sheet.value = v; } } );

		}

		if ( app.wake ) {

			const boat = shoreTab.addFolder( 'Boat wake', { icon: 'wave', open: false } );
			s.wakeHeight = app.wake.amplitude.value;
			s.wakeFoam = app.wake.foamGain.value;
			boat.addSlider( { label: 'Wake height', object: s, key: 'wakeHeight', min: 0, max: 2, step: 0.01, onChange: ( v ) => { app.wake.amplitude.value = v; } } );
			boat.addSlider( { label: 'Wake foam', object: s, key: 'wakeFoam', min: 0, max: 1.5, step: 0.01, onChange: ( v ) => { app.wake.foamGain.value = v; } } );

		}
		if ( app.caustics ) {

			const light = shoreTab.addFolder( 'Caustics', { icon: 'sun', open: false } );
			light.addSlider( { label: 'Intensity', object: s, key: 'caustics', min: 0, max: 2, step: 0.01, onChange: ( v ) => { app.caustics.strength.value = v; } } );

		}

		// ---------------------------------------------------------------- Sky
		const sky = ui.addTab( 'sky', 'Sky', 'sky' );
		const sun = sky.addFolder( 'Sun', { icon: 'clock' } );
		sun.addTimeOfDay( { object: app.settings, key: 'timeOfDay' } );
		sun.addSlider( { label: 'Sun azimuth', object: app.settings, key: 'sunAzimuth', min: - 180, max: 180, step: 1, format: ( v ) => `${ Math.round( v ) }°`, tooltip: 'Turns the sun\'s path around the island (0 = the real path: rises in the east, sets in the west).' } );
		let speed = null;
		sun.addToggle( { label: 'Advance time', object: s, key: 'advance', onChange: ( v ) => {

			app.settings.timeSpeed = v ? s.timeSpeed : 0;
			speed.setVisible( v );

		} } );
		speed = sun.addSlider( { label: 'Time speed', object: s, key: 'timeSpeed', min: 0.002, max: 1, log: true, unit: 'h/s', onChange: ( v ) => { if ( s.advance ) app.settings.timeSpeed = v; } } ).setVisible( s.advance );
		const atmo = sky.addFolder( 'Atmosphere', { icon: 'cloud' } );
		if ( app.clouds ) atmo.addSlider( { label: 'Cloud cover', object: s, key: 'clouds', min: 0, max: 1, step: 0.01, format: ( v ) => `${ Math.round( v * 100 ) }%`, onChange: ( v ) => { app.clouds.coverage.value = v; } } );
		if ( app.clouds && app.clouds.cirrus ) atmo.addSlider( { label: 'Cirrus', object: s, key: 'cirrus', min: 0, max: 1, step: 0.01, format: ( v ) => `${ Math.round( v * 100 ) }%`, onChange: ( v ) => { app.clouds.cirrus.value = v; } } );
		if ( app.haze ) {

			s.haze = app.haze.density.value;
			s.shafts = app.haze.shafts.value;
			atmo.addSlider( { label: 'Haze', object: s, key: 'haze', min: 0, max: 4, step: 0.05, tooltip: 'Aerial perspective and marine haze density (1 = about 20 km visibility at sea level, 0 = clear air).', onChange: ( v ) => { app.haze.density.value = v; } } );
			atmo.addSlider( { label: 'Sun shafts', object: s, key: 'shafts', min: 0, max: 3, step: 0.05, tooltip: 'Volumetric light shafts and crepuscular rays in the haze (shadows of palms, the pier, hills and clouds). 0 turns them off.', onChange: ( v ) => { app.haze.shafts.value = v; } } );

		}
		if ( app.airMotes ) {

			s.air = app.airMotes.intensity.value;
			atmo.addSlider( { label: 'Air particles', object: s, key: 'air', min: 0, max: 2, step: 0.01, tooltip: 'Dust, pollen, salt haze, seed fluff and the odd gnat drifting in the air: they catch the light when backlit by the sun. 0 turns them off.', onChange: ( v ) => { app.airMotes.intensity.value = v; } } );

		}

		atmo.addSlider( { label: 'Exposure', object: s, key: 'exposure', min: - 3, max: 3, step: 0.1, unit: 'EV', onChange: ( v ) => { app.settings.exposure = 0.55 * Math.pow( 2, v ); } } );

		// ---------------------------------------------------------------- Camera
		const cam = ui.addTab( 'camera', 'Camera', 'camera' );
		const view = cam.addFolder( 'View', { icon: 'camera' } );
		view.addSelect( { label: 'Boat camera', object: s, key: 'camMode', options: [ { label: '1st person', value: 'first' }, { label: '3rd person', value: 'third' } ], onChange: ( v ) => { app.player.camMode = v; } } );
		view.addSlider( { label: 'Field of view', object: s, key: 'fov', min: 35, max: 100, step: 1, unit: '°', onChange: ( v ) => {

			app.camera.fov = v;
			app.camera.updateProjectionMatrix();

		} } );
		view.addButton( { label: 'Free camera (F)', icon: 'camera', onClick: () => app.setFreeCam( ! app.freeCam ) } );

		// ---------------------------------------------------------------- Effects
		const fx = ui.addTab( 'effects', 'Effects', 'effects' );
		const post = fx.addFolder( 'Post-processing', { icon: 'sparkles' } );
		const P = app.post.params;
		post.addSlider( { label: 'Ambient occlusion', object: s, key: 'ao', min: 0, max: 1.5, step: 0.01, onChange: ( v ) => { P.aoStrength.value = v; } } );
		s.bounce = GroundBounce.strength.value;
		s.contact = ContactShadows.strength.value;
		post.addSlider( { label: 'Bounce light', object: s, key: 'bounce', min: 0, max: 2, step: 0.01, tooltip: 'Sunlight reflected off the ground (bright sand) onto undersides and shaded faces: pier, eaves, hulls, trunks. 0 = off.', onChange: ( v ) => { GroundBounce.strength.value = v; } } );
		post.addSlider( { label: 'Contact shadows', object: s, key: 'contact', min: 0, max: 1, step: 0.01, tooltip: 'Screen-space sun shadows of small details the shadow maps miss (pebbles, shells, grass, rope). 0 = off.', onChange: ( v ) => { ContactShadows.strength.value = v; } } );
		s.sharpen = P.sharpen.value;
		post.addSlider( { label: 'Sharpen', object: s, key: 'sharpen', min: 0, max: 1, step: 0.01, tooltip: 'Contrast-adaptive sharpening after the temporal anti-aliasing.', onChange: ( v ) => { P.sharpen.value = v; } } );
		if ( app.post.motionBlur ) {

			const mb = app.post.motionBlur.shutter;
			s.motionBlur = mb.value;
			post.addSlider( { label: 'Motion blur', object: s, key: 'motionBlur', min: 0, max: 1, step: 0.05, format: ( v ) => v > 0 ? `${ Math.round( v * 360 ) }°` : 'Off', tooltip: 'Camera and object motion blur, as a shutter angle (180° = film look). 0 turns it off.', onChange: ( v ) => { mb.value = v; } } );

		}

		post.addSlider( { label: 'Bloom', object: s, key: 'bloom', min: 0, max: 0.3, step: 0.005, onChange: ( v ) => { P.bloom.value = v; } } );
		if ( app.post.flare ) post.addSlider( { label: 'Lens flare', object: s, key: 'flare', min: 0, max: 2, step: 0.05, onChange: ( v ) => { app.post.flare.strength.value = v; } } );
		post.addSlider( { label: 'Saturation', object: s, key: 'saturation', min: 0.5, max: 1.5, step: 0.01, onChange: ( v ) => { P.saturation.value = v; } } );
		post.addSlider( { label: 'Contrast', object: s, key: 'contrast', min: 0.8, max: 1.3, step: 0.01, onChange: ( v ) => { P.contrast.value = v; } } );
		post.addSlider( { label: 'Vignette', object: s, key: 'vignette', min: 0, max: 1, step: 0.01, onChange: ( v ) => { P.vignette.value = v; } } );
		post.addSlider( { label: 'Film grain', object: s, key: 'grain', min: 0, max: 0.06, step: 0.001, onChange: ( v ) => { P.grain.value = v; } } );

		// ---------------------------------------------------------------- Performance
		const perf = ui.addTab( 'performance', 'Performance', 'performance' );
		const live = perf.addFolder( 'Live', { icon: 'gauge' } );
		live.addInfo( { label: 'Frame rate', get: () => `${ ( app.fps || 0 ).toFixed( 0 ) } fps` } );
		live.addInfo( { label: 'CPU per frame', get: () => `${ ( app.cpuMs || 0 ).toFixed( 2 ) } ms` } );
		live.addInfo( { label: 'Render size', get: () => `${ app.sceneRenderer.width } × ${ app.sceneRenderer.height }` } );
		const quality = perf.addFolder( 'Quality', { icon: 'layers' } );
		quality.addSlider( { label: 'Render scale', object: s, key: 'renderScale', min: 0.5, max: 1, step: 0.05, format: ( v ) => `${ Math.round( v * 100 ) }%`, tooltip: 'Internal resolution; the temporal upscaler reconstructs the full output resolution.', onChange: ( v ) => app.setRenderScale( v ) } );
		s.aa = app.post.aaMode;
		quality.addSelect( { label: 'Anti-aliasing', object: s, key: 'aa', tooltip: 'TAA: temporal anti-aliasing and upscaling (also resolves the dithered fades and soft shadow noise). SMAA / FXAA: spatial filters, sharper in motion, no upscaling.', options: [ { label: 'None', value: 'none' }, { label: 'TAA', value: 'taa' }, { label: 'SMAA', value: 'smaa' }, { label: 'FXAA', value: 'fxaa' } ], onChange: ( v ) => { app.post.aaMode = v; } } );
		quality.addToggle( { label: 'Shadows', object: s, key: 'shadows', onChange: ( v ) => { app.shadows.enabled = v; } } );
		s.ssr = true;
		quality.addToggle( { label: 'Water reflections', object: s, key: 'ssr', tooltip: 'Screen-space reflections of the pier, boats and hills on the water.', onChange: ( v ) => { app.waterMaterial.params.ssr.value = v ? 1 : 0; } } );

		// TAA tuning (TemporalUpscale settings; the defaults are FSR2's except the two marked)
		const taau = app.post.taau;
		const T = taau.settings;
		const taa = perf.addFolder( 'TAA', { icon: 'layers', open: false } );
		for ( const k of [ 'boxStill', 'boxMotion', 'maxAccumulation', 'motionAccumulation', 'blurComp', 'lockThreshold' ] ) s[ k ] = T[ k ].value;
		s.locks = T.locks.value > 0;
		s.instability = T.instability.value > 0;
		s.phases = taau.jitterPhaseOverride;
		s.debug = taau.debugView;
		const taaSlider = ( key, label, min, max, step, tooltip, format ) => taa.addSlider( { label, object: s, key, min, max, step, tooltip, format, onChange: ( v ) => { T[ key ].value = v; } } );
		taa.addSelect( { label: 'Debug view', object: s, key: 'debug', tooltip: 'Shows what the TAA does per pixel over a grey image.', options: taau.constructor.DEBUG_VIEWS.map( ( label, value ) => ( { label, value } ) ), onChange: ( v ) => { taau.debugView = Number( v ); } } );
		taaSlider( 'boxStill', 'Clamp width still', 0.5, 8, 0.1, 'How far (in standard deviations of the 3x3 neighbourhood) the history may differ from the new frame before it is clamped, with a still camera. Wider: steadier sub-pixel detail, more ghosting. FSR2: 1 at native resolution (default here 3).', ( v ) => `${ v.toFixed( 1 ) }σ` );
		taaSlider( 'boxMotion', 'Clamp width moving', 0.25, 4, 0.05, 'The same at 20 px per frame of motion and above (it narrows with speed). FSR2: 1.', ( v ) => `${ v.toFixed( 2 ) }σ` );
		taaSlider( 'maxAccumulation', 'History length', 0.25, 4, 0.05, 'How many frames the history averages with a still camera (1 ≈ 13 frames). Longer: steadier, slower to react to lighting changes. FSR2: 1 (default here 2).', ( v ) => `${ Math.round( 1 + v * 12 ) } frames` );
		taaSlider( 'motionAccumulation', 'History length moving', 1, 40, 1, 'Cap on the history length once anything moves (in frames). FSR2: 10.', ( v ) => `${ v } frames` );
		taaSlider( 'blurComp', 'Blur compensation', 0, 2, 0.05, 'In motion the history is resampled between pixels every frame and softens; this gives blurred history more of the sharp new frame. 0 = FSR2 (default here 0.5).' );
		taaSlider( 'lockThreshold', 'Thin feature threshold', 1.0, 1.5, 0.01, 'Brightness ratio under which a neighbour counts as similar when looking for one-pixel-wide features to lock. Higher: more pixels count as thin features. FSR2: 1.05.' );
		s.staticKeep = T.staticKeep.value > 0;
		taa.addToggle( { label: 'Keep still pixels', object: s, key: 'staticKeep', tooltip: 'With the camera still, pixels keep their history unless their local brightness really changed (not in FSR2). Stops thin distant detail flickering while standing still.', onChange: ( v ) => { T.staticKeep.value = v ? 1 : 0; } } );
		taa.addToggle( { label: 'Thin feature locks', object: s, key: 'locks', tooltip: 'FSR2: one-pixel-wide ridges (rails, wires, plank gaps) keep their history instead of being clamped.', onChange: ( v ) => { T.locks.value = v ? 1 : 0; } } );
		taa.addToggle( { label: 'Luma instability', object: s, key: 'instability', tooltip: 'FSR2: a pixel whose brightness oscillates over the last 4 frames keeps its history instead of being clamped.', onChange: ( v ) => { T.instability.value = v ? 1 : 0; } } );
		s.jitterScale = taau.jitterScale;
		taa.addSlider( { label: 'Jitter amount', object: s, key: 'jitterScale', min: 0, max: 1, step: 0.05, tooltip: 'Size of the per-frame sub-pixel camera offset the TAA averages over. 1: a full pixel (FSR2). Less: steadier thin detail, but edges get less anti-aliasing; 0 turns the jitter off.', onChange: ( v ) => { taau.jitterScale = v; } } );
		s.jitterMoving = taau.jitterMoving;
		taa.addSlider( { label: 'Jitter when moving', object: s, key: 'jitterMoving', min: 0, max: 1, step: 0.05, tooltip: 'Jitter amount (times the above) while the camera moves. Walking already moves the samples across the pixels; the jitter on top makes distant thin detail flicker. 1: always full.', onChange: ( v ) => { taau.jitterMoving = v; } } );
		taa.addSelect( { label: 'Jitter phases', object: s, key: 'phases', tooltip: 'Length of the sub-pixel jitter sequence. Auto: FSR2 (8 at native resolution).', options: [ { label: 'Auto', value: 0 }, { label: '4', value: 4 }, { label: '8', value: 8 }, { label: '16', value: 16 }, { label: '32', value: 32 } ], onChange: ( v ) => { taau.jitterPhaseOverride = Number( v ); } } );

		this._t = 0;

	}

	// per-frame HUD
	update( dt ) {

		const app = this.app;
		const ui = this.ui;
		ui.setStats( { fps: app.fps, frameMs: dt * 1000 } );
		this.s.renderScale = app.post.scale;

		const p = app.player;
		if ( app.freeCam ) {

			ui.setMode( 'Free camera' );
			ui.setPrompt( 'F', 'Walk' );
			ui.setBoatGauges( { visible: false } );
			ui.setDepth( { visible: false } );
			return;

		}

		const mode = p.mode === 'boat' ? `Boat · ${ p.camMode === 'first' ? '1st' : '3rd' } person`
			: p.mode === 'deck' ? 'On deck'
			: p.mode === 'swim' ? ( app.camera.position.y < ( app.cameraWaterHeight ?? 0 ) - 0.3 ? 'Diving' : 'Swimming' ) : 'Walking';
		ui.setMode( mode );
		if ( p.prompt ) ui.setPrompt( p.prompt.key, p.prompt.text );
		else ui.setPrompt( null );

		const b = app.boatCtl;
		if ( p.mode === 'boat' ) {

			const f = b.forward( new THREE.Vector3() );
			ui.setBoatGauges( {
				visible: true,
				throttle: b.throttle,
				rpm: b.rpm,
				speedKnots: b.speed * 1.94384,
				heading: ( THREE.MathUtils.radToDeg( Math.atan2( f.x, - f.z ) ) + 360 ) % 360,
			} );

		} else ui.setBoatGauges( { visible: false } );

		const depth = ( app.cameraWaterHeight ?? 0 ) - app.camera.position.y;
		ui.setDepth( { visible: p.mode === 'swim' && depth > 0.3, meters: depth } );

	}

}
