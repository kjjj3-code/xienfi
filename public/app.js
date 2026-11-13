// 나만의 만화 번역기 — 브라우저 쪽 로직
// 이미지는 브라우저에서 줄여서 서버로 보내고, 번역 결과(글자 영역 + 번역문)를
// 원본 해상도 캔버스 위에 직접 그립니다. 좌표는 항상 원본 이미지 픽셀 기준입니다.

const $ = (id) => document.getElementById(id);
const MAX_EDGE = 1568; // 모델에 보내는 이미지의 긴 변(px)
const TALL_RATIO = 2.2; // 이보다 세로로 길면 여러 조각으로 나눠 번역
const CONCURRENCY = 2;

const pages = [];
let current = null;
let nextId = 1;
let running = 0;

// ── 설정 (브라우저에 기억) ────────────────────────────────────────────
const settings = { lang: "Korean", font: "Jua", sfx: false, notes: "" };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem("mt-settings") || "{}"));
} catch {}
const saveSettings = () => {
  try {
    localStorage.setItem("mt-settings", JSON.stringify(settings));
  } catch {}
};
$("lang").value = settings.lang;
$("font").value = settings.font;
$("sfx").checked = settings.sfx;
$("notes").value = settings.notes;
$("lang").onchange = (e) => ((settings.lang = e.target.value), saveSettings());
$("sfx").onchange = (e) => ((settings.sfx = e.target.checked), saveSettings());
$("notes").oninput = (e) => ((settings.notes = e.target.value), saveSettings());
$("font").onchange = (e) => {
  settings.font = e.target.value;
  saveSettings();
  render();
};
$("notesBtn").onclick = () => ($("notesPanel").hidden = !$("notesPanel").hidden);

// ── 서버 통신 ─────────────────────────────────────────────────────────
async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/api/login") {
    await login();
    return api(path, body);
  }
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}

let loginPromise = null;
function login() {
  loginPromise ??= new Promise((resolve) => {
    const dlg = $("login");
    dlg.showModal();
    dlg.oncancel = (e) => e.preventDefault();
    $("loginForm").onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api("/api/login", { password: $("password").value });
        dlg.close();
        loginPromise = null;
        resolve();
      } catch (err) {
        $("loginError").textContent = err.message;
      }
    };
  });
  return loginPromise;
}

api("/api/config").then((cfg) => {
  $("model").textContent = cfg.model === "mock" ? "MOCK 모드 (가짜 번역)" : cfg.model;
  if (cfg.authRequired && !cfg.authed) login();
});

// ── 이미지 추가 ───────────────────────────────────────────────────────
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("이미지를 열 수 없습니다."));
    img.src = URL.createObjectURL(file);
  });
}

async function addFiles(files) {
  const images = [...files]
    .filter((f) => f.type.startsWith("image/"))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const file of images) {
    try {
      const img = await loadImage(file);
      const page = {
        id: nextId++,
        name: file.name || `page-${nextId}.png`,
        img,
        w: img.naturalWidth,
        h: img.naturalHeight,
        status: "queued",
        error: "",
        regions: [],
        selected: -1,
        orig: null,
      };
      pages.push(page);
      if (!current) select(page);
    } catch {}
  }
  renderPageList();
  pump();
}

$("file").onchange = (e) => {
  addFiles(e.target.files);
  e.target.value = "";
};
$("drop").onkeydown = (e) => (e.key === "Enter" || e.key === " ") && $("file").click();
addEventListener("dragover", (e) => {
  e.preventDefault();
  document.body.classList.add("dragging");
});
addEventListener("dragleave", () => document.body.classList.remove("dragging"));
addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("dragging");
  addFiles(e.dataTransfer.files);
});
addEventListener("paste", (e) => {
  if (e.clipboardData?.files.length) addFiles(e.clipboardData.files);
});

// ── 번역 ──────────────────────────────────────────────────────────────
function pump() {
  while (running < CONCURRENCY) {
    const page = pages.find((p) => p.status === "queued");
    if (!page) return;
    running++;
    translatePage(page).finally(() => {
      running--;
      pump();
    });
  }
}

async function translatePage(page) {
  page.status = "working";
  page.error = "";
  refresh(page);
  try {
    const regions = [];
    for (const [y0, y1] of planChunks(page)) {
      const chunk = await encodeChunk(page, y0, y1);
      const result = await api("/api/translate", {
        image: chunk.data,
        mediaType: "image/jpeg",
        width: chunk.width,
        height: chunk.height,
        targetLang: settings.lang,
        includeSfx: settings.sfx,
        notes: settings.notes,
      });
      for (const r of result.regions || []) {
        const x = clamp(r.x / chunk.scale, 0, page.w - 4);
        const y = clamp(r.y / chunk.scale + y0, 0, page.h - 4);
        regions.push({
          x,
          y,
          w: clamp(r.width / chunk.scale, 4, page.w - x),
          h: clamp(r.height / chunk.scale, 4, page.h - y),
          type: r.type,
          original: r.original,
          text: r.translated,
          fontSize: 0, // 0 = 상자에 맞춰 자동
        });
      }
    }
    page.regions = regions;
    page.selected = -1;
    page.status = "done";
  } catch (err) {
    page.status = "error";
    page.error = err.message;
  }
  refresh(page, true);
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

// 세로로 긴 웹툰은 컷 사이의 빈 줄을 찾아 나눕니다 (말풍선을 반으로 자르지 않도록).
function planChunks(page) {
  if (page.h / page.w <= TALL_RATIO) return [[0, page.h]];
  const sw = 64;
  const sh = Math.round((page.h * sw) / page.w);
  const c = new OffscreenCanvas(sw, sh);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(page.img, 0, 0, sw, sh);
  const px = ctx.getImageData(0, 0, sw, sh).data;
  const busy = new Float32Array(sh); // 줄마다 밝기의 분산: 낮을수록 빈 줄
  for (let y = 0; y < sh; y++) {
    let sum = 0;
    let sq = 0;
    for (let x = 0; x < sw; x++) {
      const i = (y * sw + x) * 4;
      const l = px[i] * 0.3 + px[i + 1] * 0.6 + px[i + 2] * 0.1;
      sum += l;
      sq += l * l;
    }
    busy[y] = sq / sw - (sum / sw) ** 2;
  }
  const target = Math.round(sw * 1.6);
  const slack = Math.round(target * 0.3);
  const cuts = [0];
  let pos = 0;
  while (sh - pos > target + slack) {
    let best = pos + target;
    for (let y = pos + target - slack; y <= pos + target + slack; y++) {
      if (busy[y] < busy[best]) best = y;
    }
    cuts.push(best);
    pos = best;
  }
  cuts.push(sh);
  const k = page.h / sh;
  return cuts.slice(1).map((end, i) => [Math.round(cuts[i] * k), i === cuts.length - 2 ? page.h : Math.round(end * k)]);
}

async function encodeChunk(page, y0, y1) {
  const ch = y1 - y0;
  const scale = Math.min(1, MAX_EDGE / Math.max(page.w, ch));
  const width = Math.round(page.w * scale);
  const height = Math.round(ch * scale);
  const c = new OffscreenCanvas(width, height);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(page.img, 0, y0, page.w, ch, 0, 0, width, height);
  const blob = await c.convertToBlob({ type: "image/jpeg", quality: 0.9 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { data: btoa(bin), width, height, scale };
}

// ── 캔버스에 번역문 그리기 ────────────────────────────────────────────
const fontOf = (size) => `700 ${size}px "${settings.font}", "Noto Sans KR", sans-serif`;
const CJK = /[぀-ヿ㐀-鿿＀-￯]/;

// 줄바꿈 단위: 띄어쓰기 단어. 한자·가나는 글자 단위.
function units(line) {
  const out = [];
  for (const word of line.split(/(\s+)/)) {
    if (!word) continue;
    if (CJK.test(word)) out.push(...word);
    else out.push(word);
  }
  return out;
}

function wrap(ctx, text, maxW) {
  const lines = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const u of units(para)) {
      const candidate = line + u;
      if (ctx.measureText(candidate.trim()).width <= maxW || !line.trim()) {
        line = candidate;
        // 한 단어가 상자보다 넓으면 글자 단위로 자릅니다
        while (ctx.measureText(line.trim()).width > maxW && line.trim().length > 1) {
          let n = line.length - 1;
          while (n > 1 && ctx.measureText(line.slice(0, n)).width > maxW) n--;
          lines.push(line.slice(0, n));
          line = line.slice(n);
        }
      } else {
        lines.push(line.trim());
        line = /^\s+$/.test(u) ? "" : u;
      }
    }
    lines.push(line.trim());
  }
  return lines;
}

const LINE_H = 1.22;
function fitText(ctx, text, maxW, maxH, fixed) {
  const layout = (size) => {
    ctx.font = fontOf(size);
    const lines = wrap(ctx, text, maxW);
    const fits = lines.length * size * LINE_H <= maxH && lines.every((l) => ctx.measureText(l).width <= maxW);
    return { size, lines, fits };
  };
  if (fixed) return layout(fixed);
  let lo = 6;
  let hi = Math.max(lo, Math.floor(maxH));
  let best = layout(lo);
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const l = layout(mid);
    if (l.fits) {
      best = l;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

function originalPixels(page) {
  if (!page.orig) {
    const c = new OffscreenCanvas(page.w, page.h);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(page.img, 0, 0);
    page.orig = ctx;
  }
  return page.orig;
}

// 상자 테두리를 따라 원본 색을 뽑아 중앙값을 배경색으로 씁니다.
function backgroundOf(page, r) {
  const x = Math.max(0, Math.floor(r.x));
  const y = Math.max(0, Math.floor(r.y));
  const w = Math.max(1, Math.min(page.w - x, Math.floor(r.w)));
  const h = Math.max(1, Math.min(page.h - y, Math.floor(r.h)));
  const d = originalPixels(page).getImageData(x, y, w, h).data;
  const ch = [[], [], []];
  const take = (px, py) => {
    const i = (py * w + px) * 4;
    ch[0].push(d[i]);
    ch[1].push(d[i + 1]);
    ch[2].push(d[i + 2]);
  };
  const sx = Math.max(1, Math.floor(w / 40));
  const sy = Math.max(1, Math.floor(h / 40));
  for (let px = 0; px < w; px += sx) (take(px, 0), take(px, h - 1));
  for (let py = 0; py < h; py += sy) (take(0, py), take(w - 1, py));
  return ch.map((v) => v.sort((a, b) => a - b)[v.length >> 1]);
}

function draw(page, canvas, { original = false } = {}) {
  canvas.width = page.w;
  canvas.height = page.h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(page.img, 0, 0);
  if (original) return;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  for (const r of page.regions) {
    const sfx = r.type === "sfx";
    let ink = "#fff";
    let edge = "#000";
    if (!sfx) {
      const [R, G, B] = backgroundOf(page, r);
      const dark = R * 0.3 + G * 0.6 + B * 0.1 < 128;
      ink = dark ? "#fff" : "#111";
      edge = `rgb(${R},${G},${B})`;
      ctx.fillStyle = edge;
      ctx.beginPath();
      ctx.roundRect(r.x, r.y, r.w, r.h, Math.min(r.w, r.h) * 0.18);
      ctx.fill();
    }
    if (!r.text.trim()) continue;
    const pad = sfx ? 1 : 0.94;
    const { size, lines } = fitText(ctx, r.text, r.w * pad, r.h * pad, r.fontSize);
    const top = r.y + r.h / 2 - ((lines.length - 1) * size * LINE_H) / 2;
    ctx.strokeStyle = edge;
    ctx.lineWidth = size * (sfx ? 0.22 : 0.12);
    ctx.fillStyle = ink;
    lines.forEach((line, i) => {
      const ly = top + i * size * LINE_H;
      ctx.strokeText(line, r.x + r.w / 2, ly);
      ctx.fillText(line, r.x + r.w / 2, ly);
    });
  }
}

// 웹폰트가 늦게 로드되면 다시 그립니다.
const fontsReady = new Set();
function ensureFont() {
  const f = settings.font;
  if (fontsReady.has(f)) return;
  fontsReady.add(f);
  document.fonts?.load(fontOf(20), "가A").then(() => render(), () => {});
}

let showOriginal = false;
let raf = 0;
function render() {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => {
    if (!current) return;
    ensureFont();
    draw(current, $("canvas"), { original: showOriginal });
  });
}

// ── 화면 구성 ─────────────────────────────────────────────────────────
function select(page) {
  current = page;
  renderPageList();
  renderViewer(true);
}

function refresh(page, structural = false) {
  renderPageList();
  if (page === current) renderViewer(structural);
}

function renderPageList() {
  const ul = $("pages");
  ul.replaceChildren(
    ...pages.map((p) => {
      const li = document.createElement("li");
      li.className = p === current ? "current" : "";
      li.onclick = () => select(p);
      const img = document.createElement("img");
      img.src = p.img.src;
      img.alt = "";
      const meta = document.createElement("div");
      meta.className = "meta";
      const dot = document.createElement("span");
      dot.className = `dot ${p.status}`;
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = p.name;
      const rm = document.createElement("button");
      rm.className = "remove";
      rm.textContent = "×";
      rm.title = "목록에서 빼기";
      rm.onclick = (e) => {
        e.stopPropagation();
        pages.splice(pages.indexOf(p), 1);
        URL.revokeObjectURL(p.img.src);
        if (current === p) current = pages[0] || null;
        renderPageList();
        renderViewer(true);
      };
      meta.append(dot, name, rm);
      li.append(img, meta);
      return li;
    }),
  );
  $("downloadAll").hidden = pages.filter((p) => p.status === "done").length < 2;
}

const STATUS = { queued: "대기 중…", working: "번역 중…", done: "", error: "" };
function renderViewer(structural) {
  $("empty").hidden = !!current;
  $("viewer").hidden = !current;
  $("regionsCol").hidden = !current || current.status !== "done";
  if (!current) return;
  const p = current;
  const st = $("status");
  st.className = p.status === "error" ? "error" : "";
  st.textContent =
    p.status === "error" ? p.error : p.status === "done" ? `글자 영역 ${p.regions.length}개` : STATUS[p.status];
  $("download").disabled = $("addBox").disabled = p.status !== "done";
  $("retry").disabled = p.status === "working" || p.status === "queued";
  if (structural) {
    renderBoxes();
    renderRegions();
  }
  render();
}

function setSelected(i) {
  current.selected = i;
  [...$("boxes").children].forEach((el, n) => el.classList.toggle("selected", n === i));
  [...$("regions").children].forEach((el, n) => el.classList.toggle("selected", n === i));
}

function placeBox(el, r) {
  const p = current;
  el.style.left = `${(r.x / p.w) * 100}%`;
  el.style.top = `${(r.y / p.h) * 100}%`;
  el.style.width = `${(r.w / p.w) * 100}%`;
  el.style.height = `${(r.h / p.h) * 100}%`;
}

function renderBoxes() {
  const p = current;
  $("boxes").replaceChildren(
    ...p.regions.map((r, i) => {
      const el = document.createElement("div");
      el.className = "box" + (i === p.selected ? " selected" : "");
      const handle = document.createElement("div");
      handle.className = "handle";
      el.append(handle);
      placeBox(el, r);
      el.onpointerdown = (e) => {
        e.preventDefault();
        setSelected(i);
        $("regions").children[i]?.scrollIntoView({ block: "nearest" });
        const resize = e.target === handle;
        const k = p.w / $("stage").clientWidth;
        const start = { px: e.clientX, py: e.clientY, x: r.x, y: r.y, w: r.w, h: r.h };
        el.setPointerCapture(e.pointerId);
        el.onpointermove = (m) => {
          const dx = (m.clientX - start.px) * k;
          const dy = (m.clientY - start.py) * k;
          if (resize) {
            r.w = clamp(start.w + dx, 12, p.w - r.x);
            r.h = clamp(start.h + dy, 12, p.h - r.y);
          } else {
            r.x = clamp(start.x + dx, 0, p.w - r.w);
            r.y = clamp(start.y + dy, 0, p.h - r.h);
          }
          placeBox(el, r);
          render();
        };
        el.onpointerup = el.onpointercancel = () => (el.onpointermove = null);
      };
      return el;
    }),
  );
}

function renderRegions() {
  const p = current;
  $("regions").replaceChildren(
    ...p.regions.map((r, i) => {
      const card = document.createElement("div");
      card.className = "region" + (i === p.selected ? " selected" : "");
      card.onfocusin = card.onclick = () => setSelected(i);
      if (r.original) {
        const orig = document.createElement("div");
        orig.className = "orig";
        orig.textContent = r.original;
        card.append(orig);
      }
      const ta = document.createElement("textarea");
      ta.rows = 2;
      ta.value = r.text;
      ta.oninput = () => {
        r.text = ta.value;
        render();
      };
      const row = document.createElement("div");
      row.className = "row";
      const label = document.createElement("label");
      label.textContent = "글자 크기 ";
      const size = document.createElement("input");
      size.type = "number";
      size.min = 0;
      size.placeholder = "자동";
      size.value = r.fontSize || "";
      size.oninput = () => {
        r.fontSize = Math.max(0, Number(size.value) || 0);
        render();
      };
      label.append(size);
      const spacer = document.createElement("span");
      spacer.className = "spacer";
      const del = document.createElement("button");
      del.className = "del";
      del.textContent = "삭제";
      del.onclick = (e) => {
        e.stopPropagation();
        p.regions.splice(i, 1);
        p.selected = -1;
        renderViewer(true);
      };
      row.append(label, spacer, del);
      card.append(ta, row);
      return card;
    }),
  );
}

// ── 버튼 ──────────────────────────────────────────────────────────────
const cmp = $("compare");
const setOriginal = (v) => {
  showOriginal = v;
  $("boxes").style.visibility = v ? "hidden" : "";
  render();
};
cmp.onpointerdown = () => setOriginal(true);
cmp.onpointerup = cmp.onpointerleave = cmp.onpointercancel = () => showOriginal && setOriginal(false);
cmp.onkeydown = (e) => e.key === " " && !e.repeat && setOriginal(true);
cmp.onkeyup = () => setOriginal(false);

$("addBox").onclick = () => {
  const p = current;
  const w = p.w * 0.25;
  const h = w * 0.5;
  // 지금 화면에 보이는 위치 근처에 놓습니다
  const wrapEl = $("stageWrap");
  const k = p.w / $("stage").clientWidth;
  const y = clamp((wrapEl.scrollTop + wrapEl.clientHeight / 2) * k - h / 2, 0, p.h - h);
  p.regions.push({ x: (p.w - w) / 2, y, w, h, type: "bubble", original: "", text: "새 텍스트", fontSize: 0 });
  p.selected = p.regions.length - 1;
  renderViewer(true);
  $("regions").lastElementChild?.querySelector("textarea")?.select();
};

$("retry").onclick = () => {
  current.status = "queued";
  refresh(current, true);
  pump();
};

function save(page) {
  const c = document.createElement("canvas");
  draw(page, c);
  return new Promise((resolve) =>
    c.toBlob((blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = page.name.replace(/\.[^.]+$/, "") + "_translated.png";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      resolve();
    }, "image/png"),
  );
}
$("download").onclick = () => save(current);
$("downloadAll").onclick = async () => {
  for (const p of pages.filter((p) => p.status === "done")) {
    await save(p);
    await new Promise((r) => setTimeout(r, 300));
  }
};

addEventListener("keydown", (e) => {
  if (e.key !== "Delete" || !current || current.selected < 0) return;
  if (/^(TEXTAREA|INPUT|SELECT)$/.test(document.activeElement?.tagName)) return;
  current.regions.splice(current.selected, 1);
  current.selected = -1;
  renderViewer(true);
});
