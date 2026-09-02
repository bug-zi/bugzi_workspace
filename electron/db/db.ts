// 主进程数据库层：node:sqlite 初始化 + 版本化迁移 + 全部建表
import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

let db: DatabaseSync | null = null

export function getDb(): DatabaseSync {
  if (!db) throw new Error('DB_NOT_INITIALIZED')
  return db
}

export function userDataDir(): string {
  return app.getPath('userData')
}

export function initDb(): void {
  const userData = userDataDir()
  // 目录：md 四模块子目录 + bg
  for (const dir of ['md/mottos', 'md/inspirations', 'md/wiki', 'md/verify', 'bg']) {
    mkdirSync(join(userData, dir), { recursive: true })
  }
  db = new DatabaseSync(join(userData, 'bugzi.db'))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  migrate()
}

function migrate(): void {
  const d = db!
  const version = Number((d.prepare('PRAGMA user_version').get() as any).user_version ?? 0)

  if (version < 1) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mottos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        note_path TEXT,
        origin TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mottos_status ON mottos(status) WHERE deleted_at IS NULL;

      CREATE TABLE IF NOT EXISTS wiki_sections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        sort INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS wiki_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        section_id INTEGER NOT NULL REFERENCES wiki_sections(id),
        term TEXT NOT NULL,
        summary TEXT NOT NULL,
        md_path TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'ai',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_wiki_entries_section ON wiki_entries(section_id);

      CREATE TABLE IF NOT EXISTS wiki_highlights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_id INTEGER NOT NULL REFERENCES wiki_entries(id),
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS inspirations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        md_path TEXT NOT NULL,
        sort INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_inspirations_status ON inspirations(status);

      CREATE TABLE IF NOT EXISTS verify_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        claim TEXT NOT NULL,
        analysis TEXT NOT NULL,
        credibility INTEGER NOT NULL,
        md_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS ai_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        ai_module TEXT,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS recycle_bin (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        item_id INTEGER NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_recycle_source ON recycle_bin(source);
    `)

    // 初始板块（万象库 specs §1）
    const now = new Date().toISOString()
    const ins = d.prepare('INSERT INTO wiki_sections (name, sort, created_at) VALUES (?, ?, ?)')
    const initialSections = ['经济学', '法学', '心理学', '博弈论', '历史神话']
    initialSections.forEach((name, i) => ins.run(name, i, now))

    // 默认设置
    const set = d.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
    set.run('theme', 'light')
    set.run('motto_schedule', '22:00')

    d.exec('PRAGMA user_version = 1')
  }
}

// ---------- 通用工具 ----------
export function nowIso(): string {
  return new Date().toISOString()
}

/** 规范化文本：去首尾空白 + 中英文标点统一（格言查重等） */
export function normalizeText(s: string): string {
  return s
    .trim()
    .replace(/[，。！？；：、""''（）【】《》…—·,.!?;:()"[\]<>~\s]/g, '')
    .toLowerCase()
}
