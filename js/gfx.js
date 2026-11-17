// gfx.js — the AAA graphics layer
//
// Everything that makes Costa Rosa look like a modern game lives here:
// real-time shadows off a low golden-hour sun, an HDR-ish post chain (bloom +
// god rays + ACES filmic + FXAA + vignette), a procedural environment cube so
// every PBR surface picks up the sky, a planar-reflection ocean shader with
// animated normals, foam and the same CPU-matched swell the physics has
// always run on, 4K-derived ground surfacing (asphalt, concrete, sand) that
// tiles in world metres out of media/textures, wet-asphalt under rain, and
// headlight pools on the road at night.
//
// The layer is quality-tiered and falls back gracefully: on LOW (or a
// phone) it steps out of the way and the renderer tone-maps directly, so
// nothing here can leave a slow machine unable to play.
//
// It hooks the game in four places (main.js):
//   GAME.gfx.init(renderer, scene, camera)   once, after the lights exist
//   GAME.gfx.render(scene, camera)           wherever renderer.render was
//   GAME.gfx.tick(dt)                        once per frame (sim or not)
//   GAME.gfx.resize()                        on window resize
// and two places in the world builders:
//   GAME.gfx.waterMaterial(waveUniform)      city.js, for the ocean
//   GAME.gfx.setShadowCaster(root)           statics, after a build pass
(function () {
  'use strict';

  var CFG = {
    high:   { shadows: 2560, shadowR: 100, post: true,  reflection: 512, reflEvery: 1, detailPeds: true,  tex: 2048 },
    medium: { shadows: 1536, shadowR: 110, post: true,  reflection: 384, reflEvery: 2, detailPeds: true,  tex: 1024 },
    low:    { shadows: 0,    shadowR: 110, post: false, reflection: 0,   reflEvery: 0, detailPeds: false, tex: 512 }
  };

  var gfx = {
    cfg: null,          // the live tier (a copy of one of the above, trimmed for touch)
    enabled: true,
    qualityName: 'high'
  };
  window.GFX = gfx;
  GAME.gfx = gfx;

  // The sun's one true slant, shared by the shadow light, the sea's specular
  // and the disc in the sky (city.js buildSky reads it through gfx.sunDir): a
  // low golden-hour angle (24 degrees up, out over the sea to the east), so
  // the city gets long readable shadows and the light shafts something to
  // pour through — and the sun itself rides inside the camera's reach, which
  // stops at a whisker above the horizon. One constant, three agreement.
  var SUN_OFF = { x: 460, y: 215, z: -138 };
  gfx.SUN_OFF = SUN_OFF;
  var SUN_DIR = null;
  gfx.sunDir = function () {
    if (!SUN_DIR) {
      var l = Math.sqrt(SUN_OFF.x * SUN_OFF.x + SUN_OFF.y * SUN_OFF.y + SUN_OFF.z * SUN_OFF.z);
      SUN_DIR = new THREE.Vector3(SUN_OFF.x / l, SUN_OFF.y / l, SUN_OFF.z / l);
    }
    return SUN_DIR;
  };

  var renderer = null, scene = null, camera = null;
  var TONE = THREE.NoToneMapping;   // set at init; never flipped mid-session
  // ---------- shared procedural textures ----------
  // One 256x256 RGBA tile is stretched to every purpose: water normals (RG),
  // asphalt grain (B) and fine flake noise (A) all read the same upload, and
  // the memory budget never notices it arrived.
  var noiseTex = null;
  function makeNoiseTexture() {
    if (noiseTex) return noiseTex;
    var S = 256, cv = document.createElement('canvas');
    cv.width = cv.height = S;
    var ctx = cv.getContext('2d');
    var img = ctx.createImageData(S, S);
    var d = img.data;
    // two octaves of smooth value noise, tileable (wrapped lattice), plus
    // per-pixel grain: RG end up smooth enough to differentiate into water
    // normals, B speckled like asphalt, A a fine metallic flake field
    var g1 = [], g2 = [];
    function lattice(n, arr) {
      for (var i = 0; i < n * n; i++) arr[i] = Math.random();
      arr[n * n - 1] = arr[0]; // seam-free wrap on both axes is approximated
    }
    lattice(8, g1); lattice(16, g2);
    function smooth(t) { return t * t * (3 - 2 * t); }
    function sample(arr, n, x, y) {
      var xi = Math.floor(x) % n, yi = Math.floor(y) % n;
      var xf = smooth(x - Math.floor(x)), yf = smooth(y - Math.floor(y));
      var a = arr[yi * n + xi], b = arr[yi * n + (xi + 1) % n];
      var c = arr[((yi + 1) % n) * n + xi], e = arr[((yi + 1) % n) * n + (xi + 1) % n];
      return a + (b - a) * xf + (c + (e - b - c + a) * xf - a) * yf;
    }
    for (var y = 0; y < S; y++) {
      for (var x = 0; x < S; x++) {
        var u = x / S, v = y / S;
        var h = sample(g1, 8, u * 8, v * 8) * 0.65 + sample(g2, 16, u * 16, v * 16) * 0.35;
        var grain = Math.random();
        var i = (y * S + x) * 4;
        d[i] = Math.round(h * 255);
        d[i + 1] = Math.round(sample(g2, 16, u * 16 + 5.3, v * 16 + 2.7) * 255);
        d[i + 2] = Math.round((h * 0.45 + grain * 0.55) * 255);
        d[i + 3] = Math.round(grain * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    noiseTex = new THREE.CanvasTexture(cv);
    noiseTex.wrapS = noiseTex.wrapT = THREE.RepeatWrapping;
    noiseTex.anisotropy = 4;
    return noiseTex;
  }
  gfx.noiseTexture = makeNoiseTexture;

  // The asphalt: the noise tile read as a roughness map. Roads darken and
  // sheen under rain by dropping the material's roughness instead (tick).
  var asphaltRough = null;
  gfx.asphaltRoughnessMap = function () {
    if (asphaltRough) return asphaltRough;
    asphaltRough = makeNoiseTexture();
    return asphaltRough;
  };

  // ---------- the ground texture set ----------
  // Real surfacing, generated offline (tools/gen_textures.py in the repo):
  // 4K masters shipped as 2048 albedo / 1024 normal + roughness, tileable and
  // hue-neutral so the city's vertex tints still decide a street's shade.
  // Every texture starts life as an 8x8 grey placeholder — nothing ever
  // renders black while a file is in flight — and when the image arrives it
  // is scaled to the quality tier FIRST (a phone or a software GL uploads
  // 512s, not 2048s: the file is big once, the memory never is) and swapped
  // into every clone at once. A file that never arrives never blocks play.
  var texReg = {}, texPending = 0, texCbs = [], texTimer = null, texReady = false;
  var MAXANISO = 4;
  function texPlaceholder() {
    var cv = document.createElement('canvas');
    cv.width = cv.height = 8;
    var c = cv.getContext('2d');
    c.fillStyle = '#8c8c8c';
    c.fillRect(0, 0, 8, 8);
    return cv;
  }
  function groundTex(name) {
    var r = texReg[name];
    if (!r) { r = texReg[name] = { image: null, texs: [], started: false }; }
    var t = new THREE.Texture(r.image || texPlaceholder());
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = MAXANISO;
    r.texs.push(t);
    if (!r.started) { r.started = true; texStartLoad(name, r); }
    return t;
  }
  function texStartLoad(name, r) {
    texPending++;
    var tier = gfx.cfg ? (gfx.cfg.tex || 1024) : 1024;
    new THREE.ImageLoader().load('media/textures/' + name + '.jpg', function (img) {
      var w = img.naturalWidth || img.width;
      var assign = function (image) {
        r.image = image;
        r.texs.forEach(function (tx) { tx.image = image; tx.needsUpdate = true; });
        texDone();
      };
      var canvasCopy = function () {
        var cv = document.createElement('canvas');
        cv.width = cv.height = tier;
        cv.getContext('2d').drawImage(img, 0, 0, tier, tier);
        assign(cv);
      };
      // ImageBitmap where the browser can: the decoded pixels live outside
      // the JS heap, and the resize happens off it too. Failing that, a
      // canvas at the tier; failing THAT, the element as it came
      if (w > tier) {
        if (window.createImageBitmap) {
          createImageBitmap(img, { resizeWidth: tier, resizeHeight: tier, resizeQuality: 'medium' })
            .then(assign, canvasCopy);
        } else canvasCopy();
      } else if (window.createImageBitmap) {
        createImageBitmap(img).then(assign, function () { assign(img); });
      } else assign(img);
    }, undefined, function () { texDone(); });
  }
  function texDone() {
    texPending--;
    if (texPending <= 0) texFire();
  }
  function texFire() {
    if (texTimer) { clearTimeout(texTimer); texTimer = null; }
    texReady = true;
    var cbs = texCbs; texCbs = [];
    cbs.forEach(function (cb) { try { cb(); } catch (e) { } });
  }
  // boot gate: fires once every asked-for file has landed (or failed), and
  // never later than nine seconds — the game does not wait on a file
  gfx.texturesReady = function (cb) {
    if (texReady || texPending <= 0) { cb(); return; }
    texCbs.push(cb);
    if (!texTimer) texTimer = setTimeout(texFire, 9000);
  };
  gfx._texStats = function () {
    return { pending: texPending, ready: texReady,
      loaded: Object.keys(texReg).filter(function (k) { return !!texReg[k].image; }).length };
  };

  // Ground surfacing tiles in WORLD METRES, not whatever uv a quad was
  // handed (one road quad can be a kilometre long): the hook rewrites the uv
  // every map samples from the vertex's own world xz.
  function groundUV(tileMetres) {
    return function (sh) {
      sh.uniforms.uGroundTile = { value: 1 / tileMetres };
      sh.vertexShader = sh.vertexShader
        .replace('#include <uv_pars_vertex>', '#include <uv_pars_vertex>\nuniform float uGroundTile;')
        .replace('#include <uv_vertex>', 'vUv = ( modelMatrix * vec4( position, 1.0 ) ).xz * uGroundTile;');
      if (sh.vertexShader.indexOf('uGroundTile') < 0) {
        if (window.console && console.error) console.error('gfx: ground uv hook missing');
      }
    };
  }

  // the street itself: aggregate grain, tar snakes and tyre polish out of
  // the asphalt set, rough enough to drink the light and wet right down
  // under rain (registerWet, as before)
  gfx.asphaltMaterial = function (opts) {
    if (gfx.flatTier()) {
      return new THREE.MeshPhongMaterial({ vertexColors: !!(opts && opts.vertexColors), shininess: 70, specular: 0x232e42 });
    }
    var m = new THREE.MeshStandardMaterial({
      vertexColors: !!(opts && opts.vertexColors),
      map: groundTex('asphalt'),
      normalMap: groundTex('asphalt_n'),
      roughnessMap: groundTex('asphalt_r'),
      roughness: 1, metalness: 0.02, envMapIntensity: 0.35
    });
    if (envCube) m.envMap = envCube;
    m.normalScale.set(0.85, 0.85);
    m.onBeforeCompile = groundUV(11);
    groundMats.push(m);
    return m;
  };
  // concrete and sand: the shared terrain material for the ground and beach
  // batches (vertex colours tint districts; the maps carry the surface)
  gfx.terrainMaterial = function (kind, tileMetres) {
    if (gfx.flatTier()) return new THREE.MeshLambertMaterial({ vertexColors: true });
    var m = new THREE.MeshStandardMaterial({
      vertexColors: true,
      map: groundTex(kind),
      normalMap: groundTex(kind + '_n'),
      roughnessMap: kind === 'concrete' ? groundTex('concrete_r') : null,
      roughness: 1, metalness: 0,
      envMapIntensity: kind === 'sand' ? 0.16 : 0.3
    });
    if (envCube) m.envMap = envCube;
    m.normalScale.set(0.7, 0.7);
    m.onBeforeCompile = groundUV(tileMetres);
    groundMats.push(m);
    return m;
  };
  // stucco grain for every facade in town (city.js lam/lamBlock): the
  // buildings keep their window maps and gain a plaster normal
  gfx.facadeNormal = function () {
    if (gfx.flatTier()) return null;
    return groundTex('plaster_n');
  };
  var groundMats = [];

  // ---------- the environment cube ----------
  // A 128px-per-face cube built from gradients, a moon/sun disc and a neon
  // horizon glow — reflected by every PBR material in the city. Two are
  // built, night and day, and the scene swaps between them at dusk, when
  // nothing is looking.
  function envFace(ctx, w, h, top, bottom, draw) {
    var g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    if (draw) draw(ctx, w, h);
  }
  function buildEnvCube(night) {
    var S = 128;
    var faces = [];
    // a physically plain sky: blue zenith into a pale horizon by day, deep
    // blue with a whisper of the city's own light at night — every PBR
    // surface reflects it, so it stays honest and never tints the town pink
    var nightTop = night ? '#060b16' : '#3f78c8';
    var nightHor = night ? '#0e1a2c' : '#cfe2f2';
    // the city's horizon light in its own colours: sodium amber and cool
    // glass — warm and quiet, no neon pink in the reflections
    var glowCols = ['#ffb46b', '#6bd4ff', '#ffe9b0', '#8ad0e8', '#ffc98a'];
    function glow(ctx, w, h) {
      for (var i = 0; i < 5; i++) {
        var x = (i * 37 + 13) % (w - 30), r = 18 + (i * 23) % 30;
        var gr = ctx.createRadialGradient(x, h, 2, x, h, r);
        gr.addColorStop(0, glowCols[(i + (night ? 0 : 2)) % glowCols.length]);
        gr.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gr;
        ctx.globalAlpha = night ? 0.26 : 0.05;
        ctx.fillRect(x - r, h - r, r * 2, r * 2);
        ctx.globalAlpha = 1;
      }
    }
    function stars(ctx, w, h) {
      if (!night) return;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      for (var i = 0; i < 26; i++) {
        var x = (i * 89 + 31) % w, y = (i * 53 + 7) % (h * 0.6);
        ctx.globalAlpha = 0.25 + (i % 5) * 0.14;
        ctx.fillRect(x, y, 1.4, 1.4);
      }
      ctx.globalAlpha = 1;
    }
    function side(draw) {
      var cv = document.createElement('canvas');
      cv.width = cv.height = S;
      var ctx = cv.getContext('2d');
      envFace(ctx, S, S, nightTop, nightHor, function (c, w, h) {
        stars(c, w, h);
        glow(c, w, h);
        if (draw) draw(c, w, h);
      });
      return cv;
    }
    var moon = side(function (ctx, w, h) {
      // the sun by day and the moon by night ride the +x face, up and to the
      // right: the same quarter the directional light comes from (SUN_OFF in
      // gfx.js), so paint and glass catch a highlight that agrees with the
      // shadows the buildings throw
      var x = w * 0.38, y = h * 0.30, r = night ? 14 : 13;
      var gr = ctx.createRadialGradient(x, y, 2, x, y, r * 2.6);
      gr.addColorStop(0, night ? '#ffffff' : '#fff8e0');
      gr.addColorStop(0.45, night ? 'rgba(200,214,255,0.4)' : 'rgba(255,242,205,0.55)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gr;
      ctx.fillRect(x - r * 2.6, y - r * 2.6, r * 5.2, r * 5.2);
      ctx.fillStyle = night ? '#e8edf8' : '#fff2c4';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    });
    var plain = side(null);
    var up = (function () {
      var cv = document.createElement('canvas');
      cv.width = cv.height = S;
      var ctx = cv.getContext('2d');
      envFace(ctx, S, S, night ? '#04070e' : '#3a72c4', nightTop, stars);
      return cv;
    })();
    var down = (function () {
      var cv = document.createElement('canvas');
      cv.width = cv.height = S;
      var ctx = cv.getContext('2d');
      envFace(ctx, S, S, night ? '#0a0c10' : '#8b9096', night ? '#08090c' : '#5a6068', null);
      return cv;
    })();
    // CubeTexture face order: +x, -x, +y, -y, +z, -z
    faces = [moon, plain, up, down, plain, plain];
    var tex = new THREE.CubeTexture(faces);
    tex.needsUpdate = true;
    tex.encoding = THREE.LinearEncoding; // authored as-is; the composite encodes
    return tex;
  }
  var envNight = null, envDay = null, envIsNight = true;

  // ---------- the material upgrade ----------
  // The town wore flat Lambert. These are the same registry factories the
  // whole game builds through (utils.js), returning standard-surface
  // materials instead: physically based, environment-lit, with the tone the
  // neon city was already tuned to. Reassigning the globals means every
  // mesh built after this file loads — the whole city, every car, every
  // pedestrian — comes up PBR without a single caller changing.
  var envCube = null; // set at init; materials hold the reference from here

  function makeSurface(opts) {
    var m = new THREE.MeshStandardMaterial({
      color: opts.color !== undefined ? opts.color : 0xffffff,
      vertexColors: !!opts.vertexColors,
      roughness: opts.roughness !== undefined ? opts.roughness : 0.85,
      metalness: opts.metalness !== undefined ? opts.metalness : 0.0,
      map: opts.map || null,
      normalMap: opts.normalMap || null,
      normalScale: opts.normalScale || new THREE.Vector2(1, 1),
      emissive: opts.emissive !== undefined ? opts.emissive : 0x000000,
      emissiveMap: opts.emissiveMap || null,
      transparent: !!opts.transparent,
      opacity: opts.opacity !== undefined ? opts.opacity : 1,
      side: opts.side || THREE.FrontSide
    });
    if (envCube) { m.envMap = envCube; m.envMapIntensity = opts.envInt !== undefined ? opts.envInt : 0.4; }
    if (opts.onBeforeCompile) m.onBeforeCompile = opts.onBeforeCompile;
    return m;
  }

  // per-vertex roughness/metalness (vehicles): the shader hook that turns
  // the aRM attribute into per-part paint, chrome, rubber and glass on a
  // single merged body. Guarded so a plain material never hears of it.
  function rmHook(sh) {
    sh.uniforms.uRMBoost = { value: 1 };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aRM;\nvarying vec2 vRM;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRM = aRM;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vRM;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * vRM.x;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = metalness * vRM.y;');
    if (sh.fragmentShader.indexOf('vRM') < 0 || sh.vertexShader.indexOf('aRM') < 0) {
      // a three.js that renamed its chunks must not break silently
      if (window.console && console.error) console.error('gfx: rm shader hook missing');
    }
  }

  var sharedVertexPBRCache = null;
  function sharedVertexPBR() {
    if (sharedVertexPBRCache) return sharedVertexPBRCache;
    // software GL: the merged bodies wear the town's original vertex-lit
    // coat (the aRM attribute rides along unread — see GeoBatch)
    if (gfx.flatTier && gfx.flatTier()) {
      sharedVertexPBRCache = sharedVertexLambert();
      return sharedVertexPBRCache;
    }
    var m = makeSurface({ vertexColors: true, roughness: 1, metalness: 1, envInt: 0.85 });
    m.onBeforeCompile = rmHook;
    m.userData.shared = true;
    // roughness/metalness base 1: the aRM attribute is the whole value
    sharedVertexPBRCache = m;
    return m;
  }
  gfx.sharedVertexPBR = sharedVertexPBR;

  // ---------- material tiers ----------
  // On software GL the per-pixel Standard shading costs the CPU dearly
  // (the whole city is one big flat wall of pixels). There the factories
  // hand back the original Lambert workhorses — vertex-lit, proven — and
  // everything else in the show (the water shader, the pools, the sky)
  // still runs. A real GPU never asks.
  var flatTierCache = null;
  gfx.flatTier = function () {
    if (!renderer) return false;
    if (flatTierCache === null) flatTierCache = softwareGL();
    return flatTierCache;
  };
  // a lit surface for the world builders: Standard on a GPU, Lambert on
  // software — one call, the right answer for the machine in hand
  gfx.surface = function (o) {
    o = o || {};
    if (gfx.flatTier()) {
      return new THREE.MeshLambertMaterial({
        color: o.color !== undefined ? o.color : 0xffffff,
        vertexColors: !!o.vertexColors,
        map: o.map || null,
        emissive: o.emissive !== undefined ? o.emissive : 0x000000,
        emissiveMap: o.emissiveMap || null,
        transparent: !!o.transparent,
        opacity: o.opacity !== undefined ? o.opacity : 1,
        side: o.side || THREE.FrontSide
      });
    }
    return gfx.applyEnv(new THREE.MeshStandardMaterial({
      color: o.color !== undefined ? o.color : 0xffffff,
      vertexColors: !!o.vertexColors,
      map: o.map || null,
      normalMap: o.normalMap || null,
      normalScale: o.normalScale || new THREE.Vector2(1, 1),
      emissive: o.emissive !== undefined ? o.emissive : 0x000000,
      emissiveMap: o.emissiveMap || null,
      transparent: !!o.transparent,
      opacity: o.opacity !== undefined ? o.opacity : 1,
      side: o.side || THREE.FrontSide,
      roughness: o.roughness !== undefined ? o.roughness : 0.85,
      metalness: o.metalness !== undefined ? o.metalness : 0,
      roughnessMap: o.roughnessMap || null,
      envMapIntensity: o.envInt !== undefined ? o.envInt : 0.35
    }));
  };

  function patchMaterialFactories() {
    // flat colours: people, hair, guns, lamp standards — matte, a whisper of sky
    sharedLambert = function (hex) {
      var k = 'S' + hex;
      var m = SHARED.mat[k];
      if (!m) {
        m = gfx.flatTier()
          ? new THREE.MeshLambertMaterial({ color: hex })
          : makeSurface({ color: hex, roughness: 0.78, metalness: 0.02, envInt: 0.3 });
        m.userData.shared = true;
        SHARED.mat[k] = m;
      }
      return m;
    };
    // merged vertex-colour bodies (piers, stairs, city scatter): as the
    // town's own plaster and timber on a GPU, the town as it always was on
    // software GL
    sharedVertexLambert = function () {
      var m = SHARED.mat.SV;
      if (!m) {
        m = gfx.flatTier()
          ? new THREE.MeshLambertMaterial({ vertexColors: true })
          : makeSurface({ vertexColors: true, roughness: 0.88, metalness: 0.04, envInt: 0.35 });
        m.userData.shared = true;
        SHARED.mat.SV = m;
      }
      return m;
    };
    // the instanced scatter (fence posts, palms, lamp posts)
    sharedInstanceLambert = function () {
      var m = SHARED.mat.SI;
      if (!m) {
        m = gfx.flatTier()
          ? new THREE.MeshLambertMaterial()
          : makeSurface({ roughness: 0.8, metalness: 0.05, envInt: 0.35 });
        m.userData.shared = true;
        SHARED.mat.SI = m;
      }
      return m;
    };
  }

  // car glass: one material for every window in town
  var glassCache = null;
  gfx.glassMaterial = function () {
    if (glassCache) return glassCache;
    glassCache = gfx.flatTier()
      ? new THREE.MeshLambertMaterial({ color: 0x9db4c8, transparent: true, opacity: 0.52 })
      : makeSurface({
          color: 0x9db4c8, roughness: 0.08, metalness: 0.4, envInt: 1.6,
          transparent: true, opacity: 0.52
        });
    glassCache.userData.shared = true;
    return glassCache;
  };

  // ---------- post-processing ----------
  // Scene renders linear into a full-res target; a two-scale gaussian bloom
  // is pulled out of it; the composite adds them back, runs ACES, encodes
  // sRGB, lays a soft vignette and, on the way out the door, FXAA. The
  // neon never sat in the tone curve before — now the signs, the window
  // light, the headlamps and the light pools all bloom like they always
  // meant to.
  var post = {
    on: false, rt: null, half: null, quarter: null,
    sceneFS: null, camFS: null,
    bright: null, blur: null, comp: null,
    w: 0, h: 0
  };

  var QUAD_VERT = [
    'varying vec2 vUv;',
    'void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }'
  ].join('\n');

  var BRIGHT_FRAG = [
    'uniform sampler2D tIn; uniform float uThresh; varying vec2 vUv;',
    'void main(){',
    '  vec3 c = texture2D(tIn, vUv).rgb;',
    '  float l = max(c.r, max(c.g, c.b));',
    '  float k = smoothstep(uThresh, uThresh + 0.22, l);',
    '  gl_FragColor = vec4(c * k, 1.0);',
    '}'
  ].join('\n');

  var BLUR_FRAG = [
    'uniform sampler2D tIn; uniform vec2 uDir; varying vec2 vUv;',
    'void main(){',
    '  vec3 s = texture2D(tIn, vUv).rgb * 0.29411764;',
    '  s += texture2D(tIn, vUv + uDir).rgb * 0.35294117;',
    '  s += texture2D(tIn, vUv - uDir).rgb * 0.35294117;',
    '  s += texture2D(tIn, vUv + uDir * 2.0).rgb * 0.11764706;',
    '  s += texture2D(tIn, vUv - uDir * 2.0).rgb * 0.11764706;',
    '  gl_FragColor = vec4(s, 1.0);',
    '}'
  ].join('\n');

  // FXAA: the compact 3.11 console fit — enough for a city of thin neon
  // edges at a fraction of the full algorithm's cost
  var FXAA_GLSL = [
    'vec3 fxaa(sampler2D tex, vec2 uv, vec2 rcp){',
    '  vec3 rgbNW = texture2D(tex, uv + vec2(-1.0,-1.0) * rcp).rgb;',
    '  vec3 rgbNE = texture2D(tex, uv + vec2( 1.0,-1.0) * rcp).rgb;',
    '  vec3 rgbSW = texture2D(tex, uv + vec2(-1.0, 1.0) * rcp).rgb;',
    '  vec3 rgbSE = texture2D(tex, uv + vec2( 1.0, 1.0) * rcp).rgb;',
    '  vec3 rgbM  = texture2D(tex, uv).rgb;',
    '  vec3 l = vec3(0.299, 0.587, 0.114);',
    '  float lNW = dot(rgbNW, l), lNE = dot(rgbNE, l);',
    '  float lSW = dot(rgbSW, l), lSE = dot(rgbSE, l), lM = dot(rgbM, l);',
    '  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));',
    '  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));',
    '  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));',
    '  float dirReduce = max((lNW + lNE + lSW + lSE) * 0.25 * 0.125, 1.0/128.0);',
    '  float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);',
    '  dir = clamp(dir * rcpDirMin, vec2(-8.0), vec2(8.0)) * rcp;',
    '  vec3 rgbA = 0.5 * (texture2D(tex, uv + dir * (1.0/3.0 - 0.5)).rgb + texture2D(tex, uv + dir * (2.0/3.0 - 0.5)).rgb);',
    '  vec3 rgbB = rgbA * 0.5 + 0.25 * (texture2D(tex, uv + dir * -0.5).rgb + texture2D(tex, uv + dir * 0.5).rgb);',
    '  float lB = dot(rgbB, l);',
    '  return (lB < lMin || lB > lMax) ? rgbA : rgbB;',
    '}'
  ].join('\n');

  var COMP_FRAG = [
    'uniform sampler2D tScene; uniform sampler2D tBloomA; uniform sampler2D tBloomB;',
    'uniform vec2 uRcp; uniform float uBloom; uniform float uExposure;',
    'uniform float uVignette; uniform float uAA; uniform float uFilmic;',
    'uniform vec2 uSunUV; uniform float uSunI; uniform vec3 uSunCol; uniform float uAspect;',
    'varying vec2 vUv;',
    FXAA_GLSL,
    // ACES (Stephen Hill's fit): the filmic curve the whole industry runs
    'vec3 rrtOdt(vec3 v){',
    '  vec3 a = v * (v + 0.0245786) - 0.000090537;',
    '  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;',
    '  return a / b;',
    '}',
    'vec3 aces(vec3 c){',
    '  c *= uExposure;',
    '  const mat3 IN = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);',
    '  const mat3 OUT = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);',
    // NB: the matrix goes on the LEFT. In GLSL, `v * M` is a row-vector
    // multiply — it applies the TRANSPOSE — and the transposed output fit
    // turns every neutral in the frame magenta (0.5 grey in, (144,48,95)
    // out, measured). `M * v` is the fit as Hill wrote it.
    '  return clamp(OUT * rrtOdt(IN * c), 0.0, 1.0);',
    '}',
    // Crepuscular rays — the sun's light pouring through the streets. The
    // classic screen-space march (GPU Gems 3, ch.13): step from the pixel
    // toward the sun's screen position, let only what was bright enough
    // (the disc, the sky near it) contribute, and fade along the way. The
    // buildings themselves, darker than sky, are what carves the shafts.
    'vec3 sunRays(vec2 uv){',
    '  vec2 d = (uSunUV - uv) * vec2(uAspect, 1.0);',
    '  vec2 stp = d * (0.92 / 30.0);',
    '  vec3 acc = vec3(0.0);',
    '  float decay = 1.0;',
    '  for (int i = 0; i < 30; i++) {',
    '    uv += stp / vec2(uAspect, 1.0);',
    '    vec3 s = texture2D(tScene, clamp(uv, 0.0, 1.0)).rgb;',
    '    float l = max(s.r, max(s.g, s.b));',
    '    acc += s * smoothstep(0.58, 0.95, l) * decay;',
    '    decay *= 0.955;',
    '  }',
    '  return acc / 18.0;',
    '}',
    'void main(){',
    '  vec3 c = uAA > 0.5 ? fxaa(tScene, vUv, uRcp) : texture2D(tScene, vUv).rgb;',
    '  c += (texture2D(tBloomA, vUv).rgb * 0.62 + texture2D(tBloomB, vUv).rgb * 0.38) * uBloom;',
    '  if (uSunI > 0.001) c += sunRays(vUv) * uSunCol * uSunI;',
    // The town was authored to be shown exactly as it was painted — no
    // encode, no curve — so the composite takes only ACES's SHOULDER: the
    // mids stay as lit, the top end rolls off instead of clipping, and the
    // bloom just added sits down inside the curve
    '  c = mix(c, aces(c), uFilmic);',
    '  float d = distance(vUv, vec2(0.5));',
    '  c *= 1.0 - uVignette * smoothstep(0.42, 0.86, d);',
    '  gl_FragColor = vec4(c, 1.0);',
    '}'
  ].join('\n');

  function fsMaterial(frag, uniforms) {
    return new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: frag,
      uniforms: uniforms,
      depthTest: false, depthWrite: false
    });
  }

  function buildPost() {
    var w = Math.max(2, Math.floor(renderer.domElement.width)),
        h = Math.max(2, Math.floor(renderer.domElement.height));
    post.w = w; post.h = h;
    var half = { w: Math.max(2, w >> 1), h: Math.max(2, h >> 1) };
    var quar = { w: Math.max(2, w >> 2), h: Math.max(2, h >> 2) };
    disposePost();
    function rt(pw, ph) {
      return new THREE.WebGLRenderTarget(pw, ph, {
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        depthBuffer: true, stencilBuffer: false
      });
    }
    post.rt = rt(w, h);
    post.half = rt(half.w, half.h);
    post.quarter = rt(quar.w, quar.h);
    post.sceneFS = new THREE.Scene();
    post.camFS = new THREE.Camera();
    post.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    post.sceneFS.add(post.quad);
    post.bright = fsMaterial(BRIGHT_FRAG, { tIn: { value: null }, uThresh: { value: 0.80 } });
    post.blur = fsMaterial(BLUR_FRAG, { tIn: { value: null }, uDir: { value: new THREE.Vector2() } });
    post.comp = fsMaterial(COMP_FRAG, {
      tScene: { value: null }, tBloomA: { value: null }, tBloomB: { value: null },
      uRcp: { value: new THREE.Vector2(1 / w, 1 / h) },
      uBloom: { value: 0.34 }, uExposure: { value: 1.02 },
      uVignette: { value: 0.22 }, uAA: { value: 1 }, uFilmic: { value: 0.62 },
      uSunUV: { value: new THREE.Vector2(0.5, 0.5) }, uSunI: { value: 0 },
      uSunCol: { value: new THREE.Color(1, 0.88, 0.7) }, uAspect: { value: w / h }
    });
  }
  function disposePost() {
    if (post.rt) post.rt.dispose();
    if (post.half) post.half.dispose();
    if (post.quarter) post.quarter.dispose();
    if (post.quad) { post.quad.geometry.dispose(); }
    post.rt = post.half = post.quarter = post.quad = null;
    ['bright', 'blur', 'comp'].forEach(function (k) { if (post[k]) { post[k].dispose(); post[k] = null; } });
  }

  function drawQuad(mat, target) {
    post.quad.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(post.sceneFS, post.camFS);
  }

  // ---------- shadows ----------
  var shadowLight = null, shadowTarget = null;
  function setupShadows(size, radius) {
    var L = GAME.lights;
    if (!L || !L.dir || !size) return;
    var d = L.dir;
    d.castShadow = true;
    d.shadow.mapSize.set(size, size);
    var c = d.shadow.camera;
    c.left = -radius; c.right = radius; c.top = radius; c.bottom = -radius;
    c.near = 10; c.far = 900;
    c.updateProjectionMatrix();
    // the lower sun throws longer shadows and grazes more: a touch more
    // normal bias keeps the acnes off the walls it slides along
    d.shadow.bias = -0.0004;
    d.shadow.normalBias = 1.2;
    if (!shadowTarget) {
      shadowTarget = new THREE.Object3D();
      GAME.scene.add(shadowTarget);
    }
    d.target = shadowTarget;
    d.shadow.needsUpdate = true;
    shadowLight = d;
  }
  // anything static: buildings, palms, piers, containers — the moon gets to
  // throw all of it at the ground. Sky, glows and the ocean are skipped by
  // what they are made of.
  gfx.setShadowCaster = function (root) {
    if (!renderer || !renderer.shadowMap.enabled) return;
    root.traverse(function (o) {
      if (!o.isMesh) return;
      var mats = Array.isArray(o.material) ? o.material : [o.material];
      var lit = false;
      for (var i = 0; i < mats.length; i++) {
        var m = mats[i];
        if (!m || m.isMeshBasicMaterial) continue;
        lit = true;
        break;
      }
      if (!lit) return;
      o.castShadow = true;
      o.receiveShadow = true;
    });
  };

  // the shadow frustum rides the player (or the camera in attract mode),
  // snapped to texel centres so the shadows don't shimmer as it moves
  var _focus = { x: 0, z: 0 };
  function tickShadows() {
    if (!shadowLight || !renderer.shadowMap.enabled) return;
    var f = GAME.focus ? GAME.focus() : _focus;
    _focus.x = f.x; _focus.z = f.z;
    var size = shadowLight.shadow.mapSize.x;
    var world = shadowLight.shadow.camera.right * 2;
    var texel = world / size;
    var x = Math.round(f.x / texel) * texel;
    var z = Math.round(f.z / texel) * texel;
    // the light keeps its own fixed slant on the city (SUN_OFF above): the
    // same direction the sun disc rides and the sea's specular answers to
    shadowTarget.position.set(x, 0, z);
    shadowLight.position.set(x + SUN_OFF.x, SUN_OFF.y, z + SUN_OFF.z);
    shadowTarget.updateMatrixWorld();
  }

  var _sunW = new THREE.Vector3(), _sunV = new THREE.Vector3(), _sunP = new THREE.Vector3();
  var sunVisual = null;
  // city.js buildSky hands the sun disc over; the rays aim at wherever it
  // actually is on screen this frame
  gfx.setSunVisual = function (mesh) { sunVisual = mesh; };
  gfx._sunScreen = function () {   // test hook: where the rays point, and how hard
    var u = post.on && post.comp ? post.comp.uniforms : null;
    return u ? { uv: [u.uSunUV.value.x, u.uSunUV.value.y], i: u.uSunI.value } : null;
  };
  // test hook: the post chain's own materials and targets (test/diag.js)
  gfx._post = function () { return post; };
  function updateSun() {
    var u = post.on && post.comp ? post.comp.uniforms : null;
    if (!u) return;
    var I = 0;
    if (sunVisual && sunVisual.visible && camera) {
      sunVisual.getWorldPosition(_sunW);
      _sunV.copy(_sunW).applyMatrix4(camera.matrixWorldInverse);
      if (_sunV.z < -1) {   // in front of the camera, not behind it
        _sunP.copy(_sunW).project(camera);
        var edge = Math.max(Math.abs(_sunP.x), Math.abs(_sunP.y));
        var fade = U.clamp((1.35 - edge) / 0.5, 0, 1);
        var df = GAME.timeOfDay || 0;
        var dayI = U.clamp((df - 0.55) / 0.3, 0, 1);
        var W = GAME.weather;
        var grey = Math.max(W ? W.rain : 0, Math.max(W ? W.cloud : 0, W ? W.mist : 0));
        var clear = 1 - U.clamp(grey * 1.15, 0, 1);
        if (GAME.player && GAME.player.interior) clear = 0;   // no shafts across a ceiling
        I = 0.55 * dayI * clear * fade;
        u.uSunUV.value.set((_sunP.x + 1) / 2, (_sunP.y + 1) / 2);
        // golden at the low hours, warm white at noon
        var t = U.clamp((df - 0.55) / 0.45, 0, 1);
        u.uSunCol.value.setRGB(1, U.lerp(0.8, 0.94, t), U.lerp(0.58, 0.85, t));
      }
    }
    u.uSunI.value = I;
  }

  // ---------- the ocean ----------
  // A ShaderMaterial for the sea that keeps the exact swell formula the
  // physics has always integrated (city.seaY and the boats' buoyancy answer
  // to the same two sines), and on top of it: animated normals from the
  // shared noise tile, Schlick fresnel, a planar reflection rendered from a
  // mirrored camera, moon specular, shore foam and scene fog.
  var WATER_VERT = [
    'uniform vec2 uWave;',
    'varying vec3 vWorld;',
    'varying vec4 vProj;',
    'varying float vShore;',
    'void main(){',
    '  vec3 p = position;',
    '  if (p.y > -0.5) p.y += sin(p.x * 0.045 + uWave.x) * 0.28 + sin(p.z * 0.06 + uWave.y) * 0.22;',
    '  vec4 wp = modelMatrix * vec4(p, 1.0);',
    '  vWorld = wp.xyz;',
    '  vShore = clamp((p.y + 4.0) / 3.7, 0.0, 1.0);',  // -4 deep .. -0.3 at the surface
    '  vec4 mv = viewMatrix * wp;',
    '  vProj = projectionMatrix * mv;',
    '  gl_Position = vProj;',
    '}'
  ].join('\n');

  var WATER_FRAG = [
    'uniform sampler2D tNoise;',
    'uniform sampler2D tRefl;',
    'uniform mat4 uReflMat;',
    'uniform vec2 uWave;',
    'uniform vec3 uDeep;',
    'uniform vec3 uShallow;',
    'uniform vec3 uSunDir;',
    'uniform vec3 uSunColor;',
    'uniform vec3 uFogColor;',
    'uniform float uFogNear;',
    'uniform float uFogFar;',
    'uniform float uReflAmt;',
    'uniform float uTime;',
    'varying vec3 vWorld;',
    'varying vec4 vProj;',
    'varying float vShore;',
    'float waveH(vec2 p){',
    '  vec2 uv1 = p * 0.06 + vec2(uTime * 0.021, uTime * 0.013);',
    '  vec2 uv2 = p * 0.163 - vec2(uTime * 0.033, uTime * 0.018);',
    '  return texture2D(tNoise, uv1).r * 0.7 + texture2D(tNoise, uv2).g * 0.3;',
    '}',
    'void main(){',
    '  vec2 p = vWorld.xz;',
    '  float e = 0.35;',
    '  float hC = waveH(p);',
    '  float hX = waveH(p + vec2(e, 0.0));',
    '  float hZ = waveH(p + vec2(0.0, e));',
    '  vec3 n = normalize(vec3(hC - hX, e * 1.6, hC - hZ));',
    '  vec3 V = normalize(cameraPosition - vWorld);',
    '  // Schlick, from water\'s own F0',
    '  float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, V), 0.0), 5.0);',
    '  fres = mix(0.04, 1.0, fres);',
    '  vec3 deep = mix(uDeep, uShallow, vShore * vShore);',
    '  vec3 col = deep;',
    // planar reflection, warped by the waves
    '  if (uReflAmt > 0.5) {',
    // projective sampling: the matrix already carries the 0.5 bias that
    // folds clip space into texture space (Reflector's texture2DProj in
    // all but name), so xy/w IS the uv — adding another half would sample
    // a squashed copy of the screen's middle
    '    vec4 rp = uReflMat * vec4(vWorld, 1.0);',
    '    vec2 ruv = rp.xy / rp.w;',
    '    ruv += n.xz * vec2(0.055, 0.031);',
    '    vec3 refl = texture2D(tRefl, ruv).rgb;',
    '    col = mix(col, refl, clamp(fres, 0.0, 0.92));',
    '  } else {',
    '    col = mix(col, uFogColor * 1.05, clamp(fres * 0.8, 0.0, 0.85));',
    '  }',
    // sun/moon glitter
    '  vec3 H = normalize(uSunDir + V);',
    '  float spec = pow(max(dot(n, H), 0.0), 220.0);',
    '  col += uSunColor * spec * 1.6;',
    // foam: a band where the sea meets the sand, plus caps on the swell
    '  float band = smoothstep(0.86, 0.985, vShore);',
    '  float cap = smoothstep(0.55, 0.95, hC) * 0.35;',
    '  float foam = clamp(band * (0.55 + 0.45 * texture2D(tNoise, p * 0.19 + uTime * 0.02).a) + cap * band, 0.0, 1.0);',
    '  col = mix(col, vec3(0.86, 0.9, 0.94), foam * 0.75);',
    // scene fog, the same linear falloff the city wears
    '  float depth = distance(cameraPosition, vWorld);',
    '  float fog = smoothstep(uFogNear, uFogFar, depth);',
    '  col = mix(col, uFogColor, fog);',
    '  gl_FragColor = vec4(col, 0.94);',
    '}'
  ].join('\n');

  var water = {
    mesh: null, mat: null, rt: null, cam: null,
    texMat: new THREE.Matrix4(),
    plane: new THREE.Plane(),
    reflEvery: 1, frame: 0
  };

  gfx.waterMaterial = function (waveUniform) {
    var mat = new THREE.ShaderMaterial({
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      transparent: true,
      uniforms: {
        tNoise: { value: makeNoiseTexture() },
        tRefl: { value: null },
        uReflMat: { value: new THREE.Matrix4() },
        uWave: { value: waveUniform },
        uDeep: { value: new THREE.Color(0x07142a) },
        uShallow: { value: new THREE.Color(0x0e4a5e) },
        uSunDir: { value: gfx.sunDir().clone() },
        uSunColor: { value: new THREE.Color(0xbcc8e8) },
        uFogColor: { value: new THREE.Color(0x0d1420) },
        uFogNear: { value: 110 }, uFogFar: { value: 430 },
        uReflAmt: { value: 0 },
        uTime: { value: 0 }
      }
    });
    water.mat = mat;
    return mat;
  };

  // city.js hands the finished ocean mesh over; the reflection rig hangs
  // off it from then on
  gfx.upgradeWater = function (oceanMesh) {
    water.mesh = oceanMesh;
    var refl = gfx.cfg ? gfx.cfg.reflection : 0;
    if (refl && renderer) {
      water.rt = new THREE.WebGLRenderTarget(refl, refl, {
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        depthBuffer: true, stencilBuffer: false
      });
      water.mat.uniforms.tRefl.value = water.rt.texture;
      water.mat.uniforms.uReflAmt.value = 1;
      water.reflEvery = gfx.cfg.reflEvery || 1;
      water.cam = new THREE.PerspectiveCamera();
    }
  };

  // the mirrored-camera planar reflection, after three.js's own Reflector:
  // reflect the camera about the sea plane, clip everything below it with an
  // oblique frustum, and keep the projective matrix for sampling
  var _rPos = new THREE.Vector3(), _rLook = new THREE.Vector3(),
      _rUp = new THREE.Vector3(), _rot = new THREE.Matrix4(),
      _n = new THREE.Vector3(), _v = new THREE.Vector3(),
      _planeP = new THREE.Vector3(), _q = new THREE.Vector4(),
      _plane = new THREE.Plane(), _camWP = new THREE.Vector3();
  function renderReflection() {
    if (!water.rt || !water.cam || !water.mesh) return;
    if (water.frame % water.reflEvery !== 0) { water.frame++; return; }
    water.frame++;
    var SEA = -0.35;
    _n.set(0, 1, 0);
    // is the camera above the water at all?
    _camWP.setFromMatrixPosition(camera.matrixWorld);
    if (_camWP.y < SEA) return;
    // reflect position
    _rPos.set(_camWP.x, 2 * SEA - _camWP.y, _camWP.z);
    // reflect the forward direction
    _rot.extractRotation(camera.matrixWorld);
    _v.set(0, 0, -1).applyMatrix4(_rot);
    _v.y = -_v.y;
    _rLook.copy(_rPos).add(_v);
    // reflect the up vector
    _rUp.set(0, 1, 0).applyMatrix4(_rot);
    _rUp.y = -_rUp.y;
    water.cam.position.copy(_rPos);
    water.cam.up.copy(_rUp);
    water.cam.lookAt(_rLook);
    water.cam.fov = camera.fov;
    water.cam.aspect = camera.aspect;
    water.cam.near = camera.near;
    water.cam.far = camera.far;
    water.cam.updateProjectionMatrix();
    water.cam.updateMatrixWorld();
    // oblique near-plane clipping at the water: everything below the mirror
    // (which the mirrored camera would see doubled) is folded out of the
    // frustum. test/abwater.js can switch it off to see it work.
    if (!gfx._debugNoClip) {
      _planeP.set(0, SEA, 0);
      _plane.setFromNormalAndCoplanarPoint(_n, _planeP);
      _plane.applyMatrix4(water.cam.matrixWorldInverse);
      _q.set(
        (Math.sign(_plane.normal.x) + water.cam.projectionMatrix.elements[8]) / water.cam.projectionMatrix.elements[0],
        (Math.sign(_plane.normal.y) + water.cam.projectionMatrix.elements[9]) / water.cam.projectionMatrix.elements[5],
        -1,
        (1 + water.cam.projectionMatrix.elements[10]) / water.cam.projectionMatrix.elements[14]
      );
      var dotNDotQ = _plane.normal.x * _q.x + _plane.normal.y * _q.y + _plane.normal.z * _q.z + _plane.constant * _q.w;
      var s = 2 / dotNDotQ;
      water.cam.projectionMatrix.elements[2] = _plane.normal.x * s;
      water.cam.projectionMatrix.elements[6] = _plane.normal.y * s;
      water.cam.projectionMatrix.elements[10] = _plane.normal.z * s + 1;
      water.cam.projectionMatrix.elements[14] = _plane.constant * s;
    }
    // projective sampling matrix
    water.texMat.set(
      0.5, 0, 0, 0.5,
      0, 0.5, 0, 0.5,
      0, 0, 0.5, 0.5,
      0, 0, 0, 1
    );
    water.texMat.multiply(water.cam.projectionMatrix);
    water.texMat.multiply(water.cam.matrixWorldInverse);
    water.mat.uniforms.uReflMat.value.copy(water.texMat);
    // draw, with the water itself out of the way
    water.mesh.visible = false;
    renderer.setRenderTarget(water.rt);
    renderer.clear();
    renderer.render(scene, water.cam);
    renderer.setRenderTarget(null);
    water.mesh.visible = true;
  }

  // ---------- wet asphalt ----------
  var wetMats = [];
  gfx.registerWet = function (m) { if (m && wetMats.indexOf(m) < 0) { m.userData.baseRough = m.roughness; wetMats.push(m); } };
  var wetNow = 0;
  function tickWet(dt) {
    var W = GAME.weather;
    var target = W && W.rain ? W.rain : 0;
    wetNow = U.damp(wetNow, target, 1.2, dt);
    if (Math.abs(wetNow - (gfx._wetApplied || -1)) < 0.02) return;
    gfx._wetApplied = wetNow;
    for (var i = 0; i < wetMats.length; i++) {
      var m = wetMats[i];
      m.roughness = m.userData.baseRough - wetNow * (m.userData.baseRough - 0.22);
      m.envMapIntensity = 0.3 + wetNow * 0.9;
    }
  }

  // ---------- headlight pools ----------
  // The spotlight lights the street; the pool is the glow you SEE on it —
  // an additive soft quad laid on the road ahead of the car, for the player
  // and for whichever cruisers are running hot. Nowhere near as many
  // lights: just the light that reads.
  var poolTex = null, pools = [], livePools = [];
  function makePoolTexture() {
    var S = 128, cv = document.createElement('canvas');
    cv.width = cv.height = S;
    var ctx = cv.getContext('2d');
    var g = ctx.createRadialGradient(S / 2, S / 2, 2, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(255,238,196,0.85)');
    g.addColorStop(0.5, 'rgba(255,228,170,0.32)');
    g.addColorStop(1, 'rgba(255,220,150,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    poolTex = new THREE.CanvasTexture(cv);
    return poolTex;
  }
  function makePool() {
    if (!poolTex) makePoolTexture();
    var p = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
      map: poolTex, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: false, opacity: 0
    }));
    p.rotation.x = -Math.PI / 2;
    p.renderOrder = 2;
    p.matrixAutoUpdate = false;
    return p;
  }
  var _needs = [];
  // ---------- the street lamps' own light ----------
  // The pools painted on the road (city.js) say where the light LANDS; these
  // three PointLights are the light itself, set down on the lamp heads
  // nearest the player after dark. Standard materials pick them up — faces,
  // paint, clothes — so the night street is lit by its lamps instead of the
  // moon alone. Three lights, moved not made, and off with the day.
  var lampLights = null, lampLightOn = -1;
  gfx.setLampLight = function (on) { lampLightOn = on; };
  function tickLampLights(night) {
    if (!scene) return;
    if (!lampLights) {
      lampLights = [];
      for (var i = 0; i < 3; i++) {
        var l = new THREE.PointLight(0xffb070, 0, 22, 2);
        l.position.set(0, -50, 0);
        scene.add(l);
        lampLights.push(l);
      }
    }
    var spots = GAME.city && GAME.city.lampSpots;
    var amt = (lampLightOn >= 0 ? lampLightOn : night);
    if (!spots || !spots.length || amt <= 0.03 || (gfx.flatTier && gfx.flatTier())) {
      for (var j = 0; j < lampLights.length; j++) { lampLights[j].intensity = 0; }
      return;
    }
    // the three nearest standing lamps to wherever the eye is
    var f = GAME.focus ? GAME.focus() : { x: 0, z: 0 };
    var best = [-1, -1, -1], bestD = [1e9, 1e9, 1e9];
    for (var s = 0; s < spots.length; s++) {
      var sp = spots[s];
      if (sp.down) continue;
      var dx = sp.x - f.x, dz = sp.z - f.z, d2 = dx * dx + dz * dz;
      if (d2 > 1600) continue;   // 40 m: beyond this the pool decal is enough
      if (d2 < bestD[0]) { bestD[2] = bestD[1]; best[2] = best[1]; bestD[1] = bestD[0]; best[1] = best[0]; bestD[0] = d2; best[0] = s; }
      else if (d2 < bestD[1]) { bestD[2] = bestD[1]; best[2] = best[1]; bestD[1] = d2; best[1] = s; }
      else if (d2 < bestD[2]) { bestD[2] = d2; best[2] = s; }
    }
    for (var k = 0; k < lampLights.length; k++) {
      var l2 = lampLights[k], idx = best[k];
      if (idx < 0) { l2.intensity = 0; continue; }
      var lamp = spots[idx];
      l2.position.set(lamp.x + Math.cos(lamp.rot) * 1.6, 5.5, lamp.z - Math.sin(lamp.rot) * 1.6);
      l2.intensity = 1.35 * amt;
    }
  }

  function tickPools() {
    var night = U.clamp(1 - GAME.timeOfDay * 1.6, 0, 1);
    tickLampLights(night);
    _needs.length = 0;
    if (night > 0.08 && scene) {
      var P = GAME.player;
      if (P && P.inCar && P.car && !P.car.spec.heli && !P.car.spec.plane && !P.car.spec.boat && !P.car.spec.jetski) {
        _needs.push([P.car, night]);
      }
      // the law: up to four cruisers with a lightbar going, nearest first
      if (GAME.world && GAME.world.cars) {
        var cops = [];
        GAME.world.cars.forEach(function (c) {
          if (!c.isPolice || c.spec.heli || c.spec.boat || !c.mesh || !c.mesh.userData.lightbar) return;
          var lb = c.mesh.userData.lightbar;
          if (!lb[0].visible && !lb[1].visible) return;
          if (P && P.inCar && P.car) {
            var dx = c.pos.x - P.car.pos.x, dz = c.pos.z - P.car.pos.z;
            c._poolD = dx * dx + dz * dz;
          } else c._poolD = 0;
          cops.push(c);
        });
        cops.sort(function (a, b) { return a._poolD - b._poolD; });
        for (var i = 0; i < Math.min(4, cops.length); i++) _needs.push([cops[i], night * 0.8]);
      }
    }
    // hand back the surplus, take what is needed, place them
    while (livePools.length > _needs.length) {
      var spare = livePools.pop();
      spare.visible = false;
      scene.remove(spare);
      pools.push(spare);
    }
    while (livePools.length < _needs.length) {
      var p = pools.pop() || makePool();
      scene.add(p);
      livePools.push(p);
    }
    for (var j = 0; j < _needs.length; j++) {
      var car = _needs[j][0], n = _needs[j][1], pool = livePools[j];
      var gy = GAME.city ? GAME.city.groundY(car.pos.x, car.pos.z) : 0;
      var fx = Math.sin(car.heading), fz = Math.cos(car.heading);
      pool.position.set(car.pos.x + fx * 4.4, gy + 0.06, car.pos.z + fz * 4.4);
      pool.rotation.z = car.heading;
      pool.scale.set(5.6, 9.2, 1);
      pool.updateMatrix();
      pool.material.opacity = 0.5 * n;
      pool.visible = true;
    }
  }

  // ---------- env / time of day ----------
  function tickEnv() {
    var df = GAME.timeOfDay;
    var wantNight = df < 0.5;
    if (envNight && envDay && wantNight !== envIsNight) {
      envIsNight = wantNight;
      envCube = envIsNight ? envNight : envDay;
      setEnvCubeAll(envCube);
    }
    if (water.mat) {
      var u = water.mat.uniforms;
      // water palette: warm day, cold neon night
      u.uDeep.value.setRGB(
        U.lerp(0.027, 0.10, df), U.lerp(0.078, 0.24, df), U.lerp(0.16, 0.38, df));
      u.uShallow.value.setRGB(
        U.lerp(0.055, 0.16, df), U.lerp(0.29, 0.42, df), U.lerp(0.37, 0.50, df));
      var L = GAME.lights;
      if (L) {
        u.uSunColor.value.copy(L.dir.color).multiplyScalar(L.dir.intensity);
        u.uSunDir.value.copy(gfx.sunDir());
      }
      var fog = scene.fog;
      if (fog) {
        u.uFogColor.value.copy(fog.color);
        u.uFogNear.value = fog.near; u.uFogFar.value = fog.far;
      }
      u.uTime.value = GAME.time;
    }
  }
  // a material built outside the factories (the city's walls, the roads)
  // asks for the sky it should reflect
  gfx.applyEnv = function (m) { if (envCube && m) m.envMap = envCube; return m; };

  // test hook: the planar reflection on and off (test/abwater.js)
  gfx._setReflection = function (on) {
    if (!water.mat) return;
    water.mat.uniforms.uReflAmt.value = on ? 1 : 0;
  };
  // test hook: the water rig's own state (test/abwater.js)
  gfx._water = function () { return water; };

  function setEnvCubeAll(tex) {
    var list = [sharedVertexPBRCache, glassCache, SHARED.mat.SV, SHARED.mat.SI];
    for (var k in SHARED.mat) {
      if (k[0] === 'S') list.push(SHARED.mat[k]);
    }
    for (var i = 0; i < groundMats.length; i++) list.push(groundMats[i]);
    list.forEach(function (m) { if (m && m.envMap !== undefined) m.envMap = tex; });
  }

  // ---------- the public surface ----------
  // Software GL (SwiftShader in CI, llvmpipe on a driverless desktop, the
  // odd VM) rasterises on the CPU: shadow maps, a mirrored second render of
  // the city and six fullscreen post passes cost seconds a frame there. Such
  // a machine keeps the look that survives — PBR surfaces, the water shader,
  // the sky — and drops the passes it cannot afford. A real GPU never trips
  // this, and the test rig can switch it off.
  var softwareTrim = true;
  // ?fullgfx on the URL: the whole show, whatever the machine says it is.
  // A wrongly-flagged GPU (a remote desktop, a VM, an over-cautious driver
  // string) used to flatten the town to vertex colours, and the owner had
  // no way to say "I can see the textures from here".
  var FORCE_FULL = /[?&]fullgfx/.test(location.search);
  function softwareGL() {
    if (FORCE_FULL) return false;
    if (!renderer) return false;
    try {
      var gl = renderer.getContext();
      // the masked strings say nothing ("WebKit WebGL"): the real device
      // hides behind the debug extension, when it is there at all
      var dbg = gl.getExtension('WEBGL_debug_renderer_info');
      var r = String(gl.getParameter(gl.RENDERER)) + ' ' + String(gl.getParameter(gl.VENDOR));
      if (dbg) r += ' ' + String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) + ' ' + String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL));
      return /swiftshader|software|llvmpipe|softpipe|basic render/i.test(r);
    } catch (e) { return false; }
  }
  gfx._noSoftwareTrim = false;

  gfx.init = function (rend, sc, cam) {
    renderer = rend; scene = sc; camera = cam;
    try { MAXANISO = Math.min(8, renderer.capabilities.getMaxAnisotropy() || 4); } catch (e) { MAXANISO = 4; }
    gfx.applyQuality(true);
    // env cubes
    envNight = buildEnvCube(true);
    envDay = buildEnvCube(false);
    envCube = envIsNight ? envNight : envDay;
    setEnvCubeAll(envCube);
    makeNoiseTexture();
  };

  gfx.applyQuality = function (quiet) {
    var name = GAME.quality || 'high';
    gfx.qualityName = name;
    var base = CFG[name] || CFG.high;
    var cfg = { shadows: base.shadows, shadowR: base.shadowR, post: base.post,
      reflection: base.reflection, reflEvery: base.reflEvery, detailPeds: base.detailPeds, tex: base.tex };
    // a phone has no headroom for shadows, mirror renders or 2048s of grain;
    // the bloom stays
    if (GAME.isTouch) { cfg.shadows = 0; cfg.reflection = 0; cfg.detailPeds = false; cfg.tex = Math.min(cfg.tex, 512); }
    // software GL (see softwareGL above): the look without the passes it
    // cannot afford — no shadows, no mirror render, no post chain, 512s of
    // grain, and the people keep the simpler figures (every extra mesh is a
    // draw call)
    if (softwareTrim && !gfx._noSoftwareTrim && renderer && softwareGL()) {
      cfg.shadows = 0; cfg.reflection = 0; cfg.post = false; cfg.detailPeds = false; cfg.tex = 512;
    }
    // the live perf system starving says more than any tier: step down
    // (and back up — tickPerfGate watches the reading and re-runs this)
    if (GAME.perf && GAME.perf.scale < 0.55) { cfg.shadows = 0; cfg.reflection = 0; }
    gfx.cfg = cfg;

    if (!renderer) return;
    var firstShadow = renderer.shadowMap.enabled;
    renderer.shadowMap.enabled = cfg.shadows > 0;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    if (renderer.shadowMap.enabled && shadowLight) {
      // size change needs a fresh map
      if (shadowLight.shadow.map) { shadowLight.shadow.map.dispose(); shadowLight.shadow.map = null; }
    }
    setupShadows(cfg.shadows, cfg.shadowR);
    if (renderer.shadowMap.enabled && !firstShadow && scene) {
      gfx.setShadowCaster(scene);
      // the programs were built for a shadowless light; rebuild them
      scene.traverse(function (o) {
        if (!o.material) return;
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) {
          if (m && !m.userData.shared) m.needsUpdate = true;
        });
      });
    }

    // post on: linear into a target, the composite does tone and colour.
    // post off: the renderer tone-maps directly (its own programs, its own
    // look, and no target traffic for the slow machines).
    if (cfg.post && !post.on) {
      post.on = true;
      TONE = THREE.NoToneMapping;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.outputEncoding = THREE.LinearEncoding;
      buildPost();
    } else if (!cfg.post && post.on) {
      post.on = false;
      disposePost();
      TONE = THREE.NoToneMapping;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.outputEncoding = THREE.LinearEncoding;
    }
    // post off: the renderer draws exactly as the town was authored — the
    // machines that cannot afford the chain keep the original look whole
    if (!cfg.post) {
      TONE = THREE.NoToneMapping;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.outputEncoding = THREE.LinearEncoding;
    }
    // water reflection follows the tier
    if (water.mesh) {
      var wantRt = cfg.reflection > 0;
      if (wantRt && (!water.rt || cfg.reflection !== water.rt.width)) {
        if (water.rt) { water.rt.dispose(); water.rt = null; water.cam = null; }
        gfx.upgradeWater(water.mesh);
      }
      if (!wantRt && water.rt) {
        water.rt.dispose(); water.rt = null; water.cam = null;
        water.mat.uniforms.tRefl.value = null;
        water.mat.uniforms.uReflAmt.value = 0;
      }
    }
  };

  gfx.render = function (sc, cam) {
    if (!post.on || !post.rt) {
      renderer.render(sc, cam);
      return;
    }
    // shadows render once a frame: on the reflection pass, and the main
    // pass reuses them (autoUpdate is left off outside this function)
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    if (water.rt && water.mesh) renderReflection();
    // the scene, linear and un-toned, into the target
    renderer.setRenderTarget(post.rt);
    renderer.clear();
    renderer.render(sc, cam);
    renderer.setRenderTarget(null);
    // where the sun sits on screen this frame, and how hard the rays may run
    updateSun();
    // bloom: bright-pass into half, blur it, down into quarter, blur again
    post.bright.uniforms.tIn.value = post.rt.texture;
    drawQuad(post.bright, post.half);
    post.blur.uniforms.tIn.value = post.half.texture;
    post.blur.uniforms.uDir.value.set(1.4 / post.half.width, 0);
    drawQuad(post.blur, post.quarter);
    post.blur.uniforms.tIn.value = post.quarter.texture;
    post.blur.uniforms.uDir.value.set(0, 1.4 / post.quarter.height);
    drawQuad(post.blur, post.quarter);
    post.blur.uniforms.tIn.value = post.quarter.texture;
    post.blur.uniforms.uDir.value.set(1.4 / post.quarter.width * 0.5, 0);
    drawQuad(post.blur, post.half);
    // composite to the screen: FXAA + bloom + a filmic shoulder + vignette
    post.comp.uniforms.tScene.value = post.rt.texture;
    post.comp.uniforms.tBloomA.value = post.quarter.texture;
    post.comp.uniforms.tBloomB.value = post.half.texture;
    drawQuad(post.comp, null);
  };

  gfx.resize = function () {
    if (!renderer || !post.on) return;
    buildPost();
  };

  gfx.tick = function (dt) {
    if (!renderer) return;
    tickPerfGate(dt || 0.016);
    tickShadows();
    tickWet(dt || 0.016);
    tickEnv();
    tickPools();
  };

  // the frame cannot afford the whole show: the perf system's own reading
  // decides, the same way it decides how many cars the street carries.
  // Down at 0.55 (starving), back up only at 0.8 (room to spare) — the gap
  // keeps a machine sitting on the line from flipping between the two every
  // half second, and each flip is a recompile of everything that shadows.
  var perfPollT = 0, perfTrimmed = false;
  function tickPerfGate(dt) {
    if (!GAME.perf || !GAME.perf.scale) return;
    perfPollT += dt;
    if (perfPollT < 2) return;
    perfPollT = 0;
    var s = GAME.perf.scale;
    if (!perfTrimmed && s < 0.55 && gfx.cfg && (gfx.cfg.shadows || gfx.cfg.reflection)) {
      perfTrimmed = true;
      gfx.applyQuality();
    } else if (perfTrimmed && s > 0.8) {
      perfTrimmed = false;
      gfx.applyQuality();
    }
  }

  // ---------- boot: take over the material factories ----------
  // Runs the moment this file loads, before the city builds (script order
  // in index.html), so every shared material in the game is born PBR.
  patchMaterialFactories();
})();
