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

/* ── Spotify OAuth (real automatic sync — unlike Stats.fm/Musicat, Spotify's
   Web API is genuinely public and documented) ──
   Requires the site owner to register a free app at
   https://developer.spotify.com/dashboard and set these three env vars. */
const SPOTIFY_CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID || '';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';
const SPOTIFY_REDIRECT_URI  = process.env.SPOTIFY_REDIRECT_URI || '';

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
   OAuth token exchanges (Spotify), which fetchJSON (GET-only) can't do. */
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
  // same rule as ListenBrainz/Spotify.
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

/* ═══════════════════════════════════════════════════════════
   LISTENBRAINZ SYNC — uses ListenBrainz public API
   No API key required for public listen counts.
   ═══════════════════════════════════════════════════════════ */
async function syncListenBrainz(memberUid, username, lbUsername, memberTeam) {
  if (!lbUsername) return { success: false, status: 'No ListenBrainz username' };
  if (!memberUid) return { success: false, status: 'Missing member ID' };

  const nowSec = Math.floor(Date.now() / 1000);

  // Peek at current state (non-transactional) just to know whether this is a
  // first connection and what min_ts to query ListenBrainz with.
  let peekDoc = await dbGetSyncData(memberUid) || {};
  peekDoc.lb = peekDoc.lb || {};

  // First-ever connection: set a TIME baseline and award 0 HP. No historical
  // streams are ever imported — only listens strictly after this moment count.
  // Nothing to race on yet (no prior state), so no transaction needed here.
  if (!peekDoc.lb.firstSyncDone) {
    peekDoc.lb.lastProcessedTimestamp = nowSec;
    peekDoc.lb.verifiedBtsStreams = 0;
    peekDoc.lb.streamingHpAwarded = 0;
    peekDoc.lb.recentFingerprints = [];
    peekDoc.lb.firstSyncDone = true;
    peekDoc.lb.username = lbUsername;
    peekDoc.lb.lastSync = new Date().toISOString();
    peekDoc.lb.status = 'Connected';
    await dbSaveSyncData(memberUid, peekDoc);
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
  // every artist a member has ever scrobbled, not just BTS. This is a plain
  // read-only GET, so it's safe to do outside the transaction below.
  let listens;
  try {
    listens = await fetchListenBrainzListens(lbUsername, peekDoc.lb.lastProcessedTimestamp || nowSec);
  } catch (e) {
    return { success: false, status: 'ListenBrainz unavailable' };
  }
  listens.sort((a, b) => a.playedAt - b.playedAt); // oldest first, so counters advance chronologically

  if (!db) {
    // No Firestore connection — nothing to safely transact against. Bail out
    // rather than risk a non-atomic write against a database that isn't even
    // configured (this also means: if you're seeing "Local file" storage in
    // the server logs, none of this — or any other backend HP logic — is
    // actually reaching your shared database yet).
    return { success: false, status: 'Database not connected — HP cannot be safely awarded right now' };
  }

  // Transaction: two devices syncing the SAME member at the same instant must
  // not both compute HP from the same starting point and award it twice. The
  // transaction re-reads both docs at commit time and Firestore automatically
  // retries this function if a conflicting write happened in between.
  const syncRef = db.collection('syncData').doc(memberUid);
  const memberRef = db.collection('members').doc(memberUid);
  let out = null;

  try {
    await db.runTransaction(async (tx) => {
      const syncSnap = await tx.get(syncRef);
      const memberSnap = await tx.get(memberRef);
      const syncDoc = syncSnap.exists ? syncSnap.data() : {};
      syncDoc.lb = syncDoc.lb || {};
      const member = memberSnap.exists ? memberSnap.data() : {};

      // Only process listens strictly after the CURRENT (transaction-fresh)
      // watermark — if a concurrent sync already advanced it, skip whatever
      // it already handled instead of double-counting.
      const freshWatermark = syncDoc.lb.lastProcessedTimestamp || nowSec;
      const recentFp = new Set(syncDoc.lb.recentFingerprints || []);
      let acceptedCount = 0, rejectedCount = 0, duplicateCount = 0;
      const acceptedTracks = [];
      let maxTs = freshWatermark;

      for (const l of listens) {
        if (l.playedAt <= freshWatermark) continue; // already processed by a concurrent sync
        maxTs = Math.max(maxTs, l.playedAt);
        if (!isApprovedBtsArtist(l.artist)) { rejectedCount++; continue; }
        const fp = _streamFingerprint(memberUid, 'listenbrainz', l.artist, l.track, l.playedAt);
        if (recentFp.has(fp)) { duplicateCount++; continue; }
        recentFp.add(fp);
        acceptedCount++;
        acceptedTracks.push({ name: l.track, artist: l.artist });
      }
      const recentFpArr = Array.from(recentFp).slice(-500);

      // Persistent verified counters — HP entitlement is recomputed from the
      // running verified-stream total, and only the DELTA since the last
      // award is granted (never floor(total/10) re-added every sync).
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
      syncDoc.lb.username = lbUsername;
      syncDoc.lb.status = earned > 0 ? 'HP added' : acceptedCount > 0 ? 'Synced' : 'No new streams';

      // Absolute values — never allowed to decrease.
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
        lastUpdated: new Date().toISOString(), username,
      };
      if (earned > 0) {
        memberUpdates.hp = newWeeklyHp; memberUpdates.weeklyHp = newWeeklyHp;
        memberUpdates.totalHp = newTotalHp; memberUpdates.hpStreaming = newHpStreaming;
      }

      tx.set(syncRef, { ...syncDoc, username: memberUid }, { merge: true });
      if (acceptedCount > 0 || earned > 0) {
        tx.set(memberRef, memberUpdates, { merge: true });
      }

      out = {
        acceptedCount, rejectedCount, duplicateCount, earned,
        oldTotalHp, newTotalHp, newWeeklyHp, newTotalStr, newWeeklyStr, newHpStreaming,
        pending: newVerifiedTotal % 10, acceptedTracks, status: syncDoc.lb.status,
      };
    });
  } catch (e) {
    return { success: false, status: 'Sync failed — please try again' };
  }

  if (out.acceptedCount > 0 || out.earned > 0) {
    await dbAddNotification('stream', `${username}: +${out.acceptedCount} verified BTS streams → +${out.earned} HP`, { memberUid, username, lbUsername, earned: out.earned, newStreams: out.acceptedCount, team: memberTeam });
  }

  // Audit log — every sync call, so incorrect HP changes can be traced
  // instead of silently modifying member totals.
  if (db) db.collection('streamingHpAudit').add({
    memberUid, username, source: 'listenbrainz',
    newVerifiedStreams: out.acceptedCount, rejectedStreams: out.rejectedCount, duplicatesIgnored: out.duplicateCount,
    hpBefore: out.oldTotalHp, hpAwarded: out.earned, hpAfter: out.earned > 0 ? out.newTotalHp : out.oldTotalHp,
    timestamp: new Date().toISOString(),
  }).catch(()=>{});
  // hpTransactions ledger — this is what the Dashboard's HP Earned
  // breakdown actually reads from, so streaming HP must land here too.
  if (db && out.earned > 0) {
    const txnId = 'hpt_' + Date.now() + '_' + Math.floor(Math.random()*10000);
    db.collection('hpTransactions').doc(txnId).set({
      transactionId: txnId, memberUid, username, team: memberTeam || '',
      source: 'streaming', amount: out.earned, reason: `ListenBrainz: ${out.acceptedCount} verified streams`,
      relatedId: null, createdAt: new Date().toISOString(), createdBy: 'system',
    }).catch(()=>{});
  }

  return {
    success: true, firstSync: false, status: out.status, username: lbUsername,
    newStreams: out.acceptedCount, earnedHP: out.earned, pending: out.pending,
    newTracksList: out.acceptedTracks,
    newTotalHp: out.newTotalHp, newWeeklyHp: out.newWeeklyHp, newTotalStreams: out.newTotalStr, newWeeklyStreams: out.newWeeklyStr, newHpStreaming: out.newHpStreaming,
  };
}

/* ════════════════════════════════════════════════════════════
   SPOTIFY — real automatic sync via Spotify's own public Web API
   (unlike Stats.fm/Musicat, which have no independent per-user
   API of their own — they're both just Spotify/Apple Music
   wrappers). Uses the exact same verified-artist / fingerprint /
   transaction pipeline as syncListenBrainz.
   ════════════════════════════════════════════════════════════ */
async function _spotifyRefreshAccessToken(refreshToken) {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) throw new Error('Spotify not configured on the backend');
  const basic = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`;
  const r = await httpRequest('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    body,
  });
  if (r.status !== 200 || !r.data || !r.data.access_token) throw new Error('Spotify token refresh failed');
  return r.data.access_token;
}

async function fetchSpotifyRecentlyPlayed(accessToken, afterMs) {
  const url2 = `https://api.spotify.com/v1/me/player/recently-played?limit=50${afterMs ? '&after=' + afterMs : ''}`;
  const r = await httpRequest(url2, { headers: { 'Authorization': `Bearer ${accessToken}` } });
  if (r.status !== 200 || !r.data || !r.data.items) return [];
  return r.data.items.map(it => ({
    artist: (it.track && it.track.artists && it.track.artists.map(a => a.name).join(', ')) || '',
    track: (it.track && it.track.name) || '',
    playedAt: it.played_at ? Math.floor(new Date(it.played_at).getTime() / 1000) : 0,
  })).filter(l => l.track && l.playedAt);
}

async function syncSpotify(memberUid, username, memberTeam) {
  if (!memberUid) return { success: false, status: 'Missing member ID' };
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) return { success: false, status: 'Spotify not configured on the backend yet' };

  let syncDoc = await dbGetSyncData(memberUid) || {};
  syncDoc.spotify = syncDoc.spotify || {};
  if (!syncDoc.spotify.refreshToken) return { success: false, status: 'Spotify not connected' };

  const nowSec = Math.floor(Date.now() / 1000);
  if (!syncDoc.spotify.firstSyncDone) {
    syncDoc.spotify.lastProcessedTimestamp = nowSec;
    syncDoc.spotify.verifiedBtsStreams = 0;
    syncDoc.spotify.streamingHpAwarded = 0;
    syncDoc.spotify.recentFingerprints = [];
    syncDoc.spotify.firstSyncDone = true;
    syncDoc.spotify.lastSync = new Date().toISOString();
    syncDoc.spotify.status = 'Connected';
    await dbSaveSyncData(memberUid, syncDoc);
    if (db) db.collection('streamingHpAudit').add({
      memberUid, username, source: 'spotify', newVerifiedStreams: 0, rejectedStreams: 0, duplicatesIgnored: 0,
      hpBefore: 0, hpAwarded: 0, hpAfter: 0, timestamp: new Date().toISOString(), note: 'First connection — baseline set, no historical import',
    }).catch(()=>{});
    return { success: true, firstSync: true, status: 'Connected', earnedHP: 0, newStreams: 0, pending: 0, newTracksList: [] };
  }

  let listens;
  try {
    const accessToken = await _spotifyRefreshAccessToken(syncDoc.spotify.refreshToken);
    listens = await fetchSpotifyRecentlyPlayed(accessToken, (syncDoc.spotify.lastProcessedTimestamp || nowSec) * 1000);
  } catch (e) {
    return { success: false, status: 'Spotify sync failed: ' + e.message };
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
      const sDoc = syncSnap.exists ? syncSnap.data() : {};
      sDoc.spotify = sDoc.spotify || {};
      const member = memberSnap.exists ? memberSnap.data() : {};

      const freshWatermark = sDoc.spotify.lastProcessedTimestamp || nowSec;
      const recentFp = new Set(sDoc.spotify.recentFingerprints || []);
      let acceptedCount = 0, rejectedCount = 0, duplicateCount = 0;
      const acceptedTracks = [];
      let maxTs = freshWatermark;

      for (const l of listens) {
        if (l.playedAt <= freshWatermark) continue;
        maxTs = Math.max(maxTs, l.playedAt);
        if (!isApprovedBtsArtist(l.artist)) { rejectedCount++; continue; }
        const fp = _streamFingerprint(memberUid, 'spotify', l.artist, l.track, l.playedAt);
        if (recentFp.has(fp)) { duplicateCount++; continue; }
        recentFp.add(fp);
        acceptedCount++;
        acceptedTracks.push({ name: l.track, artist: l.artist });
      }
      const recentFpArr = Array.from(recentFp).slice(-500);

      const hpBefore = sDoc.spotify.streamingHpAwarded || 0;
      const newVerifiedTotal = (sDoc.spotify.verifiedBtsStreams || 0) + acceptedCount;
      const newEntitlement = Math.floor(newVerifiedTotal / 10);
      const earned = Math.max(0, newEntitlement - hpBefore);

      sDoc.spotify.verifiedBtsStreams = newVerifiedTotal;
      sDoc.spotify.streamingHpAwarded = newEntitlement;
      sDoc.spotify.lastProcessedTimestamp = maxTs;
      sDoc.spotify.recentFingerprints = recentFpArr;
      sDoc.spotify.lastSync = new Date().toISOString();
      sDoc.spotify.lastNewStreams = acceptedCount;
      sDoc.spotify.status = earned > 0 ? 'HP added' : acceptedCount > 0 ? 'Synced' : 'No new streams';

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

      tx.set(syncRef, { ...sDoc, username: memberUid }, { merge: true });
      if (acceptedCount > 0 || earned > 0) tx.set(memberRef, memberUpdates, { merge: true });

      out = {
        acceptedCount, rejectedCount, duplicateCount, earned,
        oldTotalHp, newTotalHp, newWeeklyHp, newTotalStr, newWeeklyStr, newHpStreaming,
        pending: newVerifiedTotal % 10, acceptedTracks, status: sDoc.spotify.status,
      };
    });
  } catch (e) {
    return { success: false, status: 'Sync failed — please try again' };
  }

  if (out.acceptedCount > 0 || out.earned > 0) {
    await dbAddNotification('stream', `${username}: +${out.acceptedCount} verified BTS streams (Spotify) → +${out.earned} HP`, { memberUid, username, earned: out.earned, newStreams: out.acceptedCount, team: memberTeam });
  }
  if (db) db.collection('streamingHpAudit').add({
    memberUid, username, source: 'spotify',
    newVerifiedStreams: out.acceptedCount, rejectedStreams: out.rejectedCount, duplicatesIgnored: out.duplicateCount,
    hpBefore: out.oldTotalHp, hpAwarded: out.earned, hpAfter: out.earned > 0 ? out.newTotalHp : out.oldTotalHp,
    timestamp: new Date().toISOString(),
  }).catch(()=>{});
  if (db && out.earned > 0) {
    const txnId = 'hpt_' + Date.now() + '_' + Math.floor(Math.random()*10000);
    db.collection('hpTransactions').doc(txnId).set({
      transactionId: txnId, memberUid, username, team: memberTeam || '',
      source: 'streaming', amount: out.earned, reason: `Spotify: ${out.acceptedCount} verified streams`,
      relatedId: null, createdAt: new Date().toISOString(), createdBy: 'system',
    }).catch(()=>{});
  }

  return {
    success: true, firstSync: false, status: out.status,
    newStreams: out.acceptedCount, earnedHP: out.earned, pending: out.pending,
    newTracksList: out.acceptedTracks,
    newTotalHp: out.newTotalHp, newWeeklyHp: out.newWeeklyHp, newTotalStreams: out.newTotalStr, newWeeklyStreams: out.newWeeklyStr, newHpStreaming: out.newHpStreaming,
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

  /* ── Spotify OAuth: step 1 — build the URL the frontend redirects to ── */
  if (pathname === '/api/spotify/auth-url' && method === 'GET') {
    if (!SPOTIFY_CLIENT_ID || !SPOTIFY_REDIRECT_URI) {
      return sendJSON(res, 200, { success: false, error: 'Spotify is not configured on the backend yet. Set SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, and SPOTIFY_REDIRECT_URI.' });
    }
    const memberUid = parsed.query.memberUid || '';
    if (!memberUid) return sendJSON(res, 200, { success: false, error: 'Missing member ID' });
    const params = new url.URLSearchParams({
      client_id: SPOTIFY_CLIENT_ID,
      response_type: 'code',
      redirect_uri: SPOTIFY_REDIRECT_URI,
      scope: 'user-read-recently-played',
      state: memberUid,
    });
    return sendJSON(res, 200, { success: true, url: `https://accounts.spotify.com/authorize?${params.toString()}` });
  }

  /* ── Spotify OAuth: step 2 — Spotify redirects the user's browser here ── */
  if (pathname === '/api/spotify/callback' && method === 'GET') {
    const code = parsed.query.code;
    const memberUid = parsed.query.state;
    const FRONTEND_URL = process.env.FRONTEND_URL || 'https://zer0clock.netlify.app';
    if (!code || !memberUid) {
      res.writeHead(302, { Location: `${FRONTEND_URL}/?spotify=error` }); return res.end();
    }
    try {
      const basic = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
      const body = `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(SPOTIFY_REDIRECT_URI)}`;
      const r = await httpRequest('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
        body,
      });
      if (r.status !== 200 || !r.data || !r.data.refresh_token) {
        res.writeHead(302, { Location: `${FRONTEND_URL}/?spotify=error` }); return res.end();
      }
      const syncDoc = await dbGetSyncData(memberUid) || {};
      syncDoc.spotify = { ...(syncDoc.spotify||{}), refreshToken: r.data.refresh_token, connectedAt: new Date().toISOString() };
      await dbSaveSyncData(memberUid, syncDoc);
      // Mark connected on the member doc too, so Dashboard/Profile/Admin all see it immediately
      if (db) await db.collection('members').doc(memberUid).update({ spotify: { connected: true, connectedAt: new Date().toISOString() } }).catch(()=>{});
      res.writeHead(302, { Location: `${FRONTEND_URL}/?spotify=connected` }); return res.end();
    } catch (e) {
      res.writeHead(302, { Location: `${FRONTEND_URL}/?spotify=error` }); return res.end();
    }
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
      const memberTeam = body.memberTeam || '';
      const memberUid  = body.memberUid || '';
      const wantsSpotify = !!body.spotifyConnected;
      let lastfmUrl = body.lastfmUrl || '';
      let lbResult = null, spotifyResult = null, lastfmResult = null;

      if (lbUsername) {
        if (!memberUid) return sendJSON(res, 200, { success: false, status: 'Missing member ID — please refresh and try again' });
        lbResult = await syncListenBrainz(memberUid, memberId, lbUsername, memberTeam);
      }
      if (wantsSpotify && memberUid) {
        // Runs after ListenBrainz so its transaction reads the freshest
        // member state — the absolute totals it returns already include
        // both awards, never double-counted.
        spotifyResult = await syncSpotify(memberUid, memberId, memberTeam);
      }
      // Fall back to the saved Last.fm profile if none was passed explicitly
      if (!lastfmUrl && memberUid) {
        const syncDoc = await dbGetSyncData(memberUid);
        if (syncDoc?.lastfm?.profileUrl) lastfmUrl = syncDoc.lastfm.profileUrl;
      }
      if (lastfmUrl && memberUid) {
        // Runs last — reads whatever ListenBrainz/Spotify already wrote.
        lastfmResult = await syncLastFm(memberUid, lastfmUrl, memberTeam);
      }

      if (!lbResult && !spotifyResult && !lastfmResult) {
        return sendJSON(res, 200, { success: false, status: 'No streaming platform connected' });
      }

      const final = lastfmResult || spotifyResult || lbResult; // whichever ran last reflects the cumulative absolute totals
      const combinedEarned = (lbResult?.earnedHP||0) + (spotifyResult?.earnedHP||0) + (lastfmResult?.earnedHP||0);
      const combinedStreams = (lbResult?.newStreams||0) + (spotifyResult?.newStreams||0) + (lastfmResult?.newStreams||0);
      const combinedTracks = [...(lbResult?.newTracksList||[]), ...(spotifyResult?.newTracksList||[]), ...(lastfmResult?.newTracksList||[])];

      return sendJSON(res, 200, {
        success: true, lastfm: lastfmResult, spotify: spotifyResult, listenbrainz: lbResult,
        totalEarnedHP: combinedEarned,
        newStreams:     combinedStreams,
        firstSync:     lbResult?.firstSync || spotifyResult?.firstSync || lastfmResult?.firstSync || false,
        pending:       final?.pending || 0,
        newTracksList: combinedTracks,
        newTotalHp: final?.newTotalHp, newWeeklyHp: final?.newWeeklyHp,
        newTotalStreams: final?.newTotalStreams, newWeeklyStreams: final?.newWeeklyStreams,
        newHpStreaming: final?.newHpStreaming,
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
