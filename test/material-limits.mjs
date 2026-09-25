// Compile the actual terrain, stall and water variants against baseline WebGPU limits.
import './headless.mjs';
import './smaa-shim.mjs';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { GPU, Texture, MeshRenderer, SceneRenderer, SunShadows, readTexture, setFrameCamera } from '../src/engine/webgpu.js';
import { Scene, PerspectiveCamera, BoxGeometry, Mesh } from '../src/engine/index.js';
import { Atmosphere } from '../src/sky/Atmosphere.js';
import { Sky } from '../src/sky/Sky.js';
import { SkyProClouds } from '../src/sky/SkyProClouds.js';
import { Environment } from '../src/sky/Environment.js';
import { TerrainData } from '../src/world/TerrainData.js';
import { computeShoreField } from '../src/world/ShoreField.js';
import { TerrainGPU } from '../src/world/TerrainGPU.js';
import { OceanFFT } from '../src/ocean/OceanFFT.js';
import { WaterSurface } from '../src/ocean/WaterSurface.js';
import { ShoreWaves } from '../src/ocean/ShoreWaves.js';
import { ShoreSim } from '../src/ocean/ShoreSim.js';
import { SeaDetail } from '../src/ocean/SeaDetail.js';
import { Caustics } from '../src/ocean/Caustics.js';
import { installUnderwaterLighting } from '../src/ocean/UnderwaterLighting.js';
import { WakeSim } from '../src/ocean/WakeSim.js';
import { WaterQuery } from '../src/ocean/WaterQuery.js';
import { Underwater } from '../src/post/Underwater.js';
import { AirHaze } from '../src/post/AirHaze.js';
import { PostFX } from '../src/post/PostFX.js';
import { installGroundBounce } from '../src/materials/GroundBounce.js';
import { Terrain } from '../src/world/Terrain.js';
import { CDLOD } from '../src/core/CDLOD.js';
import { createFoamTexture } from '../src/ocean/FoamTexture.js';
import { SurfFoam } from '../src/ocean/SurfFoam.js';
import { WaterMaterial } from '../src/ocean/WaterMaterial.js';
import { RefractionPass } from '../src/ocean/RefractionPass.js';
import { createStallMaterial } from '../src/game/StallKit.js';

const root = new URL( '../', import.meta.url ).pathname;
const realFetch = globalThis.fetch;
globalThis.fetch = async ( url, options ) => String( url ).startsWith( '/clouds/' ) ? new Response( await readFile( root + 'public' + url ) ) : realFetch( url, options );
await GPU.init( { headless: true, requiredLimits: { maxStorageTexturesPerShaderStage: 4, maxSampledTexturesPerShaderStage: Number( process.argv[ 2 ] || 16 ) } } );
GPU.device.pushErrorScope( 'validation' );
const errors = [];
const error = console.error;
console.error = ( ...args ) => { errors.push( args.join( ' ' ) ); error( ...args ); };
const atmosphere = new Atmosphere();
const sky = new Sky( atmosphere );
const clouds = new SkyProClouds( null, atmosphere );
await clouds.ready;
sky.clouds = clouds;
new Environment( null, null, sky );
const terrainData = new TerrainData();
const shoreField = computeShoreField( terrainData, { res: 64, swellDir: [ 0, 1 ] } );
const terrain = new TerrainGPU( terrainData, shoreField );
const fft = new OceanFFT();
const surface = new WaterSurface( { fft } );
surface.terrain = terrain;
const shore = surface.shore = new ShoreWaves( terrain );
const shoreSim = surface.shoreSim = new ShoreSim( null, { terrainGPU: terrain, shore, res: 64 } );
surface.detail = new SeaDetail();
const caustics = new Caustics( null, fft );
caustics.detail = surface.detail;
const uw = installUnderwaterLighting( { fft, surface, terrain, shore, shoreSim, caustics, clouds } );
uw.maps.usageList.push( 'copySrc' );
const wake = surface.wake = new WakeSim( null, { terrainGPU: terrain, boat: { model: { lines: {
	zAft: - 3.4, wlEnd: 3.6, bottomAt: ( x, z ) => Math.abs( x ) < 1 && Math.abs( z ) < 3 ? - 0.4 : NaN,
} } } } );
const query = new WaterQuery( null, surface );
const scene = new Scene(), camera = new PerspectiveCamera( 55, 1, 0.1, 1000 );
const mr = new MeshRenderer();
new SunShadows();
setFrameCamera( camera, 64, 64 );
const sr = new SceneRenderer( mr, scene, camera );
const underwater = new Underwater( { depthTexture: sr.sceneRT.depthTexture, maskTexture: sr.waterMaskTexture, query, caustics, fft } );
const haze = new AirHaze( { depthTexture: sr.sceneRT.depthTexture, underwater, atmosphere, sky, clouds, terrain } );
const post = new PostFX( {}, { sceneRenderer: sr, camera, underwater, clouds, sunDir: atmosphere.sunDir, haze } );

installGroundBounce( { terrain, clouds } );
const ground = new Terrain( { scene, terrainData, terrainGPU: terrain } );
ground.material.appliesHillShadow = true;
ground.wetness = { modules: [ shoreSim.module ], code: 'fn terrainWetness(xz: vec2f, h: f32) -> vec2f { let s = shoreSimSample(xz); return vec2f(s.y, shoreSimSandFoam(xz,s,h)); }' };
ground.finalizeMaterial();
surface.cdlod = new CDLOD( { gridSize: 32, leafSize: 8, levels: 12, minY: - 25, maxY: 25 } );
surface.foamTexture = createFoamTexture();
surface.foamShading = new SurfFoam( { shoreSim } );
const refraction = new RefractionPass( { meshRenderer: mr, scene, camera, sceneRenderer: sr } );
const water = new WaterMaterial( { surface, sky, sceneCopy: sr.opaqueCopy, sceneDepthHalf: sr.opaqueDepthHalf.texture, refraction, hullMask: sr.hullMaskRT.texture, hullMaskActive: sr.hullMaskActive } );
water.clouds = clouds;
water.cameraWaterHeightNode = query.cameraState().x;
water.hullOverride = 1;
water.pipelineKey();

post._build();
const array = () => new Texture( { width: 4, height: 4, depth: 4, dimension: '2d-array' } );
const set = () => ( { a: array(), n: array(), r: array() } );
const stall = createStallMaterial( { surf: set(), prop: set(), signs: array() } );
const meshes = [ ground.mesh, new Mesh( new BoxGeometry(), stall ), new Mesh( surface.cdlod.geometry, water ) ];
const handles = [];
for ( const mesh of meshes ) {
	const material = mesh.material;
	material.pipelineKey();
	const vl = mr._layout( mesh, mesh.geometry, material );
	const passes = material === water
		? [ { kind: 'main', late: true, hull: 0 }, { kind: 'main', late: true, hull: 1 } ]
		: [ { kind: 'main' }, { kind: 'color', defines: { REFRACTION_CLIP: 1 } }, { kind: 'depth' } ];
	for ( const variant of passes ) {
		if ( material === water ) material.hullOverride = variant.hull;
		const label = material.name + ' ' + JSON.stringify( variant );
		const pass = { ...variant, colorFormats: variant.kind === 'main' ? [ 'rgba16float', 'rgba16float', 'rgba8unorm' ] : [ 'rgba16float' ], depthFormat: 'depth32float', depthCompare: 'greater-equal' };
		const p = mr._createPipeline( material, vl, pass, label );
		handles.push( p.handle );
		p.bindings.getBindGroup();
		const counts = [ GPUShaderStage.VERTEX, GPUShaderStage.FRAGMENT ].map( ( stage ) => p.bindings.described.filter( ( d ) => d.layout.texture && ( d.layout.visibility & stage ) ).length );
		assert.ok( counts.every( ( n ) => n <= GPU.limits.maxSampledTexturesPerShaderStage ), label + ': ' + counts );
		console.log( label, 'sampled textures V/F:', counts );
	}
}
// Execute the changed array writers as well as validating the material readers.
fft.update( 1 / 60 );
uw.update( camera );
wake._prime();
GPU.submit();
await GPU.queue.onSubmittedWorkDone();
for ( let layer = 0; layer < 4; layer ++ ) {
	const { data } = await readTexture( uw.maps, { layer } );
	const half = new Uint16Array( data );
	for ( let i = 0; i < half.length; i ++ ) assert.notEqual( half[ i ] & 0x7c00, 0x7c00, 'finite underwater map layer ' + layer );
	if ( layer % 2 ) for ( let i = 3; i < half.length; i += 4 ) assert.equal( half[ i ], 0x3c00, 'underwater level map alpha ' + layer );
}
await GPU.pipelinesReady();
assert.ok( handles.every( ( h ) => h.pipeline && ! h.failed ), 'All material pipelines compiled' );
const validation = await GPU.device.popErrorScope();
assert.equal( validation?.message || null, null );
assert.deepEqual( errors, [] );
console.log( 'Material limits passed:', GPU.limits.maxSampledTexturesPerShaderStage );
process.exit( 0 );
