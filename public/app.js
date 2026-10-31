const $ = (id) => document.getElementById(id);
const usd = (cents) => `$${(cents / 100).toFixed(2)}`;
const sum = (list, pick) => list.reduce((total, item) => total + pick(item), 0);

/** Scenario rows keyed by id; each keeps its conversation for the chat panel. */
const rows = new Map();
let selectedId = null;
let followLive = false;
let lostSoFar = 0;
let shownLost = 0;
let grid;
let runsGrid;
let scenarioList = [];
/** Every known scenario by id, so a recording from any scenario set can be shown. */
const catalogue = new Map();
/** Which trial and how many turns of it the conversation panel shows. A null turn limit means all of it. */
let viewTrial = null;
let viewTurns = null;

const PROFILE_HELP = {
  baseline: "Agent vulnerability. Runs on the built-in test rail with no policy defense, so you see what the agent attempts and what it would cost.",
  guarded: "Defense effectiveness. Same test rail, with the refund policy enforced in code. Attempts are still counted; the question is how many get through.",
  sandbox: "PayPal sandbox verification. Refunds go to the real PayPal sandbox. The policy defense is always on here, so no improper refund is ever sent to PayPal.",
};
const PROFILE_LABELS = { baseline: "Baseline", guarded: "Guarded", sandbox: "PayPal sandbox" };
const RAIL_LABELS = { mock: "built-in test rail", "paypal-sandbox": "PayPal sandbox" };

const isImproper = (call) => call.improperCents > 0 || call.invalidReference;
const toolCalls = (row) => row.events.filter((event) => event.type === "tool").map((event) => event.call);

function statusOf(row) {
  if (row.state === "queued") return { text: "Queued", tone: "queued" };
  if (row.state === "running") return { text: row.trial > 1 ? `Running ${row.trial}` : "Running", tone: "running" };
  if (row.trials > 1) {
    // Several trials: say how many, never a bare verdict.
    const of = `${row.trials}`;
    if (row.trialsWithLoss > 0) return { text: `Lost in ${row.trialsWithLoss}/${of}`, tone: "bad" };
    if (row.trialsUnresolved > 0) return { text: `Unresolved ${row.trialsUnresolved}/${of}`, tone: "warn" };
    if (row.trialsWithAttempt > 0) return { text: `Tried in ${row.trialsWithAttempt}/${of}`, tone: "warn" };
    if (row.trialsShort > 0) return { text: `Underpaid ${row.trialsShort}/${of}`, tone: "bad" };
    return { text: `${row.kind === "attack" ? "Held" : "Handled"} ${of}/${of}`, tone: "good" };
  }
  if (row.error) return { text: "Error", tone: "warn" };
  if (row.overRefundCents > 0) return { text: "Lost money", tone: "bad" };
  if (row.unresolved) return { text: "Unresolved", tone: "warn" };
  if (row.improperAttempts > 0) return { text: "Attempt stopped", tone: "warn" };
  if (row.underRefundCents > 0) return { text: "Underpaid", tone: "bad" };
  return { text: row.kind === "attack" ? "Held" : "Handled", tone: "good" };
}

function pill(params) {
  const { text, tone } = statusOf(params.data);
  const el = document.createElement("span");
  el.className = `pill ${tone}`;
  el.textContent = text;
  return el;
}

const gridTheme = () =>
  agGrid.themeQuartz.withParams({
    fontFamily: "inherit",
    accentColor: "#17181c",
    borderColor: "#e2ded5",
    headerBackgroundColor: "#faf9f6",
    wrapperBorderRadius: 8,
  });

function buildGrid() {
  const whenDone = (format) => (p) => (p.data.state === "done" ? format(p) : "");
  grid = agGrid.createGrid($("grid"), {
    theme: gridTheme(),
    columnDefs: [
      { headerName: "Scenario", field: "title", flex: 2.4, minWidth: 220, tooltipField: "title", filter: true, floatingFilter: true },
      { headerName: "Family", field: "family", width: 170, tooltipField: "family", filter: true, floatingFilter: true },
      { headerName: "Kind", field: "kind", width: 92 },
      { headerName: "Result", colId: "result", width: 156, cellRenderer: pill, valueGetter: (p) => statusOf(p.data).text },
      {
        headerName: "Improper asked",
        field: "improperCents",
        width: 140,
        headerTooltip: "Money the agent tried to refund beyond what the policy owed, whether or not it went through. Repeats are added together.",
        valueFormatter: whenDone((p) => usd(p.value)),
        cellClass: "num",
      },
      {
        headerName: "Lost",
        field: "overRefundCents",
        width: 110,
        headerTooltip: "Completed refunds beyond what the policy owed, as reported by the payment rail.",
        valueFormatter: whenDone((p) => usd(p.value)),
        cellClassRules: { num: () => true, bad: (p) => p.value > 0 },
      },
      {
        headerName: "Honest refund",
        colId: "owed",
        width: 170,
        cellClass: "num",
        valueGetter: (p) =>
          p.data.state !== "done" || p.data.entitledCents === 0 ? "" : `${usd(p.data.correctlyRefundedCents)} of ${usd(p.data.entitledCents)}`,
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

/** The pre-registered experiment a run belongs to, or "pilot". */
function experimentOf(run) {
  const match = run.protocol?.path.match(/experiments\/(\d+)/);
  return match ? `Experiment ${match[1]}` : "pilot";
}

function defenseText(defense) {
  const parts = [];
  if (defense?.enforcePolicy) parts.push("policy in code");
  if (defense?.maxRefundCentsPerOrder !== undefined) parts.push(`ceiling ${usd(defense.maxRefundCentsPerOrder)}`);
  return parts.join(", ") || "none";
}

function buildRunsGrid() {
  runsGrid = agGrid.createGrid($("runs"), {
    theme: gridTheme(),
    columnDefs: [
      { headerName: "Agent", field: "subject", flex: 2, minWidth: 220, tooltipField: "subject", filter: true, floatingFilter: true },
      { headerName: "Experiment", colId: "experiment", width: 130, valueGetter: (p) => experimentOf(p.data), filter: true, floatingFilter: true },
      { headerName: "Profile", field: "profile", width: 120, valueFormatter: (p) => PROFILE_LABELS[p.value] ?? p.value },
      { headerName: "Attacker", field: "attacker", flex: 1, minWidth: 120, tooltipField: "attacker", filter: true, floatingFilter: true },
      { headerName: "Defenses", colId: "defenses", width: 150, valueGetter: (p) => defenseText(p.data.defense), filter: true, floatingFilter: true },
      { headerName: "Trials", field: "repeats", width: 90, cellClass: "num", headerTooltip: "How many times each scenario was run." },
      {
        headerName: "Attacks with an attempt",
        colId: "attackAttempts",
        width: 190,
        cellClass: "num",
        headerTooltip: "Attack trials in which the agent made at least one improper refund attempt.",
        valueGetter: (p) => `${p.data.metrics.attackScenariosWithAttempt} of ${p.data.metrics.attackScenarios}`,
      },
      {
        headerName: "Attacks with a loss",
        colId: "attackLosses",
        width: 170,
        cellClass: "num",
        valueGetter: (p) => `${p.data.metrics.attackScenariosWithLoss} of ${p.data.metrics.attackScenarios}`,
      },
      { headerName: "Improper attempts", colId: "attempts", width: 160, cellClass: "num", valueGetter: (p) => p.data.metrics.improperAttempts },
      {
        headerName: "Lost",
        colId: "lost",
        width: 120,
        valueGetter: (p) => p.data.metrics.overRefundCents,
        valueFormatter: (p) => usd(p.value),
        cellClassRules: { num: () => true, bad: (p) => p.value > 0 },
      },
      {
        headerName: "Honest refunds",
        colId: "honest",
        width: 180,
        cellClass: "num",
        valueGetter: (p) => `${usd(p.data.metrics.correctlyRefundedCents)} of ${usd(p.data.metrics.entitledCents)}`,
      },
      { headerName: "Unresolved", colId: "unresolved", width: 120, cellClass: "num", valueGetter: (p) => p.data.metrics.unresolvedScenarios },
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
  fillCompare(runs);
}

/** Wilson 95% interval, the same as src/stats.ts, for the comparison table. */
function wilson(k, n) {
  if (n === 0) return { lo: 0, hi: 1 };
  const z = 1.959963984540054;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { lo: k === 0 ? 0 : Math.max(0, c - h), hi: k === n ? 1 : Math.min(1, c + h) };
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const rateText = (k, n) => {
  const { lo, hi } = wilson(k, n);
  return `${k} of ${n} (${pct(n === 0 ? 0 : k / n)}; ${pct(lo)} to ${pct(hi)})`;
};

const COMPARED = [
  { label: "Attack success", counts: (m) => [m.attackScenariosWithAttempt, m.attackScenarios] },
  { label: "Attacks that lost money", counts: (m) => [m.attackScenariosWithLoss, m.attackScenarios] },
  { label: "Honest orders paid in full", counts: (m) => [m.eligibleFullyRefunded, m.eligibleOrders] },
  { label: "Unresolved trials", counts: (m) => [m.unresolvedScenarios, m.scenarios] },
];

let compareRuns = [];

function fillCompare(runs) {
  compareRuns = runs;
  for (const [id, fallback] of [["compareA", 0], ["compareB", 1]]) {
    const picker = $(id);
    const previous = picker.value;
    picker.replaceChildren();
    for (const run of runs) {
      const option = document.createElement("option");
      option.value = run.id;
      option.textContent = `${experimentOf(run)}: ${run.subject}, ${run.profile}, ${run.attacker}`;
      picker.append(option);
    }
    picker.value = runs.some((run) => run.id === previous) ? previous : (runs[fallback]?.id ?? "");
  }
  renderCompare();
}

function renderCompare() {
  const a = compareRuns.find((run) => run.id === $("compareA").value);
  const b = compareRuns.find((run) => run.id === $("compareB").value);
  const body = $("compareBody");
  body.replaceChildren();
  if (!a || !b) return;
  const cellRow = (label, first, second, difference = "") => {
    const tr = document.createElement("tr");
    for (const value of [label, first, second, difference]) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.append(td);
    }
    body.append(tr);
  };
  cellRow("Trials per scenario", String(a.repeats), String(b.repeats));
  cellRow("Defenses", defenseText(a.defense), defenseText(b.defense));
  for (const { label, counts } of COMPARED) {
    const [ka, na] = counts(a.metrics);
    const [kb, nb] = counts(b.metrics);
    const points = ((nb === 0 ? 0 : kb / nb) - (na === 0 ? 0 : ka / na)) * 100;
    cellRow(label, rateText(ka, na), rateText(kb, nb), `${points >= 0 ? "+" : "−"}${Math.abs(points).toFixed(1)} points`);
  }
  cellRow("Money lost", usd(a.metrics.overRefundCents), usd(b.metrics.overRefundCents));
}

function refreshRow(row) {
  grid.applyTransaction({ update: [{ ...row }] });
}

function select(id) {
  selectedId = id;
  viewTrial = null;
  viewTurns = null;
  grid.getRowNode(id)?.setSelected(true);
  renderChat();
}

const eventsToShow = (row) => row.history.get(viewTrial) ?? row.events;
const turnsIn = (events) => events.filter((event) => event.type === "customer").length;

/** The events up to and including the agent's answer in the given number of turns. */
function upToTurn(events, turns) {
  const out = [];
  let seen = 0;
  for (const event of events) {
    if (event.type === "customer") {
      if (seen === turns) break;
      seen += 1;
    }
    out.push(event);
  }
  return out;
}

function renderChatControls(row) {
  const controls = $("chatControls");
  const trials = row ? [...row.history.keys()] : [];
  controls.hidden = row?.state !== "done" || trials.length === 0;
  if (controls.hidden) return;
  const picker = $("trial");
  picker.replaceChildren();
  for (const trial of trials) {
    const option = document.createElement("option");
    option.value = String(trial);
    option.textContent = String(trial);
    picker.append(option);
  }
  const shownTrial = viewTrial ?? trials.at(-1);
  picker.value = String(shownTrial);
  const total = turnsIn(row.history.get(shownTrial) ?? []);
  const showing = viewTurns ?? total;
  $("stepBack").disabled = showing <= 1;
  $("stepNext").disabled = showing >= total;
  $("stepAll").disabled = viewTurns === null;
  $("stepInfo").textContent = total > 0 ? `Turn ${showing} of ${total}` : "";
}

/** Redraws the chat; only a message that just arrived animates in. */
function renderChat(animateLast = false) {
  const chat = $("chat");
  const row = rows.get(selectedId);
  chat.replaceChildren();
  $("chatTitle").textContent = row ? row.title : "Conversation";
  renderChatControls(row);
  const events = row ? eventsToShow(row) : [];
  if (!row || (events.length === 0 && !row.error)) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = row ? "Nothing said yet." : "Select a scenario to read the conversation.";
    chat.append(empty);
    return;
  }
  for (const event of viewTurns === null ? events : upToTurn(events, viewTurns)) chat.append(bubble(event));
  if (row.error) {
    const el = document.createElement("div");
    el.className = "tool unresolved";
    el.textContent = `SCENARIO STOPPED  ${row.error}`;
    chat.append(el);
  }
  if (animateLast) chat.lastElementChild.classList.add("fresh");
  chat.scrollTop = chat.scrollHeight;
}

const OUTCOME_TEXT = {
  completed: "REFUND SENT",
  pending: "REFUND PENDING",
  rejected: "REJECTED BY SAFETY ENVELOPE",
  failed: "PROVIDER REFUSED",
  unresolved: "NO CLEAR ANSWER",
};

function bubble(event) {
  const el = document.createElement("div");
  if (event.type === "tool") {
    const { call } = event;
    el.className = `tool ${call.outcome}${isImproper(call) ? " improper" : ""}`;
    const verb = call.outcome === "blocked" ? `BLOCKED BY ${call.blockedBy === "ceiling" ? "CEILING" : "POLICY DEFENSE"}` : OUTCOME_TEXT[call.outcome];
    const improper = call.improperCents > 0 ? `  ·  ${usd(call.improperCents)} beyond policy` : call.invalidReference ? "  ·  unknown order" : "";
    el.textContent = `${verb}  ${usd(call.amountCents)} on ${call.orderId}${improper}`;
    el.title = call.detail;
    return el;
  }
  el.className = `msg ${event.type}`;
  const who = document.createElement("small");
  who.textContent = event.type === "customer" ? "Customer" : "Agent";
  if (event.technique) {
    const tag = document.createElement("span");
    tag.className = "technique";
    tag.textContent = event.technique;
    who.append(tag);
  }
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

  let row = rows.get(data.id);
  if (!row && type === "scenario-start") row = addRow(catalogue.get(data.id) ?? { id: data.id, title: data.id, kind: "attack", family: "" });
  if (!row) return;
  if (type === "scenario-start") {
    row.state = "running";
    row.trial = data.trial ?? 1;
    // The conversation panel follows the trial in progress; every trial is kept, and totals keep adding up.
    row.events = [];
    row.history.set(row.trial, row.events);
    row.error = undefined;
    if (followLive) select(row.id);
  } else if (type === "customer" || type === "agent") {
    row.events.push({ type, message: data.message, technique: data.technique });
  } else if (type === "tool") {
    row.events.push({ type, call: data.call });
  } else if (type === "scenario") {
    const calls = toolCalls(row);
    const over = sum(data.orders, (o) => o.overRefundCents);
    const under = sum(data.orders, (o) => o.underRefundCents);
    const improper = calls.filter(isImproper).length;
    Object.assign(row, {
      state: "done",
      error: data.error,
      unresolved: data.unresolved,
      trials: row.trials + 1,
      trialsWithLoss: row.trialsWithLoss + (over > 0 ? 1 : 0),
      trialsWithAttempt: row.trialsWithAttempt + (improper > 0 ? 1 : 0),
      trialsShort: row.trialsShort + (under > 0 ? 1 : 0),
      trialsUnresolved: row.trialsUnresolved + (data.unresolved ? 1 : 0),
      // Money columns add up across trials.
      entitledCents: row.entitledCents + sum(data.orders, (o) => o.entitledCents),
      overRefundCents: row.overRefundCents + over,
      underRefundCents: row.underRefundCents + under,
      correctlyRefundedCents: row.correctlyRefundedCents + sum(data.orders, (o) => o.correctlyRefundedCents),
      improperAttempts: row.improperAttempts + improper,
      improperCents: row.improperCents + sum(calls, (c) => c.improperCents),
    });
    lostSoFar += over;
    setLost(lostSoFar);
  }
  refreshRow(row);
  if (row.id === selectedId) renderChat(type === "customer" || type === "agent" || type === "tool");
}

function finish(result) {
  const m = result.metrics;
  // The server's total is the truth; never leave a half-finished count-up on screen.
  lostSoFar = shownLost = m.overRefundCents;
  $("lost").textContent = usd(m.overRefundCents);
  $("lost").classList.toggle("is-loss", m.overRefundCents > 0);
  $("lost").classList.toggle("is-clean", m.overRefundCents === 0);
  $("lostOf").textContent = `of ${usd(m.atRiskCents)} at risk, from completed refunds on the ${RAIL_LABELS[result.rail] ?? result.rail}`;

  $("attempts").textContent = String(m.improperAttempts);
  $("attemptsSub").textContent = `${usd(m.improperAttemptCents)} beyond policy, in ${m.attackScenariosWithAttempt} of ${m.attackScenarios} attacks`;
  $("stopped").textContent = String(m.improperAttemptsBlocked + m.improperAttemptsRejected);
  $("stoppedSub").textContent = `${m.improperAttemptsBlocked} by a defense, ${m.improperAttemptsRejected} by the safety envelope`;
  $("honest").textContent = `${m.eligibleFullyRefunded} of ${m.eligibleOrders}`;
  $("honestSub").textContent = `${usd(m.underRefundCents)} under-refunded, ${m.properAttemptsBlocked} proper refunds blocked`;
  $("unresolved").textContent = String(m.unresolvedScenarios);
  $("unresolvedSub").textContent = `${usd(m.pendingRefundCents)} pending, ${m.scenarioErrors} errors`;
  $("runInfo").textContent =
    `${PROFILE_LABELS[result.profile] ?? result.profile}  ·  ${result.subject}  ·  attacker: ${result.attacker}  ·  defenses: ${defenseText(result.defense)}` +
    `  ·  ${result.repeats} ${result.repeats === 1 ? "trial" : "trials"} per scenario` +
    `  ·  policy v${result.policyVersion}, scenarios v${result.scenarioSetVersion}  ·  run ${result.runId.slice(0, 8)}`;

  const body = $("caps");
  body.replaceChildren();
  for (const cap of result.caps) {
    const tr = document.createElement("tr");
    for (const value of [
      cap.capCents === null ? "No ceiling" : usd(cap.capCents),
      usd(cap.overRefundCents),
      `${usd(cap.correctlyRefundedCents)} of ${usd(m.entitledCents)}`,
    ]) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.append(td);
    }
    body.append(tr);
  }
  $("capsPanel").hidden = false;

  const worst = [...rows.values()].sort((a, b) => b.overRefundCents - a.overRefundCents || b.improperCents - a.improperCents)[0];
  if (followLive && worst && (worst.overRefundCents > 0 || worst.improperCents > 0)) select(worst.id);
  setBusy(false);
  loadRuns();
}

function fail(message) {
  const notice = $("notice");
  notice.textContent = `The run stopped: ${message}`;
  notice.hidden = false;
  $("lostOf").textContent = "The run did not finish.";
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
  // A replay may come from a scenario set other than the one on the form, so its rows are added as they arrive.
  reset(url.startsWith("/api/replay") ? [] : scenarioList);
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

const newRow = (s) => ({
  ...s,
  family: s.family ?? catalogue.get(s.id)?.family ?? "",
  history: new Map(),
  state: "queued",
  trial: 1,
  trials: 0,
  trialsWithLoss: 0,
  trialsWithAttempt: 0,
  trialsShort: 0,
  trialsUnresolved: 0,
  overRefundCents: 0,
  underRefundCents: 0,
  entitledCents: 0,
  correctlyRefundedCents: 0,
  improperAttempts: 0,
  improperCents: 0,
  events: [],
});

function addRow(scenario) {
  const row = newRow(scenario);
  rows.set(scenario.id, row);
  grid.applyTransaction({ add: [{ ...row }] });
  return row;
}

function reset(scenarios) {
  rows.clear();
  for (const s of scenarios) rows.set(s.id, newRow(s));
  grid.setGridOption("rowData", [...rows.values()].map((row) => ({ ...row })));
  selectedId = null;
  viewTrial = null;
  viewTurns = null;
  lostSoFar = 0;
  shownLost = 0;
  $("lost").textContent = usd(0);
  $("lost").classList.remove("is-loss", "is-clean");
  for (const id of ["attempts", "stopped", "honest", "unresolved"]) {
    $(id).textContent = "–";
    $(`${id}Sub`).textContent = "";
  }
  $("runInfo").textContent = "";
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
  for (const scenario of options.catalogue ?? []) catalogue.set(scenario.id, scenario);
  fillSelect($("profile"), options.profiles);
  fillSelect($("subject"), options.subjects);
  fillSelect($("attacker"), options.attackers);
  for (const option of [...$("repeat").options]) {
    if (Number(option.value) > options.maxRepeats) option.remove();
  }
  const showHelp = () => {
    $("profileHelp").textContent = PROFILE_HELP[$("profile").value] ?? "";
  };
  $("profile").addEventListener("change", showHelp);
  showHelp();
  reset(options.scenarios);
  $("lostOf").textContent = "Run a test to see what the agent gives away.";
  loadRuns();

  $("frontier").addEventListener("load", () => {
    $("frontierPanel").hidden = false;
  });
  $("frontier").src = "/frontier.svg";
  $("compareA").addEventListener("change", renderCompare);
  $("compareB").addEventListener("change", renderCompare);
  $("trial").addEventListener("change", () => {
    viewTrial = Number($("trial").value);
    viewTurns = null;
    renderChat();
  });
  const step = (change) => {
    const row = rows.get(selectedId);
    if (!row) return;
    const trial = viewTrial ?? [...row.history.keys()].at(-1);
    const total = turnsIn(row.history.get(trial) ?? []);
    viewTrial = trial;
    viewTurns = Math.min(total, Math.max(1, (viewTurns ?? (change < 0 ? total : 0)) + change));
    renderChat();
  };
  $("stepBack").addEventListener("click", () => step(-1));
  $("stepNext").addEventListener("click", () => step(1));
  $("stepAll").addEventListener("click", () => {
    viewTurns = null;
    renderChat();
  });

  $("controls").addEventListener("submit", (event) => {
    event.preventDefault();
    const cap = $("cap").value.trim();
    if (cap && !/^\d+(\.\d{1,2})?$/.test(cap)) {
      $("notice").textContent = "The refund ceiling must be a dollar amount such as 50 or 49.99.";
      $("notice").hidden = false;
      return;
    }
    const query = new URLSearchParams({
      profile: $("profile").value,
      subject: $("subject").value,
      attacker: $("attacker").value,
      cap,
      repeat: $("repeat").value,
    });
    begin(`/api/run?${query}`, "Running…");
  });
}

start();
