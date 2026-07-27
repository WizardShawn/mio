/**
 * One-off diagnostic — read the desktop assistant's SQLite DB and dump
 * the current state of every memory subsystem (sessions, messages,
 * memory_entries, message_vectors, session_compactions). Useful when
 * the operator reports "she doesn't remember" — lets us see exactly
 * what the persistence layer has on disk vs what's actually replayed
 * into the prompt.
 *
 * Run with: ./node_modules/.bin/electron scripts/inspect-memory.js
 */
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const fmt = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

// Match production app name so we read the real user-data folder
// (`%APPDATA%/cortana-desktop-assistant`), not the bare-Electron default.
app.setName('cortana-desktop-assistant');
app.setPath('userData', path.join(app.getPath('appData'), 'cortana-desktop-assistant'));

// Headless — never show a window, exit when the inspection finishes.
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('headless');

const outPath = path.join(process.cwd(), 'scripts', 'inspect-memory.out.txt');
const sink = fs.createWriteStream(outPath, { flags: 'w' });
const out = (line = '') => sink.write(line + '\n');

const origLog = console.log;
console.log = (...args) => {
  origLog(...args);
  out(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
};

app.whenReady().then(() => {
  const dbPath = path.join(app.getPath('userData'), 'cortana.sqlite');
  console.log('DB:', dbPath);
  console.log('');

  const db = new Database(dbPath, { readonly: true });

  const prefsPath = path.join(app.getPath('userData'), 'user-preferences.json');
  let activeId = null;
  try {
    const prefs = JSON.parse(require('node:fs').readFileSync(prefsPath, 'utf8'));
    activeId = prefs.activeSessionId;
    console.log('Active session id (from prefs):', activeId);
  } catch (e) {
    console.log('Could not read user prefs:', e.message);
  }
  console.log('');

  console.log('--- SESSIONS ---');
  const sessions = db.prepare(`
    SELECT id, title, created_at, updated_at,
           (SELECT COUNT(*) FROM messages m WHERE m.session_id = sessions.id) AS msg_count,
           (SELECT COUNT(*) FROM message_vectors v WHERE v.session_id = sessions.id) AS vec_count
      FROM sessions
     ORDER BY updated_at DESC
  `).all();
  for (const s of sessions) {
    const isActive = s.id === activeId ? ' [ACTIVE]' : '';
    console.log(`${isActive} ${s.id}`);
    console.log(`   title:     ${s.title}`);
    console.log(`   created:   ${fmt(s.created_at)}`);
    console.log(`   updated:   ${fmt(s.updated_at)}`);
    console.log(`   messages:  ${s.msg_count}`);
    console.log(`   vectors:   ${s.vec_count}`);
  }
  console.log('');

  if (activeId) {
    console.log('--- MESSAGES (active session, ALL — oldest first) ---');
    const msgs = db.prepare(`
      SELECT id, role, substr(content, 1, 240) AS preview, created_at,
             length(content) AS clen,
             (images_json IS NOT NULL) AS has_images
        FROM messages
       WHERE session_id = ?
       ORDER BY created_at ASC, id ASC
    `).all(activeId);
    for (const m of msgs) {
      const img = m.has_images ? ' [+img]' : '';
      console.log(`[${m.id}] ${fmt(m.created_at)} ${m.role} (${m.clen} chars)${img}`);
      console.log(`     ${m.preview.replace(/\s+/g, ' ').trim()}`);
    }
    console.log('');
    const total = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE session_id = ?').get(activeId).c;
    console.log(`Total messages in active session: ${total}`);
    console.log('');

    console.log('--- COMPACTION (active session) ---');
    const comp = db.prepare(`
      SELECT summary, covered_through_id, message_count, updated_at
        FROM session_compactions
       WHERE session_id = ?
    `).get(activeId);
    if (!comp) {
      console.log('(no compaction row)');
    } else {
      console.log(`covered_through_id: ${comp.covered_through_id}`);
      console.log(`message_count:      ${comp.message_count}`);
      console.log(`updated:            ${fmt(comp.updated_at)}`);
      console.log(`summary:\n${comp.summary}`);
    }
    console.log('');
  }

  console.log('--- MEMORY ENTRIES (cycle observations, newest 20) ---');
  const memCount = db.prepare('SELECT COUNT(*) AS c FROM memory_entries').get().c;
  console.log(`Total entries: ${memCount}`);
  const entries = db.prepare(`
    SELECT id, notable, substr(summary, 1, 200) AS preview, created_at
      FROM memory_entries
     ORDER BY created_at DESC
     LIMIT 20
  `).all();
  for (const e of entries) {
    console.log(`[${e.id}] ${fmt(e.created_at)} notable=${e.notable}`);
    console.log(`     ${e.preview.replace(/\s+/g, ' ').trim()}`);
  }
  console.log('');

  console.log('--- VECTORS ---');
  const vecCounts = db.prepare(`
    SELECT session_id, COUNT(*) AS c, MIN(created_at) AS oldest, MAX(created_at) AS newest
      FROM message_vectors
     GROUP BY session_id
  `).all();
  for (const v of vecCounts) {
    const isActive = v.session_id === activeId ? ' [ACTIVE]' : '';
    console.log(`${isActive} session ${v.session_id}: ${v.c} vectors, oldest=${fmt(v.oldest)}, newest=${fmt(v.newest)}`);
  }
  console.log('');

  console.log('--- TABLE COUNTS ---');
  const tables = ['sessions', 'messages', 'memory_entries', 'message_vectors', 'session_compactions', 'generated_images', 'agent_counters'];
  for (const t of tables) {
    try {
      const c = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
      console.log(`  ${t}: ${c}`);
    } catch (e) {
      console.log(`  ${t}: (missing — ${e.message})`);
    }
  }

  db.close();
  sink.end(() => app.exit(0));
});

app.on('window-all-closed', () => {
  app.exit(0);
});
