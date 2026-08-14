// Ported from: descent-master/MAIN/ENDLEVEL.C
// Endlevel tunnel flythrough state and movement

import * as THREE from 'three';

import { Segments, Num_segments, Side_opposite } from './mglobal.js';
import { compute_center_point_on_side, find_connect_side, compute_segment_center, find_point_seg } from './gameseg.js';
import { VCLIP_PLAYER_HIT, VCLIP_BIG_PLAYER_EXPLOSION } from './fireball.js';
import { SOUND_EXPLODING_WALL } from './digi.js';
import { iff_read_bitmap } from './iff.js';
import { Polygon_models, buildModelMesh, polyobj_clone_model_mesh,
	polyobj_set_object_light, polyobj_set_morphing } from './polyobj.js';
import { exit_modelnum } from './bm.js';

// endlevel sequence states (ENDLEVEL.C)
const EL_OFF = 0;
const EL_FLYTHROUGH = 1;

// Movement tuning from ENDLEVEL.C
const FLY_SPEED = 50.0;
const FLY_ACCEL = 5.0;
const MIN_D = 0x100 / 65536.0;

// Internal tunnel path cache
const MAX_PATH_SEGS = 256;
const _pathSegs = new Int16Array( MAX_PATH_SEGS );
const _pathExitSides = new Int8Array( MAX_PATH_SEGS );
let _pathCount = 0;
let _pathIndex = 0;

// Sequence state
let Endlevel_sequence = EL_OFF;
let _currentSegnum = - 1;
let _transitionSegnum = - 1;
let _exitSegnum = - 1;

let _posX = 0;
let _posY = 0;
let _posZ = 0;
let _curFlySpeed = FLY_SPEED;
let _desiredFlySpeed = FLY_SPEED;

let _explosionTimer = 0;
let _tunnelSoundCount = 0;
let _exitExplosionPlayed = false;
let _finishDelay = 0;
const FINISH_DELAY = 0.9;

const ENDLEVEL_VARIABLE_COUNT = 8;
const BITMAP_TBL_XOR = 0xD3;
const TERRAIN_GRID_SCALE = 40.0;
const EXIT_MODEL_OFFSET = 15.0;
const SATELLITE_DISTANCE = 1024.0;
const SATELLITE_HEIGHT_SCALE = 9 / 4;
const STAR_COUNT = 500;

let _endlevelData = null;
let _externalSceneReady = false;
let _externalGroup = null;
let _terrainMesh = null;
let _satelliteSprite = null;
let _starField = null;
let _exitModelMesh = null;
let _satelliteTopX = 0;
let _satelliteTopY = 0;
let _satelliteTopZ = 0;

const _externalTextures = [];
const _externalGeometries = [];
const _externalMaterials = [];

// Externals from gameseq
let _setPlayerSegnum = null;
let _createExplosion = null;
let _setWhiteFlash = null;
let _playWorldSound = null;
let _scene = null;
let _pigFile = null;
let _palette = null;

// Pre-allocated vectors (Golden Rule #5)
const _lookAt = new THREE.Vector3();
const _mineExitQuaternion = new THREE.Quaternion();
const _surfaceQuaternion = new THREE.Quaternion();
const _exitAngleQuaternion = new THREE.Quaternion();
const _satelliteAngleQuaternion = new THREE.Quaternion();
const _rotationMatrix = new THREE.Matrix4();
const _rotationEuler = new THREE.Euler( 0, 0, 0, 'YXZ' );
const _mineExitPoint = new THREE.Vector3();
const _mineForward = new THREE.Vector3();
const _mineUp = new THREE.Vector3();
const _mineRight = new THREE.Vector3();
const _surfaceForward = new THREE.Vector3();
const _surfaceUp = new THREE.Vector3();
const _satelliteDirection = new THREE.Vector3();
const _satelliteProjectedUp = new THREE.Vector3();
const _satelliteBottomScreen = new THREE.Vector3();
const _satelliteTopScreen = new THREE.Vector3();

export function endlevel_set_externals( ext ) {

	if ( ext.setPlayerSegnum !== undefined ) _setPlayerSegnum = ext.setPlayerSegnum;
	if ( ext.createExplosion !== undefined ) _createExplosion = ext.createExplosion;
	if ( ext.setWhiteFlash !== undefined ) _setWhiteFlash = ext.setWhiteFlash;
	if ( ext.playWorldSound !== undefined ) _playWorldSound = ext.playWorldSound;
	if ( ext.scene !== undefined ) _scene = ext.scene;
	if ( ext.pigFile !== undefined ) _pigFile = ext.pigFile;
	if ( ext.palette !== undefined ) _palette = ext.palette;

}

export function endlevel_is_active() {

	return Endlevel_sequence !== EL_OFF;

}

export function endlevel_get_data() {

	return _endlevelData;

}

export function endlevel_get_external_scene() {

	return {
		ready: _externalSceneReady,
		group: _externalGroup,
		terrainMesh: _terrainMesh,
		satelliteSprite: _satelliteSprite,
		starField: _starField,
		exitModelMesh: _exitModelMesh
	};

}

function clear_external_scene() {

	if ( _externalGroup !== null && _externalGroup.parent !== null ) {

		_externalGroup.parent.remove( _externalGroup );

	}

	for ( let i = 0; i < _externalTextures.length; i ++ ) _externalTextures[ i ].dispose();
	for ( let i = 0; i < _externalGeometries.length; i ++ ) _externalGeometries[ i ].dispose();
	for ( let i = 0; i < _externalMaterials.length; i ++ ) _externalMaterials[ i ].dispose();

	_externalTextures.length = 0;
	_externalGeometries.length = 0;
	_externalMaterials.length = 0;
	_externalGroup = null;
	_terrainMesh = null;
	_satelliteSprite = null;
	_starField = null;
	_exitModelMesh = null;
	_externalSceneReady = false;

}

function remap_iff_palette( bitmap, gamePalette ) {

	const remap = new Uint8Array( 256 );

	for ( let source = 0; source < 256; source ++ ) {

		if ( bitmap.hasTransparency === true && source === bitmap.transparentColor ) {

			remap[ source ] = 255;
			continue;

		}

		const red = bitmap.palette[ source * 3 ] >>> 2;
		const green = bitmap.palette[ source * 3 + 1 ] >>> 2;
		const blue = bitmap.palette[ source * 3 + 2 ] >>> 2;
		let best = 0;
		let dr = red - ( gamePalette[ 0 ] >>> 2 );
		let dg = green - ( gamePalette[ 1 ] >>> 2 );
		let db = blue - ( gamePalette[ 2 ] >>> 2 );
		let bestDistance = dr * dr + dg * dg + db * db;

		// PALETTE.C deliberately excludes the two transparency slots.
		for ( let target = 1; target < 254; target ++ ) {

			dr = red - ( gamePalette[ target * 3 ] >>> 2 );
			dg = green - ( gamePalette[ target * 3 + 1 ] >>> 2 );
			db = blue - ( gamePalette[ target * 3 + 2 ] >>> 2 );
			const distance = dr * dr + dg * dg + db * db;
			if ( distance < bestDistance ) {

				bestDistance = distance;
				best = target;
				if ( distance === 0 ) break;

			}

		}

		remap[ source ] = best;

	}

	return remap;

}

function build_iff_texture( bitmap, gamePalette, repeat ) {

	const remap = remap_iff_palette( bitmap, gamePalette );
	const rgba = new Uint8Array( bitmap.width * bitmap.height * 4 );

	for ( let i = 0; i < bitmap.pixels.length; i ++ ) {

		const source = bitmap.pixels[ i ];
		const transparent = bitmap.hasTransparency === true &&
			source === bitmap.transparentColor;
		const target = remap[ source ];
		rgba[ i * 4 ] = transparent === true ? 0 : gamePalette[ target * 3 ];
		rgba[ i * 4 + 1 ] = transparent === true ? 0 : gamePalette[ target * 3 + 1 ];
		rgba[ i * 4 + 2 ] = transparent === true ? 0 : gamePalette[ target * 3 + 2 ];
		rgba[ i * 4 + 3 ] = transparent === true ? 0 : 255;

	}

	const texture = new THREE.DataTexture( rgba, bitmap.width, bitmap.height );
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.magFilter = THREE.LinearFilter;
	texture.minFilter = THREE.LinearMipmapLinearFilter;
	texture.generateMipmaps = true;
	texture.wrapS = repeat === true ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
	texture.wrapT = repeat === true ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
	texture.needsUpdate = true;
	_externalTextures.push( texture );
	return texture;

}

function copy_side_center( segnum, sidenum, target ) {

	const center = compute_center_point_on_side( segnum, sidenum );
	target.set( center.x, center.y, - center.z );

}

function compute_exit_orientation( data ) {

	const front = new THREE.Vector3();
	const back = new THREE.Vector3();
	const bottom = new THREE.Vector3();
	const top = new THREE.Vector3();
	copy_side_center( data.exitSegnum, 5, front );
	copy_side_center( data.exitSegnum, 4, back );
	copy_side_center( data.exitSegnum, 3, bottom );
	copy_side_center( data.exitSegnum, 1, top );

	_mineForward.subVectors( back, front ).normalize();
	_mineUp.subVectors( top, bottom ).normalize();
	// The reflected Three basis has right = forward cross up.
	_mineRight.crossVectors( _mineForward, _mineUp ).normalize();
	_mineUp.crossVectors( _mineRight, _mineForward ).normalize();

	_rotationMatrix.set(
		_mineRight.x, _mineUp.x, - _mineForward.x, 0,
		_mineRight.y, _mineUp.y, - _mineForward.y, 0,
		_mineRight.z, _mineUp.z, - _mineForward.z, 0,
		0, 0, 0, 1
	);
	_mineExitQuaternion.setFromRotationMatrix( _rotationMatrix );

	// ENDLEVEL.C keeps a fixed -0xa00 pitch and replaces the heading from
	// the level data, then post-multiplies the mine orientation by its inverse.
	const exitPitch = - 0x0A00 / 65536 * Math.PI * 2;
	_rotationEuler.set(
		- exitPitch, - data.exitHeading * Math.PI / 180, 0, 'YXZ'
	);
	_exitAngleQuaternion.setFromEuler( _rotationEuler ).invert();
	_surfaceQuaternion.copy( _mineExitQuaternion ).multiply( _exitAngleQuaternion ).normalize();

	const exitCenter = compute_segment_center( data.exitSegnum );
	_mineExitPoint.set( exitCenter.x, exitCenter.y, - exitCenter.z );
	_surfaceForward.set( 0, 0, - 1 ).applyQuaternion( _surfaceQuaternion ).normalize();
	_surfaceUp.set( 0, 1, 0 ).applyQuaternion( _surfaceQuaternion ).normalize();

	data.mineExitX = _mineExitPoint.x;
	data.mineExitY = _mineExitPoint.y;
	data.mineExitZ = - _mineExitPoint.z;

}

function terrain_height( pixels, width, height, i, j, minHeight ) {

	if ( i < 0 ) i = 0;
	if ( i >= width ) i = width - 1;
	if ( j < 0 ) j = 0;
	if ( j >= height ) j = height - 1;
	return pixels[ i * width + j ] - minHeight;

}

function build_terrain_mesh( terrainBitmap, heightBitmap, data ) {

	const width = heightBitmap.width;
	const height = heightBitmap.height;
	if ( width <= 1 || height <= 1 || width !== height || width > 64 ) return null;

	let minHeight = 255;
	for ( let i = 0; i < heightBitmap.pixels.length; i ++ ) {

		if ( heightBitmap.pixels[ i ] < minHeight ) minHeight = heightBitmap.pixels[ i ];

	}

	const count = width * height;
	const positions = new Float32Array( count * 3 );
	const uvs = new Float32Array( count * 2 );
	const colors = new Float32Array( count * 3 );
	const rawLight = new Float64Array( count );
	let minLight = Infinity;
	let maxLight = - Infinity;
	const lightX = 0x2E14 / 65536;
	const lightY = 0xE8F5 / 65536;
	const lightZ = 0x5EB8 / 65536;

	for ( let i = 0; i < width; i ++ ) {

		for ( let j = 0; j < height; j ++ ) {

			const index = i * height + j;
			const terrainHeight = terrain_height(
				heightBitmap.pixels, width, height, i, j, minHeight
			);
			positions[ index * 3 ] = ( i - data.exitPointY ) * TERRAIN_GRID_SCALE;
			positions[ index * 3 + 1 ] = terrainHeight;
			positions[ index * 3 + 2 ] = - ( j - data.exitPointX ) * TERRAIN_GRID_SCALE;
			uvs[ index * 2 ] = i / 4;
			uvs[ index * 2 + 1 ] = j / 4;

			let nx = terrain_height( heightBitmap.pixels, width, height, i + 1, j, minHeight ) -
				terrain_height( heightBitmap.pixels, width, height, i - 1, j, minHeight );
			let ny = - TERRAIN_GRID_SCALE * 2;
			let nz = terrain_height( heightBitmap.pixels, width, height, i, j + 1, minHeight ) -
				terrain_height( heightBitmap.pixels, width, height, i, j - 1, minHeight );
			const normalLength = Math.sqrt( nx * nx + ny * ny + nz * nz );
			nx /= normalLength;
			ny /= normalLength;
			nz /= normalLength;
			const lighting = - ( nx * lightX + ny * lightY + nz * lightZ );
			rawLight[ index ] = lighting;
			if ( lighting < minLight ) minLight = lighting;
			if ( lighting > maxLight ) maxLight = lighting;

		}

	}

	const lightRange = maxLight - minLight;
	for ( let i = 0; i < count; i ++ ) {

		const lighting = lightRange > 0 ? ( rawLight[ i ] - minLight ) / lightRange : 1;
		colors[ i * 3 ] = lighting;
		colors[ i * 3 + 1 ] = lighting;
		colors[ i * 3 + 2 ] = lighting;

	}

	const indices = new Uint16Array( ( width - 1 ) * ( height - 1 ) * 6 );
	let write = 0;
	for ( let i = 0; i < width - 1; i ++ ) {

		for ( let j = 0; j < height - 1; j ++ ) {

			const p0 = i * height + j;
			const p1 = p0 + 1;
			const p3 = ( i + 1 ) * height + j;
			const p2 = p3 + 1;
			// Reflection reverses the source fan winding; restore its upward face.
			indices[ write ++ ] = p0;
			indices[ write ++ ] = p3;
			indices[ write ++ ] = p1;
			indices[ write ++ ] = p1;
			indices[ write ++ ] = p3;
			indices[ write ++ ] = p2;

		}

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'uv', new THREE.BufferAttribute( uvs, 2 ) );
	geometry.setAttribute( 'color', new THREE.BufferAttribute( colors, 3 ) );
	geometry.setIndex( new THREE.BufferAttribute( indices, 1 ) );
	geometry.computeVertexNormals();
	geometry.computeBoundingSphere();
	_externalGeometries.push( geometry );

	const material = new THREE.MeshBasicMaterial( {
		map: build_iff_texture( terrainBitmap, _palette, true ),
		vertexColors: true,
		alphaTest: 0.5,
		side: THREE.FrontSide
	} );
	_externalMaterials.push( material );

	const mesh = new THREE.Mesh( geometry, material );
	mesh.name = 'endlevel-terrain';
	mesh.userData.endlevelTerrain = true;
	mesh.position.copy( _mineExitPoint ).addScaledVector( _mineUp, - 20 );
	mesh.quaternion.copy( _surfaceQuaternion );
	return mesh;

}

function next_star_random( state ) {

	state.value = ( Math.imul( state.value, 1103515245 ) + 12345 ) & 0x7FFFFFFF;
	return ( state.value >>> 16 ) & 0x7FFF;

}

function build_star_field() {

	const positions = new Float32Array( STAR_COUNT * 3 );
	const colors = new Float32Array( STAR_COUNT * 3 );
	const randomState = { value: 1 };
	let intensity = 31;

	for ( let i = 0; i < STAR_COUNT; i ++ ) {

		if ( ( i & 63 ) === 0 && i !== 0 ) intensity -= 3;
		positions[ i * 3 ] = ( next_star_random( randomState ) - 16384 ) / 4;
		positions[ i * 3 + 1 ] = next_star_random( randomState ) / 8;
		positions[ i * 3 + 2 ] = - ( next_star_random( randomState ) - 16384 ) / 4;
		const brightness = intensity / 31;
		colors[ i * 3 ] = brightness;
		colors[ i * 3 + 1 ] = brightness;
		colors[ i * 3 + 2 ] = brightness;

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'color', new THREE.BufferAttribute( colors, 3 ) );
	_externalGeometries.push( geometry );
	const material = new THREE.PointsMaterial( {
		size: 1,
		sizeAttenuation: false,
		vertexColors: true,
		depthWrite: false
	} );
	_externalMaterials.push( material );
	const points = new THREE.Points( geometry, material );
	points.name = 'endlevel-stars';
	points.userData.endlevelStars = true;
	points.frustumCulled = false;
	points.quaternion.copy( _surfaceQuaternion );
	points.position.copy( _mineExitPoint );
	return points;

}

function build_satellite_sprite( bitmap, data ) {

	_rotationEuler.set(
		data.satellitePitch * Math.PI / 180,
		- data.satelliteHeading * Math.PI / 180,
		0,
		'YXZ'
	);
	_satelliteAngleQuaternion.setFromEuler( _rotationEuler );
	_satelliteDirection.set( 0, 0, - 1 )
		.applyQuaternion( _satelliteAngleQuaternion )
		.applyQuaternion( _surfaceQuaternion )
		.normalize();

	_satelliteProjectedUp.copy( _surfaceUp ).addScaledVector(
		_satelliteDirection, - _surfaceUp.dot( _satelliteDirection )
	);
	if ( _satelliteProjectedUp.lengthSq() < 0.000001 ) {

		_satelliteProjectedUp.set( 1, 0, 0 ).applyQuaternion( _surfaceQuaternion );

	}
	_satelliteProjectedUp.normalize();

	const material = new THREE.SpriteMaterial( {
		map: build_iff_texture( bitmap, _palette, false ),
		alphaTest: 0.5,
		transparent: false
	} );
	_externalMaterials.push( material );
	const sprite = new THREE.Sprite( material );
	sprite.name = 'endlevel-satellite';
	sprite.userData.endlevelSatellite = true;
	sprite.center.set( 0.5, 0 );
	sprite.position.copy( _mineExitPoint ).addScaledVector(
		_satelliteDirection, SATELLITE_DISTANCE
	);
	const satelliteHeight = data.satelliteSize * SATELLITE_HEIGHT_SCALE;
	sprite.scale.set( data.satelliteSize * 2, satelliteHeight, 1 );
	_satelliteTopX = sprite.position.x + _satelliteProjectedUp.x * satelliteHeight;
	_satelliteTopY = sprite.position.y + _satelliteProjectedUp.y * satelliteHeight;
	_satelliteTopZ = sprite.position.z + _satelliteProjectedUp.z * satelliteHeight;
	return sprite;

}

function build_exit_model() {

	if ( exit_modelnum < 0 || exit_modelnum >= Polygon_models.length ) return null;
	const model = Polygon_models[ exit_modelnum ];
	if ( model === null || model === undefined ) return null;
	if ( model.mesh === null ) model.mesh = buildModelMesh( model, _pigFile, _palette );
	if ( model.mesh === null ) return null;

	const mesh = polyobj_clone_model_mesh( model.mesh );
	mesh.name = 'endlevel-exit-model';
	mesh.userData.endlevelExitModel = true;
	mesh.position.copy( _mineExitPoint ).addScaledVector( _mineForward, EXIT_MODEL_OFFSET );
	mesh.quaternion.copy( _mineExitQuaternion );
	polyobj_set_object_light( mesh, 1, 1, 1 );
	// The end-level renderer passes no glow array, so OP_GLOW uses object light.
	polyobj_set_morphing( mesh, true );
	mesh.traverse( child => {

		if ( child.isMesh !== true ) return;
		const materials = Array.isArray( child.material ) ? child.material : [ child.material ];
		for ( let i = 0; i < materials.length; i ++ ) {

			if ( _externalMaterials.includes( materials[ i ] ) !== true ) {

				_externalMaterials.push( materials[ i ] );

			}

		}

	} );
	return mesh;

}

export function prepare_endlevel_scene( hogFile ) {

	clear_external_scene();
	if ( _endlevelData === null || _scene === null || _pigFile === null || _palette === null ) return false;

	const terrainBitmap = iff_read_bitmap( hogFile, _endlevelData.terrainBitmap );
	const heightBitmap = iff_read_bitmap( hogFile, _endlevelData.heightMap );
	const satelliteBitmap = iff_read_bitmap( hogFile, _endlevelData.satelliteBitmap );
	if ( terrainBitmap === null || heightBitmap === null || satelliteBitmap === null ) return false;

	compute_exit_orientation( _endlevelData );
	_externalGroup = new THREE.Group();
	_externalGroup.name = 'endlevel-exterior';
	_externalGroup.userData.endlevelExterior = true;
	_externalGroup.visible = false;
	_scene.add( _externalGroup );

	_terrainMesh = build_terrain_mesh( terrainBitmap, heightBitmap, _endlevelData );
	_satelliteSprite = build_satellite_sprite( satelliteBitmap, _endlevelData );
	_starField = build_star_field();
	_exitModelMesh = build_exit_model();
	if ( _terrainMesh === null || _satelliteSprite === null || _starField === null ||
		_exitModelMesh === null ) {

		clear_external_scene();
		return false;

	}

	_externalGroup.add( _starField );
	_externalGroup.add( _satelliteSprite );
	_externalGroup.add( _terrainMesh );
	_externalGroup.add( _exitModelMesh );
	_externalSceneReady = true;
	console.log( 'ENDLEVEL: Exterior scene prepared (' +
		heightBitmap.width + 'x' + heightBitmap.height + ' terrain)' );
	return true;

}

function update_external_scene( camera, visible ) {

	if ( _externalGroup === null ) return;
	_externalGroup.visible = visible;
	if ( visible !== true ) return;

	_starField.position.copy( camera.position );
	_satelliteBottomScreen.copy( _satelliteSprite.position ).project( camera );
	_satelliteTopScreen.set( _satelliteTopX, _satelliteTopY, _satelliteTopZ ).project( camera );
	const dx = _satelliteTopScreen.x - _satelliteBottomScreen.x;
	const dy = _satelliteTopScreen.y - _satelliteBottomScreen.y;
	if ( dx * dx + dy * dy > 0.000001 ) {

		_satelliteSprite.material.rotation = Math.atan2( dy, dx ) - Math.PI / 2;

	}

}

function convert_endlevel_extension( filename, extension ) {

	const dot = filename.indexOf( '.' );
	if ( dot < 0 || dot > 8 ) return '';
	return filename.substring( 0, dot + 1 ) + extension;

}

function decode_endlevel_text( bytes, binary ) {

	let text = '';

	for ( let i = 0; i < bytes.length; i ++ ) {

		let value = bytes[ i ];

		// ENDLEVEL.C decrypts every byte returned by cfgets except its final LF.
		if ( binary === true && value !== 0x0A ) {

			value = ( ( value << 1 ) | ( value >>> 7 ) ) & 0xFF;
			value ^= BITMAP_TBL_XOR;
			value = ( ( value << 1 ) | ( value >>> 7 ) ) & 0xFF;

		}

		text += String.fromCharCode( value );

	}

	return text;

}

function parse_integer( value ) {

	if ( /^[+-]?\d+$/.test( value ) !== true ) return null;
	const parsed = Number.parseInt( value, 10 );
	return Number.isSafeInteger( parsed ) === true ? parsed : null;

}

function parse_pair( value ) {

	const parts = value.split( ',' );
	if ( parts.length !== 2 ) return null;

	const first = parse_integer( parts[ 0 ].trim() );
	const second = parse_integer( parts[ 1 ].trim() );
	if ( first === null || second === null ) return null;
	return [ first, second ];

}

function parse_endlevel_text( text, sourceFilename ) {

	const rawLines = text.split( /\r\n?|\n/ );
	const values = [];

	for ( let i = 0; i < rawLines.length; i ++ ) {

		const semicolon = rawLines[ i ].indexOf( ';' );
		const line = ( semicolon >= 0 ? rawLines[ i ].substring( 0, semicolon ) : rawLines[ i ] ).trim();
		if ( line.length > 0 ) values.push( line );

	}

	if ( values.length !== ENDLEVEL_VARIABLE_COUNT ) return null;

	const exitPoint = parse_pair( values[ 2 ] );
	const exitHeading = parse_integer( values[ 3 ] );
	const satelliteAngles = parse_pair( values[ 5 ] );
	const satelliteSize = parse_integer( values[ 6 ] );
	const stationAngles = parse_pair( values[ 7 ] );

	if ( exitPoint === null || exitHeading === null || satelliteAngles === null ||
		satelliteSize === null || stationAngles === null ) return null;

	return {
		sourceFilename: sourceFilename,
		terrainBitmap: values[ 0 ],
		heightMap: values[ 1 ],
		exitPointX: exitPoint[ 0 ],
		exitPointY: exitPoint[ 1 ],
		exitHeading: exitHeading,
		satelliteBitmap: values[ 4 ],
		satelliteHeading: satelliteAngles[ 0 ],
		satellitePitch: satelliteAngles[ 1 ],
		satelliteSize: satelliteSize,
		stationHeading: stationAngles[ 0 ],
		stationPitch: stationAngles[ 1 ],
		exitSegnum: - 1,
		exitSidenum: - 1
	};

}

function find_external_side( data ) {

	for ( let segnum = 0; segnum < Num_segments; segnum ++ ) {

		for ( let sidenum = 0; sidenum < 6; sidenum ++ ) {

			if ( Segments[ segnum ].children[ sidenum ] === - 2 ) {

				data.exitSegnum = segnum;
				data.exitSidenum = sidenum;
				return true;

			}

		}

	}

	return false;

}

// Load the ordered eight-variable end-level description.  ENDLEVEL.C first
// tries the current level's .END/.TXB, then falls back to level 1's data.
export function load_endlevel_data( hogFile, levelFilename, fallbackLevelFilename ) {

	clear_external_scene();
	_endlevelData = null;
	if ( hogFile === null || hogFile === undefined ) return false;

	const levelFilenames = [ levelFilename ];
	if ( fallbackLevelFilename !== levelFilename ) levelFilenames.push( fallbackLevelFilename );

	for ( let i = 0; i < levelFilenames.length; i ++ ) {

		const filename = levelFilenames[ i ];
		if ( typeof filename !== 'string' || filename.length === 0 ) continue;

		const plainFilename = convert_endlevel_extension( filename, 'end' );
		const binaryFilename = convert_endlevel_extension( filename, 'txb' );
		if ( plainFilename.length === 0 || binaryFilename.length === 0 ) continue;

		let sourceFilename = plainFilename;
		let binary = false;
		let file = hogFile.findFile( sourceFilename );
		if ( file === null ) {

			sourceFilename = binaryFilename;
			binary = true;
			file = hogFile.findFile( sourceFilename );

		}
		if ( file === null ) continue;

		const bytes = file.readBytes( file.length() );
		const data = parse_endlevel_text(
			decode_endlevel_text( bytes, binary ), sourceFilename
		);

		if ( data === null ) {

			console.warn( 'ENDLEVEL: Invalid end-level data in ' + sourceFilename );
			return false;

		}

		if ( find_external_side( data ) !== true ) {

			console.warn( 'ENDLEVEL: Mine has no external exit side' );
			return false;

		}

		_endlevelData = data;
		console.log( 'ENDLEVEL: Loaded ' + sourceFilename +
			' (exit=' + data.exitSegnum + ':' + data.exitSidenum + ')' );
		return true;

	}

	console.warn( 'ENDLEVEL: No .end/.txb data for ' + levelFilename );
	return false;

}

function find_exit_side( segnum, prefX, prefY, prefZ ) {

	const seg = Segments[ segnum ];
	const segCenter = compute_segment_center( segnum );

	let bestSide = - 1;
	let bestDot = - Infinity;

	for ( let side = 0; side < 6; side ++ ) {

		const child = seg.children[ side ];
		if ( child < 0 ) continue;

		const sideCenter = compute_center_point_on_side( segnum, side );

		let vx = sideCenter.x - segCenter.x;
		let vy = sideCenter.y - segCenter.y;
		let vz = sideCenter.z - segCenter.z;
		const vm = Math.sqrt( vx * vx + vy * vy + vz * vz );
		if ( vm < 0.0001 ) continue;

		vx /= vm;
		vy /= vm;
		vz /= vm;

		let d = vx * prefX + vy * prefY + vz * prefZ;
		if ( Math.abs( d ) < MIN_D ) d = 0;

		if ( d > bestDot ) {

			bestDot = d;
			bestSide = side;

		}

	}

	return bestSide;

}

function build_exit_tunnel_path( startSegnum, prefX, prefY, prefZ ) {

	if ( startSegnum < 0 || startSegnum >= Num_segments ) return false;

	let segnum = startSegnum;
	let exitSide = find_exit_side( segnum, prefX, prefY, prefZ );
	if ( exitSide < 0 ) return false;

	_pathCount = 0;

	while ( _pathCount < MAX_PATH_SEGS ) {

		_pathSegs[ _pathCount ] = segnum;
		_pathExitSides[ _pathCount ] = exitSide;
		_pathCount ++;

		const nextSeg = Segments[ segnum ].children[ exitSide ];

		if ( nextSeg === - 2 ) {

			_exitSegnum = segnum;
			break;

		}

		if ( nextSeg < 0 || nextSeg >= Num_segments ) return false;

		const entrySide = find_connect_side( segnum, nextSeg );
		if ( entrySide < 0 ) return false;

		segnum = nextSeg;
		exitSide = Side_opposite[ entrySide ];

	}

	if ( _pathCount <= 0 || _pathCount >= MAX_PATH_SEGS ) return false;

	_transitionSegnum = _pathSegs[ Math.floor( _pathCount / 3 ) ];
	return true;

}

function apply_camera_pose( camera, lookX, lookY, lookZ ) {

	camera.position.x = _posX;
	camera.position.y = _posY;
	camera.position.z = - _posZ;

	_lookAt.set( lookX, lookY, - lookZ );
	camera.lookAt( _lookAt );

}

function play_tunnel_effects( dt ) {

	if ( _createExplosion === null ) return;

	_explosionTimer -= dt;
	if ( _explosionTimer <= 0 ) {

		const rx = ( Math.random() - 0.5 ) * 8.0;
		const ry = ( Math.random() - 0.5 ) * 8.0;
		const rz = ( Math.random() - 0.5 ) * 8.0;
		const explosion_x = _posX + rx;
		const explosion_y = _posY + ry;
		const explosion_z = _posZ + rz;
		const explosionSegnum = find_point_seg(
			explosion_x, explosion_y, explosion_z, _currentSegnum
		);

		if ( explosionSegnum !== - 1 ) {

			_createExplosion(
				explosion_x, explosion_y, explosion_z,
				1.5 + Math.random() * 2.0, VCLIP_PLAYER_HIT
			);

			// D1 makes the chase explosions audible pseudo-randomly, but never
			// allows more than seven eligible explosions between sounds.
			if ( _playWorldSound !== null &&
				( Math.random() < 10000 / 32768 || ++ _tunnelSoundCount === 7 ) ) {

				_playWorldSound(
					SOUND_EXPLODING_WALL, 1.0, explosionSegnum,
					explosion_x, explosion_y, explosion_z
				);
				_tunnelSoundCount = 0;

			}

		}

		_explosionTimer = 0.125 + Math.random() * 0.125;

	}

	if ( _setWhiteFlash !== null ) {

		const segsRemaining = _pathCount - _pathIndex;
		if ( segsRemaining <= 2 && Math.random() < dt * 6.0 ) {

			_setWhiteFlash( 0.2 + Math.random() * 0.4 );

		} else {

			_setWhiteFlash( 0 );

		}

	}

}

function update_speed( dt ) {

	if ( _curFlySpeed === _desiredFlySpeed ) return;

	const delta = _desiredFlySpeed - _curFlySpeed;
	const frameAccel = dt * FLY_ACCEL;

	if ( Math.abs( delta ) < frameAccel ) {

		_curFlySpeed = _desiredFlySpeed;

	} else if ( delta > 0 ) {

		_curFlySpeed += frameAccel;

	} else {

		_curFlySpeed -= frameAccel;

	}

}

function advance_path_position( dt ) {

	let moveDist = _curFlySpeed * dt;

	while ( moveDist > 0 && _pathIndex < _pathCount ) {

		const segnum = _pathSegs[ _pathIndex ];
		const exitSide = _pathExitSides[ _pathIndex ];
		const target = compute_center_point_on_side( segnum, exitSide );

		const dx = target.x - _posX;
		const dy = target.y - _posY;
		const dz = target.z - _posZ;
		const dist = Math.sqrt( dx * dx + dy * dy + dz * dz );

		if ( dist <= 0.0001 ) {

			const child = Segments[ segnum ].children[ exitSide ];
			if ( child >= 0 && child < Num_segments ) {

				_currentSegnum = child;
				if ( _setPlayerSegnum !== null ) _setPlayerSegnum( _currentSegnum );

			}
			_pathIndex ++;
			continue;

		}

		if ( moveDist >= dist ) {

			_posX = target.x;
			_posY = target.y;
			_posZ = target.z;
			moveDist -= dist;

			const child = Segments[ segnum ].children[ exitSide ];
			if ( child >= 0 && child < Num_segments ) {

				_currentSegnum = child;
				if ( _setPlayerSegnum !== null ) _setPlayerSegnum( _currentSegnum );

			}

			_pathIndex ++;

		} else {

			const k = moveDist / dist;
			_posX += dx * k;
			_posY += dy * k;
			_posZ += dz * k;
			moveDist = 0;

		}

	}

}

export function start_endlevel_sequence( camera, startSegnum ) {

	if ( camera === null || camera === undefined ) return false;
	if ( startSegnum < 0 || startSegnum >= Num_segments ) return false;
	if ( _endlevelData === null || _externalSceneReady !== true ) return false;

	const threeForward = new THREE.Vector3( 0, 0, - 1 ).applyQuaternion( camera.quaternion );
	let prefX = threeForward.x;
	let prefY = threeForward.y;
	let prefZ = - threeForward.z;
	const prefMag = Math.sqrt( prefX * prefX + prefY * prefY + prefZ * prefZ );
	if ( prefMag < 0.0001 ) {

		prefX = 0;
		prefY = 0;
		prefZ = 1;

	} else {

		prefX /= prefMag;
		prefY /= prefMag;
		prefZ /= prefMag;

	}

	if ( build_exit_tunnel_path( startSegnum, prefX, prefY, prefZ ) !== true ) {

		stop_endlevel_sequence();
		return false;

	}

	_pathIndex = 0;
	_currentSegnum = startSegnum;
	_posX = camera.position.x;
	_posY = camera.position.y;
	_posZ = - camera.position.z;
	_curFlySpeed = FLY_SPEED;
	_desiredFlySpeed = FLY_SPEED;
	_explosionTimer = 0.12;
	_exitExplosionPlayed = false;
	_finishDelay = FINISH_DELAY;
	Endlevel_sequence = EL_FLYTHROUGH;
	update_external_scene( camera, false );

	if ( _setPlayerSegnum !== null ) _setPlayerSegnum( _currentSegnum );

	console.log( 'ENDLEVEL: Tunnel flythrough started. seg=' + startSegnum +
		' transition=' + _transitionSegnum + ' exit=' + _exitSegnum + ' path=' + _pathCount );

	return true;

}

export function stop_endlevel_sequence() {

	Endlevel_sequence = EL_OFF;
	_pathCount = 0;
	_pathIndex = 0;
	_currentSegnum = - 1;
	_transitionSegnum = - 1;
	_exitSegnum = - 1;
	_explosionTimer = 0;
	_exitExplosionPlayed = false;
	_finishDelay = 0;
	if ( _externalGroup !== null ) _externalGroup.visible = false;

	if ( _setWhiteFlash !== null ) _setWhiteFlash( 0 );

}

// Returns true when the flythrough finishes.
export function do_endlevel_frame( dt, camera ) {

	if ( Endlevel_sequence === EL_OFF ) return false;
	if ( camera === null || camera === undefined ) return false;

	update_speed( dt );
	advance_path_position( dt );
	play_tunnel_effects( dt );

	if ( _pathIndex < _pathCount ) {

		const segnum = _pathSegs[ _pathIndex ];
		const side = _pathExitSides[ _pathIndex ];
		const target = compute_center_point_on_side( segnum, side );
		apply_camera_pose( camera, target.x, target.y, target.z );
		update_external_scene( camera, false );
		return false;

	}

	if ( _exitExplosionPlayed !== true ) {

		_exitExplosionPlayed = true;
		if ( _createExplosion !== null ) {

			_createExplosion(
				_posX, _posY, _posZ, 50.0, VCLIP_BIG_PLAYER_EXPLOSION
			);

		}

		if ( _playWorldSound !== null ) {

			_playWorldSound(
				SOUND_EXPLODING_WALL, 0.75, _exitSegnum,
				_posX, _posY, _posZ
			);

		}

	}

	// Completed tunnel path: hold briefly while effects finish.
	_finishDelay -= dt;
	apply_camera_pose( camera, _posX, _posY, _posZ + 10.0 );
	update_external_scene( camera, true );

	if ( _finishDelay > 0 ) return false;

	stop_endlevel_sequence();
	return true;

}
