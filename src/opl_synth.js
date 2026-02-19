// OPL2 FM synth and bank handling for HMP MIDI playback.

const NUM_CHANNELS = 16;
const OPL2_NUM_VOICES = 9;

let _audioContext = null;
let _outputNode = null;

// Per-channel state (16 MIDI channels)
const _channels = [];

// Active note tracking for cleanup
const _activeNotes = new Map(); // key: "channel-note" -> { carrier, modulator, noteGain, ... }

// OPL2 9-voice melodic limit
const _voiceSlots = []; // array of { key, startTime }

// OPL bank data loaded from melodic.bnk / drum.bnk
let _bnkMelodicPatches = null; // Array(128): program -> patch
let _bnkDrumPatches = null; // Map(note -> patch)
let _bnkDrumNoteList = null; // sorted Array of available drum note keys

// OPL2 waveforms with feedback: cached as PeriodicWave objects
const _oplWaveCache = new Map();

function ensureChannelsInitialized() {

	if ( _channels.length === NUM_CHANNELS ) return;

	_channels.length = 0;

	for ( let i = 0; i < NUM_CHANNELS; i ++ ) {

		_channels.push( {
			program: 0,		// current instrument (0-127)
			volume: 100,	// channel volume (0-127)
			pan: 64,		// pan (0=left, 64=center, 127=right)
			expression: 127,	// expression controller
			pitchBend: 0	// pitch bend in cents (±200 = ±2 semitones)
		} );

	}

}

function getOplWaveform( waveType, fb ) {

	if ( _audioContext === null ) return null;

	const cacheKey = waveType + '-' + fb;

	if ( _oplWaveCache.has( cacheKey ) ) return _oplWaveCache.get( cacheKey );

	// Build PeriodicWave from Fourier coefficients
	const N = 64; // number of harmonics
	const real = new Float32Array( N );
	const imag = new Float32Array( N );

	if ( waveType === 0 ) {

		// Pure sine
		imag[ 1 ] = 1.0;

	} else if ( waveType === 1 ) {

		// Half-sine: positive half only (negative clamped to 0)
		real[ 0 ] = 1.0 / Math.PI;
		imag[ 1 ] = 0.5;
		for ( let n = 1; n < N / 2; n ++ ) {

			real[ 2 * n ] = - 2.0 / ( ( 4 * n * n - 1 ) * Math.PI );

		}

	} else if ( waveType === 2 ) {

		// Abs-sine: full-wave rectified (always positive)
		real[ 0 ] = 2.0 / Math.PI;
		for ( let n = 1; n < N / 2; n ++ ) {

			real[ 2 * n ] = - 4.0 / ( ( 4 * n * n - 1 ) * Math.PI );

		}

	} else if ( waveType === 3 ) {

		// Quarter-sine: sin(x) for 0≤x<π/2, 0 elsewhere
		const M = 1024;

		for ( let k = 0; k < N; k ++ ) {

			let rSum = 0, iSum = 0;

			for ( let j = 0; j < M; j ++ ) {

				const x = ( 2 * Math.PI * j ) / M;
				const val = ( x < Math.PI / 2 ) ? Math.sin( x ) : 0;
				rSum += val * Math.cos( 2 * Math.PI * k * j / M );
				iSum -= val * Math.sin( 2 * Math.PI * k * j / M );

			}

			real[ k ] = rSum / M * 2;
			imag[ k ] = iSum / M * 2;

		}

		real[ 0 ] /= 2;

	}

	// Apply OPL2 feedback to the waveform
	if ( fb > 0 ) {

		const fbAmount = Math.PI / Math.pow( 2, 8 - fb );
		const M = 1024;
		const waveform = new Float32Array( M );
		let prev1 = 0, prev2 = 0;

		for ( let cycle = 0; cycle < 3; cycle ++ ) {

			for ( let j = 0; j < M; j ++ ) {

				const phase = ( 2 * Math.PI * j ) / M;
				const fbPhase = phase + fbAmount * ( prev1 + prev2 ) * 0.5;
				let val;

				if ( waveType === 0 ) {

					val = Math.sin( fbPhase );

				} else if ( waveType === 1 ) {

					val = Math.sin( fbPhase );
					if ( val < 0 ) val = 0;

				} else if ( waveType === 2 ) {

					val = Math.abs( Math.sin( fbPhase ) );

				} else {

					const normPhase = ( ( fbPhase % ( 2 * Math.PI ) ) + 2 * Math.PI ) % ( 2 * Math.PI );
					val = ( normPhase < Math.PI / 2 ) ? Math.sin( normPhase ) : 0;

				}

				waveform[ j ] = val;
				prev2 = prev1;
				prev1 = val;

			}

		}

		for ( let k = 0; k < N; k ++ ) {

			let rSum = 0, iSum = 0;

			for ( let j = 0; j < M; j ++ ) {

				rSum += waveform[ j ] * Math.cos( 2 * Math.PI * k * j / M );
				iSum -= waveform[ j ] * Math.sin( 2 * Math.PI * k * j / M );

			}

			real[ k ] = rSum / M * 2;
			imag[ k ] = iSum / M * 2;

		}

		real[ 0 ] /= 2;

	}

	const wave = _audioContext.createPeriodicWave( real, imag, { disableNormalization: false } );
	_oplWaveCache.set( cacheKey, wave );
	return wave;

}

function oplAttackRate( rate ) {

	if ( rate === 0 ) return 10.0;
	return 2.826 / Math.pow( 2, rate - 1 );

}

function oplDecayRate( rate ) {

	if ( rate === 0 ) return 30.0;
	return 39.28 / Math.pow( 2, rate - 1 );

}

function oplSustainLevel( sl ) {

	if ( sl === 0 ) return 1.0;
	if ( sl >= 15 ) return 0.00002;
	return Math.pow( 10, - 3.0 * sl / 20.0 );

}

function oplTotalLevel( tl ) {

	if ( tl === 0 ) return 1.0;
	if ( tl >= 63 ) return 0.005;
	return Math.pow( 10, - 0.75 * tl / 20.0 );

}

function oplMultiplier( mult ) {

	if ( mult === 0 ) return 0.5;
	return mult;

}

function oplKeyScaleLevel( kslField, midiNote ) {

	if ( kslField === 0 ) return 1.0;

	const KSL_DB_PER_OCT = [ 0, 3.0, 1.5, 6.0 ];
	const dbPerOct = KSL_DB_PER_OCT[ kslField ];
	const octavesAboveC4 = ( midiNote - 60 ) / 12.0;
	if ( octavesAboveC4 <= 0 ) return 1.0;

	const attenuationDb = dbPerOct * octavesAboveC4;
	return Math.pow( 10, - attenuationDb / 20.0 );

}

function oplKeyScaleRate( ksrBit, midiNote ) {

	if ( ksrBit === 0 ) return 1.0;
	const octaves = Math.max( 0, ( midiNote - 36 ) / 12.0 );
	return Math.pow( 2, octaves * 0.5 );

}

const OPL_PATCHES = {};

OPL_PATCHES[ 0 ] = {
	mod: { mult: 3, tl: 8, ar: 9, dr: 5, sl: 1, rr: 9, wave: 1, fb: 4, eg: 1, ksl: 1, ksr: 0, am: 0, vib: 0 },
	car: { mult: 1, tl: 0, ar: 8, dr: 4, sl: 1, rr: 9, wave: 0, eg: 1, ksl: 0, ksr: 0, am: 0, vib: 0 }
};

OPL_PATCHES[ 25 ] = {
	mod: { mult: 3, tl: 20, ar: 15, dr: 3, sl: 9, rr: 10, wave: 1, fb: 6, eg: 0, ksl: 1, ksr: 0, am: 0, vib: 0 },
	car: { mult: 1, tl: 0, ar: 15, dr: 1, sl: 14, rr: 7, wave: 0, eg: 0, ksl: 0, ksr: 1, am: 0, vib: 0 }
};

OPL_PATCHES[ 29 ] = {
	mod: { mult: 3, tl: 8, ar: 9, dr: 5, sl: 1, rr: 9, wave: 1, fb: 4, eg: 1, ksl: 1, ksr: 0, am: 0, vib: 0 },
	car: { mult: 1, tl: 0, ar: 8, dr: 4, sl: 1, rr: 9, wave: 0, eg: 1, ksl: 0, ksr: 0, am: 0, vib: 0 }
};

OPL_PATCHES[ 38 ] = {
	mod: { mult: 1, tl: 11, ar: 15, dr: 4, sl: 14, rr: 8, wave: 0, fb: 5, eg: 1, ksl: 2, ksr: 1, am: 0, vib: 0 },
	car: { mult: 1, tl: 0, ar: 15, dr: 1, sl: 7, rr: 8, wave: 0, eg: 1, ksl: 0, ksr: 1, am: 0, vib: 0 }
};

OPL_PATCHES[ 39 ] = {
	mod: { mult: 1, tl: 18, ar: 15, dr: 1, sl: 2, rr: 8, wave: 0, fb: 5, eg: 1, ksl: 0, ksr: 1, am: 0, vib: 0 },
	car: { mult: 1, tl: 0, ar: 15, dr: 1, sl: 1, rr: 8, wave: 0, eg: 1, ksl: 0, ksr: 1, am: 0, vib: 0 }
};

OPL_PATCHES[ 80 ] = {
	mod: { mult: 2, tl: 25, ar: 15, dr: 15, sl: 0, rr: 3, wave: 2, fb: 0, eg: 1, ksl: 1, ksr: 0, am: 0, vib: 0 },
	car: { mult: 1, tl: 0, ar: 15, dr: 15, sl: 0, rr: 15, wave: 0, eg: 1, ksl: 0, ksr: 0, am: 0, vib: 0 }
};

OPL_PATCHES[ 90 ] = {
	mod: { mult: 1, tl: 23, ar: 9, dr: 1, sl: 3, rr: 4, wave: 0, fb: 6, eg: 1, ksl: 0, ksr: 0, am: 0, vib: 1 },
	car: { mult: 1, tl: 0, ar: 5, dr: 5, sl: 1, rr: 6, wave: 0, eg: 1, ksl: 0, ksr: 0, am: 0, vib: 1 }
};

OPL_PATCHES[ 94 ] = {
	mod: { mult: 1, tl: 9, ar: 1, dr: 1, sl: 3, rr: 3, wave: 0, fb: 5, eg: 1, ksl: 2, ksr: 0, am: 0, vib: 0 },
	car: { mult: 1, tl: 3, ar: 4, dr: 2, sl: 2, rr: 5, wave: 0, eg: 1, ksl: 0, ksr: 0, am: 0, vib: 1 }
};

OPL_PATCHES[ 95 ] = {
	mod: { mult: 1, tl: 21, ar: 1, dr: 1, sl: 4, rr: 7, wave: 1, fb: 0, eg: 1, ksl: 0, ksr: 0, am: 1, vib: 0 },
	car: { mult: 1, tl: 0, ar: 12, dr: 15, sl: 0, rr: 7, wave: 0, eg: 1, ksl: 0, ksr: 0, am: 0, vib: 0 }
};

OPL_PATCHES[ 100 ] = {
	mod: { mult: 1, tl: 13, ar: 15, dr: 1, sl: 5, rr: 1, wave: 1, fb: 0, eg: 0, ksl: 1, ksr: 0, am: 0, vib: 1 },
	car: { mult: 2, tl: 0, ar: 15, dr: 2, sl: 15, rr: 5, wave: 0, eg: 0, ksl: 0, ksr: 0, am: 0, vib: 1 }
};

OPL_PATCHES[ 113 ] = {
	mod: { mult: 7, tl: 21, ar: 14, dr: 12, sl: 2, rr: 6, wave: 0, fb: 5, eg: 0, ksl: 0, ksr: 0, am: 0, vib: 0 },
	car: { mult: 2, tl: 0, ar: 15, dr: 8, sl: 1, rr: 6, wave: 0, eg: 0, ksl: 0, ksr: 0, am: 0, vib: 0 }
};

OPL_PATCHES[ 117 ] = {
	mod: { mult: 1, tl: 1, ar: 15, dr: 8, sl: 4, rr: 7, wave: 2, fb: 2, eg: 0, ksl: 1, ksr: 1, am: 0, vib: 0 },
	car: { mult: 0, tl: 3, ar: 15, dr: 3, sl: 0, rr: 3, wave: 0, eg: 0, ksl: 0, ksr: 1, am: 0, vib: 0 }
};

OPL_PATCHES[ 118 ] = {
	mod: { mult: 1, tl: 14, ar: 15, dr: 1, sl: 0, rr: 6, wave: 2, fb: 7, eg: 0, ksl: 2, ksr: 0, am: 0, vib: 0 },
	car: { mult: 0, tl: 0, ar: 15, dr: 3, sl: 0, rr: 2, wave: 0, eg: 0, ksl: 0, ksr: 1, am: 0, vib: 0 }
};

const OPL_DEFAULT_PATCH = {
	mod: { mult: 1, tl: 20, ar: 12, dr: 4, sl: 4, rr: 8, wave: 0, fb: 3, eg: 1, ksl: 0, ksr: 0, am: 0, vib: 0 },
	car: { mult: 1, tl: 0, ar: 12, dr: 4, sl: 2, rr: 8, wave: 0, eg: 1, ksl: 0, ksr: 0, am: 0, vib: 0 }
};

function getOplPatch( program ) {

	if ( _bnkMelodicPatches !== null && program >= 0 && program < _bnkMelodicPatches.length ) {

		const bnkPatch = _bnkMelodicPatches[ program ];
		if ( bnkPatch !== undefined && bnkPatch !== null ) return bnkPatch;

	}

	if ( OPL_PATCHES[ program ] !== undefined ) return OPL_PATCHES[ program ];

	return OPL_DEFAULT_PATCH;

}

function readAscii( data, offset, length ) {

	let str = '';

	for ( let i = 0; i < length; i ++ ) {

		const b = data[ offset + i ];
		if ( b === 0 ) break;
		str += String.fromCharCode( b );

	}

	return str;

}

function parseOplBankFile( data ) {

	if ( data === null || data.length < 0x1c ) return null;

	const view = new DataView( data.buffer, data.byteOffset, data.byteLength );
	let headerBase = 2;
	let signature = readAscii( data, headerBase, 6 );

	if ( signature !== 'ADLIB-' ) {

		headerBase = 0;
		signature = readAscii( data, headerBase, 6 );

	}

	if ( signature !== 'ADLIB-' ) {

		console.warn( 'OPL: Invalid bank signature: ' + signature );
		return null;

	}

	const numEntries = view.getUint16( headerBase + 6, true );
	const numInstruments = view.getUint16( headerBase + 8, true );
	const namesOffset = view.getUint32( headerBase + 10, true );
	const dataOffset = view.getUint32( headerBase + 14, true );

	const entries = [];

	for ( let i = 0; i < numEntries; i ++ ) {

		const off = namesOffset + i * 12;
		if ( off + 12 > data.length ) break;

		entries.push( {
			instrumentIndex: view.getUint16( off, true ),
			tag: data[ off + 2 ],
			name: readAscii( data, off + 3, 9 )
		} );

	}

	const instruments = [];

	for ( let i = 0; i < numInstruments; i ++ ) {

		const off = dataOffset + i * 30;
		if ( off + 30 > data.length ) break;
		instruments.push( data.slice( off, off + 30 ) );

	}

	return {
		entries: entries,
		instruments: instruments
	};

}

function bankInstrumentToPatch( raw ) {

	if ( raw === undefined || raw === null || raw.length < 30 ) return null;

	// Instrument record format (30 bytes):
	// [0] percussive, [1] voice num
	// [2..14] operator 1 (mod), [15..27] operator 2 (car), [28..29] waveform selects.
	return {
		mod: {
			wave: raw[ 28 ] & 0x03,
			mult: raw[ 3 ] & 0x0F,
			fb: raw[ 4 ] & 0x07,
			ar: raw[ 5 ] & 0x0F,
			sl: raw[ 6 ] & 0x0F,
			eg: raw[ 7 ] & 0x01,
			dr: raw[ 8 ] & 0x0F,
			rr: raw[ 9 ] & 0x0F,
			tl: raw[ 10 ] & 0x3F,
			am: raw[ 11 ] & 0x01,
			vib: raw[ 12 ] & 0x01,
			ksr: raw[ 13 ] & 0x01,
			ksl: raw[ 2 ] & 0x03,
			con: raw[ 14 ] & 0x01
		},
		car: {
			wave: raw[ 29 ] & 0x03,
			mult: raw[ 16 ] & 0x0F,
			ar: raw[ 18 ] & 0x0F,
			sl: raw[ 19 ] & 0x0F,
			eg: raw[ 20 ] & 0x01,
			dr: raw[ 21 ] & 0x0F,
			rr: raw[ 22 ] & 0x0F,
			tl: raw[ 23 ] & 0x3F,
			am: raw[ 24 ] & 0x01,
			vib: raw[ 25 ] & 0x01,
			ksr: raw[ 26 ] & 0x01,
			ksl: raw[ 15 ] & 0x03,
			con: raw[ 27 ] & 0x01
		}
	};

}

function midiToFreq( note ) {

	return 440.0 * Math.pow( 2, ( note - 69 ) / 12.0 );

}

function selectPatch( channel, note ) {

	const program = _channels[ channel ].program;
	let opl = null;

	if ( channel === 9 && _bnkDrumPatches !== null ) {

		opl = _bnkDrumPatches.get( note ) || null;

		if ( opl === null && _bnkDrumNoteList !== null && _bnkDrumNoteList.length > 0 ) {

			let nearest = _bnkDrumNoteList[ 0 ];
			let bestDist = Math.abs( note - nearest );

			for ( let i = 1; i < _bnkDrumNoteList.length; i ++ ) {

				const candidate = _bnkDrumNoteList[ i ];
				const dist = Math.abs( note - candidate );

				if ( dist < bestDist ) {

					nearest = candidate;
					bestDist = dist;

				}

			}

			opl = _bnkDrumPatches.get( nearest ) || null;

		}

	}

	if ( opl === null ) {

		opl = getOplPatch( program );

	}

	return opl;

}

function removeVoiceSlot( key ) {

	for ( let i = 0; i < _voiceSlots.length; i ++ ) {

		if ( _voiceSlots[ i ].key === key ) {

			_voiceSlots.splice( i, 1 );
			return;

		}

	}

}

function hardStopActiveNote( key, active, time ) {

	try {

		active.noteGain.gain.cancelAndHoldAtTime( time );
		active.noteGain.gain.linearRampToValueAtTime( 0, time + 0.003 );
		active.modGain.gain.cancelAndHoldAtTime( time );
		active.modGain.gain.linearRampToValueAtTime( 0.0001, time + 0.003 );

		if ( active.modOutputGain ) {

			active.modOutputGain.gain.cancelAndHoldAtTime( time );
			active.modOutputGain.gain.linearRampToValueAtTime( 0, time + 0.003 );

		}

		active.carrier.stop( time + 0.005 );
		active.modulator.stop( time + 0.005 );

		if ( active.vibLfo ) active.vibLfo.stop( time + 0.005 );
		if ( active.amLfo ) active.amLfo.stop( time + 0.005 );

	} catch ( e ) { /* already stopped */ }

	_activeNotes.delete( key );
	removeVoiceSlot( key );

}

function cleanupActiveNote( key, active ) {

	const current = _activeNotes.get( key );
	if ( current === active ) _activeNotes.delete( key );
	removeVoiceSlot( key );

}

function scheduleNoteOn( channel, note, velocity, time ) {

	if ( _audioContext === null || _outputNode === null ) return;

	const key = channel + '-' + note;
	const existing = _activeNotes.get( key );

	if ( existing !== undefined ) {

		hardStopActiveNote( key, existing, time );

	}

	if ( _voiceSlots.length >= OPL2_NUM_VOICES ) {

		const oldest = _voiceSlots.shift();
		const oldNote = ( oldest !== undefined ) ? _activeNotes.get( oldest.key ) : undefined;

		if ( oldNote !== undefined ) {

			hardStopActiveNote( oldest.key, oldNote, time );

		}

	}

	const opl = selectPatch( channel, note );
	const freq = midiToFreq( note );
	const vel = velocity / 127;

	const modFreq = freq * oplMultiplier( opl.mod.mult );
	const carFreq = freq * oplMultiplier( opl.car.mult );
	const algorithmAdditive = ( opl.mod.con === 1 );

	const modKSL = oplKeyScaleLevel( opl.mod.ksl, note );
	const modDepthScale = oplTotalLevel( opl.mod.tl ) * modKSL;
	const peakMod = modDepthScale * carFreq * 8.0;

	const carKSL = oplKeyScaleLevel( opl.car.ksl, note );
	const carLevel = oplTotalLevel( opl.car.tl ) * carKSL;

	const velSq = vel * vel;
	const channelVol = _channels[ channel ].volume / 127;
	const expression = _channels[ channel ].expression / 127;
	const levelScale = velSq * channelVol * expression;

	const modKSR = oplKeyScaleRate( opl.mod.ksr, note );
	const carKSR = oplKeyScaleRate( opl.car.ksr, note );

	const modAR = oplAttackRate( opl.mod.ar ) / modKSR;
	const modDR = oplDecayRate( opl.mod.dr ) / modKSR;
	const modSL = oplSustainLevel( opl.mod.sl );
	const modRR = oplDecayRate( opl.mod.rr ) / modKSR;
	const carAR = oplAttackRate( opl.car.ar ) / carKSR;
	const carDR = oplDecayRate( opl.car.dr ) / carKSR;
	const carSL = oplSustainLevel( opl.car.sl );
	const carRR = oplDecayRate( opl.car.rr ) / carKSR;

	const modSustaining = opl.mod.eg === 1;
	const carSustaining = opl.car.eg === 1;

	const modulator = _audioContext.createOscillator();
	const modWave = getOplWaveform( opl.mod.wave, opl.mod.fb );

	if ( modWave !== null ) {

		modulator.setPeriodicWave( modWave );

	} else {

		modulator.type = 'sine';

	}

	modulator.frequency.value = modFreq;

	const modGain = _audioContext.createGain();
	modGain.gain.setValueAtTime( 0, time );

	if ( algorithmAdditive === true ) {

		const modVol = levelScale * modDepthScale * 0.18;
		const modSustainVal = modSustaining === true ? Math.max( modVol * modSL, 0.0001 ) : 0.0001;
		modGain.gain.setTargetAtTime( modVol, time, modAR / 3 );
		modGain.gain.setTargetAtTime( modSustainVal, time + modAR, modDR / 3 );

		if ( modSustaining !== true ) {

			modGain.gain.setTargetAtTime( 0.0001, time + modAR + modDR, modRR / 3 );

		}

	} else if ( peakMod > 0.1 ) {

		const modSustainVal = modSustaining === true ? Math.max( peakMod * modSL, 0.0001 ) : 0.0001;
		modGain.gain.setTargetAtTime( peakMod, time, modAR / 3 );
		modGain.gain.setTargetAtTime( modSustainVal, time + modAR, modDR / 3 );

		if ( modSustaining !== true ) {

			modGain.gain.setTargetAtTime( 0.0001, time + modAR + modDR, modRR / 3 );

		}

	}

	modulator.connect( modGain );
	let modOutputGain = null;

	const carrier = _audioContext.createOscillator();
	const carWave = getOplWaveform( opl.car.wave, 0 );

	if ( carWave !== null ) {

		carrier.setPeriodicWave( carWave );

	} else {

		carrier.type = 'sine';

	}

	carrier.frequency.value = carFreq;

	if ( algorithmAdditive === true ) {

		modOutputGain = _audioContext.createGain();
		modOutputGain.gain.setValueAtTime( 1.0, time );
		modGain.connect( modOutputGain );

	} else {

		modGain.connect( carrier.frequency );

	}

	if ( _channels[ channel ].pitchBend !== 0 ) {

		carrier.detune.setValueAtTime( _channels[ channel ].pitchBend, time );
		modulator.detune.setValueAtTime( _channels[ channel ].pitchBend, time );

	}

	const noteGain = _audioContext.createGain();

	const vol = levelScale * carLevel * 0.18;

	const carSustainVal = carSustaining === true ? Math.max( vol * carSL, 0.0001 ) : 0.0001;

	noteGain.gain.setValueAtTime( 0, time );
	noteGain.gain.setTargetAtTime( vol, time, carAR / 3 );
	noteGain.gain.setTargetAtTime( carSustainVal, time + carAR, carDR / 3 );

	if ( carSustaining !== true ) {

		noteGain.gain.setTargetAtTime( 0.0001, time + carAR + carDR, carRR / 3 );

	}

	let vibLfo = null;

	if ( opl.car.vib === 1 || opl.mod.vib === 1 ) {

		vibLfo = _audioContext.createOscillator();
		vibLfo.frequency.value = 6.1;
		vibLfo.type = 'sine';

		if ( opl.car.vib === 1 ) {

			const vibCarGain = _audioContext.createGain();
			vibCarGain.gain.value = 7.0;
			vibLfo.connect( vibCarGain );
			vibCarGain.connect( carrier.detune );

		}

		if ( opl.mod.vib === 1 ) {

			const vibModGain = _audioContext.createGain();
			vibModGain.gain.value = 7.0;
			vibLfo.connect( vibModGain );
			vibModGain.connect( modulator.detune );

		}

		vibLfo.start( time );

	}

	let amLfo = null;
	let amGain = null;

	if ( opl.car.am === 1 ) {

		amLfo = _audioContext.createOscillator();
		amLfo.frequency.value = 3.7;
		amLfo.type = 'sine';

		amGain = _audioContext.createGain();
		amGain.gain.value = 1.0;

		const amDepthNode = _audioContext.createGain();
		amDepthNode.gain.value = 0.06;
		amLfo.connect( amDepthNode );
		amDepthNode.connect( amGain.gain );

		amLfo.start( time );

		carrier.connect( amGain );
		amGain.connect( noteGain );

	} else {

		carrier.connect( noteGain );

	}

	if ( algorithmAdditive === true && modOutputGain ) {

		modOutputGain.connect( noteGain );

	}

	const panValue = ( _channels[ channel ].pan - 64 ) / 64;
	let panNode = null;

	if ( typeof _audioContext.createStereoPanner === 'function' ) {

		panNode = _audioContext.createStereoPanner();
		panNode.pan.setValueAtTime( panValue, time );
		noteGain.connect( panNode );
		panNode.connect( _outputNode );

	} else {

		noteGain.connect( _outputNode );

	}

	carrier.start( time );
	modulator.start( time );

	const shouldAutoStop = ( carSustaining !== true ) && ( algorithmAdditive !== true || modSustaining !== true );

	if ( shouldAutoStop === true ) {

		const carTail = carAR + carDR + carRR + 1.0;
		const modTail = modAR + modDR + modRR + 1.0;
		const stopTime = time + Math.max( carTail, modTail );
		carrier.stop( stopTime );
		modulator.stop( stopTime );

		if ( vibLfo ) vibLfo.stop( stopTime );
		if ( amLfo ) amLfo.stop( stopTime );

	}

	const noteState = {
		carrier: carrier,
		modulator: modulator,
		noteGain: noteGain,
		modGain: modGain,
		modOutputGain: modOutputGain,
		pan: panNode,
		carRR: carRR,
		modRR: modRR,
		vibLfo: vibLfo,
		amLfo: amLfo
	};

	carrier.onended = () => {

		cleanupActiveNote( key, noteState );

	};

	_activeNotes.set( key, noteState );

	_voiceSlots.push( { key: key, startTime: time } );

}

function scheduleNoteOff( channel, note, time ) {

	const key = channel + '-' + note;
	const active = _activeNotes.get( key );

	if ( active === undefined ) return;

	const carRelease = active.carRR;
	const modRelease = active.modRR;
	const maxRelease = Math.max( carRelease, modRelease );
	const stopTime = time + maxRelease + 0.1;

	try {

		active.noteGain.gain.cancelAndHoldAtTime( time );
		active.noteGain.gain.setTargetAtTime( 0.0001, time, carRelease / 3 );

		active.modGain.gain.cancelAndHoldAtTime( time );
		active.modGain.gain.setTargetAtTime( 0.0001, time, modRelease / 3 );

		if ( active.modOutputGain ) {

			active.modOutputGain.gain.cancelAndHoldAtTime( time );
			active.modOutputGain.gain.setTargetAtTime( 0.0001, time, modRelease / 3 );

		}

		active.carrier.stop( stopTime );
		active.modulator.stop( stopTime );
		if ( active.vibLfo ) active.vibLfo.stop( stopTime );
		if ( active.amLfo ) active.amLfo.stop( stopTime );

	} catch ( e ) { /* already stopped */ }

}

function handleControlChange( channel, controller, value ) {

	switch ( controller ) {

		case 7:
			_channels[ channel ].volume = value;
			break;

		case 10:
			_channels[ channel ].pan = value;
			break;

		case 11:
			_channels[ channel ].expression = value;
			break;

		case 121:
			_channels[ channel ].volume = 100;
			_channels[ channel ].pan = 64;
			_channels[ channel ].expression = 127;
			_channels[ channel ].pitchBend = 0;
			break;

	}

}

function handlePitchBend( channel, data1, data2, playTime ) {

	const bendValue = ( ( data2 << 7 ) | data1 ) - 8192;
	const bendCents = ( bendValue / 8192 ) * 200;
	_channels[ channel ].pitchBend = bendCents;

	for ( const [ key, active ] of _activeNotes ) {

		if ( key.startsWith( channel + '-' ) === true ) {

			try {

				active.carrier.detune.setValueAtTime( bendCents, playTime );
				active.modulator.detune.setValueAtTime( bendCents, playTime );

			} catch ( e ) { /* oscillator may have stopped */ }

		}

	}

}

export function opl_set_audio_graph( audioContext, outputNode ) {

	if ( _audioContext !== audioContext ) {

		_oplWaveCache.clear();

	}

	_audioContext = audioContext;
	_outputNode = outputNode;

}

export function opl_init( hogFile ) {

	ensureChannelsInitialized();
	opl_reset_channels();

	_bnkMelodicPatches = null;
	_bnkDrumPatches = null;
	_bnkDrumNoteList = null;

	if ( hogFile === null || hogFile === undefined ) return;

	const melodicFile = hogFile.findFile( 'melodic.bnk' );

	if ( melodicFile !== null ) {

		const melodicData = melodicFile.readBytes( melodicFile.length() );
		const melodicBank = parseOplBankFile( melodicData );

		if ( melodicBank !== null ) {

			const melodicTable = new Array( 128 );
			let melodicCount = 0;

			for ( let program = 0; program < melodicBank.entries.length && program < 128; program ++ ) {

				const entry = melodicBank.entries[ program ];
				if ( entry.instrumentIndex >= melodicBank.instruments.length ) continue;

				const patch = bankInstrumentToPatch( melodicBank.instruments[ entry.instrumentIndex ] );
				if ( patch === null ) continue;

				melodicTable[ program ] = patch;
				melodicCount ++;

			}

			_bnkMelodicPatches = melodicTable;
			console.log( 'OPL: Loaded melodic.bnk (' + melodicCount + ' program patches)' );

		}

	}

	const drumFile = hogFile.findFile( 'drum.bnk' );

	if ( drumFile !== null ) {

		const drumData = drumFile.readBytes( drumFile.length() );
		const drumBank = parseOplBankFile( drumData );

		if ( drumBank !== null ) {

			const drumMap = new Map();

			for ( let i = 0; i < drumBank.entries.length; i ++ ) {

				const entry = drumBank.entries[ i ];
				const note = entry.tag & 0x7F;
				if ( note < 0 || note > 127 ) continue;
				if ( entry.instrumentIndex >= drumBank.instruments.length ) continue;
				if ( drumMap.has( note ) ) continue;

				const patch = bankInstrumentToPatch( drumBank.instruments[ entry.instrumentIndex ] );
				if ( patch === null ) continue;
				drumMap.set( note, patch );

			}

			_bnkDrumPatches = drumMap;
			_bnkDrumNoteList = [ ...drumMap.keys() ].sort( ( a, b ) => a - b );
			console.log( 'OPL: Loaded drum.bnk (' + drumMap.size + ' drum-note patches)' );

		}

	}

}

export function opl_reset_channels() {

	ensureChannelsInitialized();

	for ( let i = 0; i < NUM_CHANNELS; i ++ ) {

		_channels[ i ].program = 0;
		_channels[ i ].volume = 100;
		_channels[ i ].pan = 64;
		_channels[ i ].expression = 127;
		_channels[ i ].pitchBend = 0;

	}

}

export function opl_process_midi_event( ev, playTime ) {

	ensureChannelsInitialized();

	const ch = ev.channel;

	switch ( ev.type ) {

		case 0x8:
			scheduleNoteOff( ch, ev.data1, playTime );
			break;

		case 0x9:
			if ( ev.data2 === 0 ) {

				scheduleNoteOff( ch, ev.data1, playTime );

			} else {

				scheduleNoteOn( ch, ev.data1, ev.data2, playTime );

			}
			break;

		case 0xB:
			handleControlChange( ch, ev.data1, ev.data2 );
			break;

		case 0xC:
			_channels[ ch ].program = ev.data1;
			break;

		case 0xE:
			handlePitchBend( ch, ev.data1, ev.data2, playTime );
			break;

	}

}

export function opl_stop_all_notes() {

	if ( _audioContext === null ) return;

	const now = _audioContext.currentTime;

	for ( const [ key, active ] of _activeNotes ) {

		try {

			active.noteGain.gain.cancelScheduledValues( now );
			active.noteGain.gain.setValueAtTime( 0, now );
			active.modGain.gain.cancelScheduledValues( now );
			active.modGain.gain.setValueAtTime( 0, now );
			if ( active.modOutputGain ) {

				active.modOutputGain.gain.cancelScheduledValues( now );
				active.modOutputGain.gain.setValueAtTime( 0, now );

			}
			active.carrier.stop( now + 0.01 );
			active.modulator.stop( now + 0.01 );
			if ( active.vibLfo ) active.vibLfo.stop( now + 0.01 );
			if ( active.amLfo ) active.amLfo.stop( now + 0.01 );

		} catch ( e ) { /* already stopped */ }

	}

	_activeNotes.clear();
	_voiceSlots.length = 0;

}
