/* WordKeep: vocabulary revision with automatic retesting. No server; progress lives in localStorage. */
(function () {
  'use strict';

  // ───────────────────────── data ─────────────────────────
  const W = window.WORDS.map(([word, meaning, sentence, group, seed], i) => ({ i, word, key: word.toLowerCase(), meaning, sentence, group, seed }));
  const BY = new Map(W.map((w) => [w.key, w]));
  const DAY = 86400000, MIN = 60000;
  const INTERVALS = [1, 3, 7, 14, 30]; // days until the next retest of a Mastered word: box 1..5
  const STORE = 'wordkeep.v1';
  const DEBUG = /[?&]debug/.test(location.search);
  let OFFSET = 0;
  const now = () => Date.now() + OFFSET;

  // ───────────────────────── helpers ─────────────────────────
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(kid));
    }
    return el;
  }
  const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const uid = () => Math.random().toString(36).slice(2, 10);
  const dayKey = (t) => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));

  // highlight the word (or its inflected form) in a sentence
  function sentenceNodes(w, blank) {
    const exact = new RegExp('\\b' + esc(w.word) + '\\b', 'gi');
    if (blank) return [w.sentence.replace(exact, '_______')];
    let re = exact;
    if (!exact.test(w.sentence)) { const stem = w.word.slice(0, Math.max(4, w.word.length - 2)); re = new RegExp('\\b' + esc(stem) + '\\w*', 'i'); }
    exact.lastIndex = 0;
    const out = []; let last = 0; let m;
    re.lastIndex = 0;
    const g = new RegExp(re.source, 'gi');
    while ((m = g.exec(w.sentence))) { out.push(w.sentence.slice(last, m.index)); out.push(h('strong', null, m[0])); last = m.index + m[0].length; if (!m[0]) g.lastIndex++; }
    out.push(w.sentence.slice(last));
    return out;
  }
  const canBlank = (w) => new RegExp('\\b' + esc(w.word) + '\\b', 'i').test(w.sentence);

  // ───────────────────────── state ─────────────────────────
  let S = load();
  function load() { try { const s = JSON.parse(localStorage.getItem(STORE)); return s && s.v === 1 ? s : null; } catch (e) { return null; } }
  function save() { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) { /* storage full or blocked */ } }
  function freshState(name, fromRootwork) {
    const t = now();
    const st = { v: 1, name: name || '', created: t, settings: { fresh: 10, session: 20 }, words: {}, days: {}, log: [] };
    if (fromRootwork) {
      for (const w of W) {
        if (w.seed === 'M') st.words[w.key] = { b: 'm', box: 1, due: t, seen: 1, right: 1, wrong: 0, last: t, prev: 'M' };
        else if (w.seed === 'W' || w.seed === 'H') st.words[w.key] = { b: 'w', box: 0, due: t, seen: 1, right: 0, wrong: 0, last: t, prev: w.seed };
      }
    }
    return st;
  }
  const ws = (state, key) => state.words[key];
  function counts(state, t) {
    t = t == null ? now() : t;
    let m = 0, wk = 0, dueW = 0, dueM = 0;
    for (const k in state.words) { const s = state.words[k]; if (!BY.has(k)) continue; if (s.b === 'm') { m++; if (s.due <= t) dueM++; } else { wk++; if (s.due <= t) dueW++; } }
    return { m, w: wk, n: W.length - m - wk, dueW, dueM, due: dueW + dueM };
  }
  function streakOf(state) {
    let d = now(); let n = 0;
    if (!(state.days[dayKey(d)] || {}).n) d -= DAY;
    while ((state.days[dayKey(d)] || {}).n) { n++; d -= DAY; }
    return n;
  }
  function weekStats(state) {
    let n = 0, ok = 0;
    for (let i = 0; i < 7; i++) { const d = state.days[dayKey(now() - i * DAY)]; if (d) { n += d.n; ok += d.ok; } }
    return { n, ok, pct: n ? Math.round((100 * ok) / n) : null };
  }

  // ───────────────────────── scheduling ─────────────────────────
  // Correct on a New/Working word  -> Mastered, retest in 1 day
  //   (unless it was just missed in this same session: it stays Working on and is due tomorrow)
  // Correct on a Mastered word that is due -> next box (retests after 1, 3, 7, 14, 30 days)
  // Wrong on anything -> Working on, shown again in this session and in the next one
  function answer(w, ok, type, sess) {
    const t = now(), dk = dayKey(t);
    let st = S.words[w.key];
    const day = (S.days[dk] = S.days[dk] || { n: 0, ok: 0, intro: 0 });
    if (!st) { st = S.words[w.key] = { b: 'w', box: 0, due: t, seen: 0, right: 0, wrong: 0, last: 0 }; day.intro++; }
    const wasDue = st.due <= t;
    st.seen++; st.last = t; st.lastType = type;
    let result;
    if (ok) {
      st.right++;
      if (st.b === 'm') {
        if (wasDue) { st.box = Math.min(5, st.box + 1); st.due = t + INTERVALS[st.box - 1] * DAY; result = 'kept'; } else result = 'kept-early';
      } else if (sess && st.missSess === sess.id) { st.due = t + DAY; result = 'confirm'; }
      else { st.b = 'm'; st.box = 1; st.due = t + DAY; result = 'promoted'; }
    } else {
      st.wrong++;
      result = st.b === 'm' ? 'demoted' : 'missed';
      st.b = 'w'; st.box = 0; st.due = t + 5 * MIN; st.missSess = sess ? sess.id : null;
    }
    day.n++; if (ok) day.ok++;
    S.log.push({ t, k: w.key, ok: ok ? 1 : 0, ty: type });
    if (S.log.length > 1500) S.log.splice(0, S.log.length - 1500);
    save();
    return result;
  }
  function planToday() {
    const t = now();
    const dueAll = W.filter((w) => { const s = S.words[w.key]; return s && s.due <= t; });
    const byDue = (a, b) => S.words[a.key].due - S.words[b.key].due;
    const dw = dueAll.filter((w) => S.words[w.key].b === 'w').sort(byDue);
    const dm = dueAll.filter((w) => S.words[w.key].b === 'm').sort(byDue);
    const cap = S.settings.session;
    // Mastered words due for retest get up to half the session; Working on words fill the rest
    const mTake = dm.slice(0, Math.ceil(cap / 2));
    const due = [...mTake, ...dw, ...dm.slice(mTake.length)].slice(0, cap);
    const introToday = (S.days[dayKey(t)] || {}).intro || 0;
    const room = Math.max(0, cap - due.length), quota = Math.max(0, S.settings.fresh - introToday);
    const fresh = W.filter((w) => !S.words[w.key]).slice(0, Math.min(room, quota));
    return { due, fresh, dueTotal: dueAll.length };
  }

  // ───────────────────────── questions ─────────────────────────
  function distractors(w, mode) {
    const picked = [];
    for (let tries = 0; picked.length < 40 && tries < 600; tries++) {
      const c = W[Math.floor(Math.random() * W.length)];
      if (c === w || picked.includes(c) || c.meaning === w.meaning) continue;
      if (c.key.slice(0, 4) === w.key.slice(0, 4)) continue; // same word family
      picked.push(c);
    }
    if (mode === 'meaning') {
      picked.sort((a, b) => Math.abs(a.meaning.length - w.meaning.length) - Math.abs(b.meaning.length - w.meaning.length));
      return shuffle(picked.slice(0, 10)).slice(0, 3);
    }
    return picked.slice(0, 3);
  }
  function makeQuestion(w, avoid) {
    const types = ['def', 'word']; if (canBlank(w)) types.push('blank');
    const pool = types.filter((t) => t !== avoid);
    const type = pick(pool.length ? pool : types);
    const opts = shuffle([w, ...distractors(w, type === 'def' ? 'meaning' : 'word')]);
    return { w, type, options: opts.map((o) => ({ w: o, text: type === 'def' ? o.meaning : o.word })), correct: opts.indexOf(w), done: null };
  }

  // ───────────────────────── ui state ─────────────────────────
  const ui = { view: 'today', session: null, cards: null, quiz: { pool: 'working', n: 10 }, words: { q: '', bucket: 'all', group: 'all', page: 1 }, viewing: null };
  const view = document.getElementById('view');
  function go(v) { ui.view = v; ui.viewing = null; render(); window.scrollTo(0, 0); }
  document.getElementById('tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-view]'); if (b) { if (b.dataset.view !== 'today' && ui.session && ui.session.stage === 'quiz' && !confirm('Leave this session? Your answers so far are saved.')) return; if (b.dataset.view !== 'today') ui.session = null; go(b.dataset.view); } });

  function render() {
    document.querySelectorAll('#tabs button').forEach((b) => { if (b.dataset.view === ui.view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    document.getElementById('hello').textContent = S && S.name ? 'Hi ' + S.name + '. Learn it. Keep it.' : 'Learn it. Keep it.';
    const sk = S ? streakOf(S) : 0;
    document.getElementById('streak').textContent = sk ? '🔥 ' + plural(sk, 'day') + ' in a row' : '';
    view.replaceChildren();
    if (!S) { view.append(welcome()); return; }
    const fn = { today: todayView, cards: cardsView, quiz: quizView, words: wordsView, progress: progressView }[ui.view];
    view.append(fn());
  }

  // ───────────────────────── welcome ─────────────────────────
  function welcome() {
    const name = h('input', { type: 'text', id: 'nm', placeholder: 'Name', autocomplete: 'off' });
    const seeded = W.filter((w) => w.seed).length;
    const mastered = W.filter((w) => w.seed === 'M').length;
    const opt = (id, val, checked, label, sub) => h('label', { class: 'check', style: 'align-items:flex-start' }, h('input', { type: 'radio', name: 'seed', id, value: val, checked }), h('span', null, label, h('br'), h('span', { class: 'muted', style: 'font-weight:400' }, sub)));
    return h('section', { class: 'panel' },
      h('h2', null, 'Welcome to WordKeep'),
      h('p', null, 'Each day you meet a few new words, answer quick multiple-choice questions, and get retested until the words stick.'),
      h('p', { class: 'muted' }, 'Right answer: the word moves to Mastered and comes back for a retest (1, 3, 7, 14, then 30 days later). Wrong answer: it goes to Working on and comes back soon.'),
      h('div', { class: 'field', style: 'margin:1rem 0' }, 'Who is learning?', name),
      opt('s1', 'rw', true, 'Continue from the earlier progress', `${mastered} words start as Mastered and ${seeded - mastered} as Working on. All of them get retested first.`),
      opt('s0', 'fresh', false, 'Start fresh', 'Every word starts as new.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'button', onclick: () => {
        const rw = document.querySelector('input[name=seed]:checked').value === 'rw';
        S = freshState(name.value.trim(), rw); save(); ui.view = 'today'; render();
      } }, 'Get started')));
  }

  // ───────────────────────── today ─────────────────────────
  function bucketBar(c) {
    const tot = W.length;
    return h('div', null,
      h('div', { class: 'seg', role: 'img', 'aria-label': `${c.m} mastered, ${c.w} working on, ${c.n} not yet seen` }, h('i', { class: 'm', style: `width:${(100 * c.m) / tot}%` }), h('i', { class: 'w', style: `width:${(100 * c.w) / tot}%` })),
      h('div', { class: 'legend' }, h('span', null, h('i', { class: 'dotk m' }), 'Mastered'), h('span', null, h('i', { class: 'dotk w' }), 'Working on'), h('span', null, h('i', { class: 'dotk n' }), 'Not yet seen')));
  }
  function statTiles(c) {
    return h('div', { class: 'stats' },
      h('div', { class: 'stat m' }, h('b', null, c.m), 'Mastered'),
      h('div', { class: 'stat w' }, h('b', null, c.w), 'Working on'),
      h('div', { class: 'stat' }, h('b', null, c.n), 'Not yet seen'));
  }
  function nextRetest() {
    let min = Infinity; for (const k in S.words) if (S.words[k].due < min) min = S.words[k].due;
    return min === Infinity ? null : min;
  }
  function todayView() {
    if (ui.session) return sessionView();
    const c = counts(S), plan = planToday();
    const total = plan.due.length + plan.fresh.length;
    const sec = h('section', { class: 'panel' }, h('h2', null, 'Your words'), statTiles(c), bucketBar(c));
    const day = S.days[dayKey(now())] || { n: 0, ok: 0 };
    const todayP = h('section', { class: 'panel' }, h('h2', null, 'Today'));
    if (total) {
      const dw = plan.due.filter((w) => S.words[w.key].b === 'w').length, dm = plan.due.length - dw;
      const parts = [];
      if (dw) parts.push(plural(dw, 'Working on word') + ' to practice');
      if (dm) parts.push(plural(dm, 'Mastered word') + ' to retest');
      if (plan.fresh.length) parts.push(plural(plan.fresh.length, 'new word'));
      todayP.append(h('p', null, parts.join(', '), '.'));
      if (plan.dueTotal > plan.due.length) todayP.append(h('p', { class: 'muted' }, `${plan.dueTotal - plan.due.length} more are due. They will be in the next sessions.`));
      todayP.append(h('div', { class: 'actions' }, h('button', { class: 'btn primary grow', type: 'button', onclick: () => startToday(plan) }, `Start today’s session (${plural(total, 'question')})`)));
    } else {
      const nr = nextRetest();
      todayP.append(h('p', null, 'You are all caught up. ', nr ? `The next retest is ${nr > now() ? 'on ' + fmtDate(nr) : 'now'}.` : ''));
      todayP.append(h('p', { class: 'muted' }, 'You can still practice: pick a set in the Quiz tab, or go through the flashcards.'));
    }
    if (day.n) todayP.append(h('p', { class: 'notice' }, `Answered today: ${day.ok} right out of ${day.n}.`));
    const extra = h('div', { class: 'actions' });
    if (c.w) extra.append(h('button', { class: 'btn grow', type: 'button', onclick: () => startQuiz('working', 10) }, 'Practice Working on words'));
    if (c.m) extra.append(h('button', { class: 'btn grow', type: 'button', onclick: () => startQuiz('mastered', 10) }, 'Retest Mastered words early'));
    if (extra.children.length) todayP.append(extra);
    return h('div', null, todayP, sec);
  }

  // ───────────────────────── sessions ─────────────────────────
  function startToday(plan) {
    const items = [...shuffle(plan.due).map((w) => ({ w, kind: 'due' })), ...shuffle(plan.fresh).map((w) => ({ w, kind: 'new' }))];
    ui.session = { id: uid(), title: 'Today’s session', queue: items, idx: 0, total: 0, correct: 0, promoted: [], demoted: [], missed: [], confirmed: [], lastType: {}, retries: {}, intro: plan.fresh, introIdx: 0, stage: plan.fresh.length ? 'intro' : 'quiz', q: null };
    ui.view = 'today'; render(); window.scrollTo(0, 0);
  }
  function poolWords(pool) {
    const t = now();
    if (pool === 'working') return W.filter((w) => S.words[w.key] && S.words[w.key].b === 'w');
    if (pool === 'mastered') return W.filter((w) => S.words[w.key] && S.words[w.key].b === 'm');
    if (pool === 'new') return W.filter((w) => !S.words[w.key]);
    if (pool === 'due') return W.filter((w) => S.words[w.key] && S.words[w.key].due <= t);
    if (pool.startsWith('g')) { const g = +pool.slice(1); return W.filter((w) => w.group === g); }
    return W;
  }
  function startQuiz(pool, n) {
    const words = shuffle(poolWords(pool)).slice(0, n);
    if (!words.length) return;
    ui.session = { id: uid(), title: 'Quiz', queue: words.map((w) => ({ w, kind: 'quiz' })), idx: 0, total: 0, correct: 0, promoted: [], demoted: [], missed: [], confirmed: [], lastType: {}, retries: {}, intro: [], introIdx: 0, stage: 'quiz', q: null };
    ui.view = 'today'; render(); window.scrollTo(0, 0);
  }
  function sessionView() {
    const s = ui.session;
    if (s.stage === 'intro') return introView(s);
    if (s.stage === 'done') return summaryView(s);
    const item = s.queue[s.idx];
    if (!s.q) s.q = makeQuestion(item.w, s.lastType[item.w.key]);
    return questionView(s, item);
  }
  function introView(s) {
    const w = s.intro[s.introIdx], last = s.introIdx === s.intro.length - 1;
    const box = h('div', { class: 'cardbox', style: 'cursor:default' },
      h('p', { class: 'qtag' }, 'New word'), h('p', { class: 'bigword' }, w.word), h('p', { class: 'meaning' }, w.meaning), h('p', { class: 'sentence' }, sentenceNodes(w)));
    return h('div', null,
      h('div', { class: 'session-bar' }, h('strong', null, `Meet today’s new words (${s.introIdx + 1} of ${s.intro.length})`), h('span', { class: 'muted' }, 'Read each one, then you will be quizzed.')),
      box,
      h('div', { class: 'actions' },
        s.introIdx > 0 && h('button', { class: 'btn', type: 'button', onclick: () => { s.introIdx--; render(); } }, 'Back'),
        h('button', { class: 'btn primary grow', type: 'button', onclick: () => { if (last) { s.stage = 'quiz'; } else s.introIdx++; render(); window.scrollTo(0, 0); } }, last ? 'Start the quiz' : 'Next word')));
  }
  const LABEL = { def: 'What does it mean?', word: 'Which word fits?', blank: 'Complete the sentence' };
  function questionView(s, item) {
    const q = s.q, w = q.w;
    const done = q.done;
    const prompt = q.type === 'def' ? h('p', { class: 'prompt' }, 'What does ', h('span', { class: 'focus-term' }, w.word), ' mean?')
      : q.type === 'word' ? h('p', { class: 'prompt' }, 'Which word means: ', h('em', null, w.meaning), '?')
      : h('div', null, h('p', { class: 'prompt' }, 'Which word completes the sentence?'), h('p', { class: 'sentence', style: 'margin-top:.6rem' }, sentenceNodes(w, true)));
    const opts = h('div', { class: 'options', role: 'group', 'aria-label': 'Answer choices' });
    q.options.forEach((o, i) => {
      let cls = 'option';
      if (done) { if (i === q.correct) cls += ' right'; else if (i === done.choice) cls += ' wrong'; }
      opts.append(h('button', { class: cls, type: 'button', disabled: !!done, onclick: () => choose(i) }, h('span', { class: 'key' }, 'ABCD'[i]), h('span', null, o.text)));
    });
    if (!done) opts.append(h('button', { class: 'option idk', type: 'button', onclick: () => choose(-1) }, h('span', { class: 'key' }, '?'), h('span', null, 'I don’t know')));
    const pct = Math.round((100 * s.idx) / s.queue.length);
    const out = h('div', { class: 'question' },
      h('div', { class: 'session-bar' }, h('span', { class: 'qtag' }, `${s.title}: question ${s.idx + 1} of ${s.queue.length}`), item.kind === 'retry' ? h('span', { class: 'badge w' }, 'Second try') : item.kind === 'new' ? h('span', { class: 'badge' }, 'New word') : null),
      h('div', { class: 'meter' }, h('div', { class: 'bar' }, h('i', { style: `width:${pct}%` }))),
      prompt, opts);
    if (done) out.append(feedback(s, q, done));
    return out;
  }
  function feedback(s, q, done) {
    const st = S.words[q.w.key];
    const msg = {
      promoted: 'Correct! This word is now Mastered. First retest tomorrow.',
      kept: `Correct! Still Mastered. Next retest in ${plural(Math.round((st.due - now()) / DAY), 'day')}.`,
      'kept-early': 'Correct! Its retest was not due yet, so the schedule stays the same.',
      confirm: 'Correct! It stays in Working on for now. One more right answer tomorrow locks it in.',
      missed: 'Not quite. It is in Working on and will come back soon.',
      demoted: 'Not quite. This word moves back to Working on so you can rebuild it.',
    }[done.result];
    return h('div', { class: 'explain', 'aria-live': 'polite' },
      h('p', { class: 'verdict ' + (done.ok ? 'ok' : 'no') }, done.choice === -1 ? 'No problem. Here is the answer.' : msg ? (done.ok ? '✓ ' : '✗ ') + msg : ''),
      done.choice === -1 && h('p', { class: 'muted' }, 'It is in Working on and will come back soon.'),
      h('p', { class: 'w' }, q.w.word, ' ', h('span', { class: 'badge ' + st.b }, st.b === 'm' ? 'Mastered' : 'Working on')),
      h('p', { style: 'margin:0;font-weight:700' }, q.w.meaning),
      h('p', { class: 'sentence' }, sentenceNodes(q.w)),
      h('div', { class: 'actions', style: 'margin-top:.2rem' }, h('button', { class: 'btn primary grow', type: 'button', id: 'nextbtn', onclick: nextQ }, s.idx + 1 >= s.queue.length ? 'See results' : 'Next')));
  }
  function choose(i) {
    const s = ui.session, q = s.q; if (!q || q.done) return;
    const item = s.queue[s.idx], w = q.w, ok = i === q.correct;
    const result = answer(w, ok, q.type, s);
    s.lastType[w.key] = q.type; s.total++; if (ok) s.correct++;
    if (result === 'promoted') s.promoted.push(w); else if (result === 'confirm') s.confirmed.push(w);
    else if (result === 'missed' || result === 'demoted') { if (!s.missed.includes(w)) s.missed.push(w); if (result === 'demoted') s.demoted.push(w); }
    if (!ok) { s.retries[w.key] = (s.retries[w.key] || 0) + 1; if (s.retries[w.key] <= 2) s.queue.splice(Math.min(s.idx + 5, s.queue.length), 0, { w, kind: 'retry' }); }
    q.done = { choice: i, ok, result };
    render();
    const nb = document.getElementById('nextbtn'); if (nb) nb.focus({ preventScroll: false });
  }
  function nextQ() {
    const s = ui.session; s.idx++; s.q = null;
    if (s.idx >= s.queue.length) s.stage = 'done';
    render(); window.scrollTo(0, 0);
  }
  function summaryView(s) {
    const pct = s.total ? Math.round((100 * s.correct) / s.total) : 0;
    const sec = h('section', { class: 'panel' }, h('h2', null, 'Session complete'),
      h('p', { style: 'font:800 3rem/1 var(--display);margin:.2rem 0' }, `${s.correct} / ${s.total}`),
      h('p', { class: 'muted' }, `${pct}% right on the first try of each question.`));
    const stat = h('div', { class: 'stats' },
      h('div', { class: 'stat m' }, h('b', null, s.promoted.length), 'newly Mastered'),
      h('div', { class: 'stat w' }, h('b', null, s.missed.length), 'to keep working on'),
      h('div', { class: 'stat' }, h('b', null, s.confirmed.length), 'one more right answer needed'));
    sec.append(stat);
    if (s.missed.length) sec.append(h('h3', null, 'Words to look at again'), h('table', { class: 'tbl' }, s.missed.map((w) => h('tr', null, h('td', null, h('strong', null, w.word)), h('td', null, w.meaning)))));
    const nr = (() => { const t = now(); let tom = 0, wk = 0; for (const k in S.words) { const d = S.words[k].due - t; if (d > 0 && d <= 1.5 * DAY) tom++; else if (d > 0 && d <= 7 * DAY) wk++; } return { tom, wk }; })();
    sec.append(h('p', { class: 'notice' }, `Coming up for retest: ${plural(nr.tom, 'word')} tomorrow and ${plural(nr.wk, 'word')} later this week. Mastered words are retested at 1, 3, 7, 14 and 30 days.`));
    sec.append(h('div', { class: 'actions' }, h('button', { class: 'btn primary grow', type: 'button', onclick: () => { ui.session = null; render(); } }, 'Back to Today')));
    return sec;
  }
  document.addEventListener('keydown', (e) => {
    if (!ui.session || ui.session.stage !== 'quiz' || ui.view !== 'today' || e.target.matches('input,select,textarea')) return;
    const q = ui.session.q; if (!q) return;
    const idx = '1234'.indexOf(e.key) >= 0 && e.key ? '1234'.indexOf(e.key) : 'abcd'.indexOf(e.key.toLowerCase());
    if (!q.done && idx >= 0 && e.key.length === 1) choose(idx);
    else if (q.done && (e.key === 'Enter' || e.key === ' ') && !e.target.matches('button')) { e.preventDefault(); nextQ(); }
  });

  // ───────────────────────── quiz setup ─────────────────────────
  function poolOptions() {
    const c = counts(S);
    const opts = [['working', `Working on (${c.w})`], ['mastered', `Mastered: early retest (${c.m})`], ['due', `Everything due now (${c.due})`], ['new', `Not yet seen (${c.n})`], ['all', `All ${W.length} words`]];
    for (let g = 1; g <= 40; g++) if (W.some((w) => w.group === g)) opts.push(['g' + g, `ISEE group ${g}`]);
    return opts;
  }
  function quizView() {
    const sel = h('select', { id: 'pool', onchange: (e) => { ui.quiz.pool = e.target.value; render(); } }, poolOptions().map(([v, l]) => h('option', { value: v, selected: v === ui.quiz.pool }, l)));
    const num = h('select', { id: 'qn', onchange: (e) => { ui.quiz.n = +e.target.value; } }, [10, 20, 30].map((n) => h('option', { value: n, selected: n === ui.quiz.n }, n + ' questions')));
    const avail = poolWords(ui.quiz.pool).length;
    return h('section', { class: 'panel' }, h('h2', null, 'Quiz'),
      h('p', { class: 'muted' }, 'Every answer updates the buckets: right answers move words to Mastered, wrong ones to Working on.'),
      h('div', { class: 'toolbar', style: 'margin-top:1rem' }, h('label', { class: 'field' }, 'Words', sel), h('label', { class: 'field' }, 'Length', num)),
      avail ? null : h('p', { class: 'notice' }, 'There are no words in that set yet.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary grow', type: 'button', disabled: !avail, onclick: () => startQuiz(ui.quiz.pool, ui.quiz.n) }, 'Start quiz')));
  }

  // ───────────────────────── flashcards ─────────────────────────
  function cardsView() {
    if (!ui.cards) ui.cards = { pool: 'working', order: null, i: 0, flipped: false };
    const c = ui.cards;
    if (!c.order) c.order = shuffle(poolWords(c.pool));
    const sel = h('select', { onchange: (e) => { c.pool = e.target.value; c.order = null; c.i = 0; c.flipped = false; render(); } }, poolOptions().filter((o) => o[0] !== 'due').map(([v, l]) => h('option', { value: v, selected: v === c.pool }, l)));
    const head = h('div', { class: 'toolbar' }, h('label', { class: 'field' }, 'Deck', sel),
      h('button', { class: 'btn', type: 'button', onclick: () => { c.order = null; c.i = 0; c.flipped = false; render(); } }, 'Shuffle'));
    if (!c.order.length) return h('section', { class: 'panel' }, head, h('p', null, 'There are no words in this deck yet.'));
    const w = c.order[c.i];
    const st = S.words[w.key];
    const face = c.flipped
      ? [h('p', { class: 'bigword', style: 'font-size:1.6rem' }, w.word), h('p', { class: 'meaning' }, w.meaning), h('p', { class: 'sentence' }, sentenceNodes(w))]
      : [h('p', { class: 'bigword' }, w.word), h('p', { class: 'hint' }, 'Tap the card to see the meaning')];
    const box = h('div', { class: 'cardbox', tabindex: 0, role: 'button', 'aria-label': 'Flip card', onclick: () => { c.flipped = !c.flipped; render(); }, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); c.flipped = !c.flipped; render(); } } }, face);
    return h('div', null, head,
      h('div', { class: 'meter' }, h('span', null, `${c.i + 1} / ${c.order.length}`), h('div', { class: 'bar' }, h('i', { style: `width:${(100 * (c.i + 1)) / c.order.length}%` })), h('span', { class: 'badge ' + (st ? st.b : '') }, st ? (st.b === 'm' ? 'Mastered' : 'Working on') : 'Not yet seen')),
      box,
      h('p', { class: 'muted' }, 'Flashcards are for reading and reviewing. To change a word’s bucket, answer it in a quiz.'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn grow', type: 'button', disabled: c.i === 0, onclick: () => { c.i--; c.flipped = false; render(); } }, 'Previous'),
        h('button', { class: 'btn primary grow', type: 'button', disabled: c.i === c.order.length - 1, onclick: () => { c.i++; c.flipped = false; render(); } }, 'Next')));
  }

  // ───────────────────────── words ─────────────────────────
  function bucketOf(w) { const s = S.words[w.key]; return s ? (s.b === 'm' ? 'mastered' : 'working') : 'new'; }
  function wordsView() {
    const f = ui.words, t = now();
    const q = h('input', { type: 'search', placeholder: 'Search words or meanings', value: f.q, 'aria-label': 'Search', oninput: (e) => { f.q = e.target.value; f.page = 1; renderList(); } });
    const bsel = h('select', { onchange: (e) => { f.bucket = e.target.value; f.page = 1; renderList(); } }, [['all', 'All'], ['working', 'Working on'], ['mastered', 'Mastered'], ['new', 'Not yet seen'], ['due', 'Due now']].map(([v, l]) => h('option', { value: v, selected: v === f.bucket }, l)));
    const groups = [['all', 'All groups'], ...Array.from({ length: 40 }, (_, i) => i + 1).filter((g) => W.some((w) => w.group === g)).map((g) => ['' + g, 'Group ' + g]), ['0', 'Extra words']];
    const gsel = h('select', { onchange: (e) => { f.group = e.target.value; f.page = 1; renderList(); } }, groups.map(([v, l]) => h('option', { value: v, selected: v === f.group }, l)));
    const list = h('div', { class: 'list' });
    const info = h('p', { class: 'muted' });
    function renderList() {
      const needle = f.q.trim().toLowerCase();
      const rows = W.filter((w) => {
        if (f.group !== 'all' && w.group !== +f.group) return false;
        if (f.bucket === 'due') { const s = S.words[w.key]; if (!(s && s.due <= t)) return false; } else if (f.bucket !== 'all' && bucketOf(w) !== f.bucket) return false;
        return !needle || w.key.includes(needle) || w.meaning.toLowerCase().includes(needle);
      });
      list.replaceChildren();
      info.textContent = `${rows.length} words`;
      rows.slice(0, f.page * 60).forEach((w) => {
        const s = S.words[w.key], b = bucketOf(w);
        list.append(h('details', null,
          h('summary', null, h('span', { class: 'form' }, w.word), h('span', { class: 'muted' }, w.meaning.length > 38 ? w.meaning.slice(0, 36) + '…' : w.meaning), h('span', { class: 'badge ' + (b === 'mastered' ? 'm' : b === 'working' ? 'w' : '') }, b === 'mastered' ? 'Mastered' : b === 'working' ? 'Working on' : 'Not yet seen')),
          h('p', { style: 'margin:.2rem 0;font-weight:700' }, w.meaning),
          h('p', { class: 'sentence' }, sentenceNodes(w)),
          s && h('p', { class: 'muted', style: 'margin:.6rem 0 0' }, `Right ${s.right}, missed ${s.wrong}. ${s.due <= t ? 'Due for a retest now.' : 'Next retest ' + fmtDate(s.due) + '.'}`)));
      });
      if (rows.length > f.page * 60) list.append(h('button', { class: 'btn', type: 'button', onclick: () => { f.page++; renderList(); } }, 'Show more'));
    }
    const out = h('div', null, h('div', { class: 'toolbar' }, h('label', { class: 'field' }, 'Search', q), h('label', { class: 'field' }, 'Bucket', bsel), h('label', { class: 'field' }, 'Group', gsel)), info, list);
    renderList();
    return out;
  }

  // ───────────────────────── progress & report ─────────────────────────
  function reportOf(state, label) {
    const t = now(), c = counts(state, t), wk = weekStats(state), sk = (() => { const real = S; S = state; const r = streakOf(state); S = real; return r; })();
    const today = state.days[dayKey(t)] || { n: 0, ok: 0 };
    const sec = h('section', { class: 'panel' }, h('h2', null, label), h('p', { class: 'muted' }, `${state.name ? state.name + ' · ' : ''}${W.length} words`),
      statTiles(c), bucketBar(c));
    sec.append(h('div', { class: 'row2', style: 'margin-top:1rem' },
      h('div', { class: 'stat' }, h('b', null, wk.n ? wk.pct + '%' : '–'), `right in the last 7 days (${wk.n} answers)`),
      h('div', { class: 'stat' }, h('b', null, sk), 'day streak')));
    sec.append(h('p', { class: 'notice' }, `Today: ${today.n ? `${today.ok} right of ${today.n}` : 'no answers yet'}. Due for retest now: ${c.dueW} Working on, ${c.dueM} Mastered.`));
    // 14-day chart
    const days = Array.from({ length: 14 }, (_, i) => { const k = dayKey(t - (13 - i) * DAY); return { k, n: (state.days[k] || {}).n || 0, d: new Date(t - (13 - i) * DAY) }; });
    const mx = Math.max(10, ...days.map((d) => d.n));
    sec.append(h('h3', null, 'Answers per day (last 14 days)'),
      h('div', { class: 'chart', role: 'img', 'aria-label': 'Answers per day' }, days.map((d) => h('div', { class: d.n ? '' : 'zero', style: `height:${Math.max(2, (d.n / mx) * 90)}px`, title: `${d.k}: ${d.n}` }))),
      h('div', { class: 'chartlab' }, days.map((d) => h('span', null, d.d.getDate()))));
    // hardest
    const hard = Object.entries(state.words).filter(([k, s]) => BY.has(k) && s.b === 'w').sort((a, b) => (b[1].wrong - a[1].wrong) || (a[1].right - b[1].right)).slice(0, 15);
    if (hard.length) sec.append(h('h3', null, 'Words to focus on'), h('table', { class: 'tbl' }, h('tr', null, h('th', null, 'Word'), h('th', null, 'Meaning'), h('th', null, 'Missed')), hard.map(([k, s]) => h('tr', null, h('td', null, h('strong', null, BY.get(k).word)), h('td', null, BY.get(k).meaning), h('td', null, s.wrong)))));
    // upcoming retests
    const up = { today: 0, tom: 0, wk: 0, later: 0 };
    for (const k in state.words) { if (!BY.has(k)) continue; const d = state.words[k].due - t; if (d <= 0) up.today++; else if (d <= 1.5 * DAY) up.tom++; else if (d <= 7 * DAY) up.wk++; else up.later++; }
    sec.append(h('h3', null, 'Retest schedule'), h('table', { class: 'tbl' }, h('tr', null, h('th', null, 'When'), h('th', null, 'Words')),
      h('tr', null, h('td', null, 'Due now'), h('td', null, up.today)), h('tr', null, h('td', null, 'Tomorrow'), h('td', null, up.tom)), h('tr', null, h('td', null, 'Within a week'), h('td', null, up.wk)), h('tr', null, h('td', null, 'Later'), h('td', null, up.later))));
    return sec;
  }
  function summaryText(state) {
    const c = counts(state), wk = weekStats(state);
    return `WordKeep progress${state.name ? ' for ' + state.name : ''} (${new Date().toLocaleDateString()})\nMastered: ${c.m}\nWorking on: ${c.w}\nNot yet seen: ${c.n} (of ${W.length})\nDue for retest now: ${c.due}\nLast 7 days: ${wk.n} answers, ${wk.pct == null ? 'n/a' : wk.pct + '% right'}\nStreak: ${(() => { const r = S; S = state; const v = streakOf(state); S = r; return v; })()} days`;
  }
  function download() {
    const data = JSON.stringify({ app: 'wordkeep', v: 1, exported: new Date().toISOString(), state: S }, null, 1);
    const a = h('a', { href: URL.createObjectURL(new Blob([data], { type: 'application/json' })), download: `wordkeep-progress-${(S.name || 'student').toLowerCase().replace(/\W+/g, '-')}-${dayKey(now())}.json` });
    document.body.append(a); a.click(); a.remove();
  }
  async function copyText(txt, btn) {
    try { await navigator.clipboard.writeText(txt); btn.textContent = 'Copied'; }
    catch (e) { const ta = h('textarea', null, txt); document.body.append(ta); ta.select(); try { document.execCommand('copy'); btn.textContent = 'Copied'; } catch (e2) { prompt('Copy this summary:', txt); } ta.remove(); }
    setTimeout(() => { btn.textContent = 'Copy a text summary'; }, 2000);
  }
  function readFile(file, cb) {
    const r = new FileReader();
    r.onload = () => { try { const d = JSON.parse(r.result); const st = d.state || d; if (!st || st.v !== 1 || !st.words) throw 0; cb(st, d.exported); } catch (e) { alert('That does not look like a WordKeep progress file.'); } };
    r.readAsText(file);
  }
  function progressView() {
    if (ui.viewing) {
      return h('div', null, h('section', { class: 'panel' }, h('p', { style: 'margin:0' }, `Viewing a progress file${ui.viewing.when ? ' saved ' + new Date(ui.viewing.when).toLocaleString() : ''}. This does not change the progress on this device.`), h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => { ui.viewing = null; render(); } }, 'Close file view'))),
        h('div', { style: 'margin-top:1rem' }, reportOf(ui.viewing.state, 'Progress report')));
    }
    const out = h('div', null, reportOf(S, 'Progress'));
    // settings
    const mk = (label, key, vals) => h('label', { class: 'field' }, label, h('select', { onchange: (e) => { S.settings[key] = +e.target.value; save(); } }, vals.map((v) => h('option', { value: v, selected: S.settings[key] === v }, v))));
    out.append(h('section', { class: 'panel' }, h('h2', null, 'Settings'), h('div', { class: 'toolbar' }, mk('New words per day (up to)', 'fresh', [0, 5, 10, 15, 20]), mk('Questions per daily session (up to)', 'session', [10, 20, 30, 40])),
      h('p', { class: 'muted' }, 'Words that are due for a retest always come first. New words only fill the space that is left in the session.')));
    // share
    const fileIn = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: (e) => { const f = e.target.files[0]; if (f) readFile(f, (st, when) => { ui.viewing = { state: st, when }; render(); }); } });
    const impIn = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: (e) => { const f = e.target.files[0]; if (f) readFile(f, (st) => { if (confirm('Replace the progress on this device with the progress in that file?')) { S = st; save(); render(); } }); } });
    const copyBtn = h('button', { class: 'btn grow', type: 'button' }, 'Copy a text summary'); copyBtn.addEventListener('click', () => copyText(summaryText(S), copyBtn));
    out.append(h('section', { class: 'panel' }, h('h2', null, 'Share or move progress'),
      h('p', { class: 'muted' }, 'A parent cannot see progress from the website itself, because it is stored only in this browser. Download the file here, send it, then open it on another device with “View a progress file”.'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary grow', type: 'button', onclick: download }, 'Download progress file'), copyBtn,
        h('button', { class: 'btn grow', type: 'button', onclick: () => fileIn.click() }, 'View a progress file'),
        h('button', { class: 'btn grow', type: 'button', onclick: () => impIn.click() }, 'Load a file onto this device')), fileIn, impIn,
      h('p', { style: 'margin-top:1.2rem' }, h('button', { class: 'link', type: 'button', onclick: () => { if (confirm('Erase all progress on this device and start over?')) { localStorage.removeItem(STORE); S = null; ui.session = null; ui.view = 'today'; render(); } } }, 'Reset all progress'))));
    return out;
  }

  if (DEBUG) window.__wk = { S: () => S, ui, plan: planToday, skipDays: (n) => { OFFSET += n * DAY; render(); }, counts: () => counts(S), W, correct: () => (ui.session && ui.session.q ? ui.session.q.correct : null), choose, startToday, nextQ };
  render();
})();
