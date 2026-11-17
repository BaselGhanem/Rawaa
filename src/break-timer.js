'use strict';

const $ = id => document.getElementById(id);
const duration = $(`duration`);
const presets = [...document.querySelectorAll(`[data-minutes]`)];
const returnTime = new Intl.DateTimeFormat(`ar-JO`, { hour: `numeric`, minute: `2-digit` });
const minuteMs = 60_000;
let totalMs = 0;
let pausedMs = 0;
let deadline = 0;
let frame = 0;

function showDigits(id, value) {
  const digit = $(id);
  const text = String(value).padStart(2, `0`);
  if (digit.textContent === text) return;
  digit.textContent = text;
  digit.classList.remove(`tick`);
  void digit.offsetWidth;
  digit.classList.add(`tick`);
}

function paint(ms) {
  const seconds = Math.ceil(ms / 1000);
  showDigits(`minutes`, Math.floor(seconds / 60));
  showDigits(`seconds`, seconds % 60);
  $(`progress`).value = totalMs ? ms / totalMs : 1;
}

function setPhase(phase) {
  document.body.dataset.phase = phase;
  $(`setup`).hidden = phase !== `setup`;
  $(`controls`).hidden = phase === `setup`;
  $(`pause`).hidden = phase === `finished`;
  $(`detail`).hidden = phase === `setup`;
  $(`heading`).textContent = phase === `finished` ? `انتهت الاستراحة` : `استراحة`;
  $(`pause`).textContent = phase === `paused` ? `متابعة` : `ايقاف مؤقت`;
  $(`detail`).textContent = {
    running: deadline ? `نرجع الساعة ${returnTime.format(deadline)}` : ``,
    paused: `المؤقت متوقف`,
    finished: `نكمل التدريب`
  }[phase] || ``;
}

function tick() {
  const remaining = Math.max(0, deadline - Date.now());
  paint(remaining);
  if (remaining > 0) {
    frame = requestAnimationFrame(tick);
  } else {
    deadline = 0;
    setPhase(`finished`);
    $(`reset`).focus({ preventScroll: true });
  }
}

function start(ms) {
  deadline = Date.now() + ms;
  setPhase(`running`);
  tick();
}

function updateDuration() {
  const value = duration.valueAsNumber;
  for (const button of presets) {
    button.setAttribute(`aria-pressed`, String(Number(button.dataset.minutes) === value));
  }
  paint(duration.validity.valid ? value * minuteMs : 0);
}

for (const button of presets) {
  button.addEventListener(`click`, () => {
    duration.value = button.dataset.minutes;
    updateDuration();
  });
}

duration.addEventListener(`input`, updateDuration);
$(`setup`).addEventListener(`submit`, event => {
  event.preventDefault();
  if (!duration.reportValidity()) return;
  totalMs = duration.valueAsNumber * minuteMs;
  start(totalMs);
  $(`pause`).focus({ preventScroll: true });
});

$(`pause`).addEventListener(`click`, () => {
  if (!deadline) {
    start(pausedMs);
    return;
  }
  pausedMs = Math.max(0, deadline - Date.now());
  cancelAnimationFrame(frame);
  if (!pausedMs) {
    tick();
    return;
  }
  deadline = 0;
  paint(pausedMs);
  setPhase(`paused`);
});

$(`reset`).addEventListener(`click`, () => {
  cancelAnimationFrame(frame);
  totalMs = 0;
  deadline = 0;
  pausedMs = 0;
  setPhase(`setup`);
  updateDuration();
  duration.focus({ preventScroll: true });
});

$(`exit`).addEventListener(`click`, () => window.close());
