# maxi-components.js — Implementation Plan

## Concept

Declarative A-Frame DSP patching. Each entity is a Maximilian node. `#selector`
references pipe outputs between nodes. `maxi-patch` system compiles the entity
graph into a DSP code string and passes it to `maxi.setAudioCode()`.

## HTML usage example

```html
<a-scene maxi-patch="output: #out">

  <a-entity id="clock" maxi-clock="tempo: 120; ticksPerBeat: 4"></a-entity>
  <a-entity id="lfo"   maxi-osc="type: sinewave; freq: 2; scale: 200; offset: 440"></a-entity>
  <a-entity id="osc"   maxi-osc="type: sinewave; freq: #lfo"></a-entity>
  <a-entity id="filt"  maxi-filter="type: lores; input: #osc; cutoff: 800; resonance: 0.5"></a-entity>
  <a-entity id="env"   maxi-env="type: adsr; input: #filt; trigger: #clock; attack: 10; decay: 100; sustain: 0.8; release: 300"></a-entity>
  <a-entity id="out"   maxi-gain="input: #env; gain: 0.7"></a-entity>

</a-scene>
```

## Compiled DSP output (what maxi-patch generates)

```js
var __clock = new Maximilian.maxiClock();
var __lfo   = new Maximilian.maxiOsc();
var __osc   = new Maximilian.maxiOsc();
var __filt  = new Maximilian.maxiFilter();
var __env   = new Maximilian.maxiEnv();
// maxi-gain has no object

__clock.setTempo(120);
__clock.setTicksPerBeat(4);

function play() {
  __clock.ticker(); var __clock_o = __clock.tick ? 1.0 : 0.0;
  var __lfo_o  = __lfo.sinewave(2) * 200 + 440;
  var __osc_o  = __osc.sinewave(__lfo_o);
  var __filt_o = __filt.lores(__osc_o, 800, 0.5);
  var __env_o  = __env.adsr(__filt_o, 10, 100, 0.8, 300, 4096, __clock_o);
  var __out_o  = __env_o * 0.7;
  return __out_o;
}
```

## maxi-patch system (on `<a-scene>`)

- Loads Maximilian via `initAudioEngine(new URL('./libs', document.location.href).href)`
- Suspends AudioContext after init; `maxi.play()` called synchronously in click handler
- Discovers all registered maxi-* components
- Topological sorts by dependency (resolves `#selector` refs)
- Generates + calls `maxi.setAudioCode(compiledString)`
- Recompiles (debounced 100ms) when any component attribute changes
- Sets up FFT analyser → `window.jazzFFTTexture` (compatible with jazz-sphere/jazz-trails)
- Updates FFT texture in `tick()`

Schema: `output` (CSS selector for output node), `libsPath` (override libs URL)

## Components

Each component must have an `id` on its entity. Every numeric param can be a
literal or a `#selector` reference to another node's output.

### maxi-osc — maxiOsc
- `type`: sinewave | coswave | phasor | square | pulse | saw | sawn | triangle | noise | impulse
- `freq`: number or #ref
- `duty`: number (pulse only)
- `scale`: multiply output (default 1) — use for LFOs: `scale: 200; offset: 440`
- `offset`: add to output (default 0)

### maxi-clock — maxiClock
- `tempo`: BPM
- `ticksPerBeat`: subdivisions
- Output: 1.0 on tick, 0.0 otherwise

### maxi-filter — maxiFilter
- `type`: lores | hires | lopass | hipass | bandpass
- `input`, `cutoff`, `resonance`: number or #ref

### maxi-biquad — maxiBiquad
- `type`: LOWPASS | HIGHPASS | BANDPASS | NOTCH | PEAK | LOWSHELF | HIGHSHELF
- `input`, `freq`, `Q`, `gain`: number or #ref
- Note: coefficients recomputed each sample if freq/Q are #refs (expensive)

### maxi-svf — maxiSVF (state variable filter, blended outputs)
- `input`, `cutoff`, `resonance`: number or #ref
- `lp`, `hp`, `bp`, `notch`: blend amounts (default: lp=1, rest=0)
- If cutoff/resonance are #refs, setCutoff/setResonance called each sample

### maxi-env — maxiEnv
- `type`: ar | adsr
- `input`, `trigger`: number or #ref (trigger: 1=on, 0=off)
- `attack`, `decay`, `release`: ms
- `sustain`: level 0-1
- `holdtime`: samples (default 4096)

### maxi-delay — maxiDelayline
- `input`, `feedback`: number or #ref
- `delay`: samples (number or #ref)

### maxi-gain — (arithmetic, no Maximilian object)
- `input`, `gain`: number or #ref
- Emits: `input * gain`

### maxi-add — (arithmetic, no Maximilian object)
- `a`, `b`: number or #ref
- `mix`: 0=a only, 1=b only, 0.5=equal (number or #ref)
- Emits: `a * (1 - mix) + b * mix`

### maxi-distortion — maxiNonlinearity
- `type`: atanDist | fastAtanDist | softclip | hardclip | asymclip | fastatan
- `input`, `amount`: number or #ref
- `asymmetry`, `hardness`: number (asymclip only)

### maxi-lag — maxiLagExp (exponential smoothing)
- `input`: number or #ref
- `time`: smoothing coefficient 0-1

### maxi-map — maxiMap (static methods)
- `type`: linlin | linexp | explin | clamp
- `input`: number or #ref
- `inMin`, `inMax`, `outMin`, `outMax`: numbers

### maxi-convert — maxiConvert (static methods)
- `type`: mtof | msToSamps | sampsToMs | ampToDbs | dbsToAmp
- `input`: number or #ref (e.g. MIDI note → frequency)

### maxi-dyn — maxiDyn (dynamics)
- `type`: compressor | gate
- `input`: number or #ref
- `threshold`, `ratio`, `attack`, `release`: numbers
- `holdtime`: samples (gate only)

### maxi-chorus — maxiChorus
- `input`: number or #ref
- `delayLength`, `lfoSpeed`, `lfoDepth`, `mix`: numbers

### maxi-flanger — maxiFlanger
- `input`: number or #ref
- `delayLength`, `lfoSpeed`, `lfoDepth`, `mix`: numbers

### maxi-step — maxiStep (step sequencer)
- `trigger`: number or #ref (clock output)
- `values`: space-separated list e.g. `"440 550 660 880"`
- `probability`: 0-1

### maxi-sample — maxiSample (deferred to v2)
- Sample loading is async and uses a separate main-thread API (`maxi.addSample`)
- Skip for v1; implement once the rest is stable

## Code generation rules

- Variable name for object: `__<id>` (non-alphanumeric chars → `_`)
- Variable name for output: `__<id>_o`
- `#selector` in a param → resolved to `__<refId>_o` in generated code
- Topological sort ensures dependencies are evaluated before dependents
- `_genDecls()` → variable declarations (outside play, run once)
- `_genSetup()` → one-time setup calls (setTempo, etc.)
- `_genPlay()` → one or more statements inside play() per sample
- Components with no Maximilian object (maxi-gain, maxi-add, maxi-map, maxi-convert) return null from _genDecls()

## File structure

```
maxi-components.js
  ├── _nodes[]           global registry
  ├── _patch             reference to maxi-patch system
  ├── registerNode(c)    called from each component init()
  ├── unregisterNode(c)  called from each component remove()
  ├── nv(id)             __id   (object var name)
  ├── no(id)             __id_o (output var name)
  ├── rp(val)            resolve param: #ref → no(id), else literal
  ├── isRef(val)         true if val starts with #
  ├── topoSort(nodes)    depth-first topo sort using _getDeps()
  ├── makeComp(def)      base mixin: init/update/remove + _genSetup stub
  └── AFRAME.registerSystem('maxi-patch', ...)
      AFRAME.registerComponent('maxi-osc', ...)
      AFRAME.registerComponent('maxi-clock', ...)
      ... etc
```

## HTML boilerplate (same as AFRAME-CONVERSION.md)

```html
<script src="./enable-threads.js"></script>
<script src="./maximilian.v.0.1.js"></script>
<script src="./aframe.min.js"></script>
<script src="./maxi-components.js"></script>
```

Do NOT load jazz-aframe.js alongside maxi-components.js — they both register
jazz-audio and will conflict. maxi-components.js replaces jazz-aframe.js for
patch-based variations.
