/**
 * Instagram Follower Remover — content script
 *
 * Instagram-ийн "Followers" (дагагчид) цонхон дээр ажиллаж, мөр бүрийн
 * "Remove" товчийг дараад, гарч ирэх баталгаажуулах цонхны товчийг дарж
 * дагагчийг устгана. Instagram-д хориглогдохоос сэргийлж, дараалал бүрийн
 * хооронд хүлээлт (rate limit) тавьдаг.
 *
 * ⚠️  Энэ бол автоматжуулалтын туслах хэрэгсэл тул хэт хурдан ажиллуулбал
 *     Instagram таны хаягийг түр хааж болзошгүй. Хүлээлтийг өндөр байлга.
 */

(() => {
  'use strict';

  // ---- Тохиргоо / төлөв ------------------------------------------------
  const state = {
    running: false,
    removed: 0,
    limit: 0,          // 0 = хязгааргүй
    minDelay: 4000,    // мс — хамгийн бага хүлээлт
    maxDelay: 7000,    // мс — хамгийн их хүлээлт
    stopRequested: false,
  };

  // Товчны текстийг олон хэл дээр таних (жижиг үсгээр)
  const REMOVE_LABELS = ['remove', 'устгах', 'удалить', 'quitar', 'entfernen', 'supprimer'];
  const CONFIRM_LABELS = ['remove', 'устгах', 'удалить', 'quitar', 'entfernen', 'supprimer'];

  const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  // ---- Background-д ажиллах туслахууд ---------------------------------
  // Chrome нь идэвхгүй (hidden) таб дээр setTimeout-г удаашруулдаг тул
  // цагийг Web Worker дотор тоолуулж, throttling-ыг тойрно.
  let timerWorker = null;
  function getTimerWorker() {
    if (timerWorker) return timerWorker;
    try {
      const code =
        'self.onmessage=function(e){setTimeout(function(){self.postMessage(e.data.id);},e.data.ms);};';
      const blob = new Blob([code], { type: 'application/javascript' });
      timerWorker = new Worker(URL.createObjectURL(blob));
    } catch (e) {
      timerWorker = null;
    }
    return timerWorker;
  }

  function sleep(ms) {
    const w = getTimerWorker();
    if (!w) return new Promise((r) => setTimeout(r, ms)); // fallback
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      const handler = (e) => {
        if (e.data === id) {
          w.removeEventListener('message', handler);
          resolve();
        }
      };
      w.addEventListener('message', handler);
      w.postMessage({ id, ms });
    });
  }

  // Чимээгүй аудио тоглуулж таб-ыг "идэвхтэй" байлгаснаар Chrome-ийн
  // intensive throttling-оос сэргийлнэ (таб нуугдсан ч timer зөв ажиллана).
  let keepAlive = { ctx: null, osc: null };
  function startKeepAlive() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0; // бүрэн чимээгүй
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      if (ctx.state === 'suspended') ctx.resume();
      keepAlive = { ctx, osc };
    } catch (e) {
      /* дэмжигдээгүй бол алгасах */
    }
  }
  function stopKeepAlive() {
    try {
      if (keepAlive.osc) keepAlive.osc.stop();
      if (keepAlive.ctx) keepAlive.ctx.close();
    } catch (e) {
      /* noop */
    }
    keepAlive = { ctx: null, osc: null };
  }

  const normalize = (s) => (s || '').trim().toLowerCase();

  const matchesLabel = (text, labels) => {
    const t = normalize(text);
    return labels.some((l) => t === l);
  };

  // ---- DOM хайлт -------------------------------------------------------

  // Идэвхтэй dialog (Followers цонх) олох
  function getFollowersDialog() {
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
    // Хамгийн сүүлд нээгдсэн (хамгийн доор байрлах) dialog-г сонгоно
    return dialogs.length ? dialogs[dialogs.length - 1] : null;
  }

  // Dialog доторх гүйдэг (scrollable) контейнер олох
  function getScrollContainer(dialog) {
    if (!dialog) return null;
    const candidates = dialog.querySelectorAll('div');
    let best = null;
    let bestHeight = 0;
    for (const el of candidates) {
      const style = getComputedStyle(el);
      const overflowY = style.overflowY;
      if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
        if (el.clientHeight > bestHeight) {
          best = el;
          bestHeight = el.clientHeight;
        }
      }
    }
    return best;
  }

  // Мөрөн дэх "Remove" товчийг олох (баталгаажуулах цонхны товчийг оруулахгүй)
  function findRemoveButtons(dialog) {
    if (!dialog) return [];
    const buttons = Array.from(dialog.querySelectorAll('button, div[role="button"]'));
    return buttons.filter((b) => matchesLabel(b.textContent, REMOVE_LABELS));
  }

  // Баталгаажуулах цонхны "Remove" товчийг олох
  function findConfirmButton() {
    // Баталгаажуулах цонх нь ихэвчлэн шинэ dialog болж нээгддэг
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
    for (let i = dialogs.length - 1; i >= 0; i--) {
      const btns = Array.from(dialogs[i].querySelectorAll('button, div[role="button"]'));
      const confirm = btns.find((b) => matchesLabel(b.textContent, CONFIRM_LABELS));
      if (confirm) return confirm;
    }
    return null;
  }

  // ---- Устгах гол логик ------------------------------------------------

  async function removeOne(button) {
    button.scrollIntoView({ block: 'center' });
    await sleep(400);
    button.click();

    // Баталгаажуулах цонх гарч иртэл хүлээх
    let confirm = null;
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      confirm = findConfirmButton();
      if (confirm) break;
    }
    if (!confirm) {
      // Баталгаажуулах цонх гараагүй бол алгасах
      return false;
    }
    await sleep(500);
    confirm.click();
    await sleep(1200);
    return true;
  }

  async function run() {
    const dialog = getFollowersDialog();
    if (!dialog) {
      notify('❌ Followers цонх олдсонгүй. Эхлээд профайл дээрээ "Followers" дарж жагсаалтыг нээнэ үү.', true);
      stop();
      return;
    }

    const scroller = getScrollContainer(dialog);
    let noProgressRounds = 0;

    while (state.running && !state.stopRequested) {
      if (state.limit > 0 && state.removed >= state.limit) {
        notify(`✅ Хязгаарт (${state.limit}) хүрлээ. Нийт ${state.removed} дагагч устгав.`);
        break;
      }

      const buttons = findRemoveButtons(getFollowersDialog());

      if (buttons.length === 0) {
        // Илүү дагагч ачаалахаар доош гүйлгэх
        if (scroller) {
          const before = scroller.scrollTop;
          scroller.scrollTop = scroller.scrollHeight;
          await sleep(1500);
          if (scroller.scrollTop === before) {
            noProgressRounds++;
          } else {
            noProgressRounds = 0;
          }
        } else {
          noProgressRounds++;
        }

        if (noProgressRounds >= 3) {
          notify(`✅ Дуусгав. Нийт ${state.removed} дагагч устгав.`);
          break;
        }
        continue;
      }

      noProgressRounds = 0;
      const ok = await removeOne(buttons[0]);
      if (ok) {
        state.removed++;
        updatePanel();
        chrome.runtime.sendMessage({ type: 'progress', removed: state.removed }).catch(() => {});
      }

      // Хориглолтоос сэргийлж санамсаргүй хүлээлт
      const delay = rand(state.minDelay, state.maxDelay);
      notify(`⏳ ${state.removed} устгав. Дараагийн хүртэл ${Math.round(delay / 1000)}с хүлээж байна…`);
      await sleep(delay);
    }

    stop();
  }

  // ---- Хөвөгч самбар (floating panel) ----------------------------------

  let panel = null;

  function buildPanel() {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'ifr-panel';
    panel.innerHTML = `
      <div class="ifr-header">
        <span>Follower Remover</span>
        <button id="ifr-close" title="Хаах">×</button>
      </div>
      <div class="ifr-body">
        <label>Хэдэн дагагч устгах уу? (0 = бүгд)
          <input type="number" id="ifr-limit" min="0" value="0" />
        </label>
        <label>Хүлээлт (сек, бага – их)
          <span class="ifr-row">
            <input type="number" id="ifr-min" min="2" value="4" />
            <input type="number" id="ifr-max" min="2" value="7" />
          </span>
        </label>
        <div class="ifr-status" id="ifr-status">Бэлэн.</div>
        <div class="ifr-actions">
          <button id="ifr-start" class="ifr-primary">Эхлэх</button>
          <button id="ifr-stop" class="ifr-danger" disabled>Зогсоох</button>
        </div>
        <p class="ifr-hint">Профайл → "Followers" цонхыг нээгээд "Эхлэх" дарна.</p>
      </div>
    `;
    document.body.appendChild(panel);

    panel.querySelector('#ifr-close').addEventListener('click', () => panel.remove());
    panel.querySelector('#ifr-start').addEventListener('click', start);
    panel.querySelector('#ifr-stop').addEventListener('click', () => { state.stopRequested = true; });

    makeDraggable(panel, panel.querySelector('.ifr-header'));
  }

  function makeDraggable(el, handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect();
      ox = r.left; oy = r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      el.style.left = ox + (e.clientX - sx) + 'px';
      el.style.top = oy + (e.clientY - sy) + 'px';
      el.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  function notify(msg, isError = false) {
    const s = panel && panel.querySelector('#ifr-status');
    if (s) {
      s.textContent = msg;
      s.classList.toggle('ifr-error', !!isError);
    }
  }

  function updatePanel() {
    if (!panel) return;
    panel.querySelector('#ifr-start').disabled = state.running;
    panel.querySelector('#ifr-stop').disabled = !state.running;
  }

  function readSettings() {
    if (!panel) return;
    const limit = parseInt(panel.querySelector('#ifr-limit').value, 10);
    const min = parseFloat(panel.querySelector('#ifr-min').value);
    const max = parseFloat(panel.querySelector('#ifr-max').value);
    state.limit = Number.isFinite(limit) && limit > 0 ? limit : 0;
    state.minDelay = Math.max(2000, (Number.isFinite(min) ? min : 4) * 1000);
    state.maxDelay = Math.max(state.minDelay, (Number.isFinite(max) ? max : 7) * 1000);
  }

  function start() {
    if (state.running) return;
    buildPanel();
    readSettings();
    state.running = true;
    state.stopRequested = false;
    state.removed = 0;
    startKeepAlive(); // "Эхлэх" дарсан нь user gesture тул аудио эхлэх боломжтой
    updatePanel();
    notify('▶️ Эхэллээ… (өөр таб руу орсон ч үргэлжилнэ)');
    run();
  }

  function stop() {
    state.running = false;
    stopKeepAlive();
    updatePanel();
    chrome.runtime.sendMessage({ type: 'stopped', removed: state.removed }).catch(() => {});
  }

  // ---- Popup-той харилцах ---------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'togglePanel') {
      if (panel) { panel.remove(); panel = null; }
      else buildPanel();
      sendResponse({ ok: true });
    } else if (msg && msg.type === 'start') {
      if (msg.settings) {
        buildPanel();
        if (msg.settings.limit != null) panel.querySelector('#ifr-limit').value = msg.settings.limit;
        if (msg.settings.min != null) panel.querySelector('#ifr-min').value = msg.settings.min;
        if (msg.settings.max != null) panel.querySelector('#ifr-max').value = msg.settings.max;
      }
      start();
      sendResponse({ ok: true });
    } else if (msg && msg.type === 'stop') {
      state.stopRequested = true;
      sendResponse({ ok: true });
    } else if (msg && msg.type === 'getState') {
      sendResponse({ running: state.running, removed: state.removed });
    }
    return true;
  });

  // Хуудас ачаалахад самбарыг автоматаар харуулна
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    buildPanel();
  } else {
    window.addEventListener('DOMContentLoaded', buildPanel);
  }
})();
