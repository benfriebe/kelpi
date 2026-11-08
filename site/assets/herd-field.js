// The herding field behind the page. Faint dots flock across the black like sheep:
// each keeps its distance, matches its neighbours' heading and drifts toward the
// group, all riding a slow current. A few carry the app's running green and waiting
// blue, because the flock is your agents. The pointer is the dog: dots peel away from
// it and settle again once it moves off. The kelpie in the hero is a second, calmer
// dog, so the flock flows around it.
(function () {
  'use strict';

  if (!document.createElement('canvas').getContext) return;

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');

  // Tuning, in pixels and seconds
  var CRUISE = 22;          // calm drifting speed
  var MAX_SPEED = 150;      // top speed while fleeing
  var NEIGHBOUR = 120;      // how far a dot looks for its flock
  var PERSONAL = 15;        // how close is too close
  var DOG_RADIUS = 170;     // how far the pointer's presence carries
  var DOG_PUSH = 520;       // acceleration away from the pointer at contact
  var KELPIE_PUSH = 140;    // the hero kelpie herds more gently
  var DENSITY = 6200;       // square pixels of viewport per dot
  var WRAP = 24;            // dots leave one edge and return from the other

  var COLOURS = [
    { rgb: '255, 255, 255', alpha: 0.3, share: 0.82 },   // the flock
    { rgb: '95, 190, 137', alpha: 0.5, share: 0.12 },    // running
    { rgb: '111, 155, 216', alpha: 0.55, share: 0.06 }   // waiting
  ];

  var canvas = document.createElement('canvas');
  canvas.className = 'herd-field';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.insertBefore(canvas, document.body.firstChild);
  var ctx = canvas.getContext('2d');

  var width = 0, height = 0;
  var x = [], y = [], vx = [], vy = [], kind = [];
  var dog = { x: 0, y: 0, active: false, until: 0 };
  var kelpie = document.querySelector('[data-ascii]');
  var lastScroll = window.scrollY || 0;
  var running = false;
  var rafId = 0;
  var lastTime = 0;
  var clock = 0;

  function random(min, max) {
    return min + Math.random() * (max - min);
  }

  function pickKind() {
    var roll = Math.random(), sum = 0;
    for (var i = 0; i < COLOURS.length; i++) {
      sum += COLOURS[i].share;
      if (roll < sum) return i;
    }
    return 0;
  }

  // ---------- Flock size follows the viewport ----------

  function layout() {
    width = window.innerWidth;
    height = window.innerHeight;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var target = Math.max(45, Math.min(230, Math.round(width * height / DENSITY)));
    var heading = random(0, Math.PI * 2);
    while (x.length < target) {
      x.push(random(0, width));
      y.push(random(0, height));
      var a = heading + random(-0.6, 0.6);
      vx.push(Math.cos(a) * CRUISE);
      vy.push(Math.sin(a) * CRUISE);
      kind.push(pickKind());
    }
    if (x.length > target) {
      x.length = y.length = vx.length = vy.length = kind.length = target;
    }
    for (var i = 0; i < x.length; i++) {
      if (x[i] > width + WRAP) x[i] = random(0, width);
      if (y[i] > height + WRAP) y[i] = random(0, height);
    }
  }

  // ---------- Simulation ----------

  function flee(i, fx, fy, radius, push, ax, ay) {
    var dx = x[i] - fx, dy = y[i] - fy;
    var d2 = dx * dx + dy * dy;
    if (d2 >= radius * radius || d2 < 0.01) return;
    var d = Math.sqrt(d2);
    var k = 1 - d / radius;
    var force = push * k * k;
    ax[0] += (dx / d) * force;
    ay[0] += (dy / d) * force;
  }

  function step(dt) {
    clock += dt;
    var n = x.length;
    var current = clock * 0.035;
    var currentX = Math.cos(current) * 5, currentY = Math.sin(current * 0.7) * 3;
    var nearR2 = NEIGHBOUR * NEIGHBOUR, personalR2 = PERSONAL * PERSONAL;

    var dogOn = dog.active && performance.now() < dog.until;
    var herder = null;
    if (kelpie) {
      var rect = kelpie.getBoundingClientRect();
      if (rect.bottom > 0 && rect.top < height && rect.width) {
        herder = { x: rect.left + rect.width * 0.5, y: rect.top + rect.height * 0.5, r: rect.width * 0.48 };
      }
    }

    var ax = [0], ay = [0];
    for (var i = 0; i < n; i++) {
      var count = 0, avx = 0, avy = 0, cx = 0, cy = 0, sx = 0, sy = 0;
      for (var j = 0; j < n; j++) {
        if (j === i) continue;
        var dx = x[j] - x[i], dy = y[j] - y[i];
        var d2 = dx * dx + dy * dy;
        if (d2 > nearR2) continue;
        count++;
        avx += vx[j]; avy += vy[j];
        cx += dx; cy += dy;
        if (d2 < personalR2 && d2 > 0.01) {
          sx -= dx / d2; sy -= dy / d2;
        }
      }

      ax[0] = currentX + random(-6, 6);
      ay[0] = currentY + random(-6, 6);
      if (count) {
        ax[0] += (avx / count - vx[i]) * 0.9;      // match heading
        ay[0] += (avy / count - vy[i]) * 0.9;
        ax[0] += (cx / count) * 0.32;              // drift to the group
        ay[0] += (cy / count) * 0.32;
        ax[0] += sx * 420;                         // keep some room
        ay[0] += sy * 420;
      }
      if (dogOn) flee(i, dog.x, dog.y, DOG_RADIUS, DOG_PUSH, ax, ay);
      if (herder) flee(i, herder.x, herder.y, herder.r, KELPIE_PUSH, ax, ay);

      vx[i] += ax[0] * dt;
      vy[i] += ay[0] * dt;

      // ease back toward a calm cruise, never past top speed
      var speed = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]) || 0.001;
      var settle = speed + (CRUISE - speed) * Math.min(1, dt * 0.8);
      var next = Math.min(MAX_SPEED, settle);
      vx[i] *= next / speed;
      vy[i] *= next / speed;
    }

    for (var m = 0; m < n; m++) {
      x[m] += vx[m] * dt;
      y[m] += vy[m] * dt;
      if (x[m] < -WRAP) x[m] += width + WRAP * 2;
      else if (x[m] > width + WRAP) x[m] -= width + WRAP * 2;
      if (y[m] < -WRAP) y[m] += height + WRAP * 2;
      else if (y[m] > height + WRAP) y[m] -= height + WRAP * 2;
    }
  }

  // ---------- Drawing ----------

  function draw() {
    ctx.clearRect(0, 0, width, height);
    ctx.lineWidth = 1;
    ctx.lineCap = 'round';
    for (var i = 0; i < x.length; i++) {
      var colour = COLOURS[kind[i]];
      var speed = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);
      var alarm = Math.max(0, Math.min(1, (speed - CRUISE * 1.4) / (MAX_SPEED - CRUISE)));
      var alpha = colour.alpha + 0.3 * alarm;

      // a short streak behind a dot that is running from the dog
      if (alarm > 0.05) {
        var tail = 3 + 14 * alarm;
        ctx.strokeStyle = 'rgba(' + colour.rgb + ', ' + (alpha * 0.45).toFixed(3) + ')';
        ctx.beginPath();
        ctx.moveTo(x[i], y[i]);
        ctx.lineTo(x[i] - (vx[i] / speed) * tail, y[i] - (vy[i] / speed) * tail);
        ctx.stroke();
      }

      ctx.fillStyle = 'rgba(' + colour.rgb + ', ' + alpha.toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(x[i], y[i], kind[i] ? 1.8 : 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function frame(now) {
    rafId = 0;
    if (!running) return;
    var dt = lastTime ? Math.min(0.05, (now - lastTime) / 1000) : 1 / 60;
    lastTime = now;
    step(dt);
    draw();
    rafId = window.requestAnimationFrame(frame);
  }

  function start() {
    if (running || reduceMotion.matches || document.hidden) return;
    running = true;
    lastTime = 0;
    rafId = window.requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    if (rafId) window.cancelAnimationFrame(rafId);
    rafId = 0;
  }

  // ---------- The dog ----------

  function moveDog(px, py, holdMs) {
    dog.x = px;
    dog.y = py;
    dog.active = true;
    dog.until = performance.now() + holdMs;
  }

  function init() {
    layout();
    // Let the flock find its shape before anyone sees it.
    for (var s = 0; s < (reduceMotion.matches ? 400 : 240); s++) step(1 / 30);
    draw();
    canvas.classList.add('is-ready');
    start();

    var pending = 0;
    window.addEventListener('resize', function () {
      if (pending) return;
      pending = window.requestAnimationFrame(function () {
        pending = 0;
        layout();
        draw();
      });
    }, { passive: true });

    // The field sits still while the page moves over it, so slide the flock a little
    // against the scroll and it feels like ground passing underneath.
    window.addEventListener('scroll', function () {
      var now = window.scrollY || 0;
      var delta = now - lastScroll;
      lastScroll = now;
      if (reduceMotion.matches || !delta) return;
      for (var i = 0; i < y.length; i++) {
        y[i] -= delta * 0.3;
        if (y[i] < -WRAP) y[i] += height + WRAP * 2;
        else if (y[i] > height + WRAP) y[i] -= height + WRAP * 2;
      }
    }, { passive: true });

    if (finePointer.matches) {
      window.addEventListener('pointermove', function (event) {
        moveDog(event.clientX, event.clientY, 60000);
      }, { passive: true });
      document.documentElement.addEventListener('pointerleave', function () { dog.active = false; });
    }

    // On a phone the finger is the dog while it touches the screen.
    window.addEventListener('touchstart', function (event) {
      var t = event.touches[0];
      if (t) moveDog(t.clientX, t.clientY, 700);
    }, { passive: true });
    window.addEventListener('touchmove', function (event) {
      var t = event.touches[0];
      if (t) moveDog(t.clientX, t.clientY, 700);
    }, { passive: true });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop(); else start();
    });

    reduceMotion.addEventListener('change', function () {
      if (reduceMotion.matches) { stop(); draw(); } else { start(); }
    });
  }

  init();
})();
