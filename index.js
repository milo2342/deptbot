require('dotenv').config();

const {
  Client, GatewayIntentBits, Partials, PermissionFlagsBits, ChannelType,
  EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder, ModalBuilder, TextInputBuilder,
  TextInputStyle, ButtonBuilder, ButtonStyle, SlashCommandBuilder,
  REST, Routes, MessageFlags
} = require('discord.js');
const mysql = require('mysql2/promise');
const { DateTime } = require('luxon');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const REPORT_GUILD_ID = process.env.REPORT_GUILD_ID || process.env.LOG_GUILD_ID || '1499578614298181642';
const TIMEZONE = process.env.TIMEZONE || 'Europe/London';
const DUTY_POLL_MS = Math.max(5000, Number(process.env.DUTY_POLL_MS || 10000));
const DB_TIMEOUT_MS = Math.max(1000, Number(process.env.MYSQL_CONNECT_TIMEOUT_MS || 4000));
const DEPARTMENTS = ['USM', 'SASP', 'BCSO', 'LSPD'];
const LEO_VOICE_CHANNELS = [
  '1542399560394088538',
  '1542399564588261446',
  '1542399567234994206'
];

const departmentNames = {
  USM: 'United States Marshals',
  SASP: 'San Andreas State Police',
  BCSO: "Blaine County Sheriff's Office",
  LSPD: 'Los Santos Police Department'
};

const ALL_COMMAND_NAMES = [
  'officer-report-panel','anonreport','addofficer','reportadd','report-config','report-staff',
  'log-config','ridealong-permissions','ridealong','permissions','admin-roles',
  'rename','close','delete','hours','allhours','totalhours','weeklydeptours','deptofhours',
  'tophours','leaderboard','evaluate','inactive_officers','promotions','leomulti',
  'add_org','add_org_hours','rename_org','dept_officers'
];
const ADMIN_COMMANDS = new Set(['officer-report-panel','report-config','report-staff','log-config','ridealong-permissions','permissions','admin-roles','add_org','add_org_hours','rename_org']);
const REPORT_SERVER_COMMANDS = new Set(['officer-report-panel','anonreport','addofficer','reportadd','report-config','report-staff','log-config','rename','close','delete','ridealong-permissions','ridealong']);

if (!TOKEN || !CLIENT_ID) throw new Error('Missing DISCORD_TOKEN or CLIENT_ID.');
if (!process.env.MYSQL_HOST || !process.env.MYSQL_USER || !process.env.MYSQL_DATABASE) {
  console.warn('MYSQL_HOST / MYSQL_USER / MYSQL_DATABASE are missing. Discord commands will still register, but database features will report unavailable.');
}

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 8,
  queueLimit: 0,
  connectTimeout: DB_TIMEOUT_MS,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
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
const currentVoice = new Map();
let dbOnline = false;
let dbRetryTimer = null;
let dutyTimer = null;

const now = () => Math.floor(Date.now() / 1000);
const dt = (ts) => DateTime.fromSeconds(Number(ts), { zone: TIMEZONE });
const formatDateTime = (ts) => dt(ts).toFormat('cccc, dd LLLL yyyy HH:mm');
const formatShort = (ts) => dt(ts).toFormat('dd/MM/yyyy HH:mm');
const hoursText = (seconds) => `${(Math.max(0, Number(seconds || 0)) / 3600).toFixed(2)}h`;
function formatDuration(seconds) {
  let s = Math.max(0, Math.floor(Number(seconds || 0)));
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60); s %= 60;
  if (d) return `${d}d ${h}h ${m}m ${s}s`;
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}
function cleanName(value) { return String(value || 'user').toLowerCase().replace(/[^a-z0-9-]/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'').slice(0,70) || 'user'; }
function parseIds(v) { return String(v || '').split(',').map(s => s.trim()).filter(Boolean); }
function dept(value) { const v = String(value || '').toUpperCase(); return DEPARTMENTS.includes(v) ? v : null; }
function isLeoVoice(id) { return !!id && LEO_VOICE_CHANNELS.includes(id); }
function commandNameClean(v) { return String(v || '').toLowerCase().replace(/^\//,''); }

async function db(sql, params = []) {
  if (!process.env.MYSQL_HOST || !process.env.MYSQL_USER || !process.env.MYSQL_DATABASE) throw new Error('Database configuration is incomplete.');
  const [rows] = await pool.execute(sql, params);
  dbOnline = true;
  return rows;
}
async function dbSafe(sql, params = []) { try { return await db(sql, params); } catch (e) { dbOnline = false; throw e; } }
async function dbFast(sql, params = [], timeout = 1500) {
  return Promise.race([
    db(sql, params),
    new Promise((_, reject) => setTimeout(() => { const e = new Error('Database request timed out.'); e.code = 'DB_TIMEOUT'; reject(e); }, timeout))
  ]).catch(e => { if (e?.code === 'DB_TIMEOUT') dbOnline = false; throw e; });
}

function settingKey(guildId, key) { return `guild:${guildId}:${key}`; }
async function getSetting(key, fallback = null, guildId = REPORT_GUILD_ID) {
  const rows = await dbFast('SELECT settingValue FROM bot_settings WHERE settingKey=? LIMIT 1', [settingKey(guildId, key)]).catch(() => []);
  return rows[0] ? rows[0].settingValue : fallback;
}
async function setSetting(key, value, guildId = REPORT_GUILD_ID) {
  await dbSafe('INSERT INTO bot_settings(settingKey,settingValue) VALUES(?,?) ON DUPLICATE KEY UPDATE settingValue=VALUES(settingValue)', [settingKey(guildId, key), String(value)]);
}
async function getJson(key, fallback, guildId = REPORT_GUILD_ID) { try { const raw = await getSetting(key, JSON.stringify(fallback), guildId); return JSON.parse(raw); } catch { return fallback; } }
async function setJson(key, value, guildId = REPORT_GUILD_ID) { return setSetting(key, JSON.stringify(value), guildId); }

async function ensureSchema() {
  if (!fs.existsSync(path.join(__dirname, 'schema.sql'))) return;
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const statements = sql.split(/;\s*(?=\n|$)/).map(s => s.trim()).filter(Boolean);
  for (const statement of statements) await dbSafe(statement);
  dbOnline = true;
}

async function isAdmin(member) {
  if (!member) return false;
  if (parseIds(process.env.BOT_ADMINS).includes(member.id)) return true;
  if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
  if (!dbOnline) return false;
  const roles = await getJson('adminRoles', [], member.guild?.id || REPORT_GUILD_ID).catch(() => []);
  return roles.some(id => member.roles.cache.has(id));
}
async function configuredPermission(member, key, defaultOpen = true) {
  if (!member) return false;
  if (parseIds(process.env.BOT_ADMINS).includes(member.id) || member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
  if (!dbOnline) return defaultOpen;
  const roles = await getJson(key, [], member.guild.id).catch(() => []);
  if (!roles.length) return defaultOpen;
  return roles.some(id => member.roles.cache.has(id));
}
async function commandAllowed(member, command) {
  return configuredPermission(member, `cmdperm:${command}`, true);
}
async function reportStaffAllowed(member) {
  return configuredPermission(member, 'reportStaffRoles', false);
}
async function ridealongAllowed(member) {
  return configuredPermission(member, 'ridealongRoles', false);
}

function reportServerOnly(interaction) {
  if (!interaction.guild) return false;
  return interaction.guild.id === REPORT_GUILD_ID;
}
async function requireDBReply(interaction) {
  if (!dbOnline) return interaction.editReply({ content: 'The database is currently unavailable. Please try again shortly.' }).then(() => false).catch(() => false);
  return true;
}

function commandBase(name, description) { return new SlashCommandBuilder().setName(name).setDescription(description); }

const commands = [
  commandBase('officer-report-panel','Post the officer report panel'),
  commandBase('anonreport','Submit or convert a report to anonymous mode'),
  commandBase('addofficer','Set the officer being reported in the current ticket'),
  commandBase('reportadd','Create a report ticket as staff'),
  commandBase('report-config','Configure department report roles and category'),
  commandBase('report-staff','Configure report handling roles'),
  commandBase('log-config','Configure report, transcript and ride-along logs'),
  commandBase('ridealong-permissions','Configure roles allowed to log ride-alongs'),
  commandBase('ridealong','Ride-along logging and role configuration'),
  commandBase('permissions','Configure which roles can use commands'),
  commandBase('admin-roles','Configure administrator roles'),
  commandBase('rename','Rename a report ticket to user-handling'),
  commandBase('close','Close a report ticket'),
  commandBase('delete','Save transcript and delete a report ticket'),
  commandBase('hours','View duty hours'),
  commandBase('allhours','View all officer hours for a department'),
  commandBase('totalhours','View the total hours for a department'),
  commandBase('weeklydeptours','View department hours for a timeframe'),
  commandBase('deptofhours','Rank officers by department hours'),
  commandBase('tophours','View the highest hour totals'),
  commandBase('leaderboard','View a department leaderboard'),
  commandBase('evaluate','Evaluate weekly hour requirements'),
  commandBase('inactive_officers','Find inactive officers'),
  commandBase('promotions','Show promotion-eligible officers'),
  commandBase('leomulti','Apply a temporary hour multiplier'),
  commandBase('add_org','Add an organisation'),
  commandBase('add_org_hours','Add adjusted hours to an organisation'),
  commandBase('rename_org','Rename an organisation'),
  commandBase('dept_officers','View department officers by activity')
];

const depOpt = (name='department', required=true) => (o) => o.setName(name).setDescription('Department').setRequired(required).addChoices(...DEPARTMENTS.map(d => ({name:d,value:d})));
const tfChoices = [
  {name:'Last Week',value:'last_week'}, {name:'This Week',value:'this_week'},
  {name:'This Month',value:'this_month'}, {name:'Last Month',value:'last_month'}, {name:'All Time',value:'all_time'}
];
function addReportOptions(cmd, anonymous = false) {
  cmd.addStringOption(depOpt('department', true));
  if (!anonymous) cmd.addUserOption(o=>o.setName('officer').setDescription('Officer being reported').setRequired(false));
  if (anonymous) cmd.addUserOption(o=>o.setName('officer').setDescription('Officer being reported').setRequired(false));
  cmd.addStringOption(o=>o.setName('date').setDescription('Date of incident').setRequired(false));
  cmd.addStringOption(o=>o.setName('game_id').setDescription('In-game ID').setRequired(false));
  cmd.addStringOption(o=>o.setName('clip').setDescription('Clip URL or evidence link').setRequired(false));
  cmd.addStringOption(o=>o.setName('description').setDescription('What happened').setRequired(false));
  cmd.addStringOption(o=>o.setName('context').setDescription('Additional context').setRequired(false));
}
commands.find(c=>c.name==='hours')
  .addStringOption(depOpt('department', true))
  .addStringOption(o=>o.setName('timeframe').setDescription('Time frame').setRequired(false).addChoices(...tfChoices))
  .addUserOption(o=>o.setName('user').setDescription('Exact person').setRequired(false));
for (const n of ['allhours','totalhours','weeklydeptours','deptofhours','leaderboard','evaluate','inactive_officers','promotions','dept_officers']) commands.find(c=>c.name===n).addStringOption(depOpt('department',true));
for (const n of ['allhours','totalhours','weeklydeptours','deptofhours','leaderboard']) commands.find(c=>c.name===n).addStringOption(o=>o.setName('timeframe').setDescription('Time frame').setRequired(false).addChoices(...tfChoices));
commands.find(c=>c.name==='evaluate').addUserOption(o=>o.setName('user').setDescription('Exact person').setRequired(false));
for (const n of ['inactive_officers','dept_officers']) commands.find(c=>c.name===n).addIntegerOption(o=>o.setName('weeks_back').setDescription('Weeks without duty').setRequired(false).addChoices({name:'2 weeks',value:2},{name:'4 weeks',value:4}));
commands.find(c=>c.name==='promotions').addIntegerOption(o=>o.setName('min_hours').setDescription('Minimum weekly hours').setRequired(false).setMinValue(0));
commands.find(c=>c.name==='leomulti').addIntegerOption(o=>o.setName('duration_minutes').setDescription('Duration in minutes').setRequired(true).setMinValue(1).setMaxValue(10080)).addNumberOption(o=>o.setName('multiplier').setDescription('Multiplier').setRequired(false).setMinValue(1).setMaxValue(5));
commands.find(c=>c.name==='add_org').addStringOption(o=>o.setName('code').setDescription('Organisation code').setRequired(true)).addStringOption(o=>o.setName('name').setDescription('Organisation name').setRequired(true));
commands.find(c=>c.name==='add_org_hours').addStringOption(o=>o.setName('code').setDescription('Organisation code').setRequired(true)).addNumberOption(o=>o.setName('hours').setDescription('Hours').setRequired(true)).addStringOption(o=>o.setName('reason').setDescription('Reason').setRequired(false));
commands.find(c=>c.name==='rename_org').addStringOption(o=>o.setName('old_code').setDescription('Current code').setRequired(true)).addStringOption(o=>o.setName('new_code').setDescription('New code').setRequired(true)).addStringOption(o=>o.setName('name').setDescription('Organisation name').setRequired(true));
commands.find(c=>c.name==='admin-roles').addStringOption(o=>o.setName('action').setDescription('Action').setRequired(true).addChoices({name:'Add',value:'add'},{name:'Remove',value:'remove'},{name:'Clear',value:'clear'},{name:'View',value:'view'})).addRoleOption(o=>o.setName('role').setDescription('Administrator role').setRequired(false));
commands.find(c=>c.name==='permissions').addStringOption(o=>o.setName('action').setDescription('Action').setRequired(true).addChoices({name:'Add',value:'add'},{name:'Remove',value:'remove'},{name:'Clear',value:'clear'},{name:'View',value:'view'})).addStringOption(o=>o.setName('command').setDescription('Command name').setRequired(true)).addRoleOption(o=>o.setName('role').setDescription('Allowed role').setRequired(false));
commands.find(c=>c.name==='report-staff').addStringOption(o=>o.setName('action').setDescription('Action').setRequired(true).addChoices({name:'Add',value:'add'},{name:'Remove',value:'remove'},{name:'Clear',value:'clear'},{name:'View',value:'view'})).addRoleOption(o=>o.setName('role').setDescription('Report handling role').setRequired(false));
commands.find(c=>c.name==='ridealong-permissions').addStringOption(o=>o.setName('action').setDescription('Action').setRequired(true).addChoices({name:'Add',value:'add'},{name:'Remove',value:'remove'},{name:'Clear',value:'clear'},{name:'View',value:'view'})).addRoleOption(o=>o.setName('role').setDescription('Role allowed to log ride-alongs').setRequired(false));
commands.find(c=>c.name==='report-config').addStringOption(o=>o.setName('action').setDescription('Action').setRequired(true).addChoices({name:'Set',value:'set'},{name:'Clear',value:'clear'},{name:'View',value:'view'})).addStringOption(depOpt('department',false)).addRoleOption(o=>o.setName('role').setDescription('Role to ping').setRequired(false)).addChannelOption(o=>o.setName('category').setDescription('Report ticket category').addChannelTypes(ChannelType.GuildCategory).setRequired(false));
commands.find(c=>c.name==='log-config').addStringOption(o=>o.setName('type').setDescription('Log type').setRequired(true).addChoices({name:'Report Logs',value:'report_log'},{name:'Transcript Logs',value:'transcript_log'},{name:'Ride-Along Logs',value:'ridealong_log'})).addChannelOption(o=>o.setName('channel').setDescription('Log channel').setRequired(false).addChannelTypes(ChannelType.GuildText));
commands.find(c=>c.name==='ridealong')
  .addSubcommand(sub=>sub.setName('log').setDescription('Log a ride-along').addUserOption(o=>o.setName('player').setDescription('Trainee').setRequired(true)).addStringOption(depOpt('department',true)).addStringOption(o=>o.setName('result').setDescription('Result').setRequired(true).addChoices({name:'Passed',value:'Passed'},{name:'Failed',value:'Failed'})).addStringOption(o=>o.setName('notes').setDescription('Notes').setRequired(false)))
  .addSubcommand(sub=>sub.setName('role').setDescription('Configure ride-along and trainee roles').addRoleOption(o=>o.setName('ridealong_role').setDescription('Ride-along role').setRequired(true)).addRoleOption(o=>o.setName('trainee_role').setDescription('Trainee role to remove').setRequired(true)));
commands.find(c=>c.name==='reportadd').addStringOption(depOpt('department',true)).addUserOption(o=>o.setName('officer').setDescription('Officer').setRequired(false)).addStringOption(o=>o.setName('date').setDescription('Date of incident').setRequired(false)).addStringOption(o=>o.setName('game_id').setDescription('In-game ID').setRequired(false)).addStringOption(o=>o.setName('clip').setDescription('Clip URL').setRequired(false)).addStringOption(o=>o.setName('description').setDescription('Description').setRequired(false)).addStringOption(o=>o.setName('context').setDescription('Additional context').setRequired(false));
addReportOptions(commands.find(c=>c.name==='anonreport'), true);
commands.find(c=>c.name==='addofficer').addUserOption(o=>o.setName('user').setDescription('Discord user').setRequired(false)).addStringOption(o=>o.setName('user_id').setDescription('Exact Discord user ID').setRequired(false));

function fixOptionOrder(value) {
  const visit = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj.options)) obj.options = obj.options.map(visit);
    if (Array.isArray(obj.options)) {
      const subs = obj.options.filter(x => [1,2].includes(x.type));
      const plain = obj.options.filter(x => ![1,2].includes(x.type));
      if (subs.length) obj.options = subs.concat(plain.sort((a,b)=>Number(Boolean(b.required))-Number(Boolean(a.required))));
      else obj.options.sort((a,b)=>Number(Boolean(b.required))-Number(Boolean(a.required)));
    }
    return obj;
  };
  return visit(value);
}
function validateOptions(options, path='options') {
  let seenOptional = false;
  for (const o of options || []) {
    if (o.type === 1 || o.type === 2) { validateOptions(o.options, `${path}.${o.name}`); continue; }
    if (o.required) { if (seenOptional) throw new Error(`Invalid required option order at ${path}.${o.name}`); }
    else seenOptional = true;
  }
}
async function registerCommands() {
  const rest = new REST({version:'10'}).setToken(TOKEN);
  const body = commands.map(c=>fixOptionOrder(c.toJSON()));
  for (const c of body) validateOptions(c.options, `/${c.name}`);
  const result = await rest.put(Routes.applicationCommands(CLIENT_ID), {body});
  const count = Array.isArray(result) ? result.length : body.length;
  console.log(`GLOBAL COMMANDS REGISTERED: ${count}`);
  console.log(`Global command names: ${body.map(c=>c.name).join(', ')}`);
}

function panelEmbed() {
  return new EmbedBuilder().setColor(0x2f80ed).setTitle('Department Reports')
    .setDescription('Select the type of report you want to submit. A private report channel will be created automatically.')
    .addFields(
      {name:'Officer Report',value:'Report an officer or department member.',inline:true},
      {name:'Higher Up Report',value:'Report a supervisor, command member or senior leadership.',inline:true}
    ).setFooter({text:'WCRP Department Utilities'});
}
function panelRow() {
  return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('report_panel_type').setPlaceholder('Select report type').addOptions(
    new StringSelectMenuOptionBuilder().setLabel('Officer Report').setDescription('Report an officer').setValue('officer'),
    new StringSelectMenuOptionBuilder().setLabel('Higher Up Report').setDescription('Report higher-up staff').setValue('higher')
  ));
}
function reportModal(type) {
  return new ModalBuilder().setCustomId(`report_form:${type}`).setTitle(type==='higher'?'Higher Up Report':'Officer Report').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('department').setLabel('Department').setPlaceholder('USM / SASP / BCSO / LSPD').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('officer_id').setLabel('Officer Discord ID (optional)').setPlaceholder('Discord user ID').setStyle(TextInputStyle.Short).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('date').setLabel('Date of incident').setPlaceholder('Date / time').setStyle(TextInputStyle.Short).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('clip').setLabel('Clips / evidence').setPlaceholder('Clip URL(s)').setStyle(TextInputStyle.Paragraph).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('details').setLabel('Description / context').setPlaceholder('Explain what happened and add any useful context.').setStyle(TextInputStyle.Paragraph).setRequired(false))
  );
}
function reportEmbed(report) {
  const title = report.anonymous ? 'Anonymous Report' : report.ticketType === 'higher' ? 'Higher Up Report' : 'Officer Report';
  return new EmbedBuilder().setColor(report.anonymous ? 0x8b5cf6 : report.ticketType === 'higher' ? 0x7c3aed : 0x2f80ed).setTitle(title)
    .addFields(
      {name:'Department',value:`${report.department} — ${departmentNames[report.department] || report.department}`,inline:true},
      {name:'Date of Incident',value:report.dateOfIncident || 'Not provided',inline:true},
      {name:'In-Game ID',value:report.gameId || 'Not provided',inline:true},
      {name:'Officer Being Reported',value:report.reportedUserId ? `<@${report.reportedUserId}> (${report.reportedUserId})` : 'Not provided',inline:false},
      {name:'Clips / Evidence',value:report.clip || 'Not provided',inline:false},
      {name:'Description',value:report.description || 'Not provided',inline:false},
      {name:'Additional Context',value:report.context || 'Not provided',inline:false}
    ).setFooter({text:`WCRP Department Utilities • ${formatShort(report.createdAt || now())}`});
}
function activeTicketButtons(closed=false) {
  if (!closed) return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket_close').setLabel('Close').setStyle(ButtonStyle.Danger));
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_transcript').setLabel('Transcript').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ticket_delete').setLabel('Delete').setStyle(ButtonStyle.Danger)
  );
}
async function fetchReport(channelId) { const rows = await dbSafe('SELECT * FROM reports WHERE channelId=? LIMIT 1',[channelId]); return rows[0] || null; }
async function getDepartmentReportRoles(guildId, department) { return getJson(`reportRoles:${department}`,[],guildId); }
async function reportCategory(guildId, department) { return getSetting(`reportCategory:${department}`,null,guildId); }
function canManageTicket(member) { return reportStaffAllowed(member); }

async function applyTicketPermissions(channel, report) {
  const everyone = channel.guild.roles.everyone.id;
  const overwrites = new Map();
  overwrites.set(everyone,{ViewChannel:false});
  if (report.reporterId) overwrites.set(report.reporterId,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true});
  if (report.reportedUserId) overwrites.set(report.reportedUserId,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true});
  const staff = await getJson('reportStaffRoles',[],channel.guild.id);
  for (const roleId of staff) overwrites.set(roleId,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true});
  overwrites.set(client.user.id,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true,ManageChannels:true,ManageMessages:true});
  for (const [target, perms] of overwrites) await channel.permissionOverwrites.edit(target,perms).catch(()=>{});
}
async function createReportTicket({interaction,type,department,anonymous,reporterId,reportedUserId,dateOfIncident,gameId,clip,description,context}) {
  const categoryId = await reportCategory(interaction.guild.id, department);
  const roles = await getDepartmentReportRoles(interaction.guild.id,department);
  const report = {ticketType:type,department,reporterId:anonymous?null:reporterId,reportedUserId:reportedUserId||null,dateOfIncident:dateOfIncident||null,gameId:gameId||null,clip:clip||null,description:description||null,context:context||null,anonymous:anonymous?1:0,createdAt:now()};
  const base = anonymous ? `anon-${department.toLowerCase()}` : `report-${department.toLowerCase()}-${cleanName(interaction.user.username)}`;
  const channel = await interaction.guild.channels.create({name:base,type:ChannelType.GuildText,parent:categoryId||undefined,reason:'Department report',permissionOverwrites:[{id:interaction.guild.roles.everyone.id,deny:['ViewChannel']} ]});
  await dbSafe('INSERT INTO reports(channelId,ticketType,department,reporterId,reportedUserId,dateOfIncident,gameId,clip,description,context,anonymous,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[
    channel.id,type,department,report.reporterId,report.reportedUserId,report.dateOfIncident,report.gameId,report.clip,report.description,report.context,report.anonymous,report.createdAt
  ]);
  await applyTicketPermissions(channel, report);
  await channel.send({content:roles.map(r=>`<@&${r}>`).join(' ')||undefined,embeds:[reportEmbed({id:0,...report})],components:[activeTicketButtons(false)]});
  return channel;
}

async function updateReportMessage(report) {
  const channel = await client.channels.fetch(report.channelId).catch(()=>null);
  if (!channel?.isTextBased()) return false;
  const msgs = await channel.messages.fetch({limit:100}).catch(()=>null);
  const msg = msgs ? [...msgs.values()].find(m=>m.embeds.some(e=>/Report/.test(e.title||''))) : null;
  if (!msg) return false;
  await msg.edit({embeds:[reportEmbed(report)],components:[activeTicketButtons(Boolean(report.closedAt))]});
  await applyTicketPermissions(channel,report);
  return true;
}
async function clearChannel(channel) {
  for (let i=0;i<50;i++) {
    const msgs = await channel.messages.fetch({limit:100}).catch(()=>null);
    if (!msgs?.size) return;
    for (const m of msgs.values()) await m.delete().catch(()=>{});
    if (msgs.size<100) return;
  }
}
async function transcript(channel) {
  const all=[]; let before;
  for(let i=0;i<30;i++){
    const msgs=await channel.messages.fetch({limit:100,before}).catch(()=>null);
    if(!msgs?.size) break;
    all.push(...msgs.values()); before=msgs.last().id;
    if(msgs.size<100) break;
  }
  all.sort((a,b)=>a.createdTimestamp-b.createdTimestamp);
  return all.map(m=>{
    const files=m.attachments.size?[...m.attachments.values()].map(a=>a.url).join(', '):'';
    return `[${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}: ${m.content || '[embed / attachment]'}${files?` | Attachments: ${files}`:''}`;
  }).join('\n');
}
async function sendTranscriptLog(guild,channel,content) {
  const id = await getSetting('transcriptChannelId',null,guild.id).catch(()=>null);
  if(!id) return false;
  const log = guild.channels.cache.get(id);
  if(!log?.isTextBased()) return false;
  await log.send({content:`Transcript for #${channel.name}`,files:[{attachment:Buffer.from(content||'No messages.'),name:`${channel.name}-transcript.txt`}]}).catch(()=>{});
  return true;
}
async function sendReportLog(guild,embed) {
  const id = await getSetting('reportLogChannelId',null,guild.id).catch(()=>null);
  const ch=id?guild.channels.cache.get(id):null;
  if(ch?.isTextBased()) await ch.send({embeds:[embed]}).catch(()=>{});
}
async function sendRidealongLog(guild,embed) {
  const id = await getSetting('ridealongLogChannelId',null,guild.id).catch(()=>null);
  const ch=id?guild.channels.cache.get(id):null;
  if(ch?.isTextBased()) await ch.send({embeds:[embed]}).catch(()=>{});
}

function weekWindow(ts=now()){
  const d=dt(ts); const days=(d.weekday+2)%7; const start=d.minus({days}).startOf('day'); const end=start.plus({days:7});
  return {start:Math.floor(start.toSeconds()),end:Math.floor(end.toSeconds()),startLabel:start.toFormat('LLL dd'),endLabel:end.minus({seconds:1}).toFormat('LLL dd')};
}
function timeWindow(kind, ts=now()){
  const d=dt(ts), w=weekWindow(ts);
  if(kind==='this_week') return w;
  if(kind==='last_week'){const s=dt(w.start).minus({days:7}),e=dt(w.start);return {start:Math.floor(s.toSeconds()),end:Math.floor(e.toSeconds()),startLabel:s.toFormat('LLL dd'),endLabel:e.minus({seconds:1}).toFormat('LLL dd')};}
  if(kind==='this_month'){const s=d.startOf('month'),e=s.plus({months:1});return {start:Math.floor(s.toSeconds()),end:Math.floor(e.toSeconds()),startLabel:s.toFormat('LLL dd'),endLabel:e.minus({seconds:1}).toFormat('LLL dd')};}
  if(kind==='last_month'){const e=d.startOf('month'),s=e.minus({months:1});return {start:Math.floor(s.toSeconds()),end:Math.floor(e.toSeconds()),startLabel:s.toFormat('LLL dd'),endLabel:e.minus({seconds:1}).toFormat('LLL dd')};}
  return {start:0,end:now()+1,startLabel:'All Time',endLabel:''};
}
async function dutyTotal(discordId,department,w){
  const rows=await dbSafe(`SELECT inTime,COALESCE(outTime,UNIX_TIMESTAMP()) outTime FROM duty_hours WHERE inTime IS NOT NULL ${discordId?'AND discordId=?':''} ${department?'AND department=?':''} AND inTime < ? AND COALESCE(outTime,UNIX_TIMESTAMP()) > ?`,[...(discordId?[discordId]:[]),...(department?[department]:[]),w.end,w.start]);
  return rows.reduce((sum,r)=>sum+Math.max(0,Math.min(Number(r.outTime),w.end)-Math.max(Number(r.inTime),w.start)),0);
}
async function voiceStats(dutyId,inTime,outTime){
  const end=outTime||now();
  const rows=await dbSafe('SELECT inTime,COALESCE(outTime,?) outTime,isLeoVoice FROM duty_voice_segments WHERE dutyId=? AND inTime < ? AND COALESCE(outTime,?) > ?',[end,dutyId,end,end,inTime]);
  let voice=0;
  for(const r of rows) if(Number(r.isLeoVoice)) voice+=Math.max(0,Math.min(Number(r.outTime),end)-Math.max(Number(r.inTime),inTime));
  const session=Math.max(0,end-inTime);
  return {session,voice,outVoice:Math.max(0,session-voice),coverage:session?(voice/session)*100:0};
}
async function openVoiceSegment(discordId,channelId,timestamp){
  const duty=activeDuty.get(discordId); if(!duty) return;
  const old=currentVoice.get(discordId);
  if(old && old.channelId===channelId) return;
  if(old) await dbSafe('UPDATE duty_voice_segments SET outTime=? WHERE id=? AND outTime IS NULL',[timestamp,old.id]).catch(()=>{});
  const result=await dbSafe('INSERT INTO duty_voice_segments(dutyId,discordId,channelId,inTime,outTime,isLeoVoice) VALUES(?,?,?,?,NULL,?)',[duty.id,discordId,channelId||null,timestamp,isLeoVoice(channelId)?1:0]);
  currentVoice.set(discordId,{id:result.insertId,channelId:channelId||null});
}
async function closeVoiceSegment(discordId,timestamp){ const old=currentVoice.get(discordId); if(!old)return; await dbSafe('UPDATE duty_voice_segments SET outTime=? WHERE id=? AND outTime IS NULL',[timestamp,old.id]).catch(()=>{}); currentVoice.delete(discordId); }
function onDutyEmbed(user,department,inTime){return new EmbedBuilder().setColor(0x2f9e44).setTitle('On Duty').setDescription(`Thanks for your service, ${user.globalName||user.username}.`).addFields({name:'Clock In',value:formatDateTime(inTime),inline:true},{name:'Department',value:`${department} — ${departmentNames[department]||department}`,inline:true}).setFooter({text:`WCRP Department Utilities • ${formatShort(inTime)}`});}
function offDutyEmbed(user,row,stats,weekly){return new EmbedBuilder().setColor(0xe04f5f).setTitle('Off Duty').setDescription(`Thanks for your service, ${user.globalName||user.username}.`).addFields({name:'Reason',value:row.reason||'Clock Out',inline:false},{name:'Clock Out',value:formatDateTime(Number(row.outTime)),inline:true},{name:'Session',value:formatDuration(stats.session),inline:true},{name:'This Week (Fri-Thu)',value:hoursText(weekly.total),inline:true},{name:'Week',value:`${weekly.startLabel} - ${weekly.endLabel}`,inline:true},{name:'Department',value:`${row.department} — ${departmentNames[row.department]||row.department}`,inline:true},{name:'In Voice',value:formatDuration(stats.voice),inline:true},{name:'Out of Voice',value:formatDuration(stats.outVoice),inline:true},{name:'Voice Coverage',value:`${stats.coverage.toFixed(0)}%`,inline:true},{name:'Clock In',value:formatDateTime(Number(row.inTime)),inline:false}).setFooter({text:`WCRP Department Utilities • ${formatShort(Number(row.outTime))}`});}
async function dmUser(id,embeds){const user=await client.users.fetch(String(id)).catch(()=>null); if(!user)return; await user.send({embeds:[embeds]}).catch(()=>{});}
async function startDuty(row){const id=String(row.discordId); if(activeDuty.has(id)) return; activeDuty.set(id,{id:row.id,discordId:id,inTime:Number(row.inTime),department:String(row.department||'').toUpperCase()}); const guild=client.guilds.cache.get(REPORT_GUILD_ID); const member=guild?await guild.members.fetch(id).catch(()=>null):null; await openVoiceSegment(id,member?.voice?.channelId||null,Number(row.inTime)).catch(()=>{}); await dmUser(id,onDutyEmbed(await client.users.fetch(id).catch(()=>({username:'Member'})),String(row.department),Number(row.inTime))); }
async function finishDuty(row){const id=String(row.discordId); const duty=activeDuty.get(id); const inTime=duty?.inTime||Number(row.inTime); const dutyId=duty?.id||row.id; const outTime=Number(row.outTime||now()); await closeVoiceSegment(id,outTime); const stats=await voiceStats(dutyId,inTime,outTime); const w=weekWindow(outTime); const weekly={total:await dutyTotal(id,String(row.department),w),startLabel:w.startLabel,endLabel:w.endLabel}; const user=await client.users.fetch(id).catch(()=>null); if(user) await dmUser(id,offDutyEmbed(user,row,stats,weekly)); activeDuty.delete(id); }
async function pollDuty(){if(!dbOnline)return; try{const active=await dbSafe('SELECT * FROM duty_hours WHERE outTime IS NULL AND discordId IS NOT NULL ORDER BY id DESC');const seen=new Set();for(const r of active){const id=String(r.discordId);if(seen.has(id))continue;seen.add(id);await startDuty(r);}const completed=await dbSafe('SELECT * FROM duty_hours WHERE outTime IS NOT NULL AND outTime >= ? ORDER BY outTime ASC',[now()-120]);for(const r of completed){const id=String(r.discordId);if(activeDuty.has(id)&&activeDuty.get(id).id===r.id)await finishDuty(r);}for(const [id] of activeDuty){if(!seen.has(id)){await closeVoiceSegment(id,now());activeDuty.delete(id);}}}catch(e){dbOnline=false;console.error('Duty poll error:',e.message);} }

client.on('voiceStateUpdate',async(oldState,newState)=>{const id=String(newState.id||oldState.id);if(!activeDuty.has(id))return;await openVoiceSegment(id,newState.channelId||null).catch(e=>console.error('Voice tracking error:',e.message));});

async function editOrReply(interaction, payload){ if(interaction.deferred||interaction.replied) return interaction.editReply(payload); return interaction.reply(payload); }

async function handleCommand(interaction){
  if(!interaction.isChatInputCommand())return;
  let name=interaction.commandName;
  try {
    await interaction.deferReply({flags: MessageFlags.Ephemeral});
  } catch (ackError) {
    console.error('COMMAND ACK ERROR:', ackError);
    return;
  }
  try {
  if(!interaction.guildId)return interaction.editReply('This command must be used in a server.');
  if(REPORT_SERVER_COMMANDS.has(name) && interaction.guildId!==REPORT_GUILD_ID) return interaction.editReply('This command is only available in the WCRP reports and ride-along server.');
  if(ADMIN_COMMANDS.has(name) && !(await isAdmin(interaction.member))) return interaction.editReply('Administrator permission required.');
  if(!(await commandAllowed(interaction.member,name))) return interaction.editReply('You do not have permission to use this command.');
  if(!(await requireDBReply(interaction))) return;
  try {
    if(name==='officer-report-panel'){
      await interaction.channel.send({embeds:[panelEmbed()],components:[panelRow()]});
      return interaction.editReply('Report panel posted.');
    }
    if(name==='admin-roles'){
      const action=interaction.options.getString('action'),role=interaction.options.getRole('role');let roles=await getJson('adminRoles',[],interaction.guild.id);
      if(action==='add'&&role)roles=[...new Set([...roles,role.id])]; if(action==='remove'&&role)roles=roles.filter(x=>x!==role.id); if(action==='clear')roles=[];
      await setJson('adminRoles',roles,interaction.guild.id); return interaction.editReply(`Administrator roles: ${roles.length?roles.map(x=>`<@&${x}>`).join(', '):'None'}`);
    }
    if(name==='permissions'){
      const action=interaction.options.getString('action'),cmd=commandNameClean(interaction.options.getString('command')),role=interaction.options.getRole('role'); let roles=await getJson(`cmdperm:${cmd}`,[],interaction.guild.id);
      if(action==='view')return interaction.editReply(`${cmd}: ${roles.length?roles.map(x=>`<@&${x}>`).join(', '):'Everyone'}`);
      if(action==='add'&&role)roles=[...new Set([...roles,role.id])]; if(action==='remove'&&role)roles=roles.filter(x=>x!==role.id); if(action==='clear')roles=[]; await setJson(`cmdperm:${cmd}`,roles,interaction.guild.id); return interaction.editReply(`${cmd}: ${roles.length?roles.map(x=>`<@&${x}>`).join(', '):'Everyone'}`);
    }
    if(name==='report-staff'||name==='ridealong-permissions'){
      const action=interaction.options.getString('action'),role=interaction.options.getRole('role'),key=name==='report-staff'?'reportStaffRoles':'ridealongRoles';let roles=await getJson(key,[],interaction.guild.id);
      if(action==='view')return interaction.editReply(`${name==='report-staff'?'Report staff':'Ride-along'} roles: ${roles.length?roles.map(x=>`<@&${x}>`).join(', '):'None'}`);
      if(action==='add'&&role)roles=[...new Set([...roles,role.id])];if(action==='remove'&&role)roles=roles.filter(x=>x!==role.id);if(action==='clear')roles=[];await setJson(key,roles,interaction.guild.id);return interaction.editReply(`${name==='report-staff'?'Report staff':'Ride-along'} roles: ${roles.length?roles.map(x=>`<@&${x}>`).join(', '):'None'}`);
    }
    if(name==='report-config'){
      const action=interaction.options.getString('action'),d=dept(interaction.options.getString('department')),role=interaction.options.getRole('role'),cat=interaction.options.getChannel('category');
      if(action==='view'){const lines=[];for(const x of DEPARTMENTS){const rs=await getJson(`reportRoles:${x}`,[],interaction.guild.id);const c=await reportCategory(interaction.guild.id,x);lines.push(`${x}: role ${rs.length?rs.map(r=>`<@&${r}>`).join(', '):'Not configured'} | category ${c?`<#${c}>`:'Not configured'}`);}return interaction.editReply(lines.join('\n'));}
      if(!d)return interaction.editReply('Select a department.');
      if(action==='set'){if(role)await setJson(`reportRoles:${d}`,[role.id],interaction.guild.id);if(cat)await setSetting(`reportCategory:${d}`,cat.id,interaction.guild.id);}
      if(action==='clear'){await setJson(`reportRoles:${d}`,[],interaction.guild.id);await setSetting(`reportCategory:${d}`,'',interaction.guild.id);}
      return interaction.editReply(`Report configuration updated for ${d}.`);
    }
    if(name==='log-config'){
      const type=interaction.options.getString('type'),ch=interaction.options.getChannel('channel');const key=type==='report_log'?'reportLogChannelId':type==='transcript_log'?'transcriptChannelId':'ridealongLogChannelId';if(ch)await setSetting(key,ch.id,interaction.guild.id);const v=await getSetting(key,null,interaction.guild.id);return interaction.editReply(`${type}: ${v?`<#${v}>`:'Not configured'}`);
    }
    if(name==='ridealong'){
      const sub=interaction.options.getSubcommand();
      if(sub==='role'){if(!(await isAdmin(interaction.member)))return interaction.editReply('Administrator permission required.');const ride=interaction.options.getRole('ridealong_role'),trainee=interaction.options.getRole('trainee_role');await setSetting('ridealongResultRoleId',ride.id,interaction.guild.id);await setSetting('traineeRoleId',trainee.id,interaction.guild.id);return interaction.editReply(`Ride-along role: <@&${ride.id}>\nTrainee role removed on log: <@&${trainee.id}>`);}
      if(!(await ridealongAllowed(interaction.member)))return interaction.editReply('You do not have permission to log ride-alongs.');
      const player=interaction.options.getUser('player'),d=dept(interaction.options.getString('department')),result=interaction.options.getString('result'),notes=interaction.options.getString('notes');const guildMember=await interaction.guild.members.fetch(player.id).catch(()=>null);const trainee=await getSetting('traineeRoleId',null,interaction.guild.id);const rideRole=await getSetting('ridealongResultRoleId',null,interaction.guild.id);
      if(guildMember&&trainee&&guildMember.roles.cache.has(trainee))await guildMember.roles.remove(trainee,'Ride-along logged').catch(()=>{});if(guildMember&&result==='Passed'&&rideRole)await guildMember.roles.add(rideRole,'Ride-along passed').catch(()=>{});
      await dbSafe('INSERT INTO ridealongs(discordId,department,ridealongRoleId,result,notes,createdBy,createdAt) VALUES(?,?,?,?,?,?,?)',[player.id,d,rideRole,result,notes||null,interaction.user.id,now()]);
      await sendRidealongLog(interaction.guild,new EmbedBuilder().setColor(result==='Passed'?0x2f9e44:0xe04f5f).setTitle('Ride-Along Log').addFields({name:'Officer',value:`<@${player.id}>`,inline:true},{name:'Department',value:d,inline:true},{name:'Result',value:result,inline:true},{name:'Notes',value:notes||'None'}).setFooter({text:`Logged by ${interaction.user.tag} • ${formatShort(now())}`}));
      return interaction.editReply(`Ride-along logged for <@${player.id}>.`);
    }
    if(name==='addofficer'){
      if(!(await reportStaffAllowed(interaction.member)))return interaction.editReply('Reports team permission required.');const user=interaction.options.getUser('user'),userId=interaction.options.getString('user_id')?.trim(),target=user?.id||userId;if(!/^\d{17,20}$/.test(String(target||'')))return interaction.editReply('Provide a valid Discord user or exact Discord user ID.');const report=await fetchReport(interaction.channel.id);if(!report)return interaction.editReply('This is not a report ticket.');await dbSafe('UPDATE reports SET reportedUserId=? WHERE channelId=?',[target,interaction.channel.id]);report.reportedUserId=target;await updateReportMessage(report);return interaction.editReply(`Officer being reported set to <@${target}>.`);
    }
    if(name==='reportadd'){
      if(!(await reportStaffAllowed(interaction.member)))return interaction.editReply('Reports team permission required.');const d=dept(interaction.options.getString('department'));const ch=await createReportTicket({interaction,type:'officer',department:d,anonymous:false,reporterId:interaction.user.id,reportedUserId:interaction.options.getUser('officer')?.id,dateOfIncident:interaction.options.getString('date'),gameId:interaction.options.getString('game_id'),clip:interaction.options.getString('clip'),description:interaction.options.getString('description'),context:interaction.options.getString('context')});return interaction.editReply(`Report created: ${ch}`);
    }
    if(name==='anonreport'){
      const d=dept(interaction.options.getString('department'));const existing=await fetchReport(interaction.channel.id);const officer=interaction.options.getUser('officer')?.id||existing?.reportedUserId||null;if(!officer)return interaction.editReply('Select the officer being reported or use /addofficer first.');const updates={department:d,reportedUserId:officer,dateOfIncident:interaction.options.getString('date'),gameId:interaction.options.getString('game_id'),clip:interaction.options.getString('clip'),description:interaction.options.getString('description'),context:interaction.options.getString('context'),anonymous:1};if(!existing){const ch=await createReportTicket({interaction,type:'officer',department:d,anonymous:true,reporterId:null,reportedUserId:officer,...updates});return interaction.editReply(`Anonymous report created: ${ch}`);}await dbSafe('UPDATE reports SET department=?,reportedUserId=?,dateOfIncident=?,gameId=?,clip=?,description=?,context=?,anonymous=1,reporterId=NULL WHERE channelId=?',[d,officer,updates.dateOfIncident||null,updates.gameId||null,updates.clip||null,updates.description||null,updates.context||null,interaction.channel.id]);const report={...existing,...updates,reporterId:null,anonymous:1};await clearChannel(interaction.channel);await interaction.channel.permissionOverwrites.delete(existing.reporterId).catch(()=>{});await interaction.channel.setName(`anon-${d.toLowerCase()}`).catch(()=>{});await applyTicketPermissions(interaction.channel,report);const roles=await getDepartmentReportRoles(interaction.guild.id,d);await interaction.channel.send({content:roles.map(r=>`<@&${r}>`).join(' ')||undefined,embeds:[reportEmbed(report)],components:[activeTicketButtons(false)]});return interaction.editReply('Anonymous report rebuilt. The reporter has been removed from the ticket.');
    }
    if(name==='rename'){
      const report=await fetchReport(interaction.channel.id);if(!report)return interaction.editReply('This is not a report ticket.');const owner=report.anonymous?report.reportedUserId:report.reporterId;const u=owner?await client.users.fetch(owner).catch(()=>null):null;const base=cleanName(u?.username||interaction.user.username);await interaction.channel.setName(`${base}-handling`);return interaction.editReply(`Channel renamed to ${base}-handling.`);
    }
    if(name==='close'){
      if(!(await reportStaffAllowed(interaction.member)))return interaction.editReply('Reports team permission required.');const report=await fetchReport(interaction.channel.id);if(!report)return interaction.editReply('This is not a report ticket.');report.closedAt=now();await dbSafe('UPDATE reports SET closedAt=? WHERE channelId=?',[report.closedAt,interaction.channel.id]);if(report.reporterId)await interaction.channel.permissionOverwrites.edit(report.reporterId,{ViewChannel:false,SendMessages:false}).catch(()=>{});await interaction.editReply({content:'Ticket closed.',components:[activeTicketButtons(true)]});
      return;
    }
    if(name==='delete'){
      if(!(await reportStaffAllowed(interaction.member)))return interaction.editReply('Reports team permission required.');const report=await fetchReport(interaction.channel.id);if(!report)return interaction.editReply('This is not a report ticket.');const text=await transcript(interaction.channel);await sendTranscriptLog(interaction.guild,interaction.channel,text);await sendReportLog(interaction.guild,new EmbedBuilder().setColor(0x7f1d1d).setTitle('Report Deleted').setDescription(`${report.department} report deleted by <@${interaction.user.id}>.`).addFields({name:'Channel',value:`#${interaction.channel.name}`},{name:'Officer',value:report.reportedUserId?`<@${report.reportedUserId}>`:'Not set'}).setFooter({text:`${formatShort(now())}`}));await interaction.editReply('Transcript saved. Deleting ticket...');setTimeout(()=>interaction.channel.delete('Report ticket deleted').catch(()=>{}),1200);return;
    }
    if(name==='hours'||name==='evaluate'||name==='allhours'||name==='totalhours'||name==='weeklydeptours'||name==='deptofhours'||name==='leaderboard'||name==='tophours'||name==='inactive_officers'||name==='dept_officers'||name==='promotions'){
      if(name==='hours'){const u=interaction.options.getUser('user')||interaction.user,d=dept(interaction.options.getString('department')),tf=interaction.options.getString('timeframe')||'this_week',w=timeWindow(tf),total=await dutyTotal(u.id,d,w);return interaction.editReply({embeds:[new EmbedBuilder().setColor(0x2f80ed).setTitle('Duty Hours').addFields({name:'Member',value:`<@${u.id}>`,inline:true},{name:'Department',value:d,inline:true},{name:'Time Frame',value:tf.replaceAll('_',' '),inline:true},{name:'Hours',value:hoursText(total)})]});}
      if(name==='evaluate'){const u=interaction.options.getUser('user')||interaction.user,d=dept(interaction.options.getString('department')),w=weekWindow(),req=Number(await getSetting(`requirement:${d}`,'8',interaction.guild.id)||8),total=await dutyTotal(u.id,d,w),remain=Math.max(0,req*3600-total),ok=total>=req*3600;return interaction.editReply({embeds:[new EmbedBuilder().setColor(ok?0x2f9e44:0xe04f5f).setTitle(`${d} Weekly Evaluation`).addFields({name:'Member',value:`<@${u.id}>`,inline:true},{name:'Hours Worked',value:hoursText(total),inline:true},{name:'Required',value:`${req.toFixed(2)}h`,inline:true},{name:'Status',value:ok?'Requirement Met':'Below Requirement',inline:true},{name:'Remaining',value:hoursText(remain),inline:true}).setFooter({text:'Friday to Thursday'})]});}
      const d=dept(interaction.options.getString('department'));const tf=interaction.options.getString('timeframe')||'this_week',w=timeWindow(tf);const rows=await dbSafe(`SELECT discordId,SUM(GREATEST(0,LEAST(COALESCE(outTime,UNIX_TIMESTAMP()),?)-GREATEST(inTime,?))) seconds FROM duty_hours WHERE department=? AND inTime IS NOT NULL AND inTime<? AND COALESCE(outTime,UNIX_TIMESTAMP())>? AND discordId IS NOT NULL GROUP BY discordId ORDER BY seconds DESC`,[w.end,w.start,d,w.end,w.start]);
      if(name==='totalhours'||name==='weeklydeptours'){const total=rows.reduce((s,r)=>s+Number(r.seconds||0),0);return interaction.editReply({embeds:[new EmbedBuilder().setColor(0x2f80ed).setTitle(`${d} Department Hours`).addFields({name:'Time Frame',value:tf.replaceAll('_',' '),inline:true},{name:'Total',value:hoursText(total),inline:true})]});}
      if(name==='tophours'){const top=rows.slice(0,5);return interaction.editReply({embeds:[new EmbedBuilder().setColor(0x2f80ed).setTitle('Top Hours').setDescription(top.length?top.map((r,i)=>`${i+1}. <@${r.discordId}> — ${hoursText(r.seconds)}`).join('\n'):'No recorded hours.') ]});}
      if(name==='deptofhours'||name==='leaderboard'||name==='allhours'){const top=rows.slice(0,25);return interaction.editReply({embeds:[new EmbedBuilder().setColor(0x2f80ed).setTitle(`${d} ${name==='leaderboard'?'Leaderboard':'Hours'}`).setDescription(top.length?top.map((r,i)=>`${i+1}. <@${r.discordId}> — ${hoursText(r.seconds)}`).join('\n'):'No recorded hours.').setFooter({text:tf.replaceAll('_',' ')})]});}
      if(name==='inactive_officers'||name==='dept_officers'){const weeks=interaction.options.getInteger('weeks_back')||2,cutoff=now()-weeks*7*86400;const inactive=await dbSafe(`SELECT discordId,MAX(COALESCE(outTime,UNIX_TIMESTAMP())) lastDuty FROM duty_hours WHERE department=? AND discordId IS NOT NULL GROUP BY discordId HAVING lastDuty<? ORDER BY lastDuty ASC`,[d,cutoff]);return interaction.editReply({embeds:[new EmbedBuilder().setColor(0xe0a458).setTitle(`${d} Inactive Officers`).setDescription(inactive.length?inactive.map(r=>`<@${r.discordId}> — last duty ${formatShort(r.lastDuty)}`).join('\n'):'No inactive officers found.')]});}
      if(name==='promotions'){const min=interaction.options.getInteger('min_hours')??8;const eligible=rows.filter(r=>Number(r.seconds)>=min*3600);return interaction.editReply({embeds:[new EmbedBuilder().setColor(0x2f80ed).setTitle(`${d} Promotion Eligibility`).setDescription(eligible.length?eligible.map(r=>`<@${r.discordId}> — ${hoursText(r.seconds)}`).join('\n'):'No members meet the current threshold.').setFooter({text:`Minimum ${min}h this week`})]});}
    }
    if(name==='leomulti'){const mins=interaction.options.getInteger('duration_minutes'),mult=interaction.options.getNumber('multiplier')||1.5;await setJson('leoMultiplier',{multiplier:mult,until:now()+mins*60},interaction.guild.id);return interaction.editReply(`LEO hour multiplier started at ${mult}x for ${mins} minutes.`);}
    if(name==='add_org'){const code=interaction.options.getString('code').toUpperCase(),orgName=interaction.options.getString('name');await dbSafe('INSERT INTO department_orgs(code,name,createdBy) VALUES(?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)',[code,orgName,interaction.user.id]);return interaction.editReply(`Added ${code} — ${orgName}.`);}
    if(name==='add_org_hours'){const code=interaction.options.getString('code').toUpperCase(),hrs=interaction.options.getNumber('hours'),reason=interaction.options.getString('reason');await dbSafe('INSERT INTO org_hours_adjustments(orgCode,hours,reason,createdBy,createdAt) VALUES(?,?,?,?,?)',[code,hrs,reason||null,interaction.user.id,now()]);return interaction.editReply(`Added ${hrs.toFixed(2)} hours to ${code}.`);}
    if(name==='rename_org'){const oldC=interaction.options.getString('old_code').toUpperCase(),newC=interaction.options.getString('new_code').toUpperCase(),orgName=interaction.options.getString('name');await dbSafe('UPDATE department_orgs SET code=?,name=? WHERE code=?',[newC,orgName,oldC]);await dbSafe('UPDATE org_hours_adjustments SET orgCode=? WHERE orgCode=?',[newC,oldC]);return interaction.editReply(`Renamed ${oldC} to ${newC}.`);}
    return interaction.editReply('Command received, but this command does not have a handler yet.');
  } catch(error) {
    dbOnline = /ETIMEDOUT|ECONNREFUSED|ENOTFOUND|PROTOCOL|ECONNRESET/.test(error.code||'') ? false : dbOnline;
    console.error(`/${name} ERROR:`,error);
    return interaction.editReply(`The command could not be completed. ${error.message?.slice(0,250)||'Unknown error'}`).catch(()=>{});
  }
  } catch(error) {
    console.error(`/${name} OUTER ERROR:`, error);
    return interaction.editReply('The command could not be completed.').catch(()=>{});
  }
}

client.on('interactionCreate',async interaction=>{
  try {
    if(interaction.isChatInputCommand()) return handleCommand(interaction);
    if(interaction.isStringSelectMenu() && interaction.customId==='report_panel_type'){
      if(interaction.guildId!==REPORT_GUILD_ID) return interaction.reply({content:'This panel is only available in the configured reports server.',flags:MessageFlags.Ephemeral});
      return interaction.showModal(reportModal(interaction.values[0]));
    }
    if(interaction.isModalSubmit() && interaction.customId.startsWith('report_form:')){
      await interaction.deferReply({flags:MessageFlags.Ephemeral});
      if(interaction.guildId!==REPORT_GUILD_ID)return interaction.editReply('Reports are only available in the configured reports server.');
      if(!(await requireDBReply(interaction)))return;
      const [,type]=interaction.customId.split(':');const d=dept(interaction.fields.getTextInputValue('department'));if(!d)return interaction.editReply('Department must be USM, SASP, BCSO or LSPD.');
      const officerId=interaction.fields.getTextInputValue('officer_id')?.trim()||null;if(officerId&&!/^\d{17,20}$/.test(officerId))return interaction.editReply('Officer Discord ID is invalid.');
      const details=interaction.fields.getTextInputValue('details')||'';const ch=await createReportTicket({interaction,type,department:d,anonymous:false,reporterId:interaction.user.id,reportedUserId:officerId,dateOfIncident:interaction.fields.getTextInputValue('date'),gameId:null,clip:interaction.fields.getTextInputValue('clip'),description:details,context:null});
      await sendReportLog(interaction.guild,new EmbedBuilder().setColor(0x2f80ed).setTitle('Report Created').setDescription(`${type==='higher'?'Higher Up':'Officer'} report opened in ${ch}.`).addFields({name:'Department',value:d,inline:true},{name:'Reporter',value:`<@${interaction.user.id}>`,inline:true}));
      return interaction.editReply(`Report created: ${ch}`);
    }
    if(interaction.isButton()){
      if(!interaction.guildId||interaction.guildId!==REPORT_GUILD_ID)return interaction.reply({content:'This control is only available in the configured reports server.',flags:MessageFlags.Ephemeral});
      await interaction.deferReply({flags:MessageFlags.Ephemeral});
      if(!(await requireDBReply(interaction)))return;
      const report=await fetchReport(interaction.channel.id);if(!report)return interaction.editReply('This is not a report ticket.');
      if(interaction.customId==='ticket_close'){
        if(!(await reportStaffAllowed(interaction.member)))return interaction.editReply('Reports team permission required.');report.closedAt=now();await dbSafe('UPDATE reports SET closedAt=? WHERE channelId=?',[report.closedAt,interaction.channel.id]);if(report.reporterId)await interaction.channel.permissionOverwrites.edit(report.reporterId,{ViewChannel:false,SendMessages:false}).catch(()=>{});return interaction.editReply({content:'Ticket closed.',components:[activeTicketButtons(true)]});
      }
      if(interaction.customId==='ticket_transcript'){
        if(!(await reportStaffAllowed(interaction.member)))return interaction.editReply('Reports team permission required.');const text=await transcript(interaction.channel);const sent=await sendTranscriptLog(interaction.guild,interaction.channel,text);if(!sent)return interaction.editReply('Transcript log channel is not configured.');return interaction.editReply('Transcript saved to the configured transcript log.');
      }
      if(interaction.customId==='ticket_delete'){
        if(!(await reportStaffAllowed(interaction.member)))return interaction.editReply('Reports team permission required.');const text=await transcript(interaction.channel);await sendTranscriptLog(interaction.guild,interaction.channel,text);await interaction.editReply('Transcript saved. Deleting ticket...');setTimeout(()=>interaction.channel.delete('Report ticket deleted').catch(()=>{}),1200);return;
      }
    }
  }catch(error){console.error('INTERACTION ERROR:',error);try{if(interaction.deferred||interaction.replied)await interaction.editReply(`An error occurred: ${error.message?.slice(0,250)||'Unknown error'}`);else await interaction.reply({content:`An error occurred: ${error.message?.slice(0,250)||'Unknown error'}`,flags:MessageFlags.Ephemeral});}catch{}}
});

client.once('clientReady',async()=>{
  console.log(`Logged in as ${client.user.tag} (${client.user.id})`);
  try{await registerCommands();}catch(e){console.error('GLOBAL COMMAND REGISTRATION FAILED:',e);}
  const initDB=async()=>{try{await ensureSchema();dbOnline=true;console.log('DATABASE ONLINE');await pollDuty();if(!dutyTimer)dutyTimer=setInterval(()=>pollDuty().catch(()=>{}),DUTY_POLL_MS);if(dbRetryTimer){clearInterval(dbRetryTimer);dbRetryTimer=null;}}catch(e){dbOnline=false;console.error('DATABASE OFFLINE:',e.message);if(!dbRetryTimer)dbRetryTimer=setInterval(initDB,30000);}};
  await initDB();
});

process.on('unhandledRejection',e=>console.error('UNHANDLED REJECTION:',e));
process.on('uncaughtException',e=>console.error('UNCAUGHT EXCEPTION:',e));
process.on('SIGINT',async()=>{clearInterval(dutyTimer);clearInterval(dbRetryTimer);await pool.end().catch(()=>{});process.exit(0);});
process.on('SIGTERM',async()=>{clearInterval(dutyTimer);clearInterval(dbRetryTimer);await pool.end().catch(()=>{});process.exit(0);});
client.login(TOKEN);
