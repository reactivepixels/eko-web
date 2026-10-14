/**
 * This frame's new light: the waveform in the preset's shape, plus any comets. Drawn
 * additively on a transparent canvas the size of the feedback buffer; the warp then smears
 * it into trails on the following frames.
 */

const TAU = Math.PI * 2;
const css = (c, a) =>
  `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;

/**
 * @param {CanvasRenderingContext2D} g
 * @param {object} s  blended preset parameters
 * @param {{ wave: Float32Array, spectrum: Uint8Array, bass_att: number, mid_att: number,
 *   treb_att: number, t: number }} a
 */
export function drawWaves(g, s, a) {
  const { width: w, height: h } = g.canvas;
  g.globalCompositeOperation = "source-over";
  g.clearRect(0, 0, w, h);
  g.globalCompositeOperation = "lighter";
  g.lineJoin = "round";
  g.lineCap = "round";
  const unit = Math.min(w, h);
  const cx = w * s.cx;
  const cy = h * (1 - s.cy);
  // Each frame only adds a little light: the feedback accumulates it, so a full-strength
  // wave every frame would burn the whole screen white within a second.
  const alpha = Math.max(0, Math.min(1, s.waveAlpha)) * 0.42;

  // A wide, faint pass under a thin, bright one reads as glow without canvas shadows, which
  // are slow in Safari and Firefox. The feedback softens it further.
  const stroke = (color, a1, width, path) => {
    g.beginPath();
    path();
    g.strokeStyle = css(color, a1 * alpha * 0.22);
    g.lineWidth = width * 4;
    g.stroke();
    g.strokeStyle = css(color, a1 * alpha);
    g.lineWidth = width;
    g.stroke();
  };

  const N = 192;
  const wv = (i) => a.wave[Math.floor((i / N) * (a.wave.length - 1))] || 0;

  switch (s.wave) {
    case "ring": {
      const R = unit * 0.17 * s.waveScale;
      // Three rings, outermost warm, innermost cool, each riding the waveform harder.
      [
        [s.waveA, 1.18, 0.5, 0.9],
        [s.waveA, 1.0, 0.38, 0.75],
        [s.waveB, 0.72, 0.28, 0.85],
      ].forEach(([color, scale, depth, op], layer) => {
        stroke(color, op, unit * 0.0035, () => {
          for (let i = 0; i <= N; i++) {
            // Ease the last stretch back to where it started, so the ring closes cleanly.
            const k = i / N;
            const f = Math.max(0, (k - 0.85) / 0.15);
            const v = wv(i) * (1 - f) + wv(0) * f;
            const r = R * scale + v * R * depth * (1 + layer * 0.2);
            const th = k * TAU + a.t * (0.2 - layer * 0.07);
            const x = cx + Math.cos(th) * r;
            const y = cy + Math.sin(th) * r;
            if (i) g.lineTo(x, y);
            else g.moveTo(x, y);
          }
          g.closePath();
        });
      });
      break;
    }
    case "spectrumRing": {
      // Mirrored, so the ring is symmetric: lows at the top and bottom, highs at the sides.
      const R = unit * 0.14 * s.waveScale;
      const bins = 96;
      const level = (i) => {
        const m = i < bins / 2 ? i : bins - 1 - i;
        return (
          a.spectrum[Math.floor(Math.pow(m / (bins / 2), 1.5) * a.spectrum.length * 0.5)] / 255
        );
      };
      for (const [color, parity] of [
        [s.waveA, 0],
        [s.waveB, 1],
      ]) {
        stroke(color, 0.7, unit * 0.004, () => {
          for (let i = parity; i < bins; i += 2) {
            const v = level(i);
            const th = (i / bins) * TAU + a.t * 0.15;
            g.moveTo(cx + Math.cos(th) * R, cy + Math.sin(th) * R);
            g.lineTo(cx + Math.cos(th) * (R + v * R * 1.4), cy + Math.sin(th) * (R + v * R * 1.4));
          }
        });
      }
      break;
    }
    case "scope": {
      const amp = h * 0.22 * s.waveScale;
      stroke(s.waveA, 0.9, unit * 0.004, () => {
        for (let i = 0; i <= N; i++) {
          const x = (i / N) * w;
          const y = cy + wv(i) * amp;
          if (i) g.lineTo(x, y);
          else g.moveTo(x, y);
        }
      });
      stroke(s.waveB, 0.5, unit * 0.002, () => {
        for (let i = 0; i <= N; i++) {
          const x = (i / N) * w;
          const y = cy - wv(N - i) * amp * 0.6;
          if (i) g.lineTo(x, y);
          else g.moveTo(x, y);
        }
      });
      break;
    }
    case "lissajous": {
      // The waveform against itself a quarter-cycle later: a figure that knots with the music.
      const R = unit * 0.28 * s.waveScale;
      const lag = Math.floor(a.wave.length / 7);
      stroke(s.waveA, 0.85, unit * 0.003, () => {
        for (let i = 0; i < a.wave.length - lag; i += 3) {
          const x = cx + a.wave[i] * R;
          const y = cy + a.wave[i + lag] * R;
          if (i) g.lineTo(x, y);
          else g.moveTo(x, y);
        }
      });
      break;
    }
    case "bars": {
      // Sodium lamps: spectrum bars hanging from the top, dripping down the warp.
      const bins = 48;
      const bw = w / bins;
      for (const [color, keep] of [
        [s.waveA, (i) => i % 3 !== 0],
        [s.waveB, (i) => i % 3 === 0],
      ]) {
        stroke(color, 0.3, bw * 0.16, () => {
          for (let i = 0; i < bins; i++) {
            if (!keep(i)) continue;
            const v =
              a.spectrum[Math.floor(Math.pow(i / bins, 1.7) * a.spectrum.length * 0.55)] / 255;
            g.moveTo(i * bw + bw / 2, 0);
            g.lineTo(i * bw + bw / 2, 2 + v * h * 0.12 * s.waveScale);
          }
        });
      }
      break;
    }
    case "spiral": {
      const turns = 3.5;
      const R = unit * 0.36 * s.waveScale;
      stroke(s.waveA, 0.85, unit * 0.003, () => {
        for (let i = 0; i <= N; i++) {
          const k = i / N;
          const th = k * TAU * turns + a.t * 0.4;
          const r = k * R * (1 + wv(i) * 0.35);
          const x = cx + Math.cos(th) * r;
          const y = cy + Math.sin(th) * r;
          if (i) g.lineTo(x, y);
          else g.moveTo(x, y);
        }
      });
      break;
    }
    case "dots": {
      const R = unit * 0.22 * s.waveScale;
      for (const [color, parity] of [
        [s.waveA, 2],
        [s.waveB, 0],
      ]) {
        g.fillStyle = css(color, 0.9 * alpha);
        g.beginPath();
        for (let i = parity; i < N; i += 4) {
          const th = (i / N) * TAU - a.t * 0.3;
          const r = R * (1 + wv(i) * 0.6);
          const x = cx + Math.cos(th) * r;
          const y = cy + Math.sin(th) * r;
          g.moveTo(x + unit * 0.004, y);
          g.arc(x, y, unit * 0.004, 0, TAU);
        }
        g.fill();
      }
      break;
    }
    default:
      break;
  }

  // Comets: bright heads orbiting the centre; the feedback draws their tails.
  for (let i = 0; i < s.comets; i++) {
    const color = i % 2 ? s.waveB : s.waveA;
    const speed = 0.35 + (i % 3) * 0.08;
    const th = (i / s.comets) * TAU + a.t * speed * (0.8 + 0.4 * a.bass_att);
    const r = unit * (0.3 + 0.07 * Math.sin(a.t * 0.6 + i * 1.7));
    const x = cx + Math.cos(th) * r;
    const y = cy + Math.sin(th) * r;
    const rad = unit * 0.01;
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    grad.addColorStop(0, css([1, 1, 1], Math.min(1, 2 * alpha)));
    grad.addColorStop(0.35, css(color, Math.min(1, 1.8 * alpha)));
    grad.addColorStop(1, css(color, 0));
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, rad, 0, TAU);
    g.fill();
  }
}
