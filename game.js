// ── STATE ──
let catalog = [];
let queue   = [];
let qIdx    = 0;
let answered = false;
let correctCount = 0, totalCount = 0, streak = 0, bestStreak = 0;

// ── BOOT ──
fetch('data/catalog.json')
  .then(r => r.json())
  .then(data => {
    // Only entries with a locally-downloaded image
    catalog = data.filter(d => d.image_path);
    shuffle(catalog);
    queue = [...catalog];
    nextQuestion();
  })
  .catch(() => {
    document.getElementById('game-opts').innerHTML =
      '<p style="text-align:center;color:var(--text-soft);padding:24px">Failed to load — check your connection.</p>';
  });

// ── HELPERS ──
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pickWrong(correct, n = 2) {
  // Prefer same region (makes the quiz harder and more educational)
  const sameParent  = catalog.filter(d => d !== correct && d.parent === correct.parent && d.name !== correct.name);
  const sameCountry = catalog.filter(d => d !== correct && d.country === correct.country && d.parent !== correct.parent && d.name !== correct.name);
  const other       = catalog.filter(d => d !== correct && d.name !== correct.name);

  const pool = [
    ...shuffle([...sameParent]),
    ...shuffle([...sameCountry]),
    ...shuffle([...other]),
  ];

  const seen = new Set([correct.name]);
  const result = [];
  for (const d of pool) {
    if (!seen.has(d.name)) {
      seen.add(d.name);
      result.push(d);
      if (result.length === n) break;
    }
  }
  return result;
}

// ── TRANSITIONS ──
function fadeCard(cb) {
  const card = document.getElementById('game-card');
  card.classList.add('fading');
  setTimeout(() => {
    cb();
    requestAnimationFrame(() => requestAnimationFrame(() => card.classList.remove('fading')));
  }, 180);
}

// ── QUESTION FLOW ──
function nextQuestion() {
  if (qIdx >= queue.length) {
    queue = shuffle([...catalog]);
    qIdx = 0;
  }
  const correct = queue[qIdx++];
  const wrong = pickWrong(correct, 2);
  if (wrong.length < 2) { nextQuestion(); return; }
  fadeCard(() => showQuestion(correct, shuffle([correct, ...wrong])));
}

function showQuestion(correct, options) {
  answered = false;

  // ── Image ──
  const img     = document.getElementById('game-img');
  const shimmer = document.getElementById('game-shimmer');
  img.classList.remove('loaded');
  shimmer.style.display = 'block';
  const src = correct.image_path || correct.image_url;
  img.onload  = () => { img.classList.add('loaded'); shimmer.style.display = 'none'; };
  img.onerror = () => { img.classList.add('loaded'); shimmer.style.display = 'none'; };
  img.src = src;
  if (img.complete && img.src.endsWith(src)) { img.classList.add('loaded'); shimmer.style.display = 'none'; }

  // ── Options ──
  const optsEl = document.getElementById('game-opts');
  optsEl.innerHTML = '';
  options.forEach((opt, i) => {
    const btn = document.createElement('button');
    btn.className = 'game-opt';
    btn.style.animationDelay = `${i * 45}ms`;
    btn.textContent = opt.name;
    if (opt === correct) btn.dataset.isCorrect = '1';
    btn.addEventListener('click', () => handleAnswer(btn, correct, optsEl));
    optsEl.appendChild(btn);
  });

  // ── Reset hint ──
  const hint = document.getElementById('game-hint');
  hint.textContent = '';
  hint.className = 'game-hint';
}

function handleAnswer(btn, correct, optsEl) {
  if (answered) return;
  answered = true;
  totalCount++;

  const isCorrect = btn.dataset.isCorrect === '1';

  if (isCorrect) {
    btn.classList.add('correct');
    correctCount++;
    streak++;
    if (streak > bestStreak) bestStreak = streak;
  } else {
    btn.classList.add('wrong');
    streak = 0;
    // Reveal correct answer
    optsEl.querySelectorAll('.game-opt[data-is-correct]').forEach(b => {
      b.classList.add('correct', 'reveal');
    });
  }

  optsEl.querySelectorAll('.game-opt').forEach(b => {
    b.disabled = true;
    b.classList.add('done');
  });

  // ── Hint: show location ──
  const loc = correct.parent !== correct.country
    ? `${correct.parent} · ${correct.country}`
    : correct.country;
  const hint = document.getElementById('game-hint');
  hint.textContent = loc;
  hint.className = 'game-hint visible';

  updateScore();
  setTimeout(nextQuestion, isCorrect ? 1300 : 2400);
}

// ── SCORE ──
function updateScore() {
  document.getElementById('stat-correct').textContent = correctCount;
  document.getElementById('stat-total').textContent   = totalCount;
  document.getElementById('stat-streak').textContent  = streak;

  const streakWrap = document.getElementById('streak-wrap');
  if (streak >= 2) streakWrap.removeAttribute('hidden');
  else streakWrap.setAttribute('hidden', '');

  // Stats row
  const pct = totalCount ? Math.round(correctCount / totalCount * 100) : 0;
  document.getElementById('display-pct').textContent    = totalCount ? pct + '%' : '—';
  document.getElementById('display-streak').textContent = bestStreak;
  document.getElementById('display-played').textContent = totalCount;
}
