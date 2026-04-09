// ============================================================
// firebase.js — LossIQ Dashboard  |  Firebase Config & DB API
// Project ID: lossiq-dashboard-ffedb
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  createUserWithEmailAndPassword,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore, collection, doc, setDoc, getDoc, getDocs,
  addDoc, updateDoc, deleteDoc, query, where, orderBy, limit,
  writeBatch, serverTimestamp, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── CONFIG ────────────────────────────────────────────────────
// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyAGN2YAXAZ88rme0Tfu33H1Bg_MJyMM6uU",
  authDomain: "lossiq-dashboard-ffedb.firebaseapp.com",
  projectId: "lossiq-dashboard-ffedb",
  storageBucket: "lossiq-dashboard-ffedb.firebasestorage.app",
  messagingSenderId: "557849334542",
  appId: "1:557849334542:web:3849da2f4b02f74ef53d5f",
  measurementId: "G-FTPSXTMPL0"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);

const app  = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db   = getFirestore(app);

// ── COLLECTION NAMES ─────────────────────────────────────────
export const C = {
  USERS:          "users",
  LOSS_DATA:      "loss_data",
  MASTER_DATA:    "master_data",
  LOGIN_LOGS:     "login_logs",
  RCA_UPDATES:    "rca_updates",
  REATTRIBUTIONS: "reattributions",
  UPLOAD_HISTORY: "upload_history",
};

// ── AUTH ──────────────────────────────────────────────────────
export async function loginUser(identifier, password) {
  // Mobile numbers get a virtual email format
  const email = /^\d{10}$/.test(identifier.trim())
    ? `${identifier.trim()}@lossiq.internal`
    : identifier.trim();
  try {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    await addDoc(collection(db, C.LOGIN_LOGS), {
      uid: cred.user.uid, identifier,
      logged_in_at: serverTimestamp(),
      session_id: crypto.randomUUID(),
      user_agent: navigator.userAgent,
    });
    return { success: true, user: cred.user };
  } catch (err) {
    return { success: false, error: friendlyAuthError(err.code) };
  }
}

export const logoutUser = () => signOut(auth);
export const onAuthChange = (cb) => onAuthStateChanged(auth, cb);

function friendlyAuthError(code) {
  const map = {
    "auth/wrong-password":    "Invalid password.",
    "auth/user-not-found":    "User not found.",
    "auth/invalid-email":     "Invalid email/mobile.",
    "auth/too-many-requests": "Too many attempts. Try later.",
  };
  return map[code] || "Authentication failed.";
}

// ── USER MANAGEMENT ──────────────────────────────────────────
export async function createUser(data) {
  const email    = data.email || `${data.mobile}@lossiq.internal`;
  const password = data.password || data.mobile;
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await setDoc(doc(db, C.USERS, cred.user.uid), {
      uid: cred.user.uid, name: data.name, designation: data.designation,
      mobile: data.mobile, email: data.email || "",
      zone: data.zone || "", sc_allocated: data.sc_allocated || [],
      reporting_manager: data.reporting_manager || "",
      role: data.role || "user", active: true, created_at: serverTimestamp(),
    });
    return { success: true, uid: cred.user.uid };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
export async function getAllUsers() {
  const snap = await getDocs(collection(db, C.USERS));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
export async function getUserById(uid) {
  const snap = await getDoc(doc(db, C.USERS, uid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}
export const updateUser = (uid, data) =>
  updateDoc(doc(db, C.USERS, uid), { ...data, updated_at: serverTimestamp() });
export const deleteUserDoc = (uid) => deleteDoc(doc(db, C.USERS, uid));

// ── MASTER DATA ───────────────────────────────────────────────
export async function uploadMasterData(rows) {
  const existing = await getDocs(collection(db, C.MASTER_DATA));
  const delBatch = writeBatch(db);
  existing.docs.forEach(d => delBatch.delete(d.ref));
  await delBatch.commit();

  const CHUNK = 499;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const b = writeBatch(db);
    rows.slice(i, i + CHUNK).forEach(row => {
      const ref = doc(collection(db, C.MASTER_DATA));
      b.set(ref, {
        location:       (row.location || "").toString().trim().toUpperCase(),
        cluster_head:   row["Cluster Head"]    || row.cluster_head    || "",
        zone:           row["Zone"]            || row.zone            || "",
        regional_head:  row["Regional Head"]   || row.regional_head   || "",
        sortcentre_type:row["Sortcentre type"] || row.sortcentre_type || "",
        partner:        row["Partner"]         || row.partner         || "",
        uploaded_at: serverTimestamp(),
      });
    });
    await b.commit();
  }
  return { success: true, count: rows.length };
}

export async function getMasterDataMap() {
  const snap = await getDocs(collection(db, C.MASTER_DATA));
  const map  = {};
  snap.docs.forEach(d => { const r = d.data(); map[r.location] = r; });
  return map;
}

// ── LOSS DATA ─────────────────────────────────────────────────
export async function uploadLossData(rawRows, masterMap, onProgress) {
  const processed = rawRows.map(row => {
    const loc    = (row.location || "").toString().trim().toUpperCase();
    const master = masterMap[loc] || {};
    let lostDate = null, month = "";
    if (row.actual_lost_date) {
      // Handle Excel serial dates
      let d = row.actual_lost_date;
      if (typeof d === "number") {
        d = new Date(Math.round((d - 25569) * 86400 * 1000));
      } else {
        d = new Date(d);
      }
      if (!isNaN(d)) {
        lostDate = Timestamp.fromDate(d);
        month = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
      }
    }
    return {
      actual_lost_date:     lostDate,
      month,
      current_movement_type: row.current_movement_type || "",
      awb:                  (row.awb || "").toString().trim(),
      shipment_value:       parseFloat(row.shipment_value)  || 0,
      loss_value:           parseFloat(row.loss_value)      || 0,
      location:             loc,
      reason:               row.reason    || "",
      reason_l1:            row.reason_l1 || "",
      attribution_changed:  row.attribution_changed || "",
      cluster_head:         master.cluster_head    || "",
      zone:                 master.zone            || "",
      regional_head:        master.regional_head   || "",
      sortcentre_type:      master.sortcentre_type || "",
      partner:              master.partner         || "",
      uploaded_at: serverTimestamp(),
    };
  });

  const CHUNK = 499;
  let done = 0;
  for (let i = 0; i < processed.length; i += CHUNK) {
    const b = writeBatch(db);
    processed.slice(i, i + CHUNK).forEach(row => {
      b.set(doc(collection(db, C.LOSS_DATA)), row);
    });
    await b.commit();
    done += Math.min(CHUNK, processed.length - i);
    onProgress && onProgress(done, processed.length);
  }
  await addDoc(collection(db, C.UPLOAD_HISTORY), {
    type: "loss_data", count: done,
    uploaded_at: serverTimestamp(),
    uploaded_by: auth.currentUser?.uid || "unknown",
  });
  return { success: true, count: done };
}

export async function queryLossData(filters = {}) {
  const constraints = [];
  const addIn = (field, vals) => {
    if (vals?.length) constraints.push(where(field, "in", vals.slice(0,10)));
  };
  addIn("month",                 filters.months);
  addIn("zone",                  filters.zones);
  addIn("regional_head",         filters.regional_heads);
  addIn("cluster_head",          filters.cluster_heads);
  addIn("location",              filters.locations);
  addIn("current_movement_type", filters.movements);
  addIn("reason_l1",             filters.reason_l1s);
  addIn("sortcentre_type",       filters.sortcentre_types);
  addIn("partner",               filters.partners);
  addIn("attribution_changed",   filters.attributions);
  const snap = await getDocs(query(collection(db, C.LOSS_DATA), ...constraints));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function getAllLossData() {
  const snap = await getDocs(collection(db, C.LOSS_DATA));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function getFilterOptions() {
  const snap = await getDocs(collection(db, C.LOSS_DATA));
  const opts = { months:new Set(), zones:new Set(), regional_heads:new Set(),
    cluster_heads:new Set(), locations:new Set(), movements:new Set(),
    reason_l1s:new Set(), sortcentre_types:new Set(), partners:new Set(), attributions:new Set() };
  snap.docs.forEach(d => {
    const r = d.data();
    if (r.month)                 opts.months.add(r.month);
    if (r.zone)                  opts.zones.add(r.zone);
    if (r.regional_head)         opts.regional_heads.add(r.regional_head);
    if (r.cluster_head)          opts.cluster_heads.add(r.cluster_head);
    if (r.location)              opts.locations.add(r.location);
    if (r.current_movement_type) opts.movements.add(r.current_movement_type);
    if (r.reason_l1)             opts.reason_l1s.add(r.reason_l1);
    if (r.sortcentre_type)       opts.sortcentre_types.add(r.sortcentre_type);
    if (r.partner)               opts.partners.add(r.partner);
    if (r.attribution_changed)   opts.attributions.add(r.attribution_changed);
  });
  return Object.fromEntries(Object.entries(opts).map(([k,v]) => [k,[...v].sort()]));
}

// ── RCA ───────────────────────────────────────────────────────
export async function searchByAWB(awb) {
  const snap = await getDocs(query(collection(db, C.LOSS_DATA), where("awb","==",awb.trim())));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
export async function updateRCA(docId, data) {
  await updateDoc(doc(db, C.LOSS_DATA, docId), {
    reason: data.reason || "", reason_l1: data.reason_l1 || "",
    rca_updated_at: serverTimestamp(), rca_updated_by: auth.currentUser?.uid,
  });
  await addDoc(collection(db, C.RCA_UPDATES), {
    ...data, doc_id: docId, updated_at: serverTimestamp(),
    updated_by: auth.currentUser?.uid,
  });
}
export async function bulkUpdateRCA(updates) {
  const b = writeBatch(db);
  updates.forEach(({ docId, data }) =>
    b.update(doc(db, C.LOSS_DATA, docId), {
      reason: data.reason||"", reason_l1: data.reason_l1||"",
      rca_updated_at: serverTimestamp(),
    })
  );
  await b.commit();
}

// ── REATTRIBUTION ─────────────────────────────────────────────
export async function updateAttribution(docId, newAttr, oldAttr) {
  await updateDoc(doc(db, C.LOSS_DATA, docId), {
    attribution_changed: newAttr, attribution_updated_at: serverTimestamp(),
  });
  await addDoc(collection(db, C.REATTRIBUTIONS), {
    doc_id: docId, old_attribution: oldAttr, new_attribution: newAttr,
    changed_at: serverTimestamp(), changed_by: auth.currentUser?.uid,
  });
}

// ── LOGS ──────────────────────────────────────────────────────
export async function getLoginLogs(n=200) {
  const snap = await getDocs(query(collection(db, C.LOGIN_LOGS),
    orderBy("logged_in_at","desc"), limit(n)));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ── ANALYTICS HELPERS ─────────────────────────────────────────
export function aggregateBy(rows, field) {
  const map = {};
  rows.forEach(r => {
    const k = r[field] || "Unknown";
    if (!map[k]) map[k] = { label:k, loss_value:0, shipment_value:0, count:0 };
    map[k].loss_value     += r.loss_value     || 0;
    map[k].shipment_value += r.shipment_value || 0;
    map[k].count++;
  });
  return Object.values(map).sort((a,b) => b.loss_value - a.loss_value);
}
export function computeKPIs(rows) {
  const tl = rows.reduce((s,r) => s+(r.loss_value||0), 0);
  const ts = rows.reduce((s,r) => s+(r.shipment_value||0), 0);
  return {
    total_loss: tl, total_shipment: ts, count: rows.length,
    loss_pct:   ts > 0 ? (tl/ts)*100 : 0,
    locations:  new Set(rows.map(r=>r.location)).size,
    partners:   new Set(rows.map(r=>r.partner)).size,
  };
}
export function computeRankings(rows, field) {
  return aggregateBy(rows, field)
    .sort((a,b) => a.loss_value - b.loss_value)
    .map((item,i) => ({ ...item, rank: i+1 }));
}
export function monthTrend(rows) {
  const map = {};
  rows.forEach(r => {
    if (!r.month) return;
    if (!map[r.month]) map[r.month] = { month:r.month, loss_value:0, count:0 };
    map[r.month].loss_value += r.loss_value || 0;
    map[r.month].count++;
  });
  return Object.values(map).sort((a,b) => a.month.localeCompare(b.month));
}
export function clusterMonthMatrix(rows) {
  const clusters = [...new Set(rows.map(r=>r.cluster_head||"Unknown"))].sort();
  const months   = [...new Set(rows.map(r=>r.month||"Unknown"))].sort();
  const matrix   = {};
  clusters.forEach(c => { matrix[c]={}; months.forEach(m => matrix[c][m]=0); });
  rows.forEach(r => {
    const c = r.cluster_head||"Unknown", m = r.month||"Unknown";
    if (matrix[c] && m in matrix[c]) matrix[c][m] += r.loss_value||0;
  });
  return { clusters, months, matrix };
}
export function fmt(n) {
  if (n >= 1e7) return `₹${(n/1e7).toFixed(2)}Cr`;
  if (n >= 1e5) return `₹${(n/1e5).toFixed(2)}L`;
  return `₹${n.toLocaleString("en-IN",{maximumFractionDigits:0})}`;
}
