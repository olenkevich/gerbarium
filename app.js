// ── STATE ──
const PAGE_SIZE = 20;
let allData = [], filtered = [], rendered = 0;
let activeCity = 'All', searchQuery = '';
let activeSort = '';      // '' | 'popular' | 'recent'
let activeRegion = 'all'; // 'all' | 'russia' | 'europe' | 'rest'

const EUROPE_COUNTRIES = new Set([
  'Albania','Andorra','Austria','Belarus','Belgium','Bosnia and Herzegovina',
  'Bulgaria','Croatia','Cyprus','Czech Republic','Denmark','Estonia',
  'Finland','France','Germany','Greece','Hungary','Iceland','Ireland',
  'Italy','Kosovo','Latvia','Liechtenstein','Lithuania','Luxembourg',
  'Malta','Moldova','Monaco','Montenegro','Netherlands','North Macedonia',
  'Norway','Poland','Portugal','Romania','San Marino','Serbia','Slovakia',
  'Slovenia','Spain','Sweden','Switzerland','Ukraine','United Kingdom',
  'Vatican City',
]);


fetch('data/catalog.json')
  .then(r => r.json())
  .then(data => {
    allData = data;
    initHero(data);
    applyFilters();
    // Deep-link: open modal if URL has a path like /Bogorodskoye
    const slug = location.pathname.slice(1);
    if (slug) {
      const item = allData.find(d => encodeURIComponent(d.name) === slug || d.name === decodeURIComponent(slug));
      if (item) openModal(item);
    }
  })
  .catch(() => {
    document.getElementById('grid').innerHTML = '<div class="empty">Failed to load catalog</div>';
  });

document.getElementById('search').addEventListener('input', e => {
  searchQuery = e.target.value.trim().toLowerCase();
  applyFilters();
});

// ── DATA & FILTERS ──
const fmtRank = d => d.image_format === 'svg' ? 0 : (d.image_format === 'png' || d.image_format === 'jpg') ? 1 : 2;

function regionMatch(d) {
  if (activeRegion === 'all')    return true;
  if (activeRegion === 'russia') return d.country === 'Russia';
  if (activeRegion === 'europe') return d.country !== 'Russia' && EUROPE_COUNTRIES.has(d.country);
  if (activeRegion === 'rest')   return d.country !== 'Russia' && !EUROPE_COUNTRIES.has(d.country);
  return true;
}

function applyFilters() {
  const showHero = !searchQuery && activeRegion === 'all' && !activeSort;
  let base = allData.filter(d => {
    const cityMatch = activeCity === 'All' || d.parent === activeCity;
    const qMatch = !searchQuery || d.name.toLowerCase().includes(searchQuery) || d.parent.toLowerCase().includes(searchQuery);
    const notHero = !showHero || !todaysPick || d.name !== todaysPick.name;
    return cityMatch && qMatch && notHero && regionMatch(d);
  });

  if (activeSort === 'popular') {
    const likes = getLikesData();
    base = base.slice().sort((a, b) => (likes[b.name] || 0) - (likes[a.name] || 0) || fmtRank(a) - fmtRank(b));
  } else if (activeSort === 'recent') {
    const idxMap = new Map(allData.map((d, i) => [d, i]));
    base = base.slice().sort((a, b) => idxMap.get(b) - idxMap.get(a));
  } else {
    base = base.slice().sort((a, b) => fmtRank(a) - fmtRank(b));
  }

  filtered = base;
  rendered = 0;
  document.getElementById('grid').innerHTML = '';
  renderNext();
  document.getElementById('search').placeholder = `Search ${filtered.length.toLocaleString()} coats of arms…`;
}

const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// ── GRID RENDER ──
function renderNext() {
  const grid = document.getElementById('grid');
  const batch = filtered.slice(rendered, rendered + PAGE_SIZE);
  if (rendered === 0 && batch.length === 0) {
    grid.innerHTML = `<div class="empty"><div class="empty-title">No results</div><div class="empty-sub">Try a different search</div></div>`;
    return;
  }
  if (rendered === 0 && todaysPick && !searchQuery && activeCity === 'All') {
    const heroCard = renderHeroCard();
    grid.appendChild(heroCard);
    requestAnimationFrame(() => initHeroFlag(todaysPick.image_path || todaysPick.image_url));
  }
  batch.forEach((d, batchIdx) => {
    const adminLabel = {
      municipal_okrug: 'Municipal Okrug', city_district: 'City District', rayon: 'Rayon',
      city: 'City', federal_city: 'Federal City', village: 'Village', region: 'Region',
      republic: 'Republic', oblast: 'Oblast', krai: 'Krai', state: 'State',
      autonomous_okrug: 'Autonomous Okrug', autonomous_oblast: 'Autonomous Oblast',
      country: 'Country',
    }[d.admin_type] ?? d.admin_type;
    const sub = d.parent !== d.country
      ? `${esc(d.parent)} · ${esc(adminLabel)}`
      : esc(adminLabel);
    const card = document.createElement('div');
    card.className = 'card';
    card.style.animationDelay = `${batchIdx * 32}ms`;
    card.innerHTML = `
      <div class="card-img">
        <img src="${esc(d.image_path || d.image_url)}" alt="${esc(d.name)}" loading="lazy">
      </div>
      <div class="card-info">
        <div class="card-name">${esc(d.name)}</div>
        <div class="card-sub">${sub}</div>
      </div>`;
    const imgEl = card.querySelector('img');
    if (imgEl.complete && imgEl.naturalWidth > 0) {
      imgEl.classList.add('loaded');
    } else {
      imgEl.addEventListener('load',  () => imgEl.classList.add('loaded'));
      imgEl.addEventListener('error', () => imgEl.classList.add('loaded'));
    }
    card.addEventListener('click', () => openModal(d));
    grid.appendChild(card);
  });
  rendered += batch.length;
}

// ── FLAG PHYSICS ──
// 3D Flag — physics ported from github.com/krikienoid/flagwaver

let flagRenderer = null, flagAnimId = null;
let flagGeo = null, flagMat = null, flagTexture = null;

// Constants (flagwaver/constants.js)
const FW_DT   = 1 / 60;
const FW_ITER = 2;
const FW_DRAG = 1 - 0.03;   // DRAG = 1 - DAMPING
const FW_Cd   = 0.12;        // DRAG_COEFFICIENT
const FW_RHO  = 1.225;       // AIR_DENSITY kg/m³
const FW_G    = 9.80665;     // m/s²

// Shared temporaries — avoids GC pressure (flagwaver pattern)
const _cDiff  = new THREE.Vector3();
const _wCb    = new THREE.Vector3();
const _wAb    = new THREE.Vector3();
const _wForce = new THREE.Vector3();

// Particle (flagwaver/physics/Particle.js)
class FWParticle {
  constructor(pos, mass) {
    this.position     = pos.clone();
    this.previous     = pos.clone();
    this.original     = pos.clone();
    this.inverseMass  = 1 / mass;
    this.acceleration = new THREE.Vector3();
    this.tmp          = new THREE.Vector3();
  }
  applyForce(f) {
    this.acceleration.addScaledVector(f, this.inverseMass);
  }
  integrate(dt2) {
    const t = this.tmp
      .subVectors(this.position, this.previous)
      .multiplyScalar(FW_DRAG)
      .add(this.position)
      .addScaledVector(this.acceleration, dt2);
    this.tmp = this.previous;
    this.previous = this.position;
    this.position = t;
    this.acceleration.set(0, 0, 0);
  }
}

// Constraint (flagwaver/physics/Constraint.js)
class FWConstraint {
  constructor(p1, p2, rest) { this.p1 = p1; this.p2 = p2; this.restDistance = rest; }
  resolve() {
    _cDiff.subVectors(this.p2.position, this.p1.position);
    const d = _cDiff.length();
    if (d === 0) return;
    const c = _cDiff.multiplyScalar((1 - this.restDistance / d) / 2);
    this.p1.position.add(c);
    this.p2.position.sub(c);
  }
}

// Cloth (flagwaver/physics/Cloth.js — BufferGeometry instead of ParametricGeometry)
class FWCloth {
  constructor(xSegs, ySegs, restDist, mass) {
    const NX = xSegs + 1, NY = ySegs + 1, N = NX * NY;
    const pm = mass / N;
    const p  = new THREE.Vector3();
    const particles = [], constraints = [];
    const at = (u, v) => particles[u + v * NX];

    for (let v = 0; v < NY; v++)
      for (let u = 0; u < NX; u++)
        particles.push(new FWParticle(p.set(u * restDist, v * restDist, 0), pm));

    // Structural constraints (flagwaver/physics/Cloth.js)
    for (let v = 0; v < ySegs; v++)
      for (let u = 0; u < xSegs; u++) {
        constraints.push(new FWConstraint(at(u, v), at(u, v + 1), restDist));
        constraints.push(new FWConstraint(at(u, v), at(u + 1, v), restDist));
      }
    for (let v = 0; v < ySegs; v++) constraints.push(new FWConstraint(at(xSegs, v), at(xSegs, v + 1), restDist));
    for (let u = 0; u < xSegs; u++) constraints.push(new FWConstraint(at(u, ySegs), at(u + 1, ySegs), restDist));

    // Shear constraints
    const dd = Math.SQRT2 * restDist;
    for (let v = 0; v < ySegs; v++)
      for (let u = 0; u < xSegs; u++) {
        constraints.push(new FWConstraint(at(u, v),     at(u + 1, v + 1), dd));
        constraints.push(new FWConstraint(at(u + 1, v), at(u, v + 1),     dd));
      }

    // BufferGeometry — vertex layout matches particles: index = u + v*NX
    const posArr = new Float32Array(N * 3);
    const uvArr  = new Float32Array(N * 2);
    for (let v = 0; v < NY; v++)
      for (let u = 0; u < NX; u++) {
        const i = u + v * NX;
        posArr[i*3] = u * restDist; posArr[i*3+1] = v * restDist;
        uvArr[i*2]  = u / xSegs;   uvArr[i*2+1]  = v / ySegs;
      }
    const geo = new THREE.BufferGeometry();
    const pa  = new THREE.BufferAttribute(posArr, 3);
    pa.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', pa);
    geo.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));

    const idx = [];
    for (let v = 0; v < ySegs; v++)
      for (let u = 0; u < xSegs; u++) {
        const bl = u + v*NX, br = (u+1) + v*NX;
        const tl = u + (v+1)*NX, tr = (u+1) + (v+1)*NX;
        idx.push(bl, br, tl,  br, tr, tl);
      }
    geo.setIndex(new THREE.BufferAttribute(new Uint16Array(idx), 1));
    geo.computeVertexNormals();

    this.xSegs = xSegs; this.ySegs = ySegs; this.NX = NX;
    this.restDistance = restDist;
    this.width = xSegs * restDist; this.height = ySegs * restDist;
    this.particles = particles; this.constraints = constraints;
    this.particleAt = at; this.geometry = geo; this._posAttr = pa;
  }

  simulate(dt) {
    const dt2 = dt * dt;
    const { particles, constraints } = this;
    for (let i = 0; i < particles.length; i++) particles[i].integrate(dt2);
    for (let n = 0; n < FW_ITER; n++)
      for (let i = 0; i < constraints.length; i++) constraints[i].resolve();
  }

  render() {
    const { particles, _posAttr } = this;
    const arr = _posAttr.array;
    for (let i = 0; i < particles.length; i++) {
      arr[i*3] = particles[i].position.x;
      arr[i*3+1] = particles[i].position.y;
      arr[i*3+2] = particles[i].position.z;
    }
    _posAttr.needsUpdate = true;
    this.geometry.computeVertexNormals();
  }
}

// applyWindForceToCloth (flagwaver/interactions/applyWindForceToCloth.js)
// windPressure must already be in cloth-local space
function fwWind(cloth, windPressure) {
  const { particles, geometry, restDistance } = cloth;
  const idx = geometry.getIndex();
  const faceArea = restDistance * restDistance / 2;
  _wForce.copy(windPressure).multiplyScalar(FW_Cd * faceArea / 3);
  for (let i = 0, ii = idx.count; i < ii; i += 3) {
    const pA = particles[idx.getX(i)], pB = particles[idx.getX(i+1)], pC = particles[idx.getX(i+2)];
    _wCb.subVectors(pC.position, pB.position);
    _wAb.subVectors(pA.position, pB.position);
    _wCb.cross(_wAb).normalize();
    _wCb.multiplyScalar(_wCb.dot(_wForce));
    pA.applyForce(_wCb);
    pB.applyForce(_wCb);
    pC.applyForce(_wCb);
  }
}

// ── FLAG 3D (initFlag / destroyFlag) ──

// Preload sky.jpg once so it's in the browser cache before user opens flag tab
(function() { const s = new Image(); s.src = 'data/sky.jpg'; })();

// Shared texture painter used by both initFlag and initHeroFlag.
// source    — HTMLImageElement or HTMLCanvasElement to draw onto the flag
// ctx       — CanvasRenderingContext2D of the flag texture canvas
// texture   — THREE.CanvasTexture to mark needsUpdate
// rendererEl — renderer.domElement to add 'flag-ready' class
// skeletonEl — (optional) skeleton div to remove; pass null for hero flag
function paintFlagTexture(source, ctx, texture, rendererEl, skeletonEl) {
  // Find most frequent color — quantize into 32-step buckets, pick winner
  const sc = document.createElement('canvas'); sc.width = sc.height = 32;
  const sx = sc.getContext('2d'); sx.drawImage(source, 0, 0, 32, 32);
  const px = sx.getImageData(0, 0, 32, 32).data;
  const buckets = {};
  for (let i = 0; i < px.length; i += 4) {
    if (px[i+3] < 200) continue;
    const r = px[i], g = px[i+1], b = px[i+2];
    const max = Math.max(r,g,b)/255, min = Math.min(r,g,b)/255;
    const l = (max+min)/2;
    const sv = max===min ? 0 : (max-min)/(1-Math.abs(2*l-1));
    if (l > 0.88 || l < 0.12 || sv < 0.12) continue;
    const key = `${r>>5},${g>>5},${b>>5}`;
    if (!buckets[key]) buckets[key] = { r, g, b, n: 0 };
    buckets[key].n++;
  }
  let best = null;
  for (const k in buckets) if (!best || buckets[k].n > best.n) best = buckets[k];
  const isJpg = /\.(jpg|jpeg)/i.test(source.src || '');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 900, 600);
  if (!isJpg && best) { ctx.fillStyle = `rgb(${best.r},${best.g},${best.b})`; ctx.fillRect(0, 0, 900, 600); }
  const sz = 500;
  ctx.drawImage(source, (900 - sz) / 2, (600 - sz) / 2, sz, sz);
  texture.needsUpdate = true;
  // Remove skeleton (modal flag only) and fade canvas in
  if (skeletonEl) skeletonEl.remove();
  if (rendererEl) {
    rendererEl.classList.add('flag-ready');
  }
}

function initFlag(imageUrl) {
  const wrap = document.getElementById('flag-canvas-wrap');
  wrap.innerHTML = '';
  // Add shimmer skeleton while coat image loads
  const skeleton = document.createElement('div');
  skeleton.className = 'flag-skeleton';
  wrap.appendChild(skeleton);
  cancelAnimationFrame(flagAnimId);
  if (flagRenderer) { flagRenderer.dispose(); flagRenderer = null; }
  if (flagGeo)      { flagGeo = null; }
  if (flagMat)      { flagMat.dispose(); flagMat = null; }
  if (flagTexture)  { flagTexture.dispose(); flagTexture = null; }

  const rect = wrap.getBoundingClientRect();
  const W = rect.width  || 520;
  const H = rect.height || 400;

  // ── Scene (transparent — CSS sky shows through) ──
  const scene = new THREE.Scene();

  // ── Camera — centered on flag (pole may be clipped, that's fine) ──
  // Flag center in world space:
  //   local center (0.9, -0.6) rotated -45° → (0.212, -1.060)
  //   + flagObj position (4.24, 4.24) → world (4.45, 3.18, 0)
  // Flag world span: X [3.39..5.51], Y [2.12..4.24] — ~2.12×2.12
  // At distance 5.5, FOV 32° → half-height = 5.5·tan(16°) ≈ 1.58 (flag half ≈ 1.06)
  const isMobile = window.innerWidth <= 640;
  const camera = new THREE.PerspectiveCamera(32, W / H, 0.1, 100);
  camera.position.set(4.45, 3.18, isMobile ? 8.0 : 5.5);
  camera.lookAt(4.45, 3.18, 0);

  // ── Renderer (transparent — CSS sky gradient shows through) ──
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(W, H);
  renderer.physicallyCorrectLights = true;
  renderer.outputEncoding = THREE.sRGBEncoding;
  wrap.appendChild(renderer.domElement);
  flagRenderer = renderer;

  // ── Flag defaults (Flag.defaults + Flagpole.defaults) ──
  // OutriggerFlagpole rotates by Math.PI * 7/4 = -45°
  const POLE_ANGLE  = Math.PI * 7 / 4;  // -45°
  const POLE_LENGTH = 6;                 // Flagpole.defaults.poleLength
  const FLAG_W = 1.8, FLAG_H = 1.2;
  const REST   = FLAG_H / 16;           // 0.075 — restDistance
  const NX = Math.round(FLAG_W / REST); // 24
  const NY = Math.round(FLAG_H / REST); // 16
  const MASS = 0.08 * FLAG_W * FLAG_H;  // 0.08 kg/m² × area

  // ── Cloth simulation ──
  const cloth = new FWCloth(NX, NY, REST, MASS);

  // Pin left edge — Flag.defaults.pin: edges:[Side.LEFT]
  const pins = [];
  for (let v = 0; v <= NY; v++) pins.push(cloth.particleAt(0, v));

  // Z jitter to break cloth symmetry
  for (let i = 0; i < cloth.particles.length; i++) {
    if (i % cloth.NX !== 0) {
      const z = (Math.random() - 0.5) * 0.04;
      cloth.particles[i].position.z = z;
      cloth.particles[i].previous.z = z;
    }
  }

  // ── Pole top world position ──
  // OutriggerFlagpole: this.top = new Vector3(0, poleLength, 0).applyAxisAngle(Z, POLE_ANGLE)
  // (0, 6, 0) rotated by -45°: x = 6·sin(45°), y = 6·cos(45°) ≈ (4.243, 4.243, 0)
  const c45 = Math.SQRT2 / 2;
  const poleTopX = POLE_LENGTH * c45;
  const poleTopY = POLE_LENGTH * c45;

  // ── Flag texture ──
  const texCanvas = document.createElement('canvas');
  texCanvas.width = 900; texCanvas.height = 600;
  const ctx = texCanvas.getContext('2d');
  ctx.fillStyle = '#f0f0f0'; ctx.fillRect(0, 0, 900, 600);
  flagTexture = new THREE.CanvasTexture(texCanvas);
  flagTexture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  flagTexture.encoding = THREE.sRGBEncoding;

  // Fast path: reuse the already-decoded modal image (no extra network request)
  const modalImg = document.getElementById('modal-img');
  if (modalImg.complete && modalImg.naturalWidth > 0) {
    paintFlagTexture(modalImg, ctx, flagTexture, renderer.domElement, skeleton);
  } else {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => paintFlagTexture(img, ctx, flagTexture, renderer.domElement, skeleton);
    img.onerror = () => { skeleton.remove(); if (renderer.domElement) renderer.domElement.classList.add('flag-ready'); };
    img.src = imageUrl;
  }

  // ── Flag mesh + Object3D ──
  // OutriggerFlagpole.addFlag: flag.object.rotateZ(POLE_ANGLE) + position.add(this.top)
  flagGeo = cloth.geometry;
  flagMat = new THREE.MeshStandardMaterial({
    map: flagTexture, side: THREE.DoubleSide,
    metalness: 0.0, roughness: 0.65
  });
  const flagMesh = new THREE.Mesh(flagGeo, flagMat);
  flagMesh.position.set(0, -cloth.height, 0); // Flag.js: mesh.position.set(0, -cloth.height, 0)

  const flagObj = new THREE.Object3D();
  flagObj.rotation.z = POLE_ANGLE;
  flagObj.position.set(poleTopX, poleTopY, 0);
  flagObj.add(flagMesh);
  scene.add(flagObj);

  // ── Pole (OutriggerFlagpole geometry — CylinderGeometry, rotated -45°) ──
  // poleWidth: 0.076 → poleRadius: 0.038; poleCapSize = poleWidth * 4/3
  const poleR = 0.038;
  const capR  = poleR * 4 / 3;
  const poleMat = new THREE.MeshStandardMaterial({ color: 0xd4d8dc, metalness: 0.92, roughness: 0.18, envMapIntensity: 1.2 });

  const poleGeo = new THREE.CylinderGeometry(poleR, poleR, POLE_LENGTH, 32);
  poleGeo.translate(0, POLE_LENGTH / 2, 0);
  poleGeo.rotateZ(POLE_ANGLE);
  scene.add(new THREE.Mesh(poleGeo, poleMat));

  const capGeo = new THREE.CylinderGeometry(capR, capR, capR, 32);
  capGeo.translate(0, POLE_LENGTH + capR / 2, 0);
  capGeo.rotateZ(POLE_ANGLE);
  scene.add(new THREE.Mesh(capGeo, poleMat));

  // ── Lights ──
  scene.add(new THREE.AmbientLight(0xdce8f0, 2.2));
  const sun = new THREE.DirectionalLight(0xfff8ee, 1.6);
  sun.position.set(8, 40, 30);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xd0e8ff, 1.0);
  fill.position.set(-10, 20, -20);
  scene.add(fill);

  // ── Force localization (flagwaver interactions/utils/localizeForce.js) ──
  // The flag Object3D is rotated by POLE_ANGLE = -45°.
  // localizeForce transforms world-space vectors into the object's local space
  // by applying the inverse rotation (+45°). For a pure Z-rotation:
  //   local = R(-POLE_ANGLE) * world  [i.e. rotate world vector by +45°]
  //
  // World gravity (0, -G, 0) → local:
  //   x =  G·sin(45°) ≈ +6.936   (pulls cloth toward fly end — natural drape)
  //   y = -G·cos(45°) ≈ -6.936   (pulls cloth downward in local frame)
  const localGrav = new THREE.Vector3(FW_G * c45, -FW_G * c45, 0);

  // Wind pressure (world-space), localized per-frame
  const windDir = new THREE.Vector3(2000, 0.001, 1000).normalize(); // WindModifiers.blowFromLeftDirection
  const windPressure = new THREE.Vector3();
  const localWind    = new THREE.Vector3();

  let lastTime = -1, accum = 0;

  function animate(ts) {
    flagAnimId = requestAnimationFrame(animate);
    if (lastTime < 0) { lastTime = ts; return; }
    const delta = Math.min((ts - lastTime) * 0.001, 0.05);
    lastTime = ts;

    // Wind: WindModifiers.variableSpeed — speed * (1 + 0.25·cos(time/7000))
    const speed = 7 * (1 + 0.15 * Math.cos(Date.now() / 9000));
    windPressure.copy(windDir).multiplyScalar(0.5 * FW_RHO * speed * speed);

    // Localize wind: rotate world wind by +45° in XY
    localWind.set(
      windPressure.x * c45 - windPressure.y * c45,
      windPressure.x * c45 + windPressure.y * c45,
      windPressure.z
    );

    accum += delta;
    let steps = 0;
    while (accum >= FW_DT && steps < 2) {
      // applyGravityToCloth — direct add to acceleration (mass-independent)
      const { particles } = cloth;
      for (let i = 0; i < particles.length; i++) particles[i].acceleration.add(localGrav);

      // applyWindForceToCloth (with localized wind pressure)
      fwWind(cloth, localWind);

      cloth.simulate(FW_DT);

      // Pin snapping — Flag.simulate()
      for (let i = 0; i < pins.length; i++) {
        const p = pins[i];
        p.previous.copy(p.position.copy(p.original));
      }

      accum -= FW_DT;
      steps++;
    }

    cloth.render();
    renderer.render(scene, camera);
  }

  animate(performance.now());
}

function destroyFlag() {
  cancelAnimationFrame(flagAnimId);
  flagAnimId = null;
  if (flagRenderer) { flagRenderer.dispose(); flagRenderer = null; }
  if (flagGeo)      { flagGeo.dispose();      flagGeo = null; }
  if (flagMat)      { flagMat.dispose();       flagMat = null; }
  if (flagTexture)  { flagTexture.dispose();   flagTexture = null; }
  document.getElementById('flag-canvas-wrap').innerHTML = '';
}

// ── HERO FLAG (initHeroFlag / destroyHeroFlag) ──

let heroRenderer = null, heroAnimId = null;
let heroGeo = null, heroMat = null, heroTexture = null;
let todaysPick = null;

function getTodaysPick(data) {
  const hiRes = data.filter(d => d.image_format === 'svg');
  const day = Math.floor(Date.now() / 86400000);
  return hiRes[day % hiRes.length];
}

function initHeroFlag(imageUrl) {
  const wrap = document.getElementById('hero-flag-wrap');
  wrap.innerHTML = '';
  destroyHeroFlag();
  const rect = wrap.getBoundingClientRect();
  const W = rect.width  || window.innerWidth;
  const H = rect.height || 300;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(46, W / H, 0.1, 100);
  camera.position.set(4.45, 3.18, 3.4);
  camera.lookAt(4.45, 3.18, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(W, H);
  renderer.physicallyCorrectLights = true;
  renderer.outputEncoding = THREE.sRGBEncoding;
  wrap.appendChild(renderer.domElement);
  heroRenderer = renderer;

  const POLE_ANGLE = Math.PI * 7 / 4;
  const POLE_LENGTH = 6;
  const FLAG_W = 1.8, FLAG_H = 1.2;
  const REST = FLAG_H / 16;
  const NX = Math.round(FLAG_W / REST);
  const NY = Math.round(FLAG_H / REST);
  const MASS = 0.08 * FLAG_W * FLAG_H;
  const cloth = new FWCloth(NX, NY, REST, MASS);
  const pins = [];
  for (let v = 0; v <= NY; v++) pins.push(cloth.particleAt(0, v));
  for (let i = 0; i < cloth.particles.length; i++) {
    if (i % cloth.NX !== 0) {
      const z = (Math.random() - 0.5) * 0.04;
      cloth.particles[i].position.z = z;
      cloth.particles[i].previous.z = z;
    }
  }

  const c45 = Math.SQRT2 / 2;
  const poleTopX = POLE_LENGTH * c45;
  const poleTopY = POLE_LENGTH * c45;

  const texCanvas = document.createElement('canvas');
  texCanvas.width = 900; texCanvas.height = 600;
  const ctx = texCanvas.getContext('2d');
  ctx.fillStyle = '#1a2040'; ctx.fillRect(0, 0, 900, 600);
  heroTexture = new THREE.CanvasTexture(texCanvas);
  heroTexture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  heroTexture.encoding = THREE.sRGBEncoding;

  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => paintFlagTexture(img, ctx, heroTexture, renderer.domElement, null);
  img.onerror = () => { if (renderer.domElement) renderer.domElement.classList.add('flag-ready'); };
  img.src = imageUrl;

  heroGeo = cloth.geometry;
  heroMat = new THREE.MeshStandardMaterial({ map: heroTexture, side: THREE.DoubleSide, metalness: 0.0, roughness: 0.65 });
  const flagMesh = new THREE.Mesh(heroGeo, heroMat);
  flagMesh.position.set(0, -cloth.height, 0);
  const flagObj = new THREE.Object3D();
  flagObj.rotation.z = POLE_ANGLE;
  flagObj.position.set(poleTopX, poleTopY, 0);
  flagObj.add(flagMesh);
  scene.add(flagObj);

  const poleR = 0.038, capR = poleR * 4 / 3;
  const poleMat = new THREE.MeshStandardMaterial({ color: 0xd4d8dc, metalness: 0.92, roughness: 0.18, envMapIntensity: 1.2 });
  const poleGeo = new THREE.CylinderGeometry(poleR, poleR, POLE_LENGTH, 32);
  poleGeo.translate(0, POLE_LENGTH / 2, 0);
  poleGeo.rotateZ(POLE_ANGLE);
  scene.add(new THREE.Mesh(poleGeo, poleMat));
  const capGeo = new THREE.CylinderGeometry(capR, capR, capR, 32);
  capGeo.translate(0, POLE_LENGTH + capR / 2, 0);
  capGeo.rotateZ(POLE_ANGLE);
  scene.add(new THREE.Mesh(capGeo, poleMat));

  scene.add(new THREE.AmbientLight(0xdce8f0, 2.2));
  const sun = new THREE.DirectionalLight(0xfff8ee, 1.6);
  sun.position.set(8, 40, 30);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xd0e8ff, 1.0);
  fill.position.set(-10, 20, -20);
  scene.add(fill);

  const localGrav = new THREE.Vector3(FW_G * c45, -FW_G * c45, 0);
  const windDir = new THREE.Vector3(2000, 0.001, 1000).normalize();
  const windPressure = new THREE.Vector3();
  const localWind = new THREE.Vector3();
  let lastTime = -1, accum = 0;

  function heroAnimate(ts) {
    heroAnimId = requestAnimationFrame(heroAnimate);
    if (lastTime < 0) { lastTime = ts; return; }
    const delta = Math.min((ts - lastTime) * 0.001, 0.05);
    lastTime = ts;
    const speed = 7 * (1 + 0.15 * Math.cos(Date.now() / 9000));
    windPressure.copy(windDir).multiplyScalar(0.5 * FW_RHO * speed * speed);
    localWind.set(
      windPressure.x * c45 - windPressure.y * c45,
      windPressure.x * c45 + windPressure.y * c45,
      windPressure.z
    );
    accum += delta;
    let steps = 0;
    while (accum >= FW_DT && steps < 2) {
      const { particles } = cloth;
      for (let i = 0; i < particles.length; i++) particles[i].acceleration.add(localGrav);
      fwWind(cloth, localWind);
      cloth.simulate(FW_DT);
      for (let i = 0; i < pins.length; i++) {
        const p = pins[i];
        p.previous.copy(p.position.copy(p.original));
      }
      accum -= FW_DT;
      steps++;
    }
    cloth.render();
    renderer.render(scene, camera);
  }

  heroAnimate(performance.now());
}

function destroyHeroFlag() {
  cancelAnimationFrame(heroAnimId);
  heroAnimId = null;
  if (heroRenderer) { heroRenderer.dispose(); heroRenderer = null; }
  if (heroGeo)      { heroGeo = null; }
  if (heroMat)      { heroMat.dispose(); heroMat = null; }
  if (heroTexture)  { heroTexture.dispose(); heroTexture = null; }
}

// ── MAP ──
let mapInstance = null;

function initMap(name, parent, country) {
  if (mapInstance) { mapInstance.remove(); mapInstance = null; }

  const nominatim = (q) =>
    fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`, {
      headers: { 'Accept-Language': 'en', 'User-Agent': 'GerbariumApp/1.0' }
    }).then(r => r.json()).then(data => data.length ? data[0] : null);

  // Fallback chain: specific → parent city → country
  nominatim(`${name}, ${parent}, ${country}`)
    .then(r => r || nominatim(`${parent}, ${country}`))
    .then(r => r || nominatim(country))
    .then(result => {
      if (!result) return;
      const lat = parseFloat(result.lat), lon = parseFloat(result.lon);
      // Zoom: tightest for exact match, wider for fallbacks
      const zoom = result.display_name.toLowerCase().includes(name.toLowerCase()) ? 9 :
                   result.display_name.toLowerCase().includes(parent.toLowerCase()) ? 6 : 3;
      mapInstance = L.map('modal-map', {
        center: [lat, lon], zoom,
        zoomControl: false, attributionControl: false,
        scrollWheelZoom: false, dragging: false
      });
      const tileLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        subdomains: 'abcd', maxZoom: 19
      }).addTo(mapInstance);
      tileLayer.on('load', () => {
        document.getElementById('modal-map').classList.add('map-loaded');
      });
      // Only show pin for exact/city-level matches
      if (zoom >= 6) {
        L.circleMarker([lat, lon], {
          radius: 7, fillColor: '#007aff', color: '#fff',
          weight: 2.5, fillOpacity: 1
        }).addTo(mapInstance);
      }
    })
    .catch(() => {});
}

function destroyMap() {
  if (mapInstance) { mapInstance.remove(); mapInstance = null; }
}

// ── HERO CARD ──
function initHero(data) {
  todaysPick = getTodaysPick(data);
}

function renderHeroCard() {
  destroyHeroFlag();
  const d = todaysPick;
  const heroCard = document.createElement('div');
  heroCard.className = 'hero-card';
  heroCard.id = 'hero-card';
  heroCard.innerHTML = `
    <div class="hero-flag-wrap" id="hero-flag-wrap"></div>
    <div class="hero-card-info">
      <div class="hero-eyebrow">Today's Pick</div>
      <div class="hero-card-name">${esc(d.name)}</div>
      <div class="hero-card-sub">${d.parent !== d.country ? esc(d.parent) + ' · ' + esc(d.country) : esc(d.country)}</div>
    </div>`;
  heroCard.addEventListener('click', () => openModal(d));
  return heroCard;
}

// ── LIKES ──
function getLikesData() {
  try { return JSON.parse(localStorage.getItem('gerbarium_likes') || '{}'); } catch { return {}; }
}
function getLikedSet() {
  try { return new Set(JSON.parse(localStorage.getItem('gerbarium_liked') || '[]')); } catch { return new Set(); }
}
function getLikeCount(name) { return getLikesData()[name] || 0; }
function hasLiked(name) { return getLikedSet().has(name); }
function toggleLike(name) {
  const data = getLikesData();
  const liked = getLikedSet();
  if (liked.has(name)) {
    liked.delete(name);
    data[name] = Math.max(0, (data[name] || 1) - 1);
  } else {
    liked.add(name);
    data[name] = (data[name] || 0) + 1;
  }
  localStorage.setItem('gerbarium_likes', JSON.stringify(data));
  localStorage.setItem('gerbarium_liked', JSON.stringify([...liked]));
  return liked.has(name);
}
function syncCardLike(btn, name) {
  if (!btn) return;
  const liked = hasLiked(name);
  const count = getLikeCount(name);
  btn.classList.toggle('liked', liked);
  const countEl = btn.querySelector('.card-like-count');
  if (countEl) countEl.textContent = count > 0 ? count : '';
}
function syncModalLike(name) {
  const liked = hasLiked(name);
  const count = getLikeCount(name);
  const btn = document.getElementById('modal-like');
  const mBtn = document.getElementById('mobile-like');
  if (btn) {
    btn.classList.toggle('liked', liked);
    const countEl = document.getElementById('modal-like-count');
    if (countEl) countEl.textContent = count;
  }
  if (mBtn) {
    mBtn.classList.toggle('liked', liked);
    const mCountEl = document.getElementById('mobile-like-count');
    if (mCountEl) mCountEl.textContent = count;
  }
}

// ── MODAL ──
// Tab switching — delegated to #modal so both desktop and mobile tabs work
document.getElementById('modal').addEventListener('click', e => {
  const tab = e.target.closest('.modal-tab');
  if (!tab) return;
  switchView(tab.dataset.tab);
});

function switchView(which) {
  document.querySelectorAll('.modal-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === which));
  document.getElementById('view-image').classList.toggle('hidden', which !== 'image');
  document.getElementById('view-flag').classList.toggle('hidden', which !== 'flag');
  document.querySelector('.modal-left').classList.toggle('tab-flag', which === 'flag');
  if (which === 'flag') {
    const src = document.getElementById('modal-img').src;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const wrap = document.getElementById('flag-canvas-wrap');
      const rect = wrap.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) initFlag(src);
      else setTimeout(() => initFlag(src), 100);
    }));
  } else {
    destroyFlag();
  }
}

function openModal(d) {
  document.getElementById('modal-img').src = d.image_path || d.image_url;
  document.getElementById('modal-img').alt = d.name;

  const adminLabel = {
    municipal_okrug: 'Municipal Okrug', city_district: 'City District', rayon: 'Rayon',
    city: 'City', federal_city: 'Federal City', village: 'Village', region: 'Region',
    republic: 'Republic', oblast: 'Oblast', krai: 'Krai', state: 'State',
    autonomous_okrug: 'Autonomous Okrug', autonomous_oblast: 'Autonomous Oblast',
    country: 'Country',
  }[d.admin_type] ?? d.admin_type;
  const fullName = `${d.name} ${adminLabel}`;
  const showRegion = d.parent !== d.country;

  // Desktop info panel
  document.getElementById('modal-name').textContent = fullName;
  document.getElementById('modal-eyebrow').textContent = showRegion ? d.parent + ' · ' + d.country : d.country;
  const regionRow = showRegion
    ? `<div class="modal-row"><div class="modal-label">Region</div><div class="modal-value">${esc(d.parent)}</div></div>`
    : '';
  document.getElementById('modal-rows').innerHTML =
    `<div class="modal-row"><div class="modal-label">Type</div><div class="modal-value">${esc(adminLabel)}</div></div>` +
    regionRow +
    `<div class="modal-row"><div class="modal-label">Country</div><div class="modal-value">${esc(d.country)}</div></div>`;

  const wikiSlug = encodeURIComponent(d.admin_type === 'rayon' ? `${d.name} rayon, ${d.parent}` : d.name);
  const wikiUrl = `https://en.wikipedia.org/wiki/${wikiSlug}`;
  document.getElementById('modal-wiki').href = wikiUrl;

  // Desktop download + copy
  const dlBtn = document.getElementById('modal-download');
  dlBtn.href = d.image_path || d.image_url;
  dlBtn.download = d.name.toLowerCase().replace(/\s+/g, '_') + '.' + (d.image_format || 'png');
  const copyBtn = document.getElementById('modal-copy');
  const copyLabel = document.getElementById('copy-label');
  copyBtn.onclick = () => {
    navigator.clipboard.writeText(location.href).then(() => {
      copyBtn.classList.add('success'); copyLabel.textContent = 'Copied!';
      setTimeout(() => { copyBtn.classList.remove('success'); copyLabel.textContent = 'Copy URL'; }, 2000);
    });
  };

  // Mobile body
  document.getElementById('mobile-eyebrow').textContent = showRegion ? d.parent + ' · ' + d.country : d.country;
  document.getElementById('mobile-name').textContent = fullName;
  const mDl = document.getElementById('mobile-download');
  mDl.href = d.image_path || d.image_url;
  mDl.download = dlBtn.download;
  document.getElementById('mobile-wiki').href = wikiUrl;
  const mobileCopy = document.getElementById('mobile-copy');
  if (mobileCopy) mobileCopy.onclick = () => {
    navigator.clipboard.writeText(location.href).then(() => {
      mobileCopy.classList.add('icon-success');
      setTimeout(() => mobileCopy.classList.remove('icon-success'), 2000);
    });
  };

  // Mobile overlay more menu
  const mDlMenu = document.getElementById('mobile-download-menu');
  if (mDlMenu) { mDlMenu.href = d.image_path || d.image_url; mDlMenu.download = dlBtn.download; }
  const mWikiMenu = document.getElementById('mobile-wiki-menu');
  if (mWikiMenu) mWikiMenu.href = wikiUrl;
  const moreBtn = document.getElementById('mobile-more');
  const moreMenu = document.getElementById('mobile-more-menu');
  if (moreBtn && moreMenu) moreBtn.onclick = (e) => {
    e.stopPropagation();
    moreMenu.classList.toggle('open');
  };
  const mCopyMenu = document.getElementById('mobile-copy-menu');
  if (mCopyMenu) mCopyMenu.onclick = () => {
    navigator.clipboard.writeText(location.href).then(() => {
      mCopyMenu.querySelector('svg').style.display = 'none';
      const prev = mCopyMenu.childNodes[mCopyMenu.childNodes.length - 1];
      prev.textContent = 'Copied!';
      setTimeout(() => { mCopyMenu.querySelector('svg').style.display = ''; prev.textContent = ' Copy Link'; }, 2000);
    });
    moreMenu.classList.remove('open');
  };

  // Like button (desktop only on mobile-less layout)
  const likeName = d.name;
  syncModalLike(likeName);
  document.getElementById('modal-like').onclick = () => { toggleLike(likeName); syncModalLike(likeName); };
  const mobileLikeBtn = document.getElementById('mobile-like');
  if (mobileLikeBtn) mobileLikeBtn.onclick = () => { toggleLike(likeName); syncModalLike(likeName); };

  // Reset to image view
  switchView('image');

  history.pushState({ name: d.name }, '', '/' + encodeURIComponent(d.name));
  document.getElementById('backdrop').classList.add('open');
  document.body.style.overflow = 'hidden';
  document.getElementById('modal-map').classList.remove('map-loaded');
  setTimeout(() => initMap(d.name, d.parent, d.country), 320);

  // Desktop sidebar stagger
  const staggerEls = [
    document.getElementById('modal-eyebrow'),
    document.getElementById('modal-name'),
    document.getElementById('modal-rows'),
    document.getElementById('modal-map'),
    document.querySelector('.modal-footer'),
  ];
  staggerEls.forEach(el => { if (el) el.style.animation = 'none'; });
  document.querySelector('.modal-body').offsetHeight;
  staggerEls.forEach((el, i) => {
    if (!el) return;
    el.style.animation = `slideUp 0.46s ${0.05 + i * 0.055}s cubic-bezier(0.22,1,0.36,1) both`;
  });
}

function closeModal() {
  document.getElementById('backdrop').classList.remove('open');
  document.body.style.overflow = '';
  destroyFlag();
  destroyMap();
  switchView('image');
  history.pushState({}, '', '/');
}

// ── EVENTS ──
document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('backdrop').addEventListener('click', e => {
  if (e.target === document.getElementById('backdrop')) closeModal();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// ── Swipe down to close (mobile) ──
(function() {
  const modal = document.getElementById('modal');
  let startY = 0, currentY = 0, dragging = false;
  modal.addEventListener('touchstart', e => {
    // Only start swipe from header or when content is scrolled to top
    const header = document.getElementById('modal-mobile-header');
    const fromHeader = header && header.contains(e.target);
    const scrollable = e.target.closest('[style*="overflow"], .modal-left');
    const atTop = !scrollable || scrollable.scrollTop === 0;
    if (!fromHeader && !atTop) return;
    startY = e.touches[0].clientY;
    currentY = startY;
    dragging = true;
    modal.style.transition = 'none';
  }, { passive: true });
  modal.addEventListener('touchmove', e => {
    if (!dragging) return;
    currentY = e.touches[0].clientY;
    const dy = Math.max(0, currentY - startY);
    modal.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  modal.addEventListener('touchend', () => {
    if (!dragging) return;
    dragging = false;
    modal.style.transition = '';
    if (currentY - startY > 100) {
      closeModal();
      modal.style.transform = '';
    } else {
      modal.style.transform = '';
    }
  });
})();

// Back/forward button support
window.addEventListener('popstate', e => {
  if (e.state && e.state.name) {
    const item = allData.find(d => d.name === e.state.name);
    if (item) openModal(item);
  } else {
    document.getElementById('backdrop').classList.remove('open');
    document.body.style.overflow = '';
    destroyFlag();
    destroyMap();
    switchView('image');
  }
});

// About dropdown
const aboutBtn = document.getElementById('about-btn');
const aboutDropdown = document.getElementById('about-dropdown');
aboutBtn.addEventListener('click', e => {
  e.stopPropagation();
  aboutBtn.classList.toggle('open');
  aboutDropdown.classList.toggle('open');
});
document.addEventListener('click', () => {
  aboutBtn.classList.remove('open');
  aboutDropdown.classList.remove('open');
  document.querySelectorAll('.nav-dd').forEach(d => d.classList.remove('open'));
  document.querySelectorAll('.nav-dd-btn').forEach(b => b.classList.remove('open'));
  const menu = document.getElementById('mobile-more-menu');
  if (menu) menu.classList.remove('open');
});

// ── NAV DROPDOWNS ──
function setupDropdown(btnId, ddId, onSelect) {
  const btn = document.getElementById(btnId);
  const dd  = document.getElementById(ddId);
  btn.addEventListener('click', e => {
    e.stopPropagation();
    // Close sibling dropdowns
    document.querySelectorAll('.nav-dd').forEach(d => { if (d !== dd) d.classList.remove('open'); });
    document.querySelectorAll('.nav-dd-btn').forEach(b => { if (b !== btn) b.classList.remove('open'); });
    btn.classList.toggle('open');
    dd.classList.toggle('open');
  });
  dd.querySelectorAll('.nav-dd-item').forEach(item => {
    item.addEventListener('click', () => {
      dd.querySelectorAll('.nav-dd-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      btn.classList.remove('open');
      dd.classList.remove('open');
      onSelect(item);
    });
  });
}

setupDropdown('sort-btn', 'sort-dd', item => {
  activeSort = item.dataset.sort;
  document.getElementById('sort-label').textContent = item.dataset.btnLabel;
  document.getElementById('sort-btn').classList.toggle('active-filter', activeSort !== '');
  applyFilters();
});

setupDropdown('region-btn', 'region-dd', item => {
  activeRegion = item.dataset.region;
  document.getElementById('region-label').textContent = item.dataset.btnLabel;
  document.getElementById('region-btn').classList.toggle('active-filter', activeRegion !== 'all');
  applyFilters();
});

new IntersectionObserver(entries => {
  if (entries[0].isIntersecting && rendered < filtered.length) renderNext();
}, { rootMargin: '200px' }).observe(document.getElementById('sentinel'));
