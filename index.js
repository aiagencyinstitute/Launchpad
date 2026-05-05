require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
  Events,
} = require('discord.js');

const cron = require('node-cron');
const axios = require('axios');

// ── Config ───────────────────────────────────────────────────────────────────
const TIMEZONE = process.env.TIMEZONE || 'Australia/Sydney';
const WEBHOOK_TIMEOUT_MS = Number(process.env.WEBHOOK_TIMEOUT_MS || 8000);
const ENABLE_BOT_CRONS = process.env.ENABLE_BOT_CRONS !== 'false';

const CHECKIN_WEBHOOK =
  process.env.N8N_CHECKIN_WEBHOOK || process.env.N8N_WEBHOOK_URL;

const WIN_WEBHOOK = process.env.N8N_WIN_WEBHOOK;
const OUTREACH_WEBHOOK = process.env.N8N_OUTREACH_WEBHOOK;

// ── Client setup ─────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ── In-memory trackers ───────────────────────────────────────────────────────
// For a small 12-student cohort this is okay, but note this resets if Railway restarts.
const weeklyCheckins = new Set();
const introPosters = new Set();
const joinTimestamps = new Map();

// ── Helpers ──────────────────────────────────────────────────────────────────
function getCurrentWeek() {
  const start = new Date(process.env.COHORT_START_DATE);
  const now = new Date();

  if (Number.isNaN(start.getTime())) {
    console.warn('⚠️ COHORT_START_DATE is missing or invalid. Defaulting to Week 1.');
    return 1;
  }

  const diff = Math.floor((now - start) / (7 * 24 * 60 * 60 * 1000));
  return Math.max(1, Math.min(12, diff + 1));
}

function isUsableWebhook(url) {
  return (
    typeof url === 'string' &&
    url.trim().length > 0 &&
    !url.includes('paste_after') &&
    !url.includes('your_') &&
    !url.includes('[n8n]')
  );
}

async function postToWebhook(label, url, payload) {
  if (!isUsableWebhook(url)) {
    console.warn(`⚠️ ${label} webhook is not configured. Skipping sync.`);
    return { ok: false, skipped: true };
  }

  try {
    await axios.post(url, payload, { timeout: WEBHOOK_TIMEOUT_MS });
    return { ok: true, skipped: false };
  } catch (err) {
    console.error(`❌ ${label} webhook error:`, {
      message: err.message,
      status: err.response?.status,
      data: err.response?.data,
    });
    return { ok: false, skipped: false, error: err };
  }
}

async function safeRespond(interaction, content) {
  try {
    if (interaction.deferred) {
      return await interaction.editReply({ content });
    }

    if (interaction.replied) {
      return await interaction.followUp({ content, ephemeral: true });
    }

    return await interaction.reply({ content, ephemeral: true });
  } catch (err) {
    console.error('❌ Failed to respond to interaction:', err.message);
  }
}

async function safeSendToChannel(channelId, message) {
  if (!channelId) {
    console.warn('⚠️ Missing channel ID. Skipping channel send.');
    return false;
  }

  try {
    const channel = await client.channels.fetch(channelId);

    if (!channel || !channel.isTextBased()) {
      console.warn(`⚠️ Channel ${channelId} not found or not text-based.`);
      return false;
    }

    await channel.send(message);
    return true;
  } catch (err) {
    console.error(`❌ Failed to send message to channel ${channelId}:`, err.message);
    return false;
  }
}

function getDisplayName(user) {
  return user.globalName || user.username;
}

function collectModalResponses(interaction, count = 5) {
  const responses = {};

  for (let i = 1; i <= count; i++) {
    try {
      responses[`q${i}`] = interaction.fields.getTextInputValue(`q${i}`);
    } catch {
      responses[`q${i}`] = '';
    }
  }

  return responses;
}

function includesAny(text, terms) {
  return terms.some((term) => text.includes(term));
}

function numbersFromText(text) {
  const matches = text.match(/\d+(?:,\d{3})*/g) || [];
  return matches.map((n) => Number(n.replace(/,/g, ''))).filter(Number.isFinite);
}

function hasNumberAtLeast(text, min) {
  return numbersFromText(text).some((n) => n >= min);
}

function hasMrrAtLeast1k(text) {
  const lower = text.toLowerCase();

  if (/\$?\s*[1-9]\d*\s*k\b/.test(lower)) return true;

  const moneyMatches = lower.match(/\$\s*\d+(?:,\d{3})*/g) || [];
  const moneyAmounts = moneyMatches.map((raw) =>
    Number(raw.replace(/\$/g, '').replace(/,/g, '').trim())
  );

  if (moneyAmounts.some((amount) => amount >= 1000)) return true;

  if (lower.includes('mrr') && hasNumberAtLeast(lower, 1000)) return true;

  return false;
}

async function getTextChannelByName(guild, channelName) {
  try {
    const channels = await guild.channels.fetch();
    return channels.find((channel) => channel?.name === channelName && channel.isTextBased());
  } catch (err) {
    console.error(`❌ Failed to fetch channel by name ${channelName}:`, err.message);
    return null;
  }
}

// ── Ready ────────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, () => {
  console.log(`✅ LaunchPad Bot is online as ${client.user.tag}`);
  console.log(`🕒 Timezone: ${TIMEZONE}`);
  console.log(`📌 Bot crons enabled: ${ENABLE_BOT_CRONS}`);
  console.log(`📌 Check-in webhook configured: ${isUsableWebhook(CHECKIN_WEBHOOK)}`);
});

// ── New member joins ─────────────────────────────────────────────────────────
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    const studentRole = member.guild.roles.cache.get(process.env.STUDENT_ROLE_ID);

    if (studentRole) {
      await member.roles.add(studentRole);
    } else {
      console.warn('⚠️ STUDENT_ROLE_ID is missing or role not found.');
    }

    joinTimestamps.set(member.id, Date.now());

    const introMention = process.env.INTRO_CHANNEL_ID
      ? `<#${process.env.INTRO_CHANNEL_ID}>`
      : '#introductions';

    const checkinMention = process.env.CHECKIN_CHANNEL_ID
      ? `<#${process.env.CHECKIN_CHANNEL_ID}>`
      : '#weekly-checkin';

    await member.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x2dd4bf)
          .setTitle(`Welcome to LaunchPad, ${member.displayName}! 🚀`)
          .setDescription(
            `We're so glad you're here. Here's what to do right now:\n\n` +
              `**1.** Head to ${introMention} and post your intro — your name, your niche idea, and what you want to get out of LaunchPad.\n\n` +
              `**2.** Watch the first module in Kajabi to get started.\n\n` +
              `**3.** Every Monday, type \`/checkin\` in ${checkinMention} to report your progress. It takes 2 minutes.\n\n` +
              `**4.** Got a question? Drop it in #questions — don't sit on blockers.\n\n` +
              `We're here to help. Let's build! 💪`
          ),
      ],
    });

    const introChannel =
      (process.env.INTRO_CHANNEL_ID
        ? await client.channels.fetch(process.env.INTRO_CHANNEL_ID).catch(() => null)
        : null) || (await getTextChannelByName(member.guild, 'introductions'));

    if (introChannel && introChannel.isTextBased()) {
      await introChannel.send(
        `👋 Welcome to LaunchPad, <@${member.id}>! Head over here and tell us about yourself — your name, what niche you're thinking about, and what you want to achieve. The group wants to meet you!`
      );
    }
  } catch (err) {
    console.error('❌ Error in GuildMemberAdd:', err);
  }
});

// ── Interaction router ───────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'checkin') {
        return await handleCheckinCommand(interaction);
      }

      if (interaction.commandName === 'win') {
        return await handleWinCommand(interaction);
      }

      if (interaction.commandName === 'logoutreach') {
        return await handleOutreachCommand(interaction);
      }
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith('checkin_week_')) {
        return await handleCheckinModal(interaction);
      }

      if (interaction.customId === 'win_modal') {
        return await handleWinModal(interaction);
      }

      if (interaction.customId === 'outreach_modal') {
        return await handleOutreachModal(interaction);
      }
    }
  } catch (err) {
    console.error('❌ Unhandled interaction error:', err);
    await safeRespond(interaction, 'Something went wrong. Please try again.');
  }
});

// ── /checkin ─────────────────────────────────────────────────────────────────
async function handleCheckinCommand(interaction) {
  try {
    const week = getCurrentWeek();
    const questions = getWeekQuestions(week);

    const modal = new ModalBuilder()
      .setCustomId(`checkin_week_${week}`)
      .setTitle(`Week ${week} Check-in`);

    questions.forEach((q, i) => {
      const input = new TextInputBuilder()
        .setCustomId(`q${i + 1}`)
        .setLabel(q.label)
        .setPlaceholder(q.placeholder)
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(input));
    });

    await interaction.showModal(modal);
  } catch (err) {
    console.error('❌ Error opening /checkin modal:', err);
    await safeRespond(interaction, 'Something went wrong opening the check-in. Try again.');
  }
}

async function handleCheckinModal(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const week = Number(interaction.customId.split('_')[2]);
  const name = getDisplayName(interaction.user);
  const responses = collectModalResponses(interaction, 5);

  const payload = {
    student_name: name,
    student_discord_id: interaction.user.id,
    week_number: week,
    submitted_at: new Date().toISOString(),
    responses,
  };

  weeklyCheckins.add(interaction.user.id);

  const webhookResult = await postToWebhook('Check-in', CHECKIN_WEBHOOK, payload);

  await safeSendToChannel(
    process.env.CHECKIN_CHANNEL_ID,
    `✅ **${name}** checked in for Week ${week}! Keep it up. 💪`
  );

  try {
    await checkMilestones(interaction, week, responses);
  } catch (err) {
    console.error('❌ Milestone check failed:', err.message);
  }

  if (webhookResult.ok) {
    return await interaction.editReply({
      content: `✅ Check-in submitted for Week ${week}! Nice work.`,
    });
  }

  if (webhookResult.skipped) {
    return await interaction.editReply({
      content: `✅ Check-in received for Week ${week}, but the check-in webhook is not configured yet, so it did not sync to the tracker.`,
    });
  }

  return await interaction.editReply({
    content: `✅ Check-in received for Week ${week}, but the tracker sync failed. Please let the team know so they can check n8n.`,
  });
}

// ── /win ─────────────────────────────────────────────────────────────────────
async function handleWinCommand(interaction) {
  try {
    const modal = new ModalBuilder()
      .setCustomId('win_modal')
      .setTitle('Log a Win 🔥');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('win_text')
          .setLabel("What's the win?")
          .setPlaceholder('e.g. First client signed!')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('win_detail')
          .setLabel('Tell us more (optional)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
      )
    );

    await interaction.showModal(modal);
  } catch (err) {
    console.error('❌ Error opening /win modal:', err);
    await safeRespond(interaction, 'Something went wrong opening the win form. Try again.');
  }
}

async function handleWinModal(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const winText = interaction.fields.getTextInputValue('win_text');
  const winDetail = interaction.fields.getTextInputValue('win_detail');
  const name = getDisplayName(interaction.user);

  await safeSendToChannel(process.env.WINS_CHANNEL_ID, {
    embeds: [
      new EmbedBuilder()
        .setColor(0xf97316)
        .setTitle(`🔥 WIN ALERT — ${name}`)
        .setDescription(`**${winText}**${winDetail ? `\n\n${winDetail}` : ''}`),
    ],
  });

  const webhookResult = await postToWebhook('Win', WIN_WEBHOOK, {
    student_name: name,
    student_discord_id: interaction.user.id,
    win_text: winText,
    win_detail: winDetail,
    submitted_at: new Date().toISOString(),
  });

  if (webhookResult.ok || webhookResult.skipped) {
    return await interaction.editReply({
      content: `🔥 Win posted in #wins! Legend.`,
    });
  }

  return await interaction.editReply({
    content: `🔥 Win posted in #wins, but the tracker sync failed. Please let the team know so they can check n8n.`,
  });
}

// ── /logoutreach ─────────────────────────────────────────────────────────────
async function handleOutreachCommand(interaction) {
  try {
    const modal = new ModalBuilder()
      .setCustomId('outreach_modal')
      .setTitle('Log Your Outreach');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('calls')
          .setLabel('Calls made today')
          .setPlaceholder('e.g. 5')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('dms')
          .setLabel('DMs sent today')
          .setPlaceholder('e.g. 12')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('emails')
          .setLabel('Emails sent today')
          .setPlaceholder('e.g. 20')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      )
    );

    await interaction.showModal(modal);
  } catch (err) {
    console.error('❌ Error opening /logoutreach modal:', err);
    await safeRespond(interaction, 'Something went wrong opening the outreach form. Try again.');
  }
}

async function handleOutreachModal(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const callsRaw = interaction.fields.getTextInputValue('calls');
  const dmsRaw = interaction.fields.getTextInputValue('dms');
  const emailsRaw = interaction.fields.getTextInputValue('emails');

  const calls = Number.parseInt(callsRaw, 10) || 0;
  const dms = Number.parseInt(dmsRaw, 10) || 0;
  const emails = Number.parseInt(emailsRaw, 10) || 0;
  const total = calls + dms + emails;
  const name = getDisplayName(interaction.user);

  const webhookResult = await postToWebhook('Outreach', OUTREACH_WEBHOOK, {
    student_name: name,
    student_discord_id: interaction.user.id,
    calls,
    dms,
    emails,
    total_touches: total,
    submitted_at: new Date().toISOString(),
  });

  if (webhookResult.ok || webhookResult.skipped) {
    return await interaction.editReply({
      content: `✅ Logged: ${calls} calls, ${dms} DMs, ${emails} emails. **${total} total touches today.** Keep going!`,
    });
  }

  return await interaction.editReply({
    content: `✅ Outreach received, but the tracker sync failed. Please let the team know so they can check n8n.`,
  });
}

// ── Milestone role checker ───────────────────────────────────────────────────
async function checkMilestones(interaction, week, responses) {
  if (!interaction.guild) return;

  const guild = interaction.guild;
  const member = await guild.members.fetch(interaction.user.id);
  const allResponses = Object.values(responses).join(' ').toLowerCase();

  const assign = async (roleId, roleName) => {
    if (!roleId) {
      console.warn(`⚠️ Missing role ID for ${roleName}. Skipping.`);
      return;
    }

    const role = await guild.roles.fetch(roleId).catch(() => null);

    if (!role) {
      console.warn(`⚠️ Role not found for ${roleName}. ID: ${roleId}`);
      return;
    }

    if (member.roles.cache.has(roleId)) return;

    try {
      await member.roles.add(role);

      await safeSendToChannel(
        process.env.WINS_CHANNEL_ID,
        `🎉 **${member.displayName}** just earned the **${roleName}** role! Another one locked in.`
      );
    } catch (err) {
      console.error(`❌ Failed assigning ${roleName}:`, err.message);
    }
  };

  // Bot Builder: avoid triggering from any random "yes" in later weeks.
  if (
    week >= 2 &&
    /\b(closebot|bot)\b/.test(allResponses) &&
    /\b(yes|built|connected|tested|live|complete|completed|working)\b/.test(allResponses)
  ) {
    await assign(process.env.BOT_BUILDER_ROLE_ID, 'Bot Builder');
  }

  // Outreach Activated: requires outreach-related wording and 10+ number.
  if (
    week >= 3 &&
    /\b(dm|dms|touch|touches|outreach|emails|calls)\b/.test(allResponses) &&
    hasNumberAtLeast(allResponses, 10)
  ) {
    await assign(process.env.OUTREACH_ACTIVATED_ROLE_ID, 'Outreach Activated');
  }

  // Call Booker: avoid "not booked" style false positives.
  if (
    week >= 4 &&
    /\b(booked|call booked|calls booked|discovery calls booked)\b/.test(allResponses) &&
    !/\b(no calls booked|none booked|not booked|0 booked)\b/.test(allResponses)
  ) {
    await assign(process.env.CALL_BOOKER_ROLE_ID, 'Call Booker');
  }

  // Client Closer: avoid "not closed" false positives.
  if (
    week >= 7 &&
    /\b(closed|signed|client signed|first client|deal won)\b/.test(allResponses) &&
    !/\b(not closed|haven't closed|have not closed|no client|not signed|0 clients)\b/.test(allResponses)
  ) {
    await assign(process.env.CLIENT_CLOSER_ROLE_ID, 'Client Closer');
  }

  // $1K Club: only if MRR or money amount clearly shows 1K+.
  if (week >= 7 && hasMrrAtLeast1k(allResponses)) {
    await assign(process.env.MRR_1K_ROLE_ID, '$1K Club');
  }

  // Alumni: Week 12 check-in submitted.
  if (week >= 12) {
    await assign(process.env.ALUMNI_ROLE_ID, 'LaunchPad Alumni');
  }
}

// ── Cron jobs ────────────────────────────────────────────────────────────────
if (ENABLE_BOT_CRONS) {
  // Intro follow-up check, hourly
  cron.schedule(
    '0 * * * *',
    async () => {
      const guild = client.guilds.cache.get(process.env.GUILD_ID);
      if (!guild) return;

      const introChannel =
        (process.env.INTRO_CHANNEL_ID
          ? await client.channels.fetch(process.env.INTRO_CHANNEL_ID).catch(() => null)
          : null) || (await getTextChannelByName(guild, 'introductions'));

      if (!introChannel || !introChannel.isTextBased()) return;

      try {
        const messages = await introChannel.messages.fetch({ limit: 100 });
        messages.forEach((m) => introPosters.add(m.author.id));
      } catch (err) {
        console.error('❌ Failed fetching intro messages:', err.message);
        return;
      }

      for (const [userId, joinTime] of joinTimestamps.entries()) {
        const twentyFourHours = 24 * 60 * 60 * 1000;

        if (Date.now() - joinTime > twentyFourHours && !introPosters.has(userId)) {
          try {
            const member = await guild.members.fetch(userId);
            await member.send(
              `Hey! I noticed you haven't introduced yourself yet. Drop a quick intro in #introductions — just your name, what niche you're thinking about, and what you want to get out of LaunchPad. The group wants to meet you! 👋`
            );
            joinTimestamps.delete(userId);
          } catch (err) {
            console.warn(`⚠️ Could not DM intro follow-up to ${userId}:`, err.message);
            joinTimestamps.delete(userId);
          }
        }
      }
    },
    { timezone: TIMEZONE }
  );

  // Monday check-in reminder, 9 AM local time
  cron.schedule(
    '0 9 * * 1',
    async () => {
      const guild = client.guilds.cache.get(process.env.GUILD_ID);
      if (!guild) return;

      const week = getCurrentWeek();

      await safeSendToChannel(
        process.env.CHECKIN_CHANNEL_ID,
        `👋 Hey team — it's check-in time! Type \`/checkin\` to submit your **Week ${week}** progress. Takes 2 minutes. Let's see where everyone's at. 🚀`
      );

      weeklyCheckins.clear();
    },
    { timezone: TIMEZONE }
  );

  // Wednesday missed check-in DMs, 12 PM local time
  cron.schedule(
    '0 12 * * 3',
    async () => {
      const guild = client.guilds.cache.get(process.env.GUILD_ID);
      if (!guild) return;

      const week = getCurrentWeek();

      try {
        const members = await guild.members.fetch();
        const students = members.filter((m) =>
          m.roles.cache.has(process.env.STUDENT_ROLE_ID)
        );

        for (const [id, member] of students) {
          if (!weeklyCheckins.has(id)) {
            try {
              await member.send(
                `Hey ${member.displayName}! I noticed you haven't checked in for Week ${week} yet. Everything okay? Type \`/checkin\` in <#${process.env.CHECKIN_CHANNEL_ID}> when you're ready. If you're stuck on something, drop it in #questions — don't sit on it. 💪`
              );
            } catch (err) {
              console.warn(`⚠️ Could not DM missed check-in nudge to ${id}:`, err.message);
            }
          }
        }
      } catch (err) {
        console.error('❌ Missed check-in cron failed:', err.message);
      }
    },
    { timezone: TIMEZONE }
  );

  // Sunday leaderboard reminder, 8 PM local time
  cron.schedule(
    '0 20 * * 0',
    async () => {
      const week = getCurrentWeek();

      await safeSendToChannel(
        process.env.SCOREBOARD_CHANNEL_ID,
        `🏆 **WEEK ${week} LEADERBOARD** is coming tonight! Make sure your outreach is logged with \`/logoutreach\` before it posts. Every touch counts. 💪`
      );
    },
    { timezone: TIMEZONE }
  );

  // Daily standup thread, weekdays 8 AM local time
  cron.schedule(
    '0 8 * * 1-5',
    async () => {
      const channel = await client.channels
        .fetch(process.env.STANDUP_CHANNEL_ID)
        .catch(() => null);

      if (!channel || !channel.isTextBased() || !channel.threads) {
        console.warn('⚠️ Standup channel missing or does not support threads.');
        return;
      }

      const now = new Date();

      const dayName = new Intl.DateTimeFormat('en-AU', {
        weekday: 'long',
        timeZone: TIMEZONE,
      }).format(now);

      const dateStr = new Intl.DateTimeFormat('en-AU', {
        day: 'numeric',
        month: 'short',
        timeZone: TIMEZONE,
      }).format(now);

      try {
        const thread = await channel.threads.create({
          name: `${dayName} ${dateStr} Standup`,
          autoArchiveDuration: 1440,
        });

        await thread.send(
          `Good morning team! Drop your standup below 👇\n\n` +
            `**1.** What did you do yesterday?\n` +
            `**2.** What are you working on today?\n` +
            `**3.** Anything blocking you?`
        );
      } catch (err) {
        console.error('❌ Failed creating standup thread:', err.message);
      }
    },
    { timezone: TIMEZONE }
  );
}

// ── Weekly check-in questions per week ───────────────────────────────────────
// Discord modal labels max 45 characters
function getWeekQuestions(week) {
  const map = {
    1: [
      { label: 'Agency name chosen? What is it?', placeholder: 'e.g. Apex AI Agency' },
      { label: 'Is your website live? Drop the URL.', placeholder: 'e.g. https://apexai.com.au' },
      { label: 'Socials set up? (LinkedIn/Insta/FB)', placeholder: 'e.g. Yes - all three created' },
      { label: 'GHL active with Twilio + calendar?', placeholder: 'e.g. Yes - tested and working' },
      { label: 'Modules watched? Anything blocking you?', placeholder: 'e.g. Watched 1-3, stuck on GHL' },
    ],
    2: [
      { label: 'CloseBot built and connected to GHL?', placeholder: 'e.g. Yes - tested and live' },
      { label: 'Q&As in knowledge base? (target: 15-20)', placeholder: 'e.g. 18 Q&As added' },
      { label: 'Full flow tested by someone else?', placeholder: 'e.g. Yes - my partner tested it' },
      { label: '60-sec demo video recorded + posted?', placeholder: 'e.g. Yes - posted on LinkedIn' },
      { label: 'Prospects on your list? (target: 25)', placeholder: 'e.g. 28 prospects in GHL' },
    ],
    3: [
      { label: 'Prospect list at 50 names?', placeholder: 'e.g. Yes - 52 in GHL' },
      { label: 'Cold email sequence live + sending?', placeholder: 'e.g. Yes - 3-step sequence live' },
      { label: 'Personalised DMs sent? (target: 10+)', placeholder: 'e.g. 14 DMs sent so far' },
      { label: 'Warm network contacted?', placeholder: 'e.g. Yes - reached out to 8 contacts' },
      { label: 'Total touches this week? Blockers?', placeholder: 'e.g. 47 touches, stuck on replies' },
    ],
    4: [
      { label: 'Hitting 20 outreach touches per day?', placeholder: 'e.g. Yes - averaging 22/day' },
      { label: 'Discovery calls booked? (target: 2-3)', placeholder: 'e.g. 2 booked for next week' },
      { label: 'Top 5 objection responses written?', placeholder: 'e.g. Yes - written and practiced' },
      { label: 'Content pieces posted? (target: 3)', placeholder: 'e.g. 3 LinkedIn posts' },
      { label: 'What message gets the best replies?', placeholder: 'e.g. The missed call angle works' },
    ],
    5: [
      { label: 'Discovery calls completed this week?', placeholder: 'e.g. 2 calls done' },
      { label: 'Using PAINS/SPIN/BANT framework?', placeholder: 'e.g. Yes - used on both calls' },
      { label: 'Any hot prospects ready to close?', placeholder: 'e.g. Yes - 1 dentist wants proposal' },
      { label: 'Main objection you keep hearing?', placeholder: 'e.g. We already have a receptionist' },
      { label: 'Following up within 24hrs of calls?', placeholder: 'e.g. Yes - same day follow-ups' },
    ],
    6: [
      { label: 'Proposal template built?', placeholder: 'e.g. Yes - using Launchpad template' },
      { label: 'Pricing model + price point?', placeholder: 'e.g. $800 setup + $500/mo retainer' },
      { label: 'How many proposals sent?', placeholder: 'e.g. 2 proposals sent' },
      { label: 'Pricing objections? How handled?', placeholder: 'e.g. Broke it down to $125/week' },
      { label: 'Still hitting 20+ daily touches?', placeholder: 'e.g. Yes - averaging 21/day' },
    ],
    7: [
      { label: 'First client closed? Who + deal?', placeholder: 'e.g. Yes - dental clinic $800/mo' },
      { label: 'If not closed, what is the blocker?', placeholder: 'e.g. Waiting on decision this week' },
      { label: 'Client onboarding process documented?', placeholder: 'e.g. Yes - using LP checklist' },
      { label: 'Client GHL sub-account set up?', placeholder: 'e.g. Yes - sub-account ready' },
      { label: 'Pipeline? (leads/calls/proposals/won)', placeholder: 'e.g. 8/3/2/1' },
    ],
    8: [
      { label: 'First client bot live + performing?', placeholder: 'e.g. Yes - live since Monday' },
      { label: 'What results is the bot generating?', placeholder: 'e.g. 4 missed calls captured' },
      { label: 'Collecting testimonial/case study?', placeholder: 'e.g. Yes - collecting this week' },
      { label: 'Outreach continuing for client #2?', placeholder: 'e.g. Yes - 18 touches/day' },
      { label: 'Active conversations in pipeline?', placeholder: 'e.g. 5 active conversations' },
    ],
    9: [
      { label: 'Case study created from client #1?', placeholder: 'e.g. Yes - one-pager done' },
      { label: 'Using case study in outreach?', placeholder: 'e.g. Yes - attaching to DMs' },
      { label: 'Content pieces posted this week?', placeholder: 'e.g. 4 posts this week' },
      { label: 'Started video content? (Reels/LI)', placeholder: 'e.g. Posted first Reel Tuesday' },
      { label: 'Total client count?', placeholder: 'e.g. 1 client, 2nd closing this week' },
    ],
    10: [
      { label: 'Sales process documented as SOP?', placeholder: 'e.g. Yes - in Notion' },
      { label: 'Client onboarding SOP documented?', placeholder: 'e.g. Yes - step by step checklist' },
      { label: 'Tracking MRR? What is it?', placeholder: 'e.g. Yes - $1,500/mo MRR' },
      { label: 'Biggest time sink right now?', placeholder: 'e.g. Manual bot setup each client' },
      { label: 'What would you delegate first?', placeholder: 'e.g. The initial bot build' },
    ],
    11: [
      { label: 'How many active clients?', placeholder: 'e.g. 3 clients' },
      { label: 'Current MRR?', placeholder: 'e.g. $2,400/mo' },
      { label: 'Tasks to delegate or automate?', placeholder: 'e.g. Onboarding calls, bot builds' },
      { label: 'Considering hiring? (VA/closer/tech)', placeholder: 'e.g. Yes - looking for a VA' },
      { label: 'Biggest bottleneck right now?', placeholder: 'e.g. Time - doing everything myself' },
    ],
    12: [
      { label: 'Total clients signed in LaunchPad?', placeholder: 'e.g. 3 clients total' },
      { label: 'Current MRR?', placeholder: 'e.g. $3,200/mo' },
      { label: 'Biggest win from the program?', placeholder: 'e.g. Closing first client Week 7' },
      { label: 'Biggest lesson learned?', placeholder: 'e.g. Outreach volume is everything' },
      { label: 'Goals for the next 90 days?', placeholder: 'e.g. Hit $5K MRR, hire a VA' },
    ],
  };

  return map[week] || map[1];
}

// ── Login ────────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);
