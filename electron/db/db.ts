// 主进程数据库层：node:sqlite 初始化 + 版本化迁移 + 全部建表
import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import { mkdirSync, statSync, unlinkSync, renameSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WALL_BANK_SEED } from './wallBankSeed'

let db: DatabaseSync | null = null

export function getDb(): DatabaseSync {
  if (!db) throw new Error('DB_NOT_INITIALIZED')
  return db
}

/** 关闭数据库（迁移数据目录前调用，WAL 落盘） */
export function closeDb(): void {
  if (db) {
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      db.close()
    } catch {
      /* 已关闭 */
    }
    db = null
  }
}

export function userDataDir(): string {
  return app.getPath('userData')
}

export function initDb(): void {
  const userData = userDataDir()
  // 目录：md 各模块子目录 + bg
  for (const dir of ['md/mottos', 'md/inspirations', 'md/wiki', 'md/verify', 'md/zhijiji', 'md/turtle', 'md/wall', 'md/wall/bank', 'md/drafts', 'bg']) {
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

  if (version < 2) {
    // v2 修复+种子：
    // 1) 旧 bug 产物清理：image:pick 曾把背景图存为 bg/bg-light（无扩展名）而 settings 记
    //    bg-light.png → 404。将无扩展旧文件改名为规范名。
    // 2) 种子默认背景图：resources/bg-light.png / resources/bg-dark.png 首次启动复制入
    //    userData/bg/（开发者要求默认即用项目内背景图，见 问题疑惑区 #2）。
    const bgDir = join(userDataDir(), 'bg')
    for (const kind of ['bg-light', 'bg-dark'] as const) {
      const bare = join(bgDir, kind)
      const canonical = join(bgDir, `${kind}.png`)
      try {
        const st = statSync(bare)
        if (st.isFile()) {
          try {
            unlinkSync(canonical)
          } catch {
            /* 无同名规范文件 */
          }
          renameSync(bare, canonical)
        }
      } catch {
        /* 无旧 bug 文件 */
      }
      // 种子（缺文件才复制，不覆盖用户已上传的）
      if (!existsSync(canonical)) {
        const src = join(app.getAppPath(), 'resources', `${kind}.png`)
        try {
          copyFileSync(src, canonical)
        } catch {
          /* 源图缺失（打包环境路径不同）则跳过 */
        }
      }
      d.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(
        `bg_${kind}`,
        `${kind}.png`
      )
    }
    d.exec('PRAGMA user_version = 2')
  }

  if (version < 3) {
    // v3：格言排序（优化建议区「序号+拖拽排序」）。mottos 加 sort REAL 列
    //（越小越靠前，REAL 便于插入位置取半差）；存量按当前显示顺序（区内 id 倒序，
    // 即 mottos:list 原排序）逐区赋 0..n-1，迁移后观感不变。
    d.exec('ALTER TABLE mottos ADD COLUMN sort REAL NOT NULL DEFAULT 0')
    for (const status of ['draft', 'settled', 'formal']) {
      const rows = d
        .prepare('SELECT id FROM mottos WHERE status = ? AND deleted_at IS NULL ORDER BY id DESC')
        .all(status) as { id: number }[]
      const upd = d.prepare('UPDATE mottos SET sort = ? WHERE id = ?')
      rows.forEach((r, i) => upd.run(i, r.id))
    }
    d.exec('PRAGMA user_version = 3')
  }

  if (version < 4) {
    // v4：AI 助手多会话（优化建议区「对话记录管理」）。新建会话表、消息挂会话；
    // 存量消息归入「历史对话」会话并设为激活——升级后原记录可见、可继续聊。
    d.exec(`
      CREATE TABLE IF NOT EXISTS ai_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL DEFAULT '新对话',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      ALTER TABLE ai_messages ADD COLUMN session_id INTEGER REFERENCES ai_sessions(id);
      CREATE INDEX IF NOT EXISTS idx_ai_messages_session ON ai_messages(session_id);
    `)
    const legacyCount = (d.prepare('SELECT COUNT(*) AS c FROM ai_messages').get() as { c: number }).c
    if (legacyCount > 0) {
      const now = nowIso()
      const r = d
        .prepare("INSERT INTO ai_sessions (title, created_at, updated_at) VALUES ('历史对话', ?, ?)")
        .run(now, now)
      const sid = Number(r.lastInsertRowid)
      d.prepare('UPDATE ai_messages SET session_id = ? WHERE session_id IS NULL').run(sid)
      d.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
        'ai_active_session_id',
        String(sid)
      )
    }
    d.exec('PRAGMA user_version = 4')
  }

  if (version < 5) {
    // v5：格言标签（格言库 v2.0 §7.1）。JSON 字符串数组，存量默认空。
    d.exec("ALTER TABLE mottos ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'")
    d.exec('PRAGMA user_version = 5')
  }

  if (version < 6) {
    // v6：生成格言类型标记（开发者指令：AI 徽章仅编撰条显示，摘录条不打）。
    // gen_kind：'excerpt'=现实摘录 | 'composed'=AI 编撰 | NULL=手动录入；
    // 存量 ai 行按出处含「AI…编撰」回填（v1 prompt 约定编撰条出处标「AI 编撰」）。
    d.exec('ALTER TABLE mottos ADD COLUMN gen_kind TEXT')
    d.exec(
      "UPDATE mottos SET gen_kind = CASE WHEN source LIKE '%AI%编撰%' THEN 'composed' ELSE 'excerpt' END WHERE origin = 'ai'"
    )
    d.exec('PRAGMA user_version = 6')
  }

  if (version < 7) {
    // v7：灵感泉 v2.0（AI 辅助生成）。origin：'manual'=手动新建 | 'ai'=AI「来5条灵感」生成
    //（列表 AI 徽标依据；回收站 payload 自带该字段，恢复后徽标保留）。
    d.exec("ALTER TABLE inspirations ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'")
    d.exec('PRAGMA user_version = 7')
  }

  if (version < 8) {
    // v8：格言笔记正文去重（优化建议区）。句子+出处改由笔记弹窗标题区展示，新笔记正文
    // 从空白开始；存量笔记剥离旧模板头（`# 句子\n\n> 出处`），头部以下自写内容保留，
    // 已自行改写过头部的不动。查询不过滤 deleted_at：回收站中的软删格言的笔记同样剥离，
    // 恢复后再转正不会重现旧头（转正处 setStatus 还有同款兜底）。
    const rows = d
      .prepare('SELECT note_path, content, source FROM mottos WHERE note_path IS NOT NULL')
      .all() as { note_path: string; content: string; source: string }[]
    for (const r of rows) stripMottoNoteHeader(r.note_path, r.content, r.source)
    d.exec('PRAGMA user_version = 8')
  }

  if (version < 9) {
    // v9：致知己（问题+多版本答案）+ 我的画像 + AI 边栏频道制（问题疑惑区 260905 共识）。
    // 版本日期 YYMMDD 存 DB（覆盖当前版本时只改 DB 日期，md 文件名 {qid}-v{seq}.md 稳定不重命名）；
    // ai_sessions.channel 存量归 'assistant'（DEFAULT 兜底，零迁移）。
    d.exec(`
      CREATE TABLE IF NOT EXISTS zhijiji_questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS zhijiji_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        question_id INTEGER NOT NULL REFERENCES zhijiji_questions(id),
        seq INTEGER NOT NULL,
        date TEXT NOT NULL,
        md_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_zhijiji_versions_q ON zhijiji_versions(question_id);

      CREATE TABLE IF NOT EXISTS profile_facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      ALTER TABLE ai_sessions ADD COLUMN channel TEXT NOT NULL DEFAULT 'assistant';
    `)
    // 种子问题（仅空表时预置）：四锚点材料随 v1 落 md，待开发者用自己的话写出 v1
    const cnt = (d.prepare('SELECT COUNT(*) AS c FROM zhijiji_questions').get() as { c: number }).c
    if (cnt === 0) {
      const now = nowIso()
      const r = d
        .prepare(
          "INSERT INTO zhijiji_questions (title, tags, created_at, updated_at) VALUES (?, ?, ?, ?)"
        )
        .run('线性代数和 AI 有什么渊源？', '["线性代数","AI"]', now, now)
      const qid = Number(r.lastInsertRowid)
      const mdPath = `md/zhijiji/${qid}-v1.md`
      d.prepare(
        'INSERT INTO zhijiji_versions (question_id, seq, date, md_path, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?)'
      ).run(qid, yyMMdd(), mdPath, now, now)
      writeFileSync(
        join(userDataDir(), mdPath),
        '> 以下是预填的思考锚点材料，请用自己的话写出属于你的 v1 答案，完成后可删除本段：\n>\n> ① 神经网络每一层就是一次矩阵乘法 y=σ(Wx+b)，训练就是学出 W\n> ② 词语被表示为向量，语义相似度 = 向量夹角\n> ③ 注意力 QKᵀV 本质是线性代数运算，LoRA 靠低秩近似\n> ④ AI 每生成一个字，背后都是海量矩阵运算\n',
        'utf-8'
      )
    }
    d.exec('PRAGMA user_version = 9')
  }

  if (version < 10) {
    // v10：AI 编撰条出处署名改名（优化建议区第16轮续——AI 起名 debugzi）：
    // 「AI 编撰」→「debugzi」。不过滤 deleted_at（回收站软删行同步改，恢复路径覆盖）；
    // 限定 origin='ai' 防误伤手动条；LIKE 口径同 v6 回填（覆盖无空格/大小写变体）。
    d.exec(
      "UPDATE mottos SET source = 'debugzi' WHERE origin = 'ai' AND source LIKE '%AI%编撰%'"
    )
    d.exec('PRAGMA user_version = 10')
  }

  if (version < 11) {
    // v11：灵感文档正文去重（优化建议区第19轮）。标题由弹窗标题区展示，新建/AI 生成的
    // 正文不再写 `# 标题` 行；存量文档剥离首行旧模板标题（仅与现库标题精确匹配才剥——
    // 改过名的文档首行是旧标题、用户自写的 # 开头正文均不匹配，不动以免误删，可手动删）。
    // 不过滤 deleted_at：回收站软删条的文档同样剥离，恢复后不重现旧头（口径同 v8 格言笔记）。
    const rows = d
      .prepare(
        "SELECT title, md_path FROM inspirations WHERE md_path IS NOT NULL AND md_path != 'PENDING'"
      )
      .all() as { title: string; md_path: string }[]
    for (const r of rows) stripInspirationTitleHeader(r.md_path, r.title)
    d.exec('PRAGMA user_version = 11')
  }

  if (version < 12) {
    // v12：推理角（推理角 specs §1）——海龟汤（汤库 / 对局 / 问答消息）+ 思维墙（每日一题）。
    // 问答逐条即时落库（中断续玩、多局并行的根基）；turtle_games.soup_id 不设外键：删汤
    // 不级联删局，对局记录 md 是快照（含汤面汤底全文）自包含（specs §5「删汤不影响已有记录」）。
    // wall_puzzles.date 唯一——一天一题，「打开现出」。
    d.exec(`
      CREATE TABLE IF NOT EXISTS turtle_soups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        surface TEXT NOT NULL,
        bottom TEXT NOT NULL,
        analysis TEXT NOT NULL,
        difficulty TEXT NOT NULL,
        theme_tag TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'fresh',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS turtle_games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        soup_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'playing',
        question_count INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        duration_ms INTEGER,
        md_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_turtle_games_soup ON turtle_games(soup_id);

      CREATE TABLE IF NOT EXISTS turtle_game_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id INTEGER NOT NULL REFERENCES turtle_games(id),
        role TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_turtle_msgs_game ON turtle_game_messages(game_id);

      CREATE TABLE IF NOT EXISTS wall_puzzles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL UNIQUE,
        puzzle_text TEXT NOT NULL,
        answer_standard TEXT NOT NULL,
        hints TEXT NOT NULL DEFAULT '[]',
        puzzle_type TEXT NOT NULL,
        difficulty TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'answering',
        hints_used INTEGER NOT NULL DEFAULT 0,
        my_answer TEXT,
        md_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
    d.exec('PRAGMA user_version = 12')
  }

  if (version < 13) {
    // v13：思维墙洞察题重做（specs v1.2）——① wall_puzzles 增 standard_reasoning
    // （出题时的标准论证，判答讲解与详情 md 共用）；② 精选题库 wall_bank（双层题源
    // 第二层：人工策展存量难题，AI 只判答不出题，status todo→solved/failed 终态），
    // 迁移时插入首批评选 10 题（wallBankSeed.ts，均已人工验证）。
    d.exec(`
      ALTER TABLE wall_puzzles ADD COLUMN standard_reasoning TEXT;

      CREATE TABLE IF NOT EXISTS wall_bank (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        tag TEXT NOT NULL,
        difficulty TEXT NOT NULL,
        puzzle_text TEXT NOT NULL,
        answer_standard TEXT NOT NULL,
        solution TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'todo',
        my_answer TEXT,
        md_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
    const now13 = new Date().toISOString()
    const insBank = d.prepare(
      'INSERT INTO wall_bank (title, tag, difficulty, puzzle_text, answer_standard, solution, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    for (const b of WALL_BANK_SEED) {
      insBank.run(b.title, b.tag, b.difficulty, b.puzzle, b.answer, b.solution, b.source, 'todo', now13, now13)
    }
    d.exec('PRAGMA user_version = 13')
  }

  if (version < 14) {
    // v14：草稿本（优化建议区第21轮）——右缘常驻面板的 md 草稿。channel 固定两频道起步
    // （general 通用 / turtle 海龟汤），为普通字符串字段，将来加频道零迁移；
    // 正文存 md/drafts/{id}.md（真实 .md 文件），删除走回收站软删（deleted_at）。
    d.exec(`
      CREATE TABLE IF NOT EXISTS drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'general',
        md_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_drafts_channel ON drafts(channel);
    `)
    d.exec('PRAGMA user_version = 14')
  }
}

// ---------- 通用工具 ----------
export function nowIso(): string {
  return new Date().toISOString()
}

/** 版本日期标识 YYMMDD（致知己版本 `v{序号}-{YYMMDD}`） */
export function yyMMdd(t: Date = new Date()): string {
  return `${String(t.getFullYear()).slice(2)}${String(t.getMonth() + 1).padStart(2, '0')}${String(
    t.getDate()
  ).padStart(2, '0')}`
}

/** 正则字面量转义（stripMottoNoteHeader 宽松匹配用） */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 剥离格言笔记的旧模板头（v8 起：句子+出处由弹窗标题区展示，正文不再重复）。
 * 旧模板：`# {句子}\n\n> {出处}\n`。先精确匹配现库句子+出处；不中则退一步——
 * 标题行与句子一致且后跟一行 > 引用（句子未改而出处后来被改过的情形）；
 * 仍不中（用户已自行编辑头部）则不动。剥后清掉残留的行首空行。
 */
export function stripMottoNoteHeader(relPath: string, content: string, source: string): void {
  let c: string
  try {
    c = readFileSync(join(userDataDir(), relPath), 'utf-8')
  } catch {
    return // 笔记文件缺失等，跳过（不阻断迁移/转正）
  }
  const header = `# ${content}\n\n> ${source}\n`
  let rest: string | null = null
  if (c === header) rest = ''
  else if (c.startsWith(header)) rest = c.slice(header.length)
  else {
    const m = c.match(new RegExp(`^# ${escapeRegExp(content)}\\n\\n> [^\\n]*\\n`))
    if (m) rest = c.slice(m[0].length)
  }
  if (rest === null) return
  writeFileSync(join(userDataDir(), relPath), rest.replace(/^\n+/, ''), 'utf-8')
}

/**
 * 剥离灵感文档的旧模板标题行（v11 起：标题由弹窗标题区展示，正文不再重复）。
 * 旧模板首行：`# {标题}`。仅当首行与现库标题精确匹配时剥离（用户自写 # 开头正文、
 * 改名后残留的旧标题行均不匹配——不动，避免误删正文），剥后清掉残留的行首空行。
 */
export function stripInspirationTitleHeader(relPath: string, title: string): void {
  let c: string
  try {
    c = readFileSync(join(userDataDir(), relPath), 'utf-8')
  } catch {
    return // 文档缺失等，跳过（不阻断迁移）
  }
  const header = `# ${title}\n`
  if (!c.startsWith(header)) return
  writeFileSync(join(userDataDir(), relPath), c.slice(header.length).replace(/^\n+/, ''), 'utf-8')
}

/** 规范化文本：去首尾空白 + 中英文标点统一（格言查重等） */
export function normalizeText(s: string): string {
  return s
    .trim()
    .replace(/[，。！？；：、""''（）【】《》…—·,.!?;:()"[\]<>~\s]/g, '')
    .toLowerCase()
}

/** 包含判重的最短规范化长度门槛（格言库 v2.0 §7.4：防短句子串误杀） */
const DUP_SUBSTR_MIN_LEN = 6

/**
 * 格言判重（格言库 v2.0 §7.4.2）：规范化后与已有任一条完全一致，
 * 或互为子串且双方规范化长度均 ≥ 门槛 → 重复
 */
export function isDupMotto(existing: Iterable<string>, norm: string): boolean {
  if (!norm) return true
  for (const e of existing) {
    if (!e) continue
    if (e === norm) return true
    if (
      e.length >= DUP_SUBSTR_MIN_LEN &&
      norm.length >= DUP_SUBSTR_MIN_LEN &&
      (e.includes(norm) || norm.includes(e))
    ) {
      return true
    }
  }
  return false
}
