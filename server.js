/**
 * ╔══════════════════════════════════════════════════════════╗
 *  ZCLOCK BACKEND SERVER — server.js
 *  Spec 51: Firebase Firestore real-time shared database
 *  Spec 52: Clean member UX — no technical errors exposed
 *  Pure Node.js — run with: node server.js
 *  Port: 3001
 * ╚══════════════════════════════════════════════════════════╝
 *
 *  SETUP (one-time):
 *  1. Go to https://firebase.google.com → create project
 *  2. Firestore Database → Create database (production mode)
 *  3. Project Settings → Service Accounts → Generate new private key
 *  4. Save that JSON file as firebase-credentials.json in this folder
 *  5. Copy your Project ID into FIREBASE_PROJECT_ID below
 *  6. npm install firebase-admin   (or: npm install)
 *  7. node server.js
 */

'use strict';

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const url    = require('url');

/* ── Protected API keys (server-side only) ── */
const LASTFM_API_KEY     = 'caa466ebac44bfcdd7cbb7d02bfdd0ba';
const LASTFM_BASE        = 'https://ws.audioscrobbler.com/2.0/';
const PORT               = process.env.PORT || 3001;

/* ── Firebase config ── */
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'fir-project-id-b56fc';
const FIREBASE_CREDENTIALS  = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, 'firebase-credentials.json');

/* ════════════════════════════════════════════════════════════
   FIREBASE ADAPTER
   Wraps firebase-admin OR falls back to local JSON storage.
   When credentials are configured → data is shared across all
   devices in real time. Without credentials → local only.
   ════════════════════════════════════════════════════════════ */
let db = null;  // Firestore instance or null
let firebaseReady = false;

function initFirebase() {
  try {
    const admin = require('firebase-admin');
    let credential;
    if (fs.existsSync(FIREBASE_CREDENTIALS)) {
      const svc = JSON.parse(fs.readFileSync(FIREBASE_CREDENTIALS, 'utf8'));
      credential = admin.credential.cert(svc);
      console.log('🔥 Firebase: Using service account from file');
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      credential = admin.credential.cert(svc);
      console.log('🔥 Firebase: Using service account from ENV');
    } else {
      console.log('⚠️  Firebase: No credentials found — using local fallback storage');
      return false;
    }
    admin.initializeApp({ credential, projectId: FIREBASE_PROJECT_ID });
    db = admin.firestore();
    firebaseReady = true;
    console.log('✅ Firebase Firestore connected — real-time multi-device sync enabled');
    return true;
  } catch (err) {
    console.log('⚠️  Firebase unavailable (' + err.message + ') — using local storage');
    return false;
  }
}

/* ── Local file fallback ── */
const LOCAL_FILE = path.join(__dirname, 'zclock-data.json');
function localLoad() {
  try { if (fs.existsSync(LOCAL_FILE)) return JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8')); } catch {}
  return { members: {}, syncData: {}, notifications: [], systemLog: [] };
}
function localSave(data) {
  try { fs.writeFileSync(LOCAL_FILE, JSON.stringify(data, null, 2)); } catch {}
}
let localDB = localLoad();
function localPersist() { localSave(localDB); }

/* ════════════════════════════════════════════════════════════
   DATABASE ABSTRACTION LAYER
   All code uses these functions — automatically uses Firebase
   when available, falls back to local JSON when not.
   ════════════════════════════════════════════════════════════ */

/* ── Members ── */
async function dbGetAllMembers() {
  if (firebaseReady) {
    try {
      const snap = await db.collection('members').get();
      const result = {};
      snap.forEach(doc => { result[doc.id] = doc.data(); });
      return result;
    } catch (e) { console.error('Firebase read error:', e.message); }
  }
  return localDB.members || {};
}

async function dbGetMember(username) {
  if (firebaseReady) {
    try {
      const doc = await db.collection('members').doc(username).get();
      return doc.exists ? doc.data() : null;
    } catch (e) { console.error('Firebase read error:', e.message); }
  }
  return localDB.members?.[username] || null;
}

async function dbSaveMember(username, data) {
  const record = { ...data, username, lastUpdated: new Date().toISOString() };
  if (firebaseReady) {
    try {
      await db.collection('members').doc(username).set(record, { merge: true });
      return;
    } catch (e) { console.error('Firebase write error:', e.message); }
  }
  if (!localDB.members) localDB.members = {};
  localDB.members[username] = record;
  localPersist();
}

/* ── Sync data ── */
async function dbGetSyncData(username) {
  if (firebaseReady) {
    try {
      const doc = await db.collection('syncData').doc(username).get();
      return doc.exists ? doc.data() : null;
    } catch (e) {}
  }
  return localDB.syncData?.[username] || null;
}

async function dbSaveSyncData(username, data) {
  if (firebaseReady) {
    try {
      await db.collection('syncData').doc(username).set({ ...data, username }, { merge: true });
      return;
    } catch (e) {}
  }
  if (!localDB.syncData) localDB.syncData = {};
  localDB.syncData[username] = { ...data, username };
  localPersist();
}

/* ── Notifications ── */
async function dbAddNotification(type, text, meta = {}) {
  const notif = { id: Date.now() + Math.random(), type, text, meta, time: new Date().toISOString(), read: false };
  if (firebaseReady) {
    try {
      await db.collection('notifications').add(notif);
      return;
    } catch (e) {}
  }
  if (!localDB.notifications) localDB.notifications = [];
  localDB.notifications.unshift(notif);
  if (localDB.notifications.length > 500) localDB.notifications.splice(500);
  localPersist();
}

async function dbGetNotifications(limit = 100) {
  if (firebaseReady) {
    try {
      const snap = await db.collection('notifications')
        .orderBy('time', 'desc').limit(limit).get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {}
  }
  return (localDB.notifications || []).slice(0, limit);
}

async function dbMarkAllRead() {
  if (firebaseReady) {
    try {
      const snap = await db.collection('notifications').where('read', '==', false).get();
      const batch = db.batch();
      snap.forEach(doc => batch.update(doc.ref, { read: true }));
      await batch.commit();
      return;
    } catch (e) {}
  }
  (localDB.notifications || []).forEach(n => n.read = true);
  localPersist();
}

/* ── Evidence ── */
async function dbGetEvidence() {
  if (firebaseReady) {
    try {
      const snap = await db.collection('evidence').orderBy('ts', 'desc').get();
      return snap.docs.map(d => ({ firestoreId: d.id, ...d.data() }));
    } catch (e) {}
  }
  return localDB.evidence || [];
}

async function dbSaveEvidence(item) {
  if (firebaseReady) {
    try {
      await db.collection('evidence').doc(String(item.id)).set(item);
      return;
    } catch (e) {}
  }
  if (!localDB.evidence) localDB.evidence = [];
  const i = localDB.evidence.findIndex(e => e.id === item.id);
  if (i > -1) localDB.evidence[i] = item; else localDB.evidence.unshift(item);
  localPersist();
}

/* ── Reports ── */
async function dbGetReports() {
  if (firebaseReady) {
    try {
      const snap = await db.collection('reports').orderBy('ts', 'desc').get();
      return snap.docs.map(d => ({ firestoreId: d.id, ...d.data() }));
    } catch (e) {}
  }
  return localDB.reports || [];
}

async function dbSaveReport(item) {
  if (firebaseReady) {
    try {
      await db.collection('reports').doc(String(item.id)).set(item);
      return;
    } catch (e) {}
  }
  if (!localDB.reports) localDB.reports = [];
  const i = localDB.reports.findIndex(r => r.id === item.id);
  if (i > -1) localDB.reports[i] = item; else localDB.reports.unshift(item);
  localPersist();
}

/* ════════════════════════════════════════════════════════════
   HTTP HELPERS
   ════════════════════════════════════════════════════════════ */
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Member-ID');
}
function sendJSON(res, status, data) {
  setCORS(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 5e6) reject(new Error('Too large')); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function fetchJSON(apiUrl) {
  return new Promise((resolve, reject) => {
    const parsed = new url.URL(apiUrl);
    const req = https.request({ hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'GET', headers: { 'User-Agent': 'Zclock/1.0', Accept: 'application/json' }, timeout: 10000 }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(body) }); } catch (e) { reject(new Error('Parse error')); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

/* ════════════════════════════════════════════════════════════
   STREAMING SYNC LOGIC
   ════════════════════════════════════════════════════════════ */
function extractLastFmUsername(input) {
  if (!input) return '';
  const m = input.trim().match(/last\.fm\/user\/([^/?#\s]+)/i);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{2,}$/.test(input.trim())) return input.trim();
  return '';
}
function calcHP(newStreams, pending) {
  const total = newStreams + (pending || 0);
  return { earned: Math.floor(total / 10), newPending: total % 10 };
}

/* ════════════════════════════════════════════════════════════
   CENTRAL APPROVED ARTIST LIST — Streaming HP is only ever
   earned from BTS or approved BTS-member solo/collab tracks.
   ════════════════════════════════════════════════════════════ */
const BTS_ARTISTS = [
  'bts', '방탄소년단', 'bangtan', 'bangtan boys', 'bangtan sonyeondan',
  'rm', 'kim namjoon', '김남준',
  'jin', 'kim seokjin', '김석진',
  'suga', 'agust d', 'min yoongi', '민윤기',
  'j-hope', 'jhope', 'jung hoseok', '정호석',
  'jimin', 'park jimin', '박지민',
  'v', 'kim taehyung', '김태형',
  'jungkook', 'jeon jungkook', '전정국',
];
function isApprovedBtsArtist(name) {
  if (!name) return false;
  const n = name.toLowerCase().trim();
  return BTS_ARTISTS.some(a => n === a || n.includes(a));
}
function _normStr(s) { return (s || '').toLowerCase().trim().replace(/\s+/g, ' '); }
function _streamFingerprint(memberUid, source, artist, track, playedAt) {
  return `${memberUid}_${source}_${_normStr(artist)}_${_normStr(track)}_${playedAt}`;
}

/* Real per-listen data from ListenBrainz (artist + track + timestamp),
   not just the aggregate total-listen-count — required to verify each
   stream actually belongs to BTS before it can count toward HP. */
async function fetchListenBrainzListens(username, minTsSeconds) {
  const url2 = `https://api.listenbrainz.org/1/user/${encodeURIComponent(username)}/listens?min_ts=${minTsSeconds}&count=100`;
  const r = await fetchJSON(url2);
  if (r.status !== 200 || !r.data || !r.data.payload || !r.data.payload.listens) return [];
  return r.data.payload.listens.map(l => ({
    artist: (l.track_metadata && l.track_metadata.artist_name) || '',
    track: (l.track_metadata && l.track_metadata.track_name) || '',
    playedAt: l.listened_at || 0,
  })).filter(l => l.track && l.playedAt);
}

async function syncLastFm(memberId, profileUrl, memberTeam) {
  const username = extractLastFmUsername(profileUrl);
  if (!username) return { success: false, status: 'Invalid profile URL' };

  let syncDoc = await dbGetSyncData(memberId) || {};
  syncDoc.lastfm = syncDoc.lastfm || { savedCount: null, pending: 0, earnedHP: 0, totalStreams: 0 };
  syncDoc.lastfm.profileUrl = profileUrl;
  syncDoc.lastfm.username   = username;

  let total = null;
  try {
    const r = await fetchJSON(`${LASTFM_BASE}?method=user.getinfo&user=${encodeURIComponent(username)}&api_key=${LASTFM_API_KEY}&format=json`);
    if (r.status === 200 && r.data?.user?.playcount) {
      total = parseInt(r.data.user.playcount);
    } else if (r.data?.error) {
      syncDoc.lastfm.status   = 'Connection failed';
      syncDoc.lastfm.lastSync = new Date().toISOString();
      await dbSaveSyncData(memberId, syncDoc);
      return { success: false, status: 'Connection failed' };
    }
  } catch (err) {
    syncDoc.lastfm.status   = 'Sync unavailable';
    syncDoc.lastfm.lastSync = new Date().toISOString();
    await dbSaveSyncData(memberId, syncDoc);
    return { success: false, status: 'Sync temporarily unavailable' };
  }

  if (total === null) {
    syncDoc.lastfm.status = 'Sync failed';
    await dbSaveSyncData(memberId, syncDoc);
    return { success: false, status: 'Sync failed' };
  }

  /* First-sync rule: save starting count, give 0 HP */
  if (syncDoc.lastfm.savedCount === null || !syncDoc.lastfm.firstSyncDone) {
    syncDoc.lastfm.savedCount    = total;
    syncDoc.lastfm.pending       = 0;
    syncDoc.lastfm.firstSyncDone = true;
    syncDoc.lastfm.status        = 'Connected';
    syncDoc.lastfm.lastSync      = new Date().toISOString();
    await dbSaveSyncData(memberId, syncDoc);
    await dbAddNotification('sync', `${memberId} connected Last.fm (${username}) — starting count: ${total.toLocaleString()}`, { memberId, username, startingCount: total });
    return { success: true, firstSync: true, status: 'Connected', earnedHP: 0, newStreams: 0, pending: 0, username };
  }

  /* Subsequent sync */
  const rawNew = Math.max(0, total - syncDoc.lastfm.savedCount);
  const { earned, newPending } = calcHP(rawNew, syncDoc.lastfm.pending);
  syncDoc.lastfm.savedCount    = total;
  syncDoc.lastfm.pending       = newPending;
  syncDoc.lastfm.lastNewStreams = rawNew;
  syncDoc.lastfm.earnedHP      = (syncDoc.lastfm.earnedHP || 0) + earned;
  syncDoc.lastfm.totalStreams   = (syncDoc.lastfm.totalStreams || 0) + rawNew;
  syncDoc.lastfm.lastSync      = new Date().toISOString();
  syncDoc.lastfm.status        = earned > 0 ? 'HP added successfully' : rawNew > 0 ? 'Synced' : 'No new streams';
  await dbSaveSyncData(memberId, syncDoc);

  /* Update member HP + streams in shared DB — safety: totals never decrease */
  const member = await dbGetMember(memberId) || {};
  const oldTotalHp      = member.totalHp      || 0;
  const oldTotalStreams  = member.totalStreams  || member.lifetimeStreams || 0;
  const oldWeeklyStreams = member.streams       || member.weeklyStreams   || 0;
  const oldWeeklyHp     = member.hp            || member.weeklyHp        || 0;

  const newWeeklyStreams = oldWeeklyStreams + rawNew;
  const newTotalStreams  = Math.max(oldTotalStreams + rawNew, newWeeklyStreams); // safety: total >= weekly
  const newWeeklyHp     = oldWeeklyHp + earned;
  const newTotalHp      = Math.max(oldTotalHp + earned, newWeeklyHp);           // safety: total >= weekly

  const updates = {
    streams:         newWeeklyStreams,
    weeklyStreams:   newWeeklyStreams,
    totalStreams:    newTotalStreams,
    lifetimeStreams: newTotalStreams,
  };
  if (earned > 0) {
    updates.hp          = newWeeklyHp;
    updates.weeklyHp    = newWeeklyHp;
    updates.totalHp     = newTotalHp;
    updates.hpStreaming  = (member.hpStreaming || 0) + earned;
  }
  if (rawNew > 0 || earned > 0) {
    await dbSaveMember(memberId, updates);
    await dbAddNotification('stream', `${memberId} synced: +${rawNew} streams → +${earned} HP`, { memberId, username, earned, newStreams: rawNew, team: memberTeam });
  }

  /* Fetch recent tracks for frontend track/album/mission matching */
  let recentTracks = [];
  try {
    const tracksResp = await fetchJSON(`${LASTFM_BASE}?method=user.getrecenttracks&user=${encodeURIComponent(username)}&api_key=${LASTFM_API_KEY}&format=json&limit=200`);
    if (tracksResp.status === 200 && tracksResp.data?.recenttracks?.track) {
      const raw = tracksResp.data.recenttracks.track;
      recentTracks = (Array.isArray(raw) ? raw : [raw])
        .filter(t => !t['@attr']?.nowplaying)
        .map(t => ({ name: (t.name||'').trim(), artist: (t.artist?.['#text']||t.artist||'').trim(), album: (t.album?.['#text']||t.album||'').trim() }))
        .filter(t => t.name);
    }
  } catch(e) {}

  return { success: true, firstSync: false, status: syncDoc.lastfm.status, username, newStreams: rawNew, earnedHP: earned, pending: newPending, newTracksList: recentTracks };
}

/* ═══════════════════════════════════════════════════════════
   LISTENBRAINZ SYNC — uses ListenBrainz public API
   No API key required for public listen counts.
   ═══════════════════════════════════════════════════════════ */
async function syncListenBrainz(memberUid, username, lbUsername, memberTeam) {
  if (!lbUsername) return { success: false, status: 'No ListenBrainz username' };
  if (!memberUid) return { success: false, status: 'Missing member ID' };

  // Get sync doc — keyed by the real Firestore member doc ID (Firebase Auth uid),
  // NOT username. Previously this used username, which is a *different* document
  // than the one the frontend actually reads/writes — every HP update the backend
  // computed was silently orphaned and never reached the member's real profile.
  let syncDoc = await dbGetSyncData(memberUid) || {};
  syncDoc.lb = syncDoc.lb || {};
  syncDoc.lb.username = lbUsername;

  const nowSec = Math.floor(Date.now() / 1000);

  // First-ever connection: set a TIME baseline and award 0 HP. No historical
  // streams are ever imported — only listens strictly after this moment count.
  if (!syncDoc.lb.firstSyncDone) {
    syncDoc.lb.lastProcessedTimestamp = nowSec;
    syncDoc.lb.verifiedBtsStreams = 0;
    syncDoc.lb.streamingHpAwarded = 0;
    syncDoc.lb.recentFingerprints = [];
    syncDoc.lb.firstSyncDone = true;
    syncDoc.lb.lastSync = new Date().toISOString();
    syncDoc.lb.status = 'Connected';
    await dbSaveSyncData(memberUid, syncDoc);
    await dbAddNotification('sync', `${username} connected ListenBrainz (${lbUsername}) — baseline set, no historical import`, { memberUid, username, lbUsername });
    if (db) db.collection('streamingHpAudit').add({
      memberUid, username, source: 'listenbrainz',
      newVerifiedStreams: 0, rejectedStreams: 0, duplicatesIgnored: 0,
      hpBefore: 0, hpAwarded: 0, hpAfter: 0,
      timestamp: new Date().toISOString(), note: 'First connection — baseline set, no historical import',
    }).catch(()=>{});
    return { success: true, firstSync: true, status: 'Connected', earnedHP: 0, newStreams: 0, pending: 0, username: lbUsername, newTracksList: [] };
  }

  // Fetch real per-listen data (artist + track + timestamp) since the last
  // processed point — NOT the aggregate total-listen-count, which counts
  // every artist a member has ever scrobbled, not just BTS.
  let listens;
  try {
    listens = await fetchListenBrainzListens(lbUsername, syncDoc.lb.lastProcessedTimestamp || nowSec);
  } catch (e) {
    return { success: false, status: 'ListenBrainz unavailable' };
  }
  listens.sort((a, b) => a.playedAt - b.playedAt); // oldest first, so counters advance chronologically

  const recentFp = new Set(syncDoc.lb.recentFingerprints || []);
  let acceptedCount = 0, rejectedCount = 0, duplicateCount = 0;
  const acceptedTracks = [];
  let maxTs = syncDoc.lb.lastProcessedTimestamp || nowSec;

  for (const l of listens) {
    maxTs = Math.max(maxTs, l.playedAt);
    if (!isApprovedBtsArtist(l.artist)) { rejectedCount++; continue; }
    const fp = _streamFingerprint(memberUid, 'listenbrainz', l.artist, l.track, l.playedAt);
    if (recentFp.has(fp)) { duplicateCount++; continue; }
    recentFp.add(fp);
    acceptedCount++;
    acceptedTracks.push({ name: l.track, artist: l.artist });
  }
  const recentFpArr = Array.from(recentFp).slice(-500); // bounded safety-net, not the primary dedup mechanism

  // Persistent verified counters — HP entitlement is recomputed from the
  // running verified-stream total each time, and only the DELTA since the
  // last award is granted. This replaces the old "floor(total/10) re-added
  // every sync" pattern that could hand out the same HP repeatedly.
  const hpBefore = syncDoc.lb.streamingHpAwarded || 0;
  const newVerifiedTotal = (syncDoc.lb.verifiedBtsStreams || 0) + acceptedCount;
  const newEntitlement = Math.floor(newVerifiedTotal / 10);
  const earned = Math.max(0, newEntitlement - hpBefore);

  syncDoc.lb.verifiedBtsStreams = newVerifiedTotal;
  syncDoc.lb.streamingHpAwarded = newEntitlement;
  syncDoc.lb.lastProcessedTimestamp = maxTs;
  syncDoc.lb.recentFingerprints = recentFpArr;
  syncDoc.lb.lastSync = new Date().toISOString();
  syncDoc.lb.lastNewStreams = acceptedCount;
  syncDoc.lb.status = earned > 0 ? 'HP added' : acceptedCount > 0 ? 'Synced' : 'No new streams';
  await dbSaveSyncData(memberUid, syncDoc);

  // Update member HP + streams — keyed by uid (see note above). Totals are
  // set to absolute values (never re-added as a delta on top of a delta),
  // and never allowed to decrease.
  const member = await dbGetMember(memberUid) || {};
  const oldTotalHp   = member.totalHp || 0;
  const oldTotalStr  = Math.max(member.totalStreams || 0, member.lifetimeStreams || 0);
  const oldWeeklyStr = member.streams || 0;
  const oldWeeklyHp  = member.hp || 0;
  const newWeeklyStr = oldWeeklyStr + acceptedCount;
  const newTotalStr  = Math.max(oldTotalStr + acceptedCount, newWeeklyStr);
  const newWeeklyHp  = oldWeeklyHp + earned;
  const newTotalHp   = Math.max(oldTotalHp + earned, newWeeklyHp);

  const updates = {
    streams: newWeeklyStr, weeklyStreams: newWeeklyStr,
    totalStreams: newTotalStr, lifetimeStreams: newTotalStr,
    lastSyncStreams: acceptedCount, streamsCountedThisSync: acceptedCount,
  };
  if (earned > 0) {
    updates.hp = newWeeklyHp; updates.weeklyHp = newWeeklyHp;
    updates.totalHp = newTotalHp; updates.hpStreaming = (member.hpStreaming || 0) + earned;
  }
  if (acceptedCount > 0 || earned > 0) {
    await dbSaveMember(memberUid, updates);
    await dbAddNotification('stream', `${username}: +${acceptedCount} verified BTS streams → +${earned} HP`, { memberUid, username, lbUsername, earned, newStreams: acceptedCount, team: memberTeam });
  }

  // Audit log — every sync call, so incorrect HP changes can be traced
  // instead of silently modifying member totals.
  if (db) db.collection('streamingHpAudit').add({
    memberUid, username, source: 'listenbrainz',
    newVerifiedStreams: acceptedCount, rejectedStreams: rejectedCount, duplicatesIgnored: duplicateCount,
    hpBefore: oldTotalHp, hpAwarded: earned, hpAfter: earned > 0 ? newTotalHp : oldTotalHp,
    timestamp: new Date().toISOString(),
  }).catch(()=>{});

  return {
    success: true, firstSync: false, status: syncDoc.lb.status, username: lbUsername,
    newStreams: acceptedCount, earnedHP: earned, pending: newVerifiedTotal % 10,
    newTracksList: acceptedTracks,
    newTotalHp, newWeeklyHp: newWeeklyHp, newTotalStreams: newTotalStr, newWeeklyStreams: newWeeklyStr, newHpStreaming: (member.hpStreaming || 0) + earned,
  };
}

async function syncStatsFm(memberId, profileUrl) {
  const username = (profileUrl.match(/stats\.fm\/user\/([^/?#\s]+)/i)||[])[1] || profileUrl.trim();
  if (!profileUrl.trim()) return { success: false, status: 'Invalid profile URL' };
  let syncDoc = await dbGetSyncData(memberId) || {};
  syncDoc.statsfm = { profileUrl, username, status: 'Connected', lastSync: new Date().toISOString() };
  await dbSaveSyncData(memberId, syncDoc);
  await dbAddNotification('sync', `${memberId} connected Stats.fm profile`, { memberId });
  return { success: true, status: 'Connected', username };
}

async function syncMusicat(memberId, profileUrl) {
  const username = (profileUrl.match(/musicat[^\/]*\/[a-z0-9-]*\/([^/?#\s]+)/i)||[])[1] || profileUrl.trim();
  if (!profileUrl.trim()) return { success: false, status: 'Invalid profile URL' };
  let syncDoc = await dbGetSyncData(memberId) || {};
  syncDoc.musicat = { profileUrl, username, status: 'Connected', lastSync: new Date().toISOString() };
  await dbSaveSyncData(memberId, syncDoc);
  await dbAddNotification('sync', `${memberId} connected Musicat profile`, { memberId });
  return { success: true, status: 'Connected', username };
}

/* ════════════════════════════════════════════════════════════
   MEMBER REGISTRATION — called when a new user joins
   ════════════════════════════════════════════════════════════ */
async function registerMember(memberData) {
  const { username } = memberData;
  if (!username) return { success: false, error: 'Username required' };
  // Force a fresh read from Firestore source (not cache) to avoid stale data after admin deletes
  let existing = null;
  if (firebaseReady) {
    try {
      const doc = await db.collection('members').doc(username).get({ source: 'server' });
      existing = doc.exists ? doc.data() : null;
    } catch(e) {
      existing = await dbGetMember(username);
    }
  } else {
    existing = await dbGetMember(username);
  }
  if (existing) return { success: false, error: 'Username already taken' };
  if (db) {
    try {
      const banned = await db.collection('bannedUsernames').doc(username.toLowerCase()).get({ source: 'server' }).catch(() => db.collection('bannedUsernames').doc(username.toLowerCase()).get());
      if (banned.exists) return { success: false, error: 'This username is not available' };
    } catch(e) {}
  }
  const record = {
    ...memberData,
    hp: 0, totalHp: 0, weeklyHp: 0, hpStreaming: 0, hpVoting: 0, hpMissions: 0, hpGames: 0, hpAttendance: 0,
    streams: 0, weeklyStreams: 0, totalStreams: 0, lifetimeStreams: 0, votesToday: 0,
    completedMissions: [], completedGames: [],
    joinedAt: new Date().toISOString(),
    lastActive: new Date().toISOString(),
  };
  await dbSaveMember(username, record);
  await dbAddNotification('join', `${username} joined ARMY as ${memberData.team || '—'}`, { username });
  return { success: true, member: record };
}

/* ════════════════════════════════════════════════════════════
   HTTP SERVER
   ════════════════════════════════════════════════════════════ */
const server = http.createServer(async (req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const method   = req.method.toUpperCase();

  if (method === 'OPTIONS') { setCORS(res); res.writeHead(204); res.end(); return; }

  /* Health */
  if (pathname === '/api/health') {
    return sendJSON(res, 200, { status: 'ok', firebase: firebaseReady, time: new Date().toISOString() });
  }

  /* ── MEMBER REGISTRATION ── */
  /* ── Admin: WIPE ALL MEMBERS — clears every doc in members collection ── */
  if (pathname === '/api/admin/wipe-all-members' && method === 'DELETE') {
    if (!db) return sendJSON(res, 200, { success: false, error: 'Firebase not connected' });
    try {
      let totalDeleted = 0;
      let snap = await db.collection('members').limit(450).get();
      while (!snap.empty) {
        const batch = db.batch();
        snap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
        totalDeleted += snap.docs.length;
        snap = await db.collection('members').limit(450).get();
      }
      // Also clear bannedUsernames so re-registration is clean
      let bsnap = await db.collection('bannedUsernames').limit(450).get();
      while (!bsnap.empty) {
        const batch = db.batch();
        bsnap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
        bsnap = await db.collection('bannedUsernames').limit(450).get();
      }
      return sendJSON(res, 200, { success: true, deletedCount: totalDeleted });
    } catch(e) { return sendJSON(res, 200, { success: false, error: e.message }); }
  }

  /* ── Admin: force-check & delete a stuck username ── */
  if (pathname.startsWith('/api/admin/check-username/') && method === 'GET') {
    const checkUser = decodeURIComponent(pathname.replace('/api/admin/check-username/', ''));
    if (!db) return sendJSON(res, 200, { exists: false, banned: false, error: 'Firebase not connected' });
    try {
      const memberDoc = await db.collection('members').doc(checkUser).get();
      const bannedDoc = await db.collection('bannedUsernames').doc(checkUser.toLowerCase()).get();
      return sendJSON(res, 200, {
        username: checkUser,
        existsAsMember: memberDoc.exists,
        memberData: memberDoc.exists ? memberDoc.data() : null,
        isBanned: bannedDoc.exists,
        bannedData: bannedDoc.exists ? bannedDoc.data() : null,
      });
    } catch(e) { return sendJSON(res, 200, { error: e.message }); }
  }

  if (pathname.startsWith('/api/admin/force-delete-username/') && method === 'DELETE') {
    const delUser = decodeURIComponent(pathname.replace('/api/admin/force-delete-username/', ''));
    if (!db) return sendJSON(res, 200, { success: false, error: 'Firebase not connected' });
    try {
      await db.collection('members').doc(delUser).delete().catch(()=>{});
      await db.collection('bannedUsernames').doc(delUser.toLowerCase()).delete().catch(()=>{});
      const snap = await db.collection('members').where('username','==',delUser).get();
      const batch = db.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      if (!snap.empty) await batch.commit();
      return sendJSON(res, 200, { success: true, deleted: delUser });
    } catch(e) { return sendJSON(res, 200, { success: false, error: e.message }); }
  }

  if (pathname === '/api/register' && method === 'POST') {
    try {
      const body = await readBody(req);
      const result = await registerMember(body);
      return sendJSON(res, result.success ? 200 : 409, result);
    } catch (e) { return sendJSON(res, 500, { success: false }); }
  }

  /* ── GET MEMBER ── */
  if (pathname.startsWith('/api/member/') && method === 'GET') {
    const username = decodeURIComponent(pathname.replace('/api/member/', ''));
    const m = await dbGetMember(username);
    return sendJSON(res, m ? 200 : 404, m || { error: 'Not found' });
  }

  /* ── SAVE/UPDATE MEMBER ── */
  if (pathname.startsWith('/api/member/') && method === 'POST') {
    const username = decodeURIComponent(pathname.replace('/api/member/', ''));
    try {
      const body = await readBody(req);
      await dbSaveMember(username, body);
      return sendJSON(res, 200, { success: true });
    } catch (e) { return sendJSON(res, 500, { success: false }); }
  }

  /* ── GET ALL MEMBERS (admin) ── */
  if (pathname === '/api/members' && method === 'GET') {
    const all = await dbGetAllMembers();
    return sendJSON(res, 200, { members: all, count: Object.keys(all).length });
  }

  /* ── LOGIN ── */
  if (pathname === '/api/login' && method === 'POST') {
    try {
      const { username, password } = await readBody(req);
      const m = await dbGetMember(username);
      if (!m || m.password !== password) return sendJSON(res, 401, { success: false, error: 'Invalid credentials' });
      await dbSaveMember(username, { lastActive: new Date().toISOString() });
      return sendJSON(res, 200, { success: true, member: m });
    } catch (e) { return sendJSON(res, 500, { success: false }); }
  }

  /* ── SYNC LAST.FM ── */
  if (pathname === '/api/sync-lastfm' && method === 'POST') {
    try {
      const { memberId, profileUrl, memberTeam } = await readBody(req);
      if (!memberId || !profileUrl) return sendJSON(res, 400, { success: false });
      const result = await syncLastFm(memberId, profileUrl, memberTeam || '');
      return sendJSON(res, 200, result);
    } catch (e) { return sendJSON(res, 200, { success: false, status: 'Sync temporarily unavailable' }); }
  }

  /* ── SYNC STATS.FM ── */
  if (pathname === '/api/sync-statsfm' && method === 'POST') {
    try {
      const { memberId, profileUrl } = await readBody(req);
      if (!memberId) return sendJSON(res, 400, { success: false });
      const result = await syncStatsFm(memberId, profileUrl || '');
      return sendJSON(res, 200, result);
    } catch (e) { return sendJSON(res, 200, { success: false, status: 'Sync temporarily unavailable' }); }
  }

  /* ── SYNC MUSICAT ── */
  if (pathname === '/api/sync-musicat' && method === 'POST') {
    try {
      const { memberId, profileUrl } = await readBody(req);
      if (!memberId) return sendJSON(res, 400, { success: false });
      const result = await syncMusicat(memberId, profileUrl || '');
      return sendJSON(res, 200, result);
    } catch (e) { return sendJSON(res, 200, { success: false, status: 'Sync temporarily unavailable' }); }
  }

  /* ── SYNC ALL ── */
  if (pathname.startsWith('/api/sync-all/') && method === 'POST') {
    const memberId = decodeURIComponent(pathname.replace('/api/sync-all/', ''));
    try {
      const body = await readBody(req).catch(() => ({}));
      const lbUsername = body.lbUsername || '';
      const lastfmUrl  = body.lastfmUrl  || '';
      const memberTeam = body.memberTeam || '';
      const memberUid  = body.memberUid || '';
      let lfResult;
      if (lbUsername) {
        if (!memberUid) return sendJSON(res, 200, { success: false, status: 'Missing member ID — please refresh and try again' });
        lfResult = await syncListenBrainz(memberUid, memberId, lbUsername, memberTeam);
      } else if (lastfmUrl) {
        lfResult = await syncLastFm(memberUid || memberId, lastfmUrl, memberTeam);
      } else {
        // Try from saved syncDoc
        const syncDoc = await dbGetSyncData(memberUid || memberId);
        if (syncDoc?.lastfm?.profileUrl) {
          lfResult = await syncLastFm(memberUid || memberId, syncDoc.lastfm.profileUrl, memberTeam);
        } else {
          return sendJSON(res, 200, { success: false, status: 'No streaming platform connected' });
        }
      }
      return sendJSON(res, 200, {
        success: true, lastfm: lfResult,
        totalEarnedHP: lfResult?.earnedHP || 0,
        newStreams:     lfResult?.newStreams || 0,
        firstSync:     lfResult?.firstSync || false,
        pending:       lfResult?.pending || 0,
        newTracksList: lfResult?.newTracksList || [],
        newTotalHp: lfResult?.newTotalHp, newWeeklyHp: lfResult?.newWeeklyHp,
        newTotalStreams: lfResult?.newTotalStreams, newWeeklyStreams: lfResult?.newWeeklyStreams,
        newHpStreaming: lfResult?.newHpStreaming,
      });
    } catch (e) { return sendJSON(res, 200, { success: false, status: 'Sync temporarily unavailable' }); }
  }

  /* ── SAVE PROFILES ── */
  if (pathname === '/api/save-profiles' && method === 'POST') {
    try {
      const { memberId, lastfmUrl, statsfmUrl, musicatUrl, memberTeam } = await readBody(req);
      if (!memberId) return sendJSON(res, 400, { success: false });
      const results = {};
      if (lastfmUrl  !== undefined) results.lastfm  = await syncLastFm(memberId, lastfmUrl, memberTeam || '').catch(() => ({ success: false, status: 'Sync temporarily unavailable' }));
      if (statsfmUrl !== undefined) results.statsfm = await syncStatsFm(memberId, statsfmUrl).catch(() => ({ success: false, status: 'Sync temporarily unavailable' }));
      if (musicatUrl !== undefined) results.musicat = await syncMusicat(memberId, musicatUrl).catch(() => ({ success: false, status: 'Sync temporarily unavailable' }));
      return sendJSON(res, 200, { success: true, platforms: results, totalEarnedHP: results.lastfm?.earnedHP || 0 });
    } catch (e) { return sendJSON(res, 200, { success: false }); }
  }

  /* ── GET SYNC STATUS ── */
  if (pathname.startsWith('/api/sync-status/') && method === 'GET') {
    const memberId = decodeURIComponent(pathname.replace('/api/sync-status/', ''));
    const syncDoc  = await dbGetSyncData(memberId);
    return sendJSON(res, 200, { memberId, sync: syncDoc });
  }

  /* ── ALL SYNC STATUS (admin) ── */
  if (pathname === '/api/all-sync-status' && method === 'GET') {
    const allM = await dbGetAllMembers();
    const result = {};
    await Promise.allSettled(Object.keys(allM).map(async uid => {
      result[uid] = await dbGetSyncData(uid);
    }));
    return sendJSON(res, 200, { members: result, firebase: firebaseReady });
  }

  /* ── NOTIFICATIONS ── */
  if (pathname === '/api/notifications' && method === 'GET') {
    const limit = parseInt(parsed.query.limit) || 100;
    const notifs = await dbGetNotifications(limit);
    return sendJSON(res, 200, { notifications: notifs, unread: notifs.filter(n => !n.read).length });
  }
  if (pathname === '/api/notifications/mark-read' && method === 'POST') {
    await dbMarkAllRead();
    return sendJSON(res, 200, { success: true });
  }

  /* ── EVIDENCE (admin) ── */
  if (pathname === '/api/evidence' && method === 'GET') {
    const ev = await dbGetEvidence();
    return sendJSON(res, 200, { evidence: ev });
  }
  if (pathname === '/api/evidence' && method === 'POST') {
    try {
      const body = await readBody(req);
      await dbSaveEvidence(body);
      await dbAddNotification('evidence', `${body.user} submitted evidence: ${body.mission}`, { user: body.user });
      return sendJSON(res, 200, { success: true });
    } catch (e) { return sendJSON(res, 500, { success: false }); }
  }
  if (pathname.startsWith('/api/evidence/') && method === 'PUT') {
    try {
      const id   = decodeURIComponent(pathname.replace('/api/evidence/', ''));
      const body = await readBody(req);
      await dbSaveEvidence({ id: parseInt(id), ...body });
      return sendJSON(res, 200, { success: true });
    } catch (e) { return sendJSON(res, 500, { success: false }); }
  }

  /* ── REPORTS (admin) ── */
  if (pathname === '/api/reports' && method === 'GET') {
    const reps = await dbGetReports();
    return sendJSON(res, 200, { reports: reps });
  }
  if (pathname === '/api/reports' && method === 'POST') {
    try {
      const body = await readBody(req);
      await dbSaveReport(body);
      await dbAddNotification('report', `${body.user}: ${body.title}`, { user: body.user });
      return sendJSON(res, 200, { success: true });
    } catch (e) { return sendJSON(res, 500, { success: false }); }
  }
  if (pathname.startsWith('/api/reports/') && method === 'PUT') {
    try {
      const id   = decodeURIComponent(pathname.replace('/api/reports/', ''));
      const body = await readBody(req);
      await dbSaveReport({ id: parseInt(id), ...body });
      return sendJSON(res, 200, { success: true });
    } catch (e) { return sendJSON(res, 500, { success: false }); }
  }

  /* ── ACTION LOG ── */
  if (pathname === '/api/log' && method === 'POST') {
    try {
      const body = await readBody(req);
      await dbAddNotification(body.category || 'action', `${body.username}: ${body.action}`, body.details || {});
      return sendJSON(res, 200, { success: true });
    } catch (e) { return sendJSON(res, 200, { success: true }); }
  }

  /* ── ADMIN: DELETE MEMBER ── */
  if (pathname.startsWith('/api/member/') && method === 'DELETE') {
    const username = decodeURIComponent(pathname.replace('/api/member/', ''));
    try {
      if (firebaseReady) await db.collection('members').doc(username).delete();
      else { delete localDB.members[username]; localPersist(); }
      return sendJSON(res, 200, { success: true });
    } catch (e) { return sendJSON(res, 500, { success: false }); }
  }

  /* ── SYSTEM STATUS (admin only) ── */
  if (pathname === '/api/system-status' && method === 'GET') {
    return sendJSON(res, 200, {
      backend: 'online',
      firebase: firebaseReady,
      storage: firebaseReady ? 'Firebase Firestore' : 'Local file (single device)',
      time: new Date().toISOString(),
      version: '2.0.0',
    });
  }

  /* ── REPAIR CORRUPTED STREAM/HP DATA ── */
  if (pathname === '/api/admin/repair-totals' && method === 'POST') {
    if (!db) return sendJSON(res, 200, { success: false, error: 'Firebase not ready' });
    try {
      const allM = await dbGetAllMembers();
      const repairs = [];
      await Promise.allSettled(Object.entries(allM).map(async ([uid, m]) => {
        const updates = {};
        const weeklyStreams = m.streams || m.weeklyStreams || 0;
        const totalStreams  = m.totalStreams || m.lifetimeStreams || 0;
        const weeklyHp     = m.hp || m.weeklyHp || 0;
        const totalHp      = m.totalHp || 0;
        // Safety: total must always >= weekly
        if (weeklyStreams > totalStreams) {
          updates.totalStreams    = weeklyStreams;
          updates.lifetimeStreams = weeklyStreams;
        }
        if (weeklyHp > totalHp) {
          updates.totalHp = weeklyHp;
        }
        // Ensure all 4 fields exist
        if (!m.totalStreams)    updates.totalStreams    = Math.max(totalStreams, weeklyStreams);
        if (!m.lifetimeStreams) updates.lifetimeStreams = Math.max(totalStreams, weeklyStreams);
        if (!m.weeklyStreams)   updates.weeklyStreams   = weeklyStreams;
        if (!m.weeklyHp)       updates.weeklyHp        = weeklyHp;
        if (Object.keys(updates).length > 0) {
          await dbSaveMember(uid, updates);
          repairs.push({ uid, updates });
        }
      }));
      return sendJSON(res, 200, { success: true, repaired: repairs.length, repairs });
    } catch(e) { return sendJSON(res, 200, { success: false, error: e.message }); }
  }

  /* ── USER STATS ── */
  if (pathname.startsWith('/api/user/') && pathname.endsWith('/stats') && method === 'GET') {
    const uid = decodeURIComponent(pathname.replace('/api/user/','').replace('/stats',''));
    const member = await dbGetMember(uid) || {};
    const syncDoc = await dbGetSyncData(uid) || {};
    return sendJSON(res, 200, { success: true, uid,
      weeklyHP: member.hp || 0, totalHP: member.totalHp || 0,
      weeklyStreams: member.streams || 0, totalStreams: member.totalStreams || member.lifetimeStreams || 0,
      level: Math.floor((member.totalHp || 0) / 1000) + 1,
      lastSync: syncDoc.lastfm?.lastSync || null,
      username: syncDoc.lastfm?.username || uid,
    });
  }

  /* ── TEAM STATS ── */
  if (pathname === '/api/team/stats' && method === 'GET') {
    const allM = await dbGetAllMembers();
    const stats = { hyung: { totalHP:0, weeklyHP:0, totalStreams:0, weeklyStreams:0, members:0 }, maknae: { totalHP:0, weeklyHP:0, totalStreams:0, weeklyStreams:0, members:0 } };
    Object.values(allM).forEach(m => {
      const t = (m.team||'').toLowerCase().includes('hyung') ? 'hyung' : 'maknae';
      stats[t].totalHP      += m.totalHp     || 0;
      stats[t].weeklyHP     += m.hp          || 0;
      stats[t].totalStreams  += m.totalStreams || m.lifetimeStreams || 0;
      stats[t].weeklyStreams += m.streams     || 0;
      stats[t].members++;
    });
    return sendJSON(res, 200, { success: true, teams: stats });
  }

  /* ── MISSION PROGRESS ── */
  if (pathname.startsWith('/api/missions/progress/') && method === 'GET') {
    const uid = decodeURIComponent(pathname.replace('/api/missions/progress/',''));
    if (!db) return sendJSON(res, 200, { success: false, error: 'Firebase not ready', tracks: [], albums: [], missions: [] });
    try {
      const [tSnap, aSnap, mSnap] = await Promise.all([
        db.collection('memberTrackProgress').where('memberUid','==',uid).get(),
        db.collection('memberAlbumProgress').where('memberUid','==',uid).get(),
        db.collection('memberMissionProgress').where('memberUid','==',uid).get(),
      ]);
      return sendJSON(res, 200, {
        success: true,
        tracks:   tSnap.docs.map(d => d.data()),
        albums:   aSnap.docs.map(d => d.data()),
        missions: mSnap.docs.map(d => d.data()),
      });
    } catch(e) { return sendJSON(res, 200, { success: false, error: e.message }); }
  }

  /* ── ADMIN SYNC ALL USERS ── */
  if (pathname === '/api/sync/all' && method === 'POST') {
    const allM = await dbGetAllMembers();
    const results = {};
    await Promise.allSettled(Object.keys(allM).map(async uid => {
      const syncDoc = await dbGetSyncData(uid);
      if (syncDoc?.lastfm?.profileUrl) {
        results[uid] = await syncLastFm(uid, syncDoc.lastfm.profileUrl, allM[uid]?.team || '').catch(e => ({ success: false, error: e.message }));
      }
    }));
    return sendJSON(res, 200, { success: true, results, synced: Object.keys(results).length });
  }

  /* ── ListenBrainz check endpoint ── */
  if (pathname.startsWith('/api/listenbrainz/check/') && method === 'GET') {
    const lbUser = decodeURIComponent(pathname.replace('/api/listenbrainz/check/', ''));
    try {
      const r = await fetchJSON(`https://api.listenbrainz.org/1/user/${encodeURIComponent(lbUser)}/listen-count`);
      if (r.status === 200 && r.data?.payload?.count !== undefined) {
        return sendJSON(res, 200, { success: true, exists: true, username: lbUser, listenCount: r.data.payload.count });
      }
      return sendJSON(res, 200, { success: false, exists: false });
    } catch(e) { return sendJSON(res, 200, { success: false, exists: false, error: e.message }); }
  }

  /* Last.fm total playcount — used by frontend stream counter */
  if (pathname.startsWith('/api/lastfm-count/') && method === 'GET') {
    const lfUser = decodeURIComponent(pathname.replace('/api/lastfm-count/', ''));
    try {
      const r = await fetchJSON(`${LASTFM_BASE}?method=user.getinfo&user=${encodeURIComponent(lfUser)}&api_key=${LASTFM_API_KEY}&format=json`);
      if (r.status === 200 && r.data?.user?.playcount) {
        return sendJSON(res, 200, { success: true, playcount: parseInt(r.data.user.playcount), username: lfUser });
      }
      return sendJSON(res, 200, { success: false, playcount: null });
    } catch(e) { return sendJSON(res, 200, { success: false, playcount: null }); }
  }

  /* Last.fm tracks proxy */
  if (pathname.startsWith('/api/lastfm-tracks/') && method === 'GET') {
    const lfUser = decodeURIComponent(pathname.replace('/api/lastfm-tracks/', ''));
    try {
      const lfUrl = `${LASTFM_BASE}?method=user.getrecenttracks&user=${encodeURIComponent(lfUser)}&api_key=${LASTFM_API_KEY}&format=json&limit=200`;
      const mod = require('https');
      const data = await new Promise((resolve, reject) => {
        mod.get(lfUrl, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>resolve(JSON.parse(d))); }).on('error',reject);
      });
      if (data.error) return sendJSON(res, 200, { success: false, error: data.message, tracks: [] });
      const rawTracks = data?.recenttracks?.track || [];
      const tracks = (Array.isArray(rawTracks) ? rawTracks : [rawTracks])
        .filter(t => !t['@attr']?.nowplaying)
        .map(t => ({ name:(t.name||'').trim(), artist:(t.artist?.['#text']||t.artist||'').trim(), album:(t.album?.['#text']||t.album||'').trim() }))
        .filter(t => t.name);
      return sendJSON(res, 200, { success: true, tracks, count: tracks.length });
    } catch(e) { return sendJSON(res, 200, { success: false, error: e.message, tracks: [] }); }
  }

  sendJSON(res, 404, { error: 'Not found' });
});

/* ── Start ── */
initFirebase();
server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`  ZCLOCK BACKEND  running on port ${PORT}`);
  console.log(`  Database: ${firebaseReady ? 'Firebase Firestore ✅' : 'Local file (add firebase-credentials.json for multi-device)'}`);
  console.log(`  Last.fm API: server-side only ✅`);
  console.log(`╚══════════════════════════════════════════════╝\n`);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} in use. Try: PORT=3002 node server.js`);
  else console.error('Server error:', err.message);
});
process.on('SIGTERM', () => { localPersist(); server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { localPersist(); server.close(() => process.exit(0)); });
