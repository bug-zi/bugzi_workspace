// 主进程数据库层：node:sqlite 初始化 + 版本化迁移 + 全部建表
import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import { mkdirSync, statSync, unlinkSync, renameSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WALL_BANK_SEED_V22 } from './wallBankSeed'

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
  for (const dir of ['md/mottos', 'md/inspirations', 'md/wiki', 'md/verify', 'md/zhijiji', 'md/turtle', 'md/wall', 'md/wall/bank', 'md/drafts', 'md/wenbi/journal', 'md/wenbi/article', 'canvas', 'books', 'covers', 'bg']) {
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
    // 第二层：人工策展存量难题，AI 只判答不出题，status todo→solved/failed 终态）。
    // （v1.6 题型换血后种子数组已删：此处只建表不插种子，现行种子走 v22 的
    // WALL_BANK_SEED_V22；v13 批次旧题由 v23 迁移删除。）
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

  if (version < 15) {
    // v15：海龟汤质量优化（海龟汤修改反馈）——汤库存「核心诡计一句话」概括（trick_note），
    // 供出题/审题注入避免清单防跨批同构；纯内部机制，不进任何 UI（防剧透）。
    // 存量回填由启动后一次性 LLM 任务完成（services.backfillTrickNotes），迁移只加列。
    d.exec('ALTER TABLE turtle_soups ADD COLUMN trick_note TEXT')
    d.exec('PRAGMA user_version = 15')
  }

  if (version < 16) {
    // v16：格言删除记忆墓碑（优化建议区第24轮）——物理删除的格言留底 content，
    // 供「来10条格言」生成查重防复现；表只增不删（代码侧判重查全量，prompt 注入限量）。
    d.exec(`
      CREATE TABLE IF NOT EXISTS motto_tombstones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        content_norm TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
    d.exec('PRAGMA user_version = 16')
  }

  if (version < 17) {
    // v17：文笔坊（文笔坊 specs §1）——浮生记条目 + 写作台文章。浮生记无标题字段（时间线行=创建日期+首行摘要），
    // is_event 为大事件标记；文章 zone 四区流转（idea 构思 / writing 写作 / done 完稿 / published 已发布）。
    // 正文分别存 md/wenbi/journal/{id}.md、md/wenbi/article/{id}.md，删除走回收站软删（deleted_at）。
    d.exec(`
      CREATE TABLE IF NOT EXISTS wenbi_journals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        md_path TEXT NOT NULL,
        is_event INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS wenbi_articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        zone TEXT NOT NULL DEFAULT 'idea',
        md_path TEXT NOT NULL,
        sort INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_wenbi_articles_zone ON wenbi_articles(zone);
    `)
    d.exec('PRAGMA user_version = 17')
  }

  if (version < 18) {
    // v18：海龟汤计时净用时（优化建议区第26轮）——active_ms 累计净思考用时，
    // segment_start_at 当前计时段起点（NULL=暂停中）；渲染层发 timerStart/timerPause 边界事件，
    // 终局结算 duration_ms=active_ms。存量 playing 局 active_ms 从 0 起算（历史墙钟不并入），
    // 旧终局记录 duration_ms 不追溯（维持原墙钟口径）。
    d.exec('ALTER TABLE turtle_games ADD COLUMN active_ms INTEGER NOT NULL DEFAULT 0')
    d.exec('ALTER TABLE turtle_games ADD COLUMN segment_start_at TEXT')
    d.exec('PRAGMA user_version = 18')
  }

  if (version < 19) {
    // v19：书架（书架 specs §1）——本地电子书阅读。epub/pdf 复制入库（books/）+ 封面（covers/），
    // 进度记忆：epub 存 CFI + 百分比、pdf 存页码；路径一律相对 userData（库可整体迁移）。
    // 删除为二次确认后物理删除（不入回收站），故无 deleted_at 列。
    // （设计写 v18，被并行会话海龟汤计时（优化建议区第26轮）占用，顺延 v19——specs 版本号实况条款）
    d.exec(`
      CREATE TABLE IF NOT EXISTS books (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT '',
        format TEXT NOT NULL,
        file_path TEXT NOT NULL,
        cover_path TEXT,
        file_size INTEGER NOT NULL DEFAULT 0,
        progress_cfi TEXT,
        progress_page INTEGER,
        progress_percent REAL NOT NULL DEFAULT 0,
        added_at TEXT NOT NULL,
        last_read_at TEXT
      );
    `)
    d.exec('PRAGMA user_version = 19')
  }

  if (version < 20) {
    // v20：信息源（信息源 specs §1）——RSS 订阅聚合 + AI 总结按需缓存。articles 以 (feed_id, guid)
    // 去重；正文两级（content_feed_html=RSS 自带 / content_fetched_html=readability 懒抓）；
    // 删除源为显式两步删（连文章），不依赖外键级联，不入回收站。
    // （设计写 v19，被并行会话海龟汤计时的 v18 顺延挤占，落 v20——specs 版本号实况条款）
    d.exec(`
      CREATE TABLE IF NOT EXISTS feeds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        feed_url TEXT NOT NULL UNIQUE,
        site_url TEXT NOT NULL DEFAULT '',
        last_fetched_at TEXT,
        fetch_error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        feed_id INTEGER NOT NULL,
        guid TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL DEFAULT '',
        author TEXT NOT NULL DEFAULT '',
        published_at TEXT,
        fetched_at TEXT NOT NULL,
        content_feed_html TEXT,
        content_fetched_html TEXT,
        read_at TEXT,
        summary_text TEXT,
        summary_at TEXT,
        UNIQUE(feed_id, guid)
      );
      CREATE INDEX IF NOT EXISTS idx_articles_feed ON articles(feed_id, published_at DESC);
    `)
    d.exec('PRAGMA user_version = 20')
  }

  if (version < 21) {
    // v21：账本（账本 specs §1）——轻量记账。金额一律存「分」INTEGER（浮点累加脏数据），
    // 余额不落字段实时聚合（期初 + 未删收支滚存）；流水日期精确到天；三表软删（deleted_at）
    // 走回收站第九块。种子：预设四账户 + 支出/收入分类各一组。
    d.exec(`
      CREATE TABLE IF NOT EXISTS ledger_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        initial_balance_cents INTEGER NOT NULL DEFAULT 0,
        sort INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS ledger_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('expense','income')),
        sort INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS ledger_tx (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('expense','income')),
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        category_id INTEGER,
        account_id INTEGER NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ledger_tx_date ON ledger_tx(date);
      CREATE INDEX IF NOT EXISTS idx_ledger_tx_account ON ledger_tx(account_id);
    `)
    const now = nowIso()
    const insAcc = d.prepare(
      'INSERT INTO ledger_accounts (name, initial_balance_cents, sort, created_at) VALUES (?, 0, ?, ?)'
    )
    insAcc.run('现金', 0, now)
    insAcc.run('微信', 1, now)
    insAcc.run('支付宝', 2, now)
    insAcc.run('银行卡', 3, now)
    const insCat = d.prepare(
      'INSERT INTO ledger_categories (name, kind, sort, created_at) VALUES (?, ?, ?, ?)'
    )
    const expenseSeeds = ['餐饮', '交通', '购物', '居住', '娱乐', '医疗', '学习', '其他']
    const incomeSeeds = ['工资', '理财', '副业', '红包', '其他']
    expenseSeeds.forEach((n, i) => insCat.run(n, 'expense', i, now))
    incomeSeeds.forEach((n, i) => insCat.run(n, 'income', i + 100, now))
    d.exec('PRAGMA user_version = 21')
  }

  if (version < 22) {
    // v22：思维墙题型换血（v1.6）——精选题库追加 8 道思维游戏题
    // （4 道经开发者例题校准 + 4 道待人工验证，source 标「AI 起草」），只追加不动旧。
    // （v1.3 规划的 wall_pool 题池未实施，无池存量旧题需清理——
    // 每日一题/练习场均现场两阶段生成，换血后自动全走新 prompt。）
    const now22 = new Date().toISOString()
    const insBank22 = d.prepare(
      'INSERT INTO wall_bank (title, tag, difficulty, puzzle_text, answer_standard, solution, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    for (const b of WALL_BANK_SEED_V22) {
      insBank22.run(b.title, b.tag, b.difficulty, b.puzzle, b.answer, b.solution, b.source, 'todo', now22, now22)
    }
    d.exec('PRAGMA user_version = 22')
  }

  if (version < 23) {
    // v23：移除 v13 批次的 10 道数学种子题（开发者指令——题型换血后旧题不再保留，
    // 含已作答/已揭示的；全新用户经改造后的 v13 已不插种子，此迁移对其为空操作）。
    // 按标题白名单精确删除防误删；已生成的题解 md（md/wall/bank/{id}.md）连带清理。
    const retiredTitles = [
      '蓝眼睛的岛民',
      '和积问题',
      '100 囚徒与 100 个抽屉',
      '海盗分金',
      '千桶毒酒',
      '2017 张卡片',
      '全装错的信',
      '约瑟夫环',
      '37% 法则',
      '分赌本问题'
    ]
    const placeholders23 = retiredTitles.map(() => '?').join(', ')
    const retiredRows = d
      .prepare(`SELECT id, md_path FROM wall_bank WHERE title IN (${placeholders23})`)
      .all(...retiredTitles) as { id: number; md_path: string | null }[]
    for (const r of retiredRows) {
      if (r.md_path) {
        const abs = join(userDataDir(), r.md_path)
        if (existsSync(abs)) unlinkSync(abs)
      }
    }
    d.prepare(`DELETE FROM wall_bank WHERE title IN (${placeholders23})`).run(...retiredTitles)
    d.exec('PRAGMA user_version = 23')
  }

  if (version < 24) {
    // v24：书架优化第1轮 §8.5——划词笔记（高光/批注，CFI 区间定位；仅 epub）。
    // 删书级联清理由 BookService.deleteBook 负责（此处不建 FK 约束，与全库惯例一致）。
    d.exec(`CREATE TABLE book_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      cfi_range TEXT NOT NULL,
      quote TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )`)
    d.exec('PRAGMA user_version = 24')
  }

  if (version < 25) {
    // v25：画布（新功能开发区 260909）——右缘第三面板的 Excalidraw 画布，多画布管理。
    // 正文存 canvas/{id}.excalidraw（标准 Excalidraw JSON，可直接被官方导入导出），
    // 删除走回收站软删（deleted_at）。无 channel 字段（画布无频道维度）。
    d.exec(`
      CREATE TABLE IF NOT EXISTS canvases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_canvases_updated ON canvases(updated_at);
    `)
    d.exec('PRAGMA user_version = 25')
  }

  if (version < 26) {
    // v26：推理角题库预生成（v1.3 设计 260907，因后续模块挤占版本号顺延至此）——
    // 每日一题/练习场共用的预生成题池（补充泵 electron/services/reasoningStock.ts 后台维持）。
    // 池是未消费的储备：无 deleted_at、不进回收站、无删除入口；被取走即转正（每日题）或消耗（练习场）。
    // title 列为 v1.7 口径适配：练习场取池题生成即入 wall_bank，题库行需要标题（每日一题转正忽略 title）。
    d.exec(`CREATE TABLE IF NOT EXISTS wall_pool (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '',
      puzzle_text TEXT NOT NULL,
      answer_standard TEXT NOT NULL,
      standard_reasoning TEXT NOT NULL,
      hints TEXT NOT NULL DEFAULT '[]',
      puzzle_type TEXT NOT NULL,
      difficulty TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`)
    d.exec('PRAGMA user_version = 26')
  }

  if (version < 27) {
    // v27：LLM 使用记账（260910 推理角效率优化）——chatCompletion 咽喉点每次逻辑调用一行；
    // 429 重试只记最终趟（耗时含重试等待）；usage 缺失时按字符估算并打 tokens_estimated 标记。
    // 只增不删（一天几十行，不做清理任务——设计定稿 YAGNI）。
    d.exec(`CREATE TABLE IF NOT EXISTS llm_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      scene TEXT NOT NULL,
      config_name TEXT NOT NULL,
      model TEXT NOT NULL,
      ok INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      tokens_estimated INTEGER NOT NULL DEFAULT 0,
      error_brief TEXT
    )`)
    d.exec('CREATE INDEX IF NOT EXISTS idx_llm_usage_created ON llm_usage(created_at)')
    d.exec('PRAGMA user_version = 27')
  }

  if (version < 28) {
    // v28：收藏夹（260910 立项，收藏夹 specs §1）——纯链接收藏：两级分类 + 条目（URL+名称+简介 md）。
    // 不入回收站（二次确认直接删）；简介存 DB 非 md 文件；url 无唯一约束（允许重复收藏）。
    // 「未分类」is_system=1 锁定大类：禁删/改名/排序，sort=1e9 固定末位，删除非空分类时条目的去处。
    d.exec(`CREATE TABLE IF NOT EXISTS fav_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id INTEGER,
      name TEXT NOT NULL,
      sort INTEGER NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`)
    d.exec(`CREATE TABLE IF NOT EXISTS fav_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      desc_md TEXT NOT NULL DEFAULT '',
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`)
    d.exec('CREATE INDEX IF NOT EXISTS idx_fav_items_cat ON fav_items(category_id, created_at DESC)')
    d.exec('PRAGMA user_version = 28')
  }

  if (version < 29) {
    // v29：书架 v2.0（2026-09-10-书架v2-design.md §一）——书级偏好两列（模式/字号，
    // NULL=回落全局默认，存量书零迁移）+ 手动书签表（epub/pdf 都支持）+ 阅读统计按书按日累秒表。
    // （设计写 v28，被并行会话收藏夹占用 v28，实际落 v29——版本号实况条款同 v18/v19 先例。）
    d.exec(`ALTER TABLE books ADD COLUMN reading_mode TEXT`)
    d.exec(`ALTER TABLE books ADD COLUMN font_scale REAL`)
    d.exec(`CREATE TABLE book_marks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      cfi TEXT,
      page INTEGER,
      label TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )`)
    d.exec(`CREATE TABLE book_read_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      day TEXT NOT NULL,
      seconds INTEGER NOT NULL DEFAULT 0,
      UNIQUE(book_id, day)
    )`)
    d.exec('PRAGMA user_version = 29')
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

/**
 * 已删除格言墓碑（优化建议区第24轮）：mottos 物理删除前留底，供 generateMottos 查重
 * 防「来10条格言」复现已删格言。同规范化内容已存在则跳过（防手动加回再删堆积重复行）。
 */
export function recordMottoTombstone(content: string): void {
  const norm = normalizeText(content)
  if (!norm) return
  const d = getDb()
  const exists = d.prepare('SELECT 1 FROM motto_tombstones WHERE content_norm = ?').get(norm)
  if (exists) return
  d.prepare('INSERT INTO motto_tombstones (content, content_norm, created_at) VALUES (?, ?, ?)').run(
    content,
    norm,
    nowIso()
  )
}
