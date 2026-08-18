import neonSunrise from './neon-sunrise.js';
import midnightDrive from './midnight-drive.js';
import laserBloom from './laser-bloom.js';
import circuitStorm from './circuit-storm.js';
import hyperNova from './hyper-nova.js';

/** Les morceaux dans l'ordre de difficulté croissante. */
export const SONGS = [neonSunrise, midnightDrive, laserBloom, circuitStorm, hyperNova];

export const SONGS_BY_ID = Object.fromEntries(SONGS.map((s) => [s.id, s]));
