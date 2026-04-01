// engine.js — Jazz variations shared engine
(function () {
  'use strict';

  // ── Barycentric wireframe helper ─────────────────────────────────────────────
  window.addBarycentricCoords = function (geometry) {
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
  };

  // ── Default shaders ──────────────────────────────────────────────────────────
  var DEFAULT_VERT = /* glsl */`
    attribute vec3 barycentric;
    varying vec3 vBary;
    uniform sampler2D uFFT;
    uniform float uDeform;
    uniform float uTime;
    uniform float uFFTUV; // 0 = use fract(uv.x*2), 1 = use uv.y
    void main() {
      vBary = barycentric;
      float uvCoord = mix(uv.x, uv.y, uFFTUV);
      float mag = clamp(texture2D(uFFT, vec2(uvCoord, 0.5)).r, 0.0, 20.0);
      vec3 displaced = position + normal * mag * uDeform;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
    }
  `;

  var DEFAULT_FRAG = /* glsl */`
    varying vec3 vBary;
    uniform float uLineWidth;
    uniform vec3  uColor;
    void main() {
      vec3 d  = fwidth(vBary);
      vec3 a3 = smoothstep(vec3(0.0), d * uLineWidth, vBary);
      float edge  = min(min(a3.x, a3.y), a3.z);
      float alpha = 1.0 - edge;
      if (alpha < 0.01) discard;
      gl_FragColor = vec4(uColor, alpha);
    }
  `;

  // ── Main engine initialiser ──────────────────────────────────────────────────
  window.initJazzEngine = function (cfg) {
    var title        = cfg.title        || 'Jazz';
    var trailOpacity = cfg.trailOpacity !== undefined ? cfg.trailOpacity : 0.08;
    var camCfg       = cfg.camera       || {};
    var bounds       = cfg.bounds       || 800;
    var camSpeed     = cfg.speed        || 150;

    // ── Renderer ────────────────────────────────────────────────────────────
    var renderer = new THREE.WebGLRenderer({
      antialias: cfg.antialias || false, preserveDrawingBuffer: true
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000, 1);
    // preserveDrawingBuffer keeps the colour buffer alive between rAF calls.
    // autoClear=false means we handle clearing manually: depth only, each frame.
    renderer.autoClear = false;
    document.body.appendChild(renderer.domElement);

    var scene  = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 1, 10000);
    camera.position.copy(camCfg.position || new THREE.Vector3(0, 0, 500));
    if (camCfg.lookAt) camera.lookAt(camCfg.lookAt);

    var initPos  = camera.position.clone();
    var initQuat = camera.quaternion.clone();

    window.addEventListener('resize', function () {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });

    // ── Trail fade quad ──────────────────────────────────────────────────────
    // Rendered each frame BEFORE the scene to darken the colour buffer,
    // creating persistence / motion-trail. Depth is not written or tested.
    var fadeScene  = new THREE.Scene();
    var fadeMat    = new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: trailOpacity,
      depthTest: false, depthWrite: false
    });
    fadeScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), fadeMat));
    var fadeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // ── FFT texture ──────────────────────────────────────────────────────────
    var FFT_BINS   = 256;
    var fftArray   = new Float32Array(FFT_BINS);
    var fftTexture = new THREE.DataTexture(fftArray, FFT_BINS, 1, THREE.RedFormat, THREE.FloatType);
    fftTexture.magFilter = THREE.NearestFilter;
    fftTexture.minFilter = THREE.NearestFilter;

    // ── Shared shader helpers ────────────────────────────────────────────────
    var sharedShaders = {
      fftTexture:     fftTexture,
      vertexShader:   DEFAULT_VERT,
      fragmentShader: DEFAULT_FRAG,
      makeUniforms: function (overrides) {
        var base = {
          uFFT:       { value: fftTexture },
          uDeform:    { value: 1200.0 },
          uTime:      { value: 0.0 },
          uLineWidth: { value: 2.0 },
          uColor:     { value: new THREE.Color(1, 1, 1) },
          uFFTUV:     { value: 0.0 }
        };
        if (overrides) Object.keys(overrides).forEach(function (k) { base[k] = overrides[k]; });
        return base;
      }
    };

    // ── Init variation scene ─────────────────────────────────────────────────
    var sceneApi    = cfg.sceneSetup(scene, camera, sharedShaders);
    var updateScene = sceneApi.update || function () {};
    var resetScene  = sceneApi.reset  || function () {};
    var guiSetup    = sceneApi.gui    || function () {};

    // ── WASD + pointer-lock mouse-look ───────────────────────────────────────
    var keys  = {};
    var pitch = 0, yaw = 0, locked = false;

    var initEuler = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    pitch = initEuler.x;
    yaw   = initEuler.y;
    var initPitch = pitch, initYaw = yaw;

    document.addEventListener('keydown', function (e) { keys[e.code] = true; });
    document.addEventListener('keyup',   function (e) { keys[e.code] = false; });

    var canvas = renderer.domElement;
    canvas.addEventListener('click', function () { canvas.requestPointerLock(); });
    document.addEventListener('pointerlockchange', function () {
      locked = document.pointerLockElement === canvas;
    });
    document.addEventListener('mousemove', function (e) {
      if (!locked) return;
      yaw   -= e.movementX * 0.002;
      pitch -= e.movementY * 0.002;
      pitch  = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, pitch));
    });

    var euler   = new THREE.Euler(0, 0, 0, 'YXZ');
    var moveDir = new THREE.Vector3();

    function updateControls(dt) {
      euler.set(pitch, yaw, 0);
      camera.quaternion.setFromEuler(euler);
      moveDir.set(0, 0, 0);
      if (keys['KeyW'] || keys['ArrowUp'])    moveDir.z -= 1;
      if (keys['KeyS'] || keys['ArrowDown'])  moveDir.z += 1;
      if (keys['KeyA'] || keys['ArrowLeft'])  moveDir.x -= 1;
      if (keys['KeyD'] || keys['ArrowRight']) moveDir.x += 1;
      if (keys['KeyQ']) moveDir.y -= 1;
      if (keys['KeyE']) moveDir.y += 1;
      if (moveDir.lengthSq() > 0) {
        moveDir.normalize().applyQuaternion(camera.quaternion);
        camera.position.addScaledVector(moveDir, camSpeed * dt);
        camera.position.x = Math.max(-bounds, Math.min(bounds, camera.position.x));
        camera.position.y = Math.max(-bounds, Math.min(bounds, camera.position.y));
        camera.position.z = Math.max(-bounds, Math.min(bounds, camera.position.z));
      }
    }

    // ── Audio params ─────────────────────────────────────────────────────────
    var defaultAudio = {
      initialA: 0.5, initialB: 0.5,
      initialFeedback: 0.9999, initialBFeedback: 0.9999,
      initialFreq: 350, initialFreq2: 50, initialModI: 650,
      tempo: 90, ticksPerBeat: 4,
      sparsity_1: 0.4, sparsity_2: 0.5, maxTicksPerBeat: 8,
      slowFreq2: 100, slowModI: 1,
      positiveFeedbackThreshold: 0.75,
      positiveFeedbackValue: 1.00001,
      decayFeedbackValue: 0.999,
      fastFreqBase: 250, fastFreqRange: 350,
      fastFeedbackBase: 0.999, fastFeedbackRange: 0.001,
      fastFreq2Range: 300, fastModIRange: 10000
    };
    var savedAudio  = Object.assign({}, defaultAudio, cfg.audio || {});
    var audioParams = Object.assign({}, savedAudio);

    var REALTIME_KEYS = [
      'sparsity_1','sparsity_2','maxTicksPerBeat',
      'slowFreq2','slowModI',
      'positiveFeedbackThreshold','positiveFeedbackValue','decayFeedbackValue',
      'fastFreqBase','fastFreqRange',
      'fastFeedbackBase','fastFeedbackRange',
      'fastFreq2Range','fastModIRange'
    ];

    var maxi;
    function sendRealtimeParams() {
      if (!maxi) return;
      maxi.send('params', REALTIME_KEYS.map(function (k) { return audioParams[k]; }));
    }

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
        'var _a        = ' + p.initialA        + ';',
        'var _b        = ' + p.initialB        + ';',
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

    // ── Audio init (background, before first click) ──────────────────────────
    // Load WASM + DSP code while the page is rendering so the engine is ready
    // before the user clicks play. The AudioContext starts in 'suspended' state
    // (browser autoplay policy), so no sound is produced until play() is called
    // synchronously inside a user-gesture handler.
    // We explicitly suspend after init as an extra safeguard.
    var analyser, floatFreqData, linArray, sampleRate;
    var playing = false, engineReady = false;

    // Grab the play button immediately and show loading state while the audio
    // engine initialises. If init fails or times out, show a reload prompt.
    var playBtn = document.getElementById('playButton');
    playBtn.textContent = 'loading…';
    playBtn.disabled = true;

    function audioInitFailed() {
      playBtn.textContent = 'reload ↺';
      playBtn.disabled = false;
      playBtn.addEventListener('click', function onReload() {
        playBtn.removeEventListener('click', onReload);
        window.location.reload();
      });
    }

    // 20-second hard timeout — if init hangs (e.g. first load before the
    // COOP service-worker is active), show a reload button so the user can
    // recover without refreshing manually.
    var audioInitTimer = setTimeout(audioInitFailed, 20000);

    initAudioEngine(document.location.origin + '/libs')
      .then(function (dspEngine) {
        maxi = dspEngine;
        sendRealtimeParams();
        maxi.setAudioCode(buildDSPCode(audioParams));
        // Explicitly suspend to guarantee silence until the user clicks play,
        // regardless of how the MIMIC engine initialises its AudioContext.
        if (maxi.audioWorkletNode) {
          maxi.audioWorkletNode.context.suspend();
          var ctx = maxi.audioWorkletNode.context;
          sampleRate = ctx.sampleRate;
          analyser = ctx.createAnalyser();
          analyser.fftSize = FFT_BINS * 2;
          floatFreqData = new Float32Array(analyser.frequencyBinCount);
          linArray = new Float32Array(FFT_BINS);
          // Insert a gain node so variations can control master volume.
          var gainNode = ctx.createGain();
          gainNode.gain.value = 1.0;
          try { maxi.audioWorkletNode.disconnect(); } catch(e) {}
          maxi.audioWorkletNode.connect(gainNode);
          gainNode.connect(ctx.destination);
          maxi.audioWorkletNode.connect(analyser);
          window.jazzSetVolume = function (v) {
            gainNode.gain.value = Math.max(0, Math.min(1, v));
          };
          window.jazzSetAudioParams = function (params) {
            Object.assign(audioParams, params);
            sendRealtimeParams();
          };
        }
        clearTimeout(audioInitTimer);
        engineReady = true;
        playBtn.textContent = 'play';
        playBtn.disabled = false;
      })
      .catch(function (err) {
        console.error('Audio engine failed to load:', err);
        clearTimeout(audioInitTimer);
        audioInitFailed();
      });

    // ── Play button ──────────────────────────────────────────────────────────
    // maxi.play() is called *synchronously* inside the click handler so it runs
    // within the browser's user-gesture window — the only time AudioContext
    // .resume() is guaranteed to persist (async callbacks / setTimeout calls
    // are outside the gesture window and the browser auto-suspends them).
    playBtn.addEventListener('click', function () {
      if (!playing) {
        if (!engineReady) return; // button should be disabled — guard only
        maxi.play(); // synchronous resume — within user gesture ✓
        playing = true;
        playBtn.textContent = 'stop';
      } else {
        maxi.audioWorkletNode.context.suspend();
        playing = false;
        playBtn.textContent = 'play';
      }
    });

    // ── Reset ────────────────────────────────────────────────────────────────
    var resetBtn = document.getElementById('resetButton');
    resetBtn.addEventListener('click', function () {
      camera.position.copy(initPos);
      camera.quaternion.copy(initQuat);
      pitch = initPitch; yaw = initYaw;
      Object.assign(audioParams, savedAudio);
      sendRealtimeParams();
      resetScene();
      if (window._jazzGUI) {
        window._jazzGUI.controllersRecursive().forEach(function (c) { c.updateDisplay(); });
      }
    });

    // ── GUI ──────────────────────────────────────────────────────────────────
    var gui = new lil.GUI({ title: title });
    window._jazzGUI = gui;

    var timingF = gui.addFolder('Timing');
    timingF.add(audioParams, 'sparsity_1',      0, 1,  0.01).name('Slow threshold').onChange(sendRealtimeParams);
    timingF.add(audioParams, 'sparsity_2',      0, 1,  0.01).name('Fast threshold').onChange(sendRealtimeParams);
    timingF.add(audioParams, 'maxTicksPerBeat', 1, 16, 1   ).name('Max subdivisions').onChange(sendRealtimeParams);

    var slowF = gui.addFolder('Slow Events');
    slowF.add(audioParams, 'slowFreq2',                1, 2000,  1      ).name('Mod freq Hz'  ).onChange(sendRealtimeParams);
    slowF.add(audioParams, 'slowModI',                 0,  100,  0.1    ).name('Mod index'    ).onChange(sendRealtimeParams);
    slowF.add(audioParams, 'positiveFeedbackThreshold',0,    1,  0.01   ).name('Growth prob'  ).onChange(sendRealtimeParams);
    slowF.add(audioParams, 'positiveFeedbackValue',    1,1.001, 0.00001 ).name('Growth rate'  ).onChange(sendRealtimeParams);
    slowF.add(audioParams, 'decayFeedbackValue',     0.9,    1, 0.0001  ).name('Decay rate'   ).onChange(sendRealtimeParams);

    var fastF = gui.addFolder('Fast Events');
    fastF.add(audioParams, 'fastFreqBase',      0, 2000,    1).name('Carrier base Hz' ).onChange(sendRealtimeParams);
    fastF.add(audioParams, 'fastFreqRange',     0, 2000,    1).name('Carrier range Hz').onChange(sendRealtimeParams);
    fastF.add(audioParams, 'fastFeedbackBase',  0.99, 1, 0.0001).name('Feedback base').onChange(sendRealtimeParams);
    fastF.add(audioParams, 'fastFeedbackRange', 0, 0.01, 0.00001).name('Feedback range').onChange(sendRealtimeParams);
    fastF.add(audioParams, 'fastFreq2Range',    0, 1000,    1).name('Mod freq range'  ).onChange(sendRealtimeParams);
    fastF.add(audioParams, 'fastModIRange',     0, 20000,   1).name('Mod index range' ).onChange(sendRealtimeParams);

    var visF = gui.addFolder('Visuals');
    visF.add({ trail: trailOpacity }, 'trail', 0, 0.5, 0.01).name('Trail decay').onChange(function (v) {
      fadeMat.opacity = v;
    });
    guiSetup(visF, audioParams, sendRealtimeParams);

    timingF.close(); slowF.close(); fastF.close();

    // ── Render loop ──────────────────────────────────────────────────────────
    var clock     = new THREE.Clock();
    var rmsSmooth    = 0;
    var peakBaseline = 0;  // slow-moving average of FFT peak — tracks "normal" level
    var eventCooldown = 0; // seconds until next direction-flip is allowed
    window.jazzRMS    = 0;         // smoothed RMS, exposed to variations
    window.jazzRotDir = [1, 1, 1]; // per-axis rotation signs (±1), flip on events

    function draw() {
      var dt      = Math.min(clock.getDelta(), 0.05);
      var elapsed = clock.elapsedTime;

      updateControls(dt);

      if (analyser) {
        // 1. dB → linear amplitude into linArray
        analyser.getFloatFrequencyData(floatFreqData);
        var peak = 0;
        for (var i = 0; i < FFT_BINS; i++) {
          var db = floatFreqData[i];
          linArray[i] = (isFinite(db) && db > -200) ? Math.pow(10, db / 20) : 0;
          if (linArray[i] > peak) peak = linArray[i];
        }

        // 2. RMS from linear amplitude
        var rawRms = 0;
        for (var j = 0; j < FFT_BINS; j++) rawRms += linArray[j] * linArray[j];
        rawRms = Math.sqrt(rawRms / FFT_BINS);
        rmsSmooth = rmsSmooth * 0.88 + rawRms * 0.12;
        window.jazzRMS = rmsSmooth;

        // 3. Event detection
        eventCooldown = Math.max(0, eventCooldown - dt);
        peakBaseline  = peakBaseline * 0.99 + peak * 0.01;
        if (eventCooldown <= 0 && peak > peakBaseline * 1.5 && peak > 0.01) {
          window.jazzRotDir[0] = Math.random() > 0.5 ? 1 : -1;
          window.jazzRotDir[1] = Math.random() > 0.5 ? 1 : -1;
          window.jazzRotDir[2] = Math.random() > 0.5 ? 1 : -1;
          eventCooldown = 0.4;
        }

        // 4. Log-frequency remap + peak-normalise into the texture buffer.
        //    FM content sits in the bottom ~5% of linear FFT bins (e.g. 80–1200 Hz
        //    occupies bins 1–14 of 256 at 44100 Hz / 512-pt FFT).  Remapping to a
        //    log scale spreads the musical content across all 256 texture slots so
        //    every part of every geometry sees FFT variation.
        if (peak > 0.002) {
          var nyquist = sampleRate / 2;
          var logMin  = Math.log2(20);    // 20 Hz
          var logMax  = Math.log2(8000);  // 8 kHz — covers FM fundamentals + sidebands
          var inv     = 1.0 / peak;
          for (var k = 0; k < FFT_BINS; k++) {
            var t      = k / (FFT_BINS - 1);
            var freq   = Math.pow(2, logMin + t * (logMax - logMin));
            var binIdx = Math.min(Math.floor(freq * FFT_BINS * 2 / sampleRate), FFT_BINS - 1);
            fftArray[k] = linArray[binIdx] * inv;
          }
        } else {
          for (var k = 0; k < FFT_BINS; k++) {
            fftArray[k] = 0;
          }
        }

        fftTexture.needsUpdate = true;
      }

      updateScene(fftArray, elapsed, dt);

      renderer.clearDepth();
      renderer.render(fadeScene, fadeCamera);
      renderer.render(scene, camera);

      requestAnimationFrame(draw);
    }

    requestAnimationFrame(draw);
  };

})();
