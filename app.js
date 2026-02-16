/* 五人暗战模式 2.0｜异地模式（带后端日志） */

// -----------------------------
// 基础工具
// -----------------------------

/** @param {string} sel */
function $(sel) {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`找不到元素: ${sel}`);
  return el;
}

/** @param {string} msg */
function toast(msg) {
  const host = $("#toast");
  const item = document.createElement("div");
  item.className = "toast__item";
  const text = document.createElement("div");
  text.className = "toast__msg";
  text.textContent = msg;
  const close = document.createElement("button");
  close.className = "toast__close";
  close.type = "button";
  close.textContent = "关闭";
  close.addEventListener("click", () => item.remove());
  item.appendChild(text);
  item.appendChild(close);
  host.appendChild(item);
  setTimeout(() => {
    if (item.isConnected) item.remove();
  }, 3600);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function formatMMSS(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function normalizeName(s, fallback) {
  const t = String(s ?? "").trim();
  return t.length ? t : fallback;
}

/** @typedef {{id:string, type:string, text:string}} Task */

/**
 * @typedef {Object} RemoteState
 * @property {string} name
 * @property {string} code
 * @property {string} token
 * @property {"idle"|"waiting"|"assigned"} status
 * @property {number} joined
 * @property {number} maxPlayers
 * @property {string=} role
 * @property {Task[]=} tasks
 * @property {{taskCount:number, maxSameType:number}=} settings
 * @property {string=} lane
 */

/** @type {RemoteState|null} */
let state = null;

let pollTimerId = /** @type {number|null} */ (null);

// -----------------------------
// 屏幕切换
// -----------------------------

const screens = {
  setup: $("#screenSetup"),
  reveal: $("#screenReveal"),
  after: $("#screenAfter"),
  rules: $("#screenRules"),
};

/** @param {keyof typeof screens} name */
function showScreen(name) {
  for (const k of Object.keys(screens)) {
    screens[k].hidden = k !== name;
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resetAll() {
  stopPolling();
  state = null;
  localStorage.removeItem("timi_room_code");
  localStorage.removeItem("timi_room_token");
  localStorage.removeItem("timi_room_name");

  $("#revealMask").hidden = false;
  $("#revealContent").hidden = true;
  $("#undercoverBlock").hidden = true;
  $("#roleBadge").textContent = "身份";
  $("#roleBadge").classList.remove("role--normal", "role--undercover");
  $("#roleDesc").textContent = "描述";
  const laneEl = document.getElementById("laneText");
  if (laneEl) {
    laneEl.textContent = "分路：—";
    laneEl.hidden = true;
  }
  $("#taskList").innerHTML = "";
  $("#revealPlayerName").textContent = "玩家";
  $("#revealIndexText").textContent = "等待中…";
  $("#revealProgress").style.width = "0%";
  $("#maskTitle").textContent = "等待房间凑齐 5 人";
  $("#maskDesc").textContent = "当前人数：—/5。凑齐后系统会自动分配身份。";

  showScreen("setup");
  toast("已重置。");
}

async function apiPost(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `请求失败: ${res.status}`);
  }
  return data;
}

async function apiGet(path) {
  const res = await fetch(path, { method: "GET" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `请求失败: ${res.status}`);
  }
  return data;
}

function stopPolling() {
  if (pollTimerId != null) {
    window.clearInterval(pollTimerId);
    pollTimerId = null;
  }
}

function readJoinInputs() {
  const name = normalizeName($("#myName").value, "").trim();
  const code = normalizeName($("#roomCode").value, "").trim().toUpperCase();
  return { name, code };
}

async function createRoom() {
  const taskCount = Number($("#taskCount").value);
  const maxSameType = Number($("#maxSameType").value);
  const resp = await apiPost("/api/room", { maxPlayers: 5, taskCount, maxSameType });
  $("#roomCode").value = resp.code;
  toast(`房间已创建：${resp.code}（把房间码发给其他 4 人）`);
}

function updateWaitingUI(joined, maxPlayers) {
  $("#revealIndexText").textContent = joined >= maxPlayers ? "已到齐，准备分配…" : `等待中：${joined}/${maxPlayers}`;
  $("#revealProgress").style.width = `${(joined / maxPlayers) * 100}%`;
  $("#maskTitle").textContent = joined >= maxPlayers ? "正在分配身份…" : "等待房间凑齐 5 人";
  $("#maskDesc").textContent = `当前人数：${joined}/${maxPlayers}。凑齐后系统会自动分配身份。`;
}

function renderAssignment(role, tasks, settings, lane) {
  const badge = $("#roleBadge");
  const desc = $("#roleDesc");
  const laneEl = document.getElementById("laneText");

  if (role === "卧底") {
    badge.textContent = "卧底";
    badge.classList.remove("role--normal");
    badge.classList.add("role--undercover");
    desc.textContent =
      "你的目标：满足其一即胜利：① 游戏输掉且未被投票找出；② 完成任意 3 个隐藏任务（即使游戏赢了）。任务完成后不要立刻宣布，等游戏结束再揭晓。";
    $("#undercoverBlock").hidden = false;
    $("#maxSameTypeText").textContent = String(settings?.maxSameType ?? 2);

    const list = $("#taskList");
    list.innerHTML = "";
    for (const t of tasks || []) {
      const li = document.createElement("li");
      const tag = document.createElement("span");
      tag.className = "taskType";
      tag.textContent = t.type;
      li.appendChild(tag);
      li.appendChild(document.createTextNode(t.text));
      list.appendChild(li);
    }
  } else {
    badge.textContent = "正常玩家";
    badge.classList.remove("role--undercover");
    badge.classList.add("role--normal");
    desc.textContent = "你的目标：赢下比赛 + 找出卧底。注意：卧底可能在帮你赢，但在偷偷刷任务。";
    $("#undercoverBlock").hidden = true;
    $("#taskList").innerHTML = "";
  }

  if (laneEl) {
    if (lane) {
      laneEl.textContent = `分路：${lane}`;
      laneEl.hidden = false;
    } else {
      laneEl.textContent = "分路：—";
      laneEl.hidden = true;
    }
  }

  // 先遮挡，等用户点“查看”
  $("#revealMask").hidden = false;
  $("#revealContent").hidden = true;
  $("#btnRevealNow").textContent = "查看我的身份";
  $("#maskTitle").textContent = "请确认周围无人偷看";
  $("#maskDesc").textContent = "点击下方按钮后才会显示身份信息。显示后请截图保存或记牢。";
}

async function joinRoom() {
  const { name, code } = readJoinInputs();
  if (!name) throw new Error("请先输入你的名字");
  if (!code) throw new Error("请先输入房间码");

  const resp = await apiPost("/api/join", { name, code });
  state = {
    name: resp.name,
    code: resp.room,
    token: resp.token,
    status: resp.status,
    joined: resp.joined,
    maxPlayers: resp.maxPlayers,
    role: resp.role,
    tasks: resp.tasks,
    settings: resp.settings,
    lane: resp.lane,
  };

  localStorage.setItem("timi_room_code", state.code);
  localStorage.setItem("timi_room_token", state.token);
  localStorage.setItem("timi_room_name", state.name);

  $("#revealPlayerName").textContent = state.name;
  updateWaitingUI(state.joined, state.maxPlayers);
  showScreen("reveal");

  if (state.status === "assigned") {
    renderAssignment(
      state.role || "正常玩家",
      state.tasks || [],
      state.settings || { taskCount: 4, maxSameType: 2 },
      state.lane || ""
    );
    toast("身份已分配。建议立刻截图保存或记牢。");
  } else {
    $("#btnRevealNow").textContent = "刷新状态";
    $("#revealMask").hidden = false;
    $("#revealContent").hidden = true;
    startPolling();
    toast("已加入房间，等待其他玩家加入。");
  }
}

// -----------------------------
// 身份查看（传手机）
// -----------------------------

async function refreshMe() {
  if (!state) throw new Error("尚未加入房间");
  const resp = await apiGet(`/api/me?code=${encodeURIComponent(state.code)}&token=${encodeURIComponent(state.token)}`);
  state.status = resp.status;
  state.joined = resp.joined;
  state.maxPlayers = resp.maxPlayers;
  updateWaitingUI(state.joined, state.maxPlayers);

  if (resp.status === "assigned") {
    state.role = resp.role;
    state.tasks = resp.tasks;
    state.settings = resp.settings;
    state.lane = resp.lane;
    stopPolling();
    renderAssignment(
      state.role || "正常玩家",
      state.tasks || [],
      state.settings || { taskCount: 4, maxSameType: 2 },
      state.lane || ""
    );
    toast("身份已分配。建议立刻截图保存或记牢。");
  }
}

function startPolling() {
  stopPolling();
  pollTimerId = window.setInterval(() => {
    refreshMe().catch(() => {});
  }, 2000);
}

function revealNow() {
  // 两种状态：
  // - waiting：刷新状态
  // - assigned：显示身份
  if (!state) {
    toast("请先加入房间。");
    return;
  }
  if (state.status !== "assigned") {
    refreshMe().catch((e) => toast(String(e.message || e)));
    return;
  }
  $("#revealMask").hidden = true;
  $("#revealContent").hidden = false;
}

function hideReveal() {
  $("#revealMask").hidden = false;
  $("#revealContent").hidden = true;
  $("#undercoverBlock").hidden = true;
}

function memorizedDone() {
  hideReveal();
  toast("好的。需要再次查看可点“查看我的身份”。");
}

// -----------------------------
// 计时器（保留：给主持人用）
// -----------------------------

let timer = {
  totalSeconds: 60,
  remainingSeconds: 60,
  running: false,
  intervalId: /** @type {number|null} */ (null),
};

function renderTimer() {
  $("#timerReadout").textContent = formatMMSS(timer.remainingSeconds);
}

function setTimer(seconds) {
  timer.totalSeconds = Math.max(1, Math.floor(seconds));
  timer.remainingSeconds = timer.totalSeconds;
  renderTimer();
}

function stopTimer(reset) {
  timer.running = false;
  if (timer.intervalId != null) {
    window.clearInterval(timer.intervalId);
    timer.intervalId = null;
  }
  if (reset) {
    timer.remainingSeconds = timer.totalSeconds;
    renderTimer();
  }
}

function toggleTimer() {
  if (timer.running) {
    timer.running = false;
    if (timer.intervalId != null) {
      window.clearInterval(timer.intervalId);
      timer.intervalId = null;
    }
    return;
  }
  timer.running = true;
  if (timer.intervalId != null) window.clearInterval(timer.intervalId);
  timer.intervalId = window.setInterval(() => {
    if (!timer.running) return;
    timer.remainingSeconds -= 1;
    renderTimer();
    if (timer.remainingSeconds <= 0) {
      stopTimer(false);
      toast("时间到。");
    }
  }, 1000);
}

// -----------------------------
// 结算（保留旧 UI；异地版可不用）
// -----------------------------

function buildVoteSummary() {
  if (!state) return { summaryText: "无投票数据。", votedOutIndex: null };
  if (state.votes.length < state.players.length) return { summaryText: "投票尚未全部完成。", votedOutIndex: null };

  /** @type {Map<number, number>} */
  const counts = new Map();
  let skips = 0;
  for (const v of state.votes) {
    if (v.choiceIndex == null) {
      skips++;
      continue;
    }
    counts.set(v.choiceIndex, (counts.get(v.choiceIndex) ?? 0) + 1);
  }

  // 统计最高票（平票则判定“无人被投出”）
  let top = -1;
  let topCount = 0;
  let tie = false;
  for (const [idx, c] of counts.entries()) {
    if (c > topCount) {
      top = idx;
      topCount = c;
      tie = false;
    } else if (c === topCount && c > 0) {
      tie = true;
    }
  }
  const votedOutIndex = topCount === 0 || tie ? null : top;

  // 文本摘要
  const parts = [];
  for (let i = 0; i < state.players.length; i++) {
    const c = counts.get(i) ?? 0;
    parts.push(`${state.players[i]}：${c} 票`);
  }
  if (skips) parts.push(`弃票：${skips}`);

  let headline = "";
  if (votedOutIndex == null) headline = "结果：平票或无人得票 → 视为“未投出任何人”。";
  else headline = `结果：${state.players[votedOutIndex]} 最高票。`;

  return { summaryText: `${headline}\n${parts.join(" ｜ ")}`, votedOutIndex };
}

function computeOutcome() {
  if (!state) return "未开始本局。";

  const gameResult = $("#gameResult").value; // win/lose
  const tasksDone = Number($("#undercoverTasksDone").value);
  const tasksWin = tasksDone >= 3;
  const { votedOutIndex } = buildVoteSummary();
  const wasFound = votedOutIndex === state.undercoverIndex;

  // 情况A：任务胜利优先
  if (tasksWin) {
    return `【任务胜利】卧底完成 ≥3 个隐藏任务，直接获胜（即使对局 ${gameResult === "win" ? "赢了" : "输了"}）。`;
  }

  // 情况B：按原规则
  if (gameResult === "win") {
    return "【正常阵营胜】对局获胜，且卧底未达成任务胜利。";
  }

  // 输了
  if (!wasFound) {
    return "【卧底胜】对局输了，且卧底未被投票找出。";
  }
  return "【正常阵营胜】对局输了，但卧底被投票找出。";
}

function revealOutcome() {
  if (!state) {
    toast("请先开始抽取。");
    return;
  }
  if (state.votes.length < state.players.length) {
    toast("投票还没全部完成。请依次让 5 人都投完再结算。");
    return;
  }

  const { summaryText } = buildVoteSummary();
  $("#voteSummary").textContent = summaryText;

  // 身份公开
  const list = $("#identitySummary");
  list.innerHTML = "";
  for (let i = 0; i < state.players.length; i++) {
    const li = document.createElement("li");
    const left = document.createElement("div");
    left.textContent = state.players[i];
    const right = document.createElement("div");
    right.className = "muted";
    right.textContent = i === state.undercoverIndex ? "卧底" : "正常玩家";
    li.appendChild(left);
    li.appendChild(right);
    list.appendChild(li);
  }

  // 卧底任务公开（赛后）
  const tasks = $("#undercoverTasksPublic");
  tasks.innerHTML = "";
  for (const t of state.undercoverTasks) {
    const li = document.createElement("li");
    const tag = document.createElement("span");
    tag.className = "taskType";
    tag.textContent = t.type;
    li.appendChild(tag);
    li.appendChild(document.createTextNode(t.text));
    tasks.appendChild(li);
  }

  const outcome = computeOutcome();
  $("#outcomeText").textContent = outcome;
  $("#outcomePanel").hidden = false;
  toast("已公布结算与身份/任务。");
}

// -----------------------------
// 规则页
// -----------------------------

function openRules() {
  showScreen("rules");
}

function backFromRules() {
  if (state) showScreen("reveal");
  else showScreen("setup");
}

// -----------------------------
// 事件绑定
// -----------------------------

function bindEvents() {
  $("#btnReset").addEventListener("click", resetAll);

  $("#btnCreateRoom").addEventListener("click", () => {
    createRoom().catch((e) => toast(String(e.message || e)));
  });

  $("#btnJoinRoom").addEventListener("click", () => {
    joinRoom().catch((e) => toast(String(e.message || e)));
  });

  $("#btnRules").addEventListener("click", openRules);
  $("#btnBackFromRules").addEventListener("click", backFromRules);

  $("#btnRevealNow").addEventListener("click", revealNow);
  $("#btnHide").addEventListener("click", hideReveal);
  $("#btnMemorized").addEventListener("click", memorizedDone);

  $("#btnTimerSpeech").addEventListener("click", () => {
    stopTimer(false);
    setTimer(60);
  });
  $("#btnTimerDebate").addEventListener("click", () => {
    stopTimer(false);
    setTimer(120);
  });
  $("#btnTimerStop").addEventListener("click", () => stopTimer(true));
  $("#btnTimerStartPause").addEventListener("click", toggleTimer);

  $("#btnRevealOutcome").addEventListener("click", revealOutcome);
}

// -----------------------------
// 启动
// -----------------------------

bindEvents();
renderTimer();

// 恢复本地加入信息（避免刷新丢失）
try {
  const savedCode = (localStorage.getItem("timi_room_code") || "").trim().toUpperCase();
  const savedToken = (localStorage.getItem("timi_room_token") || "").trim();
  const savedName = (localStorage.getItem("timi_room_name") || "").trim();
  const qs = new URLSearchParams(location.search);
  const codeFromUrl = (qs.get("room") || "").trim().toUpperCase();

  if (codeFromUrl) $("#roomCode").value = codeFromUrl;

  if (savedName) $("#myName").value = savedName;
  if (savedCode && savedToken && savedName) {
    state = {
      name: savedName,
      code: savedCode,
      token: savedToken,
      status: "waiting",
      joined: 0,
      maxPlayers: 5,
    };
    $("#revealPlayerName").textContent = state.name;
    showScreen("reveal");
    refreshMe().catch(() => {});
    startPolling();
  }
} catch (_) {}

