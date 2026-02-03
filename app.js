const ALLOWED = ["M1","M2","B1","B2","B3","B4","K1","TK"];

const els = {
  start: document.getElementById("startDate"),
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

function parseBrandFromName(name){
  const m = String(name).match(/^([A-Za-z0-9]+)_\d{4}-\d{2}-\d{2}/);
  if(!m) return null;
  const b = m[1].toUpperCase();
  return ALLOWED.includes(b) ? b : null;
}

/** OCR using Tesseract.js (runs in browser) */
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

/** Normalize and also fix common dash variants in dates */
function normalize(s){
  return String(s || "")
    .replace(/\u00A0/g," ")
    .replace(/[–—]/g, "-")
    .replace(/[\.\/]/g, "-")
    .replace(/[^\S\r\n]+/g," ")
    .replace(/\s+/g," ")
    .trim();
}

/** Find all date strings like 2026-02-03 (also supports OCR variants) */
function findAllDates(text){
  const t = normalize(text);
  const re = /(20\d{2}-\d{2}-\d{2})/g;
  const dates = [];
  let m;
  while((m = re.exec(t)) !== null){
    dates.push({ date: m[1], index: m.index });
  }
  // unique by date, keep first index
  const seen = new Set();
  return dates.filter(d => (seen.has(d.date) ? false : (seen.add(d.date), true)));
}

function dateToNum(d){
  // "YYYY-MM-DD" -> number
  const [y,m,dd] = d.split("-").map(x=>parseInt(x,10));
  return y*10000 + m*100 + dd;
}

/**
 * Extract numbers for a target date.
 * If not found, auto-pick nearest available date from OCR.
 */
function extractForDateSmart(text, targetDate){
  const t = normalize(text);

  const allDates = findAllDates(t);
  if(allDates.length === 0){
    return { ok:false, reason:"No dates detected in OCR text at all." };
  }

  let chosen = allDates.find(d => d.date === targetDate);

  let usedNearest = false;
  if(!chosen){
    // pick nearest date by numeric distance
    usedNearest = true;
    const targetN = dateToNum(targetDate);
    let best = allDates[0];
    let bestDist = Math.abs(dateToNum(best.date) - targetN);
    for(const d of allDates){
      const dist = Math.abs(dateToNum(d.date) - targetN);
      if(dist < bestDist){
        best = d; bestDist = dist;
      }
    }
    chosen = best;
  }

  const idx = chosen.index;
  const win = t.slice(idx, idx + 900);

  // collect numeric tokens near the date
  const nums = [];
  const reNum = /(\(?-?\d[\d,]*\.?\d*\)?)/g;
  let m;
  while((m = reNum.exec(win)) !== null){
    const s = m[1];
    if(s.includes("-")) continue; // ignore dates
    nums.push(s);
    if(nums.length > 40) break;
  }

  // Heuristic mapping (same as before):
  // [Registered, FTD, DepCount, Deposit, WCount, W, Active, Turnover, ...]
  if(nums.length < 8){
    return {
      ok:false,
      reason:`Date found (${chosen.date}) but not enough numbers near it (found ${nums.length}).`,
      chosenDate: chosen.date,
      usedNearest
    };
  }

  const registered = toNum(nums[0]);
  const ftd = toNum(nums[1]);
  const deposit = toNum(nums[3]);
  const active = toNum(nums[6]);
  const turnover = toNum(nums[7]);

  return {
    ok:true,
    chosenDate: chosen.date,
    usedNearest,
    registered, ftd, deposit, active, turnover,
    sample: nums.slice(0, 12)
  };
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

function calcDropPct(startVal, endVal){
  const drop = endVal - startVal;
  const pct = startVal === 0 ? null : (drop / startVal);
  return { drop, pct };
}

function fmtInt(n){
  return (n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function fmtPct(p){
  if(p === null || p === undefined) return "";
  return (p*100).toFixed(2) + "%";
}

function escapeHtml(s){
  return s.replace(/[&<>"']/g, (m)=>({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[m]));
}

function makeRow(brand, res){
  const tr = document.createElement("tr");
  const status = res.status || "—";
  const badgeClass = status === "OK" ? "badge ok" : status === "WARN" ? "badge warn" : "badge err";

  const cells = [
    brand,
    fmtInt(res.deposit.drop), fmtPct(res.deposit.pct),
    fmtInt(res.registered.drop), fmtPct(res.registered.pct),
    fmtInt(res.ftd.drop), fmtPct(res.ftd.pct),
    fmtInt(res.active.drop), fmtPct(res.active.pct),
    fmtInt(res.turnover.drop), fmtPct(res.turnover.pct),
    `<span class="${badgeClass}">${status}</span>`
  ];

  cells.forEach((c,i)=>{
    const td = document.createElement("td");
    td.innerHTML = (i===11 ? c : escapeHtml(String(c)));
    tr.appendChild(td);
  });
  return tr;
}

function renderRaw(brand, text, startObj, endObj, startTarget, endTarget){
  const wrap = document.createElement("details");
  wrap.className = "rawItem";
  const sum = document.createElement("summary");
  sum.textContent = `${brand} — OCR text (click)`;

  const meta = document.createElement("div");
  meta.className = "muted small";
  meta.style.marginTop = "8px";

  const sUsed = startObj.ok ? startObj.chosenDate : "-";
  const eUsed = endObj.ok ? endObj.chosenDate : "-";

  meta.textContent =
    `Target Start=${startTarget} → Used=${sUsed}${startObj.usedNearest ? " (nearest)" : ""} | ` +
    `Target End=${endTarget} → Used=${eUsed}${endObj.usedNearest ? " (nearest)" : ""} ` +
    `| Start sample: ${startObj.ok ? JSON.stringify(startObj.sample) : startObj.reason} ` +
    `| End sample: ${endObj.ok ? JSON.stringify(endObj.sample) : endObj.reason}`;

  const pre = document.createElement("pre");
  pre.style.whiteSpace = "pre-wrap";
  pre.style.margin = "10px 0 0";
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
  const startDate = els.start.value.trim();
  const endDate = els.end.value.trim();

  els.dashBody.innerHTML = "";
  els.rawBox.innerHTML = "";

  if(!startDate || !endDate){
    alert("Please enter Start Date and End Date");
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

  const results = {};
  let done = 0;
  const total = Object.keys(byBrand).length || 1;

  for(const brand of ALLOWED){
    const f = byBrand[brand];
    if(!f){
      results[brand] = { status:"ERR", error:"No file uploaded for this brand" };
      continue;
    }

    setProgress(true, `OCR: ${brand}`, `Reading ${f.name}`, (done/total)*100);

    const text = await ocrImage(f, (status, prog)=>{
      setProgress(true, `OCR: ${brand}`, `${status} ${(prog*100).toFixed(0)}%`, ((done + prog) / total) * 100);
    });

    const startObj = extractForDateSmart(text, startDate);
    const endObj = extractForDateSmart(text, endDate);

    renderRaw(brand, text, startObj, endObj, startDate, endDate);

    if(!startObj.ok || !endObj.ok){
      results[brand] = {
        status:"ERR",
        deposit:{drop:0,pct:null},
        registered:{drop:0,pct:null},
        ftd:{drop:0,pct:null},
        active:{drop:0,pct:null},
        turnover:{drop:0,pct:null},
      };
      done++;
      continue;
    }

    const deposit = calcDropPct(startObj.deposit, endObj.deposit);
    const registered = calcDropPct(startObj.registered, endObj.registered);
    const ftd = calcDropPct(startObj.ftd, endObj.ftd);
    const active = calcDropPct(startObj.active, endObj.active);
    const turnover = calcDropPct(startObj.turnover, endObj.turnover);

    const usedNearest = startObj.usedNearest || endObj.usedNearest;
    results[brand] = {
      status: usedNearest ? "WARN" : "OK",
      deposit, registered, ftd, active, turnover
    };

    done++;
    setProgress(true, `OCR: ${brand}`, `Done`, (done/total)*100);
  }

  for(const brand of ALLOWED){
    const r = results[brand] || {
      status:"ERR",
      deposit:{drop:0,pct:null},
      registered:{drop:0,pct:null},
      ftd:{drop:0,pct:null},
      active:{drop:0,pct:null},
      turnover:{drop:0,pct:null},
    };
    els.dashBody.appendChild(makeRow(brand, r));
  }

  setProgress(false);
});
