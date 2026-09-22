/**
 * EKO's segmented LED spectrum, ported from the native player's Spectrum component so the
 * web demos read as the same instrument rather than a generic bar graph.
 *
 * Short, wide, flat segments with no glow, a faint unlit grid behind them, and white
 * peak-hold caps that fall away: the classic digital-amp display. It settles quietly to
 * rest when nothing is playing rather than snapping to empty.
 *
 * The native player is fed pre-computed bands by its Rust FFT. Here the source is the
 * engine's own AnalyserNode, so the linear FFT bins have to be folded into bands first,
 * on a logarithmic scale. Linear bins would put almost everything in the first tenth of
 * the display, which is why a naive analyser spectrum always looks bass-heavy and dead
 * across the top.
 */

const FRAME_MS = 1000 / 30; // Uncapped repaints are a real cost on older integrated GPUs.

/**
 * @param canvas    the <canvas> to draw into
 * @param getAnalyser  () => AnalyserNode | null, called per frame: the engine builds its
 *                     graph lazily, so there is nothing to read until playback has started
 * @returns a stop function
 */
export function attachSpectrum(canvas, getAnalyser, { bands = 36, bargap = 2 } = {}) {
  const ctx = canvas.getContext("2d");
  // Theme-aware monochrome: ink on light, white on dark. The stylesheet owns both values.
  const specRgb = () => getComputedStyle(canvas).getPropertyValue("--spec").trim() || "64,59,52";

  const lvl = new Float32Array(bands);
  const peak = new Float32Array(bands);
  let bins = null;
  let raf = 0;
  let last = 0;

  const resize = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  /** Fold the analyser's linear bins into `bands` logarithmic buckets, 20 Hz to 16 kHz. */
  const readBands = (analyser, out) => {
    if (!bins || bins.length !== analyser.frequencyBinCount) {
      bins = new Uint8Array(analyser.frequencyBinCount);
    }
    analyser.getByteFrequencyData(bins);
    const nyquist = analyser.context.sampleRate / 2;
    const hzPerBin = nyquist / bins.length;
    const lo = 20;
    const hi = Math.min(16000, nyquist);
    for (let b = 0; b < out.length; b++) {
      const f0 = lo * Math.pow(hi / lo, b / out.length);
      const f1 = lo * Math.pow(hi / lo, (b + 1) / out.length);
      const i0 = Math.max(0, Math.floor(f0 / hzPerBin));
      const i1 = Math.max(i0 + 1, Math.ceil(f1 / hzPerBin));
      let peakBin = 0;
      for (let i = i0; i < i1 && i < bins.length; i++) {
        if (bins[i] > peakBin) peakBin = bins[i];
      }
      out[b] = peakBin / 255;
    }
  };

  const incoming = new Float32Array(bands);

  const draw = (now) => {
    // Reschedule FIRST, so one throwing frame can never kill the loop.
    raf = requestAnimationFrame(draw);
    if (now - last < FRAME_MS) return;
    last = now;

    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);

    let analyser = null;
    try {
      analyser = getAnalyser();
    } catch {
      analyser = null; // No graph yet: draw the unlit grid, same as being idle.
    }

    if (analyser) {
      readBands(analyser, incoming);
      for (let b = 0; b < bands; b++) {
        const v = incoming[b];
        lvl[b] = v > lvl[b] ? v : lvl[b] * 0.82 + v * 0.18; // fast attack, smooth release
      }
    } else {
      for (let b = 0; b < bands; b++) lvl[b] *= 0.9;
    }

    // Padding scales with size, so the same code serves a wide deck and a small embed.
    const padX = Math.max(3, Math.min(12, w * 0.04));
    const padY = Math.max(2, Math.min(11, h * 0.1));
    const innerW = w - padX * 2;
    const innerH = h - padY * 2;
    const bandW = (innerW - bargap * (bands - 1)) / bands;
    // Segment count comes from the height at a fixed pitch, so each segment stays thin
    // however tall the display is.
    const segs = Math.max(4, Math.round(innerH / 5));
    const vgap = innerH < 60 ? 0.7 : 1;
    const segH = (innerH - vgap * (segs - 1)) / segs;
    const rad = Math.min(1.6, segH / 2);
    const rgb = specRgb();

    for (let b = 0; b < bands; b++) {
      const x = padX + b * (bandW + bargap);
      const litCount = Math.round(lvl[b] * segs);
      if (lvl[b] >= peak[b]) peak[b] = lvl[b];
      else peak[b] = Math.max(lvl[b], peak[b] - 0.012);
      const pkRow = Math.min(segs - 1, Math.round(peak[b] * segs));

      for (let s = 0; s < segs; s++) {
        const y = padY + innerH - (s + 1) * segH - s * vgap;
        const f = (s + 1) / segs;
        if (s === pkRow && peak[b] > 0.02) ctx.fillStyle = `rgba(${rgb},0.9)`;
        else if (s < litCount) ctx.fillStyle = `rgba(${rgb},${(0.24 + 0.5 * f).toFixed(3)})`;
        else ctx.fillStyle = `rgba(${rgb},0.07)`;
        ctx.beginPath();
        ctx.roundRect(x, y, bandW, segH, rad);
        ctx.fill();
      }
    }
  };

  raf = requestAnimationFrame(draw);
  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
  };
}
