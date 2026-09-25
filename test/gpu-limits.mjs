// Exercise the limits reported by Linux/Electron adapters, even on larger devices.
import './headless.mjs';
import assert from 'node:assert/strict';
import { GPU, Texture, ComputeKernel, FullscreenPass, RenderTarget, readTexture, ShaderModule } from '../src/engine/webgpu.js';
import { ComputeMips } from '../src/ocean/ComputeMips.js';
import { OceanFFT, FFT_SIZE } from '../src/ocean/OceanFFT.js';
import { readFloatTexture } from './ocean-util.mjs';

const storageLimit = Number( process.argv[ 2 ] || 4 );
await GPU.init( { headless: true, requiredLimits: {
	maxStorageTexturesPerShaderStage: storageLimit,
	maxSampledTexturesPerShaderStage: 16,
} } );
assert.equal( GPU.limits.maxStorageTexturesPerShaderStage, storageLimit );
assert.equal( GPU.limits.maxSampledTexturesPerShaderStage, 16 );
GPU.device.pushErrorScope( 'validation' );

// More declared textures than fit in a stage; only two are reachable. The unused helper must
// remain valid WGSL, while its bindings must not consume any per-stage slots.
const tex = new Texture( { width: 1, height: 1, data: new Uint8Array( [ 32, 64, 128, 255 ] ) } );
const bindings = Object.fromEntries( Array.from( { length: 21 }, ( _, i ) => [ 'tex' + i, { texture: tex } ] ) );
const helpers = new ShaderModule( { name: 'limit helpers', bindings, code: `
fn unused() -> vec4f { return ${ Array.from( { length: 19 }, ( _, i ) => `textureLoad( tex${ i + 2 }, vec2i( 0 ), 0 )` ).join( ' + ' ) }; }
fn nested() -> vec4f { return textureLoad( tex1, vec2i( 0 ), 0 ); }
fn used() -> vec4f {
	// unused() tex2 { }
	/* outer { /* nested } */ unused() tex3 */
	return ( textureLoad( tex0, vec2i( 0 ), 0 ) + nested() ) * 0.5;
}
` } );
const target = new RenderTarget( 1, 1, { colors: [ 'rgba8unorm' ] } );
const render = new FullscreenPass( { modules: [ helpers ], colorFormats: [ 'rgba8unorm' ],
	code: 'fn fragment( in: FSIn ) -> vec4f { return used(); }' } );
render.render( { colorViews: [ target.texture ] } );
assert.deepEqual( new Uint8Array( ( await readTexture( target.texture ) ).data ), new Uint8Array( [ 32, 64, 128, 255 ] ) );
const output = new Texture( { width: 1, height: 1, usage: [ 'storage', 'copySrc' ] } );
const compute = new ComputeKernel( { modules: [ helpers ], bindings: { output: { storageTexture: output } },
	entryPoint: 'bake', workgroupSize: [ 1, 1, 1 ], code: `
@compute @workgroup_size( 1 ) fn bake() { textureStore( output, vec2i( 0 ), used() ); }
` } );
compute.dispatch( 1 );
assert.deepEqual( new Uint8Array( ( await readTexture( output ) ).data ), new Uint8Array( [ 32, 64, 128, 255 ] ) );

// Check every mip against a CPU box filter, including layer isolation, partial chains, no mips,
// and the 512px case that requires three dispatches at the four-storage-texture limit.
for ( const [ size, dimension, layers, mips ] of [
	[ 32, '2d', 1, false ], [ 32, '2d', 1, 3 ], [ 32, '2d', 1, true ],
	[ 64, 'cube', 6, true ], [ 128, '2d', 1, true ], [ 256, '2d', 1, true ], [ 512, '2d-array', 2, true ],
] ) {

	const data = new Float32Array( size * size * layers * 4 );
	for ( let layer = 0; layer < layers; layer ++ ) for ( let y = 0; y < size; y ++ ) for ( let x = 0; x < size; x ++ ) {

		const i = ( layer * size * size + y * size + x ) * 4;
		data.set( [ x, y, ( x + y ) % 4, layer + 1 ], i );

	}
	const texture = new Texture( { width: size, height: size, depth: layers, dimension,
		format: 'rgba32float', mips, data, usage: [ 'sample', 'storage', 'copySrc', 'copyDst' ] } );
	const chain = new ComputeMips( texture );
	// Both the caller-owned pass and separate-pass APIs must order dependent dispatches correctly.
	if ( dimension === '2d' ) chain.dispatch();
	else GPU.computePass( 'mip regression', ( pass ) => chain.dispatch( pass ) );
	GPU.submit();
	for ( let layer = 0; layer < layers; layer ++ ) {

		let expected = data.slice( layer * size * size * 4, ( layer + 1 ) * size * size * 4 );
		for ( let mip = 1, width = size >> 1; mip < texture.mipLevelCount; mip ++, width >>= 1 ) {

			const next = new Float32Array( width * width * 4 );
			for ( let y = 0; y < width; y ++ ) for ( let x = 0; x < width; x ++ ) for ( let c = 0; c < 4; c ++ ) {

				const p = ( 2 * y * width * 2 + 2 * x ) * 4 + c;
				next[ ( y * width + x ) * 4 + c ] = ( expected[ p ] + expected[ p + 4 ] + expected[ p + width * 8 ] + expected[ p + width * 8 + 4 ] ) * 0.25;

			}
			expected = next;
			const actual = new Float32Array( ( await readTexture( texture, { mip, layer } ) ).data );
			assert.deepEqual( actual, expected, `${ size }px ${ dimension }, layer ${ layer }, mip ${ mip }` );

		}

	}
	texture.destroy();

}

// The FFT has its own mip generator reading full-precision, interleaved storage buffers.
// Feed an analytic pattern into that buffer and check both output textures, especially level 5,
// whose texture write belongs to the second dispatch on four-slot devices.
const fft = new OceanFFT();
const n = FFT_SIZE, layers = fft.cascades;
const data = new Float32Array( n * n * layers * 8 );
for ( let layer = 0; layer < layers; layer ++ ) for ( let y = 0; y < n; y ++ ) for ( let x = 0; x < n; x ++ ) {

	for ( let t = 0; t < 2; t ++ ) data.set( [ x + t * 512, y, ( x % 2 ) * 2 + y % 2, layer + 1 ], ( layer * n * n + y * n + x ) * 8 + t * 4 );

}
GPU.queue.writeBuffer( fft.mipSrc.getGPU(), 0, data );
GPU.computePass( 'FFT mip regression', ( pass ) => {

	for ( const k of fft.mipKernelsA ) k.dispatch( [ n / 32, n / 32, layers ], { pass } );
	for ( const k of fft.mipKernelsB ) k.dispatch( [ 1, 1, layers ], { pass } );

} );
const textures = [ fft.displacementTexture, fft.derivativeTexture ];
for ( let t = 0; t < 2; t ++ ) for ( let layer = 0; layer < layers; layer ++ ) for ( let mip = 1; mip < textures[ t ].mipLevelCount; mip ++ ) {

	const width = n >> mip, stride = 1 << mip;
	const expected = new Float32Array( width * width * 4 );
	for ( let y = 0; y < width; y ++ ) for ( let x = 0; x < width; x ++ ) {

		expected.set( [ x * stride + ( stride - 1 ) / 2 + t * 512, y * stride + ( stride - 1 ) / 2, 1.5, layer + 1 ], ( y * width + x ) * 4 );

	}
	const actual = await readFloatTexture( textures[ t ], { mip, layer } );
	assert.deepEqual( actual.data, expected, `FFT texture ${ t }, layer ${ layer }, mip ${ mip }` );

}
await GPU.pipelinesReady();
assert.equal( await GPU.device.popErrorScope(), null );
console.log( `GPU limits passed (${ storageLimit } storage / 16 sampled textures per stage)` );
process.exit( 0 );
