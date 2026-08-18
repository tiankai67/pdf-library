/**
 * PDF 图书馆 —— 零依赖 Node 后端
 * 提供：静态资源服务、图书列表、PDF 上传/删除、封面图服务
 * 启动：node server.js  （可选环境变量 PORT / ADMIN_PASSWORD / DATA_DIR）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
// 静态站点与数据都放在仓库根：自托管与 GitHub Pages（分支根部署）共用同一份文件，避免重复
const PUBLIC = ROOT;
const DATA_DIR = process.env.DATA_DIR || ROOT;
const PDF_DIR = path.join(DATA_DIR, 'pdfs');
const COVER_DIR = path.join(DATA_DIR, 'covers');
const BOOKS_FILE = path.join(DATA_DIR, 'books.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// 初始管理员密码：仅在首次生成 config.json 时使用；
// 之后以后台修改的密码为准。若忘记密码，可用 RESET_PASSWORD=1 启动强制重置。
// 安全：不再写死默认密码。优先读取环境变量 ADMIN_PASSWORD；
// 若未设置，首次启动会自动生成随机密码并打印到控制台（请妥善保存）。
function resolveInitPassword() {
  const fromEnv = process.env.ADMIN_PASSWORD;
  if (fromEnv) return fromEnv;
  const generated = crypto.randomBytes(12).toString('hex');
  console.warn('[security] 未设置 ADMIN_PASSWORD，已自动生成随机管理员密码（请记录）：', generated);
  return generated;
}
const PORT = parseInt(process.env.PORT || '3000', 10);

// 确保目录存在
[DATA_DIR, PDF_DIR, COVER_DIR].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

function loadBooks() {
  try {
    return JSON.parse(fs.readFileSync(BOOKS_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}
function saveBooks(books) {
  fs.writeFileSync(BOOKS_FILE, JSON.stringify(books, null, 2));
}

/* ================= 排序 ================= */
// 统一顺序：有 order 的按 order 升序；缺失 order 的按创建时间倒序补在后面，
// 然后重新写成连续的 0..n-1，避免出现空洞或重复。
function sortedBooks(books) {
  const list = books.slice();
  list.sort((a, b) => {
    const ao = Number.isFinite(a.order) ? a.order : Infinity;
    const bo = Number.isFinite(b.order) ? b.order : Infinity;
    if (ao !== bo) return ao - bo;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
  return list;
}
function normalizeOrder(books) {
  const list = sortedBooks(books);
  list.forEach((b, i) => { b.order = i; });
  return list;
}

/* ================= 密码（加盐哈希持久化） ================= */
function hashPw(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 32).toString('hex');
}
function writeConfig(cfg) {
  // 原子写：先落 .tmp 再 rename，避免进程被强杀时把 config.json 写到一半而损坏
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_FILE);
}
function makeConfig(plainPw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: hashPw(plainPw, salt), updatedAt: Date.now() };
}
function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (cfg && cfg.salt && cfg.hash) return cfg;
  } catch (e) { /* 落到下面重建 */ }
  const cfg = makeConfig(resolveInitPassword());
  writeConfig(cfg);
  return cfg;
}
function verifyPassword(pw) {
  if (!pw) return false;
  const cfg = loadConfig();
  const a = Buffer.from(hashPw(pw, cfg.salt), 'hex');
  const b = Buffer.from(cfg.hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
// 启动时初始化 / 按需重置
if (process.env.RESET_PASSWORD === '1' || !fs.existsSync(CONFIG_FILE)) {
  writeConfig(makeConfig(resolveInitPassword()));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 60 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('上传体积过大（上限 60MB）'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function checkAdmin(req) {
  const provided =
    req.headers['x-admin-password'] ||
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  return verifyPassword(provided);
}

// 剥掉 data URI 前缀（如 "data:image/jpeg;base64,"），仅保留 base64 主体
function stripDataUri(b64) {
  if (!b64 || typeof b64 !== 'string') return b64;
  const i = b64.indexOf(',');
  return i >= 0 ? b64.slice(i + 1) : b64;
}

// 安全解析：将请求路径映射到 BASE 下的真实文件，禁止越界
function safeFile(base, sub) {
  const target = path.normalize(path.join(base, sub));
  if (!target.startsWith(base)) return null;
  return target;
}

function serveStatic(res, filePath) {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (e) {
    res.writeHead(400); res.end('Bad Request'); return;
  }
  const pathname = decodeURIComponent(url.pathname);

  try {
    // ---------- API ----------
    // 图书列表（按后台设定的顺序返回）
    if (pathname === '/api/books' && req.method === 'GET') {
      const books = sortedBooks(loadBooks()).map(
        ({ id, title, pages, createdAt, size, order }) => ({
          id, title, pages, createdAt, size, order,
        })
      );
      return sendJSON(res, 200, { ok: true, books });
    }

    // 登录校验（后台进入前真实验证密码）
    if (pathname === '/api/login' && req.method === 'POST') {
      const buf = await readBody(req, 4096);
      let pw = '';
      try { pw = (JSON.parse(buf.toString('utf8')) || {}).password || ''; } catch (e) {}
      if (!verifyPassword(pw)) return sendJSON(res, 401, { ok: false, error: '密码错误' });
      return sendJSON(res, 200, { ok: true });
    }

    // 修改管理密码
    if (pathname === '/api/change-password' && req.method === 'POST') {
      const buf = await readBody(req, 4096);
      let payload = {};
      try { payload = JSON.parse(buf.toString('utf8')) || {}; } catch (e) {
        return sendJSON(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      }
      const oldPw = payload.oldPassword || '';
      const newPw = String(payload.newPassword || '');
      if (!verifyPassword(oldPw)) {
        return sendJSON(res, 401, { ok: false, error: '当前密码不正确' });
      }
      if (newPw.length < 6) {
        return sendJSON(res, 400, { ok: false, error: '新密码至少 6 位' });
      }
      if (newPw.length > 64) {
        return sendJSON(res, 400, { ok: false, error: '新密码过长（上限 64 位）' });
      }
      if (verifyPassword(newPw)) {
        return sendJSON(res, 400, { ok: false, error: '新密码不能与当前密码相同' });
      }
      writeConfig(makeConfig(newPw));
      console.log('🔑 管理密码已更新', new Date().toLocaleString('zh-CN'));
      return sendJSON(res, 200, { ok: true });
    }

    // 保存书架顺序（body: { ids: [...] }，按数组先后即为展示顺序）
    if (pathname === '/api/reorder' && req.method === 'POST') {
      if (!checkAdmin(req)) return sendJSON(res, 401, { ok: false, error: '管理员密码错误' });
      const buf = await readBody(req, 256 * 1024);
      let ids;
      try { ids = (JSON.parse(buf.toString('utf8')) || {}).ids; } catch (e) {
        return sendJSON(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      }
      if (!Array.isArray(ids)) return sendJSON(res, 400, { ok: false, error: '缺少 ids 数组' });

      const books = loadBooks();
      const rank = new Map();
      ids.forEach((id, i) => rank.set(String(id), i));
      books.forEach((b) => {
        // 传入列表里没有的书（并发上传等）排到末尾，保留其相对次序
        b.order = rank.has(b.id) ? rank.get(b.id) : ids.length + (Number.isFinite(b.order) ? b.order : 0);
      });
      saveBooks(normalizeOrder(books));
      return sendJSON(res, 200, { ok: true });
    }

    // 获取单本元信息（阅读器用）
    const metaMatch = pathname.match(/^\/api\/book\/([\w-]+)$/);
    if (metaMatch && req.method === 'GET') {
      const book = loadBooks().find((b) => b.id === metaMatch[1]);
      if (!book) return sendJSON(res, 404, { ok: false, error: '未找到该图书' });
      return sendJSON(res, 200, { ok: true, book });
    }

    // 修改书名（body: { title }）
    if (metaMatch && (req.method === 'PATCH' || req.method === 'PUT')) {
      if (!checkAdmin(req)) return sendJSON(res, 401, { ok: false, error: '管理员密码错误' });
      const buf = await readBody(req, 8 * 1024);
      let payload;
      try { payload = JSON.parse(buf.toString('utf8')) || {}; } catch (e) {
        return sendJSON(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      }
      // 去掉首尾空白与换行/制表符，避免书名把书架布局撑乱
      const title = String(payload.title == null ? '' : payload.title)
        .replace(/[\r\n\t]+/g, ' ')
        .trim();
      if (!title) return sendJSON(res, 400, { ok: false, error: '书名不能为空' });
      if (title.length > 120) return sendJSON(res, 400, { ok: false, error: '书名过长（上限 120 字）' });

      const books = loadBooks();
      const book = books.find((b) => b.id === metaMatch[1]);
      if (!book) return sendJSON(res, 404, { ok: false, error: '未找到该图书' });
      book.title = title;
      book.updatedAt = Date.now();
      saveBooks(books);
      return sendJSON(res, 200, { ok: true, title });
    }

    // 上传 PDF（JSON: { title, pages, pdf(base64), cover(base64) }）
    if (pathname === '/api/upload' && req.method === 'POST') {
      if (!checkAdmin(req)) return sendJSON(res, 401, { ok: false, error: '管理员密码错误' });
      const buf = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(buf.toString('utf8'));
      } catch (e) {
        return sendJSON(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      }
      const { title, pdf, cover, pages } = payload || {};
      if (!pdf || typeof pdf !== 'string') {
        return sendJSON(res, 400, { ok: false, error: '缺少 pdf 字段' });
      }
      let pdfBuf, coverBuf;
      try {
        pdfBuf = Buffer.from(stripDataUri(pdf), 'base64');
        coverBuf = cover ? Buffer.from(stripDataUri(cover), 'base64') : null;
      } catch (e) {
        return sendJSON(res, 400, { ok: false, error: 'base64 解码失败' });
      }
      if (pdfBuf.length < 100) {
        return sendJSON(res, 400, { ok: false, error: 'PDF 内容无效' });
      }
      const id = crypto.randomUUID();
      fs.writeFileSync(path.join(PDF_DIR, id + '.pdf'), pdfBuf);
      if (coverBuf) fs.writeFileSync(path.join(COVER_DIR, id + '.jpg'), coverBuf);

      const books = loadBooks();
      const cleanTitle = (title || '未命名图书').toString().slice(0, 120);
      books.push({
        id,
        title: cleanTitle,
        pages: Number(pages) || null,
        size: pdfBuf.length,
        createdAt: Date.now(),
        order: -1, // 新书默认排在书架最前，后台可再拖动调整
      });
      saveBooks(normalizeOrder(books));
      return sendJSON(res, 200, { ok: true, id });
    }

    // 删除图书
    if (pathname.startsWith('/api/book/') && req.method === 'DELETE') {
      if (!checkAdmin(req)) return sendJSON(res, 401, { ok: false, error: '管理员密码错误' });
      const id = pathname.split('/').pop();
      const books = loadBooks();
      const idx = books.findIndex((b) => b.id === id);
      if (idx === -1) return sendJSON(res, 404, { ok: false, error: '未找到该图书' });
      books.splice(idx, 1);
      saveBooks(normalizeOrder(books));
      try { fs.unlinkSync(path.join(PDF_DIR, id + '.pdf')); } catch (e) {}
      try { fs.unlinkSync(path.join(COVER_DIR, id + '.jpg')); } catch (e) {}
      return sendJSON(res, 200, { ok: true });
    }

    // ---------- 静态资源 ----------
    // PDF 文件
    const pdfMatch = pathname.match(/^\/pdfs\/([\w-]+)\.pdf$/);
    if (pdfMatch) {
      return serveStatic(res, safeFile(PDF_DIR, pdfMatch[1] + '.pdf'));
    }
    // 封面图
    const coverMatch = pathname.match(/^\/covers\/([\w-]+)\.jpg$/);
    if (coverMatch) {
      const f = safeFile(COVER_DIR, coverMatch[1] + '.jpg');
      if (f && fs.existsSync(f)) {
        // 安全网：若封面文件被损坏（如历史数据混入了 data URI 前缀乱码），
        // 自动从 JPEG 起始标记 ffd8ff 处截取后再返回，保证封面始终可显示。
        let buf = fs.readFileSync(f);
        const soi = buf.indexOf(Buffer.from('ffd8ff', 'hex'));
        if (soi > 0) {
          buf = buf.slice(soi);
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache' });
          return res.end(buf);
        }
        return serveStatic(res, f);
      }
      // 无封面时回退到占位图
      return serveStatic(res, safeFile(PUBLIC, 'no-cover.svg'));
    }

    // 常规页面 / 资源
    let rel = pathname === '/' ? '/index.html' : pathname;
    // 禁止访问仓库源码 / 配置 / git 元数据等敏感文件（这些不是站点资源）
    if (/^\/(?:\.git|\.github|\.gitignore|README\.md|LICENSE|server\.js|config\.json)(?:$|\/)/i.test(pathname)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found'); return;
    }
    // 防目录穿越
    const target = safeFile(PUBLIC, rel);
    if (!target) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    serveStatic(res, target);
  } catch (err) {
    console.error('请求处理错误:', err);
    if (!res.headersSent) sendJSON(res, 500, { ok: false, error: '服务器内部错误' });
  }
});

server.listen(PORT, () => {
  const cfg = loadConfig();
  console.log(`📚 PDF 图书馆已启动: http://localhost:${PORT}`);
  console.log(`   前台书架: http://localhost:${PORT}/`);
  console.log(`   后台管理: http://localhost:${PORT}/admin.html`);
  console.log(`   密码：已加盐哈希保存于 data/config.json（最后更新 ${new Date(cfg.updatedAt).toLocaleString('zh-CN')}）`);
  console.log(`   忘记密码可用 RESET_PASSWORD=1 启动重置为 ADMIN_PASSWORD 环境变量的值`);
});
