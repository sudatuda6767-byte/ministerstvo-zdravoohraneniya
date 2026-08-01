const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const SECRET = 'super_secret_hr_key_2024';
const db = new Database('hr.db');

// Создаём папку uploads
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const upload = multer({ dest: 'uploads/', limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// ==================== БАЗА ДАННЫХ ====================
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    login TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    nickname TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'Сотрудник',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS blacklist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fio TEXT NOT NULL,
    date_added TEXT NOT NULL,
    date_until TEXT,
    reason TEXT NOT NULL,
    added_by_role TEXT NOT NULL,
    added_by_fio TEXT NOT NULL,
    added_by_user_id INTEGER,
    removal_fee TEXT,
    removal_action TEXT,
    is_removed INTEGER DEFAULT 0,
    removed_at TEXT,
    removed_by_role TEXT,
    removed_by_fio TEXT,
    removed_by_user_id INTEGER,
    is_amnestied INTEGER DEFAULT 0,
    amnestied_at TEXT,
    amnestied_by_role TEXT,
    amnestied_by_fio TEXT,
    amnestied_by_user_id INTEGER
  );

  CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_number TEXT,
    fio TEXT NOT NULL,
    phone TEXT,
    special_comm TEXT,
    special_id TEXT,
    interview_datetime TEXT,
    interview_responsible TEXT,
    acceptance_responsible TEXT,
    passport_file TEXT,
    license_file TEXT,
    medcard_file TEXT,
    status TEXT DEFAULT 'pending',
    reject_reason TEXT,
    decided_by_role TEXT,
    decided_by_fio TEXT,
    decided_by_user_id INTEGER,
    decided_at TEXT,
    blacklist_info TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_by_user_id INTEGER
  );
`);

// ==================== ХЕЛПЕРЫ ====================
const PRIVILEGED_ROLES = [
  'Заведующий ОК', 'Заместитель Заведующего ОК',
  'Заведующий АБ', 'Заместитель Заведующего АБ',
  'Заместитель Главного Врача', 'Главный Врач'
];

const OK_ROLES = ['Заведующий ОК', 'Заместитель Заведующего ОК'];

function extractFIO(nickname) {
  // Убираем приставки в квадратных скобках: [Зав. АБ] Сергеев А.Б. -> Сергеев А.Б.
  return nickname.replace(/\[.*?\]\s*/g, '').trim();
}

function authMiddleware(req, res, next) {
  const token = req.cookies.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Не авторизован' });
  try {
    const decoded = jwt.verify(token, SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.id);
    if (!user) return res.status(401).json({ error: 'Пользователь не найден' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Невалидный токен' });
  }
}

function requireRoles(roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Недостаточно прав. Требуется: ' + roles.join(', ') });
    }
    next();
  };
}

// ==================== АВТОРИЗАЦИЯ ====================
app.post('/api/register', (req, res) => {
  const { login, password, nickname, role } = req.body;
  if (!login || !password || !nickname) return res.status(400).json({ error: 'Заполните все поля' });
  const exists = db.prepare('SELECT id FROM users WHERE login = ?').get(login);
  if (exists) return res.status(400).json({ error: 'Логин уже занят' });
  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO users (login, password, nickname, role) VALUES (?, ?, ?, ?)')
    .run(login, hash, nickname, role || 'Сотрудник');
  const token = jwt.sign({ id: result.lastInsertRowid }, SECRET, { expiresIn: '30d' });
  res.cookie('token', token, { httpOnly: true, maxAge: 30 * 24 * 3600 * 1000 });
  res.json({ success: true, token });
});

app.post('/api/login', (req, res) => {
  const { login, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE login = ?').get(login);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(400).json({ error: 'Неверный логин или пароль' });
  }
  const token = jwt.sign({ id: user.id }, SECRET, { expiresIn: '30d' });
  res.cookie('token', token, { httpOnly: true, maxAge: 30 * 24 * 3600 * 1000 });
  res.json({ success: true, token });
});

app.get('/api/me', authMiddleware, (req, res) => {
  const { password, ...user } = req.user;
  res.json(user);
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

// Обновление профиля
app.put('/api/me', authMiddleware, (req, res) => {
  const { nickname, role } = req.body;
  if (nickname) db.prepare('UPDATE users SET nickname = ? WHERE id = ?').run(nickname, req.user.id);
  if (role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.user.id);
  res.json({ success: true });
});

// ==================== ЧЁРНЫЙ СПИСОК ====================
app.get('/api/blacklist', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT * FROM blacklist ORDER BY id DESC').all();
  res.json(rows);
});

app.post('/api/blacklist', authMiddleware, requireRoles(PRIVILEGED_ROLES), (req, res) => {
  const { fio, date_until, reason, removal_fee, removal_action } = req.body;
  if (!fio || !reason) return res.status(400).json({ error: 'ФИО и причина обязательны' });
  const now = new Date().toLocaleString('ru-RU');
  const userFio = extractFIO(req.user.nickname);
  const result = db.prepare(`
    INSERT INTO blacklist (fio, date_added, date_until, reason, added_by_role, added_by_fio, added_by_user_id, removal_fee, removal_action)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(fio, now, date_until || '', reason, req.user.role, userFio, req.user.id, removal_fee || '', removal_action || '');
  res.json({ success: true, id: result.lastInsertRowid });
});

// Снятие ЧС (галочка)
app.put('/api/blacklist/:id/remove', authMiddleware, requireRoles(PRIVILEGED_ROLES), (req, res) => {
  const row = db.prepare('SELECT * FROM blacklist WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Запись не найдена' });
  const now = new Date().toLocaleString('ru-RU');
  const userFio = extractFIO(req.user.nickname);
  // Фиксируем роль и ФИО на момент нажатия — сохраняем навсегда
  db.prepare(`
    UPDATE blacklist SET is_removed = 1, removed_at = ?, removed_by_role = ?, removed_by_fio = ?, removed_by_user_id = ?
    WHERE id = ?
  `).run(now, req.user.role, userFio, req.user.id, req.params.id);
  res.json({ success: true });
});

// Амнистия (галочка)
app.put('/api/blacklist/:id/amnesty', authMiddleware, requireRoles(PRIVILEGED_ROLES), (req, res) => {
  const row = db.prepare('SELECT * FROM blacklist WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Запись не найдена' });
  const now = new Date().toLocaleString('ru-RU');
  const userFio = extractFIO(req.user.nickname);
  db.prepare(`
    UPDATE blacklist SET is_amnestied = 1, amnestied_at = ?, amnestied_by_role = ?, amnestied_by_fio = ?, amnestied_by_user_id = ?
    WHERE id = ?
  `).run(now, req.user.role, userFio, req.user.id, req.params.id);
  res.json({ success: true });
});

// ==================== АНКЕТЫ ПРИЁМА ====================
// Загрузка файлов
app.post('/api/upload', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  const ext = path.extname(req.file.originalname) || '.png';
  const newName = req.file.filename + ext;
  fs.renameSync(req.file.path, path.join('uploads', newName));
  res.json({ url: '/uploads/' + newName });
});

// Создание анкеты
app.post('/api/applications', authMiddleware, (req, res) => {
  const { fio, phone, special_comm, special_id, interview_datetime, interview_responsible, acceptance_responsible, passport_file, license_file, medcard_file } = req.body;
  if (!fio) return res.status(400).json({ error: 'ФИО обязательно' });

  // Проверка ЧС
  const blEntry = db.prepare("SELECT * FROM blacklist WHERE fio = ? AND is_removed = 0 AND is_amnestied = 0").get(fio);
  if (blEntry) {
    return res.status(400).json({
      error: `Данный гражданин находится в Чёрном Списке организации по причине: "${blEntry.reason}" до ${blEntry.date_until || 'бессрочно'}. Заносил: ${blEntry.added_by_role} ${blEntry.added_by_fio}`,
      blacklisted: true
    });
  }

  // Генерация номера дела
  const count = db.prepare('SELECT COUNT(*) as c FROM applications').get().c;
  const caseNum = 'ЛД-' + String(count + 1).padStart(4, '0');

  const result = db.prepare(`
    INSERT INTO applications (case_number, fio, phone, special_comm, special_id, interview_datetime, interview_responsible, acceptance_responsible, passport_file, license_file, medcard_file, created_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(caseNum, fio, phone || '', special_comm || '', special_id || '', interview_datetime || '', interview_responsible || '', acceptance_responsible || '', passport_file || '', license_file || '', medcard_file || '', req.user.id);
  res.json({ success: true, id: result.lastInsertRowid, case_number: caseNum });
});

app.get('/api/applications', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT * FROM applications ORDER BY id DESC').all();
  res.json(rows);
});

// Одобрить / Отклонить
app.put('/api/applications/:id/decide', authMiddleware, requireRoles(OK_ROLES), (req, res) => {
  const { decision, reject_reason } = req.body; // decision: 'approved' | 'rejected'
  const row = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Анкета не найдена' });
  if (row.status !== 'pending') return res.status(400).json({ error: 'Решение уже принято' });

  const now = new Date().toLocaleString('ru-RU');
  const userFio = extractFIO(req.user.nickname);

  db.prepare(`
    UPDATE applications SET status = ?, reject_reason = ?, decided_by_role = ?, decided_by_fio = ?, decided_by_user_id = ?, decided_at = ?
    WHERE id = ?
  `).run(decision, reject_reason || '', req.user.role, userFio, req.user.id, now, req.params.id);
  res.json({ success: true });
});

// ==================== ЗАПУСК ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен: http://localhost:${PORT}`));
