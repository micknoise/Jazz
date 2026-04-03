# Converting a Jazz variation to A-Frame

This guide is for converting a Jazz variation (Three.js + Maximilian + engine.js)
into an A-Frame component. Read it before touching any code.

---

## The key rule: do not rewrite the Maximilian DSP

The audio in every Jazz variation runs on Maximilian, a C++ DSP library compiled
to WASM. The DSP code that drives it is already correct. **Do not rewrite it in
plain JavaScript.** The WASM runtime is faster, and the clock and oscillator
behaviour is different in subtle ways. The only safe path is to keep Maximilian
and wire it up the same way engine.js does.

---

## What actually changes between Three.js and A-Frame

Nothing about audio changes. You are only changing how the visual scene is set up
and updated.

| Three.js (engine.js)                         | A-Frame equivalent                           |
|----------------------------------------------|----------------------------------------------|
| `initJazzEngine({ ... })`                    | `<a-scene jazz-audio="..." jazz-trails="...">` |
| `sceneSetup(scene, camera, ss)` callback     | `AFRAME.registerComponent('jazz-xxx', {...})` |
| `update(fftArray, elapsed, dt)` callback     | component `tick(time, dtMs)`                 |
| `camera: { position, lookAt }`               | `<a-entity camera="userHeight:0" position="...">` |

Everything else — geometry creation, ShaderMaterial, uniforms — is identical
Three.js code moved into `init()` and `tick()`.

---

## HTML boilerplate

Load scripts in this exact order. **All four are required.**

```html
<script src="./enable-threads.js"></script>      <!-- SharedArrayBuffer polyfill via service worker -->
<script src="./maximilian.v.0.1.js"></script>    <!-- Maximilian WASM + initAudioEngine() -->
<script src="./aframe.min.js"></script>           <!-- A-Frame (must be local, CDN may be blocked) -->
<script src="./jazz-aframe.js"></script>          <!-- Jazz components -->
```

`enable-threads.js` registers a service worker that sets COOP/COEP headers.
Without it, SharedArrayBuffer is unavailable and Maximilian silently fails.
It must come first.

`maximilian.v.0.1.js` must come before `aframe.min.js` because it patches
`document.location` before A-Frame reads it.

Do **not** use a CDN URL for `aframe.min.js` — CDN requests may be blocked.
Get a local copy:

```bash
cd /tmp && npm pack aframe@1.5.0
tar xzf aframe-1.5.0.tgz package/dist/aframe-v1.5.0.min.js
cp package/dist/aframe-v1.5.0.min.js /path/to/project/aframe.min.js
```

---

## jazz-audio system — how to wire up Maximilian

Copy the `jazz-audio` system from `jazz-aframe.js` unchanged. It is a direct
port of the engine.js audio wiring. The key points:

**1. `initAudioEngine` takes a page-relative path, not an origin-relative one.**

```js
// CORRECT — works in subdirectories
initAudioEngine(new URL('./libs', document.location.href).href)

// WRONG — drops everything after the last slash
initAudioEngine(document.location.origin + '/libs')
```

**2. `buildDSPCode(p)` generates the Maximilian JS string. Copy it exactly from
engine.js.** Do not simplify or rewrite it. The `maxiClock`, `maxiOsc`, and
feedback logic are there for a reason.

**3. `maxi.play()` must be called synchronously inside a click handler** — not
in a Promise `.then()`, not in `setTimeout`. The browser only unlocks
`AudioContext` if `resume()` (which `play()` calls) happens in the same
synchronous call stack as the user gesture.

```js
playBtn.addEventListener('click', function() {
  if (!self._engineReady) return;
  if (!self._playing) {
    self._maxi.play();          // synchronous — inside the click handler
    self._playing = true;
  }
});
```

**4. Suspend the AudioContext after `initAudioEngine` resolves**, so it stays
silent until the user clicks play:

```js
initAudioEngine(libsPath).then(function(maxi) {
  self._maxi = maxi;
  maxi.setAudioCode(buildDSPCode(d));
  maxi.audioWorkletNode.context.suspend(); // start silent
  // ... rest of wiring
});
```

---

## FFT texture pipeline

The analyser output is written into a `THREE.DataTexture` and exposed as
`window.jazzFFTTexture` for components to read as a uniform:

```js
// Create — use RGBAFormat + Uint8Array (not RedFormat + Float, inconsistent WebGL2 support)
this._fftData   = new Uint8Array(FFT_BINS * 4);
this.fftTexture = new THREE.DataTexture(this._fftData, FFT_BINS, 1, THREE.RGBAFormat);
window.jazzFFTTexture = this.fftTexture;

// Update in tick() — normalise float frequency data into 0–255 bytes
analyser.getFloatFrequencyData(this._floatFreqData);
for (var i = 0; i < FFT_BINS; i++) {
  var norm = (this._floatFreqData[i] + 100) / 100; // –100..0 dBFS → 0..1
  var byte = Math.max(0, Math.min(255, norm * 255)) | 0;
  this._fftData[i * 4]     = byte;
  this._fftData[i * 4 + 1] = byte;
  this._fftData[i * 4 + 2] = byte;
  this._fftData[i * 4 + 3] = 255;
}
this.fftTexture.needsUpdate = true;
```

Components pick it up in `init()`:

```js
init: function() {
  var fftTex = window.jazzFFTTexture || fallbackTexture;
  // pass to ShaderMaterial uniform
}
```

---

## Writing a component

Components are per-entity. Systems are per-scene. Use a system for audio and
trail rendering; use a component for each visual object.

```js
AFRAME.registerComponent('jazz-sphere', {
  schema: {
    radius:    { default: 200 },
    segments:  { default: 22 },
    deform:    { default: 1000 },
    lineWidth: { default: 2.0 },
    fftUV:     { default: 0.0 }
  },

  init: function() {
    var d   = this.data;
    var geo = addBarycentricCoords(new THREE.SphereGeometry(d.radius, d.segments, d.segments));
    var mat = new THREE.ShaderMaterial({
      vertexShader:   JAZZ_VERT,
      fragmentShader: JAZZ_FRAG,
      uniforms: {
        uFFT:       { value: window.jazzFFTTexture },
        uDeform:    { value: d.deform },
        uTime:      { value: 0 },
        uLineWidth: { value: d.lineWidth },
        uColor:     { value: new THREE.Color(1, 1, 1) },
        uFFTUV:     { value: d.fftUV }
      },
      transparent: true,
      depthWrite:  false,
      side: THREE.DoubleSide
      // Do NOT set glslVersion — Three.js handles GLSL1→WebGL2 automatically
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.el.setObject3D('mesh', this.mesh);
  },

  tick: function(time, dtMs) {
    var dt = dtMs / 1000;
    this.mesh.material.uniforms.uTime.value = time / 1000;
    // drive rotation from window.jazzRMS (set by jazz-audio system)
    var speed = 0.05 + window.jazzRMS * 0.4;
    this.mesh.rotation.y += window.jazzRotDir[1] * speed * dt;
    this.mesh.rotation.x += window.jazzRotDir[0] * speed * 0.3 * dt;
  }
});
```

---

## Camera

Use `<a-entity>` with explicit component attributes. Do not use `<a-camera>` —
it adds a 1.6 m height offset that shifts the scene:

```html
<a-entity
  id="camera"
  camera="userHeight: 0; near: 1; far: 10000"
  position="0 0 500"
  look-controls="pointerLockEnabled: true; magicWindowTrackingEnabled: false"
  wasd-controls="acceleration: 500; fly: true"
></a-entity>
```

---

## Trail persistence

The trail effect requires `renderer.autoClear = false` and a black semi-transparent
quad rendered before A-Frame's main scene each frame. This is handled by the
`jazz-trails` system; do not reproduce it in a component.

The system must also clear `sceneEl.object3D.background = null` each tick to
prevent Three.js from force-clearing the canvas before the trail quad.

---

## GLSL shaders

Write shaders using GLSL 1 syntax (`attribute`, `varying`, `texture2D`,
`gl_FragColor`). Do not set `glslVersion: THREE.GLSL1` or
`glslVersion: THREE.GLSL3` — Three.js auto-converts GLSL 1 to WebGL2 syntax.
Setting `glslVersion` explicitly breaks the auto-conversion.

`fwidth()` works in WebGL2 without any extension declaration.

---

## Checklist before testing

- [ ] `enable-threads.js` is the first script tag
- [ ] `maximilian.v.0.1.js` comes before `aframe.min.js`
- [ ] `aframe.min.js` is a local file, not a CDN URL
- [ ] `initAudioEngine` uses `new URL('./libs', document.location.href).href`
- [ ] `maxi.play()` is called synchronously inside a click handler
- [ ] `maxi.audioWorkletNode.context.suspend()` is called after init resolves
- [ ] No custom `glslVersion` on ShaderMaterial
- [ ] FFT texture uses `THREE.RGBAFormat` + `Uint8Array`
- [ ] Camera entity uses `camera="userHeight: 0"`, not `<a-camera>`
