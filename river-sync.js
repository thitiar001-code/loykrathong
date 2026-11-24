// river-sync.js: the GitHub Pages copy of the page talks to Firebase instead of claude.ai.
// It gives the page the same small API it uses on claude.ai (window.claude.use('db' | 'user' |
// 'room' | 'downloads')), backed by Firebase Realtime Database and anonymous sign-in.
// Loaded as a module before the page's own module, so window.claude exists when the page starts.
// Everyone gets a quiet anonymous id kept in their browser; the site owner opens the page with
// ?admin and signs in with Google once to moderate (their uid goes under admins/ in the database).
const V = 'https://www.gstatic.com/firebasejs/10.12.2/';
const downloads = { // save a picture: a plain browser download
  async save({ filename, data }) {
    const url = URL.createObjectURL(data), a = document.createElement('a');
    a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  },
};
// the page asks for parts as soon as it starts; every ask waits until Firebase is up (or gave up)
let real = null;
const cfg = window.FIREBASE_CONFIG;
const started = cfg?.apiKey && !String(cfg.apiKey).startsWith('PASTE')
  ? start().catch(e => console.warn('[river-sync] Firebase did not start; wishes stay on this screen', e))
  : Promise.resolve();
window.claude = {
  use: async name => {
    if (name === 'downloads') return downloads;
    await started;
    return real ? real(name) : null;
  },
};

async function start() {
  const [{ initializeApp }, A, D] = await Promise.all([
    import(V + 'firebase-app.js'), import(V + 'firebase-auth.js'), import(V + 'firebase-database.js')]);
  const app = initializeApp(cfg);
  // no popup/redirect machinery at start-up (it loads an iframe and stalls sign-in); only ?admin needs it
  const auth = A.initializeAuth(app, { persistence: [A.indexedDBLocalPersistence, A.browserLocalPersistence] });
  const rtdb = D.getDatabase(app);
  const adminMode = new URLSearchParams(location.search).has('admin');

  // --- who you are: anonymous by default, kept across visits in this browser
  const ready = new Promise((resolve, reject) => { // no deadline: a slow phone still gets there
    A.onAuthStateChanged(auth, u => {
      if (u) { resolve(u); return; }
      A.signInAnonymously(auth).catch(reject);
    });
  });

  // --- the database, shaped like the claude.ai one: doc(path) and collection(name)
  const clean = v => JSON.parse(JSON.stringify(v)); // the database refuses undefined
  const asDoc = s => ({ id: s.key, exists: s.exists(), data: () => (s.exists() ? s.val() : undefined) });
  const db = {
    doc(path) {
      const r = D.ref(rtdb, path);
      return {
        get: async () => asDoc(await D.get(r)),
        set: async data => D.set(r, clean(data)),
        onSnapshot: (cb, err) => D.onValue(r, s => cb(asDoc(s)), e => err?.(e)),
      };
    },
    collection(name) {
      const r = D.ref(rtdb, name);
      return {
        onSnapshot(cb, err) { // one download at the start, then only what changed
          const docs = new Map(); let loaded = false, t = 0;
          const emit = () => { clearTimeout(t); t = setTimeout(() => cb({ docs: [...docs.values()], metadata: { fromCache: false } }), 80); };
          const up = s => { docs.set(s.key, asDoc(s)); if (loaded) emit(); };
          const rm = s => { docs.delete(s.key); if (loaded) emit(); };
          const fail = e => err?.(e);
          const offs = [D.onChildAdded(r, up, fail), D.onChildChanged(r, up, fail), D.onChildRemoved(r, rm, fail)];
          D.get(r).then(() => { loaded = true; emit(); }, fail);
          return () => offs.forEach(off => off());
        },
      };
    },
  };

  const user = {
    id: async () => (await ready).uid,
    can: async () => true,
    canEdit: async () => { // the owner: their uid is listed under admins/ (added once in the Firebase console)
      const u = await ready;
      if (u.isAnonymous) return false;
      try { return !!(await D.get(D.ref(rtdb, 'admins/' + u.uid))).val(); } catch { return false; }
    },
  };

  // --- who is here now: one entry per open tab, gone when the tab closes
  const tab = Math.random().toString(36).slice(2, 10);
  let offset = 0; D.onValue(D.ref(rtdb, '.info/serverTimeOffset'), s => { offset = s.val() || 0; });
  let lastState = {};
  const room = {
    async presence(state) {
      lastState = state || {};
      const u = await ready, r = D.ref(rtdb, `presence/${u.uid}/${tab}`);
      D.onDisconnect(r).remove();
      await D.set(r, { ...clean(lastState), t: D.serverTimestamp() });
    },
    onPeers(cb, err) {
      ready.then(u => {
        D.onValue(D.ref(rtdb, 'presence'), s => {
          const now = Date.now() + offset, peers = [];
          s.forEach(person => { // count a person once, if any of their tabs spoke in the last 5 minutes
            let alive = false;
            person.forEach(t => { if (now - (t.val()?.t || 0) < 5 * 60e3) alive = true; });
            if (alive) peers.push({ kind: 'viewer', peer: person.key, isMe: person.key === u.uid, sameTab: person.key === u.uid });
          });
          cb({ peers });
        }, e => err?.(e));
      }, e => err?.(e));
    },
  };
  setInterval(() => room.presence(lastState).catch(() => {}), 2 * 60e3); // keep my entry fresh

  const parts = { db, user, room };
  real = async name => {
    try { await ready; } catch (e) { console.warn('[river-sync] sign-in failed', e); return null; }
    return parts[name] ?? null;
  };
  // for checking the setup from the browser console; the config is public anyway
  window.__riverSync = { auth, rtdb, D, uid: () => auth.currentUser?.uid };

  if (adminMode) adminBox(auth, A);
}

// --- ?admin: sign in with Google, then show the uid to put under admins/ in the console
function adminBox(auth, A) {
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;z-index:99;left:12px;bottom:12px;max-width:min(420px,calc(100% - 24px));padding:14px 16px;border-radius:16px;background:rgba(10,14,40,.92);color:#fff;font:14px/1.6 Mitr,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.5)';
  const show = u => {
    box.innerHTML = '';
    if (!u || u.isAnonymous) {
      const b = document.createElement('button');
      b.textContent = 'เข้าสู่ระบบผู้ดูแลด้วย Google';
      b.style.cssText = 'font:inherit;padding:8px 16px;border-radius:999px;border:0;background:#ffb45a;color:#2b1400;cursor:pointer';
      b.onclick = () => A.signInWithPopup(auth, new A.GoogleAuthProvider(), A.browserPopupRedirectResolver)
        .catch(e => alert('เข้าสู่ระบบไม่สำเร็จ: ' + e.message));
      box.append('โหมดผู้ดูแล ', b);
      return;
    }
    box.innerHTML = 'รหัสผู้ดูแล (uid) ของคุณ:<br><code style="user-select:all;word-break:break-all;color:#ffd29a"></code><br><small>ใส่รหัสนี้ใน Firebase ตามขั้นตอน แล้วรีเฟรชหน้า แท็บ "ดูแล" จะขึ้นในหน้าคำอวยพรทั้งหมด</small>';
    box.querySelector('code').textContent = u.uid;
  };
  A.onAuthStateChanged(auth, show);
  document.body.append(box);
}
