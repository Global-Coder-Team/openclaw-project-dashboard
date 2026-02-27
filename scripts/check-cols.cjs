const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
(async()=>{
  const buf = fs.readFileSync('C:/Users/boydz/.openclaw/project-dashboard.sqlite');
  const SQL = await initSqlJs();
  const db = new SQL.Database(new Uint8Array(buf));
  const stmt = db.prepare("PRAGMA table_info(projects)");
  while(stmt.step()){
    console.log(stmt.getAsObject());
  }
  stmt.free();
})();
