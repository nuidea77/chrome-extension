'use strict';

const $ = (id) => document.getElementById(id);

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isInstagram(url) {
  return typeof url === 'string' && url.startsWith('https://www.instagram.com/');
}

async function send(msg) {
  const tab = await getActiveTab();
  if (!tab || !isInstagram(tab.url)) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch (e) {
    return null;
  }
}

function setRunning(running) {
  $('start').disabled = running;
  $('stop').disabled = !running;
}

function setStatus(text) {
  $('status').textContent = text;
}

async function init() {
  const tab = await getActiveTab();
  if (!tab || !isInstagram(tab.url)) {
    $('not-instagram').classList.remove('hidden');
    $('controls').classList.add('hidden');
    return;
  }

  // Хадгалсан тохиргоог сэргээх
  const saved = await chrome.storage.local.get(['limit', 'min', 'max']);
  if (saved.limit != null) $('limit').value = saved.limit;
  if (saved.min != null) $('min').value = saved.min;
  if (saved.max != null) $('max').value = saved.max;

  const st = await send({ type: 'getState' });
  if (st) {
    setRunning(!!st.running);
    setStatus(st.running ? `Ажиллаж байна… ${st.removed} устгав.` : 'Бэлэн.');
  }
}

$('start').addEventListener('click', async () => {
  const settings = {
    limit: parseInt($('limit').value, 10) || 0,
    min: parseFloat($('min').value) || 4,
    max: parseFloat($('max').value) || 7,
  };
  await chrome.storage.local.set(settings);
  const res = await send({ type: 'start', settings });
  if (res) {
    setRunning(true);
    setStatus('Эхэллээ…');
  } else {
    setStatus('❌ Instagram таб идэвхтэй эсэхийг шалгана уу.');
  }
});

$('stop').addEventListener('click', async () => {
  await send({ type: 'stop' });
  setRunning(false);
  setStatus('Зогслоо.');
});

$('toggle').addEventListener('click', () => send({ type: 'togglePanel' }));

// Content script-аас ирэх явцын мэдээлэл
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === 'progress') {
    setStatus(`${msg.removed} дагагч устгав…`);
  } else if (msg.type === 'stopped') {
    setRunning(false);
    setStatus(`Дуусгав. Нийт ${msg.removed} устгав.`);
  }
});

init();
