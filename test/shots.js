// Visual check — boots the game, poses the camera through the game's own
// follow rig (yaw/pitch/dist + player placement), saves PNGs.
//   node test/shots.js [outdir]
var http = require('http');
var fs = require('fs');
var path = require('path');
var { chromium } = require('playwright');

var ROOT = __dirname + '/..';
var OUT = process.argv[2] || '/tmp/shots';
fs.mkdirSync(OUT, { recursive: true });

var server = http.createServer(function (req, res) {
  var url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  var file = path.join(ROOT, url);
  fs.readFile(file, function (err, data) {
    if (err) { res.writeHead(404); res.end('no'); return; }
    var ext = path.extname(file).slice(1);
    var type = { html: 'text/html', js: 'text/javascript', png: 'image/png', svg: 'image/svg+xml', json: 'application/json' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
});

(async function () {
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  var port = server.address().port;
  var browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  var page = await browser.newPage({ viewport: { width: 800, height: 450 } });
  var errors = [];
  page.on('console', function (m) { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', function (e) { errors.push(String(e)); });
  await page.goto('http://127.0.0.1:' + port + '/?fullgfx');  // the real look: textures, PBR, post — the whole chain
  await page.waitForFunction(function () { return window.GAME && GAME.test; }, null, { timeout: 60000 });

  async function shot(name, fn, arg) {
    await page.evaluate(fn, arg);
    // Lola's welcome and any scene it opened own the camera until dismissed;
    // the letterbox the scene brought with it leaves an element behind too
    await page.evaluate(function () {
      for (var i = 0; i < 5; i++) {
        if (GAME.lolaOpen && GAME.lola && GAME.lola.key) { GAME.lola.key('Escape'); continue; }
        if (GAME.hud.dialogOpen()) { GAME.hud.dialogKey('Escape'); continue; }
        if (GAME.sceneOpen && GAME.scenes && GAME.scenes.key) { GAME.scenes.key('Escape'); continue; }
        break;
      }
      var cine = document.getElementById('cine');
      if (cine) cine.style.display = 'none';
    });
    await page.evaluate(fn, arg);
    // the rAF loop draws on its own; give software GL a beat to land a frame
    await page.waitForTimeout(1600);
    await page.screenshot({ path: OUT + '/' + name + '.png', timeout: 90000 });
    console.log('shot ' + name + (errors.length ? '  ERRORS: ' + errors.slice(0, 3).join(' | ') : ''));
  }
  // stand the player somewhere and aim the game's own follow camera
  var POSE = function (a) {
    GAME.test.teleport(a.x, a.z);
    var cam = GAME.cam;
    cam.yaw = a.yaw; cam.pitch = a.pitch; cam.dist = a.dist;
    cam.x = cam.y = cam.z = null;
  };

  await page.evaluate(function () {
    GAME.test.start();
    GAME.setQuality('high');
    GAME.setTimeMode('night');
    // software GL is slow: hold the perf reading at a fast machine's, and
    // tell the tier this rig wants the whole show anyway (shadows,
    // reflections) — the pixel checks are the point of these shots
    GAME.perf.testReset();
    GAME.perf.sample = function () {};
    GAME.gfx._noSoftwareTrim = true;
    GAME.gfx.applyQuality();
    // a clear sky for every shot: the weather rolls on its own, and a bank
    // of cloud in one run put a grey lid over the whole comparison
    if (GAME.weather && GAME.weather.setMode) {
      GAME.weather.setMode('clear', true);
      GAME.weather.testSet && GAME.weather.testSet(0);
      // settle the ramp instantly: a cloud bank at boot lingers for seconds
      for (var _w = 0; _w < 12; _w++) GAME.weather.update(5);
    }
    // and no cutscene owns the camera while the shots are being taken
    if (GAME.scenes) { GAME.scenes.enabled = false; if (GAME.scenes.skip) GAME.scenes.skip(); }
  });

  await shot('01-night-strip', POSE, { x: 356, z: 40, yaw: -2.62, pitch: 0.24, dist: 9 });
  await shot('02-night-car', function () {
    GAME.test.teleport(356, 40);
    GAME.test.spawnCar('sports', 0, -7);
    var cam = GAME.cam;
    cam.yaw = -2.62; cam.pitch = 0.1; cam.dist = 7.5;
    cam.x = cam.y = cam.z = null;
  });
  await shot('03-night-ped', function () {
    GAME.test.teleport(356, 40);
    GAME.test.spawnPed(0, -3.4);
    var cam = GAME.cam;
    cam.yaw = -2.62; cam.pitch = 0.08; cam.dist = 4.6;
    cam.x = cam.y = cam.z = null;
  });
  await shot('04-night-sea', POSE, { x: 402, z: 100, yaw: -Math.PI / 2, pitch: 0.1, dist: 11 });
  await page.evaluate(function () { GAME.setTimeMode('day'); });
  await shot('05-day-city', POSE, { x: 356, z: 40, yaw: -0.9, pitch: 0.5, dist: 12 });
  await shot('06-day-sea', POSE, { x: 402, z: 100, yaw: -Math.PI / 2, pitch: 0.1, dist: 11 });
  await shot('07-day-car-shadow', function () {
    GAME.test.teleport(380, 90);
    GAME.test.spawnCar('sedan', 0, -6);
    var cam = GAME.cam;
    cam.yaw = -Math.PI / 2; cam.pitch = 0.55; cam.dist = 8;
    cam.x = cam.y = cam.z = null;
  });
  // the skyline mirrored on the sea: the player swims out and the camera
  // sits low behind him, the whole city lying upside-down ahead
  await shot('08-day-reflection', POSE, { x: 428, z: 100, yaw: -Math.PI / 2, pitch: 0.1, dist: 8 });
  await page.evaluate(function () { GAME.setTimeMode('night'); });
  await shot('09-night-reflection', POSE, { x: 428, z: 100, yaw: -Math.PI / 2, pitch: 0.1, dist: 8 });
  await shot('10-night-reflection-close', POSE, { x: 424, z: 130, yaw: -Math.PI / 2 + 0.06, pitch: 0.06, dist: 6 });

  console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.join('\n') : 'NO CONSOLE ERRORS');
  await browser.close();
  server.close();
})().catch(function (e) { console.error(e); process.exit(1); });
