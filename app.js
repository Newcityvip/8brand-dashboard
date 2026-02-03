// ========================
// 8 Brand Dashboard (OCR)
// Fix: Accurate extraction of Active/Deposit/Reg/FTD/Turnover from table rows
// Rolling comparisons: 1D, 7D, 14D ending at End Date
// ========================

const BRANDS = ["M1","M2","B1","B2","B3","B4","K1","TK"];
const METRICS = ["active","deposit","reg","ftd","turnover"];

const el = (id) => document.getElementById(id);

const state = {
  endDate: null,
  filesByBrand: new Map(),   // brand -> File
  ocrTextByBrand: new Map(), // brand -> raw text
  seriesByBrand: new Map(),  // brand -> Map(dateStr -> {active,deposit,reg,ftd,turnover})
};

init();

function init(){
  // Default end date: today in local timezone (YYYY-MM-DD)
  const d = new Date();
  el("endDate").valueAsDate = d;

  el("files").addEventListener("change", onFilesSelected);
  el("runBtn").addEventListener("click", runAll);
  el("clearBtn").addEventListener("click", clearAll);

  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      document.querySelectorAll(".tabPane").forEach(p => p.classList.remove("show"));
      el(`tab-${tab}`).classList.add("show");
    });
  });

  setStatus("Idle");
  renderEmptyTables();
}

function setStatus(msg, kind=""){
  const pill = el("statusPill");
  pill.textContent = msg;
  pill.style.borderColor = kind === "ok" ? "rgba(27,191,107,.35)"
    : kind === "warn" ? "rgba(240,180,41,.35)"
    : kind === "bad" ? "rgba(226,74,74,.35)"
    : "rgba(255,255,255,.08)";
}

function clearAll(){
  state.filesByBrand.clear();
  state.ocrTextByBrand.clear();
  state.seriesByBrand.clear();
  el("files").value = "";
  renderEmptyTables();
  el("rawBlocks").innerHTML = "";
  el("summaryCards").innerHTML = "";
  setStatus("Cleared");
}

function onFilesSelected(e){
  state.filesByBrand.clear();
  const files = Array.from(e.target.files || []);
  for(const f of files){
    const brand = detectBrandFromFilename(f.name);
    if(!brand) continue;
    state.filesByBrand.set(brand, f);
  }
  const missing = BRANDS.filter(b => !state.filesByBrand.has(b));
  if(missing.length){
    setStatus(`Selected files. Missing: ${missing.join(", ")}`, "warn");
  } else {
    setStatus("All 8 brands selected ✅", "ok");
  }
}

function detectBrandFromFilename(name){
  const base = String(name || "").toUpperCase().trim();
  // allow: m1.png OR m1_2026-02-02.png OR M1-anything.jpg
  const m = base.match(/^(M1|M2|B1|B2|B3|B4|K1|TK)\b/);
  return m ? m[1] : null;
}

async function runAll(){
  const endDate = el("endDate").value;
  if(!endDate){
    setStatus("End date is required", "bad");
    return;
  }
  state.endDate = endDate;

  // Validate files
  const missing = BRANDS.filter(b => !state.filesByBrand.has(b));
  if(missing.length){
    setStatus(`Missing files: ${missing.join(", ")}`, "bad");
    return;
  }

  setStatus("OCR running... (don’t close tab)", "warn");
  el("runBtn").disabled = true;

  try{
    state.ocrTextByBrand.clear();
    state.seriesByBrand.clear();

    for(const brand of BRANDS){
      setStatus(`OCR: ${brand} ...`, "warn");
      const file = state.filesByBrand.get(brand);
      const text = await ocrImage(file);
      state.ocrTextByBrand.set(brand, text);

      const series = parseDailySeriesFromOCR(text);
      state.seriesByBrand.set(brand, series);
    }

    renderRaw();
    renderDashboards();

    setStatus("Done ✅", "ok");
  }catch(err){
    console.error(err);
    setStatus(`Error: ${err?.message || String(err)}`, "bad");
  }finally{
    el("runBtn").disabled = false;
  }
}

async function ocrImage(file){
  // Stronger OCR for table numbers:
  // - use eng
  // - keep symbols needed for dates, commas, decimals
  const { data } = await Tesseract.recognize(file, "eng", {
    logger: () => {}
  });
  return (data && data.text) ? data.text : "";
}

/**
 * Parse all daily rows from OCR text.
 * We look for lines containing a date: YYYY/MM/DD or YYYY-MM-DD
 * Then read numeric tokens after date and map:
 *  reg = token[0] (small int)
 *  ftd = token[1] (small int)
 *  deposit = first big money after those counts
 *  turnover = largest money value in row
 *  active = integer nearest before turnover (typical table layout)
 */
function parseDailySeriesFromOCR(text){
  const series = new Map(); // dateStr -> metric obj
  const lines = String(text || "")
    .replace(/\u00A0/g, " ")
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);

  for(const line of lines){
    const date = extractDate(line);
    if(!date) continue;

    const after = line.slice(line.indexOf(date) + date.length).trim();
    const nums = extractNumbers(after);
    if(nums.length < 4) continue;

    const row = mapRowToMetrics(nums);
    if(!row) continue;

    // keep the best row if duplicates (OCR sometimes repeats)
    series.set(date, row);
  }
  return series;
}

function extractDate(line){
  // Accept 2026/02/03 or 2026-02-03
  const m = line.match(/(\d{4}[\/-]\d{2}[\/-]\d{2})/);
  if(!m) return null;
  return normalizeDate(m[1]);
}

function normalizeDate(s){
  // Convert 2026/02/03 -> 2026-02-03
  return String(s).replaceAll("/", "-");
}

function extractNumbers(s){
  // Extract numbers with commas + decimals + negatives + ( ) negatives
  // Example tokens: 155,793,400.12  (25,073,803.27)  78,572
  const tokens = String(s || "").match(/(\(\s*-?[\d,]+(?:\.\d+)?\s*\)|-?[\d,]+(?:\.\d+)?)/g) || [];
  return tokens.map(toNumberSafe).filter(n => Number.isFinite(n));
}

function toNumberSafe(tok){
  let t = String(tok).trim();
  let neg = false;
  if(t.startsWith("(") && t.endsWith(")")){
    neg = true;
    t = t.slice(1, -1).trim();
  }
  t = t.replace(/,/g, "");
  let n = Number(t);
  if(!Number.isFinite(n)) return NaN;
  if(neg) n = -Math.abs(n);
  return n;
}

function isLikelyCount(n){
  // counts like reg/ftd/active: integer-ish and not too huge
  return Number.isFinite(n) && Math.abs(n) <= 5000000 && Math.abs(n) >= 0 && Math.floor(Math.abs(n)) === Math.abs(n);
}

function isLikelyMoney(n){
  // money fields are usually large and can be decimal
  return Number.isFinite(n) && Math.abs(n) >= 1000;
}

function mapRowToMetrics(nums){
  // reg + ftd are the first two SMALL integers typically
  // But OCR might insert extra numbers, so we search:
  const smallInts = nums.filter(n => isLikelyCount(n) && Math.abs(n) <= 200000); // reg/ftd are small
  if(smallInts.length < 2) return null;

  const reg = smallInts[0];
  const ftd = smallInts[1];

  // turnover: usually the largest absolute money value in the row
  const money = nums.filter(isLikelyMoney);
  if(money.length < 2) return null;

  let turnover = money.reduce((a,b) => Math.abs(b) > Math.abs(a) ? b : a, money[0]);

  // active: the integer token closest BEFORE the turnover token in the original token list
  const turnoverIdx = nums.findIndex(n => n === turnover);
  let active = 0;

  if(turnoverIdx > 0){
    // scan backwards to find a good "active" candidate
    for(let i = turnoverIdx - 1; i >= 0; i--){
      const n = nums[i];
      if(isLikelyCount(n) && Math.abs(n) >= 50){ // active usually not tiny
        active = n;
        break;
      }
    }
  }

  // deposit amount: choose the first big money AFTER the reg/ftd area.
  // Heuristic: pick the first money value in the row that is not turnover and occurs after some early tokens.
  let deposit = 0;
  for(let i = 0; i < nums.length; i++){
    const n = nums[i];
    if(!isLikelyMoney(n)) continue;
    if(n === turnover) continue;
    // skip early counts area by requiring either decimal OR large enough
    if(Math.abs(n) >= 100000 || (String(n).includes(".") && Math.abs(n) >= 1000)){
      deposit = n;
      break;
    }
  }
  // fallback: second-largest money
  if(deposit === 0){
    const sorted = [...money].sort((a,b) => Math.abs(b)-Math.abs(a));
    deposit = sorted.length > 1 ? sorted[1] : sorted[0];
  }

  return { active, deposit, reg, ftd, turnover };
}

// ==========================
// Rolling calculations
// ==========================

function renderDashboards(){
  const end = state.endDate;
  const summary = buildSummary(end);
  renderSummary(summary);
  renderActiveFocus(end);
  renderAllMetrics(end);
}

function buildSummary(end){
  // brand health based mainly on Active trend
  const out = [];
  for(const brand of BRANDS){
    const series = state.seriesByBrand.get(brand);
    const c = computeComparisons(series, end, "active");
    const status = statusFromActive(c);
    out.push({ brand, status, active1d: c.d1.pct, active7d: c.d7.pct, active14d: c.d14.pct });
  }
  return out;
}

function statusFromActive(c){
  // Professional status rules:
  // ERR = missing required periods
  // WARN = 7D <= -8% OR 14D <= -12% OR end-day active <= 0
  // OK otherwise
  if(!c.d1.ok && !c.d7.ok && !c.d14.ok) return "ERR";
  if(c.endVal <= 0) return "ERR";
  if((c.d7.ok && c.d7.pct <= -0.08) || (c.d14.ok && c.d14.pct <= -0.12)) return "WARN";
  return "OK";
}

function computeComparisons(series, endDate, metric){
  // 1D: end day vs previous day
  // 7D: avg(last 7 ending endDate) vs avg(previous 7)
  // 14D: avg(last 14) vs avg(previous 14)

  const end = pickNearestOnOrBefore(series, endDate);
  const prev1 = end ? pickNearestOnOrBefore(series, shiftDate(end.date, -1)) : null;

  const last7 = avgWindow(series, endDate, 7, 0, metric);
  const prev7 = avgWindow(series, endDate, 7, 7, metric);

  const last14 = avgWindow(series, endDate, 14, 0, metric);
  const prev14 = avgWindow(series, endDate, 14, 14, metric);

  const d1 = mkDelta(prev1?.val, end?.val);
  const d7 = mkDelta(prev7?.val, last7?.val);
  const d14 = mkDelta(prev14?.val, last14?.val);

  return {
    endDateUsed: end?.date || null,
    endVal: end?.val ?? 0,
    prevVal: prev1?.val ?? 0,
    d1, d7, d14,
    last7, prev7, last14, prev14
  };
}

function mkDelta(base, cur){
  const b = Number(base);
  const c = Number(cur);
  if(!Number.isFinite(b) || !Number.isFinite(c)) return { ok:false, abs:0, pct:0 };
  if(b === 0) return { ok: Number.isFinite(c), abs: c - b, pct: 0 };
  return { ok:true, abs: c - b, pct: (c - b) / b };
}

function avgWindow(series, endDate, windowSize, offsetDays, metric){
  // window ending at endDate - offsetDays
  const end = shiftDate(endDate, -offsetDays);
  const dates = [];
  for(let i = 0; i < windowSize; i++){
    dates.push(shiftDate(end, -i));
  }
  const vals = [];
  for(const d of dates){
    const row = series.get(d);
    if(row && Number.isFinite(row[metric])) vals.push(row[metric]);
  }
  if(vals.length < Math.ceil(windowSize * 0.6)){ // need at least 60% coverage
    return { ok:false, val:0, used: vals.length, need: windowSize, end };
  }
  const sum = vals.reduce((a,b)=>a+b,0);
  return { ok:true, val: sum/vals.length, used: vals.length, need: windowSize, end };
}

function pickNearestOnOrBefore(series, dateStr){
  // If OCR missed exact date, pick nearest earlier date within 3 days
  for(let back = 0; back <= 3; back++){
    const d = shiftDate(dateStr, -back);
    const row = series.get(d);
    if(row) return { date: d, val: row.active, row };
  }
  return null;
}

function shiftDate(dateStr, days){
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  return `${yyyy}-${mm}-${dd}`;
}

// ==========================
// Rendering
// ==========================

function renderEmptyTables(){
  el("activeTable").innerHTML = "";
  el("allTable").innerHTML = "";
}

function fmtInt(n){
  if(!Number.isFinite(n)) return "-";
  return Math.round(n).toLocaleString();
}
function fmtMoney(n){
  if(!Number.isFinite(n)) return "-";
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function fmtPct(p){
  if(!Number.isFinite(p)) return "-";
  return (p*100).toFixed(2) + "%";
}

function clsForPct(p){
  if(!Number.isFinite(p)) return "muted";
  if(p < 0) return "neg";
  if(p > 0) return "pos";
  return "muted";
}

function renderSummary(rows){
  const box = el("summaryCards");
  box.innerHTML = "";
  for(const r of rows){
    const badgeCls = r.status === "OK" ? "ok" : r.status === "WARN" ? "warn" : "bad";
    const div = document.createElement("div");
    div.className = "sCard";
    div.innerHTML = `
      <div class="sTitle">${r.brand} • Status <span class="badge ${badgeCls}">${r.status}</span></div>
      <div class="sValue ${clsForPct(r.active7d)}">Active 7D: ${fmtPct(r.active7d)}</div>
      <div class="sSub">
        Active 1D: <span class="${clsForPct(r.active1d)}">${fmtPct(r.active1d)}</span> •
        Active 14D: <span class="${clsForPct(r.active14d)}">${fmtPct(r.active14d)}</span>
      </div>
    `;
    box.appendChild(div);
  }
}

function renderActiveFocus(endDate){
  const table = el("activeTable");
  const cols = [
    "Brand",
    "End Day Active", "Prev Day Active", "Avg(last7)", "Avg(prev7)", "Avg(last14)", "Avg(prev14)",
    "1D Δ", "1D %", "7D Δ", "7D %", "14D Δ", "14D %", "Status"
  ];

  let html = `<thead><tr>${cols.map(c=>`<th>${c}</th>`).join("")}</tr></thead><tbody>`;

  for(const brand of BRANDS){
    const series = state.seriesByBrand.get(brand);
    const end = pickNearestOnOrBefore(series, endDate);
    const prev = end ? pickNearestOnOrBefore(series, shiftDate(end.date, -1)) : null;

    const c = computeComparisons(series, endDate, "active");
    const status = statusFromActive(c);
    const badgeCls = status === "OK" ? "ok" : status === "WARN" ? "warn" : "bad";

    html += `<tr>
      <td class="brandCell">${brand}</td>
      <td>${fmtInt(end?.row?.active ?? 0)}</td>
      <td>${fmtInt(prev?.row?.active ?? 0)}</td>
      <td>${c.last7.ok ? fmtInt(c.last7.val) : "-"}</td>
      <td>${c.prev7.ok ? fmtInt(c.prev7.val) : "-"}</td>
      <td>${c.last14.ok ? fmtInt(c.last14.val) : "-"}</td>
      <td>${c.prev14.ok ? fmtInt(c.prev14.val) : "-"}</td>

      <td>${fmtInt(c.d1.abs)}</td>
      <td class="${clsForPct(c.d1.pct)}">${c.d1.ok ? fmtPct(c.d1.pct) : "-"}</td>

      <td>${fmtInt(c.d7.abs)}</td>
      <td class="${clsForPct(c.d7.pct)}">${c.d7.ok ? fmtPct(c.d7.pct) : "-"}</td>

      <td>${fmtInt(c.d14.abs)}</td>
      <td class="${clsForPct(c.d14.pct)}">${c.d14.ok ? fmtPct(c.d14.pct) : "-"}</td>

      <td><span class="badge ${badgeCls}">${status}</span></td>
    </tr>`;
  }

  html += `</tbody>`;
  table.innerHTML = html;
}

function renderAllMetrics(endDate){
  const table = el("allTable");

  // Compact but clear: grouped columns per metric
  const head1 = `
    <tr>
      <th rowspan="2">Brand</th>
      ${METRICS.map(m => `<th colspan="6">${cap(m)}</th>`).join("")}
      <th rowspan="2">Status</th>
    </tr>
  `;

  const head2 = `
    <tr>
      ${METRICS.map(() => `<th>1D Δ</th><th>1D %</th><th>7D Δ</th><th>7D %</th><th>14D Δ</th><th>14D %</th>`).join("")}
    </tr>
  `;

  let body = "";
  for(const brand of BRANDS){
    const series = state.seriesByBrand.get(brand);
    const cActive = computeComparisons(series, endDate, "active");
    const status = statusFromActive(cActive);
    const badgeCls = status === "OK" ? "ok" : status === "WARN" ? "warn" : "bad";

    body += `<tr><td class="brandCell">${brand}</td>`;

    for(const metric of METRICS){
      const c = computeComparisons(series, endDate, metric);
      const fmtA = (metric === "reg" || metric === "ftd" || metric === "active") ? fmtInt : fmtMoney;

      body += `
        <td>${fmtA(c.d1.abs)}</td>
        <td class="${clsForPct(c.d1.pct)}">${c.d1.ok ? fmtPct(c.d1.pct) : "-"}</td>

        <td>${fmtA(c.d7.abs)}</td>
        <td class="${clsForPct(c.d7.pct)}">${c.d7.ok ? fmtPct(c.d7.pct) : "-"}</td>

        <td>${fmtA(c.d14.abs)}</td>
        <td class="${clsForPct(c.d14.pct)}">${c.d14.ok ? fmtPct(c.d14.pct) : "-"}</td>
      `;
    }

    body += `<td><span class="badge ${badgeCls}">${status}</span></td></tr>`;
  }

  table.innerHTML = `<thead>${head1}${head2}</thead><tbody>${body}</tbody>`;
}

function cap(s){
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function renderRaw(){
  const box = el("rawBlocks");
  box.innerHTML = "";

  for(const brand of BRANDS){
    const text = state.ocrTextByBrand.get(brand) || "";
    const series = state.seriesByBrand.get(brand);
    const sample = sampleParsed(series);

    const details = document.createElement("details");
    details.className = "rawBlock";
    details.innerHTML = `
      <summary>${brand} — OCR text (click) <span class="muted"> • parsed days: ${series?.size || 0}</span></summary>
      <div class="rawText">
        Parsed sample (date → reg, ftd, deposit, active, turnover):
        ${sample}

        ----------------------------
        RAW OCR:
        ${escapeHTML(text)}
      </div>
    `;
    box.appendChild(details);
  }
}

function sampleParsed(series){
  if(!series || series.size === 0) return "No rows parsed.";
  const dates = Array.from(series.keys()).sort().slice(-5);
  return dates.map(d => {
    const r = series.get(d);
    return `${d} → reg=${r.reg}, ftd=${r.ftd}, deposit=${r.deposit}, active=${r.active}, turnover=${r.turnover}`;
  }).join("\n");
}

function escapeHTML(s){
  return String(s || "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;");
}
