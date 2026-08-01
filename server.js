'use strict';

const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, Events
} = require('discord.js');

// ─── ENV ────────────────────────────────────
const PORT                     = process.env.PORT || 3000;
const JWT_SECRET               = process.env.JWT_SECRET || 'change_me_jwt';
const DISCORD_TOKEN            = process.env.DISCORD_TOKEN || '';
const DISCORD_CLIENT_ID        = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_GUILD_ID         = process.env.DISCORD_GUILD_ID || '';
const APPLICATIONS_CHANNEL_ID  = process.env.APPLICATIONS_CHANNEL_ID || '';
const BLACKLIST_LOG_CHANNEL_ID = process.env.BLACKLIST_LOG_CHANNEL_ID || '';
const BASE_URL                 = process.env.BASE_URL || `http://localhost:${PORT}`;

const ROLE_IDS = {
  ZAV_OK:     process.env.ROLE_ZAV_OK_ID     || '',
  ZAM_ZAV_OK: process.env.ROLE_ZAM_ZAV_OK_ID || '',
  ZAV_AB:     process.env.ROLE_ZAV_AB_ID     || '',
  ZAM_ZAV_AB: process.env.ROLE_ZAM_ZAV_AB_ID || '',
  ZAM_GV:     process.env.ROLE_ZAM_GV_ID     || '',
  GV:         process.env.ROLE_GV_ID         || ''
};

const BL_ALLOWED_ROLES   = Object.values(ROLE_IDS).filter(Boolean);
const APP_DECISION_ROLES = [ROLE_IDS.ZAV_OK, ROLE_IDS.ZAM_ZAV_OK].filter(Boolean);

// ─── UPLOADS ────────────────────────────────
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const storage = multer.diskStorage({
  destination: (_r, _f, cb) => cb(null, 'uploads/'),
  filename: (_r, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, Date.now() + '_' + Math.random().toString(36).slice(2) + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 } });

// ─── DATABASE ───────────────────────────────
const db = new Database('hr.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    login TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    nickname TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'Сотрудник',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS blacklist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fio TEXT NOT NULL,
    fio_norm TEXT NOT NULL,
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
    case_number TEXT NOT NULL,
    fio TEXT NOT NULL,
    fio_norm TEXT NOT NULL,
    phone TEXT,
    special_comm TEXT,
    special_id TEXT,
    interview_datetime TEXT,
    interview_responsible TEXT,
    acceptance_responsible TEXT,
    passport_url TEXT,
    license_url TEXT,
    medcard_url TEXT,
    submitted_by_role TEXT,
    submitted_by_fio TEXT,
    submitted_by_user_id INTEGER,
    status TEXT DEFAULT 'pending',
    reject_reason TEXT,
    decided_by_role TEXT,
    decided_by_fio TEXT,
    decided_at TEXT,
    discord_channel_id TEXT,
    discord_message_id TEXT,
    created_at TEXT NOT NULL
  );
`);

// ─── HELPERS ────────────────────────────────
const nowRu   = () => new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
const safe    = v => (v && String(v).trim()) ? String(v).trim() : '—';
const normFio = v => String(v || '').trim().replace(/\s+/g, ' ').toLowerCase();

// Главное исправление — парсинг ФИО
// Примеры ников:
//   "Глав. Врач | Швец О. В."       → "Швец О. В."
//   "[Зав. ОК] Иванов И.И."         → "Иванов И.И."
//   "Зам. Зав. АБ | Петрова А.Б."   → "Петрова А.Б."
//   "Сергеев А.Б."                  → "Сергеев А.Б."
function extractFIO(nick) {
  let s = String(nick || '').trim();
  // Убираем [что угодно]
  s = s.replace(/\[.*?\]\s*/g, '');
  // Если есть разделитель | — берём то что после него
  if (s.includes('|')) {
    s = s.split('|').pop().trim();
  }
  // Если всё ещё начинается с должностных приставок типа "Глав. Врач", "Зав. ОК" и т.п.
  // убираем всё до последней фамилии (ищем паттерн: Фамилия + инициалы)
  const fioMatch = s.match(/([А-ЯЁ][а-яё]+\s+[А-ЯЁ]\.\s*[А-ЯЁ]\.\s*)$/);
  if (fioMatch) return fioMatch[1].trim();
  const fioMatch2 = s.match(/([А-ЯЁ][а-яё]+\s+[А-ЯЁ]\.[А-ЯЁ]\.\s*)$/);
  if (fioMatch2) return fioMatch2[1].trim();
  // Полное ФИО: Иванов Иван Иванович
  const fioFull = s.match(/([А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+)\s*$/);
  if (fioFull) return fioFull[1].trim();
  return s;
}

function nextCaseNumber() {
  const row = db.prepare('SELECT id FROM applications ORDER BY id DESC LIMIT 1').get();
  return 'ЛД-' + String((row?.id || 0) + 1).padStart(4, '0');
}

// ─── DISCORD HELPERS ────────────────────────
function getRoleLabel(member) {
  if (!member?.roles?.cache) return 'Сотрудник';
  const ids = [...member.roles.cache.keys()];
  if (ROLE_IDS.GV         && ids.includes(ROLE_IDS.GV))         return 'Главный Врач';
  if (ROLE_IDS.ZAM_GV     && ids.includes(ROLE_IDS.ZAM_GV))     return 'Заместитель Главного Врача';
  if (ROLE_IDS.ZAV_OK     && ids.includes(ROLE_IDS.ZAV_OK))     return 'Заведующий ОК';
  if (ROLE_IDS.ZAM_ZAV_OK && ids.includes(ROLE_IDS.ZAM_ZAV_OK)) return 'Заместитель Заведующего ОК';
  if (ROLE_IDS.ZAV_AB     && ids.includes(ROLE_IDS.ZAV_AB))     return 'Заведующий АБ';
  if (ROLE_IDS.ZAM_ZAV_AB && ids.includes(ROLE_IDS.ZAM_ZAV_AB)) return 'Заместитель Заведующего АБ';
  return 'Сотрудник';
}

function hasRole(member, allowed) {
  if (!member?.roles?.cache) return false;
  const ids = [...member.roles.cache.keys()];
  return allowed.some(id => ids.includes(id));
}

function actorSnap(interaction) {
  const display = interaction.member?.displayName
    || interaction.user?.globalName
    || interaction.user?.username || '?';
  return {
    role: getRoleLabel(interaction.member),
    fio: extractFIO(display),
    id: interaction.user.id
  };
}

function statusColor(s) {
  if (s === 'approved') return 0x00c853;
  if (s === 'rejected') return 0xff4444;
  return 0xff9800;
}
function statusLabel(s) {
  if (s === 'approved') return '✅ Одобрено';
  if (s === 'rejected') return '❌ Отклонено';
  return '🟠 На рассмотрении';
}

function buildAppEmbed(a) {
  const docs = [
    a.passport_url ? `[📄 Паспорт](${a.passport_url})` : '📄 Паспорт: нет',
    a.license_url  ? `[📄 Лицензии](${a.license_url})`  : '📄 Лицензии: нет',
    a.medcard_url  ? `[📄 Мед. карта](${a.medcard_url})` : '📄 Мед. карта: нет'
  ].join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`📋 ${safe(a.case_number)}`)
    .setColor(statusColor(a.status))
    .addFields(
      { name: 'Статус',         value: statusLabel(a.status), inline: false },
      { name: 'Ф.И.О.',         value: safe(a.fio),            inline: true },
      { name: 'Телефон',        value: safe(a.phone),          inline: true },
      { name: 'Спец. связь',    value: safe(a.special_comm),   inline: true },
      { name: 'Спец. ID',       value: safe(a.special_id),     inline: true },
      { name: 'Собеседование',  value: safe(a.interview_datetime), inline: false },
      { name: 'Отв. собес.',    value: safe(a.interview_responsible), inline: true },
      { name: 'Отв. принятие',  value: safe(a.acceptance_responsible), inline: true },
      { name: 'Документы',      value: docs, inline: false },
      { name: 'Подал',          value: `${safe(a.submitted_by_role)}, ${safe(a.submitted_by_fio)}`, inline: true },
      { name: 'Создано',        value: safe(a.created_at), inline: true }
    )
    .setTimestamp();

  if (a.status !== 'pending' && a.decided_by_role) {
    let dec = `${safe(a.decided_by_role)}, ${safe(a.decided_by_fio)}\n${safe(a.decided_at)}`;
    if (a.status === 'rejected' && a.reject_reason) dec += `\n**Причина:** ${a.reject_reason}`;
    embed.addFields({ name: 'Решение', value: dec, inline: false });
  }

  return embed;
}

function buildAppButtons(a) {
  const dis = a.status !== 'pending';
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`app:approve:${a.id}`).setLabel('✅ Одобрить').setStyle(ButtonStyle.Success).setDisabled(dis),
    new ButtonBuilder().setCustomId(`app:reject:${a.id}`).setLabel('❌ Отклонить').setStyle(ButtonStyle.Danger).setDisabled(dis)
  )];
}

async function syncAppMsg(a) {
  if (!a.discord_channel_id || !a.discord_message_id) return;
  try {
    const ch = await dc.channels.fetch(a.discord_channel_id);
    const msg = await ch.messages.fetch(a.discord_message_id);
    await msg.edit({ embeds: [buildAppEmbed(a)], components: buildAppButtons(a) });
  } catch (e) { console.error('syncAppMsg:', e.message); }
}

async function logBL(title, color, row) {
  if (!BLACKLIST_LOG_CHANNEL_ID) return;
  try {
    const ch = await dc.channels.fetch(BLACKLIST_LOG_CHANNEL_ID);
    const embed = new EmbedBuilder()
      .setTitle(title).setColor(color)
      .addFields(
        { name: 'ID', value: String(row.id), inline: true },
        { name: 'Ф.И.О.', value: safe(row.fio), inline: true },
        { name: 'Причина', value: safe(row.reason), inline: false },
        { name: 'Внёс', value: `${safe(row.added_by_role)}, ${safe(row.added_by_fio)}`, inline: true },
        { name: 'До', value: safe(row.date_until), inline: true },
        { name: 'Сумма', value: safe(row.removal_fee), inline: true },
        { name: 'Действие', value: safe(row.removal_action), inline: true }
      ).setTimestamp();
    if (row.is_removed) embed.addFields({ name: 'ЧС снят', value: `${safe(row.removed_by_role)}, ${safe(row.removed_by_fio)}\n${safe(row.removed_at)}`, inline: false });
    if (row.is_amnestied) embed.addFields({ name: 'Амнистирован', value: `${safe(row.amnestied_by_role)}, ${safe(row.amnestied_by_fio)}\n${safe(row.amnestied_at)}`, inline: false });
    await ch.send({ embeds: [embed] });
  } catch (e) { console.error('logBL:', e.message); }
}

// ─── DISCORD CLIENT ─────────────────────────
const dc = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

const slashDefs = [
  new SlashCommandBuilder().setName('bl-add').setDescription('Добавить в ЧС')
    .addStringOption(o => o.setName('fio').setDescription('Ф.И.О.').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Причина').setRequired(true))
    .addStringOption(o => o.setName('date_until').setDescription('До какой даты').setRequired(false))
    .addStringOption(o => o.setName('fee').setDescription('Сумма за вынос').setRequired(false))
    .addStringOption(o => o.setName('action').setDescription('Действие для выноса').setRequired(false)),
  new SlashCommandBuilder().setName('bl-remove').setDescription('Снять ЧС')
    .addIntegerOption(o => o.setName('id').setDescription('ID записи').setRequired(true)),
  new SlashCommandBuilder().setName('bl-amnesty').setDescription('Амнистировать')
    .addIntegerOption(o => o.setName('id').setDescription('ID записи').setRequired(true)),
  new SlashCommandBuilder().setName('bl-find').setDescription('Поиск по ЧС')
    .addStringOption(o => o.setName('fio').setDescription('Ф.И.О. или часть').setRequired(true)),
  new SlashCommandBuilder().setName('bl-list').setDescription('Активные записи ЧС'),
  new SlashCommandBuilder().setName('app-view').setDescription('Посмотреть анкету')
    .addIntegerOption(o => o.setName('id').setDescription('ID анкеты').setRequired(true))
].map(c => c.toJSON());

dc.once(Events.ClientReady, async () => {
  console.log(`Discord: ${dc.user.tag}`);
  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID), { body: slashDefs });
    console.log('Discord: команды ОК');
  } catch (e) { console.error('Discord cmds:', e.message); }
});

dc.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;

      if (cmd === 'bl-add') {
        if (!hasRole(interaction.member, BL_ALLOWED_ROLES)) return interaction.reply({ content: '❌ Нет прав.', ephemeral: true });
        const fio = interaction.options.getString('fio', true).trim();
        const reason = interaction.options.getString('reason', true).trim();
        const until = (interaction.options.getString('date_until') || '').trim();
        const fee = (interaction.options.getString('fee') || '').trim();
        const action = (interaction.options.getString('action') || '').trim();
        const actor = actorSnap(interaction);
        const r = db.prepare('INSERT INTO blacklist (fio,fio_norm,date_added,date_until,reason,added_by_role,added_by_fio,removal_fee,removal_action) VALUES (?,?,?,?,?,?,?,?,?)').run(fio, normFio(fio), nowRu(), until, reason, actor.role, actor.fio, fee, action);
        const row = db.prepare('SELECT * FROM blacklist WHERE id=?').get(r.lastInsertRowid);
        await logBL('🚫 Добавление в ЧС', 0xff4444, row);
        return interaction.reply({ content: `✅ ЧС создан. ID: **${row.id}**`, ephemeral: true });
      }

      if (cmd === 'bl-remove') {
        if (!hasRole(interaction.member, BL_ALLOWED_ROLES)) return interaction.reply({ content: '❌ Нет прав.', ephemeral: true });
        const id = interaction.options.getInteger('id', true);
        const row = db.prepare('SELECT * FROM blacklist WHERE id=?').get(id);
        if (!row) return interaction.reply({ content: '❌ Не найдено.', ephemeral: true });
        if (row.is_removed) return interaction.reply({ content: '❌ Уже снят.', ephemeral: true });
        const actor = actorSnap(interaction);
        db.prepare('UPDATE blacklist SET is_removed=1,removed_at=?,removed_by_role=?,removed_by_fio=? WHERE id=?').run(nowRu(), actor.role, actor.fio, id);
        const updated = db.prepare('SELECT * FROM blacklist WHERE id=?').get(id);
        await logBL('✅ ЧС снят', 0x00c853, updated);
        return interaction.reply({ content: `✅ Снят: **${updated.fio}**`, ephemeral: true });
      }

      if (cmd === 'bl-amnesty') {
        if (!hasRole(interaction.member, BL_ALLOWED_ROLES)) return interaction.reply({ content: '❌ Нет прав.', ephemeral: true });
        const id = interaction.options.getInteger('id', true);
        const row = db.prepare('SELECT * FROM blacklist WHERE id=?').get(id);
        if (!row) return interaction.reply({ content: '❌ Не найдено.', ephemeral: true });
        if (row.is_amnestied) return interaction.reply({ content: '❌ Уже амнистирован.', ephemeral: true });
        const actor = actorSnap(interaction);
        db.prepare('UPDATE blacklist SET is_amnestied=1,amnestied_at=?,amnestied_by_role=?,amnestied_by_fio=? WHERE id=?').run(nowRu(), actor.role, actor.fio, id);
        const updated = db.prepare('SELECT * FROM blacklist WHERE id=?').get(id);
        await logBL('🕊 Амнистия', 0x7c83ff, updated);
        return interaction.reply({ content: `✅ Амнистия: **${updated.fio}**`, ephemeral: true });
      }

      if (cmd === 'bl-find') {
        const q = interaction.options.getString('fio', true).trim().toLowerCase();
        const rows = db.prepare('SELECT * FROM blacklist WHERE fio_norm LIKE ? ORDER BY id DESC LIMIT 10').all(`%${q}%`);
        if (!rows.length) return interaction.reply({ content: 'Ничего не найдено.', ephemeral: true });
        const lines = rows.map(r => `**ID ${r.id}** | ${r.fio}\nПричина: ${r.reason}\nВнёс: ${r.added_by_role}, ${r.added_by_fio}\nСнят: ${r.is_removed ? 'Да' : 'Нет'} | Амнистия: ${r.is_amnestied ? 'Да' : 'Нет'}`).join('\n─────\n');
        return interaction.reply({ content: lines.length > 1900 ? lines.slice(0, 1900) + '\n...' : lines, ephemeral: true });
      }

      if (cmd === 'bl-list') {
        const rows = db.prepare('SELECT * FROM blacklist WHERE is_removed=0 AND is_amnestied=0 ORDER BY id DESC LIMIT 10').all();
        if (!rows.length) return interaction.reply({ content: 'ЧС пуст.', ephemeral: true });
        const lines = rows.map(r => `**ID ${r.id}** | ${r.fio}\nПричина: ${r.reason} | До: ${safe(r.date_until)}`).join('\n─────\n');
        return interaction.reply({ content: lines, ephemeral: true });
      }

      if (cmd === 'app-view') {
        const id = interaction.options.getInteger('id', true);
        const row = db.prepare('SELECT * FROM applications WHERE id=?').get(id);
        if (!row) return interaction.reply({ content: '❌ Не найдена.', ephemeral: true });
        return interaction.reply({ embeds: [buildAppEmbed(row)], ephemeral: true });
      }
    }

    // ── BUTTONS ──
    if (interaction.isButton()) {
      const [ns, action, rawId] = interaction.customId.split(':');
      if (ns !== 'app') return;
      const appId = Number(rawId);
      const row = db.prepare('SELECT * FROM applications WHERE id=?').get(appId);
      if (!row) return interaction.reply({ content: '❌ Не найдена.', ephemeral: true });
      if (!hasRole(interaction.member, APP_DECISION_ROLES)) return interaction.reply({ content: '❌ Нет прав. Нужна роль Зав.ОК или Зам.Зав.ОК.', ephemeral: true });
      if (row.status !== 'pending') return interaction.reply({ content: '❌ Решение уже принято.', ephemeral: true });

      if (action === 'approve') {
        const actor = actorSnap(interaction);
        const res = db.prepare('UPDATE applications SET status=\'approved\',reject_reason=\'\',decided_by_role=?,decided_by_fio=?,decided_at=? WHERE id=? AND status=\'pending\'').run(actor.role, actor.fio, nowRu(), appId);
        if (!res.changes) return interaction.reply({ content: '❌ Уже решено.', ephemeral: true });
        const updated = db.prepare('SELECT * FROM applications WHERE id=?').get(appId);
        await syncAppMsg(updated);
        return interaction.reply({ content: `✅ **${updated.case_number}** одобрена.`, ephemeral: true });
      }

      if (action === 'reject') {
        const modal = new ModalBuilder().setCustomId(`modal:reject:${appId}`).setTitle('Причина отказа');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('reason').setLabel('Укажите причину').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)
        ));
        return interaction.showModal(modal);
      }
    }

    // ── MODAL ──
    if (interaction.isModalSubmit()) {
      const [ns, action, rawId] = interaction.customId.split(':');
      if (ns !== 'modal' || action !== 'reject') return;
      const appId = Number(rawId);
      const row = db.prepare('SELECT * FROM applications WHERE id=?').get(appId);
      if (!row) return interaction.reply({ content: '❌ Не найдена.', ephemeral: true });
      if (!hasRole(interaction.member, APP_DECISION_ROLES)) return interaction.reply({ content: '❌ Нет прав.', ephemeral: true });
      if (row.status !== 'pending') return interaction.reply({ content: '❌ Решение уже принято.', ephemeral: true });
      const reason = interaction.fields.getTextInputValue('reason').trim();
      const actor = actorSnap(interaction);
      const res = db.prepare('UPDATE applications SET status=\'rejected\',reject_reason=?,decided_by_role=?,decided_by_fio=?,decided_at=? WHERE id=? AND status=\'pending\'').run(reason, actor.role, actor.fio, nowRu(), appId);
      if (!res.changes) return interaction.reply({ content: '❌ Уже решено.', ephemeral: true });
      const updated = db.prepare('SELECT * FROM applications WHERE id=?').get(appId);
      await syncAppMsg(updated);
      return interaction.reply({ content: `❌ **${updated.case_number}** отклонена.`, ephemeral: true });
    }

  } catch (e) {
    console.error('interaction error:', e);
    try {
      if (interaction.replied || interaction.deferred) await interaction.followUp({ content: '⚠️ Ошибка.', ephemeral: true });
      else await interaction.reply({ content: '⚠️ Ошибка.', ephemeral: true });
    } catch {}
  }
});

// ─── EXPRESS ────────────────────────────────
const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

function authMW(req, res, next) {
  const token = req.cookies?.token || (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Не авторизован' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(decoded.id);
    if (!user) return res.status(401).json({ error: 'Не найден' });
    req.user = user;
    next();
  } catch { return res.status(401).json({ error: 'Невалидный токен' }); }
}

function requireRoles(roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Нет прав' });
    next();
  };
}

const SITE_BL_ROLES = ['Заведующий ОК','Заместитель Заведующего ОК','Заведующий АБ','Заместитель Заведующего АБ','Заместитель Главного Врача','Главный Врач'];
const SITE_OK_ROLES = ['Заведующий ОК','Заместитель Заведующего ОК'];

// ── AUTH ROUTES ──
app.post('/api/register', (req, res) => {
  const { login, password, nickname, role } = req.body;
  if (!login || !password || !nickname) return res.status(400).json({ error: 'Заполни все поля' });
  if (db.prepare('SELECT id FROM users WHERE login=?').get(login)) return res.status(400).json({ error: 'Логин занят' });
  const hash = bcrypt.hashSync(password, 10);
  const r = db.prepare('INSERT INTO users (login,password,nickname,role,created_at) VALUES (?,?,?,?,?)').run(login, hash, nickname, role || 'Сотрудник', nowRu());
  const token = jwt.sign({ id: r.lastInsertRowid }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('token', token, { httpOnly: true, maxAge: 30 * 24 * 3600 * 1000 });
  res.json({ success: true });
});

app.post('/api/login', (req, res) => {
  const { login, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE login=?').get(login);
  if (!user || !bcrypt.compareSync(password, user.password)) return res.status(400).json({ error: 'Неверный логин или пароль' });
  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('token', token, { httpOnly: true, maxAge: 30 * 24 * 3600 * 1000 });
  res.json({ success: true });
});

app.post('/api/logout', (_req, res) => { res.clearCookie('token'); res.json({ success: true }); });
app.get('/api/me', authMW, (req, res) => { const { password: _, ...u } = req.user; res.json(u); });

// ── BLACKLIST ROUTES ──
app.get('/api/blacklist', authMW, (_req, res) => res.json(db.prepare('SELECT * FROM blacklist ORDER BY id DESC').all()));

app.post('/api/blacklist', authMW, requireRoles(SITE_BL_ROLES), (req, res) => {
  const { fio, date_until, reason, removal_fee, removal_action } = req.body;
  if (!fio || !reason) return res.status(400).json({ error: 'ФИО и причина обязательны' });
  const uf = extractFIO(req.user.nickname);
  const r = db.prepare('INSERT INTO blacklist (fio,fio_norm,date_added,date_until,reason,added_by_role,added_by_fio,added_by_user_id,removal_fee,removal_action) VALUES (?,?,?,?,?,?,?,?,?,?)').run(fio, normFio(fio), nowRu(), date_until || '', reason, req.user.role, uf, req.user.id, removal_fee || '', removal_action || '');
  const row = db.prepare('SELECT * FROM blacklist WHERE id=?').get(r.lastInsertRowid);
  logBL('🚫 ЧС (сайт)', 0xff4444, row).catch(() => {});
  res.json({ success: true, id: row.id });
});

app.put('/api/blacklist/:id/remove', authMW, requireRoles(SITE_BL_ROLES), (req, res) => {
  const row = db.prepare('SELECT * FROM blacklist WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Не найдено' });
  if (row.is_removed) return res.status(400).json({ error: 'Уже снят' });
  const uf = extractFIO(req.user.nickname);
  db.prepare('UPDATE blacklist SET is_removed=1,removed_at=?,removed_by_role=?,removed_by_fio=?,removed_by_user_id=? WHERE id=?').run(nowRu(), req.user.role, uf, req.user.id, req.params.id);
  const updated = db.prepare('SELECT * FROM blacklist WHERE id=?').get(req.params.id);
  logBL('✅ ЧС снят (сайт)', 0x00c853, updated).catch(() => {});
  res.json({ success: true });
});

app.put('/api/blacklist/:id/amnesty', authMW, requireRoles(SITE_BL_ROLES), (req, res) => {
  const row = db.prepare('SELECT * FROM blacklist WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Не найдено' });
  if (row.is_amnestied) return res.status(400).json({ error: 'Уже амнистирован' });
  const uf = extractFIO(req.user.nickname);
  db.prepare('UPDATE blacklist SET is_amnestied=1,amnestied_at=?,amnestied_by_role=?,amnestied_by_fio=?,amnestied_by_user_id=? WHERE id=?').run(nowRu(), req.user.role, uf, req.user.id, req.params.id);
  const updated = db.prepare('SELECT * FROM blacklist WHERE id=?').get(req.params.id);
  logBL('🕊 Амнистия (сайт)', 0x7c83ff, updated).catch(() => {});
  res.json({ success: true });
});

// ── FILE UPLOAD ──
app.post('/api/upload', authMW, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  res.json({ url: `${BASE_URL}/uploads/${req.file.filename}` });
});

// ── APPLICATIONS ──
app.get('/api/applications', authMW, (_req, res) => res.json(db.prepare('SELECT * FROM applications ORDER BY id DESC').all()));

app.post('/api/applications', authMW, async (req, res) => {
  const { fio, phone, special_comm, special_id, interview_datetime, interview_responsible, acceptance_responsible, passport_url, license_url, medcard_url } = req.body;
  if (!fio || !String(fio).trim()) return res.status(400).json({ error: 'ФИО обязательно' });

  const bl = db.prepare('SELECT * FROM blacklist WHERE fio_norm=? AND is_removed=0 AND is_amnestied=0 ORDER BY id DESC LIMIT 1').get(normFio(fio));
  if (bl) return res.status(400).json({ error: `Данный гражданин в ЧС: "${bl.reason}" до ${bl.date_until || 'бессрочно'}. Заносил: ${bl.added_by_role}, ${bl.added_by_fio}`, blacklisted: true });

  const uf = extractFIO(req.user.nickname);
  const cn = nextCaseNumber();
  const ca = nowRu();

  const r = db.prepare('INSERT INTO applications (case_number,fio,fio_norm,phone,special_comm,special_id,interview_datetime,interview_responsible,acceptance_responsible,passport_url,license_url,medcard_url,submitted_by_role,submitted_by_fio,submitted_by_user_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(cn, String(fio).trim(), normFio(fio), phone || '', special_comm || '', special_id || '', interview_datetime || '', interview_responsible || '', acceptance_responsible || '', passport_url || '', license_url || '', medcard_url || '', req.user.role, uf, req.user.id, ca);

  const appRow = db.prepare('SELECT * FROM applications WHERE id=?').get(r.lastInsertRowid);

  if (dc.isReady() && APPLICATIONS_CHANNEL_ID) {
    try {
      const ch = await dc.channels.fetch(APPLICATIONS_CHANNEL_ID);
      const msg = await ch.send({ embeds: [buildAppEmbed(appRow)], components: buildAppButtons(appRow) });
      db.prepare('UPDATE applications SET discord_channel_id=?,discord_message_id=? WHERE id=?').run(msg.channelId, msg.id, appRow.id);
    } catch (e) { console.error('discord send:', e.message); }
  }

  res.json({ success: true, id: appRow.id, case_number: cn });
});

// ── ОДОБРЕНИЕ / ОТКАЗ С САЙТА ──
app.put('/api/applications/:id/decide', authMW, requireRoles(SITE_OK_ROLES), async (req, res) => {
  const { decision, reject_reason } = req.body;
  const row = db.prepare('SELECT * FROM applications WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Не найдена' });
  if (row.status !== 'pending') return res.status(400).json({ error: 'Решение уже принято' });

  const uf = extractFIO(req.user.nickname);
  const now = nowRu();

  db.prepare('UPDATE applications SET status=?,reject_reason=?,decided_by_role=?,decided_by_fio=?,decided_at=? WHERE id=?').run(decision, reject_reason || '', req.user.role, uf, now, req.params.id);

  const updated = db.prepare('SELECT * FROM applications WHERE id=?').get(req.params.id);
  await syncAppMsg(updated);
  res.json({ success: true });
});

// ── HEALTH ──
app.get('/health', (_req, res) => res.json({ ok: true, discord: dc.isReady() ? 'online' : 'offline' }));

// ─── START ──────────────────────────────────
app.listen(PORT, () => console.log(`HTTP: порт ${PORT}`));
if (!DISCORD_TOKEN) { console.error('Нет DISCORD_TOKEN'); }
else { dc.login(DISCORD_TOKEN).catch(e => console.error('DC login:', e.message)); }
