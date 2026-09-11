require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  REST,
  Routes
} = require('discord.js');
const mysql = require('mysql2/promise');
const { DateTime } = require('luxon');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.DISCORD_TOKEN || '';
const CLIENT_ID = process.env.CLIENT_ID || '';
const REPORT_GUILD_ID = '1499578614298181642';
const TIMEZONE = process.env.TIMEZONE || 'Europe/London';
const DUTY_POLL_MS = Math.max(2000, Number(process.env.DUTY_POLL_MS || 5000));
const DB_TIMEOUT_MS = Math.max(500, Number(process.env.DB_TIMEOUT_MS || 1500));
const DB_RETRY_COOLDOWN_MS = Math.max(5000, Number(process.env.DB_RETRY_COOLDOWN_MS || 15000));
const SETTINGS_CACHE_FILE = path.join(__dirname, 'settings-cache.json');

const DEPARTMENTS = ['USM', 'SASP', 'BCSO', 'LSPD'];
const LEO_VOICE_CHANNELS = [
  '1542399560394088538',
  '1542399564588261446',
  '1542399567234994206'
];

const ADMIN_COMMANDS = new Set([
  'admin-roles', 'permissions', 'report-config', 'report-staff',
  'ridealong-permissions', 'ridealong-config', 'log-config',
  'officer-report-panel', 'add_org', 'add_org_hours', 'rename_org'
]);

const REPORT_COMMANDS = new Set([
  'officer-report-panel', 'anonreport', 'addofficer', 'reportadd',
  'report-config', 'report-staff', 'log-config', 'rename', 'close', 'delete'
]);

const REPORT_GUILD_COMMANDS = new Set([
  ...REPORT_COMMANDS, 'ridealong', 'ridealong-permissions', 'ridealong-config'
]);

const PRIVATE_COMMANDS = new Set([
  ...ADMIN_COMMANDS, 'anonreport', 'addofficer', 'reportadd', 'rename', 'close', 'delete'
]);

class DatabaseUnavailableError extends Error {
  constructor(message = 'MySQL is currently unavailable.') {
    super(message);
    this.name = 'DatabaseUnavailableError';
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

let pool = null;
let dbUnavailableUntil = 0;
const activeDuty = new Map();
const pendingVoice = new Map();
const reportCache = new Map();
const settingsCache = loadSettingsCache();
const dirtySettings = new Set();

function now() { return Math.floor(Date.now() / 1000); }
function localDateTime(ts) { return DateTime.fromSeconds(Number(ts), { zone: TIMEZONE }); }
function formatDateTime(ts) { return localDateTime(ts).toFormat('cccc, dd LLLL yyyy HH:mm'); }
function formatShort(ts) { return localDateTime(ts).toFormat('dd/MM/yyyy HH:mm'); }

function formatDuration(seconds) {
  let value = Math.max(0, Math.floor(Number(seconds || 0)));
  const d = Math.floor(value / 86400); value %= 86400;
  const h = Math.floor(value / 3600); value %= 3600;
  const m = Math.floor(value / 60); const s = value % 60;
  if (d) return `${d}d ${h}h ${m}m ${s}s`;
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatSessionDuration(seconds) {
  let value = Math.max(0, Math.floor(Number(seconds || 0)));
  const d = Math.floor(value / 86400); value %= 86400;
  const h = Math.floor(value / 3600); value %= 3600;
  const m = Math.floor(value / 60);
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function hoursText(seconds) {
  return `${(Math.max(0, Number(seconds || 0)) / 3600).toFixed(2)}h`;
}

function cleanName(value) {
  return String(value || 'user')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 70) || 'user';
}

function clamp(value, max = 1024) {
  const text = String(value ?? '').trim();
  if (!text) return 'Not provided';
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function parseIds(value) {
  return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
}

function deptName(code) {
  return {
    USM: 'United States Marshals',
    SASP: 'San Andreas State Police',
    BCSO: "Blaine County Sheriff's Office",
    LSPD: 'Los Santos Police Department'
  }[code] || code;
}

function timeframeLabel(value) {
  return {
    last_week: 'Last Week',
    this_week: 'This Week',
    this_month: 'This Month',
    last_month: 'Last Month',
    all_time: 'All Time'
  }[value] || value;
}

function assertDepartment(value) {
  const department = String(value || '').trim().toUpperCase();
  return DEPARTMENTS.includes(department) ? department : null;
}

function isLeoVoice(channelId) {
  return Boolean(channelId) && LEO_VOICE_CHANNELS.includes(String(channelId));
}

function splitEvidence(value) {
  const lines = String(value || '')
    .split(/\r?\n/)
    .map(v => v.trim())
    .filter(Boolean);
  return lines.length ? lines : [];
}

function splitTextChunks(value, max = 1024) {
  const text = String(value || '').trim();
  if (!text) return [];
  const chunks = [];
  let remaining = text;
  while (remaining.length > max) {
    let cut = remaining.lastIndexOf('\n', max);
    if (cut < Math.floor(max * 0.5)) cut = remaining.lastIndexOf(' ', max);
    if (cut < Math.floor(max * 0.5)) cut = max;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function loadSettingsCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_CACHE_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveSettingsCache() {
  try {
    fs.writeFileSync(SETTINGS_CACHE_FILE, `${JSON.stringify(settingsCache, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.warn('Unable to save local settings cache:', error.message);
  }
}

function settingKey(guildId, key) {
  return guildId ? `guild:${guildId}:${key}` : key;
}

function getPool() {
  if (pool) return pool;
  if (!process.env.MYSQL_DATABASE) throw new DatabaseUnavailableError('MYSQL_DATABASE is not configured.');

  const config = {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || 'root',
    database: process.env.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    connectTimeout: DB_TIMEOUT_MS,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
  };
  if (process.env.MYSQL_PASSWORD) config.password = process.env.MYSQL_PASSWORD;
  pool = mysql.createPool(config);
  return pool;
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new DatabaseUnavailableError(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isConnectionFailure(error) {
  const code = String(error?.code || '');
  return [
    'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH',
    'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR', 'ER_CON_COUNT_ERROR'
  ].includes(code);
}

function markDatabaseFailure(error) {
  dbUnavailableUntil = Date.now() + DB_RETRY_COOLDOWN_MS;
  if (!(error instanceof DatabaseUnavailableError)) {
    console.warn('MySQL unavailable:', error.message);
  }
}

async function q(sql, params = []) {
  if (Date.now() < dbUnavailableUntil) throw new DatabaseUnavailableError();
  try {
    const db = getPool();
    const [rows] = await withTimeout(db.execute(sql, params), DB_TIMEOUT_MS, 'MySQL query timed out.');
    dbUnavailableUntil = 0;
    return rows;
  } catch (error) {
    if (error instanceof DatabaseUnavailableError || isConnectionFailure(error)) {
      markDatabaseFailure(error);
      if (error instanceof DatabaseUnavailableError) throw error;
      throw new DatabaseUnavailableError(error.message);
    }
    throw error;
  }
}

async function rawQuery(sql) {
  if (Date.now() < dbUnavailableUntil) throw new DatabaseUnavailableError();
  try {
    const db = getPool();
    const result = await withTimeout(db.query(sql), DB_TIMEOUT_MS, 'MySQL schema query timed out.');
    dbUnavailableUntil = 0;
    return result;
  } catch (error) {
    if (error instanceof DatabaseUnavailableError || isConnectionFailure(error)) {
      markDatabaseFailure(error);
      if (error instanceof DatabaseUnavailableError) throw error;
      throw new DatabaseUnavailableError(error.message);
    }
    throw error;
  }
}

async function getSetting(key, fallback = null, guildId = null) {
  const fullKey = settingKey(guildId, key);
  if (Object.prototype.hasOwnProperty.call(settingsCache, fullKey)) return settingsCache[fullKey];
  try {
    const rows = await q('SELECT settingValue FROM bot_settings WHERE settingKey=? LIMIT 1', [fullKey]);
    const value = rows[0] ? rows[0].settingValue : fallback;
    settingsCache[fullKey] = value;
    saveSettingsCache();
    return value;
  } catch (error) {
    if (!(error instanceof DatabaseUnavailableError)) throw error;
    return fallback;
  }
}

async function setSetting(key, value, guildId = null) {
  const fullKey = settingKey(guildId, key);
  settingsCache[fullKey] = String(value);
  saveSettingsCache();
  try {
    await q(
      'INSERT INTO bot_settings (settingKey, settingValue) VALUES (?, ?) ON DUPLICATE KEY UPDATE settingValue=VALUES(settingValue)',
      [fullKey, String(value)]
    );
    dirtySettings.delete(fullKey);
    return true;
  } catch (error) {
    if (!(error instanceof DatabaseUnavailableError)) throw error;
    dirtySettings.add(fullKey);
    return false;
  }
}

async function getJsonSetting(key, fallback, guildId = null) {
  const raw = await getSetting(key, JSON.stringify(fallback), guildId);
  try {
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

async function setJsonSetting(key, value, guildId = null) {
  return setSetting(key, JSON.stringify(value), guildId);
}

async function flushDirtySettings() {
  if (!dirtySettings.size) return;
  for (const fullKey of [...dirtySettings]) {
    try {
      await q(
        'INSERT INTO bot_settings (settingKey, settingValue) VALUES (?, ?) ON DUPLICATE KEY UPDATE settingValue=VALUES(settingValue)',
        [fullKey, String(settingsCache[fullKey] ?? '')]
      );
      dirtySettings.delete(fullKey);
    } catch (error) {
      if (error instanceof DatabaseUnavailableError) return;
      console.warn('Unable to flush setting:', error.message);
    }
  }
}

async function ensureSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const statements = sql.split(/;\s*(?:\n|$)/).map(s => s.trim()).filter(Boolean);
  for (const statement of statements) await rawQuery(statement);
  await flushDirtySettings();
}

async function isAdmin(member) {
  if (!member) return false;
  if (parseIds(process.env.BOT_ADMINS).includes(member.id)) return true;
  if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
  if (!member.guild) return false;
  const roleIds = await getJsonSetting('adminRoles', [], member.guild.id);
  return roleIds.some(id => member.roles?.cache.has(id));
}

async function commandAllowed(member, commandName) {
  if (!member) return false;
  if (await isAdmin(member)) return true;
  const configured = await getJsonSetting(`cmdperm:${commandName}`, [], member.guild.id);
  if (!configured.length) return true;
  return configured.some(id => member.roles?.cache.has(id));
}

async function roleAllowed(member, key) {
  if (!member) return false;
  if (await isAdmin(member)) return true;
  const roleIds = await getJsonSetting(key, [], member.guild.id);
  return roleIds.some(id => member.roles?.cache.has(id));
}

function editPayload(payload) {
  const copy = { ...payload };
  delete copy.ephemeral;
  delete copy.flags;
  return copy;
}

async function respond(interaction, payload) {
  if (interaction.deferred) return interaction.editReply(editPayload(payload));
  if (interaction.replied) return interaction.followUp(payload);
  return interaction.reply(payload);
}

async function failInteraction(interaction, error) {
  console.error(error);
  const databaseFailure = error instanceof DatabaseUnavailableError;
  const content = databaseFailure
    ? 'The duty database is currently unavailable. The Discord interaction was acknowledged successfully; please try again when MySQL is online.'
    : 'An error occurred while processing that request.';
  try {
    await respond(interaction, { content, ephemeral: true });
  } catch (replyError) {
    console.error('Unable to send interaction error response:', replyError.message);
  }
}

function getUserDisplay(user) {
  return user?.globalName || user?.username || user?.id || 'User';
}

async function getDiscordUser(discordId) {
  return client.users.fetch(String(discordId)).catch(() => null);
}

async function sendDM(user, embed) {
  try {
    await user.send({ embeds: [embed] });
  } catch (error) {
    console.warn(`Unable to DM ${user?.id || 'unknown'}: ${error.message}`);
  }
}

function dutyOnEmbed({ user, department, inTime }) {
  return new EmbedBuilder()
    .setColor(0x2f9e44)
    .setTitle('On Duty')
    .setDescription(`We hope you enjoy your shift, ${getUserDisplay(user)}.`)
    .addFields(
      { name: 'Clock In', value: formatDateTime(inTime), inline: true },
      { name: 'Department', value: department, inline: true }
    )
    .setFooter({ text: `WCRP Department Utilities | ${formatShort(inTime)}` });
}

function dutyOffEmbed({ department, outTime, session, weekly, inVoice, outVoice, coverage, reason }) {
  return new EmbedBuilder()
    .setColor(0xe04f5f)
    .setTitle('Off Duty')
    .setDescription('We hope you enjoyed your shift!')
    .addFields(
      { name: 'Reason', value: reason || 'Normal Duty Clock Out', inline: false },
      { name: 'Clock Out', value: formatDateTime(outTime), inline: true },
      { name: 'Session', value: formatSessionDuration(session), inline: true },
      { name: 'This Week (Fri-Thu)', value: hoursText(weekly.total), inline: true },
      { name: 'Week', value: `${weekly.startLabel} - ${weekly.endLabel}`, inline: true },
      { name: 'Department', value: department, inline: true },
      { name: 'In Voice', value: formatDuration(inVoice), inline: true },
      { name: 'Out of Voice', value: formatDuration(outVoice), inline: true },
      { name: 'Voice Coverage', value: `${coverage.toFixed(0)}%`, inline: true }
    )
    .setFooter({ text: `WCRP Department Utilities | ${formatShort(outTime)}` });
}

function getWeekWindow(ts = now()) {
  const current = localDateTime(ts);
  const daysSinceFriday = (current.weekday + 2) % 7;
  const start = current.minus({ days: daysSinceFriday }).startOf('day');
  const end = start.plus({ days: 7 });
  return {
    start: Math.floor(start.toSeconds()),
    end: Math.floor(end.toSeconds()),
    startLabel: start.toFormat('LLL dd'),
    endLabel: end.minus({ seconds: 1 }).toFormat('LLL dd')
  };
}

function windowFor(type, ts = now()) {
  const current = localDateTime(ts);
  const week = getWeekWindow(ts);
  if (type === 'this_week') return week;
  if (type === 'last_week') {
    const start = localDateTime(week.start).minus({ days: 7 });
    const end = localDateTime(week.start);
    return { start: Math.floor(start.toSeconds()), end: Math.floor(end.toSeconds()), startLabel: start.toFormat('LLL dd'), endLabel: end.minus({ seconds: 1 }).toFormat('LLL dd') };
  }
  if (type === 'this_month') {
    const start = current.startOf('month');
    const end = start.plus({ months: 1 });
    return { start: Math.floor(start.toSeconds()), end: Math.floor(end.toSeconds()), startLabel: start.toFormat('LLL dd'), endLabel: end.minus({ seconds: 1 }).toFormat('LLL dd') };
  }
  if (type === 'last_month') {
    const end = current.startOf('month');
    const start = end.minus({ months: 1 });
    return { start: Math.floor(start.toSeconds()), end: Math.floor(end.toSeconds()), startLabel: start.toFormat('LLL dd'), endLabel: end.minus({ seconds: 1 }).toFormat('LLL dd') };
  }
  return { start: 0, end: now() + 1, startLabel: 'All Time', endLabel: '' };
}

async function totalDutySeconds({ discordId, department, window }) {
  let sql = 'SELECT inTime, COALESCE(outTime, UNIX_TIMESTAMP()) outTime FROM duty_hours WHERE inTime IS NOT NULL';
  const params = [];
  if (discordId) { sql += ' AND discordId=?'; params.push(discordId); }
  if (department) { sql += ' AND department=?'; params.push(department); }
  if (window) {
    sql += ' AND inTime < ? AND COALESCE(outTime, UNIX_TIMESTAMP()) > ?';
    params.push(window.end, window.start);
  }
  const rows = await q(sql, params);
  let total = 0;
  for (const row of rows) {
    const inTime = Number(row.inTime);
    const outTime = Number(row.outTime);
    total += Math.max(0, Math.min(outTime, window?.end ?? outTime) - Math.max(inTime, window?.start ?? inTime));
  }
  return Math.floor(total);
}

async function voiceSecondsForDuty(dutyId, inTime, outTime) {
  const end = outTime || now();
  const rows = await q(
    `SELECT inTime, COALESCE(outTime, ?) outTime, isLeoVoice
     FROM duty_voice_segments
     WHERE dutyId=? AND inTime < ? AND COALESCE(outTime, ?) > ?`,
    [end, dutyId, end, end, inTime]
  );
  let voice = 0;
  for (const row of rows) {
    if (Number(row.isLeoVoice)) {
      voice += Math.max(0, Math.min(Number(row.outTime), end) - Math.max(Number(row.inTime), inTime));
    }
  }
  const session = Math.max(0, end - inTime);
  return { voice, outVoice: Math.max(0, session - voice), session, coverage: session ? (voice / session) * 100 : 0 };
}

async function updateVoiceSegmentForUser(discordId, channelId, ts = now()) {
  const duty = activeDuty.get(String(discordId));
  if (!duty) return;
  const state = pendingVoice.get(String(discordId));
  const nextChannelId = channelId || null;
  if (state && state.channelId === nextChannelId) return;
  if (state) await q('UPDATE duty_voice_segments SET outTime=? WHERE id=? AND outTime IS NULL', [ts, state.segmentId]);
  const result = await q(
    'INSERT INTO duty_voice_segments (dutyId, discordId, channelId, inTime, outTime, isLeoVoice) VALUES (?, ?, ?, ?, NULL, ?)',
    [duty.id, String(discordId), nextChannelId, ts, isLeoVoice(nextChannelId) ? 1 : 0]
  );
  pendingVoice.set(String(discordId), { segmentId: result.insertId, channelId: nextChannelId });
}

async function closeVoiceForUser(discordId, ts = now()) {
  const key = String(discordId);
  const state = pendingVoice.get(key);
  if (!state) return;
  await q('UPDATE duty_voice_segments SET outTime=? WHERE id=? AND outTime IS NULL', [ts, state.segmentId]);
  pendingVoice.delete(key);
}

async function getReportGuild() {
  return client.guilds.fetch(REPORT_GUILD_ID).catch(() => null);
}

async function startDutyTracking(row) {
  if (!row?.discordId) return;
  const discordId = String(row.discordId);
  if (activeDuty.has(discordId)) return;
  const duty = {
    id: row.id,
    discordId,
    inTime: Number(row.inTime),
    department: assertDepartment(row.department) || String(row.department || '').toUpperCase()
  };
  activeDuty.set(discordId, duty);

  const guild = await getReportGuild();
  const member = guild ? await guild.members.fetch(discordId).catch(() => null) : null;
  if (member) {
    const segmentStart = Math.max(duty.inTime, now());
    await updateVoiceSegmentForUser(discordId, member.voice.channelId, segmentStart).catch(error => console.warn('Unable to begin voice segment:', error.message));
  }

  const user = await getDiscordUser(discordId);
  if (user) await sendDM(user, dutyOnEmbed({ user, department: duty.department, inTime: duty.inTime }));
}

async function finishDutyTracking(row) {
  const discordId = String(row.discordId);
  const duty = activeDuty.get(discordId);
  if (!duty) return;
  const inTime = duty.inTime || Number(row.inTime);
  const outTime = Number(row.outTime || now());

  await closeVoiceForUser(discordId, outTime).catch(() => {});
  const stats = await voiceSecondsForDuty(duty.id, inTime, outTime);
  const weeklyWindow = getWeekWindow(outTime);
  const weekly = {
    total: await totalDutySeconds({ discordId, department: duty.department, window: weeklyWindow }),
    startLabel: weeklyWindow.startLabel,
    endLabel: weeklyWindow.endLabel
  };
  const user = await getDiscordUser(discordId);
  if (user) {
    await sendDM(user, dutyOffEmbed({
      department: duty.department,
      outTime,
      session: stats.session,
      weekly,
      inVoice: stats.voice,
      outVoice: stats.outVoice,
      coverage: stats.coverage,
      reason: row.reason || 'Normal Duty Clock Out'
    }));
  }
  activeDuty.delete(discordId);
}

async function pollDuty() {
  try {
    const activeRows = await q('SELECT * FROM duty_hours WHERE outTime IS NULL AND discordId IS NOT NULL ORDER BY id DESC');
    const latestByUser = new Map();
    for (const row of activeRows) {
      const id = String(row.discordId);
      if (!latestByUser.has(id)) latestByUser.set(id, row);
    }

    for (const row of latestByUser.values()) await startDutyTracking(row);

    for (const [discordId, duty] of [...activeDuty.entries()]) {
      if (latestByUser.has(discordId)) continue;
      const rows = await q('SELECT * FROM duty_hours WHERE id=? LIMIT 1', [duty.id]);
      const row = rows[0];
      if (row?.outTime) await finishDutyTracking(row);
      else {
        await closeVoiceForUser(discordId).catch(() => {});
        activeDuty.delete(discordId);
      }
    }
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) {
      console.warn('Duty polling paused while MySQL is unavailable.');
      return;
    }
    console.error('Duty poll error:', error);
  }
}

client.on('voiceStateUpdate', async (oldState, newState) => {
  const discordId = String(newState.id || oldState.id);
  if (!activeDuty.has(discordId)) return;
  try {
    await updateVoiceSegmentForUser(discordId, newState.channelId);
  } catch (error) {
    if (!(error instanceof DatabaseUnavailableError)) console.error('Voice tracking error:', error);
  }
});

function baseCommand(name, description) {
  return new SlashCommandBuilder().setName(name).setDescription(description).setDMPermission(false);
}

const commands = [
  baseCommand('officer-report-panel', 'Post the WCRP officer report panel'),
  baseCommand('anonreport', 'Anonymize and rebuild the current report ticket'),
  baseCommand('addofficer', 'Reports Team: set the officer being reported'),
  baseCommand('reportadd', 'Reports Team: create an officer report ticket'),
  baseCommand('report-config', 'Admin: configure report ping roles and category'),
  baseCommand('report-staff', 'Admin: configure Reports Team roles'),
  baseCommand('log-config', 'Admin: configure log channels'),
  baseCommand('ridealong-permissions', 'Admin: configure ride-along permission roles'),
  baseCommand('ridealong-config', 'Admin: configure trainee and ride-along roles'),
  baseCommand('permissions', 'Admin: configure command permission roles'),
  baseCommand('admin-roles', 'Admin: configure bot administrator roles'),
  baseCommand('ridealong', 'Log a ride-along result'),
  baseCommand('rename', 'Reports Team: rename this ticket to handler-handling'),
  baseCommand('close', 'Reports Team: close this report ticket'),
  baseCommand('delete', 'Reports Team: delete this report ticket with transcript'),
  baseCommand('hours', 'Check duty hours by department and timeframe'),
  baseCommand('allhours', 'Show duty hours for everyone in a department'),
  baseCommand('totalhours', 'Show total duty hours for a department'),
  baseCommand('weeklydeptours', 'Show department duty hours for a timeframe'),
  baseCommand('deptofhours', 'Show top officers in a department by hours'),
  baseCommand('tophours', 'Show the top five officers by all-time duty hours'),
  baseCommand('leaderboard', 'Show a department duty leaderboard'),
  baseCommand('evaluate', 'Evaluate an exact user in a department and timeframe'),
  baseCommand('inactive_officers', 'Show inactive officers in a department'),
  baseCommand('promotions', 'Show promotion-eligible department officers'),
  baseCommand('leomulti', 'Set a temporary LEO hour multiplier marker'),
  baseCommand('add_org', 'Admin: add an organisation'),
  baseCommand('add_org_hours', 'Admin: add hours to an organisation total'),
  baseCommand('rename_org', 'Admin: rename an organisation'),
  baseCommand('dept_officers', 'Show department officers and activity status')
];

const departmentOption = (name = 'department', required = true) => (option) =>
  option
    .setName(name)
    .setDescription('Department')
    .setRequired(required)
    .addChoices(...DEPARTMENTS.map(value => ({ name: value, value })));

const timeframeChoices = [
  { name: 'Last Week', value: 'last_week' },
  { name: 'This Week', value: 'this_week' },
  { name: 'This Month', value: 'this_month' },
  { name: 'Last Month', value: 'last_month' },
  { name: 'All Time', value: 'all_time' }
];

commands.find(c => c.name === 'hours')
  .addStringOption(departmentOption('department', true))
  .addStringOption(o => o.setName('timeframe').setDescription('Timeframe').setRequired(true).addChoices(...timeframeChoices))
  .addUserOption(o => o.setName('user').setDescription('User to check; defaults to you').setRequired(false));

commands.find(c => c.name === 'evaluate')
  .addUserOption(o => o.setName('user').setDescription('Exact user to evaluate').setRequired(true))
  .addStringOption(departmentOption('department', true))
  .addStringOption(o => o.setName('timeframe').setDescription('Timeframe').setRequired(true).addChoices(...timeframeChoices));

for (const name of ['allhours', 'totalhours', 'weeklydeptours', 'deptofhours', 'leaderboard']) {
  commands.find(c => c.name === name)
    .addStringOption(departmentOption('department', true))
    .addStringOption(o => o.setName('timeframe').setDescription('Timeframe').setRequired(false).addChoices(...timeframeChoices));
}

for (const name of ['promotions', 'inactive_officers', 'dept_officers']) {
  commands.find(c => c.name === name).addStringOption(departmentOption('department', true));
}

commands.find(c => c.name === 'promotions')
  .addIntegerOption(o => o.setName('min_hours').setDescription('Minimum hours this week').setRequired(false).setMinValue(0));
commands.find(c => c.name === 'inactive_officers')
  .addIntegerOption(o => o.setName('weeks_back').setDescription('Inactivity threshold').setRequired(false).addChoices({ name: '2 weeks', value: 2 }, { name: '4 weeks', value: 4 }));
commands.find(c => c.name === 'dept_officers')
  .addIntegerOption(o => o.setName('weeks_back').setDescription('Activity threshold').setRequired(false).addChoices({ name: '2 weeks', value: 2 }, { name: '4 weeks', value: 4 }));
commands.find(c => c.name === 'leomulti')
  .addIntegerOption(o => o.setName('duration_minutes').setDescription('Duration in minutes').setRequired(true).setMinValue(1).setMaxValue(10080))
  .addNumberOption(o => o.setName('multiplier').setDescription('Multiplier').setRequired(false).setMinValue(1).setMaxValue(5));

commands.find(c => c.name === 'add_org')
  .addStringOption(o => o.setName('code').setDescription('Organisation code').setRequired(true))
  .addStringOption(o => o.setName('name').setDescription('Organisation name').setRequired(true));
commands.find(c => c.name === 'add_org_hours')
  .addStringOption(o => o.setName('code').setDescription('Organisation code').setRequired(true))
  .addNumberOption(o => o.setName('hours').setDescription('Hours to add').setRequired(true))
  .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false));
commands.find(c => c.name === 'rename_org')
  .addStringOption(o => o.setName('old_code').setDescription('Current code').setRequired(true))
  .addStringOption(o => o.setName('new_code').setDescription('New code').setRequired(true))
  .addStringOption(o => o.setName('name').setDescription('New organisation name').setRequired(true));

commands.find(c => c.name === 'permissions')
  .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices(
    { name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }, { name: 'Clear', value: 'clear' }, { name: 'View', value: 'view' }
  ))
  .addStringOption(o => o.setName('command').setDescription('Slash command name without /').setRequired(true))
  .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(false));

commands.find(c => c.name === 'admin-roles')
  .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices(
    { name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }, { name: 'Clear', value: 'clear' }, { name: 'View', value: 'view' }
  ))
  .addRoleOption(o => o.setName('role').setDescription('Bot administrator role').setRequired(false));

commands.find(c => c.name === 'report-staff')
  .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices(
    { name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }, { name: 'Clear', value: 'clear' }, { name: 'View', value: 'view' }
  ))
  .addRoleOption(o => o.setName('role').setDescription('Reports Team role').setRequired(false));

commands.find(c => c.name === 'ridealong-permissions')
  .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices(
    { name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }, { name: 'Clear', value: 'clear' }, { name: 'View', value: 'view' }
  ))
  .addRoleOption(o => o.setName('role').setDescription('Role allowed to use /ridealong').setRequired(false));

commands.find(c => c.name === 'report-config')
  .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices(
    { name: 'Add Department Ping Role', value: 'add_role' },
    { name: 'Remove Department Ping Role', value: 'remove_role' },
    { name: 'Clear Department Ping Roles', value: 'clear_roles' },
    { name: 'Set Ticket Category', value: 'set_category' },
    { name: 'Clear Ticket Category', value: 'clear_category' },
    { name: 'View', value: 'view' }
  ))
  .addStringOption(departmentOption('department', false))
  .addRoleOption(o => o.setName('role').setDescription('Department report ping role').setRequired(false))
  .addChannelOption(o => o.setName('category').setDescription('Report ticket category').setRequired(false).addChannelTypes(ChannelType.GuildCategory));

commands.find(c => c.name === 'log-config')
  .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices(
    { name: 'Set', value: 'set' }, { name: 'Clear', value: 'clear' }, { name: 'View', value: 'view' }
  ))
  .addStringOption(o => o.setName('type').setDescription('Log type').setRequired(true).addChoices(
    { name: 'Report Logs', value: 'report_log' },
    { name: 'Transcript Logs', value: 'transcript_log' },
    { name: 'Ride-Along Logs', value: 'ridealong_log' }
  ))
  .addChannelOption(o => o.setName('channel').setDescription('Log channel').setRequired(false).addChannelTypes(ChannelType.GuildText));

commands.find(c => c.name === 'ridealong-config')
  .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices(
    { name: 'Set', value: 'set' }, { name: 'Clear', value: 'clear' }, { name: 'View', value: 'view' }
  ))
  .addRoleOption(o => o.setName('ridealong_role').setDescription('Role assigned after a passed ride-along').setRequired(false))
  .addRoleOption(o => o.setName('trainee_role').setDescription('Trainee role removed when a ride-along is logged').setRequired(false));

commands.find(c => c.name === 'ridealong')
  .addUserOption(o => o.setName('player').setDescription('Trainee receiving the ride-along result').setRequired(true))
  .addStringOption(departmentOption('department', true))
  .addStringOption(o => o.setName('result').setDescription('Ride-along result').setRequired(true).addChoices(
    { name: 'Passed', value: 'Passed' }, { name: 'Failed', value: 'Failed' }
  ))
  .addRoleOption(o => o.setName('ridealong_role').setDescription('Optional role to assign on a pass').setRequired(false))
  .addStringOption(o => o.setName('notes').setDescription('Optional notes').setRequired(false));

commands.find(c => c.name === 'addofficer')
  .addUserOption(o => o.setName('user').setDescription('Reported Discord user').setRequired(false))
  .addStringOption(o => o.setName('user_id').setDescription('Exact reported Discord user ID').setRequired(false));

function addReportOptions(command) {
  command
    .addStringOption(departmentOption('department', true))
    .addUserOption(o => o.setName('officer').setDescription('Officer being reported').setRequired(false))
    .addStringOption(o => o.setName('date').setDescription('Date of incident').setRequired(false))
    .addStringOption(o => o.setName('game_id').setDescription('In-game ID').setRequired(false))
    .addStringOption(o => o.setName('evidence').setDescription('Evidence or clip links').setRequired(false))
    .addStringOption(o => o.setName('description').setDescription('Description').setRequired(false))
    .addStringOption(o => o.setName('context').setDescription('Additional context').setRequired(false));
}
addReportOptions(commands.find(c => c.name === 'reportadd'));

function buildCommandsJson() {
  const normalizeOptions = (options) => {
    if (!Array.isArray(options)) return options;
    return options
      .map(option => Array.isArray(option.options) ? { ...option, options: normalizeOptions(option.options) } : option)
      .sort((a, b) => Number(Boolean(b.required)) - Number(Boolean(a.required)));
  };

  return commands.map(command => {
    const json = command.toJSON();
    if (Array.isArray(json.options)) json.options = normalizeOptions(json.options);
    return json;
  });
}

async function registerCommands() {
  if (!TOKEN || !CLIENT_ID) throw new Error('Missing DISCORD_TOKEN or CLIENT_ID.');
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const body = buildCommandsJson();
  const registered = await rest.put(Routes.applicationCommands(CLIENT_ID), { body });
  console.log(`Registered ${Array.isArray(registered) ? registered.length : body.length} global commands.`);
}

function reportPanelEmbed() {
  return new EmbedBuilder()
    .setColor(0xe3a008)
    .setTitle('WCRP Reports')
    .setDescription(
      'Below is the officer report system. Select Officer Report to open the report form.\n\n' +
      'The ticket is private to you, the configured Reports Team, and the configured department report roles until it is anonymized.\n\n' +
      'Use /anonreport inside the ticket when the report needs to be made anonymous.'
    )
    .addFields({
      name: 'Officer Report',
      value: 'Report misconduct, rule violations, or other concerns involving a WCRP department member.'
    })
    .setFooter({ text: 'WCRP Department Utilities' });
}

function reportPanelRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('report_type')
      .setPlaceholder('Select a report type...')
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel('Officer Report')
          .setDescription('Open an officer report form')
          .setValue('officer')
      )
  );
}

function reportFieldsModal(type = 'officer') {
  return new ModalBuilder()
    .setCustomId(`report_modal:${type}`)
    .setTitle(type === 'higher' ? 'Higher Up Report' : 'Officer Report')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('department')
          .setLabel('Department')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('USM / SASP / BCSO / LSPD')
          .setRequired(true)
          .setMaxLength(8)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('officer')
          .setLabel('Officer Discord ID (optional)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Leave blank if Reports Team will use /addofficer')
          .setRequired(false)
          .setMaxLength(20)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('date')
          .setLabel('Date of incident')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('DD/MM/YYYY or other clear date')
          .setRequired(true)
          .setMaxLength(100)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('evidence')
          .setLabel('Clips / evidence')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Paste one clip or evidence link per line')
          .setRequired(false)
          .setMaxLength(2000)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('details')
          .setLabel('Context / details')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Explain what happened and include relevant context')
          .setRequired(true)
          .setMaxLength(4000)
      )
    );
}

function reportContext(report) {
  const pieces = [report.description, report.context].map(v => String(v || '').trim()).filter(Boolean);
  return pieces.length ? pieces.join('\n\n') : 'Not provided';
}

function buildReportEmbed(report) {
  const evidence = splitEvidence(report.clip);
  const fields = [
    {
      name: 'Reporting User',
      value: Number(report.anonymous) === 1 ? 'Anonymous' : (report.reporterId ? `<@${report.reporterId}>` : 'Not provided'),
      inline: false
    },
    { name: 'Department', value: `${report.department} - ${deptName(report.department)}`, inline: false },
    {
      name: 'Officer Reported',
      value: report.reportedUserId ? `<@${report.reportedUserId}>` : 'Not set. Reports Team can use /addofficer.',
      inline: false
    },
    { name: 'Date of Incident', value: clamp(report.dateOfIncident), inline: false }
  ];

  if (report.gameId) fields.push({ name: 'In-Game ID', value: clamp(report.gameId), inline: false });

  if (evidence.length) {
    const direct = evidence.slice(0, 4);
    direct.forEach((item, index) => {
      const chunks = splitTextChunks(item);
      chunks.forEach((chunk, chunkIndex) => fields.push({
        name: chunkIndex === 0 ? `Clip ${index + 1}` : `Clip ${index + 1} Continued`,
        value: chunk,
        inline: false
      }));
    });
    const remainingEvidence = evidence.slice(4).join('\n');
    splitTextChunks(remainingEvidence).forEach((chunk, index) => fields.push({
      name: index === 0 ? 'Additional Evidence' : `Additional Evidence ${index + 1}`,
      value: chunk,
      inline: false
    }));
  } else {
    fields.push({ name: 'Clip 1', value: 'Not provided', inline: false });
  }

  const contextChunks = splitTextChunks(reportContext(report));
  if (contextChunks.length) {
    contextChunks.forEach((chunk, index) => fields.push({
      name: index === 0 ? 'Context' : `Context ${index + 1}`,
      value: chunk,
      inline: false
    }));
  } else {
    fields.push({ name: 'Context', value: 'Not provided', inline: false });
  }

  return new EmbedBuilder()
    .setColor(0xe3a008)
    .setTitle(report.ticketType === 'higher' ? 'Higher Up Report' : 'Officer Report')
    .addFields(fields.slice(0, 25))
    .setFooter({ text: `WCRP Reports | Submitted ${formatShort(report.createdAt || now())}` });
}

function reportCloseButton(channelId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`report_close:${channelId}`)
      .setLabel('Close Report')
      .setStyle(ButtonStyle.Danger)
  );
}

function normalReportPermissions(guild, reporterId, departmentRoleIds, staffRoleIds) {
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }
  ];
  if (guild.members.me) {
    overwrites.push({
      id: guild.members.me.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages
      ]
    });
  }
  if (reporterId) {
    overwrites.push({
      id: reporterId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
    });
  }
  for (const roleId of [...new Set([...departmentRoleIds, ...staffRoleIds])]) {
    if (!guild.roles.cache.has(roleId)) continue;
    overwrites.push({
      id: roleId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
    });
  }
  return overwrites;
}

async function anonymousReportPermissions(guild, report, staffRoleIds) {
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }
  ];

  if (guild.members.me) {
    overwrites.push({
      id: guild.members.me.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages
      ]
    });
  }

  for (const roleId of [...new Set(staffRoleIds)]) {
    if (!guild.roles.cache.has(roleId)) continue;
    overwrites.push({
      id: roleId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
    });
  }

  if (report.reportedUserId && report.reportedUserId !== report.reporterId) {
    const member = await guild.members.fetch(report.reportedUserId).catch(() => null);
    if (member) {
      overwrites.push({
        id: member.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
        deny: [PermissionFlagsBits.SendMessages]
      });
    }
  }

  return overwrites;
}

async function persistReport(report) {
  reportCache.set(String(report.channelId), { ...report });
  try {
    await q(
      `INSERT INTO reports
       (channelId,ticketType,department,reporterId,reportedUserId,dateOfIncident,gameId,clip,description,context,anonymous,createdAt,closedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         ticketType=VALUES(ticketType), department=VALUES(department), reporterId=VALUES(reporterId),
         reportedUserId=VALUES(reportedUserId), dateOfIncident=VALUES(dateOfIncident), gameId=VALUES(gameId),
         clip=VALUES(clip), description=VALUES(description), context=VALUES(context), anonymous=VALUES(anonymous),
         createdAt=VALUES(createdAt), closedAt=VALUES(closedAt)`,
      [
        report.channelId, report.ticketType || 'officer', report.department, report.reporterId || null,
        report.reportedUserId || null, report.dateOfIncident || null, report.gameId || null,
        report.clip || null, report.description || null, report.context || null,
        Number(report.anonymous) ? 1 : 0, Number(report.createdAt || now()), report.closedAt || null
      ]
    );
    return true;
  } catch (error) {
    if (!(error instanceof DatabaseUnavailableError)) throw error;
    return false;
  }
}

function parseMentionId(value) {
  return String(value || '').match(/\d{17,20}/)?.[0] || null;
}

function embedFieldValue(embed, name) {
  const field = embed?.fields?.find(f => String(f.name).toLowerCase() === String(name).toLowerCase());
  return field?.value || null;
}

async function inferReportFromChannel(channel) {
  if (!channel?.isTextBased()) return null;
  const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (!messages?.size) return null;
  const message = [...messages.values()].find(m => {
    const title = m.embeds?.[0]?.title || '';
    return /Officer Report|Higher Up Report|Anonymous Report/i.test(title);
  });
  if (!message) return null;
  const embed = message.embeds[0];
  const departmentText = embedFieldValue(embed, 'Department') || '';
  const department = DEPARTMENTS.find(d => departmentText.toUpperCase().includes(d)) || null;
  if (!department) return null;

  const clipFields = (embed.fields || [])
    .filter(f => /^Clip \d+$/i.test(f.name) || /Evidence/i.test(f.name))
    .map(f => f.value)
    .filter(v => v && v !== 'Not provided');
  const reportingValue = embedFieldValue(embed, 'Reporting User');
  const reportedValue = embedFieldValue(embed, 'Officer Reported') || embedFieldValue(embed, 'Officer being reported');
  const anonymous = /anonymous/i.test(String(reportingValue || '')) || /anon-/i.test(channel.name);

  return {
    channelId: channel.id,
    ticketType: /Higher Up/i.test(embed.title || '') ? 'higher' : 'officer',
    department,
    reporterId: anonymous ? null : parseMentionId(reportingValue),
    reportedUserId: parseMentionId(reportedValue),
    dateOfIncident: embedFieldValue(embed, 'Date of Incident') || embedFieldValue(embed, 'Date of incident'),
    gameId: embedFieldValue(embed, 'In-Game ID'),
    clip: clipFields.join('\n') || null,
    description: null,
    context: embedFieldValue(embed, 'Context') || embedFieldValue(embed, 'Description') || null,
    anonymous: anonymous ? 1 : 0,
    createdAt: Math.floor(message.createdTimestamp / 1000),
    closedAt: null
  };
}

async function getReport(channelId, channel = null) {
  const key = String(channelId);
  if (reportCache.has(key)) return { ...reportCache.get(key) };
  try {
    const rows = await q('SELECT * FROM reports WHERE channelId=? LIMIT 1', [key]);
    if (rows[0]) {
      reportCache.set(key, { ...rows[0] });
      return { ...rows[0] };
    }
  } catch (error) {
    if (!(error instanceof DatabaseUnavailableError)) throw error;
  }

  const inferred = await inferReportFromChannel(channel);
  if (inferred) {
    reportCache.set(key, inferred);
    return { ...inferred };
  }
  return null;
}

async function sendReportPost(channel, report, { pingDepartment = false, pingReported = false } = {}) {
  let content;
  const allowedMentions = { parse: [], roles: [], users: [] };

  if (pingReported && report.reportedUserId) {
    content = `<@${report.reportedUserId}>`;
    allowedMentions.users = [report.reportedUserId];
  } else if (pingDepartment) {
    const roles = await getJsonSetting(`reportRoles:${report.department}`, [], channel.guild.id);
    const validRoles = roles.filter(id => channel.guild.roles.cache.has(id));
    if (validRoles.length) {
      content = validRoles.map(id => `<@&${id}>`).join(' ');
      allowedMentions.roles = validRoles;
    }
  }

  return channel.send({
    content,
    embeds: [buildReportEmbed(report)],
    components: [reportCloseButton(channel.id)],
    allowedMentions
  });
}

async function replaceReportPost(channel, report, options = {}) {
  const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (messages?.size) {
    const deletions = [];
    for (const message of messages.values()) {
      if (message.author.id !== client.user?.id) continue;
      if (!message.embeds?.length) continue;
      const title = message.embeds[0]?.title || '';
      if (/Officer Report|Higher Up Report|Anonymous Report/i.test(title)) deletions.push(message.delete().catch(() => {}));
    }
    await Promise.allSettled(deletions);
  }
  return sendReportPost(channel, report, options);
}

async function clearChannelFast(channel) {
  for (let round = 0; round < 10; round++) {
    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!messages?.size) break;
    await channel.bulkDelete(messages, true).catch(() => {});

    const remaining = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!remaining?.size) break;
    const oldMessages = [...remaining.values()].filter(m => Date.now() - m.createdTimestamp >= 13.5 * 24 * 60 * 60 * 1000);
    if (oldMessages.length) await Promise.allSettled(oldMessages.map(m => m.delete().catch(() => {})));
    if (remaining.size < 100 && !oldMessages.length) break;
  }
}

async function createReportTicket({ interaction, type = 'officer', department, dateOfIncident, gameId = null, clip = null, description = null, context = null, reportedUserId = null }) {
  const guild = interaction.guild;
  if (!guild || guild.id !== REPORT_GUILD_ID) return null;

  const departmentRoles = await getJsonSetting(`reportRoles:${department}`, [], guild.id);
  const staffRoles = await getJsonSetting('reportStaffRoles', [], guild.id);
  const categoryId = await getSetting('reportCategoryId', null, guild.id);
  const parent = categoryId && guild.channels.cache.get(categoryId)?.type === ChannelType.GuildCategory ? categoryId : undefined;

  const channel = await guild.channels.create({
    name: `report-${department.toLowerCase()}-${cleanName(interaction.user.username)}`,
    type: ChannelType.GuildText,
    parent,
    permissionOverwrites: normalReportPermissions(guild, interaction.user.id, departmentRoles, staffRoles)
  });

  const report = {
    channelId: channel.id,
    ticketType: type,
    department,
    reporterId: interaction.user.id,
    reportedUserId,
    dateOfIncident: dateOfIncident || null,
    gameId: gameId || null,
    clip: clip || null,
    description: description || null,
    context: context || null,
    anonymous: 0,
    createdAt: now(),
    closedAt: null
  };

  await persistReport(report);
  await sendReportPost(channel, report, { pingDepartment: true });
  return channel;
}

async function makeTranscript(channel) {
  const all = [];
  let before;
  for (let i = 0; i < 20; i++) {
    const messages = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!messages?.size) break;
    all.push(...messages.values());
    before = messages.last().id;
    if (messages.size < 100) break;
  }
  all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  return all.map(message => {
    const attachmentText = message.attachments.size
      ? ` Attachments: ${[...message.attachments.values()].map(a => a.url).join(', ')}`
      : '';
    return `[${new Date(message.createdTimestamp).toISOString()}] ${message.author.tag}: ${message.content || '[embed/attachment]'}${attachmentText}`;
  }).join('\n');
}

async function ensureReportPermissions(member) {
  return roleAllowed(member, 'reportStaffRoles');
}

async function reportConfigText(guildId) {
  const lines = [];
  for (const department of DEPARTMENTS) {
    const roleIds = await getJsonSetting(`reportRoles:${department}`, [], guildId);
    lines.push(`${department}: ${roleIds.length ? roleIds.map(id => `<@&${id}>`).join(', ') : 'None'}`);
  }
  const categoryId = await getSetting('reportCategoryId', null, guildId);
  lines.push(`Category: ${categoryId ? `<#${categoryId}>` : 'Not configured'}`);
  return lines.join('\n');
}

async function sendReportLog(guild, title, report, extraFields = []) {
  const channelId = await getSetting('reportLogChannelId', null, guild.id);
  const channel = channelId ? guild.channels.cache.get(channelId) : null;
  if (!channel?.isTextBased()) return;
  const embed = new EmbedBuilder()
    .setColor(0xe3a008)
    .setTitle(title)
    .addFields(
      { name: 'Department', value: report.department, inline: true },
      { name: 'Ticket', value: `<#${report.channelId}>`, inline: true },
      ...extraFields
    )
    .setFooter({ text: `WCRP Department Utilities | ${formatShort(now())}` });
  await channel.send({ embeds: [embed] }).catch(() => {});
}

async function handleHours(interaction) {
  const user = interaction.options.getUser('user') || interaction.user;
  const department = assertDepartment(interaction.options.getString('department'));
  const timeframe = interaction.options.getString('timeframe');
  const window = windowFor(timeframe);
  const seconds = await totalDutySeconds({ discordId: user.id, department, window });

  const embed = new EmbedBuilder()
    .setColor(0x3b82f6)
    .setTitle('Duty Hours')
    .addFields(
      { name: 'Member', value: `<@${user.id}>`, inline: true },
      { name: 'Department', value: department, inline: true },
      { name: 'Timeframe', value: timeframeLabel(timeframe), inline: true },
      { name: 'Hours', value: hoursText(seconds), inline: false }
    )
    .setFooter({ text: 'WCRP Department Utilities' });
  return respond(interaction, { embeds: [embed] });
}

async function departmentHourRows(department, timeframe) {
  const window = windowFor(timeframe);
  return q(
    `SELECT discordId,
            SUM(GREATEST(0, LEAST(COALESCE(outTime, UNIX_TIMESTAMP()), ?) - GREATEST(inTime, ?))) seconds
     FROM duty_hours
     WHERE department=? AND inTime IS NOT NULL AND inTime < ?
       AND COALESCE(outTime, UNIX_TIMESTAMP()) > ? AND discordId IS NOT NULL
     GROUP BY discordId ORDER BY seconds DESC`,
    [window.end, window.start, department, window.end, window.start]
  );
}

async function handleDepartmentHours(interaction, mode) {
  const department = assertDepartment(interaction.options.getString('department'));
  const timeframe = interaction.options.getString('timeframe') || 'this_week';
  const rows = await departmentHourRows(department, timeframe);

  if (mode === 'total') {
    const total = rows.reduce((sum, row) => sum + Number(row.seconds || 0), 0);
    return respond(interaction, {
      embeds: [new EmbedBuilder()
        .setColor(0x3b82f6)
        .setTitle('Department Hours')
        .addFields(
          { name: 'Department', value: department, inline: true },
          { name: 'Timeframe', value: timeframeLabel(timeframe), inline: true },
          { name: 'Total', value: hoursText(total), inline: false }
        )
        .setFooter({ text: 'WCRP Department Utilities' })]
    });
  }

  const limit = mode === 'leaderboard' ? 10 : 25;
  const shown = rows.slice(0, limit);
  const description = shown.length
    ? shown.map((row, i) => `${i + 1}. <@${row.discordId}> - ${hoursText(Number(row.seconds))}`).join('\n')
    : 'No recorded hours.';

  return respond(interaction, {
    embeds: [new EmbedBuilder()
      .setColor(0x3b82f6)
      .setTitle(mode === 'leaderboard' ? 'Department Leaderboard' : 'Department Hours')
      .setDescription(description)
      .setFooter({ text: `${department} | ${timeframeLabel(timeframe)} | WCRP` })]
  });
}

async function handleEvaluate(interaction) {
  const user = interaction.options.getUser('user', true);
  const department = assertDepartment(interaction.options.getString('department'));
  const timeframe = interaction.options.getString('timeframe');
  const window = windowFor(timeframe);
  const requiredHours = Number(await getSetting(`requirement:${department}`, '8', interaction.guild.id));
  const total = await totalDutySeconds({ discordId: user.id, department, window });
  const requiredSeconds = Math.max(0, requiredHours * 3600);
  const remaining = Math.max(0, requiredSeconds - total);

  return respond(interaction, {
    embeds: [new EmbedBuilder()
      .setColor(total >= requiredSeconds ? 0x2f9e44 : 0xe04f5f)
      .setTitle(`${department} Evaluation`)
      .addFields(
        { name: 'Member', value: `<@${user.id}>`, inline: true },
        { name: 'Department', value: department, inline: true },
        { name: 'Timeframe', value: timeframeLabel(timeframe), inline: true },
        { name: 'Hours Worked', value: hoursText(total), inline: true },
        { name: 'Requirement', value: `${requiredHours.toFixed(2)}h`, inline: true },
        { name: 'Status', value: total >= requiredSeconds ? 'Requirement Met' : 'Below Requirement', inline: true },
        { name: 'Remaining', value: hoursText(remaining), inline: false }
      )
      .setFooter({ text: 'WCRP Department Utilities' })]
  });
}

async function handleAdminRoleList(interaction, key, label) {
  const action = interaction.options.getString('action', true);
  const role = interaction.options.getRole('role');
  let roles = await getJsonSetting(key, [], interaction.guild.id);

  if (action === 'add') {
    if (!role) return respond(interaction, { content: 'Select a role to add.' });
    roles = [...new Set([...roles, role.id])];
    await setJsonSetting(key, roles, interaction.guild.id);
  } else if (action === 'remove') {
    if (!role) return respond(interaction, { content: 'Select a role to remove.' });
    roles = roles.filter(id => id !== role.id);
    await setJsonSetting(key, roles, interaction.guild.id);
  } else if (action === 'clear') {
    roles = [];
    await setJsonSetting(key, roles, interaction.guild.id);
  }

  return respond(interaction, {
    content: `${label}: ${roles.length ? roles.map(id => `<@&${id}>`).join(', ') : 'None'}`
  });
}

async function handleReportConfig(interaction) {
  const action = interaction.options.getString('action', true);
  const department = assertDepartment(interaction.options.getString('department'));
  const role = interaction.options.getRole('role');
  const category = interaction.options.getChannel('category');

  if (action === 'add_role' || action === 'remove_role' || action === 'clear_roles') {
    if (!department) return respond(interaction, { content: 'Select a department for department role changes.' });
    let roles = await getJsonSetting(`reportRoles:${department}`, [], interaction.guild.id);
    if (action === 'add_role') {
      if (!role) return respond(interaction, { content: 'Select the department report ping role to add.' });
      roles = [...new Set([...roles, role.id])];
    } else if (action === 'remove_role') {
      if (!role) return respond(interaction, { content: 'Select the department report ping role to remove.' });
      roles = roles.filter(id => id !== role.id);
    } else {
      roles = [];
    }
    await setJsonSetting(`reportRoles:${department}`, roles, interaction.guild.id);
  } else if (action === 'set_category') {
    if (!category) return respond(interaction, { content: 'Select the report ticket category.' });
    await setSetting('reportCategoryId', category.id, interaction.guild.id);
  } else if (action === 'clear_category') {
    await setSetting('reportCategoryId', '', interaction.guild.id);
  }

  return respond(interaction, { content: await reportConfigText(interaction.guild.id) });
}

async function handleLogConfig(interaction) {
  const action = interaction.options.getString('action', true);
  const type = interaction.options.getString('type', true);
  const channel = interaction.options.getChannel('channel');
  const key = type === 'report_log'
    ? 'reportLogChannelId'
    : type === 'transcript_log'
      ? 'transcriptChannelId'
      : 'ridealongLogChannelId';

  if (action === 'set') {
    if (!channel) return respond(interaction, { content: 'Select a log channel.' });
    await setSetting(key, channel.id, interaction.guild.id);
  } else if (action === 'clear') {
    await setSetting(key, '', interaction.guild.id);
  }

  const value = await getSetting(key, null, interaction.guild.id);
  return respond(interaction, { content: `${type}: ${value ? `<#${value}>` : 'Not configured'}` });
}

async function handleAddOfficer(interaction) {
  if (!await ensureReportPermissions(interaction.member)) {
    return respond(interaction, { content: 'Reports Team permission required.' });
  }
  const report = await getReport(interaction.channel.id, interaction.channel);
  if (!report) return respond(interaction, { content: 'This is not a report ticket.' });

  const selected = interaction.options.getUser('user');
  const rawId = interaction.options.getString('user_id')?.trim();
  const targetId = selected?.id || rawId;
  if (!/^\d{17,20}$/.test(String(targetId || ''))) {
    return respond(interaction, { content: 'Provide a Discord user or an exact Discord user ID.' });
  }

  const member = await interaction.guild.members.fetch(targetId).catch(() => null);
  if (!member) return respond(interaction, { content: 'That Discord user is not a member of this server.' });

  const oldTargetId = report.reportedUserId;
  report.reportedUserId = targetId;
  await persistReport(report);

  if (Number(report.anonymous) === 1) {
    if (oldTargetId && oldTargetId !== targetId) {
      await interaction.channel.permissionOverwrites.delete(oldTargetId).catch(() => {});
    }
    const staffRoles = await getJsonSetting('reportStaffRoles', [], interaction.guild.id);
    await interaction.channel.permissionOverwrites.set(await anonymousReportPermissions(interaction.guild, report, staffRoles));
    await replaceReportPost(interaction.channel, report, { pingReported: true });
  } else {
    await replaceReportPost(interaction.channel, report, { pingDepartment: false });
  }

  return respond(interaction, {
    content: Number(report.anonymous) === 1
      ? `Officer set to <@${targetId}>. Their read-only ticket access is active and the complete evidence embed was resubmitted.`
      : `Officer set to <@${targetId}>.`
  });
}

async function handleAnonReport(interaction) {
  const report = await getReport(interaction.channel.id, interaction.channel);
  if (!report) return respond(interaction, { content: 'This is not a report ticket.' });

  const isReporter = report.reporterId === interaction.user.id;
  const isReportsTeam = await ensureReportPermissions(interaction.member);
  if (!isReporter && !isReportsTeam) {
    return respond(interaction, { content: 'Only the report opener or Reports Team can anonymize this ticket.' });
  }

  report.anonymous = 1;
  await persistReport(report);

  const staffRoles = await getJsonSetting('reportStaffRoles', [], interaction.guild.id);
  const overwrites = await anonymousReportPermissions(interaction.guild, report, staffRoles);
  await interaction.channel.permissionOverwrites.set(overwrites);
  await interaction.channel.setName(`anon-${report.department.toLowerCase()}`).catch(() => {});
  await clearChannelFast(interaction.channel);
  await sendReportPost(interaction.channel, report, { pingReported: Boolean(report.reportedUserId) });
  await sendReportLog(interaction.guild, 'Report Anonymized', report, [
    { name: 'Reported Officer', value: report.reportedUserId ? `<@${report.reportedUserId}>` : 'Not set', inline: true }
  ]);

  return respond(interaction, {
    content: report.reportedUserId
      ? 'The ticket is now anonymous. The opener and department roles were removed; only Reports Team, the bot, and the reported officer retain access.'
      : 'The ticket is now anonymous. The opener and department roles were removed; only Reports Team and the bot retain access until /addofficer is used.'
  });
}

async function handleRename(interaction) {
  if (!await ensureReportPermissions(interaction.member)) {
    return respond(interaction, { content: 'Reports Team permission required.' });
  }
  const report = await getReport(interaction.channel.id, interaction.channel);
  if (!report) return respond(interaction, { content: 'This is not a report ticket.' });
  const base = cleanName(interaction.user.username);
  await interaction.channel.setName(`${base}-handling`);
  return respond(interaction, { content: `Channel renamed to ${base}-handling.` });
}

async function handleClose(interaction) {
  if (!await ensureReportPermissions(interaction.member)) {
    return respond(interaction, { content: 'Reports Team permission required.' });
  }
  const report = await getReport(interaction.channel.id, interaction.channel);
  if (!report) return respond(interaction, { content: 'This is not a report ticket.' });
  report.closedAt = now();
  await persistReport(report);

  if (report.reporterId) await interaction.channel.permissionOverwrites.delete(report.reporterId).catch(() => {});
  if (report.reportedUserId) await interaction.channel.permissionOverwrites.delete(report.reportedUserId).catch(() => {});
  await sendReportLog(interaction.guild, 'Report Closed', report, [
    { name: 'Closed By', value: `<@${interaction.user.id}>`, inline: true }
  ]);
  return respond(interaction, { content: 'Ticket closed.' });
}

async function handleDelete(interaction) {
  if (!await ensureReportPermissions(interaction.member) && !(await isAdmin(interaction.member))) {
    return respond(interaction, { content: 'Reports Team permission required.' });
  }
  const report = await getReport(interaction.channel.id, interaction.channel);
  if (!report) return respond(interaction, { content: 'This is not a report ticket.' });

  const transcript = await makeTranscript(interaction.channel);
  const transcriptId = await getSetting('transcriptChannelId', null, interaction.guild.id);
  const transcriptChannel = transcriptId ? interaction.guild.channels.cache.get(transcriptId) : null;
  if (transcriptChannel?.isTextBased()) {
    await transcriptChannel.send({
      content: `Transcript for #${interaction.channel.name}`,
      files: [{ attachment: Buffer.from(transcript || 'No messages.'), name: `${interaction.channel.name}-transcript.txt` }]
    }).catch(() => {});
  }

  await respond(interaction, { content: 'Transcript saved where configured. Deleting this ticket.' });
  setTimeout(() => interaction.channel.delete().catch(() => {}), 750);
}

async function handleRideAlong(interaction) {
  if (!await roleAllowed(interaction.member, 'ridealongRoles')) {
    return respond(interaction, { content: 'You do not have permission to log ride-alongs.' });
  }

  const player = interaction.options.getUser('player', true);
  const department = assertDepartment(interaction.options.getString('department'));
  const result = interaction.options.getString('result', true);
  const selectedRole = interaction.options.getRole('ridealong_role');
  const configuredRoleId = await getSetting('ridealongResultRoleId', null, interaction.guild.id);
  const traineeRoleId = await getSetting('traineeRoleId', null, interaction.guild.id);
  const notes = interaction.options.getString('notes');
  const roleId = selectedRole?.id || configuredRoleId || null;

  const member = await interaction.guild.members.fetch(player.id).catch(() => null);
  let traineeRemoved = false;
  let resultRoleAdded = false;
  if (member && traineeRoleId && member.roles.cache.has(traineeRoleId)) {
    traineeRemoved = await member.roles.remove(traineeRoleId, `Ride-along logged by ${interaction.user.tag}`).then(() => true).catch(() => false);
  }
  if (member && result === 'Passed' && roleId && !member.roles.cache.has(roleId)) {
    resultRoleAdded = await member.roles.add(roleId, `Ride-along passed and logged by ${interaction.user.tag}`).then(() => true).catch(() => false);
  }

  let databaseRecorded = true;
  try {
    await q(
      'INSERT INTO ridealongs (discordId,department,ridealongRoleId,result,notes,createdBy,createdAt) VALUES (?,?,?,?,?,?,?)',
      [player.id, department, roleId, result, notes || null, interaction.user.id, now()]
    );
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) databaseRecorded = false;
    else throw error;
  }

  const embed = new EmbedBuilder()
    .setColor(result === 'Passed' ? 0x2f9e44 : 0xe04f5f)
    .setTitle('Ride-Along Log')
    .addFields(
      { name: 'Player', value: `<@${player.id}>`, inline: true },
      { name: 'Department', value: department, inline: true },
      { name: 'Result', value: result, inline: true },
      { name: 'Trainee Role Removed', value: traineeRemoved ? 'Yes' : 'No', inline: true },
      { name: 'Ride-Along Role Added', value: resultRoleAdded ? 'Yes' : 'No', inline: true },
      { name: 'Database Record', value: databaseRecorded ? 'Saved' : 'MySQL offline; Discord role changes still completed', inline: false },
      { name: 'Notes', value: notes || 'None', inline: false },
      { name: 'Logged By', value: `<@${interaction.user.id}>`, inline: true }
    )
    .setFooter({ text: `WCRP Department Utilities | ${formatShort(now())}` });

  const logChannelId = await getSetting('ridealongLogChannelId', null, interaction.guild.id);
  const logChannel = logChannelId ? interaction.guild.channels.cache.get(logChannelId) : null;
  if (logChannel?.isTextBased()) await logChannel.send({ embeds: [embed] }).catch(() => {});
  return respond(interaction, { embeds: [embed] });
}

async function handleCommand(interaction) {
  const name = interaction.commandName;

  if (!interaction.guild) {
    return respond(interaction, { content: 'This command can only be used in a server.' });
  }

  if (REPORT_GUILD_COMMANDS.has(name) && interaction.guild.id !== REPORT_GUILD_ID) {
    return respond(interaction, { content: `Reports and ride-alongs are only available in server ${REPORT_GUILD_ID}.` });
  }

  if (!(await commandAllowed(interaction.member, name))) {
    return respond(interaction, { content: 'You do not have permission to use this command.' });
  }

  if (ADMIN_COMMANDS.has(name) && !(await isAdmin(interaction.member))) {
    return respond(interaction, { content: 'Administrator permission required.' });
  }

  if (name === 'officer-report-panel') {
    await interaction.channel.send({ embeds: [reportPanelEmbed()], components: [reportPanelRow()] });
    return respond(interaction, { content: 'WCRP report panel posted.' });
  }

  if (name === 'admin-roles') {
    return handleAdminRoleList(interaction, 'adminRoles', 'Bot administrator roles');
  }

  if (name === 'permissions') {
    const action = interaction.options.getString('action', true);
    const commandName = String(interaction.options.getString('command', true)).toLowerCase().replace(/^\//, '').trim();
    const role = interaction.options.getRole('role');
    if (!commands.some(command => command.name === commandName)) {
      return respond(interaction, { content: `Unknown command: /${commandName}` });
    }
    let roles = await getJsonSetting(`cmdperm:${commandName}`, [], interaction.guild.id);
    if (action === 'add') {
      if (!role) return respond(interaction, { content: 'Select a role to add.' });
      roles = [...new Set([...roles, role.id])];
      await setJsonSetting(`cmdperm:${commandName}`, roles, interaction.guild.id);
    } else if (action === 'remove') {
      if (!role) return respond(interaction, { content: 'Select a role to remove.' });
      roles = roles.filter(id => id !== role.id);
      await setJsonSetting(`cmdperm:${commandName}`, roles, interaction.guild.id);
    } else if (action === 'clear') {
      roles = [];
      await setJsonSetting(`cmdperm:${commandName}`, roles, interaction.guild.id);
    }
    return respond(interaction, {
      content: `/${commandName}: ${roles.length ? roles.map(id => `<@&${id}>`).join(', ') : 'Everyone'}`
    });
  }

  if (name === 'report-config') return handleReportConfig(interaction);
  if (name === 'report-staff') return handleAdminRoleList(interaction, 'reportStaffRoles', 'Reports Team roles');
  if (name === 'ridealong-permissions') return handleAdminRoleList(interaction, 'ridealongRoles', 'Ride-along permission roles');
  if (name === 'log-config') return handleLogConfig(interaction);

  if (name === 'ridealong-config') {
    const action = interaction.options.getString('action', true);
    const rideRole = interaction.options.getRole('ridealong_role');
    const traineeRole = interaction.options.getRole('trainee_role');
    if (action === 'set') {
      if (rideRole) await setSetting('ridealongResultRoleId', rideRole.id, interaction.guild.id);
      if (traineeRole) await setSetting('traineeRoleId', traineeRole.id, interaction.guild.id);
      if (!rideRole && !traineeRole) {
        return respond(interaction, { content: 'Select a ride-along role, trainee role, or both.' });
      }
    } else if (action === 'clear') {
      await setSetting('ridealongResultRoleId', '', interaction.guild.id);
      await setSetting('traineeRoleId', '', interaction.guild.id);
    }
    const currentRide = await getSetting('ridealongResultRoleId', null, interaction.guild.id);
    const currentTrainee = await getSetting('traineeRoleId', null, interaction.guild.id);
    return respond(interaction, {
      content: `Ride-along role: ${currentRide ? `<@&${currentRide}>` : 'Not configured'}\nTrainee role: ${currentTrainee ? `<@&${currentTrainee}>` : 'Not configured'}`
    });
  }

  if (name === 'addofficer') return handleAddOfficer(interaction);

  if (name === 'reportadd') {
    if (!await ensureReportPermissions(interaction.member)) {
      return respond(interaction, { content: 'Reports Team permission required.' });
    }
    const department = assertDepartment(interaction.options.getString('department'));
    const channel = await createReportTicket({
      interaction,
      type: 'officer',
      department,
      reportedUserId: interaction.options.getUser('officer')?.id || null,
      dateOfIncident: interaction.options.getString('date'),
      gameId: interaction.options.getString('game_id'),
      clip: interaction.options.getString('evidence'),
      description: interaction.options.getString('description'),
      context: interaction.options.getString('context')
    });
    if (channel) {
      const report = await getReport(channel.id, channel);
      if (report) await sendReportLog(interaction.guild, 'Report Created', report);
    }
    return respond(interaction, { content: channel ? `Report created: ${channel}` : 'Unable to create the report.' });
  }

  if (name === 'anonreport') return handleAnonReport(interaction);
  if (name === 'rename') return handleRename(interaction);
  if (name === 'close') return handleClose(interaction);
  if (name === 'delete') return handleDelete(interaction);
  if (name === 'ridealong') return handleRideAlong(interaction);
  if (name === 'hours') return handleHours(interaction);
  if (name === 'evaluate') return handleEvaluate(interaction);

  if (['allhours', 'totalhours', 'weeklydeptours', 'leaderboard'].includes(name)) {
    return handleDepartmentHours(interaction, name === 'totalhours' ? 'total' : name);
  }

  if (name === 'deptofhours') {
    const department = assertDepartment(interaction.options.getString('department'));
    const timeframe = interaction.options.getString('timeframe') || 'this_week';
    const rows = (await departmentHourRows(department, timeframe)).slice(0, 10);
    const description = rows.length
      ? rows.map((row, i) => `${i + 1}. <@${row.discordId}> - ${hoursText(Number(row.seconds))}`).join('\n')
      : 'No recorded hours.';
    return respond(interaction, {
      embeds: [new EmbedBuilder()
        .setColor(0x3b82f6)
        .setTitle(`Top ${department} Officers`)
        .setDescription(description)
        .setFooter({ text: `${timeframeLabel(timeframe)} | WCRP Department Utilities` })]
    });
  }

  if (name === 'tophours') {
    const rows = await q(
      'SELECT discordId, SUM(GREATEST(0, COALESCE(outTime, UNIX_TIMESTAMP()) - inTime)) seconds FROM duty_hours WHERE discordId IS NOT NULL GROUP BY discordId ORDER BY seconds DESC LIMIT 5'
    );
    const description = rows.length
      ? rows.map((row, i) => `${i + 1}. <@${row.discordId}> - ${hoursText(Number(row.seconds))}`).join('\n')
      : 'No recorded hours.';
    return respond(interaction, {
      embeds: [new EmbedBuilder().setColor(0x3b82f6).setTitle('Top Hours').setDescription(description).setFooter({ text: 'WCRP Department Utilities' })]
    });
  }

  if (name === 'inactive_officers') {
    const department = assertDepartment(interaction.options.getString('department'));
    const weeks = interaction.options.getInteger('weeks_back') || 2;
    const cutoff = now() - weeks * 7 * 86400;
    const rows = await q(
      'SELECT discordId, MAX(COALESCE(outTime, UNIX_TIMESTAMP())) lastDuty FROM duty_hours WHERE department=? AND discordId IS NOT NULL GROUP BY discordId HAVING lastDuty < ? ORDER BY lastDuty ASC',
      [department, cutoff]
    );
    const description = rows.length
      ? rows.map(row => `<@${row.discordId}> - last duty ${formatShort(Number(row.lastDuty))}`).join('\n')
      : 'No inactive officers found.';
    return respond(interaction, {
      embeds: [new EmbedBuilder()
        .setColor(0xe0a458)
        .setTitle(`${department} Inactive Officers`)
        .setDescription(description)
        .setFooter({ text: `${weeks}+ weeks without duty | WCRP` })]
    });
  }

  if (name === 'dept_officers') {
    const department = assertDepartment(interaction.options.getString('department'));
    const weeks = interaction.options.getInteger('weeks_back') || 2;
    const cutoff = now() - weeks * 7 * 86400;
    const rows = await q(
      'SELECT discordId, MAX(COALESCE(outTime, UNIX_TIMESTAMP())) lastDuty FROM duty_hours WHERE department=? AND discordId IS NOT NULL GROUP BY discordId ORDER BY lastDuty DESC',
      [department]
    );
    const shown = rows.slice(0, 25);
    const description = shown.length
      ? shown.map(row => `<@${row.discordId}> - ${Number(row.lastDuty) >= cutoff ? 'Active' : 'Inactive'} - ${formatShort(Number(row.lastDuty))}`).join('\n')
      : 'No officers found.';
    return respond(interaction, {
      embeds: [new EmbedBuilder()
        .setColor(0x3b82f6)
        .setTitle(`${department} Officers`)
        .setDescription(description)
        .setFooter({ text: `Active means duty within ${weeks} weeks | WCRP` })]
    });
  }

  if (name === 'promotions') {
    const department = assertDepartment(interaction.options.getString('department'));
    const minimum = interaction.options.getInteger('min_hours') ?? 8;
    const window = getWeekWindow();
    const rows = await q(
      `SELECT discordId,
              SUM(GREATEST(0, LEAST(COALESCE(outTime, UNIX_TIMESTAMP()), ?) - GREATEST(inTime, ?))) seconds
       FROM duty_hours
       WHERE department=? AND inTime < ? AND COALESCE(outTime, UNIX_TIMESTAMP()) > ? AND discordId IS NOT NULL
       GROUP BY discordId HAVING seconds >= ? ORDER BY seconds DESC`,
      [window.end, window.start, department, window.end, window.start, minimum * 3600]
    );
    const description = rows.length
      ? rows.map(row => `<@${row.discordId}> - ${hoursText(Number(row.seconds))}`).join('\n')
      : 'No members meet the current threshold.';
    return respond(interaction, {
      embeds: [new EmbedBuilder()
        .setColor(0x3b82f6)
        .setTitle(`${department} Promotion Eligibility`)
        .setDescription(description)
        .setFooter({ text: `Minimum ${minimum}h this week | WCRP` })]
    });
  }

  if (name === 'leomulti') {
    const duration = interaction.options.getInteger('duration_minutes', true);
    const multiplier = interaction.options.getNumber('multiplier') || 1.5;
    await setJsonSetting('leoMultiplier', { multiplier, until: now() + duration * 60 }, interaction.guild.id);
    return respond(interaction, { content: `LEO hour multiplier marker set to ${multiplier}x for ${duration} minutes.` });
  }

  if (name === 'add_org') {
    const code = interaction.options.getString('code', true).toUpperCase();
    const orgName = interaction.options.getString('name', true);
    await q('INSERT INTO department_orgs (code,name,createdBy) VALUES (?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)', [code, orgName, interaction.user.id]);
    return respond(interaction, { content: `Added organisation ${code} - ${orgName}.` });
  }

  if (name === 'add_org_hours') {
    const code = interaction.options.getString('code', true).toUpperCase();
    const hours = interaction.options.getNumber('hours', true);
    const reason = interaction.options.getString('reason');
    await q('INSERT INTO org_hours_adjustments (orgCode,hours,reason,createdBy,createdAt) VALUES (?,?,?,?,?)', [code, hours, reason || null, interaction.user.id, now()]);
    return respond(interaction, { content: `Added ${hours.toFixed(2)} hours to ${code}.` });
  }

  if (name === 'rename_org') {
    const oldCode = interaction.options.getString('old_code', true).toUpperCase();
    const newCode = interaction.options.getString('new_code', true).toUpperCase();
    const orgName = interaction.options.getString('name', true);
    await q('UPDATE department_orgs SET code=?,name=? WHERE code=?', [newCode, orgName, oldCode]);
    await q('UPDATE org_hours_adjustments SET orgCode=? WHERE orgCode=?', [newCode, oldCode]);
    return respond(interaction, { content: `Renamed ${oldCode} to ${newCode}.` });
  }

  return respond(interaction, { content: 'Command handler not implemented.' });
}

async function handleReportSelect(interaction) {
  if (!interaction.guild || interaction.guild.id !== REPORT_GUILD_ID) {
    return interaction.reply({ content: `Reports are only available in server ${REPORT_GUILD_ID}.`, ephemeral: true });
  }
  const type = interaction.values[0] || 'officer';
  return interaction.showModal(reportFieldsModal(type));
}

async function handleReportModal(interaction) {
  const [, type = 'officer'] = interaction.customId.split(':');
  const department = assertDepartment(interaction.fields.getTextInputValue('department'));
  if (!department) {
    return respond(interaction, { content: 'Department must be USM, SASP, BCSO, or LSPD.' });
  }

  const officerRaw = interaction.fields.getTextInputValue('officer')?.trim() || '';
  const reportedUserId = officerRaw ? parseMentionId(officerRaw) : null;
  if (officerRaw && !reportedUserId) {
    return respond(interaction, { content: 'The officer field must be a valid Discord user ID or left blank.' });
  }

  const channel = await createReportTicket({
    interaction,
    type,
    department,
    reportedUserId,
    dateOfIncident: interaction.fields.getTextInputValue('date'),
    clip: interaction.fields.getTextInputValue('evidence'),
    description: null,
    context: interaction.fields.getTextInputValue('details')
  });

  if (channel) {
    const report = await getReport(channel.id, channel);
    if (report) await sendReportLog(interaction.guild, 'Report Created', report);
  }
  return respond(interaction, { content: channel ? `Your report ticket has been created: ${channel}` : 'Unable to create the report ticket.' });
}

async function handleReportCloseButton(interaction) {
  if (!interaction.guild || interaction.guild.id !== REPORT_GUILD_ID) {
    return respond(interaction, { content: `Reports are only available in server ${REPORT_GUILD_ID}.` });
  }
  return handleClose(interaction);
}

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isStringSelectMenu() && interaction.customId === 'report_type') {
      return await handleReportSelect(interaction);
    }

    if (interaction.isChatInputCommand()) {
      await interaction.deferReply({ ephemeral: PRIVATE_COMMANDS.has(interaction.commandName) });
      return await handleCommand(interaction);
    }

    if (interaction.isButton() && interaction.customId.startsWith('report_close:')) {
      await interaction.deferReply({ ephemeral: true });
      return await handleReportCloseButton(interaction);
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('report_modal:')) {
      await interaction.deferReply({ ephemeral: true });
      if (!interaction.guild || interaction.guild.id !== REPORT_GUILD_ID) {
        return respond(interaction, { content: `Reports are only available in server ${REPORT_GUILD_ID}.` });
      }
      return await handleReportModal(interaction);
    }
  } catch (error) {
    return failInteraction(interaction, error);
  }
});

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag} (${client.user.id})`);

  try {
    await registerCommands();
  } catch (error) {
    console.error('GLOBAL COMMAND REGISTRATION FAILED:', error);
  }

  const initializeDatabase = async () => {
    try {
      await ensureSchema();
      await pollDuty();
      console.log('DATABASE / DUTY TRACKING ONLINE');
    } catch (error) {
      if (error instanceof DatabaseUnavailableError) {
        console.warn('DATABASE / DUTY TRACKING OFFLINE. Discord commands remain online.');
      } else {
        console.error('DATABASE STARTUP ERROR:', error);
      }
    }
  };

  await initializeDatabase();

  if (!globalThis.__dutyInterval) {
    globalThis.__dutyInterval = setInterval(async () => {
      await pollDuty();
      if (Date.now() >= dbUnavailableUntil) {
        await ensureSchema().catch(() => {});
        await flushDirtySettings().catch(() => {});
      }
    }, DUTY_POLL_MS);
  }
});

async function shutdown() {
  if (globalThis.__dutyInterval) clearInterval(globalThis.__dutyInterval);
  if (pool) await pool.end().catch(() => {});
}

process.on('SIGINT', async () => { await shutdown(); process.exit(0); });
process.on('SIGTERM', async () => { await shutdown(); process.exit(0); });

async function start() {
  if (!TOKEN || !CLIENT_ID) throw new Error('Missing DISCORD_TOKEN or CLIENT_ID.');
  await client.login(TOKEN);
}

if (require.main === module) {
  start().catch(error => {
    console.error('BOT STARTUP FAILED:', error);
    process.exitCode = 1;
  });
}

module.exports = {
  REPORT_GUILD_ID,
  DEPARTMENTS,
  LEO_VOICE_CHANNELS,
  buildCommandsJson,
  reportFieldsModal,
  buildReportEmbed,
  splitEvidence,
  assertDepartment,
  timeframeLabel,
  getWeekWindow,
  windowFor,
  formatDuration,
  formatSessionDuration,
  hoursText
};
