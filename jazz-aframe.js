// jazz-aframe.js — A-Frame component library for Jazz audio-visual variations
// Provides: jazz-audio system, jazz-trails system, jazz-sphere component
(function () {
  'use strict';

  // ── Barycentric wireframe helper ─────────────────────────────────────────────
  function addBarycentricCoords(geometry) {
    var g = geometry.toNonIndexed();
    var count = g.attributes.position.count;
    var bary = new Float32Array(count * 3);
    for (var i = 0; i < count; i += 3) {
      bary[i * 3]         = 1; bary[i * 3 + 1]     = 0; bary[i * 3 + 2]     = 0;
      bary[(i+1) * 3]     = 0; bary[(i+1) * 3 + 1] = 1; bary[(i+1) * 3 + 2] = 0;
      bary[(i+2) * 3]     = 0; bary[(i+2) * 3 + 1] = 0; bary[(i+2) * 3 + 2] = 1;
    }
    g.setAttribute('barycentric', new THREE.BufferAttribute(bary, 3));
    return g;
  }

  // ── Shared GLSL shaders ──────────────────────────────────────────────────────
  var JAZZ_VERT = [
    'attribute vec3 barycentric;',
    'varying vec3 vBary;',
    'uniform sampler2D uFFT;',
    'uniform float uDeform;',
    'uniform float uTime;',
    'uniform float uFFTUV;',
    'void main() {',
    '  vBary = barycentric;',
    '  float uvCoord = mix(uv.x, uv.y, uFFTUV);',
    '  float mag = clamp(texture2D(uFFT, vec2(uvCoord, 0.5)).r, 0.0, 20.0);',
    '  vec3 displaced = position + normal * mag * uDeform;',
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);',
    '}'
  ].join('\n');

  var JAZZ_FRAG = [
    'varying vec3 vBary;',
    'uniform float uLineWidth;',
    'uniform vec3  uColor;',
    'void main() {',
    '  vec3 d  = fwidth(vBary);',
    '  vec3 a3 = smoothstep(vec3(0.0), d * uLineWidth, vBary);',
    '  float edge  = min(min(a3.x, a3.y), a3.z);',
    '  float alpha = 1.0 - edge;',
    '  if (alpha < 0.01) discard;',
    '  gl_FragColor = vec4(uColor, alpha);',
    '}'
  ].join('\n');

  // ── FM AudioWorklet source (stored as string for Blob URL loading) ───────────
  // Two clocks (c=fast subdivisions, d=slow beat), FM synthesis with phase
  // accumulators. Mirrors the Maximilian DSP logic from engine.js.
  var FM_WORKLET_SRC = [
    'class JazzFMProcessor extends AudioWorkletProcessor {',
    '  constructor(options) {',
    '    super();',
    '    var p = (options && options.processorOptions) ? options.processorOptions : {};',
    '    var sr = sampleRate;',
    '    var tempo        = p.tempo        || 90;',
    '    var ticksPerBeat = p.ticksPerBeat || 4;',
    '    // Clock C: fast subdivisions',
    '    this._cCounter = 0;',
    '    this._cPeriod  = sr * 60 / (tempo * ticksPerBeat);',
    '    this._cTick    = false;',
    '    // Clock D: one tick per beat',
    '    this._dCounter = 0;',
    '    this._dPeriod  = sr * 60 / tempo;',
    '    this._dTick    = false;',
    '    this._tempo    = tempo;',
    '    // Audio state',
    '    this._a         = p.initialA        !== undefined ? p.initialA        : 0.5;',
    '    this._b         = p.initialB        !== undefined ? p.initialB        : 0.5;',
    '    this._feedback  = p.initialFeedback  !== undefined ? p.initialFeedback  : 0.9999;',
    '    this._bFeedback = p.initialBFeedback !== undefined ? p.initialBFeedback : 0.9999;',
    '    this._freq      = p.initialFreq      !== undefined ? p.initialFreq      : 350;',
    '    this._freq2     = p.initialFreq2     !== undefined ? p.initialFreq2     : 50;',
    '    this._modI      = p.initialModI      !== undefined ? p.initialModI      : 650;',
    '    this._ph1 = 0;',
    '    this._ph2 = 0;',
    '    // Realtime-updatable params (mirror REALTIME_KEYS order in engine.js)',
    '    this._sp1    = p.sparsity_1                !== undefined ? p.sparsity_1                : 0.4;',
    '    this._sp2    = p.sparsity_2                !== undefined ? p.sparsity_2                : 0.5;',
    '    this._maxTPB = p.maxTicksPerBeat           !== undefined ? p.maxTicksPerBeat           : 8;',
    '    this._sf2    = p.slowFreq2                 !== undefined ? p.slowFreq2                 : 100;',
    '    this._smi    = p.slowModI                  !== undefined ? p.slowModI                  : 1;',
    '    this._pfThr  = p.positiveFeedbackThreshold !== undefined ? p.positiveFeedbackThreshold : 0.75;',
    '    this._pfVal  = p.positiveFeedbackValue     !== undefined ? p.positiveFeedbackValue     : 1.00001;',
    '    this._dfVal  = p.decayFeedbackValue        !== undefined ? p.decayFeedbackValue        : 0.999;',
    '    this._ffBase = p.fastFreqBase              !== undefined ? p.fastFreqBase              : 250;',
    '    this._ffRng  = p.fastFreqRange             !== undefined ? p.fastFreqRange             : 350;',
    '    this._fbBase = p.fastFeedbackBase          !== undefined ? p.fastFeedbackBase          : 0.999;',
    '    this._fbRng  = p.fastFeedbackRange         !== undefined ? p.fastFeedbackRange         : 0.001;',
    '    this._f2Rng  = p.fastFreq2Range            !== undefined ? p.fastFreq2Range            : 300;',
    '    this._miRng  = p.fastModIRange             !== undefined ? p.fastModIRange             : 10000;',
    '    var self = this;',
    '    this.port.onmessage = function(e) {',
    '      if (e.data.type === "params") {',
    '        var a = e.data.value;',
    '        self._sp1    = a[0];  self._sp2    = a[1];  self._maxTPB = a[2];',
    '        self._sf2    = a[3];  self._smi    = a[4];',
    '        self._pfThr  = a[5];  self._pfVal  = a[6];  self._dfVal  = a[7];',
    '        self._ffBase = a[8];  self._ffRng  = a[9];',
    '        self._fbBase = a[10]; self._fbRng  = a[11];',
    '        self._f2Rng  = a[12]; self._miRng  = a[13];',
    '      }',
    '    };',
    '  }',
    '  process(inputs, outputs) {',
    '    var out = outputs[0] && outputs[0][0];',
    '    if (!out) return true;',
    '    var sr = sampleRate;',
    '    var TWO_PI = 6.283185307179586;',
    '    for (var i = 0; i < out.length; i++) {',
    '      // Tick clock C (fast subdivisions)',
    '      this._cCounter++;',
    '      if (this._cCounter >= this._cPeriod) { this._cCounter = 0; this._cTick = true; }',
    '      else { this._cTick = false; }',
    '      // Tick clock D (slow beat)',
    '      this._dCounter++;',
    '      if (this._dCounter >= this._dPeriod) { this._dCounter = 0; this._dTick = true; }',
    '      else { this._dTick = false; }',
    '      // Slow event (one per beat)',
    '      if (this._dTick && Math.random() > this._sp1) {',
    '        var newTPB = Math.floor(1 + Math.random() * this._maxTPB);',
    '        this._cPeriod   = sr * 60 / (this._tempo * newTPB);',
    '        this._a         = 1.0; this._b = 1.0;',
    '        this._bFeedback = Math.random() > this._pfThr ? this._pfVal : this._dfVal;',
    '        this._freq2     = this._sf2; this._modI = this._smi;',
    '      }',
    '      // Fast event (subdivision)',
    '      if (this._cTick && Math.random() > this._sp2 && !this._dTick) {',
    '        this._freq      = this._ffBase + Math.random() * this._ffRng;',
    '        this._a         = 1.0; this._b = 1.0;',
    '        this._feedback  = this._fbBase + Math.random() * this._fbRng;',
    '        this._bFeedback = this._fbBase + Math.random() * this._fbRng;',
    '        this._freq2     = Math.random() * this._f2Rng;',
    '        this._modI      = Math.random() * this._miRng;',
    '      }',
    '      // Envelope decay',
    '      this._a *= this._feedback;',
    '      this._b *= this._bFeedback;',
    '      // FM synthesis (phase accumulators)',
    '      var modOut = Math.sin(this._ph2);',
    '      this._ph2 += TWO_PI * this._freq2 / sr;',
    '      var carOut = Math.sin(this._ph1);',
    '      this._ph1 += TWO_PI * (this._freq * this._b + modOut * this._modI) / sr;',
    '      out[i] = carOut * this._a;',
    '    }',
    '    return true;',
    '  }',
    '}',
    'registerProcessor("jazz-fm", JazzFMProcessor);'
  ].join('\n');

  // ── jazz-audio system ────────────────────────────────────────────────────────
  // Uses Maximilian (WASM) via initAudioEngine — same as engine.js.
  // Requires enable-threads.js and maximilian.v.0.1.js loaded before this file.
  AFRAME.registerSystem('jazz-audio', {
    schema: {
      tempo:                      { default: 90 },
      ticksPerBeat:               { default: 4 },
      sparsity_1:                 { default: 0.4 },
      sparsity_2:                 { default: 0.5 },
      maxTicksPerBeat:            { default: 8 },
      slowFreq2:                  { default: 100 },
      slowModI:                   { default: 1 },
      positiveFeedbackThreshold:  { default: 0.75 },
      positiveFeedbackValue:      { default: 1.00001 },
      decayFeedbackValue:         { default: 0.999 },
      fastFreqBase:               { default: 250 },
      fastFreqRange:              { default: 350 },
      fastFeedbackBase:           { default: 0.999 },
      fastFeedbackRange:          { default: 0.001 },
      fastFreq2Range:             { default: 300 },
      fastModIRange:              { default: 10000 },
      initialA:                   { default: 0.5 },
      initialB:                   { default: 0.5 },
      initialFeedback:            { default: 0.9999 },
      initialBFeedback:           { default: 0.9999 },
      initialFreq:                { default: 350 },
      initialFreq2:               { default: 50 },
      initialModI:                { default: 650 }
    },

    init: function () {
      var self = this;
      var d    = this.data;
      var FFT_BINS = 256;

      // FFT texture — RGBA bytes, same pipeline as engine.js
      this._fftData   = new Uint8Array(FFT_BINS * 4);
      this.fftTexture = new THREE.DataTexture(this._fftData, FFT_BINS, 1, THREE.RGBAFormat);
      this.fftTexture.magFilter = THREE.NearestFilter;
      this.fftTexture.minFilter = THREE.NearestFilter;
      this.fftTexture.needsUpdate = true;
      window.jazzFFTTexture = this.fftTexture;
      window.jazzRMS        = 0;
      window.jazzRotDir     = [1, 1, 1];

      this._maxi          = null;
      this._analyser      = null;
      this._floatFreqData = null;
      this._linArray      = new Float32Array(FFT_BINS);
      this._sampleRate    = 44100;
      this._rmsSmooth     = 0;
      this._peakBaseline  = 0;
      this._eventCooldown = 0;
      this._playing       = false;
      this._engineReady   = false;

      var REALTIME_KEYS = [
        'sparsity_1','sparsity_2','maxTicksPerBeat',
        'slowFreq2','slowModI',
        'positiveFeedbackThreshold','positiveFeedbackValue','decayFeedbackValue',
        'fastFreqBase','fastFreqRange',
        'fastFeedbackBase','fastFeedbackRange',
        'fastFreq2Range','fastModIRange'
      ];

      function sendRealtimeParams() {
        if (!self._maxi) return;
        self._maxi.send('params', REALTIME_KEYS.map(function(k) { return d[k]; }));
      }

      // Identical to engine.js buildDSPCode — generates Maximilian JS for the worklet
      function buildDSPCode(p) {
        return [
          'var myOsc  = new Maximilian.maxiOsc();',
          'var myOsc2 = new Maximilian.maxiOsc();',
          'var paramsIn = new Input("params");',
          'var c = new Maximilian.maxiClock();',
          'var d = new Maximilian.maxiClock();',
          'c.setTempo('        + p.tempo        + ');',
          'c.setTicksPerBeat(' + p.ticksPerBeat + ');',
          'd.setTempo('        + p.tempo        + ');',
          'var _a         = ' + p.initialA        + ';',
          'var _b         = ' + p.initialB        + ';',
          'var _feedback  = ' + p.initialFeedback  + ';',
          'var _bFeedback = ' + p.initialBFeedback + ';',
          'var _freq      = ' + p.initialFreq      + ';',
          'var _freq2     = ' + p.initialFreq2     + ';',
          'var _modI      = ' + p.initialModI      + ';',
          'var sparsity_1 = ' + p.sparsity_1 + ';',
          'var sparsity_2 = ' + p.sparsity_2 + ';',
          'var maxTicksPerBeat = ' + p.maxTicksPerBeat + ';',
          'var slowFreq2 = ' + p.slowFreq2 + ';',
          'var slowModI  = ' + p.slowModI  + ';',
          'var positiveFeedbackThreshold = ' + p.positiveFeedbackThreshold + ';',
          'var positiveFeedbackValue     = ' + p.positiveFeedbackValue     + ';',
          'var decayFeedbackValue        = ' + p.decayFeedbackValue        + ';',
          'var fastFreqBase    = ' + p.fastFreqBase    + ';',
          'var fastFreqRange   = ' + p.fastFreqRange   + ';',
          'var fastFeedbackBase  = ' + p.fastFeedbackBase  + ';',
          'var fastFeedbackRange = ' + p.fastFeedbackRange + ';',
          'var fastFreq2Range  = ' + p.fastFreq2Range  + ';',
          'var fastModIRange   = ' + p.fastModIRange   + ';',
          'function play() {',
          '  var p = paramsIn.getValue();',
          '  if (p) {',
          '    sparsity_1 = p[0]; sparsity_2 = p[1]; maxTicksPerBeat = p[2];',
          '    slowFreq2 = p[3]; slowModI = p[4];',
          '    positiveFeedbackThreshold = p[5]; positiveFeedbackValue = p[6]; decayFeedbackValue = p[7];',
          '    fastFreqBase = p[8]; fastFreqRange = p[9];',
          '    fastFeedbackBase = p[10]; fastFeedbackRange = p[11];',
          '    fastFreq2Range = p[12]; fastModIRange = p[13];',
          '  }',
          '  c.ticker(); d.ticker();',
          '  if (d.tick && Math.random() > sparsity_1) {',
          '    c.setTicksPerBeat(Math.floor(1 + Math.random() * maxTicksPerBeat));',
          '    _a = 1.0; _b = 1.0;',
          '    _bFeedback = Math.random() > positiveFeedbackThreshold ? positiveFeedbackValue : decayFeedbackValue;',
          '    _freq2 = slowFreq2; _modI = slowModI;',
          '  }',
          '  if (c.tick && Math.random() > sparsity_2 && !d.tick) {',
          '    _freq = fastFreqBase + (Math.random() * fastFreqRange);',
          '    _a = 1.0; _b = 1.0;',
          '    _feedback  = fastFeedbackBase + (Math.random() * fastFeedbackRange);',
          '    _bFeedback = fastFeedbackBase + (Math.random() * fastFeedbackRange);',
          '    _freq2 = Math.random() * fastFreq2Range;',
          '    _modI  = Math.random() * fastModIRange;',
          '  }',
          '  _a *= _feedback; _b *= _bFeedback;',
          '  return myOsc.sinewave((_freq * _b) + (myOsc2.sinewave(_freq2) * _modI)) * _a;',
          '}'
        ].join('\n');
      }

      var playBtn = document.getElementById('playButton');
      if (playBtn) {
        playBtn.textContent = 'loading\u2026';
        playBtn.disabled = true;
        this._playBtn = playBtn;
      }

      var audioInitTimer = setTimeout(function() {
        if (playBtn) { playBtn.textContent = 'reload \u21ba'; playBtn.disabled = false; }
      }, 20000);

      // initAudioEngine is provided by maximilian.v.0.1.js
      // libsPath must be page-relative (not origin-relative)
      initAudioEngine(new URL('./libs', document.location.href).href)
        .then(function(maxi) {
          self._maxi = maxi;
          sendRealtimeParams();
          maxi.setAudioCode(buildDSPCode(d));
          var ctx = maxi.audioWorkletNode.context;
          ctx.suspend();
          self._sampleRate = ctx.sampleRate;

          var analyser = ctx.createAnalyser();
          analyser.fftSize = FFT_BINS * 2;
          self._analyser      = analyser;
          self._floatFreqData = new Float32Array(analyser.frequencyBinCount);

          var gainNode = ctx.createGain();
          gainNode.gain.value = 1.0;
          try { maxi.audioWorkletNode.disconnect(); } catch(e) {}
          maxi.audioWorkletNode.connect(gainNode);
          gainNode.connect(ctx.destination);
          maxi.audioWorkletNode.connect(analyser);

          window.jazzSetVolume = function(v) {
            gainNode.gain.value = Math.max(0, Math.min(1, v));
          };

          clearTimeout(audioInitTimer);
          self._engineReady = true;
          if (playBtn) { playBtn.textContent = 'play'; playBtn.disabled = false; }
        })
        .catch(function(err) {
          console.error('jazz-audio: Maximilian failed to load', err);
          clearTimeout(audioInitTimer);
          if (playBtn) { playBtn.textContent = 'reload \u21ba'; playBtn.disabled = false; }
        });

      if (playBtn) {
        playBtn.addEventListener('click', function() {
          if (!self._engineReady) return;
          if (!self._playing) {
            self._maxi.play(); // synchronous resume — must be inside user gesture
            self._playing = true;
            playBtn.textContent = 'stop';
          } else {
            self._maxi.audioWorkletNode.context.suspend();
            self._playing = false;
            playBtn.textContent = 'play';
          }
        });
      }
    },

    tick: function (time, dt) {
      if (!this._analyser) return;
      var FFT_BINS      = 256;
      var analyser      = this._analyser;
      var floatFreqData = this._floatFreqData;
      var linArray      = this._linArray;
      var fftData       = this._fftData;
      var sampleRate    = this._sampleRate;
      var dtSec         = dt / 1000;

      analyser.getFloatFrequencyData(floatFreqData);
      var peak = 0;
      for (var i = 0; i < FFT_BINS; i++) {
        var db = floatFreqData[i];
        linArray[i] = (isFinite(db) && db > -200) ? Math.pow(10, db / 20) : 0;
        if (linArray[i] > peak) peak = linArray[i];
      }

      var rawRms = 0;
      for (var j = 0; j < FFT_BINS; j++) rawRms += linArray[j] * linArray[j];
      rawRms = Math.sqrt(rawRms / FFT_BINS);
      this._rmsSmooth = this._rmsSmooth * 0.88 + rawRms * 0.12;
      window.jazzRMS  = this._rmsSmooth;

      this._eventCooldown = Math.max(0, this._eventCooldown - dtSec);
      this._peakBaseline  = this._peakBaseline * 0.99 + peak * 0.01;
      if (this._eventCooldown <= 0 && peak > this._peakBaseline * 1.5 && peak > 0.01) {
        window.jazzRotDir[0] = Math.random() > 0.5 ? 1 : -1;
        window.jazzRotDir[1] = Math.random() > 0.5 ? 1 : -1;
        window.jazzRotDir[2] = Math.random() > 0.5 ? 1 : -1;
        this._eventCooldown = 0.4;
      }

      if (peak > 0.002) {
        var logMin = Math.log2(20);
        var logMax = Math.log2(8000);
        var inv    = 1.0 / peak;
        for (var k = 0; k < FFT_BINS; k++) {
          var t      = k / (FFT_BINS - 1);
          var freq   = Math.pow(2, logMin + t * (logMax - logMin));
          var binIdx = Math.min(Math.floor(freq * FFT_BINS * 2 / sampleRate), FFT_BINS - 1);
          var val    = Math.min(255, Math.floor(linArray[binIdx] * inv * 255));
          fftData[k * 4] = fftData[k * 4 + 1] = fftData[k * 4 + 2] = val;
          fftData[k * 4 + 3] = 255;
        }
      } else {
        for (var k = 0; k < FFT_BINS; k++) {
          fftData[k * 4] = fftData[k * 4 + 1] = fftData[k * 4 + 2] = 0;
          fftData[k * 4 + 3] = 255;
        }
      }
      this.fftTexture.needsUpdate = true;
    }
  });

  // ── jazz-trails system ───────────────────────────────────────────────────────
  // Persistence / motion-trail effect. Place on <a-scene> as:
  //   jazz-trails="opacity: 0.08"
  // The renderer must have preserveDrawingBuffer:true (set via a-scene renderer attr).
  AFRAME.registerSystem('jazz-trails', {
    schema: {
      opacity: { default: 0.08 }
    },

    init: function () {
      var self = this;

      // Defer setup until renderer is confirmed ready
      this.el.addEventListener('renderstart', function () {
        var sceneEl  = self.el;
        var renderer = sceneEl.renderer;

        // Disable auto-clear so the colour buffer persists between frames
        renderer.autoClear = false;

        // Full-screen dark quad rendered each frame before the scene
        var fadeScene = new THREE.Scene();
        self._fadeMat = new THREE.MeshBasicMaterial({
          color: 0x000000, transparent: true, opacity: self.data.opacity,
          depthTest: false, depthWrite: false
        });
        fadeScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), self._fadeMat));
        self._fadeScene  = fadeScene;
        self._fadeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        self._ready      = true;
      });
    },

    // tick() runs BEFORE A-Frame renders the scene each frame
    tick: function () {
      if (!this._ready) return;
      var sceneEl  = this.el;
      var renderer = sceneEl.renderer;
      sceneEl.object3D.background = null; // prevent Three.js force-clear
      renderer.clearDepth();
      renderer.render(this._fadeScene, this._fadeCamera);
    }
  });

  // ── jazz-sphere component ────────────────────────────────────────────────────
  // Renders an audio-reactive wireframe sphere.
  // Usage: <a-entity jazz-sphere="radius:200; segments:22; deform:1000"></a-entity>
  AFRAME.registerComponent('jazz-sphere', {
    schema: {
      radius:    { default: 200 },
      segments:  { default: 22 },
      deform:    { default: 1000 },
      lineWidth: { default: 2.0 },
      fftUV:     { default: 0 },
      color:     { default: '#ffffff' }
    },

    init: function () {
      console.log('jazz-sphere: init start');
      try {
        // Create a fallback DataTexture using RGBAFormat + Uint8Array (256*4 zeros)
        // Do NOT use window.jazzFFTTexture yet — audio system may init after this
        var fallbackData = new Uint8Array(256 * 4);
        // Set alpha channel to 255 so texture is valid
        for (var i = 3; i < fallbackData.length; i += 4) fallbackData[i] = 255;
        var fftTex = new THREE.DataTexture(
          fallbackData, 256, 1, THREE.RGBAFormat
        );
        fftTex.magFilter = THREE.NearestFilter;
        fftTex.minFilter = THREE.NearestFilter;
        fftTex.needsUpdate = true;

        var d   = this.data;
        var geo = addBarycentricCoords(
          new THREE.SphereGeometry(d.radius, d.segments, d.segments)
        );

        // Do NOT set glslVersion — let Three.js auto-handle GLSL version for WebGL2
        var mat = new THREE.ShaderMaterial({
          vertexShader:   JAZZ_VERT,
          fragmentShader: JAZZ_FRAG,
          uniforms: {
            uFFT:       { value: fftTex },
            uDeform:    { value: d.deform },
            uTime:      { value: 0.0 },
            uLineWidth: { value: d.lineWidth },
            uColor:     { value: new THREE.Color(d.color) },
            uFFTUV:     { value: d.fftUV }
          },
          transparent: true,
          depthWrite:  false,
          side:        THREE.DoubleSide
        });

        this.mesh = new THREE.Mesh(geo, mat);
        this._mat = mat;
        this.el.setObject3D('mesh', this.mesh);

        console.log('jazz-sphere: mesh added to scene');
      } catch (e) {
        console.error('jazz-sphere: init error', e);
      }
    },

    tick: function (time, dtMs) {
      if (!this._mat) return;

      var dt  = dtMs / 1000;
      var t   = time / 1000;
      var mat = this._mat;

      // Update time uniform
      mat.uniforms.uTime.value = t;

      // Check if FFT texture has been populated by the audio system; swap in
      if (window.jazzFFTTexture && mat.uniforms.uFFT.value !== window.jazzFFTTexture) {
        mat.uniforms.uFFT.value = window.jazzFFTTexture;
      }

      // Rotate mesh slowly, driven by RMS amplitude and event direction
      var rms      = window.jazzRMS    || 0;
      var rotDir   = window.jazzRotDir || [1, 1, 1];
      var rotSpeed = 0.05 + rms * 0.4;
      this.mesh.rotation.y += rotDir[1] * rotSpeed * dt;
      this.mesh.rotation.x += rotDir[0] * rotSpeed * 0.3 * dt;
    },

    remove: function () {
      this.el.removeObject3D('mesh');
    }
  });

})();
