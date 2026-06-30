/* ════════════════════════════════════════════════════════════
   ZCLOCK  script.js  — Phase 5
   Spec 70: Full Firebase Firestore cross-device sync
   Members, HP, sessions — all live in Firestore.
   localStorage = UI settings only (theme, nav state).
   ════════════════════════════════════════════════════════════ */
'use strict';

/* ─── LocalStorage helper — UI SETTINGS ONLY ─── */
const LS = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del: (k)    => { try { localStorage.removeItem(k); } catch {} },
};

/* ─────────────────────────────────────────────────────────
   FIRESTORE BRIDGE
   All member data reads/writes go through here.
   Firebase is initialized by firebase-config.js (loaded first).
   ───────────────────────────────────────────────────────── */
const FSB = {
  _db:   () => { if (typeof firebase==='undefined'||!firebase.apps||!firebase.apps.length) return null; return firebase.firestore(); },
  _auth: () => { if (typeof firebase==='undefined'||!firebase.apps||!firebase.apps.length) return null; return firebase.auth(); },
  uid:   () => localStorage.getItem('zc_uid') || null,

  async getAllMembers() {
    const db = this._db(); if (!db) return [];
    try { const s=await db.collection('members').get(); return s.docs.map(d=>({uid:d.id,...d.data()})); }
    catch(e) { console.error('[FSB] getAllMembers:',e.message); return []; }
  },
  async getMember(uid) {
    const db = this._db(); if (!db||!uid) return null;
    try { const d=await db.collection('members').doc(uid).get(); return d.exists?{uid,...d.data()}:null; }
    catch(e) { console.error('[FSB] getMember:',e.message); return null; }
  },
  async getMemberByUsername(username) {
    const db = this._db(); if (!db) return null;
    try { const s=await db.collection('members').where('username','==',username).limit(1).get(); return s.empty?null:{uid:s.docs[0].id,...s.docs[0].data()}; }
    catch(e) { console.error('[FSB] getMemberByUsername:',e.message); return null; }
  },
  async saveMember(uid, data) {
    const db = this._db(); if (!db||!uid) return;
    try { await db.collection('members').doc(uid).set({...data,lastUpdated:new Date().toISOString()},{merge:true}); }
    catch(e) { console.error('[FSB] saveMember:',e.message); }
  },
  async deleteMember(uid) {
    const db = this._db(); if (!db||!uid) return;
    try { await db.collection('members').doc(uid).delete(); }
    catch(e) { console.error('[FSB] deleteMember:',e.message); }
  },
  listenMembers(callback) {
    const db = this._db();
    if (!db) { callback([],'Firebase not configured'); return ()=>{}; }
    return db.collection('members').onSnapshot(
      s => callback(s.docs.map(d=>({uid:d.id,...d.data()})),null),
      e => { console.error('[FSB] listenMembers:',e.message); callback([],e.message); }
    );
  },
  async getCollection(col, orderField=null, limitN=500) {
    const db = this._db(); if (!db) return [];
    try {
      let q=db.collection(col);
      if(orderField) q=q.orderBy(orderField,'desc');
      if(limitN) q=q.limit(limitN);
      const s=await q.get(); return s.docs.map(d=>({id:d.id,...d.data()}));
    } catch(e) { console.error('[FSB] getCollection',col,e.message); return []; }
  },
  async saveDoc(col,id,data) {
    const db = this._db(); if (!db) return;
    try { await db.collection(col).doc(id).set(data,{merge:true}); }
    catch(e) { console.error('[FSB] saveDoc',col,e.message); }
  },
  async addDoc(col,data) {
    const db = this._db(); if (!db) return null;
    try { return await db.collection(col).add({...data,ts:Date.now()}); }
    catch(e) { console.error('[FSB] addDoc',col,e.message); return null; }
  },
  async deleteDoc(col,id) {
    const db = this._db(); if (!db) return;
    try { await db.collection(col).doc(id).delete(); }
    catch(e) { console.error('[FSB] deleteDoc',col,e.message); }
  },
  listenCollection(col,callback) {
    const db = this._db();
    if (!db) { callback([],'Firebase not configured'); return ()=>{}; }
    return db.collection(col).onSnapshot(
      s=>callback(s.docs.map(d=>({id:d.id,...d.data()})),null),
      e=>callback([],e.message)
    );
  }
};

/* ── In-memory cache (filled from Firestore on app start) ── */
let _memberCache   = null;      // { uid: memberObj }
let _currentMemberObj = null;
let _adminMembersListener = null;

async function _loadCurrentMember() {
  const uid = FSB.uid(); if (!uid) return null;
  const m = await FSB.getMember(uid);
  _currentMemberObj = m;
  if (m) {
    if (!_memberCache) _memberCache = {};
    _memberCache[uid] = m;
  }
  return m;
}

/* ════════════════════════════════════════════════════════════
   DB — Firestore-backed central data store
   Members/HP/Evidence/Reports: Firestore.
   Game questions/content settings: localStorage (admin device).
   ════════════════════════════════════════════════════════════ */
const DB = {
  /* ── Members ── */
  getMembers: () => {
    const raw = _memberCache ? Object.values(_memberCache) : LS.get('zc_members_cache',[]);
    const seen = new Set();
    return raw.filter(m => {
      const k = m.uid || m.username;
      if(!k || seen.has(k)) return false;
      seen.add(k); return true;
    });
  },
  saveMembers: (arr) => { arr.forEach(m => { if (m&&m.uid) FSB.saveMember(m.uid,m).catch(()=>{}); }); },
  getMember: (username) => {
    if (_memberCache) { const f=Object.values(_memberCache).find(m=>m.username===username); if(f) return f; }
    return null;
  },
  saveMember: (m) => {
    if (!m||m.isAdmin) return;
    m.lastActive = new Date().toISOString();
    const uid = m.uid || FSB.uid();
    if (!uid) return;
    if (_memberCache) _memberCache[uid] = {...(_memberCache[uid]||{}),...m};
    FSB.saveMember(uid,m).catch(e=>console.error('[DB] saveMember async:',e.message));
    if (_currentMemberObj&&(_currentMemberObj.uid===uid||_currentMemberObj.username===m.username)) {
      _currentMemberObj = {..._currentMemberObj,...m};
    }
  },
  /* ── Notifications ── */
  getNotifs: () => LS.get('zc_notifications_cache',[]),
  addNotif: (type,text,meta={}) => {
    const n=DB.getNotifs();
    n.unshift({id:Date.now(),type,text,meta,time:new Date().toISOString(),read:false});
    if(n.length>500) n.splice(500);
    LS.set('zc_notifications_cache',n);
    updateNotifBadge();
    FSB.addDoc('notifications',{type,text,meta,time:new Date().toISOString(),read:false}).catch(()=>{});
  },
  /* ── Evidence ── */
  getEvidence: () => LS.get('zc_evidence_cache',[]),
  saveEvidence: (arr) => {
    LS.set('zc_evidence_cache',arr);
    // Save to both individual docs AND content collection for admin access
    arr.forEach(e=>FSB.saveDoc('evidence',String(e.id||e.ts||Date.now()),e).catch(()=>{}));
    FSB.saveDoc('content','evidence',{items:arr,updatedAt:new Date().toISOString()}).catch(()=>{});
  },
  /* ── Reports ── */
  getReports: () => LS.get('zc_reports_cache',[]),
  saveReports: (arr) => {
    LS.set('zc_reports_cache',arr);
    arr.forEach(r=>FSB.saveDoc('reports',String(r.id||r.ts||Date.now()),r).catch(()=>{}));
    FSB.saveDoc('content','reports',{items:arr,updatedAt:new Date().toISOString()}).catch(()=>{});
  },
  /* ── Content: localStorage + Firebase realtime collections ── */
  getMissions:       ()    => LS.get('zc_missions',[]),
  saveMissions:      (arr) => {
    LS.set('zc_missions',arr);
    var _db=FSB._db(); if(_db) _db.collection('missions').doc('_index').set({items:arr,updatedAt:new Date().toISOString()}).catch(function(){});
  },
  getTracks:         ()    => LS.get('zc_tracks',[]),
  saveTracks:        (arr) => {
    LS.set('zc_tracks',arr);
    var _db=FSB._db(); if(_db) _db.collection('tracks').doc('_index').set({items:arr,updatedAt:new Date().toISOString()}).catch(function(){});
  },
  getAlbums:         ()    => LS.get('zc_albums',[]),
  saveAlbums:        (arr) => {
    LS.set('zc_albums',arr);
    var _db=FSB._db(); if(_db) _db.collection('albums').doc('_index').set({items:arr,updatedAt:new Date().toISOString()}).catch(function(){});
  },
  getCards:          ()    => LS.get('zc_battle_cards',[]),
  saveCards:         (arr) => {
    LS.set('zc_battle_cards',arr);
    var _db=FSB._db(); if(_db) _db.collection('bbcCards').doc('_index').set({items:arr,updatedAt:new Date().toISOString()}).catch(function(){});
  },
  getPicCards:       ()    => LS.get('zc_picture_cards',[]),
  savePicCards:      (arr) => {
    LS.set('zc_picture_cards',arr);
    var _db=FSB._db(); if(_db) _db.collection('pictureCards').doc('_index').set({items:arr,updatedAt:new Date().toISOString()}).catch(function(){});
  },
  getCardMissions:   ()    => LS.get('zc_card_missions',[]),
  saveCardMissions:  (arr) => {
    LS.set('zc_card_missions',arr);
    var _db=FSB._db(); if(_db) _db.collection('cardMissions').doc('_index').set({items:arr,updatedAt:new Date().toISOString()}).catch(function(){});
  },
  getCPRQuestions:   ()    => LS.get('zc_game_cpr',DEFAULT_CPR),
  saveCPRQuestions:  (arr) => {
    LS.set('zc_game_cpr',arr);
    var _db=FSB._db(); if(_db) _db.collection('purpleCprQuestions').doc('_index').set({items:arr,updatedAt:new Date().toISOString()}).catch(function(){});
  },
  getDLDQuestions:   ()    => LS.get('zc_game_dld',DEFAULT_DLD),
  saveDLDQuestions:  (arr) => {
    LS.set('zc_game_dld',arr);
    var _db=FSB._db(); if(_db) _db.collection('dldQuestions').doc('_index').set({items:arr,updatedAt:new Date().toISOString()}).catch(function(){});
  },
  getJHopeQuestions: ()    => LS.get('zc_game_jhope',DEFAULT_JHOPE),
  saveJHopeQuestions:(arr) => {
    LS.set('zc_game_jhope',arr);
    var _db=FSB._db(); if(_db) _db.collection('jhopeTimeQuestions').doc('_index').set({items:arr,updatedAt:new Date().toISOString()}).catch(function(){});
  },
  getAnns:           ()    => LS.get('zc_announcements',[]),
  saveAnns:          (arr) => {
    LS.set('zc_announcements',arr);
    var _db=FSB._db(); if(_db) _db.collection('announcements').doc('_index').set({items:arr,updatedAt:new Date().toISOString()}).catch(function(){});
  },
  getPlaylists:      ()    => LS.get('zc_playlists',[]),
  savePlaylists:     (arr) => {
    LS.set('zc_playlists',arr);
    var _db=FSB._db(); if(_db) _db.collection('playlists').doc('_index').set({items:arr,updatedAt:new Date().toISOString()}).catch(function(){});
  },
  getHelpline:       ()    => LS.get('zc_helpline',[]),
  saveHelpline:      (arr) => {
    LS.set('zc_helpline',arr);
    var _db=FSB._db(); if(_db) _db.collection('helpline').doc('_index').set({items:arr,updatedAt:new Date().toISOString()}).catch(function(){});
  },
  getBattles:        ()    => LS.get('zc_battles',[]),
  saveBattles:       (arr) => {
    LS.set('zc_battles',arr);
    var _db=FSB._db(); if(_db) _db.collection('battles').doc('_index').set({items:arr,updatedAt:new Date().toISOString()}).catch(function(){});
  },
  getChat:           ()    => LS.get('zc_chat',[]),
  saveChat:          (arr) => { LS.set('zc_chat',arr); },
  getSettings: () => {
    const uid = FSB.uid() || (isAdmin() ? '__admin__' : 'guest');
    return LS.get('zc_settings_' + uid, {});
  },
  saveSettings: (obj) => {
    const uid = FSB.uid() || (isAdmin() ? '__admin__' : 'guest');
    LS.set('zc_settings_' + uid, obj);
  },
};

/* ─── Auth ─── */
function getCurrentUser() {
  if (isAdmin()) return {username:'__admin__',isAdmin:true,hp:0,totalHp:0,streams:0,team:'Admin'};
  if (_currentMemberObj) return _currentMemberObj;
  const u = LS.get('zc_user',null); if (!u) return null;
  return DB.getMember(u) || {username:u,hp:0,totalHp:0,streams:0};
}
function isAdmin() { const v=LS.get('zc_is_admin',false); return v===true||v==='true'; }
function authGuard() {
  if (!document.getElementById('bottom-nav')) return;
  if (!FSB.uid()&&!isAdmin()) window.location.href='login.html';
}
function doLogout() {
  const auth=FSB._auth(); if(auth) auth.signOut().catch(()=>{});
  LS.del('zc_uid'); LS.del('zc_user'); LS.del('zc_is_admin');
  _currentMemberObj=null; _memberCache=null;
  if(_adminMembersListener){_adminMembersListener();_adminMembersListener=null;}
  window.location.href='login.html';
}
function logAction(username,category,action,details={}) {
  if(!username||username==='__admin__') return;
  FSB.addDoc('actionLog',{username,category,action,details,time:new Date().toISOString()}).catch(()=>{});
  const m=DB.getMember(username);
  if(m){m.lastActive=new Date().toISOString();DB.saveMember(m);}
}
function resetTour() {
  const user = getCurrentUser();
  if (user) localStorage.removeItem('zc_tour_done_' + user.username);
  if (typeof startTour === 'function') startTour();
  else showToast('Reload page to start tour.', 'info');
}

/* ─── HP Constants (balanced) ─── */
const HP = {
  VOTE: 2, MISSION_SM: 3, MISSION_MD: 8, MISSION_LG: 13, MISSION_SP: 20,
  GAME_CPR: 5, GAME_DLD: 5, GAME_JHOPE: 6,
  ATTENDANCE: 1, EVIDENCE: 10, STREAK_BONUS: 3, TEAM_MILESTONE: 5, CARD_DAILY: 2,
};

/* ─── Award HP ─── */
const HP_BREAKDOWN_KEY={streaming:'hpStreaming',voting:'hpVoting',missions:'hpMissions',games:'hpGames',attendance:'hpAttendance',bonus:'hpBonus',video:'hpVideo'};
const HP_WEEKLY_KEY={streaming:'weeklyHpStreaming',voting:'weeklyHpVoting',missions:'weeklyHpMissions',games:'weeklyHpGames',attendance:'weeklyHpAttendance',bonus:'weeklyHpBonus',video:'weeklyHpVideo'};

function _earnHP(user,amount,category,reason){
  if(!user||user.isAdmin)return 0;
  amount=Math.min(20,Math.max(1,Math.round(amount)));
  const prevTotal=user.totalHp||0;const prevWeekly=user.hp||0;
  if(prevTotal<prevWeekly)user.totalHp=prevWeekly;
  user.hp=(prevWeekly)+amount;user.weeklyHp=user.hp;
  user.totalHp=(user.totalHp||0)+amount;
  const bKey=HP_BREAKDOWN_KEY[category]||'hpBonus';const wKey=HP_WEEKLY_KEY[category]||'weeklyHpBonus';
  user[bKey]=(user[bKey]||0)+amount;user[wKey]=(user[wKey]||0)+amount;
  user.hpLog=user.hpLog||[];
  user.hpLog.unshift({id:Date.now(),type:category||'general',reason:reason||'',amount,prevTotalHp:prevTotal,newTotalHp:user.totalHp,prevWeeklyHp:prevWeekly,newWeeklyHp:user.hp,date:new Date().toISOString()});
  if(user.hpLog.length>200)user.hpLog.splice(200);
  DB.saveMember(user);
  const db=FSB._db();const uid=FSB.uid();
  if(db&&uid)db.collection('hpTransactions').add({memberUid:uid,username:user.username,type:category||'general',reason:reason||'',amount,prevTotalHp:prevTotal,newTotalHp:user.totalHp,date:new Date().toISOString()}).catch(()=>{});
  showHPPopup(amount);
  DB.addNotif('hp',`${user.username} earned +${amount} HP: ${reason||category}`);
  logAction(user.username,category||'general',`+${amount} HP`,{reason,amount});
  refreshTopBar();
  return amount;
}

function awardHP(amount,reason,category='general'){
  const user=getCurrentUser();if(!user||user.isAdmin)return;
  _earnHP(user,amount,category,reason);
  checkTeamMilestone(user);
  showToast(`+${amount} HP — ${reason}`,'success');
}

function showHPPopup(n) {
  const el = document.createElement('div');
  el.className = 'hp-popup';
  el.textContent = `+${n} HP ✨`;
  el.style.cssText = `left:${30 + Math.random() * 40}%;top:${25 + Math.random() * 30}%`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1500);
}

function checkTeamMilestone(user) {
  const members = DB.getMembers().filter(m => m.team === user.team);
  const teamHP = members.reduce((s, m) => s + (m.hp || 0), 0);
  const ml = LS.get('zc_team_milestones', {});
  const key = user.team + '_500';
  if (teamHP >= 500 && !ml[key]) {
    ml[key] = true;
    LS.set('zc_team_milestones', ml);
    const arr = DB.getMembers();
    arr.filter(m => m.team === user.team).forEach(m => {
      m.hp = (m.hp || 0) + HP.TEAM_MILESTONE;
      m.totalHp = (m.totalHp || 0) + HP.TEAM_MILESTONE;
    });
    DB.saveMembers(arr);
    showToast(`🏆 ${user.team} hit 500 HP! +${HP.TEAM_MILESTONE} HP for all members!`, 'success');
    DB.addNotif('milestone', `${user.team} reached 500 HP milestone!`);
  }
}

/* ─── Notifications ─── */
function addNotification(type, text, meta = {}) { DB.addNotif(type, text, meta); }
function updateNotifBadge() {
  const n = DB.getNotifs();
  const dot = document.getElementById('notif-dot');
  const bellBtn = document.getElementById('notif-btn') || document.querySelector('.notif-bell');
  // Hide bell entirely for non-admin
  if (!isAdmin()) {
    if (bellBtn) bellBtn.style.display = 'none';
    if (dot) dot.style.display = 'none';
    return;
  }
  if (dot) { dot.classList.toggle('show', n.filter(x => !x.read).length > 0); }
}

/* ─── Toast ─── */
function showToast(msg, type = 'info') {
  const c = document.getElementById('toast-container');
  if (!c) return;
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

/* ─── Theme ─── */
const THEMES = ['golden-stardust', 'young-forever', 'blue-hour', 'borahae'];
const THEME_NAMES = { 'golden-stardust': '✨ Golden Stardust', 'young-forever': '🖤 Young Forever', 'blue-hour': '🌙 Blue Hour', 'borahae': '💜 Borahae' };
function applyTheme(t) { if (!THEMES.includes(t)) t = 'golden-stardust'; document.documentElement.setAttribute('data-theme', t); LS.set('zc_theme', t); }
function loadTheme() { applyTheme(LS.get('zc_theme', 'golden-stardust')); }

/* ─── Stars ─── */
function initStars() {
  const cv = document.getElementById('stars-canvas'); if (!cv) return;
  const ctx = cv.getContext('2d'); let S = [], W, H;
  const resize = () => { W = cv.width = innerWidth; H = cv.height = innerHeight; S = Array.from({ length: 130 }, () => ({ x: Math.random() * W, y: Math.random() * H, r: Math.random() * 1.6 + 0.3, ph: Math.random() * Math.PI * 2, sp: Math.random() * 0.008 + 0.003 })); };
  const draw = t => {
    ctx.clearRect(0, 0, W, H);
    const cm = { 'golden-stardust': '196,142,100', 'young-forever': '220,220,220', 'blue-hour': '130,180,255', 'borahae': '180,150,230' };
    const c = cm[document.documentElement.getAttribute('data-theme')] || '196,142,100';
    S.forEach(s => { const a = .15 + .85 * (.5 + .5 * Math.sin(t * s.sp + s.ph)); ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fillStyle = `rgba(${c},${a.toFixed(2)})`; ctx.fill(); });
    requestAnimationFrame(draw);
  };
  resize(); window.addEventListener('resize', resize); requestAnimationFrame(draw);
}

/* ─── Quotes ─── */
const QUOTES = ['Every second with you, counts for forever. 💜', 'Stream with your heart. Your love is BTS\'s power.', 'Time is our power. Together we count.', 'Purple you, purple us, purple forever.', 'Borahae — I will love you for a long time.', 'One stream closer to forever.', 'We bloom together, ARMY.', 'Zero Clock — where every second matters.'];
let qIdx = 0;
function initQuotes() {
  const el = document.getElementById('topbar-quote'); if (!el) return;
  el.textContent = QUOTES[0]; el.style.opacity = '0.9';
  setInterval(() => { el.style.opacity = '0'; setTimeout(() => { qIdx = (qIdx + 1) % QUOTES.length; el.textContent = QUOTES[qIdx]; el.style.opacity = '0.9'; }, 500); }, 6000);
}

function refreshTopBar() {
  const user = getCurrentUser(); if (!user) return;
  setText('user-chip-name', user.isAdmin ? 'Admin' : user.username);
  const av = document.getElementById('topbar-avatar'); if (av) av.textContent = user.isAdmin ? '👑' : user.username.charAt(0).toUpperCase();
  setText('user-chip-level', user.isAdmin ? 'Admin Panel' : 'Level ' + (Math.floor((user.hp || 0) / 1000) + 1));
}

/* ═══════════════════════════════════════════════
   SPEC 46 — STREAMING SYNC STARTING RULE
   First sync: save current count, give 0 HP.
   Subsequent syncs: count only NEW streams.
   ═══════════════════════════════════════════════ */


/* ════════════════════════════════════════════════
   SPEC 50 — BACKEND-CONNECTED SYNC SYSTEM
   API key lives in server.js — never in frontend
   ════════════════════════════════════════════════ */

/* Backend URL — user sets this in Settings if using cloud deployment */

const NAV_CONFIG = [
  { key: 'main', icon: '🏠', label: 'Main', tabs: [{ id: 'dashboard', label: '📊 Dashboard' }, { id: 'profile', label: '👤 Profile' }, { id: 'guide', label: '📖 Guide' }, { id: 'twilight', label: '🌅 Twilight' }] },
  { key: 'missions', icon: '🎯', label: 'Missions', tabs: [{ id: 'missions-list', label: '🎯 Missions' }, { id: 'tracks', label: '🎵 Tracks' }, { id: 'albums', label: '💿 Albums' }, { id: 'video-mission', label: '📺 Video' }, { id: 'voting', label: '🗳️ Voting' }, { id: 'special-missions', label: '⭐ Special' }, { id: 'playlist', label: '🎶 Playlist' }] },
  { key: 'games', icon: '🎮', label: 'Games', tabs: [{ id: 'game-cpr', label: '🧠 Purple CPR' }, { id: 'game-dld', label: '🎤 DLD' }, { id: 'game-jhope', label: '💃 J-Hope' }] },
  { key: 'community', icon: '💬', label: 'Community', tabs: [{ id: 'team', label: '👥 Team' }, { id: 'bellssquad', label: '💬 BellsSquad' }, { id: 'leaderboard', label: '🏆 Leaderboard' }] },
  { key: 'cards', icon: '🃏', label: 'Cards', tabs: [{ id: 'card-collection', label: '🃏 BBC Cards' }, { id: 'card-battle', label: '⚔️ Battle/Playmat' }, { id: 'card-display', label: '🖼️ Display Collection' }, { id: 'card-missions', label: '📋 Card Missions' }] },
  { key: 'groups', icon: '🌐', label: 'Groups', tabs: [{ id: 'groups-links', label: '🌐 Groups' }, { id: 'announcements', label: '📢 Announcements' }] },
  { key: 'more', icon: '⋯', label: 'More', tabs: [{ id: 'rewards-achievements', label: '🏅 Rewards' }, { id: 'weekly-results', label: '📊 Weekly' }, { id: 'attendance', label: '📅 Attendance' }, { id: 'reports', label: '📋 Reports' }, { id: 'evidence', label: '📎 Evidence' }, { id: 'helpline', label: '🆘 Helpline' }, { id: 'admin-panel', label: '👑 Admin', adminOnly: true }, { id: 'settings', label: '⚙️ Settings' }, { id: 'logout', label: '🚪 Logout', action: 'logout' }] },
];

let activeNavKey = 'main', activeSection = 'dashboard';
/* ── Global Refresh System ── */
let _lastRefresh = Date.now();
let _refreshInterval = null;

function startAutoRefresh() {
  if (_refreshInterval) clearInterval(_refreshInterval);
  // Auto-refresh content every 2 minutes
  _refreshInterval = setInterval(() => {
    _silentRefreshContent();
  }, 2 * 60 * 1000);
}

async function _silentRefreshContent() {
  const db = FSB._db(); if(!db) return;
  try {
    // Re-pull all content from Firebase silently
    const MAP = {
      missions:'zc_missions', tracks:'zc_tracks', albums:'zc_albums',
      bbcCards:'zc_battle_cards', pictureCards:'zc_picture_cards',
      announcements:'zc_announcements', playlists:'zc_playlists',
      purpleCprQuestions:'zc_game_cpr', dldQuestions:'zc_game_dld',
      jhopeTimeQuestions:'zc_game_jhope',
    };
    const snap = await db.collection('content').get();
    snap.forEach(doc => {
      const key = MAP[doc.id];
      if(key && doc.data().items) LS.set(key, doc.data().items);
    });
    // Also reload members for leaderboard/team
    await FSB.listenMembers && null; // listeners already active
    _lastRefresh = Date.now();
    // Show subtle refresh indicator
    showRefreshPulse();
  } catch(e) { /* silent fail */ }
}

function showRefreshPulse() {
  const btn = document.getElementById('zc-refresh-fab');
  if (!btn) return;
  btn.style.transform = 'scale(1.2) rotate(360deg)';
  btn.style.transition = 'transform 0.5s ease';
  setTimeout(() => {
    btn.style.transform = 'scale(1)';
    btn.style.transition = 'transform 0.3s ease';
  }, 500);
}

async function manualRefresh() {
  const btn = document.getElementById('zc-refresh-fab');
  if (btn) {
    btn.style.transform = 'rotate(360deg)';
    btn.style.transition = 'transform 0.6s ease';
    btn.innerHTML = '⏳';
  }
  try {
    await _silentRefreshContent();
    // Reload current visible section
    const active = document.querySelector('.nav-item.active');
    if (active) {
      const menu = active.dataset.menu;
      if (menu && typeof openNav === 'function') openNav(menu);
    }
    showToast('Content refreshed! ✅', 'success');
  } catch(e) {
    showToast('Refresh failed. Check connection.', 'warn');
  }
  setTimeout(() => {
    if (btn) { btn.innerHTML = '🔄'; btn.style.transform = 'rotate(0deg)'; }
  }, 700);
}

/* Pull to refresh */
let _touchStartY = 0;
let _pullRefreshing = false;
function initPullToRefresh() {
  document.addEventListener('touchstart', e => {
    _touchStartY = e.touches[0].clientY;
  }, { passive: true });
  document.addEventListener('touchend', e => {
    if (_pullRefreshing) return;
    const dy = e.changedTouches[0].clientY - _touchStartY;
    const atTop = window.scrollY <= 0;
    if (atTop && dy > 80) {
      _pullRefreshing = true;
      showToast('Refreshing...', 'info');
      manualRefresh().finally(() => { _pullRefreshing = false; });
    }
  }, { passive: true });
}

function injectRefreshFAB() {
  if (document.getElementById('zc-refresh-fab')) return;
  const fab = document.createElement('button');
  fab.id = 'zc-refresh-fab';
  fab.innerHTML = '🔄';
  fab.title = 'Refresh content';
  fab.onclick = manualRefresh;
  fab.style.cssText = `
    position:fixed;
    bottom:85px;
    right:14px;
    width:40px;height:40px;
    border-radius:50%;
    background:rgba(196,142,100,0.15);
    border:1.5px solid rgba(196,142,100,0.4);
    color:var(--white);
    font-size:1rem;
    cursor:pointer;
    z-index:8000;
    backdrop-filter:blur(10px);
    box-shadow:0 2px 12px rgba(196,142,100,0.2);
    transition:all 0.2s;
    display:flex;align-items:center;justify-content:center;
    padding:0;
  `;
  fab.addEventListener('mouseenter', () => fab.style.background = 'rgba(196,142,100,0.25)');
  fab.addEventListener('mouseleave', () => fab.style.background = 'rgba(196,142,100,0.15)');
  document.body.appendChild(fab);
}

function buildNav() {
  const nav = document.getElementById('bottom-nav'); if (!nav) return;
  nav.innerHTML = NAV_CONFIG.map(n => `<button class="nav-item" id="nav-${n.key}" onclick="openNav('${n.key}')"><span class="ni">${n.icon}</span>${n.label}</button>`).join('');
}
function buildSubtabs(key) {
  const bar = document.getElementById('subtab-bar'); if (!bar) return;
  const cfg = NAV_CONFIG.find(n => n.key === key); if (!cfg) return;
  bar.innerHTML = cfg.tabs.filter(t => !t.adminOnly || isAdmin()).filter(t => !t.action)
    .map(t => `<button class="subtab${t.id === activeSection ? ' active' : ''}" onclick="openSection('${t.id}')">${t.label}</button>`).join('');
}
function openNav(key) {
  activeNavKey = key;
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`nav-${key}`)?.classList.add('active');
  const cfg = NAV_CONFIG.find(n => n.key === key); if (!cfg) return;
  const first = cfg.tabs.filter(t => !t.adminOnly || isAdmin()).filter(t => !t.action)[0];
  if (first) openSection(first.id);
  buildSubtabs(key);
}
function openSection(id) {
  if (id === 'logout') { doLogout(); return; }
  activeSection = id;
  document.querySelectorAll('.section-view').forEach(s => s.classList.remove('active'));
  document.getElementById(`sec-${id}`)?.classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  document.querySelectorAll('.subtab').forEach(t => t.classList.toggle('active', t.getAttribute('onclick') === `openSection('${id}')`));
  onSectionOpen(id);
}
function onSectionOpen(id) {
  const map = {
    'dashboard': loadDashboard, 'profile': loadProfile, 'guide': loadGuide, 'twilight': loadTwilight,
    'missions-list': loadMissions, 'tracks': loadTracks, 'albums': loadAlbums,
    'video-mission': loadVideoMission, 'voting': loadVoting, 'special-missions': loadSpecialMissions,
    'playlist': loadPlaylist, 'team': loadTeam, 'leaderboard': loadLeaderboard,
    'bellssquad': () => { loadChat(); if (chatInterval) clearInterval(chatInterval); chatInterval = setInterval(loadChat, 3000); },
    'attendance': loadAttendance, 'evidence': loadEvidence, 'reports': loadReports,
    'card-collection': loadBBCCards, 'card-battle': loadPlaymat, 'card-display': loadDisplayCollection,
    'card-missions': loadCardMissions, 'groups-links': loadGroups, 'announcements': loadAnnouncements,
    'rewards-achievements': loadRewards, 'weekly-results': loadWeekly, 'helpline': loadHelpline,
    'settings': loadSettings, 'admin-panel': loadAdminPanel,
  };
  if (map[id]) map[id]();
}

/* ─── DASHBOARD ─── */
function loadDashboard() {
  const user = getCurrentUser(); if (!user) return;
  if (user.isAdmin) {
    const el = document.getElementById('sec-dashboard'); if (!el) return;
    const members = DB.getMembers();
    const evidence = DB.getEvidence().filter(e => e.status === 'Pending').length;
    const reports = DB.getReports().filter(r => !r.fromAdmin && r.status !== 'Resolved').length;
    el.innerHTML = `<div class="glass-card p-16 text-center mb-12"><div style="font-size:2rem">👑</div><div style="font-family:var(--font-display);font-size:1.3rem;color:var(--accent-1);margin:8px 0">Admin Dashboard</div><div class="text-muted">Zclock Control Centre</div></div>
      <div class="stat-grid mb-12">
        <div class="stat-card"><div class="stat-icon">👥</div><div class="stat-label">Members</div><div class="stat-value">${members.length}</div></div>
        <div class="stat-card"><div class="stat-icon">📎</div><div class="stat-label">Evidence</div><div class="stat-value">${evidence}</div><div class="stat-sub">Pending</div></div>
        <div class="stat-card"><div class="stat-icon">📋</div><div class="stat-label">Reports</div><div class="stat-value">${reports}</div><div class="stat-sub">Open</div></div>
      </div>
      <button class="btn btn-primary btn-full" onclick="openNav('more');openSection('admin-panel')">Go to Admin Panel →</button>`;
    return;
  }
  // Load ALL members from Firebase for accurate counts and ranks
  const members = DB.getMembers().filter(m => !m.isAdmin);
  // Sort by HP, then by joinedAt, then username — so rank is never blank
  const sorted = [...members].sort((a, b) => {
    const hpDiff = (b.hp||0) - (a.hp||0);
    if (hpDiff !== 0) return hpDiff;
    const aDate = a.joinedAt||a.lastActive||'';
    const bDate = b.joinedAt||b.lastActive||'';
    if (aDate && bDate) return aDate < bDate ? -1 : 1;
    return (a.username||'').localeCompare(b.username||'');
  });
  // Always assign a rank — even if HP is 0
  const rankIdx = sorted.findIndex(m => m.username === user.username);
  // Always show a rank — even if HP is 0 (rank by join order then username)
  const rank = rankIdx >= 0 ? rankIdx + 1 : 1; // default to #1 if not found yet
  const ts = getTeamStats();
  setText('dash-welcome', `Welcome back, ${user.username} 💜`);
  setText('dash-hp', formatNum(user.hp || 0));
  setText('dash-streams', formatNum(user.streams || 0));
  setText('dash-rank', '#' + rank); // always show rank
  // Get ALL members from Firebase cache for accurate global count
  const allMembersForCount = DB.getMembers().filter(m => !m.isAdmin);
  setText('dash-members', allMembersForCount.length); // ALL registered members
  setText('dash-vote-status', LS.get('zc_voting_active', false) ? '✅ Active' : '🚫 Closed');
  const hpEl = document.getElementById('dash-hp-earned');
  if (hpEl) hpEl.innerHTML = `<div class="flex-between mb-8"><span class="text-muted">🎵 Streaming</span><span class="text-gold">${formatNum(user.hpStreaming || 0)} HP</span></div><div class="flex-between mb-8"><span class="text-muted">🗳️ Voting</span><span class="text-gold">${formatNum(user.hpVoting || 0)} HP</span></div><div class="flex-between mb-8"><span class="text-muted">⭐ Missions</span><span class="text-gold">${formatNum(user.hpMissions || 0)} HP</span></div><div class="flex-between mb-8"><span class="text-muted">🎮 Games</span><span class="text-gold">${formatNum(user.hpGames || 0)} HP</span></div><div class="flex-between"><span class="text-muted">📅 Attendance</span><span class="text-gold">${formatNum(user.hpAttendance || 0)} HP</span></div>`;
  const tot = (ts.hyung.hp + ts.maknae.hp) || 1;
  const hb = document.getElementById('dash-hyung-bar'), mb = document.getElementById('dash-maknae-bar');
  if (hb) hb.style.width = (ts.hyung.hp / tot * 100) + '%';
  if (mb) mb.style.width = (ts.maknae.hp / tot * 100) + '%';
  setText('dash-hyung-hp', formatNum(ts.hyung.hp) + ' HP');
  setText('dash-maknae-hp', formatNum(ts.maknae.hp) + ' HP');
  const tl = document.getElementById('dash-team-leader');
  if (tl) tl.textContent = ts.hyung.hp > ts.maknae.hp ? '💜 Hyung Line leading' : ts.maknae.hp > ts.hyung.hp ? '🩷 Maknae Line leading' : '⚖️ Teams tied';
  const lv = Math.floor((user.hp || 0) / 1000) + 1;
  setText('dash-level', lv);
  setText('dash-level-next', `${(user.hp || 0) % 1000} / 1,000 HP to Level ${lv + 1}`);
  const lb = document.getElementById('dash-level-bar'); if (lb) lb.style.width = Math.min(100, ((user.hp || 0) % 1000) / 10) + '%';
  // Sync area
  const syncKey = `zc_sync_${user.username}`;
  const syncData = LS.get(syncKey, {});
  // Dashboard reads THIS member's own Last.fm from Firebase (never global/admin)
  const lfFirebase = _currentMemberObj && _currentMemberObj.lastfm;
  const lfUrl = (lfFirebase && lfFirebase.profileUrl) || (_currentMemberObj && _currentMemberObj.lastfmUrl) || '';
  const lfUsername = (lfFirebase && lfFirebase.username) || (lfUrl ? lfUrl.replace(/.*last\.fm\/user\//i,'').replace(/\/.*/,'').trim() : '');
  const lfConnected = !!(lfFirebase && lfFirebase.connected) || !!lfUsername;
  const lfStatus = lfConnected ? (lfUsername + ' ✅ Connected') : 'Not connected — add your URL in Settings';
  // ListenBrainz connection display
  const lb2=_currentMemberObj?.listenbrainz||{};
  const lbUn=lb2.username||'';const lbConn=lb2.connected||!!lbUn;
  const lbSt=lbConn?(lbUn+' Connected'):'Not connected - add username in Settings';
  const lbLS=lb2.lastSyncAt?new Date(lb2.lastSyncAt).toLocaleString():null;
  const lbLStr=lb2.lastSyncStreams||0;
  const sumEl2=document.getElementById('dash-sync-area');
  if(sumEl2)sumEl2.innerHTML='<div class="glass-card p-14 mb-12"><div class="flex-between mb-8"><div class="section-title" style="margin:0">Streaming Sync</div><button class="btn btn-primary btn-xs" onclick="runSync(getCurrentUser(),true)">Sync Now</button></div><div id="sync-status-bar" style="display:none;font-size:0.78rem;color:var(--accent-1);margin-bottom:6px"></div><div style="display:flex;gap:8px;flex-wrap:wrap;font-size:0.78rem;margin-bottom:8px"><span class="badge '+(lbConn?'badge-green':'badge-accent')+'">ListenBrainz: '+escHtml(lbSt)+'</span></div><div class="text-muted" style="font-size:0.74rem">'+(lbLS?('Last sync: '+lbLS+(lbLStr>0?' +'+lbLStr+' streams':' No new streams')):(lbConn?'Click Sync Now to start':'Go to Settings to connect ListenBrainz'))+'</div></div>';
}

/* ─── PROFILE ─── */
function loadProfile() {
  const user = getCurrentUser(); if (!user || user.isAdmin) return;
  const members = DB.getMembers().filter(m => !m.isAdmin);
  const sorted = [...members].sort((a, b) => (b.hp || 0) - (a.hp || 0));
  const rank = sorted.findIndex(m => m.username === user.username) + 1;
  const lv = Math.floor((user.hp || 0) / 1000) + 1;
  const syncKey = `zc_sync_${user.username}`;
  const syncData = LS.get(syncKey, {});
  const settings = DB.getSettings();
  const el = document.getElementById('sec-profile'); if (!el) return;
  el.innerHTML = `
    <div class="profile-header card-hover mb-12">
      <div class="profile-avatar">${user.username.charAt(0).toUpperCase()}</div>
      <div class="profile-info">
        <div class="profile-name">${escHtml(user.username)}</div>
        <div class="profile-team">${user.team || '—'} · Level ${lv}</div>
        <div class="profile-badges mt-8">
          <span class="badge badge-gold">⭐ ARMY</span>
          ${rank <= 3 && rank > 0 ? '<span class="badge badge-gold">🏆 Top 3</span>' : ''}
          ${(user.streams || 0) >= 50 ? '<span class="badge badge-accent">🎵 Streamer</span>' : ''}
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0">
        <button class="btn btn-secondary btn-sm" onclick="openEditProfile()">✏️ Edit</button>
        <button class="btn btn-danger btn-sm" onclick="doLogout()">🚪 Logout</button>
      </div>
    </div>
    <div class="profile-stats-grid mb-12">
      <div class="profile-stat"><div class="profile-stat-val grad-text">${formatNum(user.hp || 0)}</div><div class="profile-stat-lbl">Current HP</div></div>
      <div class="profile-stat"><div class="profile-stat-val" style="font-size:1.1rem;color:var(--gold)">${formatNum(user.totalHp || 0)}</div><div class="profile-stat-lbl">Total HP ∞</div></div>
      <div class="profile-stat"><div class="profile-stat-val">${formatNum(user.streams || 0)}</div><div class="profile-stat-lbl">Streams</div></div>
      <div class="profile-stat"><div class="profile-stat-val">${(user.completedMissions || []).length}</div><div class="profile-stat-lbl">Missions</div></div>
      <div class="profile-stat"><div class="profile-stat-val">#${rank > 0 ? rank : '—'}</div><div class="profile-stat-lbl">Global Rank</div></div>
      <div class="profile-stat"><div class="profile-stat-val">${lv}</div><div class="profile-stat-lbl">Level</div></div>
    </div>
    <div class="card p-16 mb-12">
      <div class="section-title">📋 Member Info</div>
      <div class="grid-2">
        <div><div class="text-muted" style="font-size:0.72rem">Joined</div><div style="font-size:0.88rem">${user.joinedAt ? new Date(user.joinedAt).toLocaleDateString() : '—'}</div></div>
        <div><div class="text-muted" style="font-size:0.72rem">Team</div><div style="font-size:0.88rem">${user.team || '—'}</div></div>
        <div><div class="text-muted" style="font-size:0.72rem">Weekly Streams</div><div style="font-size:0.88rem">${user.weeklyStreams || 0}</div></div>
        <div><div class="text-muted" style="font-size:0.72rem">Weekly HP</div><div style="font-size:0.88rem">${user.weeklyHp || 0}</div></div>
      </div>
    </div>
    <div class="card p-16 mb-12">
      <div class="section-title">🔄 Sync Status</div>
      <div style="background:rgba(196,142,100,0.08);border:1px solid rgba(196,142,100,0.3);border-radius:var(--radius-sm);padding:12px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <div style="font-weight:700;font-size:0.85rem">🎵 Last.fm</div>
            <div class="text-muted" style="font-size:0.75rem">${settings.lastfmUrl ? settings.lastfmUrl.replace(/.*last\.fm\/user\//,'').replace(/\/.*/,'') : 'Not connected'}</div>
          </div>
          ${settings.lastfmUrl
            ? '<span class="badge badge-green" style="font-size:0.62rem">✅ Connected</span>'
            : '<span class="badge badge-accent" style="font-size:0.62rem">❌ Not connected</span>'}
        </div>
      </div>
      <button class="btn btn-primary btn-sm mt-8" onclick="runSync(getCurrentUser(),true)">🔄 Sync Now</button>
    </div>
    <div class="card p-16">
      <div class="section-title">📈 Progress</div>
      <div class="prog-label"><span>Level ${lv}</span><span>${(user.hp || 0) % 1000} / 1,000 HP</span></div>
      <div style="height:8px;background:rgba(255,255,255,0.06);border-radius:4px;overflow:hidden">
        <div style="height:100%;width:${Math.min(100, ((user.hp || 0) % 1000) / 10)}%;background:var(--grad-btn);border-radius:4px;transition:width 0.7s"></div>
      </div>
    </div>`;
}
function openEditProfile() { const u = getCurrentUser(); if (!u) return; const mo = document.getElementById('modal-edit-profile'); if (!mo) return; document.getElementById('ep-team').value = u.team || 'Hyung Line'; mo.classList.add('show'); }
function saveEditProfile() {
  const u = getCurrentUser(); if (!u) return;
  u.team = document.getElementById('ep-team').value;
  DB.saveMember(u); closeModal('modal-edit-profile');
  showToast('Profile updated!', 'success');
  logAction(u.username, 'profile', 'Updated profile', { team: u.team });
  DB.addNotif('profile', `${u.username} updated profile`); loadProfile();
}

/* ─── GUIDE ─── */
function loadGuide() {
  const el = document.getElementById('sec-guide'); if (!el) return;
  const user = getCurrentUser();
  const tourDone = user ? localStorage.getItem('zc_tour_done_' + user.username) : null;
  el.innerHTML = `<div class="page-eyebrow">Main</div><div class="page-heading mb-12">📖 How to Use Zclock</div>
    <div class="glass-card p-16 mb-16 text-center" style="border-color:var(--accent-1);background:linear-gradient(135deg,rgba(196,142,100,0.08),rgba(147,51,234,0.05))">
      <div style="font-size:2.5rem;margin-bottom:8px">✨</div>
      <div style="font-family:var(--font-display);font-size:1.1rem;color:var(--accent-1);margin-bottom:6px">Meet Zchan — Your Guide</div>
      <div class="text-muted mb-14" style="font-size:0.84rem">Let Zchan walk you through every section of Zclock with an animated tour!</div>
      <button class="btn btn-primary" onclick="if(typeof startTour==='function')startTour();else showToast('Tour loading…','info')" style="background:linear-gradient(135deg,#c48e64,#9b6041);box-shadow:0 4px 20px rgba(196,142,100,0.4)">
        ${tourDone ? '🔄 Restart Tour' : '✨ Take Me On Tour'}
      </button>
      ${tourDone ? '<div class="text-muted mt-8" style="font-size:0.72rem">You completed the tour! Click to restart anytime.</div>' : ''}
    </div>` +
    [['🔄', 'Streaming Sync', 'Add your Last.fm profile URL in Settings. First sync saves your starting count — old streams never count. Every 10 new streams = 1 HP.'],
    ['🗳️', 'Vote', '+2 HP per vote. Max 10 votes/day when voting is active.'],
    ['🎮', 'Games', 'Purple CPR, DLD, and J-Hope Time. Each game locks after completion — admin can reset for you.'],
    ['📅', 'Attendance', 'Check in every day for 1 HP. Build your streak!'],
    ['📎', 'Evidence', 'Upload screenshots for admin review. Approved evidence earns bonus HP.'],
    ['🃏', 'Cards', 'Battle cards unlock automatically when you reach the HP requirement.'],
    ['⚙️', 'Settings', 'Paste your Last.fm profile URL here for automatic streaming sync! 10 new streams = 1 HP.'],
    ['☁️', 'Sync My Data', 'In Settings, click Sync My Data to Firebase so admin can see you from any device.'],
    ].map(([i, t, d]) => `<div class="card p-14 mb-8"><div class="flex-row mb-4" style="gap:10px"><span style="font-size:1.3rem">${i}</span><span style="font-weight:700;color:var(--accent-1)">${t}</span></div><div class="text-muted" style="font-size:0.84rem">${d}</div></div>`).join('');
}

/* ─── TWILIGHT ─── */
function loadTwilight() {
  const el = document.getElementById('sec-twilight'); if (!el) return;
  el.innerHTML = `<div style="text-align:center;padding:40px 16px">
    <div style="font-size:3.5rem;margin-bottom:12px">🌅</div>
    <div style="font-family:var(--font-display);font-size:2rem;font-weight:800;background:var(--grad-text);-webkit-background-clip:text;background-clip:text;color:transparent;margin-bottom:8px">Coming Soon</div>
    <div class="page-eyebrow" style="justify-content:center;margin-bottom:16px">Twilight Songs</div>
    <div class="text-muted mb-16" style="max-width:320px;margin:0 auto 20px">The Twilight song collection is being prepared. Admin will unlock exclusive BTS streaming missions soon.</div>
    <div class="glass-card p-16" style="max-width:380px;margin:0 auto 20px">
      <div class="section-title" style="justify-content:center">🔮 What's Coming</div>
      <div style="font-size:0.85rem;color:var(--white-dim);line-height:2">• Exclusive Twilight song list<br>• Auto-sync stream tracking<br>• HP rewards per 10 streams<br>• Team streaming challenges<br>• Special achievements</div>
    </div>
    <div class="badge badge-gold" style="font-size:0.78rem;padding:8px 18px">🌟 Admin will activate Twilight songs soon</div>
  </div>`;
}

/* ─── MISSIONS ─── */
function loadMissions() {
  const missions = DB.getMissions(); const user = getCurrentUser();
  const el = document.getElementById('sec-missions-list'); if (!el) return;
  if (!missions.length) { el.innerHTML = `<div class="page-eyebrow">Missions</div><div class="page-heading mb-12">🎯 Missions</div>` + emptyState('🎯', 'No missions yet. Admin will upload missions.'); return; }
  el.innerHTML = `<div class="page-eyebrow">Missions</div><div class="page-heading mb-12">🎯 Active Missions</div><div class="mission-grid">` +
    missions.map(m => {
      const done = user && (user.completedMissions || []).includes(m.id);
      const hp = Math.min(20, m.hp || 5);
      return `<div class="mission-card"><div class="mission-type">${m.type} Mission</div><div class="mission-title">${escHtml(m.title)}</div><div class="mission-meta"><span class="badge badge-accent">🎯 ${m.target} ${m.unit}</span><span class="badge badge-gold">+${hp} HP</span>${m.deadline ? `<span class="badge badge-pink">⏰ ${m.deadline}</span>` : ''}</div><div class="mission-footer mt-8"><span class="badge ${done ? 'badge-green' : 'badge-accent'}">${done ? '✅ Done' : '⏳ Active'}</span>${!done && user && !user.isAdmin ? `<button class="btn btn-primary btn-sm" onclick="completeMission('${m.id}','${m.title}',${hp})">Complete</button>` : ''}</div></div>`;
    }).join('') + '</div>';
}
function completeMission(id,title,hp){
  const user=getCurrentUser();if(!user||user.isAdmin)return;
  if((user.completedMissions||[]).includes(id)){showToast('Already completed!','warn');return;}
  user.completedMissions=[...(user.completedMissions||[]),id];
  const cap=Math.min(20,hp);
  _earnHP(user,cap,'missions',`Mission: ${title}`);
  showToast(`Mission complete! +${cap} HP!`,'success');
  DB.addNotif('mission',`${user.username} completed: ${title}`);
  logAction(user.username,'missions',`Completed: ${title}`,{missionId:id,hp:cap});
  loadMissions();
}

/* ─── TRACKS ─── */
function loadTracks() {
  const tracks = DB.getTracks(); const el = document.getElementById('sec-tracks'); if (!el) return;
  if (!tracks.length) { el.innerHTML = `<div class="page-eyebrow">Tracks</div><div class="page-heading mb-12">🎵 Tracks</div>` + emptyState('🎵', 'No tracks yet. Admin will add tracks.'); return; }
  const user = getCurrentUser();
  el.innerHTML = `<div class="page-eyebrow">Tracks</div><div class="page-heading mb-12">🎵 Tracks</div><div class="glass-card p-12 mb-12" style="font-size:0.8rem;color:var(--accent-2)">💡 Streams auto-sync from Last.fm. 10 streams = 1 HP.</div><div class="song-list">` +
    tracks.map((t, i) => {
      const s = user ? (user.trackStreams || {})[t.id] || 0 : 0;
      const p = Math.min(100, (s / t.goal) * 100);
      return `<div class="song-item"><div class="song-num">${i + 1}</div><div class="song-info"><div class="song-title">${escHtml(t.title)}</div><div class="song-sub">${escHtml(t.artist || 'BTS')} · ${s}/${t.goal} streams</div><div style="height:4px;background:rgba(255,255,255,0.06);border-radius:3px;overflow:hidden;margin-top:4px"><div style="height:100%;width:${p}%;background:var(--grad-btn);border-radius:3px;transition:width 0.6s"></div></div></div><div class="song-hp" style="font-size:0.65rem;color:var(--gold)">+1 HP<br>/10 streams</div></div>`;
    }).join('') + '</div>';
}

/* ─── ALBUMS ─── */
function loadAlbums() {
  const albums = DB.getAlbums(); const el = document.getElementById('sec-albums'); if (!el) return;
  if (!albums.length) { el.innerHTML = `<div class="page-eyebrow">Albums</div><div class="page-heading mb-12">💿 Albums</div>` + emptyState('💿', 'No albums yet. Admin will add albums.'); return; }
  el.innerHTML = `<div class="page-eyebrow">Albums</div><div class="page-heading mb-12">💿 Albums</div><div class="album-grid">` +
    albums.map(a => `<div class="album-card card-hover"><div class="album-art">${a.emoji || '💿'}</div><div class="album-info"><div class="album-name">${escHtml(a.name)}</div><div class="album-year">${a.year || ''}</div><div style="font-size:0.7rem;color:var(--white-muted);margin:4px 0 6px">Goal: ${a.goal || 0} · +1 HP/10 streams</div><button class="btn btn-primary btn-xs btn-full" onclick="showToast('Opening album…','info')">Open Album</button></div></div>`).join('') + '</div>';
}

/* ─── VIDEO ─── */
/* ════════════════════════════════════════════════
   VIDEO MISSIONS — Admin Controlled (Spec 79)
   ════════════════════════════════════════════════ */

/* State for active video watch session */
let _vmState = {
  missionId: null,
  ytPlayer: null,
  skipped: false,
  watchPercent: 0,
  completed: false,
  claimed: false,
  lastTime: 0,
  duration: 0,
  checkInterval: null,
};

function getYTId(url) {
  if (!url) return '';
  const m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : '';
}

/* Get completions for this member */
function _getVMCompletions() {
  const user = getCurrentUser();
  if (!user) return {};
  return LS.get('zc_vm_completions_' + (FSB.uid()||user.username), {});
}
function _saveVMCompletion(missionId, data) {
  const user = getCurrentUser(); if (!user) return;
  const all = _getVMCompletions();
  all[missionId] = { ...all[missionId], ...data };
  LS.set('zc_vm_completions_' + (FSB.uid()||user.username), all);
  // Also save to Firebase
  const db = FSB._db(); const uid = FSB.uid();
  if (db && uid) {
    db.collection('videoMissionCompletions').doc(uid + '_' + missionId).set({
      memberUid: uid,
      username: user.username,
      team: user.team||'',
      videoMissionId: missionId,
      ...data,
      updatedAt: new Date().toISOString()
    }, { merge: true }).catch(()=>{});
  }
}

function loadVideoMission() {
  const el = document.getElementById('sec-video-mission'); if (!el) return;
  const user = getCurrentUser();
  const missions = LS.get('zc_video_missions', []).filter(m => m.active !== false);
  const completions = _getVMCompletions();

  // Filter by team
  const myTeam = user?.team || '';
  const visible = missions.filter(m => !m.teamTarget || m.teamTarget === 'All' || m.teamTarget === myTeam);

  if (!visible.length) {
    el.innerHTML = '<div class="page-eyebrow">Missions</div><div class="page-heading mb-12">📺 Video Missions</div>' +
      emptyState('📺', 'No video missions yet. Admin will assign MVs for you to watch!');
    return;
  }

  function missionCard(m) {
    var vid = getYTId(m.youtubeUrl || '');
    var thumb = vid ? 'https://img.youtube.com/vi/'+vid+'/mqdefault.jpg' : '';
    var comp = completions[m.id] || {};
    var claimed = comp.claimed;
    var completed = comp.completed;
    var skipped = comp.skipped;
    var pct = Math.round(comp.watchPercent || 0);
    var borderColor = claimed?'rgba(46,204,113,0.4)':completed?'rgba(196,142,100,0.4)':'var(--border-color)';
    var thumbHTML = thumb
      ? '<img src="'+escHtml(thumb)+'" style="width:100%;aspect-ratio:16/9;object-fit:cover;display:block" alt="'+escHtml(m.title)+'">'
      : '<div style="aspect-ratio:16/9;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;font-size:3rem">📺</div>';
    var teamBadge = m.teamTarget&&m.teamTarget!=='All'?'<span class="badge badge-purple">'+escHtml(m.teamTarget)+'</span>':'';
    var progressHTML = pct>0&&!claimed
      ? '<div style="margin-bottom:8px"><div style="display:flex;justify-content:space-between;font-size:0.7rem;color:var(--white-muted);margin-bottom:3px"><span>Watch progress</span><span>'+pct+'%</span></div><div style="height:4px;background:rgba(255,255,255,0.08);border-radius:2px;overflow:hidden"><div style="height:100%;width:'+pct+'%;background:var(--grad-btn);border-radius:2px;transition:width 0.5s"></div></div></div>'
      : '';
    var actionHTML;
    if (claimed) {
      actionHTML = '<div class="badge badge-green" style="font-size:0.78rem">✅ Reward Claimed!</div>';
    } else if (completed && !skipped) {
      actionHTML = '<button class="btn btn-primary btn-full" data-vmid="'+escHtml(String(m.id))+'" data-vmhp="'+(m.hpReward||5)+'" onclick="_claimVM(this)" style="background:linear-gradient(135deg,#f0c040,#c48e64);color:#000;font-weight:800">🎁 Claim Reward (+'+(m.hpReward||5)+' HP)</button>';
    } else if (skipped) {
      actionHTML = '<div class="badge badge-red" style="font-size:0.75rem">⚠️ Video skipped — no reward. Rewatch to try again.</div><button class="btn btn-secondary btn-sm btn-full mt-8" data-vmid="'+escHtml(String(m.id))+'" onclick="_watchVM(this)">↺ Rewatch</button>';
    } else {
      actionHTML = '<button class="btn btn-primary btn-full" data-vmid="'+escHtml(String(m.id))+'" onclick="_watchVM(this)">▶️ Watch Now</button>';
    }
    return '<div class="card mb-12" style="overflow:hidden;border:1.5px solid '+borderColor+'">'+
      thumbHTML+
      '<div class="p-14">'+
        '<div style="font-weight:800;font-size:1rem;margin-bottom:4px">'+escHtml(m.title)+'</div>'+
        '<div class="text-muted mb-8" style="font-size:0.8rem">'+escHtml(m.description||'')+'</div>'+
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">'+
          '<span class="badge badge-gold">🎁 +'+(m.hpReward||5)+' HP</span>'+
          '<span class="badge badge-accent">📺 '+escHtml(m.mvName||'BTS MV')+'</span>'+
          teamBadge+
        '</div>'+
        progressHTML+
        actionHTML+
      '</div>'+
    '</div>';
  }

  el.innerHTML = '<div class="page-eyebrow">Missions</div><div class="page-heading mb-12">📺 Video Missions</div>' +
    '<div class="glass-card p-12 mb-12" style="font-size:0.8rem;color:var(--accent-2)">⚠️ Watch the full MV without skipping to earn HP. Skipping disqualifies the reward.</div>' +
    visible.map(missionCard).join('');
}

/* ── Open video player modal ── */
function openVideoPlayer(missionId) {
  const missions = LS.get('zc_video_missions', []);
  const m = missions.find(x => x.id === missionId);
  if (!m) return;
  const vid = getYTId(m.youtubeUrl || '');
  if (!vid) { showToast('Invalid video link.', 'error'); return; }

  // Reset state
  _vmState = { missionId, ytPlayer: null, skipped: false, watchPercent: 0, completed: false, claimed: false, lastTime: 0, duration: 0, checkInterval: null };

  // Check if already claimed
  const comp = _getVMCompletions()[missionId] || {};
  if (comp.claimed) { showToast('Already claimed!', 'info'); return; }

  // Create modal
  const modal = document.createElement('div');
  modal.id = 'vm-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,0.95);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px';
  modal.innerHTML = `
    <div style="width:100%;max-width:700px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div style="font-weight:700;font-size:0.95rem;color:var(--accent-1)">${escHtml(m.title)}</div>
        <button onclick="closeVideoPlayer()" style="background:rgba(255,255,255,0.1);border:none;color:var(--white);border-radius:50%;width:32px;height:32px;cursor:pointer;font-size:1rem">✕</button>
      </div>
      <div style="width:100%;aspect-ratio:16/9;background:#000;border-radius:12px;overflow:hidden;position:relative">
        <div id="vm-player" style="width:100%;height:100%"></div>
      </div>
      <div style="margin-top:10px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <div id="vm-status" style="font-size:0.8rem;color:var(--white-muted)">Watch the full video to earn +${m.hpReward||5} HP</div>
        <div id="vm-progress-wrap" style="display:flex;align-items:center;gap:8px">
          <div style="width:120px;height:5px;background:rgba(255,255,255,0.1);border-radius:3px;overflow:hidden">
            <div id="vm-prog-bar" style="height:100%;width:0%;background:var(--grad-btn);border-radius:3px;transition:width 0.5s"></div>
          </div>
          <span id="vm-pct" style="font-size:0.72rem;color:var(--accent-1)">0%</span>
        </div>
      </div>
      <div style="font-size:0.72rem;color:rgba(255,255,255,0.3);margin-top:6px;text-align:center">⚠️ Seeking forward/backward will void the reward</div>
      <div style="display:flex;gap:8px;justify-content:center;margin-top:10px;flex-wrap:wrap">
        <button onclick="vmToggleMute()" class="btn btn-secondary btn-xs" id="vm-mute-btn">🔊 Mute</button>
        <button onclick="vmFullscreen()" class="btn btn-secondary btn-xs">⛶ Fullscreen</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  // Load YouTube IFrame API
  if (!window.YT || !window.YT.Player) {
    if (!document.getElementById('yt-api-script')) {
      const s = document.createElement('script');
      s.id = 'yt-api-script';
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(s);
    }
    window.onYouTubeIframeAPIReady = () => _initVMPlayer(vid, m);
  } else {
    _initVMPlayer(vid, m);
  }
}

function _initVMPlayer(vid, m) {
  if (!document.getElementById('vm-player')) return;
  _vmState.ytPlayer = new YT.Player('vm-player', {
    videoId: vid,
    playerVars: { autoplay: 1, controls: 0, disablekb: 1, modestbranding: 1, rel: 0, iv_load_policy: 3 },
    events: {
      onReady: e => {
        e.target.playVideo();
        _vmState.duration = e.target.getDuration();
        _startVMTracking(m);
      },
      onStateChange: e => {
        // YT.PlayerState.ENDED = 0
        if (e.data === 0) _onVideoEnd(m);
      }
    }
  });
}

function _startVMTracking(m) {
  if (_vmState.checkInterval) clearInterval(_vmState.checkInterval);
  _vmState.checkInterval = setInterval(() => {
    const player = _vmState.ytPlayer;
    if (!player || typeof player.getCurrentTime !== 'function') return;
    try {
      const current = player.getCurrentTime();
      const duration = player.getDuration() || _vmState.duration || 1;

      // Anti-skip: detect if user seeked forward by more than 2 seconds
      const diff = current - _vmState.lastTime;
      if (_vmState.lastTime > 0 && diff > 3) {
        _vmState.skipped = true;
        clearInterval(_vmState.checkInterval);
        const statusEl = document.getElementById('vm-status');
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--pink)">⚠️ Skip detected — reward voided!</span>';
        _saveVMCompletion(m.id, { skipped: true, watchPercent: _vmState.watchPercent, completedAt: new Date().toISOString() });
        showToast('Skip detected! Reward lost. You can rewatch to try again.', 'error');
      }

      if (!_vmState.skipped) {
        _vmState.lastTime = current;
        const pct = Math.min(100, Math.round((current / duration) * 100));
        _vmState.watchPercent = pct;

        // Update UI
        const bar = document.getElementById('vm-prog-bar');
        const pctEl = document.getElementById('vm-pct');
        if (bar) bar.style.width = pct + '%';
        if (pctEl) pctEl.textContent = pct + '%';

        // Save progress
        if (pct % 10 === 0) {
          _saveVMCompletion(m.id, { watchPercent: pct, skipped: false });
        }
      }
    } catch(e) {}
  }, 1000);
}

function _onVideoEnd(m) {
  clearInterval(_vmState.checkInterval);
  if (_vmState.skipped) return;
  _vmState.completed = true;
  _saveVMCompletion(m.id, { completed: true, watchPercent: 100, skipped: false, completedAt: new Date().toISOString() });

  // Show gift box animation in modal
  const statusEl = document.getElementById('vm-status');
  if (statusEl) statusEl.innerHTML = '<span style="color:var(--accent-1)">🎉 Mission Complete! Close to claim your reward!</span>';

  // Replace progress bar with gift box
  const wrap = document.getElementById('vm-progress-wrap');
  if (wrap) wrap.innerHTML = '<div style="font-size:1.5rem;animation:bounce 0.5s ease infinite alternate">🎁</div>';

  showToast('🎉 Video complete! Close the player and claim your reward!', 'success');
}

function closeVideoPlayer() {
  if (_vmState.checkInterval) clearInterval(_vmState.checkInterval);
  if (_vmState.ytPlayer) { try { _vmState.ytPlayer.destroy(); } catch(e){} }
  const modal = document.getElementById('vm-modal');
  if (modal) modal.remove();
  loadVideoMission(); // refresh to show claim button
}

function claimVideoReward(missionId, hp) {
  const user = getCurrentUser(); if (!user || user.isAdmin) return;
  const comp = _getVMCompletions()[missionId] || {};
  if (comp.claimed) { showToast('Already claimed!', 'warn'); return; }
  if (!comp.completed || comp.skipped) { showToast('Watch the full video first!', 'warn'); return; }

  const hpAmt = Math.min(20, hp || 5);
  _earnHP(user,hpAmt,'video',`Video mission: ${missionId}`);

  // Update Firebase member
  const uid = FSB.uid();
  if (uid) {
    const db = FSB._db();
    if (db) db.collection('members').doc(uid).update({ hp: user.hp, totalHp: user.totalHp, weeklyHp: user.weeklyHp }).catch(()=>{});
  }

  _saveVMCompletion(missionId, { claimed: true, hpEarned: hpAmt, claimedAt: new Date().toISOString() });
  showHPPopup(hpAmt);
  showToast(`🎁 +${hpAmt} HP claimed! Borahae! 💜`, 'success');
  DB.addNotif('video', user.username + ' claimed video mission reward +' + hpAmt + ' HP');
  logAction(user.username, 'video', 'Claimed video mission reward', { missionId, hp: hpAmt });
  loadVideoMission();
}

function vmToggleMute() {
  const player = _vmState.ytPlayer; if (!player) return;
  try {
    const btn = document.getElementById('vm-mute-btn');
    if (player.isMuted()) { player.unMute(); if (btn) btn.textContent = '🔊 Mute'; }
    else { player.mute(); if (btn) btn.textContent = '🔇 Unmuted'; }
  } catch(e) {}
}

function vmFullscreen() {
  const el = document.getElementById('vm-modal');
  if (el) el.requestFullscreen?.();
}

/* ─── VOTING ─── */
function loadVoting() {
  const el = document.getElementById('sec-voting'); if (!el) return;
  const vActive = LS.get('zc_voting_active', false); const vLink = LS.get('zc_voting_link', ''); const user = getCurrentUser();
  el.innerHTML = `<div class="page-eyebrow">Voting</div><div class="page-heading mb-12">🗳️ Voting</div>` +
    (vActive ? `<div class="card p-16 mb-12" style="border-color:var(--accent-1)"><div class="section-title">🟢 Voting Active!</div><p class="text-muted mb-12">+${HP.VOTE} HP per vote. Max 10/day.</p>${vLink ? `<a href="${vLink}" target="_blank" class="btn btn-primary btn-full mb-12">🗳️ Vote Now</a>` : ''}<div class="flex-between mb-8"><span class="text-muted">Today</span><span class="text-gold">${(user || {}).votesToday || 0}/10</span></div><div style="height:7px;background:rgba(255,255,255,0.06);border-radius:4px;overflow:hidden;margin-bottom:12px"><div style="height:100%;width:${Math.min(100, ((user || {}).votesToday || 0) * 10)}%;background:var(--grad-btn);border-radius:4px"></div></div>${user && !user.isAdmin ? `<button class="btn btn-success btn-sm" onclick="castVote()">✅ Record Vote (+${HP.VOTE} HP)</button>` : ''}</div>`
      : emptyState('🗳️', 'No voting missions right now.'));
}
function castVote(){
  const user=getCurrentUser();if(!user||user.isAdmin)return;
  if((user.votesToday||0)>=10){showToast('Daily limit reached!','warn');return;}
  user.votesToday=(user.votesToday||0)+1;
  _earnHP(user,HP.VOTE,'voting','Cast a vote');
  showToast(`+${HP.VOTE} HP for voting!`,'success');
  DB.addNotif('vote',`${user.username} cast a vote`);
  logAction(user.username,'voting','Cast a vote',{votesToday:user.votesToday});loadVoting();
}

/* ─── SPECIAL ─── */
function loadSpecialMissions() {
  const s = LS.get('zc_special_missions', []); const el = document.getElementById('sec-special-missions'); if (!el) return;
  if (!s.length) { el.innerHTML = `<div class="page-eyebrow">Special</div><div class="page-heading mb-12">⭐ Special Missions</div>` + emptyState('⭐', 'No special missions right now.'); return; }
  el.innerHTML = `<div class="page-eyebrow">Special</div><div class="page-heading mb-12">⭐ Special</div><div class="mission-grid">` + s.map(m => `<div class="mission-card"><div class="mission-type">Special</div><div class="mission-title">${escHtml(m.title)}</div><div class="mission-meta"><span class="badge badge-gold">+${Math.min(20, m.hp)} HP</span></div><p class="text-muted mt-8" style="font-size:0.8rem">${escHtml(m.desc || '')}</p></div>`).join('') + '</div>';
}

/* ─── PLAYLIST ─── */
/* ─── PLAYLIST STATE ─── */
let _plCatFilter = 'all';
let _plPlatFilter = 'all';
let _plSort = 'new';
let _plSearch = '';
let _plShowRequest = false;

function loadPlaylist() {
  const el = document.getElementById('sec-playlist'); if (!el) return;
  const user = getCurrentUser();

  // Official playlists (added by admin — stored as type:'official')
  const allPlaylists = DB.getPlaylists();
  const official = allPlaylists.filter(p => p.type === 'official');
  const requests = allPlaylists.filter(p => p.type !== 'official');
  const mine = requests.filter(r => r.user === (user && user.username));

  // Apply filters to official playlists
  let filtered = [...official];
  if (_plCatFilter !== 'all') filtered = filtered.filter(p => p.category === _plCatFilter);
  if (_plPlatFilter !== 'all') filtered = filtered.filter(p => p.platform === _plPlatFilter);
  if (_plSearch) {
    const q = _plSearch.toLowerCase();
    filtered = filtered.filter(p => (p.title||'').toLowerCase().includes(q) || (p.platform||'').toLowerCase().includes(q) || (p.category||'').toLowerCase().includes(q));
  }
  if (_plSort === 'new') filtered.sort((a,b) => (b.ts||0)-(a.ts||0));
  else if (_plSort === 'old') filtered.sort((a,b) => (a.ts||0)-(b.ts||0));
  else if (_plSort === 'az') filtered.sort((a,b) => (a.title||'').localeCompare(b.title||''));
  else if (_plSort === 'za') filtered.sort((a,b) => (b.title||'').localeCompare(a.title||''));

  const platIcon = {Spotify:'🟢','Apple Music':'🍎','YouTube Music':'▶️',Other:'🎵'};
  const catColor = {Focus:'#c48e64',General:'#9b8fa0',Team:'#7c3aed',Mission:'#ec4899',Special:'#f0c040'};

  function plCard(p) {
    const icon = platIcon[p.platform] || '🎵';
    const cc = catColor[p.category] || '#c48e64';
    const featured = p.featured ? `<span class="badge badge-gold" style="font-size:0.58rem">⭐ Featured</span>` : '';
    return `<div class="plx-card" onclick="void 0">
      <div class="plx-card-top">
        <div class="plx-icon">${icon}</div>
        <div class="plx-info">
          <div class="plx-title">${escHtml(p.title||p.name||'Untitled')} ${featured}</div>
          <div class="plx-meta">
            <span class="plx-tag" style="background:${cc}22;color:${cc}">${escHtml(p.category||'General')}</span>
            <span class="plx-tag">${escHtml(p.platform||'—')}</span>
            ${p.team&&p.team!=='All'?`<span class="plx-tag" style="background:rgba(147,51,234,0.15);color:#c4b5fd">${escHtml(p.team)}</span>`:`<span class="plx-tag">All Teams</span>`}
          </div>
          ${p.desc?`<div class="plx-desc">${escHtml(p.desc)}</div>`:''}
        </div>
      </div>
      <div class="plx-card-bot">
        <div class="plx-date">Added ${new Date(p.ts||Date.now()).toLocaleDateString()}</div>
        <div class="plx-btns">
          <button class="btn btn-secondary btn-xs" onclick="navigator.clipboard&&navigator.clipboard.writeText('${escHtml(p.link||'')}').then(()=>showToast('Link copied! 📋','success'))">📋 Copy</button>
          ${p.link?`<a href="${escHtml(p.link)}" target="_blank" class="btn btn-primary btn-xs">▶️ Open</a>`:'<span class="btn btn-primary btn-xs" style="opacity:0.4">No link</span>'}
        </div>
      </div>
    </div>`;
  }

  el.innerHTML = `
    <style>
      .plx-header{margin-bottom:16px;}
      .plx-filters{display:flex;flex-direction:column;gap:8px;margin-bottom:14px;}
      .plx-filter-row{display:flex;gap:5px;overflow-x:auto;scrollbar-width:none;padding-bottom:2px;}
      .plx-filter-row::-webkit-scrollbar{display:none;}
      .plx-fb{padding:5px 12px;border-radius:20px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.55);font-family:var(--font-ui);font-size:0.72rem;font-weight:700;cursor:pointer;white-space:nowrap;transition:all 0.2s;}
      .plx-fb.on{background:rgba(196,142,100,0.2);border-color:rgba(196,142,100,0.5);color:var(--accent-1);}
      .plx-search{display:flex;align-items:center;gap:8px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:8px 12px;}
      .plx-search input{flex:1;background:transparent;border:none;outline:none;color:var(--white);font-size:0.82rem;font-family:var(--font-body);}
      .plx-card{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:14px;padding:14px;margin-bottom:10px;transition:all 0.2s;}
      .plx-card:hover{background:rgba(196,142,100,0.05);border-color:rgba(196,142,100,0.25);transform:translateY(-1px);}
      .plx-card-top{display:flex;gap:12px;margin-bottom:10px;}
      .plx-icon{width:42px;height:42px;border-radius:10px;background:rgba(196,142,100,0.1);border:1px solid rgba(196,142,100,0.2);display:flex;align-items:center;justify-content:center;font-size:1.3rem;flex-shrink:0;}
      .plx-info{flex:1;min-width:0;}
      .plx-title{font-weight:700;font-size:0.9rem;color:var(--white);margin-bottom:5px;line-height:1.3;}
      .plx-meta{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:4px;}
      .plx-tag{padding:2px 8px;border-radius:20px;font-size:0.62rem;font-weight:700;background:rgba(255,255,255,0.07);color:rgba(255,255,255,0.55);}
      .plx-desc{font-size:0.75rem;color:var(--white-muted);line-height:1.5;margin-top:4px;}
      .plx-card-bot{display:flex;justify-content:space-between;align-items:center;}
      .plx-date{font-size:0.65rem;color:var(--white-muted);}
      .plx-btns{display:flex;gap:6px;}
      .plx-req-card{background:rgba(196,142,100,0.06);border:1.5px solid rgba(196,142,100,0.25);border-radius:16px;padding:16px;margin-bottom:16px;}
      .plx-my-req{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:10px 12px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;}
    </style>

    <div class="plx-header">
      <div class="page-eyebrow">Missions</div>
      <div class="page-heading mb-4">🎶 Streaming Playlists</div>
      <div class="text-muted mb-10" style="font-size:0.82rem">Team-approved playlists for streaming missions. ${official.length} playlist${official.length!==1?'s':''} available.</div>
      <button class="btn btn-primary btn-sm" onclick="_plShowRequest=!_plShowRequest;loadPlaylist()">
        ${_plShowRequest?'✕ Close Request':'📤 Request a Playlist'}
      </button>
    </div>

    <!-- Request Form -->
    ${_plShowRequest?`<div class="plx-req-card">
      <div class="section-title mb-10">📤 Request a Playlist</div>
      <div class="grid-2">
        <div class="form-group">
          <label class="form-label">Platform</label>
          <select class="form-input" id="pl-platform">
            <option>Spotify</option><option>Apple Music</option><option>YouTube Music</option><option>Other</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Category</label>
          <select class="form-input" id="pl-cat">
            <option>Focus</option><option>General</option><option>Team</option><option>Mission</option><option>Special</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Playlist Name</label>
        <input type="text" class="form-input" id="pl-name" placeholder="e.g. BTS Butter Chill Mix">
      </div>
      <div class="form-group">
        <label class="form-label">Playlist Link (optional)</label>
        <input type="url" class="form-input" id="pl-link" placeholder="https://open.spotify.com/playlist/...">
      </div>
      <div class="form-group">
        <label class="form-label">Reason / Note</label>
        <textarea class="form-input" id="pl-note" rows="2" placeholder="Why would this playlist help the team?"></textarea>
      </div>
      <button class="btn btn-primary btn-full" onclick="submitPlaylist()">📤 Submit Request</button>
    </div>`:''}

    <!-- My Requests -->
    ${mine.length?`<div class="section-title mb-8">My Requests (${mine.length})</div>
    ${mine.slice(0,3).map(r=>`<div class="plx-my-req">
      <div>
        <div style="font-weight:600;font-size:0.85rem">${escHtml(r.name)}</div>
        <div class="text-muted" style="font-size:0.7rem">${r.platform} · ${new Date(r.ts).toLocaleDateString()}</div>
      </div>
      <span class="badge ${r.status==='Approved'?'badge-green':r.status==='Rejected'?'badge-red':'badge-accent'}">${r.status||'Pending'}</span>
    </div>`).join('')}
    <div class="divider mb-14"></div>`:''}

    <!-- Filters -->
    <div class="plx-filters">
      <div class="plx-search">
        <span style="color:var(--white-muted)">🔍</span>
        <input type="text" value="${escHtml(_plSearch)}" placeholder="Search playlists…" oninput="_plSearch=this.value;loadPlaylist()">
      </div>
      <div class="plx-filter-row">
        ${['all','Focus','General','Team','Mission','Special'].map(c=>`<button class="plx-fb ${_plCatFilter===c?'on':''}" onclick="_plCatFilter='${c}';loadPlaylist()">${c==='all'?'All Categories':c}</button>`).join('')}
      </div>
      <div class="plx-filter-row">
        ${['all','Spotify','Apple Music','YouTube Music','Other'].map(p=>`<button class="plx-fb ${_plPlatFilter===p?'on':''}" onclick="_plPlatFilter='${p}';loadPlaylist()">${p==='all'?'All Platforms':p}</button>`).join('')}
        <button class="plx-fb ${_plSort==='new'?'on':''}" onclick="_plSort='new';loadPlaylist()">🆕 New</button>
        <button class="plx-fb ${_plSort==='old'?'on':''}" onclick="_plSort='old';loadPlaylist()">📅 Old</button>
        <button class="plx-fb ${_plSort==='az'?'on':''}" onclick="_plSort='az';loadPlaylist()">A→Z</button>
        <button class="plx-fb ${_plSort==='za'?'on':''}" onclick="_plSort='za';loadPlaylist()">Z→A</button>
      </div>
    </div>

    <!-- Official Playlists -->
    <div class="section-title mb-10">🎵 Official Playlists (${filtered.length})</div>
    ${filtered.length
      ? filtered.map(plCard).join('')
      : emptyState('🎶', official.length ? 'No playlists match your filters.' : 'No playlists yet. Admin will upload playlists soon!')}`;
}

function submitPlaylist() {
  const user = getCurrentUser(); if (!user || user.isAdmin) return;
  const platform = document.getElementById('pl-platform')?.value;
  const category = document.getElementById('pl-cat')?.value || 'General';
  const name = document.getElementById('pl-name')?.value.trim();
  const link = document.getElementById('pl-link')?.value.trim() || '';
  const note = document.getElementById('pl-note')?.value.trim() || '';
  if (!name) { showToast('Enter a playlist name.', 'warn'); return; }
  const r = DB.getPlaylists();
  r.push({ id: Date.now(), type: 'request', user: user.username, team: user.team||'', platform, category, name, link, note, ts: Date.now(), status: 'Pending' });
  DB.savePlaylists(r);
  showToast('Request submitted! Admin will review it. 🎶', 'success');
  DB.addNotif('playlist', `${user.username} requested playlist: ${name} on ${platform}`);
  logAction(user.username, 'playlist', 'Requested playlist: ' + name, { platform, category });
  _plShowRequest = false;
  loadPlaylist();
}

/* Admin: add official playlist */
function admAddPlaylist() {
  const title = document.getElementById('adm-pl-title')?.value.trim();
  const platform = document.getElementById('adm-pl-platform')?.value;
  const category = document.getElementById('adm-pl-cat')?.value;
  const team = document.getElementById('adm-pl-team')?.value;
  const link = document.getElementById('adm-pl-link')?.value.trim();
  const desc = document.getElementById('adm-pl-desc')?.value.trim();
  const featured = document.getElementById('adm-pl-featured')?.checked || false;
  if (!title) { showToast('Enter playlist title.', 'warn'); return; }
  const id = Date.now();
  const doc = { id, type: 'official', title, platform, category, team, link, desc, featured, ts: id, createdAt: new Date().toISOString(), uploadedBy: 'admin' };
  const arr = DB.getPlaylists(); arr.push(doc); DB.savePlaylists(arr);
  _fbSaveDoc('playlists', String(id), doc);
  showToast('Playlist added! ✅', 'success');
  DB.addNotif('system', 'Admin added playlist: ' + title);
  loadAdminPanel();
}

function admDelPlaylist(id) {
  if (!confirm('Delete this playlist?')) return;
  DB.savePlaylists(DB.getPlaylists().filter(p => String(p.id) !== String(id)));
  showToast('Playlist deleted.', 'success');
  loadAdminPanel();
}

function admApprovePlaylistReq(id, action) {
  const arr = DB.getPlaylists();
  const p = arr.find(x => String(x.id) === String(id));
  if (!p) return;
  p.status = action === 'approve' ? 'Approved' : 'Rejected';
  DB.savePlaylists(arr);
  showToast(action === 'approve' ? 'Request approved!' : 'Request rejected.', 'success');
  DB.addNotif('playlist', `Admin ${action}d playlist request from ${p.user}: ${p.name}`);
  loadAdminPanel();
}

/* ═══════════════════════════════════════════════
   SPEC 47 — DEFAULT GAME QUESTIONS
   Admin can replace these via Admin Panel
   ═══════════════════════════════════════════════ */
const DEFAULT_CPR = [
  { id: 'cpr1', q: 'What does BTS stand for?', opts: ['Bangtan Sonyeondan', 'Beyond The Scene', 'Both Sonyeondan', 'Bangtan Series'], ans: 0, hp: 5, time: 10 },
  { id: 'cpr2', q: 'Which member is "Suga"?', opts: ['Kim Seokjin', 'Min Yoongi', 'Jung Hoseok', 'Kim Namjoon'], ans: 1, hp: 5, time: 10 },
  { id: 'cpr3', q: 'What does "Borahae" mean?', opts: ['I love you', 'Purple you', 'Stream BTS', 'ARMY forever'], ans: 1, hp: 5, time: 10 },
  { id: 'cpr4', q: 'When did BTS debut?', opts: ['2010', '2011', '2012', '2013'], ans: 3, hp: 5, time: 10 },
  { id: 'cpr5', q: 'BTS fandom name?', opts: ['BTS Fan', 'Bangtan Army', 'ARMY', 'Purple Hearts'], ans: 2, hp: 5, time: 10 },
  { id: 'cpr6', q: '"Dynamite" was first in which language?', opts: ['Korean', 'Japanese', 'English', 'Spanish'], ans: 2, hp: 5, time: 10 },
  { id: 'cpr7', q: '"IDOL" is from which album?', opts: ['Wings', 'Love Yourself: Answer', 'Map of the Soul', 'BE'], ans: 1, hp: 5, time: 10 },
  { id: 'cpr8', q: 'BTS oldest member?', opts: ['RM', 'Jin', 'Suga', 'J-Hope'], ans: 1, hp: 5, time: 10 },
  { id: 'cpr9', q: '"In the SOOP" platform?', opts: ['Netflix', 'Weverse', 'Vlive', 'Hulu'], ans: 1, hp: 5, time: 10 },
];
const DEFAULT_DLD = [
  { id: 'dld1', lyric: '"No matter who you are, where you\'re from…"', song: 'DNA', hint: 'From Love Yourself: Her', hp: 5 },
  { id: 'dld2', lyric: '"I\'m so sick of this fake love…"', song: 'Fake Love', hint: 'From Love Yourself: Tear', hp: 5 },
  { id: 'dld3', lyric: '"Boy with luv, answer…"', song: 'Boy With Luv', hint: 'Feat. Halsey', hp: 5 },
  { id: 'dld4', lyric: '"Life goes on, like an arrow in the blue sky…"', song: 'Life Goes On', hint: 'From BE', hp: 5 },
  { id: 'dld5', lyric: '"Smooth like butter…"', song: 'Butter', hint: 'Summer bop 2021', hp: 5 },
];
const DEFAULT_JHOPE = [
  { id: 'jh1', hint: 'Rapping about sunshine and positivity.', song: 'Daydream', attempts: 3, hp: 6 },
  { id: 'jh2', hint: 'Expresses J-Hope\'s inner conflict about fame.', song: 'More', attempts: 3, hp: 6 },
  { id: 'jh3', hint: 'Dedicated to his mother.', song: 'Mama', attempts: 3, hp: 6 },
  { id: 'jh4', hint: 'Samples "Icky Thump" by The White Stripes.', song: 'Chicken Noodle Soup', attempts: 3, hp: 6 },
  { id: 'jh5', hint: 'J-Hope\'s solo debut performance track.', song: 'Hope World', attempts: 3, hp: 6 },
];

/* ─── GAMES (spec 47 — loads from DB, locks after completion) ─── */
function isGameDone(key) { const u = getCurrentUser(); if (!u || u.isAdmin) return false; return (u.completedGames || []).includes(key); }
function markGameDone(key, hp) {
  const user = getCurrentUser(); if (!user || user.isAdmin) return;
  user.completedGames = [...(user.completedGames || []), key];
  user.hpGames = (user.hpGames || 0) + hp; user.hp = (user.hp || 0) + hp; user.totalHp = (user.totalHp || 0) + hp;
  DB.saveMember(user); showHPPopup(hp); showToast(`Game complete! +${hp} HP 🎮`, 'success');
  DB.addNotif('game', `${user.username} completed: ${key}`);
  logAction(user.username, 'games', `Completed game: ${key}`, { hp });
}
const lockedHTML = name => `<div class="text-center p-16"><div style="font-size:2rem">🔒</div><div style="font-family:var(--font-display);font-size:0.9rem;color:var(--accent-1);margin-top:8px">ALREADY COMPLETED</div><div class="text-muted mt-8">${name} is locked. Admin can reset it.</div></div>`;

/* Purple CPR */
let cprState = { current: [], idx: 0, score: 0, timer: null };
function initCPR() {
  const el = document.getElementById('cpr-game-area');
  if (isGameDone('cpr')) { el.innerHTML = lockedHTML('Purple CPR'); return; }
  const questions = DB.getCPRQuestions();
  cprState.current = [...questions].sort(() => Math.random() - .5).slice(0, Math.min(5, questions.length));
  cprState.idx = 0; cprState.score = 0; renderCPR();
}
function renderCPR() {
  const el = document.getElementById('cpr-game-area'); if (!el) return;
  if (cprState.idx >= cprState.current.length) {
    const totalHP = cprState.current.reduce((s, q) => s + (q.hp || HP.GAME_CPR), 0);
    const earned = Math.round((cprState.score / cprState.current.length) * totalHP);
    markGameDone('cpr', earned);
    el.innerHTML = `<div class="text-center p-16"><div style="font-size:2rem">🎉</div><div style="font-family:var(--font-display);font-size:1.2rem;color:var(--accent-1);margin-top:8px">Score: ${cprState.score}/${cprState.current.length}</div><div class="text-muted mt-8">+${earned} HP earned!</div><div class="badge badge-green mt-12">✅ Complete — Locked</div></div>`;
    return;
  }
  const q = cprState.current[cprState.idx]; let tl = q.time || 10; clearInterval(cprState.timer);
  el.innerHTML = `<div style="display:flex;justify-content:space-between;margin-bottom:12px"><span class="badge badge-accent">Q${cprState.idx + 1}/${cprState.current.length}</span><span id="cpr-t" style="font-family:var(--font-display);font-size:1.4rem;color:var(--accent-1)">${tl}</span></div><div style="font-size:0.96rem;font-weight:600;color:var(--white);margin-bottom:16px;line-height:1.5">${escHtml(q.q)}</div><div class="grid-2" id="cpr-opts">${q.opts.map((o, i) => `<button class="btn btn-secondary" style="text-align:left;padding:10px 13px;font-size:0.82rem" onclick="ansCPR(${i})">${escHtml(o)}</button>`).join('')}</div>`;
  cprState.timer = setInterval(() => { tl--; const t = document.getElementById('cpr-t'); if (t) { t.textContent = tl; if (tl <= 3) t.style.color = 'var(--pink)'; } if (tl <= 0) { clearInterval(cprState.timer); ansCPR(-1); } }, 1000);
}
function ansCPR(i) {
  clearInterval(cprState.timer); const q = cprState.current[cprState.idx];
  document.querySelectorAll('#cpr-opts button').forEach((b, j) => { b.disabled = true; if (j === q.ans) b.style.background = 'rgba(39,174,96,0.3)'; if (j === i && i !== q.ans) b.style.background = 'rgba(192,57,43,0.3)'; });
  if (i === q.ans) cprState.score++; cprState.idx++; setTimeout(renderCPR, 900);
}

/* DLD */
let dldState = { current: [], idx: 0, score: 0 };
function initDLD() {
  const el = document.getElementById('dld-game-area');
  if (isGameDone('dld')) { el.innerHTML = lockedHTML('Don\'t Leave Du'); return; }
  const questions = DB.getDLDQuestions();
  dldState.current = [...questions].sort(() => Math.random() - .5).slice(0, Math.min(3, questions.length));
  dldState.idx = 0; dldState.score = 0; renderDLD();
}
function renderDLD() {
  const el = document.getElementById('dld-game-area'); if (!el) return;
  if (dldState.idx >= dldState.current.length) {
    const earned = dldState.score * HP.GAME_DLD;
    markGameDone('dld', earned);
    el.innerHTML = `<div class="text-center p-16"><div style="font-size:2rem">🎤</div><div class="grad-text" style="font-family:var(--font-display);font-size:1.2rem;margin-top:8px">Score: ${dldState.score}/${dldState.current.length}</div><div class="text-muted mt-8">+${earned} HP!</div><div class="badge badge-green mt-12">✅ Complete — Locked</div></div>`;
    return;
  }
  const q = dldState.current[dldState.idx];
  const allSongs = DB.getDLDQuestions().map(x => x.song);
  const opts = [...new Set([q.song, ...allSongs.filter(s => s !== q.song).sort(() => Math.random() - .5).slice(0, 3)])].sort(() => Math.random() - .5);
  el.innerHTML = `<div class="badge badge-accent mb-12">Lyric ${dldState.idx + 1}/${dldState.current.length}</div>${q.hint ? `<div class="text-muted mb-8" style="font-size:0.78rem">💡 Hint: ${escHtml(q.hint)}</div>` : ''}<div style="font-style:italic;color:var(--accent-2);font-size:0.96rem;margin-bottom:16px;padding:10px;background:var(--bg-glass);border-radius:var(--radius-md);border:1px solid var(--border-color)">${escHtml(q.lyric)}</div><div class="grid-2">${opts.map(o => `<button class="btn btn-secondary" style="font-size:0.82rem" onclick="ansDLD('${escHtml(o)}','${escHtml(q.song)}')">${escHtml(o)}</button>`).join('')}</div>`;
}
function ansDLD(c, correct) { document.querySelectorAll('#dld-game-area button').forEach(b => { b.disabled = true; if (b.textContent === correct) b.style.background = 'rgba(39,174,96,0.3)'; if (b.textContent === c && c !== correct) b.style.background = 'rgba(192,57,43,0.3)'; }); if (c === correct) dldState.score++; dldState.idx++; setTimeout(renderDLD, 800); }

/* J-Hope Time */
let jhopeState = { current: [], idx: 0, score: 0, attempts: 0 };
function initJHope() {
  const el = document.getElementById('jhope-game-area');
  if (isGameDone('jhope')) { el.innerHTML = lockedHTML('J-Hope Time'); return; }
  const questions = DB.getJHopeQuestions();
  jhopeState.current = [...questions].sort(() => Math.random() - .5).slice(0, Math.min(3, questions.length));
  jhopeState.idx = 0; jhopeState.score = 0; renderJHope();
}
function renderJHope() {
  const el = document.getElementById('jhope-game-area'); if (!el) return;
  if (jhopeState.idx >= jhopeState.current.length) {
    const earned = jhopeState.score * HP.GAME_JHOPE;
    markGameDone('jhope', earned);
    el.innerHTML = `<div class="text-center p-16"><div style="font-size:2rem">💃</div><div class="grad-text" style="font-family:var(--font-display);font-size:1.2rem;margin-top:8px">Score: ${jhopeState.score}/${jhopeState.current.length}</div><div class="text-muted mt-8">+${earned} HP!</div><div class="badge badge-green mt-12">✅ Complete — Locked</div></div>`;
    return;
  }
  const q = jhopeState.current[jhopeState.idx]; jhopeState.attempts = 0; const maxAtt = q.attempts || 3;
  el.innerHTML = `<div class="badge badge-accent mb-12">Round ${jhopeState.idx + 1}/${jhopeState.current.length}</div>
    ${q.imageData ? `<img src="${q.imageData}" style="max-width:100%;max-height:200px;object-fit:contain;border-radius:var(--radius-md);margin-bottom:12px;display:block">` : ''}
    <div style="background:var(--bg-glass);border:1px solid var(--border-color);border-radius:var(--radius-md);padding:12px;margin-bottom:14px;font-size:0.9rem;color:var(--white-dim)">${escHtml(q.hint)}</div>
    <div class="form-group"><input type="text" class="form-input" id="jh-ans" placeholder="Guess the J-Hope song…" onkeydown="if(event.key==='Enter')submitJH()"></div>
    <div style="display:flex;gap:8px;align-items:center"><button class="btn btn-primary" onclick="submitJH()">Submit</button><span id="jh-att" class="text-muted" style="font-size:0.78rem">${maxAtt} attempts</span></div>
    <div id="jh-fb" class="mt-8"></div>`;
}
function submitJH() {
  const inp = document.getElementById('jh-ans'); if (!inp) return;
  const a = inp.value.trim(); const q = jhopeState.current[jhopeState.idx]; jhopeState.attempts++;
  const maxAtt = q.attempts || 3;
  if (a.toLowerCase() === q.song.toLowerCase()) { jhopeState.score++; document.getElementById('jh-fb').innerHTML = `<div class="badge badge-green">✅ "${escHtml(q.song)}"</div>`; jhopeState.idx++; setTimeout(renderJHope, 900); }
  else if (jhopeState.attempts >= maxAtt) { document.getElementById('jh-fb').innerHTML = `<div class="badge badge-red">❌ Answer: "${escHtml(q.song)}"</div>`; jhopeState.idx++; setTimeout(renderJHope, 900); }
  else { const r = maxAtt - jhopeState.attempts; document.getElementById('jh-att').textContent = `${r} attempt${r !== 1 ? 's' : ''} left`; document.getElementById('jh-fb').innerHTML = `<div class="badge badge-pink">Try again!</div>`; inp.value = ''; }
}

/* ─── COMMUNITY ─── */
function getTeamStats() {
  const m = DB.getMembers().filter(x => !x.isAdmin);
  const h = m.filter(x => x.team === 'Hyung Line'), mk = m.filter(x => x.team === 'Maknae Line');
  return { hyung: { count: h.length, hp: h.reduce((s, x) => s + (x.hp || 0), 0), streams: h.reduce((s, x) => s + (x.streams || 0), 0), members: h }, maknae: { count: mk.length, hp: mk.reduce((s, x) => s + (x.hp || 0), 0), streams: mk.reduce((s, x) => s + (x.streams || 0), 0), members: mk } };
}
let _teamListener = null;
function loadTeam() {
  const el = document.getElementById('sec-team'); if (!el) return;
  const user = getCurrentUser();
  const db = FSB._db();
  if (db && !_teamListener) {
    _teamListener = db.collection('members').onSnapshot(() => {
      const el2 = document.getElementById('sec-team');
      if (el2) _renderTeam(el2, getCurrentUser());
    }, () => {});
  }
  _renderTeam(el, user);
}

function _renderTeam(el, user) {
  const allMembers = DB.getMembers().filter(m => !m.isAdmin);
  const hyung  = allMembers.filter(m => m.team === 'Hyung Line').sort((a,b) => (b.hp||0)-(a.hp||0));
  const maknae = allMembers.filter(m => m.team === 'Maknae Line').sort((a,b) => (b.hp||0)-(a.hp||0));

  const hHP    = hyung.reduce((s,m)  => s+(m.hp||0), 0);
  const mHP    = maknae.reduce((s,m) => s+(m.hp||0), 0);
  const hStr   = hyung.reduce((s,m)  => s+(m.streams||m.lifetimeStreams||0), 0);
  const mStr   = maknae.reduce((s,m) => s+(m.streams||m.lifetimeStreams||0), 0);
  const hWkStr = hyung.reduce((s,m)  => s+(m.weeklyStreams||0), 0);
  const mWkStr = maknae.reduce((s,m) => s+(m.weeklyStreams||0), 0);
  const tot    = (hHP + mHP) || 1;
  const totStr = (hStr + mStr) || 1;
  const leading = hHP > mHP ? 'hyung' : mHP > hHP ? 'maknae' : 'tied';
  const maxHP  = Math.max(1, ...allMembers.map(x => x.hp||0));

  // Inject CSS once
  if (!document.getElementById('team-css')) {
    const s = document.createElement('style');
    s.id = 'team-css';
    s.textContent = [
      '.team-base{border-radius:18px;padding:20px;margin-bottom:20px;position:relative;overflow:hidden;}',
      '.team-base::before{content:"";position:absolute;inset:0;background:radial-gradient(ellipse at 50% 0%,var(--tglow,rgba(196,142,100,0.12)) 0%,transparent 65%);pointer-events:none;}',
      '.team-base-hyung{background:linear-gradient(135deg,rgba(196,142,100,0.08),rgba(196,142,100,0.03));border:1.5px solid rgba(196,142,100,0.35);}',
      '.team-base-maknae{background:linear-gradient(135deg,rgba(236,72,153,0.08),rgba(236,72,153,0.03));border:1.5px solid rgba(236,72,153,0.35);}',
      '.team-base-name{font-family:var(--font-display);font-size:1.3rem;font-weight:800;margin-bottom:4px;}',
      '.team-power-num{font-family:var(--font-display);font-size:2.2rem;font-weight:900;line-height:1;}',
      '.team-base-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:14px 0;}',
      '.team-base-stat{background:rgba(0,0,0,0.2);border-radius:10px;padding:10px;text-align:center;}',
      '.team-base-stat-val{font-weight:800;font-size:1rem;margin-bottom:2px;}',
      '.team-base-stat-lbl{font-size:0.62rem;color:var(--white-muted);letter-spacing:0.5px;text-transform:uppercase;}',
      '.team-prog-wrap{height:8px;background:rgba(255,255,255,0.06);border-radius:4px;overflow:hidden;margin-top:12px;}',
      '.team-prog-fill{height:100%;border-radius:4px;transition:width 0.8s cubic-bezier(0.34,1.56,0.64,1);}',
      '.team-member-card{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:14px;padding:12px;margin-bottom:8px;border-left:3px solid var(--tc,#c48e64);}',
      '.team-card-me{background:rgba(196,142,100,0.06)!important;border-color:rgba(196,142,100,0.4)!important;}',
      '.team-card-header{display:flex;align-items:center;gap:10px;margin-bottom:10px;}',
      '.team-card-avatar{width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:1rem;flex-shrink:0;}',
      '.team-card-info{flex:1;min-width:0;}',
      '.team-card-name{font-weight:700;font-size:0.88rem;display:flex;align-items:center;gap:6px;flex-wrap:wrap;}',
      '.team-card-sub{font-size:0.68rem;color:var(--white-muted);}',
      '.team-you-tag{font-size:0.58rem;background:rgba(196,142,100,0.25);color:var(--accent-1);border-radius:4px;padding:1px 5px;font-weight:700;}',
      '.team-online-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;}',
      '.team-online-dot.online{background:#2ecc71;box-shadow:0 0 6px rgba(46,204,113,0.6);}',
      '.team-online-dot.offline{background:rgba(255,255,255,0.18);}',
      '.team-card-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:8px;}',
      '.team-stat{text-align:center;}',
      '.team-stat-val{font-weight:700;font-size:0.82rem;color:var(--white);}',
      '.team-stat-lbl{font-size:0.58rem;color:var(--white-muted);text-transform:uppercase;letter-spacing:0.5px;}',
      '.team-card-bar{height:3px;background:rgba(255,255,255,0.06);border-radius:2px;overflow:hidden;}',
      '.team-vs-card{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:16px;margin-bottom:20px;text-align:center;}',
    ].join('');
    document.head.appendChild(s);
  }

  // Build member card HTML (no nested template literals — use string concat)
  function memberCard(m, teamColor) {
    var isMe    = m.username === (user && user.username);
    var initial = (m.username||'?').charAt(0).toUpperCase();
    var online  = m.onlineStatus === 'online';
    var streams = m.streams || m.lifetimeStreams || 0;
    var wkStr   = m.weeklyStreams || 0;
    var totHP   = m.totalHp || m.hp || 0;
    var contrib = totStr > 0 ? Math.round((streams / totStr) * 100) : 0;
    var lv      = Math.floor((m.hp||0)/1000)+1;
    var barW    = Math.min(100, Math.round((m.hp||0)/maxHP*100));
    var lastSeen = m.lastActive ? new Date(m.lastActive).toLocaleString() : 'Never';

    return '<div class="team-member-card' + (isMe?' team-card-me':'') + '" style="--tc:' + teamColor + '">' +
      '<div class="team-card-header">' +
        '<div class="team-card-avatar" style="background:' + teamColor.replace('var(--accent-1)','rgba(196,142,100,0.2)').replace('var(--pink)','rgba(236,72,153,0.2)') + ';color:' + teamColor + '">' + initial + '</div>' +
        '<div class="team-card-info">' +
          '<div class="team-card-name">' + escHtml(m.username) + (isMe?'<span class="team-you-tag">you</span>':'') + '</div>' +
          '<div class="team-card-sub">Lv.' + lv + ' · ' + escHtml(m.team||'—') + ' · ' + (online?'<span style="color:#2ecc71">Online</span>':'<span style="color:var(--white-muted)">'+lastSeen+'</span>') + '</div>' +
        '</div>' +
        '<div class="team-online-dot ' + (online?'online':'offline') + '"></div>' +
      '</div>' +
      '<div class="team-card-stats">' +
        '<div class="team-stat"><div class="team-stat-val" style="color:' + teamColor + '">' + formatNum(m.hp||0) + '</div><div class="team-stat-lbl">HP</div></div>' +
        '<div class="team-stat"><div class="team-stat-val">' + formatNum(totHP) + '</div><div class="team-stat-lbl">Total HP</div></div>' +
        '<div class="team-stat"><div class="team-stat-val">' + formatNum(streams) + '</div><div class="team-stat-lbl">Streams</div></div>' +
        '<div class="team-stat"><div class="team-stat-val">' + formatNum(wkStr) + '</div><div class="team-stat-lbl">This Wk</div></div>' +
      '</div>' +
      '<div class="team-card-bar"><div style="height:100%;width:' + barW + '%;background:' + teamColor + ';border-radius:2px;transition:width 0.6s"></div></div>' +
    '</div>';
  }

  // Build team base HTML
  function teamBase(members, name, color, hp, streams, wkStreams, pct) {
    var energy   = Math.min(100, Math.round((hp / tot) * 100));
    var emoji    = name === 'Hyung Line' ? '💜' : '🩷';
    var cls      = name === 'Hyung Line' ? 'team-base-hyung' : 'team-base-maknae';
    return '<div class="team-base ' + cls + '">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px">' +
        '<div>' +
          '<div class="team-base-name" style="color:' + color + '">' + emoji + ' ' + name + '</div>' +
          '<div style="font-size:0.75rem;color:var(--white-muted)">' + members.length + ' member' + (members.length!==1?'s':'') + '</div>' +
        '</div>' +
        '<div style="text-align:right">' +
          '<div style="font-size:0.68rem;color:var(--white-muted);text-transform:uppercase;letter-spacing:1px">Team Energy</div>' +
          '<div class="team-power-num" style="color:' + color + '">' + energy + '%</div>' +
        '</div>' +
      '</div>' +
      '<div class="team-base-stats">' +
        '<div class="team-base-stat"><div class="team-base-stat-val" style="color:' + color + '">' + formatNum(hp) + '</div><div class="team-base-stat-lbl">Total HP</div></div>' +
        '<div class="team-base-stat"><div class="team-base-stat-val">' + formatNum(streams) + '</div><div class="team-base-stat-lbl">All Streams</div></div>' +
        '<div class="team-base-stat"><div class="team-base-stat-val">' + formatNum(wkStreams) + '</div><div class="team-base-stat-lbl">This Week</div></div>' +
      '</div>' +
      '<div class="team-prog-wrap"><div class="team-prog-fill" style="width:' + pct.toFixed(1) + '%;background:' + color + '"></div></div>' +
    '</div>';
  }

  // VS comparison card
  var leadMsg  = leading==='hyung' ? '💜 Hyung Line is leading!' : leading==='maknae' ? '🩷 Maknae Line is leading!' : '⚖️ Teams are tied!';
  var leadColor = leading==='hyung' ? 'var(--accent-1)' : leading==='maknae' ? 'var(--pink)' : 'var(--white-muted)';
  var hPct = (hHP/tot*100).toFixed(1);

  var vsCard = '<div class="team-vs-card mb-16">' +
    '<div style="font-size:0.65rem;letter-spacing:3px;color:var(--white-muted);margin-bottom:10px">TEAM BATTLE</div>' +
    '<div style="display:flex;align-items:center;justify-content:center;gap:16px">' +
      '<div style="text-align:center"><div style="font-size:1.4rem;font-weight:900;color:var(--accent-1)">' + formatNum(hHP) + '</div><div style="font-size:0.7rem;color:var(--accent-1)">💜 Hyung HP</div></div>' +
      '<div style="font-size:1.2rem;font-weight:900;color:var(--white-muted)">VS</div>' +
      '<div style="text-align:center"><div style="font-size:1.4rem;font-weight:900;color:var(--pink)">' + formatNum(mHP) + '</div><div style="font-size:0.7rem;color:var(--pink)">🩷 Maknae HP</div></div>' +
    '</div>' +
    '<div style="height:6px;background:rgba(255,255,255,0.06);border-radius:3px;overflow:hidden;margin:12px 0;display:flex">' +
      '<div style="height:100%;width:' + hPct + '%;background:var(--accent-1);border-radius:3px 0 0 3px;transition:width 0.8s"></div>' +
      '<div style="height:100%;flex:1;background:var(--pink);border-radius:0 3px 3px 0"></div>' +
    '</div>' +
    '<div style="font-size:0.8rem;font-weight:700;color:' + leadColor + '">' + leadMsg + '</div>' +
  '</div>';

  // Assemble page
  el.innerHTML =
    '<div class="page-eyebrow">Community</div>' +
    '<div class="page-heading mb-16">⚡ Team Bases</div>' +
    vsCard +
    teamBase(hyung,  'Hyung Line',  'var(--accent-1)', hHP, hStr, hWkStr, hHP/tot*100) +
    teamBase(maknae, 'Maknae Line', 'var(--pink)',      mHP, mStr, mWkStr, mHP/tot*100) +
    '<div class="section-title mb-10">💜 Hyung Line Members (' + hyung.length + ')</div>' +
    (hyung.length  ? hyung.map(function(m){return memberCard(m,'var(--accent-1)');}).join('') : emptyState('💜','No Hyung Line members yet.')) +
    '<div class="section-title mt-16 mb-10">🩷 Maknae Line Members (' + maknae.length + ')</div>' +
    (maknae.length ? maknae.map(function(m){return memberCard(m,'var(--pink)');}).join('')   : emptyState('🩷','No Maknae Line members yet.'));
}

/* ── Leaderboard state ── */
let _lbTab = 'worldwide';
let _lbListener = null;

function loadLeaderboard() {
  const el = document.getElementById('sec-leaderboard'); if (!el) return;
  _renderLeaderboard(el);
  // Firebase realtime listener
  const db = FSB._db();
  if (db && !_lbListener) {
    _lbListener = db.collection('members').onSnapshot(() => {
      const el2 = document.getElementById('sec-leaderboard');
      if (el2) _renderLeaderboard(el2);
    }, () => {});
  }
}

function _lbDedup(arr) {
  const seen = new Set();
  return arr.filter(m => {
    const k = m.uid || m.username;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

function _renderLeaderboard(el) {
  const user = getCurrentUser();
  const allRaw = DB.getMembers().filter(m => !m.isAdmin);
  const all = _lbDedup(allRaw);
  const hyung = all.filter(m => m.team === 'Hyung Line');
  const maknae = all.filter(m => m.team === 'Maknae Line');
  const hyungHP = hyung.reduce((s,m) => s+(m.hp||0), 0);
  const maknaeHP = maknae.reduce((s,m) => s+(m.hp||0), 0);
  const hyungStr = hyung.reduce((s,m) => s+(m.streams||0), 0);
  const maknaeStr = maknae.reduce((s,m) => s+(m.streams||0), 0);
  const leading = hyungHP > maknaeHP ? 'Hyung Line' : maknaeHP > hyungHP ? 'Maknae Line' : 'Tied';

  // Sort by HP, then by joinedAt, then username — always rank everyone
  function _lbSort(arr) {
    return [...arr].sort((a,b) => {
      const hpDiff = (b.hp||0)-(a.hp||0);
      if(hpDiff!==0) return hpDiff;
      const aDate=a.joinedAt||a.lastActive||''; const bDate=b.joinedAt||b.lastActive||'';
      if(aDate&&bDate) return aDate<bDate?-1:1;
      return (a.username||'').localeCompare(b.username||'');
    });
  }
  const globalSorted = _lbSort(all);
  const hyungSorted  = _lbSort(hyung);
  const makneSorted  = _lbSort(maknae);

  // My ranks
  const _myGlobalIdx = globalSorted.findIndex(m => m.username === user?.username);
  const myGlobalRank = _myGlobalIdx >= 0 ? _myGlobalIdx + 1 : globalSorted.length + 1;
  const myTeam = user?.team || '';
  const myTeamSorted = myTeam === 'Hyung Line' ? hyungSorted : makneSorted;
  const _myTeamIdx = myTeamSorted.findIndex(m => m.username === user?.username);
  const myTeamRank = _myTeamIdx >= 0 ? _myTeamIdx + 1 : myTeamSorted.length + 1;

  // Weekly champion = highest hp this week
  const champion = globalSorted[0];

  // Active list
  const activeList = _lbTab === 'worldwide' ? globalSorted
    : _lbTab === 'hyung' ? hyungSorted : makneSorted;

  function rankBadge(r) {
    if (r === 1) return `<div class="zlb-rank zlb-gold">👑</div>`;
    if (r === 2) return `<div class="zlb-rank zlb-silver">🥈</div>`;
    if (r === 3) return `<div class="zlb-rank zlb-bronze">🥉</div>`;
    return `<div class="zlb-rank zlb-num">#${r}</div>`;
  }

  function memberCard(m, rank) {
    const isMe = m.username === user?.username;
    const lv = Math.floor((m.hp||0)/1000)+1;
    const missions = (m.completedMissions||[]).length;
    const glowClass = rank===1?'zlb-c-gold':rank===2?'zlb-c-silver':rank===3?'zlb-c-bronze':isMe?'zlb-c-me':'';
    const teamColor = m.team==='Hyung Line'?'var(--accent-1)':'var(--pink)';
    return `<div class="zlb-card ${glowClass}">
      <div class="zlb-card-left">
        ${rankBadge(rank)}
        <div class="zlb-avatar" style="background:${teamColor}">${m.username.charAt(0).toUpperCase()}</div>
      </div>
      <div class="zlb-card-mid">
        <div class="zlb-name">${escHtml(m.username)}${isMe?' <span class="zlb-you">you</span>':''}</div>
        <div class="zlb-team" style="color:${teamColor}">${escHtml(m.team||'—')} · Lv.${lv}</div>
        <div class="zlb-stats">
          <span>💜 ${formatNum(m.hp||0)} HP</span>
          <span>🎵 ${formatNum(m.streams||0)}</span>
          <span>🎯 ${missions}</span>
        </div>
      </div>
      <div class="zlb-card-right">
        <div class="zlb-hp-big">${formatNum(m.hp||0)}</div>
        <div class="zlb-total">Total: ${formatNum(m.totalHp||0)}</div>
      </div>
    </div>`;
  }

  el.innerHTML = `
    <style>
      .zlb-tabs{display:flex;gap:6px;margin-bottom:16px;background:rgba(0,0,0,0.3);border-radius:12px;padding:5px;}
      .zlb-tab{flex:1;padding:9px 4px;border:none;border-radius:9px;background:transparent;color:rgba(255,255,255,0.5);font-family:var(--font-ui);font-size:0.78rem;font-weight:700;cursor:pointer;transition:all 0.2s;text-align:center;}
      .zlb-tab.active{background:linear-gradient(135deg,rgba(196,142,100,0.25),rgba(196,142,100,0.1));color:var(--accent-1);box-shadow:0 0 12px rgba(196,142,100,0.2);}
      .zlb-rank-cards{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px;}
      .zlb-rank-card{background:rgba(196,142,100,0.08);border:1.5px solid rgba(196,142,100,0.3);border-radius:14px;padding:14px;text-align:center;}
      .zlb-rank-card .big{font-family:var(--font-display);font-size:1.8rem;font-weight:800;color:var(--accent-1);line-height:1;}
      .zlb-rank-card .sub{font-size:0.68rem;color:var(--white-muted);margin-top:4px;letter-spacing:1px;text-transform:uppercase;}
      .zlb-champion{background:linear-gradient(135deg,rgba(196,142,100,0.15),rgba(147,51,234,0.08));border:1.5px solid rgba(196,142,100,0.5);border-radius:16px;padding:16px;margin-bottom:16px;text-align:center;position:relative;overflow:hidden;}
      .zlb-champion::before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse at 50% 0%,rgba(196,142,100,0.12) 0%,transparent 70%);pointer-events:none;}
      .zlb-champ-crown{font-size:1.8rem;margin-bottom:6px;}
      .zlb-champ-name{font-family:var(--font-display);font-size:1.1rem;font-weight:800;color:var(--accent-1);}
      .zlb-champ-sub{font-size:0.75rem;color:var(--white-muted);margin-top:4px;}
      .zlb-team-summary{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px;}
      .zlb-team-card{border-radius:12px;padding:12px;border:1.5px solid;}
      .zlb-team-card.hyung{border-color:rgba(196,142,100,0.4);background:rgba(196,142,100,0.06);}
      .zlb-team-card.maknae{border-color:rgba(236,72,153,0.4);background:rgba(236,72,153,0.06);}
      .zlb-team-name{font-weight:800;font-size:0.85rem;margin-bottom:6px;}
      .zlb-team-stat{font-size:0.72rem;color:var(--white-muted);line-height:1.8;}
      .zlb-leading{background:linear-gradient(135deg,rgba(196,142,100,0.12),rgba(147,51,234,0.06));border:1px solid rgba(196,142,100,0.3);border-radius:10px;padding:10px;margin-bottom:16px;text-align:center;font-size:0.82rem;font-weight:700;color:var(--accent-1);}
      .zlb-list{display:flex;flex-direction:column;gap:8px;}
      .zlb-card{display:flex;align-items:center;gap:10px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:14px;padding:12px;transition:all 0.2s;}
      .zlb-card:hover{background:rgba(255,255,255,0.05);transform:translateY(-1px);}
      .zlb-c-gold{border-color:rgba(196,142,100,0.6)!important;background:rgba(196,142,100,0.08)!important;box-shadow:0 0 20px rgba(196,142,100,0.15);}
      .zlb-c-silver{border-color:rgba(192,192,192,0.5)!important;background:rgba(192,192,192,0.05)!important;}
      .zlb-c-bronze{border-color:rgba(176,141,87,0.5)!important;background:rgba(176,141,87,0.05)!important;}
      .zlb-c-me{border-color:rgba(147,51,234,0.5)!important;background:rgba(147,51,234,0.06)!important;}
      .zlb-card-left{display:flex;flex-direction:column;align-items:center;gap:6px;min-width:44px;}
      .zlb-rank{width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:1rem;font-weight:800;}
      .zlb-gold{background:rgba(196,142,100,0.2);font-size:1.2rem;}
      .zlb-silver{background:rgba(192,192,192,0.15);font-size:1.1rem;}
      .zlb-bronze{background:rgba(176,141,87,0.15);font-size:1rem;}
      .zlb-num{background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.5);font-size:0.72rem;}
      .zlb-avatar{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:0.9rem;color:#fff;}
      .zlb-card-mid{flex:1;min-width:0;}
      .zlb-name{font-weight:700;font-size:0.88rem;color:var(--white);display:flex;align-items:center;gap:5px;}
      .zlb-you{font-size:0.58rem;background:rgba(147,51,234,0.3);color:#c4b5fd;border-radius:4px;padding:1px 5px;font-weight:700;}
      .zlb-team{font-size:0.7rem;font-weight:600;margin-bottom:3px;}
      .zlb-stats{display:flex;gap:8px;font-size:0.65rem;color:rgba(255,255,255,0.5);flex-wrap:wrap;}
      .zlb-card-right{text-align:right;min-width:60px;}
      .zlb-hp-big{font-family:var(--font-display);font-size:1rem;font-weight:800;color:var(--accent-1);}
      .zlb-total{font-size:0.6rem;color:var(--white-muted);}
    </style>

    <div class="page-eyebrow">Community</div>
    <div class="page-heading mb-12">🏆 Leaderboard</div>

    <!-- My Rank Cards -->
    ${user&&!user.isAdmin?`<div class="zlb-rank-cards">
      <div class="zlb-rank-card">
        <div class="big">#${myGlobalRank}</div>
        <div class="sub">🌍 Worldwide</div>
      </div>
      <div class="zlb-rank-card">
        <div class="big">#${myTeamRank}</div>
        <div class="sub">${myTeam||'Team'} Rank</div>
      </div>
    </div>`:''}

    <!-- Weekly Champion -->
    ${champion?`<div class="zlb-champion">
      <div class="zlb-champ-crown">🏆</div>
      <div style="font-size:0.62rem;letter-spacing:3px;color:rgba(196,142,100,0.6);margin-bottom:4px">WEEKLY CHAMPION</div>
      <div class="zlb-champ-name">${escHtml(champion.username)}</div>
      <div class="zlb-champ-sub">${escHtml(champion.team||'—')} · ${formatNum(champion.hp||0)} HP · ${formatNum(champion.streams||0)} streams</div>
    </div>`:''}

    <!-- Team Summary -->
    <div class="zlb-team-summary">
      <div class="zlb-team-card hyung">
        <div class="zlb-team-name" style="color:var(--accent-1)">💜 Hyung Line</div>
        <div class="zlb-team-stat">${hyung.length} members<br>${formatNum(hyungHP)} HP<br>${formatNum(hyungStr)} streams</div>
      </div>
      <div class="zlb-team-card maknae">
        <div class="zlb-team-name" style="color:var(--pink)">🩷 Maknae Line</div>
        <div class="zlb-team-stat">${maknae.length} members<br>${formatNum(maknaeHP)} HP<br>${formatNum(maknaeStr)} streams</div>
      </div>
    </div>
    <div class="zlb-leading">🏆 Leading: ${leading==='Tied'?'⚖️ Tied!':leading+' is ahead!'}</div>

    <!-- Tabs -->
    <div class="zlb-tabs">
      <button class="zlb-tab ${_lbTab==='worldwide'?'active':''}" onclick="_lbTab='worldwide';_renderLeaderboard(document.getElementById('sec-leaderboard'))">🌍 Worldwide</button>
      <button class="zlb-tab ${_lbTab==='hyung'?'active':''}" onclick="_lbTab='hyung';_renderLeaderboard(document.getElementById('sec-leaderboard'))">💜 Hyung Line</button>
      <button class="zlb-tab ${_lbTab==='maknae'?'active':''}" onclick="_lbTab='maknae';_renderLeaderboard(document.getElementById('sec-leaderboard'))">✨ Maknae Line</button>
    </div>

    <!-- Rankings -->
    <div class="zlb-list">
      ${activeList.length
        ? activeList.map((m,i) => memberCard(m, i+1)).join('')
        : emptyState('🏆','No members in this category yet.')}
    </div>`;
}

/* ─── CHAT ─── */
let chatInterval = null;
let _chatListener = null;
const CHAT_COLLECTION = 'bellsSquadMessages';

function loadChat() {
  const container = document.getElementById('chat-messages'); if (!container) return;
  const user = getCurrentUser();
  const db = FSB._db();

  function renderMsg(m, user) {
    const mine = m.username === (user && user.username) || m.user === (user && user.username);
    const uname = m.username || m.user || '?';
    const teamColor = m.team === 'Hyung Line' ? 'var(--accent-1)' : 'var(--pink)';
    const t = m.createdAt ? new Date(m.createdAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : formatTime(m.ts||Date.now());
    return `<div class="chat-msg-row ${mine ? 'mine' : 'other'}">
      <div class="chat-av" style="background:${teamColor}">${uname.charAt(0).toUpperCase()}</div>
      <div>
        <div class="chat-meta" style="color:${teamColor}">${escHtml(uname)} <span style="color:var(--white-muted);font-size:0.65rem">· ${escHtml(m.team||'')} · ${t}</span></div>
        <div class="chat-bubble ${mine ? 'mine' : 'other'}">${escHtml(m.text)}</div>
      </div>
    </div>`;
  }

  // Set up realtime listener on bellsSquadMessages
  if (!_chatListener && db) {
    _chatListener = db.collection(CHAT_COLLECTION)
      .orderBy('createdAt').limitToLast(300)
      .onSnapshot(snap => {
        const c2 = document.getElementById('chat-messages'); if (!c2) return;
        const atBot = c2.scrollHeight - c2.scrollTop <= c2.clientHeight + 100;
        const msgs = snap.docs.map(d => ({id:d.id, ...d.data()}));
        c2.innerHTML = msgs.map(m => renderMsg(m, user)).join('') ||
          `<div class="text-muted text-center" style="padding:20px;font-size:0.82rem">No messages yet. Say hello! 💜</div>`;
        if (atBot) c2.scrollTop = c2.scrollHeight;
      }, () => {
        // Fallback to chat collection
        if (db) {
          db.collection('chat').orderBy('ts').limitToLast(100).get().then(snap => {
            const c2 = document.getElementById('chat-messages'); if(!c2) return;
            c2.innerHTML = snap.docs.map(d => renderMsg(d.data(), user)).join('');
            c2.scrollTop = c2.scrollHeight;
          }).catch(()=>{});
        }
      });
  }
  setTimeout(() => { if(container) container.scrollTop = container.scrollHeight; }, 200);
}

function sendChat() {
  const inp = document.getElementById('chat-input'); if (!inp) return;
  const text = inp.value.trim(); if (!text || text.length > 500) return;
  const user = getCurrentUser(); if (!user || user.isAdmin) return;
  inp.value = '';
  const db = FSB._db();
  const now = new Date().toISOString();
  const msg = {
    messageId: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
    uid: FSB.uid() || '',
    username: user.username,
    team: user.team || '',
    text,
    ts: Date.now(),
    createdAt: now,
  };
  if (db) {
    db.collection(CHAT_COLLECTION).add(msg).catch(() => {
      // Fallback to old chat collection
      db.collection('chat').add({user:user.username,team:user.team||'',text,ts:Date.now()}).catch(()=>{});
    });
  }
}

function _resetChatListener() {
  if (_chatListener) { _chatListener(); _chatListener = null; }
}

/* ─── ATTENDANCE ─── */
function loadAttendance() {
  const user = getCurrentUser(); const el = document.getElementById('sec-attendance'); if (!el) return;
  if (user && user.isAdmin) { el.innerHTML = emptyState('📅', 'Attendance is for members only.'); return; }
  const today = new Date().toDateString();
  const att = LS.get(`zc_att_${user?.username}`, {}); const checked = att[today] || false;
  const streak = Object.keys(att).filter(k => !k.startsWith('day')).length;
  el.innerHTML = `<div class="page-eyebrow">More</div><div class="page-heading mb-12">📅 Daily Attendance</div>
    <div class="card p-16 mb-12 text-center"><div style="font-size:2.5rem;margin-bottom:8px">📅</div>
      <div style="font-family:var(--font-display);font-size:1.6rem;color:var(--accent-1)">${streak} Day Streak</div>
      <div class="text-muted mt-8">${checked ? '✅ Checked in today! (+1 HP)' : 'Check in for your daily HP!'}</div>
      ${!checked ? `<button class="btn btn-primary mt-12" onclick="checkInToday()">✅ Check In (+${HP.ATTENDANCE} HP)</button>` : ''}
    </div>
    <div class="section-title">This Week</div>
    <div class="attendance-days">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d, i) => `<div class="att-day ${att['day' + i] ? 'done' : ''} ${i === new Date().getDay() - 1 ? 'today' : ''}"><span style="font-size:0.7rem">${d}</span><span>${att['day' + i] ? '✓' : ''}</span></div>`).join('')}</div>`;
}
function checkInToday() {
  const user = getCurrentUser(); if (!user || user.isAdmin) return;
  const today = new Date().toDateString();
  const att = LS.get(`zc_att_${user.username}`, {});
  if (att[today]) { showToast('Already checked in!', 'warn'); return; }
  att[today] = true; att['day' + (new Date().getDay() - 1)] = true;
  LS.set(`zc_att_${user.username}`, att);
  user.attendanceHistory=user.attendanceHistory||[];user.attendanceHistory.push(today);
  _earnHP(user,HP.ATTENDANCE,'attendance','Daily check-in');
  showToast(`+${HP.ATTENDANCE} HP — Attendance!`,'success');
  DB.addNotif('attendance', `${user.username} checked in`);
  logAction(user.username, 'attendance', 'Daily check-in', { date: today, streak: Object.keys(att).filter(k => !k.startsWith('day')).length });
  loadAttendance();
}

/* ─── EVIDENCE ─── */
function loadEvidence() {
  const user = getCurrentUser(); const all = DB.getEvidence(); const mine = all.filter(e => e.user === (user && user.username));
  const el = document.getElementById('sec-evidence'); if (!el) return;
  el.innerHTML = `<div class="page-eyebrow">More</div><div class="page-heading mb-12">📎 Evidence</div>
    <div class="card p-16 mb-12"><div class="section-title">Upload Evidence</div>
      <div class="form-group"><label class="form-label">Type</label><select class="form-input" id="ev-type"><option>Streaming Screenshot</option><option>Voting Proof</option><option>Mission Completion</option><option>Game Score</option><option>Other</option></select></div>
      <div class="form-group"><label class="form-label">Mission Name</label><input type="text" class="form-input" id="ev-mission" placeholder="Mission name"></div>
      <div class="form-group"><label class="form-label">Upload Files (multiple OK)</label><input type="file" class="form-input" id="ev-file" accept="image/*,.pdf,.jpg,.png,.jpeg,.gif,.webp" multiple style="padding:8px"></div>
      <div class="form-group"><label class="form-label">Notes</label><textarea class="form-input" id="ev-notes"></textarea></div>
      <button class="btn btn-primary btn-full" onclick="submitEvidence()">📤 Submit</button>
    </div>
    <div class="section-title">My Submissions (${mine.length})</div>
    ${mine.length ? mine.map(e => `<div class="card p-12 mb-8"><div class="flex-between mb-8"><div><div style="font-weight:600">${escHtml(e.type)}</div><div class="text-muted" style="font-size:0.72rem">${escHtml(e.mission)} · ${new Date(e.ts).toLocaleDateString()} · ${e.fileCount || 1} file(s)</div></div><span class="badge ${e.status === 'Approved' ? 'badge-green' : e.status === 'Rejected' ? 'badge-red' : 'badge-accent'}">${e.status || 'Pending'}</span></div>${e.status === 'Approved' ? `<div class="text-gold" style="font-size:0.8rem">+${HP.EVIDENCE} HP awarded ✅</div>` : ''}</div>`).join('') : emptyState('📎', 'No evidence yet.')}`;
}
function submitEvidence() {
  const user = getCurrentUser(); if (!user || user.isAdmin) return;
  const type = document.getElementById('ev-type').value;
  const mission = document.getElementById('ev-mission').value.trim();
  const files = document.getElementById('ev-file').files;
  const notes = document.getElementById('ev-notes').value.trim();
  if (!mission) { showToast('Enter mission name.', 'warn'); return; }
  if (!files || !files.length) { showToast('Upload at least one file.', 'warn'); return; }
  let done = 0; const fArr = [];
  Array.from(files).forEach(file => {
    const rd = new FileReader();
    rd.onload = ev => {
      fArr.push({ name: file.name, data: ev.target.result }); done++;
      if (done === files.length) {
        const id = 'ev' + Date.now();
        const doc = {
          id, evidenceId: id,
          memberUid: FSB.uid() || '',
          username: user.username,
          team: user.team || '',
          type, missionTitle: mission,
          notes, files: fArr,
          fileCount: files.length,
          status: 'Pending',
          hpReward: HP.EVIDENCE,
          ts: Date.now(),
          submittedAt: new Date().toISOString(),
          reviewedBy: '', reviewedAt: '', adminResponse: ''
        };
        // Save to localStorage cache
        const all = DB.getEvidence(); all.push(doc); DB.saveEvidence(all);
        // Save as individual Firebase doc so admin sees it
        const db = FSB._db();
        if (db) {
          db.collection('evidence').doc(id).set(doc)
            .then(() => console.log('[ZClock] ✅ Evidence saved to Firebase:', id))
            .catch(e => console.warn('[ZClock] Evidence save error:', e.message));
        }
        showToast(files.length + ' file(s) submitted! Admin will review. 📎', 'success');
        DB.addNotif('evidence', user.username + ' submitted evidence: ' + mission);
        logAction(user.username, 'evidence', 'Submitted evidence: ' + mission, { fileCount: files.length, type });
        loadEvidence();
      }
    };
    rd.readAsDataURL(file);
  });
}

/* ─── REPORTS ─── */
function loadReports() {
  const user = getCurrentUser(); const all = DB.getReports();
  const mine = all.filter(r => r.user === (user && user.username));
  const fromAdmin = all.filter(r => r.targetUser === (user && user.username) && r.fromAdmin);
  const el = document.getElementById('sec-reports'); if (!el) return;
  el.innerHTML = `<div class="page-eyebrow">More</div><div class="page-heading mb-12">📋 Reports</div>
    <div class="card p-16 mb-12"><div class="section-title">File a Report</div>
      <div class="form-group"><label class="form-label">Title</label><input type="text" class="form-input" id="rep-title"></div>
      <div class="form-group"><label class="form-label">Description</label><textarea class="form-input" id="rep-desc"></textarea></div>
      <button class="btn btn-primary btn-full" onclick="submitReport()">Submit</button>
    </div>
    ${fromAdmin.length ? `<div class="section-title">📩 Admin Notices</div>${fromAdmin.map(r => `<div class="card p-12 mb-8" style="border-color:var(--accent-1)"><div class="flex-between mb-4"><span class="badge badge-gold">👑 Admin</span><span class="badge ${r.noticeType === 'Warning' ? 'badge-red' : 'badge-accent'}">${r.noticeType || 'Notice'}</span></div><div style="font-weight:600;margin-bottom:4px">${escHtml(r.title)}</div><div class="text-muted" style="font-size:0.8rem">${escHtml(r.desc)}</div><div class="text-muted mt-4" style="font-size:0.68rem">${new Date(r.ts).toLocaleString()}</div></div>`).join('')}` : ''}
    <div class="section-title mt-12">My Reports</div>
    ${mine.length ? mine.map(r => `<div class="card p-12 mb-8"><div class="flex-between mb-8"><div style="font-weight:600">${escHtml(r.title)}</div><span class="badge ${r.status === 'Resolved' ? 'badge-green' : 'badge-accent'}">${r.status || 'Open'}</span></div><div class="text-muted" style="font-size:0.78rem">${escHtml(r.desc)}</div>${r.response ? `<div class="mt-8" style="font-size:0.8rem;color:var(--accent-2);padding:8px;background:var(--bg-glass);border-radius:var(--radius-sm)">Admin: ${escHtml(r.response)}</div>` : ''}</div>`).join('') : emptyState('📋', 'No reports yet.')}`;
}
function submitReport() {
  const user = getCurrentUser(); if (!user || user.isAdmin) return;
  const title = document.getElementById('rep-title')?.value.trim();
  const desc = document.getElementById('rep-desc')?.value.trim();
  const cat = document.getElementById('rep-cat')?.value || 'General';
  if (!title || !desc) { showToast('Fill all fields.', 'warn'); return; }
  const id = 'rep' + Date.now();
  const doc = {
    id, reportId: id,
    memberUid: FSB.uid() || '',
    username: user.username,
    team: user.team || '',
    title, desc, category: cat,
    status: 'Open',
    ts: Date.now(),
    submittedAt: new Date().toISOString(),
    response: '', resolvedAt: '', resolvedBy: ''
  };
  const all = DB.getReports(); all.push(doc); DB.saveReports(all);
  // Save to Firebase reports collection
  const db = FSB._db();
  if (db) {
    db.collection('reports').doc(id).set(doc)
      .then(() => console.log('[ZClock] ✅ Report saved to Firebase:', id))
      .catch(e => console.warn('[ZClock] Report save error:', e.message));
  }
  showToast('Report submitted! Admin will respond soon.', 'success');
  DB.addNotif('report', user.username + ' filed report: ' + title);
  logAction(user.username, 'reports', 'Filed report: ' + title, { desc });
  loadReports();
}

/* ─── CARDS ─── */
/* ════════════════════════════════════════════════════════════
   CARDS SYSTEM — Redesigned
   1. BBC Cards Collection  (battle cards, admin-uploaded)
   2. Battle / Playmat      (full arena battle system)
   3. Display Collection    (picture cards, mission-earned)
   4. Card Missions         (missions to unlock picture cards)
   ════════════════════════════════════════════════════════════ */

const RARITY_C = { common: '#aaaaaa', uncommon: '#5dade2', rare: '#82b4ff', epic: '#c39bd3', legendary: '#f0c040' };
const RARITY_ORDER = ['common','uncommon','rare','epic','legendary'];

/* ── Render a BBC card (battle card) ── */
function renderBBCCard(c, userHP, clickable = false) {
  const unlocked = userHP >= (c.hpRequired || 0);
  const prog = Math.min(100, (userHP / Math.max(1, c.hpRequired || 1)) * 100);
  const rarityColor = RARITY_C[c.rarity] || '#aaa';
  const _bbcSrc = c.imageData || c.image || '';
  const art = _bbcSrc
    ? `<img src="${escHtml(_bbcSrc)}" alt="${escHtml(c.name)}" style="width:100%;height:100%;object-fit:cover;border-radius:4px 4px 0 0" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
    + `<div style="font-size:2.4rem;display:none;align-items:center;justify-content:center;height:100%;color:${rarityColor}">🃏</div>`
    : `<div style="font-size:2.4rem;display:flex;align-items:center;justify-content:center;height:100%;color:${rarityColor}">🃏</div>`;
  return `<div class="bbc-card ${unlocked ? 'bbc-unlocked' : 'bbc-locked'}" ${clickable && unlocked ? `data-cid="${escHtml(c.id)}" onclick="selectBattleCard(this,'${escHtml(c.id)}')"` : ''} style="--rarity-color:${rarityColor}">
    <div class="bbc-art">${art}</div>
    <div class="bbc-rarity-bar" style="background:${rarityColor}">${(c.rarity||'common').toUpperCase()}</div>
    <div class="bbc-body">
      <div class="bbc-name">${escHtml(c.name)}</div>
      <div class="bbc-stats">
        <span title="Attack">⚔️ ${c.attack||0}</span>
        <span title="Defense">🛡️ ${c.defense||0}</span>
      </div>
      ${unlocked
        ? `<div class="badge badge-green" style="font-size:0.55rem;margin-top:4px">✅ Unlocked</div>`
        : `<div style="margin-top:4px"><div style="font-size:0.58rem;color:var(--white-muted);margin-bottom:2px">🔒 Need ${c.hpRequired} HP</div><div style="height:3px;background:rgba(255,255,255,0.1);border-radius:2px;overflow:hidden"><div style="height:100%;width:${prog}%;background:var(--grad-btn);border-radius:2px;transition:width 0.6s"></div></div></div>`}
    </div>
  </div>`;
}

/* ── Render a Picture Card ── */
function renderPicCard(c, owned = false) {
  const _picSrc = c.imageData || c.image || '';
  const art = _picSrc
    ? `<img src="${escHtml(_picSrc)}" alt="${escHtml(c.name)}" style="width:100%;height:100%;object-fit:cover;border-radius:4px 4px 0 0" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
    + `<div style="font-size:2.4rem;display:none;align-items:center;justify-content:center;height:100%;color:var(--accent-1)">🖼️</div>`
    : `<div style="font-size:2.4rem;display:flex;align-items:center;justify-content:center;height:100%;color:var(--accent-1)">🖼️</div>`;
  return `<div class="pic-card ${owned ? 'pic-owned' : 'pic-locked'}">
    <div class="pic-art">${art}</div>
    <div class="pic-body">
      <div class="pic-name">${escHtml(c.name)}</div>
      <div style="font-size:0.62rem;color:var(--white-muted);margin-top:2px">${escHtml(c.collection||c.source||'—')}</div>
      ${owned
        ? `<div class="badge badge-green" style="font-size:0.55rem;margin-top:4px">✅ Owned</div>`
        : `<div style="font-size:0.62rem;color:var(--pink);margin-top:4px">🔒 Complete mission to unlock</div>`}
    </div>
  </div>`;
}

/* ════════ 1. BBC CARDS COLLECTION ════════ */
function loadBBCCards() {
  const user = getCurrentUser();
  const cards = DB.getCards();
  const hp = user ? (user.hp || 0) : 0;
  const el = document.getElementById('sec-card-collection'); if (!el) return;

  const fv = document.getElementById('bbc-rf')?.value || 'all';
  const filtered = fv === 'all' ? cards : cards.filter(c => c.rarity === fv);
  const unlockedCount = cards.filter(c => hp >= (c.hpRequired || 0)).length;

  el.innerHTML = `
    <div class="page-eyebrow">Cards</div>
    <div class="page-heading mb-4">🃏 BBC Cards Collection</div>
    <div class="text-muted mb-12" style="font-size:0.8rem">Bangtan Battle Cards — used in Playmat battles. Unlock by reaching the required HP.</div>
    <div class="flex-between mb-12" style="flex-wrap:wrap;gap:8px">
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <div class="stat-pill">💜 HP: <strong>${formatNum(hp)}</strong></div>
        <div class="stat-pill">🃏 Unlocked: <strong>${unlockedCount}/${cards.length}</strong></div>
      </div>
      <select class="form-input" id="bbc-rf" style="width:auto;padding:5px 10px;font-size:0.8rem" onchange="loadBBCCards()">
        <option value="all">All Rarities</option>
        <option value="common">Common</option>
        <option value="uncommon">Uncommon</option>
        <option value="rare">Rare</option>
        <option value="epic">Epic</option>
        <option value="legendary">Legendary</option>
      </select>
    </div>
    ${filtered.length
      ? `<div class="bbc-grid">${filtered.map(c => renderBBCCard(c, hp)).join('')}</div>`
      : emptyState('🃏', 'No BBC Cards yet. Admin will upload Bangtan Battle Cards.')}`;
}

/* ════════ 2. BATTLE / PLAYMAT ════════ */
let playmatState = null; // active battle state

let _battleReqListener = null;
function loadPlaymat() {
  const el = document.getElementById('sec-card-battle'); if (!el) return;
  const user = getCurrentUser(); if (!user || user.isAdmin) { el.innerHTML = emptyState('⚔️','Login as a member to use the Playmat.'); return; }
  const db = FSB._db();
  const uid = FSB.uid();
  const myUnlocked = DB.getCards().filter(c => (user.hp||0) >= (c.hpRequired||0));
  const battles = DB.getBattles();
  const myHistory = battles.filter(b => b.challenger === user.username || b.opponent === user.username);
  const pending = battles.filter(b => b.opponent === user.username && b.status === 'pending');

  // Realtime listener for incoming challenges
  if (db && uid && !_battleReqListener) {
    _battleReqListener = db.collection('battleRequests')
      .where('opponentUsername','==',user.username)
      .where('status','==','pending')
      .onSnapshot(snap => {
        snap.docChanges().forEach(ch => {
          if(ch.type==='added') {
            const req = ch.doc.data();
            // Add to local battles if not already there
            const existing = DB.getBattles();
            if(!existing.find(b=>b.id===req.battleRequestId)) {
              existing.push({
                id:req.battleRequestId, challenger:req.challengerUsername,
                opponent:req.opponentUsername, challengerCard:{
                  id:req.selectedCardId,name:req.selectedCardName,
                  rarity:req.selectedCardRarity,attack:req.selectedCardAtk,defense:req.selectedCardDef
                }, status:'pending', ts:req.ts||Date.now()
              });
              DB.saveBattles(existing);
              showToast('⚔️ '+req.challengerUsername+' challenged you to a battle!','info');
            }
          }
        });
        const el2=document.getElementById('sec-card-battle');
        if(el2) loadPlaymat();
      }, ()=>{});
  }

  el.innerHTML = `
    <div class="page-eyebrow">Cards</div>
    <div class="page-heading mb-4">⚔️ Battle Playmat</div>
    <div class="text-muted mb-14" style="font-size:0.8rem">Challenge ARMY to a card battle! Loser's selected card transfers to the winner.</div>

    ${pending.length ? `
    <div class="playmat-incoming mb-14">
      <div class="section-title">⚡ Incoming Challenges (${pending.length})</div>
      ${pending.map(b => `
      <div class="card p-12 mb-8" style="border-color:var(--accent-2)">
        <div class="flex-between mb-8">
          <div><strong style="color:var(--accent-2)">${escHtml(b.challenger)}</strong> challenged you!</div>
          <span class="badge badge-accent">Pending</span>
        </div>
        <div class="text-muted mb-4" style="font-size:0.75rem">Their card: <strong>${escHtml(b.challengerCard?.name||'Unknown')}</strong> (${b.challengerCard?.rarity||'?'})</div>
        <div class="text-muted mb-10" style="font-size:0.72rem">⚠️ If you lose, your selected card transfers to them!</div>
        ${myUnlocked.length ? `
        <div class="form-group mb-8"><label class="form-label" style="font-size:0.72rem">Choose your card to defend with:</label>
        <select class="form-input" id="defend-card-${b.id}" style="font-size:0.8rem">
          ${myUnlocked.map(c => `<option value="${escHtml(c.id)}">${escHtml(c.name)} (${c.rarity}) ⚔️${c.attack||0} 🛡️${c.defense||0}</option>`).join('')}
        </select></div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-success btn-sm" onclick="respondBattle(${b.id},'accept')">⚔️ Accept & Fight</button>
          <button class="btn btn-danger btn-sm" onclick="respondBattle(${b.id},'decline')">❌ Decline</button>
        </div>` : `<div class="badge badge-red mb-8">No unlocked cards to defend with</div>
        <button class="btn btn-danger btn-sm" onclick="respondBattle(${b.id},'decline')">❌ Decline</button>`}
      </div>`).join('')}
    </div>` : ''}

    <div class="playmat-arena glass-card p-16 mb-14">
      <div class="section-title mb-12">⚔️ Challenge Arena</div>
      <div class="playmat-vs-layout">
        <div class="playmat-side">
          <div class="playmat-side-label">YOUR SIDE</div>
          <div class="playmat-player-info">
            <div class="playmat-avatar">${user.username.charAt(0).toUpperCase()}</div>
            <div class="playmat-name">${escHtml(user.username)}</div>
            <div class="text-muted" style="font-size:0.72rem">HP: ${formatNum(user.hp||0)}</div>
          </div>
          ${myUnlocked.length ? `
          <div class="form-group mt-10">
            <label class="form-label" style="font-size:0.72rem">Battle Card</label>
            <select class="form-input" id="battle-card-sel" style="font-size:0.8rem">
              ${myUnlocked.map(c => `<option value="${escHtml(c.id)}">${escHtml(c.name)} ⚔️${c.attack||0} 🛡️${c.defense||0}</option>`).join('')}
            </select>
          </div>` : `<div class="text-muted mt-10" style="font-size:0.78rem">No cards unlocked yet</div>`}
        </div>
        <div class="playmat-vs-center">
          <div class="vs-badge">VS</div>
          <div class="text-muted" style="font-size:0.65rem;margin-top:6px">⚠️ Loser's card transfers to winner</div>
        </div>
        <div class="playmat-side">
          <div class="playmat-side-label">OPPONENT</div>
          <div class="playmat-player-info">
            <div class="playmat-avatar" style="background:var(--pink)">?</div>
            <div class="form-group mt-8">
              <select class="form-input" id="battle-opp" style="font-size:0.82rem">
                <option value="">— Select opponent —</option>
                ${(()=>{
                  // Deduplicate and show opposite team first
                  const seen=new Set();
                  const opponents=DB.getMembers().filter(m=>{
                    if(!m||m.isAdmin||m.username===user.username) return false;
                    const key=m.uid||m.username;
                    if(seen.has(key)) return false;
                    seen.add(key); return true;
                  });
                  const opposite=opponents.filter(m=>user.team&&m.team&&m.team!==user.team);
                  const same=opponents.filter(m=>!user.team||!m.team||m.team===user.team);
                  const sorted=[...opposite,...same];
                  if(!sorted.length) return '<option disabled>No opponents available yet</option>';
                  return (opposite.length?`<optgroup label="⚔️ Opposite Team">`:'') +
                    opposite.map(m=>`<option value="${escHtml(m.username)}">${escHtml(m.username)} — ${escHtml(m.team||'—')} — ${formatNum(m.hp||0)} HP</option>`).join('') +
                    (opposite.length?'</optgroup>':'') +
                    (same.length?`<optgroup label="👥 Same Team">`:'') +
                    same.map(m=>`<option value="${escHtml(m.username)}">${escHtml(m.username)} — ${escHtml(m.team||'—')} — ${formatNum(m.hp||0)} HP</option>`).join('') +
                    (same.length?'</optgroup>':'');
                })()}
              </select>
            </div>
          </div>
        </div>
      </div>
      ${myUnlocked.length
        ? `<button class="btn btn-primary btn-full mt-12" onclick="sendBattleChallenge()" style="background:linear-gradient(135deg,#c0392b,#8e1a11);font-size:1rem;font-weight:700;letter-spacing:1px">⚔️ SEND CHALLENGE</button>`
        : `<div class="text-muted text-center mt-12">Earn more HP to unlock cards and battle!</div>`}
    </div>

    <div class="section-title mb-12">📜 Battle History</div>
    ${myHistory.length ? myHistory.slice(0,20).map(b => {
      const isChallenger = b.challenger === user.username;
      const won = b.winner === user.username;
      const opp = isChallenger ? b.opponent : b.challenger;
      const myCard = isChallenger ? b.challengerCard : b.opponentCard;
      const oppCard = isChallenger ? b.opponentCard : b.challengerCard;
      const statusBadge = b.status === 'pending' ? '<span class="badge badge-accent">⏳ Waiting</span>'
        : b.status === 'declined' ? '<span class="badge">❌ Declined</span>'
        : won ? '<span class="badge badge-green">🏆 WON</span>'
        : '<span class="badge badge-red">💀 LOST</span>';
      return `<div class="card p-12 mb-8">
        <div class="flex-between mb-6">
          <div style="font-weight:600;font-size:0.88rem">${escHtml(user.username)} vs ${escHtml(opp)}</div>
          ${statusBadge}
        </div>
        <div style="display:flex;gap:16px;font-size:0.72rem;color:var(--white-muted)">
          <span>Your card: ${escHtml(myCard?.name||'—')}</span>
          <span>Their card: ${escHtml(oppCard?.name||'—')}</span>
        </div>
        ${b.status === 'completed' && b.cardTransferred ? `<div class="mt-6" style="font-size:0.72rem;color:${won?'#2ecc71':'#e74c3c'}">${won ? `🎉 You won ${escHtml(oppCard?.name||'their card')}!` : `💀 ${escHtml(oppCard?.name||'Your card')} transferred to ${escHtml(opp)}`}</div>` : ''}
        <div class="text-muted mt-4" style="font-size:0.65rem">${new Date(b.ts||b.id).toLocaleString()}</div>
      </div>`;
    }).join('') : emptyState('⚔️', 'No battles yet. Challenge someone!')}`;
}

function sendBattleChallenge() {
  const user = getCurrentUser(); if (!user || user.isAdmin) return;
  const oppSel = document.getElementById('battle-opp');
  const opp = oppSel?.value.trim() || oppSel?.options[oppSel.selectedIndex]?.value;
  const cid = document.getElementById('battle-card-sel')?.value;
  if (!opp) { showToast('Select an opponent.', 'warn'); return; }
  if (opp === user.username) { showToast("Can't battle yourself!", 'warn'); return; }
  // Opposite team only
  const oppMember = DB.getMembers().find(m => m.username === opp);
  if (!oppMember) { showToast('Member not found.', 'error'); return; }
  if (oppMember.team === user.team) { showToast('You can only battle the opposite team!', 'warn'); return; }
  const card = DB.getCards().find(c => String(c.id) === String(cid));
  if (!card) { showToast('Select a valid card.', 'warn'); return; }
  const db = FSB._db();
  const uid = FSB.uid();
  const reqId = 'br_' + Date.now();
  const now = new Date().toISOString();
  const battleReq = {
    battleRequestId: reqId,
    challengerUid: uid||'', challengerUsername: user.username, challengerTeam: user.team||'',
    opponentUid: oppMember.uid||'', opponentUsername: opp, opponentTeam: oppMember.team||'',
    selectedCardId: String(card.id), selectedCardName: card.name,
    selectedCardRarity: card.rarity||'common', selectedCardAtk: card.attack||50, selectedCardDef: card.defense||50,
    status: 'pending', createdAt: now, ts: Date.now(),
  };
  if (db) {
    db.collection('battleRequests').doc(reqId).set(battleReq)
      .then(() => {
        const b = DB.getBattles();
        b.push({id:reqId, challenger:user.username, opponent:opp, challengerCard:card, status:'pending', ts:Date.now()});
        DB.saveBattles(b);
        showToast('⚔️ Challenge sent to '+opp+'!', 'success');
        DB.addNotif('battle', user.username+' challenged '+opp+' to a battle!');
        logAction(user.username,'cards','Challenged '+opp,{card:card.name});
        loadPlaymat();
      })
      .catch(e => showToast('Error: '+e.message,'error'));
  } else {
    const b = DB.getBattles();
    b.push({id:reqId, challenger:user.username, opponent:opp, challengerCard:card, status:'pending', ts:Date.now()});
    DB.saveBattles(b);
    showToast('⚔️ Challenge sent to '+opp+'!', 'success');
    loadPlaymat();
  }
}

function respondBattle(id, action) {
  const user = getCurrentUser(); if (!user) return;
  const b = DB.getBattles();
  const bt = b.find(x => x.id === id); if (!bt) return;

  if (action === 'decline') {
    bt.status = 'declined';
    DB.saveBattles(b);
    showToast('Challenge declined.', 'info');
    logAction(user.username, 'cards', `Declined battle from ${bt.challenger}`, {});
    loadPlaymat(); return;
  }

  // Get opponent's chosen defend card
  const defCardId = document.getElementById(`defend-card-${id}`)?.value;
  const defCard = defCardId ? DB.getCards().find(c => String(c.id) === String(defCardId)) : null;
  bt.opponentCard = defCard || null;

  // Battle logic: compare attack + defense + random factor
  const cAtk = (bt.challengerCard?.attack || 0) + (bt.challengerCard?.defense || 0) + Math.floor(Math.random() * 30);
  const oAtk = (bt.opponentCard?.attack || 0) + (bt.opponentCard?.defense || 0) + Math.floor(Math.random() * 30);
  const winner = cAtk >= oAtk ? bt.challenger : bt.opponent;
  const loser  = winner === bt.challenger ? bt.opponent : bt.challenger;

  bt.status = 'completed';
  bt.winner = winner;
  bt.loser = loser;
  bt.challengerScore = cAtk;
  bt.opponentScore = oAtk;
  bt.cardTransferred = true;

  // Transfer the loser's card to the winner
  const winnerMember = DB.getMember(winner);
  const loserMember  = DB.getMember(loser);
  const loserCard    = winner === bt.challenger ? bt.opponentCard : bt.challengerCard;

  if (winnerMember && loserCard) {
    winnerMember.unlockedCards = winnerMember.unlockedCards || [];
    if (!winnerMember.unlockedCards.includes(loserCard.id)) {
      winnerMember.unlockedCards.push(loserCard.id);
    }
    // Give won card extra entry in collection
    winnerMember.wonCards = winnerMember.wonCards || [];
    winnerMember.wonCards.push({ cardId: loserCard.id, fromPlayer: loser, wonAt: new Date().toISOString() });
    DB.saveMember(winnerMember);
  }

  DB.saveBattles(b);
  const isWinner = winner === user.username;
  showToast(`⚔️ Battle complete! ${winner} wins! ${isWinner ? '🏆 You won!' : '💀 You lost!'}`, isWinner ? 'success' : 'error');
  DB.addNotif('battle', `${winner} defeated ${loser}! Card transferred: ${loserCard?.name||'—'}`);
  logAction(user.username, 'cards', `Battle: ${winner} won vs ${loser}`, { winner, loser, loserCard: loserCard?.name });
  loadPlaymat();
}

/* ════════ 3. DISPLAY COLLECTION ════════ */
function loadDisplayCollection() {
  const user = getCurrentUser();
  const el = document.getElementById('sec-card-display'); if (!el) return;
  const allPicCards = DB.getPicCards();
  const myOwnedIds = user ? (user.ownedPicCards || []) : [];

  el.innerHTML = `
    <div class="page-eyebrow">Cards</div>
    <div class="page-heading mb-4">🖼️ Display Collection</div>
    <div class="text-muted mb-12" style="font-size:0.8rem">Picture cards earned from missions and events. Display-only — not used in battles.</div>
    ${user && !user.isAdmin ? `<div class="stat-pill mb-12">🖼️ Owned: <strong>${myOwnedIds.length}/${allPicCards.length}</strong></div>` : ''}
    ${allPicCards.length
      ? `<div class="bbc-grid">${allPicCards.map(c => renderPicCard(c, myOwnedIds.includes(String(c.id)))).join('')}</div>`
      : emptyState('🖼️', 'No picture cards yet. Complete Card Missions to earn them!')}`;
}

/* ════════ 4. CARD MISSIONS ════════ */
function loadCardMissions() {
  const user = getCurrentUser();
  const el = document.getElementById('sec-card-missions'); if (!el) return;
  const missions = DB.getCardMissions().filter(m => m.active !== false);
  const completed = user ? (user.completedCardMissions || []) : [];

  el.innerHTML = `
    <div class="page-eyebrow">Cards</div>
    <div class="page-heading mb-4">📋 Card Missions</div>
    <div class="text-muted mb-12" style="font-size:0.8rem">Complete missions to unlock picture cards for your Display Collection.</div>
    ${missions.length ? missions.map(m => {
      const isDone = completed.includes(String(m.id));
      const picCard = m.rewardCardId ? DB.getPicCards().find(c => String(c.id) === String(m.rewardCardId)) : null;
      const deadline = m.deadline ? new Date(m.deadline) : null;
      const expired = deadline && deadline < new Date();
      const _mSrc = picCard?.imageData || picCard?.image || '';
      const cardArt = _mSrc
        ? `<img src="${escHtml(_mSrc)}" alt="${escHtml(picCard.name)}" style="width:56px;height:56px;object-fit:cover;border-radius:8px;border:2px solid var(--accent-1)">`
        : `<div style="width:56px;height:56px;border-radius:8px;background:var(--bg-glass);border:2px solid var(--border-color);display:flex;align-items:center;justify-content:center;font-size:1.5rem">🖼️</div>`;
      return `<div class="card p-14 mb-10 ${isDone ? 'card-done' : ''}" style="${isDone ? 'border-color:#2ecc71;opacity:0.85' : ''}">
        <div class="flex-between mb-8">
          <div style="font-weight:700;font-size:0.95rem">${escHtml(m.title)}</div>
          ${isDone ? '<span class="badge badge-green">✅ Completed</span>' : expired ? '<span class="badge badge-red">⏰ Expired</span>' : '<span class="badge badge-accent">📋 Active</span>'}
        </div>
        <div class="text-muted mb-10" style="font-size:0.82rem">${escHtml(m.description||'')}</div>
        ${m.task ? `<div class="card p-10 mb-10" style="background:rgba(196,142,100,0.06);border-color:rgba(196,142,100,0.2)"><div style="font-size:0.72rem;color:var(--white-muted);margin-bottom:3px">TASK REQUIRED</div><div style="font-size:0.84rem">${escHtml(m.task)}</div></div>` : ''}
        <div class="flex-between">
          <div style="display:flex;align-items:center;gap:10px">
            ${cardArt}
            <div>
              <div style="font-size:0.72rem;color:var(--white-muted)">CARD REWARD</div>
              <div style="font-size:0.85rem;font-weight:600;color:var(--accent-1)">${escHtml(picCard?.name||'Picture Card')}</div>
              ${m.hpReward ? `<div style="font-size:0.7rem;color:var(--gold)">+${m.hpReward} HP bonus</div>` : ''}
              ${deadline ? `<div style="font-size:0.62rem;color:${expired?'var(--pink)':'var(--white-muted)'}">${expired?'Expired':'Deadline'}: ${deadline.toLocaleDateString()}</div>` : ''}
            </div>
          </div>
          ${!isDone && !expired && user && !user.isAdmin
            ? `<button class="btn btn-primary btn-sm" onclick="claimCardMission('${escHtml(m.id)}')">🎴 Claim Card</button>`
            : isDone ? `<span class="badge badge-green" style="font-size:0.7rem">Card Added ✅</span>` : ''}
        </div>
      </div>`;
    }).join('') : emptyState('📋', 'No card missions yet. Admin will create missions to unlock picture cards.')}`;
}

function claimCardMission(missionId) {
  const user = getCurrentUser(); if (!user || user.isAdmin) return;
  const missions = DB.getCardMissions();
  const m = missions.find(x => String(x.id) === String(missionId));
  if (!m) { showToast('Mission not found.', 'error'); return; }

  user.completedCardMissions = user.completedCardMissions || [];
  if (user.completedCardMissions.includes(String(missionId))) { showToast('Already claimed!', 'warn'); return; }

  user.completedCardMissions.push(String(missionId));

  // Unlock the picture card
  if (m.rewardCardId) {
    user.ownedPicCards = user.ownedPicCards || [];
    if (!user.ownedPicCards.includes(String(m.rewardCardId))) {
      user.ownedPicCards.push(String(m.rewardCardId));
    }
  }

  // Award bonus HP if any
  if (m.hpReward && m.hpReward > 0) {
    user.hp = (user.hp || 0) + m.hpReward;
    user.totalHp = (user.totalHp || 0) + m.hpReward;
    user.weeklyHp = (user.weeklyHp || 0) + m.hpReward;
    user.hpMissions = (user.hpMissions || 0) + m.hpReward;
    showHPPopup(m.hpReward);
  }

  DB.saveMember(user);
  const picCard = m.rewardCardId ? DB.getPicCards().find(c => String(c.id) === String(m.rewardCardId)) : null;
  showToast(`🎴 Card unlocked: ${picCard?.name || 'Picture Card'}! Added to Display Collection.`, 'success');
  DB.addNotif('cards', `${user.username} claimed card: ${picCard?.name||'—'} from mission: ${m.title}`);
  logAction(user.username, 'cards', `Claimed card mission: ${m.title}`, { cardName: picCard?.name });
  loadCardMissions();
  refreshTopBar();
}

/* helper for select card in battle */
function selectBattleCard(el, cid) {
  document.querySelectorAll('.bbc-card').forEach(c => c.classList.remove('bbc-selected'));
  el.classList.add('bbc-selected');
  const sel = document.getElementById('battle-card-sel');
  if (sel) sel.value = cid;
}

/* ─── GROUPS / ANNOUNCEMENTS ─── */
function loadGroups() {
  const el = document.getElementById('sec-groups-links'); if (!el) return;
  el.innerHTML = `<div class="page-eyebrow">Groups</div><div class="page-heading mb-12">🌐 Join Our Groups</div>` +
    [{ p: '📸 Instagram', l: [{ t: 'Main GC', h: 'https://ig.me/j/AbZC6pbE-WBKvj0j/' }, { t: 'Discussions', h: 'https://ig.me/j/AbZti8i-aSaHp2ky/' }, { t: 'Maknae Line', h: 'https://ig.me/j/AbaYrgN-VQ1Uosw6/' }, { t: 'Hyung Line', h: 'https://ig.me/j/AbZ8PQtolmR59Mxr/' }] },
    { p: '✈️ Telegram', l: [{ t: 'Main Group', h: 'https://t.me/zclock13_twilight' }, { t: 'Discussions', h: 'https://t.me/+S2DS7vgdLVMxODQ1' }, { t: 'Maknae Line', h: 'https://t.me/+qMoHR2riDck1NTM9' }, { t: 'Hyung Line', h: 'https://t.me/+xpyXrWjMFzI5OGI1' }] },
    { p: '🎵 TikTok', l: [{ t: 'Coming Soon', h: '#' }] }, { p: '🧵 Threads', l: [{ t: 'Coming Soon', h: '#' }] },
    ].map(g => `<div class="card p-14 mb-10"><div class="section-title">${g.p}</div><div class="grid-2">${g.l.map(x => `<a href="${x.h}" target="_blank" class="btn btn-secondary btn-sm">${x.t}</a>`).join('')}</div></div>`).join('');
}
function loadAnnouncements() {
  const el = document.getElementById('sec-announcements'); if (!el) return;
  const a = DB.getAnns();
  el.innerHTML = `<div class="page-eyebrow">Groups</div><div class="page-heading mb-12">📢 Announcements</div>` + (a.length ? a.map(x => `<div class="card p-14 mb-10" style="border-left:3px solid var(--accent-1)"><div style="font-weight:700;color:var(--white);margin-bottom:4px">${escHtml(x.title)}</div><div class="text-muted" style="font-size:0.83rem;line-height:1.6">${escHtml(x.body)}</div><div class="text-muted mt-8" style="font-size:0.68rem">${new Date(x.ts).toLocaleString()}</div></div>`).join('') : emptyState('📢', 'No announcements yet.'));
}

/* ─── REWARDS ─── */
function loadRewards() {
  const user = getCurrentUser(); const hp = user ? (user.hp || 0) : 0; const streams = user ? (user.streams || 0) : 0;
  const ACHS = [
    { icon: '🎵', name: 'First Stream', desc: 'First stream synced', req: streams >= 1 },
    { icon: '💜', name: 'Purple Heart', desc: 'Earn 10 HP', req: hp >= 10 },
    { icon: '⭐', name: 'Mission Hunter', desc: 'Complete 5 missions', req: (user?.completedMissions || []).length >= 5 },
    { icon: '🏆', name: 'HP Champion', desc: 'Earn 100 HP total', req: (user?.totalHp || 0) >= 100 },
    { icon: '🎮', name: 'Quiz Champion', desc: 'Complete all 3 games', req: (user?.completedGames || []).length >= 3 },
    { icon: '📅', name: 'Attendance Pro', desc: '7-day attendance streak', req: (user?.attendanceHistory || []).length >= 7 },
    { icon: '👑', name: 'Purple Warrior', desc: 'Earn 500 HP total', req: (user?.totalHp || 0) >= 500 },
    { icon: '🃏', name: 'Card Collector', desc: 'Unlock 5 BBC cards', req: DB.getCards().filter(c => (user?.hp || 0) >= (c.hpRequired || 0)).length >= 5 },
    { icon: '📸', name: 'Evidence Expert', desc: '5 evidence approved', req: DB.getEvidence().filter(e => e.user === user?.username && e.status === 'Approved').length >= 5 },
    { icon: '🔄', name: 'Sync Master', desc: 'Sync 50 streams', req: (user?.streams || 0) >= 50 },
  ];
  const el = document.getElementById('sec-rewards-achievements'); if (!el) return;
  const u = ACHS.filter(a => a.req).length;
  el.innerHTML = `<div class="page-eyebrow">More</div><div class="page-heading mb-12">🏅 Rewards & Achievements</div>
    <div class="glass-card p-14 mb-12 text-center"><div style="font-family:var(--font-display);font-size:1.6rem;color:var(--accent-1)">${u}/${ACHS.length}</div><div class="text-muted">Unlocked</div></div>
    <div class="grid-2">${ACHS.map(a => `<div class="card p-14"><div style="font-size:1.8rem;margin-bottom:6px;${a.req ? '' : 'opacity:0.35'}">${a.icon}</div><div style="font-weight:700;font-size:0.86rem;${a.req ? 'color:var(--accent-1)' : 'color:var(--white-muted)'}">${a.name}</div><div class="text-muted mt-4" style="font-size:0.72rem">${a.desc}</div><div class="mt-8"><span class="badge ${a.req ? 'badge-green' : 'badge-accent'}" style="font-size:0.6rem">${a.req ? '✅ Unlocked' : '🔒 Locked'}</span></div></div>`).join('')}</div>`;
}

/* ─── WEEKLY ─── */
function loadWeekly() {
  const ts = getTeamStats(); const user = getCurrentUser(); const el = document.getElementById('sec-weekly-results'); if (!el) return;
  const hw = ts.hyung.hp > ts.maknae.hp, tied = ts.hyung.hp === ts.maknae.hp;
  el.innerHTML = `<div class="page-eyebrow">More</div><div class="page-heading mb-12">📊 Weekly Results</div>
    <div class="glass-card p-16 mb-12 text-center" style="border-color:var(--gold)">
      <div style="font-size:0.7rem;letter-spacing:3px;color:var(--gold);font-family:var(--font-display)">WINNER OF THE WEEK</div>
      <div style="font-family:var(--font-display);font-size:1.6rem;font-weight:800;margin:8px 0;background:var(--grad-text);-webkit-background-clip:text;background-clip:text;color:transparent">${tied ? '⚖️ Tied!' : hw ? '💜 Hyung Line' : '🩷 Maknae Line'}</div>
    </div>
    <div class="grid-2 mb-12">
      <div class="card p-14"><div class="section-title" style="font-size:0.65rem">💜 HYUNG</div><div style="font-family:var(--font-display);font-size:1.3rem;color:var(--accent-1)">${formatNum(ts.hyung.hp)} HP</div><div class="text-muted">${formatNum(ts.hyung.streams)} streams</div></div>
      <div class="card p-14"><div class="section-title" style="font-size:0.65rem;color:var(--pink)">🩷 MAKNAE</div><div style="font-family:var(--font-display);font-size:1.3rem;color:var(--pink)">${formatNum(ts.maknae.hp)} HP</div><div class="text-muted">${formatNum(ts.maknae.streams)} streams</div></div>
    </div>
    ${user && !user.isAdmin ? `<div class="card p-14"><div class="section-title">My Week</div><div class="flex-between"><span class="text-muted">Streams</span><span class="text-gold">${user.weeklyStreams || 0}</span></div><div class="flex-between mt-8"><span class="text-muted">HP</span><span class="text-gold">${user.weeklyHp || 0}</span></div></div>` : ''}`;
}

/* ─── HELPLINE ─── */
/* ── Ticket ID generator ── */
function genTicketId() {
  const all = DB.getHelpline();
  const num = String(all.length + 1).padStart(4, '0');
  return 'ZH-' + num;
}

function loadHelpline() {
  const user = getCurrentUser();
  const el = document.getElementById('sec-helpline'); if (!el) return;
  const all = DB.getHelpline();
  const mine = all.filter(function(h){ return h.user === (user && user.username); });

  var myTickets = mine.length ? mine.map(function(h) {
    var statusCls = {Open:'badge-accent','In Progress':'badge-gold',Resolved:'badge-green',Closed:'badge-red'}[h.status]||'badge-accent';
    var reply = h.adminReply ? '<div class="mt-8" style="background:rgba(196,142,100,0.1);border-left:3px solid var(--accent-1);padding:8px 10px;border-radius:var(--radius-sm);font-size:0.82rem"><strong style="color:var(--accent-1)">Admin Reply:</strong><br>' + escHtml(h.adminReply) + '</div>' : '';
    return '<div class="card p-14 mb-8" style="border-left:3px solid var(--border-color)">' +
      '<div class="flex-between mb-6">' +
        '<div><span class="badge badge-gold" style="font-size:0.65rem;margin-right:6px">' + escHtml(h.ticketId||h.id) + '</span><strong style="font-size:0.85rem">' + escHtml(h.category) + '</strong></div>' +
        '<span class="badge ' + statusCls + '" style="font-size:0.65rem">' + escHtml(h.status||'Open') + '</span>' +
      '</div>' +
      '<div class="text-muted mb-4" style="font-size:0.78rem">Platform: ' + escHtml(h.platform) + ' · @' + escHtml(h.platformUsername) + ' · ' + escHtml(h.team) + '</div>' +
      '<div style="font-size:0.82rem;line-height:1.6;margin-bottom:6px">' + escHtml(h.description) + '</div>' +
      reply +
      '<div class="text-muted mt-6" style="font-size:0.68rem">' + new Date(h.ts).toLocaleString() + '</div>' +
    '</div>';
  }).join('') : '<div class="empty-state"><div class="es-icon">🎫</div><div class="es-text">No support requests yet.</div></div>';

  el.innerHTML = '<div class="page-eyebrow">More</div><div class="page-heading mb-12">🆘 Member Support</div>' +
    '<div class="card p-16 mb-16">' +
      '<div class="section-title">📝 New Support Request</div>' +
      '<div class="text-muted mb-12" style="font-size:0.82rem">Fill in the form below. We will get back to you as soon as possible.</div>' +

      '<div class="grid-2">' +
        '<div class="form-group"><label class="form-label">Platform</label>' +
          '<select class="form-input" id="hl-platform">' +
            '<option value="Instagram">📸 Instagram</option>' +
            '<option value="X (Twitter)">🐦 X (Twitter)</option>' +
            '<option value="TikTok">🎵 TikTok</option>' +
            '<option value="Facebook">📘 Facebook</option>' +
            '<option value="Telegram">✈️ Telegram</option>' +
            '<option value="Threads">🧵 Threads</option>' +
            '<option value="Discord">💬 Discord</option>' +
            '<option value="Other">Other</option>' +
          '</select></div>' +

        '<div class="form-group"><label class="form-label">Your Team</label>' +
          '<select class="form-input" id="hl-team">' +
            '<option value="Hyung Line">💜 Hyung Line</option>' +
            '<option value="Maknae Line">🩷 Maknae Line</option>' +
          '</select></div>' +
      '</div>' +

      '<div class="grid-2">' +
        '<div class="form-group"><label class="form-label">Platform Username</label>' +
          '<input type="text" class="form-input" id="hl-platuser" placeholder="@yourusername"></div>' +
        '<div class="form-group"><label class="form-label">User ID (if any)</label>' +
          '<input type="text" class="form-input" id="hl-userid" placeholder="Optional"></div>' +
      '</div>' +

      '<div class="form-group"><label class="form-label">Issue Category</label>' +
        '<select class="form-input" id="hl-category">' +
          '<option>Streaming Issue</option>' +
          '<option>Voting Issue</option>' +
          '<option>Sync Issue</option>' +
          '<option>Account Issue</option>' +
          '<option>Team Issue</option>' +
          '<option>Mission Issue</option>' +
          '<option>Evidence Issue</option>' +
          '<option>Technical Issue</option>' +
          '<option>Other</option>' +
        '</select></div>' +

      '<div class="form-group"><label class="form-label">Issue Description</label>' +
        '<textarea class="form-input" id="hl-desc" rows="5" placeholder="Explain your issue in detail. Include what happened, when it happened, and what you expected…" style="min-height:120px"></textarea></div>' +

      '<div class="form-group"><label class="form-label">Attachments (screenshots, images)</label>' +
        '<input type="file" class="form-input" id="hl-files" accept="image/*,.pdf,.jpg,.png,.jpeg,.gif" multiple style="padding:8px">' +
        '<div class="text-muted mt-4" style="font-size:0.72rem">You can upload multiple screenshots</div></div>' +

      '<button class="btn btn-primary btn-full" onclick="submitHelpline()">🆘 Send Support Request</button>' +
      '<div id="hl-submit-status" class="mt-8" style="font-size:0.82rem"></div>' +
    '</div>' +

    '<div class="section-title mt-4">🎫 My Support Requests (' + mine.length + ')</div>' +
    myTickets;
}

function submitHelpline() {
  const user = getCurrentUser(); if (!user || user.isAdmin) return;
  const platform = document.getElementById('hl-platform')?.value;
  const team = document.getElementById('hl-team')?.value || user.team || '';
  const platUser = document.getElementById('hl-platuser')?.value.trim();
  const userId = document.getElementById('hl-userid')?.value.trim();
  const category = document.getElementById('hl-category')?.value;
  const description = document.getElementById('hl-desc')?.value.trim();
  const files = document.getElementById('hl-files')?.files;
  const statusEl = document.getElementById('hl-submit-status');

  if (!platUser) { showToast('Enter your platform username.', 'warn'); return; }
  if (!description || description.length < 10) { showToast('Please describe your issue in more detail.', 'warn'); return; }

  const ticketId = genTicketId();
  if (statusEl) statusEl.textContent = 'Sending…';

  // Read attachments
  const attachments = [];
  if (files && files.length) {
    let done = 0;
    Array.from(files).forEach(function(file) {
      const rd = new FileReader();
      rd.onload = function(e) {
        attachments.push({ name: file.name, data: e.target.result });
        done++;
        if (done === files.length) saveTicket();
      };
      rd.readAsDataURL(file);
    });
  } else {
    saveTicket();
  }

  function saveTicket() {
    const ticket = {
      id: Date.now(),
      ticketId: ticketId,
      user: user.username,
      platform: platform,
      platformUsername: platUser,
      userId: userId,
      team: team,
      category: category,
      description: description,
      attachments: attachments,
      fileCount: attachments.length,
      status: 'Open',
      adminReply: '',
      ts: Date.now(),
    };
    const all = DB.getHelpline();
    all.unshift(ticket);
    DB.saveHelpline(all);
    DB.addNotif('helpline', user.username + ' opened ticket ' + ticketId + ': ' + category);
    logAction(user.username, 'helpline', 'Opened support ticket ' + ticketId, { category, platform });

    if (statusEl) statusEl.innerHTML = '<span style="color:var(--accent-1)">✅ Ticket ' + ticketId + ' submitted! Admin will respond soon.</span>';
    showToast('Support request sent! Ticket: ' + ticketId, 'success');

    // Clear form
    ['hl-platuser','hl-userid','hl-desc'].forEach(function(id){ const el=document.getElementById(id); if(el)el.value=''; });
    const fi = document.getElementById('hl-files'); if(fi) fi.value='';
    setTimeout(loadHelpline, 1500);
  }
}

/* ─── SETTINGS ─── */


/* ════════════════════════════════════════════════════════════
   BACKEND API LAYER  (Spec 51 + 52)
   ════════════════════════════════════════════════════════════ */
function _getBackendUrl(){
  var saved=LS.get('zc_backend_url','');
  return (saved && saved !== 'http://localhost:3001') ? saved : 'https://zclock-backend-f92s.onrender.com';
}
async function _apiCall(route,method,body,ms=70000,retries=2){
  for(let attempt=0;attempt<=retries;attempt++){
    try{
      const r=await fetch(`${_getBackendUrl()}${route}`,{method:method||'POST',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(ms)});
      return await r.json();
    }catch(e){
      if(attempt===retries)return{success:false,_offline:true};
      await new Promise(res=>setTimeout(res,3000));
    }
  }
  return{success:false,_offline:true};
}
async function _backendOnline(){
  for(let attempt=0;attempt<2;attempt++){
    try{const r=await fetch(`${_getBackendUrl()}/api/health`,{signal:AbortSignal.timeout(65000)});const d=await r.json();if(d.status==='ok')return true;}catch{}
    if(attempt===0)await new Promise(res=>setTimeout(res,3000));
  }
  return false;
}
async function registerMemberOnServer(data){await _apiCall('/api/register','POST',data);}
async function pushMemberToServer(user){if(!user||user.isAdmin)return;await _apiCall(`/api/member/${encodeURIComponent(user.username)}`,'POST',user);}
async function logActionToServer(username,category,action,details={}){await _apiCall('/api/log','POST',{username,category,action,details,time:new Date().toISOString()});}

function getSyncResult(username){return LS.get(`zc_sync_result_${username}`,null);}
function _saveSyncLocal(username,result){
  LS.set(`zc_sync_result_${username}`,{...result,savedAt:Date.now()});
  const user=DB.getMember(username);
  if(user&&result?.platforms?.lastfm){
    const lf=result.platforms.lastfm;
    user.lastSyncSummary={time:Date.now(),lastfmStatus:lf.status||'—',firstSync:lf.firstSync||false,totalEarned:result.totalEarnedHP||0};
    // Update lastfm sub-object in Firebase — use per-member settings ONLY
    const uid=FSB.uid();
    if(uid){
      const s=DB.getSettings(); // per-member key
      const lfUrl=s.lastfmUrl||(_currentMemberObj&&_currentMemberObj.lastfmUrl)||'';
      const lfUn=lf.username||(lfUrl?lfUrl.replace(/.*last\.fm\/user\//i,'').replace(/\/.*/,'').trim():'');
      if(lfUn){
        user.lastfmUrl=lfUrl;
        user.lastfm={
          profileUrl:lfUrl,
          username:lfUn,
          connected:true,
          firstSyncCompleted:!lf.firstSync,
          startingScrobbles:lf.startingCount||0,
          lastSavedScrobbles:lf.latestCount||0,
          pendingStreams:lf.pendingStreams||0,
          lastSyncAt:new Date().toISOString(),
        };
        if(_currentMemberObj) Object.assign(_currentMemberObj, {lastfmUrl:lfUrl,lastfm:user.lastfm});
      }
    }
    DB.saveMember(user);
  }
}
function _applyStreamingHP(username, earnedHP, newStreams){
  if(!earnedHP && !newStreams) return;
  const members = DB.getMembers();
  const i = members.findIndex(m => m.username === username);
  if(i < 0) return;

  if(earnedHP > 0){
    members[i].hp = (members[i].hp||0) + earnedHP;
    members[i].totalHp = (members[i].totalHp||0) + earnedHP;
    members[i].weeklyHp = (members[i].weeklyHp||0) + earnedHP;
    members[i].hpStreaming = (members[i].hpStreaming||0) + earnedHP;
    showHPPopup(earnedHP);
    DB.addNotif('stream', username + ' earned +' + earnedHP + ' HP from streaming');
  }
  if(newStreams > 0){
    members[i].streams = (members[i].streams||0) + newStreams;
    members[i].weeklyStreams = (members[i].weeklyStreams||0) + newStreams;
    members[i].lifetimeStreams = (members[i].lifetimeStreams||0) + newStreams;
    members[i].lastFmStreams = members[i].streams;
  }

  DB.saveMembers(members);
  refreshTopBar();

  // Also update Firebase member doc with new streams + HP
  const uid = FSB.uid();
  if(uid){
    const updates = {
      hp: members[i].hp,
      totalHp: members[i].totalHp,
      weeklyHp: members[i].weeklyHp,
      hpStreaming: members[i].hpStreaming,
      streams: members[i].streams,
      weeklyStreams: members[i].weeklyStreams,
      lifetimeStreams: members[i].lifetimeStreams || members[i].streams,
      lastActive: new Date().toISOString(),
    };
    FSB.saveMember(uid, {...((_memberCache&&_memberCache[uid])||{}), ...updates}).catch(()=>{});
    if(_memberCache && _memberCache[uid]) Object.assign(_memberCache[uid], updates);
    if(_currentMemberObj) Object.assign(_currentMemberObj, updates);
  }

  // Refresh dashboard and leaderboard if visible
  if(document.getElementById('sec-dashboard')) loadDashboard();
}

/* Main sync — spec 52: only friendly messages to members */
/* ============================================================
   LISTENBRAINZ SYSTEM
   ============================================================ */
function _generateToken(){const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';let t='ZCK-';for(let i=0;i<32;i++)t+=chars[Math.floor(Math.random()*chars.length)];return t;}

async function generateLBToken(){
  const user=getCurrentUser();if(!user||user.isAdmin)return;
  const uid=FSB.uid();if(!uid)return showToast('Session error.','error');
  const token=_generateToken();
  const lb={...((_currentMemberObj?.listenbrainz)||{}),token,tokenGenerated:true,tokenGeneratedAt:new Date().toISOString()};
  const db=FSB._db();
  if(db)await db.collection('members').doc(uid).update({listenbrainz:lb}).catch(()=>{});
  if(_currentMemberObj)_currentMemberObj.listenbrainz=lb;
  if(_memberCache&&_memberCache[uid])_memberCache[uid].listenbrainz=lb;
  showToast('Token generated! ✅','success');loadSettings();
}

async function saveLBSettings(){
  const user=getCurrentUser();if(!user||user.isAdmin)return;
  const uid=FSB.uid();if(!uid)return showToast('Session error.','error');
  const username=document.getElementById('set-lb-username')?.value.trim();
  if(!username)return showToast('Enter your ListenBrainz username.','warn');
  const el=document.getElementById('lb-status');
  if(el)el.innerHTML='<span style="color:var(--accent-1)">Checking ListenBrainz...</span>';
  const result=await _apiCall(`/api/listenbrainz/check/${encodeURIComponent(username)}`,'GET',undefined,15000,1);
  if(result._offline){
    const lb={...((_currentMemberObj?.listenbrainz)||{}),username,connected:false};
    const db=FSB._db();
    if(db)await db.collection('members').doc(uid).update({listenbrainz:lb}).catch(()=>{});
    if(_currentMemberObj)_currentMemberObj.listenbrainz=lb;
    if(_memberCache&&_memberCache[uid])_memberCache[uid].listenbrainz=lb;
    showToast('Username saved! Sync when server is online.','info');loadSettings();return;
  }
  if(result.success&&result.exists){
    const lb={...((_currentMemberObj?.listenbrainz)||{}),username,connected:true,listenCount:result.listenCount||0};
    const db=FSB._db();
    if(db)await db.collection('members').doc(uid).update({listenbrainz:lb}).catch(()=>{});
    if(_currentMemberObj)_currentMemberObj.listenbrainz=lb;
    if(_memberCache&&_memberCache[uid])_memberCache[uid].listenbrainz=lb;
    if(el)el.innerHTML=`<span style="color:var(--accent-1)">✅ Connected! ${escHtml(username)} — ${(result.listenCount||0).toLocaleString()} total listens</span>`;
    showToast('ListenBrainz connected! Now click Sync Now.','success');loadSettings();
  }else{
    if(el)el.innerHTML=`<span style="color:var(--pink)">❌ Username not found on ListenBrainz. Check spelling.</span>`;
    showToast('Username not found.','error');
  }
}

async function checkLBConnection(){
  const el=document.getElementById('lb-status');
  const user=getCurrentUser();if(!user||user.isAdmin)return;
  const lb=_currentMemberObj?.listenbrainz||{};
  if(!lb.username){if(el)el.innerHTML='<span style="color:var(--pink)">Enter your ListenBrainz username first.</span>';return;}
  if(el)el.innerHTML='<span style="color:var(--accent-1)">Checking...</span>';
  const result=await _apiCall(`/api/listenbrainz/check/${encodeURIComponent(lb.username)}`,'GET',undefined,15000,1);
  if(result._offline){if(el)el.innerHTML='<span style="color:var(--pink)">Server offline.</span>';return;}
  if(result.success&&result.exists){
    const uid=FSB.uid();const db=FSB._db();
    const updated={...lb,connected:true};
    if(db&&uid)await db.collection('members').doc(uid).update({listenbrainz:updated}).catch(()=>{});
    if(_currentMemberObj)_currentMemberObj.listenbrainz=updated;
    if(el)el.innerHTML=`<span style="color:var(--accent-1)">✅ ${escHtml(lb.username)} connected — ${(result.listenCount||0).toLocaleString()} listens</span>`;
    showToast('Connected! ✅','success');loadSettings();
  }else{
    if(el)el.innerHTML='<span style="color:var(--pink)">❌ Username not found.</span>';
  }
}

function _applyNewStreams(username,newStreams){
  if(!newStreams||newStreams<=0)return;
  const members=DB.getMembers();const i=members.findIndex(m=>m.username===username);if(i<0)return;
  const m=members[i];
  const newW=(m.streams||0)+newStreams;
  const newT=Math.max((m.totalStreams||m.lifetimeStreams||0)+newStreams,newW);
  m.streams=newW;m.weeklyStreams=newW;m.totalStreams=newT;m.lifetimeStreams=newT;
  m.lastSyncStreams=newStreams;m.streamsCountedThisSync=newStreams;
  DB.saveMembers(members);
  const uid=FSB.uid();const db2=FSB._db();
  if(uid&&db2){
    db2.collection('members').doc(uid).update({streams:newW,weeklyStreams:newW,totalStreams:newT,lifetimeStreams:newT,lastSyncStreams:newStreams,streamsCountedThisSync:newStreams,lastActive:new Date().toISOString()}).catch(()=>{});
    if(_memberCache&&_memberCache[uid])Object.assign(_memberCache[uid],{streams:newW,totalStreams:newT,lastSyncStreams:newStreams});
    if(_currentMemberObj)Object.assign(_currentMemberObj,{streams:newW,totalStreams:newT});
  }
  refreshTopBar();
}

/* Match newly scrobbled tracks against admin-uploaded Tracks/Albums/Missions.
   Updates per-member progress in Firestore. Awards bonus HP on completion (once). */
async function _updateTaskProgress(username, newTracksList) {
  if (!newTracksList || !newTracksList.length) return;
  const db = FSB._db(); if (!db) return;
  const uid = FSB.uid(); if (!uid) return;
  const user = getCurrentUser(); if (!user || user.isAdmin) return;

  const tracks   = DB.getTracks();
  const albums   = DB.getAlbums();
  const missions = DB.getMissions();
  const hpGained = [];

  // ── TRACK PROGRESS ──
  for (const track of tracks) {
    if (!track.active) continue;
    const trackId = track.id || track.trackId;
    if (!trackId) continue;
    const titleKey  = (track.title  || '').toLowerCase().trim();
    const artistKey = (track.artist || '').toLowerCase().trim();
    const matchCount = newTracksList.filter(t => {
      const tTitle  = (t.name   || t.title      || '').toLowerCase().trim();
      const tArtist = (t.artist || t.artistName || '').toLowerCase().trim();
      if (tTitle !== titleKey) return false;
      if (!artistKey || artistKey === 'bts') return true;
      return tArtist.includes(artistKey) || artistKey.includes(tArtist);
    }).length;
    if (!matchCount) continue;

    const freshUser = getCurrentUser();
    if (freshUser) {
      freshUser.trackStreams = freshUser.trackStreams || {};
      freshUser.trackStreams[trackId] = (freshUser.trackStreams[trackId] || 0) + matchCount;
      DB.saveMember(freshUser);
      db.collection('members').doc(uid).update({ [`trackStreams.${trackId}`]: freshUser.trackStreams[trackId] }).catch(()=>{});
    }

    const docId = uid + '_' + trackId;
    const ref = db.collection('memberTrackProgress').doc(docId);
    try {
      const snap = await ref.get();
      const goal = track.goal || 100;
      const cur = snap.exists ? snap.data() : { memberUid: uid, username, trackId, title: track.title, currentStreams: 0, goal, completed: false, hpClaimed: false };
      if (cur.hpClaimed) continue;
      cur.currentStreams = (cur.currentStreams || 0) + matchCount;
      const justCompleted = !cur.completed && cur.currentStreams >= goal;
      if (justCompleted) { cur.completed = true; cur.completedAt = new Date().toISOString(); }
      await ref.set(cur, { merge: true });
      if (justCompleted) {
        const bonusHp = Math.min(20, track.hp || 2);
        await ref.update({ hpClaimed: true });
        hpGained.push({ type: 'track', title: track.title, hp: bonusHp });
        _earnHP(freshUser || user, bonusHp, 'missions', `Track completed: ${track.title}`);
        DB.addNotif('track', `${username} completed track: ${track.title} +${bonusHp}HP`);
      }
    } catch(e) { console.warn('[ZClock] Track progress error:', e.message); }
  }

  // ── ALBUM PROGRESS ──
  for (const album of albums) {
    if (!album.active) continue;
    const albumId = album.id || album.albumId;
    if (!albumId) continue;
    const albumTitleKeys = (album.tracks || []).map(t => (typeof t === 'string' ? t : (t.title || '')).toLowerCase().trim());
    const albumNameKey = (album.name || album.title || '').toLowerCase().trim();
    const matchCount = newTracksList.filter(t => {
      const tTitle = (t.name || t.title || '').toLowerCase().trim();
      const tAlbum = (t.album || '').toLowerCase().trim();
      return albumTitleKeys.includes(tTitle) || (albumNameKey && tAlbum.includes(albumNameKey));
    }).length;
    if (!matchCount) continue;

    const docId = uid + '_' + albumId;
    const ref = db.collection('memberAlbumProgress').doc(docId);
    try {
      const snap = await ref.get();
      const goal = album.goal || 100;
      const cur = snap.exists ? snap.data() : { memberUid: uid, username, albumId, title: album.name || album.title, currentStreams: 0, goal, completed: false, hpClaimed: false };
      if (cur.hpClaimed) continue;
      cur.currentStreams = (cur.currentStreams || 0) + matchCount;
      const justCompleted = !cur.completed && cur.currentStreams >= goal;
      if (justCompleted) { cur.completed = true; cur.completedAt = new Date().toISOString(); }
      await ref.set(cur, { merge: true });
      if (justCompleted) {
        const hpAmt = Math.min(20, album.hp || album.hpReward || 5);
        await ref.update({ hpClaimed: true });
        hpGained.push({ type: 'album', title: album.name || album.title, hp: hpAmt });
        _earnHP(getCurrentUser() || user, hpAmt, 'missions', `Album completed: ${album.name || album.title}`);
        DB.addNotif('album', `${username} completed album: ${album.name || album.title} +${hpAmt}HP`);
      }
    } catch(e) { console.warn('[ZClock] Album progress error:', e.message); }
  }

  // ── MISSION PROGRESS (streaming-type) ──
  for (const mission of missions) {
    if (!mission.active) continue;
    const targetKey = (mission.trackTarget || mission.target || mission.song || '').toLowerCase().trim();
    if (!targetKey) continue;
    const matchCount = newTracksList.filter(t => {
      const tTitle = (t.name || t.title || '').toLowerCase().trim();
      return tTitle === targetKey || tTitle.includes(targetKey) || targetKey.includes(tTitle);
    }).length;
    if (!matchCount) continue;

    const docId = uid + '_' + mission.id;
    const ref = db.collection('memberMissionProgress').doc(docId);
    try {
      const snap = await ref.get();
      const goal = mission.goal || mission.target_count || 1;
      const cur = snap.exists ? snap.data() : { memberUid: uid, username, missionId: mission.id, title: mission.title, progress: 0, goal, completed: false, hpClaimed: false };
      if (cur.hpClaimed) continue;
      cur.progress = (cur.progress || 0) + matchCount;
      const justCompleted = !cur.completed && cur.progress >= goal;
      if (justCompleted) { cur.completed = true; cur.completedAt = new Date().toISOString(); }
      await ref.set(cur, { merge: true });
      if (justCompleted) {
        const hpAmt = Math.min(20, mission.hpReward || mission.hp || 10);
        await ref.update({ hpClaimed: true });
        hpGained.push({ type: 'mission', title: mission.title, hp: hpAmt });
        _earnHP(getCurrentUser() || user, hpAmt, 'missions', `Mission completed: ${mission.title}`);
        DB.addNotif('mission', `${username} completed streaming mission: ${mission.title} +${hpAmt}HP`);
      }
    } catch(e) { console.warn('[ZClock] Mission progress error:', e.message); }
  }

  if (hpGained.length) {
    const total = hpGained.reduce((s, x) => s + x.hp, 0);
    showToast(`🎯 ${hpGained.length} task(s) completed! +${total} HP`, 'success');
  }
  if (document.getElementById('sec-tracks')) loadTracks();
  if (document.getElementById('sec-albums')) loadAlbums();
}

async function _fetchTracksForProgress(username,lbUsername){
  if(!lbUsername)return;
  try{
    const result=await _apiCall(`/api/lastfm-tracks/${encodeURIComponent(lbUsername)}`,'GET',undefined,15000,1);
    if(!result._offline&&result.tracks&&result.tracks.length)await _updateTaskProgress(username,result.tracks);
  }catch(e){console.warn('[ZClock] Track progress error:',e.message);}
}

let _lastSyncTime=0;

async function runSync(user,showUI=true){
  if(!user||user.isAdmin)return;
  const now=Date.now();
  if(!showUI&&(now-_lastSyncTime)<10*60*1000)return;
  _lastSyncTime=now;

  const lb=_currentMemberObj?.listenbrainz||{};
  const lbUsername=lb.username||'';
  if(!lbUsername){
    if(showUI)showToast('Add your ListenBrainz username in Settings.','info');
    return;
  }
  if(showUI)updateSyncStatusUI('Syncing...');

  const result=await _apiCall(`/api/sync-all/${encodeURIComponent(user.username)}`,'POST',{memberTeam:user.team||'',lbUsername});
  if(result._offline){if(showUI){updateSyncStatusUI('');showToast('Server offline. Try again later.','warn');}return;}

  const earnedHP=result.totalEarnedHP||0;
  const newStreams=result.newStreams||result.lastfm?.newStreams||0;
  const firstSync=result.firstSync||result.lastfm?.firstSync||false;
  const pending=result.pending||result.lastfm?.pending||0;

  if(newStreams>0)_applyNewStreams(user.username,newStreams);

  const db3=FSB._db();const uid3=FSB.uid();
  if(db3&&uid3){
    const lbUpdate={...lb,lastSyncAt:new Date().toISOString(),lastSyncStreams:newStreams,connected:true};
    if(firstSync){lbUpdate.firstSyncCompleted=true;}
    db3.collection('members').doc(uid3).update({listenbrainz:lbUpdate}).catch(()=>{});
    if(_currentMemberObj)_currentMemberObj.listenbrainz=lbUpdate;
  }

  if(showUI){
    if(firstSync)showToast('ListenBrainz connected! New streams count from now.','success');
    else if(earnedHP>0)showToast(`+${earnedHP} HP - ${newStreams} new streams! (${pending} pending)`,'success');
    else if(newStreams>0)showToast(`${newStreams} streams counted - ${pending} pending for next HP`,'info');
    else showToast('No new streams since last sync.','info');
  }

  _saveSyncLocal(user.username,result);
  updateSyncStatusUI('');
  if(lbUsername)_fetchTracksForProgress(user.username,lbUsername).catch(()=>{});
}
async function saveAndSyncProfiles(user,lastfmUrl,showUI=true){
  if(!user||user.isAdmin)return;
  if(showUI)updateSyncStatusUI('Connecting…');
  const result=await _apiCall('/api/save-profiles','POST',{memberId:user.username,memberTeam:user.team||'',lastfmUrl});
  if(result._offline){if(showUI){updateSyncStatusUI('');showToast('Sync temporarily unavailable.','warn');}return;}
  if(result.totalEarnedHP>0)_applyStreamingHP(user.username,result.totalEarnedHP,0);
  _saveSyncLocal(user.username,result);
  if(showUI){const lf=result.platforms?.lastfm;if(lf?.firstSync)showToast('Connected! Only new streams will earn HP.','success');else if(result.totalEarnedHP>0)showToast(`Synced! +${result.totalEarnedHP} HP earned.`,'success');else showToast('Profiles saved!','success');updateSyncStatusUI('');}
  return result;
}
function updateSyncStatusUI(msg){const el=document.getElementById('sync-status-bar');if(!el)return;if(!msg){el.style.display='none';return;}el.style.display='flex';el.textContent=msg;}
let syncInterval = null;
function startAutoSync(){if(syncInterval)clearInterval(syncInterval);syncInterval=setInterval(()=>{const u=getCurrentUser();if(u&&!u.isAdmin)runSync(u,false);},30*60*1000);}
function checkWeeklyReset(){
  const now=new Date();const s=new Date(now);s.setDate(now.getDate()-now.getDay());s.setHours(0,0,0,0);const key=s.toISOString();
  if(LS.get('zc_last_weekly_reset','')===key)return;LS.set('zc_last_weekly_reset',key);
  const members=DB.getMembers();members.forEach(m=>{m.hp=0;m.weeklyStreams=0;m.weeklyHp=0;m.votesToday=0;});DB.saveMembers(members);
  DB.addNotif('system','Weekly HP reset — Current HP cleared, Total HP preserved');
}

/* ════════════════════════════════════════════════════════════
   SETTINGS — Spec 52: No backend URL, no tech errors for members
   ════════════════════════════════════════════════════════════ */
function loadSettings(){
  const user=getCurrentUser();
  // Per-member settings: load THIS member's Last.fm from Firebase
  if(user&&!user.isAdmin&&_currentMemberObj){
    const s0=DB.getSettings(); // already per-member key (zc_settings_{uid})
    // Always prefer Firebase member doc (source of truth)
    const fbUrl = (_currentMemberObj.lastfm&&_currentMemberObj.lastfm.profileUrl) || _currentMemberObj.lastfmUrl || '';
    if(fbUrl) { s0.lastfmUrl=fbUrl; DB.saveSettings(s0); }
    // If settings has URL but Firebase doesn't — push to Firebase
    else if(s0.lastfmUrl && !fbUrl && FSB.uid()) {
      const uid=FSB.uid();
      const lfUn=s0.lastfmUrl.replace(/.*last\.fm\/user\//i,'').replace(/\/.*/,'').trim();
      FSB.saveMember(uid, {...(_currentMemberObj||{}), lastfmUrl:s0.lastfmUrl, lastfm:{profileUrl:s0.lastfmUrl,username:lfUn,connected:!!lfUn}}).catch(()=>{});
    }
  }
  const s=DB.getSettings();const ct=LS.get('zc_theme','golden-stardust');
  const syncResult=user?getSyncResult(user.username):null;
  const el=document.getElementById('sec-settings');if(!el)return;

  function pBadge(result,key){
    if(!result?.platforms?.[key])return`<span class="badge badge-accent" style="font-size:0.65rem">Not connected</span>`;
    const ok=result.platforms[key].success;
    const st=result.platforms[key].status||'—';
    const friendly={'Connected':'✅ Connected','HP added successfully':'✅ HP added','Synced':'✅ Synced','No new streams':'📊 No new streams','Sync temporarily unavailable':'⏳ Unavailable','Sync failed':'⚠️ Failed','Connection failed':'⚠️ Failed','Invalid profile URL':'❌ Invalid URL'}[st]||st;
    return`<span class="badge ${ok?'badge-green':'badge-red'}" style="font-size:0.65rem">${escHtml(friendly)}</span>`;
  }

  const backendUrl=LS.get('zc_backend_url','http://localhost:3001');
  el.innerHTML=`
    <div class="page-eyebrow">More</div><div class="page-heading mb-12">⚙️ Settings</div>
    <div class="card p-16 mb-12"><div class="section-title">🎨 Theme</div>
      <div class="grid-2">${THEMES.map(t=>`<button class="btn ${ct===t?'btn-primary':'btn-secondary'}" onclick="applyTheme('${t}');loadSettings();showToast('Theme applied!','success')">${THEME_NAMES[t]}</button>`).join('')}</div>
    </div>
    ${isAdmin()?`<div class="card p-16 mb-12">
      <div class="section-title">🖥️ Backend Server</div>
      <div class="text-muted mb-10" style="font-size:0.8rem">Enter your Render backend URL here. This connects the website to Firebase and Last.fm sync.</div>
      <div class="form-group"><label class="form-label">Backend URL</label>
        <input type="url" class="form-input" id="set-backend" value="${escHtml(backendUrl)}" placeholder="https://zclock-backend-1.onrender.com">
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" onclick="saveBackendUrl()">💾 Save URL</button>
        <button class="btn btn-secondary btn-sm" onclick="testBackend()">🔌 Test Connection</button>
      </div>
      <div id="backend-status" class="mt-8" style="font-size:0.78rem;color:var(--white-muted)"></div>
    </div>`:''}
    <div class="card p-16 mb-12">
      <div class="section-title">🎵 Last.fm Streaming Tracker</div>
      <div class="glass-card p-12 mb-12" style="border-color:var(--accent-1)">
        <div style="font-size:0.82rem;color:var(--accent-2);line-height:1.8">💡 Paste your <strong>profile URL</strong> from each platform.<br>First sync saves your starting point — old streams don't count.<br>Only <strong>new streams</strong> earn HP. <strong>10 new streams = 1 HP.</strong></div>
      </div>
      <div class="form-group">
        <label class="form-label" style="display:flex;justify-content:space-between;align-items:center">
          <span>🎵 Last.fm Profile URL</span>
          <div style="display:flex;gap:5px;align-items:center">
            ${s.lastfmUrl
              ? '<span class="badge badge-green" style="font-size:0.65rem">✅ Connected</span>'
              : '<span class="badge badge-accent" style="font-size:0.65rem">❌ Not Connected</span>'}
            <a href="https://www.last.fm" target="_blank" class="btn btn-secondary btn-xs">Visit</a>
          </div>
        </label>
        <input type="url" class="form-input" id="set-lastfmUrl" value="${escHtml(s.lastfmUrl||'')}" placeholder="https://www.last.fm/user/YourUsername">
        <div class="text-muted mt-4" style="font-size:0.72rem">Paste your Last.fm profile URL. First sync saves your starting point — only new streams count.</div>
      </div>
      <div class="glass-card p-10 mb-10" style="border-color:rgba(196,142,100,0.3)">
        <div style="font-size:0.78rem;line-height:1.8;color:var(--white-muted)">
          📊 <strong style="color:var(--accent-1)">HP Formula:</strong> 10 new streams = 1 HP &nbsp;·&nbsp; Max 20 HP per sync<br>
          ⚡ First sync saves your starting count — old streams never count
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary" onclick="saveAndSyncFromSettings()">💾 Save & Sync</button>
        <button class="btn btn-secondary btn-sm" onclick="runSync(getCurrentUser(),true)">🔄 Sync Now</button>
        <button class="btn btn-secondary btn-sm" onclick="testLastFmSync()">🧪 Test Connection</button>
      </div>
      <div id="lastfm-test-result" class="mt-8" style="font-size:0.82rem"></div>
      <div id="sync-status-bar" style="display:none;font-size:0.78rem;color:var(--accent-1);margin-top:8px;padding:6px 10px;background:rgba(196,142,100,0.08);border-radius:var(--radius-sm)"></div>
      ${syncResult?.savedAt?`<div class="text-muted mt-8" style="font-size:0.72rem">Last sync: ${new Date(syncResult.savedAt).toLocaleString()}</div>`:''}
    </div>
    ${user&&!user.isAdmin?`
    <div class="card p-16 mb-12"><div class="section-title">👤 Change Username</div>
      <div class="form-group"><label class="form-label">New Username</label><input type="text" class="form-input" id="set-nu" placeholder="${user.username}"></div>
      <div class="form-group"><label class="form-label">Current Password</label><input type="password" class="form-input" id="set-up"></div>
      <button class="btn btn-primary btn-sm" onclick="changeUsername()">Update</button></div>
    <div class="card p-16 mb-12"><div class="section-title">🔑 Change Password</div>
      <div class="form-group"><label class="form-label">Current Password</label><input type="password" class="form-input" id="set-cp"></div>
      <div class="form-group"><label class="form-label">New Password</label><input type="password" class="form-input" id="set-np"></div>
      <div class="form-group"><label class="form-label">Confirm</label><input type="password" class="form-input" id="set-cpp"></div>
      <button class="btn btn-primary btn-sm" onclick="changePassword()">Update</button></div>`:``}
    <div class="card p-16 mb-12"><div class="section-title">☁️ Sync My Data</div>
      <div class="text-muted mb-10" style="font-size:0.8rem">Push your profile to the shared database so admin can see you from any device.</div>
      <button class="btn btn-primary btn-sm btn-full" onclick="syncMyselfToFirebase()">⬆️ Sync My Data to Firebase</button>
      <div id="self-sync-status" class="mt-8" style="font-size:0.78rem;color:var(--white-muted)"></div>
    </div>
    <div class="card p-16"><div class="section-title">🚪 Session</div>
      <div class="text-muted mb-12">Logged in as: <strong style="color:var(--accent-1)">${user?.username||'—'}</strong></div>
      <button class="btn btn-danger btn-sm btn-full" onclick="doLogout()">🚪 Logout</button></div>`;
}
function saveBackendUrl(){
  const v=document.getElementById('set-backend')?.value.trim();
  if(!v)return showToast('Enter a URL.','warn');
  LS.set('zc_backend_url',v.replace(/\/$/,''));
  showToast('Backend URL saved!','success');
  loadSettings();
}
async function testBackend(){
  const el=document.getElementById('backend-status');
  if(el)el.textContent='Testing connection…';
  const r=await _apiCall('/api/health','GET');
  if(r.status==='ok'){
    if(el)el.innerHTML='<span style="color:var(--accent-1)">✅ Connected! Firebase: '+(r.firebase?'✅':'⚠️ local only')+'</span>';
    showToast('Backend connected! ✅','success');
  } else {
    if(el)el.innerHTML='<span style="color:var(--pink)">❌ Cannot reach backend. Check URL.</span>';
    showToast('Cannot reach backend.','error');
  }
}
async function syncMyselfToFirebase(){
  const user = getCurrentUser(); if(!user||user.isAdmin) return;
  const el = document.getElementById('self-sync-status');
  if(el) el.textContent = 'Syncing to Firebase…';
  // Try register first
  let r = await _apiCall('/api/register','POST', user);
  if(!r.success && r.error === 'Username already taken'){
    // Already exists — update
    r = await _apiCall(`/api/member/${encodeURIComponent(user.username)}`,'POST', user);
  }
  if(r._offline){
    if(el) el.innerHTML = '<span style="color:var(--pink)">⚠️ Server unavailable. Try again later.</span>';
    return;
  }
  if(el) el.innerHTML = '<span style="color:var(--accent-1)">✅ Synced to Firebase! Admin can now see you.</span>';
  DB.addNotif('join', user.username + ' synced profile to Firebase');
}

async function testLastFmSync(){
  const user=getCurrentUser();if(!user||user.isAdmin)return;
  // Read THIS member's own Last.fm from Firebase first
  const lfFromFB=(_currentMemberObj&&_currentMemberObj.lastfm&&_currentMemberObj.lastfm.profileUrl)||(_currentMemberObj&&_currentMemberObj.lastfmUrl)||'';
  const s=DB.getSettings(); // per-member key
  const url=lfFromFB||s.lastfmUrl||'';
  const el=document.getElementById('lastfm-test-result');
  if(!url){if(el)el.innerHTML='<span style="color:var(--pink)">❌ No Last.fm URL saved yet.</span>';return;}
  if(el)el.innerHTML='<span style="color:var(--accent-2)">Testing Last.fm sync…</span>';
  const r=await _apiCall('/api/sync-lastfm','POST',{memberId:user.username,profileUrl:url,memberTeam:user.team||''});
  if(r._offline){if(el)el.innerHTML='<span style="color:var(--pink)">❌ Backend offline. Check Render.</span>';return;}
  if(r.success){
    const msg = r.firstSync
      ? '✅ First sync! Starting count: '+r.startingCount+' streams saved. HP starts from next sync.'
      : r.newStreams>0
      ? '✅ '+r.newStreams+' new streams → +'+r.earnedHP+' HP earned!'
      : '📊 Synced. No new streams since last sync.';
    if(el)el.innerHTML='<span style="color:var(--accent-1)">'+msg+'</span>';
    if(r.earnedHP>0){_applyStreamingHP(user.username,r.earnedHP,r.newStreams);}
    _saveSyncLocal(user.username,{platforms:{lastfm:r},totalEarnedHP:r.earnedHP||0});
  } else {
    if(el)el.innerHTML='<span style="color:var(--pink)">❌ '+escHtml(r.status||'Sync failed')+'</span>';
  }
}

function saveAndSyncFromSettings(){
  const user=getCurrentUser();if(!user||user.isAdmin)return;
  const uid=FSB.uid(); if(!uid){showToast('Session error. Please log in again.','error');return;}

  // Get settings for THIS member only
  const s=DB.getSettings(); // now returns zc_settings_{uid}
  const lfEl = document.getElementById('set-lastfmUrl'); if(lfEl) s.lastfmUrl = lfEl.value.trim();
  DB.saveSettings(s); // saves to zc_settings_{uid}

  // Extract username from URL
  const lfUrl = s.lastfmUrl||'';
  const lfUsername = lfUrl ? lfUrl.replace(/.*last\.fm\/user\//i,'').replace(/\/.*/,'').trim() : '';

  // Build lastfm struct for THIS member's Firebase doc
  const now = new Date().toISOString();
  const lfStruct = {
    lastfmUrl: lfUrl,
    lastfm: {
      profileUrl: lfUrl,
      username: lfUsername,
      connected: !!lfUsername,
      firstSyncCompleted: false,
      startingScrobbles: 0,
      lastSavedScrobbles: 0,
      pendingStreams: 0,
      lastSyncAt: lfUsername ? now : null,
    }
  };

  // Save only to THIS member's Firebase doc
  const merged = {...(_memberCache&&_memberCache[uid]||{}), ...lfStruct, lastActive:now};
  FSB.saveMember(uid, merged).then(()=>{
    console.log('[ZClock] ✅ Last.fm saved to Firebase for', user.username, '—', lfUsername||'(cleared)');
  }).catch(e=>console.warn('[ZClock] Last.fm save error:', e.message));
  if(_memberCache) _memberCache[uid] = merged;
  if(_currentMemberObj) Object.assign(_currentMemberObj, lfStruct);

  if(lfUsername) {
    DB.addNotif('sync', user.username+' connected Last.fm: '+lfUsername);
    showToast('Last.fm connected! Your streams will sync from now. 🎵','success');
    saveAndSyncProfiles(user,lfUrl,true).then(()=>loadSettings());
  } else {
    showToast('Last.fm URL cleared.','info');
    loadSettings();
  }
}
async function changeUsername(){
  const user=getCurrentUser();if(!user)return;
  const nu=document.getElementById('set-nu')?.value.trim();const p=document.getElementById('set-up')?.value;
  if(!nu)return showToast('Enter new username.','warn');if(p!==user.password)return showToast('Wrong password.','error');
  const m=DB.getMembers();if(m.find(x=>x.username===nu))return showToast('Username taken.','error');
  const i=m.findIndex(x=>x.username===user.username);if(i>-1){m[i].username=nu;DB.saveMembers(m);}
  LS.set('zc_user',nu);showToast('Username updated!','success');loadSettings();
}
function changePassword(){
  const user=getCurrentUser();if(!user)return;
  const cp=document.getElementById('set-cp')?.value;const np=document.getElementById('set-np')?.value;const cpp=document.getElementById('set-cpp')?.value;
  if(cp!==user.password)return showToast('Wrong password.','error');if(np!==cpp)return showToast('Passwords don\'t match.','error');if((np||'').length<6)return showToast('Min 6 characters.','warn');
  user.password=np;DB.saveMember(user);showToast('Password updated!','success');
}
/* ADMIN PANEL — Spec 49: Full fix with image upload
   for Battle Cards, Picture Cards, J-Hope images
   ════════════════════════════════════════════════ */
function loadAdminPanel() {
  if (!isAdmin()) { showToast('Admin only.','error'); openSection('dashboard'); return; }
  const el = document.getElementById('sec-admin-panel'); if (!el) return;

  /* ── Show loading state while Firestore fetches ── */
  el.innerHTML = '<div class="text-center p-16"><div class="loading-ring" style="margin:0 auto 12px"></div><div class="text-muted">Loading from Firebase...</div></div>';

  /* ── Attach real-time Firestore listener (replaces old DB.getMembers()) ── */
  if (_adminMembersListener) { _adminMembersListener(); _adminMembersListener = null; }

  // Load evidence, reports, helpline from their OWN Firebase collections for admin
  const db0 = FSB._db();
  if (db0) {
    // Evidence — from 'evidence' collection (not content doc)
    db0.collection('evidence').orderBy('ts','desc').limit(300).get()
      .then(snap=>{ const items=snap.docs.map(d=>d.data()); LS.set('zc_evidence_cache',items); })
      .catch(()=>{
        // Fallback to content doc
        db0.collection('content').doc('evidence').get().then(d=>{if(d.exists&&d.data().items)LS.set('zc_evidence_cache',d.data().items);}).catch(()=>{});
      });
    // Reports — from 'reports' collection
    db0.collection('reports').orderBy('ts','desc').limit(300).get()
      .then(snap=>{ const items=snap.docs.map(d=>d.data()); LS.set('zc_reports_cache',items); })
      .catch(()=>{
        db0.collection('content').doc('reports').get().then(d=>{if(d.exists&&d.data().items)LS.set('zc_reports_cache',d.data().items);}).catch(()=>{});
      });
    // Helpline — from 'helpline' collection (content doc used by helpline system)
    db0.collection('content').doc('helpline').get().then(d=>{if(d.exists&&d.data().items)LS.set('zc_helpline',d.data().items);}).catch(()=>{});
    // Notifications
    db0.collection('notifications').orderBy('time','desc').limit(200).get().then(snap=>{
      const notifs=snap.docs.map(d=>({id:d.id,...d.data()}));
      LS.set('zc_notifications_cache',notifs);
      updateNotifBadge();
    }).catch(()=>{});
  }

  _adminMembersListener = FSB.listenMembers(async (firestoreMembers, fsErr) => {
    /* Update in-memory cache with live Firestore data */
    if (!_memberCache) _memberCache = {};
    firestoreMembers.forEach(m => { _memberCache[m.uid] = m; });

    /* Deduplicate by username — keep the most recently active doc */
    const _seenNames = new Map();
    firestoreMembers.forEach(m => {
      const existing = _seenNames.get(m.username);
      if (!existing || (m.lastActive||'') > (existing.lastActive||'')) {
        _seenNames.set(m.username, m);
      }
    });
    const members = Array.from(_seenNames.values());

    // Auto-refresh visible member-facing sections when Firebase members update
    if (!isAdmin()) {
      if (document.getElementById('sec-dashboard')) loadDashboard();
      if (document.getElementById('sec-team')) _renderTeam(document.getElementById('sec-team'), getCurrentUser());
      if (document.getElementById('sec-leaderboard')) _renderLeaderboard(document.getElementById('sec-leaderboard'));
    }

    /* Also pull evidence + reports from Firestore cache (or LS fallback) */
    const evidence = DB.getEvidence();
    const playlists = DB.getPlaylists();
    const reports  = DB.getReports();
    const notifs   = DB.getNotifs();
    const missions = DB.getMissions();
    const tracks   = DB.getTracks();
    const albums   = DB.getAlbums();
    const cards    = DB.getCards();
    const picCards = DB.getPicCards();
    const helpline = DB.getHelpline();
    const cprQs    = DB.getCPRQuestions();
    const dldQs    = DB.getDLDQuestions();
    const jhopeQs  = DB.getJHopeQuestions();
    const anns     = DB.getAnns();
    const unread   = notifs.filter(n => !n.read).length;
    const pendEv   = evidence.filter(e => e.status === 'Pending').length;
    const openReps = reports.filter(r => !r.fromAdmin && r.status !== 'Resolved').length;
    const vActive  = LS.get('zc_voting_active', false);
    const vLink    = LS.get('zc_voting_link', '');
    const ct       = LS.get('zc_theme', 'golden-stardust');

    const pendLabel   = pendEv ? ' (' + pendEv + ')' : '';
    const unreadBadge = unread ? ' <span style="background:var(--pink);color:#fff;border-radius:8px;padding:1px 6px;font-size:0.68rem">' + unread + '</span>' : '';

    /* Firebase debug info */
    const fbProjectId = (typeof ZCLOCK_FB_CONFIG !== 'undefined') ? ZCLOCK_FB_CONFIG.projectId : 'not configured';
    const fbStatus    = fsErr
      ? '<span class="badge badge-red">❌ ' + escHtml(fsErr) + '</span>'
      : '<span class="badge badge-green">🔥 Live — ' + members.length + ' members</span>';
    const fbDebug = `<div class="card p-12 mb-10" style="border-color:rgba(196,142,100,0.3);font-size:0.75rem">
      <div class="section-title" style="font-size:0.7rem;margin-bottom:8px">🔧 Firebase Debug</div>
      <div class="flex-between mb-4"><span class="text-muted">Project ID</span><span style="color:var(--accent-1)">${escHtml(fbProjectId)}</span></div>
      <div class="flex-between mb-4"><span class="text-muted">Firestore Status</span>${fbStatus}</div>
      <div class="flex-between mb-4"><span class="text-muted">Members Collection</span><code style="font-size:0.72rem">members/</code></div>
      <div class="flex-between mb-4"><span class="text-muted">Documents Loaded</span><strong style="color:var(--accent-1)">${members.length}</strong></div>
      <div class="flex-between"><span class="text-muted">Last Read</span><span>${new Date().toLocaleTimeString()}</span></div>
      ${fsErr ? `<div class="mt-8" style="color:var(--pink);font-size:0.72rem">⚠️ Fix: Check Firestore Rules allow admin reads. See firebase-config.js for project setup.</div>` : ''}
    </div>`;

    el.innerHTML = [
    '<div class="page-eyebrow">Admin</div>',
    '<div class="page-heading mb-12">👑 Admin Control Centre</div>',
    '<div class="stat-grid mb-12">',
      '<div class="stat-card"><div class="stat-icon">👥</div><div class="stat-label">Members</div><div class="stat-value">' + members.length + '</div></div>',
      '<div class="stat-card"><div class="stat-icon">📎</div><div class="stat-label">Evidence</div><div class="stat-value">' + pendEv + '</div><div class="stat-sub">Pending</div></div>',
      '<div class="stat-card"><div class="stat-icon">📋</div><div class="stat-label">Reports</div><div class="stat-value">' + openReps + '</div><div class="stat-sub">Open</div></div>',
    '</div>',
    // Tab bar
    '<div class="admin-tabs" id="admin-tab-bar">',
      '<button class="admin-tab active" onclick="swAdm(this,\'adm-activity\')">🔔 Activity' + unreadBadge + '</button>',
      '<button class="admin-tab" onclick="swAdm(this,\'adm-members\')">👥 Members</button>',
      '<button class="admin-tab" onclick="swAdm(this,\'adm-member-detail\')">🔍 Detail</button>',
      '<button class="admin-tab" onclick="swAdm(this,\'adm-sync\')">🔄 Sync</button>',
      '<button class="admin-tab" onclick="swAdm(this,\'adm-evidence\')">📎 Evidence' + pendLabel + '</button>',
      '<button class="admin-tab" onclick="swAdm(this,\'adm-reports\')">📋 Reports</button>',
      '<button class="admin-tab" onclick="swAdm(this,\'adm-notice\')">📩 Notices</button>',
      '<button class="admin-tab" onclick="swAdm(this,\'adm-missions\')">🎯 Missions</button>',
      '<button class="admin-tab" onclick="swAdm(this,\'adm-tracks\')">🎵 Tracks</button>',
      '<button class="admin-tab" onclick="swAdm(this,\'adm-albums\')">💿 Albums</button>',
      '<button class="admin-tab" onclick="swAdm(this,\'adm-battle-cards\')">🃏 BBC Cards</button>',
      '<button class="admin-tab" onclick="swAdm(this,\'adm-picture-cards\')">🖼️ Pic Cards</button>',
      '<button class="admin-tab" onclick="swAdm(this,\'adm-card-missions\')">📋 Card Missions</button>',
      '<button class="admin-tab" onclick="swAdm(this,\'adm-games-cpr\')">🧠 CPR</button>',
      '<button class="admin-tab" onclick="swAdm(this,\'adm-games-dld\')">🎤 DLD</button>',
      '<button class="admin-tab" onclick="swAdm(this,\'adm-games-jhope\')">💃 J-Hope</button>',
      '<button class="admin-tab" onclick="swAdm(this,\'adm-games-reset\')">🔄 Reset</button>',
      '<button class="admin-tab" onclick="swAdm(this,\'adm-voting\')">🗳️ Voting</button>',
      '<button class="admin-tab" onclick="swAdm(this,\'adm-themes\')">🎨 Themes</button>',
      '<button class="admin-tab" onclick="swAdm(this,\'adm-ann\')">📢 Posts</button>',
      '<button class="admin-tab" onclick="swAdm(this,\'adm-helpline\')">🆘 Helpline</button>',
      '<button class="admin-tab" onclick="swAdm(this,\'adm-playlists\')">🎶 Playlists</button>',
      '<button class="admin-tab" onclick="swAdm(this,\'adm-video-missions\')">📺 Videos</button>',
    '</div>',
    _admActivity(notifs),
    _admMembers(members),
    _admDetail(members),
    _admSync(members),
    _admEvidence(evidence, pendEv),
    _admReports(reports),
    _admNotices(members),
    _admMissions(missions),
    _admTracks(tracks),
    _admAlbums(albums),
    _admBattleCards(cards),
    _admPicCards(picCards),
    _admCardMissions(DB.getCardMissions(), picCards),
    _admCPR(cprQs),
    _admDLD(dldQs),
    _admJHope(jhopeQs),
    _admReset(members),
    _admVoting(vActive, vLink),
    _admThemes(ct),
    _admAnn(anns),
    _admHelpline(helpline),
    _admPlaylists(playlists),
    _admVideoMissions(LS.get('zc_video_missions',[])),
    fbDebug,
  ].join('');
  }); // end FSB.listenMembers callback
}

/* ── Admin section builders (all use string concat, no nested template literals) ── */

function _admActivity(notifs) {
  const ICONS = {hp:'💜',stream:'🎵',mission:'🎯',evidence:'📎',report:'📋',vote:'🗳️',attendance:'📅',profile:'👤',game:'🎮',playlist:'🎶',helpline:'🆘',battle:'⚔️',milestone:'🏆',join:'🌟',system:'⚙️',sync:'🔄'};
  const items = notifs.slice(0,100).map(function(n) {
    var cls = n.read ? 'notif-item' : 'notif-item unread';
    return '<div class="' + cls + '"><div class="notif-icon">' + (ICONS[n.type]||'🔔') + '</div><div class="notif-body">' + escHtml(n.text) + '<div class="notif-time">' + new Date(n.time).toLocaleString() + '</div></div></div>';
  }).join('') || emptyState('🔔','No activity yet.');
  return '<div class="admin-panel active" id="adm-activity">' +
    '<div class="flex-between mb-12"><div class="section-title" style="margin:0">Live Activity</div>' +
    '<div style="display:flex;gap:6px">' +
    '<button class="btn btn-secondary btn-xs" onclick="markAllRead()">Mark all read</button>' +
    '<button class="btn btn-secondary btn-xs" onclick="loadAdminPanel()">🔄 Refresh</button>' +
    '</div></div>' + items + '</div>';
}

function _admMembers(members) {
  return '<div class="admin-panel" id="adm-members">' +
    '<div class="flex-between mb-12">' +
    '<div class="section-title" style="margin:0">All Members</div>' +
    '<button class="btn btn-primary btn-sm" onclick="loadAllMembersAdmin()">🔄 Refresh from Firebase</button>' +
    '</div>' +
    '<div id="admin-members-content">' + buildLocalMembersTable(members) + '</div>' +
    '</div>';
}

function _admDetail(members) {
  var opts = members.map(function(m){ return '<option value="' + escHtml(m.username) + '">' + escHtml(m.username) + '</option>'; }).join('');
  var first = members.length ? getMemberDetailHTML(members[0].username) : emptyState('👤','No members.');
  return '<div class="admin-panel" id="adm-member-detail">' +
    '<div class="form-group"><label class="form-label">Select Member</label>' +
    '<select class="form-input" id="md-select" onchange="showMemberDetail(this.value)">' + opts + '</select></div>' +
    '<div id="member-detail-content">' + first + '</div></div>';
}

function _admSync(members) {
  var rows = members.map(function(m) {
    var r = getSyncResult(m.username); var lf = (r&&r.platforms&&r.platforms.lastfm) ? r.platforms.lastfm : {};
    var cls = (lf.status==='HP added successfully'||lf.status==='Connected') ? 'badge-green' : 'badge-accent';
    var lastSync = lf.lastSync ? new Date(lf.lastSync).toLocaleString() : (r&&r.savedAt ? new Date(r.savedAt).toLocaleString() : 'Never');
    return '<tr><td><strong>' + escHtml(m.username) + '</strong></td><td>' + escHtml(m.team||'—') + '</td><td style="font-size:0.72rem">' + escHtml(lf.username||'—') + '</td><td>' + formatNum(m.streams||0) + '</td><td class="text-gold">' + formatNum(m.hpStreaming||0) + '</td><td>' + (lf.pending||0) + '</td><td><span class="badge ' + cls + '" style="font-size:0.62rem">' + escHtml(lf.status||'Not synced') + '</span></td><td style="font-size:0.72rem">' + lastSync + '</td></tr>';
  }).join('');
  return '<div class="admin-panel" id="adm-sync">' +
    '<div class="flex-between mb-8"><div class="section-title" style="margin:0">🔄 Streaming Sync</div>' +
    '<button class="btn btn-primary btn-xs" onclick="loadAdminSyncView()">🔄 Live from Backend</button></div>' +
    '<div id="admin-sync-content">' +
    '<div class="table-wrap"><table class="data-table"><thead><tr><th>Member</th><th>Team</th><th>Last.fm</th><th>Streams</th><th>HP</th><th>Pending</th><th>Status</th><th>Last Sync</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div></div></div>';
}

function _admEvidence(evidence, pendEv) {
  // Evidence is loaded from Firebase in loadAdminPanel — rendered here
  function evCard(e) {
    var scls = e.status==='Approved'?'badge-green':e.status==='Rejected'?'badge-red':'badge-accent';
    var imgs = (e.files||[]).filter(function(f){return f&&f.data&&f.data.startsWith('data:image');}).slice(0,4)
      .map(function(f){return '<img src="'+f.data+'" style="max-width:90px;border-radius:6px;max-height:70px;object-fit:cover;margin:2px" alt="ev">';}).join('');
    var btns = e.status==='Pending' ?
      '<div class="flex-row mt-8" style="gap:6px;flex-wrap:wrap">'+
        '<input type="number" id="ev-hp-'+e.id+'" class="form-input" placeholder="HP" value="'+HP.EVIDENCE+'" style="width:70px;font-size:0.78rem;padding:5px 8px">'+
        '<button class="btn btn-success btn-xs" data-eid="'+e.id+'" data-act="Approved" onclick="admReviewEvBtn(this)">✅ Approve</button>'+
        '<button class="btn btn-danger btn-xs" data-eid="'+e.id+'" data-act="Rejected" onclick="admReviewEvBtn(this)">❌ Reject</button>'+
      '</div>' : (e.adminResponse?'<div style="font-size:0.75rem;color:var(--accent-2);margin-top:6px">Admin: '+escHtml(e.adminResponse)+'</div>':'');
    return '<div class="card p-12 mb-8">'+
      '<div class="flex-between mb-6">'+
        '<div><strong>'+escHtml(e.username||e.user)+'</strong> <span class="text-muted">·</span> '+escHtml(e.team||'—')+'<br>'+
          '<span class="text-muted" style="font-size:0.72rem">'+escHtml(e.type)+' · '+escHtml(e.missionTitle||e.mission||'—')+' · '+new Date(e.ts).toLocaleDateString()+'</span></div>'+
        '<span class="badge '+scls+'">'+escHtml(e.status||'Pending')+'</span>'+
      '</div>'+
      (e.notes?'<div class="text-muted mb-6" style="font-size:0.8rem">"'+escHtml(e.notes)+'"</div>':'')+
      (imgs?'<div style="margin-bottom:8px">'+imgs+'</div>':'')+
      btns+'</div>';
  }
  var pending = evidence.filter(function(e){return e.status==='Pending';});
  var approved = evidence.filter(function(e){return e.status==='Approved';});
  var rejected = evidence.filter(function(e){return e.status==='Rejected';});
  var list = evidence.length ? evidence.map(evCard).join('') : emptyState('📎','No evidence submissions yet.');
  return '<div class="admin-panel" id="adm-evidence">'+
    '<div class="flex-between mb-12">'+
      '<div class="section-title" style="margin:0">📎 Evidence ('+evidence.length+')</div>'+
      '<div style="display:flex;gap:6px">'+
        '<span class="badge badge-accent">'+pending.length+' Pending</span>'+
        '<span class="badge badge-green">'+approved.length+' Approved</span>'+
        '<span class="badge badge-red">'+rejected.length+' Rejected</span>'+
        '<button class="btn btn-secondary btn-xs" onclick="admRefreshEvidence()">🔄 Refresh</button>'+
      '</div>'+
    '</div>'+
    list+'</div>';
}

async function admRefreshEvidence() {
  const db = FSB._db(); if(!db) return;
  try {
    const snap = await db.collection('evidence').orderBy('ts','desc').limit(200).get();
    const items = snap.docs.map(d => d.data());
    LS.set('zc_evidence_cache', items);
    loadAdminPanel();
    showToast('Evidence refreshed from Firebase ✅', 'success');
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
}

function _admReports(reports) {
  var member = reports.filter(function(r){return !r.fromAdmin;});
  var open = member.filter(function(r){return r.status==='Open';});
  var resolved = member.filter(function(r){return r.status==='Resolved';});
  var items = member.length ? member.map(function(r) {
    var scls = r.status==='Resolved'?'badge-green':'badge-accent';
    var resolve = r.status!=='Resolved' ?
      '<div class="flex-row mt-8" style="gap:6px">'+
        '<input type="text" class="form-input" id="rr-'+r.id+'" placeholder="Admin response…" style="flex:1;font-size:0.8rem;padding:7px 10px">'+
        '<button class="btn btn-success btn-xs" data-rid="'+r.id+'" onclick="admResolveReportBtn(this)">Resolve</button>'+
      '</div>' :
      '<div style="color:var(--gold);font-size:0.8rem;margin-top:6px">✅ '+escHtml(r.response||'Resolved')+'</div>';
    return '<div class="card p-12 mb-8">'+
      '<div class="flex-between mb-6"><div>'+
        '<strong>'+escHtml(r.username||r.user)+'</strong>'+
        (r.team?'<span class="text-muted"> · '+escHtml(r.team)+'</span>':'')+
        '<br><span style="font-weight:600;font-size:0.88rem">'+escHtml(r.title)+'</span>'+
        (r.category?'<span class="badge badge-accent" style="font-size:0.6rem;margin-left:6px">'+escHtml(r.category)+'</span>':'')+
        '<br><span class="text-muted" style="font-size:0.7rem">'+new Date(r.ts).toLocaleString()+'</span>'+
      '</div><span class="badge '+scls+'">'+escHtml(r.status||'Open')+'</span></div>'+
      '<div class="text-muted mb-6" style="font-size:0.82rem">'+escHtml(r.desc)+'</div>'+
      resolve+'</div>';
  }).join('') : emptyState('📋','No reports yet.');
  return '<div class="admin-panel" id="adm-reports">'+
    '<div class="flex-between mb-12">'+
      '<div class="section-title" style="margin:0">📋 Reports ('+member.length+')</div>'+
      '<div style="display:flex;gap:6px">'+
        '<span class="badge badge-accent">'+open.length+' Open</span>'+
        '<span class="badge badge-green">'+resolved.length+' Resolved</span>'+
        '<button class="btn btn-secondary btn-xs" onclick="admRefreshReports()">🔄 Refresh</button>'+
      '</div>'+
    '</div>'+items+'</div>';
}

async function admRefreshReports() {
  const db = FSB._db(); if(!db) return;
  try {
    const snap = await db.collection('reports').orderBy('ts','desc').limit(200).get();
    const items = snap.docs.map(d => d.data());
    LS.set('zc_reports_cache', items);
    loadAdminPanel();
    showToast('Reports refreshed from Firebase ✅', 'success');
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
}

function _admNotices(members) {
  var opts = members.map(function(m){return '<option value="' + escHtml(m.username) + '">' + escHtml(m.username) + '</option>';}).join('');
  return '<div class="admin-panel" id="adm-notice"><div class="card p-16">' +
    '<div class="section-title">📩 Send Notice to Member</div>' +
    '<div class="form-group"><label class="form-label">Member</label><select class="form-input" id="nt-user">' + opts + '</select></div>' +
    '<div class="form-group"><label class="form-label">Type</label><select class="form-input" id="nt-type"><option value="Notice">Notice</option><option value="Warning">⚠️ Warning</option><option value="Performance">📈 Performance</option><option value="Improvement">💡 Suggestion</option></select></div>' +
    '<div class="form-group"><label class="form-label">Title</label><input type="text" class="form-input" id="nt-title"></div>' +
    '<div class="form-group"><label class="form-label">Message</label><textarea class="form-input" id="nt-body"></textarea></div>' +
    '<button class="btn btn-primary btn-sm" onclick="admSendNotice()">Send</button></div></div>';
}

function _admMissions(missions) {
  var list = missions.map(function(m) {
    return '<div class="card p-10 mb-6 flex-between"><div><strong>' + escHtml(m.title) + '</strong> <span class="badge badge-accent">' + escHtml(m.type) + '</span><div class="text-muted" style="font-size:0.75rem">' + m.target + ' ' + escHtml(m.unit||'') + ' · +' + m.hp + ' HP</div></div>' +
      '<button class="btn btn-danger btn-xs" data-mid="' + escHtml(m.id) + '" onclick="admDelMissionBtn(this)">Del</button></div>';
  }).join('') || emptyState('🎯','No missions yet. Add one above.');
  return '<div class="admin-panel" id="adm-missions">' +
    '<div class="card p-14 mb-12"><div class="section-title">+ Add Mission</div>' +
    '<div class="grid-2">' +
    '<div class="form-group"><label class="form-label">Title</label><input type="text" class="form-input" id="am-title"></div>' +
    '<div class="form-group"><label class="form-label">Type</label><select class="form-input" id="am-type"><option>Individual</option><option>Team</option></select></div>' +
    '<div class="form-group"><label class="form-label">Target</label><input type="number" class="form-input" id="am-target" placeholder="50"></div>' +
    '<div class="form-group"><label class="form-label">Unit</label><input type="text" class="form-input" id="am-unit" value="streams"></div>' +
    '<div class="form-group"><label class="form-label">HP (max 20)</label><input type="number" class="form-input" id="am-hp" max="20"></div>' +
    '<div class="form-group"><label class="form-label">Deadline</label><input type="date" class="form-input" id="am-dl"></div>' +
    '</div><button class="btn btn-primary btn-sm" onclick="admAddMission()">Add Mission</button></div>' +
    '<div class="section-title">All Missions (' + missions.length + ')</div>' + list + '</div>';
}

function _admTracks(tracks) {
  var list = tracks.map(function(t) {
    return '<div class="card p-10 mb-6 flex-between"><div><strong>' + escHtml(t.title) + '</strong> — ' + escHtml(t.artist||'') + '</div><button class="btn btn-danger btn-xs" data-tid="' + escHtml(t.id) + '" onclick="admDelTrackBtn(this)">Del</button></div>';
  }).join('') || emptyState('🎵','No tracks yet.');
  return '<div class="admin-panel" id="adm-tracks">' +
    '<div class="card p-14 mb-12"><div class="section-title">+ Add Track</div>' +
    '<div class="grid-2">' +
    '<div class="form-group"><label class="form-label">Title</label><input type="text" class="form-input" id="at-title"></div>' +
    '<div class="form-group"><label class="form-label">Artist</label><input type="text" class="form-input" id="at-artist" value="BTS"></div>' +
    '<div class="form-group"><label class="form-label">Goal</label><input type="number" class="form-input" id="at-goal" placeholder="100"></div>' +
    '</div><button class="btn btn-primary btn-sm" onclick="admAddTrack()">Add Track</button></div>' +
    '<div class="section-title">All Tracks (' + tracks.length + ')</div>' + list + '</div>';
}

function _admAlbums(albums) {
  var list = albums.map(function(a) {
    return '<div class="card p-10 mb-6 flex-between"><div>' + (a.emoji||'💿') + ' <strong>' + escHtml(a.name) + '</strong> (' + escHtml(a.year||'') + ')</div><button class="btn btn-danger btn-xs" data-aid="' + escHtml(a.id) + '" onclick="admDelAlbumBtn(this)">Del</button></div>';
  }).join('') || emptyState('💿','No albums yet.');
  return '<div class="admin-panel" id="adm-albums">' +
    '<div class="card p-14 mb-12"><div class="section-title">+ Add Album</div>' +
    '<div class="grid-2">' +
    '<div class="form-group"><label class="form-label">Name</label><input type="text" class="form-input" id="aal-name"></div>' +
    '<div class="form-group"><label class="form-label">Year</label><input type="text" class="form-input" id="aal-year"></div>' +
    '<div class="form-group"><label class="form-label">Emoji</label><input type="text" class="form-input" id="aal-emoji" placeholder="💿"></div>' +
    '<div class="form-group"><label class="form-label">Goal</label><input type="number" class="form-input" id="aal-goal" placeholder="500"></div>' +
    '</div><button class="btn btn-primary btn-sm" onclick="admAddAlbum()">Add Album</button></div>' +
    '<div class="section-title">All Albums (' + albums.length + ')</div>' + list + '</div>';
}

function _admBattleCards(cards) {
  var RC = {common:'#aaaaaa',uncommon:'#5dade2',rare:'#82b4ff',epic:'#c39bd3',legendary:'#f0c040'};
  var grid = cards.map(function(c) {
    // Show actual uploaded image — never a joker/placeholder if image exists
    var art = (c.imageData || c.image || '')
      ? '<img src="' + (c.imageData||c.image||'') + '" style="width:100%;height:100%;object-fit:cover;border-radius:4px 4px 0 0" alt="' + escHtml(c.name) + '">'
      : '<div style="font-size:2rem;display:flex;align-items:center;justify-content:center;height:100%;color:' + (RC[c.rarity]||'#aaa') + '">🃏</div>';
    return '<div class="bbc-card bbc-admin-card">' +
      '<div class="bbc-art" style="height:110px;border-radius:4px 4px 0 0;overflow:hidden">' + art + '</div>' +
      '<div class="bbc-rarity-bar" style="background:' + (RC[c.rarity]||'#aaa') + '">' + ((c.rarity||'common').toUpperCase()) + '</div>' +
      '<div class="bbc-body">' +
      '<div class="bbc-name" style="font-size:0.78rem">' + escHtml(c.name) + '</div>' +
      '<div class="bbc-stats" style="font-size:0.68rem"><span>⚔️ ' + (c.attack||0) + '</span><span>🛡️ ' + (c.defense||0) + '</span></div>' +
      '<div style="font-size:0.6rem;color:var(--white-muted);margin-top:2px">Req: ' + (c.hpRequired||0) + ' HP</div>' +
      '<button class="btn btn-danger btn-xs" style="margin-top:6px;width:100%" data-cid="' + escHtml(c.id) + '" onclick="admDelCardBtn(this)">🗑️ Delete</button>' +
      '</div></div>';
  }).join('') || emptyState('🃏','No BBC battle cards yet. Upload one above.');
  return '<div class="admin-panel" id="adm-battle-cards">' +
    '<div class="card p-14 mb-12"><div class="section-title">🃏 Upload BBC Battle Card</div>' +
    '<div class="text-muted mb-10" style="font-size:0.8rem">Pokémon-style battle cards used in the Playmat. Upload the actual card image.</div>' +
    '<div class="grid-2">' +
    '<div class="form-group"><label class="form-label">Card Name</label><input type="text" class="form-input" id="ac-name" placeholder="e.g. RM - Namjoon"></div>' +
    '<div class="form-group"><label class="form-label">Rarity</label><select class="form-input" id="ac-rarity"><option value="common">Common</option><option value="uncommon">Uncommon</option><option value="rare">Rare</option><option value="epic">Epic</option><option value="legendary">Legendary</option></select></div>' +
    '<div class="form-group"><label class="form-label">HP Required to Unlock</label><input type="number" class="form-input" id="ac-hp" placeholder="0" value="0"></div>' +
    '<div class="form-group"><label class="form-label">Attack</label><input type="number" class="form-input" id="ac-atk" placeholder="50" value="50"></div>' +
    '<div class="form-group"><label class="form-label">Defense</label><input type="number" class="form-input" id="ac-def" placeholder="50" value="50"></div>' +
    '</div>' +
    '<div class="form-group"><label class="form-label">Card Image (required — actual BBC card image)</label>' +
    '<input type="file" class="form-input" id="ac-img" accept="image/*" onchange="previewCardImg(\'ac-img\',\'ac-preview\')" style="padding:8px">' +
    '<div id="ac-preview" style="margin-top:8px;display:none"><img id="ac-preview-img" style="max-width:140px;max-height:180px;object-fit:cover;border-radius:var(--radius-md);border:2px solid var(--accent-1)" alt="preview"></div></div>' +
    '<button class="btn btn-primary btn-sm" onclick="admAddCard()">📤 Upload BBC Card</button></div>' +
    '<div class="section-title mt-8">Uploaded BBC Cards (' + cards.length + ')</div>' +
    '<div class="bbc-grid" style="margin-top:10px">' + grid + '</div></div>';
}

function _admPicCards(picCards) {
  var grid = picCards.map(function(c) {
    var art = (c.imageData || c.image || '')
      ? '<img src="' + (c.imageData||c.image||'') + '" style="width:100%;height:100%;object-fit:cover;border-radius:4px 4px 0 0" alt="' + escHtml(c.name) + '">'
      : '<div style="font-size:2rem;display:flex;align-items:center;justify-content:center;height:100%;color:var(--accent-1)">🖼️</div>';
    return '<div class="pic-card pic-owned" style="max-width:140px">' +
      '<div class="pic-art" style="height:110px;border-radius:4px 4px 0 0;overflow:hidden">' + art + '</div>' +
      '<div class="pic-body">' +
      '<div class="pic-name" style="font-size:0.72rem">' + escHtml(c.name) + '</div>' +
      '<div style="font-size:0.6rem;color:var(--white-muted)">' + escHtml(c.collection||c.source||'—') + '</div>' +
      '<button class="btn btn-danger btn-xs" style="margin-top:6px;width:100%" data-pcid="' + escHtml(c.id) + '" onclick="admDelPicCardBtn(this)">🗑️ Delete</button>' +
      '</div></div>';
  }).join('') || emptyState('🖼️','No picture cards yet. Upload one above.');
  return '<div class="admin-panel" id="adm-picture-cards">' +
    '<div class="card p-14 mb-12"><div class="section-title">🖼️ Upload Picture Card</div>' +
    '<div class="text-muted mb-10" style="font-size:0.8rem">Display/collection-only cards. Members earn these via Card Missions — NOT used in battles.</div>' +
    '<div class="grid-2">' +
    '<div class="form-group"><label class="form-label">Card Name</label><input type="text" class="form-input" id="pc-name" placeholder="e.g. Jimin Photocard"></div>' +
    '<div class="form-group"><label class="form-label">Collection / Series</label><input type="text" class="form-input" id="pc-cat" placeholder="e.g. Butter Era, Photocards"></div>' +
    '<div class="form-group"><label class="form-label">Event / Source</label><input type="text" class="form-input" id="pc-source" placeholder="e.g. Voting Reward, Mission Prize"></div>' +
    '<div class="form-group"><label class="form-label">Description (optional)</label><input type="text" class="form-input" id="pc-desc" placeholder="Optional description"></div>' +
    '</div>' +
    '<div class="form-group"><label class="form-label">Card Image (required — actual picture card)</label>' +
    '<input type="file" class="form-input" id="pc-img" accept="image/*" onchange="previewCardImg(\'pc-img\',\'pc-preview\')" style="padding:8px">' +
    '<div id="pc-preview" style="margin-top:8px;display:none"><img id="pc-preview-img" style="max-width:140px;max-height:180px;object-fit:cover;border-radius:var(--radius-md);border:2px solid var(--accent-1)" alt="preview"></div></div>' +
    '<button class="btn btn-primary btn-sm" onclick="admAddPictureCard()">📤 Upload Picture Card</button></div>' +
    '<div class="section-title mt-8">Picture Cards (' + picCards.length + ')</div>' +
    '<div class="bbc-grid" style="margin-top:10px">' + grid + '</div></div>';
}

function _admCardMissions(cardMissions, picCards) {
  var pcOpts = picCards.map(function(c){ return '<option value="' + escHtml(c.id) + '">' + escHtml(c.name) + '</option>'; }).join('');
  var list = cardMissions.map(function(m) {
    var pc = picCards.find(function(c){ return String(c.id) === String(m.rewardCardId); });
    var _pcSrc = pc ? (pc.imageData||pc.image||'') : '';
    var pcArt = _pcSrc ? '<img src="' + escHtml(_pcSrc) + '" style="width:40px;height:40px;object-fit:cover;border-radius:6px;border:1px solid var(--border-color)" alt="card">' : (pc ? '🖼️' : '—');
    var statusBadge = m.active !== false ? '<span class="badge badge-green">✅ Active</span>' : '<span class="badge badge-red">🚫 Inactive</span>';
    return '<div class="card p-12 mb-8">' +
      '<div class="flex-between mb-6">' +
      '<div style="font-weight:700">' + escHtml(m.title) + '</div>' + statusBadge + '</div>' +
      '<div class="text-muted mb-6" style="font-size:0.8rem">' + escHtml(m.description||'') + '</div>' +
      (m.task ? '<div class="text-muted mb-6" style="font-size:0.75rem">Task: ' + escHtml(m.task) + '</div>' : '') +
      '<div class="flex-row mb-6" style="gap:10px;align-items:center">' + pcArt + '<span style="font-size:0.78rem">Card: <strong>' + escHtml(pc?.name||'—') + '</strong></span>' + (m.hpReward?'<span class="badge badge-gold" style="font-size:0.6rem">+'+m.hpReward+' HP</span>':'') + (m.deadline?'<span style="font-size:0.65rem;color:var(--white-muted)">📅 '+m.deadline+'</span>':'') + '</div>' +
      '<div style="display:flex;gap:6px">' +
      '<button class="btn btn-' + (m.active!==false?'danger':'success') + ' btn-xs" data-cmid="' + escHtml(m.id) + '" onclick="admToggleCardMissionBtn(this)">' + (m.active!==false?'🚫 Deactivate':'✅ Activate') + '</button>' +
      '<button class="btn btn-danger btn-xs" data-cmid="' + escHtml(m.id) + '" onclick="admDelCardMissionBtn(this)">🗑️ Delete</button>' +
      '</div></div>';
  }).join('') || emptyState('📋','No card missions yet. Create one above.');
  return '<div class="admin-panel" id="adm-card-missions">' +
    '<div class="card p-14 mb-12"><div class="section-title">📋 Create Card Mission</div>' +
    '<div class="text-muted mb-10" style="font-size:0.8rem">Members must complete the task to claim the picture card reward.</div>' +
    '<div class="grid-2">' +
    '<div class="form-group"><label class="form-label">Mission Title</label><input type="text" class="form-input" id="cm-title" placeholder="e.g. Stream 100 Songs"></div>' +
    '<div class="form-group"><label class="form-label">Picture Card Reward</label><select class="form-input" id="cm-card">' + (pcOpts || '<option>No picture cards yet — upload first</option>') + '</select></div>' +
    '<div class="form-group" style="grid-column:span 2"><label class="form-label">Mission Description</label><textarea class="form-input" id="cm-desc" rows="2" placeholder="Describe the mission to members"></textarea></div>' +
    '<div class="form-group" style="grid-column:span 2"><label class="form-label">Required Task</label><textarea class="form-input" id="cm-task" rows="2" placeholder="What members must do (e.g. Stream Purple Kiss 50 times and submit screenshot)"></textarea></div>' +
    '<div class="form-group"><label class="form-label">HP Bonus Reward</label><input type="number" class="form-input" id="cm-hp" placeholder="0" value="0"></div>' +
    '<div class="form-group"><label class="form-label">Deadline (optional)</label><input type="date" class="form-input" id="cm-dl"></div>' +
    '</div><button class="btn btn-primary btn-sm" onclick="admAddCardMission()">📋 Create Mission</button></div>' +
    '<div class="section-title mt-8">Card Missions (' + cardMissions.length + ')</div>' + list + '</div>';
}

function _admCPR(qs) {
  var list = qs.map(function(q) {
    var ans = q.opts && q.opts[q.ans] ? escHtml(q.opts[q.ans]) : '?';
    return '<div class="card p-10 mb-6"><div class="flex-between mb-4"><div style="font-size:0.85rem;font-weight:600">' + escHtml(q.q) + '</div>' +
      '<button class="btn btn-danger btn-xs" data-qid="' + escHtml(q.id) + '" onclick="admDelCPRBtn(this)">Del</button></div>' +
      '<div class="text-muted" style="font-size:0.72rem">✅ Answer: ' + ans + ' · ' + (q.time||10) + 's · +' + (q.hp||5) + ' HP</div></div>';
  }).join('') || emptyState('🧠','No CPR questions yet. Add one above.');
  return '<div class="admin-panel" id="adm-games-cpr">' +
    '<div class="section-title mb-8">🧠 Purple CPR Questions (' + qs.length + ')</div>' +
    '<div class="card p-14 mb-12"><div class="section-title">+ Add Question</div>' +
    '<div class="form-group"><label class="form-label">Question</label><input type="text" class="form-input" id="cpr-q" placeholder="e.g. What does BTS stand for?"></div>' +
    '<div class="form-group"><label class="form-label">Option A</label><input type="text" class="form-input" id="cpr-a"></div>' +
    '<div class="form-group"><label class="form-label">Option B</label><input type="text" class="form-input" id="cpr-b"></div>' +
    '<div class="form-group"><label class="form-label">Option C</label><input type="text" class="form-input" id="cpr-c"></div>' +
    '<div class="form-group"><label class="form-label">Option D</label><input type="text" class="form-input" id="cpr-d"></div>' +
    '<div class="grid-2">' +
    '<div class="form-group"><label class="form-label">Correct (0=A 1=B 2=C 3=D)</label><input type="number" class="form-input" id="cpr-ans" min="0" max="3" value="0"></div>' +
    '<div class="form-group"><label class="form-label">Time (seconds)</label><input type="number" class="form-input" id="cpr-time" value="10"></div>' +
    '<div class="form-group"><label class="form-label">HP Reward</label><input type="number" class="form-input" id="cpr-hp" value="5"></div>' +
    '</div><button class="btn btn-primary btn-sm" onclick="admAddCPRQuestion()">Add Question</button></div>' + list + '</div>';
}

function _admDLD(qs) {
  var list = qs.map(function(q) {
    return '<div class="card p-10 mb-6"><div class="flex-between mb-4"><div style="font-size:0.85rem;font-weight:600;font-style:italic">' + escHtml(q.lyric) + '</div>' +
      '<button class="btn btn-danger btn-xs" data-qid="' + escHtml(q.id) + '" onclick="admDelDLDBtn(this)">Del</button></div>' +
      '<div class="text-muted" style="font-size:0.72rem">Answer: ' + escHtml(q.song) + (q.hint?' · Hint: '+escHtml(q.hint):'') + ' · +' + (q.hp||5) + ' HP</div></div>';
  }).join('') || emptyState('🎤','No DLD lyrics yet. Add one above.');
  return '<div class="admin-panel" id="adm-games-dld">' +
    '<div class="section-title mb-8">🎤 DLD — Lyrics (' + qs.length + ')</div>' +
    '<div class="card p-14 mb-12"><div class="section-title">+ Add Lyric</div>' +
    '<div class="form-group"><label class="form-label">Lyric Line</label><input type="text" class="form-input" id="dld-lyric" placeholder="e.g. No matter who you are..."></div>' +
    '<div class="form-group"><label class="form-label">Correct Song</label><input type="text" class="form-input" id="dld-song" placeholder="e.g. DNA"></div>' +
    '<div class="form-group"><label class="form-label">Hint (optional)</label><input type="text" class="form-input" id="dld-hint"></div>' +
    '<div class="form-group"><label class="form-label">HP Reward</label><input type="number" class="form-input" id="dld-hp" value="5"></div>' +
    '<button class="btn btn-primary btn-sm" onclick="admAddDLDQuestion()">Add Lyric</button></div>' + list + '</div>';
}

function _admJHope(qs) {
  var list = qs.map(function(q) {
    var img = q.imageData ? '<img src="' + q.imageData + '" style="max-width:90px;border-radius:6px;margin-bottom:4px" alt="dance">' : '';
    return '<div class="card p-10 mb-6"><div class="flex-between mb-4"><div style="font-size:0.85rem;font-weight:600">' + escHtml(q.hint) + '</div>' +
      '<button class="btn btn-danger btn-xs" data-qid="' + escHtml(q.id) + '" onclick="admDelJHopeBtn(this)">Del</button></div>' +
      img + '<div class="text-muted" style="font-size:0.72rem">Answer: ' + escHtml(q.song) + ' · ' + (q.attempts||3) + ' attempts · +' + (q.hp||6) + ' HP</div></div>';
  }).join('') || emptyState('💃','No J-Hope questions yet. Add one above.');
  return '<div class="admin-panel" id="adm-games-jhope">' +
    '<div class="section-title mb-8">💃 J-Hope Time (' + qs.length + ')</div>' +
    '<div class="card p-14 mb-12"><div class="section-title">+ Add Question</div>' +
    '<div class="form-group"><label class="form-label">Hint / Description</label><input type="text" class="form-input" id="jh-hint" placeholder="e.g. Rapping about sunshine..."></div>' +
    '<div class="form-group"><label class="form-label">Dance Step Image (upload from device)</label>' +
    '<input type="file" class="form-input" id="jh-img-upload" accept="image/*" onchange="previewCardImg(\'jh-img-upload\',\'jh-img-preview\')" style="padding:8px">' +
    '<div id="jh-img-preview" style="margin-top:8px;display:none"><img id="jh-img-preview-img" style="max-width:160px;max-height:140px;object-fit:cover;border-radius:var(--radius-md);border:2px solid var(--border-color)" alt="preview"></div></div>' +
    '<div class="form-group"><label class="form-label">Correct Song</label><input type="text" class="form-input" id="jh-song" placeholder="e.g. Daydream"></div>' +
    '<div class="form-group"><label class="form-label">Attempts</label><input type="number" class="form-input" id="jh-att" value="3"></div>' +
    '<div class="form-group"><label class="form-label">HP Reward</label><input type="number" class="form-input" id="jh-hp" value="6"></div>' +
    '<button class="btn btn-primary btn-sm" onclick="admAddJHopeQuestion()">Add Question</button></div>' + list + '</div>';
}

function _admReset(members) {
  var opts = members.map(function(m){return '<option value="' + escHtml(m.username) + '">' + escHtml(m.username) + '</option>';}).join('');
  return '<div class="admin-panel" id="adm-games-reset">' +
    '<div class="card p-16 mb-12"><div class="section-title">🎮 Reset Member Games</div>' +
    '<div class="text-muted mb-12" style="font-size:0.82rem">Games lock after completion. Reset here so member can play again.</div>' +
    '<div class="form-group"><label class="form-label">Member</label><select class="form-input" id="gr-user">' + opts + '</select></div>' +
    '<div class="form-group"><label class="form-label">Game</label><select class="form-input" id="gr-game"><option value="cpr">Purple CPR</option><option value="dld">DLD</option><option value="jhope">J-Hope Time</option><option value="all">All Games</option></select></div>' +
    '<button class="btn btn-primary btn-sm" onclick="admResetGame()">Reset</button></div>' +

    '<div class="card p-16 mb-12"><div class="section-title">🔄 Site Resets</div>' +
    '<div class="text-muted mb-12" style="font-size:0.82rem">⚠️ These actions cannot be undone.</div>' +
    '<div style="display:flex;flex-wrap:wrap;gap:8px">' +
    '<button class="btn btn-danger btn-sm" onclick="admResetWeeklyHP()">Reset Weekly HP</button>' +
    '<button class="btn btn-danger btn-sm" onclick="admResetVoting()">Reset Voting</button>' +
    '<button class="btn btn-danger btn-sm" onclick="admResetAttendance()">Reset Attendance</button>' +
    '</div></div>' +

    '<div class="card p-16 mb-12"><div class="section-title">🔧 HP / Stream Repair</div>' +
    '<div class="text-muted mb-12" style="font-size:0.82rem">Fixes any member where weekly HP/streams exceed total HP/streams.</div>' +
    '<button class="btn btn-primary btn-sm" onclick="admRepairAllHP()">🔧 Repair All Members</button>' +
    '</div>' +

    '<div class="card p-16 mb-12" style="border-color:rgba(196,142,100,0.4)">' +
    '<div class="section-title" style="color:var(--pink)">🚨 FULL RESET — Keep Members</div>' +
    '<div class="text-muted mb-12" style="font-size:0.82rem">Resets ALL HP, streams, missions, games, attendance, sync data for everyone. Members stay registered but start at zero.</div>' +
    '<button class="btn btn-danger btn-full" style="background:linear-gradient(135deg,#c0392b,#922b21);font-weight:900;letter-spacing:1px" onclick="admFullReset()">🔴 FULL RESET — Start From Zero</button>' +
    '</div>' +

    '<div class="card p-16 mb-12" style="border-color:rgba(220,38,38,0.5)">' +
    '<div class="section-title" style="color:#dc2626">☠️ DELETE EVERYTHING</div>' +
    '<div class="text-muted mb-12" style="font-size:0.82rem">Permanently deletes ALL members, accounts, HP, streams, missions, tracks, albums, evidence, reports, helpline tickets, games, cards, notifications, activity logs — everything. The site becomes a brand new empty website. Members must Join ARMY again.</div>' +
    '<button class="btn btn-full" style="background:#000;border:2px solid #dc2626;color:#dc2626;font-weight:900;letter-spacing:1px" onclick="admDeleteEverything()">☠️ DELETE EVERYTHING — Brand New Site</button>' +
    '</div>' +

    '<div class="card p-16" style="border-color:rgba(220,38,38,0.5)">' +
    '<div class="section-title" style="color:#dc2626">🧹 Fix "Username Already Taken" Bug</div>' +
    '<div class="text-muted mb-12" style="font-size:0.82rem">If members can\'t register because the username shows as taken even after deletion, click this to wipe ALL leftover backend member records and banned usernames.</div>' +
    '<button class="btn btn-full" style="background:#7c2d12;border:2px solid #dc2626;color:#fca5a5;font-weight:800" onclick="admWipeBackendMembers()">🧹 Wipe All Backend Member Records</button>' +
    '</div></div>';
}

function _admVoting(vActive, vLink) {
  var badge = vActive ? '<span class="badge badge-green">✅ Active</span>' : '<span class="badge badge-red">🚫 Closed</span>';
  return '<div class="admin-panel" id="adm-voting"><div class="card p-16">' +
    '<div class="section-title">🗳️ Voting Control</div>' +
    '<div class="flex-row mb-12">' + badge + '</div>' +
    '<div class="form-group"><label class="form-label">Voting Link</label><input type="url" class="form-input" id="adm-vl" value="' + escHtml(vLink) + '" placeholder="https://..."></div>' +
    '<div class="flex-row">' +
    '<button class="btn btn-success btn-sm" onclick="admSetVoting(true)">✅ Activate</button>' +
    '<button class="btn btn-danger btn-sm" onclick="admSetVoting(false)">🚫 Close</button>' +
    '<button class="btn btn-secondary btn-sm" onclick="admSaveVoteLink()">💾 Save Link</button>' +
    '</div></div></div>';
}

function _admThemes(ct) {
  var btns = THEMES.map(function(t) {
    var active = ct === t ? 'btn-primary' : 'btn-secondary';
    return '<button class="btn ' + active + '" data-theme="' + t + '" onclick="admApplyThemeBtn(this)">' + escHtml(THEME_NAMES[t]) + '</button>';
  }).join('');
  return '<div class="admin-panel" id="adm-themes"><div class="card p-16">' +
    '<div class="section-title">🎨 Site Theme</div>' +
    '<div class="text-muted mb-12" style="font-size:0.82rem">Currently active: <strong style="color:var(--accent-1)">' + escHtml(THEME_NAMES[ct]||ct) + '</strong></div>' +
    '<div class="grid-2">' + btns + '</div></div></div>';
}

function _admAnn(anns) {
  var list = anns.map(function(a) {
    return '<div class="card p-10 mb-6 flex-between"><div><strong>' + escHtml(a.title) + '</strong><div class="text-muted" style="font-size:0.72rem">' + new Date(a.ts).toLocaleString() + '</div></div><button class="btn btn-danger btn-xs" data-aid="' + a.id + '" onclick="admDelAnnBtn(this)">Del</button></div>';
  }).join('') || emptyState('📢','No announcements yet.');
  return '<div class="admin-panel" id="adm-ann">' +
    '<div class="card p-14 mb-12"><div class="section-title">📢 Post Announcement</div>' +
    '<div class="form-group"><label class="form-label">Title</label><input type="text" class="form-input" id="ann-t" placeholder="Announcement title"></div>' +
    '<div class="form-group"><label class="form-label">Body</label><textarea class="form-input" id="ann-b" placeholder="Announcement content…"></textarea></div>' +
    '<button class="btn btn-primary btn-sm" onclick="admPostAnn()">Post</button></div>' +
    '<div class="section-title">All Announcements (' + anns.length + ')</div>' + list + '</div>';
}

/* ── Admin Video Missions Panel ── */
function _admVideoMissions(missions) {
  const addForm = `<div class="card p-16 mb-12">
    <div class="section-title mb-10">➕ Add Video Mission</div>
    <div class="grid-2">
      <div class="form-group"><label class="form-label">Mission Title</label><input type="text" class="form-input" id="vm-title" placeholder="e.g. Jungkook Seven Mission"></div>
      <div class="form-group"><label class="form-label">MV Name</label><input type="text" class="form-input" id="vm-mvname" placeholder="e.g. SEVEN MV"></div>
    </div>
    <div class="form-group"><label class="form-label">YouTube URL</label><input type="url" class="form-input" id="vm-url" placeholder="https://youtube.com/watch?v=..."></div>
    <div class="grid-2">
      <div class="form-group"><label class="form-label">HP Reward (max 20)</label><input type="number" class="form-input" id="vm-hp" value="10" min="1" max="20"></div>
      <div class="form-group"><label class="form-label">Team Target</label>
        <select class="form-input" id="vm-team"><option value="All">All Members</option><option value="Hyung Line">💜 Hyung Line</option><option value="Maknae Line">🩷 Maknae Line</option></select>
      </div>
    </div>
    <div class="grid-2">
      <div class="form-group"><label class="form-label">Start Date (optional)</label><input type="date" class="form-input" id="vm-start"></div>
      <div class="form-group"><label class="form-label">End Date (optional)</label><input type="date" class="form-input" id="vm-end"></div>
    </div>
    <div class="form-group"><label class="form-label">Description</label><textarea class="form-input" id="vm-desc" rows="2" placeholder="Mission description..."></textarea></div>
    <button class="btn btn-primary btn-sm" onclick="admAddVideoMission()">📺 Add Video Mission</button>
  </div>`;

  const list = missions.length ? missions.map(m => {
    const vid = typeof getYTId==='function' ? getYTId(m.youtubeUrl||'') : '';
    const thumb = vid ? '<img src="https://img.youtube.com/vi/'+vid+'/mqdefault.jpg" style="width:80px;border-radius:6px;flex-shrink:0" alt="thumb">' : '<div style="width:80px;height:45px;background:rgba(0,0,0,0.4);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:1.4rem">📺</div>';
    return '<div class="card p-12 mb-8">'+
      '<div class="flex-between mb-8">'+
        '<div style="display:flex;gap:10px;align-items:center;flex:1;min-width:0">'+
          thumb+
          '<div style="min-width:0">'+
            '<div style="font-weight:700;font-size:0.88rem">'+escHtml(m.title)+'</div>'+
            '<div class="text-muted" style="font-size:0.72rem">'+escHtml(m.mvName||'—')+' · +'+m.hpReward+' HP · '+escHtml(m.teamTarget||'All')+'</div>'+
            (m.startDate||m.endDate?'<div class="text-muted" style="font-size:0.68rem">'+(m.startDate||'')+(m.endDate?' → '+m.endDate:'')+'</div>':'')+
          '</div>'+
        '</div>'+
        '<div style="display:flex;gap:6px;flex-shrink:0">'+
          '<span class="badge '+(m.active?'badge-green':'badge-red')+'" style="font-size:0.62rem">'+(m.active?'Active':'Inactive')+'</span>'+
          '<button class="btn btn-secondary btn-xs" data-vmid="'+m.id+'" onclick="admToggleVM(this.dataset.vmid)">Toggle</button>'+
          '<button class="btn btn-danger btn-xs" data-vmid="'+m.id+'" onclick="admDelVM(this.dataset.vmid)">Del</button>'+
        '</div>'+
      '</div>'+
      '<div style="font-size:0.75rem;color:var(--white-muted)">'+escHtml(m.youtubeUrl||'—')+'</div>'+
    '</div>';
  }).join('') : emptyState('📺', 'No video missions yet.');

  // Member completions from Firebase
  var members = DB.getMembers().filter(function(m){return !m.isAdmin;});
  var completionRows = '';
  missions.forEach(function(m) {
    var completors = members.filter(function(mem) {
      var comps = mem.videoCompletions || {};
      return comps[m.id] && comps[m.id].claimed;
    });
    if (completors.length) {
      completionRows += '<div class="section-title mb-6" style="font-size:0.75rem;margin-top:10px">'+escHtml(m.title)+' — Completions ('+completors.length+')</div>'+
        completors.map(function(mem) {
          var c = mem.videoCompletions[m.id];
          return '<div class="card p-8 mb-4 flex-between"><div><strong>'+escHtml(mem.username)+'</strong> <span class="text-muted">· '+escHtml(mem.team||'—')+'</span></div>'+
            '<div style="display:flex;gap:6px;font-size:0.7rem"><span class="badge badge-green">✅ '+Math.round(c.watchPercent||100)+'%</span>'+
            (c.completedAt?'<span class="text-muted">'+new Date(c.completedAt).toLocaleDateString()+'</span>':'')+'</div></div>';
        }).join('');
    }
  });

  return '<div class="admin-panel" id="adm-video-missions">'+
    '<div class="section-title mb-12">📺 Video Mission Manager</div>'+
    addForm+
    '<div class="section-title mb-8">Missions ('+missions.length+')</div>'+
    list+
    (completionRows?'<div class="divider mt-12 mb-10"></div><div class="section-title mb-8">📊 Member Completions</div>'+completionRows:'')+
    '</div>';
}

function admAddVideoMission() {
  const title = document.getElementById('vm-title')?.value.trim();
  const mvName = document.getElementById('vm-mvname')?.value.trim();
  const url = document.getElementById('vm-url')?.value.trim();
  const hp = Math.min(20, parseInt(document.getElementById('vm-hp')?.value)||10);
  const team = document.getElementById('vm-team')?.value||'All';
  const desc = document.getElementById('vm-desc')?.value.trim()||'';
  const startDate = document.getElementById('vm-start')?.value||'';
  const endDate = document.getElementById('vm-end')?.value||'';
  if (!title) { showToast('Enter mission title.','warn'); return; }
  if (!url || !getYTId(url)) { showToast('Enter a valid YouTube URL.','warn'); return; }
  const id = 'vm' + Date.now();
  const doc = { id, videoMissionId:id, title, mvName, youtubeUrl:url, hpReward:hp, teamTarget:team, description:desc, startDate, endDate, active:true, createdBy:'admin', createdAt:new Date().toISOString() };
  const all = LS.get('zc_video_missions',[]); all.push(doc); LS.set('zc_video_missions', all);
  // Save to Firebase
  _fbSaveDoc('videoMissions', id, doc);
  FSB.saveDoc('videoMissions','_index',{items:all,updatedAt:new Date().toISOString()}).catch(()=>{});
  DB.addNotif('video','Admin added video mission: '+title);
  showToast('Video mission added! ✅','success');
  loadAdminPanel();
}

function admToggleVM(id) {
  const all = LS.get('zc_video_missions',[]);
  const m = all.find(x=>x.id===id); if(!m)return;
  m.active = !m.active;
  LS.set('zc_video_missions', all);
  _fbSaveDoc('videoMissions', id, m);
  FSB.saveDoc('videoMissions','_index',{items:all,updatedAt:new Date().toISOString()}).catch(()=>{});
  showToast(m.active?'Mission activated!':'Mission deactivated.','success');
  loadAdminPanel();
}

function admDelVM(id) {
  if (!confirm('Delete this video mission?')) return;
  const all = LS.get('zc_video_missions',[]).filter(x=>x.id!==id);
  LS.set('zc_video_missions', all);
  _fbDeleteDoc('videoMissions', id);
  FSB.saveDoc('videoMissions','_index',{items:all,updatedAt:new Date().toISOString()}).catch(()=>{});
  showToast('Video mission deleted.','success');
  loadAdminPanel();
}

function _admPlaylists(playlists) {
  const official = playlists.filter(p => p.type === 'official');
  const requests = playlists.filter(p => p.type !== 'official');
  const platIcon = {Spotify:'🟢','Apple Music':'🍎','YouTube Music':'▶️',Other:'🎵'};

  const addForm = `<div class="card p-16 mb-12">
    <div class="section-title mb-10">➕ Add Official Playlist</div>
    <div class="grid-2">
      <div class="form-group"><label class="form-label">Playlist Title</label><input type="text" class="form-input" id="adm-pl-title" placeholder="BTS Official Mix"></div>
      <div class="form-group"><label class="form-label">Link</label><input type="url" class="form-input" id="adm-pl-link" placeholder="https://open.spotify.com/..."></div>
    </div>
    <div class="grid-2">
      <div class="form-group"><label class="form-label">Platform</label>
        <select class="form-input" id="adm-pl-platform"><option>Spotify</option><option>Apple Music</option><option>YouTube Music</option><option>Other</option></select>
      </div>
      <div class="form-group"><label class="form-label">Category</label>
        <select class="form-input" id="adm-pl-cat"><option>Focus</option><option>General</option><option>Team</option><option>Mission</option><option>Special</option></select>
      </div>
    </div>
    <div class="grid-2">
      <div class="form-group"><label class="form-label">Visible To</label>
        <select class="form-input" id="adm-pl-team"><option value="All">All Members</option><option value="Hyung Line">💜 Hyung Line</option><option value="Maknae Line">🩷 Maknae Line</option></select>
      </div>
      <div class="form-group"><label class="form-label">Description</label><input type="text" class="form-input" id="adm-pl-desc" placeholder="Optional description"></div>
    </div>
    <div class="form-group" style="display:flex;align-items:center;gap:8px">
      <input type="checkbox" id="adm-pl-featured" style="width:16px;height:16px">
      <label for="adm-pl-featured" class="form-label" style="margin:0">⭐ Mark as Featured</label>
    </div>
    <button class="btn btn-primary btn-sm" onclick="admAddPlaylist()">➕ Add Playlist</button>
  </div>`;

  const offList = official.length ? official.map(p => {
    const icon = platIcon[p.platform] || '🎵';
    return `<div class="card p-12 mb-8">
      <div class="flex-between mb-6">
        <div style="display:flex;gap:10px;align-items:center">
          <span style="font-size:1.2rem">${icon}</span>
          <div>
            <div style="font-weight:700;font-size:0.88rem">${escHtml(p.title||'Untitled')}${p.featured?' ⭐':''}</div>
            <div class="text-muted" style="font-size:0.72rem">${escHtml(p.platform)} · ${escHtml(p.category)} · ${escHtml(p.team||'All')}</div>
            ${p.link?`<div style="font-size:0.68rem;color:var(--accent-2);margin-top:2px">${escHtml(p.link.slice(0,45))}…</div>`:''}
          </div>
        </div>
        <button class="btn btn-danger btn-xs" onclick="admDelPlaylist(${p.id})">Del</button>
      </div>
    </div>`;
  }).join('') : emptyState('🎶', 'No official playlists yet. Add one above.');

  const reqList = requests.length ? requests.map(r => {
    const statusCls = r.status==='Approved'?'badge-green':r.status==='Rejected'?'badge-red':'badge-accent';
    return `<div class="card p-12 mb-8">
      <div class="flex-between mb-6">
        <div>
          <div style="font-weight:700;font-size:0.85rem">${escHtml(r.name)}</div>
          <div class="text-muted" style="font-size:0.72rem">${escHtml(r.user)} · ${escHtml(r.platform)} · ${escHtml(r.category||'—')}</div>
          ${r.note?`<div style="font-size:0.75rem;margin-top:4px;color:var(--white-muted)">"${escHtml(r.note)}"</div>`:''}
          ${r.link?`<div style="font-size:0.68rem;color:var(--accent-2);margin-top:2px">${escHtml(r.link)}</div>`:''}
        </div>
        <span class="badge ${statusCls}">${r.status||'Pending'}</span>
      </div>
      ${r.status==='Pending'?`<div style="display:flex;gap:6px">
        <button class="btn btn-success btn-xs" onclick="admApprovePlaylistReq(${r.id},'approve')">✅ Approve</button>
        <button class="btn btn-danger btn-xs" onclick="admApprovePlaylistReq(${r.id},'reject')">❌ Reject</button>
      </div>`:''}
    </div>`;
  }).join('') : emptyState('📤', 'No playlist requests from members.');

  return `<div class="admin-panel" id="adm-playlists">
    <div class="section-title mb-12">🎶 Playlist Management</div>
    ${addForm}
    <div class="section-title mb-8">📋 Official Playlists (${official.length})</div>
    ${offList}
    <div class="divider mt-12 mb-12"></div>
    <div class="section-title mb-8">📤 Member Requests (${requests.length})</div>
    ${reqList}
  </div>`;
}

function _admHelpline(helpline) {
  var STATUS_CLS = {Open:'badge-accent','In Progress':'badge-gold',Resolved:'badge-green',Closed:'badge-red'};
  var list = helpline.map(function(h) {
    var statusCls = STATUS_CLS[h.status]||'badge-accent';
    var attachPreviews = (h.attachments||[]).filter(function(f){return f&&f.data&&f.data.startsWith('data:image');}).slice(0,3).map(function(f){
      return '<img src="'+f.data+'" style="max-width:80px;max-height:70px;object-fit:cover;border-radius:5px;margin:3px" alt="att">';
    }).join('');
    var replySection = h.status !== 'Resolved' && h.status !== 'Closed'
      ? '<div class="flex-row mt-8" style="gap:6px;flex-wrap:wrap">' +
          '<input type="text" class="form-input" id="hlreply-'+h.id+'" placeholder="Reply to member…" style="flex:1;font-size:0.8rem;padding:7px 10px">' +
          '<button class="btn btn-success btn-xs" data-hid="'+h.id+'" onclick="admHelplineReply(this)">Reply</button>' +
          '<button class="btn btn-secondary btn-xs" data-hid="'+h.id+'" data-st="In Progress" onclick="admHelplineStatus(this)">In Progress</button>' +
          '<button class="btn btn-gold btn-xs" data-hid="'+h.id+'" data-st="Resolved" onclick="admHelplineStatus(this)">Resolve</button>' +
          '<button class="btn btn-danger btn-xs" data-hid="'+h.id+'" data-st="Closed" onclick="admHelplineStatus(this)">Close</button>' +
        '</div>'
      : '<div class="badge badge-green mt-8" style="font-size:0.65rem">'+escHtml(h.status)+'</div>';
    var existingReply = h.adminReply ? '<div class="mt-6" style="background:rgba(196,142,100,0.1);border-left:3px solid var(--accent-1);padding:8px;border-radius:4px;font-size:0.8rem"><strong>Your Reply:</strong> '+escHtml(h.adminReply)+'</div>' : '';
    return '<div class="card p-14 mb-10">' +
      '<div class="flex-between mb-8">' +
        '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
          '<span class="badge badge-gold" style="font-size:0.68rem">'+escHtml(h.ticketId||('ZH-'+h.id))+'</span>' +
          '<strong>'+escHtml(h.user)+'</strong>' +
          '<span class="badge badge-accent" style="font-size:0.65rem">'+escHtml(h.category||h.issue||'Issue')+'</span>' +
        '</div>' +
        '<span class="badge '+statusCls+'" style="font-size:0.65rem">'+escHtml(h.status||'Open')+'</span>' +
      '</div>' +
      '<div class="grid-2 mb-8" style="gap:6px;font-size:0.78rem">' +
        '<div><span class="text-muted">Platform:</span> '+escHtml(h.platform||'—')+'</div>' +
        '<div><span class="text-muted">Username:</span> @'+escHtml(h.platformUsername||h.user)+'</div>' +
        '<div><span class="text-muted">User ID:</span> '+escHtml(h.userId||'—')+'</div>' +
        '<div><span class="text-muted">Team:</span> '+escHtml(h.team||'—')+'</div>' +
      '</div>' +
      '<div style="font-size:0.85rem;line-height:1.6;padding:10px;background:var(--bg-glass);border-radius:var(--radius-sm);margin-bottom:8px">'+escHtml(h.description||h.msg||'—')+'</div>' +
      (attachPreviews ? '<div style="margin-bottom:8px">'+attachPreviews+'</div>' : '') +
      '<div class="text-muted" style="font-size:0.68rem">'+new Date(h.ts).toLocaleString()+(h.fileCount?' · '+h.fileCount+' attachment(s)':'')+'</div>' +
      existingReply +
      replySection +
    '</div>';
  }).join('') || emptyState('🆘','No helpline requests yet.');

  return '<div class="admin-panel" id="adm-helpline">' +
    '<div class="flex-between mb-12">' +
      '<div class="section-title" style="margin:0">🆘 Support Tickets ('+helpline.length+')</div>' +
      '<div style="display:flex;gap:6px">' +
        '<button class="btn btn-secondary btn-xs" onclick="admFilterHelpline(\'Open\')">Open</button>' +
        '<button class="btn btn-secondary btn-xs" onclick="admFilterHelpline(\'In Progress\')">In Progress</button>' +
        '<button class="btn btn-secondary btn-xs" onclick="admFilterHelpline(\'Resolved\')">Resolved</button>' +
        '<button class="btn btn-secondary btn-xs" onclick="admFilterHelpline(\'all\')">All</button>' +
      '</div>' +
    '</div>' +
    '<div id="helpline-list">'+list+'</div>' +
  '</div>';
}

function admHelplineReply(btn) {
  var id = parseInt(btn.dataset.hid);
  var inp = document.getElementById('hlreply-' + id);
  var reply = inp ? inp.value.trim() : '';
  if (!reply) { showToast('Enter a reply.', 'warn'); return; }
  var all = DB.getHelpline();
  var i = all.findIndex(function(h){ return h.id === id; });
  if (i < 0) return;
  all[i].adminReply = reply;
  all[i].status = 'In Progress';
  DB.saveHelpline(all);
  DB.addNotif('helpline', 'Admin replied to ticket ' + (all[i].ticketId||id) + ' from ' + all[i].user);
  showToast('Reply sent!', 'success');
  loadAdminPanel();
}

function admHelplineStatus(btn) {
  var id = parseInt(btn.dataset.hid);
  var st = btn.dataset.st;
  var all = DB.getHelpline();
  var i = all.findIndex(function(h){ return h.id === id; });
  if (i < 0) return;
  all[i].status = st;
  DB.saveHelpline(all);
  showToast('Ticket marked as ' + st, 'success');
  DB.addNotif('helpline', 'Ticket ' + (all[i].ticketId||id) + ' marked as ' + st);
  loadAdminPanel();
}

function admFilterHelpline(status) {
  var all = DB.getHelpline();
  var filtered = status === 'all' ? all : all.filter(function(h){ return (h.status||'Open') === status; });
  var el = document.getElementById('helpline-list'); if (!el) return;
  if (!filtered.length) { el.innerHTML = emptyState('🆘', 'No ' + status + ' tickets.'); return; }
  el.innerHTML = _admHelpline(filtered).replace('<div class="admin-panel" id="adm-helpline">','').replace(/^[\s\S]*?<div id="helpline-list">/, '').replace(/<\/div>\s*$/, '');
  loadAdminPanel();
}

/* ── Data-attribute button helpers (avoids onclick quote nesting) ── */
function admReviewEvBtn(btn){admReviewEv(parseInt(btn.dataset.eid),btn.dataset.act);}
function admResolveReportBtn(btn){admResolveReport(btn.dataset.rid||btn.getAttribute('data-rid'));}
function admDelMissionBtn(btn){admDelMission(btn.dataset.mid);}
function admDelTrackBtn(btn){admDelTrack(btn.dataset.tid);}
function admDelAlbumBtn(btn){admDelAlbum(btn.dataset.aid);}
function admDelCardBtn(btn){admDelCard(btn.dataset.cid);}
function admDelPicCardBtn(btn){admDelPictureCard(btn.dataset.pcid);}
function admDelCPRBtn(btn){admDelCPRQuestion(btn.dataset.qid);}
function admDelDLDBtn(btn){admDelDLDQuestion(btn.dataset.qid);}
function admDelJHopeBtn(btn){admDelJHopeQuestion(btn.dataset.qid);}
function admDelAnnBtn(btn){admDelAnn(parseInt(btn.dataset.aid));}
function admApplyThemeBtn(btn){applyTheme(btn.dataset.theme);loadAdminPanel();showToast('Theme applied!','success');}
function admResetWeeklyHP(){if(!confirm('Reset ALL members weekly HP to 0?\n\nTotal HP and Total Streams will NOT be affected.'))return;const m=DB.getMembers();m.forEach(x=>{x.hp=0;x.weeklyHp=0;x.weeklyStreams=0;x.streams=0;x.weeklyMissionCount=0;x.votesToday=0;});DB.saveMembers(m);showToast('Weekly HP reset! Total HP preserved ✅','success');DB.addNotif('system','Admin reset weekly HP — Total HP preserved');loadAdminPanel();}

async function admRepairAllHP() {
  if (!confirm('Repair all members HP/streams data?\n\nEnsures totalHP >= weeklyHP and totalStreams >= weeklyStreams for everyone.')) return;
  const m = DB.getMembers(); let fixed = 0;
  m.forEach(x => {
    if ((x.hp||0) > (x.totalHp||0))          { x.totalHp = x.hp; fixed++; }
    if ((x.streams||0) > (x.totalStreams||0)) { x.totalStreams = x.streams; x.lifetimeStreams = x.streams; fixed++; }
    if (!x.weeklyHp) x.weeklyHp = x.hp || 0;
    if (!x.weeklyStreams) x.weeklyStreams = x.streams || 0;
  });
  DB.saveMembers(m);
  // Push fixes to Firebase
  const db = FSB._db();
  if (db) {
    await Promise.allSettled(m.map(x => {
      if (!x.uid) return;
      return db.collection('members').doc(x.uid).update({
        totalHp: x.totalHp||0, totalStreams: x.totalStreams||0, lifetimeStreams: x.totalStreams||0,
        weeklyHp: x.weeklyHp||0, weeklyStreams: x.weeklyStreams||0
      }).catch(()=>{});
    }));
  }
  showToast(`Repaired ${fixed} field(s) across ${m.length} members ✅`, 'success');
  DB.addNotif('admin', `Admin ran HP repair — fixed ${fixed} corrupted fields`);
  loadAdminPanel();
}

async function admFullReset() {
  if (!confirm('⚠️ FULL RESET ⚠️\n\nThis will reset ALL member HP, streams, sync data, games, missions, and attendance to ZERO.\n\nMembers stay registered — only their progress resets.\n\nThis cannot be undone.\n\nContinue?')) return;
  if (!confirm('Final confirmation — reset EVERYTHING to zero for a fresh start?')) return;
  const db = FSB._db();
  const members = DB.getMembers();

  const resetData = {
    hp: 0, weeklyHp: 0, totalHp: 0,
    streams: 0, weeklyStreams: 0, totalStreams: 0, lifetimeStreams: 0,
    lastSyncStreams: 0, streamsCountedThisSync: 0, pendingStreams: 0,
    hpStreaming: 0, hpVoting: 0, hpMissions: 0, hpGames: 0, hpAttendance: 0, hpBonus: 0, hpVideo: 0,
    weeklyHpStreaming: 0, weeklyHpVoting: 0, weeklyHpMissions: 0, weeklyHpGames: 0, weeklyHpAttendance: 0,
    votesToday: 0, weeklyMissionCount: 0,
    completedMissions: [], completedGames: [], attendance: {}, attendanceHistory: [],
    hpLog: [], trackStreams: {},
    listenbrainz: { username: '', connected: false, firstSyncCompleted: false },
    lastActive: new Date().toISOString(),
  };

  if (db) {
    showToast('Resetting... please wait', 'info');
    await Promise.allSettled(members.map(m => {
      if (!m.uid) return;
      return db.collection('members').doc(m.uid).update(resetData).catch(()=>{});
    }));
    await Promise.allSettled(members.map(m => {
      const uid = m.uid || m.username; if (!uid) return;
      return db.collection('syncData').doc(uid).set({ lb: { savedCount: null, firstSyncDone: false, pending: 0, earnedHP: 0, totalStreams: 0, lastSync: null }, lastfm: { savedCount: null, firstSyncDone: false, pending: 0, earnedHP: 0 } }).catch(()=>{});
    }));
    const collectionsToWipe = ['streamSync', 'hpTransactions', 'notifications', 'dailyGameCompletions', 'streamSyncLogs', 'memberTrackProgress', 'memberAlbumProgress', 'memberMissionProgress'];
    for (const colName of collectionsToWipe) {
      try {
        const snap = await db.collection(colName).limit(500).get();
        const batch = db.batch();
        snap.docs.forEach(d => batch.delete(d.ref));
        if (!snap.empty) await batch.commit();
      } catch(e) {}
    }
    await db.collection('settings').doc('weeklyReset').set({ lastReset: null, resetAt: new Date().toISOString(), note: 'Full reset by admin' }).catch(()=>{});
  }

  members.forEach(m => { Object.assign(m, resetData); });
  DB.saveMembers(members);
  members.forEach(m => { LS.del(`zc_sync_${m.username}`); });

  showToast('✅ Full reset complete! Fresh start for everyone 💜', 'success');
  DB.addNotif('system', '🔄 Admin performed full reset — all data cleared. Fresh start!');
  loadAdminPanel();
}

async function admWipeBackendMembers() {
  if (!confirm('Wipe ALL backend member records and banned usernames?\n\nThis fixes the "Username already taken" bug for everyone.')) return;
  try {
    const result = await _apiCall('/api/admin/wipe-all-members', 'DELETE', undefined, 30000, 1);
    if (result._offline) { showToast('Server offline. Try again later.', 'error'); return; }
    if (result.success) {
      showToast(`✅ Wiped ${result.deletedCount} leftover record(s). Members can register now!`, 'success');
      DB.addNotif('admin', `Admin wiped ${result.deletedCount} stuck backend member records`);
    } else {
      showToast('Error: ' + (result.error || 'Unknown'), 'error');
    }
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  }
}

async function admDeleteEverything() {
  if (!confirm('☠️ DELETE EVERYTHING ☠️\n\nThis PERMANENTLY deletes ALL members, accounts, HP, streams, missions, tracks, albums, evidence, reports, helpline tickets, games, cards, notifications, and activity logs.\n\nThe site will become a brand new empty website. Members must Join ARMY again.\n\nThis CANNOT be undone.\n\nContinue?')) return;
  if (!confirm('FINAL WARNING: Type-confirm — delete EVERY user and ALL data permanently?')) return;
  const typed = prompt('Type DELETE to confirm permanent deletion of everything:');
  if (typed !== 'DELETE') { showToast('Cancelled — confirmation text did not match.', 'info'); return; }

  const db = FSB._db();
  if (!db) { showToast('Firebase not connected.', 'error'); return; }

  showToast('Deleting everything... please wait', 'info');

  const collectionsToFullyDelete = [
    'members', 'syncData', 'streamSync', 'hpTransactions', 'notifications',
    'dailyGameCompletions', 'streamSyncLogs', 'memberTrackProgress',
    'memberAlbumProgress', 'memberMissionProgress', 'evidence', 'reports',
    'helplineTickets', 'bannedUsernames'
  ];

  for (const colName of collectionsToFullyDelete) {
    try {
      let snap = await db.collection(colName).limit(450).get();
      while (!snap.empty) {
        const batch = db.batch();
        snap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
        snap = await db.collection(colName).limit(450).get();
      }
    } catch(e) { console.warn(`[ZClock] Error wiping ${colName}:`, e.message); }
  }

  // Reset settings docs
  await db.collection('settings').doc('weeklyReset').set({ lastReset: null }).catch(()=>{});
  await db.collection('settings').doc('voting').set({ active: false, link: '' }).catch(()=>{});

  // Clear all localStorage
  try { localStorage.clear(); } catch(e) {}
  try { sessionStorage.clear(); } catch(e) {}

  showToast('☠️ Everything deleted. Site is now brand new.', 'success');
  setTimeout(() => { window.location.href = 'login.html'; }, 2000);
}
function admResetVoting(){if(!confirm('Reset voting?'))return;LS.set('zc_voting_active',false);LS.set('zc_voting_link','');showToast('Voting reset!','success');loadAdminPanel();}
function admResetAttendance(){if(!confirm('Reset all attendance?'))return;DB.getMembers().forEach(m=>{LS.del('zc_att_'+m.username);});showToast('Attendance reset!','success');loadAdminPanel();}

/* Image preview helper for file uploads */
function previewCardImg(inputId, previewContainerId) {
  const file = document.getElementById(inputId)?.files?.[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const container = document.getElementById(previewContainerId);
    const imgEl = document.getElementById(previewContainerId + '-img');
    if (container) container.style.display = 'block';
    if (imgEl) imgEl.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

/* Load admin sync view from backend */
async function loadAdminSyncView() {
  const el = document.getElementById('admin-sync-content'); if (!el) return;
  el.innerHTML = '<div class="text-muted">Loading from backend…</div>';
  const result = await backendCall('/api/all-sync-status', 'GET');
  if (!result || result.success === false) {
    el.innerHTML = `<div class="card p-12"><div style="color:var(--pink)">⚠️ Server offline — showing cached data.</div></div>`;
    return;
  }
  const members = DB.getMembers();
  const backendData = result.members || {};
  el.innerHTML = `<div class="text-muted mb-8" style="font-size:0.78rem">Live data from backend — ${Object.keys(backendData).length} member(s) synced</div>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Member</th><th>Team</th><th>Last.fm</th><th>New Streams</th><th>HP Earned</th><th>Pending</th><th>Status</th><th>Last Sync</th></tr></thead>
      <tbody>${members.map(m=>{
    const bd=backendData[m.username]?.lastfm||{};
    return`<tr><td><strong>${escHtml(m.username)}</strong></td><td>${escHtml(m.team||'—')}</td><td style="font-size:0.72rem">${escHtml(bd.username||'—')}</td><td>${formatNum(bd.lastNewStreams||0)}</td><td class="text-gold">${formatNum(bd.earnedHP||0)}</td><td>${bd.pending||0}</td><td><span class="badge ${bd.status?.includes('HP added')||bd.status?.includes('First sync')?'badge-green':'badge-accent'}" style="font-size:0.62rem">${escHtml(bd.status||'Not synced')}</span></td><td style="font-size:0.72rem">${bd.lastSync?new Date(bd.lastSync).toLocaleString():'Never'}</td></tr>`;
  }).join('')}</tbody>
    </table></div>`;
}

/* Member detail HTML */
function getMemberDetailHTML(username) {
  const m = DB.getMember(username); if (!m) return emptyState('👤','Not found.');
  const r = getSyncResult(username);
  const att = LS.get(`zc_att_${m.username}`,{});
  const myEv = DB.getEvidence().filter(e=>e.user===m.username);
  const myReps = DB.getReports().filter(r=>r.user===m.username);
  const battles = DB.getBattles().filter(b=>b.challenger===m.username||b.opponent===m.username);
  const wins = battles.filter(b=>b.winner===m.username).length;
  const losses = battles.filter(b=>b.loser===m.username).length;
  return `
    <div class="glass-card p-16 mb-10" style="border-color:var(--accent-1)">
      <div class="flex-between mb-8"><span style="font-family:var(--font-display);font-size:1rem;color:var(--accent-1)">${escHtml(m.username)}</span><span class="badge badge-accent">${escHtml(m.team||'—')}</span></div>
      <div class="grid-2" style="gap:8px;font-size:0.82rem">
        <div><span class="text-muted">Current HP</span> <span class="text-gold">${formatNum(m.hp||0)}</span></div>
        <div><span class="text-muted">Total HP</span> <span>${formatNum(m.totalHp||0)}</span></div>
        <div><span class="text-muted">Streams</span> <span>${formatNum(m.streams||0)}</span></div>
        <div><span class="text-muted">HP from streams</span> <span>${formatNum(m.hpStreaming||0)}</span></div>
        <div><span class="text-muted">Missions</span> <span>${(m.completedMissions||[]).length}</span></div>
        <div><span class="text-muted">Games</span> <span>${(m.completedGames||[]).join(', ')||'None'}</span></div>
        <div><span class="text-muted">Attendance</span> <span>${Object.keys(att).filter(k=>!k.startsWith('day')).length} days</span></div>
        <div><span class="text-muted">Battles</span> <span>W:${wins} L:${losses}</span></div>
        <div><span class="text-muted">Evidence</span> <span>${myEv.length} total / ${myEv.filter(e=>e.status==='Approved').length} approved</span></div>
        <div><span class="text-muted">Reports</span> <span>${myReps.length}</span></div>
        <div><span class="text-muted">Joined</span> <span style="font-size:0.78rem">${m.joinedAt?new Date(m.joinedAt).toLocaleDateString():'—'}</span></div>
        <div><span class="text-muted">Last Active</span> <span style="font-size:0.78rem">${m.lastActive?new Date(m.lastActive).toLocaleString():'Never'}</span></div>
      </div>
    </div>
    <div class="card p-12 mb-8">
      <div class="section-title" style="font-size:0.65rem">🔄 Sync Status</div>
      <div style="font-size:0.8rem">Last.fm: <span class="badge ${r?.platforms?.lastfm?.success?'badge-green':'badge-accent'}" style="font-size:0.65rem">${escHtml(r?.platforms?.lastfm?.status||'Not synced')}</span></div>
      ${r?.platforms?.lastfm?.message?`<div class="text-muted mt-4" style="font-size:0.76rem">${escHtml(r.platforms.lastfm.message)}</div>`:''}
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-gold btn-sm" onclick="admAddHP('${m.username}')">+ Add HP</button>
      <button class="btn btn-danger btn-sm" onclick="admDelMember('${m.username}')">Delete Member</button>
    </div>`;
}
function showMemberDetail(username) {
  const sel = document.getElementById('md-select'); if(sel) sel.value = username;
  const content = document.getElementById('member-detail-content'); if(content) content.innerHTML = getMemberDetailHTML(username);
}

/* Admin helpers */
function swAdm(btn,id){document.querySelectorAll('.admin-tab').forEach(t=>t.classList.remove('active'));document.querySelectorAll('.admin-panel').forEach(p=>p.classList.remove('active'));btn.classList.add('active');document.getElementById(id)?.classList.add('active');}
function markAllRead(){
  const n=DB.getNotifs();
  n.forEach(x=>x.read=true);
  LS.set('zc_notifications_cache',n);
  updateNotifBadge();
  // Mark all read in Firebase
  const db=FSB._db();
  if(db){
    db.collection('notifications').where('read','==',false).limit(500).get().then(snap=>{
      if(snap.empty) return;
      const batch=db.batch();
      snap.docs.forEach(d=>batch.update(d.ref,{read:true}));
      return batch.commit();
    }).catch(()=>{});
  }
  loadAdminPanel();
}
function admAddHP(u){const a=Math.min(20,parseInt(prompt(`Add HP to ${u} (max 20):`)||0));if(!a||a<1)return;const m=DB.getMembers();const i=m.findIndex(x=>x.username===u);if(i>-1){m[i].hp=(m[i].hp||0)+a;m[i].totalHp=(m[i].totalHp||0)+a;DB.saveMembers(m);showToast(`+${a} HP to ${u}`,'success');DB.addNotif('hp',`Admin awarded +${a} HP to ${u}`);loadAdminPanel();}}
function admDelMember(u){
  if(!confirm(`Delete member "${u}"? This cannot be undone.`))return;
  const members=DB.getMembers();
  const m=members.find(x=>x.username===u);
  const db=FSB._db();
  // Delete from Firestore by uid
  if(m&&m.uid){
    FSB.deleteMember(m.uid).catch(()=>{});
  }
  // Also search by username (catches old docs without uid)
  if(db){
    db.collection('members').where('username','==',u).get().then(snap=>{
      snap.docs.forEach(d=>d.ref.delete());
    }).catch(()=>{});
  }
  // Remove from local cache immediately
  if(_memberCache){
    Object.keys(_memberCache).forEach(k=>{
      if(_memberCache[k].username===u) delete _memberCache[k];
    });
  }
  // Remove from backend if connected
  _apiCall(`/api/member/${encodeURIComponent(u)}`,'DELETE').catch(()=>{});

  showToast(`${u} deleted.`,'success');
  DB.addNotif('admin','Admin deleted member: '+u);
  setTimeout(()=>loadAdminPanel(), 500); // Small delay so Firebase delete completes
}
function admReviewEvBtn(btn){
  var eid=btn.dataset.eid||btn.getAttribute('data-eid');
  var action=btn.dataset.act||btn.getAttribute('data-act')||btn.getAttribute('data-action');
  admReviewEv(eid,action);
}
function admReviewEv(id,status){
  const all=DB.getEvidence();
  const ev=all.find(e=>String(e.id)===String(id));if(!ev)return;
  ev.status=status;ev.reviewedAt=new Date().toISOString();ev.reviewedBy='admin';
  const hpEl=document.getElementById('ev-hp-'+id);
  const hpAmt=hpEl?parseInt(hpEl.value)||HP.EVIDENCE:HP.EVIDENCE;
  if(status==='Approved'){
    ev.hpAwarded=hpAmt;
    // Award HP to member in localStorage
    const m=DB.getMembers();const i=m.findIndex(x=>x.username===(ev.username||ev.user));
    if(i>-1){m[i].hp=(m[i].hp||0)+hpAmt;m[i].totalHp=(m[i].totalHp||0)+hpAmt;DB.saveMembers(m);}
    // Award HP to member in Firebase
    const db=FSB._db();
    if(db&&ev.memberUid){
      db.collection('members').doc(ev.memberUid).get().then(doc=>{
        if(doc.exists){const cur=doc.data();return db.collection('members').doc(ev.memberUid).update({hp:(cur.hp||0)+hpAmt,totalHp:(cur.totalHp||0)+hpAmt});}
      }).catch(()=>{});
    }
    DB.addNotif('evidence',(ev.username||ev.user)+' evidence approved +'+hpAmt+' HP');
    showToast('Approved! +'+hpAmt+' HP awarded. ✅','success');
  } else {
    DB.addNotif('evidence',(ev.username||ev.user)+' evidence rejected');
    showToast('Evidence rejected.','info');
  }
  DB.saveEvidence(all);
  // Update Firebase evidence doc
  const db2=FSB._db();
  if(db2){db2.collection('evidence').doc(String(id)).update({status,reviewedAt:ev.reviewedAt,reviewedBy:'admin'}).catch(()=>{});}
  loadAdminPanel();
}
function admResolveReport(id){
  const inp=document.getElementById('rr-'+id);
  const resp=inp?inp.value.trim():'Resolved by admin.';
  const all=DB.getReports();
  const r=all.find(x=>String(x.id)===String(id));if(!r)return;
  r.status='Resolved';r.response=resp;r.resolvedAt=new Date().toISOString();
  DB.saveReports(all);
  // Update Firebase reports doc
  const db=FSB._db();
  if(db){db.collection('reports').doc(String(id)).update({status:'Resolved',response:resp,resolvedAt:r.resolvedAt}).catch(()=>{});}
  DB.addNotif('report',(r.username||r.user)+' report resolved');
  showToast('Report resolved. ✅','success');loadAdminPanel();
}
function admSendNotice(){const tu=document.getElementById('nt-user')?.value;const type=document.getElementById('nt-type')?.value;const title=document.getElementById('nt-title')?.value.trim();const desc=document.getElementById('nt-body')?.value.trim();if(!title||!desc)return showToast('Fill all.','warn');const all=DB.getReports();all.push({id:Date.now(),targetUser:tu,fromAdmin:true,noticeType:type,title,desc,ts:Date.now()});DB.saveReports(all);showToast(`Notice sent to ${tu}!`,'success');DB.addNotif('report',`Admin sent ${type} to ${tu}: ${title}`);}
/* ── Real Firebase save for each content item ── */
async function _fbSaveDoc(collection, docId, data) {
  const db = FSB._db();
  if (!db) { showToast('⚠️ Firebase not connected.', 'warn'); return; }
  try {
    await db.collection(collection).doc(String(docId)).set({
      ...data,
      _savedAt: new Date().toISOString(),
      _savedBy: 'admin'
    });
    console.log('[ZClock] ✅ Firebase save:', collection, '/', docId);
    showToast('✅ Saved to Firebase — ' + collection + ' / ' + docId, 'success');
  } catch(e) {
    console.error('[ZClock] Firebase save error:', e.message);
    showToast('⚠️ Firebase save failed: ' + e.message, 'error');
  }
}

async function _fbDeleteDoc(collection, docId) {
  const db = FSB._db();
  if (!db) return;
  try {
    await db.collection(collection).doc(String(docId)).delete();
  } catch(e) { console.warn('[ZClock] Firebase delete:', e.message); }
}

// Legacy alias kept for compatibility
function _fbSaveConfirm(col, id) {
  showToast('✅ Saved — ' + col + ' / ' + id, 'success');
}

function admAddMission(){
  const t=document.getElementById('am-title')?.value.trim();if(!t)return showToast('Enter title.','warn');
  const id='m'+Date.now();
  const doc={id,title:t,type:document.getElementById('am-type')?.value,target:parseInt(document.getElementById('am-target')?.value)||10,unit:document.getElementById('am-unit')?.value||'streams',hp:Math.min(20,parseInt(document.getElementById('am-hp')?.value)||5),deadline:document.getElementById('am-dl')?.value||'',status:'active',createdAt:new Date().toISOString(),createdBy:'admin',active:true};
  const m=DB.getMissions(); m.push(doc); DB.saveMissions(m);
  _fbSaveDoc('missions', id, doc);
  DB.addNotif('mission','Admin added mission: '+t);
  loadAdminPanel();
}
function admDelMission(id){
  DB.saveMissions(DB.getMissions().filter(m=>m.id!==id));
  _fbDeleteDoc('missions', id);
  showToast('Mission deleted.','success');loadAdminPanel();
}

function admAddTrack(){
  const t=document.getElementById('at-title')?.value.trim();if(!t)return showToast('Enter title.','warn');
  const id='tr'+Date.now();
  const doc={id,title:t,artist:document.getElementById('at-artist')?.value||'BTS',goal:parseInt(document.getElementById('at-goal')?.value)||100,hp:Math.min(20,parseInt(document.getElementById('at-hp')?.value)||2),active:true,createdAt:new Date().toISOString(),uploadedBy:'admin'};
  const tr=DB.getTracks(); tr.push(doc); DB.saveTracks(tr);
  _fbSaveDoc('tracks', id, doc);
  DB.addNotif('system','Admin added track: '+t);
  loadAdminPanel();
}
function admDelTrack(id){
  DB.saveTracks(DB.getTracks().filter(t=>t.id!==id));
  _fbDeleteDoc('tracks', id);
  showToast('Track deleted.','success');loadAdminPanel();
}

function admAddAlbum(){
  const n=document.getElementById('aal-name')?.value.trim();if(!n)return showToast('Enter name.','warn');
  const id='al'+Date.now();
  const doc={id,name:n,year:document.getElementById('aal-year')?.value||'',emoji:document.getElementById('aal-emoji')?.value||'💿',goal:parseInt(document.getElementById('aal-goal')?.value)||500,active:true,createdAt:new Date().toISOString(),uploadedBy:'admin'};
  const a=DB.getAlbums(); a.push(doc); DB.saveAlbums(a);
  _fbSaveDoc('albums', id, doc);
  loadAdminPanel();
}
function admDelAlbum(id){
  DB.saveAlbums(DB.getAlbums().filter(a=>a.id!==id));
  _fbDeleteDoc('albums', id);
  loadAdminPanel();
}

/* Battle card with image upload */
function admAddCard(){
  const name=document.getElementById('ac-name')?.value.trim();if(!name)return showToast('Enter card name.','warn');
  const rarity=document.getElementById('ac-rarity')?.value||'common';
  const hpRequired=parseInt(document.getElementById('ac-hp')?.value)||0;
  const attack=parseInt(document.getElementById('ac-atk')?.value)||50;
  const defense=parseInt(document.getElementById('ac-def')?.value)||50;
  const file=document.getElementById('ac-img')?.files?.[0];
  const doSave=(imageData)=>{
    const id='c'+Date.now();
    const doc={id,name,rarity,hpRequired,attack,defense,imageData:imageData||'',createdAt:new Date().toISOString(),uploadedBy:'admin'};
    const c=DB.getCards(); c.push(doc); DB.saveCards(c);
    // Save to Firebase bbcCards collection
    const docNoImg={...doc}; delete docNoImg.imageData; // Don't store base64 in Firestore (too large)
    _fbSaveDoc('bbcCards', id, {...docNoImg, hasImage:!!imageData});
    // Also update content collection for realtime delivery
    DB.saveCards(c); // triggers content/battleCards update
    showToast('BBC Card uploaded! 🃏','success');
    loadAdminPanel();
  };
  if(file){const rd=new FileReader();rd.onload=e=>doSave(e.target.result);rd.readAsDataURL(file);}
  else doSave('');
}
function admDelCard(id){
  DB.saveCards(DB.getCards().filter(c=>String(c.id)!==String(id)));
  _fbDeleteDoc('bbcCards', id);
  loadAdminPanel();
}

/* Picture card with image upload */
function admAddPictureCard(){
  const name=document.getElementById('pc-name')?.value.trim();if(!name)return showToast('Enter card name.','warn');
  const cat=document.getElementById('pc-cat')?.value||'';
  const source=document.getElementById('pc-source')?.value||'';
  const desc=document.getElementById('pc-desc')?.value||'';
  const file=document.getElementById('pc-img')?.files?.[0];
  const doSave=(imageData)=>{
    const id='pc'+Date.now();
    const doc={id,name,category:cat,source,desc,imageData:imageData||'',ts:Date.now(),createdAt:new Date().toISOString(),uploadedBy:'admin'};
    const cards=DB.getPicCards(); cards.push(doc); DB.savePicCards(cards);
    _fbSaveDoc('pictureCards', id, {...doc, hasImage:!!imageData});
    showToast('Picture Card uploaded! 🖼️','success');
    loadAdminPanel();
  };
  if(file){const rd=new FileReader();rd.onload=e=>doSave(e.target.result);rd.readAsDataURL(file);}
  else doSave('');
}
function admDelPictureCard(id){
  DB.savePicCards(DB.getPicCards().filter(c=>String(c.id)!==String(id)));
  _fbDeleteDoc('pictureCards', id);
  loadAdminPanel();
}

/* Card Mission management */
function admAddCardMission(){
  const title=document.getElementById('cm-title')?.value.trim();if(!title)return showToast('Enter mission title.','warn');
  const rewardCardId=document.getElementById('cm-card')?.value;
  const description=document.getElementById('cm-desc')?.value.trim();
  const task=document.getElementById('cm-task')?.value.trim();
  const hpReward=parseInt(document.getElementById('cm-hp')?.value)||0;
  const deadline=document.getElementById('cm-dl')?.value||'';
  const missions=DB.getCardMissions();
  missions.unshift({id:'cm'+Date.now(),title,description,task,rewardCardId,hpReward,deadline,active:true,createdAt:new Date().toISOString()});
  DB.saveCardMissions(missions);
  showToast('Card Mission created! 📋','success');
  DB.addNotif('cards','Admin created card mission: '+title);
  loadAdminPanel();
}
function admToggleCardMissionBtn(btn){
  const id=btn.dataset.cmid;const missions=DB.getCardMissions();
  const m=missions.find(x=>String(x.id)===String(id));if(!m)return;
  m.active=m.active===false?true:false;
  DB.saveCardMissions(missions);loadAdminPanel();
}
function admDelCardMissionBtn(btn){
  const id=btn.dataset.cmid;
  DB.saveCardMissions(DB.getCardMissions().filter(m=>String(m.id)!==String(id)));
  loadAdminPanel();
}

/* J-Hope with image upload (NO URL field) */
function admAddJHopeQuestion(){
  const song=document.getElementById('jh-song')?.value.trim();if(!song)return showToast('Enter song name.','warn');
  const hint=document.getElementById('jh-hint')?.value.trim()||'';
  const hp=Math.min(20,parseInt(document.getElementById('jh-hp')?.value)||6);
  const attempts=parseInt(document.getElementById('jh-attempts')?.value)||3;
  const file=document.getElementById('jh-img')?.files?.[0];
  const doSave=(imageData)=>{
    const id='jh'+Date.now();
    const doc={id,song,hint,hp,attempts,imageData:imageData||'',createdAt:new Date().toISOString()};
    const qs=DB.getJHopeQuestions(); qs.push(doc); DB.saveJHopeQuestions(qs);
    _fbSaveDoc('jhopeTimeQuestions', id, {...doc,hasImage:!!imageData});
    showToast('J-Hope question added!','success');loadAdminPanel();
  };
  if(file){const rd=new FileReader();rd.onload=e=>doSave(e.target.result);rd.readAsDataURL(file);}
  else doSave('');
}
function admDelJHopeQuestion(id){DB.saveJHopeQuestions(DB.getJHopeQuestions().filter(q=>q.id!==id));loadAdminPanel();}

/* Spec 47 helpers */
/* old duplicate builders removed — using _admCPR, _admDLD, _admJHope instead */
function admAddCPRQuestion(){
  const q=document.getElementById('cpr-q')?.value.trim();
  const a=document.getElementById('cpr-a')?.value.trim();
  const b=document.getElementById('cpr-b')?.value.trim();
  const c=document.getElementById('cpr-c')?.value.trim();
  const d=document.getElementById('cpr-d')?.value.trim();
  if(!q||!a||!b||!c||!d)return showToast('Fill all fields.','warn');
  const id='cpr'+Date.now();
  const doc={id,q,opts:[a,b,c,d],ans:parseInt(document.getElementById('cpr-ans')?.value)||0,hp:Math.min(20,parseInt(document.getElementById('cpr-hp')?.value)||5),time:parseInt(document.getElementById('cpr-time')?.value)||10,createdAt:new Date().toISOString()};
  const qs=DB.getCPRQuestions(); qs.push(doc); DB.saveCPRQuestions(qs);
  _fbSaveDoc('purpleCprQuestions', id, doc);
  showToast('Question added!','success');loadAdminPanel();
}
function admDelCPRQuestion(id){DB.saveCPRQuestions(DB.getCPRQuestions().filter(q=>q.id!==id));loadAdminPanel();}
function admAddDLDQuestion(){
  const lyric=document.getElementById('dld-lyric')?.value.trim();
  const song=document.getElementById('dld-song')?.value.trim();
  if(!lyric||!song)return showToast('Fill lyric and song.','warn');
  const id='dld'+Date.now();
  const doc={id,lyric,song,hint:document.getElementById('dld-hint')?.value||'',hp:Math.min(20,parseInt(document.getElementById('dld-hp')?.value)||5),createdAt:new Date().toISOString()};
  const qs=DB.getDLDQuestions(); qs.push(doc); DB.saveDLDQuestions(qs);
  _fbSaveDoc('dldQuestions', id, doc);
  showToast('Lyric added!','success');loadAdminPanel();
}
function admDelDLDQuestion(id){DB.saveDLDQuestions(DB.getDLDQuestions().filter(q=>q.id!==id));loadAdminPanel();}
function admSetVoting(a){LS.set('zc_voting_active',a);showToast(a?'Voting activated!':'Voting closed.',a?'success':'info');loadAdminPanel();}
function admSaveVoteLink(){LS.set('zc_voting_link',document.getElementById('adm-vl')?.value||'');showToast('Saved!','success');}
function admResetGame(){const u=document.getElementById('gr-user')?.value;const g=document.getElementById('gr-game')?.value;const m=DB.getMembers();const i=m.findIndex(x=>x.username===u);if(i<0)return showToast('Not found.','error');if(g==='all')m[i].completedGames=[];else m[i].completedGames=(m[i].completedGames||[]).filter(x=>x!==g);DB.saveMembers(m);showToast(`Reset ${g} for ${u}!`,'success');DB.addNotif('game',`Admin reset game for ${u}`);}
function admPostAnn(){
  const title=document.getElementById('ann-title')?.value.trim();
  const body=document.getElementById('ann-body')?.value.trim();
  if(!title||!body)return showToast('Enter title and message.','warn');
  const id=Date.now();
  const doc={id,title,body,ts:id,createdAt:new Date().toISOString(),createdBy:'admin',active:true};
  const anns=DB.getAnns(); anns.unshift(doc); DB.saveAnns(anns);
  _fbSaveDoc('announcements', String(id), doc);
  DB.addNotif('system','Admin posted: '+title);
  showToast('Announcement posted! 📢','success');
  loadAdminPanel();
}
function admDelAnn(id){DB.saveAnns(DB.getAnns().filter(a=>a.id!==id));loadAdminPanel();}


/* ════════════════════════════════════════════════════════════
   SPEC 51 + 52: ENHANCED ADMIN PANEL SECTIONS
   ════════════════════════════════════════════════════════════ */

/* Load live member list from server for admin (spec 51) */
function buildLocalMembersTable(rawMembers){
  // Extra safety dedup by username — keep most recently active
  const seen2 = new Map();
  rawMembers.forEach(m => {
    const ex = seen2.get(m.username);
    if(!ex || (m.lastActive||'') > (ex.lastActive||'')) seen2.set(m.username, m);
  });
  const members = Array.from(seen2.values());

  if(!members.length) return emptyState('👥','No members yet. Members will appear here after they join and log in.');
  return`<div class="table-wrap"><table class="data-table">
    <thead><tr><th>Username</th><th>Team</th><th>HP</th><th>Total HP</th><th>Streams</th><th>Missions</th><th>Last Active</th><th>Actions</th></tr></thead>
    <tbody>${members.map(m=>`<tr>
      <td><strong>${escHtml(m.username)}</strong></td>
      <td><span class="badge badge-accent" style="font-size:0.65rem">${escHtml(m.team||'—')}</span></td>
      <td class="text-gold">${formatNum(m.hp||0)}</td>
      <td>${formatNum(m.totalHp||0)}</td>
      <td>${formatNum(m.streams||0)}</td>
      <td>${(m.completedMissions||[]).length}</td>
      <td style="font-size:0.72rem">${m.lastActive?new Date(m.lastActive).toLocaleString():'Never'}</td>
      <td><button class="btn btn-gold btn-xs" onclick="admAddHP('${m.username}')">+HP</button> <button class="btn btn-secondary btn-xs" onclick="showMemberDetail('${m.username}')">View</button> <button class="btn btn-danger btn-xs" onclick="admDelMember('${m.username}')">Del</button></td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

async function loadAllMembersAdmin(){
  const el=document.getElementById('admin-members-content');
  if(!el)return;
  el.innerHTML='<div class="text-muted p-12">Loading from Firebase…</div>';
  const result=await _apiCall('/api/members','GET');
  if(result._offline||!result.members){
    const local=DB.getMembers();
    el.innerHTML='<div class="glass-card p-12 mb-12" style="border-color:var(--gold)"><div style="font-size:0.82rem;color:var(--accent-2);margin-bottom:8px">⚠️ Backend offline — showing local members ('+local.length+'). Backend must be running to see members from other devices.</div></div>'+buildLocalMembersTable(local);
    return;
  }
  const all=Object.values(result.members).filter(m=>m.username&&m.username!=='__admin__');
  all.forEach(m=>{const existing=DB.getMember(m.username);if(!existing)DB.saveMember(m);});
  if(!all.length){
    // Firebase empty — show local members and offer to push them
    const local=DB.getMembers();
    el.innerHTML='<div class="glass-card p-12 mb-12" style="border-color:var(--accent-1)"><div style="font-size:0.82rem;color:var(--accent-2);margin-bottom:10px">Firebase is empty. Push your existing local members to Firebase so admin can see them from any device.</div><button class="btn btn-primary btn-sm" onclick="pushAllLocalMembersToFirebase()">⬆️ Push All Local Members to Firebase ('+local.length+')</button><div id="push-status" class="mt-8" style="font-size:0.78rem;color:var(--white-muted)"></div></div>'+buildLocalMembersTable(local);
    return;
  }
  el.innerHTML='<div class="text-muted mb-8" style="font-size:0.78rem">✅ Live from Firebase — '+all.length+' member(s)</div>'+buildLocalMembersTable(all);
}

async function pushAllLocalMembersToFirebase(){
  const statusEl=document.getElementById('push-status');
  const local=DB.getMembers();
  if(!local.length){if(statusEl)statusEl.textContent='No local members to push.';return;}
  if(statusEl)statusEl.textContent='Pushing '+local.length+' member(s) to Firebase…';
  let pushed=0;
  for(const m of local){
    if(m.username==='__admin__')continue;
    const r=await _apiCall('/api/register','POST',m);
    // If already exists, update instead
    if(!r.success&&r.error==='Username already taken'){
      await _apiCall(`/api/member/${encodeURIComponent(m.username)}`,'POST',m);
    }
    pushed++;
    if(statusEl)statusEl.textContent='Pushed '+pushed+'/'+local.length+'…';
  }
  if(statusEl)statusEl.innerHTML='<span style="color:var(--accent-1)">✅ Done! Pushed '+pushed+' member(s) to Firebase.</span>';
  setTimeout(()=>loadAllMembersAdmin(),2000);
}

async function loadAdminMembersFromServer() {
  const el = document.getElementById('admin-members-table'); if (!el) return;
  el.innerHTML = '<div class="text-muted">Loading from server…</div>';
  const result = await _apiCall('/api/members', 'GET');
  if (result._offline) { el.innerHTML = '<div class="text-muted">Could not reach server — showing local data.</div>'; return; }
  const all = result.members || {};
  const rows = Object.values(all).sort((a,b) => (b.hp||0) - (a.hp||0));
  el.innerHTML = `<div class="text-muted mb-8" style="font-size:0.78rem">Live data from server — ${rows.length} member(s)</div>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Username</th><th>Team</th><th>HP</th><th>Total HP</th><th>Streams</th><th>Last Active</th></tr></thead>
      <tbody>${rows.map(m=>`<tr><td><strong>${escHtml(m.username)}</strong></td><td>${escHtml(m.team||'—')}</td><td class="text-gold">${formatNum(m.hp||0)}</td><td>${formatNum(m.totalHp||0)}</td><td>${formatNum(m.streams||0)}</td><td style="font-size:0.72rem">${m.lastActive?new Date(m.lastActive).toLocaleString():'Never'}</td></tr>`).join('')}</tbody>
    </table></div>`;
}

/* Load admin sync view from server */
async function loadAdminSyncView() {
  const el = document.getElementById('admin-sync-content'); if (!el) return;
  el.innerHTML = '<div class="text-muted">Loading from server…</div>';
  const result = await _apiCall('/api/all-sync-status', 'GET');
  if (result._offline) { el.innerHTML = '<div class="text-muted" style="color:var(--pink)">Server offline — showing cached data.</div>'; return; }
  const allSync = result.members || {};
  const members = DB.getMembers();
  el.innerHTML = `<div class="text-muted mb-8" style="font-size:0.78rem">Live sync data from server. Firebase: ${result.firebase?'✅ Connected':'⚠️ Using local storage'}</div>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Member</th><th>Team</th><th>Last.fm</th><th>Streams</th><th>HP Earned</th><th>Pending</th><th>Status</th><th>Last Sync</th></tr></thead>
      <tbody>${members.map(m=>{
        const sd=allSync[m.username]?.lastfm||{};
        return`<tr><td><strong>${escHtml(m.username)}</strong></td><td>${escHtml(m.team||'—')}</td><td style="font-size:0.72rem">${escHtml(sd.username||'—')}</td><td>${formatNum(m.streams||0)}</td><td class="text-gold">${formatNum(m.hpStreaming||0)}</td><td>${sd.pending||0}</td><td><span class="badge ${sd.status==='HP added successfully'||sd.status==='Connected'?'badge-green':'badge-accent'}" style="font-size:0.62rem">${escHtml(sd.status||'Not synced')}</span></td><td style="font-size:0.72rem">${sd.lastSync?new Date(sd.lastSync).toLocaleString():'Never'}</td></tr>`;
      }).join('')}</tbody>
    </table></div>`;
}

/* System status section — ADMIN ONLY (spec 52) */
async function loadSystemStatus() {
  const el = document.getElementById('admin-system-status'); if (!el) return;
  el.innerHTML = '<div class="text-muted">Checking backend…</div>';
  const r = await _apiCall('/api/system-status', 'GET');
  if (r._offline) {
    el.innerHTML = `<div class="glass-card p-14"><div class="flex-between mb-8"><span class="text-muted">Backend Server</span><span class="badge badge-red">⚫ Offline</span></div><div class="flex-between mb-8"><span class="text-muted">Database</span><span class="badge badge-red">Disconnected</span></div><div class="text-muted mt-8" style="font-size:0.78rem">Start server.js to enable multi-device monitoring.<br><code>node server.js</code></div></div>`;
    return;
  }
  el.innerHTML = `<div class="glass-card p-14">
    <div class="flex-between mb-8"><span class="text-muted">Backend Server</span><span class="badge badge-green">🟢 Online</span></div>
    <div class="flex-between mb-8"><span class="text-muted">Database</span><span class="badge ${r.firebase?'badge-green':'badge-gold'}">${r.firebase?'🔥 Firebase Connected':'📁 Local Storage'}</span></div>
    <div class="flex-between mb-8"><span class="text-muted">Storage Mode</span><span style="font-size:0.78rem">${escHtml(r.storage||'—')}</span></div>
    <div class="flex-between"><span class="text-muted">Server Time</span><span style="font-size:0.78rem">${new Date(r.time).toLocaleString()}</span></div>
    ${!r.firebase?`<div class="glass-card p-12 mt-10" style="border-color:var(--gold)"><div style="font-size:0.78rem;color:var(--accent-2)">⚠️ <strong>Firebase not connected.</strong><br>Members on different devices cannot see each other.<br>Add <code>firebase-credentials.json</code> to enable real-time multi-device sync.</div></div>`:''}
  </div>`;
}

/* Load admin notifications from server */
async function loadAdminNotifsFromServer() {
  const el = document.getElementById('adm-activity-content'); if (!el) return;
  const result = await _apiCall('/api/notifications?limit=100', 'GET');
  if (result._offline || !result.notifications) return; // Keep local notifs shown
  const notifs = result.notifications;
  el.innerHTML = notifs.map(n=>`<div class="notif-item"><div class="notif-icon">${{'hp':'💜','stream':'🎵','mission':'🎯','evidence':'📎','report':'📋','vote':'🗳️','attendance':'📅','profile':'👤','game':'🎮','playlist':'🎶','helpline':'🆘','battle':'⚔️','milestone':'🏆','join':'🌟','system':'⚙️','sync':'🔄'}[n.type]||'🔔'}</div><div class="notif-body">${escHtml(n.text)}<div class="notif-time">${new Date(n.time).toLocaleString()}</div></div></div>`).join('') || emptyState('🔔','No activity.');
}


/* ── Missing admin helper functions ── */
function admApplyThemeBtn(btn){applyTheme(btn.dataset.theme);loadAdminPanel();showToast('Theme applied!','success');}
function admResetWeeklyHP(){if(!confirm('Reset ALL members weekly HP to 0?'))return;const m=DB.getMembers();m.forEach(x=>{x.hp=0;x.weeklyHp=0;x.weeklyStreams=0;x.votesToday=0;});DB.saveMembers(m);showToast('Weekly HP reset!','success');DB.addNotif('system','Admin reset weekly HP for all members');}
function admResetVoting(){if(!confirm('Reset voting?'))return;LS.set('zc_voting_active',false);LS.set('zc_voting_link','');showToast('Voting reset!','success');}
function admResetAttendance(){if(!confirm('Reset attendance for all members?'))return;const m=DB.getMembers();m.forEach(x=>{x.attendanceHistory=[];});DB.saveMembers(m);showToast('Attendance reset!','success');}
function admDelCPRBtn(btn){admDelCPRQuestion(btn.dataset.qid);}
function admDelDLDBtn(btn){admDelDLDQuestion(btn.dataset.qid);}
function admDelJHopeBtn(btn){admDelJHopeQuestion(btn.dataset.qid);}
function admDelAnnBtn(btn){admDelAnn(parseInt(btn.dataset.aid));}
/* ─── UTILITIES ─── */
function setText(id,v){const e=document.getElementById(id);if(e)e.textContent=v;}
function escHtml(s){if(!s)return'';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function formatNum(n){return Number(n||0).toLocaleString();}
function formatTime(ts){const d=new Date(ts);return d.getHours()+':'+String(d.getMinutes()).padStart(2,'0');}
function emptyState(icon,text){return`<div class="empty-state"><div class="es-icon">${icon}</div><div class="es-text">${text}</div></div>`;}
function closeModal(id){document.getElementById(id)?.classList.remove('show');}

/* ── Load all content from Firebase dedicated collections ── */
let _contentListeners = [];

/* Map: Firestore collection → localStorage key → refresh function */
const CONTENT_MAP = [
  {col:'missions',            ls:'zc_missions',            fn:'loadMissions'},
  {col:'tracks',              ls:'zc_tracks',              fn:'loadTracks'},
  {col:'albums',              ls:'zc_albums',              fn:'loadAlbums'},
  {col:'bbcCards',            ls:'zc_battle_cards',        fn:'loadCards'},
  {col:'pictureCards',        ls:'zc_picture_cards',       fn:'loadCardDisplay'},
  {col:'cardMissions',        ls:'zc_card_missions',       fn:'loadCardRewards'},
  {col:'purpleCprQuestions',  ls:'zc_game_cpr',            fn:null},
  {col:'dldQuestions',        ls:'zc_game_dld',            fn:null},
  {col:'jhopeTimeQuestions',  ls:'zc_game_jhope',          fn:null},
  {col:'announcements',       ls:'zc_announcements',       fn:'loadAnnouncements'},
  {col:'playlists',           ls:'zc_playlists',           fn:'loadPlaylist'},
  {col:'helpline',            ls:'zc_helpline',            fn:null},
  {col:'battles',             ls:'zc_battles',             fn:null},
  {col:'videoMissions',       ls:'zc_video_missions',      fn:'loadVideoMission'},
];

const SEC_IDS = {
  loadMissions:'sec-missions-list', loadTracks:'sec-tracks',
  loadAlbums:'sec-albums', loadCards:'sec-card-collection',
  loadCardDisplay:'sec-card-display', loadCardRewards:'sec-card-rewards',
  loadAnnouncements:'sec-announcements', loadPlaylist:'sec-playlist',
  loadVideoMission:'sec-video-mission',
};

function _rtUpdate(e, items) {
  if(!items||!items.length) return;

  // For cards: merge incoming items with existing localStorage items
  // to preserve imageData (base64) which is not stored in Firestore
  if(e.ls === 'zc_battle_cards' || e.ls === 'zc_picture_cards') {
    const existing = LS.get(e.ls, []);
    const existingMap = {};
    existing.forEach(item => { if(item&&item.id) existingMap[item.id] = item; });
    // Merge: use Firebase metadata but keep local imageData if present
    const merged = items.map(item => {
      const local = existingMap[item.id];
      if(local && local.imageData && !item.imageData) {
        return {...item, imageData: local.imageData}; // preserve local image
      }
      return item;
    });
    LS.set(e.ls, merged);
  } else {
    LS.set(e.ls, items);
  }

  if(e.fn && typeof window[e.fn]==='function') {
    const secId = SEC_IDS[e.fn];
    if(secId && document.getElementById(secId)) {
      window[e.fn]();
      console.log('[ZClock] 🔴 LIVE update rendered:', e.col);
    }
  }
  console.log('[ZClock] ✅ Realtime:', e.col, items.length, 'items');
}

async function _loadContentFromFirebase() {
  const db = FSB._db(); if(!db) return;

  // Clear old listeners
  _contentListeners.forEach(u => u()); _contentListeners = [];

  // Also do a one-time bulk load from content collection first
  try {
    const bulkSnap = await db.collection('content').get();
    const MAP2 = {
      missions:'zc_missions',tracks:'zc_tracks',albums:'zc_albums',
      battleCards:'zc_battle_cards',picCards:'zc_picture_cards',
      cardMissions:'zc_card_missions',gameCPR:'zc_game_cpr',
      gameDLD:'zc_game_dld',gameJHope:'zc_game_jhope',
      announcements:'zc_announcements',playlists:'zc_playlists',
    };
    bulkSnap.forEach(doc => {
      const k=MAP2[doc.id]; if(k&&doc.data().items) LS.set(k,doc.data().items);
    });
  } catch(e2){ /* silent */ }

  for(const entry of CONTENT_MAP) {
    (function(e){
      // PRIMARY: listen to _index doc (written by every admin save)
      const unsubIndex = db.collection(e.col).doc('_index')
        .onSnapshot(function(doc) {
          if(doc.exists && doc.data() && doc.data().items) {
            _rtUpdate(e, doc.data().items);
          }
        }, function(){ /* _index missing, use collection listener instead */ });
      _contentListeners.push(unsubIndex);

      // SECONDARY: also listen to entire collection for individual docs
      // (catches admAddMission etc that save per-doc AND _index)
      const unsubCol = db.collection(e.col)
        .onSnapshot(function(snap) {
          // Filter out _index doc, get real items
          const docs = snap.docs.filter(d=>d.id!=='_index').map(d=>d.data()).filter(d=>d&&d.id);
          if(docs.length) {
            // Merge with existing — prefer Firebase
            const existing = LS.get(e.ls, []);
            const merged = Object.values(
              [...existing, ...docs].reduce((acc, item) => {
                if(item&&item.id) acc[item.id]=item;
                return acc;
              }, {})
            );
            _rtUpdate(e, merged);
          }
        }, function(){});
      _contentListeners.push(unsubCol);

    })(entry);
  }

  // Also listen to content collection for bulk updates (includes imageData for cards!)
  const unsubContent = db.collection('content').onSnapshot(function(snap){
    const MAP3 = {
      missions:'zc_missions',tracks:'zc_tracks',albums:'zc_albums',
      battleCards:'zc_battle_cards',picCards:'zc_picture_cards',
      cardMissions:'zc_card_missions',gameCPR:'zc_game_cpr',
      gameDLD:'zc_game_dld',gameJHope:'zc_game_jhope',
      announcements:'zc_announcements',playlists:'zc_playlists',
    };
    snap.docChanges().forEach(function(change){
      if(change.type==='added'||change.type==='modified'){
        const k=MAP3[change.doc.id];
        if(k&&change.doc.data().items){
          // content collection has FULL imageData — always use this for cards
          LS.set(k, change.doc.data().items);
          console.log('[ZClock] 📦 Content update:', change.doc.id, change.doc.data().items.length, 'items');
          // Find matching CONTENT_MAP entry and refresh if visible
          const entry=CONTENT_MAP.find(function(e){return e.ls===k;});
          if(entry&&entry.fn&&typeof window[entry.fn]==='function'){
            const secId=SEC_IDS[entry.fn];
            if(secId&&document.getElementById(secId)) window[entry.fn]();
          }
        }
      }
    });
  }, function(){});
  _contentListeners.push(unsubContent);

  console.log('[ZClock] ✅ 100% Realtime — listening on', CONTENT_MAP.length*2+1, 'Firebase channels');
}

/* ─── INIT ─── */
document.addEventListener('DOMContentLoaded', async () => {
  if (!document.getElementById('bottom-nav')) return;

  loadTheme(); checkWeeklyReset();
  buildNav(); initStars(); initQuotes();

  /* ── Hide loading screen after 1.5s ── */
  setTimeout(() => {
    const ls = document.getElementById('loading-screen');
    if (ls) { ls.classList.add('fade-out'); setTimeout(() => ls.remove(), 800); }
  }, 1500);

  /* ── Auth guard: must have uid or admin flag ── */
  const uid = FSB.uid();
  if (!uid && !isAdmin()) {
    window.location.href = 'login.html';
    return;
  }

  /* ── Load current member from Firestore ── */
  if (uid && !isAdmin()) {
    try {
      const m = await FSB.getMember(uid);
      if (!m) {
        /* uid exists but doc missing — log out and re-join */
        console.warn('[ZClock] Member doc missing for uid:', uid);
        doLogout();
        return;
      }
      _currentMemberObj = m;
      /* Populate member cache */
      if (!_memberCache) _memberCache = {};
      _memberCache[uid] = m;
      console.log('[ZClock] ✅ Member loaded from Firestore:', m.username);
    } catch(e) {
      console.error('[ZClock] Failed to load member from Firestore:', e.message);
    }
  }

  openNav('main');
  refreshTopBar();
  updateNotifBadge();
  injectRefreshFAB();
  initPullToRefresh();

  // Load all content from Firebase (missions, cards, games etc)
  _loadContentFromFirebase().catch(()=>{});

  const user = getCurrentUser();
  if (user && !user.isAdmin) {
    /* Update last active in Firestore */
    FSB.saveMember(uid, {
      lastActive: new Date().toISOString(),
      onlineStatus: 'online',
      lastSeen: new Date().toISOString()
    }).catch(() => {});
    // Mark offline when tab closes
    window.addEventListener('beforeunload', () => {
      FSB.saveMember(uid, { onlineStatus: 'offline', lastSeen: new Date().toISOString() }).catch(()=>{});
    });
    /* Restore THIS member's Last.fm from Firebase to their per-member settings */
    if (_currentMemberObj) {
      const s0 = DB.getSettings(); // per-member key: zc_settings_{uid}
      // Firebase member doc is source of truth — always overwrite local with Firebase value
      const fbLfUrl = (_currentMemberObj.lastfm&&_currentMemberObj.lastfm.profileUrl) || _currentMemberObj.lastfmUrl || '';
      if (fbLfUrl) { s0.lastfmUrl = fbLfUrl; DB.saveSettings(s0); }
    }
    /* Run Last.fm sync */
    runSync(user, false);
    startAutoSync();
    startAutoRefresh();
  }

  setTimeout(() => {
    loadGuide(); loadTwilight(); loadVoting(); loadSpecialMissions();
    loadPlaylist(); loadTeam(); loadHelpline(); loadGroups();
    // Reset chat listener on navigation changes
    if (typeof _resetChatListener === 'function') _resetChatListener();
  }, 1500);
});
