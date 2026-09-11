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
const dutyAdapter = fs.readFileSync(path.join(root, 'fivem-duty-adapter.lua'), 'utf8');

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
assert.ok(interactionSection.includes("interaction.customId.startsWith('dept_purchase:close:')"), 'Department purchase close button handler missing');
assert.ok(interactionSection.includes("interaction.customId.startsWith('dept_purchase:delete:')"), 'Department purchase delete button handler missing');

const panelSection = section('function reportPanelRow()', 'function reportDepartmentSelect');
assert.ok(panelSection.includes("setLabel('Officer Report')"));
assert.ok(panelSection.includes("setLabel('Higher Up Report')"));
assert.strictEqual(panelSection.includes('StringSelectMenuBuilder'), false, 'Main report panel should be buttons, not a dropdown');

const deptSelectSection = section('function reportDepartmentSelect', 'function reportFieldsModal');
assert.ok(deptSelectSection.includes("setPlaceholder('Select the department...')"));
assert.ok(deptSelectSection.includes('departmentDefinitions().slice(0, 25)'));
assert.ok(deptSelectSection.includes('setValue(code)'));


const dynamicDepartmentSection = section('const DEFAULT_DEPARTMENTS', 'const LEO_VOICE_CHANNELS');
assert.ok(dynamicDepartmentSection.includes('departmentRegistry'), 'Dynamic department registry missing');
const departmentOptionSection = section('const departmentOption', 'const timeframeChoices');
assert.ok(departmentOptionSection.includes('.setAutocomplete(true)'), 'Department slash options are not dynamic/autocomplete enabled');
assert.strictEqual(departmentOptionSection.includes('.addChoices('), false, 'Department slash options are still hard-coded choices');
const addDepartmentCommandSection = section("commands.find(c => c.name === 'add')", "commands.find(c => c.name === 'add_org')");
assert.ok(addDepartmentCommandSection.includes("setName('dept')"), '/add dept subcommand missing');
assert.ok(addDepartmentCommandSection.includes("setName('code')"), '/add dept code option missing');
assert.ok(addDepartmentCommandSection.includes("setName('name')"), '/add dept name option missing');
const addDepartmentHandlerSection = section('async function handleAddDepartment', 'async function handleHours');
assert.ok(addDepartmentHandlerSection.includes("setJsonSetting('departments'"), '/add dept does not persist dynamic departments');
assert.ok(addDepartmentHandlerSection.includes('registerDepartmentLocal(code, name)'), '/add dept does not update the runtime department registry');
const autocompleteSection = section('async function handleAutocomplete', "client.on('interactionCreate'");
assert.ok(autocompleteSection.includes("focused.name !== 'department'"), 'Department autocomplete handler missing');
assert.ok(interactionSection.includes('interaction.isAutocomplete()'), 'Autocomplete interactions are not handled');
assert.ok(source.includes("if (name === 'add' && interaction.options.getSubcommand() === 'dept') return handleAddDepartment(interaction);"), '/add dept handler dispatch missing');
assert.ok(source.includes('await refreshDepartmentRegistry();'), 'Dynamic departments are not reloaded from MySQL/local settings at startup');

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

const transcriptSection = section('function transcriptEmbedText', 'async function archiveReportTranscript');
assert.ok(transcriptSection.includes('embed.title'), 'Transcript does not include embed titles');
assert.ok(transcriptSection.includes('embed.description'), 'Transcript does not include embed descriptions');
assert.ok(transcriptSection.includes('embed.fields'), 'Transcript does not include embed fields');
assert.ok(transcriptSection.includes('message.attachments'), 'Transcript does not include attachments');

const configSection = section('async function handleReportStaff', 'async function handleLogConfig');
assert.ok(configSection.includes('reportStaffRoles:${department}'), 'Report staff configuration is not department-specific');
assert.ok(configSection.includes('reportCategoryId:${department}'), 'Report category config is not per department');
assert.ok(configSection.includes('higherUpRoles:${department}'), 'Higher-up coordinator config missing');
assert.ok(configSection.includes('higherUpCategoryId:${department}'), 'Higher-up category config missing');

const deptCommandSection = section("commands.find(c => c.name === 'dept-config')", "commands.find(c => c.name === 'ridealong-config')");
assert.ok(deptCommandSection.includes("commands.find(c => c.name === 'dept')"), '/dept command missing');
assert.ok(deptCommandSection.includes("setName('ticket')"), '/dept ticket subcommand missing');
assert.ok(source.includes("baseCommand('approve'"), '/approve command missing');
assert.ok(source.includes("baseCommand('denied'"), '/denied command missing');
assert.ok(source.includes("if (name === 'approve') return handleDepartmentPurchaseDecision(interaction, 'approved')"), '/approve handler missing');
assert.ok(source.includes("if (name === 'denied') return handleDepartmentPurchaseDecision(interaction, 'denied')"), '/denied handler missing');
assert.strictEqual(deptCommandSection.includes('departmentPurchaseRoles'), false, 'Implementation leaked into command declaration unexpectedly');

const deptPurchaseSection = section('function departmentPurchasePanelEmbed', 'async function handleHours');
assert.ok(deptPurchaseSection.includes("setLabel('Submit Department Request')"));
assert.ok(deptPurchaseSection.includes("setTitle('Department Establishment Request')"), 'Professional department request panel title missing');
assert.ok(deptPurchaseSection.includes("setTitle('Department Establishment Application')"), 'Professional department application embed title missing');
assert.ok(deptPurchaseSection.includes("setLabel('Purpose of the Department')"), 'Professional department purpose question missing');
assert.ok(deptPurchaseSection.includes("setLabel('Why Should WCRP Approve This?')"), 'Professional approval question missing');
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
assert.ok(deptPurchaseSection.includes('departmentPurchaseActionRow(channel.id)'), 'Department purchase ticket does not include close/delete controls');
assert.ok(deptPurchaseSection.includes("setLabel('Close')"), 'Department purchase close button missing');
assert.ok(deptPurchaseSection.includes("setLabel('Delete')"), 'Department purchase delete button missing');
assert.ok(deptPurchaseSection.includes('handleDepartmentPurchaseDecision'), 'Department purchase decision handler missing');
assert.ok(deptPurchaseSection.includes('archiveDepartmentPurchaseTranscript'), 'Department purchase transcript archiver missing');
assert.strictEqual(deptPurchaseSection.includes('buildDepartmentPurchaseEmbed(application).addFields'), false, 'Department purchase application is still copied into the log channel on creation');

const renameSection = section('async function handleRename', 'async function disableReportCloseButtons');
assert.ok(renameSection.includes('cleanName(interaction.user.username)'), '/rename does not use handler username');

const rideSection = section('async function handleRideAlong', 'async function handleCommand');
assert.ok(rideSection.includes('member.roles.cache.has(traineeRoleId)'));
assert.ok(rideSection.includes('member.roles.remove(traineeRoleId'), 'Ride-along does not remove configured trainee role');

const promotionHelper = section('function promotionEligibilityText', 'function cleanName');
assert.ok(promotionHelper.includes('hours >= 8'), 'Double promotion threshold is not 8 hours');
assert.ok(promotionHelper.includes('hours >= 4'), 'Promotion threshold is not 4 hours');
const hoursSection = section('async function handleHours', 'async function departmentHourRows');
assert.ok(hoursSection.includes('setDescription(`<@${user.id}> - ${hoursText(seconds)}`)'), '/hours does not show hours beside the user');
assert.ok(hoursSection.includes('promotionEligibilityText(thisWeekSeconds)'), '/hours does not show promotion eligibility');
const promotionsSection = section("if (name === 'promotions')", "if (name === 'leomulti')");
assert.ok(promotionsSection.includes('const minimum = 4;'), '/promotions does not use the fixed 4-hour promotion threshold');
assert.ok(promotionsSection.includes('8 * 3600'), '/promotions does not identify double-promotion eligibility at 8 hours');
const deptOfficersSection = section("if (name === 'dept_officers')", "if (name === 'promotions')");
assert.ok(deptOfficersSection.includes('SUM(GREATEST(0'), '/dept_officers does not calculate member hours');
assert.ok(deptOfficersSection.includes('hoursText(Number(row.seconds))'), '/dept_officers does not show hours beside each member');

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


const dutyCompatibility = section('async function ensureDutyHoursCompatibility', 'async function ensureSchema');
assert.ok(dutyCompatibility.includes("TABLE_NAME = 'duty_hours'"), 'Existing duty_hours table is not inspected');
assert.ok(dutyCompatibility.includes("!names.has('id')"), 'Missing duty_hours.id is not detected');
assert.ok(dutyCompatibility.includes('ALTER TABLE `duty_hours` ADD COLUMN `id`'), 'Existing duty_hours table is not migrated with an internal id');
assert.ok(dutyCompatibility.includes("['discordId', 'inTime', 'outTime', 'department']"), 'Required FiveM duty columns are not validated');
const pollErrorHandling = section('let lastDutyPollErrorSignature', "client.on('voiceStateUpdate'");
assert.ok(pollErrorHandling.includes('signature !== lastDutyPollErrorSignature'), 'Repeated duty poll errors are not rate-limited');
assert.ok(pollErrorHandling.includes('return true;'), 'Duty poll readiness status is not returned');

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
assert.ok(dutyAdapter.includes('normalizeDepartment'), 'FiveM duty adapter does not support dynamic department codes');
assert.strictEqual(dutyAdapter.includes('ALLOWED_DEPARTMENTS'), false, 'FiveM duty adapter still hard-codes department names');
assert.strictEqual(pkg.version, '1.2.4');

console.log('All WCRP Department Utilities static integration tests passed.');
