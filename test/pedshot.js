// Pedestrian model close-ups — the character work's own visual check, beside
// test/shots.js. Boots the game the same way (high tier, software GL held to
// a fast machine's reading), stands a ped up in front of the follow camera
// and photographs it: night and day, the player on foot, and a ped walking.
//   node test/pedshot.js [outdir]
var http = require('http');
var fs = require('fs');
var path = require('path');
var { chromium } = require('playwright');

var ROOT = __dirname + '/..';
var OUT = process.argv[2] || '/tmp/pedshots';
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
  await page.goto('http://127.0.0.1:' + port + '/');
  await page.waitForFunction(function () { return window.GAME && GAME.test; }, null, { timeout: 60000 });

  async function shot(name, fn, settle) {
    await page.evaluate(fn);
    // whatever owns the camera or the conversation, out of the way
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
    await page.evaluate(fn);
    // the rAF loop draws on its own; software GL needs a beat to land a frame
    await page.waitForTimeout(settle || 1600);
    await page.screenshot({ path: OUT + '/' + name + '.png', timeout: 90000 });
    console.log('shot ' + name + (errors.length ? '  ERRORS: ' + errors.slice(0, 3).join(' | ') : ''));
  }

  await page.evaluate(function () {
    GAME.test.start();
    GAME.setQuality('high');
    GAME.setTimeMode('night');
    GAME.perf.testReset();
    GAME.perf.sample = function () {};
    GAME.gfx._noSoftwareTrim = true;
    GAME.gfx.applyQuality();
    if (GAME.scenes) { GAME.scenes.enabled = false; if (GAME.scenes.skip) GAME.scenes.skip(); }
  });

  // the close-up recipe: player at the strip's south end, a ped stood 3.4 m
  // off, follow camera low and near. `frozen` holds a ped still (the waiting-
  // for-a-fare state) and turns them to face the lens.
  var POSE_PED = function () {
    GAME.test.teleport(356, 40);
    var p = GAME.test.spawnPed(0, -3.4);
    if (p) {
      p.jobPed = true; p.state = 'wait'; p.speed = 0;
      // where the follow camera settles: behind the focus along its yaw, at
      // the on-foot distance the rig eases to (~5.6)
      var d = 5.6, h = Math.cos(0.08) * d;
      var cx = 356 - Math.sin(-2.62) * h, cz = 40 - Math.cos(-2.62) * h;
      p.heading = Math.atan2(cx - p.pos.x, cz - p.pos.z);
      p.mesh.rotation.y = p.heading;
      window.__ped = p;
    }
    var cam = GAME.cam;
    cam.yaw = -2.62; cam.pitch = 0.08; cam.dist = 4.2;
    cam.x = cam.y = cam.z = null;
  };

  await shot('ped-night', POSE_PED);
  await page.evaluate(function () { GAME.setTimeMode('day'); });
  await shot('ped-day', POSE_PED);

  // the player's own figure, on foot and idle, the same lens
  await shot('player-day', function () {
    GAME.test.teleport(356, 40);
    GAME.player.heading = Math.PI + 0.55;   // turned to the camera
    var cam = GAME.cam;
    cam.yaw = -2.62; cam.pitch = 0.08; cam.dist = 4.2;
    cam.x = cam.y = cam.z = null;
  });

  // and one walking: the same ped, left to stroll, caught mid-stride a couple
  // of seconds in (knees bent, arms swung)
  await page.evaluate(function () { GAME.setTimeMode('night'); });
  await shot('ped-walk-night', function () {
    GAME.test.teleport(356, 40);
    var p = GAME.test.spawnPed(0, -3.4);
    if (p) {
      // a walk across the lens, not away from it: the waypoint west, the
      // body left to its own gait
      p.wpX = p.pos.x - 30; p.wpZ = p.pos.z; p.wpT = 12;
      window.__ped = p;
    }
    var cam = GAME.cam;
    cam.yaw = -2.62; cam.pitch = 0.08; cam.dist = 4.2;
    cam.x = cam.y = cam.z = null;
  }, 2600);

  console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.join('\n') : 'NO CONSOLE ERRORS');
  await browser.close();
  server.close();
})().catch(function (e) { console.error(e); process.exit(1); });
