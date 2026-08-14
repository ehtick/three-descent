// Ported from: descent-master/MAIN/ENDLEVEL.C
// Endlevel tunnel flythrough state and movement

import * as THREE from 'three';

import { Segments, Num_segments, Side_opposite } from './mglobal.js';
import { compute_center_point_on_side, find_connect_side, compute_segment_center, find_point_seg } from './gameseg.js';
import { VCLIP_PLAYER_HIT, VCLIP_BIG_PLAYER_EXPLOSION } from './fireball.js';
import { SOUND_EXPLODING_WALL } from './digi.js';

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

let _endlevelData = null;

// Externals from gameseq
let _setPlayerSegnum = null;
let _createExplosion = null;
let _setWhiteFlash = null;
let _playWorldSound = null;

// Pre-allocated vectors (Golden Rule #5)
const _lookAt = new THREE.Vector3();

export function endlevel_set_externals( ext ) {

	if ( ext.setPlayerSegnum !== undefined ) _setPlayerSegnum = ext.setPlayerSegnum;
	if ( ext.createExplosion !== undefined ) _createExplosion = ext.createExplosion;
	if ( ext.setWhiteFlash !== undefined ) _setWhiteFlash = ext.setWhiteFlash;
	if ( ext.playWorldSound !== undefined ) _playWorldSound = ext.playWorldSound;

}

export function endlevel_is_active() {

	return Endlevel_sequence !== EL_OFF;

}

export function endlevel_get_data() {

	return _endlevelData;

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
	if ( _endlevelData === null ) return false;

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

	if ( _finishDelay > 0 ) return false;

	stop_endlevel_sequence();
	return true;

}
