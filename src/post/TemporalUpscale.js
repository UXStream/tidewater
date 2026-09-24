import { GPU } from '../engine/gpu/GPU.js';
import { UniformBlock } from '../engine/gpu/Shader.js';
import { RenderTarget, Texture } from '../engine/gpu/Texture.js';
import { FullscreenPass } from '../engine/render/FullscreenPass.js';
import { FrameUniforms } from '../engine/render/Frame.js';
import { Matrix4, Vector2 } from '../engine/math/index.js';

// full-screen passes overwrite every pixel: clear instead of load (no tile load of the old contents on
// tile-based GPUs)
const CLR = [ 0, 0, 0, 0 ];

// Temporal anti-aliasing / upscaling, a port of three's TAAUNode (same history, depth dilation,
// variance clipping and anti-flicker weighting, three's TAAUtils inlined) with two changes that keep
// the image sharp:
//  - the history is resampled with a 5-tap Catmull-Rom filter instead of bilinear. Bilinear
//    resampling blurs the accumulated image a little more on every frame the camera moves.
//  - the current-frame weight is a uniform (higher at 1:1 than when upscaling from lower res).
//  - even Catmull-Rom loses fine detail when it samples between texels (a 0.2 px offset keeps ~80%
//    of the finest detail, 0.5 px much less), and while walking the history is resampled that way on
//    every frame: the distant deck turned to mush, and the clip popped the aliased plank gaps of the
//    new frames in and out of it. Each pixel keeps the blur its history has gathered (the variance
//    the resamples added, decayed by the blend) and takes a larger share of the new frame the more
//    blurred its history is. A still camera resamples at texel centres (no blur, no extra weight).
// The camera jitter is driven by the post chain: PostFX.beginFrame() takes jitter() for the frame's
// camera (setFrameCamera) and endFrame() calls clearViewOffset() to advance the Halton sequence.
// The history is ping-ponged (the resolve writes the other target) instead of copied.
// Inputs: beauty (internal res, getter), the scene's reversed-Z depth, velocity (uv motion, current -
// previous, y down: history uv = uv - velocity), water mask (g = 1 on water surface pixels).

// Halton (2, 3) jitter sequence of three's TAAUNode (32 offsets)
function halton( index, base ) {

	let fraction = 1;
	let result = 0;
	while ( index > 0 ) {

		fraction /= base;
		result += fraction * ( index % base );
		index = Math.floor( index / base );

	}

	return result;

}

const HALTON = Array.from( { length: 32 }, ( _, i ) => [ halton( i + 1, 2 ), halton( i + 1, 3 ) ] );

export class TemporalUpscale {

	constructor( beauty, depthTexture, velocityTexture, camera, waterMaskTexture = null ) {

		this.beauty = beauty; // Texture or getter
		this.depthTexture = depthTexture;
		this.velocityTexture = velocityTexture;
		this.waterMaskTexture = waterMaskTexture;
		this.camera = camera;

		this.uniforms = new UniformBlock( 'TAAUParams', {
			prevInvViewProj: [ 'mat4x4f', new Matrix4() ],
			jitterOffset: [ 'vec2f', new Vector2() ],
			cameraNearFar: [ 'vec2f', new Vector2( 0.1, 1000 ) ],
			frameWeight: [ 'f32', 0.06 ],
			depthThreshold: [ 'f32', 0.0005 ],
			edgeDepthDiff: [ 'f32', 0.001 ],
			maxVelocityLength: [ 'f32', 128 ],
			hasWaterMask: [ 'f32', waterMaskTexture ? 1 : 0 ],
		}, { label: 'taau' } );
		const U = this.uniforms.fields;
		this.frameWeight = U.frameWeight;
		this._jitterOffset = U.jitterOffset;
		this._jitterIndex = 0;

		// three's TAAUNode (r186) resolves into a single-attachment target and copies only the colour into
		// the history, so its lock history stays at the seed value (0) and the lock is this frame's
		// thin-feature term alone: no lock history target (it was written and read with a weight of 0)
		// history: the resolved colour, and the flicker statistics of each pixel (x: recent size of the
		// clip's corrections, y: their signed average; see the resolve; z: the blur accumulated by the
		// history resamples, in pixels squared)
		const hist = () => ( { colors: [ { format: 'rgba16float', name: 'color' }, { format: 'rgba16float', name: 'stability' } ], label: 'taauHistory' } );
		this.history = [ new RenderTarget( 1, 1, hist() ), new RenderTarget( 1, 1, hist() ) ];
		this._cur = 0;
		this._prevDepth = new Texture( { label: 'taauPrevDepth', width: 1, height: 1, format: 'depth32float', usage: [ 'sample', 'copyDst' ] } );
		this._hasPrevInvVP = false;
		this._needsRestart = true;
		this._build();

	}

	// resolved image of this frame (output resolution)
	get texture() {

		return this.history[ this._cur ].textures[ 0 ];

	}

	getTextureNode() {

		return this.texture;

	}

	setSize( w, h ) {

		const a = this.history[ 0 ].setSize( w, h );
		this.history[ 1 ].setSize( w, h );
		if ( a ) this._needsRestart = true;

	}

	// jitter (input pixels) for this frame's camera, as three's setViewOffset( w, h, jx, jy, w, h )
	jitter() {

		const o = HALTON[ this._jitterIndex ];
		const jx = o[ 0 ] - 0.5, jy = o[ 1 ] - 0.5;
		this._jitterOffset.value.set( jx, jy );
		return [ jx, jy ];

	}

	clearViewOffset() {

		this._jitterIndex = ( this._jitterIndex + 1 ) % HALTON.length;

	}

	_build() {

		const beautyTex = () => ( typeof this.beauty === 'function' ? this.beauty() : this.beauty );
		const bindings = ( src ) => ( {
			taau: { uniform: this.uniforms },
			taauBeauty: { texture: beautyTex },
			taauDepth: { texture: () => this.depthTexture },
			taauPrevDepth: { texture: () => this._prevDepth },
			taauVelocity: { texture: () => this.velocityTexture },
			taauMask: { texture: () => this.waterMaskTexture || this.velocityTexture },
			taauHistory: { texture: () => this.history[ src ].textures[ 0 ] },
			taauStability: { texture: () => this.history[ src ].textures[ 1 ] },
		} );

		const code = /* wgsl */`
// luma weighted tone map (Karis 2014) and its inverse: the resolve works on bounded values
fn taauTonemap( c: vec3f ) -> vec3f { return c / ( 1.0 + luminance( c ) ); }
fn taauTonemapInverse( c: vec3f ) -> vec3f { return c / max( 1.0 - luminance( c ), 1e-4 ); }
fn taauToYCoCg( c: vec3f ) -> vec3f {
	return vec3f( dot( c, vec3f( 0.25, 0.5, 0.25 ) ), dot( c, vec3f( 0.5, 0.0, -0.5 ) ), dot( c, vec3f( -0.25, 0.5, -0.25 ) ) );
}
fn taauFromYCoCg( c: vec3f ) -> vec3f { return vec3f( c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z ); }

// move the history toward the box centre until it is inside the box (Playdead / Karis clip)
fn taauClip( h: vec3f, lo: vec3f, hi: vec3f ) -> vec3f {
	let center = ( hi + lo ) * 0.5;
	let extent = max( ( hi - lo ) * 0.5, vec3f( 1e-6 ) );
	let v = h - center;
	let u = abs( v / extent );
	let m = max( u.x, max( u.y, u.z ) );
	return select( h, center + v / m, m > 1.0 );
}

// Catmull-Rom history lookup with 5 bilinear taps (the 4 corner taps are dropped)
fn taauSampleHistory( uvIn: vec2f ) -> vec4f {
	let size = vec2f( textureDimensions( taauHistory ) );
	let samplePos = uvIn * size;
	let texPos1 = floor( samplePos - 0.5 ) + 0.5;
	let f = samplePos - texPos1;
	let w0 = f * ( f * ( f * -0.5 + 1.0 ) - 0.5 );
	let w1 = f * f * ( f * 1.5 - 2.5 ) + 1.0;
	let w2 = f * ( f * ( f * -1.5 + 2.0 ) + 0.5 );
	let w3 = f * f * ( f * 0.5 - 0.5 );
	let w12 = w1 + w2;
	let tp0 = ( texPos1 - 1.0 ) / size;
	let tp3 = ( texPos1 + 2.0 ) / size;
	let tp12 = ( texPos1 + w2 / w12 ) / size;
	let wa = w12.x * w0.y; let wb = w0.x * w12.y; let wc = w12.x * w12.y; let wd = w3.x * w12.y; let we = w12.x * w3.y;
	let sum = textureSampleLevel( taauHistory, smpLinearClamp, vec2f( tp12.x, tp0.y ), 0.0 ) * wa
		+ textureSampleLevel( taauHistory, smpLinearClamp, vec2f( tp0.x, tp12.y ), 0.0 ) * wb
		+ textureSampleLevel( taauHistory, smpLinearClamp, vec2f( tp12.x, tp12.y ), 0.0 ) * wc
		+ textureSampleLevel( taauHistory, smpLinearClamp, vec2f( tp3.x, tp12.y ), 0.0 ) * wd
		+ textureSampleLevel( taauHistory, smpLinearClamp, vec2f( tp12.x, tp3.y ), 0.0 ) * we;
	return max( sum / ( wa + wb + wc + wd + we ), vec4f( 0.0 ) );
}

fn taauLoadBeauty( p: vec2i ) -> vec4f {
	let s = vec2i( textureDimensions( taauBeauty ) );
	return textureLoad( taauBeauty, clamp( p, vec2i( 0 ), s - 1 ), 0 );
}

// standard (0 near .. 1 far) perspective depth of the reversed-Z buffer at p (clamped)
fn taauDepthAt( p: vec2i ) -> f32 {
	let s = vec2i( textureDimensions( taauDepth ) );
	return 1.0 - textureLoad( taauDepth, clamp( p, vec2i( 0 ), s - 1 ), 0 );
}

// last frame's depth at uv, reprojected into this frame's camera (standard perspective depth)
fn taauPreviousDepth( uv: vec2f ) -> f32 {
	let s = vec2i( textureDimensions( taauPrevDepth ) );
	let d = textureLoad( taauPrevDepth, clamp( vec2i( uv * vec2f( s ) ), vec2i( 0 ), s - 1 ), 0 );
	let pw = taau.prevInvViewProj * vec4f( uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, d, 1.0 );
	let world = pw.xyz / pw.w;
	let viewZ = ( frame.view * vec4f( world, 1.0 ) ).z;
	let near = taau.cameraNearFar.x; let far = taau.cameraNearFar.y;
	return ( ( near + viewZ ) * far ) / ( ( far - near ) * viewZ );
}

struct TaauOut { @location( 0 ) color: vec4f, @location( 1 ) stability: vec4f };
@fragment fn fs( in: FSIn ) -> TaauOut {
	let uvNode = in.uv;
	let inputSizeF = vec2f( textureDimensions( taauBeauty ) );

	// output pixel center in input-pixel coordinates; closest jittered input tap
	let pIn = uvNode * inputSizeF;
	let closestTapF = round( pIn - ( vec2f( 0.5 ) + taau.jitterOffset ) );
	let closestTap = vec2i( closestTapF );

	// depth dilation around the closest input tap
	var closestDepth = 2.0;
	var closestPositionTexel = vec2i( 0 );
	var farthestDepth = -1.0;
	for ( var x = -1; x <= 1; x++ ) {
		for ( var y = -1; y <= 1; y++ ) {
			let neighbor = closestTap + vec2i( x, y );
			let depth = taauDepthAt( neighbor );
			if ( depth < closestDepth ) {
				closestDepth = depth;
				closestPositionTexel = neighbor;
			}
			if ( depth > farthestDepth ) { farthestDepth = depth; }
		}
	}

	// reproject using the velocity at the dilated depth tap
	let vs = vec2i( textureDimensions( taauVelocity ) );
	let offsetUV = textureLoad( taauVelocity, clamp( closestPositionTexel, vec2i( 0 ), vs - 1 ), 0 ).xy;
	let historyUV = uvNode - offsetUV;
	let previousDepth = taauPreviousDepth( historyUV );

	// history validity
	let isValidUV = all( historyUV >= vec2f( 0.0 ) ) && all( historyUV <= vec2f( 1.0 ) );
	let isEdge = farthestDepth - closestDepth > taau.edgeDepthDiff;
	let isDisocclusion = closestDepth - previousDepth > taau.depthThreshold;
	// The water surface moves on its own (waves, the wake and bow wave travelling with a boat) while
	// its motion vectors only carry the camera's motion: near the camera its depth changes between
	// frames by more than the disocclusion threshold. Rejecting its history there shows the raw
	// jittered frame (flicker), so water always keeps its history and relies on the variance clip.
	let ms = vec2i( textureDimensions( taauMask ) );
	let isWater = taau.hasWaterMask > 0.5 && textureLoad( taauMask, clamp( closestTap, vec2i( 0 ), ms - 1 ), 0 ).g > 0.5;
	let hasValidHistory = isValidUV && ( isEdge || ! isDisocclusion || isWater );

	// Neighbourhood statistics, the current frame's reconstruction and the blend all work on a tone
	// mapped (luma weighted, Karis 2014) YCoCg version of the colour: in raw HDR a few very bright
	// samples (sun glints on the water, sunlit rails) dominate the variance and the blend, so the clip
	// box jumps from frame to frame and thin bright or dark details flicker.
	var sumColor = vec3f( 0.0 );
	var sumWeight = 0.0;
	var moment1 = vec3f( 0.0 );
	var moment2 = vec3f( 0.0 );
	var minC = vec3f( 1e9 );
	var maxC = vec3f( -1e9 );
	for ( var y = -1; y <= 1; y++ ) {
		for ( var x = -1; x <= 1; x++ ) {
			let tap = closestTap + vec2i( x, y );
			let delta = pIn - ( vec2f( tap ) + ( vec2f( 0.5 ) + taau.jitterOffset ) );
			// 9-tap Gaussian reconstruction at the output pixel (narrow: the jitter already box filters
			// over the pixel, a wider kernel only softens the image)
			let w = exp( dot( delta, delta ) * -4.5 );
			let c = taauToYCoCg( taauTonemap( max( taauLoadBeauty( tap ).rgb, vec3f( 0.0 ) ) ) );
			sumColor += c * w;
			sumWeight += w;
			moment1 += c;
			moment2 += c * c;
			minC = min( minC, c );
			maxC = max( maxC, c );
		}
	}
	let current = sumColor / max( sumWeight, 1e-5 );

	// clip box: the variance box (Salvi 2016) intersected with the neighbourhood's own extent. The
	// variance box alone can reach past any colour actually present (history outside the neighbourhood
	// survives); the extent alone flickers with every noisy sample. Wider while still, tighter in motion.
	let motionFactor = sat( length( ( uvNode - historyUV ) * inputSizeF ) / taau.maxVelocityLength );
	let gamma = mix( 1.5, 0.85, sat( motionFactor * 8.0 ) );
	let mean = moment1 / 9.0;
	let sigma = sqrt( max( moment2 / 9.0 - mean * mean, vec3f( 0.0 ) ) );
	let lo0 = max( minC, mean - sigma * gamma );
	let hi0 = min( maxC, mean + sigma * gamma );
	let historyYC = taauToYCoCg( taauTonemap( taauSampleHistory( historyUV ).rgb ) );

	// Flicker. Detail thinner than a pixel (distant plank gaps, rails, wires) is only in some of the
	// jittered frames: in a frame whose neighbourhood misses it, the clip strips it from the history,
	// and the next frame that hits it brings it back, so it pops on and off. Such pixels are found by
	// the clip's corrections: large, but cancelling out over a few frames (a real change, a moving
	// shadow or swaying leaves, pushes the same way frame after frame). There the box is widened and
	// the new frames weigh less, so the detail averages out instead of popping.
	let tight = taauClip( historyYC, lo0, hi0 );
	let corr = ( tight.x - historyYC.x ) / max( hi0.x - lo0.x, 0.02 );
	let stPrev3 = select( vec3f( 0.0 ), textureSampleLevel( taauStability, smpLinearClamp, historyUV, 0.0 ).xyz, hasValidHistory );
	let stPrev = stPrev3.xy;
	let flicker = select( sat( ( stPrev.x - abs( stPrev.y ) ) * 3.0 ), 0.0, isWater );
	let st = select( vec2f( 0.0 ), mix( stPrev, vec2f( abs( corr ), corr ), 0.25 ), hasValidHistory );
	let pad = ( sigma * 2.0 + vec3f( 0.05, 0.025, 0.025 ) ) * flicker;
	let clipped = taauClip( historyYC, lo0 - pad, hi0 + pad );

	// blend: a small share of the new frame (more in fast motion, capped on water, whose fine detail
	// shimmers under the jitter; more where the history is blurred by resampling; less where it
	// flickers), all of it where there is no usable history. The history's blur grows by the variance
	// of this frame's resample (f (1 - f) per axis, f the offset from the texel centres) and shrinks
	// by the share of the (sharp) new frame.
	let hf = fract( historyUV * vec2f( textureDimensions( taauHistory ) ) - 0.5 );
	let hv = hf * ( 1.0 - hf );
	let blurAcc = stPrev3.z + hv.x + hv.y;
	let moveW = motionFactor + blurAcc * 0.5;
	let motionW = select( moveW, min( moveW, 0.15 ), isWater );
	let currentWeight = select( 1.0, sat( taau.frameWeight + motionW ) * ( 1.0 - flicker * 0.6 ), hasValidHistory );
	let blended = mix( clipped, current, currentWeight );
	var out: TaauOut;
	out.color = vec4f( taauTonemapInverse( taauFromYCoCg( blended ) ), 1.0 );
	out.stability = vec4f( st, select( 0.0, blurAcc * ( 1.0 - currentWeight ), hasValidHistory ), 1.0 );
	return out;
}
`;

		const formats = [ 'rgba16float', 'rgba16float' ];
		// resolve[ i ] reads history i and writes history 1 - i
		this._resolve = [ 0, 1 ].map( ( src ) => new FullscreenPass( { label: 'TAAU', bindings: bindings( src ), colorFormats: formats, code } ) );
		// Seed the history with a bilinear upscale of the current beauty buffer. Without this the first
		// frames after a resize fade in from black because the history target was cleared.
		this._seed = new FullscreenPass( {
			label: 'TAAU seed', colorFormats: formats, bindings: { taauBeauty: { texture: beautyTex } },
			code: /* wgsl */`
struct TaauSeedOut { @location( 0 ) color: vec4f, @location( 1 ) stability: vec4f };
@fragment fn fs( in: FSIn ) -> TaauSeedOut {
	var o: TaauSeedOut;
	o.color = vec4f( textureSampleLevel( taauBeauty, smpLinearClamp, in.uv, 0.0 ).rgb, 1.0 );
	o.stability = vec4f( 0.0, 0.0, 0.0, 1.0 );
	return o;
}
`,
		} );

	}

	// record the resolve (after the beauty pass of this frame)
	render() {

		const F = FrameUniforms.fields;
		const U = this.uniforms.fields;
		U.cameraNearFar.value.set( F.near.value, F.far.value );
		if ( ! this._hasPrevInvVP ) U.prevInvViewProj.value.copy( F.invViewProj.value );
		this._hasPrevInvVP = true;

		// the previous-depth copy follows the scene depth size (resized before anything binds it this frame)
		const sd = this.depthTexture;
		if ( this._prevDepth.width !== sd.width || this._prevDepth.height !== sd.height ) {

			this._prevDepth.resize( sd.width, sd.height );
			this._needsRestart = true;

		}

		if ( this._needsRestart ) {

			this._needsRestart = false;
			this._seed.render( { colorViews: this.history[ this._cur ].textures, clear: CLR } );

		}

		const dst = 1 - this._cur;
		this._resolve[ this._cur ].render( { colorViews: this.history[ dst ].textures, clear: CLR } );
		this._cur = dst;

		// Copy the current scene depth into the previous-depth texture (same size as the source)
		const d = this.depthTexture;
		GPU.getEncoder().copyTextureToTexture( { texture: d.getGPU() }, { texture: this._prevDepth.getGPU() }, { width: d.width, height: d.height } );

	}

	// after the frame's passes are recorded: this frame's (jittered) camera becomes the previous one
	endFrame() {

		// the uniform block is uploaded when bound (this frame's value is already packed), so the next
		// frame sees this frame's inverse view-projection
		this._nextPrev = this._nextPrev || new Matrix4();
		this._nextPrev.copy( FrameUniforms.fields.invViewProj.value );

	}

	// called by beginFrame of the next frame before render()
	advance() {

		if ( this._nextPrev ) this.uniforms.fields.prevInvViewProj.value.copy( this._nextPrev );

	}

}
