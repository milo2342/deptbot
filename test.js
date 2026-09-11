'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'schema.sql'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `Missing section: ${startMarker}`);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;
  assert.ok(end > start, `Missing end section: ${endMarker}`);
  return source.slice(start, end);
}

const oldBrand = ['PS', 'RP'].join('');
assert.strictEqual(source.toLowerCase().includes(oldBrand.toLowerCase()), false, 'Legacy branding remains in index.js');
assert.strictEqual(readme.toLowerCase().includes(oldBrand.toLowerCase()), false, 'Legacy branding remains in README.md');
assert.strictEqual(/\p{Extended_Pictographic}/u.test(source), false, 'Decorative emoji found in index.js');

assert.ok(source.includes("const REPORT_GUILD_ID = '1499578614298181642';"));
for (const id of ['1542399560394088538', '1542399564588261446', '1542399567234994206']) {
  assert.ok(source.includes(`'${id}'`), `Missing LEO voice channel ${id}`);
}
for (const department of ['USM', 'SASP', 'BCSO', 'LSPD']) {
  assert.ok(source.includes(`'${department}'`), `Missing department ${department}`);
}

assert.ok(source.includes('Routes.applicationCommands(CLIENT_ID)'), 'Commands are not registered globally');
assert.strictEqual(source.includes('Routes.applicationGuildCommands'), false, 'Guild command registration found');

const interactionSection = section("client.on('interactionCreate'", "client.once('clientReady'");
assert.ok(interactionSection.indexOf('await interaction.deferReply') < interactionSection.indexOf('handleCommand(interaction)'), 'Slash command is not deferred before command handling');
assert.ok(interactionSection.includes('MessageFlags.Ephemeral'), 'Modern ephemeral flags are not used');
assert.strictEqual(interactionSection.includes('deferReply({ ephemeral:'), false, 'Deprecated ephemeral defer is still used');
assert.ok(interactionSection.includes("interaction.customId.startsWith('report_start:')"), 'Report buttons are not handled');
assert.ok(interactionSection.includes("interaction.customId.startsWith('report_department:')"), 'Report department dropdown is not handled');
assert.ok(interactionSection.includes("interaction.customId.startsWith('report_close:')"), 'Report close button missing');
assert.ok(interactionSection.includes("interaction.customId.startsWith('report_delete:')"), 'Report delete button missing');
assert.ok(interactionSection.includes("interaction.customId === 'dept_purchase:start'"), 'Department purchase button missing');

const panelSection = section('function reportPanelRow()', 'function reportDepartmentSelect');
assert.ok(panelSection.includes("setLabel('Officer Report')"));
assert.ok(panelSection.includes("setLabel('Higher Up Report')"));
assert.strictEqual(panelSection.includes('StringSelectMenuBuilder'), false, 'Main report panel should be buttons, not a dropdown');

const deptSelectSection = section('function reportDepartmentSelect', 'function reportFieldsModal');
assert.ok(deptSelectSection.includes("setPlaceholder('Select the department...')"));
assert.ok(deptSelectSection.includes('DEPARTMENTS.map'));

const modalSection = section('function reportFieldsModal', 'function buildReportEmbed');
for (const id of ['date', 'game_id', 'evidence', 'description', 'context']) {
  assert.ok(modalSection.includes(`.setCustomId('${id}')`), `Report modal missing ${id}`);
}
assert.strictEqual(modalSection.includes(".setCustomId('department')"), false, 'Department should come from the dropdown, not the modal');
assert.strictEqual(modalSection.includes(".setCustomId('officer')"), false, 'Officer selection should be handled by /addofficer due modal limits');
assert.strictEqual((modalSection.match(/new ActionRowBuilder\(\)\.addComponents/g) || []).length, 5, 'Report modal must have exactly five input rows');

const reportEmbed = section('function buildReportEmbed', 'function reportCloseButton');
for (const label of [
  'Department', 'Date of incident', 'In Game ID of who you are reporting', 'Suspected Discord',
  'Clip', 'Describe in detail what is in the clip', 'Provide all necessary context for the clip'
]) {
  assert.ok(reportEmbed.includes(label), `Report embed missing target field: ${label}`);
}
assert.strictEqual(reportEmbed.includes("name: 'Reporting User'"), false, 'Old report layout field remains');

const handlerRoleHelpers = section('async function getStandardReportTeamRoles', 'function normalReportPermissions');
assert.ok(handlerRoleHelpers.includes('reportStaffRoles:${department}'), 'Reports Team is not department-specific');
assert.ok(handlerRoleHelpers.includes('higherUpRoles:${report.department}'), 'Higher-up coordinator roles are not department-specific');
assert.ok(handlerRoleHelpers.includes('reportCategoryId:${report.department}'), 'Report categories are not department-specific');
assert.ok(handlerRoleHelpers.includes('higherUpCategoryId:${report.department}'), 'Higher-up category override missing');

const normalPerms = section('function normalReportPermissions', 'async function anonymousReportPermissions');
assert.ok(normalPerms.includes('handlerRoleIds'));
assert.strictEqual(normalPerms.includes('departmentRoleIds'), false, 'Unrelated department roles are still granted ticket access');

const postSection = section('async function sendReportPost', 'async function replaceReportPost');
assert.ok(postSection.includes('getReportHandlerRoles'), 'Ticket post does not resolve department-specific handler roles');
assert.ok(postSection.includes('allowedMentions.roles = validRoles'), 'Configured handler roles are not explicitly pingable');
assert.ok(postSection.includes('channel.send({ content: chunk'), 'Evidence links are not reposted as raw messages for Discord previews');

const anonSection = section('async function handleAnonReport', 'async function handleRename');
assert.ok(anonSection.includes('report.anonymous = 1'));
assert.ok(anonSection.includes('permissionOverwrites.set(overwrites)'), 'Anonymous permissions are not rebuilt');
assert.ok(anonSection.includes('clearChannelFast(interaction.channel)'), 'Anonymous ticket is not cleared');
assert.ok(anonSection.includes('sendReportPost(interaction.channel, report'), 'Anonymous report and evidence are not resubmitted');
assert.ok(anonSection.includes('getReportHandlerRoles(report'), 'Anonymous ticket does not use the selected department handler role');

const anonPerms = section('async function anonymousReportPermissions', 'async function persistReport');
assert.ok(anonPerms.includes('report.reportedUserId'), 'Reported user access missing');
assert.ok(anonPerms.includes('deny: [PermissionFlagsBits.SendMessages]'), 'Reported user should be read-only');

const addOfficerSection = section('async function handleAddOfficer', 'async function handleAnonReport');
assert.ok(addOfficerSection.includes("interaction.options.getUser('user')"));
assert.ok(addOfficerSection.includes("interaction.options.getString('user_id')"));
assert.ok(addOfficerSection.includes('anonymousReportPermissions'), 'Anonymous /addofficer does not grant reportee access');
assert.ok(addOfficerSection.includes('replaceReportPost'), '/addofficer does not refresh the full report post');

const closeSection = section('async function handleClose', 'async function handleDelete');
assert.ok(closeSection.includes("archiveReportTranscript(interaction.channel, report, 'closed')"), 'Close does not automatically archive the channel transcript');
assert.ok(closeSection.includes('ticketClosedEmbed'), 'Closed ticket embed missing');
assert.ok(closeSection.includes('deleteTicketEmbed'), 'Second Delete Ticket embed missing');
assert.ok(closeSection.includes('reportDeleteButton'), 'Delete Ticket button missing');
assert.ok(closeSection.includes('getReportHandlerRoles'), 'Close does not ping department-specific handlers');
assert.ok(closeSection.includes("sendReportLog(interaction.guild, 'Report Closed'"), 'Close event is not automatically logged');

const configSection = section('async function handleReportStaff', 'async function handleLogConfig');
assert.ok(configSection.includes('reportStaffRoles:${department}'), 'Report staff configuration is not department-specific');
assert.ok(configSection.includes('reportCategoryId:${department}'), 'Report category config is not per department');
assert.ok(configSection.includes('higherUpRoles:${department}'), 'Higher-up coordinator config missing');
assert.ok(configSection.includes('higherUpCategoryId:${department}'), 'Higher-up category config missing');

const deptCommandSection = section("commands.find(c => c.name === 'dept-config')", "commands.find(c => c.name === 'ridealong-config')");
assert.ok(deptCommandSection.includes("commands.find(c => c.name === 'dept')"), '/dept command missing');
assert.ok(deptCommandSection.includes("setName('ticket')"), '/dept ticket subcommand missing');
assert.strictEqual(deptCommandSection.includes('departmentPurchaseRoles'), false, 'Implementation leaked into command declaration unexpectedly');

const deptPurchaseSection = section('function departmentPurchasePanelEmbed', 'async function handleHours');
assert.ok(deptPurchaseSection.includes("setLabel('Purchase Department')"));
for (const id of ['department_name', 'reason', 'jurisdiction', 'assets_ready', 'high_command_ready', 'discord_ready', 'why_allow']) {
  assert.ok(deptPurchaseSection.includes(`.setCustomId('${id}')`), `Department purchase flow missing ${id}`);
}
const step1 = section('function departmentPurchaseStepOneModal', 'function departmentPurchaseStepTwoModal');
assert.strictEqual((step1.match(/new ActionRowBuilder\(\)\.addComponents/g) || []).length, 5, 'Department purchase step 1 must have five rows');
const step2 = section('function departmentPurchaseStepTwoModal', 'function departmentPurchaseContinueRow');
assert.strictEqual((step2.match(/new ActionRowBuilder\(\)\.addComponents/g) || []).length, 2, 'Department purchase step 2 should have two rows');
assert.ok(deptPurchaseSection.includes('departmentPurchaseRoles'));
assert.ok(deptPurchaseSection.includes('departmentPurchaseCategoryId'));
assert.ok(deptPurchaseSection.includes('departmentPurchaseLogChannelId'));

const renameSection = section('async function handleRename', 'async function disableReportCloseButtons');
assert.ok(renameSection.includes('cleanName(interaction.user.username)'), '/rename does not use handler username');

const rideSection = section('async function handleRideAlong', 'async function handleCommand');
assert.ok(rideSection.includes('member.roles.cache.has(traineeRoleId)'));
assert.ok(rideSection.includes('member.roles.remove(traineeRoleId'), 'Ride-along does not remove configured trainee role');

const offDuty = section('function dutyOffEmbed', 'function getWeekWindow');
for (const label of ['Off Duty', 'We hope you enjoyed your shift!', 'Reason', 'Clock Out', 'Session', 'This Week (Fri-Thu)', 'Week', 'Department', 'In Voice', 'Out of Voice', 'Voice Coverage']) {
  assert.ok(offDuty.includes(label), `Off Duty embed missing ${label}`);
}

const dbHelpers = section('function markDatabaseFailure', 'async function getSetting');
assert.ok(dbHelpers.includes('const wasOffline = databaseOffline'), 'Database offline state transition tracking missing');
assert.ok(dbHelpers.includes('Retrying silently in the background'), 'Database retry logging message missing');
const pollSection = section('async function pollDuty', "client.on('voiceStateUpdate'");
assert.strictEqual(pollSection.includes('Duty polling paused while MySQL is unavailable.'), false, 'Duty poll still spams offline warnings');
const failSection = section('async function failInteraction', 'function getUserDisplay');
assert.ok(failSection.includes('Database-dependent command could not run'));

for (const column of ['discordId', 'inTime', 'outTime', 'department']) {
  assert.ok(schema.includes(`\`${column}\``), `duty_hours schema missing ${column}`);
}
for (const table of ['duty_voice_segments', 'bot_settings', 'reports', 'ridealongs', 'department_purchase_tickets']) {
  assert.ok(schema.includes(table), `Schema missing ${table}`);
}

assert.strictEqual(pkg.main, 'index.js');
assert.strictEqual(pkg.scripts.start, 'node index.js');
assert.ok(pkg.scripts.check);
assert.ok(pkg.scripts.test);
assert.ok(envExample.includes('DB_TIMEOUT_MS=1500'));

console.log('All WCRP Department Utilities static integration tests passed.');
