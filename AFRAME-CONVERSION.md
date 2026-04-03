# Converting Jazz Maximilian + Three.js to A-Frame Components

A guide for converting a Jazz variation (engine.js + Maximilian audio + Three.js visuals)
into a declarative A-Frame page with self-contained components.

---

## Project context

The Jazz project (`micknoise/Jazz`) has variations structured as:
- `engine.js` — shared Three.js renderer, trail effect, camera controls, audio wiring
- `vNN.html` — each variation calls `initJazzEngine({...})` with a `sceneSetup` callback
- Audio uses **Maximilian** (WASM via AudioWorklet + SharedArrayBuffer), which requires
  COOP/COEP headers and a service worker (`enable-threads.js`)
- Visuals use a custom **barycentric wireframe** ShaderMaterial with FFT-driven deformation

The goal is a version where the same experience is configured entirely through HTML attributes
on `<a-scene>` and `<a-entity>` tags, removing the JS-heavy `initJazzEngine` call.

---

## Environment constraints (critical)

### 1. Host A-Frame locally — do not use a CDN

External CDN requests are blocked in this environment. Download A-Frame via npm and commit it:

```bash
cd /tmp && npm pack aframe@1.5.0
tar xzf aframe-1.5.0.tgz package/dist/aframe-v1.5.0.min.js
cp package/dist/aframe-v1.5.0.min.js /path/to/repo/aframe.min.js
```

Then load it as `<script src="./aframe.min.js"></script>`.

### 2. A-Frame uses WebGL2 with Three.js r155 (bundled)

A-Frame's internal Three.js version differs from the standalone r160 used by engine.js.
The bundled Three.js uses WebGL2 by default. ShaderMaterial GLSL is auto-converted:
- `attribute` → `in`, `varying` → `in`/`out`, `texture2D` → `texture`, `gl_FragColor` → output alias
- Do NOT set `glslVersion` on ShaderMaterial — let Three.js handle this automatically
- `fwidth()` works without `OES_standard_derivatives` in WebGL2

### 3. DataTexture format

Use `THREE.RGBAFormat` with `Uint8Array` for FFT data textures:

```javascript
var data = new Uint8Array(FFT_BINS * 4);
var tex  = new THREE.DataTexture(data, FFT_BINS, 1, THREE.RGBAFormat);
```

Do NOT use `THREE.RedFormat + THREE.FloatType` — this has inconsistent support across
WebGL2 implementations and will silently produce a broken texture.

The shader reads `.r` channel (0.0–1.0 normalized from 0–255). When writing FFT data:
```javascript
data[k * 4]     = Math.min(255, Math.floor(value * 255)); // R
data[k * 4 + 3] = 255; // A must be 255 or texture is invalid
tex.needsUpdate  = true;
```

---

## Audio: keep Maximilian if you can

**Do not rewrite Maximilian DSP in JS unless you have a specific reason.**

Maximilian runs in WASM compiled from C++. Its oscillators use lookup tables rather than
`Math.sin()`, and the entire DSP loop avoids GC pressure and JS JIT unpredictability.
A JS reimplementation is not faster and introduces subtle differences (e.g. exact sample
timing of clock ticks). `maxiClock` in particular is so simple (a counter comparison)
that a JS rewrite is pure downside — more code, same behaviour, less tested.

### When Maximilian DOES need replacing

Only replace it if the **loading mechanism** is broken, not the DSP itself. Known loading
problems in this project and their fixes:

1. **Livereload script injected into `libs/index.mjs`** — GitHub Pages dev server appended
   a livereload line at the top of the file. Fix: `sed -i '1d' libs/index.mjs` (may need
   to run twice if it left a blank line).

2. **Wrong URL for libs path** — `document.location.origin + '/libs'` gives the server
   root, not the page-relative path. Fix:
   ```javascript
   initAudioEngine(new URL('./libs', document.location.href).href)
   ```

3. **COOP/COEP headers required for SharedArrayBuffer** — Maximilian uses SharedArrayBuffer
   for the WASM memory. The `enable-threads.js` service worker adds the required headers.
   This works on GitHub Pages. If you are in an environment where service workers are
   unavailable and you cannot set server headers, then replacing Maximilian becomes necessary.

### If you must replace Maximilian: native AudioWorklet

Only in the case where Maximilian cannot load (e.g. no service worker support, no ability
to set COOP/COEP headers), replace it with a pure JS AudioWorklet loaded via Blob URL.

The Maximilian DSP concepts map directly to JS equivalents — note that `maxiClock` is
already just a counter, so the translation is exact:

| Maximilian | JS AudioWorklet equivalent |
|---|---|
| `maxiOsc.sinewave(freq)` | Phase accumulator: `out = sin(phase); phase += 2π * freq / sampleRate` |
| `maxiClock.setTempo(bpm)` | Period in samples: `period = sampleRate * 60 / bpm` |
| `maxiClock.setTicksPerBeat(n)` | Fast clock period: `period = sampleRate * 60 / (bpm * n)` |
| `maxiClock.ticker()` | Increment counter each sample, fire when counter ≥ period |
| `maxiClock.tick` | Boolean: true for ONE sample when clock fires |
| `paramsIn.getValue()` | `this.port.onmessage` receiving `{ type: 'params', value: [...] }` |

### The FM synthesis pattern from engine.js

The `buildDSPCode()` function in engine.js generates this Maximilian DSP loop:

```javascript
// Two clocks:
//   d = slow (one tick per beat at `tempo` BPM)
//   c = fast (multiple ticks per beat, subdivision randomised on each slow event)
c.ticker(); d.ticker();

// Slow event: reset envelopes, set modulator to slow mode
if (d.tick && Math.random() > sparsity_1) {
  c.setTicksPerBeat(Math.floor(1 + Math.random() * maxTicksPerBeat));
  _a = 1.0; _b = 1.0;
  _bFeedback = Math.random() > positiveFeedbackThreshold
    ? positiveFeedbackValue   // amplitude grows
    : decayFeedbackValue;     // amplitude decays
  _freq2 = slowFreq2; _modI = slowModI;
}

// Fast event: randomise carrier freq, feedback, modulator
if (c.tick && Math.random() > sparsity_2 && !d.tick) {
  _freq      = fastFreqBase + Math.random() * fastFreqRange;
  _a = 1.0; _b = 1.0;
  _feedback  = fastFeedbackBase + Math.random() * fastFeedbackRange;
  _bFeedback = fastFeedbackBase + Math.random() * fastFeedbackRange;
  _freq2     = Math.random() * fastFreq2Range;
  _modI      = Math.random() * fastModIRange;
}

// Per-sample envelope decay
_a *= _feedback; _b *= _bFeedback;

// FM synthesis: carrier frequency modulated by modulator output * modulation index
// Maximilian's sinewave(freq) = returns sin(phase), THEN increments phase
// Replicate this exactly with phase accumulators:
var modOut = sin(ph2); ph2 += 2π * _freq2 / sampleRate;
var carOut = sin(ph1); ph1 += 2π * (_freq * _b + modOut * _modI) / sampleRate;
output = carOut * _a;
```

### Native AudioWorklet template

```javascript
var FM_WORKLET_SRC = `
class JazzFMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    var p = options.processorOptions || {};
    var sr = sampleRate;
    var tempo = p.tempo || 90;
    var tpb   = p.ticksPerBeat || 4;

    // Clock state
    this._cCounter = 0; this._cPeriod = sr * 60 / (tempo * tpb); this._cTick = false;
    this._dCounter = 0; this._dPeriod = sr * 60 / tempo;          this._dTick = false;
    this._tempo = tempo;

    // Audio state (initial values from processorOptions)
    this._a = p.initialA || 0.5;           this._b = p.initialB || 0.5;
    this._feedback  = p.initialFeedback  || 0.9999;
    this._bFeedback = p.initialBFeedback || 0.9999;
    this._freq  = p.initialFreq  || 350;  this._freq2 = p.initialFreq2 || 50;
    this._modI  = p.initialModI  || 650;
    this._ph1 = 0; this._ph2 = 0;

    // Realtime params (matching REALTIME_KEYS order from engine.js)
    this._sp1 = p.sparsity_1 || 0.4;  this._sp2 = p.sparsity_2 || 0.5;
    this._maxTPB = p.maxTicksPerBeat || 8;
    this._sf2 = p.slowFreq2 || 100;   this._smi = p.slowModI || 1;
    this._pfThr = p.positiveFeedbackThreshold || 0.75;
    this._pfVal = p.positiveFeedbackValue || 1.00001;
    this._dfVal = p.decayFeedbackValue || 0.999;
    this._ffBase = p.fastFreqBase || 250;    this._ffRng = p.fastFreqRange || 350;
    this._fbBase = p.fastFeedbackBase || 0.999; this._fbRng = p.fastFeedbackRange || 0.001;
    this._f2Rng = p.fastFreq2Range || 300;   this._miRng = p.fastModIRange || 10000;

    var self = this;
    this.port.onmessage = function(e) {
      if (e.data.type !== 'params') return;
      var a = e.data.value;  // array in REALTIME_KEYS order
      self._sp1=a[0]; self._sp2=a[1]; self._maxTPB=a[2];
      self._sf2=a[3]; self._smi=a[4];
      self._pfThr=a[5]; self._pfVal=a[6]; self._dfVal=a[7];
      self._ffBase=a[8]; self._ffRng=a[9];
      self._fbBase=a[10]; self._fbRng=a[11];
      self._f2Rng=a[12]; self._miRng=a[13];
    };
  }

  process(inputs, outputs) {
    var out = outputs[0] && outputs[0][0];
    if (!out) return true;
    var sr = sampleRate, PI2 = 6.283185307179586;
    for (var i = 0; i < out.length; i++) {
      // Tick clocks
      if (++this._cCounter >= this._cPeriod) { this._cCounter=0; this._cTick=true; }
      else this._cTick = false;
      if (++this._dCounter >= this._dPeriod) { this._dCounter=0; this._dTick=true; }
      else this._dTick = false;

      // Slow event
      if (this._dTick && Math.random() > this._sp1) {
        this._cPeriod = sr * 60 / (this._tempo * Math.floor(1 + Math.random() * this._maxTPB));
        this._a = 1; this._b = 1;
        this._bFeedback = Math.random() > this._pfThr ? this._pfVal : this._dfVal;
        this._freq2 = this._sf2; this._modI = this._smi;
      }
      // Fast event
      if (this._cTick && Math.random() > this._sp2 && !this._dTick) {
        this._freq = this._ffBase + Math.random() * this._ffRng;
        this._a = 1; this._b = 1;
        this._feedback  = this._fbBase + Math.random() * this._fbRng;
        this._bFeedback = this._fbBase + Math.random() * this._fbRng;
        this._freq2 = Math.random() * this._f2Rng;
        this._modI  = Math.random() * this._miRng;
      }
      this._a *= this._feedback; this._b *= this._bFeedback;

      // FM: phase accumulator pattern matching Maximilian sinewave()
      var modOut = Math.sin(this._ph2); this._ph2 += PI2 * this._freq2 / sr;
      var carOut = Math.sin(this._ph1); this._ph1 += PI2 * (this._freq * this._b + modOut * this._modI) / sr;
      out[i] = carOut * this._a;
    }
    return true;
  }
}
registerProcessor('jazz-fm', JazzFMProcessor);
`;
```

Load it via Blob URL in the play button click handler (MUST be inside a user gesture):

```javascript
playBtn.addEventListener('click', function() {
  var ctx = new AudioContext();
  var blob = new Blob([FM_WORKLET_SRC], { type: 'application/javascript' });
  ctx.audioWorklet.addModule(URL.createObjectURL(blob)).then(function() {
    var node = new AudioWorkletNode(ctx, 'jazz-fm', {
      outputChannelCount: [1],
      processorOptions: { tempo: 75, sparsity_1: 0.6, /* ... */ }
    });
    node.connect(ctx.destination);
    ctx.resume();
  });
});
```

**Critical**: Do NOT create `AudioContext` outside a user gesture (e.g. in system `init()`).
Doing so causes silent failures in many browsers and can prevent subsequent code from running.

---

## A-Frame component structure

### Registering systems vs components

- **Systems** (`AFRAME.registerSystem`) are scene-level singletons. Put audio and trails here.
  Configured via matching attribute on `<a-scene jazz-audio="tempo: 75; ...">`.
- **Components** (`AFRAME.registerComponent`) are per-entity. Put geometry/mesh here.
  Configured via attribute on `<a-entity jazz-sphere="radius: 200; ...">`.

Both have `init()` (runs once) and `tick(time, dtMs)` (runs every frame before render).

### Trail persistence effect

```javascript
AFRAME.registerSystem('jazz-trails', {
  schema: { opacity: { default: 0.08 } },
  init: function() {
    var self = this;
    // Wait for renderstart — renderer is guaranteed ready then
    this.el.addEventListener('renderstart', function() {
      self.el.renderer.autoClear = false; // preserve colour buffer between frames
      var scene = new THREE.Scene();
      self._mat = new THREE.MeshBasicMaterial({
        color: 0x000000, transparent: true, opacity: self.data.opacity,
        depthTest: false, depthWrite: false
      });
      scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), self._mat));
      self._fadeScene  = scene;
      self._fadeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      self._ready = true;
    });
  },
  tick: function() {
    // tick() runs BEFORE A-Frame renders — correct place to inject pre-render pass
    if (!this._ready) return;
    this.el.object3D.background = null; // prevent Three.js force-clear if background was set
    this.el.renderer.clearDepth();
    this.el.renderer.render(this._fadeScene, this._fadeCamera);
  }
});
```

### Barycentric wireframe sphere

The same GLSL from engine.js works unchanged. Key ShaderMaterial settings:

```javascript
var mat = new THREE.ShaderMaterial({
  vertexShader:   JAZZ_VERT,   // same string as in engine.js
  fragmentShader: JAZZ_FRAG,   // same string as in engine.js
  uniforms: { uFFT: {value: tex}, uDeform: {value: 1000}, uTime: {value: 0},
              uLineWidth: {value: 2}, uColor: {value: new THREE.Color(1,1,1)}, uFFTUV: {value: 0} },
  transparent: true,
  depthWrite:  false,
  side:        THREE.DoubleSide   // needed if camera could be inside the geometry
  // DO NOT set glslVersion — A-Frame's Three.js auto-converts GLSL1 → GLSL3
});
```

Add the mesh to the entity's scene graph:
```javascript
this.el.setObject3D('mesh', new THREE.Mesh(geo, mat));
```

### Camera setup

Use `<a-entity>` with explicit `camera` component rather than `<a-camera>` primitive,
and set `userHeight: 0` to disable A-Frame's automatic 1.6m height offset:

```html
<a-entity camera="userHeight: 0; near: 1; far: 10000"
          position="0 0 500"
          look-controls="pointerLockEnabled: true"
          wasd-controls="acceleration: 500; fly: true"></a-entity>
```

### Renderer settings

Set on the `<a-scene>` element. `preserveDrawingBuffer: true` is required for trail effect:

```html
<a-scene renderer="preserveDrawingBuffer: true; antialias: false" ...>
```

---

## Full HTML structure

```html
<!DOCTYPE html>
<html>
<head>
  <script src="./aframe.min.js"></script>   <!-- local copy — CDN may be blocked -->
  <script src="./jazz-aframe.js"></script>  <!-- registers systems + components -->
</head>
<body>
  <!-- UI overlaid on canvas -->
  <div id="ui" style="position:absolute;top:16px;left:16px;z-index:10">
    <button id="playButton">play</button>
    <button id="resetButton">reset</button>
  </div>

  <a-scene
    renderer="preserveDrawingBuffer: true; antialias: false"
    jazz-trails="opacity: 0.08"
    jazz-audio="tempo: 75; sparsity_1: 0.6; sparsity_2: 0.7;
                fastModIRange: 15000; positiveFeedbackValue: 1.000005;
                decayFeedbackValue: 0.9995"
    vr-mode-ui="enabled: false">

    <a-entity jazz-sphere="radius: 200; segments: 22; deform: 1000;
                            lineWidth: 2; fftUV: 0"></a-entity>

    <a-entity camera="userHeight: 0; near: 1; far: 10000"
              position="0 0 500"
              look-controls="pointerLockEnabled: true"
              wasd-controls="acceleration: 500; fly: true"></a-entity>
  </a-scene>
</body>
</html>
```

---

## Checklist

- [ ] `aframe.min.js` committed to repo (not loaded from CDN)
- [ ] `AudioContext` created only inside a play button click handler
- [ ] DataTexture uses `THREE.RGBAFormat` + `Uint8Array`, alpha channel set to 255
- [ ] No `glslVersion` on ShaderMaterial
- [ ] `side: THREE.DoubleSide` on ShaderMaterial
- [ ] `jazz-trails` system sets `renderer.autoClear = false` inside `renderstart` listener
- [ ] Camera uses `<a-entity camera="userHeight: 0">` not `<a-camera>`
- [ ] No inline `<script>` that runs at parse time and queries uninitialized A-Frame elements
- [ ] Add `<a-sphere color="red">` as a diagnostic when debugging — if it doesn't appear,
      A-Frame itself isn't rendering (check browser console for errors)
