const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
(async()=>{
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      objective TEXT,
      nextAction TEXT,
      strategy TEXT,
      hypothesis TEXT,
      constraints TEXT,
      success TEXT,
      dueDate TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_projects_name ON projects(name);
    CREATE TABLE updates (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      type TEXT NOT NULL,
      text TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX idx_updates_projectId_createdAt ON updates(projectId, createdAt DESC);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE INDEX idx_tasks_projectId_status ON tasks(projectId, status);
  `);
  const now = Date.now();
  const projects = [
    ['p_3gki2vfe','GoatPort (SaaS)'],
    ['p_16sum6em','Global Coder (Bujumbura center launch 2026)'],
    ['p_31di6lub','OCI - Grants Pipeline'],
    ['p_lqoa1z49','OCI - Donor Outreach / Major Donors'],
    ['p_arhdia2h','OCI - Church Outreach (Harvest Week 2026)'],
    ['p_pydtdz2k','OCI - Burundi Medical Camp / Harvest Week 2026 Ops'],
    ['p_69a7ovfm','OCI - Sponsorship Program Growth'],
    ['p_mx50jp79','OpenClaw Automation System'],
    ['p_p6tnrgyv','OpenClaw Project Dashboard (this plugin)'],
  ];
  for (const [id,name] of projects){
    db.run(`INSERT INTO projects (id,name,status,objective,nextAction,strategy,hypothesis,constraints,success,dueDate,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,[
      id,
      name,
      'green',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      now,
      now,
    ]);
    db.run(`INSERT INTO updates (id,projectId,type,text,createdAt) VALUES (?,?,?,?,?)`,[
      `u_${Math.random().toString(36).slice(2,10)}`,
      id,
      'note',
      'Baseline created. Next: add objective, next action, and first real update.',
      now,
    ]);
  }
  const data = db.export();
  const outPath = 'C:/Users/boydz/.openclaw/project-dashboard.sqlite';
  fs.writeFileSync(outPath, Buffer.from(data));
  console.log('Wrote', outPath);
})();
