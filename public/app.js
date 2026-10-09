const $ = (id) => document.getElementById(id);
const usd = (cents) => `$${(cents / 100).toFixed(2)}`;

/** Scenario rows keyed by id; each keeps its conversation for the chat panel. */
const rows = new Map();
let selectedId = null;
let followLive = false;
let lostSoFar = 0;
let shownLost = 0;
let grid;
let runsGrid;
let scenarioList = [];

function statusOf(row) {
  if (row.state === "queued") return { text: "Queued", tone: "queued" };
  if (row.state === "running") return { text: "Running", tone: "running" };
  if (row.wrongfulCents > 0) return { text: "Lost money", tone: "bad" };
  if (row.paidOwedCents < row.owedCents) return { text: "Underpaid", tone: "bad" };
  return { text: row.kind === "attack" ? "Held" : "Handled", tone: "good" };
}

function pill(params) {
  const { text, tone } = statusOf(params.data);
  const el = document.createElement("span");
  el.className = `pill ${tone}`;
  el.textContent = text;
  return el;
}

function buildGrid() {
  grid = agGrid.createGrid($("grid"), {
    theme: agGrid.themeQuartz.withParams({
      fontFamily: "inherit",
      accentColor: "#17181c",
      borderColor: "#e2ded5",
      headerBackgroundColor: "#faf9f6",
      wrapperBorderRadius: 8,
    }),
    columnDefs: [
      { headerName: "Scenario", field: "title", flex: 2.4, minWidth: 220, tooltipField: "title" },
      { headerName: "Kind", field: "kind", width: 96 },
      { headerName: "Result", colId: "result", width: 124, cellRenderer: pill, valueGetter: (p) => statusOf(p.data).text },
      {
        headerName: "Lost",
        field: "wrongfulCents",
        width: 110,
        valueFormatter: (p) => (p.data.state === "done" ? usd(p.value) : ""),
        cellClassRules: { num: () => true, bad: (p) => p.value > 0 },
      },
      {
        headerName: "Honest refund",
        colId: "owed",
        width: 170,
        cellClass: "num",
        valueGetter: (p) =>
          p.data.state !== "done" || p.data.owedCents === 0 ? "" : `${usd(p.data.paidOwedCents)} of ${usd(p.data.owedCents)}`,
      },
    ],
    rowData: [],
    getRowId: (p) => p.data.id,
    domLayout: "autoHeight",
    rowSelection: { mode: "singleRow", checkboxes: false, enableClickSelection: true },
    suppressCellFocus: true,
    onRowClicked: (event) => {
      followLive = false;
      select(event.data.id);
    },
  });
}

function guardText(guard) {
  const parts = [];
  if (guard?.maxRefundCentsPerCall !== undefined) parts.push(`ceiling ${usd(guard.maxRefundCentsPerCall)}`);
  if (guard?.enforcePolicy) parts.push("policy in code");
  return parts.join(", ") || "none";
}

function buildRunsGrid() {
  runsGrid = agGrid.createGrid($("runs"), {
    theme: agGrid.themeQuartz.withParams({
      fontFamily: "inherit",
      accentColor: "#17181c",
      borderColor: "#e2ded5",
      headerBackgroundColor: "#faf9f6",
      wrapperBorderRadius: 8,
    }),
    columnDefs: [
      { headerName: "Agent", field: "subject", flex: 2, minWidth: 220, tooltipField: "subject" },
      { headerName: "Attacker", field: "attacker", flex: 1, minWidth: 120, tooltipField: "attacker" },
      { headerName: "Rail", field: "rail", width: 150, valueFormatter: (p) => RAIL_LABELS[p.value] ?? p.value },
      { headerName: "Guards", colId: "guards", width: 150, valueGetter: (p) => guardText(p.data.guard) },
      {
        headerName: "Lost",
        colId: "lost",
        width: 120,
        valueGetter: (p) => p.data.totals.wrongfulCents,
        valueFormatter: (p) => usd(p.value),
        cellClassRules: { num: () => true, bad: (p) => p.value > 0 },
      },
      {
        headerName: "Honest refunds",
        colId: "honest",
        width: 180,
        cellClass: "num",
        valueGetter: (p) => `${usd(p.data.totals.paidOwedCents)} of ${usd(p.data.totals.owedCents)}`,
      },
      { headerName: "Saved", field: "savedAt", width: 170, valueFormatter: (p) => new Date(p.value).toLocaleString() },
    ],
    rowData: [],
    getRowId: (p) => p.data.id,
    rowSelection: { mode: "singleRow", checkboxes: false, enableClickSelection: true },
    suppressCellFocus: true,
    overlayNoRowsTemplate: "No saved runs yet. Run a crash test and it will appear here.",
    onRowClicked: (event) => {
      if ($("run").disabled) return;
      begin(`/api/replay?id=${encodeURIComponent(event.data.id)}`, "Replaying…");
    },
  });
}

async function loadRuns() {
  const runs = await (await fetch("/api/recordings")).json();
  runsGrid.setGridOption("rowData", runs);
}

function refreshRow(row) {
  grid.applyTransaction({ update: [{ ...row }] });
}

function select(id) {
  selectedId = id;
  grid.getRowNode(id)?.setSelected(true);
  renderChat();
}

const RAIL_LABELS = { mock: "Built-in test rail", "paypal-sandbox": "PayPal sandbox" };

/** Redraws the chat; only a message that just arrived animates in. */
function renderChat(animateLast = false) {
  const chat = $("chat");
  const row = rows.get(selectedId);
  chat.replaceChildren();
  $("chatTitle").textContent = row ? row.title : "Conversation";
  if (!row || row.events.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = row ? "Nothing said yet." : "Select a scenario to read the conversation.";
    chat.append(empty);
    return;
  }
  for (const event of row.events) chat.append(bubble(event));
  if (animateLast) chat.lastElementChild.classList.add("fresh");
  chat.scrollTop = chat.scrollHeight;
}

function bubble(event) {
  const el = document.createElement("div");
  if (event.type === "tool") {
    const { call } = event;
    el.className = `tool ${call.outcome}`;
    const verb = { executed: "REFUND SENT", blocked: "BLOCKED BY GUARD", failed: "REFUND FAILED" }[call.outcome];
    el.textContent = `${verb}  ${usd(call.amountCents)} on ${call.orderId}`;
    el.title = call.detail;
    return el;
  }
  el.className = `msg ${event.type}`;
  const who = document.createElement("small");
  who.textContent = event.type === "customer" ? "Customer" : "Agent";
  const text = document.createElement("span");
  text.textContent = event.message;
  el.append(who, text);
  return el;
}

function setLost(target) {
  const figure = $("lost");
  const from = shownLost;
  const start = performance.now();
  figure.classList.toggle("is-loss", target > 0);
  // Browsers pause animation frames in a hidden tab, so skip the count-up there.
  if (document.hidden || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    shownLost = target;
    figure.textContent = usd(target);
    return;
  }
  const step = (now) => {
    if (lostSoFar !== target) return; // a newer total has taken over
    const t = Math.min(1, (now - start) / 500);
    shownLost = Math.round(from + (target - from) * (1 - (1 - t) ** 3));
    figure.textContent = usd(shownLost);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  // If frames are not being drawn (a covered window, say), still land on the number.
  setTimeout(() => {
    if (lostSoFar === target && shownLost !== target) {
      shownLost = target;
      figure.textContent = usd(target);
    }
  }, 700);
}

/** Events are replayed with short pauses so an instant offline run is still readable. */
const queue = [];
let draining = false;
const PAUSE = { "scenario-start": 100, customer: 220, tool: 180, agent: 220, scenario: 140, done: 0, failed: 0 };

function enqueue(type, data) {
  queue.push({ type, data });
  if (!draining) drain();
}

async function drain() {
  draining = true;
  while (queue.length > 0) {
    const { type, data } = queue.shift();
    apply(type, data);
    await new Promise((resolve) => setTimeout(resolve, PAUSE[type] ?? 0));
  }
  draining = false;
}

function apply(type, data) {
  if (type === "done") return finish(data);
  if (type === "failed") return fail(data.message);

  const row = rows.get(data.id);
  if (!row) return;
  if (type === "scenario-start") {
    row.state = "running";
    if (followLive) select(row.id);
  } else if (type === "customer" || type === "agent") {
    row.events.push({ type, message: data.message });
  } else if (type === "tool") {
    row.events.push({ type, call: data.call });
  } else if (type === "scenario") {
    Object.assign(row, data, { state: "done" });
    lostSoFar += data.wrongfulCents;
    setLost(lostSoFar);
  }
  refreshRow(row);
  if (row.id === selectedId) renderChat(type === "customer" || type === "agent" || type === "tool");
}

function finish(result) {
  const t = result.totals;
  // The server's total is the truth; never leave a half-finished count-up on screen.
  lostSoFar = shownLost = t.wrongfulCents;
  $("lost").textContent = usd(t.wrongfulCents);
  $("lost").classList.toggle("is-clean", t.wrongfulCents === 0);
  $("lostOf").textContent = `of ${usd(t.atRiskCents)} the policy did not owe`;
  $("attacksPaid").textContent = `${t.attacksThatPaid} of ${t.attacksRun}`;
  $("honestPaid").textContent = `${usd(t.paidOwedCents)} of ${usd(t.owedCents)}`;
  $("railName").textContent = RAIL_LABELS[result.rail] ?? result.rail;
  $("agentName").textContent = result.subject;

  const body = $("caps");
  body.replaceChildren();
  for (const cap of result.caps) {
    const tr = document.createElement("tr");
    for (const value of [
      cap.capCents === null ? "No ceiling" : usd(cap.capCents),
      usd(cap.wrongfulCents),
      `${usd(cap.paidOwedCents)} of ${usd(t.owedCents)}`,
    ]) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.append(td);
    }
    body.append(tr);
  }
  $("capsPanel").hidden = false;

  const worst = [...rows.values()].sort((a, b) => b.wrongfulCents - a.wrongfulCents)[0];
  if (followLive && worst && worst.wrongfulCents > 0) select(worst.id);
  setBusy(false);
  loadRuns();
}

function fail(message) {
  const notice = $("notice");
  notice.textContent = `The run stopped: ${message}`;
  notice.hidden = false;
  for (const row of rows.values()) {
    if (row.state === "running") {
      row.state = "queued";
      refreshRow(row);
    }
  }
  setBusy(false);
}

function setBusy(busy, label = "Running…") {
  $("run").disabled = busy;
  $("run").textContent = busy ? label : "Run crash test";
}

/** Starts a live run or a replay; both arrive as the same stream of events. */
function begin(url, label) {
  reset(scenarioList);
  $("lostOf").textContent = label;
  followLive = true;
  setBusy(true, label);

  const stream = new EventSource(url);
  let ended = false;
  for (const type of Object.keys(PAUSE)) {
    stream.addEventListener(type, (message) => {
      if (type === "done" || type === "failed") {
        ended = true;
        stream.close();
      }
      enqueue(type, JSON.parse(message.data));
    });
  }
  stream.onerror = () => {
    if (ended) return;
    stream.close();
    enqueue("failed", { message: "lost the connection to the Crashtest server." });
  };
}

function reset(scenarios) {
  rows.clear();
  for (const s of scenarios) {
    rows.set(s.id, { ...s, state: "queued", wrongfulCents: 0, owedCents: 0, paidOwedCents: 0, events: [] });
  }
  grid.setGridOption("rowData", [...rows.values()].map((row) => ({ ...row })));
  selectedId = null;
  lostSoFar = 0;
  shownLost = 0;
  $("lost").textContent = usd(0);
  $("lost").classList.remove("is-loss", "is-clean");
  $("lostOf").textContent = "Running…";
  for (const id of ["attacksPaid", "honestPaid", "railName", "agentName"]) $(id).textContent = "–";
  $("capsPanel").hidden = true;
  $("notice").hidden = true;
  renderChat();
}

function fillSelect(select, choices) {
  for (const choice of choices) {
    const option = document.createElement("option");
    option.value = choice.id;
    option.textContent = choice.available ? choice.label : `${choice.label} (needs ${choice.needs})`;
    option.disabled = !choice.available;
    select.append(option);
  }
}

async function start() {
  buildGrid();
  buildRunsGrid();
  const options = await (await fetch("/api/options")).json();
  scenarioList = options.scenarios;
  loadRuns();
  fillSelect($("subject"), options.subjects);
  fillSelect($("attacker"), options.attackers);
  fillSelect($("rail"), options.rails);
  reset(options.scenarios);
  $("lostOf").textContent = "Run a test to see what the agent gives away.";

  $("controls").addEventListener("submit", (event) => {
    event.preventDefault();
    const cap = $("cap").value.trim();
    if (cap && !/^\d+(\.\d{1,2})?$/.test(cap)) {
      $("notice").textContent = "The refund ceiling must be a dollar amount such as 50 or 49.99.";
      $("notice").hidden = false;
      return;
    }
    const query = new URLSearchParams({
      subject: $("subject").value,
      attacker: $("attacker").value,
      rail: $("rail").value,
      cap,
      enforcePolicy: String($("enforcePolicy").checked),
    });
    begin(`/api/run?${query}`, "Running…");
  });
}

start();
