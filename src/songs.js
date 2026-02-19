// Ported from: descent-master/MAIN/SONGS.C
// Song/music selection and playback orchestration for HMP tracks.

import { hmp_parse, hmp_get_events } from './hmp.js';
import {
	opl_init,
	opl_set_audio_graph,
	opl_reset_channels,
	opl_process_midi_event,
	opl_stop_all_notes
} from './opl_synth.js';

// Song constants (from SONGS.H)
export const SONG_TITLE = 0;
export const SONG_BRIEFING = 1;
export const SONG_ENDLEVEL = 2;
export const SONG_ENDGAME = 3;
export const SONG_CREDITS = 4;
export const SONG_LEVEL_MUSIC = 5;

// Shareware song file mapping
const SHAREWARE_SONGS = [
	'descent.hmp',
	'briefing.hmp',
	null,
	null,
	'credits.hmp',
	'game0.hmp',
	'game1.hmp',
	'game2.hmp',
	'game3.hmp',
	'game4.hmp',
	'game0.hmp',
	'game1.hmp'
];

// External references
let _hogFile = null;

// Playback state
let _audioContext = null;
let _masterGain = null;
let _compressor = null;
let _currentSong = - 1;
let _playing = false;
let _looping = false;
let _events = null;
let _eventIndex = 0;
let _startTime = 0;
let _scheduleTimer = null;
let _songDuration = 0;
let _playbackEndTime = 0;
let _playbackEndIndex = 0;
let _loopStartTime = 0;
let _loopStartEventIndex = 0;
let _loopDuration = 0;
let _nextSectionEndTime = 0;
let _hasLoopMarkers = false;
let _pauseTime = 0;
let _volume = 0.4;

export function songs_init( hogFile ) {

	_hogFile = hogFile;
	opl_init( hogFile );
	console.log( 'SONGS: Music system initialized' );

}

// Set shared AudioContext from digi.js (avoids multiple contexts)
export function songs_set_audio_context( ctx, masterGainNode ) {

	_audioContext = ctx;

	// Compressor prevents clipping with many simultaneous FM voices
	_compressor = ctx.createDynamicsCompressor();
	_compressor.threshold.value = - 12;
	_compressor.knee.value = 6;
	_compressor.ratio.value = 4;
	_compressor.attack.value = 0.003;
	_compressor.release.value = 0.1;

	// Chain: synth output -> _masterGain -> _compressor -> masterGainNode
	_masterGain = ctx.createGain();
	_masterGain.gain.value = _volume;
	_masterGain.connect( _compressor );
	_compressor.connect( masterGainNode );

	opl_set_audio_graph( ctx, _masterGain );

}

function ensureAudioContext() {

	if ( _audioContext !== null ) return true;

	try {

		_audioContext = new ( window.AudioContext || window.webkitAudioContext )();

		_compressor = _audioContext.createDynamicsCompressor();
		_compressor.threshold.value = - 12;
		_compressor.knee.value = 6;
		_compressor.ratio.value = 4;
		_compressor.attack.value = 0.003;
		_compressor.release.value = 0.1;

		_masterGain = _audioContext.createGain();
		_masterGain.gain.value = _volume;
		_masterGain.connect( _compressor );
		_compressor.connect( _audioContext.destination );

		opl_set_audio_graph( _audioContext, _masterGain );

		return true;

	} catch ( e ) {

		console.warn( 'SONGS: Could not create AudioContext:', e );
		return false;

	}

}

function findFirstEventAtOrAfter( time ) {

	if ( _events === null ) return 0;

	for ( let i = 0; i < _events.length; i ++ ) {

		if ( _events[ i ].time >= time ) return i;

	}

	return _events.length;

}

function findFirstEventAfter( time ) {

	if ( _events === null ) return 0;

	for ( let i = 0; i < _events.length; i ++ ) {

		if ( _events[ i ].time > time ) return i;

	}

	return _events.length;

}

function configureSongTiming() {

	_songDuration = _events[ _events.length - 1 ].time;

	if ( _songDuration <= 0 ) {

		_songDuration = 0.01;

	}

	_hasLoopMarkers = false;
	_loopStartTime = 0;
	_loopStartEventIndex = 0;
	_loopDuration = _songDuration;
	_playbackEndTime = _songDuration;
	_playbackEndIndex = _events.length;

	let markerStart = - 1;
	let markerEnd = - 1;

	for ( let i = 0; i < _events.length; i ++ ) {

		const ev = _events[ i ];
		if ( ev.type !== 0xB ) continue;

		if ( markerStart < 0 && ev.data1 === 110 ) {

			markerStart = ev.time;

		} else if ( markerStart >= 0 && ev.data1 === 111 && ev.time >= markerStart ) {

			markerEnd = ev.time;
			break;

		}

	}

	if ( markerStart >= 0 && markerEnd > markerStart ) {

		_hasLoopMarkers = true;
		_loopStartTime = markerStart;
		_loopStartEventIndex = findFirstEventAtOrAfter( _loopStartTime );
		_playbackEndTime = markerEnd;
		_playbackEndIndex = findFirstEventAfter( _playbackEndTime );
		_loopDuration = _playbackEndTime - _loopStartTime;

	}

}

export function songs_play_song( songnum, loop ) {

	if ( _hogFile === null ) return;

	songs_stop();

	const filename = ( songnum < SHAREWARE_SONGS.length ) ? SHAREWARE_SONGS[ songnum ] : null;

	if ( filename === null ) {

		console.log( 'SONGS: No music file for song ' + songnum );
		return;

	}

	const file = _hogFile.findFile( filename );

	if ( file === null ) {

		console.warn( 'SONGS: ' + filename + ' not found in HOG' );
		return;

	}

	const hmpData = new Uint8Array( file.readBytes( file.length() ) );
	const hmpFile = hmp_parse( hmpData );

	if ( hmpFile === null ) {

		console.warn( 'SONGS: Failed to parse ' + filename );
		return;

	}

	_events = hmp_get_events( hmpFile );

	if ( _events.length === 0 ) {

		console.warn( 'SONGS: No events in ' + filename );
		return;

	}

	configureSongTiming();

	if ( ensureAudioContext() !== true ) return;

	if ( _audioContext.state === 'suspended' ) {

		_audioContext.resume();

	}

	opl_reset_channels();

	_currentSong = songnum;
	_playing = true;
	_looping = ( loop === true || loop === 1 );
	_eventIndex = 0;
	_startTime = _audioContext.currentTime + 0.1;
	_nextSectionEndTime = _startTime + _playbackEndTime;
	_pauseTime = 0;

	scheduleNextChunk();

	console.log( 'SONGS: Playing ' + filename + ' (' + _events.length + ' events, ' +
		_songDuration.toFixed( 1 ) + 's' + ( _looping ? ', looping' : '' ) +
		( _hasLoopMarkers ? ', loop markers ' + _loopStartTime.toFixed( 3 ) + 's-' + _playbackEndTime.toFixed( 3 ) + 's' : '' ) +
		')' );

}

export function songs_play_level_song( levelnum ) {

	const songIndex = SONG_LEVEL_MUSIC + ( ( levelnum - 1 ) % 5 );
	songs_play_song( songIndex, true );

}

export function songs_stop() {

	_playing = false;
	_currentSong = - 1;
	_events = null;
	_songDuration = 0;
	_playbackEndTime = 0;
	_playbackEndIndex = 0;
	_loopStartTime = 0;
	_loopStartEventIndex = 0;
	_loopDuration = 0;
	_nextSectionEndTime = 0;
	_hasLoopMarkers = false;
	_pauseTime = 0;

	if ( _scheduleTimer !== null ) {

		clearTimeout( _scheduleTimer );
		_scheduleTimer = null;

	}

	opl_stop_all_notes();

}

export function songs_pause() {

	if ( _playing !== true ) return;
	if ( _audioContext === null ) return;

	_pauseTime = _audioContext.currentTime - _startTime;
	_playing = false;

	if ( _scheduleTimer !== null ) {

		clearTimeout( _scheduleTimer );
		_scheduleTimer = null;

	}

	opl_stop_all_notes();

}

export function songs_resume_playback() {

	if ( _events === null || _pauseTime <= 0 ) return;
	if ( _audioContext === null ) return;

	_playing = true;
	_startTime = _audioContext.currentTime - _pauseTime;
	_nextSectionEndTime = _startTime + _playbackEndTime;

	_eventIndex = 0;
	for ( let i = 0; i < _playbackEndIndex; i ++ ) {

		if ( _events[ i ].time > _pauseTime ) break;
		_eventIndex = i + 1;

	}

	scheduleNextChunk();

}

export function songs_set_volume( vol ) {

	_volume = vol;

	if ( _masterGain !== null ) {

		_masterGain.gain.value = vol;

	}

}

function scheduleNextChunk() {

	if ( _playing !== true || _events === null ) return;

	const SCHEDULE_AHEAD = 2.0;
	const MAX_WRAP_PASSES = 4;
	const now = _audioContext.currentTime;

	let wrapPasses = 0;

	while ( wrapPasses < MAX_WRAP_PASSES ) {

		const songTime = now - _startTime;
		const scheduleUntilTime = songTime + SCHEDULE_AHEAD;

		while ( _eventIndex < _playbackEndIndex ) {

			const ev = _events[ _eventIndex ];

			if ( ev.time > scheduleUntilTime ) break;

			const playTime = _startTime + ev.time;

			if ( playTime >= now - 0.01 ) {

				opl_process_midi_event( ev, playTime );

			}

			_eventIndex ++;

		}

		if ( _eventIndex < _playbackEndIndex ) break;

		if ( _looping !== true || _loopDuration <= 0 ) {

			if ( now >= _nextSectionEndTime - 0.01 ) {

				_playing = false;
				return;

			}

			break;

		}

		_eventIndex = ( _hasLoopMarkers === true ) ? _loopStartEventIndex : 0;
		_startTime += _loopDuration;
		_nextSectionEndTime += _loopDuration;
		wrapPasses ++;

	}

	let delayMs = 50;

	if ( _eventIndex >= _playbackEndIndex ) {

		const remainingMs = Math.max( 10, ( _nextSectionEndTime - _audioContext.currentTime ) * 1000 );
		delayMs = Math.min( 100, remainingMs );

	}

	if ( wrapPasses >= MAX_WRAP_PASSES ) {

		delayMs = 20;

	}

	_scheduleTimer = setTimeout( scheduleNextChunk, delayMs );

}

// Resume audio context (call from user gesture)
export function songs_resume() {

	if ( _audioContext !== null && _audioContext.state === 'suspended' ) {

		_audioContext.resume();

	}

}
