// Drift model verification — the bug it locks out: a handbrake tap at speed
// used to blow the lateral slip to 10x what tires hold and throw the car
// sideways into a wall (lat 15.4 m/s within 0.2s, measured).
//   node test/driftverify.js
var http = require('http');
var fs = require('fs');
var path = require('path');
var { chromium } = require('playwright');

var ROOT = __dirname + '/..';
var server = http.createServer(function (req, res) {
  var url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  var file = path.join(ROOT, url);
  fs.readFile(file, function (err, data) {
    if (err) { res.writeHead(404); res.end('no'); return; }
    var ext = path.extname(file).slice(1);
    var type = { html: 'text/html', js: 'text/javascript', png: 'image/png' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
});

var PASS = 0, FAIL = 0;
function check(name, ok, detail) {
  if (ok) { PASS++; console.log('PASS  ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { FAIL++; console.log('FAIL  ' + name + (detail ? '  (' + detail + ')' : '')); }
}

(async function () {
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  var port = server.address().port;
  var browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  var page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  var errors = [];
  page.on('console', function (m) { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', function (e) { errors.push(String(e)); });
  await page.goto('http://127.0.0.1:' + port + '/');
  await page.waitForFunction(function () { return window.GAME && GAME.test; }, null, { timeout: 60000 });
  var R = await page.evaluate(function () {
    GAME.test.start();
    GAME.setQuality('low');
    GAME.setTimeMode('day');
    if (GAME.scenes) { GAME.scenes.enabled = false; if (GAME.scenes.skip) GAME.scenes.skip(); }
    // the runway: 400 m of clear asphalt, no blocks past z=350 — a drift has
    // room to be a drift instead of a crash test
    GAME.test.teleport(-230, 438);
    var car = GAME.test.spawnCar('sports', 0, -6);
    GAME.test.enterNearestCar(car);
    car.heading = Math.PI / 2;   // face east down the strip
    car.speed = 0; car.lat = 0;
    var dt = 1 / 30, out = { errors: [] };
    function run(n, thr, st, hb, sample) {
      var worst = 0, samples = [];
      for (var i = 0; i < n; i++) {
        car.controls.throttle = thr; car.controls.steer = st; car.controls.handbrake = hb;
        GAME.tick(dt);
        var slip = Math.atan2(car.lat, Math.max(4, Math.abs(car.speed)));
        if (Math.abs(car.lat) > worst) worst = Math.abs(car.lat);
        if (sample && i % sample === 0) samples.push({ t: +(i * dt).toFixed(2), speed: +car.speed.toFixed(1), lat: +car.lat.toFixed(2), slip: +slip.toFixed(3), h: +car.heading.toFixed(2), x: +car.pos.x.toFixed(1), z: +car.pos.z.toFixed(1) });
      }
      return { worst: +worst.toFixed(2), speed: +car.speed.toFixed(1), lat: +car.lat.toFixed(2),
        slip: +Math.atan2(car.lat, Math.max(4, Math.abs(car.speed))).toFixed(3),
        heading: +car.heading.toFixed(2), x: +car.pos.x.toFixed(1), z: +car.pos.z.toFixed(1), samples: samples };
    }
    // 1) straight launch
    out.launch = run(90, 1, 0, false);
    // 2) handbrake + full steer 1s
    out.drift = run(30, 0.3, 1, true, 5);
    // 3) release everything: the tires pull the car back onto its heading
    // (a long driven phase here only ever reaches the airport fence)
    out.counter = run(12, 0, 0, false, 4);
    // fresh start for the corner run: re-teleport clears speed and slip
    GAME.test.teleport(-230, 438);
    car.heading = Math.PI / 2;
    out.relaunch = run(60, 1, 0, false);
    out.corner = run(30, 0.4, 1, false, 1);
    // handbrake donut at low speed: from rest, full steer + handbrake + throttle
    GAME.test.teleport(-230, 438);
    car.heading = Math.PI / 2;
    out.donut = run(75, 1, 1, true, 15);
    out.carType = car.spec.label;
    return out;
  });
  // ---- assertions ----
  check('launch reaches 25 m/s', R.launch.speed > 25, 'speed=' + R.launch.speed);
  var maxDrift = 0, driftSamples = R.drift.samples;
  for (var i = 0; i < driftSamples.length; i++) maxDrift = Math.max(maxDrift, Math.abs(driftSamples[i].lat));
  check('handbrake lat stays under 14 m/s', maxDrift <= 14, 'max=' + maxDrift);
  var d0 = driftSamples[0], dEnd = R.drift;
  var latDisp = Math.hypot(dEnd.x - d0.x, dEnd.z - d0.z);
  check('drift arc is car-sized (< 18 m in 1s)', latDisp < 18, 'disp=' + latDisp.toFixed(1) + 'm');
  var hChange = Math.abs(dEnd.heading - d0.h);
  check('heading change < 2.2 rad in 1s', hChange < 2.2, 'dHeading=' + hChange.toFixed(2));
  check('car still rolling after 1s handbrake', Math.abs(R.drift.speed) > 6, 'speed=' + R.drift.speed);
  check('released slip decays fast (lat < 2.5 in 0.4s)', Math.abs(R.counter.lat) < 2.5, 'lat=' + R.counter.lat);
  // normal cornering sanity: lat within 25%-200% of the old equilibrium
  var oldEq = Math.abs(R.corner.samples[0].speed) * 0.16 * 8 / 3.6; // sports grip
  var cLat = 0;
  for (i = 0; i < R.corner.samples.length; i++) cLat = Math.max(cLat, Math.abs(R.corner.samples[i].lat));
  check('grip cornering in old ballpark', cLat > oldEq * 0.25 && cLat < oldEq * 2.2,
    'maxLat=' + cLat + ' oldEq~' + oldEq.toFixed(1));
  var hCorner = Math.abs(R.corner.heading - R.corner.samples[0].h);
  check('grip corner turns (dHeading > 0.5)', hCorner > 0.5, 'dHeading=' + hCorner.toFixed(2));
  check('grip corner lat < 14 m/s (no blow-up)', cLat < 14, 'maxLat=' + cLat);
  check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  console.log('\n' + (FAIL === 0 ? 'ALL ' + PASS + ' CHECKS PASS' : FAIL + ' CHECKS FAIL'));
  console.log('R.drift:', JSON.stringify(R.drift));
  console.log('R.corner:', JSON.stringify(R.corner.samples));
  console.log('drift samples:', JSON.stringify(R.drift.samples.slice(0, 4)));
  console.log('donut end:', JSON.stringify({ heading: R.donut.heading, speed: R.donut.speed }));
  await browser.close();
  server.close();
  process.exit(FAIL === 0 ? 0 : 1);
})().catch(function (e) { console.error(e); process.exit(1); });
