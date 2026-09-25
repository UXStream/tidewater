import { GPU, ComputeKernel } from '../engine/webgpu.js';

// Box-filtered mip chain of a square power-of-two 2d / 2d-array / cube texture.
// Each dispatch reduces tiles through workgroup memory into up to five levels, bounded by the
// device's storage texture limit. Four-slot devices need a third dispatch for a 512px chain.
// The texture needs 'storage' usage and a storage-capable float format (e.g. rgba16float).
//
//   const mips = new ComputeMips( tex, 'label' );
//   GPU.computePass( 'x', ( pass ) => mips.dispatch( pass ) );   // or mips.dispatch() (own pass)
export class ComputeMips {

	constructor( tex, label = tex.label ) {

		const res = tex.width;
		if ( tex.height !== res || res & ( res - 1 ) || res < 32 || res > 512 ) throw new Error( 'ComputeMips: square power-of-two 32..512 only' );
		this.res = res;
		this.layers = tex.dimension === '3d' ? 1 : tex.depth;
		this.batches = [];
		const levels = tex.mipLevelCount;
		const batchSize = Math.min( 5, GPU.limits.maxStorageTexturesPerShaderStage );
		if ( batchSize < 1 ) throw new Error( 'ComputeMips: storage textures are required' );
		const out = ( l ) => ( { storageTexture: tex, access: 'write', view: { dimension: '2d-array', baseMipLevel: l, mipLevelCount: 1 } } );
		const src = ( l ) => ( { texture: tex, view: { dimension: '2d-array', baseMipLevel: l, mipLevelCount: 1 } } );

		for ( let base = 0; base < levels - 1; base += batchSize ) {

			const count = Math.min( batchSize, levels - 1 - base );
			const threads = 1 << ( count - 1 );
			const bindings = { src: src( base ) };
			let decl = '', reduce = '';
			for ( let l = 1, w = threads; l <= count; l ++, w >>= 1 ) {

				bindings[ 'out' + l ] = out( base + l );
				if ( l < count ) decl += `var<workgroup> s${ l }: array<vec4f, ${ w * w }>;\n`;
				if ( l === 1 ) continue;
				const from = 's' + ( l - 1 );
				reduce += /* wgsl */`
	if ( lx < ${ w }u && ly < ${ w }u ) {
		let i = ly * ${ 4 * w }u + lx * 2u;
		let v = ( ${ from }[ i ] + ${ from }[ i + 1u ] + ${ from }[ i + ${ 2 * w }u ] + ${ from }[ i + ${ 2 * w + 1 }u ] ) * 0.25;
		textureStore( out${ l }, vec2u( gx * ${ w }u + lx, gy * ${ w }u + ly ), layer, v );
		${ l < count ? `s${ l }[ ly * ${ w }u + lx ] = v;` : '' }
	}
	workgroupBarrier();`;

			}

			const kernel = new ComputeKernel( {
				label: label + ' mips ' + String.fromCharCode( 65 + this.batches.length ),
				bindings,
				workgroupSize: [ threads, threads, 1 ],
				code: /* wgsl */`
${ decl }
@compute @workgroup_size( WG_X, WG_Y, WG_Z )
fn main( @builtin( local_invocation_id ) lid: vec3u, @builtin( workgroup_id ) wid: vec3u ) {
	let lx = lid.x; let ly = lid.y;
	let gx = wid.x; let gy = wid.y; let layer = wid.z;
	let p1 = vec2u( gx, gy ) * ${ threads }u + lid.xy;
	let p = p1 * 2u;
	let v = ( textureLoad( src, p, layer, 0 ) + textureLoad( src, p + vec2u( 1u, 0u ), layer, 0 ) + textureLoad( src, p + vec2u( 0u, 1u ), layer, 0 ) + textureLoad( src, p + vec2u( 1u, 1u ), layer, 0 ) ) * 0.25;
	textureStore( out1, p1, layer, v );
	${ count > 1 ? `s1[ ly * ${ threads }u + lx ] = v;\n\tworkgroupBarrier();` : '' }
${ reduce }
}`,
			} );
			const groups = res >> ( base + count );
			this.batches.push( { kernel, groups } );

		}

	}

	dispatch( pass = null ) {

		const o = pass ? { pass } : undefined;
		for ( const { kernel, groups } of this.batches ) kernel.dispatch( [ groups, groups, this.layers ], o );

	}

}
