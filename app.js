/************************************************************
 * 8 Brand Screenshot Dashboard (GitHub Pages)
 * - OCR via Tesseract.js (runs locally in browser)
 * - Parses daily table screenshot:
 *   Date | Registered Users | First Depositors | ... | Active Players | Turnover
 * - Computes 1D / 7D / 14D:
 *   1D = end day vs prev day
 *   7D = avg(last7) vs avg(prev7)
 *   14D = avg(last14) vs avg(prev14)
 * - Toggle: Use last completed day (prevents partial-day drops)
 ************************************************************/

const BRANDS = ["M1","M2","B1","B2","B3","B4","K1","TK"];
const METRICS = ["active","deposit","reg","ftd","turnover"];

const els = {
  endDate: document.getElementById("endDate"),
  files: document.getElementById("files"),
  runBtn: document.getElementById("runBtn"),
  clearBtn: document.getElementById("clearBtn"),
  globalStatus: document.getElementById("globalStatus"),
  progressText: document.getElementById("progressText"),
  toggleLastCompleted: document.getElementById("toggleLastCompleted"),
  comparisonEndDateText: document.getElementById("comparisonEndDateText"),

  summaryGrid: document.getElementById("summaryGrid"),
  activeTable: document.getElementById("activeTable"),
  allTable: document.getElementById("allTable"),
  rawPanels: document.getElementById("rawPanels"),
};

const state = {
  endDate: null,
  comparisonEndDate: null,
  useLastCompleted: true,

  ocrTextByBrand: {},   // brand -> full OCR text
  rowsByBrand: {},      // brand -> [{date, reg, ftd, deposit, active, turnover}]
  resultsByBrand: {},   // brand -> computed results

  busy: false,
};

init();

function init(){
  // default end date = today
  const today = new Date().toISOString().slice(0,10);
  els.endDate.value = today;

  // initial label
  recalcComparisonEndDate_();

  els.toggleLastCompleted.addEventListener("change", () => {
    recalcComparisonEndDate_();
  });

  els.endDate.addEventListener("change", () => {
    recalcComparisonEndDate_();
  });

  els.runBtn.addEventListener("click", runAll_);
  els.clearBtn.addEventListener("click", clearAll_);

  // Tabs
  document.querySelectorAll(".tab").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      document.querySelectorAll(".tab").forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      showTab_(tab);
    });
  });

  // init storage
  BRANDS.forEach(b=>{
    state.ocrTextByBrand[b] = "";
    state.rowsByBrand[b] = [];
    state.resultsByBrand[b] = null;
  });

  setStatus_("Ready", "neutral");
}

function showTab_(tab){
  document.querySelectorAll(".tabPane").forEach(p=>p.classList.add("hidden"));
  const pane = document.getElementById(`tab-${tab}`);
  if (pane) pane.classList.remove("hidden");
}

function clearAll_(){
  if (state.busy) return;
  els.files.value = "";
  BRANDS.forEach(b=>{
    state.ocrTextByBrand[b] = "";
    state.rowsByBrand[b] = [];
    state.resultsByBrand[b] = null;
  });
  els.summaryGrid.innerHTML = "";
  els.activeTable.innerHTML = "";
  els.allTable.innerHTML = "";
  els.rawPanels.innerHTML = "";
  setStatus_("Cleared", "neutral");
  els.progressText.textContent = "";
  recalcComparisonEndDate_();
}

function setStatus_(text, kind){
  els.globalStatus.textContent = text;
  els.globalStatus.className = `badge ${kind || "neutral"}`;
}

function recalcComparisonEndDate_(){
  const endDate = (els.endDate.value || "").trim();
  state.endDate = endDate || null;
  state.useLastCompleted = !!els.toggleLastCompleted.checked;

  if (!endDate){
    state.comparisonEndDate = null;
    els.comparisonEndDateText.textContent = "—";
    return;
  }

  const compEnd = chooseComparisonEndDate_(endDate, state.useLastCompleted, 23, 59);
  state.comparisonEndDate = compEnd;
  els.comparisonEndDateText.textContent = compEnd;
}

function shiftDate_(dateStr, deltaDays){
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + deltaDays);
  return d.toISOString().slice(0,10);
}

function chooseComparisonEndDate_(selectedEndDate, useLastCompleted, cutoffHour=23, cutoffMin=59){
  if (!useLastCompleted) return selectedEndDate;

  const now = new Date();
  const today = now.toISOString().slice(0,10);
  if (selectedEndDate !== today) return selectedEndDate;

  const cutoff = new Date();
  cutoff.setHours(cutoffHour, cutoffMin, 0, 0);

  // Before cutoff: use yesterday to avoid partial-day drops
  if (now < cutoff) return shiftDate_(selectedEndDate, -1);
  return selectedEndDate;
}

/* ------------------------- MAIN RUN ------------------------- */

async function runAll_(){
  if (state.busy) return;

  recalcComparisonEndDate_();
  if (!state.endDate){
    setStatus_("End date required", "warn");
    return;
  }

  const files = Array.from(els.files.files || []);
  if (!files.length){
    setStatus_("Upload 8 screenshots", "warn");
    return;
  }

  state.busy = true;
  setStatus_("Running OCR…", "neutral");
  els.progressText.textContent = "";

  try{
    // Map files -> brand
    const byBrand = mapFilesToBrands_(files);

    // OCR each brand
    for (let i=0; i<BRANDS.length; i++){
      const brand = BRANDS[i];
      const f = byBrand[brand];

      if (!f){
        state.ocrTextByBrand[brand] = "";
        state.rowsByBrand[brand] = [];
        state.resultsByBrand[brand] = { status:"ERR", reason:"Missing screenshot" };
        continue;
      }

      els.progressText.textContent = `OCR: ${brand} (${i+1}/${BRANDS.length})…`;
      const text = await ocrFile_(f);
      state.ocrTextByBrand[brand] = text || "";

      const rows = parseDailyRowsFromOCR_(text || "");
      state.rowsByBrand[brand] = rows;

      const res = computeBrandResults_(rows, state.comparisonEndDate);
      state.resultsByBrand[brand] = res;
    }

    // Build UI
    renderSummary_();
    renderActiveTable_();
    renderAllTable_();
    renderRawPanels_();

    // Global status
    const anyErr = BRANDS.some(b => (state.resultsByBrand[b]?.status === "ERR"));
    const anyWarn = BRANDS.some(b => (state.resultsByBrand[b]?.status === "WARN"));
    setStatus_(anyErr ? "Done (with errors)" : anyWarn ? "Done (some warnings)" : "Done", anyErr ? "bad" : anyWarn ? "warn" : "good");

    els.progressText.textContent = "";
    showTab_("active"); // best default view
  } catch (e){
    console.error(e);
    setStatus_("Error (see console)", "bad");
    els.progressText.textContent = String(e?.message || e);
  } finally {
    state.busy = false;
  }
}

/* ------------------------- FILE MAP ------------------------- */

function mapFilesToBrands_(files){
  // Accept:
  // - m1.png
  // - M1_2026-02-02.png
  // - b4.jpg
  const out = {};
  for (const f of files){
    const name = (f.name || "").trim();
    const m = name.match(/^([a-zA-Z]{1,2}\d?)\b/i); // m1, b1, k1, tk
    if (!m) continue;

    let tag = m[1].toUpperCase();
    if (tag === "T") tag = "TK"; // safety
    if (tag === "TK" || tag === "M1" || tag === "M2" || tag === "B1" || tag === "B2" || tag === "B3" || tag === "B4" || tag === "K1"){
      // If multiple files match same brand, keep last one
      out[tag] = f;
    }
  }
  return out;
}

/* ------------------------- OCR ------------------------- */

async function ocrFile_(file){
  // Faster + good accuracy for tables
  const worker = await Tesseract.createWorker("eng", 1, {
    logger: m => {
      // optional progress
      if (m?.status === "recognizing text" && typeof m.progress === "number"){
        els.progressText.textContent = `OCR running… ${(m.progress*100).toFixed(0)}%`;
      }
    }
  });

  try{
    await worker.setParameters({
      tessedit_pageseg_mode: "6", // Assume block of text
      preserve_interword_spaces: "1"
    });
    const { data } = await worker.recognize(file);
    return data?.text || "";
  } finally {
    await worker.terminate();
  }
}

/* ------------------------- PARSING ------------------------- */

function parseDailyRowsFromOCR_(text){
  const t = normalizeText_(text);
  const lines = t.split("\n").map(s=>s.trim()).filter(Boolean);

  const rows = [];
  for (const line of lines){
    // Look for date in formats:
    // 2026/02/03 or 2026-02-03
    const dm = line.match(/\b(20\d{2})[\/\-](\d{2})[\/\-](\d{2})\b/);
    if (!dm) continue;

    const date = `${dm[1]}-${dm[2]}-${dm[3]}`;

    // Extract all numbers (including decimals) from line
    // Example line has: Reg, FTD, DepositCount, TotalDeposit, WithdrawalCount, Withdrawal, Active, Turnover...
    const nums = extractNumbers_(line);

    // We need: reg, ftd, deposit, active, turnover
    // Typical order in your table:
    // Registered Users, First Depositors, Total Deposit Count, Total Deposit, ... Active Players, Turnover
    // So likely:
    // nums[0]=reg, nums[1]=ftd, nums[3]=deposit, nums[last-2]=active, nums[last-1]=turnover
    // But OCR sometimes drops columns, so we use a robust heuristic.

    const parsed = pickMetricsHeuristic_(line, nums);

    if (!parsed) continue;

    rows.push({
      date,
      reg: parsed.reg,
      ftd: parsed.ftd,
      deposit: parsed.deposit,
      active: parsed.active,
      turnover: parsed.turnover,
      _raw: line
    });
  }

  // Deduplicate by date (keep first occurrence)
  const byDate = new Map();
  for (const r of rows){
    if (!byDate.has(r.date)) byDate.set(r.date, r);
  }

  // Sort desc by date
  return Array.from(byDate.values()).sort((a,b)=> (a.date < b.date ? 1 : -1));
}

function pickMetricsHeuristic_(line, nums){
  if (!nums || nums.length < 4) return null;

  // Try to detect "Active Players" and "Turnover" position by proximity keywords
  // If OCR includes headers in same line, still ok.

  // Basic assumption from your screenshot:
  // reg & ftd are small (thousands)
  // deposit & turnover are big (millions/billions)
  // active is mid (tens of thousands)
  // We'll choose:
  // reg = one of earliest small ints (<= 200000)
  // ftd = next small int (<= 200000)
  // active = a mid-range int often between 1k..500k (or more depending brand)
  // deposit/turnover = larger numbers (>= 1e6)

  const ints = nums.map(n => Math.round(n));

  // Candidate reg/ftd from first 5 numbers
  const head = ints.slice(0, Math.min(6, ints.length));
  const small = head.filter(n => n >= 0 && n <= 500000);

  if (small.length < 2) return null;
  const reg = small[0];
  const ftd = small[1];

  // For active & turnover: usually near end
  // Active likely appears before Turnover near end.
  // We'll take last 6 and search:
  const tail = ints.slice(Math.max(0, ints.length - 8));
  const bigTail = tail.filter(n => n >= 0);

  if (bigTail.length < 2) return null;

  // Turnover: usually the largest in tail
  const turnover = Math.max(...bigTail);

  // Active: choose a value in tail that is not turnover and looks like "players"
  // Prefer values <= 2,000,000 (players count)
  const tailNoTurn = bigTail.filter(n => n !== turnover);
  let active = tailNoTurn.find(n => n <= 2000000);
  if (active === undefined) active = tailNoTurn[0] ?? 0;

  // Deposit: choose largest number in whole line excluding turnover that is still huge
  const bigAll = ints.filter(n => n >= 0).sort((a,b)=>b-a);
  let deposit = 0;
  for (const n of bigAll){
    if (n === turnover) continue;
    if (n >= 1000000){
      deposit = n;
      break;
    }
  }
  // Sometimes turnover is lower than deposit; still ok.

  return { reg, ftd, active, deposit, turnover };
}

function extractNumbers_(line){
  // supports:
  // 1,263,132,324.65
  // 83697
  const matches = line.match(/-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/g) || [];
  return matches.map(s=>{
    const cleaned = s.replace(/,/g,"");
    const v = Number(cleaned);
    return Number.isFinite(v) ? v : null;
  }).filter(v=>v !== null);
}

function normalizeText_(s){
  return String(s || "")
    .replace(/\u00A0/g," ")
    .replace(/[^\S\r\n]+/g," ")
    .replace(/\r/g,"")
    .trim();
}

/* ------------------------- COMPUTATIONS ------------------------- */

function getRowByDateOrNearest_(rowsDesc, targetDate){
  // rowsDesc sorted desc
  if (!rowsDesc.length) return null;

  // exact
  const exact = rowsDesc.find(r => r.date === targetDate);
  if (exact) return exact;

  // nearest previous <= targetDate
  for (const r of rowsDesc){
    if (r.date <= targetDate) return r;
  }

  // otherwise newest available
  return rowsDesc[0];
}

function avgMetric_(rowsDesc, startDate, endDate, metric){
  // inclusive range [startDate..endDate]
  const vals = [];
  for (const r of rowsDesc){
    if (r.date < startDate) break; // because desc
    if (r.date <= endDate && r.date >= startDate){
      const v = Number(r[metric]);
      if (Number.isFinite(v)) vals.push(v);
    }
  }
  if (!vals.length) return null;
  return vals.reduce((a,b)=>a+b,0) / vals.length;
}

function computeDeltaPct_(cur, prev){
  if (cur === null || prev === null) return { d:null, p:null };
  const d = cur - prev;
  const p = prev === 0 ? null : (d / prev);
  return { d, p };
}

function computeBrandResults_(rowsDesc, endDate){
  if (!rowsDesc || !rowsDesc.length){
    return { status:"ERR", reason:"No rows parsed from OCR" };
  }

  const endRow = getRowByDateOrNearest_(rowsDesc, endDate);
  const prevRow = getRowByDateOrNearest_(rowsDesc, shiftDate_(endRow.date, -1));

  // 7D averages
  const last7Start = shiftDate_(endRow.date, -6);
  const prev7Start = shiftDate_(endRow.date, -13);
  const prev7End   = shiftDate_(endRow.date, -7);

  // 14D averages
  const last14Start = shiftDate_(endRow.date, -13);
  const prev14Start = shiftDate_(endRow.date, -27);
  const prev14End   = shiftDate_(endRow.date, -14);

  const out = { endUsed: endRow.date, metrics:{} };

  for (const m of METRICS){
    const endVal = Number(endRow[m]);
    const prevVal = prevRow ? Number(prevRow[m]) : null;

    const avg7 = avgMetric_(rowsDesc, last7Start, endRow.date, m);
    const avgPrev7 = avgMetric_(rowsDesc, prev7Start, prev7End, m);

    const avg14 = avgMetric_(rowsDesc, last14Start, endRow.date, m);
    const avgPrev14 = avgMetric_(rowsDesc, prev14Start, prev14End, m);

    out.metrics[m] = {
      end: endVal,
      prev: prevVal,

      avg7, avgPrev7,
      avg14, avgPrev14,

      d1: computeDeltaPct_(endVal, prevVal).d,
      p1: computeDeltaPct_(endVal, prevVal).p,

      d7: computeDeltaPct_(avg7, avgPrev7).d,
      p7: computeDeltaPct_(avg7, avgPrev7).p,

      d14: computeDeltaPct_(avg14, avgPrev14).d,
      p14: computeDeltaPct_(avg14, avgPrev14).p,
    };
  }

  // Status logic (professional + simple):
  // ERR: active missing or endRow missing
  // WARN: active 7D% <= -10% or active 14D% <= -8%
  // OK: otherwise
  const a = out.metrics.active;
  let status = "OK";
  let reason = "Healthy";

  if (!Number.isFinite(a.end) || a.end === null){
    status = "ERR"; reason = "Active not parsed";
  } else {
    const p7 = (a.p7 ?? 0);
    const p14 = (a.p14 ?? 0);
    if ((p7 !== null && p7 <= -0.10) || (p14 !== null && p14 <= -0.08)){
      status = "WARN";
      reason = "Active trend dropping";
    }
  }

  out.status = status;
  out.reason = reason;
  return out;
}

/* ------------------------- RENDER ------------------------- */

function fmtInt_(n){
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}
function fmtMoney_(n){
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
}
function fmtPct_(p){
  if (p === null || p === undefined || !Number.isFinite(p)) return "—";
  return (p*100).toFixed(2) + "%";
}
function clsByPct_(p){
  if (p === null || p === undefined || !Number.isFinite(p)) return "";
  if (p <= -0.10) return "cell-bad";
  if (p <= -0.03) return "cell-warn";
  if (p >= 0.05) return "cell-good";
  return "";
}
function badgeByStatus_(status){
  if (status === "OK") return `<span class="badge good">OK</span>`;
  if (status === "WARN") return `<span class="badge warn">WARN</span>`;
  return `<span class="badge bad">ERR</span>`;
}

function renderSummary_(){
  const grid = els.summaryGrid;
  grid.innerHTML = "";

  for (const brand of BRANDS){
    const res = state.resultsByBrand[brand];

    const st = res?.status || "ERR";
    const reason = res?.reason || "No data";
    const endUsed = res?.endUsed || "—";

    const a = res?.metrics?.active;
    const d7 = a ? a.d7 : null;
    const p7 = a ? a.p7 : null;
    const d14 = a ? a.d14 : null;
    const p14 = a ? a.p14 : null;

    const card = document.createElement("div");
    card.className = "mini";
    card.innerHTML = `
      <div class="top">
        <h3>${brand}</h3>
        ${badgeByStatus_(st)}
      </div>
      <div class="muted" style="margin-top:6px;font-size:12px;">
        End used: <b>${endUsed}</b> • ${reason}
      </div>

      <div class="kpis">
        <div class="kpi">
          <div class="k">Active 7D%</div>
          <div class="v ${clsByPct_(p7)}">${fmtPct_(p7)}</div>
          <div class="s">Δ: ${fmtInt_(d7)}</div>
        </div>
        <div class="kpi">
          <div class="k">Active 14D%</div>
          <div class="v ${clsByPct_(p14)}">${fmtPct_(p14)}</div>
          <div class="s">Δ: ${fmtInt_(d14)}</div>
        </div>
      </div>
    `;
    grid.appendChild(card);
  }
}

function renderActiveTable_(){
  const tbl = els.activeTable;

  tbl.innerHTML = `
    <thead>
      <tr>
        <th>Brand</th>
        <th>End Day Active</th>
        <th>Prev Day Active</th>
        <th>Avg(last7)</th>
        <th>Avg(prev7)</th>
        <th>Avg(last14)</th>
        <th>Avg(prev14)</th>
        <th>1D Δ</th>
        <th>1D %</th>
        <th>7D Δ</th>
        <th>7D %</th>
        <th>14D Δ</th>
        <th>14D %</th>
        <th>Status</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;

  const tbody = tbl.querySelector("tbody");

  for (const brand of BRANDS){
    const res = state.resultsByBrand[brand];
    const a = res?.metrics?.active;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><b>${brand}</b></td>
      <td>${fmtInt_(a?.end)}</td>
      <td>${fmtInt_(a?.prev)}</td>
      <td>${fmtInt_(a?.avg7)}</td>
      <td>${fmtInt_(a?.avgPrev7)}</td>
      <td>${fmtInt_(a?.avg14)}</td>
      <td>${fmtInt_(a?.avgPrev14)}</td>
      <td>${fmtInt_(a?.d1)}</td>
      <td class="${clsByPct_(a?.p1)}">${fmtPct_(a?.p1)}</td>
      <td>${fmtInt_(a?.d7)}</td>
      <td class="${clsByPct_(a?.p7)}">${fmtPct_(a?.p7)}</td>
      <td>${fmtInt_(a?.d14)}</td>
      <td class="${clsByPct_(a?.p14)}">${fmtPct_(a?.p14)}</td>
      <td>${badgeByStatus_(res?.status || "ERR")}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderAllTable_(){
  const tbl = els.allTable;

  // cleaner professional layout:
  // For each metric: 1DΔ,1D%,7DΔ,7D%,14DΔ,14D%
  tbl.innerHTML = `
    <thead>
      <tr>
        <th rowspan="2">Brand</th>
        ${metricHeader_("Active")}
        ${metricHeader_("Deposit")}
        ${metricHeader_("Reg")}
        ${metricHeader_("FTD")}
        ${metricHeader_("Turnover")}
        <th rowspan="2">Status</th>
      </tr>
      <tr>
        ${subHeader_().repeat(5)}
      </tr>
    </thead>
    <tbody></tbody>
  `;

  const tbody = tbl.querySelector("tbody");

  for (const brand of BRANDS){
    const res = state.resultsByBrand[brand];
    const tr = document.createElement("tr");

    const cells = [];
    cells.push(`<td><b>${brand}</b></td>`);

    cells.push(metricCells_(res?.metrics?.active, "int"));
    cells.push(metricCells_(res?.metrics?.deposit, "money"));
    cells.push(metricCells_(res?.metrics?.reg, "int"));
    cells.push(metricCells_(res?.metrics?.ftd, "int"));
    cells.push(metricCells_(res?.metrics?.turnover, "money"));

    cells.push(`<td>${badgeByStatus_(res?.status || "ERR")}</td>`);

    tr.innerHTML = cells.join("");
    tbody.appendChild(tr);
  }
}

function metricHeader_(name){
  return `<th colspan="6">${name}</th>`;
}
function subHeader_(){
  return `
    <th>1D Δ</th><th>1D %</th>
    <th>7D Δ</th><th>7D %</th>
    <th>14D Δ</th><th>14D %</th>
  `;
}

function metricCells_(m, type){
  const fVal = (v)=>{
    if (type === "money") return fmtMoney_(v);
    return fmtInt_(v);
  };

  const d1 = fVal(m?.d1), p1 = fmtPct_(m?.p1);
  const d7 = fVal(m?.d7), p7 = fmtPct_(m?.p7);
  const d14 = fVal(m?.d14), p14 = fmtPct_(m?.p14);

  const c1 = clsByPct_(m?.p1);
  const c7 = clsByPct_(m?.p7);
  const c14 = clsByPct_(m?.p14);

  return `
    <td>${d1}</td><td class="${c1}">${p1}</td>
    <td>${d7}</td><td class="${c7}">${p7}</td>
    <td>${d14}</td><td class="${c14}">${p14}</td>
  `;
}

function renderRawPanels_(){
  const root = els.rawPanels;
  root.innerHTML = "";

  for (const brand of BRANDS){
    const text = state.ocrTextByBrand[brand] || "";
    const rows = state.rowsByBrand[brand] || [];
    const used = state.resultsByBrand[brand]?.endUsed || "—";

    const panel = document.createElement("div");
    panel.className = "rawPanel";

    const head = document.createElement("div");
    head.className = "rawHead";
    head.innerHTML = `
      <div><b>${brand}</b> — parsed rows: <b>${rows.length}</b> • end used: <b>${used}</b></div>
      <div class="muted">click to expand</div>
    `;

    const body = document.createElement("div");
    body.className = "rawBody hidden";
    body.textContent = text ? text : "(no OCR text)";

    head.addEventListener("click", ()=>{
      body.classList.toggle("hidden");
    });

    panel.appendChild(head);
    panel.appendChild(body);
    root.appendChild(panel);
  }
}
