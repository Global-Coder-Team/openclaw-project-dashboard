const fs = require('fs');
const initSqlJs = require('sql.js');
const dbPath = 'C:/Users/boydz/.openclaw/project-dashboard.sqlite';
(async()=>{
  if (!fs.existsSync(dbPath)) {
    console.error('DB not found at', dbPath);
    process.exit(1);
  }
  const SQL = await initSqlJs();
  const buf = fs.readFileSync(dbPath);
  const db = new SQL.Database(new Uint8Array(buf));
  const cols = [];
  const stmt = db.prepare('PRAGMA table_info(projects)');
  while (stmt.step()) cols.push(stmt.getAsObject().name);
  stmt.free();
  const need = ['strategy','hypothesis','constraints','success'];
  let changed = false;
  for (const c of need) {
    if (!cols.includes(c)) {
      db.run(`ALTER TABLE projects ADD COLUMN ${c} TEXT`);
      changed = true;
      console.log('Added column', c);
    }
  }
  if (changed) {
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
    console.log('DB updated');
  } else {
    console.log('No changes needed');
  }
})();
