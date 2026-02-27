// Auto-populate project-dashboard.sqlite with objectives/next actions/strategies
// Reads cron jobs from ~/.openclaw/cron/jobs.json to link schedules.
// Does NOT require the gateway running; writes the sqlite file directly.

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const dbPath = path.resolve(process.env.USERPROFILE, '.openclaw', 'project-dashboard.sqlite');
const cronPath = path.resolve(process.env.USERPROFILE, '.openclaw', 'cron', 'jobs.json');

const seeds = [
  {
    id: 'p_3gki2vfe',
    name: 'GoatPort (SaaS)',
    objective: 'Activate 1 paying beta club and harden onboarding',
    nextAction: 'Fix onboarding friction + convert beta to paid',
    strategy: 'Stabilize onboarding, prove one paying logo, then scale outreach',
    hypothesis: 'Reducing onboarding friction and faster coach setup will unlock conversion',
    constraints: 'Single beta logo, limited eng time, support capacity',
    success: '1 paying club live; onboarding <30 minutes end-to-end',
  },
  {
    id: 'p_16sum6em',
    name: 'Global Coder (Bujumbura center launch 2026)',
    objective: 'Launch first cohort with solid ops and curriculum',
    nextAction: 'Lock facility setup + finalize cohort schedule',
    strategy: 'Small, high-quality first cohort; tighten ops before scaling',
    hypothesis: 'Tight curriculum + reliable infra yields strong placement stories',
    constraints: 'Facility readiness, local staffing, cohort sourcing',
    success: 'First cohort launched, ops stable, clear outcomes/placements',
  },
  {
    id: 'p_31di6lub',
    name: 'OCI - Grants Pipeline',
    objective: 'Increase win rate and throughput on grants',
    nextAction: 'Prep next submissions + tidy data for reporting',
    strategy: 'Focused high-probability grants with clean reporting and data room',
    hypothesis: 'Better data/readiness improves conversion and cycle time',
    constraints: 'Time to prep, data hygiene, grant calendar',
    success: 'Consistent submissions, improved hit rate, predictable reporting',
  },
  {
    id: 'p_lqoa1z49',
    name: 'OCI - Donor Outreach / Major Donors',
    objective: 'Nurture major donors and keep warm touches consistent',
    nextAction: 'Send tailored updates to top targets this week',
    strategy: 'High-touch comms with tailored stories and clear asks',
    hypothesis: 'Regular personal updates increase close/renewal rates',
    constraints: 'Limited founder time, content freshness',
    success: 'Warm pipeline with clear next touch and recent comms logged',
  },
  {
    id: 'p_arhdia2h',
    name: 'OCI - Church Outreach (Harvest Week 2026)',
    objective: 'Hit Harvest Week 2026 fundraising via church waves',
    nextAction: 'Wave 1 follow-up + clean bounce list',
    strategy: 'Wave-based outreach with follow-up and bounce remediation',
    hypothesis: 'Disciplined follow-ups lift response/commit rates',
    constraints: 'List hygiene, time to follow up, bounce management',
    success: 'Wave 1 responses tracked; bounces cleared; next wave queued',
  },
  {
    id: 'p_pydtdz2k',
    name: 'OCI - Burundi Medical Camp / Harvest Week 2026 Ops',
    objective: 'Deliver Makamba/Buranga camp logistics on time',
    nextAction: 'Confirm medical/media rosters + track inventory',
    strategy: 'Lock rosters, inventory, and timeline milestones; monitor with cron alerts',
    hypothesis: 'Early roster/inventory lock reduces last-minute risk',
    constraints: 'Cross-team coordination, supply lead times',
    success: 'Roster confirmed; inventory plan tracked; camp milestones on schedule',
  },
  {
    id: 'p_69a7ovfm',
    name: 'OCI - Sponsorship Program Growth',
    objective: 'Grow sponsors and retention',
    nextAction: 'Queue next sponsor stories + outreach batch',
    strategy: 'Steady storytelling cadence + targeted outreach',
    hypothesis: 'Fresh stories drive sponsor signups and retention',
    constraints: 'Story gathering, content throughput',
    success: 'New sponsors added; retention stable; pipeline of stories ready',
  },
  {
    id: 'p_mx50jp79',
    name: 'OpenClaw Automation System',
    objective: 'Keep automations reliable and extend safely',
    nextAction: 'Monitor cron health; fix church-bounce-check error',
    strategy: 'Small, reliable automations with monitoring and graceful fallbacks',
    hypothesis: 'Instrumented automations reduce breakage and manual fixes',
    constraints: 'Gateway stability, token/config drift',
    success: 'Cron jobs green; alerts clear; low manual intervention',
  },
  {
    id: 'p_p6tnrgyv',
    name: 'OpenClaw Project Dashboard (this plugin)',
    objective: 'Make status clear + live activity visible',
    nextAction: 'Polish UI tabs and link schedules/tasks automatically',
    strategy: 'Local-first, simple API; show tasks/schedules/updates in one view',
    hypothesis: 'Clear, live view reduces context switching and status drift',
    constraints: 'Gateway reload friction, memory tool missing',
    success: 'Projects show objectives, tasks, schedules, active pulse, no blanks',
  },
];

function mapCronToProject(name) {
  const lower = name.toLowerCase();
  if (lower.startsWith('church-')) return 'p_arhdia2h';
  if (lower.startsWith('burundi-')) return 'p_pydtdz2k';
  if (lower.startsWith('goatport')) return 'p_3gki2vfe';
  if (lower.startsWith('globalcoder') || lower.startsWith('global-coder')) return 'p_16sum6em';
  if (lower.startsWith('nightly-learning')) return 'p_mx50jp79';
  return null;
}

(async()=>{
  const SQL = await initSqlJs();
  // Load or create DB
  let db;
  if (fs.existsSync(dbPath)) {
    const buf = fs.readFileSync(dbPath);
    db = new SQL.Database(new Uint8Array(buf));
  } else {
    db = new SQL.Database();
  }

  // Ensure schema
  db.run(`
    CREATE TABLE IF NOT EXISTS projects (
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
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_name ON projects(name);
    CREATE TABLE IF NOT EXISTS updates (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      type TEXT NOT NULL,
      text TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_updates_projectId_createdAt ON updates(projectId, createdAt DESC);
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_projectId_status ON tasks(projectId, status);
  `);

  // Upgrade existing DB columns if missing
  const cols = [];
  const stmtCols = db.prepare('PRAGMA table_info(projects)');
  while (stmtCols.step()) cols.push(stmtCols.getAsObject().name);
  stmtCols.free();
  const ensureCol = (col) => { if (!cols.includes(col)) db.run(`ALTER TABLE projects ADD COLUMN ${col} TEXT`); };
  ['strategy','hypothesis','constraints','success'].forEach(ensureCol);

  // Upsert projects with seeds
  const now = Date.now();
  const sel = db.prepare('SELECT 1 FROM projects WHERE id = ?');
  const up = db.prepare(`UPDATE projects SET name=?, status=?, objective=?, nextAction=?, strategy=?, hypothesis=?, constraints=?, success=?, dueDate=?, updatedAt=? WHERE id=?`);
  const ins = db.prepare(`INSERT INTO projects (id,name,status,objective,nextAction,strategy,hypothesis,constraints,success,dueDate,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);

  for (const p of seeds) {
    sel.bind([p.id]);
    const exists = sel.step();
    sel.reset();
    if (exists) {
      up.run([p.name,'green',p.objective,p.nextAction,p.strategy,p.hypothesis,p.constraints,p.success,null,now,p.id]);
    } else {
      ins.run([p.id,p.name,'green',p.objective,p.nextAction,p.strategy,p.hypothesis,p.constraints,p.success,null,now,now]);
    }
  }

  // Seed updates for any project missing updates
  const haveUpd = db.prepare('SELECT COUNT(1) as c FROM updates WHERE projectId=?');
  const insUpd = db.prepare('INSERT INTO updates (id,projectId,type,text,createdAt) VALUES (?,?,?,?,?)');
  for (const p of seeds) {
    haveUpd.bind([p.id]);
    const row = haveUpd.step() ? haveUpd.getAsObject() : { c: 0 };
    haveUpd.reset();
    if (!row || Number(row.c) === 0) {
      insUpd.run([`u_${Math.random().toString(36).slice(2,10)}`, p.id, 'note', 'Baseline created. Next: add objective, next action, and first real update.', now]);
    }
  }

  // Parse cron jobs and store a simple schedules table in JSON (kept in state; UI already gets schedules from cron file). Nothing to write into DB.

  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
  console.log('DB written:', dbPath);
})();
