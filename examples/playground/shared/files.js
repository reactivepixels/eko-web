/**
 * Turning dropped or picked files into playlist entries, shared by every Playground player.
 * The engine reads only `track.id` and `track.src`; the rest is for display.
 */

const AUDIO_EXT = /\.(mp3|flac|wav|ogg|oga|opus|m4a|aac|aif|aiff|webm)$/i;

/** @param {{name: string, type: string}} file */
export function isAudioFile(file) {
  if (file.type && file.type.startsWith("audio/")) return true;
  return AUDIO_EXT.test(file.name);
}

/** "Artist - Title.flac" becomes "Artist - Title". Winamp showed filenames the same way. */
export function titleFromName(name) {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  return base.replace(/_/g, " ").trim();
}

/** Average bitrate in kbps, the way Winamp reported VBR files. */
export function kbpsFor(bytes, durationSec) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
  return Math.round((bytes * 8) / durationSec / 1000);
}

/**
 * An 8 second loop (Am, F, C, G arpeggio over a soft bass and a kick) as a mono 48 kHz WAV.
 * Every note and drum hit has fully decayed by the end, so copies queued back to back join
 * with no seam: pressing Play on an empty player demonstrates gapless by itself.
 */
export function makeDemoLoop() {
  const rate = 48000;
  const seconds = 8;
  const frames = rate * seconds;
  const mix = new Float32Array(frames);
  const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
  const chords = [
    [57, 60, 64, 69],
    [53, 57, 60, 65],
    [48, 52, 55, 60],
    [55, 59, 62, 67],
  ];
  const add = (start, length, fn) => {
    const s0 = Math.round(start * rate);
    const n = Math.min(Math.round(length * rate), frames - s0);
    for (let i = 0; i < n; i++) mix[s0 + i] += fn(i / rate, i, n);
  };
  const edge = (i, n, fade) => Math.min(1, i / fade, (n - 1 - i) / fade);
  chords.forEach((chord, c) => {
    const t0 = c * 2;
    const bass = midi(chord[0] - 12);
    add(t0, 2, (t, i, n) => 0.22 * Math.sin(2 * Math.PI * bass * t) * edge(i, n, 480));
    for (let k = 0; k < 8; k++) {
      const f = midi(chord[[0, 1, 2, 3, 2, 1, 2, 3][k]] + 12);
      add(t0 + k * 0.25, 0.25, (t, i, n) => {
        const env = Math.exp(-t * 14) * edge(i, n, 240);
        const tone =
          Math.sin(2 * Math.PI * f * t) +
          0.3 * Math.sin(4 * Math.PI * f * t) +
          0.12 * Math.sin(6 * Math.PI * f * t);
        return 0.16 * env * tone;
      });
    }
    for (let beat = 0; beat < 4; beat++) {
      add(t0 + beat * 0.5, 0.18, (t, i, n) => {
        const phase = 2 * Math.PI * (50 * t + (70 / 30) * (1 - Math.exp(-30 * t)));
        return 0.5 * Math.exp(-t * 22) * Math.sin(phase) * edge(i, n, 96);
      });
    }
  });
  const bytes = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(bytes);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + frames * 2, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) {
    const s = Math.max(-1, Math.min(1, mix[i]));
    view.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return new Blob([bytes], { type: "audio/wav" });
}

/** Duration from a throwaway media element. Resolves 0 when the browser cannot read it. */
export function probeDuration(url) {
  return new Promise((resolve) => {
    const audio = new Audio();
    const done = (value) => {
      audio.removeAttribute("src");
      resolve(Number.isFinite(value) ? value : 0);
    };
    audio.preload = "metadata";
    audio.onloadedmetadata = () => done(audio.duration);
    audio.onerror = () => done(0);
    audio.src = url;
  });
}

/**
 * @typedef {{ track: { id: string, src: string }, title: string, durationSec: number,
 *   kbps: number | null, url: string }} Entry
 */

/**
 * Non-audio files are dropped here, so a stray .txt or cover image never reaches the queue.
 * @param {File[]} files
 * @param {number} idStart
 * @returns {Promise<Entry[]>}
 */
export async function filesToEntries(files, idStart) {
  const audio = files.filter(isAudioFile);
  return Promise.all(
    audio.map(async (file, i) => {
      const url = URL.createObjectURL(file);
      const durationSec = await probeDuration(url);
      return {
        track: { id: `t${idStart + i}`, src: url },
        title: titleFromName(file.name),
        durationSec,
        kbps: kbpsFor(file.size, durationSec),
        url,
      };
    }),
  );
}

/** Pure append, so the list the engine is playing from is never mutated in place. */
export function appendEntries(list, added) {
  return [...list, ...added];
}
