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

/* Generic HTTP request supporting POST + custom headers + body — needed for
   OAuth-style token exchanges, which fetchJSON (GET-only) can't do. */
function httpRequest(reqUrl, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new url.URL(reqUrl);
    const req = https.request({
      hostname: parsed.hostname, path: parsed.pathname + parsed.search, method,
      headers: { 'User-Agent': 'Zclock/1.0', Accept: 'application/json', ...headers },
      timeout: 10000,
    }, res => {
      let respBody = '';
      res.on('data', c => respBody += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(respBody) }); }
        catch (e) { resolve({ status: res.statusCode, data: null, raw: respBody }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(body);
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
/* ════════════════════════════════════════════════════════════
   PUSH-BASED SCROBBLE INGESTION — real-time, no polling.
   Members point Pano Scrobbler (as a custom "ListenBrainz-like
   instance") or Web Scrobbler (via its webhook feature) directly
   at this backend using their personal PIN. Scrobbles arrive the
   moment they happen instead of waiting for a periodic poll of a
   third-party service. Shared by both POST /1/submit-listens and
   POST /api/webhook/scrobble.
   ════════════════════════════════════════════════════════════ */
async function _findMemberByPin(pin) {
  if (!db || !pin) return null;
  const snap = await db.collection('members').where('webhookPin', '==', pin).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { uid: doc.id, ...doc.data() };
}

async function _processScrobbleBatch(memberUid, username, memberTeam, source, scrobbles) {
  // scrobbles: [{artist, track, playedAt}] (playedAt = unix seconds)
  if (!memberUid || !scrobbles || !scrobbles.length) return { acceptedCount: 0, rejectedCount: 0, duplicateCount: 0, earned: 0 };
  if (!db) return { acceptedCount: 0, rejectedCount: 0, duplicateCount: 0, earned: 0, error: 'Database not connected' };

  const syncRef = db.collection('syncData').doc(memberUid);
  const memberRef = db.collection('members').doc(memberUid);
  let out = null;

  try {
    await db.runTransaction(async (tx) => {
      const syncSnap = await tx.get(syncRef);
      const memberSnap = await tx.get(memberRef);
      const syncDoc = syncSnap.exists ? syncSnap.data() : {};
      syncDoc[source] = syncDoc[source] || {};
      const member = memberSnap.exists ? memberSnap.data() : {};

      const recentFp = new Set(syncDoc[source].recentFingerprints || []);
      let acceptedCount = 0, rejectedCount = 0, duplicateCount = 0;
      const acceptedTracks = [];

      for (const l of scrobbles) {
        if (!l.track || !l.playedAt) { rejectedCount++; continue; }
        if (!isApprovedBtsArtist(l.artist)) { rejectedCount++; continue; }
        const fp = _streamFingerprint(memberUid, source, l.artist, l.track, l.playedAt);
        if (recentFp.has(fp)) { duplicateCount++; continue; }
        recentFp.add(fp);
        acceptedCount++;
        acceptedTracks.push({ name: l.track, artist: l.artist });
      }
      const recentFpArr = Array.from(recentFp).slice(-500);

      const hpBefore = syncDoc[source].streamingHpAwarded || 0;
      const newVerifiedTotal = (syncDoc[source].verifiedBtsStreams || 0) + acceptedCount;
      const newEntitlement = Math.floor(newVerifiedTotal / 10);
      const earned = Math.max(0, newEntitlement - hpBefore);

      syncDoc[source].verifiedBtsStreams = newVerifiedTotal;
      syncDoc[source].streamingHpAwarded = newEntitlement;
      syncDoc[source].recentFingerprints = recentFpArr;
      syncDoc[source].lastReceivedAt = new Date().toISOString();
      syncDoc[source].lastNewStreams = acceptedCount;

      const oldTotalHp   = member.totalHp || 0;
      const oldTotalStr  = Math.max(member.totalStreams || 0, member.lifetimeStreams || 0);
      const oldWeeklyStr = member.streams || 0;
      const oldWeeklyHp  = member.hp || 0;
      const newWeeklyStr = oldWeeklyStr + acceptedCount;
      const newTotalStr  = Math.max(oldTotalStr + acceptedCount, newWeeklyStr);
      const newWeeklyHp  = oldWeeklyHp + earned;
      const newTotalHp   = Math.max(oldTotalHp + earned, newWeeklyHp);
      const newHpStreaming = (member.hpStreaming || 0) + earned;

      const memberUpdates = {
        streams: newWeeklyStr, weeklyStreams: newWeeklyStr,
        totalStreams: newTotalStr, lifetimeStreams: newTotalStr,
        lastSyncStreams: acceptedCount, streamsCountedThisSync: acceptedCount,
        lastUpdated: new Date().toISOString(),
        [`last_${source}_at`]: new Date().toISOString(),
      };
      if (earned > 0) {
        memberUpdates.hp = newWeeklyHp; memberUpdates.weeklyHp = newWeeklyHp;
        memberUpdates.totalHp = newTotalHp; memberUpdates.hpStreaming = newHpStreaming;
      }

      tx.set(syncRef, syncDoc, { merge: true });
      if (acceptedCount > 0 || earned > 0) tx.set(memberRef, memberUpdates, { merge: true });

      out = { acceptedCount, rejectedCount, duplicateCount, earned, oldTotalHp, newTotalHp, acceptedTracks };
    });
  } catch (e) {
    return { acceptedCount: 0, rejectedCount: 0, duplicateCount: 0, earned: 0, error: e.message };
  }

  if (out.acceptedCount > 0 || out.earned > 0) {
    await dbAddNotification('stream', `${username}: +${out.acceptedCount} verified BTS streams (${source}) → +${out.earned} HP`, { memberUid, username, earned: out.earned, newStreams: out.acceptedCount, team: memberTeam }).catch(()=>{});
  }
  db.collection('streamingHpAudit').add({
    memberUid, username, source,
    newVerifiedStreams: out.acceptedCount, rejectedStreams: out.rejectedCount, duplicatesIgnored: out.duplicateCount,
    hpBefore: out.oldTotalHp, hpAwarded: out.earned, hpAfter: out.earned > 0 ? out.newTotalHp : out.oldTotalHp,
    timestamp: new Date().toISOString(),
  }).catch(()=>{});
  if (out.earned > 0) {
    const txnId = 'hpt_' + Date.now() + '_' + Math.floor(Math.random()*10000);
    db.collection('hpTransactions').doc(txnId).set({
      transactionId: txnId, memberUid, username, team: memberTeam || '',
      source: 'streaming', amount: out.earned, reason: `${source}: ${out.acceptedCount} verified streams`,
      relatedId: null, createdAt: new Date().toISOString(), createdBy: 'system',
    }).catch(()=>{});
  }

  return out;
}

async function fetchLastFmRecentTracks(username, fromUnixSec) {
  const url2 = `${LASTFM_BASE}?method=user.getrecenttracks&user=${encodeURIComponent(username)}&api_key=${LASTFM_API_KEY}&format=json&limit=200${fromUnixSec ? '&from=' + (fromUnixSec + 1) : ''}`;
  const r = await fetchJSON(url2);
  if (r.status !== 200 || !r.data || !r.data.recenttracks || !r.data.recenttracks.track) return [];
  const raw = r.data.recenttracks.track;
  return (Array.isArray(raw) ? raw : [raw])
    .filter(t => !(t['@attr'] && t['@attr'].nowplaying) && t.date && t.date.uts) // drop the currently-playing track (no timestamp yet)
    .map(t => ({
      artist: (t.artist && (t.artist['#text'] || t.artist)) || '',
      track: (t.name || '').trim(),
      playedAt: parseInt(t.date.uts, 10) || 0,
    }))
    .filter(t => t.track && t.playedAt);
}

async function syncLastFm(memberUid, profileUrl, memberTeam) {
  const username = extractLastFmUsername(profileUrl);
  if (!username) return { success: false, status: 'Invalid profile URL' };
  if (!memberUid) return { success: false, status: 'Missing member ID' };

  const nowSec = Math.floor(Date.now() / 1000);
  let peekDoc = await dbGetSyncData(memberUid) || {};
  peekDoc.lastfm = peekDoc.lastfm || {};

  // First-ever connection: time baseline, 0 HP, no historical import —
  // same rule as ListenBrainz.
  if (!peekDoc.lastfm.firstSyncDone) {
    peekDoc.lastfm.profileUrl = profileUrl;
    peekDoc.lastfm.username = username;
    peekDoc.lastfm.lastProcessedTimestamp = nowSec;
    peekDoc.lastfm.verifiedBtsStreams = 0;
    peekDoc.lastfm.streamingHpAwarded = 0;
    peekDoc.lastfm.recentFingerprints = [];
    peekDoc.lastfm.firstSyncDone = true;
    peekDoc.lastfm.lastSync = new Date().toISOString();
    peekDoc.lastfm.status = 'Connected';
    await dbSaveSyncData(memberUid, peekDoc);
    await dbAddNotification('sync', `${username} connected Last.fm (${username}) — baseline set, no historical import`, { memberUid, username });
    if (db) db.collection('streamingHpAudit').add({
      memberUid, username, source: 'lastfm',
      newVerifiedStreams: 0, rejectedStreams: 0, duplicatesIgnored: 0,
      hpBefore: 0, hpAwarded: 0, hpAfter: 0,
      timestamp: new Date().toISOString(), note: 'First connection — baseline set, no historical import',
    }).catch(()=>{});
    return { success: true, firstSync: true, status: 'Connected', earnedHP: 0, newStreams: 0, pending: 0, username, newTracksList: [] };
  }

  // Real per-scrobble data (artist + track + timestamp) since the last
  // processed point — NOT the aggregate playcount, which counts every
  // artist ever scrobbled, not just BTS. This was the exact bug this
  // function had before.
  let listens;
  try {
    listens = await fetchLastFmRecentTracks(username, peekDoc.lastfm.lastProcessedTimestamp || nowSec);
  } catch (e) {
    return { success: false, status: 'Last.fm unavailable' };
  }
  listens.sort((a, b) => a.playedAt - b.playedAt);

  if (!db) return { success: false, status: 'Database not connected — HP cannot be safely awarded right now' };
  const syncRef = db.collection('syncData').doc(memberUid);
  const memberRef = db.collection('members').doc(memberUid);
  let out = null;

  try {
    await db.runTransaction(async (tx) => {
      const syncSnap = await tx.get(syncRef);
      const memberSnap = await tx.get(memberRef);
      const syncDoc = syncSnap.exists ? syncSnap.data() : {};
      syncDoc.lastfm = syncDoc.lastfm || {};
      const member = memberSnap.exists ? memberSnap.data() : {};

      const freshWatermark = syncDoc.lastfm.lastProcessedTimestamp || nowSec;
      const recentFp = new Set(syncDoc.lastfm.recentFingerprints || []);
      let acceptedCount = 0, rejectedCount = 0, duplicateCount = 0;
      const acceptedTracks = [];
      let maxTs = freshWatermark;

      for (const l of listens) {
        if (l.playedAt <= freshWatermark) continue;
        maxTs = Math.max(maxTs, l.playedAt);
        if (!isApprovedBtsArtist(l.artist)) { rejectedCount++; continue; }
        const fp = _streamFingerprint(memberUid, 'lastfm', l.artist, l.track, l.playedAt);
        if (recentFp.has(fp)) { duplicateCount++; continue; }
        recentFp.add(fp);
        acceptedCount++;
        acceptedTracks.push({ name: l.track, artist: l.artist });
      }
      const recentFpArr = Array.from(recentFp).slice(-500);

      const hpBefore = syncDoc.lastfm.streamingHpAwarded || 0;
      const newVerifiedTotal = (syncDoc.lastfm.verifiedBtsStreams || 0) + acceptedCount;
      const newEntitlement = Math.floor(newVerifiedTotal / 10);
      const earned = Math.max(0, newEntitlement - hpBefore);

      syncDoc.lastfm.verifiedBtsStreams = newVerifiedTotal;
      syncDoc.lastfm.streamingHpAwarded = newEntitlement;
      syncDoc.lastfm.lastProcessedTimestamp = maxTs;
      syncDoc.lastfm.recentFingerprints = recentFpArr;
      syncDoc.lastfm.lastSync = new Date().toISOString();
      syncDoc.lastfm.lastNewStreams = acceptedCount;
      syncDoc.lastfm.username = username;
      syncDoc.lastfm.profileUrl = profileUrl;
      syncDoc.lastfm.status = earned > 0 ? 'HP added' : acceptedCount > 0 ? 'Synced' : 'No new streams';

      const oldTotalHp   = member.totalHp || 0;
      const oldTotalStr  = Math.max(member.totalStreams || 0, member.lifetimeStreams || 0);
      const oldWeeklyStr = member.streams || 0;
      const oldWeeklyHp  = member.hp || 0;
      const newWeeklyStr = oldWeeklyStr + acceptedCount;
      const newTotalStr  = Math.max(oldTotalStr + acceptedCount, newWeeklyStr);
      const newWeeklyHp  = oldWeeklyHp + earned;
      const newTotalHp   = Math.max(oldTotalHp + earned, newWeeklyHp);
      const newHpStreaming = (member.hpStreaming || 0) + earned;

      const memberUpdates = {
        streams: newWeeklyStr, weeklyStreams: newWeeklyStr,
        totalStreams: newTotalStr, lifetimeStreams: newTotalStr,
        lastSyncStreams: acceptedCount, streamsCountedThisSync: acceptedCount,
        lastUpdated: new Date().toISOString(),
      };
      if (earned > 0) {
        memberUpdates.hp = newWeeklyHp; memberUpdates.weeklyHp = newWeeklyHp;
        memberUpdates.totalHp = newTotalHp; memberUpdates.hpStreaming = newHpStreaming;
      }

      tx.set(syncRef, { ...syncDoc, username: memberUid }, { merge: true });
      if (acceptedCount > 0 || earned > 0) tx.set(memberRef, memberUpdates, { merge: true });

      out = {
        acceptedCount, rejectedCount, duplicateCount, earned,
        oldTotalHp, newTotalHp, newWeeklyHp, newTotalStr, newWeeklyStr, newHpStreaming,
        pending: newVerifiedTotal % 10, acceptedTracks, status: syncDoc.lastfm.status,
      };
    });
  } catch (e) {
    return { success: false, status: 'Sync failed — please try again' };
  }

  if (out.acceptedCount > 0 || out.earned > 0) {
    await dbAddNotification('stream', `${username}: +${out.acceptedCount} verified BTS streams (Last.fm) → +${out.earned} HP`, { memberUid, username, earned: out.earned, newStreams: out.acceptedCount, team: memberTeam });
  }
  if (db) db.collection('streamingHpAudit').add({
    memberUid, username, source: 'lastfm',
    newVerifiedStreams: out.acceptedCount, rejectedStreams: out.rejectedCount, duplicatesIgnored: out.duplicateCount,
    hpBefore: out.oldTotalHp, hpAwarded: out.earned, hpAfter: out.earned > 0 ? out.newTotalHp : out.oldTotalHp,
    timestamp: new Date().toISOString(),
  }).catch(()=>{});
  if (db && out.earned > 0) {
    const txnId = 'hpt_' + Date.now() + '_' + Math.floor(Math.random()*10000);
    db.collection('hpTransactions').doc(txnId).set({
      transactionId: txnId, memberUid, username, team: memberTeam || '',
      source: 'streaming', amount: out.earned, reason: `Last.fm: ${out.acceptedCount} verified streams`,
      relatedId: null, createdAt: new Date().toISOString(), createdBy: 'system',
    }).catch(()=>{});
  }

  return {
    success: true, firstSync: false, status: out.status, username,
    newStreams: out.acceptedCount, earnedHP: out.earned, pending: out.pending,
    newTracksList: out.acceptedTracks,
    newTotalHp: out.newTotalHp, newWeeklyHp: out.newWeeklyHp, newTotalStreams: out.newTotalStr, newWeeklyStreams: out.newWeeklyStr, newHpStreaming: out.newHpStreaming,
  };
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

  /* ── Admin: delete a member's actual login (Firebase Auth account) ──
     Deleting the Firestore profile alone does NOT free up their email/
     username to sign up again — the login credential itself lives in
     Firebase Authentication, which only the Admin SDK can delete on
     someone else's behalf (the client SDK can only delete your OWN
     currently-signed-in account). This is that missing piece. */
  if (pathname.startsWith('/api/admin/delete-auth-user/') && method === 'DELETE') {
    const targetUid = decodeURIComponent(pathname.replace('/api/admin/delete-auth-user/', ''));
    if (!firebaseReady) return sendJSON(res, 200, { success: false, error: 'Firebase not connected on the backend — delete the login manually in Firebase Console → Authentication instead.' });
    try {
      const admin = require('firebase-admin');
      await admin.auth().deleteUser(targetUid);
      return sendJSON(res, 200, { success: true });
    } catch (e) {
      if (e.code === 'auth/user-not-found') return sendJSON(res, 200, { success: true, note: 'Login was already gone' });
      return sendJSON(res, 200, { success: false, error: e.message });
    }
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

  /* ── SYNC ALL (Last.fm only — ListenBrainz and Webhook are push-based now,
     see /1/submit-listens and /api/webhook/scrobble below; no polling needed) ── */
  if (pathname.startsWith('/api/sync-all/') && method === 'POST') {
    const memberId = decodeURIComponent(pathname.replace('/api/sync-all/', ''));
    try {
      const body = await readBody(req).catch(() => ({}));
      const memberTeam = body.memberTeam || '';
      const memberUid  = body.memberUid || '';
      let lastfmUrl = body.lastfmUrl || '';

      if (!lastfmUrl && memberUid) {
        const syncDoc = await dbGetSyncData(memberUid);
        if (syncDoc?.lastfm?.profileUrl) lastfmUrl = syncDoc.lastfm.profileUrl;
      }
      if (!lastfmUrl || !memberUid) {
        return sendJSON(res, 200, { success: false, status: 'No streaming platform connected' });
      }

      const lastfmResult = await syncLastFm(memberUid, lastfmUrl, memberTeam);

      return sendJSON(res, 200, {
        success: true, lastfm: lastfmResult,
        totalEarnedHP: lastfmResult?.earnedHP || 0,
        newStreams:     lastfmResult?.newStreams || 0,
        firstSync:     lastfmResult?.firstSync || false,
        pending:       lastfmResult?.pending || 0,
        newTracksList: lastfmResult?.newTracksList || [],
        newTotalHp: lastfmResult?.newTotalHp, newWeeklyHp: lastfmResult?.newWeeklyHp,
        newTotalStreams: lastfmResult?.newTotalStreams, newWeeklyStreams: lastfmResult?.newWeeklyStreams,
        newHpStreaming: lastfmResult?.newHpStreaming,
      });
    } catch (e) { return sendJSON(res, 200, { success: false, status: 'Sync temporarily unavailable' }); }
  }

  /* ── ListenBrainz-compatible token validation ──
     Pano Scrobbler's "Verify" button calls this BEFORE letting the
     member save the instance config — matches the real ListenBrainz
     API's /1/validate-token contract exactly, so Pano Scrobbler
     recognizes the response. Without this, Verify always 404s even
     with a correct URL and a real token. */
  if (pathname === '/1/validate-token' && method === 'GET') {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Token\s+/i, '').trim();
    const member = await _findMemberByPin(token);
    if (!member) return sendJSON(res, 200, { code: 200, message: 'Token invalid.', valid: false });
    return sendJSON(res, 200, { code: 200, message: 'Token valid.', valid: true, user_name: member.username });
  }

  /* ── ListenBrainz-compatible listen history (read-back) ──
     Pano Scrobbler's own "Scrobbles" tab calls this to display your
     history back to you — a DIFFERENT feature from actually counting
     streams (that's /1/submit-listens, above, and works independently
     of this). We don't keep a full per-listen log (only dedup
     fingerprints), so this returns a correctly-shaped but currently
     empty response — enough to stop the "not supported" error, but
     Pano Scrobbler's history view won't show real playback history. */
  if (pathname.match(/^\/1\/user\/[^/]+\/listens$/) && method === 'GET') {
    return sendJSON(res, 200, { payload: { count: 0, listens: [], latest_listen_ts: 0 } });
  }

  /* ── ListenBrainz-compatible submission endpoint ──
     Pano Scrobbler (or any ListenBrainz-compatible scrobbler) can be
     pointed at this server as a custom "ListenBrainz-like instance",
     using the member's personal PIN as their Token. Real-time — no
     polling, no third-party ListenBrainz.org account needed. */
  if (pathname === '/1/submit-listens' && method === 'POST') {
    try {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.replace(/^Token\s+/i, '').trim();
      const member = await _findMemberByPin(token);
      if (!member) return sendJSON(res, 401, { code: 401, error: 'Invalid token' });

      const body = await readBody(req).catch(() => ({}));
      if (body.listen_type === 'playing_now') return sendJSON(res, 200, { status: 'ok' }); // not a completed listen

      const payload = Array.isArray(body.payload) ? body.payload : [];
      const scrobbles = payload.map(p => ({
        artist: (p.track_metadata && p.track_metadata.artist_name) || '',
        track: (p.track_metadata && p.track_metadata.track_name) || '',
        playedAt: p.listened_at || 0,
      })).filter(s => s.track && s.playedAt);

      await _processScrobbleBatch(member.uid, member.username, member.team, 'listenbrainz_instance', scrobbles);
      return sendJSON(res, 200, { status: 'ok' });
    } catch (e) {
      return sendJSON(res, 200, { status: 'ok' }); // never break the scrobbler client
    }
  }

  /* ── Web Scrobbler-compatible webhook receiver ──
     Web Scrobbler (browser extension) can send a webhook request on
     scrobble events. IMPORTANT: must always return 200, or Web
     Scrobbler shows a false error to the member. */
  if (pathname === '/api/webhook/scrobble' && method === 'POST') {
    try {
      const pin = parsed.query.pin || '';
      const member = await _findMemberByPin(pin);
      const body = await readBody(req).catch(() => ({}));
      if (member && body && body.eventName === 'scrobble' && body.data) {
        const songsRaw = Array.isArray(body.data.songs) ? body.data.songs : (body.data.song ? [body.data.song] : []);
        const nowSec = Math.floor((body.time || Date.now()) / 1000);
        const scrobbles = songsRaw.map(s => {
          const p = s.processed || {}; const pa = s.parsed || {};
          return { artist: p.artist || pa.artist || '', track: p.track || pa.track || '', playedAt: nowSec };
        }).filter(s => s.track);
        if (scrobbles.length) await _processScrobbleBatch(member.uid, member.username, member.team, 'webhook', scrobbles);
      }
    } catch (e) { /* swallow — must always 200 */ }
    return sendJSON(res, 200, { status: 'ok' }); // ALWAYS 200, per Web Scrobbler's requirement
  }

  /* ── SAVE PROFILES ── */
  if (pathname === '/api/save-profiles' && method === 'POST') {
    try {
      const { memberId, lastfmUrl, memberTeam } = await readBody(req);
      if (!memberId) return sendJSON(res, 400, { success: false });
      const results = {};
      if (lastfmUrl !== undefined) results.lastfm = await syncLastFm(memberId, lastfmUrl, memberTeam || '').catch(() => ({ success: false, status: 'Sync temporarily unavailable' }));
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
