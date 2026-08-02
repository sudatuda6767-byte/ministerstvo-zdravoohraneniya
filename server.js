'use strict';

const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const crypto = require('crypto');

const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, Events
} = require('discord.js');

// ─── ENV ────────────────────────────────────
const PORT                     = process.env.PORT || 3000;
const JWT_SECRET               = process.env.JWT_SECRET || 'change_me_jwt';
const DATABASE_URL             = process.env.DATABASE_URL || '';
const DISCORD_TOKEN            = process.env.DISCORD_TOKEN || '';
const DISCORD_CLIENT_ID        = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_GUILD_ID         = process.env.DISCORD_GUILD_ID || '';
const APPLICATIONS_CHANNEL_ID  = process.env.APPLICATIONS_CHANNEL_ID || '';
const BLACKLIST_LOG_CHANNEL_ID = process.env.BLACKLIST_LOG_CHANNEL_ID || '';
const BASE_URL                 = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

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

// ─── POSTGRES ───────────────────────────────
if (!DATABASE_URL) {
  console.error('❌ Нет DATABASE_URL. Задай на Render в Environment.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function q(text, params = []) {
  const res = await pool.query(text, params);
  return res.rows;
}
async function qOne(text, params = []) {
  const rows = await q(text, params);
  return rows[0] || null;
}

async function initDB() {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      login TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      nickname TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'Сотрудник',
      created_at TEXT NOT NULL
    );
  `);
  await q(`
    CREATE TABLE IF NOT EXISTS blacklist (
      id SERIAL PRIMARY KEY,
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
  `);
  await q(`
    CREATE TABLE IF NOT EXISTS applications (
      id SERIAL PRIMARY KEY,
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
  // Файлы храним прямо в БД
  await q(`
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      mime TEXT NOT NULL,
      data BYTEA NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  console.log('✅ БД готова');
}

// ─── HELPERS ────────────────────────────────
const nowRu   = () => new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
const safe    = v => (v && String(v).trim()) ? String(v).trim() : '—';
const normFio = v => String(v || '').trim().replace(/\s+/g, ' ').toLowerCase();

function extractFIO(nick) {
  let s = String(nick || '').trim();
  s = s.replace(/\[.*?\]\s*/g, '');
  if (s.includes('|')) s = s.split('|').pop().trim();
  const m1 = s.match(/([А-ЯЁ][а-яё]+\s+[А-ЯЁ]\.\s*[А-ЯЁ]\.\s*)$/);
  if (m1) return m1[1].trim();
  const m2 = s.match(/([А-ЯЁ][а-яё]+\s+[А-ЯЁ]\.[А-ЯЁ]\.\s*)$/);
  if (m2) return m2[1].trim();
  const m3 = s.match(/([А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+)\s*$/);
  if (m3) return m3[1].trim();
  return s;
}

async function nextCaseNumber() {
  const row = await qOne('SELECT id FROM applications ORDER BY id DESC LIMIT 1');
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
  const display = interaction.member?.displayName || interaction.user?.globalName || interaction.user?.username || '?';
  return { role: getRoleLabel(interaction.member), fio: extractFIO(display), id: interaction.user.id };
}

function statusColor(s) { if (s==='approved') return 0x00c853; if (s==='rejected') return 0xff4444; return 0xff9800; }
function statusLabel(s) { if (s==='approved') return '✅ Одобрено'; if (s==='rejected') return '❌ Отклонено'; return '🟠 На рассмотрении'; }

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
      { name: 'Статус',        value: statusLabel(a.status), inline: false },
      { name: 'Ф.И.О.',        value: safe(a.fio),            inline: true },
      { name: 'Телефон',       value: safe(a.phone),          inline: true },
      { name: 'Спец. связь',   value: safe(a.special_comm),   inline: true },
      { name: 'Спец. ID',      value: safe(a.special_id),     inline: true },
      { name: 'Собеседование', value: safe(a.interview_datetime), inline: false },
      { name: 'Отв. собес.',   value: safe(a.interview_responsible), inline: true },
      { name: 'Отв. принятие', value: safe(a.acceptance_responsible), inline: true },
      { name: 'Документы',     value: docs, inline: false },
      { name: 'Подал',         value: `${safe(a.submitted_by_role)}, ${safe(a.submitted_by_fio)}`, inline: true },
      { name: 'Создано',       value: safe(a.created_at), inline: true }
    )
    .setTimestamp();

  if (a.passport_url) embed.setImage(a.passport_url);
  else if (a.license_url) embed.setImage(a.license_url);
  else if (a.medcard_url) embed.setImage(a.medcard_url);

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
    .addStringOption(o => o.setName('date_until').setDescription('До').setRequired(false))
    .addStringOption(o => o.setName('fee').setDescription('Сумма').setRequired(false))
    .addStringOption(o => o.setName('action').setDescription('Действие').setRequired(false)),
  new SlashCommandBuilder().setName('bl-remove').setDescription('Снять ЧС')
    .addIntegerOption(o => o.setName('id').setDescription('ID').setRequired(true)),
  new SlashCommandBuilder().setName('bl-amnesty').setDescription('Амнистировать')
    .addIntegerOption(o => o.setName('id').setDescription('ID').setRequired(true)),
  new SlashCommandBuilder().setName('bl-find').setDescription('Поиск по ЧС')
    .addStringOption(o => o.setName('fio').setDescription('ФИО').setRequired(true)),
  new SlashCommandBuilder().setName('bl-list').setDescription('Активные записи ЧС'),
  new SlashCommandBuilder().setName('app-view').setDescription('Посмотреть анкету')
    .addIntegerOption(o => o.setName('id').setDescription('ID').setRequired(true))
].map(c => c.toJSON());

dc.once(Events.ClientReady, async () => {
  console.log(`✅ Discord: ${dc.user.tag}`);
  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID), { body: slashDefs });
    console.log('✅ Slash-команды зарегистрированы');
  } catch (e) { console.error('Discord cmds:', e.message); }
});

dc.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;

      if (cmd === 'bl-add') {
        if (!hasRole(interaction.member, BL_ALLOWED_ROLES)) return interaction.reply({ content:'❌ Нет прав.', ephemeral:true });
        const fio = interaction.options.getString('fio', true).trim();
        const reason = interaction.options.getString('reason', true).trim();
        const until = (interaction.options.getString('date_until') || '').trim();
        const fee = (interaction.options.getString('fee') || '').trim();
        const action = (interaction.options.getString('action') || '').trim();
        const actor = actorSnap(interaction);
        const row = await qOne('INSERT INTO blacklist (fio,fio_norm,date_added,date_until,reason,added_by_role,added_by_fio,removal_fee,removal_action) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [fio, normFio(fio), nowRu(), until, reason, actor.role, actor.fio, fee, action]);
        await logBL('🚫 Добавление в ЧС', 0xff4444, row);
        return interaction.reply({ content:`✅ ЧС создан. ID: **${row.id}**`, ephemeral:true });
      }

      if (cmd === 'bl-remove') {
        if (!hasRole(interaction.member, BL_ALLOWED_ROLES)) return interaction.reply({ content:'❌ Нет прав.', ephemeral:true });
        const id = interaction.options.getInteger('id', true);
        const row = await qOne('SELECT * FROM blacklist WHERE id=$1', [id]);
        if (!row) return interaction.reply({ content:'❌ Не найдено.', ephemeral:true });
        if (row.is_removed) return interaction.reply({ content:'❌ Уже снят.', ephemeral:true });
        const actor = actorSnap(interaction);
        const upd = await qOne('UPDATE blacklist SET is_removed=1,removed_at=$1,removed_by_role=$2,removed_by_fio=$3 WHERE id=$4 RETURNING *', [nowRu(), actor.role, actor.fio, id]);
        await logBL('✅ ЧС снят', 0x00c853, upd);
        return interaction.reply({ content:`✅ Снят: **${upd.fio}**`, ephemeral:true });
      }

      if (cmd === 'bl-amnesty') {
        if (!hasRole(interaction.member, BL_ALLOWED_ROLES)) return interaction.reply({ content:'❌ Нет прав.', ephemeral:true });
        const id = interaction.options.getInteger('id', true);
        const row = await qOne('SELECT * FROM blacklist WHERE id=$1', [id]);
        if (!row) return interaction.reply({ content:'❌ Не найдено.', ephemeral:true });
        if (row.is_amnestied) return interaction.reply({ content:'❌ Уже амнистирован.', ephemeral:true });
        const actor = actorSnap(interaction);
        const upd = await qOne('UPDATE blacklist SET is_amnestied=1,amnestied_at=$1,amnestied_by_role=$2,amnestied_by_fio=$3 WHERE id=$4 RETURNING *', [nowRu(), actor.role, actor.fio, id]);
        await logBL('🕊 Амнистия', 0x7c83ff, upd);
        return interaction.reply({ content:`✅ Амнистия: **${upd.fio}**`, ephemeral:true });
      }

      if (cmd === 'bl-find') {
        const qStr = interaction.options.getString('fio', true).trim().toLowerCase();
        const rows = await q('SELECT * FROM blacklist WHERE fio_norm LIKE $1 ORDER BY id DESC LIMIT 10', [`%${qStr}%`]);
        if (!rows.length) return interaction.reply({ content:'Ничего не найдено.', ephemeral:true });
        const lines = rows.map(r => `**ID ${r.id}** | ${r.fio}\nПричина: ${r.reason}\nВнёс: ${r.added_by_role}, ${r.added_by_fio}\nСнят: ${r.is_removed?'Да':'Нет'} | Амн.: ${r.is_amnestied?'Да':'Нет'}`).join('\n─────\n');
        return interaction.reply({ content: lines.length>1900?lines.slice(0,1900)+'\n...':lines, ephemeral:true });
      }

      if (cmd === 'bl-list') {
        const rows = await q('SELECT * FROM blacklist WHERE is_removed=0 AND is_amnestied=0 ORDER BY id DESC LIMIT 10');
        if (!rows.length) return interaction.reply({ content:'ЧС пуст.', ephemeral:true });
        const lines = rows.map(r => `**ID ${r.id}** | ${r.fio}\nПричина: ${r.reason} | До: ${safe(r.date_until)}`).join('\n─────\n');
        return interaction.reply({ content: lines, ephemeral:true });
      }

      if (cmd === 'app-view') {
        const id = interaction.options.getInteger('id', true);
        const row = await qOne('SELECT * FROM applications WHERE id=$1', [id]);
        if (!row) return interaction.reply({ content:'❌ Не найдена.', ephemeral:true });
        return interaction.reply({ embeds:[buildAppEmbed(row)], ephemeral:true });
      }
    }

    if (interaction.isButton()) {
      const [ns, action, rawId] = interaction.customId.split(':');
      if (ns !== 'app') return;
      const appId = Number(rawId);
      const row = await qOne('SELECT * FROM applications WHERE id=$1', [appId]);
      if (!row) return interaction.reply({ content:'❌ Не найдена.', ephemeral:true });
      if (!hasRole(interaction.member, APP_DECISION_ROLES)) return interaction.reply({ content:'❌ Нет прав.', ephemeral:true });
      if (row.status !== 'pending') return interaction.reply({ content:'❌ Уже решено.', ephemeral:true });

      if (action === 'approve') {
        const actor = actorSnap(interaction);
        const upd = await qOne(`UPDATE applications SET status='approved', reject_reason='', decided_by_role=$1, decided_by_fio=$2, decided_at=$3 WHERE id=$4 AND status='pending' RETURNING *`, [actor.role, actor.fio, nowRu(), appId]);
        if (!upd) return interaction.reply({ content:'❌ Уже решено.', ephemeral:true });
        await syncAppMsg(upd);
        return interaction.reply({ content:`✅ **${upd.case_number}** одобрена.`, ephemeral:true });
      }

      if (action === 'reject') {
        const modal = new ModalBuilder().setCustomId(`modal:reject:${appId}`).setTitle('Причина отказа');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('reason').setLabel('Причина').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)
        ));
        return interaction.showModal(modal);
      }
    }

    if (interaction.isModalSubmit()) {
      const [ns, action, rawId] = interaction.customId.split(':');
      if (ns !== 'modal' || action !== 'reject') return;
      const appId = Number(rawId);
      const row = await qOne('SELECT * FROM applications WHERE id=$1', [appId]);
      if (!row) return interaction.reply({ content:'❌ Не найдена.', ephemeral:true });
      if (!hasRole(interaction.member, APP_DECISION_ROLES)) return interaction.reply({ content:'❌ Нет прав.', ephemeral:true });
      if (row.status !== 'pending') return interaction.reply({ content:'❌ Уже решено.', ephemeral:true });
      const reason = interaction.fields.getTextInputValue('reason').trim();
      const actor = actorSnap(interaction);
      const upd = await qOne(`UPDATE applications SET status='rejected', reject_reason=$1, decided_by_role=$2, decided_by_fio=$3, decided_at=$4 WHERE id=$5 AND status='pending' RETURNING *`, [reason, actor.role, actor.fio, nowRu(), appId]);
      if (!upd) return interaction.reply({ content:'❌ Уже решено.', ephemeral:true });
      await syncAppMsg(upd);
      return interaction.reply({ content:`❌ **${upd.case_number}** отклонена.`, ephemeral:true });
    }
  } catch (e) {
    console.error('interaction error:', e);
    try {
      if (interaction.replied || interaction.deferred) await interaction.followUp({ content:'⚠️ Ошибка.', ephemeral:true });
      else await interaction.reply({ content:'⚠️ Ошибка.', ephemeral:true });
    } catch {}
  }
});

// ─── EXPRESS ────────────────────────────────
const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(cookieParser());
app.use(express.static('public'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function authMW(req, res, next) {
  const token = req.cookies?.token || (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Не авторизован' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    qOne('SELECT * FROM users WHERE id=$1', [decoded.id]).then(user => {
      if (!user) return res.status(401).json({ error:'Не найден' });
      req.user = user;
      next();
    }).catch(() => res.status(500).json({ error:'DB err' }));
  } catch { return res.status(401).json({ error:'Невалидный токен' }); }
}

function requireRoles(roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error:'Нет прав' });
    next();
  };
}

const SITE_BL_ROLES = ['Заведующий ОК','Заместитель Заведующего ОК','Заведующий АБ','Заместитель Заведующего АБ','Заместитель Главного Врача','Главный Врач'];
const SITE_OK_ROLES = ['Заведующий ОК','Заместитель Заведующего ОК'];

// AUTH
app.post('/api/register', async (req, res) => {
  try {
    const { login, password, nickname, role } = req.body;
    if (!login || !password || !nickname) return res.status(400).json({ error:'Заполни все поля' });
    const exists = await qOne('SELECT id FROM users WHERE login=$1', [login]);
    if (exists) return res.status(400).json({ error:'Логин занят' });
    const hash = bcrypt.hashSync(password, 10);
    const u = await qOne('INSERT INTO users (login,password,nickname,role,created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id', [login, hash, nickname, role || 'Сотрудник', nowRu()]);
    const token = jwt.sign({ id: u.id }, JWT_SECRET, { expiresIn:'30d' });
    res.cookie('token', token, { httpOnly:true, maxAge:30*24*3600*1000, sameSite:'lax' });
    res.json({ success:true });
  } catch (e) { console.error(e); res.status(500).json({ error:'Ошибка' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { login, password } = req.body;
    const user = await qOne('SELECT * FROM users WHERE login=$1', [login]);
    if (!user || !bcrypt.compareSync(password, user.password)) return res.status(400).json({ error:'Неверный логин или пароль' });
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn:'30d' });
    res.cookie('token', token, { httpOnly:true, maxAge:30*24*3600*1000, sameSite:'lax' });
    res.json({ success:true });
  } catch (e) { console.error(e); res.status(500).json({ error:'Ошибка' }); }
});

app.post('/api/logout', (_req, res) => { res.clearCookie('token'); res.json({ success:true }); });
app.get('/api/me', authMW, (req, res) => { const { password:_, ...u } = req.user; res.json(u); });

// BL
app.get('/api/blacklist', authMW, async (_req, res) => {
  const rows = await q('SELECT * FROM blacklist ORDER BY id DESC');
  res.json(rows);
});

app.post('/api/blacklist', authMW, requireRoles(SITE_BL_ROLES), async (req, res) => {
  try {
    const { fio, date_until, reason, removal_fee, removal_action } = req.body;
    if (!fio || !reason) return res.status(400).json({ error:'ФИО и причина обязательны' });
    const uf = extractFIO(req.user.nickname);
    const row = await qOne('INSERT INTO blacklist (fio,fio_norm,date_added,date_until,reason,added_by_role,added_by_fio,added_by_user_id,removal_fee,removal_action) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *', [fio, normFio(fio), nowRu(), date_until||'', reason, req.user.role, uf, req.user.id, removal_fee||'', removal_action||'']);
    logBL('🚫 ЧС (сайт)', 0xff4444, row).catch(()=>{});
    res.json({ success:true, id: row.id });
  } catch (e) { console.error(e); res.status(500).json({ error:'Ошибка' }); }
});

app.put('/api/blacklist/:id/remove', authMW, requireRoles(SITE_BL_ROLES), async (req, res) => {
  try {
    const row = await qOne('SELECT * FROM blacklist WHERE id=$1', [req.params.id]);
    if (!row) return res.status(404).json({ error:'Не найдено' });
    if (row.is_removed) return res.status(400).json({ error:'Уже снят' });
    const uf = extractFIO(req.user.nickname);
    const upd = await qOne('UPDATE blacklist SET is_removed=1,removed_at=$1,removed_by_role=$2,removed_by_fio=$3,removed_by_user_id=$4 WHERE id=$5 RETURNING *', [nowRu(), req.user.role, uf, req.user.id, req.params.id]);
    logBL('✅ ЧС снят (сайт)', 0x00c853, upd).catch(()=>{});
    res.json({ success:true });
  } catch (e) { console.error(e); res.status(500).json({ error:'Ошибка' }); }
});

app.put('/api/blacklist/:id/amnesty', authMW, requireRoles(SITE_BL_ROLES), async (req, res) => {
  try {
    const row = await qOne('SELECT * FROM blacklist WHERE id=$1', [req.params.id]);
    if (!row) return res.status(404).json({ error:'Не найдено' });
    if (row.is_amnestied) return res.status(400).json({ error:'Уже амнистирован' });
    const uf = extractFIO(req.user.nickname);
    const upd = await qOne('UPDATE blacklist SET is_amnestied=1,amnestied_at=$1,amnestied_by_role=$2,amnestied_by_fio=$3,amnestied_by_user_id=$4 WHERE id=$5 RETURNING *', [nowRu(), req.user.role, uf, req.user.id, req.params.id]);
    logBL('🕊 Амнистия (сайт)', 0x7c83ff, upd).catch(()=>{});
    res.json({ success:true });
  } catch (e) { console.error(e); res.status(500).json({ error:'Ошибка' }); }
});

// ФАЙЛЫ В БД
app.post('/api/upload', authMW, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error:'Файл не загружен' });
    const id = crypto.randomBytes(12).toString('hex');
    await q('INSERT INTO files (id,mime,data,created_at) VALUES ($1,$2,$3,$4)', [id, req.file.mimetype, req.file.buffer, nowRu()]);
    res.json({ url: `${BASE_URL}/file/${id}` });
  } catch (e) {
    console.error('upload:', e);
    res.status(500).json({ error:'Ошибка загрузки файла' });
  }
});

// Отдача файлов из БД (публично, чтобы Discord мог их читать)
app.get('/file/:id', async (req, res) => {
  try {
    const row = await qOne('SELECT mime, data FROM files WHERE id=$1', [req.params.id]);
    if (!row) return res.status(404).send('Not found');
    res.set('Content-Type', row.mime);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(row.data);
  } catch (e) { res.status(500).send('Error'); }
});

// APPLICATIONS
app.get('/api/applications', authMW, async (_req, res) => {
  const rows = await q('SELECT * FROM applications ORDER BY id DESC');
  res.json(rows);
});

app.post('/api/applications', authMW, async (req, res) => {
  try {
    const { fio, phone, special_comm, special_id, interview_datetime, interview_responsible, acceptance_responsible, passport_url, license_url, medcard_url } = req.body;
    if (!fio || !String(fio).trim()) return res.status(400).json({ error:'ФИО обязательно' });

    const bl = await qOne('SELECT * FROM blacklist WHERE fio_norm=$1 AND is_removed=0 AND is_amnestied=0 ORDER BY id DESC LIMIT 1', [normFio(fio)]);
    if (bl) return res.status(400).json({ error: `Данный гражданин в ЧС: "${bl.reason}" до ${bl.date_until || 'бессрочно'}. Заносил: ${bl.added_by_role}, ${bl.added_by_fio}`, blacklisted:true });

    const uf = extractFIO(req.user.nickname);
    const cn = await nextCaseNumber();
    const appRow = await qOne('INSERT INTO applications (case_number,fio,fio_norm,phone,special_comm,special_id,interview_datetime,interview_responsible,acceptance_responsible,passport_url,license_url,medcard_url,submitted_by_role,submitted_by_fio,submitted_by_user_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *', [cn, String(fio).trim(), normFio(fio), phone||'', special_comm||'', special_id||'', interview_datetime||'', interview_responsible||'', acceptance_responsible||'', passport_url||'', license_url||'', medcard_url||'', req.user.role, uf, req.user.id, nowRu()]);

    if (dc.isReady() && APPLICATIONS_CHANNEL_ID) {
      try {
        const ch = await dc.channels.fetch(APPLICATIONS_CHANNEL_ID);
        const msg = await ch.send({ embeds:[buildAppEmbed(appRow)], components:buildAppButtons(appRow) });
        await q('UPDATE applications SET discord_channel_id=$1, discord_message_id=$2 WHERE id=$3', [msg.channelId, msg.id, appRow.id]);
      } catch (e) { console.error('discord send:', e.message); }
    }

    res.json({ success:true, id: appRow.id, case_number: cn });
  } catch (e) { console.error(e); res.status(500).json({ error:'Ошибка' }); }
});

app.put('/api/applications/:id/decide', authMW, requireRoles(SITE_OK_ROLES), async (req, res) => {
  try {
    const { decision, reject_reason } = req.body;
    const row = await qOne('SELECT * FROM applications WHERE id=$1', [req.params.id]);
    if (!row) return res.status(404).json({ error:'Не найдена' });
    if (row.status !== 'pending') return res.status(400).json({ error:'Решение уже принято' });
    const uf = extractFIO(req.user.nickname);
    const upd = await qOne('UPDATE applications SET status=$1, reject_reason=$2, decided_by_role=$3, decided_by_fio=$4, decided_at=$5 WHERE id=$6 RETURNING *', [decision, reject_reason||'', req.user.role, uf, nowRu(), req.params.id]);
    await syncAppMsg(upd);
    res.json({ success:true });
  } catch (e) { console.error(e); res.status(500).json({ error:'Ошибка' }); }
});

app.get('/health', (_req, res) => res.json({ ok:true, discord: dc.isReady() ? 'online' : 'offline' }));

// ─── START ──────────────────────────────────
(async () => {
  try {
    await initDB();
    app.listen(PORT, () => console.log(`✅ HTTP: порт ${PORT}`));
    if (!DISCORD_TOKEN) console.error('⚠️  Нет DISCORD_TOKEN');
    else await dc.login(DISCORD_TOKEN);
  } catch (e) {
    console.error('❌ Ошибка старта:', e);
    process.exit(1);
  }
})();
