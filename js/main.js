(function(){

  /* ============================================================
     LIFF CONFIG
  ============================================================ */
  const LIFF_ID = "2009941241-ymtu2MdM";
  const isLiffEnabled = true;

  /* ============================================================
     CONSTANTS
  ============================================================ */
  const MAX_ADMINS = 5;
  const MAX_STUDENTS = 4;
  const BOOTSTRAP_ADMIN_ID = 'Ub1cc54fbbecfcea070a29ce8762fb05b';

  /* ============================================================
     STORAGE LAYER
  ============================================================ */
  /* v2 — bumped after stripping virtual demo seed data and adding attendance.
     This invalidates any old demo cache on existing devices, forcing a clean slate.

     Firebase migration plan: replace these helpers with Firestore reads/writes.
     - users:    collection('users') keyed by LINE userId
     - courts:   collection('courts').doc(YYYY-MM-DD) per day
     - schedule: implicit in courts doc id (date)
     - attendance: collection('attendance') with composite key uid_date_court_time
     Real-time admin notification: onSnapshot(collection('users').where('status','==','pending')). */
  const STORAGE_KEYS = {
    USERS:      'cb.users.v2',
    COURTS:     'cb.courts.v2',
    SCHEDULE:   'cb.scheduleDate.v2',
    ATTENDANCE: 'cb.attendance.v1'
  };

  function safeGet(key){
    try { return localStorage.getItem(key); } catch(_){ return null; }
  }
  function safeSet(key, value){
    try { localStorage.setItem(key, value); } catch(_){}
  }
  function saveUsers(){
    try { safeSet(STORAGE_KEYS.USERS, JSON.stringify(USERS)); } catch(_){}
  }
  function saveCourts(){
    try { safeSet(STORAGE_KEYS.COURTS, JSON.stringify(courts)); } catch(_){}
  }
  function saveScheduleDate(d){
    safeSet(STORAGE_KEYS.SCHEDULE, d);
  }

  /* ATTENDANCE — keyed by "uid|YYYY-MM-DD|court|time", set semantics so each
     booking is counted at most once. Only ended slots get recorded.
     Firebase migration: replace with collection('attendance') with the
     same composite key as the document id. */
  const attendanceRecords = new Set();
  /* Parallel map: attendance key → bookedByUid (only set when proxy-booked).
     Doesn't change Set semantics — counts still keyed by player uid. */
  const attendanceBookers = {};
  function saveAttendance(){
    try { safeSet(STORAGE_KEYS.ATTENDANCE, JSON.stringify([...attendanceRecords])); } catch(_){}
    try { safeSet(STORAGE_KEYS.ATTENDANCE + '.b', JSON.stringify(attendanceBookers)); } catch(_){}
  }
  function loadAttendance(){
    const raw = safeGet(STORAGE_KEYS.ATTENDANCE);
    if (raw){
      try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) arr.forEach(k => attendanceRecords.add(k));
      } catch(_){}
    }
    const rawB = safeGet(STORAGE_KEYS.ATTENDANCE + '.b');
    if (rawB){
      try {
        const obj = JSON.parse(rawB);
        if (obj && typeof obj === 'object'){
          Object.keys(obj).forEach(k => { attendanceBookers[k] = obj[k]; });
        }
      } catch(_){}
    }
  }
  function attKey(uid, date, court, time){
    return uid + '|' + date + '|' + court + '|' + time;
  }
  function recordAttendanceOnce(uid, date, court, time, bookedByUid){
    if (!uid) return false;
    const key = attKey(uid, date, court, time);
    if (attendanceRecords.has(key)) return false;
    attendanceRecords.add(key);
    /* Stamp booker if this was a proxy booking. Counts always go to uid (player). */
    if (bookedByUid && bookedByUid !== uid){
      attendanceBookers[key] = bookedByUid;
    }
    if (USERS[uid]){
      USERS[uid].playCount = (USERS[uid].playCount || 0) + 1;
    }
    return true;
  }

  function persist(){
    /* localStorage = fast device cache. */
    saveUsers();
    saveCourts();
    saveAttendance();
    /* Firestore syncs are gated + diff-checked separately:
       - users: per-doc, called explicitly at user mutation points
       - courts/attendance: see saveCourtsToFirestoreIfChanged /
         saveAttendanceToFirestoreIfChanged below. We DO NOT write them
         from persist() because persist() is called from many places
         (including initFromStorage and onSnapshot callbacks) where a
         stale-local-overwrites-remote race would corrupt cloud state. */
    saveCourtsToFirestoreIfChanged();
    saveAttendanceToFirestoreIfChanged();
  }

  /* ============================================================
     COURTS FIRESTORE WRITE — race-safe, observable.
     Three gates:
       (1) db must be initialised
       (2) onSnapshot must have fired at least once (we know cloud state)
       (3) local payload must differ from both last-write and last-remote
     This eliminates the boot-time stale-overwrite race where two devices
     overwrote each other's bookings via /courts/main snapshot writes.
  ============================================================ */
  let _courtsListenerFired = false;
  let _lastCourtsWrittenJson = '';
  function saveCourtsToFirestoreIfChanged(){
    if (typeof db === 'undefined' || !db || !db.collection){
      console.warn('[firestore] db not ready, skipping courts write');
      return;
    }
    if (!_courtsListenerFired){
      console.warn('[firestore] courts listener not hydrated yet, skipping write to avoid stale overwrite');
      return;
    }
    const currentJson = JSON.stringify(courts);
    /* Already matches remote → no-op (this is what kills the echo loop
       when onSnapshot bounces our own write back to us). */
    if (currentJson === _lastCourtsRemoteJson) return;
    /* Already wrote this exact state → no-op (e.g. rapid re-renders). */
    if (currentJson === _lastCourtsWrittenJson) return;
    _lastCourtsWrittenJson = currentJson;
    if (!_currentPlayDate){
      console.warn('[firestore] no _currentPlayDate set, skipping write');
      _lastCourtsWrittenJson = '';
      return;
    }
    const docPath = 'courts/' + _currentPlayDate;
    console.info('[firestore] write ' + docPath + ' · ' + currentJson.length + ' chars');
    db.collection('courts').doc(_currentPlayDate).set({ data: courts, playDate: _currentPlayDate })
      .then(() => { console.info('[firestore] ' + docPath + ' write OK'); })
      .catch(err => {
        console.error('[firestore] ' + docPath + ' write FAILED:', err && (err.code || err.message), err);
        _lastCourtsWrittenJson = '';
      });
  }

  /* ============================================================
     ATTENDANCE FIRESTORE WRITE — count-gated.
     Only writes when attendance Set actually grew.
  ============================================================ */
  let _lastAttendanceCount = -1;
  function saveAttendanceToFirestoreIfChanged(){
    if (typeof db === 'undefined' || !db || !db.collection) return;
    const cur = attendanceRecords.size;
    if (cur === _lastAttendanceCount) return;
    _lastAttendanceCount = cur;
    console.info('[firestore] write attendance/snapshot · count=' + cur);
    db.collection('attendance').doc('snapshot').set({
      data: [...attendanceRecords],
      bookers: attendanceBookers
    })
      .then(() => { console.info('[firestore] attendance/snapshot write OK'); })
      .catch(err => {
        console.error('[firestore] attendance/snapshot write FAILED:', err && (err.code || err.message), err);
        _lastAttendanceCount = -1;
      });
  }

  /* ============================================================
     PER-USER FIRESTORE WRITES
     Path: users/{uid}  — each user is a separate Firestore document.
     This replaces the previous users/snapshot single-doc model, which had
     a race condition: two devices each writing the whole snapshot would
     overwrite each other (e.g. admin's stale-cache write would erase a
     brand-new pending member). Per-doc writes are race-free per user.
  ============================================================ */
  /* Internal: queue writes if db isn't ready yet (race protection at boot).
     Replayed automatically once `db` becomes available. */
  const _pendingFsOps = [];
  function _flushPendingFsOps(){
    if (typeof db === 'undefined' || !db || !db.collection) return;
    while (_pendingFsOps.length){
      const op = _pendingFsOps.shift();
      try { op(); } catch(e){ console.error('[firestore] queued op failed:', e); }
    }
  }

  function saveUserToFirestore(uid){
    if (!uid || !USERS[uid]) return;
    /* Capture payload at call time so mutations afterwards don't change the
       write — Firestore set() reads the object reference asynchronously. */
    const payload = JSON.parse(JSON.stringify(USERS[uid]));
    const exec = () => {
      console.info('[firestore] write users/' + uid, '· status=' + (payload.status || '?'));
      db.collection('users').doc(uid).set(payload)
        .then(() => { console.info('[firestore] users/' + uid + ' write OK'); })
        .catch(err => { console.error('[firestore] users/' + uid + ' write FAILED:', err && (err.code || err.message), err); });
    };
    if (typeof db === 'undefined' || !db || !db.collection){
      console.warn('[firestore] db not ready, queuing write for users/' + uid);
      _pendingFsOps.push(exec);
      return;
    }
    try { exec(); }
    catch(e){ console.error('[firestore] saveUserToFirestore exception:', e); }
  }

  function deleteUserFromFirestore(uid){
    if (!uid) return;
    const exec = () => {
      console.info('[firestore] delete users/' + uid);
      db.collection('users').doc(uid).delete()
        .then(() => { console.info('[firestore] users/' + uid + ' delete OK'); })
        .catch(err => { console.error('[firestore] users/' + uid + ' delete FAILED:', err && (err.code || err.message), err); });
    };
    if (typeof db === 'undefined' || !db || !db.collection){
      console.warn('[firestore] db not ready, queuing delete for users/' + uid);
      _pendingFsOps.push(exec);
      return;
    }
    try { exec(); }
    catch(e){ console.error('[firestore] deleteUserFromFirestore exception:', e); }
  }

  /* One-time legacy cleanup: drop the old users/snapshot doc if it still
     exists. Per-user docs are now the source of truth. Safe to run every
     boot — Firestore delete on a missing doc is a no-op. */
  function cleanupLegacyUsersSnapshot(){
    if (typeof db === 'undefined' || !db || !db.collection) return;
    try {
      db.collection('users').doc('snapshot').delete()
        .then(() => { console.info('[firestore] legacy users/snapshot removed'); })
        .catch(() => { /* missing doc or rules → ignore */ });
    } catch(_){}
  }

  /* ============================================================
     DATE HELPERS

     todayISO()        — Asia/Taipei calendar date (used by attendance keys)
     systemDateISO()   — "play date" = today, but if Asia/Taipei wall clock
                          is past 19:00 we advance to tomorrow. This is what
                          Firestore courts/{playDate} subscribes/writes to.
     playDateLabel()   — "YYYY/MM/DD 週X" for the current play date (title).

     _currentPlayDate  — the play date this device is currently mounted on.
                          Set by startCourtsListener(). Used by all reads/writes
                          + the day-flip detector in the 60s ticker.
  ============================================================ */
  let _currentPlayDate = '';

  function _taipeiYMD(){
    /* Return Asia/Taipei calendar date as {y,m,d} numbers. */
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(new Date());
      return {
        y: Number(parts.find(p => p.type === 'year').value),
        m: Number(parts.find(p => p.type === 'month').value),
        d: Number(parts.find(p => p.type === 'day').value)
      };
    } catch(_){
      const n = new Date();
      const tw = new Date(n.getTime() + (n.getTimezoneOffset() + 8*60) * 60000);
      return {
        y: tw.getUTCFullYear(),
        m: tw.getUTCMonth() + 1,
        d: tw.getUTCDate()
      };
    }
  }

  function todayISO(){
    const t = _taipeiYMD();
    return t.y + '-' + String(t.m).padStart(2,'0') + '-' + String(t.d).padStart(2,'0');
  }
  function todayLabel(){
    const t = _taipeiYMD();
    const date = new Date(Date.UTC(t.y, t.m - 1, t.d));
    const wk = ['日','一','二','三','四','五','六'][date.getUTCDay()];
    return t.y + '/' + String(t.m).padStart(2,'0') + '/' + String(t.d).padStart(2,'0') + ' 週' + wk;
  }

  function systemDateISO(){
    /* Play date = today if before 19:00 Taipei; otherwise tomorrow.
       This is the cutoff that flips the courts board to the next day. */
    const t = _taipeiYMD();
    let date = new Date(Date.UTC(t.y, t.m - 1, t.d));
    if (nowTimeMinutesTW() >= 19 * 60){
      date.setUTCDate(date.getUTCDate() + 1);
    }
    return date.getUTCFullYear() + '-' +
      String(date.getUTCMonth() + 1).padStart(2,'0') + '-' +
      String(date.getUTCDate()).padStart(2,'0');
  }

  function playDateLabel(){
    const iso = _currentPlayDate || systemDateISO();
    const [y, m, d] = iso.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    const wk = ['日','一','二','三','四','五','六'][date.getUTCDay()];
    return y + '/' + String(m).padStart(2,'0') + '/' + String(d).padStart(2,'0') + ' 週' + wk;
  }

  const STATUS = {
    PENDING: 'pending',
    MEMBER:  'member',
    COACH:   'coach',
    ADMIN:   'admin',
    OWNER:   'owner',
    BLOCKED: 'blocked'
  };

  const STRENGTH_INFO = {
    '右邊': 'Forehand side',
    '左邊': 'Backhand side',
    '前面': 'Volley / Net play',
    '後面': 'Baseline / Movement'
  };
  const STRENGTH_KEYS = Object.keys(STRENGTH_INFO);

  /* ============================================================
     USER STORE — production cutover.
     Only the OWNER bootstrap is seeded. All real members come from
     LINE LIFF login (handleLogin → first-login creates PENDING).
     Firebase migration: this object would be replaced by a Firestore
     'users' collection keyed by LINE userId. */
  const USERS = {
    'Ub1cc54fbbecfcea070a29ce8762fb05b': {
      userId: 'Ub1cc54fbbecfcea070a29ce8762fb05b',
      displayName: 'Maverick 小猴',
      ic: 'M', cl: '#4A6B8A',
      status: STATUS.OWNER,
      createdAt: '2026-04-30',
      ntrp: '—', playCount: 0, strengths: []
    }
  };

  /* No demo identity in production. Only LIFF login establishes currentUserId. */
  let currentUserId = null;

  /* ============================================================
     HELPERS
  ============================================================ */
  function getUser(id) { return USERS[id]; }
  function me() { return getUser(currentUserId); }
  function isAdmin() {
    const u = me();
    return u && (u.status === STATUS.ADMIN || u.status === STATUS.OWNER);
  }
  function isOwner(uid){
    const u = uid ? getUser(uid) : me();
    return !!(u && u.status === STATUS.OWNER);
  }
  function isCoach(uid) { const u = getUser(uid); return u && u.status === STATUS.COACH; }
  function isAdminLike(uid){
    const u = uid ? getUser(uid) : me();
    return !!(u && (u.status === STATUS.ADMIN || u.status === STATUS.OWNER));
  }
  function isCoachLike(uid){
    const u = uid ? getUser(uid) : me();
    return !!(u && (u.status === STATUS.COACH || u.status === STATUS.OWNER));
  }
  function canBook() {
    const u = me();
    return u && (u.status === STATUS.MEMBER || u.status === STATUS.COACH ||
                 u.status === STATUS.ADMIN  || u.status === STATUS.OWNER);
  }
  function bookingRejectMessage(){
    const u = me();
    if (!u) return '請先登入';
    if (u.status === STATUS.PENDING) return '您的會員資格尚待管理員審核，通過後才能使用掛牌功能。';
    if (u.status === STATUS.BLOCKED) return '帳號已被封鎖，無法使用此功能';
    return '需要會員權限';
  }
  function adminCount() {
    return Object.values(USERS).filter(u => u.status === STATUS.ADMIN).length;
  }
  function ownerCount() {
    return Object.values(USERS).filter(u => u.status === STATUS.OWNER).length;
  }
  function pendingList() {
    return Object.values(USERS).filter(u => u.status === STATUS.PENDING);
  }
  function nonPendingList() {
    return Object.values(USERS).filter(u => u.status !== STATUS.PENDING);
  }
  function coachList() {
    return Object.values(USERS).filter(u => u.status === STATUS.COACH);
  }
  function memberLikeList() {
    return Object.values(USERS).filter(u =>
      u.status === STATUS.MEMBER || u.status === STATUS.COACH || u.status === STATUS.ADMIN
    );
  }

  /* ============================================================
     COURT DATA
  ============================================================ */
  const TIMES = [];
  for (let h = 6; h <= 18; h++){
    TIMES.push(String(h).padStart(2,'0')+':00');
    if (h !== 18) TIMES.push(String(h).padStart(2,'0')+':30');
  }
  /* Real-time slot tracking — tied to Asia/Taipei wall clock.
     - nowTimeIdx() returns the index in TIMES for the slot we're currently in.
     - Slots strictly before this index are "ended" and cannot be booked.
     - The red marker tracks this in real time, independent of activeIdx. */
  function nowTimeMinutesTW(){
    /* Get current minutes-since-midnight in Asia/Taipei, regardless of
       the device's local timezone. Two-tier strategy:
       (1) Intl.DateTimeFormat — most correct, handles DST etc.
       (2) Manual UTC+8 — timezone-independent fallback if Intl returns
           garbage or hour='24' (some Chromium versions). */
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Taipei', hour12: false,
        hour: '2-digit', minute: '2-digit'
      }).formatToParts(new Date());
      let h = Number(parts.find(p => p.type === 'hour').value);
      const m = Number(parts.find(p => p.type === 'minute').value);
      if (h === 24) h = 0; /* normalise the en-US 24:xx edge case */
      if (Number.isFinite(h) && Number.isFinite(m)) return h * 60 + m;
    } catch(_){}
    /* Fallback: compute Asia/Taipei (UTC+8) manually so we never
       accidentally use the device's local timezone. */
    const now = new Date();
    const twMs = now.getTime() + (now.getTimezoneOffset() + 8 * 60) * 60000;
    const tw = new Date(twMs);
    return tw.getUTCHours() * 60 + tw.getUTCMinutes();
  }
  function nowTimeIdx(){
    const now = nowTimeMinutesTW();
    let best = 0;
    for (let i = 0; i < TIMES.length; i++){
      const [h, m] = TIMES[i].split(':').map(Number);
      const mins = h*60 + m;
      if (mins <= now) best = i;
      else break;
    }
    /* If current time is before earliest slot, surface the first slot.
       If after the last slot, surface the last slot index. */
    return best;
  }
  function isSlotEnded(time){
    const [h, m] = time.split(':').map(Number);
    const slotEndMins = h*60 + m + 30; /* slot ends 30 min after start */
    return slotEndMins <= nowTimeMinutesTW();
  }
  /* A slot becomes unbookable the moment it begins — even if it hasn't fully
     ended yet. Booking guards use this; isSlotEnded is reserved for attendance
     and the "已結束" display label. */
  function isSlotStarted(time){
    const [h, m] = time.split(':').map(Number);
    const slotStartMins = h*60 + m;
    return slotStartMins <= nowTimeMinutesTW();
  }
  let activeIdx = nowTimeIdx();

  /* Courts start empty for production. Bookings only ever come from real
     LIFF-authenticated members. The fill loop below populates default open
     halves for every time slot. */
  const courts = { A: {}, B: {} };
  ['A','B'].forEach(c => {
    TIMES.forEach(t => {
      if (!courts[c][t]) courts[c][t] = { top:{k:'open',p:[]}, bottom:{k:'open',p:[]} };
    });
  });

  /* ============================================================
     DOM REFERENCES
  ============================================================ */
  const screens = {
    login:   document.getElementById('screen-login'),
    pending: document.getElementById('screen-pending'),
    blocked: document.getElementById('screen-blocked'),
    app:     document.getElementById('screen-app')
  };
  const overlay = document.getElementById('overlay');
  const sheet   = document.getElementById('sheet');
  const toast   = document.getElementById('toast');
  const subEl   = document.getElementById('cb-sub');
  const marker  = document.getElementById('cb-marker');
  const adminBtn = document.getElementById('admin-open');
  const adminPCount = document.getElementById('admin-pcount');
  const meBtn = document.getElementById('me-btn');
  const meAv = document.getElementById('me-av');
  const meNm = document.getElementById('me-nm');

  const seats = [
    { x: 28, y: 50 },
    { x: 72, y: 50 }
  ];

  function showToast(msg, warn){
    toast.textContent = msg;
    toast.classList.toggle('warn', !!warn);
    toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('show'), 2200);
  }

  function showScreen(name){
    Object.keys(screens).forEach(k => screens[k].classList.toggle('active', k === name));
  }

  /* ============================================================
     ROUTER
  ============================================================ */
  function route(){
    if (!currentUserId){ showScreen('login'); return; }
    const u = me();
    if (!u){ showScreen('login'); currentUserId = null; return; }
    if (u.status === STATUS.PENDING){
      document.getElementById('pending-uid').textContent = u.userId;
      document.getElementById('pending-name').textContent = u.displayName;
      document.getElementById('pending-time').textContent = u.createdAt || '—';
      showScreen('pending');
      return;
    }
    if (u.status === STATUS.BLOCKED){
      document.getElementById('blocked-uid').textContent = u.userId;
      showScreen('blocked');
      return;
    }
    showScreen('app');
    renderApp();
  }

  /* ============================================================
     BOOKING-RULE HELPERS
  ============================================================ */
  function userHasBookingAt(uid, court, time){
    const slot = courts[court] && courts[court][time];
    if (!slot) return false;
    return ['top','bottom'].some(h => {
      const s = slot[h];
      if (!s) return false;
      if (s.k === 'coach' || s.k === 'coach-tail') return false;
      return (s.p || []).indexOf(uid) >= 0;
    });
  }

  function userOnSameCourtTime(uid, court, time){
    const slot = courts[court] && courts[court][time];
    if (!slot) return false;
    return ['top','bottom'].some(h => {
      const s = slot[h]; if (!s) return false;
      return (s.p || []).indexOf(uid) >= 0;
    });
  }
  /* Cross-court uniqueness: a user may only appear on ONE court at a given time
     — A or B, never both, and not on top+bottom of the same court either. */
  function userOnAnyCourtAt(uid, time){
    return ['A','B'].some(c => userOnSameCourtTime(uid, c, time));
  }

  /* ============================================================
     ATTENDANCE PROCESSOR
     Walks today's courts and records attendance for every player on slots
     that have actually ended. Idempotent: each (uid, date, court, time)
     can only be recorded once thanks to attendanceRecords Set.
  ============================================================ */
  function recordFromCourts(courtsData, date, untilIdx){
    let changed = false;
    TIMES.slice(0, untilIdx).forEach(t => {
      ['A','B'].forEach(c => {
        const slot = courtsData[c] && courtsData[c][t]; if (!slot) return;
        ['top','bottom'].forEach(side => {
          const h = slot[side]; if (!h) return;
          const isCoach = (h.k === 'coach' || h.k === 'coach-tail');
          if (isCoach && h.coach){
            if (recordAttendanceOnce(h.coach, date, c, t)) changed = true;
          }
          (h.p || []).forEach(uid => {
            /* Pass bookedByUid when proxy-booked; null otherwise. */
            const bookerUid = (h.b && h.b[uid]) || null;
            if (recordAttendanceOnce(uid, date, c, t, bookerUid)) changed = true;
          });
        });
      });
    });
    return changed;
  }
  function processEndedSlots(){
    /* Find the highest index whose slot has fully ended. */
    let endedUntil = 0;
    for (let i = 0; i < TIMES.length; i++){
      if (isSlotEnded(TIMES[i])) endedUntil = i + 1;
      else break;
    }
    if (endedUntil === 0) return false;
    /* Attendance records use the PLAY date (not calendar date), so a slot
       booked under "today's play date" still counts under that key even if
       the clock has rolled past midnight before the slot ended. */
    const dateKey = _currentPlayDate || systemDateISO();
    const changed = recordFromCourts(courts, dateKey, endedUntil);
    if (changed) persist();
    return changed;
  }

  function adjacentBookingCount(uid, court, time){
    const prev = addMin(time, -30);
    const next = addMin(time,  30);
    let n = 0;
    if (userHasBookingAt(uid, court, prev)) n++;
    if (userHasBookingAt(uid, court, next)) n++;
    return n;
  }

  function isReplaceableEntry(half, uid){
    return half && half.replaceable && half.replaceable.indexOf(uid) >= 0;
  }

  function halfHasReplaceable(half){
    return half && half.replaceable && half.replaceable.length > 0;
  }

  /* ============================================================
     RENDER
  ============================================================ */
  function avPicHTML(u){
    if (u && u.pictureUrl){
      return '<img src="' + u.pictureUrl + '" alt="" onerror="this.remove()">';
    }
    return '';
  }

  function renderApp(){
    /* Tick attendance first — any slot that just ended gets recorded
       so the stats panel reflects reality on every render. */
    processEndedSlots();
    const u = me();
    if (!u) return; /* defensive: route() will swap to login screen */
    meAv.style.background = u.cl;
    meAv.innerHTML = u.ic + avPicHTML(u);
    meNm.textContent = u.displayName;

    if (isAdminLike()){
      adminBtn.style.display = 'inline-flex';
      const pn = pendingList().length;
      adminPCount.textContent = pn;
      adminBtn.classList.toggle('has-pending', pn > 0);
    } else {
      adminBtn.style.display = 'none';
    }

    const dirBtn = document.getElementById('directory-open');
    if (dirBtn) dirBtn.style.display = canBook() ? 'inline-flex' : 'none';

    /* Title reflects the play date (which auto-advances at 19:00),
       not the calendar today. Otherwise users at 19:01 would see
       "tomorrow's board" but the title would still say today. */
    const dateEl = document.getElementById('cb-date');
    if (dateEl) dateEl.textContent = playDateLabel();

    ['A','B'].forEach(c => {
      const slot = courts[c][TIMES[activeIdx]];
      renderHalf(document.getElementById(c+'-top'),    slot.top,    { court:c, side:'top',    time:TIMES[activeIdx] });
      renderHalf(document.getElementById(c+'-bottom'), slot.bottom, { court:c, side:'bottom', time:TIMES[activeIdx] });
      renderRoster(c);
      renderSlots(c);
    });
    /* Marker follows REAL clock time (Asia/Taipei), not the user's selected slot.
       Position interpolates fractionally between slot indices for smoothness. */
    const totalSpan = TIMES.length - 1;
    const firstMins = (() => { const [h,m] = TIMES[0].split(':').map(Number); return h*60+m; })();
    const lastMins  = (() => { const [h,m] = TIMES[TIMES.length-1].split(':').map(Number); return h*60+m; })();
    const nowMins = nowTimeMinutesTW();
    const clamped = Math.max(firstMins, Math.min(lastMins, nowMins));
    const fracIdx = (clamped - firstMins) / (lastMins - firstMins) * totalSpan;
    const pct = (fracIdx / totalSpan) * 88 + 6;
    marker.style.left = pct + '%';

    const t = TIMES[activeIdx];
    const role = u.status === STATUS.OWNER ? '擁有者'
               : u.status === STATUS.ADMIN ? '管理員'
               : u.status === STATUS.COACH ? '教練' : '會員';
    subEl.textContent = `${t} — ${addMin(t,30)} · ${role}模式`;

    persist();
  }

  function isMineSlot(slot){
    if (!slot) return false;
    return ['top','bottom'].some(h => {
      const s = slot[h];
      return s && s.k !== 'coach' && s.k !== 'coach-tail' &&
             (s.p || []).indexOf(currentUserId) >= 0;
    });
  }

  function pillEl(uid, opt){
    const u = getUser(uid) || { displayName:'?', ic:'?', cl:'#888' };
    const el = document.createElement('button');
    el.className = 'cb-pill';
    if (uid === currentUserId) el.classList.add('is-mine');
    if (opt && opt.replaceable) el.classList.add('replaceable');
    /* Proxy-booked: render second small avatar (the booker) overlapping
       the player avatar so it's obvious "X booked by Y". */
    const bookerUid = opt && opt.bookerUid;
    const bu = bookerUid ? (getUser(bookerUid) || { ic:'?', cl:'#888' }) : null;
    if (bu) el.classList.add('proxy');
    const fullClass = opt && opt.full ? ' f' : '';
    el.innerHTML =
      `<span class="av" style="background:${u.cl}">${u.ic}${avPicHTML(u)}</span>` +
      (bu
        ? `<span class="av booker" style="background:${bu.cl}" title="由 ${bu.displayName || ''} 代掛">${bu.ic}${avPicHTML(bu)}</span>`
        : '') +
      `<span class="nm">${u.displayName}</span>` +
      (opt && opt.replaceable ? `<span class="repl">替補</span>` : '') +
      `<span class="st${fullClass}"></span>`;
    el.addEventListener('click', e => {
      e.stopPropagation();
      openProfile(uid, opt && opt.context);
    });
    return el;
  }

  function emptyEl(context){
    const el = document.createElement('button');
    el.className = 'cb-pill empty';
    el.innerHTML = `<span class="av">+</span><span class="nm">空位</span>`;
    el.addEventListener('click', e => {
      e.stopPropagation();
      /* Admin/owner gets a proxy picker so they can mount the slot under
         themselves OR another approved member. Regular members go straight
         to a self-booking. */
      if (isAdminLike() && context && context.court){
        openProxyBookPicker(context);
      } else {
        joinSeat(context);
      }
    });
    return el;
  }

  function renderHalf(el, data, context){
    el.innerHTML = '';
    el.classList.remove('full','mine');
    if (!data) return;

    const tag = document.createElement('span');
    tag.className = 'cb-half-tag';
    tag.textContent = context.side === 'top' ? '前場 · NET' : '後場 · BASELINE';
    el.appendChild(tag);

    const isCoachKind = data.k === 'coach' || data.k === 'coach-tail';
    const mine = !isCoachKind && (data.p || []).indexOf(currentUserId) >= 0;

    if (isCoachKind){
      const c = document.createElement('button');
      c.className = 'cb-coach';
      const studs = (data.p || []).slice(0,4).map(uid => {
        const pp = getUser(uid) || { ic:'?', cl:'#888' };
        return `<span class="a" style="background:${pp.cl}">${pp.ic}</span>`;
      }).join('');
      const studentMine = (data.p || []).indexOf(currentUserId) >= 0;
      const coachUser = getUser(data.coach);
      c.innerHTML = `
        ${studentMine ? '<span class="cb-mine-mark">我</span>' : ''}
        <div>
          <span class="b">${data.k === 'coach' ? 'Coaching · 1h' : 'Cont.'}</span>
          <div class="who">${coachUser ? coachUser.displayName : 'Coach'}</div>
          <div class="span">${data.span || ''}</div>
        </div>
        <div class="stu">${studs}<span class="ct">${(data.p||[]).length} / ${MAX_STUDENTS} students</span></div>`;
      c.addEventListener('click', e => { e.stopPropagation(); openCoach(data, context); });
      el.appendChild(c);
      return;
    }

    if (data.k === 'full') el.classList.add('full');
    if (mine) el.classList.add('mine');

    const list = data.p || [];
    for (let i=0; i<2; i++){
      const seat = seats[i];
      const w = document.createElement('div');
      w.style.cssText = `position:absolute; left:${seat.x}%; top:${seat.y}%; transform:translate(-50%,-50%);`;
      if (list[i]){
        w.appendChild(pillEl(list[i], {
          full: data.k==='full',
          replaceable: isReplaceableEntry(data, list[i]),
          bookerUid: (data.b && data.b[list[i]]) || null,
          context: context
        }));
      } else {
        w.appendChild(emptyEl(context));
      }
      el.appendChild(w);
    }
  }

  function renderRoster(courtKey){
    const wrap = document.getElementById('roster-' + courtKey);
    if (!wrap) return;
    const t = TIMES[activeIdx];
    const slot = courts[courtKey][t];

    function pillForUser(uid, opts){
      const u = getUser(uid) || { ic:'?', cl:'#888', displayName:'?' };
      const bookerUid = opts && opts.bookerUid;
      const bu = bookerUid ? (getUser(bookerUid) || { ic:'?', cl:'#888', displayName:'?' }) : null;
      let cls = (uid === currentUserId) ? 'roster-pill is-mine' : 'roster-pill';
      if (bu) cls += ' proxy';
      const extra = opts && opts.extra ? `<span style="font-size:9px; opacity:.7; margin-left:4px;">${opts.extra}</span>` : '';
      const bookerAv = bu
        ? `<span class="av booker" style="background:${bu.cl}" title="由 ${bu.displayName || ''} 代掛">${bu.ic}${avPicHTML(bu)}</span>`
        : '';
      return `<button class="${cls}" data-uid="${uid}"><span class="av" style="background:${u.cl}">${u.ic}${avPicHTML(u)}</span>${bookerAv}${u.displayName}${extra}</button>`;
    }

    wrap.innerHTML = ['top','bottom'].map(side => {
      const h = slot[side];
      const label = side === 'top' ? '前場' : '後場';
      if (!h) return `<div class="roster-row"><span class="rl">${label}</span><span class="roster-pill empty">空位</span></div>`;
      if (h.k === 'coach' || h.k === 'coach-tail'){
        const cu = getUser(h.coach) || { ic:'?', cl:'#888', displayName:'Coach' };
        const studs = (h.p || []).map(uid => pillForUser(uid)).join('');
        const coachPill = `<button class="roster-pill coach" data-uid="${h.coach}"><span class="av" style="background:#2A4036">${cu.ic}${avPicHTML(cu)}</span>${cu.displayName} · ${(h.p||[]).length}/${MAX_STUDENTS}</button>`;
        return `<div class="roster-row"><span class="rl">${label}</span>${coachPill}${studs}</div>`;
      }
      const players = (h.p || []);
      if (players.length === 0){
        return `<div class="roster-row"><span class="rl">${label}</span><span class="roster-pill empty">空位</span></div>`;
      }
      const pills = players.map(uid => pillForUser(uid, {
        bookerUid: (h.b && h.b[uid]) || null
      })).join('');
      return `<div class="roster-row"><span class="rl">${label}</span>${pills}</div>`;
    }).join('');

    wrap.querySelectorAll('.roster-pill[data-uid]').forEach(b => {
      b.addEventListener('click', e => {
        e.stopPropagation();
        openProfile(b.getAttribute('data-uid'), null);
      });
    });
  }

  function statusText(slot){
    if (!slot) return '—';
    const tk = slot.top.k, bk = slot.bottom.k;
    if (isMineSlot(slot)) return '我的預約';
    if (tk === 'coach' || bk === 'coach') return '教練課';
    if (tk === 'coach-tail' || bk === 'coach-tail') return '課程中';
    if (tk === 'full' && bk === 'full') return '已預約';
    if (tk === 'full' || bk === 'full') return '半滿';
    return '可預約';
  }

  function renderSlots(courtKey){
    const wrap = document.getElementById('slots-' + courtKey);
    wrap.innerHTML = '';
    TIMES.forEach((t, i) => {
      const slot = courts[courtKey][t];
      const el = document.createElement('button');
      el.className = 'cb-slot';
      const tk = slot.top.k, bk = slot.bottom.k;
      const isCoach = (tk==='coach' || bk==='coach');
      const isTail  = (tk==='coach-tail' || bk==='coach-tail');
      const isFull  = (tk==='full' && bk==='full');
      const isMine  = isMineSlot(slot);
      const hasReplaceable = halfHasReplaceable(slot.top) || halfHasReplaceable(slot.bottom);
      /* Slot is "ended" once its 30-min window has passed in Asia/Taipei. */
      const past    = isSlotEnded(t);

      if (isMine) el.classList.add('mine');
      else if (past) el.classList.add('ended');
      else if (isCoach) el.classList.add('coach');
      else if (isTail) el.classList.add('coach','tail');
      else if (isFull) el.classList.add('full');
      if (hasReplaceable && !past) el.classList.add('repl');
      if (i === activeIdx) el.classList.add('active');

      const stat = past && !isMine ? '已結束'
                 : (hasReplaceable && !isMine ? '可被替補'
                 : statusText(slot));
      el.innerHTML = `<div class="t">${t}</div><div class="s">${stat}</div>`;
      el.addEventListener('click', () => { activeIdx = i; renderApp(); });
      wrap.appendChild(el);
    });
    const active = wrap.querySelector('.active');
    if (active) active.scrollIntoView({ behavior:'smooth', block:'nearest', inline:'center' });
  }

  function addMin(t, m){
    const [h, mm] = t.split(':').map(Number);
    const total = h*60 + mm + m;
    if (total < 0) return null;
    return String(Math.floor(total/60) % 24).padStart(2,'0') + ':' + String(total%60).padStart(2,'0');
  }

  /* ============================================================
     ADMIN ACTIONS
  ============================================================ */
  function approveUser(uid){
    if (!isAdmin()) return showToast('需要管理員權限', true);
    const u = getUser(uid);
    if (!u || u.status !== STATUS.PENDING) return;
    u.status = STATUS.MEMBER;
    saveUserToFirestore(uid);
    showToast(`已核准 ${u.displayName}`);
    rerenderAdminPanel(); renderApp();
  }

  function rejectUser(uid){
    if (!isAdmin()) return showToast('需要管理員權限', true);
    const u = getUser(uid);
    if (!u || u.status !== STATUS.PENDING) return;
    if (u.status === STATUS.OWNER) return;
    delete USERS[uid];
    deleteUserFromFirestore(uid);
    showToast(`已拒絕 ${u.displayName} 的申請`);
    rerenderAdminPanel(); renderApp();
  }

  function setStatus(uid, newStatus){
    if (!isAdmin()) return showToast('需要管理員權限', true);
    const u = getUser(uid);
    if (!u) return false;
    if (u.status === STATUS.OWNER){ showToast('OWNER 無法被變更', true); return false; }
    if (newStatus === STATUS.OWNER){ showToast('OWNER 角色由系統指派，無法手動設定', true); return false; }
    if (newStatus === STATUS.ADMIN && u.status !== STATUS.ADMIN){
      if (!isOwner()){ showToast('只有 OWNER 可以指派管理員', true); return false; }
      if (adminCount() >= MAX_ADMINS){ showToast(`已達管理員上限 (最多 ${MAX_ADMINS} 位)`, true); return false; }
    }
    if (u.status === STATUS.ADMIN && newStatus !== STATUS.ADMIN){
      if (!isOwner()){ showToast('只有 OWNER 可以變更管理員身份', true); return false; }
    }
    u.status = newStatus;
    saveUserToFirestore(uid);
    showToast(`${u.displayName} 已設為 ${labelForStatus(newStatus)}`);
    rerenderAdminPanel(); renderApp();
    return true;
  }

  function blockUser(uid){
    if (!isAdmin()) return showToast('需要管理員權限', true);
    const u = getUser(uid); if (!u) return;
    if (u.status === STATUS.OWNER){ showToast('OWNER 無法被封鎖', true); return; }
    if (u.status === STATUS.ADMIN && !isOwner()){ showToast('只有 OWNER 可以封鎖管理員', true); return; }
    u.status = STATUS.BLOCKED;
    removeFromAllBookings(uid);
    saveUserToFirestore(uid);
    showToast(`${u.displayName} 已封鎖`);
    rerenderAdminPanel(); renderApp();
  }

  function canDelete(targetUid){
    if (!isAdminLike()) return false;
    const t = getUser(targetUid); if (!t) return false;
    if (targetUid === currentUserId) return false;
    if (t.status === STATUS.OWNER) return false;
    if (isOwner()) return true;
    return t.status !== STATUS.ADMIN;
  }

  function deleteUser(uid){
    if (!canDelete(uid)){ showToast('無權限刪除這位使用者', true); return; }
    const u = getUser(uid); if (!u) return;
    if (!confirm('確定要刪除這位會員？此操作無法復原。')) return;
    removeFromAllBookings(uid);
    delete USERS[uid];
    deleteUserFromFirestore(uid);
    persist();
    showToast('會員已刪除');
    rerenderAdminPanel();
    renderApp();
  }

  function unblockUser(uid){
    if (!isAdmin()) return showToast('需要管理員權限', true);
    const u = getUser(uid); if (!u) return;
    u.status = STATUS.MEMBER;
    saveUserToFirestore(uid);
    showToast(`${u.displayName} 已解除封鎖`);
    rerenderAdminPanel(); renderApp();
  }

  function removeFromBooking(uid, ctx){
    if (!isAdmin()) return showToast('需要管理員權限', true);
    if (!ctx || !ctx.court) return;
    /* Same lock as personal cancel — bookings become 成立 once the slot
       has begun. Admin block/delete-user flows go through
       removeFromAllBookings which keeps no time guard. */
    if (isSlotStarted(ctx.time)){
      showToast('球賽已開始，無法移除預約', true); return;
    }
    const slot = courts[ctx.court][ctx.time];
    const half = slot[ctx.side];
    half.p = (half.p || []).filter(x => x !== uid);
    half.replaceable = (half.replaceable || []).filter(x => x !== uid);
    if (half.b) delete half.b[uid];
    normalizeHalfState(half);
    showToast('已從預約移除');
    overlay.classList.remove('show');
    renderApp();
  }

  function removeFromAllBookings(uid){
    ['A','B'].forEach(c => {
      Object.keys(courts[c]).forEach(t => {
        const slot = courts[c][t]; if (!slot) return;
        ['top','bottom'].forEach(k => {
          const half = slot[k]; if (!half || !half.p) return;
          if (half.k === 'coach' || half.k === 'coach-tail'){
            half.p = half.p.filter(x => x !== uid);
            return;
          }
          half.p = half.p.filter(x => x !== uid);
          half.replaceable = (half.replaceable || []).filter(x => x !== uid);
          if (half.b){
            /* Drop proxy entry for the removed player AND any entry where
               this uid was the BOOKER (defensive — if booker is deleted,
               the proxy record becomes meaningless). */
            delete half.b[uid];
            Object.keys(half.b).forEach(pid => {
              if (half.b[pid] === uid) delete half.b[pid];
            });
          }
          normalizeHalfState(half);
        });
      });
    });
  }

  function normalizeHalfState(half){
    if (!half || half.k === 'coach' || half.k === 'coach-tail') return;
    const n = (half.p || []).length;
    const containsMe = (half.p || []).indexOf(currentUserId) >= 0;
    if (n === 0){ half.k = 'open'; half.replaceable = []; return; }
    if (n >= 2) half.k = containsMe ? 'mine' : 'full';
    else half.k = containsMe ? 'mine' : 'open';
    if (!half.replaceable) half.replaceable = [];
    half.replaceable = half.replaceable.filter(x => half.p.indexOf(x) >= 0);
  }

  function labelForStatus(s){
    return ({pending:'待審核', member:'會員', coach:'教練', admin:'管理員', owner:'擁有者', blocked:'封鎖'})[s] || s;
  }

  /* ============================================================
     PROFILE SHEET
  ============================================================ */
  function strengthTagsHTML(strengths){
    if (!strengths || !strengths.length){
      return `<span class="empty">尚未設定</span>`;
    }
    return strengths.map(s => {
      const en = STRENGTH_INFO[s] || '';
      return `<span class="strength-tag">${s}<span class="en">${en}</span></span>`;
    }).join('');
  }

  function roleBadgeHTML(u){
    if (u.status === STATUS.OWNER)  return '<span class="badge owner">OWNER</span>';
    if (u.status === STATUS.COACH)  return '<span class="badge coach">COACH</span>';
    if (u.status === STATUS.ADMIN)  return '<span class="badge admin">ADMIN</span>';
    if (u.status === STATUS.BLOCKED)return '<span class="badge blocked">BLOCKED</span>';
    if (u.status === STATUS.PENDING)return '<span class="badge pending">PENDING</span>';
    return '';
  }

  function avatarBg(u, mine){
    return `background:${mine ? 'var(--blue)' : u.cl}`;
  }

  function openProfile(uid, context){
    const u = getUser(uid);
    if (!u){
      sheet.innerHTML = `<div class="grab"></div><div class="empty-state">使用者已不存在</div>`;
      overlay.classList.add('show');
      return;
    }
    const mine = uid === currentUserId;
    sheet.classList.toggle('is-mine', mine);
    sheet.classList.remove('is-admin-panel','is-coach-form');

    if (mine){
      sheet._draftNtrp = u.ntrp || '—';
      sheet._draftStrengths = (u.strengths || []).slice();
      sheet._draftDisplayName = u.displayName || '';
    } else {
      sheet._draftNtrp = null;
      sheet._draftStrengths = null;
      sheet._draftDisplayName = null;
    }

    const role = roleBadgeHTML(u);
    const replaceableHere = context && courts[context.court] &&
                            isReplaceableEntry(courts[context.court][context.time][context.side], uid);

    let actBtn = '';
    if (mine && context){
      actBtn = `<button class="act mine">取消預約</button>`;
    } else if (canBook() && !mine && context && replaceableHere){
      actBtn = `<button class="act amber">替補進入</button>`;
    } else if (canBook() && !mine && context){
      actBtn = `<button class="act">加入</button>`;
    }

    const avHTML = `<div class="a" style="${avatarBg(u, mine)}">${u.ic}${avPicHTML(u)}</div>`;
    const showUid = mine || isAdminLike();

    sheet.innerHTML = `
      <div class="grab"></div>
      <div class="row">
        ${avHTML}
        <div style="flex:1; min-width:0;">
          <div class="n">${u.displayName} ${role}</div>
          ${ showUid ? `<div class="sb"><span class="uid">${u.userId}</span></div>` : '' }
        </div>
        ${actBtn}
      </div>
      <div class="stats">
        <div class="stat"><div class="k">NTRP</div><div class="v">${u.ntrp || '—'}</div></div>
        <div class="stat"><div class="k">出席次數</div><div class="v">${u.playCount != null ? u.playCount : 0}</div></div>
      </div>
      <div class="cb-strengths">
        <div class="label">擅長位置 · Strengths</div>
        <div class="tags">${strengthTagsHTML(u.strengths)}</div>
      </div>
      ${ mine ? renderMyEditPanel(sheet._draftNtrp, sheet._draftStrengths, sheet._draftDisplayName) : '' }
      ${ replaceableHere ? `<div style="margin-top:12px; font-size:11px; color:var(--amber); background:var(--amber-pale); padding:8px 10px; border-radius:8px;">此預約為連續第二格，可被尚未預約的會員替補。</div>` : '' }
      ${ adminActionsForUser(u, context) }
    `;
    overlay.classList.add('show');

    const btn = sheet.querySelector('button.act');
    if (btn) btn.addEventListener('click', () => {
      if (mine && context){ cancelMyBooking(context); }
      else if (replaceableHere){ replaceBooking(context, uid); }
      else if (!mine && context){ joinSeatAt(context); }
    });
    if (mine) bindMyEditPanel();
    bindAdminButtons(u, context);
  }

  const NTRP_OPTIONS = ['2.0','2.5','3.0','3.5','4.0','4.5','5.0+'];

  function renderMyEditPanel(draftNtrp, draftStrengths, draftDisplayName){
    const ntrpHTML = NTRP_OPTIONS.map(v =>
      `<option value="${v}" ${draftNtrp === v ? 'selected' : ''}>${v}</option>`
    ).join('');
    const tagsHTML = STRENGTH_KEYS.map(k => {
      const en = STRENGTH_INFO[k] || '';
      const on = draftStrengths.indexOf(k) >= 0 ? ' on' : '';
      return `<button type="button" class="strength-opt${on}" data-key="${k}">${k}<span class="en">${en}</span></button>`;
    }).join('');
    /* Escape user input so it can't break the input value attribute. */
    const safeName = (draftDisplayName || '').replace(/"/g, '&quot;');
    return `
      <div class="cb-edit-profile" id="my-edit-panel">
        <div class="label">編輯個人資料 · Edit profile</div>
        <div class="form-row">
          <label>顯示名稱 · Display name</label>
          <input type="text" id="my-displayname" maxlength="20" value="${safeName}" placeholder="輸入你想顯示的名稱">
        </div>
        <div class="form-row">
          <label>NTRP</label>
          <select id="my-ntrp">${ntrpHTML}</select>
        </div>
        <div class="form-row" style="margin-bottom:0;">
          <label>擅長位置 (Strengths)</label>
          <div class="strength-pick" id="my-strengths">${tagsHTML}</div>
        </div>
        <div style="display:flex; gap:8px; margin-top:14px;">
          <button type="button" class="save-profile-btn" id="cancel-profile" style="flex:1; background:rgba(45,61,52,.08); color:var(--ink);">取消</button>
          <button type="button" class="save-profile-btn" id="save-profile" style="flex:2;">儲存資料</button>
        </div>
      </div>
    `;
  }

  function bindMyEditPanel(){
    sheet.querySelectorAll('#my-strengths .strength-opt').forEach(btn => {
      btn.addEventListener('click', e => {
        e.preventDefault(); e.stopPropagation();
        const key = btn.getAttribute('data-key');
        const i = sheet._draftStrengths.indexOf(key);
        if (i >= 0) sheet._draftStrengths.splice(i, 1);
        else sheet._draftStrengths.push(key);
        btn.classList.toggle('on');
      });
    });

    /* Display-name input updates the draft only — committed on save. */
    const nameInput = sheet.querySelector('#my-displayname');
    if (nameInput){
      nameInput.addEventListener('input', e => {
        e.stopPropagation();
        sheet._draftDisplayName = nameInput.value;
      });
    }

    const ntrpSel = sheet.querySelector('#my-ntrp');
    if (ntrpSel){
      ntrpSel.addEventListener('change', e => {
        e.stopPropagation();
        sheet._draftNtrp = ntrpSel.value;
      });
    }

    const cancel = sheet.querySelector('#cancel-profile');
    if (cancel){
      cancel.addEventListener('click', e => {
        e.preventDefault(); e.stopPropagation();
        overlay.classList.remove('show');
      });
    }

    const save = sheet.querySelector('#save-profile');
    if (save){
      save.addEventListener('click', e => {
        e.preventDefault(); e.stopPropagation();
        const u = USERS[currentUserId]; if (!u) return;
        /* Trim + minimum-length validation. Empty / whitespace-only names
           fall back to existing displayName. */
        const trimmed = (sheet._draftDisplayName || '').trim();
        const nameChanged = trimmed && trimmed !== u.displayName;
        if (nameChanged){
          u.displayName = trimmed;
          /* Keep ic (avatar initial) in sync with the new name. */
          u.ic = trimmed.slice(0,1);
        }
        u.ntrp = sheet._draftNtrp;
        u.strengths = sheet._draftStrengths.slice();
        saveUserToFirestore(currentUserId);
        persist();
        showToast('個人資料已更新');
        /* In-place DOM patch for read-only header + stats + tags. */
        const nameEl = sheet.querySelector('.cb-sheet .n');
        if (nameEl && nameChanged){
          /* Replace just the leading text node so the role badge survives. */
          const firstNode = nameEl.firstChild;
          if (firstNode && firstNode.nodeType === 3) firstNode.nodeValue = u.displayName + ' ';
        }
        const ntrpVal = sheet.querySelector('.cb-sheet .stats .stat:first-child .v');
        if (ntrpVal) ntrpVal.textContent = u.ntrp || '—';
        const tagsBox = sheet.querySelector('.cb-strengths .tags');
        if (tagsBox) tagsBox.innerHTML = strengthTagsHTML(u.strengths);
        if (screens.app.classList.contains('active')){
          /* Header me-button + court roster show displayName too. */
          try { renderApp(); } catch(_){}
        }
      });
    }
  }

  function adminActionsForUser(u, context){
    if (!isAdmin()) return '';
    if (u.userId === currentUserId) return '';
    if (u.status === STATUS.OWNER){
      return `
        <div class="admin-panel">
          <div class="label">管理員操作</div>
          <div class="panel-notice"><strong>OWNER 無法被任何人變更。</strong>系統擁有者身份永久且唯一。</div>
          ${ context ? `<div class="admin-row" style="margin-top:8px;"><button class="danger" data-act="remove" disabled>從此預約移除</button></div>` : '' }
        </div>
      `;
    }
    if (u.status === STATUS.ADMIN && !isOwner()){
      return `
        <div class="admin-panel">
          <div class="label">管理員操作</div>
          <div class="panel-notice">ADMIN 身份只有 OWNER 能變更。</div>
          ${ context ? `<div class="admin-row" style="margin-top:8px;"><button class="danger" data-act="remove">從此預約移除</button></div>` : '' }
        </div>
      `;
    }
    const adminFull = adminCount() >= MAX_ADMINS && u.status !== STATUS.ADMIN;
    const hint = adminFull ? `<span class="hint">已達管理員上限 (${MAX_ADMINS})</span>` : '';
    return `
      <div class="admin-panel">
        <div class="label">管理員操作 <span class="count">ADMIN ${adminCount()}/${MAX_ADMINS}</span></div>
        ${ context ? `
          <div class="admin-row">
            <button class="danger" data-act="remove">從此預約移除</button>
          </div>` : '' }
        <div class="admin-row">
          ${ u.status === STATUS.BLOCKED
              ? `<button class="success" data-act="unblock">解除封鎖</button>`
              : `<button class="danger" data-act="block">封鎖此用戶</button>` }
        </div>
        <div class="admin-row">
          <button data-act="role-member" ${u.status===STATUS.MEMBER?'disabled':''}>設為會員</button>
          <button data-act="role-coach" ${u.status===STATUS.COACH?'disabled':''}>設為教練</button>
          ${ isOwner()
            ? `<button class="blue" data-act="role-admin" ${u.status===STATUS.ADMIN||adminFull?'disabled':''}>設為管理員</button>`
            : '' }
          ${hint}
        </div>
      </div>
    `;
  }

  function bindAdminButtons(u, context){
    sheet.querySelectorAll('.admin-row button').forEach(btn => {
      const act = btn.getAttribute('data-act');
      if (!act) return;
      btn.addEventListener('click', () => {
        if (act === 'remove')       return removeFromBooking(u.userId, context);
        if (act === 'block')        return blockUser(u.userId);
        if (act === 'unblock')      return unblockUser(u.userId);
        if (act === 'role-member')  return setStatus(u.userId, STATUS.MEMBER);
        if (act === 'role-coach')   return setStatus(u.userId, STATUS.COACH);
        if (act === 'role-admin')   return setStatus(u.userId, STATUS.ADMIN);
        if (act === 'cancel-coach' && context){ cancelCoachSession(context); }
        if (act === 'add-student' && context){ openStudentPicker(context); }
        if (act === 'remove-student'){
          const sid = btn.getAttribute('data-sid');
          removeStudentFromCoach(context, sid);
        }
      });
    });
  }

  /* ============================================================
     COACH SESSION
  ============================================================ */
  function openCoach(data, context){
    sheet.classList.remove('is-mine','is-admin-panel','is-coach-form');
    const studs = (data.p || []).map(uid => {
      const pp = getUser(uid) || { displayName:'?', ic:'?', cl:'#888' };
      const removeBtn = isAdmin()
        ? `<button class="x" data-act="remove-student" data-sid="${uid}">×</button>`
        : '';
      return `<span class="chip"><span class="ca" style="background:${pp.cl}">${pp.ic}</span>${pp.displayName}${removeBtn}</span>`;
    }).join('');
    const coachUser = getUser(data.coach) || { displayName:'Coach', ic:'C' };
    const halfLabel = context.side === 'top' ? '前場 / 網前 (Net side)' : '後場 / 底線 (Baseline)';
    const isFull = (data.p || []).length >= MAX_STUDENTS;

    sheet.innerHTML = `
      <div class="grab"></div>
      <div class="row">
        <div class="a" style="background:#2A4036">${coachUser.ic}${avPicHTML(coachUser)}</div>
        <div style="flex:1; min-width:0;">
          <div class="n">${coachUser.displayName} <span class="badge coach">COACH</span></div>
          <div class="sb">${halfLabel} · ${data.span || '60 分鐘'}</div>
        </div>
      </div>
      <div class="stats">
        <div class="stat"><div class="k">時段</div><div class="v small">${data.span || '—'}</div></div>
        <div class="stat"><div class="k">學員</div><div class="v">${(data.p||[]).length} / ${MAX_STUDENTS}</div></div>
      </div>
      <div style="margin-top:14px; font-size:10px; color:var(--ink-soft); letter-spacing:.08em; text-transform:uppercase;">學員名單</div>
      <div class="stulist">${studs || '<span style="font-size:11px;color:#9CA89F;">尚無學員</span>'}</div>
      <div style="margin-top:12px; font-size:11px; color:var(--ink-soft); line-height:1.6;">
        教練課佔用此球場的<strong>${context.side === 'top' ? '前半場' : '後半場'}</strong>，另一半可由一般會員照常打球。
      </div>
      ${ isAdmin() ? `
        <div class="admin-panel">
          <div class="label">管理員操作</div>
          <div class="admin-row">
            <button class="success" data-act="add-student" ${isFull?'disabled':''}>${isFull?'學員已滿 (4/4)':'＋ 新增學員'}</button>
          </div>
          <div class="admin-row">
            <button class="danger" data-act="cancel-coach">取消此教練課</button>
          </div>
        </div>` : '' }
    `;
    overlay.classList.add('show');
    bindAdminButtons({ userId: data.coach }, context);
  }

  function cancelCoachSession(context){
    if (!isAdmin()) return showToast('需要管理員權限', true);
    const head = courts[context.court][context.time];
    head[context.side] = { k:'open', p:[] };
    const tailTime = addMin(context.time, 30);
    const tail = courts[context.court][tailTime];
    if (tail && tail[context.side] && tail[context.side].k === 'coach-tail'){
      tail[context.side] = { k:'open', p:[] };
    }
    showToast('教練課已取消');
    overlay.classList.remove('show');
    renderApp();
  }

  function removeStudentFromCoach(context, sid){
    if (!isAdmin()) return showToast('需要管理員權限', true);
    const head = courts[context.court][context.time];
    const sideHead = head[context.side];
    if (sideHead.k !== 'coach' && sideHead.k !== 'coach-tail') return;
    let headTime = context.time;
    if (sideHead.k === 'coach-tail') headTime = addMin(context.time, -30);
    const headSlot = courts[context.court][headTime];
    const tailSlot = courts[context.court][addMin(headTime, 30)];
    [headSlot, tailSlot].forEach(s => {
      if (!s) return;
      const h = s[context.side];
      if (h && (h.k === 'coach' || h.k === 'coach-tail')){
        h.p = (h.p || []).filter(x => x !== sid);
      }
    });
    showToast('已移除學員');
    openCoach(headSlot[context.side], { ...context, time: headTime });
  }

  /* ============================================================
     PROXY BOOK PICKER — admin/owner pick which member actually plays.
     Default selection is the current admin (self-book shortcut).
  ============================================================ */
  function openProxyBookPicker(context){
    if (!isAdminLike()) { joinSeat(context); return; }
    sheet.classList.remove('is-mine','is-admin-panel','is-coach-form');
    sheet.classList.add('is-coach-form');
    const sideLabel = context.side === 'top' ? '前場' : '後場';
    /* Eligible players: any approved user. Sort: self first, then by name. */
    const allowed = Object.values(USERS).filter(u =>
      u.status === STATUS.MEMBER || u.status === STATUS.COACH ||
      u.status === STATUS.ADMIN  || u.status === STATUS.OWNER
    ).sort((a,b) => {
      if (a.userId === currentUserId) return -1;
      if (b.userId === currentUserId) return 1;
      return (a.displayName||'').localeCompare(b.displayName||'');
    });
    const rows = allowed.map(u => {
      const meTag = u.userId === currentUserId ? '<span style="font-size:9px; color:var(--ink-mute); margin-left:6px;">(自己)</span>' : '';
      const roleBadge = roleBadgeHTML(u);
      return `
        <button type="button" class="user-row" data-uid="${u.userId}" style="width:100%; background:transparent; border:0; text-align:left; cursor:pointer; padding:10px 4px; border-bottom:0.5px solid rgba(45,61,52,.07);">
          <div class="av" style="background:${u.cl}">${u.ic}${avPicHTML(u)}</div>
          <div class="info">
            <div class="nm">${u.displayName}${meTag} ${roleBadge}</div>
            <div class="uid" style="font-family:inherit; color:var(--ink-soft);">NTRP ${u.ntrp || '—'} · ${u.playCount||0} 次</div>
          </div>
        </button>
      `;
    }).join('');
    sheet.innerHTML = `
      <div class="grab"></div>
      <div style="font-size:15px; font-weight:600; margin-bottom:2px;">幫球友掛單</div>
      <div style="font-size:11px; color:var(--ink-soft); margin-bottom:12px;">
        ${context.court}場 · ${context.time} · ${sideLabel} · 選擇實際打球者
      </div>
      <div style="max-height:60vh; overflow-y:auto;">${rows || '<div class="empty-state">沒有可選擇的會員</div>'}</div>
      <div class="form-actions">
        <button class="secondary" data-act="cancel-proxy">取消</button>
      </div>
    `;
    overlay.classList.add('show');
    sheet.querySelectorAll('button.user-row[data-uid]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.preventDefault(); e.stopPropagation();
        const pid = btn.getAttribute('data-uid');
        /* Self-book shortcut: pass no opt so existing self-book code path runs. */
        if (pid === currentUserId){
          overlay.classList.remove('show');
          joinSeatAt(context);
        } else {
          overlay.classList.remove('show');
          joinSeatAt(context, { playerUid: pid });
        }
      });
    });
    const cancel = sheet.querySelector('[data-act="cancel-proxy"]');
    if (cancel) cancel.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      overlay.classList.remove('show');
    });
  }

  function openStudentPicker(context){
    if (!isAdmin()) return;
    let headTime = context.time;
    const cur = courts[context.court][context.time][context.side];
    if (cur.k === 'coach-tail') headTime = addMin(context.time, -30);
    const head = courts[context.court][headTime][context.side];
    const taken = head.p || [];
    const remaining = MAX_STUDENTS - taken.length;
    const candidates = memberLikeList()
      .filter(u => taken.indexOf(u.userId) < 0 && u.status !== STATUS.BLOCKED && u.userId !== head.coach);

    sheet.classList.remove('is-mine','is-admin-panel');
    sheet.classList.add('is-coach-form');
    let picked = [];

    function refresh(){
      sheet.innerHTML = `
        <div class="grab"></div>
        <div style="font-size:14px; font-weight:600; margin-bottom:4px;">新增學員</div>
        <div style="font-size:11px; color:var(--ink-soft); margin-bottom:12px;">
          ${head.span || ''} · 還可加入 ${remaining - picked.length} 位 (上限 ${MAX_STUDENTS} 人)
        </div>
        <div class="student-grid">
          ${candidates.map(u => `
            <div class="sopt ${picked.indexOf(u.userId)>=0?'on':''}" data-uid="${u.userId}">
              <span class="ca" style="background:${u.cl}">${u.ic}</span>${u.displayName}
            </div>
          `).join('')}
        </div>
        <div class="form-actions">
          <button class="secondary" data-act="cancel">取消</button>
          <button class="primary" data-act="confirm" ${picked.length===0?'disabled':''}>加入 ${picked.length} 位</button>
        </div>
      `;
      sheet.querySelectorAll('.sopt').forEach(b => {
        b.addEventListener('click', () => {
          const id = b.getAttribute('data-uid');
          const at = picked.indexOf(id);
          if (at >= 0) picked.splice(at, 1);
          else if (picked.length < remaining) picked.push(id);
          else showToast(`不能超過 ${remaining} 位`, true);
          refresh();
        });
      });
      sheet.querySelector('[data-act="cancel"]').addEventListener('click', () => {
        openCoach(head, { ...context, time: headTime });
      });
      sheet.querySelector('[data-act="confirm"]').addEventListener('click', () => {
        if (!picked.length) return;
        const tailSlot = courts[context.court][addMin(headTime, 30)];
        head.p = head.p.concat(picked);
        if (tailSlot && tailSlot[context.side] && tailSlot[context.side].k === 'coach-tail'){
          tailSlot[context.side].p = tailSlot[context.side].p.concat(picked);
        }
        showToast(`已加入 ${picked.length} 位學員`);
        openCoach(head, { ...context, time: headTime });
      });
    }
    refresh();
  }

  function openAddCoachSession(){
    if (!isAdmin()) return;
    sheet.classList.remove('is-mine','is-admin-panel');
    sheet.classList.add('is-coach-form');

    const coaches = coachList();
    const state = {
      court: 'A',
      time: TIMES[activeIdx],
      side: 'top',
      coachId: coaches[0] ? coaches[0].userId : '',
      students: []
    };

    function timeOptions(){
      return TIMES.filter(t => {
        const next = addMin(t, 30);
        if (!next || !courts[state.court][next]) return false;
        const a = courts[state.court][t][state.side];
        const b = courts[state.court][next][state.side];
        if (!a || !b) return false;
        return a.k !== 'coach' && a.k !== 'coach-tail' && b.k !== 'coach' && b.k !== 'coach-tail';
      });
    }

    function refresh(){
      const opts = timeOptions();
      if (opts.indexOf(state.time) < 0) state.time = opts[0] || '';
      const eligibleStudents = memberLikeList()
        .filter(u => u.userId !== state.coachId && u.status !== STATUS.BLOCKED);

      sheet.innerHTML = `
        <div class="grab"></div>
        <div style="font-size:15px; font-weight:600; margin-bottom:2px;">新增教練課</div>
        <div style="font-size:11px; color:var(--ink-soft); margin-bottom:14px;">
          僅限管理員 · 1 小時 · 最多 ${MAX_STUDENTS} 位學員
        </div>
        <div class="form-row">
          <label>球場</label>
          <div class="seg">
            <button data-court="A" class="${state.court==='A'?'active':''}">球場 A</button>
            <button data-court="B" class="${state.court==='B'?'active':''}">球場 B</button>
          </div>
        </div>
        <div class="form-row">
          <label>半場 (Half)</label>
          <div class="seg">
            <button data-side="top" class="${state.side==='top'?'active':''}">前場 / 網前</button>
            <button data-side="bottom" class="${state.side==='bottom'?'active':''}">後場 / 底線</button>
          </div>
        </div>
        <div class="form-row">
          <label>教練</label>
          <select id="cf-coach">
            ${coaches.map(c => `<option value="${c.userId}" ${state.coachId===c.userId?'selected':''}>${c.displayName}</option>`).join('')}
          </select>
        </div>
        <div class="form-row">
          <label>開始時間</label>
          <select id="cf-time">
            ${opts.length === 0
              ? `<option value="">此半場無可用時段</option>`
              : opts.map(t => `<option value="${t}" ${state.time===t?'selected':''}>${t} — ${addMin(t,30)} (1h)</option>`).join('')}
          </select>
        </div>
        <div class="form-row">
          <label>學員 (${state.students.length} / ${MAX_STUDENTS})</label>
          <div class="student-grid">
            ${eligibleStudents.map(u => `
              <div class="sopt ${state.students.indexOf(u.userId)>=0?'on':''}" data-sid="${u.userId}">
                <span class="ca" style="background:${u.cl}">${u.ic}</span>${u.displayName}
              </div>
            `).join('')}
          </div>
        </div>
        <div class="form-actions">
          <button class="secondary" data-act="cancel">取消</button>
          <button class="primary" data-act="save" ${!state.time || !state.coachId ? 'disabled':''}>建立教練課</button>
        </div>
      `;

      sheet.querySelectorAll('[data-court]').forEach(b => b.addEventListener('click', () => {
        state.court = b.getAttribute('data-court'); refresh();
      }));
      sheet.querySelectorAll('[data-side]').forEach(b => b.addEventListener('click', () => {
        state.side = b.getAttribute('data-side'); refresh();
      }));
      sheet.querySelector('#cf-coach').addEventListener('change', e => {
        state.coachId = e.target.value;
        state.students = state.students.filter(s => s !== state.coachId);
        refresh();
      });
      const cft = sheet.querySelector('#cf-time');
      if (cft) cft.addEventListener('change', e => { state.time = e.target.value; refresh(); });
      sheet.querySelectorAll('.sopt').forEach(b => {
        b.addEventListener('click', () => {
          const id = b.getAttribute('data-sid');
          const at = state.students.indexOf(id);
          if (at >= 0) state.students.splice(at, 1);
          else if (state.students.length < MAX_STUDENTS) state.students.push(id);
          else showToast(`學員上限 ${MAX_STUDENTS} 位`, true);
          refresh();
        });
      });
      sheet.querySelector('[data-act="cancel"]').addEventListener('click', () => { openAdminPanel(); });
      sheet.querySelector('[data-act="save"]').addEventListener('click', () => { createCoachSession(state); });
    }

    refresh();
    overlay.classList.add('show');
  }

  function createCoachSession(state){
    if (!isAdmin()) return showToast('需要管理員權限', true);
    if (!state.time || !state.coachId) return showToast('資料不完整', true);
    const headTime = state.time;
    const tailTime = addMin(headTime, 30);
    const head = courts[state.court][headTime];
    const tail = courts[state.court][tailTime];
    if (!head || !tail) return showToast('時段無效', true);
    const wiped = (head[state.side].p || []).length + (tail[state.side].p || []).length;
    head[state.side] = {
      k:'coach', coach: state.coachId,
      p: state.students.slice(0, MAX_STUDENTS),
      dur: 60, span: `${headTime} — ${tailTime}`
    };
    tail[state.side] = {
      k:'coach-tail', coach: state.coachId,
      p: state.students.slice(0, MAX_STUDENTS),
      span: `${headTime} — ${tailTime}`
    };
    const coachUser = getUser(state.coachId);
    showToast(`已新增 ${coachUser.displayName} ${headTime} 教練課${wiped?` · 覆蓋 ${wiped} 位舊預約`:''}`);
    openAdminPanel();
    renderApp();
  }

  /* ============================================================
     PUBLIC MEMBER DIRECTORY
  ============================================================ */
  function openPublicDirectory(){
    if (!canBook()){ showToast(bookingRejectMessage(), true); return; }
    sheet.classList.remove('is-mine','is-admin-panel','is-coach-form');
    const adminLike = isAdminLike();
    const visible = Object.values(USERS).filter(u => {
      if (adminLike) return true;
      return u.status === STATUS.MEMBER || u.status === STATUS.COACH ||
             u.status === STATUS.ADMIN  || u.status === STATUS.OWNER;
    }).sort((a,b) => {
      const ord = { owner:0, admin:1, coach:2, member:3, pending:4, blocked:5 };
      const oa = ord[a.status]||9, ob = ord[b.status]||9;
      if (oa !== ob) return oa - ob;
      return (a.displayName||'').localeCompare(b.displayName||'');
    });

    const rows = visible.map(u => {
      const role = roleBadgeHTML(u);
      const strengths = (u.strengths||[]).slice(0,3).map(s => `<span class="strength-tag" style="font-size:9px; padding:2px 7px;">${s}</span>`).join('');
      return `
        <div class="user-row" data-uid="${u.userId}" style="cursor:pointer;">
          <div class="av" style="background:${u.cl}">${u.ic}${avPicHTML(u)}</div>
          <div class="info">
            <div class="nm">${u.displayName} ${role}</div>
            <div class="uid" style="display:flex; gap:6px; align-items:center;">
              <span style="font-family:inherit;color:var(--ink-soft);">NTRP ${u.ntrp || '—'} · ${u.playCount||0} 次</span>
              ${strengths}
            </div>
          </div>
        </div>
      `;
    }).join('');

    sheet.innerHTML = `
      <div class="grab"></div>
      <div class="row">
        <div class="a" style="background:var(--green)">M${avPicHTML(me())}</div>
        <div style="flex:1; min-width:0;">
          <div class="n">會員名單</div>
          <div class="sb">${visible.length} 位 · ${adminLike ? '管理視角 (可看所有狀態)' : '會員視角'}</div>
        </div>
      </div>
      <div style="margin-top:12px;">${ rows || '<div class="empty-state">目前沒有可顯示的成員</div>' }</div>
    `;
    overlay.classList.add('show');

    sheet.querySelectorAll('.user-row[data-uid]').forEach(row => {
      row.addEventListener('click', () => openProfile(row.getAttribute('data-uid'), null));
    });
  }

  /* ============================================================
     ADMIN MASTER PANEL
  ============================================================ */
  let adminTab = 'pending';

  function openAdminPanel(){
    if (!isAdmin()) return;
    if (pendingList().length > 0) adminTab = 'pending';
    sheet.classList.remove('is-mine','is-coach-form');
    sheet.classList.add('is-admin-panel');
    renderAdminPanel();
    overlay.classList.add('show');
  }

  function renderAdminPanel(){
    if (!sheet.classList.contains('is-admin-panel')) return;
    const adm = adminCount();
    const own = ownerCount();
    const pn = pendingList();
    const dir = nonPendingList().sort((a,b) => {
      const ord = { owner:0, admin:1, coach:2, member:3, blocked:4 };
      return (ord[a.status]||9) - (ord[b.status]||9);
    });
    const meIsOwner = isOwner();
    const meBadge = meIsOwner ? '<span class="badge owner">OWNER</span>'
                              : '<span class="badge admin">ADMIN</span>';

    sheet.innerHTML = `
      <div class="grab"></div>
      <div class="row">
        <div class="a" style="background:var(--blue)">${me().ic}${avPicHTML(me())}</div>
        <div style="flex:1; min-width:0;">
          <div class="n">會員管理 ${meBadge}</div>
          <div class="sb">擁有者 ${own} · 管理員 ${adm}/${MAX_ADMINS} · 待審核 ${pn.length}</div>
        </div>
      </div>
      <div class="admin-tabs">
        <button class="${adminTab==='pending'?'active':''}" data-tab="pending">待審核${pn.length?` (${pn.length})`:''}</button>
        <button class="${adminTab==='members'?'active':''}" data-tab="members">成員管理</button>
        <button class="${adminTab==='coach'?'active':''}"   data-tab="coach">教練管理</button>
        <button class="${adminTab==='attend'?'active':''}"  data-tab="attend">出席統計</button>
        <button class="${adminTab==='admins'?'active':''}"  data-tab="admins">管理員設定</button>
      </div>
      <div id="admin-list">${
        adminTab === 'pending' ? renderPendingList(pn) :
        adminTab === 'members' ? renderDirectory(dir)  :
        adminTab === 'coach'   ? renderCoachManagement() :
        adminTab === 'attend'  ? renderAttendanceStats() :
        adminTab === 'admins'  ? renderAdminSettings() :
        renderPendingList(pn)
      }</div>
    `;

    sheet.querySelectorAll('.admin-tabs button').forEach(b => {
      b.addEventListener('click', () => {
        adminTab = b.getAttribute('data-tab');
        renderAdminPanel();
      });
    });
    bindAdminListActions();
  }

  function renderPendingList(list){
    if (!list.length) return `<div class="empty-state">目前沒有待審核的申請</div>`;
    const banner = `<div class="panel-notice" style="background:var(--amber-pale); color:var(--amber); border-color:rgba(200,137,58,.2); margin-bottom:10px;"><strong>有 ${list.length} 位會員等待審核</strong>，請逐一處理。</div>`;
    return banner + list.map(u => `
      <div class="user-row">
        <div class="av" style="background:${u.cl}">${u.ic}${avPicHTML(u)}</div>
        <div class="info">
          <div class="nm">${u.displayName}</div>
          <div class="uid">${u.userId} · ${u.createdAt||''}</div>
        </div>
        <div class="ops">
          <button class="green" data-act="approve" data-uid="${u.userId}">核准</button>
          <button class="red"   data-act="reject"  data-uid="${u.userId}">拒絕</button>
        </div>
      </div>
    `).join('');
  }

  function renderDirectory(list){
    const meIsOwner = isOwner();
    const adminFullGlobal = adminCount() >= MAX_ADMINS;
    return list.map(u => {
      const isMe = u.userId === currentUserId;
      const isOwn = u.status === STATUS.OWNER;
      const isAdminTarget = u.status === STATUS.ADMIN;
      const blocked = u.status === STATUS.BLOCKED;
      const youBadge = isMe ? '<span class="badge mine">YOU</span>' : '';
      const statusBadge = `<span class="badge ${u.status}">${labelForStatus(u.status)}</span>`;

      if (isOwn){
        return `
          <div class="user-row">
            <div class="av" style="background:${u.cl}">${u.ic}${avPicHTML(u)}</div>
            <div class="info">
              <div class="nm">${u.displayName} ${statusBadge} ${youBadge}</div>
              <div class="uid">${u.userId} · NTRP ${u.ntrp || '—'} · ${u.playCount||0} 次</div>
            </div>
            <div class="ops"><span class="lock-note">永久</span></div>
          </div>
        `;
      }

      if (isAdminTarget && !meIsOwner){
        return `
          <div class="user-row">
            <div class="av" style="background:${u.cl}">${u.ic}${avPicHTML(u)}</div>
            <div class="info">
              <div class="nm">${u.displayName} ${statusBadge} ${youBadge}</div>
              <div class="uid">${u.userId} · NTRP ${u.ntrp || '—'} · ${u.playCount||0} 次</div>
            </div>
            <div class="ops"><span class="lock-note">由 OWNER 管理</span></div>
          </div>
        `;
      }

      const adminFull = adminFullGlobal && !isAdminTarget;
      return `
        <div class="user-row">
          <div class="av" style="background:${u.cl}">${u.ic}${avPicHTML(u)}</div>
          <div class="info">
            <div class="nm">${u.displayName} ${statusBadge} ${youBadge}</div>
            <div class="uid">${u.userId} · NTRP ${u.ntrp || '—'} · ${u.playCount||0} 次</div>
          </div>
          <div class="ops">
            ${ blocked
                ? `<button class="green" data-act="unblock" data-uid="${u.userId}">解封</button>`
                : `<button class="red"   data-act="block"   data-uid="${u.userId}" ${isMe?'disabled':''}>封鎖</button>` }
            <button data-act="role-member" data-uid="${u.userId}" ${u.status===STATUS.MEMBER?'disabled':''}>會員</button>
            <button data-act="role-coach"  data-uid="${u.userId}" ${u.status===STATUS.COACH ?'disabled':''}>教練</button>
            ${ meIsOwner
              ? `<button class="blue" data-act="role-admin" data-uid="${u.userId}" ${u.status===STATUS.ADMIN||adminFull?'disabled':''}>管理員</button>`
              : '' }
            ${ canDelete(u.userId)
              ? `<button class="red" data-act="delete" data-uid="${u.userId}" title="刪除此會員">刪除</button>`
              : '' }
          </div>
        </div>
      `;
    }).join('');
  }

  function renderCoachManagement(){
    const sessions = [];
    ['A','B'].forEach(c => {
      TIMES.forEach(t => {
        const slot = courts[c][t]; if (!slot) return;
        ['top','bottom'].forEach(side => {
          const h = slot[side];
          if (h && h.k === 'coach'){
            sessions.push({ court:c, time:t, side, half:h });
          }
        });
      });
    });

    return `
      <button class="add-coach-cta" data-act="add-coach">＋ 新增教練課</button>
      <div style="margin-top:14px; font-size:10px; color:var(--ink-soft); letter-spacing:.08em; text-transform:uppercase;">已排定 (${sessions.length})</div>
      ${ sessions.length === 0
        ? `<div class="empty-state">目前沒有教練課</div>`
        : sessions.map(s => {
            const cu = getUser(s.half.coach) || { displayName:'?', ic:'?', cl:'#888' };
            const sideLabel = s.side === 'top' ? '前場' : '後場';
            return `
              <div class="user-row">
                <div class="av" style="background:#2A4036">${cu.ic}${avPicHTML(cu)}</div>
                <div class="info">
                  <div class="nm">${cu.displayName} <span class="badge coach">COACH</span></div>
                  <div class="uid">球場 ${s.court} · ${sideLabel} · ${s.half.span} · ${s.half.p.length}/${MAX_STUDENTS} 學員</div>
                </div>
                <div class="ops">
                  <button data-act="open-coach" data-court="${s.court}" data-time="${s.time}" data-side="${s.side}">查看</button>
                  <button class="red" data-act="cancel-coach-x" data-court="${s.court}" data-time="${s.time}" data-side="${s.side}">取消</button>
                </div>
              </div>
            `;
          }).join('')
      }
    `;
  }

  /* ============================================================
     ATTENDANCE STATS
  ============================================================ */
  function computeStats(){
    const playingStatuses = [STATUS.MEMBER, STATUS.COACH, STATUS.ADMIN, STATUS.OWNER];
    const playing = Object.values(USERS).filter(u => playingStatuses.indexOf(u.status) >= 0);
    const totalPlayCount = playing.reduce((s,u) => s + (u.playCount||0), 0);
    const sortedDesc = playing.slice().sort((a,b) => (b.playCount||0) - (a.playCount||0));
    const topActive = sortedDesc.slice(0, 5);
    const attentionPool = playing.filter(u => u.status === STATUS.MEMBER || u.status === STATUS.COACH);
    const lowActive = attentionPool.slice().sort((a,b) => (a.playCount||0) - (b.playCount||0)).slice(0, 5);

    let coachSessions = 0;
    let currentBookings = 0;
    ['A','B'].forEach(c => {
      Object.values(courts[c] || {}).forEach(slot => {
        ['top','bottom'].forEach(side => {
          const h = slot[side]; if (!h) return;
          if (h.k === 'coach') coachSessions++;
          if (h.k !== 'coach' && h.k !== 'coach-tail'){
            currentBookings += (h.p || []).length;
          }
        });
      });
    });

    const monthlyAttendance = Math.round(totalPlayCount * 0.25) + currentBookings;

    return {
      totalPlayCount, monthlyAttendance, currentBookings,
      coachSessions, activeMembers: playing.length,
      topActive, lowActive,
      pendingCount: pendingList().length,
      blockedCount: Object.values(USERS).filter(u => u.status === STATUS.BLOCKED).length
    };
  }

  function rankRowHTML(u, idx, opts){
    const max = (opts && opts.max) || 1;
    const pct = Math.max(2, Math.round(((u.playCount||0) / max) * 100));
    const rkCls = idx === 0 ? 'top1' : (idx <= 2 ? 'top'+(idx+1) : '');
    const role = u.status === STATUS.OWNER ? '<span class="badge owner" style="margin-left:6px;">OWNER</span>'
               : u.status === STATUS.COACH ? '<span class="badge coach" style="margin-left:6px;">COACH</span>'
               : u.status === STATUS.ADMIN ? '<span class="badge admin" style="margin-left:6px;">ADMIN</span>' : '';
    const barCls = (opts && opts.barCls) || '';
    return `
      <div class="rank-row">
        <div class="rk ${rkCls}">#${idx+1}</div>
        <div class="av" style="background:${u.cl}">${u.ic}${avPicHTML(u)}</div>
        <div class="nm">${u.displayName}${role}<span class="sub">NTRP ${u.ntrp || '—'}</span></div>
        <div class="bar ${barCls}"><i style="width:${pct}%"></i></div>
        <div class="num">${u.playCount||0}</div>
      </div>
    `;
  }

  function renderAttendanceStats(){
    const s = computeStats();
    const topMax = (s.topActive[0] && s.topActive[0].playCount) || 1;
    return `
      <div class="stats-grid">
        <div class="stat-card"><div class="label">總出席次數</div><div class="value">${s.totalPlayCount}</div><div class="delta">所有成員累計</div></div>
        <div class="stat-card"><div class="label">本月出席</div><div class="value">${s.monthlyAttendance}</div><div class="delta up">▲ 含目前掛牌 ${s.currentBookings}</div></div>
        <div class="stat-card"><div class="label">教練課場次</div><div class="value">${s.coachSessions}</div><div class="delta">已排定</div></div>
        <div class="stat-card"><div class="label">活躍成員</div><div class="value">${s.activeMembers}</div><div class="delta">含教練/管理員</div></div>
      </div>
      <div class="rank-list">
        <div class="title"><span>最活躍成員 · TOP 5</span><span class="hint">total play count</span></div>
        ${ s.topActive.length === 0
          ? `<div class="empty-state" style="padding:14px 0;">尚無資料</div>`
          : s.topActive.map((u,i) => rankRowHTML(u, i, { max: topMax })).join('') }
      </div>
      <div class="rank-list">
        <div class="title"><span>低出席成員 · 需鼓勵</span><span class="hint">play count ascending</span></div>
        ${ s.lowActive.length === 0
          ? `<div class="empty-state" style="padding:14px 0;">尚無資料</div>`
          : s.lowActive.map((u,i) => rankRowHTML(u, i, { max: topMax, barCls: 'amber' })).join('') }
      </div>
      <div class="stats-grid" style="margin-top:4px;">
        <div class="stat-card"><div class="label">待審核</div><div class="value">${s.pendingCount}</div><div class="delta">需要處理</div></div>
        <div class="stat-card"><div class="label">封鎖名單</div><div class="value">${s.blockedCount}</div><div class="delta">無法使用系統</div></div>
      </div>
    `;
  }

  /* ============================================================
     ADMIN SETTINGS
  ============================================================ */
  function renderAdminSettings(){
    const own = isOwner();
    const owners = Object.values(USERS).filter(u => u.status === STATUS.OWNER);
    const admins = Object.values(USERS).filter(u => u.status === STATUS.ADMIN);
    const promoteTargets = Object.values(USERS).filter(u =>
      u.status === STATUS.MEMBER || u.status === STATUS.COACH
    );
    const slotLeft = Math.max(0, MAX_ADMINS - admins.length);

    const ownersHTML = owners.map(u => `
      <div class="rank-row">
        <div class="rk top1">★</div>
        <div class="av" style="background:${u.cl}">${u.ic}${avPicHTML(u)}</div>
        <div class="nm">${u.displayName}<span class="sub">${u.userId === currentUserId ? 'you · 你' : '系統擁有者'}</span></div>
        <div class="lock-note">永久 · 不可變更</div>
      </div>
    `).join('');

    const adminsHTML = admins.length === 0
      ? `<div class="empty-state" style="padding:14px 0;">目前沒有管理員</div>`
      : admins.map(u => `
        <div class="rank-row">
          <div class="rk">A</div>
          <div class="av" style="background:${u.cl}">${u.ic}${avPicHTML(u)}</div>
          <div class="nm">${u.displayName}<span class="sub">NTRP ${u.ntrp || '—'} · ${u.playCount||0} 次</span></div>
          ${ own
            ? `<div class="ops"><button class="danger" data-act="role-member" data-uid="${u.userId}">撤銷</button></div>`
            : `<div class="lock-note">由 OWNER 管理</div>` }
        </div>
      `).join('');

    return `
      <div class="stats-grid">
        <div class="stat-card"><div class="label">OWNER</div><div class="value">${owners.length}</div><div class="delta">系統擁有者</div></div>
        <div class="stat-card"><div class="label">ADMIN ${admins.length}/${MAX_ADMINS}</div><div class="value">${slotLeft}</div><div class="delta">剩餘配額</div></div>
      </div>
      <div class="rank-list">
        <div class="title"><span>OWNER · 系統擁有者</span><span class="hint">不可變更</span></div>
        ${ownersHTML}
      </div>
      <div class="rank-list">
        <div class="title"><span>ADMIN · 管理員 (${admins.length}/${MAX_ADMINS})</span><span class="hint">${own ? '可撤銷' : '唯讀'}</span></div>
        ${adminsHTML}
      </div>
      ${ own
        ? `<div class="promote-form">
            <div class="ttl"><span>升級為管理員</span><span class="hint" style="font-size:9px; color:var(--ink-mute); letter-spacing:.04em;">剩餘 ${slotLeft} 位</span></div>
            ${ slotLeft <= 0
              ? `<div class="empty-state" style="padding:6px 0 0;">已達上限 ${MAX_ADMINS}，請先撤銷既有管理員</div>`
              : `
                <select id="promote-pick">
                  <option value="">— 選擇成員 —</option>
                  ${promoteTargets.map(u => `<option value="${u.userId}">${u.displayName} · ${labelForStatus(u.status)} · ${u.playCount||0} 次</option>`).join('')}
                </select>
                <button data-act="promote-admin" ${promoteTargets.length===0?'disabled':''}>指派為管理員</button>
              ` }
          </div>`
        : `<div class="panel-notice">
            <strong>權限說明：</strong>只有 OWNER 可以升級或撤銷管理員身份。<br>
            如需新增或調整管理員，請聯繫系統擁有者。
          </div>`
      }
    `;
  }

  function bindAdminListActions(){
    sheet.querySelectorAll('#admin-list button').forEach(b => {
      b.addEventListener('click', () => {
        const act = b.getAttribute('data-act');
        const uid = b.getAttribute('data-uid');
        if (act === 'approve')      return approveUser(uid);
        if (act === 'reject')       return rejectUser(uid);
        if (act === 'block')        return blockUser(uid);
        if (act === 'unblock')      return unblockUser(uid);
        if (act === 'delete')       return deleteUser(uid);
        if (act === 'role-member')  return setStatus(uid, STATUS.MEMBER);
        if (act === 'role-coach')   return setStatus(uid, STATUS.COACH);
        if (act === 'role-admin')   return setStatus(uid, STATUS.ADMIN);
        if (act === 'promote-admin'){
          const sel = sheet.querySelector('#promote-pick');
          if (!sel || !sel.value){ showToast('請先選擇成員', true); return; }
          return setStatus(sel.value, STATUS.ADMIN);
        }
        if (act === 'add-coach')    return openAddCoachSession();
        if (act === 'open-coach'){
          const c = b.getAttribute('data-court'),
                t = b.getAttribute('data-time'),
                s = b.getAttribute('data-side');
          return openCoach(courts[c][t][s], { court:c, time:t, side:s });
        }
        if (act === 'cancel-coach-x'){
          const c = b.getAttribute('data-court'),
                t = b.getAttribute('data-time'),
                s = b.getAttribute('data-side');
          cancelCoachSession({ court:c, time:t, side:s });
          openAdminPanel();
        }
      });
    });
  }

  function rerenderAdminPanel(){
    if (sheet.classList.contains('is-admin-panel')) renderAdminPanel();
  }

  /* ============================================================
     BOOKING ACTIONS
  ============================================================ */
  function joinSeat(context){
    if (!canBook()){ showToast(bookingRejectMessage(), true); return; }
    /* Context-targeted path (empty-seat click) — stick to that exact slot. */
    if (context && context.court) return joinSeatAt(context);
    /* "Quick book" path — scan from the nearest UPCOMING bookable slot
       onwards. Pick the first (court, side) where the user isn't already
       on either court and the half has room. */
    let found = null;
    for (let i = 0; i < TIMES.length; i++){
      const t = TIMES[i];
      if (isSlotStarted(t)) continue;             /* skip already-started */
      if (userOnAnyCourtAt(currentUserId, t)) continue; /* user already there */
      let pickHere = null;
      ['A','B'].forEach(c => {
        if (pickHere) return;
        const slot = courts[c][t]; if (!slot) return;
        ['top','bottom'].forEach(k => {
          if (pickHere) return;
          const s = slot[k];
          if (!s || s.k === 'coach' || s.k === 'coach-tail') return;
          if ((s.p || []).indexOf(currentUserId) >= 0) return;
          if ((s.p || []).length < 2){
            pickHere = { court:c, side:k, time:t };
          }
        });
      });
      if (pickHere){ found = pickHere; break; }
    }
    if (!found){
      showToast('目前沒有可用時段，請稍後再試', true);
      return;
    }
    /* Move the visible cursor to the chosen slot so the user sees it. */
    const idx = TIMES.indexOf(found.time);
    if (idx >= 0) activeIdx = idx;
    joinSeatAt(found);
  }

  function joinSeatAt(ctx, opt){
    if (!canBook()){ showToast(bookingRejectMessage(), true); return; }
    /* Time guard — already-ended slots can't be booked. */
    if (isSlotStarted(ctx.time)){ showToast('球賽已開始，請排下一個時段', true); return; }
    /* PROXY-BOOK SUPPORT — admin/owner can pass opt.playerUid to book on
       behalf of a real player. playerUid is the person who actually plays;
       currentUserId becomes the booker recorded in half.b.
       Self-book: opt omitted → playerUid = currentUserId, no half.b entry. */
    const playerUid = (opt && opt.playerUid) || currentUserId;
    const isProxy = playerUid !== currentUserId;
    if (isProxy && !isAdminLike()){
      showToast('只有管理員可以幫他人掛單', true); return;
    }
    /* Validate proxy target — must be an existing approved member-like user. */
    if (isProxy){
      const tgt = USERS[playerUid];
      if (!tgt){ showToast('找不到該會員', true); return; }
      if (tgt.status !== STATUS.MEMBER && tgt.status !== STATUS.COACH &&
          tgt.status !== STATUS.ADMIN && tgt.status !== STATUS.OWNER){
        showToast('此會員狀態無法被掛單', true); return;
      }
    }
    const slot = courts[ctx.court][ctx.time];
    const half = slot[ctx.side];
    if (!half) return;
    if (half.k === 'coach' || half.k === 'coach-tail'){ showToast('教練課時段', true); return; }
    if ((half.p || []).indexOf(playerUid) >= 0){
      showToast(isProxy ? '該球友已在此預約' : '你已在此預約', true); return;
    }
    /* Cross-court uniqueness applies to the PLAYER, not the booker. */
    if (userOnAnyCourtAt(playerUid, ctx.time)){
      showToast(isProxy ? '該球友同一時段已在其他場' : '同一時段只能選擇一個場地', true);
      return;
    }
    const adj = adjacentBookingCount(playerUid, ctx.court, ctx.time);
    if ((half.p || []).length >= 2){
      if (halfHasReplaceable(half) && adj === 0){
        const target = half.replaceable[0];
        /* Proxy can also replace a replaceable booking — pass playerUid through. */
        return replaceBooking(ctx, target, { playerUid });
      }
      showToast('此半場已滿', true); return;
    }
    if (adj >= 2){ showToast('不可連續超過 2 個時段', true); return; }
    half.p = (half.p || []).concat([playerUid]);
    if (isProxy){
      half.b = half.b || {};
      half.b[playerUid] = currentUserId;
    }
    const sideLabel = ctx.side === 'top' ? '前場' : '後場';
    const playerName = (USERS[playerUid] && USERS[playerUid].displayName) || '會員';
    const successMsg = isProxy
      ? `已幫 ${playerName} 預約：${ctx.court}場 ${ctx.time} ${sideLabel}`
      : `預約成功：${ctx.court}場 ${ctx.time} ${sideLabel}`;
    if (adj === 1){
      half.replaceable = (half.replaceable || []).concat([playerUid]);
      showToast(successMsg + '（連續第二格，可被替補）', false);
    } else {
      showToast(successMsg);
    }
    normalizeHalfState(half);
    overlay.classList.remove('show');
    renderApp();
  }

  function replaceBooking(ctx, targetUid, opt){
    if (!canBook()){ showToast(bookingRejectMessage(), true); return; }
    if (isSlotStarted(ctx.time)){ showToast('球賽已開始，請排下一個時段', true); return; }
    const playerUid = (opt && opt.playerUid) || currentUserId;
    const isProxy = playerUid !== currentUserId;
    if (isProxy && !isAdminLike()){ showToast('只有管理員可以幫他人掛單', true); return; }
    const slot = courts[ctx.court][ctx.time];
    const half = slot[ctx.side];
    if (!half || !isReplaceableEntry(half, targetUid)){ showToast('此預約無法被替補', true); return; }
    /* Cross-court uniqueness applies to the incoming PLAYER. */
    if (userOnAnyCourtAt(playerUid, ctx.time)){
      showToast(isProxy ? '該球友同一時段已在其他場' : '同一時段只能選擇一個場地', true);
      return;
    }
    const adj = adjacentBookingCount(playerUid, ctx.court, ctx.time);
    if (adj > 0){ showToast('替補者不能在相鄰時段已有預約', true); return; }
    half.p = (half.p || []).map(x => x === targetUid ? playerUid : x);
    half.replaceable = (half.replaceable || []).filter(x => x !== targetUid);
    /* Clean stale proxy entry for the replaced player, write a new one if proxy. */
    if (half.b){ delete half.b[targetUid]; }
    if (isProxy){
      half.b = half.b || {};
      half.b[playerUid] = currentUserId;
    }
    normalizeHalfState(half);
    const tu = getUser(targetUid);
    showToast(`已替補 ${tu ? tu.displayName : ''} 的位置`);
    overlay.classList.remove('show');
    renderApp();
  }

  function cancelMyBooking(ctx){
    /* Once a slot has begun, the booking is "成立" — nobody can cancel,
       not even admin/owner. Current players are on court and any walk-in
       is a real-world substitution. */
    if (isSlotStarted(ctx.time)){
      showToast('球賽已開始，無法取消預約', true); return;
    }
    const slot = courts[ctx.court][ctx.time];
    const half = slot[ctx.side];
    half.p = (half.p || []).filter(x => x !== currentUserId);
    half.replaceable = (half.replaceable || []).filter(x => x !== currentUserId);
    if (half.b) delete half.b[currentUserId];
    normalizeHalfState(half);
    showToast('已取消你的預約');
    overlay.classList.remove('show');
    renderApp();
  }

  /* ============================================================
     LIFF / LOGIN
  ============================================================ */
  function handleLogin(userId, displayName, pictureUrl){
    if (userId === BOOTSTRAP_ADMIN_ID) {
      if (!USERS[userId]) {
        USERS[userId] = {
          userId,
          displayName: displayName || 'Maverick 小猴',
          ic: 'M', cl: '#4A6B8A',
          pictureUrl: pictureUrl || null,
          status: STATUS.OWNER,
          createdAt: '2026-04-30',
          ntrp: '—', playCount: 0, strengths: []
        };
      } else {
        USERS[userId].status = STATUS.OWNER;
        USERS[userId].displayName = displayName || USERS[userId].displayName;
        USERS[userId].pictureUrl = pictureUrl || USERS[userId].pictureUrl;
      }
      saveUserToFirestore(userId);
      currentUserId = userId;
      refreshDemoBar();
      route();
      return;
    }

    const isFirstLogin = !USERS[userId];
    if (isFirstLogin){
      console.info('[handleLogin] first login → creating PENDING user', userId);
      USERS[userId] = {
        userId,
        displayName: displayName || '新會員',
        ic: (displayName || '新').slice(0,1),
        cl: '#A8A89C',
        pictureUrl: pictureUrl || null,
        status: STATUS.PENDING,
        createdAt: new Date().toISOString().slice(0,10),
        ntrp: '—', playCount: 0, strengths: []
      };
      showToast('已建立帳號 · 等待管理員審核');
    } else {
      console.info('[handleLogin] returning user', userId, '· status=' + USERS[userId].status);
      const u = USERS[userId];
      if (displayName) { u.displayName = displayName; u.ic = displayName.slice(0,1); }
      if (pictureUrl != null) u.pictureUrl = pictureUrl;
    }
    /* Per-user Firestore write — race-free with other devices, so a new
       pending member's record is preserved even if an admin is also writing. */
    saveUserToFirestore(userId);
    persist();
    currentUserId = userId;
    refreshDemoBar();
    route();
  }

  /* ---- LIFF init flow with INVALID_ID_TOKEN loop protection ---- */

  function isInvalidTokenError(e){
    if (!e) return false;
    const code = e.code || '';
    const msg = (e.message || '') + '';
    return /INVALID_ID_TOKEN|invalid_id_token|UNAUTHORIZED|EXPIRED|expired/i.test(code + ' ' + msg);
  }

  function reLoginAfterTokenError(){
    /* Loop guard: only allow ONE auto-recovery per browser tab session.
       Without this, a stale token causes init → recover → init → recover
       indefinitely. */
    try {
      if (sessionStorage.getItem('cb.liffRecovered') === '1'){
        console.warn('[liff] already attempted re-login this session');
        showLiffErrorScreen(
          'LINE 登入持續失敗',
          '請從 LINE 應用內重新開啟，或清除 LINE 暫存後再試'
        );
        return;
      }
      sessionStorage.setItem('cb.liffRecovered', '1');
    } catch(_){}
    try { liff.logout(); } catch(_){}
    try { liff.login(); } catch(_){
      showLiffErrorScreen('LINE 登入逾期，無法自動續登', '請從 LINE 內重新開啟此應用');
    }
  }

  async function initLiff(){
    if (!isLiffEnabled) return false;
    try {
      await liff.init({ liffId: LIFF_ID });
    } catch(e){
      console.error('liff.init failed:', e);
      if (isInvalidTokenError(e)){ reLoginAfterTokenError(); return false; }
      return false;
    }
    if (!liff.isLoggedIn()) {
      /* Same loop guard applies: only auto-redirect to LINE once per session,
         so a broken redirect chain can't keep bouncing. */
      try {
        if (sessionStorage.getItem('cb.liffRedirect') === '1'){
          console.warn('[liff] already redirected this session, stopping loop');
          showLiffErrorScreen(
            'LINE 登入未完成',
            '請從 LINE 應用內重新開啟，或檢查網路'
          );
          return false;
        }
        sessionStorage.setItem('cb.liffRedirect', '1');
      } catch(_){}
      liff.login();
      return false;
    }
    try {
      const profile = await liff.getProfile();
      /* Successful login — clear loop-guard flags so future expired tokens
         in a long-running tab can still be recovered. */
      try {
        sessionStorage.removeItem('cb.liffRecovered');
        sessionStorage.removeItem('cb.liffRedirect');
      } catch(_){}
      handleLogin(profile.userId, profile.displayName, profile.pictureUrl);
      return true;
    } catch(e){
      console.error('liff.getProfile failed:', e);
      if (isInvalidTokenError(e)){ reLoginAfterTokenError(); return false; }
      return false;
    }
  }

  function liffLogout(){
    if (isLiffEnabled && window.liff && liff.isLoggedIn()){
      try { liff.logout(); } catch(e){}
    }
  }  /* ← 原本這個 } 不見了 */

  function showLiffErrorScreen(title, detail){
    let host = document.getElementById('liff-error');
    if (!host){
      host = document.createElement('div');
      host.id = 'liff-error';
      host.style.cssText = 'position:fixed;inset:0;background:#EAE2D2;z-index:300;display:flex;align-items:center;justify-content:center;padding:24px;';
      document.body.appendChild(host);
    }
    host.innerHTML =
      '<div style="max-width:340px;text-align:center;font-family:-apple-system,BlinkMacSystemFont,\'Helvetica Neue\',\'Noto Sans TC\',sans-serif;">' +
        '<div style="width:64px;height:64px;margin:0 auto 18px;border-radius:50%;background:rgba(183,62,62,.14);color:#B73E3E;display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:700;">!</div>' +
        '<h2 style="font-size:18px;margin:0 0 8px;color:#2D3D34;">' + title + '</h2>' +
        '<p style="font-size:12px;color:#6B7E72;line-height:1.6;margin:0 0 14px;">請從 LINE app 內開啟此頁面，或稍後再試。</p>' +
        '<div style="font-family:ui-monospace,monospace;font-size:10px;color:#8A9A8E;background:#FFF;padding:8px 10px;border-radius:6px;margin-bottom:18px;word-break:break-all;">' + detail + '</div>' +
        '<button id="liff-retry" style="background:#2D3D34;color:#EAE2D2;border:0;padding:10px 22px;border-radius:999px;font-size:13px;cursor:pointer;font-family:inherit;">重新嘗試</button>' +
      '</div>';
    document.getElementById('liff-retry').addEventListener('click', () => location.reload());
  }

  function simulateLineLogin(){
    if (isLiffEnabled){
      liff.login();
      return;
    }
    /* Demo fallback (no LIFF) — log in as the OWNER bootstrap so the dev can
       still preview the admin UI. In production with LIFF_ID set this branch
       is never reached. */
    handleLogin(BOOTSTRAP_ADMIN_ID, 'Maverick 小猴', null);
  }

  function simulateNewUserLogin(){
    const ts = Date.now().toString().slice(-7);
    const newUid = 'U9' + ts.padStart(10, '0').slice(-10);
    const newName = '新會員 ' + ts.slice(-3);
    handleLogin(newUid, newName, null);
    showToast(`新使用者 ${newName} 已建立 · 狀態 PENDING`);
  }

  function logout(){
    liffLogout();
    currentUserId = null;
    refreshDemoBar();
    route();
  }

  /* ============================================================
     DEMO BAR
  ============================================================ */
  const demoSel = document.getElementById('demo-user-select');
  const demoWho = document.getElementById('demo-who');

  function refreshDemoBar(){
    demoSel.innerHTML = '<option value="">— 未登入 —</option>' +
      Object.values(USERS)
        .sort((a,b) => a.userId.localeCompare(b.userId))
        .map(u => `<option value="${u.userId}" ${u.userId===currentUserId?'selected':''}>${u.displayName} (${labelForStatus(u.status)})</option>`)
        .join('');
    if (currentUserId && USERS[currentUserId]){
      demoWho.textContent = `${USERS[currentUserId].userId}`;
    } else {
      demoWho.textContent = '—';
    }
  }

  demoSel.addEventListener('change', () => {
    const v = demoSel.value;
    currentUserId = v || null;
    refreshDemoBar();
    route();
  });

  document.getElementById('demo-newuser').addEventListener('click', simulateNewUserLogin);
  document.getElementById('demo-logout').addEventListener('click', logout);
  document.getElementById('line-login').addEventListener('click', simulateLineLogin);

  /* ============================================================
     EVENT WIRING
  ============================================================ */
  document.getElementById('quick').addEventListener('click', () => joinSeat());
  adminBtn.addEventListener('click', openAdminPanel);
  const dirBtn = document.getElementById('directory-open');
  if (dirBtn) dirBtn.addEventListener('click', openPublicDirectory);
  meBtn.addEventListener('click', () => openProfile(currentUserId, null));
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('show'); });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') overlay.classList.remove('show');
    if (!screens.app.classList.contains('active')) return;
    if (e.key === 'ArrowLeft' && activeIdx > 0){ activeIdx--; renderApp(); }
    if (e.key === 'ArrowRight' && activeIdx < TIMES.length - 1){ activeIdx++; renderApp(); }
  });

  /* ============================================================
     INIT
  ============================================================ */
  function emptyCourtsForToday(){
    ['A','B'].forEach(c => {
      courts[c] = {};
      TIMES.forEach(t => { courts[c][t] = { top:{k:'open',p:[]}, bottom:{k:'open',p:[]} }; });
    });
  }

  function initFromStorage(){
    const rawU = safeGet(STORAGE_KEYS.USERS);
    if (rawU){
      try {
        const saved = JSON.parse(rawU);
        if (saved && typeof saved === 'object'){
          Object.keys(USERS).forEach(k => delete USERS[k]);
          Object.assign(USERS, saved);
        }
      } catch(_){}
    }
    if (!USERS[BOOTSTRAP_ADMIN_ID]){
      USERS[BOOTSTRAP_ADMIN_ID] = {
        userId: BOOTSTRAP_ADMIN_ID,
        displayName: 'Maverick 小猴',
        ic: 'M', cl: '#4A6B8A',
        status: STATUS.OWNER,
        createdAt: '2026-04-30',
        ntrp: '—', playCount: 0, strengths: []
      };
    } else if (USERS[BOOTSTRAP_ADMIN_ID].status !== STATUS.OWNER){
      USERS[BOOTSTRAP_ADMIN_ID].status = STATUS.OWNER;
    }

    /* Attendance Set comes from localStorage. Records persist across days
       — date is part of the key, so old days don't clash with today. */
    loadAttendance();

    /* Use the play-date (19:00 flip) for courts boundary, NOT the calendar
       date. After 19:00, today's courts are no longer relevant — the system
       has moved on to tomorrow's slot board. */
    const today = systemDateISO();
    const savedDate = safeGet(STORAGE_KEYS.SCHEDULE);
    const rawC = safeGet(STORAGE_KEYS.COURTS);
    if (savedDate === today && rawC){
      try {
        const saved = JSON.parse(rawC);
        if (saved && typeof saved === 'object'){
          ['A','B'].forEach(c => {
            if (saved[c]) courts[c] = saved[c];
            TIMES.forEach(t => {
              if (!courts[c][t]) courts[c][t] = { top:{k:'open',p:[]}, bottom:{k:'open',p:[]} };
            });
          });
        }
      } catch(_){}
    } else if (savedDate && savedDate !== today && rawC){
      /* Stale courts from a previous play day — record everything as ended
         under that date BEFORE wiping, so attendance isn't lost. */
      try {
        const saved = JSON.parse(rawC);
        if (saved && typeof saved === 'object'){
          recordFromCourts(saved, savedDate, TIMES.length);
        }
      } catch(_){}
      emptyCourtsForToday();
    } else {
      emptyCourtsForToday();
    }

    /* Catch up on anything that already ended today before this load. */
    processEndedSlots();

    saveScheduleDate(today);
    /* IMPORTANT: do NOT call persist() here. persist() writes to Firestore,
       and at this point the courts listener hasn't fired yet, so writing
       would blast our stale localStorage cache over the cloud — that's the
       exact race that caused multi-device sync to fail (Device A's old
       localStorage overwriting Device B's recent bookings). The cloud
       Firestore courts listener will hydrate in-memory courts within ~200ms
       of boot; until then localStorage cache is just for fast UI feedback,
       NOT a source we ever push back to cloud. */
    saveUsers();
    saveCourts();
    saveAttendance();
  }

  /* ============================================================
     FIRESTORE LIVE SYNC — pull remote USERS in real time so admins see
     a new pending member the moment that member's LINE login writes.
     Snapshot-doc model only (no schema change this round). Admin panel +
     app screen re-render on any merged remote change.
  ============================================================ */
  let _usersSnapshotUnsubscribe = null;
  function startUsersListener(){
    if (typeof db === 'undefined' || !db || !db.collection) return;
    if (_usersSnapshotUnsubscribe) return;
    try {
      /* Listen to the entire users collection. Each snapshot is treated as
         the authoritative state — local USERS is reconciled to match. */
      _usersSnapshotUnsubscribe = db.collection('users').onSnapshot(
        snap => {
          const remote = {};
          snap.forEach(doc => {
            const data = doc.data();
            /* Skip the legacy users/snapshot doc (shape: { data: {...} }) and
               any other malformed doc. Real user docs always have a userId
               field matching their doc.id. */
            if (!data || typeof data !== 'object') return;
            if (doc.id === 'snapshot') return;
            if (data.userId !== doc.id) return;
            remote[doc.id] = data;
          });
          let changed = false;
          Object.keys(remote).forEach(uid => {
            const r = remote[uid];
            const l = USERS[uid];
            if (!l || JSON.stringify(l) !== JSON.stringify(r)){
              USERS[uid] = r; changed = true;
            }
          });
          /* Drop locally-cached users that no longer exist remotely.
             Never drop OWNER bootstrap. */
          Object.keys(USERS).forEach(uid => {
            if (!(uid in remote) && uid !== BOOTSTRAP_ADMIN_ID){
              delete USERS[uid]; changed = true;
            }
          });
          /* Self-heal OWNER status no matter what remote claims. */
          if (USERS[BOOTSTRAP_ADMIN_ID] && USERS[BOOTSTRAP_ADMIN_ID].status !== STATUS.OWNER){
            USERS[BOOTSTRAP_ADMIN_ID].status = STATUS.OWNER;
            changed = true;
            saveUserToFirestore(BOOTSTRAP_ADMIN_ID);
          }
          if (!changed) return;
          /* Mirror to localStorage cache so reloads show fresh data instantly. */
          try { saveUsers(); } catch(_){}
          /* Re-render the views that depend on USERS. */
          if (screens.app && screens.app.classList.contains('active')){
            try { renderApp(); } catch(_){}
          }
          if (sheet && sheet.classList && sheet.classList.contains('is-admin-panel')){
            try { renderAdminPanel(); } catch(_){}
          }
        },
        err => { console.warn('users onSnapshot error:', err && err.message); }
      );
    } catch(e){
      console.warn('startUsersListener failed:', e && e.message);
    }
  }

  /* ============================================================
     COURTS LIVE SYNC — per-play-day documents
     Reads from db.collection('courts').doc(_currentPlayDate). Each play
     day has its own doc, so:
       - History is preserved naturally (yesterday's doc stays in Firestore)
       - 19:00 flip just switches subscription to tomorrow's doc
       - Legacy courts/main is left untouched (never read/written)
  ============================================================ */
  let _courtsSnapshotUnsubscribe = null;
  let _lastCourtsRemoteJson = '';
  function startCourtsListener(){
    if (typeof db === 'undefined' || !db || !db.collection) return;
    const targetDate = systemDateISO();
    /* Already subscribed to today's doc — no-op. */
    if (_courtsSnapshotUnsubscribe && _currentPlayDate === targetDate) return;
    /* Unsubscribe from any previous day's doc. */
    if (_courtsSnapshotUnsubscribe){
      try { _courtsSnapshotUnsubscribe(); } catch(_){}
      _courtsSnapshotUnsubscribe = null;
    }
    /* Reset every state that's tied to a specific doc. */
    _currentPlayDate = targetDate;
    _courtsListenerFired = false;
    _lastCourtsRemoteJson = '';
    _lastCourtsWrittenJson = '';
    /* Wipe local in-memory courts — previous play day's data must not
       leak into today's view while we wait for onSnapshot. */
    emptyCourtsForToday();
    try { saveCourts(); } catch(_){}

    const docPath = 'courts/' + _currentPlayDate;
    console.info('[firestore] subscribing to ' + docPath);
    try {
      _courtsSnapshotUnsubscribe = db.collection('courts').doc(_currentPlayDate).onSnapshot(
        snap => {
          _courtsListenerFired = true;
          const data = snap && snap.data && snap.data();
          if (!data || !data.data || typeof data.data !== 'object'){
            console.info('[firestore] ' + docPath + ' empty or missing; will create on first write');
            _lastCourtsRemoteJson = JSON.stringify({});
            return;
          }
          const remote = data.data;
          const remoteJson = JSON.stringify(remote);
          if (remoteJson === _lastCourtsRemoteJson) return;
          _lastCourtsRemoteJson = remoteJson;
          console.info('[firestore] ' + docPath + ' remote update · ' + remoteJson.length + ' chars');
          ['A','B'].forEach(c => {
            if (remote[c]) courts[c] = remote[c];
            if (!courts[c]) courts[c] = {};
            TIMES.forEach(t => {
              if (!courts[c][t]) courts[c][t] = { top:{k:'open',p:[]}, bottom:{k:'open',p:[]} };
            });
          });
          try { saveCourts(); } catch(_){}
          _lastCourtsWrittenJson = JSON.stringify(courts);
          if (screens.app && screens.app.classList.contains('active')){
            try { renderApp(); } catch(_){}
          }
        },
        err => {
          console.error('[firestore] ' + docPath + ' onSnapshot error:', err && (err.code || err.message), err);
        }
      );
    } catch(e){
      console.warn('startCourtsListener failed:', e && e.message);
    }
  }

  /* Day-flip detector — call periodically (60s ticker). If the play date
     advanced past 19:00 boundary, flush attendance for the OUTGOING day,
     then resubscribe to the new day's doc. */
  function checkPlayDateFlip(){
    const newDate = systemDateISO();
    if (_currentPlayDate && _currentPlayDate !== newDate){
      console.info('[playDate] flip', _currentPlayDate, '→', newDate);
      /* Flush any still-pending attendance under the OUTGOING play date
         before we drop the in-memory courts. */
      try { recordFromCourts(courts, _currentPlayDate, TIMES.length); } catch(_){}
      try { saveAttendance(); } catch(_){}
      saveAttendanceToFirestoreIfChanged();
      /* Resubscribe to the new day's doc; resets all _courts* flags. */
      startCourtsListener();
      if (screens.app && screens.app.classList.contains('active')){
        try { renderApp(); } catch(_){}
      }
    }
  }

  async function boot(){
    initFromStorage();
    refreshDemoBar();
    /* Replay any Firestore writes that were queued before db was ready. */
    _flushPendingFsOps();
    /* Tidy the legacy users/snapshot doc — per-user docs are now canonical. */
    cleanupLegacyUsersSnapshot();
    /* Subscribe to remote USERS so admins see new pending members live. */
    startUsersListener();
    /* Subscribe to remote COURTS so every member sees the same board. */
    startCourtsListener();
    /* Real-time tick: every 60 s re-render the slots/marker, check for
       newly-ended slots, AND check for 19:00 play-date flip. */
    setInterval(() => {
      checkPlayDateFlip();
      if (screens.app.classList.contains('active')){
        processEndedSlots();
        renderApp();
      }
    }, 60000);
    if (isLiffEnabled){
      const bar = document.querySelector('.demo-bar');
      if (bar) bar.style.display = 'none';
      const ok = await initLiff();
      if (ok) return;
    }
    route();
  }

  /* ============================================================
     FIREBASE 初始化
  ============================================================ */
  const firebaseConfig = {
    apiKey: "AIzaSyBrqZAvkN57jGx5LNOMtquWzK3YQ1QLFQ",
    authDomain: "court-board-c1e29.firebaseapp.com",
    projectId: "court-board-c1e29",
    storageBucket: "court-board-c1e29.firebasestorage.app",
    messagingSenderId: "337148491014",
    appId: "1:337148491014:web:33cab9162b64afad045a87"
  };

  const firebaseApp = firebase.initializeApp(firebaseConfig);
  const db = firebase.firestore();

  boot();

})();
