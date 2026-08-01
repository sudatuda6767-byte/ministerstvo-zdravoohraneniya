const express = require('express');
const Database = require('better-sqlite3');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  Events
} = require('discord.js');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || '';
const APPLICATIONS_CHANNEL_ID = process.env.APPLICATIONS_CHANNEL_ID || '';
const BLACKLIST_LOG_CHANNEL_ID = process.env.BLACKLIST_LOG_CHANNEL_ID || '';
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || 'super_internal_secret_change_me';

const ROLE_IDS = {
  ZAV_OK: process.env.ROLE_ZAV_OK_ID || '',
  ZAM_ZAV_OK: process.env.ROLE_ZAM_ZAV_OK_ID || '',
  ZAV_AB: process.env.ROLE_ZAV_AB_ID || '',
  ZAM_ZAV_AB: process.env.ROLE_ZAM_ZAV_AB_ID || '',
  ZAM_GV: process.env.ROLE_ZAM_GV_ID || '',
  GV: process.env.ROLE_GV_ID || ''
};

const BLACKLIST_ALLOWED_ROLE_IDS = [
  ROLE_IDS.ZAV_OK,
  ROLE_IDS.ZAM_ZAV_OK,
  ROLE_IDS.ZAV_AB,
  ROLE_IDS.ZAM_ZAV_AB,
  ROLE_IDS.ZAM_GV,
  ROLE_IDS.GV
].filter(Boolean);

const APPLICATION_DECISION_ROLE_IDS = [
  ROLE_IDS.ZAV_OK,
  ROLE_IDS.ZAM_ZAV_OK
].filter(Boolean);

const db = new Database('hr-bot.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS blacklist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fio TEXT NOT NULL,
    fio_norm TEXT NOT NULL,
    date_added TEXT NOT NULL,
    date_until TEXT,
    reason TEXT NOT NULL,
    added_by_role TEXT NOT NULL,
    added_by_fio TEXT NOT NULL,
    added_by_discord_id TEXT,
    removal_fee TEXT,
    removal_action TEXT,
    is_removed INTEGER DEFAULT 0,
    removed_at TEXT,
    removed_by_role TEXT,
    removed_by_fio TEXT,
    removed_by_discord_id TEXT,
    is_amnestied INTEGER DEFAULT 0,
    amnestied_at TEXT,
    amnestied_by_role TEXT,
    amnestied_by_fio TEXT,
    amnestied_by_discord_id TEXT
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
    status TEXT DEFAULT 'pending',
    reject_reason TEXT,
    decided_by_role TEXT,
    decided_by_fio TEXT,
    decided_by_discord_id TEXT,
    decided_at TEXT,
    discord_channel_id TEXT,
    discord_message_id TEXT,
    created_at TEXT NOT NULL
  );
`);

function nowRu() {
  return new Date().toLocaleString('ru-RU');
}

function safe(v) {
  return v && String(v).trim() ? String(v) : '—';
}

function normFio(v) {
  return String(v || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function extractFIO(nickname) {
  return String(nickname || '').replace(/\[.*?\]\s*/g, '').trim();
}

function getRoleIdsFromMember(member) {
  if (!member) return [];
  if (member.roles?.cache) return [...member.roles.cache.keys()];
  if (Array.isArray(member.roles)) return member.roles;
  return [];
}

function hasAnyRequiredRole(member, allowedRoleIds) {
  const ids = getRoleIdsFromMember(member);
  return allowedRoleIds.some(id => ids.includes(id));
}

function getActorRoleLabel(member) {
  const ids = getRoleIdsFromMember(member);

  if (ROLE_IDS.ZAV_OK && ids.includes(ROLE_IDS.ZAV_OK)) return 'Заведующий ОК';
  if (ROLE_IDS.ZAM_ZAV_OK && ids.includes(ROLE_IDS.ZAM_ZAV_OK)) return 'Заместитель Заведующего ОК';
  if (ROLE_IDS.ZAV_AB && ids.includes(ROLE_IDS.ZAV_AB)) return 'Заведующий АБ';
  if (ROLE_IDS.ZAM_ZAV_AB && ids.includes(ROLE_IDS.ZAM_ZAV_AB)) return 'Заместитель Заведующего АБ';
  if (ROLE_IDS.ZAM_GV && ids.includes(ROLE_IDS.ZAM_GV)) return 'Заместитель Главного Врача';
  if (ROLE_IDS.GV && ids.includes(ROLE_IDS.GV)) return 'Главный Врач';

  return 'Неизвестная роль';
}

function getActorSnapshot(interaction) {
  const displayName =
    interaction.member?.displayName ||
    interaction.user?.globalName ||
    interaction.user?.username ||
    'Неизвестно';

  return {
    role: getActorRoleLabel(interaction.member),
    fio: extractFIO(displayName),
    discordId: interaction.user.id
  };
}

function docsText(appRow) {
  const parts = [];
  parts.push(appRow.passport_url ? `[Паспорт](${appRow.passport_url})` : 'Паспорт: нет');
  parts.push(appRow.license_url ? `[Лицензии](${appRow.license_url})` : 'Лицензии: нет');
  parts.push(appRow.medcard_url ? `[Мед. карта](${appRow.medcard_url})` : 'Мед. карта: нет');
  return parts.join('\n');
}

function statusLabel(status) {
  if (status === 'approved') return '✅ Одобрено';
  if (status === 'rejected') return '❌ Отклонено';
  return '🟠 На рассмотрении';
}

function statusColor(status) {
  if (status === 'approved') return 0x00c853;
  if (status === 'rejected') return 0xff4444;
  return 0xff9800;
}

function buildApplicationEmbed(appRow) {
  const embed = new EmbedBuilder()
    .setTitle(`📋 Анкета ${appRow.case_number}`)
    .setColor(statusColor(appRow.status))
    .addFields(
      { name: 'Статус', value: statusLabel(appRow.status), inline: true },
      { name: 'ID записи', value: String(appRow.id), inline: true },
      { name: 'Ф.И.О.', value: safe(appRow.fio), inline: false },
      { name: 'Телефон', value: safe(appRow.phone), inline: true },
      { name: 'Спец. связь', value: safe(appRow.special_comm), inline: true },
      { name: 'Спец. ID', value: safe(appRow.special_id), inline: true },
      { name: 'Дата и время собеседования', value: safe(appRow.interview_datetime), inline: false },
      { name: 'Ответственный за собеседование', value: safe(appRow.interview_responsible), inline: true },
      { name: 'Ответственный по принятию', value: safe(appRow.acceptance_responsible), inline: true },
      { name: 'Документы', value: docsText(appRow), inline: false },
      { name: 'Кто отправил', value: `${safe(appRow.submitted_by_role)} ${safe(appRow.submitted_by_fio)}`, inline: false },
      { name: 'Создано', value: safe(appRow.created_at), inline: false }
    )
    .setTimestamp(new Date());

  if (appRow.status !== 'pending') {
    let stamp = `${safe(appRow.decided_by_role)} ${safe(appRow.decided_by_fio)}\n${safe(appRow.decided_at)}`;
    if (appRow.status === 'rejected' && appRow.reject_reason) {
      stamp += `\nПричина отказа: ${appRow.reject_reason}`;
    }
    embed.addFields({ name: 'Решение', value: stamp, inline: false });
  }

  return embed;
}

function buildApplicationComponents(appRow) {
  const disabled = appRow.status !== 'pending';

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`app:approve:${appRow.id}`)
        .setLabel('Одобрить')
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`app:reject:${appRow.id}`)
        .setLabel('Отклонить')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled)
    )
  ];
}

async function syncApplicationDiscordMessage(client, appRow) {
  if (!appRow.discord_channel_id || !appRow.discord_message_id) return;

  try {
    const channel = await client.channels.fetch(appRow.discord_channel_id);
    if (!channel || !channel.isTextBased()) return;

    const msg = await channel.messages.fetch(appRow.discord_message_id);
    if (!msg) return;

    await msg.edit({
      embeds: [buildApplicationEmbed(appRow)],
      components: buildApplicationComponents(appRow)
    });
  } catch (e) {
    console.error('syncApplicationDiscordMessage error:', e.message);
  }
}

async function sendBlacklistLog(client, title, color, row) {
  if (!BLACKLIST_LOG_CHANNEL_ID) return;

  try {
    const channel = await client.channels.fetch(BLACKLIST_LOG_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) return;

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setColor(color)
      .addFields(
        { name: 'ID', value: String(row.id), inline: true },
        { name: 'Ф.И.О.', value: safe(row.fio), inline: true },
        { name: 'Причина', value: safe(row.reason), inline: false },
        { name: 'Дата внесения', value: safe(row.date_added), inline: true },
        { name: 'До', value: safe(row.date_until), inline: true },
        { name: 'Кто внёс', value: `${safe(row.added_by_role)} ${safe(row.added_by_fio)}`, inline: false },
        { name: 'Сумма за вынос', value: safe(row.removal_fee), inline: true },
        { name: 'Действие для выноса', value: safe(row.removal_action), inline: true }
      )
      .setTimestamp(new Date());

    if (row.is_removed) {
      embed.addFields({
        name: 'ЧС снят',
        value: `${safe(row.removed_by_role)} ${safe(row.removed_by_fio)}\n${safe(row.removed_at)}`,
        inline: false
      });
    }

    if (row.is_amnestied) {
      embed.addFields({
        name: 'Амнистирован',
        value: `${safe(row.amnestied_by_role)} ${safe(row.amnestied_by_fio)}\n${safe(row.amnestied_at)}`,
        inline: false
      });
    }

    await channel.send({ embeds: [embed] });
  } catch (e) {
    console.error('sendBlacklistLog error:', e.message);
  }
}

async function postApplicationToDiscord(client, appRow) {
  if (!APPLICATIONS_CHANNEL_ID) {
    throw new Error('Не задан APPLICATIONS_CHANNEL_ID');
  }

  const channel = await client.channels.fetch(APPLICATIONS_CHANNEL_ID);
  if (!channel || !channel.isTextBased()) {
    throw new Error('Канал анкет не найден или недоступен');
  }

  const msg = await channel.send({
    embeds: [buildApplicationEmbed(appRow)],
    components: buildApplicationComponents(appRow)]
  });

  return {
    channelId: msg.channelId,
    messageId: msg.id
  };
}

function nextCaseNumber() {
  const row = db.prepare(`SELECT id FROM applications ORDER BY id DESC LIMIT 1`).get();
  const next = (row?.id || 0) + 1;
  return `ЛД-${String(next).padStart(4, '0')}`;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

const slashCommands = [
  new SlashCommandBuilder()
    .setName('bl-add')
    .setDescription('Добавить человека в чёрный список')
    .addStringOption(o => o.setName('fio').setDescription('Ф.И.О.').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Причина ЧС').setRequired(true))
    .addStringOption(o => o.setName('date_until').setDescription('До какой даты / срок').setRequired(false))
    .addStringOption(o => o.setName('removal_fee').setDescription('Сумма за вынос из ЧС').setRequired(false))
    .addStringOption(o => o.setName('removal_action').setDescription('Действие для выноса из ЧС').setRequired(false)),

  new SlashCommandBuilder()
    .setName('bl-remove')
    .setDescription('Снять ЧС по ID записи')
    .addIntegerOption(o => o.setName('id').setDescription('ID записи').setRequired(true)),

  new SlashCommandBuilder()
    .setName('bl-amnesty')
    .setDescription('Амнистировать запись ЧС по ID')
    .addIntegerOption(o => o.setName('id').setDescription('ID записи').setRequired(true)),

  new SlashCommandBuilder()
    .setName('bl-find')
    .setDescription('Поиск по ЧС')
    .addStringOption(o => o.setName('fio').setDescription('Ф.И.О. или часть Ф.И.О.').setRequired(true)),

  new SlashCommandBuilder()
    .setName('app-view')
    .setDescription('Посмотреть анкету по ID')
    .addIntegerOption(o => o.setName('id').setDescription('ID анкеты').setRequired(true))
].map(c => c.toJSON());

async function registerCommands() {
  if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID || !DISCORD_GUILD_ID) {
    console.log('Не хватает DISCORD_TOKEN / DISCORD_CLIENT_ID / DISCORD_GUILD_ID для регистрации команд');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID),
    { body: slashCommands }
  );
  console.log('Slash-команды зарегистрированы');
}

client.once(Events.ClientReady, async () => {
  console.log(`Бот вошёл как ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (e) {
    console.error('Ошибка регистрации команд:', e.message);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'bl-add') {
        if (!hasAnyRequiredRole(interaction.member, BLACKLIST_ALLOWED_ROLE_IDS)) {
          return interaction.reply({ content: 'У тебя нет прав на добавление в ЧС.', ephemeral: true });
        }

        const fio = interaction.options.getString('fio', true).trim();
        const reason = interaction.options.getString('reason', true).trim();
        const date_until = (interaction.options.getString('date_until') || '').trim();
        const removal_fee = (interaction.options.getString('removal_fee') || '').trim();
        const removal_action = (interaction.options.getString('removal_action') || '').trim();

        const actor = getActorSnapshot(interaction);

        const result = db.prepare(`
          INSERT INTO blacklist (
            fio, fio_norm, date_added, date_until, reason,
            added_by_role, added_by_fio, added_by_discord_id,
            removal_fee, removal_action
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          fio,
          normFio(fio),
          nowRu(),
          date_until,
          reason,
          actor.role,
          actor.fio,
          actor.discordId,
          removal_fee,
          removal_action
        );

        const row = db.prepare(`SELECT * FROM blacklist WHERE id = ?`).get(result.lastInsertRowid);
        await sendBlacklistLog(client, '🚫 Добавление в ЧС', 0xff4444, row);

        return interaction.reply({
          content: `Готово. Запись ЧС создана. ID: ${row.id}`,
          ephemeral: true
        });
      }

      if (interaction.commandName === 'bl-remove') {
        if (!hasAnyRequiredRole(interaction.member, BLACKLIST_ALLOWED_ROLE_IDS)) {
          return interaction.reply({ content: 'У тебя нет прав на снятие ЧС.', ephemeral: true });
        }

        const id = interaction.options.getInteger('id', true);
        const row = db.prepare(`SELECT * FROM blacklist WHERE id = ?`).get(id);
        if (!row) {
          return interaction.reply({ content: 'Запись ЧС не найдена.', ephemeral: true });
        }
        if (row.is_removed) {
          return interaction.reply({ content: 'ЧС уже снят.', ephemeral: true });
        }

        const actor = getActorSnapshot(interaction);

        db.prepare(`
          UPDATE blacklist
          SET is_removed = 1,
              removed_at = ?,
              removed_by_role = ?,
              removed_by_fio = ?,
              removed_by_discord_id = ?
          WHERE id = ?
        `).run(nowRu(), actor.role, actor.fio, actor.discordId, id);

        const updated = db.prepare(`SELECT * FROM blacklist WHERE id = ?`).get(id);
        await sendBlacklistLog(client, '✅ ЧС снят', 0x00c853, updated);

        return interaction.reply({
          content: `Готово. ЧС снят для: ${updated.fio}`,
          ephemeral: true
        });
      }

      if (interaction.commandName === 'bl-amnesty') {
        if (!hasAnyRequiredRole(interaction.member, BLACKLIST_ALLOWED_ROLE_IDS)) {
          return interaction.reply({ content: 'У тебя нет прав на амнистию.', ephemeral: true });
        }

        const id = interaction.options.getInteger('id', true);
        const row = db.prepare(`SELECT * FROM blacklist WHERE id = ?`).get(id);
        if (!row) {
          return interaction.reply({ content: 'Запись ЧС не найдена.', ephemeral: true });
        }
        if (row.is_amnestied) {
          return interaction.reply({ content: 'Эта запись уже амнистирована.', ephemeral: true });
        }

        const actor = getActorSnapshot(interaction);

        db.prepare(`
          UPDATE blacklist
          SET is_amnestied = 1,
              amnestied_at = ?,
              amnestied_by_role = ?,
              amnestied_by_fio = ?,
              amnestied_by_discord_id = ?
          WHERE id = ?
        `).run(nowRu(), actor.role, actor.fio, actor.discordId, id);

        const updated = db.prepare(`SELECT * FROM blacklist WHERE id = ?`).get(id);
        await sendBlacklistLog(client, '🕊 Амнистия ЧС', 0x7c83ff, updated);

        return interaction.reply({
          content: `Готово. Амнистия применена для: ${updated.fio}`,
          ephemeral: true
        });
      }

      if (interaction.commandName === 'bl-find') {
        const fio = interaction.options.getString('fio', true).trim().toLowerCase();

        const rows = db.prepare(`
          SELECT * FROM blacklist
          WHERE fio_norm LIKE ?
          ORDER BY id DESC
          LIMIT 10
        `).all(`%${fio}%`);

        if (!rows.length) {
          return interaction.reply({ content: 'Ничего не найдено.', ephemeral: true });
        }

        const text = rows.map(r => {
          return [
            `ID: ${r.id}`,
            `ФИО: ${r.fio}`,
            `Причина: ${r.reason}`,
            `Внёс: ${r.added_by_role} ${r.added_by_fio}`,
            `Снят: ${r.is_removed ? 'Да' : 'Нет'}`,
            `Амнистирован: ${r.is_amnestied ? 'Да' : 'Нет'}`
          ].join('\n');
        }).join('\n\n--------------------\n\n');

        return interaction.reply({
          content: text.length > 1900 ? text.slice(0, 1900) + '\n...' : text,
          ephemeral: true
        });
      }

      if (interaction.commandName === 'app-view') {
        const id = interaction.options.getInteger('id', true);
        const row = db.prepare(`SELECT * FROM applications WHERE id = ?`).get(id);

        if (!row) {
          return interaction.reply({ content: 'Анкета не найдена.', ephemeral: true });
        }

        return interaction.reply({
          embeds: [buildApplicationEmbed(row)],
          ephemeral: true
        });
      }
    }

    if (interaction.isButton()) {
      const parts = interaction.customId.split(':');
      if (parts[0] !== 'app') return;

      const action = parts[1];
      const appId = Number(parts[2]);
      const row = db.prepare(`SELECT * FROM applications WHERE id = ?`).get(appId);

      if (!row) {
        return interaction.reply({ content: 'Анкета не найдена.', ephemeral: true });
      }

      if (!hasAnyRequiredRole(interaction.member, APPLICATION_DECISION_ROLE_IDS)) {
        return interaction.reply({ content: 'У тебя нет прав на принятие решений по анкетам.', ephemeral: true });
      }

      if (row.status !== 'pending') {
        return interaction.reply({ content: 'По этой анкете решение уже принято.', ephemeral: true });
      }

      if (action === 'approve') {
        const actor = getActorSnapshot(interaction);

        const result = db.prepare(`
          UPDATE applications
          SET status = 'approved',
              reject_reason = '',
              decided_by_role = ?,
              decided_by_fio = ?,
              decided_by_discord_id = ?,
              decided_at = ?
          WHERE id = ? AND status = 'pending'
        `).run(actor.role, actor.fio, actor.discordId, nowRu(), appId);

        if (!result.changes) {
          return interaction.reply({ content: 'Решение уже было принято кем-то другим.', ephemeral: true });
        }

        const updated = db.prepare(`SELECT * FROM applications WHERE id = ?`).get(appId);
        await syncApplicationDiscordMessage(client, updated);

        return interaction.reply({
          content: `Анкета ${updated.case_number} одобрена.`,
          ephemeral: true
        });
      }

      if (action === 'reject') {
        const modal = new ModalBuilder()
          .setCustomId(`apprejectmodal:${appId}`)
          .setTitle(`Отказ анкеты ID ${appId}`);

        const input = new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Причина отказа')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000);

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }
    }

    if (interaction.isModalSubmit()) {
      const parts = interaction.customId.split(':');
      if (parts[0] !== 'apprejectmodal') return;

      const appId = Number(parts[1]);
      const row = db.prepare(`SELECT * FROM applications WHERE id = ?`).get(appId);

      if (!row) {
        return interaction.reply({ content: 'Анкета не найдена.', ephemeral: true });
      }

      if (!hasAnyRequiredRole(interaction.member, APPLICATION_DECISION_ROLE_IDS)) {
        return interaction.reply({ content: 'У тебя нет прав на отклонение анкет.', ephemeral: true });
      }

      if (row.status !== 'pending') {
        return interaction.reply({ content: 'По этой анкете решение уже принято.', ephemeral: true });
      }

      const reason = interaction.fields.getTextInputValue('reason').trim();
      const actor = getActorSnapshot(interaction);

      const result = db.prepare(`
        UPDATE applications
        SET status = 'rejected',
            reject_reason = ?,
            decided_by_role = ?,
            decided_by_fio = ?,
            decided_by_discord_id = ?,
            decided_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(reason, actor.role, actor.fio, actor.discordId, nowRu(), appId);

      if (!result.changes) {
        return interaction.reply({ content: 'Решение уже было принято кем-то другим.', ephemeral: true });
      }

      const updated = db.prepare(`SELECT * FROM applications WHERE id = ?`).get(appId);
      await syncApplicationDiscordMessage(client, updated);

      return interaction.reply({
        content: `Анкета ${updated.case_number} отклонена.`,
        ephemeral: true
      });
    }
  } catch (e) {
    console.error('interaction error:', e);
    if (interaction.deferred || interaction.replied) {
      try {
        await interaction.followUp({ content: 'Произошла ошибка.', ephemeral: true });
      } catch {}
    } else {
      try {
        await interaction.reply({ content: 'Произошла ошибка.', ephemeral: true });
      } catch {}
    }
  }
});

// ===== HTTP =====

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    bot: client.isReady() ? 'online' : 'offline',
    time: new Date().toISOString()
  });
});

// Сайт потом будет слать сюда анкету
app.post('/incoming/application', async (req, res) => {
  try {
    const secret = req.headers['x-internal-secret'];
    if (secret !== INTERNAL_API_SECRET) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const {
      fio,
      phone,
      special_comm,
      special_id,
      interview_datetime,
      interview_responsible,
      acceptance_responsible,
      passport_url,
      license_url,
      medcard_url,
      submitted_by_role,
      submitted_by_fio
    } = req.body;

    if (!fio || !String(fio).trim()) {
      return res.status(400).json({ error: 'ФИО обязательно' });
    }

    const normalized = normFio(fio);

    const blacklisted = db.prepare(`
      SELECT * FROM blacklist
      WHERE fio_norm = ?
        AND is_removed = 0
        AND is_amnestied = 0
      ORDER BY id DESC
      LIMIT 1
    `).get(normalized);

    if (blacklisted) {
      return res.status(400).json({
        error: `Данный гражданин находится в Чёрном Списке организации по причине: "${blacklisted.reason}" до ${blacklisted.date_until || 'бессрочно'}. Заносил: ${blacklisted.added_by_role} ${blacklisted.added_by_fio}`,
        blacklisted: true,
        blacklist_id: blacklisted.id
      });
    }

    const caseNumber = nextCaseNumber();
    const createdAt = nowRu();

    const result = db.prepare(`
      INSERT INTO applications (
        case_number,
        fio,
        fio_norm,
        phone,
        special_comm,
        special_id,
        interview_datetime,
        interview_responsible,
        acceptance_responsible,
        passport_url,
        license_url,
        medcard_url,
        submitted_by_role,
        submitted_by_fio,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      caseNumber,
      String(fio).trim(),
      normalized,
      phone || '',
      special_comm || '',
      special_id || '',
      interview_datetime || '',
      interview_responsible || '',
      acceptance_responsible || '',
      passport_url || '',
      license_url || '',
      medcard_url || '',
      submitted_by_role || '',
      submitted_by_fio || '',
      createdAt
    );

    const appRow = db.prepare(`SELECT * FROM applications WHERE id = ?`).get(result.lastInsertRowid);

    const discordMsg = await postApplicationToDiscord(client, appRow);

    db.prepare(`
      UPDATE applications
      SET discord_channel_id = ?, discord_message_id = ?
      WHERE id = ?
    `).run(discordMsg.channelId, discordMsg.messageId, appRow.id);

    const finalRow = db.prepare(`SELECT * FROM applications WHERE id = ?`).get(appRow.id);

    return res.json({
      success: true,
      id: finalRow.id,
      case_number: finalRow.case_number,
      status: finalRow.status
    });
  } catch (e) {
    console.error('incoming/application error:', e);
    return res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.get('/api/application/:id', (req, res) => {
  const row = db.prepare(`SELECT * FROM applications WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Не найдено' });
  res.json(row);
});

app.get('/api/blacklist/check', (req, res) => {
  const fio = String(req.query.fio || '').trim();
  if (!fio) return res.status(400).json({ error: 'fio обязателен' });

  const row = db.prepare(`
    SELECT * FROM blacklist
    WHERE fio_norm = ?
      AND is_removed = 0
      AND is_amnestied = 0
    ORDER BY id DESC
    LIMIT 1
  `).get(normFio(fio));

  if (!row) return res.json({ blacklisted: false });
  return res.json({
    blacklisted: true,
    id: row.id,
    reason: row.reason,
    date_until: row.date_until,
    added_by_role: row.added_by_role,
    added_by_fio: row.added_by_fio
  });
});

app.listen(PORT, () => {
  console.log(`HTTP сервер запущен на порту ${PORT}`);
});

if (!DISCORD_TOKEN) {
  console.error('Нет DISCORD_TOKEN');
  process.exit(1);
}

client.login(DISCORD_TOKEN);
