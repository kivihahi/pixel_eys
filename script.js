(() => {
  'use strict';
  const button = document.querySelector('.eye-button');
  const canvas = document.querySelector('.eye-screen');
  const ctx = canvas.getContext('2d');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- Настройки: крупные пиксели = маленькая сетка ----
  const W = 80, H = 50, CX = W / 2, CY = H / 2;
  const HW = 31, HT = 13.5, HB = 11.5;     // полуширина глаза, высота верхнего/нижнего века
  const MAXX = 10, MAXY = 4.2;             // предел поворота взгляда (в пикселях)
  const R = 10.6;                           // радиус радужки
  const DROWSY_AFTER = 20000, SLEEP_AFTER = 38000; // мс бездействия до сонливости / сна

  canvas.width = W; canvas.height = H;
  const img = ctx.createImageData(W, H), buf = img.data;

  // ---- Цвета и пиксельный градиент (упорядоченный дизеринг Байера) ----
  const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const ramp = (...a) => a.map(hex);
  const BAYER = [[0,8,2,10],[12,4,14,6],[3,11,1,9],[15,7,13,5]].map(r => r.map(v => (v + .5) / 16));
  const IRIS = ramp('#ffe29a','#ffb347','#c8d65a','#4fd8b4','#1fa9c9','#2a67d0','#1d3a9c','#141c5e','#0a0d2b');
  const SCLERA = ramp('#8f9ab5','#b9c2d6','#dbe2ee','#f0f4fa','#ffffff');
  const PINK = ramp('#c49aa6','#e3b6bd','#f3d3d6','#fbe8ea','#ffffff');
  const LID = hex('#10121a'), LOW = hex('#1d212d'), SOFT = hex('#6b7388'), CREASE = hex('#b7bfd2'), PUPIL = hex('#050609');
  const WHITE = hex('#ffffff'), GLINT2 = hex('#e6f4ff'), SPARK = hex('#bfe9ff');

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rand = (a, b) => a + Math.random() * (b - a);
  const smooth = x => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
  function pick(r, v, x, y) {
    const pos = clamp(v, 0, 1) * (r.length - 1), i = Math.floor(pos);
    if (i >= r.length - 1) return r[r.length - 1];
    return pos - i > BAYER[y & 3][x & 3] ? r[i + 1] : r[i];
  }
  function put(x, y, c) {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4; buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = 255;
  }

  // ---- Состояние ----
  let gx = 0, gy = 0, vx = 0, vy = 0;                 // взгляд (пружина)
  let open = 1, pupil = 0.4, kick = 0, surprise = 0, surpriseHold = 0, sleepy = 0;
  let pointer = null, interestUntil = 0, lastActivity = performance.now();
  let pressed = false, releaseAt = 0, clicks = [];
  let lookX = 0, lookY = 0, nextLook = 0, microX = 0, microY = 0, nextMicro = 0;
  let blinkT = -1, blinkSlow = 1, doubleBlink = false, nextBlink = performance.now() + 1800;
  let near = 0, last = performance.now();

  function startBlink(slow = 1) {
    if (blinkT >= 0) return;
    blinkT = 0; blinkSlow = slow; doubleBlink = Math.random() < 0.2;
  }
  function blinkFactor() {
    if (blinkT < 0) return 1;
    const k = blinkT / blinkSlow;                     // быстро закрывается, медленнее открывается
    if (k < 0.07) return 1 - smooth(k / 0.07);
    if (k < 0.11) return 0;
    return 1 - Math.pow(1 - smooth((k - 0.11) / 0.15), 2);
  }
  function startle(hold = 0.7) { surprise = 1; surpriseHold = hold; }
  function poke(now) {
    if (sleepy > 0.6) { startle(0.5); kick = 0.2; }
    lastActivity = now;
  }

  function scheduleLook(now) {
    const r = Math.random(); let x, y;
    if (r < 0.18) { x = rand(-1.5, 1.5); y = rand(-1, 1); }
    else if (r < 0.5) { x = rand(-MAXX, -4); y = rand(-3, 2.5); }
    else if (r < 0.82) { x = rand(4, MAXX); y = rand(-3, 2.5); }
    else { x = rand(-6, 6); y = Math.random() < .5 ? rand(-MAXY, -1.5) : rand(1.5, MAXY); }
    if (Math.hypot(x - lookX, y - lookY) > 9 && Math.random() < 0.45) startBlink(); // взгляд-прыжок + моргание
    lookX = x; lookY = y; nextLook = now + rand(800, 2800);
  }

  function update(dt, now) {
    const idle = now - lastActivity;
    const sTarget = reduceMotion ? 0 : idle > SLEEP_AFTER ? 1 : idle > DROWSY_AFTER ? 0.5 : 0;
    sleepy += (sTarget - sleepy) * (1 - Math.exp(-dt / (sTarget > sleepy ? 3 : 0.2)));

    // --- куда смотрим ---
    let tx, ty, following = false;
    const rect = canvas.getBoundingClientRect();
    if (pointer && now < interestUntil) {
      following = true;
      const dx = pointer.x - (rect.left + rect.width / 2), dy = pointer.y - (rect.top + rect.height / 2);
      tx = MAXX * Math.tanh(dx / (rect.width * 0.75));
      ty = MAXY * Math.tanh(dy / (rect.height * 0.9));
      near = clamp(1 - Math.hypot(dx, dy) / (rect.width * 1.2), 0, 1);
    } else {
      near = 0;
      if (!reduceMotion) {
        if (now >= nextLook) scheduleLook(now);
        if (now >= nextMicro) { microX = rand(-.8, .8); microY = rand(-.5, .5); nextMicro = now + rand(150, 500); }
      }
      tx = lookX + microX; ty = lookY + microY;
    }
    tx *= 1 - sleepy * 0.8; ty = ty * (1 - sleepy) + 2.5 * sleepy;
    if (reduceMotion) { gx = tx; gy = ty; vx = vy = 0; }
    else {
      const k = following ? 140 : 230, c = following ? 20 : 25; // лёгкий перелёт, как у настоящего глаза
      vx += (k * (tx - gx) - c * vx) * dt; gx += vx * dt;
      vy += (k * (ty - gy) - c * vy) * dt; gy += vy * dt;
    }

    // --- моргание ---
    if (blinkT >= 0) {
      blinkT += dt;
      if (blinkT / blinkSlow >= 0.26) {
        blinkT = -1;
        nextBlink = now + (doubleBlink ? rand(120, 220) : rand(2300, 6000) * (1 + sleepy * 1.5));
        doubleBlink = false;
      }
    } else if (now >= nextBlink && !pressed && sleepy < 0.95) startBlink(1 + sleepy * 1.6);

    // --- веки ---
    if (pressed || now < releaseAt) { /* держим закрытым */ }
    else if (pressed === false && releaseAt) { releaseAt = 0; kick = 0.14; }
    const holdClosed = pressed || now < releaseAt;
    const base = sleepy < 0.5 ? 1 - 0.7 * sleepy : 0.65 * (1 - (sleepy - 0.5) / 0.5);
    const target = holdClosed ? 0.02 : base;
    open += (target - open) * (1 - Math.exp(-dt / (target < open ? 0.045 : 0.12)));

    surpriseHold -= dt;
    if (surpriseHold < 0) surprise = Math.max(0, surprise - dt / 0.5);

    // --- зрачок: дышит, расширяется при интересе, сужается от испуга ---
    const t = now / 1000;
    let pt = 0.36 + 0.08 * near + 0.012 * Math.sin(t * 2.3) + 0.008 * Math.sin(t * 5.1) - 0.08 * sleepy;
    if (surprise > 0.5) pt = 0.27;
    kick *= Math.exp(-dt / 0.5);
    pupil += (pt + kick - pupil) * (1 - Math.exp(-dt / 0.08));
    return t;
  }

  // ---- Отрисовка ----
  function draw(t) {
    buf.fill(0);
    const uo = open * blinkFactor() * (1 + 0.22 * surprise);
    const lidShift = gy * 0.4;
    const ix = CX + Math.round(gx), iy = CY + 1 + Math.round(gy);
    const sq = 1 - 0.18 * Math.abs(gx) / MAXX;           // радужка чуть сплющивается у края
    const rx = R * sq, rot = t * 0.08;
    const closed = uo < 0.07;

    for (let x = 0; x < W; x++) {
      const tt = (x + .5 - CX) / HW;
      if (Math.abs(tt) > 1) continue;
      const c = Math.pow(Math.max(0, 1 - tt * tt), 0.8);
      const thU = 2.2 + 1.2 * (1 - Math.abs(tt));
      if (closed) {                                      // закрытый глаз: дуга со «ресничной» тенью
        const y0 = Math.floor(CY + 1.5 + lidShift * 0.3 + 2.2 * c);
        put(x, y0, LID); if (Math.abs(tt) < 0.85) put(x, y0 + 1, LID);
        if ((x + y0) & 1) put(x, y0 + 2, SOFT);
        continue;
      }
      const top = CY + lidShift - HT * uo * c * (1 + 0.1 * tt);
      const bot = Math.max(CY + 1 + lidShift * 0.5 + HB * uo * c * (1 - 0.08 * tt), top + thU + 0.8);
      const lowTh = 1.3;
      const cy = Math.floor(top - 2.6);                  // складка века
      if (uo > 0.4 && Math.abs(tt) < 0.8 && BAYER[cy & 3][x & 3] < 2.2 * (1 - Math.abs(tt) / 0.8)) put(x, cy, CREASE);
      for (let y = Math.max(0, Math.floor(top)); y <= Math.min(H - 1, Math.ceil(bot)); y++) {
        const yc = y + .5, dTop = yc - top, dBot = bot - yc;
        if (dTop < 0 || dBot < 0) continue;
        if (dTop < thU) { put(x, y, LID); continue; }
        if (dBot < lowTh) { put(x, y, LOW); continue; }

        const nx = (x + .5 - ix) / rx, ny = (yc - iy) / R, d = Math.hypot(nx, ny);
        const shade = clamp(1 - (dTop - thU) / 7, 0, 1);  // тень от верхнего века
        let col;
        if (d <= 1) {
          if (d < pupil) col = PUPIL;
          else {
            const u = Math.pow((d - pupil) / (1 - pupil), 0.85);
            const a = Math.atan2(ny, nx);
            const mid = 1 - Math.pow(Math.abs(2 * u - 1), 1.5);
            let v = u + (Math.sin(a * 13 + rot) + Math.sin(a * 27 - rot * 1.4)) * 0.25 * 0.12 * mid;
            v += 0.42 * shade;                             // сверху радужка темнее
            if (ny > 0) v -= 0.22 * ny * ny;               // снизу — тёплый свет
            if (d > 0.86) v = Math.max(v, 0.8 + (d - 0.86) / 0.14 * 0.2); // лимбальное кольцо
            col = pick(IRIS, v, x, y);
          }
        } else {
          let v = 0.3 + 0.7 * smooth((dTop - thU) / 6) - 0.38 * Math.pow(Math.abs(tt), 3.2);
          v -= 0.2 * clamp(1 - (dBot - lowTh) / 3, 0, 1);
          const pink = tt < -0.7 && smooth((-tt - 0.7) / 0.25) > BAYER[y & 3][x & 3];
          col = pick(pink ? PINK : SCLERA, v, x, y);
        }
        put(x, y, col);
      }
    }

    if (!closed) {                                       // блики: свет почти неподвижен, радужка скользит под ним
      const g1x = Math.round(ix - clamp(4.2 + gx * 0.25, 3, 5.2)), g1y = Math.round(iy - 4.4 - gy * 0.25);
      const inEye = (x, y) => buf[(y * W + x) * 4 + 3] && !same(x, y, LID) && !same(x, y, LOW) && !same(x, y, CREASE);
      const same = (x, y, c) => { const i = (y * W + x) * 4; return buf[i] === c[0] && buf[i+1] === c[1] && buf[i+2] === c[2]; };
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
        const x = g1x + i, y = g1y + j;
        if (x >= 0 && y >= 0 && x < W && y < H && inEye(x, y)) put(x, y, (i && j) ? GLINT2 : WHITE);
      }
      const g2x = Math.round(ix + 3.6 - clamp(gx * 0.2, -1.5, 1.5)), g2y = Math.round(iy + 4.4 - gy * 0.2);
      for (const [dx, dy] of [[0, 0], [1, 0], [2, -1]]) {
        const x = g2x + dx, y = g2y + dy;
        if (x >= 0 && y >= 0 && x < W && y < H && inEye(x, y)) put(x, y, SPARK);
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  // ---- Размер: целое число экранных пикселей на пиксель сетки ----
  function fit() {
    const s = clamp(Math.floor(Math.min(Math.min(innerWidth * 0.94, 640) / W, innerHeight * 0.8 / H)), 2, 8);
    canvas.style.width = W * s + 'px'; canvas.style.height = H * s + 'px';
  }
  addEventListener('resize', fit); fit();

  // ---- Ввод: глаз следит за курсором по всей странице ----
  addEventListener('pointermove', e => {
    const now = performance.now(); poke(now);
    pointer = { x: e.clientX, y: e.clientY };
    interestUntil = now + (button.contains(e.target) ? 5000 : 2200);
  }, { passive: true });
  document.documentElement.addEventListener('mouseleave', () => { interestUntil = Math.min(interestUntil, performance.now() + 500); });

  function press(now) {
    poke(now); pressed = true; releaseAt = now + 150;
    clicks = clicks.filter(c => now - c < 1000); clicks.push(now);
    if (clicks.length >= 3) { startle(1.1); clicks = []; }   // быстрые клики -> удивление
  }
  function release() { if (pressed) { pressed = false; kick = 0.14; } }
  button.addEventListener('pointerdown', e => {
    e.preventDefault(); pointer = { x: e.clientX, y: e.clientY }; interestUntil = performance.now() + 5000;
    press(performance.now()); button.setPointerCapture?.(e.pointerId);
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(n => button.addEventListener(n, release));
  button.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); press(performance.now()); }
  });
  button.addEventListener('keyup', e => { if (e.key === 'Enter' || e.key === ' ') release(); });
  addEventListener('blur', () => { pressed = false; interestUntil = 0; });

  // Небольшой API, чтобы вызывать состояния из своего кода: pixelEye.trigger('sleep')
  window.pixelEye = { trigger(n) {
    const now = performance.now();
    if (n === 'blink') startBlink();
    if (n === 'surprise') startle(1.1);
    if (n === 'sleep') lastActivity = now - SLEEP_AFTER - 1;
    if (n === 'wake') poke(now);
  } };

  scheduleLook(performance.now());
  const t0 = update(0.016, performance.now()); draw(t0);
  requestAnimationFrame(function frame(now) {
    const dt = Math.min(0.04, (now - last) / 1000); last = now;
    draw(update(dt, now));
    requestAnimationFrame(frame);
  });
})();
