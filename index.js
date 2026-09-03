require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
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
  Routes,
  PermissionFlagsBits
} = require('discord.js');
const mysql = require('mysql2/promise');
const { DateTime } = require('luxon');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const TIMEZONE = process.env.TIMEZONE || 'Europe/London';
const DUTY_POLL_MS = Number(process.env.DUTY_POLL_MS || 5000);
const DEPARTMENTS = ['USM', 'SASP', 'BCSO', 'LSPD'];
const LEO_VOICE_CHANNELS = [
  '1542399560394088538',
  '1542399564588261446',
  '1542399567234994206'
];

if (!TOKEN || !CLIENT_ID || !GUILD_ID) throw new Error('Missing DISCORD_TOKEN, CLIENT_ID or GUILD_ID.');

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

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

const activeDuty = new Map();
const pendingVoice = new Map();

function now() { return Math.floor(Date.now() / 1000); }
function unixDate(ts) { return new Date(Number(ts) * 1000); }
function localDateTime(ts) { return DateTime.fromSeconds(Number(ts), { zone: TIMEZONE }); }
function formatDateTime(ts) { return localDateTime(ts).toFormat('cccc, dd LLLL yyyy HH:mm'); }
function formatShort(ts) { return localDateTime(ts).toFormat('dd/MM/yyyy HH:mm'); }
function formatDuration(seconds) {
  seconds = Math.max(0, Math.floor(seconds || 0));
  const d = Math.floor(seconds / 86400); seconds %= 86400;
  const h = Math.floor(seconds / 3600); seconds %= 3600;
  const m = Math.floor(seconds / 60); const s = seconds % 60;
  if (d) return `${d}d ${h}h ${m}m ${s}s`;
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}
function hoursText(seconds) { return `${(Math.max(0, seconds || 0) / 3600).toFixed(2)}h`; }
function cleanName(s) { return String(s || 'user').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'user'; }
function parseIds(s) { return String(s || '').split(',').map(x => x.trim()).filter(Boolean); }
function isLeoVoice(channelId) { return !!channelId && LEO_VOICE_CHANNELS.includes(channelId); }
function deptName(code) {
  return { USM: 'United States Marshals', SASP: 'San Andreas State Police', BCSO: "Blaine County Sheriff's Office", LSPD: 'Los Santos Police Department' }[code] || code;
}

async function q(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

async function getSetting(key, fallback = null) {
  const rows = await q('SELECT settingValue FROM bot_settings WHERE settingKey=? LIMIT 1', [key]);
  return rows[0] ? rows[0].settingValue : fallback;
}
async function setSetting(key, value) {
  await q('INSERT INTO bot_settings (settingKey, settingValue) VALUES (?, ?) ON DUPLICATE KEY UPDATE settingValue=VALUES(settingValue)', [key, value]);
}
async function getJsonSetting(key, fallback) {
  try { return JSON.parse(await getSetting(key, JSON.stringify(fallback))); } catch { return fallback; }
}
async function setJsonSetting(key, value) { return setSetting(key, JSON.stringify(value)); }

async function ensureSchema() {
  const sql = require('fs').readFileSync(require('path').join(__dirname, 'schema.sql'), 'utf8');
  const statements = sql.split(/;\s*(?:\n|$)/).map(s => s.trim()).filter(Boolean);
  for (const statement of statements) await pool.query(statement);
}

function adminCheck(member) {
  if (!member) return false;
  const envAdmins = parseIds(process.env.BOT_ADMINS);
  if (envAdmins.includes(member.id)) return true;
  return member.permissions.has(PermissionFlagsBits.Administrator);
}

async function roleAllowed(member, settingKey) {
  if (adminCheck(member)) return true;
  const roleIds = await getJsonSetting(settingKey, []);
  return roleIds.some(id => member.roles.cache.has(id));
}

async function commandAllowed(member, commandName) {
  if (adminCheck(member)) return true;
  const configured = await getJsonSetting(`cmdperm:${commandName}`, []);
  if (!configured.length) return true;
  return configured.some(id => member.roles.cache.has(id));
}

async function sendDM(user, embed) {
  try { await user.send({ embeds: [embed] }); } catch (err) { console.warn(`Unable to DM ${user.id}: ${err.message}`); }
}

function dutyEmbed({ member, department, inTime, color = 0x2f9e44 }) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(color === 0x2f9e44 ? 'On Duty' : 'Off Duty')
    .setDescription(`Thanks for your service, ${member.displayName || member.user?.username || member.username}!`)
    .addFields(
      { name: color === 0x2f9e44 ? 'Clock In' : 'Clock Out', value: formatDateTime(inTime), inline: true },
      { name: 'Department', value: deptName(department), inline: true }
    )
    .setFooter({ text: `PSRP Department Utilities • ${formatShort(now())}` });
}

function offDutyEmbed({ member, department, outTime, inTime, session, weekly, inVoice, outVoice, coverage, reason }) {
  const embed = new EmbedBuilder()
    .setColor(0xe04f5f)
    .setTitle('Off Duty')
    .setDescription(`Thanks for your service, ${member.displayName || member.user?.username || member.username}!`)
    .addFields(
      { name: 'Reason', value: reason || 'Clock Out', inline: false },
      { name: 'Clock Out', value: formatDateTime(outTime), inline: true },
      { name: 'Session', value: formatDuration(session), inline: true },
      { name: 'This Week (Fri-Thu)', value: hoursText(weekly.total), inline: true },
      { name: 'Week', value: `${weekly.startLabel} - ${weekly.endLabel}`, inline: true },
      { name: 'Department', value: deptName(department), inline: true },
      { name: 'In Voice', value: formatDuration(inVoice), inline: true },
      { name: 'Out of Voice', value: formatDuration(outVoice), inline: true },
      { name: 'Voice Coverage', value: `${coverage.toFixed(0)}%`, inline: true }
    )
    .setFooter({ text: `PSRP Department Utilities • ${formatShort(outTime)}` });
  if (inTime) embed.addFields({ name: 'Clock In', value: formatDateTime(inTime), inline: false });
  return embed;
}

function getWeekWindow(ts = now()) {
  const current = localDateTime(ts);
  const start = current.minus({ days: (current.weekday + 2) % 7 }).startOf('day');
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
  const w = getWeekWindow(ts);
  if (type === 'this_week') return w;
  if (type === 'last_week') {
    const start = localDateTime(w.start).minus({ days: 7 });
    const end = localDateTime(w.start);
    return { start: Math.floor(start.toSeconds()), end: Math.floor(end.toSeconds()), startLabel: start.toFormat('LLL dd'), endLabel: end.minus({seconds:1}).toFormat('LLL dd') };
  }
  if (type === 'this_month') {
    const start = current.startOf('month');
    const end = start.plus({ months: 1 });
    return { start: Math.floor(start.toSeconds()), end: Math.floor(end.toSeconds()), startLabel: start.toFormat('LLL dd'), endLabel: end.minus({seconds:1}).toFormat('LLL dd') };
  }
  if (type === 'last_month') {
    const end = current.startOf('month');
    const start = end.minus({ months: 1 });
    return { start: Math.floor(start.toSeconds()), end: Math.floor(end.toSeconds()), startLabel: start.toFormat('LLL dd'), endLabel: end.minus({seconds:1}).toFormat('LLL dd') };
  }
  return { start: 0, end: now() + 1, startLabel: 'All Time', endLabel: '' };
}

async function totalDutySeconds({ discordId, department, window }) {
  let sql = `SELECT inTime, COALESCE(outTime, UNIX_TIMESTAMP()) outTime FROM duty_hours WHERE inTime IS NOT NULL`;
  const params = [];
  if (discordId) { sql += ' AND discordId=?'; params.push(discordId); }
  if (department) { sql += ' AND department=?'; params.push(department); }
  if (window) { sql += ' AND inTime < ? AND COALESCE(outTime, UNIX_TIMESTAMP()) > ?'; params.push(window.end, window.start); }
  const rows = await q(sql, params);
  let total = 0;
  for (const r of rows) total += Math.max(0, Math.min(r.outTime, window?.end || r.outTime) - Math.max(r.inTime, window?.start || r.inTime));
  return Math.floor(total);
}

async function voiceSecondsForDuty(dutyId, inTime, outTime) {
  const end = outTime || now();
  const rows = await q(`SELECT inTime, COALESCE(outTime, ?) outTime, isLeoVoice FROM duty_voice_segments WHERE dutyId=? AND inTime < ? AND COALESCE(outTime, ?) > ?`, [end, dutyId, end, end, inTime]);
  let voice = 0;
  for (const r of rows) if (Number(r.isLeoVoice)) voice += Math.max(0, Math.min(r.outTime, end) - Math.max(r.inTime, inTime));
  const session = Math.max(0, end - inTime);
  return { voice, outVoice: Math.max(0, session - voice), session, coverage: session ? (voice / session) * 100 : 0 };
}

async function updateVoiceSegmentForUser(discordId, channelId, ts = now()) {
  const duty = activeDuty.get(discordId);
  if (!duty) return;
  const leo = isLeoVoice(channelId);
  const state = pendingVoice.get(discordId);
  if (state && state.channelId === channelId) return;
  if (state) {
    await q('UPDATE duty_voice_segments SET outTime=? WHERE id=? AND outTime IS NULL', [ts, state.segmentId]);
  }
  const result = await q('INSERT INTO duty_voice_segments (dutyId, discordId, channelId, inTime, outTime, isLeoVoice) VALUES (?, ?, ?, ?, NULL, ?)', [duty.id, discordId, channelId || null, ts, leo ? 1 : 0]);
  pendingVoice.set(discordId, { segmentId: result.insertId, channelId: channelId || null });
}

async function closeVoiceForUser(discordId, ts = now()) {
  const state = pendingVoice.get(discordId);
  if (state) {
    await q('UPDATE duty_voice_segments SET outTime=? WHERE id=? AND outTime IS NULL', [ts, state.segmentId]);
    pendingVoice.delete(discordId);
  }
}

async function startDutyTracking(row) {
  if (activeDuty.has(row.discordId)) return;
  const duty = { id: row.id, discordId: row.discordId, inTime: row.inTime, department: row.department };
  activeDuty.set(row.discordId, duty);
  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  const member = guild ? await guild.members.fetch(row.discordId).catch(() => null) : null;
  if (member) {
    await updateVoiceSegmentForUser(row.discordId, member.voice.channelId, row.inTime).catch(console.error);
    await sendDM(member.user, dutyEmbed({ member, department: row.department, inTime: row.inTime }));
  }
}

async function finishDutyTracking(row) {
  const duty = activeDuty.get(row.discordId);
  const inTime = duty?.inTime || row.inTime;
  const dutyId = duty?.id || row.id;
  await closeVoiceForUser(row.discordId, row.outTime || now()).catch(() => {});
  const stats = await voiceSecondsForDuty(dutyId, inTime, row.outTime || now());
  const weeklyWindow = getWeekWindow(row.outTime || now());
  const weekly = await getPersonDepartmentWeek(row.discordId, row.department, weeklyWindow);
  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  const member = guild ? await guild.members.fetch(row.discordId).catch(() => null) : null;
  if (member) await sendDM(member.user, offDutyEmbed({ member, department: row.department, outTime: row.outTime, inTime, session: stats.session, weekly, inVoice: stats.voice, outVoice: stats.outVoice, coverage: stats.coverage, reason: 'Clock Out' }));
  activeDuty.delete(row.discordId);
}

async function getPersonDepartmentWeek(discordId, department, window) {
  const total = await totalDutySeconds({ discordId, department, window });
  return { total, startLabel: formatShort(window.start).split(',')[0], endLabel: formatShort(window.end - 1).split(',')[0] };
}

async function pollDuty() {
  try {
    const active = await q(`SELECT * FROM duty_hours WHERE outTime IS NULL AND discordId IS NOT NULL ORDER BY id DESC`);
    const seen = new Set();
    for (const row of active) { seen.add(row.discordId); await startDutyTracking(row); }
    const done = await q(`SELECT * FROM duty_hours WHERE outTime IS NOT NULL AND outTime >= ? ORDER BY outTime ASC`, [now() - 20]);
    for (const row of done) if (activeDuty.has(row.discordId) && activeDuty.get(row.discordId).id === row.id) await finishDutyTracking(row);
    for (const [id] of activeDuty) if (!seen.has(id)) activeDuty.delete(id);
  } catch (err) { console.error('Duty poll error:', err); }
}

client.on('voiceStateUpdate', async (oldState, newState) => {
  if (!activeDuty.has(newState.id) && !activeDuty.has(oldState.id)) return;
  const id = newState.id;
  try { await updateVoiceSegmentForUser(id, newState.channelId); } catch (err) { console.error('Voice tracking error:', err); }
});

function baseCommand(name, description) { return new SlashCommandBuilder().setName(name).setDescription(description); }

const commands = [
  baseCommand('officer-report-panel', 'Post the officer report panel'),
  baseCommand('anonreport', 'Create or rebuild an anonymous department report'),
  baseCommand('addofficer', 'Reports team: set the person being reported'),
  baseCommand('reportadd', 'Staff: register an incoming department report'),
  baseCommand('report-config', 'Admin: configure report categories and department report roles'),
  baseCommand('report-staff', 'Admin: manage report handling roles'),
  baseCommand('ridealong-permissions', 'Admin: manage roles allowed to use ridealong'),
  baseCommand('command-permissions', 'Admin: configure command permissions'),
  baseCommand('ridealong', 'Log a ride-along result'),
  baseCommand('rename', 'Rename a ticket to user-handling'),
  baseCommand('close', 'Close a ticket and remove the opener access'),
  baseCommand('delete', 'Delete a ticket and save a transcript'),
  baseCommand('hours', 'Check duty hours for a person or yourself'),
  baseCommand('allhours', 'Get hours of everyone in a department'),
  baseCommand('totalhours', 'Get total hours for a department'),
  baseCommand('weeklydeptours', 'Get total department hours for the last 7 days'),
  baseCommand('deptofhours', 'Get the top players in a department by hours'),
  baseCommand('tophours', 'Get the top 5 players with the most all-time hours'),
  baseCommand('leaderboard', 'Post a monthly department or gang leaderboard'),
  baseCommand('evaluate', 'Evaluate a member against the department weekly requirement'),
  baseCommand('inactive_officers', 'Report inactive department officers'),
  baseCommand('promotions', 'List promotion-eligible officers'),
  baseCommand('leomulti', 'Start a 1.5x LEO hour multiplier'),
  baseCommand('add_org', 'Admin: add a gang/org across configs'),
  baseCommand('add_org_hours', 'Admin: add hours to a department or org total'),
  baseCommand('rename_org', 'Admin: rename an organisation'),
  baseCommand('dept_officers', 'Get department officers by activity status')
].map(x => x.setDMPermission(false));

commands.find(c=>c.name==='hours').addStringOption(o=>o.setName('department').setDescription('Department').setRequired(false).addChoices(...DEPARTMENTS.map(x=>({name:x,value:x}))));
commands.find(c=>c.name==='hours').addStringOption(o=>o.setName('timeframe').setDescription('Time frame').setRequired(false).addChoices(
  {name:'Last Week',value:'last_week'},{name:'This Week',value:'this_week'},{name:'This Month',value:'this_month'},{name:'Last Month',value:'last_month'},{name:'All Time',value:'all_time'}
));
commands.find(c=>c.name==='hours').addUserOption(o=>o.setName('user').setDescription('Exact person to check').setRequired(false));
for (const name of ['allhours','totalhours','weeklydeptours','deptofhours','leaderboard','promotions','evaluate','inactive_officers','dept_officers','leomulti','add_org_hours']) {
  const c = commands.find(x=>x.name===name);
  if (['allhours','totalhours','weeklydeptours','deptofhours','leaderboard','promotions','evaluate','inactive_officers','dept_officers'].includes(name)) c.addStringOption(o=>o.setName('department').setDescription('Department').setRequired(true).addChoices(...DEPARTMENTS.map(x=>({name:x,value:x}))));
}
commands.find(c=>c.name==='deptofhours').addStringOption(o=>o.setName('timeframe').setDescription('Time frame').setRequired(false).addChoices({name:'This Week',value:'this_week'},{name:'This Month',value:'this_month'},{name:'All Time',value:'all_time'}));
commands.find(c=>c.name==='allhours').addStringOption(o=>o.setName('timeframe').setDescription('Time frame').setRequired(false).addChoices({name:'Last Week',value:'last_week'},{name:'This Week',value:'this_week'},{name:'This Month',value:'this_month'},{name:'Last Month',value:'last_month'},{name:'All Time',value:'all_time'}));
commands.find(c=>c.name==='leaderboard').addStringOption(o=>o.setName('timeframe').setDescription('Time frame').setRequired(false).addChoices({name:'This Month',value:'this_month'},{name:'Last Month',value:'last_month'}));
commands.find(c=>c.name==='promotions').addIntegerOption(o=>o.setName('min_hours').setDescription('Minimum hours').setRequired(false).setMinValue(0));
commands.find(c=>c.name==='evaluate').addUserOption(o=>o.setName('user').setDescription('Person to evaluate').setRequired(false));
commands.find(c=>c.name==='inactive_officers').addIntegerOption(o=>o.setName('weeks_back').setDescription('Inactivity threshold in weeks').setRequired(false).addChoices({name:'2 weeks',value:2},{name:'4 weeks',value:4}));
commands.find(c=>c.name==='dept_officers').addIntegerOption(o=>o.setName('weeks_back').setDescription('Inactivity threshold in weeks').setRequired(false).addChoices({name:'2 weeks',value:2},{name:'4 weeks',value:4}));
commands.find(c=>c.name==='leomulti').addIntegerOption(o=>o.setName('duration_minutes').setDescription('Multiplier duration in minutes').setRequired(true).setMinValue(1).setMaxValue(10080));
commands.find(c=>c.name==='leomulti').addNumberOption(o=>o.setName('multiplier').setDescription('Multiplier').setRequired(false).setMinValue(1).setMaxValue(5));
commands.find(c=>c.name==='add_org').addStringOption(o=>o.setName('code').setDescription('Org code').setRequired(true)).addStringOption(o=>o.setName('name').setDescription('Org name').setRequired(true));
commands.find(c=>c.name==='add_org_hours').addStringOption(o=>o.setName('code').setDescription('Department/org code').setRequired(true)).addNumberOption(o=>o.setName('hours').setDescription('Hours to add').setRequired(true)).addStringOption(o=>o.setName('reason').setDescription('Reason').setRequired(false));
commands.find(c=>c.name==='rename_org').addStringOption(o=>o.setName('old_code').setDescription('Current code').setRequired(true)).addStringOption(o=>o.setName('new_code').setDescription('New code').setRequired(true)).addStringOption(o=>o.setName('name').setDescription('New name').setRequired(true));
commands.find(c=>c.name==='command-permissions').addStringOption(o=>o.setName('action').setDescription('add/remove/clear/view').setRequired(true).addChoices({name:'Add',value:'add'},{name:'Remove',value:'remove'},{name:'Clear',value:'clear'},{name:'View',value:'view'})).addStringOption(o=>o.setName('command').setDescription('Command name').setRequired(true)).addRoleOption(o=>o.setName('role').setDescription('Role').setRequired(false));
commands.find(c=>c.name==='ridealong-permissions').addStringOption(o=>o.setName('action').setDescription('add/remove/clear/view').setRequired(true).addChoices({name:'Add',value:'add'},{name:'Remove',value:'remove'},{name:'Clear',value:'clear'},{name:'View',value:'view'})).addRoleOption(o=>o.setName('role').setDescription('Role').setRequired(false));
commands.find(c=>c.name==='report-staff').addStringOption(o=>o.setName('action').setDescription('add/remove/clear/view').setRequired(true).addChoices({name:'Add',value:'add'},{name:'Remove',value:'remove'},{name:'Clear',value:'clear'},{name:'View',value:'view'})).addRoleOption(o=>o.setName('role').setDescription('Role').setRequired(false));
commands.find(c=>c.name==='report-config').addStringOption(o=>o.setName('department').setDescription('Department').setRequired(false).addChoices(...DEPARTMENTS.map(x=>({name:x,value:x})))).addRoleOption(o=>o.setName('role').setDescription('Role pinged for that department').setRequired(false)).addChannelOption(o=>o.setName('category').setDescription('Report ticket category').setRequired(false).addChannelTypes(ChannelType.GuildCategory)).addChannelOption(o=>o.setName('log_channel').setDescription('Report log channel').setRequired(false).addChannelTypes(ChannelType.GuildText));
commands.find(c=>c.name==='ridealong').addUserOption(o=>o.setName('player').setDescription('Player receiving the ride-along').setRequired(true)).addStringOption(o=>o.setName('department').setDescription('Department').setRequired(true).addChoices(...DEPARTMENTS.map(x=>({name:x,value:x})))).addRoleOption(o=>o.setName('ridealong_role').setDescription('Ride-along role').setRequired(false)).addStringOption(o=>o.setName('result').setDescription('Result').setRequired(true).addChoices({name:'Passed',value:'Passed'},{name:'Failed',value:'Failed'})).addStringOption(o=>o.setName('notes').setDescription('Optional notes').setRequired(false));
commands.find(c=>c.name==='addofficer').addUserOption(o=>o.setName('user').setDescription('Reported Discord user').setRequired(false)).addStringOption(o=>o.setName('user_id').setDescription('Reported Discord user ID').setRequired(false));
commands.find(c=>c.name==='reportadd').addStringOption(o=>o.setName('department').setDescription('Department').setRequired(true).addChoices(...DEPARTMENTS.map(x=>({name:x,value:x})))).addUserOption(o=>o.setName('officer').setDescription('Officer being reported').setRequired(false)).addStringOption(o=>o.setName('date').setDescription('Date of incident').setRequired(false)).addStringOption(o=>o.setName('game_id').setDescription('In-game ID').setRequired(false)).addStringOption(o=>o.setName('clip').setDescription('Clip URL').setRequired(false)).addStringOption(o=>o.setName('description').setDescription('Description').setRequired(false)).addStringOption(o=>o.setName('context').setDescription('Additional context').setRequired(false));
commands.find(c=>c.name==='anonreport').addStringOption(o=>o.setName('department').setDescription('Department').setRequired(true).addChoices(...DEPARTMENTS.map(x=>({name:x,value:x})))).addStringOption(o=>o.setName('date').setDescription('Date of incident').setRequired(false)).addStringOption(o=>o.setName('game_id').setDescription('In-game ID').setRequired(false)).addStringOption(o=>o.setName('clip').setDescription('Clip URL').setRequired(false)).addStringOption(o=>o.setName('description').setDescription('Description').setRequired(false)).addStringOption(o=>o.setName('context').setDescription('Additional context').setRequired(false));

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands.map(c=>c.toJSON()) });
  console.log(`Registered ${commands.length} commands.`);
}

function reportPanelEmbed() {
  return new EmbedBuilder().setColor(0xb94a48).setTitle('Submit a Report').setDescription('Use the dropdown below to submit a report against a department member.\n\nYour ticket will be created in a private channel visible only to you and the review team.\n\nFalse or malicious reports may result in disciplinary action.').addFields(
    {name:'Officer Report',value:'Report misconduct or rule violations by a department officer.',inline:true},
    {name:'Higher Up Report',value:'Report misconduct by command staff or senior leadership.',inline:true}
  ).setFooter({text:'Paradise State Roleplay • You can request to make your report anonymous by asking in your ticket'});
}

function reportPanelRow() {
  return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('report_type').setPlaceholder('Select a ticket type...').addOptions(
    new StringSelectMenuOptionBuilder().setLabel('Officer Report').setDescription('Report an officer').setValue('officer'),
    new StringSelectMenuOptionBuilder().setLabel('Higher Up Report').setDescription('Report a higher-up').setValue('higher')
  ));
}

function reportFieldsModal(type, anonymous = false) {
  return new ModalBuilder().setCustomId(`report_modal:${type}:${anonymous ? 'anon' : 'named'}`).setTitle(anonymous ? 'Anonymous Report' : 'Officer Report').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('department').setLabel('Department').setStyle(TextInputStyle.Short).setPlaceholder('USM / SASP / BCSO / LSPD').setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('date').setLabel('Date of incident').setStyle(TextInputStyle.Short).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('game_id').setLabel('In-game ID').setStyle(TextInputStyle.Short).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('clip').setLabel('Clip URL').setStyle(TextInputStyle.Paragraph).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('details').setLabel('Description and context').setStyle(TextInputStyle.Paragraph).setRequired(false))
  );
}

async function createReportTicket({ interaction, type, department, anonymous, dateOfIncident, gameId, clip, description, context, reportedUserId = null }) {
  const guild = interaction.guild;
  const settingsRoles = await getJsonSetting(`reportRoles:${department}`, []);
  const staffRoles = await getJsonSetting('reportStaffRoles', parseIds(process.env.DEFAULT_REPORT_STAFF_ROLES));
  const categoryId = await getSetting('reportCategoryId', process.env.REPORT_CATEGORY_ID || null);
  const permissionOverwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }
  ];
  if (!anonymous) permissionOverwrites.push({ id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
  for (const roleId of [...new Set([...settingsRoles, ...staffRoles])]) permissionOverwrites.push({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
  const channel = await guild.channels.create({
    name: anonymous ? `anon-${department.toLowerCase()}` : `report-${department.toLowerCase()}-${cleanName(interaction.member.displayName || interaction.user.username)}`,
    type: ChannelType.GuildText,
    parent: categoryId || undefined,
    permissionOverwrites
  });
  await q(`INSERT INTO reports (channelId,ticketType,department,reporterId,reportedUserId,dateOfIncident,gameId,clip,description,context,anonymous,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
    channel.id, type, department, anonymous ? null : interaction.user.id, reportedUserId, dateOfIncident || null, gameId || null, clip || null, description || null, context || null, anonymous ? 1 : 0, now()
  ]);
  const roleMentions = settingsRoles.length ? settingsRoles.map(x=>`<@&${x}>`).join(' ') : '';
  const embed = new EmbedBuilder().setColor(type === 'higher' ? 0x6d5dfc : 0x2f80ed).setTitle(anonymous ? 'Anonymous Report' : 'Officer Report').addFields(
    { name:'Department', value:`${department} — ${deptName(department)}` },
    { name:'Date of incident', value:dateOfIncident || 'Not provided', inline:true },
    { name:'In-Game ID', value:gameId || 'Not provided', inline:true },
    { name:'Officer being reported', value:reportedUserId ? `<@${reportedUserId}> (${reportedUserId})` : 'Not provided', inline:false },
    { name:'Clip', value:clip || 'Not provided', inline:false },
    { name:'Description', value:description || 'Not provided', inline:false },
    { name:'Additional context', value:context || 'Not provided', inline:false }
  ).setFooter({text:`Submitted ${formatShort(now())}`});
  const buttons = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`report_close:${channel.id}`).setLabel('Close').setStyle(ButtonStyle.Danger));
  await channel.send({ content: roleMentions || undefined, embeds:[embed], components:[buttons] });
  await interaction.reply({ content:`Report created: ${channel}`, ephemeral:true });
  return channel;
}

async function clearChannel(channel) {
  let rounds = 0;
  while (rounds < 20) {
    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!messages || !messages.size) break;
    rounds++;
    for (const m of messages.values()) await m.delete().catch(() => {});
    if (messages.size < 100) break;
  }
}

async function makeTranscript(channel) {
  const messages = await channel.messages.fetch({ limit: 100 });
  const sorted = [...messages.values()].sort((a,b)=>a.createdTimestamp-b.createdTimestamp);
  return sorted.map(m=>`[${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}: ${m.content || '[embed/attachment]'}`).join('\n');
}

async function ensureReportPermissions(member) {
  return roleAllowed(member, 'reportStaffRoles');
}

async function handleHours(interaction) {
  const user = interaction.options.getUser('user') || interaction.user;
  const department = interaction.options.getString('department');
  const timeframe = interaction.options.getString('timeframe') || 'this_week';
  if (!department) {
    await interaction.reply({ content:'Select a department.', ephemeral:true }); return;
  }
  const window = windowFor(timeframe);
  const seconds = await totalDutySeconds({discordId:user.id, department, window});
  const embed = new EmbedBuilder().setColor(0x3b82f6).setTitle('Duty Hours').addFields(
    {name:'Member',value:`<@${user.id}>`,inline:true},
    {name:'Department',value:`${department} — ${deptName(department)}`,inline:true},
    {name:'Time frame',value:timeframe.replace('_',' '),inline:true},
    {name:'Hours',value:hoursText(seconds),inline:false}
  );
  await interaction.reply({ embeds:[embed] });
}

async function handleDepartmentHours(interaction, mode) {
  const department = interaction.options.getString('department');
  const timeframe = interaction.options.getString('timeframe') || (mode==='leaderboard'?'this_month':'this_week');
  const window = windowFor(timeframe);
  const rows = await q(`SELECT discordId, SUM(GREATEST(0, LEAST(COALESCE(outTime, UNIX_TIMESTAMP()), ?) - GREATEST(inTime, ?))) seconds FROM duty_hours WHERE department=? AND inTime IS NOT NULL AND inTime < ? AND COALESCE(outTime, UNIX_TIMESTAMP()) > ? AND discordId IS NOT NULL GROUP BY discordId ORDER BY seconds DESC`, [window.end, window.start, department, window.end, window.start]);
  if (mode==='total') {
    const total = rows.reduce((a,r)=>a+Number(r.seconds||0),0);
    await interaction.reply({embeds:[new EmbedBuilder().setColor(0x3b82f6).setTitle('Department Hours').addFields({name:'Department',value:`${department} — ${deptName(department)}`},{name:'Total',value:hoursText(total)}).setFooter({text:`${timeframe.replace('_',' ')}`})]}); return;
  }
  const shown = rows.slice(0, 25);
  const description = shown.length ? shown.map((r,i)=>`${i+1}. <@${r.discordId}> — ${hoursText(Number(r.seconds))}`).join('\n') : 'No recorded hours.';
  await interaction.reply({embeds:[new EmbedBuilder().setColor(0x3b82f6).setTitle(mode==='leaderboard'?'Department Leaderboard':'Department Hours').setDescription(description).setFooter({text:`${department} • ${timeframe.replace('_',' ')}`})]});
}

async function commandInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;
  const name = interaction.commandName;
  if (!await commandAllowed(interaction.member, name)) return interaction.reply({content:'You do not have permission to use this command.',ephemeral:true});

  if (name==='officer-report-panel') {
    if (!adminCheck(interaction.member)) return interaction.reply({content:'Administrator permission required.',ephemeral:true});
    await interaction.channel.send({embeds:[reportPanelEmbed()],components:[reportPanelRow()]});
    return interaction.reply({content:'Report panel posted.',ephemeral:true});
  }
  if (name==='report-config') {
    if (!adminCheck(interaction.member)) return interaction.reply({content:'Administrator permission required.',ephemeral:true});
    const dept = interaction.options.getString('department'); const role = interaction.options.getRole('role'); const category = interaction.options.getChannel('category'); const log = interaction.options.getChannel('log_channel');
    if (dept && role) await setJsonSetting(`reportRoles:${dept}`, [role.id]);
    if (category) await setSetting('reportCategoryId', category.id);
    if (log) await setSetting('reportLogChannelId', log.id);
    const values = [];
    for (const d of DEPARTMENTS) values.push(`${d}: ${((await getJsonSetting(`reportRoles:${d}`,[])).map(x=>`<@&${x}>`).join(', ') || 'Not configured')}`);
    values.push(`Category: ${(await getSetting('reportCategoryId', 'Not configured'))}`);
    values.push(`Log channel: ${(await getSetting('reportLogChannelId', 'Not configured'))}`);
    return interaction.reply({content:values.join('\n'),ephemeral:true});
  }
  if (name==='report-staff') {
    if (!adminCheck(interaction.member)) return interaction.reply({content:'Administrator permission required.',ephemeral:true});
    const action=interaction.options.getString('action'); const role=interaction.options.getRole('role'); let roles=await getJsonSetting('reportStaffRoles',parseIds(process.env.DEFAULT_REPORT_STAFF_ROLES));
    if (action==='add' && role) roles=[...new Set([...roles,role.id])];
    if (action==='remove' && role) roles=roles.filter(x=>x!==role.id);
    if (action==='clear') roles=[];
    await setJsonSetting('reportStaffRoles',roles);
    return interaction.reply({content:`Report staff roles: ${roles.length?roles.map(x=>`<@&${x}>`).join(', '):'None'}`,ephemeral:true});
  }
  if (name==='ridealong-permissions') {
    if (!adminCheck(interaction.member)) return interaction.reply({content:'Administrator permission required.',ephemeral:true});
    const action=interaction.options.getString('action'); const role=interaction.options.getRole('role'); let roles=await getJsonSetting('ridealongRoles',parseIds(process.env.DEFAULT_RIDEALONG_ROLES));
    if (action==='add' && role) roles=[...new Set([...roles,role.id])];
    if (action==='remove' && role) roles=roles.filter(x=>x!==role.id);
    if (action==='clear') roles=[];
    await setJsonSetting('ridealongRoles',roles);
    return interaction.reply({content:`Ride-along roles: ${roles.length?roles.map(x=>`<@&${x}>`).join(', '):'None'}`,ephemeral:true});
  }
  if (name==='command-permissions') {
    if (!adminCheck(interaction.member)) return interaction.reply({content:'Administrator permission required.',ephemeral:true});
    const action=interaction.options.getString('action'); const command=interaction.options.getString('command'); const role=interaction.options.getRole('role'); let roles=await getJsonSetting(`cmdperm:${command}`,[]);
    if (action==='add' && role) roles=[...new Set([...roles,role.id])];
    if (action==='remove' && role) roles=roles.filter(x=>x!==role.id);
    if (action==='clear') roles=[];
    await setJsonSetting(`cmdperm:${command}`,roles);
    const roleText = roles.length ? roles.map(x => `<@&${x}>`).join(', ') : "No custom roles (everyone can use it, subject to command's own permission)."; return interaction.reply({content:`${command}: ${roleText}`,ephemeral:true});
  }
  if (name==='addofficer') {
    if (!await ensureReportPermissions(interaction.member)) return interaction.reply({content:'Reports team permission required.',ephemeral:true});
    const user = interaction.options.getUser('user'); const uid = interaction.options.getString('user_id'); const targetId = user?.id || uid;
    if (!targetId) return interaction.reply({content:'Provide either a Discord user or a Discord user ID.',ephemeral:true});
    const rows=await q('SELECT * FROM reports WHERE channelId=? LIMIT 1',[interaction.channel.id]); if (!rows[0]) return interaction.reply({content:'This is not a report ticket.',ephemeral:true});
    await q('UPDATE reports SET reportedUserId=? WHERE channelId=?',[targetId,interaction.channel.id]);
    const msgs=await interaction.channel.messages.fetch({limit:20}); const reportMsg=[...msgs.values()].find(m=>m.embeds[0]?.title?.includes('Report'));
    if (reportMsg) {
      const old=EmbedBuilder.from(reportMsg.embeds[0]);
      const existing=old.data.fields||[]; const filtered=existing.filter(f=>f.name!=='Officer being reported'); filtered.splice(3,0,{name:'Officer being reported',value:`<@${targetId}> (${targetId})`,inline:false});
      old.setFields(filtered); await reportMsg.edit({embeds:[old]});
    }
    return interaction.reply({content:`Officer being reported set to <@${targetId}>.`,ephemeral:false});
  }
  if (name==='anonreport') {
    if (!interaction.channel) return;
    const dept=interaction.options.getString('department'); const date=interaction.options.getString('date'); const gameId=interaction.options.getString('game_id'); const clip=interaction.options.getString('clip'); const desc=interaction.options.getString('description'); const ctx=interaction.options.getString('context');
    const rows=await q('SELECT * FROM reports WHERE channelId=? LIMIT 1',[interaction.channel.id]);
    if (rows[0]) {
      await interaction.deferReply({ephemeral:true});
      await q('UPDATE reports SET department=?,dateOfIncident=?,gameId=?,clip=?,description=?,context=?,anonymous=1 WHERE channelId=?',[dept,date,gameId,clip,desc,ctx,interaction.channel.id]);
      await clearChannel(interaction.channel);
      const roles=await getJsonSetting(`reportRoles:${dept}`,[]); const embed=new EmbedBuilder().setColor(0xb94a48).setTitle('Anonymous Report').addFields({name:'Department',value:`${dept} — ${deptName(dept)}`},{name:'Date of incident',value:date||'Not provided',inline:true},{name:'In-Game ID',value:gameId||'Not provided',inline:true},{name:'Officer being reported',value:'Not provided'},{name:'Clip',value:clip||'Not provided'},{name:'Description',value:desc||'Not provided'},{name:'Additional context',value:ctx||'Not provided'}).setFooter({text:`Submitted ${formatShort(now())}`});
      await interaction.channel.send({content:roles.length?roles.map(x=>`<@&${x}>`).join(' '):undefined,embeds:[embed],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`report_close:${interaction.channel.id}`).setLabel('Close').setStyle(ButtonStyle.Danger))]});
      return interaction.editReply({content:'Anonymous report rebuilt.'});
    }
    return createReportTicket({interaction,type:'officer',department:dept,anonymous:true,dateOfIncident:date,gameId,clip,description:desc,context:ctx});
  }
  if (name==='reportadd') {
    if (!await ensureReportPermissions(interaction.member)) return interaction.reply({content:'Reports team permission required.',ephemeral:true});
    return createReportTicket({interaction,type:'officer',department:interaction.options.getString('department'),anonymous:false,reportedUserId:interaction.options.getUser('officer')?.id||null,dateOfIncident:interaction.options.getString('date'),gameId:interaction.options.getString('game_id'),clip:interaction.options.getString('clip'),description:interaction.options.getString('description'),context:interaction.options.getString('context')});
  }
  if (name==='rename') {
    const rows=await q('SELECT reporterId FROM reports WHERE channelId=? LIMIT 1',[interaction.channel.id]); const owner=rows[0]?.reporterId || interaction.user.id; const member=await interaction.guild.members.fetch(owner).catch(()=>null); const base=cleanName(member?.displayName || member?.user?.username || interaction.user.username); await interaction.channel.setName(`${base}-handling`); return interaction.reply({content:`Channel renamed to ${base}-handling.`});
  }
  if (name==='close') {
    const rows=await q('SELECT reporterId FROM reports WHERE channelId=? LIMIT 1',[interaction.channel.id]); const owner=rows[0]?.reporterId; if (!owner) return interaction.reply({content:'This is not a report ticket.',ephemeral:true});
    await interaction.channel.permissionOverwrites.edit(owner,{ViewChannel:false,SendMessages:false}).catch(()=>{});
    await q('UPDATE reports SET closedAt=? WHERE channelId=?',[now(),interaction.channel.id]);
    return interaction.reply({content:'Ticket closed.'});
  }
  if (name==='delete') {
    if (!adminCheck(interaction.member) && !await ensureReportPermissions(interaction.member)) return interaction.reply({content:'Reports team permission required.',ephemeral:true});
    const txt=await makeTranscript(interaction.channel); const logId=await getSetting('transcriptChannelId',process.env.TRANSCRIPT_CHANNEL_ID||await getSetting('reportLogChannelId',process.env.REPORT_LOG_CHANNEL_ID||null)); const log=logId?interaction.guild.channels.cache.get(logId):null; if(log) await log.send({content:`Transcript for #${interaction.channel.name}`,files:[{attachment:Buffer.from(txt||'No messages.'),'name':`${interaction.channel.name}-transcript.txt`}]}).catch(()=>{}); await interaction.reply({content:'Saving transcript and deleting ticket...'}); setTimeout(()=>interaction.channel.delete().catch(()=>{}),1000); return;
  }
  if (name==='ridealong') {
    if (!await roleAllowed(interaction.member,'ridealongRoles')) return interaction.reply({content:'You do not have permission to log ride-alongs.',ephemeral:true});
    const player=interaction.options.getUser('player'); const department=interaction.options.getString('department'); const role=interaction.options.getRole('ridealong_role'); const result=interaction.options.getString('result'); const notes=interaction.options.getString('notes');
    await q('INSERT INTO ridealongs (discordId,department,ridealongRoleId,result,notes,createdBy,createdAt) VALUES (?,?,?,?,?,?,?)',[player.id,department,role?.id||null,result,notes||null,interaction.user.id,now()]);
    return interaction.reply({embeds:[new EmbedBuilder().setColor(result==='Passed'?0x2f9e44:0xe04f5f).setTitle('Ride-Along').addFields({name:'Player',value:`<@${player.id}>`},{name:'Department',value:department},{name:'Result',value:result},{name:'Ride-Along Role',value:role?`<@&${role.id}>`:'Not provided'},{name:'Notes',value:notes||'None'})]});
  }
  if (name==='hours') return handleHours(interaction);
  if (['allhours','totalhours','weeklydeptours','leaderboard'].includes(name)) return handleDepartmentHours(interaction,name==='totalhours'?'total':name);
  if (name==='deptofhours') {
    const dept=interaction.options.getString('department'); const timeframe=interaction.options.getString('timeframe')||'this_week'; const window=windowFor(timeframe); const rows=await q(`SELECT discordId, SUM(GREATEST(0, LEAST(COALESCE(outTime, UNIX_TIMESTAMP()), ?) - GREATEST(inTime, ?))) seconds FROM duty_hours WHERE department=? AND inTime < ? AND COALESCE(outTime, UNIX_TIMESTAMP()) > ? AND discordId IS NOT NULL GROUP BY discordId ORDER BY seconds DESC LIMIT 10`,[window.end,window.start,dept,window.end,window.start]); return interaction.reply({embeds:[new EmbedBuilder().setColor(0x3b82f6).setTitle(`Top ${dept} Officers`).setDescription(rows.length?rows.map((r,i)=>`${i+1}. <@${r.discordId}> — ${hoursText(Number(r.seconds))}`).join('\n'):'No recorded hours.')]});
  }
  if (name==='tophours') {
    const rows=await q(`SELECT discordId, SUM(GREATEST(0, COALESCE(outTime, UNIX_TIMESTAMP()) - inTime)) seconds FROM duty_hours WHERE discordId IS NOT NULL GROUP BY discordId ORDER BY seconds DESC LIMIT 5`); return interaction.reply({embeds:[new EmbedBuilder().setColor(0x3b82f6).setTitle('Top Hours').setDescription(rows.length?rows.map((r,i)=>`${i+1}. <@${r.discordId}> — ${hoursText(Number(r.seconds))}`).join('\n'):'No recorded hours.')]});
  }
  if (name==='evaluate') {
    const user=interaction.options.getUser('user')||interaction.user; const dept=interaction.options.getString('department'); const req=Number(await getSetting(`requirement:${dept}`, '8'))*3600; const w=getWeekWindow(); const total=await totalDutySeconds({discordId:user.id,department:dept,window:w}); const remaining=Math.max(0,req-total); return interaction.reply({embeds:[new EmbedBuilder().setColor(total>=req?0x2f9e44:0xe04f5f).setTitle(`${dept} Weekly Evaluation`).addFields({name:'Member',value:`<@${user.id}>`,inline:true},{name:'Hours Worked',value:hoursText(total),inline:true},{name:'Required',value:hoursText(req),inline:true},{name:'Status',value:total>=req?'Requirement Met':'Below Requirement',inline:true},{name:'Remaining',value:hoursText(remaining),inline:true}).setFooter({text:'Friday to Thursday'})]});
  }
  if (name==='inactive_officers' || name==='dept_officers') {
    const dept=interaction.options.getString('department'); const weeks=interaction.options.getInteger('weeks_back')||2; const cutoff=now()-weeks*7*86400; const rows=await q(`SELECT discordId, MAX(COALESCE(outTime, UNIX_TIMESTAMP())) lastDuty FROM duty_hours WHERE department=? AND discordId IS NOT NULL GROUP BY discordId HAVING lastDuty < ? ORDER BY lastDuty ASC`,[dept,cutoff]); const desc=rows.length?rows.map(r=>`<@${r.discordId}> — last duty ${formatShort(r.lastDuty)}`).join('\n'):'No inactive officers found.'; return interaction.reply({embeds:[new EmbedBuilder().setColor(0xe0a458).setTitle(`${dept} Inactive Officers`).setDescription(desc).setFooter({text:`${weeks}+ weeks without duty`})]});
  }
  if (name==='promotions') {
    const dept=interaction.options.getString('department'); const min=interaction.options.getInteger('min_hours') ?? 8; const w=getWeekWindow(); const rows=await q(`SELECT discordId, SUM(GREATEST(0, LEAST(COALESCE(outTime, UNIX_TIMESTAMP()), ?) - GREATEST(inTime, ?))) seconds FROM duty_hours WHERE department=? AND inTime < ? AND COALESCE(outTime, UNIX_TIMESTAMP()) > ? AND discordId IS NOT NULL GROUP BY discordId HAVING seconds >= ? ORDER BY seconds DESC`,[w.end,w.start,dept,w.end,w.start,min*3600]); const desc=rows.length?rows.map(r=>`<@${r.discordId}> — ${hoursText(Number(r.seconds))}`).join('\n'):'No members meet the current threshold.'; return interaction.reply({embeds:[new EmbedBuilder().setColor(0x3b82f6).setTitle(`${dept} Promotion Eligibility`).setDescription(desc).setFooter({text:`Minimum ${min}h this week`})]});
  }
  if (name==='leomulti') {
    const duration=interaction.options.getInteger('duration_minutes'); const multiplier=interaction.options.getNumber('multiplier')||1.5; await setJsonSetting('leoMultiplier',{multiplier,until:now()+duration*60}); return interaction.reply({content:`LEO hour multiplier started at ${multiplier}x for ${duration} minutes.`});
  }
  if (name==='add_org') {
    if (!adminCheck(interaction.member)) return interaction.reply({content:'Administrator permission required.',ephemeral:true}); const code=interaction.options.getString('code').toUpperCase(); const namev=interaction.options.getString('name'); await q('INSERT INTO department_orgs (code,name,createdBy) VALUES (?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)',[code,namev,interaction.user.id]); return interaction.reply({content:`Added organisation ${code} — ${namev}.`,ephemeral:true});
  }
  if (name==='add_org_hours') {
    if (!adminCheck(interaction.member)) return interaction.reply({content:'Administrator permission required.',ephemeral:true}); const code=interaction.options.getString('code').toUpperCase(); const hours=interaction.options.getNumber('hours'); const reason=interaction.options.getString('reason'); await q('INSERT INTO org_hours_adjustments (orgCode,hours,reason,createdBy,createdAt) VALUES (?,?,?,?,?)',[code,hours,reason||null,interaction.user.id,now()]); return interaction.reply({content:`Added ${hours.toFixed(2)} hours to ${code}.`,ephemeral:true});
  }
  if (name==='rename_org') {
    if (!adminCheck(interaction.member)) return interaction.reply({content:'Administrator permission required.',ephemeral:true}); const oldCode=interaction.options.getString('old_code').toUpperCase(); const newCode=interaction.options.getString('new_code').toUpperCase(); const namev=interaction.options.getString('name'); await q('UPDATE department_orgs SET code=?,name=? WHERE code=?',[newCode,namev,oldCode]); await q('UPDATE org_hours_adjustments SET orgCode=? WHERE orgCode=?',[newCode,oldCode]); return interaction.reply({content:`Renamed ${oldCode} to ${newCode}.`,ephemeral:true});
  }
}

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isStringSelectMenu() && interaction.customId==='report_type') {
      return interaction.showModal(reportFieldsModal(interaction.values[0], false));
    }
    if (interaction.isButton() && interaction.customId.startsWith('report_close:')) {
      const allowed=await ensureReportPermissions(interaction.member); if(!allowed) return interaction.reply({content:'Reports team permission required.',ephemeral:true}); const ownerRow=await q('SELECT reporterId FROM reports WHERE channelId=? LIMIT 1',[interaction.channel.id]); if(ownerRow[0]?.reporterId) await interaction.channel.permissionOverwrites.edit(ownerRow[0].reporterId,{ViewChannel:false,SendMessages:false}).catch(()=>{}); await q('UPDATE reports SET closedAt=? WHERE channelId=?',[now(),interaction.channel.id]); return interaction.reply({content:'Ticket closed.'});
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('report_modal:')) {
      const [,type,mode]=interaction.customId.split(':'); const dept=interaction.fields.getTextInputValue('department').toUpperCase().trim(); if(!DEPARTMENTS.includes(dept)) return interaction.reply({content:'Department must be USM, SASP, BCSO or LSPD.',ephemeral:true}); const details=interaction.fields.getTextInputValue('details')||''; return createReportTicket({interaction,type,department:dept,anonymous:mode==='anon',dateOfIncident:interaction.fields.getTextInputValue('date'),gameId:interaction.fields.getTextInputValue('game_id'),clip:interaction.fields.getTextInputValue('clip'),description:details,context:'',reportedUserId:null});
    }
    return commandInteraction(interaction);
  } catch (err) {
    console.error(err);
    if (interaction.replied || interaction.deferred) await interaction.followUp({content:'An error occurred while processing that request.',ephemeral:true}).catch(()=>{});
    else await interaction.reply({content:'An error occurred while processing that request.',ephemeral:true}).catch(()=>{});
  }
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try { await ensureSchema(); await registerCommands(); await pollDuty(); setInterval(pollDuty, DUTY_POLL_MS); } catch (e) { console.error('Startup error:', e); }
});

process.on('SIGINT', async ()=>{ await pool.end().catch(()=>{}); process.exit(0); });
process.on('SIGTERM', async ()=>{ await pool.end().catch(()=>{}); process.exit(0); });

client.login(TOKEN);
