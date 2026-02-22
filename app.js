/* =====================================================
   CareAssist v1.1 – app.js
   Features:
     • Add / Edit / Delete medications with separate timings
     • Dynamic time-slot rows (add/remove)
     • All vitals logging with smart alerts
     • Caregiver SMS alerts (no backend)
     • localStorage persistence
     • PWA: service worker + notifications
   ===================================================== */
'use strict';

// ─── CONSTANTS ──────────────────────────────────────
const STORAGE_KEY = 'careassist_v1';

// ─── DEFAULT DATA STRUCTURE ─────────────────────────
function getDefaultData() {
  return {
    profile: {
      patientName: '',
      caregiverName: '',
      caregiverPhone: '',
      waterTarget: 2000,
      bpSystolicThreshold: 160,
      spo2Threshold: 94,
      urineMinDaily: 800,
      tempThreshold: 100.4,
      sugarFastingHigh: 126,
      notifMeds: true,
      notifWater: true,
      notifVitals: true,
      waterReminderInterval: 2,
      onboarded: false
    },
    // Each medication: {id, name, dose, frequency, times:[], startDate, endDate, critical, notes, active, missedCount}
    medications: [],
    // Each log: {id, medId, scheduledTime, takenTime, status:'taken'|'missed', date}
    medicationLogs: [],
    vitals: {
      bp: [],     // {id, systolic, diastolic, pulse, timestamp, status}
      spo2: [],   // {id, value, timestamp, status}
      water: [],  // {id, amount, timestamp}
      weight: [], // {id, value, timestamp}
      urine: [],  // {id, value, timestamp}
      sugar: [],  // {id, value, type, timestamp, status}
      temp: [],   // {id, value, timestamp, status}
    },
    // Each intervention: {id, type, name, date, time, critical, notes, completed}
    interventions: []
  };
}

// ─── STORAGE ────────────────────────────────────────
function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return getDefaultData();
    return JSON.parse(raw);
  } catch { return getDefaultData(); }
}
function saveData(data) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }
  catch { showToast('Storage error — data may not be saved', 'error'); }
}

// ─── GLOBAL STATE ────────────────────────────────────
let APP = loadData();

// ─── UTILITIES ───────────────────────────────────────
function genId()  { return Date.now().toString(36) + Math.random().toString(36).substr(2, 5); }
function todayStr(){ return new Date().toISOString().split('T')[0]; }
function nowTime() { return new Date().toTimeString().substr(0, 5); }

function fmt12(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m).padStart(2,'0')} ${ampm}`;
}
function fmtTs(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('en-IN', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
}
function isTimePast(t) {
  const now = new Date(), d = new Date();
  const [h, m] = t.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d < now;
}
function isTimeWithinHours(t, hrs) {
  const now = new Date(), d = new Date(), future = new Date(now.getTime() + hrs * 3600000);
  const [h, m] = t.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d >= now && d <= future;
}
function minsBetween(t1, t2) {
  const toMin = s => { const [h,m] = s.split(':').map(Number); return h*60+m; };
  return Math.abs(toMin(t1) - toMin(t2));
}
function escHtml(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── TOAST ────────────────────────────────────────────
function showToast(msg, type = 'info', ms = 3200) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + type;
  t.classList.remove('hidden');
  clearTimeout(t._tm);
  t._tm = setTimeout(() => t.classList.add('hidden'), ms);
}

// ─── OVERLAY HELPERS ──────────────────────────────────
function openOverlay(id) {
  const el = document.getElementById(id);
  el.classList.remove('hidden');
  // Pre-fill time inputs with current time if empty
  el.querySelectorAll('input[type="time"]').forEach(i => { if (!i.value) i.value = nowTime(); });
  el.querySelectorAll('input[type="date"]').forEach(i => { if (!i.value) i.value = todayStr(); });
}
function closeOverlay(id) { document.getElementById(id).classList.add('hidden'); }

// ─── SERVICE WORKER ────────────────────────────────────
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./service-worker.js').catch(console.error);
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.action === 'markTaken') renderAll();
  });
}

// ─── NOTIFICATIONS ────────────────────────────────────
function requestNotificationPermission() {
  if (!('Notification' in window)) { showToast('Notifications not supported', 'warning'); return; }
  Notification.requestPermission().then(p => {
    if (p === 'granted') {
      showToast('🔔 Notifications enabled!', 'success');
      document.getElementById('notif-banner').classList.add('hidden');
      new Notification('CareAssist', { body: '✅ Medication reminders are active!', icon: './icons/icon-192.png' });
    } else {
      showToast('Notification permission denied', 'error');
    }
  });
}
function pushNotif(title, body, opts = {}) {
  if (Notification.permission === 'granted') {
    new Notification(title, { body, icon: './icons/icon-192.png', ...opts });
  }
}

// ─── PWA INSTALL ─────────────────────────────────────
let _deferredPrompt = null;
function setupInstall() {
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    _deferredPrompt = e;
    document.getElementById('install-banner').classList.remove('hidden');
  });
  document.getElementById('btn-install').addEventListener('click', () => {
    if (!_deferredPrompt) return;
    _deferredPrompt.prompt();
    _deferredPrompt.userChoice.then(c => {
      if (c.outcome === 'accepted') {
        document.getElementById('install-banner').classList.add('hidden');
        showToast('App installed! 🎉', 'success');
      }
      _deferredPrompt = null;
    });
  });
}

// ─── ONBOARDING ───────────────────────────────────────
function initOnboarding() {
  if (!APP.profile.onboarded) {
    document.getElementById('onboarding-overlay').classList.remove('hidden');
  } else {
    updateHeader();
  }
}
document.getElementById('onboarding-form').addEventListener('submit', e => {
  e.preventDefault();
  APP.profile.patientName         = document.getElementById('patient-name').value.trim();
  APP.profile.caregiverName       = document.getElementById('caregiver-name').value.trim();
  APP.profile.caregiverPhone      = document.getElementById('caregiver-phone').value.trim();
  APP.profile.waterTarget         = +document.getElementById('water-target').value || 2000;
  APP.profile.bpSystolicThreshold = +document.getElementById('bp-systolic-threshold').value || 160;
  APP.profile.spo2Threshold       = +document.getElementById('spo2-threshold').value || 94;
  APP.profile.onboarded           = true;
  saveData(APP);
  document.getElementById('onboarding-overlay').classList.add('hidden');
  updateHeader();
  renderAll();
  showToast('Welcome to CareAssist! 🎉', 'success');
  if ('Notification' in window && Notification.permission === 'default') {
    setTimeout(() => document.getElementById('notif-banner').classList.remove('hidden'), 1800);
  }
});

function updateHeader() {
  document.getElementById('header-patient-name').textContent = APP.profile.patientName || 'Patient';
}

// ─── TABS ─────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
      btn.classList.add('active');
      document.getElementById('tab-' + tab).classList.remove('hidden');
      if (tab === 'medications') renderMedicationsTab();
      if (tab === 'vitals')      renderVitalsTab();
      if (tab === 'history')     renderHistory();
      if (tab === 'settings')    populateSettings();
    });
  });
}
function showSettings() {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'settings'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
  document.getElementById('tab-settings').classList.remove('hidden');
  populateSettings();
}

// ═══════════════════════════════════════════════════════
// DYNAMIC TIME SLOT MANAGEMENT
// ═══════════════════════════════════════════════════════

/**
 * Rebuild the time-slot rows in #med-times-container
 * based on the passed array of time strings.
 * Always shows at least 1 row.
 */
function renderTimeSlots(timesArr) {
  const container = document.getElementById('med-times-container');
  container.innerHTML = '';
  if (!timesArr || timesArr.length === 0) timesArr = [''];

  timesArr.forEach((t, i) => {
    container.appendChild(makeTimeSlotRow(t, i, timesArr.length));
  });
  syncAddTimeButton(timesArr.length);
}

function makeTimeSlotRow(value, index, total) {
  const row = document.createElement('div');
  row.className = 'time-slot-row';
  row.dataset.slotIndex = index;

  const input = document.createElement('input');
  input.type = 'time';
  input.value = value || '';
  input.required = index === 0; // first slot required
  input.dataset.slotIndex = index;

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn-remove-time';
  removeBtn.textContent = '✕';
  removeBtn.title = 'Remove this time';
  removeBtn.style.display = total <= 1 ? 'none' : ''; // hide if only 1 slot
  removeBtn.addEventListener('click', () => removeTimeSlot(index));

  row.appendChild(input);
  row.appendChild(removeBtn);
  return row;
}

function addTimeSlot() {
  const times = collectCurrentTimes();
  if (times.length >= 8) {
    showToast('Maximum 8 reminder times per medication', 'warning');
    return;
  }
  times.push('');
  renderTimeSlots(times);
  // Focus the new input
  const inputs = document.querySelectorAll('#med-times-container input[type="time"]');
  if (inputs.length) inputs[inputs.length - 1].focus();
}

function removeTimeSlot(index) {
  const times = collectCurrentTimes();
  if (times.length <= 1) return; // keep at least 1
  times.splice(index, 1);
  renderTimeSlots(times);
}

function collectCurrentTimes() {
  return Array.from(
    document.querySelectorAll('#med-times-container input[type="time"]')
  ).map(i => i.value);
}

function syncAddTimeButton(count) {
  const btn = document.getElementById('btn-add-time');
  if (btn) btn.style.display = count >= 8 ? 'none' : '';
}

// Sync time slots when frequency dropdown changes
document.getElementById('med-frequency').addEventListener('change', e => {
  const map = { once: 1, twice: 2, thrice: 3, custom: null };
  const n = map[e.target.value];
  if (n !== null) {
    const existing = collectCurrentTimes();
    // Grow or shrink to match n, preserving existing values
    const adjusted = Array.from({ length: n }, (_, i) => existing[i] || '');
    renderTimeSlots(adjusted);
  }
  // 'custom' mode: leave slots as-is, user can add/remove freely
});

// ═══════════════════════════════════════════════════════
// MEDICATION MODAL OPEN / CLOSE / EDIT
// ═══════════════════════════════════════════════════════

/** Open modal in ADD mode */
function openAddMedModal() {
  // Reset form
  document.getElementById('medication-form').reset();
  document.getElementById('med-edit-id').value = '';
  document.getElementById('modal-med-title').textContent = '💊 Add Medication';
  document.getElementById('btn-med-save').textContent = 'Save Medication';
  document.getElementById('med-start').value = todayStr();
  document.getElementById('med-end').value = '';
  // Initialise with one empty time slot at current time
  renderTimeSlots([nowTime()]);
  openOverlay('modal-medication');
}

/** Open modal in EDIT mode, pre-filled with existing medication data */
function openEditMedModal(medId) {
  const med = APP.medications.find(m => m.id === medId);
  if (!med) return;

  document.getElementById('med-edit-id').value = med.id;
  document.getElementById('modal-med-title').textContent = '✏️ Edit Medication';
  document.getElementById('btn-med-save').textContent = 'Update Medication';
  document.getElementById('med-name').value = med.name;
  document.getElementById('med-dose').value = med.dose;
  document.getElementById('med-frequency').value = med.frequency;
  document.getElementById('med-start').value = med.startDate || todayStr();
  document.getElementById('med-end').value = med.endDate || '';
  document.getElementById('med-critical').checked = !!med.critical;
  document.getElementById('med-notes').value = med.notes || '';

  // Render the existing times for this medication
  renderTimeSlots(med.times && med.times.length ? med.times : [nowTime()]);

  document.getElementById('modal-medication').classList.remove('hidden');
}

function closeMedModal() {
  closeOverlay('modal-medication');
  document.getElementById('medication-form').reset();
  document.getElementById('med-edit-id').value = '';
}

// Intervention custom name show/hide
document.getElementById('int-type').addEventListener('change', e => {
  document.getElementById('int-custom-group').style.display = e.target.value === 'custom' ? 'block' : 'none';
});

// ═══════════════════════════════════════════════════════
// MEDICATION FORM SUBMIT (handles both ADD and EDIT)
// ═══════════════════════════════════════════════════════
document.getElementById('medication-form').addEventListener('submit', e => {
  e.preventDefault();

  // Collect and validate times
  const times = collectCurrentTimes().filter(t => t.trim() !== '');
  if (times.length === 0) {
    showToast('Please set at least one reminder time', 'error');
    return;
  }

  const editId = document.getElementById('med-edit-id').value;
  const isEdit = !!editId;

  const medData = {
    name:      document.getElementById('med-name').value.trim(),
    dose:      document.getElementById('med-dose').value.trim(),
    frequency: document.getElementById('med-frequency').value,
    times:     times,
    startDate: document.getElementById('med-start').value || todayStr(),
    endDate:   document.getElementById('med-end').value || '',
    critical:  document.getElementById('med-critical').checked,
    notes:     document.getElementById('med-notes').value.trim(),
    active:    true
  };

  if (isEdit) {
    // Update existing medication in place
    const idx = APP.medications.findIndex(m => m.id === editId);
    if (idx !== -1) {
      APP.medications[idx] = { ...APP.medications[idx], ...medData };
      showToast(`✅ ${medData.name} updated!`, 'success');
    }
  } else {
    // New medication
    APP.medications.push({ id: genId(), missedCount: 0, ...medData });
    showToast(`✅ ${medData.name} added!`, 'success');
  }

  saveData(APP);
  closeMedModal();
  renderAll();
  scheduleMedReminders();
});

// ═══════════════════════════════════════════════════════
// VITALS FORM SUBMITS
// ═══════════════════════════════════════════════════════

document.getElementById('bp-form').addEventListener('submit', e => {
  e.preventDefault();
  const sys = +document.getElementById('bp-systolic').value;
  const dia = +document.getElementById('bp-diastolic').value;
  const pulse = document.getElementById('bp-pulse').value;
  const isCrit = sys >= 180 || sys < 80;
  const isWarn = sys >= APP.profile.bpSystolicThreshold || dia >= 100 || sys < 90;
  const status = isCrit ? 'critical' : isWarn ? 'warning' : 'normal';

  APP.vitals.bp.push({ id: genId(), systolic: sys, diastolic: dia, pulse: pulse || null, timestamp: Date.now(), status });
  saveData(APP);
  closeOverlay('modal-bp');
  document.getElementById('bp-form').reset();

  if (status === 'critical') {
    showHighRisk(`⚠️ CRITICAL BP: ${sys}/${dia} mmHg — Immediate attention needed!`);
    notifyCaregiver(`CRITICAL BP: ${sys}/${dia} mmHg at ${new Date().toLocaleTimeString()}`);
  } else if (status === 'warning') {
    showToast(`⚠️ BP ${sys}/${dia} mmHg — Above threshold`, 'warning', 5000);
  } else {
    showToast(`✅ BP logged: ${sys}/${dia} mmHg`, 'success');
  }
  renderAll();
});

document.getElementById('spo2-form').addEventListener('submit', e => {
  e.preventDefault();
  const val = +document.getElementById('spo2-value').value;
  const isCrit = val < APP.profile.spo2Threshold - 4;
  const status = isCrit ? 'critical' : val < APP.profile.spo2Threshold ? 'warning' : 'normal';

  APP.vitals.spo2.push({ id: genId(), value: val, timestamp: Date.now(), status });
  saveData(APP);
  closeOverlay('modal-spo2');
  document.getElementById('spo2-form').reset();

  if (status === 'critical') {
    showHighRisk(`⚠️ CRITICAL SpO₂: ${val}% — Oxygen level dangerously low!`);
    notifyCaregiver(`CRITICAL SpO₂: ${val}% at ${new Date().toLocaleTimeString()}`);
  } else if (status === 'warning') {
    showToast(`⚠️ SpO₂ ${val}% — Below threshold`, 'warning', 5000);
  } else {
    showToast(`✅ SpO₂ logged: ${val}%`, 'success');
  }
  renderAll();
});

document.getElementById('water-form').addEventListener('submit', e => {
  e.preventDefault();
  const amount = +document.getElementById('water-amount').value;
  APP.vitals.water.push({ id: genId(), amount, timestamp: Date.now() });
  saveData(APP);
  closeOverlay('modal-water');
  document.getElementById('water-form').reset();
  const remaining = APP.profile.waterTarget - getTodayWater();
  showToast(remaining <= 0 ? `🎉 Daily water target achieved!` : `💧 ${amount}ml logged. ${remaining}ml left`, 'success');
  renderAll();
});

function setWaterAmount(n) { document.getElementById('water-amount').value = n; }

document.getElementById('weight-form').addEventListener('submit', e => {
  e.preventDefault();
  const val = parseFloat(document.getElementById('weight-value').value);
  const prev = APP.vitals.weight.slice(-1)[0];
  if (prev) {
    const chg = Math.abs((val - prev.value) / prev.value * 100);
    if (chg >= 5) showToast(`⚠️ Significant weight change: ${prev.value}→${val}kg`, 'warning', 5000);
  }
  APP.vitals.weight.push({ id: genId(), value: val, timestamp: Date.now() });
  saveData(APP);
  closeOverlay('modal-weight');
  document.getElementById('weight-form').reset();
  showToast(`✅ Weight logged: ${val} kg`, 'success');
  renderAll();
});

document.getElementById('urine-form').addEventListener('submit', e => {
  e.preventDefault();
  const val = +document.getElementById('urine-value').value;
  APP.vitals.urine.push({ id: genId(), value: val, timestamp: Date.now() });
  saveData(APP);
  closeOverlay('modal-urine');
  document.getElementById('urine-form').reset();
  const total = getTodayUrine();
  if (total < APP.profile.urineMinDaily * 0.5 && new Date().getHours() >= 18) {
    notifyCaregiver(`Low Urine Output: only ${total}ml today`);
  }
  showToast(`✅ Urine logged: ${val}ml. Today total: ${total}ml`, 'success');
  renderAll();
});

document.getElementById('sugar-form').addEventListener('submit', e => {
  e.preventDefault();
  const val = +document.getElementById('sugar-value').value;
  const type = document.getElementById('sugar-type').value;
  let status = 'normal';
  if (val >= 300 || val < 70) status = 'critical';
  else if ((type === 'fasting' && val >= APP.profile.sugarFastingHigh) || (type === 'postprandial' && val >= 200)) status = 'warning';

  APP.vitals.sugar.push({ id: genId(), value: val, type, timestamp: Date.now(), status });
  saveData(APP);
  closeOverlay('modal-sugar');
  document.getElementById('sugar-form').reset();
  showToast(status === 'critical' ? `🚨 Critical blood sugar: ${val} mg/dL!` : status === 'warning' ? `⚠️ Blood sugar elevated: ${val} mg/dL` : `✅ Blood sugar: ${val} mg/dL`, status === 'critical' ? 'error' : status === 'warning' ? 'warning' : 'success', 5000);
  renderAll();
});

document.getElementById('temp-form').addEventListener('submit', e => {
  e.preventDefault();
  const val = parseFloat(document.getElementById('temp-value').value);
  const status = val >= APP.profile.tempThreshold ? (val >= 103 ? 'critical' : 'warning') : 'normal';
  APP.vitals.temp.push({ id: genId(), value: val, timestamp: Date.now(), status });
  saveData(APP);
  closeOverlay('modal-temp');
  document.getElementById('temp-form').reset();
  showToast(status === 'critical' ? `🚨 High fever: ${val}°F!` : status === 'warning' ? `⚠️ Fever: ${val}°F` : `✅ Temp: ${val}°F`, status === 'normal' ? 'success' : status, 5000);
  renderAll();
});

document.getElementById('intervention-form').addEventListener('submit', e => {
  e.preventDefault();
  const type = document.getElementById('int-type').value;
  const NAMES = { physio:'Physiotherapy / Exercise', injection:'Injection', dressing:'Dressing Change',
    bp_check:'BP Check', spo2_check:'SpO₂ Check', weight_check:'Weight Check',
    appointment:'Follow-up Appointment', custom: document.getElementById('int-custom-name').value.trim() || 'Custom' };
  APP.interventions.push({
    id: genId(), type, name: NAMES[type],
    date: document.getElementById('int-date').value,
    time: document.getElementById('int-time').value,
    critical: document.getElementById('int-critical').checked,
    notes: document.getElementById('int-notes').value.trim(),
    completed: false
  });
  saveData(APP);
  closeOverlay('modal-intervention');
  document.getElementById('intervention-form').reset();
  showToast('✅ Intervention scheduled!', 'success');
  renderAll();
});

// ═══════════════════════════════════════════════════════
// CAREGIVER & ALERTS
// ═══════════════════════════════════════════════════════
function notifyCaregiver(msg) {
  const phone = APP.profile.caregiverPhone;
  if (!phone) { showToast('No caregiver phone set — go to Settings', 'warning', 5000); return; }
  const patient = APP.profile.patientName || 'Patient';
  const text = encodeURIComponent(`[CareAssist Alert] ${patient}: ${msg}. Please check immediately.`);
  window.open(`sms:${phone}?body=${text}`, '_blank');
}

document.getElementById('btn-notify-caregiver-alert').addEventListener('click', () => {
  notifyCaregiver(document.getElementById('high-risk-message').textContent);
});

function showHighRisk(msg) {
  document.getElementById('high-risk-message').textContent = msg;
  document.getElementById('high-risk-overlay').classList.remove('hidden');
  pushNotif('🚨 HIGH RISK ALERT', msg, { requireInteraction: true });
}

// ═══════════════════════════════════════════════════════
// MEDICATION ACTIONS
// ═══════════════════════════════════════════════════════
function markTaken(medId, scheduledTime) {
  const takenTime = nowTime();
  APP.medicationLogs.push({ id: genId(), medId, scheduledTime, takenTime, status: 'taken', date: todayStr() });
  const delay = minsBetween(scheduledTime, takenTime);
  if (delay > 20) showToast(`Taken ${delay} min late — consider adjusting reminder time`, 'warning', 5000);
  else showToast('✅ Medication marked as taken!', 'success');
  saveData(APP);
  renderAll();
}

function markMissed(medId, scheduledTime) {
  APP.medicationLogs.push({ id: genId(), medId, scheduledTime, takenTime: null, status: 'missed', date: todayStr() });
  const med = APP.medications.find(m => m.id === medId);
  if (med && med.critical) {
    const critMissedToday = APP.medicationLogs.filter(l =>
      l.date === todayStr() && l.status === 'missed' &&
      APP.medications.find(m2 => m2.id === l.medId && m2.critical)
    ).length;
    if (critMissedToday >= 2) {
      showHighRisk(`Critical medication "${med.name}" missed ${critMissedToday} times today!`);
      notifyCaregiver(`URGENT: ${med.name} (critical) missed ${critMissedToday} times today`);
    }
  }
  saveData(APP);
  showToast('⚠️ Dose marked as missed', 'warning');
  renderAll();
}

function deleteMedication(medId) {
  if (!confirm('Remove this medication from the list?')) return;
  APP.medications = APP.medications.filter(m => m.id !== medId);
  saveData(APP);
  showToast('Medication removed', 'info');
  renderAll();
}

function completeIntervention(id) {
  const int = APP.interventions.find(i => i.id === id);
  if (int) { int.completed = true; saveData(APP); showToast('✅ Intervention complete!', 'success'); renderAll(); }
}
function deleteIntervention(id) {
  if (!confirm('Remove this intervention?')) return;
  APP.interventions = APP.interventions.filter(i => i.id !== id);
  saveData(APP);
  renderAll();
}

// ═══════════════════════════════════════════════════════
// DATA HELPERS
// ═══════════════════════════════════════════════════════
function getTodayWater() {
  const today = todayStr();
  return APP.vitals.water.filter(w => new Date(w.timestamp).toISOString().split('T')[0] === today)
    .reduce((s, w) => s + w.amount, 0);
}
function getTodayUrine() {
  const today = todayStr();
  return APP.vitals.urine.filter(u => new Date(u.timestamp).toISOString().split('T')[0] === today)
    .reduce((s, u) => s + u.value, 0);
}

function getScheduledDosesToday() {
  const today = todayStr();
  const doses = [];
  APP.medications.forEach(med => {
    if (!med.active) return;
    if (med.endDate && med.endDate < today) return;
    if (med.startDate > today) return;
    (med.times || []).forEach(time => {
      const log = APP.medicationLogs.find(l => l.medId === med.id && l.scheduledTime === time && l.date === today);
      const status = log ? log.status : (isTimePast(time) ? 'missed' : 'pending');
      doses.push({ med, scheduledTime: time, log: log || null, status });
    });
  });
  return doses.sort((a, b) => a.scheduledTime.localeCompare(b.scheduledTime));
}

function calcAdherence(days = 1) {
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - days);
  const logs = APP.medicationLogs.filter(l => new Date(l.date) >= cutoff);
  if (!logs.length) return null;
  return Math.round(logs.filter(l => l.status === 'taken').length / logs.length * 100);
}

function calcStreak() {
  let streak = 0, d = new Date();
  for (let i = 0; i < 30; i++) {
    const ds = d.toISOString().split('T')[0];
    const dayLogs = APP.medicationLogs.filter(l => l.date === ds);
    if (!dayLogs.length) { if (i === 0) { d.setDate(d.getDate()-1); continue; } break; }
    if (dayLogs.every(l => l.status === 'taken')) streak++;
    else break;
    d.setDate(d.getDate()-1);
  }
  return streak;
}

function getDayCareStatus() {
  const doses = getScheduledDosesToday();
  const critMissed = doses.filter(d => d.status === 'missed' && d.med.critical).length;
  const anyMissed  = doses.filter(d => d.status === 'missed').length;
  const lastBP   = APP.vitals.bp.slice(-1)[0];
  const lastSpo2 = APP.vitals.spo2.slice(-1)[0];
  if (critMissed >= 2 || lastBP?.status === 'critical' || lastSpo2?.status === 'critical') return 'critical';
  if (anyMissed  || lastBP?.status === 'warning'  || lastSpo2?.status === 'warning')  return 'attention';
  return 'stable';
}

// ═══════════════════════════════════════════════════════
// RENDERING
// ═══════════════════════════════════════════════════════

function renderMedCard(dose, showActions) {
  const { med, scheduledTime, status } = dose;
  const icon = med.critical ? '🔴' : '💊';
  const statusCls = status === 'taken' ? 'taken' : status === 'missed' ? 'missed' : '';
  const critCls   = med.critical ? 'critical' : '';

  let badges = '';
  if (med.critical) badges += '<span class="badge badge-critical">CRITICAL</span>';
  badges += status === 'taken' ? '<span class="badge badge-taken">✅ Taken</span>'
          : status === 'missed' ? '<span class="badge badge-missed">⚠️ Missed</span>'
          : '<span class="badge badge-pending">⏰ Pending</span>';

  let actions = '';
  if (status === 'pending' && showActions) {
    actions = `<button class="btn-take" onclick="markTaken('${med.id}','${scheduledTime}')">✅ Taken</button>
               <button class="btn-skip" onclick="markMissed('${med.id}','${scheduledTime}')">Skip</button>`;
  } else if (status === 'missed') {
    actions = `<button class="btn-take" onclick="markTaken('${med.id}','${scheduledTime}')">✅ Mark Taken</button>`;
  }

  return `<div class="med-card ${critCls} ${statusCls}">
    <div class="med-icon">${icon}</div>
    <div class="med-info">
      <div class="med-name">${escHtml(med.name)}</div>
      <div class="med-dose">${escHtml(med.dose)}${med.notes ? ' · ' + escHtml(med.notes) : ''}</div>
      <div class="med-time">${fmt12(scheduledTime)}</div>
      <div class="med-badges">${badges}</div>
    </div>
    <div class="med-actions">${actions}</div>
  </div>`;
}

function renderIntCard(int) {
  const icons = { physio:'🏃', injection:'💉', dressing:'🩹', bp_check:'❤️',
    spo2_check:'🫁', weight_check:'⚖️', appointment:'📅', custom:'📋' };
  return `<div class="int-card ${int.critical?'critical':''} ${int.completed?'completed':''}">
    <div class="med-icon">${icons[int.type]||'📋'}</div>
    <div class="int-info">
      <div class="int-name">${escHtml(int.name)} ${int.critical?'<span class="badge badge-critical">CRITICAL</span>':''}</div>
      <div class="int-time">${int.date} · ${fmt12(int.time)}</div>
      ${int.notes ? `<div class="int-notes">${escHtml(int.notes)}</div>` : ''}
    </div>
    <div class="int-actions">
      ${!int.completed
        ? `<button class="btn-take" onclick="completeIntervention('${int.id}')">✅ Done</button>`
        : '<span class="badge badge-taken">Done</span>'}
      <button class="btn-delete" onclick="deleteIntervention('${int.id}')">🗑️</button>
    </div>
  </div>`;
}

function renderDashboard() {
  const doses = getScheduledDosesToday();
  const taken   = doses.filter(d => d.status === 'taken').length;
  const missed  = doses.filter(d => d.status === 'missed').length;
  const pending = doses.filter(d => d.status === 'pending').length;
  const total   = doses.length;
  const pct     = total > 0 ? Math.round(taken / total * 100) : null;

  document.getElementById('stat-adherence').textContent = pct !== null ? pct + '%' : '--';
  document.getElementById('stat-taken').textContent   = taken;
  document.getElementById('stat-missed').textContent  = missed;
  document.getElementById('stat-pending').textContent = pending;

  const status = getDayCareStatus();
  const badge  = document.getElementById('status-badge');
  const sv     = document.getElementById('summary-status-text');
  const si     = document.getElementById('summary-icon');
  const MAP = { stable:{text:'Stable',icon:'✅'}, attention:{text:'Attention Needed',icon:'⚠️'}, critical:{text:'Critical',icon:'🚨'} };
  badge.textContent = '● ' + MAP[status].text;
  badge.className   = 'status-badge' + (status !== 'stable' ? ' ' + status : '');
  sv.textContent    = MAP[status].text;
  sv.className      = 'summary-value' + (status !== 'stable' ? ' ' + status : '');
  si.textContent    = MAP[status].icon;

  // Water
  const wTotal = getTodayWater();
  const wPct   = Math.min((wTotal / APP.profile.waterTarget) * 100, 100);
  document.getElementById('water-fill').style.width = wPct + '%';
  document.getElementById('water-consumed').textContent = wTotal + ' ml';
  document.getElementById('water-target-display').textContent = APP.profile.waterTarget;

  // Today medications
  const ml = document.getElementById('today-medications-list');
  ml.innerHTML = doses.length
    ? doses.map(d => renderMedCard(d, true)).join('')
    : '<div class="empty-state">No medications scheduled today.<br>Tap <b>+ Add</b> to add one.</div>';

  // Upcoming
  const ul = document.getElementById('upcoming-reminders-list');
  const up = doses.filter(d => d.status === 'pending' && isTimeWithinHours(d.scheduledTime, 6));
  ul.innerHTML = up.length ? up.map(d => renderMedCard(d, false)).join('') : '<div class="empty-state">No upcoming reminders in next 6 hours.</div>';

  // Missed
  const misl = document.getElementById('missed-alerts-list');
  const mis  = doses.filter(d => d.status === 'missed');
  misl.innerHTML = mis.length ? mis.map(d => renderMedCard(d, false)).join('') : '<div class="empty-state">No missed alerts. 🎉</div>';

  // Today interventions
  const ti = APP.interventions.filter(i => i.date === todayStr() && !i.completed);
  const til = document.getElementById('today-interventions-list');
  til.innerHTML = ti.length ? ti.map(i => renderIntCard(i)).join('') : '<div class="empty-state">No interventions today.</div>';
}

function renderMedicationsTab() {
  document.getElementById('adh-today').textContent  = calcAdherence(1) !== null ? calcAdherence(1) + '%' : '--';
  document.getElementById('adh-week').textContent   = calcAdherence(7) !== null ? calcAdherence(7) + '%' : '--';
  document.getElementById('adh-streak').textContent = calcStreak();

  const list = document.getElementById('medications-list');
  if (!APP.medications.length) {
    list.innerHTML = '<div class="empty-state">No medications added yet.<br>Tap <b>+ Add</b> above.</div>';
    return;
  }

  list.innerHTML = APP.medications.map(med => {
    const timesLabel = (med.times || []).map(fmt12).join('  ·  ');
    return `<div class="med-card ${med.critical ? 'critical' : ''}">
      <div class="med-icon">${med.critical ? '🔴' : '💊'}</div>
      <div class="med-info">
        <div class="med-name">${escHtml(med.name)}</div>
        <div class="med-dose">${escHtml(med.dose)}</div>
        <div class="med-time">${timesLabel}</div>
        <div class="med-badges">
          ${med.critical ? '<span class="badge badge-critical">CRITICAL</span>' : ''}
          <span class="badge badge-pending">${med.frequency}</span>
          ${med.endDate ? `<span class="badge" style="background:rgba(255,255,255,.05);color:var(--text-secondary);border:1px solid var(--border)">Until ${med.endDate}</span>` : ''}
        </div>
        ${med.notes ? `<div class="med-dose" style="margin-top:4px">📝 ${escHtml(med.notes)}</div>` : ''}
        <div class="med-badges" style="margin-top:6px">
          <span class="badge" style="background:rgba(26,115,232,.1);color:var(--text-secondary);border:1px solid var(--border)">
            ${(med.times||[]).length} reminder${(med.times||[]).length !== 1 ? 's' : ''}/day
          </span>
        </div>
      </div>
      <div class="med-actions">
        <button class="btn-edit"   onclick="openEditMedModal('${med.id}')">✏️ Edit</button>
        <button class="btn-delete" onclick="deleteMedication('${med.id}')">🗑️</button>
      </div>
    </div>`;
  }).join('');

  // Adherence banner
  const adh7 = calcAdherence(7);
  if (adh7 !== null && adh7 > 80) {
    list.insertAdjacentHTML('afterbegin',
      `<div style="background:rgba(0,200,83,.1);border:1px solid rgba(0,200,83,.3);border-radius:10px;padding:12px;margin-bottom:10px;text-align:center;color:var(--accent-green);font-weight:700;">
        🌟 Excellent adherence! ${adh7}% this week. Keep it up!
      </div>`);
  }
}

function renderVitalsTab() {
  const setVital = (id, card, val, time, status) => {
    document.getElementById(id).textContent   = val;
    document.getElementById(time).textContent = status ? fmtTs(status.timestamp) : 'No data';
    document.getElementById(card).className   = 'vital-card' + (status && status.status && status.status !== 'normal' ? ' ' + status.status : '');
  };

  const bp = APP.vitals.bp.slice(-1)[0];
  if (bp) setVital('latest-bp', 'vc-bp', `${bp.systolic}/${bp.diastolic}`, 'latest-bp-time', bp);

  const spo2 = APP.vitals.spo2.slice(-1)[0];
  if (spo2) setVital('latest-spo2', 'vc-spo2', `${spo2.value}%`, 'latest-spo2-time', spo2);

  const wt = APP.vitals.weight.slice(-1)[0];
  if (wt) { document.getElementById('latest-weight').textContent = `${wt.value} kg`; document.getElementById('latest-weight-time').textContent = fmtTs(wt.timestamp); }

  const sg = APP.vitals.sugar.slice(-1)[0];
  if (sg) setVital('latest-sugar', 'vc-sugar', `${sg.value} mg/dL`, 'latest-sugar-time', sg);

  const tp = APP.vitals.temp.slice(-1)[0];
  if (tp) setVital('latest-temp', 'vc-temp', `${tp.value}°F`, 'latest-temp-time', tp);

  const urineToday = getTodayUrine();
  document.getElementById('today-urine').textContent = `${urineToday} ml`;
  document.getElementById('today-urine-min').textContent = `Min: ${APP.profile.urineMinDaily} ml`;
  document.getElementById('vc-urine').className = 'vital-card' + (urineToday > 0 && urineToday < APP.profile.urineMinDaily ? ' warning' : '');

  const pending = APP.interventions.filter(i => !i.completed);
  document.getElementById('interventions-list').innerHTML = pending.length
    ? pending.sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time)).map(i => renderIntCard(i)).join('')
    : '<div class="empty-state">No pending interventions.</div>';
}

function renderHistory() {
  const filter = document.getElementById('history-filter').value;
  let entries = [];
  const add = (type, icon, label, value, ts, status) => entries.push({type, icon, label, value, ts, status});

  if (filter === 'all' || filter === 'bp')     APP.vitals.bp.forEach(r => add('bp','❤️','Blood Pressure',`${r.systolic}/${r.diastolic} mmHg`,r.timestamp,r.status));
  if (filter === 'all' || filter === 'spo2')   APP.vitals.spo2.forEach(r => add('spo2','🫁','SpO₂',`${r.value}%`,r.timestamp,r.status));
  if (filter === 'all' || filter === 'water')  APP.vitals.water.forEach(r => add('water','💧','Water Intake',`${r.amount} ml`,r.timestamp,'normal'));
  if (filter === 'all' || filter === 'weight') APP.vitals.weight.forEach(r => add('weight','⚖️','Weight',`${r.value} kg`,r.timestamp,'normal'));
  if (filter === 'all' || filter === 'urine')  APP.vitals.urine.forEach(r => add('urine','🚽','Urine Output',`${r.value} ml`,r.timestamp,'normal'));
  if (filter === 'all' || filter === 'sugar')  APP.vitals.sugar.forEach(r => add('sugar','🩸','Blood Sugar',`${r.value} mg/dL (${r.type})`,r.timestamp,r.status));
  if (filter === 'all' || filter === 'temp')   APP.vitals.temp.forEach(r => add('temp','🌡️','Temperature',`${r.value}°F`,r.timestamp,r.status));
  if (filter === 'all' || filter === 'medication') {
    APP.medicationLogs.forEach(l => {
      const med = APP.medications.find(m => m.id === l.medId);
      if (!med) return;
      add('medication', l.status === 'taken' ? '✅' : '⚠️', med.name,
        l.status.toUpperCase() + (l.takenTime ? ` at ${fmt12(l.takenTime)}` : ''),
        new Date(l.date + 'T' + (l.takenTime || l.scheduledTime)).getTime(),
        l.status === 'taken' ? 'normal' : 'warning');
    });
  }

  entries.sort((a,b) => b.ts - a.ts);
  const list = document.getElementById('history-list');
  list.innerHTML = entries.length
    ? entries.map(e => `<div class="history-item ${e.status}">
        <div class="hist-icon">${e.icon}</div>
        <div class="hist-info"><div class="hist-type">${escHtml(e.label)}</div><div class="hist-value">${escHtml(e.value)}</div></div>
        <div class="hist-time">${fmtTs(e.ts)}</div>
      </div>`).join('')
    : '<div class="empty-state">No history recorded yet.</div>';
}

function populateSettings() {
  const p = APP.profile;
  document.getElementById('set-patient-name').value       = p.patientName || '';
  document.getElementById('set-caregiver-name').value     = p.caregiverName || '';
  document.getElementById('set-caregiver-phone').value    = p.caregiverPhone || '';
  document.getElementById('set-water-target').value       = p.waterTarget || 2000;
  document.getElementById('set-bp-systolic').value        = p.bpSystolicThreshold || 160;
  document.getElementById('set-spo2-threshold').value     = p.spo2Threshold || 94;
  document.getElementById('set-urine-min').value          = p.urineMinDaily || 800;
  document.getElementById('set-temp-threshold').value     = p.tempThreshold || 100.4;
  document.getElementById('set-sugar-fasting-high').value = p.sugarFastingHigh || 126;
  document.getElementById('set-water-interval').value     = p.waterReminderInterval || 2;
  document.getElementById('set-notif-meds').checked       = p.notifMeds !== false;
  document.getElementById('set-notif-water').checked      = p.notifWater !== false;
  document.getElementById('set-notif-vitals').checked     = p.notifVitals !== false;
}

function saveSettings() {
  const g = id => document.getElementById(id);
  Object.assign(APP.profile, {
    patientName:         g('set-patient-name').value.trim(),
    caregiverName:       g('set-caregiver-name').value.trim(),
    caregiverPhone:      g('set-caregiver-phone').value.trim(),
    waterTarget:         +g('set-water-target').value || 2000,
    bpSystolicThreshold: +g('set-bp-systolic').value || 160,
    spo2Threshold:       +g('set-spo2-threshold').value || 94,
    urineMinDaily:       +g('set-urine-min').value || 800,
    tempThreshold:       +g('set-temp-threshold').value || 100.4,
    sugarFastingHigh:    +g('set-sugar-fasting-high').value || 126,
    waterReminderInterval: +g('set-water-interval').value || 2,
    notifMeds:   g('set-notif-meds').checked,
    notifWater:  g('set-notif-water').checked,
    notifVitals: g('set-notif-vitals').checked,
  });
  saveData(APP);
  updateHeader();
  showToast('✅ Settings saved!', 'success');
  renderAll();
}

function exportData() {
  const blob = new Blob([JSON.stringify(APP, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `careassist-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('Data exported!', 'success');
}

function clearAllData() {
  if (!confirm('⚠️ DELETE ALL DATA? This cannot be undone.')) return;
  if (!confirm('Final confirmation — clear everything?')) return;
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
}

function renderAll() {
  renderDashboard();
  updateHeader();
}

// ═══════════════════════════════════════════════════════
// REMINDER ENGINE — checks every 60 seconds
// ═══════════════════════════════════════════════════════
let _reminderInterval = null;

function scheduleMedReminders() {
  if (_reminderInterval) clearInterval(_reminderInterval);
  _reminderInterval = setInterval(checkReminders, 60000);
  checkReminders();
}

function checkReminders() {
  if (!APP.profile.notifMeds) return;
  const currentTime = new Date().toTimeString().substr(0, 5);
  const today = todayStr();

  APP.medications.forEach(med => {
    if (!med.active || (med.endDate && med.endDate < today) || med.startDate > today) return;
    (med.times || []).forEach(time => {
      if (currentTime === time) {
        const logged = APP.medicationLogs.find(l => l.medId === med.id && l.scheduledTime === time && l.date === today);
        if (!logged) pushNotif('💊 Medication Reminder',
          `Time to take ${med.name} (${med.dose})${med.critical ? ' — CRITICAL!' : ''}`,
          { requireInteraction: med.critical });
      }
      // 15-min follow-up: check if time is 15 min past and not taken
      const [h, m] = time.split(':').map(Number);
      const followupMins = h * 60 + m + 15;
      const nowMins = +currentTime.split(':')[0] * 60 + +currentTime.split(':')[1];
      if (nowMins === followupMins) {
        const taken = APP.medicationLogs.find(l => l.medId === med.id && l.scheduledTime === time && l.date === today && l.status === 'taken');
        if (!taken) pushNotif('⚠️ Missed Dose Reminder',
          `${med.name} was due 15 minutes ago and hasn't been logged.${med.critical ? ' CRITICAL!' : ''}`,
          { requireInteraction: true });
      }
    });
  });

  // Water reminder
  if (APP.profile.notifWater) {
    const now = new Date();
    const h = now.getHours(), m = now.getMinutes(), intv = APP.profile.waterReminderInterval || 2;
    if (m === 0 && h % intv === 0 && h >= 7 && h <= 21) {
      const remaining = APP.profile.waterTarget - getTodayWater();
      if (remaining > 0) pushNotif('💧 Hydration Reminder', `${remaining}ml more water needed today.`);
    }
  }
}

// ═══════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════
function init() {
  registerSW();
  setupInstall();
  initTabs();
  initOnboarding();
  // Initialise time slots in medication modal with one slot
  renderTimeSlots([nowTime()]);
  renderAll();
  scheduleMedReminders();

  if ('Notification' in window && Notification.permission === 'default' && APP.profile.onboarded) {
    setTimeout(() => document.getElementById('notif-banner').classList.remove('hidden'), 1000);
  }
}

document.addEventListener('DOMContentLoaded', init);
