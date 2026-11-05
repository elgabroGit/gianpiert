/*
 * Ritocchi di comportamento attorno all'app originale, senza toccarne il codice.
 * - Animazioni di ingresso solo quando cambia la vista (o arrivano i primi dati): l'app ridisegna
 *   #app a ogni istantanea del server, quindi gli ingressi non possono stare nel CSS.
 *   Andando più in profondità (clienti > cliente > progetto) la vista entra da destra, tornando da sinistra.
 * - Etichette delle celle per mostrare fatture e costi come schede su telefono.
 * - Piccolo rimbalzo della spunta e del contatore task.
 * - Pannelli dal basso che si chiudono trascinando giù la maniglia.
 * Tutto rispetta prefers-reduced-motion.
 */
(function () {
  'use strict';

  const app = document.getElementById('app');
  if (!app || !Element.prototype.animate) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const EASE = 'cubic-bezier(.2,.8,.2,1)';
  const SPRING = 'cubic-bezier(.3,1.35,.5,1)';

  /* ---------- profondità della vista ---------- */
  function route() {
    const h = decodeURIComponent(location.hash.slice(1));
    if (h.startsWith('fatture-progetto-')) return { tab: 'fatture', depth: 2 };
    if (h.startsWith('fatture-cliente-')) return { tab: 'fatture', depth: 1 };
    if (h.startsWith('progetto-')) return { tab: 'clienti', depth: 2 };
    if (h.startsWith('cliente-')) return { tab: 'clienti', depth: 1 };
    return { tab: h || 'clienti', depth: 0 };
  }
  let current = route();
  let pending = null; // direzione dell'ingresso da animare al prossimo disegno
  let hadSkeleton = !!app.querySelector('.skel');

  window.addEventListener('hashchange', () => {
    const next = route();
    pending = next.tab === current.tab && next.depth !== current.depth ? (next.depth > current.depth ? 'forward' : 'back') : 'fade';
    current = next;
  });

  /* ---------- ingressi ---------- */
  const STAGGER = [
    '.plist > *', '.tlist > li', '.cgrid > *', '.tiles > *', '.agenda > *', '.cols > *',
    '.cols .stack > *', '.chips', '.toolbar', '.calwrap', '.mchart', '.sheetwrap', '.fsec', '.section-h', '.empty', 'details.more',
  ].join(',');

  function enter(kind) {
    if (reduce.matches) return;
    const dx = kind === 'forward' ? 28 : kind === 'back' ? -28 : 0;
    const head = app.querySelector(':scope > .head, :scope > .phead, :scope > .crumbs, :scope > .back');
    const frames = [{ opacity: 0, transform: `translate(${dx}px, ${dx ? 0 : 8}px)` }, { opacity: 1, transform: 'none' }];
    if (dx) app.animate(frames, { duration: 300, easing: EASE });
    else if (head) head.animate(frames, { duration: 260, easing: EASE });

    // In cascata solo quello che si vede, al massimo 14 elementi
    const vh = window.innerHeight;
    let i = 0;
    app.querySelectorAll(STAGGER).forEach(el => {
      if (i >= 14 || el.closest('details:not([open])')) return;
      const r = el.getBoundingClientRect();
      if (r.top > vh || r.bottom < 0) return;
      el.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }],
        { duration: 340, delay: 40 + i * 28, easing: EASE, fill: 'backwards' });
      i++;
    });

    // Barre del fatturato mensile e avanzamento dei progetti
    app.querySelectorAll('.mcol i').forEach((el, k) => el.animate(
      [{ transform: 'scaleY(0)', transformOrigin: 'bottom' }, { transform: 'scaleY(1)', transformOrigin: 'bottom' }],
      { duration: 520, delay: 120 + k * 30, easing: EASE, fill: 'backwards' }));
    app.querySelectorAll('.bar i').forEach(el => el.animate(
      [{ transform: 'scaleX(0)', transformOrigin: 'left' }, { transform: 'scaleX(1)', transformOrigin: 'left' }],
      { duration: 600, delay: 160, easing: EASE, fill: 'backwards' }));
  }

  /* ---------- spunta delle task ---------- */
  let popId = null;
  document.addEventListener('click', e => {
    const c = e.target.closest && e.target.closest('.check[data-id]');
    if (c) popId = c.dataset.id;
  }, true);
  function pop() {
    if (!popId) return;
    const el = app.querySelector(`.check[data-id="${CSS.escape(popId)}"]`);
    if (!el) return;
    const done = el.getAttribute('aria-pressed') === 'true';
    popId = null;
    if (reduce.matches) return;
    el.animate([{ transform: 'scale(.7)' }, { transform: 'scale(1.15)' }, { transform: 'scale(1)' }], { duration: 360, easing: SPRING });
    if (done && navigator.vibrate) try { navigator.vibrate(8); } catch (err) { /* non supportato */ }
  }

  /* ---------- fatture e costi come schede ---------- */
  function labelGrids() {
    app.querySelectorAll('table.xl').forEach(t => {
      if (!t.tHead || !t.tBodies[0]) return;
      const labels = [...t.tHead.rows[0].cells].map(th => th.textContent.trim());
      [...t.tBodies[0].rows].forEach(tr => [...tr.cells].forEach((td, i) => {
        if (td.classList.contains('rn')) return;
        const inp = td.querySelector('[data-k],[data-col]');
        if (labels[i]) td.dataset.label = labels[i];
        if (inp && inp.dataset.k) td.dataset.k = inp.dataset.k;
        if (inp && inp.dataset.col) td.dataset.col = inp.dataset.col;
      }));
    });
  }

  /* ---------- a ogni disegno dell'app ---------- */
  new MutationObserver(() => {
    labelGrids();
    const skel = !!app.querySelector('.skel');
    let kind = pending;
    if (!kind && hadSkeleton && !skel) kind = 'fade'; // primi dati arrivati
    hadSkeleton = skel;
    if (kind && !skel) { pending = null; enter(kind); }
    pop();
  }).observe(app, { childList: true });
  labelGrids();

  /* ---------- contatore task ---------- */
  const count = document.getElementById('taskCount');
  if (count) {
    let last = count.textContent;
    new MutationObserver(() => {
      const now = count.textContent;
      if (now !== last && last !== '' && !reduce.matches) {
        count.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.35)' }, { transform: 'scale(1)' }], { duration: 380, easing: SPRING });
      }
      last = now;
    }).observe(count, { childList: true, characterData: true, subtree: true });
  }

  /* ---------- pannello dal basso: trascina giù per chiudere ---------- */
  const sheet = document.getElementById('sheet');
  const panel = document.getElementById('sheetBody');
  const small = window.matchMedia('(max-width: 640px)');
  let drag = null;
  if (sheet && panel) {
    panel.addEventListener('touchstart', e => {
      if (!small.matches || panel.scrollTop > 0 || e.touches.length !== 1) return;
      const y = e.touches[0].clientY;
      if (y - panel.getBoundingClientRect().top > 64) return; // solo dalla maniglia e dal titolo
      drag = { y0: y, dy: 0, t0: Date.now() };
      panel.style.transition = 'none';
    }, { passive: true });
    panel.addEventListener('touchmove', e => {
      if (!drag) return;
      drag.dy = Math.max(0, e.touches[0].clientY - drag.y0);
      panel.style.transform = drag.dy ? `translateY(${drag.dy}px)` : '';
    }, { passive: true });
    const end = () => {
      if (!drag) return;
      const { dy, t0 } = drag;
      drag = null;
      const fast = dy > 40 && dy / Math.max(1, Date.now() - t0) > 0.6;
      if (dy > 110 || fast) {
        const a = panel.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(100%)' }], { duration: 200, easing: 'ease-in' });
        a.onfinish = () => {
          panel.style.transform = ''; panel.style.transition = '';
          const scrim = sheet.querySelector('.scrim');
          if (scrim) scrim.click(); // passa dal closeSheet() dell'app
        };
      } else {
        panel.style.transition = 'transform .25s cubic-bezier(.2,.8,.2,1)';
        panel.style.transform = '';
      }
    };
    panel.addEventListener('touchend', end);
    panel.addEventListener('touchcancel', end);
  }
})();

/* ---------- accesso all'account: password, copia dei dati, chiave di recupero ---------- */
(function () {
  'use strict';
  const row = document.querySelector('.top-in');
  if (!row || row.querySelector('.acct')) return;
  const a = document.createElement('a');
  a.className = 'acct';
  a.href = '/account';
  a.textContent = 'Account';
  row.append(a);
})();
