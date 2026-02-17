/**
 * app.js
 * Calories Daily (SPA)
 * ฟีเจอร์:
 * - Firebase Auth: สมัคร/ล็อกอิน/ล็อกเอาท์ + session ไม่หาย
 * - Firestore:
 *   - users/{uid} = profile + goal
 *   - logs/{uid}/days/{YYYY-MM-DD} = รายการอาหารวันนี้ + totals + macros
 * - BMR/TDEE (Mifflin-St Jeor) + ตั้งเป้าลด/เพิ่ม/รักษา
 * - ติดตามแคลอรี่รายวัน + progress bar
 * - แนะนำอาหารจำนวนมาก + ค้นหา + สุ่มเมนู 1 วัน
 * - Chart.js Pie (Macros)
 * - Dark mode toggle
 * - Loading spinner + Toast
 * - LocalStorage cache ช่วยโหลดเร็ว
 */

import { fb } from "./firebase.js";

/* ----------------------------- Utilities ----------------------------- */
const $ = (id) => document.getElementById(id);

const LS_KEYS = {
  theme: "cd_theme",
  profile: "cd_profile_cache",
  today: "cd_today_cache", // เก็บ log วันนี้แบบเร็ว ๆ
};

function todayId() {
  // รูปแบบ YYYY-MM-DD
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatThaiDate(iso) {
  // iso: YYYY-MM-DD
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString("th-TH", { year: "numeric", month: "long", day: "numeric" });
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function round(n, digits = 0) {
  const p = Math.pow(10, digits);
  return Math.round(n * p) / p;
}

/* ----------------------------- UI: Loading & Toast ----------------------------- */
function setLoading(isLoading) {
  const el = $("loadingOverlay");
  if (isLoading) {
    el.classList.remove("hidden");
    el.classList.add("flex");
  } else {
    el.classList.add("hidden");
    el.classList.remove("flex");
  }
}

let toastTimer = null;
function showToast(title, msg, type = "success") {
  const toast = $("toast");
  $("toastTitle").textContent = title;
  $("toastMsg").textContent = msg;

  const dot = $("toastDot");
  dot.className = "mt-1.5 h-2.5 w-2.5 rounded-full";
  dot.classList.add(type === "error" ? "bg-red-500" : "bg-brand-green");

  toast.classList.remove("hidden");

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 3200);
}

$("toastClose").addEventListener("click", () => $("toast").classList.add("hidden"));

/* ----------------------------- SPA Routing ----------------------------- */
const routes = {
  dashboard: $("viewDashboard"),
  calc: $("viewCalc"),
  track: $("viewTrack"),
  foods: $("viewFoods"),
  auth: $("viewAuth"),
};

function setActiveRoute(routeName) {
  // ซ่อนทุก view
  Object.values(routes).forEach(v => v.classList.add("hidden"));
  routes[routeName].classList.remove("hidden");

  // ปุ่ม nav active
  document.querySelectorAll("[data-route]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.route === routeName);
  });
}

document.querySelectorAll("[data-route]").forEach(btn => {
  btn.addEventListener("click", () => {
    if (btn.dataset.route !== "auth") setActiveRoute(btn.dataset.route);
  });
});

// Quick buttons
$("btnGoAuth").addEventListener("click", () => setActiveRoute("auth"));
$("btnGoAuth2").addEventListener("click", () => setActiveRoute("auth"));
$("btnQuickToCalc").addEventListener("click", () => setActiveRoute("calc"));

/* ----------------------------- Dark Mode ----------------------------- */
function applyTheme(theme) {
  const root = document.documentElement;
  const isDark = theme === "dark";
  root.classList.toggle("dark", isDark);
  $("themeIcon").textContent = isDark ? "☀️" : "🌙";
  localStorage.setItem(LS_KEYS.theme, theme);
}

$("btnTheme").addEventListener("click", () => {
  const current = localStorage.getItem(LS_KEYS.theme) || "light";
  applyTheme(current === "light" ? "dark" : "light");
});

// init theme
applyTheme(localStorage.getItem(LS_KEYS.theme) || "light");

/* ----------------------------- Data Models ----------------------------- */
let state = {
  user: null,
  profile: {
    gender: "male",
    age: null,
    height: null,
    weight: null,
    activity: 1.2,
    bmr: null,
    tdee: null,
    goal: {
      type: "maintain", // maintain | cut | bulk
      delta: 300,
      targetKcal: null,
    }
  },
  today: {
    id: todayId(),
    foods: [], // {name, kcal, p, c, f, ts}
    totals: { kcal: 0, p: 0, c: 0, f: 0 }
  }
};

/* ----------------------------- Firestore Paths ----------------------------- */
function userDocRef(uid) {
  return fb.doc(fb.db, "users", uid);
}
function dayDocRef(uid, dayId) {
  // logs/{uid}/days/{dayId}
  return fb.doc(fb.db, "logs", uid, "days", dayId);
}

/* ----------------------------- Local Cache ----------------------------- */
function loadCache() {
  const p = localStorage.getItem(LS_KEYS.profile);
  if (p) {
    try { state.profile = JSON.parse(p); } catch {}
  }
  const t = localStorage.getItem(LS_KEYS.today);
  if (t) {
    try {
      const parsed = JSON.parse(t);
      if (parsed?.id === todayId()) state.today = parsed;
    } catch {}
  }
}
function saveCache() {
  localStorage.setItem(LS_KEYS.profile, JSON.stringify(state.profile));
  localStorage.setItem(LS_KEYS.today, JSON.stringify(state.today));
}

/* ----------------------------- BMR/TDEE + Goal ----------------------------- */
function calcBMR({ gender, age, height, weight }) {
  // Mifflin-St Jeor
  // male: 10W + 6.25H - 5A + 5
  // female: 10W + 6.25H - 5A - 161
  const base = 10 * weight + 6.25 * height - 5 * age;
  return gender === "male" ? base + 5 : base - 161;
}
function calcTDEE(bmr, activity) {
  return bmr * activity;
}

function goalLabel(type) {
  if (type === "cut") return "ลดน้ำหนัก";
  if (type === "bulk") return "เพิ่มน้ำหนัก";
  return "รักษาน้ำหนัก";
}

function computeTargetFromGoal(tdee, type, delta) {
  if (!tdee) return null;
  if (type === "cut") return Math.max(1200, tdee - delta); // กันต่ำเกินไปแบบคร่าว ๆ
  if (type === "bulk") return tdee + delta;
  return tdee;
}

/* ----------------------------- Chart.js (Macros Pie) ----------------------------- */
let macroChart = null;

function renderMacroChart(p, c, f) {
  const ctx = $("macroChart");
  const data = [p, c, f];

  if (macroChart) {
    macroChart.data.datasets[0].data = data;
    macroChart.update();
    return;
  }

  macroChart = new Chart(ctx, {
    type: "pie",
    data: {
      labels: ["โปรตีน", "คาร์โบไฮเดรต", "ไขมัน"],
      datasets: [{
        data,
        // ไม่กำหนดสีเองตามข้อกำหนดไม่ได้บังคับสี (Chart.js default)
      }]
    },
    options: {
      plugins: {
        legend: { position: "bottom" }
      }
    }
  });
}

/* ----------------------------- UI Render ----------------------------- */
function renderTodayHeader() {
  const id = state.today.id;
  $("todayStr").textContent = formatThaiDate(id);
}

function renderProfileToInputs() {
  // Calc inputs
  $("gender").value = state.profile.gender ?? "male";
  $("age").value = state.profile.age ?? "";
  $("height").value = state.profile.height ?? "";
  $("weight").value = state.profile.weight ?? "";
  $("activity").value = String(state.profile.activity ?? 1.2);

  // Goal inputs
  $("goalType").value = state.profile.goal?.type ?? "maintain";
  $("goalDelta").value = String(state.profile.goal?.delta ?? 300);

  // Outputs
  $("outBmr").textContent = state.profile.bmr ? `${round(state.profile.bmr)} kcal` : "—";
  $("outTdee").textContent = state.profile.tdee ? `${round(state.profile.tdee)} kcal` : "—";
}

function renderDashboard() {
  // BMR/TDEE cards
  $("dashBmr").textContent = state.profile.bmr ? `${round(state.profile.bmr)}` : "—";
  $("dashTdee").textContent = state.profile.tdee ? `${round(state.profile.tdee)}` : "—";

  // Goal box
  const g = state.profile.goal || {};
  if (g.targetKcal) {
    $("goalTitle").textContent = `${goalLabel(g.type)} • Target ${round(g.targetKcal)} kcal`;
    const desc = (g.type === "cut")
      ? `แนะนำ: TDEE - ${g.delta} kcal`
      : (g.type === "bulk")
        ? `แนะนำ: TDEE + ${g.delta} kcal`
        : `แนะนำ: เท่ากับ TDEE`;

    $("goalDesc").textContent = desc;

    // สีพื้นตามเป้าหมาย
    const box = $("goalBox");
    box.className =
      "rounded-2xl p-4 border border-slate-200/70 dark:border-slate-800/70";
    if (g.type === "cut") box.classList.add("bg-red-50", "dark:bg-red-950/20");
    else if (g.type === "bulk") box.classList.add("bg-blue-50", "dark:bg-sky-950/20");
    else box.classList.add("bg-green-50", "dark:bg-emerald-950/20");
  } else {
    $("goalTitle").textContent = "ยังไม่ได้ตั้งเป้าหมาย";
    $("goalDesc").textContent = "ไปที่หน้า “คำนวณ BMR/TDEE” เพื่อกำหนดเป้าหมาย (ลด/เพิ่ม/รักษา)";
  }

  // Today totals
  const target = state.profile.goal?.targetKcal ?? null;
  const eaten = state.today.totals.kcal ?? 0;
  $("statTarget").textContent = target ? `${round(target)}` : "—";
  $("statEaten").textContent = `${round(eaten)}`;
  $("statRemain").textContent = target ? `${round(target - eaten)}` : "—";

  // Progress
  const pct = target ? clamp((eaten / target) * 100, 0, 200) : 0;
  $("progressText").textContent = target ? `${round(pct)}%` : "0%";
  $("progressBar").style.width = target ? `${clamp(pct, 0, 100)}%` : "0%";

  // Macros
  $("mProtein").textContent = `${round(state.today.totals.p, 1)}g`;
  $("mCarb").textContent = `${round(state.today.totals.c, 1)}g`;
  $("mFat").textContent = `${round(state.today.totals.f, 1)}g`;
  renderMacroChart(state.today.totals.p, state.today.totals.c, state.today.totals.f);
}

function renderTrackSide() {
  const target = state.profile.goal?.targetKcal ?? null;
  const eaten = state.today.totals.kcal ?? 0;
  $("trackTarget").textContent = target ? `${round(target)}` : "—";
  $("trackTotal").textContent = `${round(eaten)}`;

  const pct = target ? clamp((eaten / target) * 100, 0, 200) : 0;
  $("trackProgressText").textContent = target ? `${round(pct)}%` : "0%";
  $("trackProgressBar").style.width = target ? `${clamp(pct, 0, 100)}%` : "0%";
}

function renderTodayList() {
  const wrap = $("todayList");
  wrap.innerHTML = "";

  if (!state.today.foods.length) {
    wrap.innerHTML = `
      <div class="rounded-2xl border border-slate-200/70 dark:border-slate-800/70 p-4 bg-slate-50 dark:bg-slate-900/40">
        <p class="font-extrabold">ยังไม่มีรายการ</p>
        <p class="text-sm text-slate-600 dark:text-slate-300">เพิ่มอาหารที่กินวันนี้ แล้วระบบจะคำนวณให้อัตโนมัติ</p>
      </div>
    `;
    return;
  }

  state.today.foods.forEach((f, idx) => {
    const card = document.createElement("div");
    card.className = "rounded-2xl border border-slate-200/70 dark:border-slate-800/70 p-4 bg-white dark:bg-slate-900/40";
    card.innerHTML = `
      <div class="flex items-start justify-between gap-3">
        <div>
          <p class="font-extrabold">${escapeHtml(f.name)}</p>
          <p class="text-sm text-slate-500 dark:text-slate-400">
            ${round(f.kcal)} kcal • P ${round(f.p,1)}g • C ${round(f.c,1)}g • F ${round(f.f,1)}g
          </p>
        </div>
        <button class="text-red-500 hover:opacity-80 font-extrabold" data-del="${idx}">ลบ</button>
      </div>
    `;
    wrap.appendChild(card);
  });

  // bind delete
  wrap.querySelectorAll("[data-del]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const idx = Number(btn.dataset.del);
      state.today.foods.splice(idx, 1);
      recomputeTodayTotals();
      await persistToday();
      renderAll();
      showToast("ลบแล้ว", "ลบรายการอาหารเรียบร้อย", "success");
    });
  });
}

function renderGoalPreview() {
  const tdee = state.profile.tdee;
  const type = $("goalType").value;
  const delta = Number($("goalDelta").value);

  if (!tdee) {
    $("goalPreviewTitle").textContent = "ยังไม่ได้คำนวณ";
    $("goalPreviewDesc").textContent = "กรุณาคำนวณ TDEE ก่อน";
    return;
  }

  const target = computeTargetFromGoal(tdee, type, delta);
  $("goalPreviewTitle").textContent = `${goalLabel(type)} • Target ~ ${round(target)} kcal`;
  $("goalPreviewDesc").textContent =
    type === "cut" ? `แนะนำ: TDEE (${round(tdee)}) - ${delta}`
    : type === "bulk" ? `แนะนำ: TDEE (${round(tdee)}) + ${delta}`
    : `แนะนำ: เท่ากับ TDEE (${round(tdee)})`;
}

/* ----------------------------- Foods Catalog ----------------------------- */
const FOOD_DB = {
  "โปรตีน": [
    { name: "อกไก่ย่าง 150g", kcal: 250, p: 40, c: 0, f: 6 },
    { name: "ไข่ต้ม 2 ฟอง", kcal: 140, p: 12, c: 1, f: 10 },
    { name: "ปลาแซลมอน 120g", kcal: 240, p: 25, c: 0, f: 15 },
    { name: "เต้าหู้ขาว 200g", kcal: 160, p: 18, c: 6, f: 7 },
    { name: "กรีกโยเกิร์ต 1 ถ้วย", kcal: 130, p: 15, c: 8, f: 3 },
    { name: "ทูน่าในน้ำแร่ 1 กระป๋อง", kcal: 120, p: 26, c: 0, f: 1 },
  ],
  "คาร์โบไฮเดรต": [
    { name: "ข้าวกล้อง 1 ถ้วย", kcal: 215, p: 5, c: 45, f: 2 },
    { name: "มันหวาน 200g", kcal: 180, p: 4, c: 41, f: 0 },
    { name: "ขนมปังโฮลวีต 2 แผ่น", kcal: 160, p: 8, c: 28, f: 2 },
    { name: "ข้าวโอ๊ต 50g", kcal: 190, p: 7, c: 33, f: 4 },
    { name: "กล้วยหอม 1 ลูก", kcal: 105, p: 1, c: 27, f: 0 },
  ],
  "ไขมันดี": [
    { name: "อะโวคาโด 1/2 ลูก", kcal: 120, p: 2, c: 6, f: 11 },
    { name: "อัลมอนด์ 20 เม็ด", kcal: 140, p: 5, c: 5, f: 12 },
    { name: "น้ำมันมะกอก 1 ช้อนโต๊ะ", kcal: 120, p: 0, c: 0, f: 14 },
    { name: "เมล็ดเจีย 1 ช้อนโต๊ะ", kcal: 60, p: 2, c: 5, f: 4 },
  ],
  "ผักและผลไม้": [
    { name: "บรอกโคลี 200g", kcal: 70, p: 6, c: 14, f: 1 },
    { name: "สลัดผักรวม", kcal: 90, p: 3, c: 12, f: 4 },
    { name: "แอปเปิล 1 ลูก", kcal: 95, p: 0, c: 25, f: 0 },
    { name: "ส้ม 1 ลูก", kcal: 60, p: 1, c: 15, f: 0 },
  ],
  "อาหารไทย (ประมาณ)": [
    { name: "ข้าวมันไก่ 1 จาน", kcal: 650, p: 30, c: 80, f: 22 },
    { name: "กะเพราไก่ไข่ดาว 1 จาน", kcal: 720, p: 35, c: 75, f: 30 },
    { name: "ผัดไทย 1 จาน", kcal: 700, p: 20, c: 95, f: 25 },
    { name: "ส้มตำไทย + ไก่ย่าง", kcal: 520, p: 28, c: 45, f: 20 },
    { name: "ต้มยำกุ้ง 1 ถ้วย", kcal: 180, p: 16, c: 12, f: 6 },
  ]
};

function flattenFoodDB() {
  const all = [];
  for (const cat of Object.keys(FOOD_DB)) {
    FOOD_DB[cat].forEach(item => all.push({ ...item, cat }));
  }
  return all;
}

function randomDayMenu() {
  const cats = ["โปรตีน", "คาร์โบไฮเดรต", "ไขมันดี", "ผักและผลไม้", "อาหารไทย (ประมาณ)"];
  // สุ่มแนว “1 วัน”: โปรตีน 2, คาร์บ 2, ไขมันดี 1, ผักผลไม้ 2, ไทย 1
  const picks = [];
  picks.push(pickOne(FOOD_DB["โปรตีน"]));
  picks.push(pickOne(FOOD_DB["โปรตีน"]));
  picks.push(pickOne(FOOD_DB["คาร์โบไฮเดรต"]));
  picks.push(pickOne(FOOD_DB["คาร์โบไฮเดรต"]));
  picks.push(pickOne(FOOD_DB["ไขมันดี"]));
  picks.push(pickOne(FOOD_DB["ผักและผลไม้"]));
  picks.push(pickOne(FOOD_DB["ผักและผลไม้"]));
  picks.push(pickOne(FOOD_DB["อาหารไทย (ประมาณ)"]));

  return picks;
}

function pickOne(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function renderRandomBox(items) {
  const wrap = $("randomBox");
  wrap.innerHTML = "";

  const totals = items.reduce((acc, it) => {
    acc.kcal += it.kcal; acc.p += it.p; acc.c += it.c; acc.f += it.f;
    return acc;
  }, { kcal: 0, p: 0, c: 0, f: 0 });

  items.forEach(it => {
    const div = document.createElement("div");
    div.className = "rounded-2xl border border-slate-200/70 dark:border-slate-800/70 p-4 bg-white dark:bg-slate-900/40";
    div.innerHTML = `
      <p class="font-extrabold">${escapeHtml(it.name)}</p>
      <p class="text-sm text-slate-500 dark:text-slate-400">${round(it.kcal)} kcal</p>
      <button class="btn-secondary mt-3 w-full">เพิ่มไป “วันนี้”</button>
    `;
    div.querySelector("button").addEventListener("click", async () => {
      await addFoodToToday(it);
      showToast("เพิ่มแล้ว", `เพิ่ม "${it.name}" เข้าในวันนี้`, "success");
    });
    wrap.appendChild(div);
  });

  const sum = document.createElement("div");
  sum.className = "rounded-2xl border border-slate-200/70 dark:border-slate-800/70 p-4 bg-slate-50 dark:bg-slate-900/40";
  sum.innerHTML = `
    <p class="font-extrabold">รวมโดยประมาณ</p>
    <p class="text-sm text-slate-600 dark:text-slate-300 mt-1">
      ${round(totals.kcal)} kcal • P ${round(totals.p,1)}g • C ${round(totals.c,1)}g • F ${round(totals.f,1)}g
    </p>
  `;
  wrap.appendChild(sum);
}

/* ----------------------------- HTML Escape ----------------------------- */
function escapeHtml(str = "") {
  return str.replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}
function escapeAttr(str = "") {
  return str.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/* ----------------------------- Totals ----------------------------- */
function recomputeTodayTotals() {
  const totals = state.today.foods.reduce((acc, f) => {
    acc.kcal += Number(f.kcal || 0);
    acc.p += Number(f.p || 0);
    acc.c += Number(f.c || 0);
    acc.f += Number(f.f || 0);
    return acc;
  }, { kcal: 0, p: 0, c: 0, f: 0 });

  state.today.totals = {
    kcal: round(totals.kcal, 0),
    p: round(totals.p, 1),
    c: round(totals.c, 1),
    f: round(totals.f, 1),
  };

  saveCache();
}

/* ----------------------------- Firestore: Load/Save ----------------------------- */
async function ensureUserDoc(uid, email) {
  const ref = userDocRef(uid);
  const snap = await fb.getDoc(ref);

  if (!snap.exists()) {
    // สร้างเอกสารผู้ใช้ใหม่
    await fb.setDoc(ref, {
      email,
      createdAt: fb.serverTimestamp(),
      profile: state.profile,
      updatedAt: fb.serverTimestamp()
    });
  }
}

async function loadUserProfile(uid) {
  // 1) ลองโหลดจาก Firestore
  const ref = userDocRef(uid);
  const snap = await fb.getDoc(ref);
  if (snap.exists()) {
    const data = snap.data();
    if (data?.profile) {
      state.profile = data.profile;
      saveCache();
    }
  }
}

async function saveUserProfile(uid) {
  const ref = userDocRef(uid);
  await fb.setDoc(ref, {
    profile: state.profile,
    updatedAt: fb.serverTimestamp()
  }, { merge: true });
  saveCache();
}

async function loadToday(uid) {
  const day = todayId();
  state.today.id = day;

  const ref = dayDocRef(uid, day);
  const snap = await fb.getDoc(ref);

  if (snap.exists()) {
    const data = snap.data();
    state.today.foods = data.foods || [];
    state.today.totals = data.totals || { kcal: 0, p: 0, c: 0, f: 0 };
  } else {
    // ถ้ายังไม่มีเอกสารวันนี้ ให้สร้างเอกสารเปล่า
    await fb.setDoc(ref, {
      dayId: day,
      foods: [],
      totals: { kcal: 0, p: 0, c: 0, f: 0 },
      updatedAt: fb.serverTimestamp()
    }, { merge: true });
    state.today.foods = [];
    state.today.totals = { kcal: 0, p: 0, c: 0, f: 0 };
  }

  saveCache();
}

async function persistToday() {
  recomputeTodayTotals();
  saveCache();

  if (!state.user) return; // ยังไม่ล็อกอินก็ยังให้ใช้งานในเครื่องได้

  const ref = dayDocRef(state.user.uid, state.today.id);
  await fb.setDoc(ref, {
    dayId: state.today.id,
    foods: state.today.foods,
    totals: state.today.totals,
    updatedAt: fb.serverTimestamp()
  }, { merge: true });
}

/* ----------------------------- Auth ----------------------------- */
async function signup(email, pass) {
  const cred = await fb.createUserWithEmailAndPassword(fb.auth, email, pass);
  return cred.user;
}

async function login(email, pass) {
  const cred = await fb.signInWithEmailAndPassword(fb.auth, email, pass);
  return cred.user;
}

async function logout() {
  await fb.signOut(fb.auth);
}

/* ----------------------------- App Flow ----------------------------- */
function showMustLoginBanner(show) {
  $("mustLogin").classList.toggle("hidden", !show);
}

function setAuthUI(isLoggedIn) {
  $("authArea").classList.toggle("hidden", isLoggedIn);
  $("userArea").classList.toggle("hidden", !isLoggedIn);

  if (isLoggedIn && state.user) {
    $("userEmail").textContent = state.user.email || "ผู้ใช้";
    showMustLoginBanner(false);
  } else {
    showMustLoginBanner(true);
  }
}

function renderAll() {
  renderTodayHeader();
  renderProfileToInputs();
  renderGoalPreview();
  renderTodayList();
  renderTrackSide();
  renderDashboard();
}

async function bootstrap() {
  setLoading(true);

  // โหลด cache ก่อนเพื่อให้ UI อัปเดตเร็ว
  loadCache();

  // ตั้งค่า UI เบื้องต้น
  renderAll();

  // แสดงวันที่
  $("todayStr").textContent = formatThaiDate(todayId());

  // Auth state listener (session ไม่หาย)
  fb.onAuthStateChanged(fb.auth, async (user) => {
    state.user = user || null;
    setAuthUI(!!user);

    try {
      if (user) {
        // ensure user document
        await ensureUserDoc(user.uid, user.email || "");

        // โหลดโปรไฟล์และ log วันนี้จาก Firestore
        await loadUserProfile(user.uid);
        await loadToday(user.uid);

        showToast("ยินดีต้อนรับ", "ซิงก์ข้อมูลจาก Firestore แล้ว", "success");
        setActiveRoute("dashboard");
      } else {
        // ไม่ล็อกอิน: ใช้ข้อมูลจาก cache ต่อได้
        state.today.id = todayId();
        if (state.today.id !== todayId()) state.today = { id: todayId(), foods: [], totals: { kcal: 0, p: 0, c: 0, f: 0 } };
        setActiveRoute("dashboard");
      }
    } catch (e) {
      console.error(e);
      showToast("เกิดข้อผิดพลาด", "โหลดข้อมูลไม่สำเร็จ (ตรวจ Firebase config/rules)", "error");
    } finally {
      renderAll();
      setLoading(false);
    }
  });

  setLoading(false);
}

/* ----------------------------- Bind Events ----------------------------- */
// Signup
$("btnSignup").addEventListener("click", async () => {
  const email = $("signupEmail").value.trim();
  const pass = $("signupPass").value.trim();
  if (!email || pass.length < 6) {
    showToast("ข้อมูลไม่ครบ", "กรอกอีเมล และรหัสผ่านอย่างน้อย 6 ตัวอักษร", "error");
    return;
  }

  setLoading(true);
  try {
    await signup(email, pass);
    showToast("สมัครสำเร็จ", "เข้าสู่ระบบให้อัตโนมัติ", "success");
  } catch (e) {
    console.error(e);
    showToast("สมัครไม่สำเร็จ", e.message || "ลองใหม่อีกครั้ง", "error");
  } finally {
    setLoading(false);
  }
});

// Login
$("btnLogin").addEventListener("click", async () => {
  const email = $("loginEmail").value.trim();
  const pass = $("loginPass").value.trim();
  if (!email || !pass) {
    showToast("ข้อมูลไม่ครบ", "กรอกอีเมลและรหัสผ่าน", "error");
    return;
  }

  setLoading(true);
  try {
    await login(email, pass);
    showToast("เข้าสู่ระบบสำเร็จ", "ยินดีต้อนรับกลับ!", "success");
  } catch (e) {
    console.error(e);
    showToast("ล็อกอินไม่สำเร็จ", e.message || "ตรวจอีเมล/รหัสผ่าน", "error");
  } finally {
    setLoading(false);
  }
});

// Logout
$("btnLogout").addEventListener("click", async () => {
  setLoading(true);
  try {
    await logout();
    showToast("ออกจากระบบแล้ว", "ข้อมูลในเครื่องยังอยู่ (cache)", "success");
  } catch (e) {
    console.error(e);
    showToast("ออกจากระบบไม่สำเร็จ", e.message || "ลองใหม่", "error");
  } finally {
    setLoading(false);
  }
});

// Calculate BMR/TDEE
$("btnCalc").addEventListener("click", () => {
  const gender = $("gender").value;
  const age = Number($("age").value);
  const height = Number($("height").value);
  const weight = Number($("weight").value);
  const activity = Number($("activity").value);

  if (!age || !height || !weight) {
    showToast("ข้อมูลไม่ครบ", "กรุณากรอก อายุ/ส่วนสูง/น้ำหนัก", "error");
    return;
  }

  const bmr = calcBMR({ gender, age, height, weight });
  const tdee = calcTDEE(bmr, activity);

  state.profile = {
    ...state.profile,
    gender, age, height, weight, activity,
    bmr: round(bmr, 0),
    tdee: round(tdee, 0),
  };

  // รีคำนวณ target ถ้ามี goal
  const g = state.profile.goal || { type: "maintain", delta: 300, targetKcal: null };
  const targetKcal = computeTargetFromGoal(state.profile.tdee, g.type, g.delta);
  state.profile.goal = { ...g, targetKcal: round(targetKcal, 0) };

  saveCache();
  renderAll();
  showToast("คำนวณสำเร็จ", "อัปเดต BMR/TDEE แล้ว", "success");
});

// Save Profile to Firestore
$("btnSaveProfile").addEventListener("click", async () => {
  if (!state.user) {
    showToast("ต้องเข้าสู่ระบบ", "เข้าสู่ระบบเพื่อบันทึกลง Firestore", "error");
    setActiveRoute("auth");
    return;
  }

  setLoading(true);
  try {
    await saveUserProfile(state.user.uid);
    showToast("บันทึกสำเร็จ", "บันทึกโปรไฟล์ลง Firestore แล้ว", "success");
  } catch (e) {
    console.error(e);
    showToast("บันทึกไม่สำเร็จ", e.message || "ตรวจ config/rules", "error");
  } finally {
    setLoading(false);
  }
});

// Apply goal preview
$("btnApplyGoal").addEventListener("click", () => {
  renderGoalPreview();
  const type = $("goalType").value;
  const delta = Number($("goalDelta").value);
  const target = computeTargetFromGoal(state.profile.tdee, type, delta);

  state.profile.goal = { type, delta, targetKcal: target ? round(target, 0) : null };
  saveCache();
  renderAll();

  showToast("ตั้งค่าเป้าหมาย", "คำนวณ Target kcal ให้แล้ว", "success");
});

// Save Goal
$("btnSaveGoal").addEventListener("click", async () => {
  if (!state.user) {
    showToast("ต้องเข้าสู่ระบบ", "เข้าสู่ระบบเพื่อบันทึกเป้าหมาย", "error");
    setActiveRoute("auth");
    return;
  }
  setLoading(true);
  try {
    await saveUserProfile(state.user.uid);
    showToast("บันทึกสำเร็จ", "บันทึกเป้าหมายลง Firestore แล้ว", "success");
  } catch (e) {
    console.error(e);
    showToast("บันทึกไม่สำเร็จ", e.message || "ตรวจ config/rules", "error");
  } finally {
    setLoading(false);
  }
});

// Track: add food
async function addFoodToToday(item) {
  const food = {
    name: item.name,
    kcal: Number(item.kcal || 0),
    p: Number(item.p || 0),
    c: Number(item.c || 0),
    f: Number(item.f || 0),
    ts: Date.now()
  };
  state.today.foods.unshift(food);
  await persistToday();
  renderAll();
}

$("btnAddFood").addEventListener("click", async () => {
  const name = $("foodName").value.trim();
  const kcal = Number($("foodCal").value);
  const p = Number($("foodP").value || 0);
  const c = Number($("foodC").value || 0);
  const f = Number($("foodF").value || 0);

  if (!name || !Number.isFinite(kcal)) {
    showToast("ข้อมูลไม่ครบ", "กรอกชื่ออาหารและแคลอรี่", "error");
    return;
  }

  setLoading(true);
  try {
    await addFoodToToday({ name, kcal, p, c, f });

    // clear inputs
    $("foodName").value = "";
    $("foodCal").value = "";
    $("foodP").value = "";
    $("foodC").value = "";
    $("foodF").value = "";

    showToast("เพิ่มสำเร็จ", "บันทึกรายการอาหารวันนี้แล้ว", "success");
  } catch (e) {
    console.error(e);
    showToast("เพิ่มไม่สำเร็จ", e.message || "ลองใหม่", "error");
  } finally {
    setLoading(false);
  }
});

// Clear today
$("btnClearToday").addEventListener("click", async () => {
  if (!confirm("ล้างรายการวันนี้ทั้งหมด?")) return;

  setLoading(true);
  try {
    state.today.foods = [];
    recomputeTodayTotals();
    await persistToday();
    renderAll();
    showToast("ล้างแล้ว", "ล้างรายการวันนี้เรียบร้อย", "success");
  } catch (e) {
    console.error(e);
    showToast("ล้างไม่สำเร็จ", e.message || "ลองใหม่", "error");
  } finally {
    setLoading(false);
  }
});

// Reload today from Firestore
$("btnReloadToday").addEventListener("click", async () => {
  if (!state.user) {
    showToast("โหมดออฟไลน์", "ยังไม่ได้ล็อกอิน ใช้ข้อมูลจากเครื่อง", "error");
    return;
  }
  setLoading(true);
  try {
    await loadToday(state.user.uid);
    renderAll();
    showToast("รีเฟรชแล้ว", "โหลดข้อมูลวันนี้จาก Firestore", "success");
  } catch (e) {
    console.error(e);
    showToast("รีเฟรชไม่สำเร็จ", e.message || "ลองใหม่", "error");
  } finally {
    setLoading(false);
  }
});

// Foods search
$("foodSearch").addEventListener("input", (e) => {
renderFoodCatalog(e.target.value);
});

// Random day
$("btnRandomDay").addEventListener("click", () => {
  const items = randomDayMenu();
  renderRandomBox(items);
  showToast("สุ่มเมนูแล้ว", "เลือกเพิ่มไปวันนี้ได้ทีละรายการ", "success");
});

/* ----------------------------- Init ----------------------------- */
function renderFoodCatalog(filterText = "") {
  const wrap = document.getElementById("foodCatalog");
  if (!wrap) return;
  wrap.innerHTML = "";

  const q = filterText.trim().toLowerCase();

  for (const cat of Object.keys(FOOD_DB)) {
    const items = FOOD_DB[cat].filter(i => !q || i.name.toLowerCase().includes(q));
    if (!items.length) continue;

    const section = document.createElement("div");
    section.innerHTML = `
      <div class="flex items-center justify-between">
        <h3 class="font-extrabold text-lg">${cat}</h3>
        <span class="text-xs text-slate-500 dark:text-slate-400">${items.length} รายการ</span>
      </div>
      <div class="mt-3 grid sm:grid-cols-2 gap-3" id="cat-${escapeAttr(cat)}"></div>
    `;
    wrap.appendChild(section);

    const grid = section.querySelector(`#cat-${escapeAttr(cat)}`);
    if (!grid) continue;

    items.forEach(item => {
      const card = document.createElement("div");
      card.className =
        "rounded-2xl border border-slate-200/70 dark:border-slate-800/70 p-4 bg-white dark:bg-slate-900/40";
      card.innerHTML = `
        <p class="font-extrabold">${escapeHtml(item.name)}</p>
        <p class="text-sm text-slate-500 dark:text-slate-400 mt-1">${round(item.kcal)} kcal</p>
        <button class="btn-secondary mt-3 w-full" data-add-food="1">เพิ่มไป “วันนี้”</button>
      `;
      card.querySelector('[data-add-food]').addEventListener("click", async () => {
        await addFoodToToday(item);
        showToast("เพิ่มแล้ว", `เพิ่ม "${item.name}" เข้าในวันนี้`, "success");
        setActiveRoute("track");
      });
      grid.appendChild(card);
    });
  }
}
renderFoodCatalog("");
renderRandomBox(randomDayMenu());
// -------- Photo MVP: pick photo + show suggested items --------
const foodPhotoInput = document.getElementById("foodPhotoInput");
const btnPickPhoto = document.getElementById("btnPickPhoto");

btnPickPhoto?.addEventListener("click", () => foodPhotoInput?.click());

foodPhotoInput?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  // preview
  const url = URL.createObjectURL(file);
  const img = document.getElementById("foodPhotoPreview");
  if (img) img.src = url;

  document.getElementById("photoPreviewWrap")?.classList.remove("hidden");

  // แสดงเมนูยอดนิยมให้เลือกเพิ่ม (ยังไม่เดา AI)
  const popular = [
    ...(FOOD_DB["อาหารไทย (ประมาณ)"] || []),
    ...((FOOD_DB["โปรตีน"] || []).slice(0, 2)),
  ];

  const wrap = document.getElementById("photoCandidates");
  if (!wrap) return;
  wrap.innerHTML = "";
  document.getElementById("photoResultWrap")?.classList.remove("hidden");

  popular.forEach(item => {
    const card = document.createElement("div");
    card.className = "rounded-2xl border border-slate-200/70 dark:border-slate-800/70 p-4 bg-white dark:bg-slate-900/40";
    card.innerHTML = `
      <p class="font-extrabold">${escapeHtml(item.name)}</p>
      <p class="text-sm text-slate-500 dark:text-slate-400 mt-1">${round(item.kcal)} kcal</p>
      <div class="grid grid-cols-3 gap-2 mt-3">
        <button class="btn-secondary" data-size="S">S</button>
        <button class="btn-secondary" data-size="M">M</button>
        <button class="btn-secondary" data-size="L">L</button>
      </div>
    `;

    card.querySelectorAll("button[data-size]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const size = btn.dataset.size;
        const mult = size === "S" ? 0.75 : size === "L" ? 1.25 : 1.0;

        await addFoodToToday({
          ...item,
          name: `${item.name} (${size})`,
          kcal: Math.round(item.kcal * mult),
          p: +(item.p * mult).toFixed(1),
          c: +(item.c * mult).toFixed(1),
          f: +(item.f * mult).toFixed(1),
        });

        showToast("เพิ่มแล้ว", `เพิ่ม "${item.name}" ขนาด ${size}`, "success");
        setActiveRoute("track");
      });
    });

    wrap.appendChild(card);
  });
});

bootstrap();
