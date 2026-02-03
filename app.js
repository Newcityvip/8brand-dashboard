const ALLOWED = ["M1","M2","B1","B2","B3","B4","K1","TK"];

const els = {
  end: document.getElementById("endDate"),
  fileInput: document.getElementById("fileInput"),
  run: document.getElementById("btnRun"),
  clear: document.getElementById("btnClear"),
  dashBody: document.getElementById("dashBody"),
  rawBox: document.getElementById("rawBox"),
  progressBox: document.getElementById("progressBox"),
  progressTitle: document.getElementById("progressTitle"),
  progressMeta: document.getElementById("progressMeta"),
  barFill: document.getElementById("barFill"),
};

function setProgress(show, title="", meta="", pct=0){
  els.progressBox.classList.toggle("hidden", !show);
  if(show){
    els.progressTitle.textContent = title;
    els.progressMeta.textContent = meta;
    els.barFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }
}

/**
 * ✅ NEW: allow filenames like:
 *   m1.png, M1.jpg, M1_anything.png, M1_2026-02-02.png
 */
function parseBrandFromName(name){
  const up = String(name || "").toUpperCase();
  const m = up.match(/^(M1|M2|B1|B2|B3|B4|K1|TK)(?=(_|\.|$))/);
  return m ? m[1] : null;
}

async function ocrImage(file, onProg){
  const { data } = await Tesseract.recognize(file, "eng", {
    logger: (m) => {
      if(m.status && typeof m.progress === "number"){
        onProg(m.status, m.progress);
      }
    }
  });
  return (data.text || "").trim();
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, (m)=>({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[m]));
}

function toNum(s){
  if(!s) return 0;
  let x = String(s).trim();
  let neg = false;
  if(x.startsWith("(") && x.endsWith(")")){
    neg = true;
    x = x.slice(1,-1);
  }
  x = x.replace(/,/g,"");
  const v = parseFloat(x);
  if(Number.isNaN(v)) return 0;
  return neg ? -v : v;
}

function fmtInt(n){
  if(n === null || n === undefined) return "";
  return (n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function fmtPct(p){
  if(p === null || p === undefined) return "";
  return (p*100).toFixed(2) + "%";
}

/**
 * ✅ NEW: normalize a SINGLE LINE (do NOT destroy newlines globally)
 */
function normalizeLine(line){
  return String(line || "")
    .replace(/\u00A0/g," ")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g," ")
    .trim();
}

/**
 * ✅ NEW: Parse OCR into daily series (keeps all rows!)
 * Accepts date formats:
 *   2026-02-03
 *   2026/02/03  (converted)
 */
function parseSeriesFromOCR(ocrText){
  const raw = String(ocrText || "");
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  const rows = [];
  for(const rawLine of lines){
    const line = normalizeLine(rawLine);

    // match date with "-" or "/"
    const dm = line.match(/(20\d{2})[\/-](\d{2})[\/-](\d{2})/);
    if(!dm) continue;

    const date = `${dm[1]}-${dm[2]}-${dm[3]}`;

    // collect numeric tokens (include commas, decimals, parentheses)
    const tokens = [];
    const reNum = /(\(?-?\d[\d,]*\.?\d*\)?)/g;
    let m;
    while((m = reNum.exec(line)) !== null){
      const s = m[1];

      // skip pieces that look like date fragments
      if(s.length === 4 && dm[1] === s) continue;
      tokens.push(s);
      if(tokens.length > 40) break;
    }

    // We expect at least enough columns
    // mapping based on your working screenshot:
    // registered = nums[0], ftd = nums[1], deposit = nums[3], active = nums[6], turnover = nums[7]
    if(tokens.length < 8) continue;

    const registered = toNum(tokens[0]);
    const ftd = toNum(tokens[1]);
    const deposit = toNum(tokens[3]);
    const active = toNum(tokens[6]);
    const turnover = toNum(tokens[7]);

    rows.push({ date, registered, ftd, deposit, active, turnover, raw: line });
  }

  // dedupe by date (keep first)
  const byDate = new Map();
  for(const r of rows){
    if(!byDate.has(r.date)) byDate.set(r.date, r);
  }

  // sort asc
  return Array.from(byDate.values()).sort((a,b)=>a.date.localeCompare(b.date));
}

function pickDateRow(series, targetDate){
  if(series.length === 0) return { ok:false, reason:"No rows/dates parsed from OCR." };

  const exact = series.find(r => r.date === targetDate);
  if(exact) return { ok:true, usedNearest:false, row: exact };

  const toN = (d)=>Number(d.replaceAll("-",""));
  const tN = toN(targetDate);

  let best = series[0];
  let bestDist = Math.abs(toN(best.date) - tN);
  for(const r of series){
    const dist = Math.abs(toN(r.date) - tN);
    if(dist < bestDist){
      bestDist = dist;
      best = r;
    }
  }
  return { ok:true, usedNearest:true, row: best };
}

function calcRolling(series, endIndex, key){
  const get = (i)=> (i >= 0 && i < series.length) ? series[i][key] : null;

  // 1D
  const endVal = get(endIndex);
  const prevVal = get(endIndex - 1);
  const d1 = (endVal === null || prevVal === null) ? null : (endVal - prevVal);
  const p1 = (prevVal === null || prevVal === 0 || d1 === null) ? null : (d1 / prevVal);

  const avg = (from, to)=>{
    if(from > to) return null;
    const a = Math.max(0, from);
    const b = Math.min(series.length - 1, to);
    if(a > b) return null;

    const arr = [];
    for(let i=a;i<=b;i++){
      const v = series[i][key];
      if(typeof v === "number") arr.push(v);
    }
    if(arr.length === 0) return null;
    return arr.reduce((s,x)=>s+x,0) / arr.length;
  };

  // 7D
  const last7 = avg(endIndex - 6, endIndex);
  const prev7 = avg(endIndex - 13, endIndex - 7);
  const d7 = (last7 === null || prev7 === null) ? null : (last7 - prev7);
  const p7 = (prev7 === null || prev7 === 0 || d7 === null) ? null : (d7 / prev7);

  // 14D
  const last14 = avg(endIndex - 13, endIndex);
  const prev14 = avg(endIndex - 27, endIndex - 14);
  const d14 = (last14 === null || prev14 === null) ? null : (last14 - prev14);
  const p14 = (prev14 === null || prev14 === 0 || d14 === null) ? null : (d14 / prev14);

  return { d1, p1, d7, p7, d14, p14 };
}

function badge(status){
  const cls = status === "OK" ? "badge ok" : status === "WARN" ? "badge warn" : "badge err";
  return `<span class="${cls}">${status}</span>`;
}

function makeRow(brand, metrics, status){
  const cols = [];
  cols.push(`<td style="text-align:left">${escapeHtml(brand)}</td>`);

  const pack = (m)=>{
    cols.push(`<td>${escapeHtml(fmtInt(m.d1))}</td>`);
    cols.push(`<td>${escapeHtml(fmtPct(m.p1))}</td>`);
    cols.push(`<td>${escapeHtml(fmtInt(m.d7))}</td>`);
    cols.push(`<td>${escapeHtml(fmtPct(m.p7))}</td>`);
    cols.push(`<td>${escapeHtml(fmtInt(m.d14))}</td>`);
    cols.push(`<td>${escapeHtml(fmtPct(m.p14))}</td>`);
  };

  pack(metrics.active);
  pack(metrics.deposit);
  pack(metrics.registered);
  pack(metrics.ftd);

  cols.push(`<td>${badge(status)}</td>`);
  return `<tr>${cols.join("")}</tr>`;
}

function renderRaw(brand, text, series, endPick){
  const wrap = document.createElement("details");
  wrap.className = "rawItem";

  const sum = document.createElement("summary");
  sum.textContent = `${brand} — OCR text (click)`;

  const meta = document.createElement("div");
  meta.className = "muted small";
  meta.style.marginTop = "8px";
  meta.textContent =
    `Parsed rows: ${series.length} | End target: ${els.end.value.trim()} → used: ${endPick.ok ? endPick.row.date : "-"}${endPick.usedNearest ? " (nearest)" : ""}`;

  const pre = document.createElement("pre");
  pre.textContent = text;

  wrap.appendChild(sum);
  wrap.appendChild(meta);
  wrap.appendChild(pre);
  els.rawBox.appendChild(wrap);
}

els.clear.addEventListener("click", ()=>{
  els.dashBody.innerHTML = "";
  els.rawBox.innerHTML = "";
  els.fileInput.value = "";
  setProgress(false);
});

els.run.addEventListener("click", async ()=>{
  const files = Array.from(els.fileInput.files || []);
  const endDate = els.end.value.trim();

  els.dashBody.innerHTML = "";
  els.rawBox.innerHTML = "";

  if(!endDate){
    alert("Please enter End Date (YYYY-MM-DD)");
    return;
  }
  if(files.length === 0){
    alert("Please upload screenshots.");
    return;
  }

  const byBrand = {};
  for(const f of files){
    const b = parseBrandFromName(f.name);
    if(!b) continue;
    byBrand[b] = f;
  }

  let done = 0;
  const total = Object.keys(byBrand).length || 1;

  for(const brand of ALLOWED){
    const f = byBrand[brand];
    if(!f){
      els.dashBody.insertAdjacentHTML("beforeend", makeRow(brand, {
        active:{d1:null,p1:null,d7:null,p7:null,d14:null,p14:null},
        deposit:{d1:null,p1:null,d7:null,p7:null,d14:null,p14:null},
        registered:{d1:null,p1:null,d7:null,p7:null,d14:null,p14:null},
        ftd:{d1:null,p1:null,d7:null,p7:null,d14:null,p14:null},
      }, "ERR"));
      continue;
    }

    setProgress(true, `OCR: ${brand}`, `Reading ${f.name}`, (done/total)*100);

    const text = await ocrImage(f, (status, prog)=>{
      setProgress(true, `OCR: ${brand}`, `${status} ${(prog*100).toFixed(0)}%`, ((done + prog) / total) * 100);
    });

    const series = parseSeriesFromOCR(text);
    const endPick = pickDateRow(series, endDate);
    renderRaw(brand, text, series, endPick);

    if(!endPick.ok){
      els.dashBody.insertAdjacentHTML("beforeend", makeRow(brand, {
        active:{d1:null,p1:null,d7:null,p7:null,d14:null,p14:null},
        deposit:{d1:null,p1:null,d7:null,p7:null,d14:null,p14:null},
        registered:{d1:null,p1:null,d7:null,p7:null,d14:null,p14:null},
        ftd:{d1:null,p1:null,d7:null,p7:null,d14:null,p14:null},
      }, "ERR"));
      done++;
      continue;
    }

    const endIndex = series.findIndex(r => r.date === endPick.row.date);

    const active = calcRolling(series, endIndex, "active");
    const deposit = calcRolling(series, endIndex, "deposit");
    const registered = calcRolling(series, endIndex, "registered");
    const ftd = calcRolling(series, endIndex, "ftd");

    // ✅ Status: need enough history for rolling:
    // 1D needs 2 rows, 7D needs ~14 rows, 14D needs ~28 rows
    const has1D = active.d1 !== null && deposit.d1 !== null;
    const has7D = active.d7 !== null && deposit.d7 !== null;
    const has14D = active.d14 !== null && deposit.d14 !== null;

    let status = "ERR";
    if(has1D && has7D && has14D) status = "OK";
    else if(has1D && (has7D || has14D)) status = "WARN";
    else if(has1D) status = "WARN";

    if(endPick.usedNearest && status === "OK") status = "WARN";

    els.dashBody.insertAdjacentHTML("beforeend", makeRow(brand, {
      active, deposit, registered, ftd
    }, status));

    done++;
    setProgress(true, `OCR: ${brand}`, `Done`, (done/total)*100);
  }

  setProgress(false);
});
