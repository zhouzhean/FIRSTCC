// ── State ──────────────────────────────────────────
const WORK_MIN = 25;
const SHORT_BREAK_MIN = 5;
const LONG_BREAK_MIN = 15;
const CYCLES_BEFORE_LONG = 4;

const PHASE = { WORK: 'work', SHORT_BREAK: 'short_break', LONG_BREAK: 'long_break' };

const state = {
  phase: PHASE.WORK,
  remainingSec: WORK_MIN * 60,
  totalSec: WORK_MIN * 60,
  completedCycles: 0,
  timerState: 'idle', // idle | running | paused
  intervalId: null,
  tasks: [],
  activeTaskId: null,
};

// ── DOM refs ──────────────────────────────────────
const $phaseLabel = document.getElementById('phase-label');
const $timerDisplay = document.getElementById('timer-display');
const $cycleCount = document.getElementById('cycle-count');
const $progressRing = document.getElementById('progress-ring');
const $btnStart = document.getElementById('btn-start');
const $btnReset = document.getElementById('btn-reset');
const $taskInput = document.getElementById('task-input');
const $btnAddTask = document.getElementById('btn-add-task');
const $taskList = document.getElementById('task-list');
const $completedCount = document.getElementById('completed-count');
const $totalCount = document.getElementById('total-count');

// ── Audio ─────────────────────────────────────────
function playAlarm() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const notes = [880, 1100, 1320]; // A5, C#6, E6
  notes.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.3, ctx.currentTime + i * 0.15);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.15 + 0.25);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime + i * 0.15);
    osc.stop(ctx.currentTime + i * 0.15 + 0.3);
  });
}

// ── Notifications ─────────────────────────────────
function notify(title, body) {
  if (Notification.permission === 'granted') {
    new Notification(title, { body, icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🍅</text></svg>' });
  }
}

function requestNotificationPermission() {
  if (Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

// ── Phase helpers ──────────────────────────────────
function phaseLabel(p) {
  if (p === PHASE.WORK) return '专注';
  if (p === PHASE.SHORT_BREAK) return '短休息';
  return '长休息';
}

function phaseMin(p) {
  if (p === PHASE.WORK) return WORK_MIN;
  if (p === PHASE.SHORT_BREAK) return SHORT_BREAK_MIN;
  return LONG_BREAK_MIN;
}

function nextPhase() {
  if (state.phase === PHASE.WORK) {
    state.completedCycles++;
    if (state.completedCycles % CYCLES_BEFORE_LONG === 0) {
      return PHASE.LONG_BREAK;
    }
    return PHASE.SHORT_BREAK;
  }
  return PHASE.WORK;
}

// ── Timer logic ────────────────────────────────────
function updateDisplay() {
  const m = Math.floor(state.remainingSec / 60);
  const s = state.remainingSec % 60;
  $timerDisplay.textContent = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');

  const progress = state.remainingSec / state.totalSec;
  const circumference = 2 * Math.PI * 90; // ~565.49
  $progressRing.style.strokeDashoffset = circumference * (1 - progress);

  if (state.phase === PHASE.WORK) {
    $progressRing.style.stroke = '#fca311';
  } else {
    $progressRing.style.stroke = '#2ecc71';
  }
}

function switchPhase(newPhase) {
  state.phase = newPhase;
  state.totalSec = phaseMin(newPhase) * 60;
  state.remainingSec = state.totalSec;
  $phaseLabel.textContent = phaseLabel(newPhase);
  updateDisplay();
}

function onComplete() {
  stopTimer();
  playAlarm();

  // Award pomodoro to active task if work just finished
  if (state.phase === PHASE.WORK && state.activeTaskId) {
    const task = state.tasks.find(t => t.id === state.activeTaskId);
    if (task) {
      task.pomodoros++;
      saveTasks();
      renderTaskList();
    }
  }

  if (state.phase === PHASE.WORK) {
    notify('番茄完成！', '休息一下吧 🍅');
  } else {
    notify('休息结束！', '开始新的番茄吧 💪');
  }

  // Auto advance to next phase and start
  switchPhase(nextPhase());
  updateCycleDisplay();
  startTimer();
}

function updateCycleDisplay() {
  $cycleCount.textContent = '#' + (state.completedCycles + 1);
}

function tick() {
  if (state.remainingSec <= 0) {
    onComplete();
    return;
  }
  state.remainingSec--;
  updateDisplay();
}

function startTimer() {
  if (state.timerState === 'running') return;
  state.timerState = 'running';
  state.intervalId = setInterval(tick, 1000);
  $btnStart.textContent = '暂停';
  $btnReset.disabled = false;
  requestNotificationPermission();
}

function pauseTimer() {
  if (state.timerState !== 'running') return;
  state.timerState = 'paused';
  clearInterval(state.intervalId);
  state.intervalId = null;
  $btnStart.textContent = '继续';
}

function stopTimer() {
  state.timerState = 'idle';
  clearInterval(state.intervalId);
  state.intervalId = null;
}

function resetTimer() {
  stopTimer();
  state.phase = PHASE.WORK;
  state.completedCycles = 0;
  state.totalSec = WORK_MIN * 60;
  state.remainingSec = state.totalSec;
  state.timerState = 'idle';
  $btnStart.textContent = '开始';
  $btnReset.disabled = true;
  $phaseLabel.textContent = phaseLabel(PHASE.WORK);
  updateCycleDisplay();
  updateDisplay();
}

// ── Task logic ─────────────────────────────────────
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function addTask(text) {
  const task = {
    id: generateId(),
    text: text.trim(),
    completed: false,
    pomodoros: 0,
  };
  state.tasks.push(task);
  saveTasks();
  renderTaskList();
}

function deleteTask(id) {
  state.tasks = state.tasks.filter(t => t.id !== id);
  if (state.activeTaskId === id) state.activeTaskId = null;
  saveTasks();
  renderTaskList();
}

function toggleTask(id) {
  const task = state.tasks.find(t => t.id === id);
  if (task) {
    task.completed = !task.completed;
    saveTasks();
    renderTaskList();
  }
}

function setActiveTask(id) {
  if (state.activeTaskId === id) {
    state.activeTaskId = null;
  } else {
    state.activeTaskId = id;
  }
  saveTasks();
  renderTaskList();
}

// ── Persistence ────────────────────────────────────
const STORAGE_KEY = 'pomodoro_tasks_v1';

function saveTasks() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.tasks));
  localStorage.setItem('pomodoro_active_task', state.activeTaskId || '');
}

function loadTasks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) state.tasks = JSON.parse(raw);
  } catch (_) { /* ignore */ }
  state.activeTaskId = localStorage.getItem('pomodoro_active_task') || null;
}

// ── Render ─────────────────────────────────────────
function renderTaskList() {
  $taskList.innerHTML = '';

  state.tasks.forEach(task => {
    const li = document.createElement('li');
    li.className = 'task-item' + (task.id === state.activeTaskId ? ' active' : '');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'task-checkbox';
    cb.checked = task.completed;
    cb.addEventListener('change', () => toggleTask(task.id));

    const span = document.createElement('span');
    span.className = 'task-text' + (task.completed ? ' done' : '');
    span.textContent = task.text;

    const badge = document.createElement('span');
    badge.className = 'task-pomo-badge';
    badge.textContent = task.pomodoros + ' 🍅';

    const selBtn = document.createElement('button');
    selBtn.className = 'task-select';
    selBtn.textContent = task.id === state.activeTaskId ? '当前' : '选择';
    selBtn.title = task.id === state.activeTaskId ? '取消选择' : '设为当前任务';
    selBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setActiveTask(task.id);
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'task-delete';
    delBtn.textContent = '×';
    delBtn.title = '删除任务';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteTask(task.id);
    });

    li.append(cb, span, badge, selBtn, delBtn);
    $taskList.appendChild(li);
  });

  // Footer counts
  $completedCount.textContent = state.tasks.filter(t => t.completed).length;
  $totalCount.textContent = state.tasks.length;
}

// ── Event binding ──────────────────────────────────
$btnStart.addEventListener('click', () => {
  if (state.timerState === 'idle' || state.timerState === 'paused') {
    startTimer();
  } else {
    pauseTimer();
  }
});

$btnReset.addEventListener('click', () => {
  resetTimer();
});

$btnAddTask.addEventListener('click', () => {
  const text = $taskInput.value.trim();
  if (!text) return;
  addTask(text);
  $taskInput.value = '';
  $taskInput.focus();
});

$taskInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    $btnAddTask.click();
  }
});

// ── Init ───────────────────────────────────────────
loadTasks();
renderTaskList();
updateDisplay();
updateCycleDisplay();
$taskInput.focus();
