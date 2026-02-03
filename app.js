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

/**
 * OCR using Tesseract.js
 * (Runs in browser, no server)
 */
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

/**
 * Extract numbers for a specific date from OCR text.
 * We search around the date and grab the first several numeric tokens.
 *
 * We assume table has order similar to your report:
 * Registered Users, First Depositors, Total Deposit Count, Total Deposit,
 * Total Withdrawal Count, Total Withdrawal, Active Players, Turnover, ...
 *
 * We only need:
 * - Registered Users
 * - First Depositors (FTD)
 * - Total Deposit (Deposit)
 * - Active Players
 * - Turnover
 */
function extractForDate(text, dateStr){
  const t = normalize(text);

  // locate the date index
  const idx = t.indexOf(dateStr);
  if(idx === -1){
    return { ok:false, reason:`Date ${dateStr} not found in OCR` };
  }

  // take a window after date (OCR may not preserve line breaks)
  const win = t.slice(idx, idx + 800);

  // pull numeric tokens (comma separated, decimals allowed)
  // e.g. 1,803   155,793,400.12   (25,073,803.27)
  const nums = [];
  const re = /(\(?-?\d[\d,]*\.?\d*\)?)/g;
  let m;
  while((m = re.exec(win)) !== null){
    let s = m[1];
    // ignore the date itself
    if(s.includes("-")) continue;
    nums.push(s);
    if(nums.length > 30) break;
  }

  // Heuristic mapping based on your table:
  // After date, usually next tokens:
  // [Registered, FirstDepositors, TotalDepositCount, TotalDeposit, TotalWCount, TotalW, Active, Turnover, ...]
  // We only need positions 0,1,3,6,7
  if(nums.length < 8){
    return { ok:false, reason:`Not enough numbers near ${dateStr} (found ${nums.length})` };
  }

  const registered = toNum(nums[0]);
  const ftd = toNum(nums[1]);
  const deposit = toNum(nums[3]);
  const active = toNum(nums[6]);
  const turnover = toNum(nums[7]);

  return { ok:true, registered, ftd, deposit, active, turnover, sample: nums.slice(0, 12) };
}

function toNum(s){
  if(!s) return 0;
  let x = String(s).trim();
  // negative in parentheses
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

function normalize(s){
  return String(s || "")
    .replace(/\u00A0/g," ")
    .replace(/[^\S\r\n]+/g," ")
    .replace(/\s+/g," ")
    .trim();
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

function escapeHtml(s){
  return s.replace(/[&<>"']/g, (m)=>({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[m]));
}

function renderRaw(brand, text, startObj, endObj){
  const wrap = document.createElement("details");
  wrap.className = "rawItem";
  const sum = document.createElement("summary");
  sum.textContent = `${brand} — OCR text (click)`;
  const pre = document.createElement("pre");
  pre.style.whiteSpace = "pre-wrap";
  pre.style.margin = "10px 0 0";
  pre.textContent = text;

  const meta = document.createElement("div");
  meta.className = "muted small";
  meta.style.marginTop = "8px";
  meta.textContent = `Start extract: ${startObj.ok ? JSON.stringify(startObj.sample) : startObj.reason} | End extract: ${endObj.ok ? JSON.stringify(endObj.sample) : endObj.reason}`;

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

  // group by brand
  const byBrand = {};
  for(const f of files){
    const b = parseBrandFromName(f.name);
    if(!b){
      // ignore but show warning later
      continue;
    }
    byBrand[b] = f;
  }

  const missing = ALLOWED.filter(b => !byBrand[b]);
  if(missing.length){
    alert("Missing screenshots for: " + missing.join(", ") + "\n(Upload anyway, it will still process what you provided.)");
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

    const startObj = extractForDate(text, startDate);
    const endObj = extractForDate(text, endDate);

    renderRaw(brand, text, startObj, endObj);

    if(!startObj.ok || !endObj.ok){
      results[brand] = {
        status:"ERR",
        error: `Extract failed. Start ok=${startObj.ok}, End ok=${endObj.ok}`
      };
      done++;
      continue;
    }

    const deposit = calcDropPct(startObj.deposit, endObj.deposit);
    const registered = calcDropPct(startObj.registered, endObj.registered);
    const ftd = calcDropPct(startObj.ftd, endObj.ftd);
    const active = calcDropPct(startObj.active, endObj.active);
    const turnover = calcDropPct(startObj.turnover, endObj.turnover);

    // WARN if all zeros (OCR probably failed)
    const allZero = [startObj.deposit,startObj.registered,startObj.ftd,startObj.active,startObj.turnover].every(v => v === 0)
                 && [endObj.deposit,endObj.registered,endObj.ftd,endObj.active,endObj.turnover].every(v => v === 0);

    results[brand] = {
      status: allZero ? "WARN" : "OK",
      deposit, registered, ftd, active, turnover
    };

    done++;
    setProgress(true, `OCR: ${brand}`, `Done`, (done/total)*100);
  }

  // Render dashboard
  for(const brand of ALLOWED){
    const r = results[brand] || { status:"ERR", error:"No result" };
    if(r.status === "OK" || r.status === "WARN"){
      els.dashBody.appendChild(makeRow(brand, r));
    } else {
      // show empty row with error status
      els.dashBody.appendChild(makeRow(brand, {
        status:"ERR",
        deposit:{drop:0,pct:null},
        registered:{drop:0,pct:null},
        ftd:{drop:0,pct:null},
        active:{drop:0,pct:null},
        turnover:{drop:0,pct:null},
      }));
    }
  }

  setProgress(false);
});
