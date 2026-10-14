/**
 * The MilkDrop loop in WebGL2. Every frame, the last frame is read back through a moving
 * warp (zoom, rotation, swirl, ripple, an optional kaleidoscope), dimmed by the decay, and
 * the new waves are added on top. Trails, tunnels and smoke all come out of that one loop.
 * A second pass puts it on screen with gamma, the echo, a little lens fringing and grain.
 *
 * The feedback lives in half-float textures where the GPU allows it, so slow decays fade
 * smoothly instead of banding into steps.
 */

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const WARP = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uPrev;
uniform sampler2D uWaves;
uniform float uZoom, uRot, uSwirl, uWarp, uWarpSpeed, uWarpScale, uDecay, uKaleido, uHue;
uniform float uTime, uAspect;
uniform vec2 uCenter, uShift;

vec2 rot(vec2 p, float a) {
  float c = cos(a), s = sin(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}
// Rotate a colour around the grey axis: a slow hue drift for presets that ask for it.
vec3 hueShift(vec3 c, float a) {
  const vec3 k = vec3(0.57735);
  float ca = cos(a);
  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec2 p = vUv - uCenter;
  p.x *= uAspect;
  float r = length(p);
  // Each pixel fetches from slightly nearer the centre, rotated: the image flows outward
  // and turns. Swirl turns the outside more than the middle.
  p = rot(p, uRot + uSwirl * r * 0.08);
  p /= uZoom;
  vec2 ripple = vec2(
    sin(p.y * uWarpScale * 9.0 + uTime * uWarpSpeed * 1.3) + sin(p.y * uWarpScale * 4.1 - uTime * uWarpSpeed * 0.7),
    cos(p.x * uWarpScale * 8.0 - uTime * uWarpSpeed * 1.1) + cos(p.x * uWarpScale * 3.3 + uTime * uWarpSpeed * 0.9)
  );
  p += ripple * uWarp * 0.0035;
  if (uKaleido > 0.5) {
    float seg = 6.2831853 / uKaleido;
    float a = mod(atan(p.y, p.x), seg);
    a = abs(a - seg * 0.5);
    p = vec2(cos(a), sin(a)) * length(p);
  }
  p.x /= uAspect;
  vec2 uv = p + uCenter - uShift;
  vec3 c = texture(uPrev, uv).rgb;
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  c = hueShift(c, uHue) * uDecay * inside;
  // A small constant fade on top of the multiply, so nothing lingers forever as a stain.
  c = max(c - 0.002, 0.0);
  c += texture(uWaves, vUv).rgb;
  c += (hash(vUv * 917.0 + uTime) - 0.5) / 512.0;
  o = vec4(c, 1.0);
}`;

const SHOW = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform float uGamma, uEcho, uEchoZoom, uTime, uAspect;
uniform vec3 uBg;
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}
vec3 fetch(vec2 uv) {
  // A hair of lens fringing: red and blue land slightly apart toward the edges.
  vec2 d = (uv - 0.5) * 0.006;
  return vec3(texture(uTex, uv + d).r, texture(uTex, uv).g, texture(uTex, uv - d).b);
}
void main() {
  vec3 c = fetch(vUv);
  if (uEcho > 0.0) {
    vec2 q = (vUv - 0.5) / uEchoZoom + 0.5;
    q.x = 1.0 - q.x;
    c = c + fetch(q) * uEcho * 0.6;
  }
  c *= uGamma;
  c = 1.0 - exp(-c * 0.95);
  vec2 v = (vUv - 0.5) * vec2(uAspect, 1.0);
  float vig = smoothstep(1.15, 0.25, length(v));
  vec3 bg = uBg * (0.55 + 0.45 * vig);
  c = bg + c * (1.0 - bg);
  c *= mix(0.55, 1.0, vig);
  c += (hash(vUv * 1311.0 + fract(uTime)) - 0.5) * 0.025;
  o = vec4(c, 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

function program(gl, fragSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fragSrc));
  gl.bindAttribLocation(p, 0, "aPos");
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(p, i).name;
    uniforms[name] = gl.getUniformLocation(p, name);
  }
  return { p, u: uniforms };
}

/**
 * @param {HTMLCanvasElement} canvas  the visible canvas
 * @returns {null | { resize(w, h): void, frame(params, waves, time): void }}
 */
export function createRenderer(canvas) {
  const gl = canvas.getContext("webgl2", {
    antialias: false,
    alpha: false,
    preserveDrawingBuffer: false,
  });
  if (!gl) return null;
  const halfFloat = Boolean(gl.getExtension("EXT_color_buffer_float"));
  const warp = program(gl, WARP);
  const show = program(gl, SHOW);

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const wavesTex = gl.createTexture();
  let targets = [];
  let w = 0;
  let h = 0;
  let read = 0;

  function texture(tex, width, height, data) {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (halfFloat) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, data);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    }
  }

  function resize(width, height) {
    if (width === w && height === h) return;
    w = width;
    h = height;
    for (const t of targets) {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fb);
    }
    targets = [0, 1].map(() => {
      const tex = gl.createTexture();
      texture(tex, w, h, null);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return { tex, fb };
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * @param {object} s  blended preset parameters
   * @param {HTMLCanvasElement | OffscreenCanvas} waves  this frame's waves, drawn at w x h
   */
  function frame(s, waves, time) {
    const src = targets[read];
    const dst = targets[1 - read];

    gl.bindTexture(gl.TEXTURE_2D, wavesTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    // Canvas rows run top down, GL textures bottom up.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, waves);

    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
    gl.viewport(0, 0, w, h);
    gl.useProgram(warp.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(warp.u.uPrev, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, wavesTex);
    gl.uniform1i(warp.u.uWaves, 1);
    gl.uniform1f(warp.u.uZoom, s.zoom);
    gl.uniform1f(warp.u.uRot, s.rot);
    gl.uniform1f(warp.u.uSwirl, s.swirl);
    gl.uniform1f(warp.u.uWarp, s.warp);
    gl.uniform1f(warp.u.uWarpSpeed, s.warpSpeed);
    gl.uniform1f(warp.u.uWarpScale, s.warpScale);
    gl.uniform1f(warp.u.uDecay, s.decay);
    gl.uniform1f(warp.u.uKaleido, s.kaleido);
    gl.uniform1f(warp.u.uHue, s.hue);
    gl.uniform1f(warp.u.uTime, time);
    gl.uniform1f(warp.u.uAspect, w / h);
    gl.uniform2f(warp.u.uCenter, s.cx, s.cy);
    gl.uniform2f(warp.u.uShift, s.dx, s.dy);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(show.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, dst.tex);
    gl.uniform1i(show.u.uTex, 0);
    gl.uniform1f(show.u.uGamma, s.gamma);
    gl.uniform1f(show.u.uEcho, s.echo);
    gl.uniform1f(show.u.uEchoZoom, s.echoZoom);
    gl.uniform1f(show.u.uTime, time);
    gl.uniform1f(show.u.uAspect, canvas.width / canvas.height);
    gl.uniform3f(show.u.uBg, s.bg[0], s.bg[1], s.bg[2]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    read = 1 - read;
  }

  return { resize, frame, halfFloat };
}
